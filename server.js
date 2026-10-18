const express = require("express");
const cors = require("cors");
const path = require("path");
const Stripe = require("stripe");
const registry = require("./lib/registry");
const { renderDashboard } = require("./lib/dashboard");
const { generateBlogSite } = require("./lib/blog-site-generator");
const { getBaseUrl } = require("./lib/config");
const { contentModeLabel } = require("./lib/content-provider");
const { listProducts, listBooks, listCategories, listProductTypes } = require("./lib/products");
const { buildCheckoutLineItems } = require("./lib/checkout");
const { purchasePayloadFromSession } = require("./lib/stripe-webhooks");
const { strict: strictLimit, standard: standardLimit } = require("./lib/rate-limit"); // WORKER-4R 2026-10-18 item 378 — review before deploy
const { getMarketplaceLinks, getSponsorSlot, affiliateDisclosure } = require("./lib/monetization");
const { recordNewsletterSignup, recordNewsletterUnsubscribe, verifyUnsubscribeSignature } = require("./lib/newsletter");
const { loadPortfolioStrategy, summarizePortfolio, listPortfolioDomains } = require("./lib/portfolio");
const {
  recordCheckoutStarted,
  recordPurchase,
  requestCustomerAccess,
  customerAccess,
  resolveDigitalAccess,
  resolveDownload,
  recoverPurchaseAccess,
  markPurchaseRefunded,
  revenueDashboard
} = require("./lib/fulfillment");

const {validEmail,configured: recoveryConfigured,sendCustomerAccessEmail} = require('./lib/recovery-mailer');
const {renderLibraryPage} = require('./lib/v2-library');
// Strict production gate: never sign entitlement tokens with a guessable key.
if (process.env.NODE_ENV === 'production' &&
    (!process.env.CUSTOMER_ACCESS_SECRET || process.env.CUSTOMER_ACCESS_SECRET.length < 32)) {
  throw new Error('Production requires CUSTOMER_ACCESS_SECRET of at least 32 characters');
}
// V2 sales must not use an ephemeral filesystem. DATA_DIR alone is not proof of durability.
// Operator MUST verify an attached persistent volume or migrate to durable database first.
if (process.env.NODE_ENV === 'production' && process.env.BEYONDMYTHOS_V2_COMMERCE_ENABLED === 'true' && !process.env.DATA_DIR) {
  throw new Error('V2 paid checkout requires verified durable commerce storage');
}
const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

const allowedOrigins = (process.env.CORS_ORIGIN || process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

app.use(
  cors(
    allowedOrigins.length
      ? {
          origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            const normalized = origin.replace(/\/+$/, "");
            return callback(null, allowedOrigins.includes(normalized));
          }
        }
      : undefined
  )
);
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const stripe = getStripe();
  const webhookSecret = getStripeWebhookSecret();
  if (!stripe || !webhookSecret) {
    return res.status(500).json({ error: "Stripe webhook is not configured" });
  }

  const signature = req.get("stripe-signature");
  if (!signature) {
    return res.status(400).json({ error: "Missing Stripe signature" });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (error) {
    console.error("Stripe webhook signature verification failed:", error.message);
    return res.status(400).json({ error: "Invalid Stripe signature" });
  }

  // TEMP-DIAG (2026-09-22): narrow webhook diagnostics, reversible. No secrets or customer PII logged.
  console.log("stripe_webhook_event", {
    type: event.type,
    eventId: event.id,
    livemode: event.livemode
  });

  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return res.json({ received: true });
  }

  const session = event.data?.object;
  // TEMP-DIAG: log session state without customer PII (email presence only).
  console.log("stripe_webhook_session", {
    sessionId: session?.id,
    paymentStatus: session?.payment_status,
    hasEmail: Boolean(
      session?.customer_details?.email || session?.customer_email || session?.metadata?.email
    )
  });
  if (!session?.id || session.payment_status !== "paid") {
    return res.json({ received: true });
  }

  try {
    const lineItemsResponse = await stripe.checkout.sessions.listLineItems(session.id, {
      limit: 100,
      expand: ["data.price.product"]
    });
    const purchasePayload = purchasePayloadFromSession({
      session,
      lineItems: lineItemsResponse?.data || []
    });
    // TEMP-DIAG: log parsed product IDs (internal catalog IDs only, no PII).
    console.log("stripe_webhook_payload", {
      sessionId: session.id,
      hasEmail: Boolean(purchasePayload.email),
      productIds: (purchasePayload.items || []).map((item) => item.id)
    });

    if (!purchasePayload.email || !purchasePayload.items.length) {
      // TEMP-DIAG: fail loudly (400) instead of silent 200 so Stripe retries
      // and the failure is visible in delivery logs.
      console.warn("stripe_webhook_rejected_incomplete", { sessionId: session.id });
      return res.status(400).json({ error: "Incomplete purchase payload" });
    }

    const result = recordPurchase(purchasePayload);
    if (result.error) {
      // TEMP-DIAG: fail loudly (400) instead of silent 200 so Stripe retries
      // and the failure is visible in delivery logs.
      console.warn("stripe_webhook_rejected_record", {
        sessionId: session.id,
        error: result.error
      });
      return res.status(400).json({ error: "Purchase record rejected" });
    }
    console.log("stripe_webhook_recorded", {
      sessionId: session.id,
      purchaseId: result.purchaseId || result.purchase?.id || null,
      existing: Boolean(result.existing)
    });
    return res.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook purchase sync failed:", error.message);
    return res.status(500).json({ error: "Failed to process Stripe webhook" });
  }
});
app.use(express.json({ limit: "1mb" }));
// REVIVE-KIT 2026-10-18: 301 pruned duplicate blog sites (-2/-3 suffixed slugs)
// to their canonical one-per-niche site. Must run before express.static.
let siteRedirects = {};
try {
  siteRedirects = require("./data/site-redirects.json");
} catch (_siteRedirectError) {
  siteRedirects = {};
}
app.use("/sites", (req, res, next) => {
  const slug = req.path.split("/").filter(Boolean)[0];
  const canonical = slug ? siteRedirects[slug] : null;
  if (canonical) {
    const rest = req.url.slice(`/${slug}`.length) || "/";
    return res.redirect(301, `/sites/${canonical}${rest}`);
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));

let stripeClient;
function getStripe() {
  if (stripeClient) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  stripeClient = Stripe(key);
  return stripeClient;
}

function getStripeWebhookSecret() {
  return (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPortfolioPage(strategy, summary, revenue) {
  const tierSections = strategy.tiers
    .map(
      (tier) => `<section style="margin:1.4rem 0;padding:1rem;border:1px solid rgba(148,163,184,.2);border-radius:12px;background:rgba(255,255,255,.02)">
        <h2 style="margin:0 0 .35rem">${escapeHtml(tier.label)}</h2>
        <p style="margin:.2rem 0 1rem;color:#94a3b8">${escapeHtml(tier.goal)}</p>
        <div style="display:grid;gap:.8rem;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
          ${(tier.domains || [])
            .map(
              (domain) => `<article style="border:1px solid rgba(148,163,184,.18);border-radius:10px;padding:.8rem;background:rgba(255,255,255,.02)">
              <strong>${escapeHtml(domain.domain)}</strong>
              <p style="margin:.45rem 0;color:#94a3b8;font-size:.92rem">${escapeHtml(domain.role)} · KPI: ${escapeHtml(domain.northStarKpi)}</p>
              <p style="margin:.45rem 0;font-size:.9rem;color:#cbd5e1"><strong>Offers:</strong> ${escapeHtml((domain.topOffers || []).slice(0, 3).join(", "))}</p>
            </article>`
            )
            .join("")}
        </div>
      </section>`
    )
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BeyondMythos Portfolio Strategy</title><style>body{margin:0;background:#0b1020;color:#eef2ff;font-family:Inter,system-ui,sans-serif}a{color:#60a5fa}.wrap{max-width:1140px;margin:auto;padding:2rem 1.25rem 4rem}.kpi{display:grid;gap:.8rem;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin:1rem 0}.kpi div{border:1px solid rgba(148,163,184,.2);border-radius:12px;padding:.8rem;background:rgba(255,255,255,.03)}code{color:#f97316}</style></head><body><main class="wrap"><p><a href="/">← Live stream</a></p><h1>Portfolio operating model</h1><p>Unified strategy for growth, monetization, campaign operations, and domain governance.</p><div class="kpi"><div><strong>${summary.domainCount}</strong><p>Mapped domains</p></div><div><strong>${summary.tierCount}</strong><p>Operating tiers</p></div><div><strong>${summary.weeklyThemes}</strong><p>Weekly campaign themes</p></div><div><strong>${revenue.totals.conversionRate}</strong><p>Checkout conversion</p></div></div>${tierSections}<section style="margin-top:1.4rem;padding:1rem;border:1px solid rgba(148,163,184,.2);border-radius:12px"><h2 style="margin:0 0 .6rem">Execution phases</h2><ol>${(strategy.executionPhases || []).map((phase) => `<li><strong>${escapeHtml(phase.id)}.</strong> ${escapeHtml(phase.name)} — ${escapeHtml(phase.focus)}</li>`).join("")}</ol><p style="color:#94a3b8">Machine-readable strategy and KPI endpoints: <code>/api/portfolio/strategy</code> and <code>/api/portfolio/dashboard</code>.</p></section></main></body></html>`;
}

function authorizeCron(req) {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) return false;
  const header = req.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const cronHeader = (req.get("x-cron-secret") || "").trim();
  return bearer === secret || cronHeader === secret;
}

const STOREFOOT =
  `<footer style="margin-top:3rem;padding-top:1.5rem;border-top:1px solid rgba(148,163,184,.2);color:#94a3b8;font-size:.9rem;display:flex;gap:1.25rem;flex-wrap:wrap">` +
  `<a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/refunds">Refunds</a><a href="/contact">Contact</a>` +
  `<span style="margin-left:auto">© ${new Date().getFullYear()} BeyondMythos Press</span></footer>`;

function productCard(product) {
  const formats = Array.isArray(product.formats) && product.formats.length
    ? `<p style="color:#94a3b8;font-size:.85rem">Includes: ${product.formats.map((f) => escapeHtml(f.toUpperCase())).join(" + ")} · DRM-free</p>`
    : "";
  const author = product.author ? `<p style="color:#94a3b8;font-size:.85rem">By ${escapeHtml(product.author)}</p>` : "";
  return `<article id="product-${product.id}"><span style="display:inline-block;padding:.2rem .45rem;border:1px solid rgba(96,165,250,.5);border-radius:999px;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:#93c5fd">${escapeHtml(product.offerTier)}</span><h2>${escapeHtml(product.name)}</h2>${author}<p>${escapeHtml(product.description)}</p>${formats}<strong>$${product.price.toFixed(2)}</strong><div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.7rem"><button data-buy-now data-product-id="${product.id}" style="cursor:pointer;padding:.45rem .7rem;border-radius:.6rem;border:1px solid rgba(96,165,250,.45);background:#2563eb;color:#fff">Buy now</button></div></article>`;
}

function buyNowScript() {
  return `<script>document.addEventListener("click",async function(event){var button=event.target.closest("[data-buy-now]");if(!button)return;event.preventDefault();var status=document.getElementById("checkout-status");var emailField=document.getElementById("checkout-email");var email=emailField&&emailField.value?emailField.value.trim():"";button.disabled=true;if(status)status.textContent="Starting checkout...";try{var response=await fetch("/api/create-checkout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:email,site:"beyondmythos.com",items:[{id:Number(button.getAttribute("data-product-id")),quantity:1}]})});var payload=await response.json();if(!response.ok||!payload.url){throw new Error(payload&&payload.error?payload.error:"Checkout failed");}window.location.href=payload.url;}catch(error){if(status)status.textContent=error.message||"Checkout failed";button.disabled=false;}});</script>`;
}

const PAGE_STYLE = `body{margin:0;background:#0b1020;color:#eef2ff;font-family:Inter,system-ui,sans-serif}.wrap{max-width:1100px;margin:auto;padding:2rem 1.25rem 4rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}article{border:1px solid rgba(148,163,184,.2);border-radius:1rem;padding:1rem;background:rgba(255,255,255,.04)}a{color:#60a5fa}p{color:#94a3b8}.checkout{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin:1rem 0}.checkout input{padding:.5rem .65rem;border-radius:.5rem;border:1px solid rgba(148,163,184,.4);background:#0f172a;color:#eef2ff}`;

function renderBookstoreHomepage() {
  const books = listBooks();
  const kits = listProducts({ type: "digital" }).filter(
    (p) => p.category !== "books" && p.hasFiles
  );
  const bookCards = books.map(productCard).join("");
  const kitCards = kits.map(productCard).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BeyondMythos Press — Bookstore</title><meta name="description" content="Direct bookstore for BeyondMythos Press: ebooks on autonomous publishing, plus creator kits and templates."><style>${PAGE_STYLE}.hero{padding:2.5rem 0 1rem}.hero h1{font-size:2.2rem;margin:.4rem 0}.kicker{display:inline-block;padding:.25rem .6rem;border:1px solid rgba(249,115,22,.5);border-radius:999px;font-size:.75rem;text-transform:uppercase;letter-spacing:.1em;color:#fdba74}h2.section{margin:2.5rem 0 1rem;font-size:1.4rem}</style></head><body><main class="wrap">
<header class="hero"><span class="kicker">BeyondMythos Press</span><h1>The bookstore for autonomous publishing</h1><p>Books, kits, and templates from the publishing network that runs itself. Buy direct — every purchase includes DRM-free downloads and self-serve recovery, forever.</p></header>
<div class="checkout"><label for="checkout-email">Checkout email</label><input id="checkout-email" type="email" placeholder="you@example.com" autocomplete="email" /><span id="checkout-status" style="color:#93c5fd;font-size:.9rem"></span></div>
<h2 class="section">Books</h2><section class="grid">${bookCards || "<p>No books yet — check back soon.</p>"}</section>
<h2 class="section">Creator kits &amp; templates</h2><section class="grid">${kitCards}</section>
<section style="margin-top:2.5rem;border:1px solid rgba(148,163,184,.2);border-radius:1rem;padding:1.25rem;background:rgba(249,115,22,.06)"><h2 style="margin-top:0">How delivery works</h2><p>Pay securely with Stripe. Your download links are signed to your purchase and never shared. Lost your link? Enter your email on the <a href="/success">order success</a> page or use purchase recovery — no support ticket needed.</p></section>
${STOREFOOT}
</main>${buyNowScript()}</body></html>`;
}

app.get("/", (req, res) => {
  res.set("Cache-Control", "public, max-age=120, stale-while-revalidate=60");
  res.type("html").send(renderBookstoreHomepage());
});

// Preview is deliberately isolated from the live root and makes no product claims.
app.get('/v2', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'v2', 'index.html'));
});
app.get('/library', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.type('html').send(renderLibraryPage());
});

app.get("/ops", (req, res) => {
  const sites = registry.listSites();
  res.set("Cache-Control", "no-store");
  res.type("html").send(renderDashboard(sites, getBaseUrl(), summarizePortfolio()));
});

app.get("/success", (req, res) => {
  const sessionId = escapeHtml(String(req.query.session_id || ""));
  res.set("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Order confirmed — BeyondMythos Press</title><style>${PAGE_STYLE}</style></head><body><main class="wrap">
<p><a href="/">← Back to the bookstore</a></p>
<h1>Checkout returned</h1>
${sessionId ? `<p style="color:#94a3b8">Stripe session: <code>${sessionId}</code></p>` : ""}
<p>If payment completed, Stripe will confirm it asynchronously. Once the order is recorded, you can request a private access link.</p>
<ol>
<li><strong>Request a private email link</strong> with the email you used at checkout, below.</li>
<li>Open the link sent to your email to see eligible purchases and download buttons.</li>
<li>Links expire after 14 days for security — you can renew them any time, free, forever.</li>
</ol>
<form id="recover-form" style="display:flex;gap:.6rem;flex-wrap:wrap;margin:1.5rem 0">
<input id="recover-email" type="email" required placeholder="you@example.com" autocomplete="email" style="padding:.5rem .65rem;border-radius:.5rem;border:1px solid rgba(148,163,184,.4);background:#0f172a;color:#eef2ff" />
<button type="submit" style="cursor:pointer;padding:.5rem .8rem;border-radius:.6rem;border:1px solid rgba(96,165,250,.45);background:#2563eb;color:#fff">Request a private email link</button>
</form>
<p id="recover-status" style="color:#93c5fd"></p>
${STOREFOOT}
</main><script>document.getElementById("recover-form").addEventListener("submit",async function(e){e.preventDefault();var s=document.getElementById("recover-status");var email=document.getElementById("recover-email").value.trim();s.textContent="Sending...";try{var r=await fetch("/api/customer/access/request",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:email})});var p=await r.json();if(!r.ok)throw new Error(p.error||"Request failed");s.textContent=p.message||'If your account has purchases, an email will be sent.';}catch(err){s.textContent=err.message;}});</script></body></html>`);
});

app.get("/cancel", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout cancelled — BeyondMythos Press</title><style>${PAGE_STYLE}</style></head><body><main class="wrap">
<p><a href="/">← Back to the bookstore</a></p>
<h1>Checkout cancelled</h1>
<p>No charge was made. Your cart is waiting whenever you're ready.</p>
<p><a href="/store">Return to the store</a> · Questions? <a href="/contact">Contact us</a></p>
${STOREFOOT}
</main></body></html>`);
});

function legalPage(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} — BeyondMythos Press</title><style>${PAGE_STYLE}.prose p{color:#cbd5e1}.prose li{color:#cbd5e1;margin:.4rem 0}</style></head><body><main class="wrap"><p><a href="/">← Back to the bookstore</a></p><h1>${escapeHtml(title)}</h1><div class="prose">${bodyHtml}</div>${STOREFOOT}</main></body></html>`;
}

app.get("/terms", (req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.type("html").send(legalPage("Terms of Service", `
<p>Last updated: September 2026. By purchasing from BeyondMythos Press you agree to the following.</p>
<h2>What you buy</h2><p>Digital products (ebooks, kits, templates) are licensed to you personally, DRM-free. You may read and use them on your own devices; you may not resell, redistribute, or publish them.</p>
<h2>Delivery</h2><p>Files are delivered through signed, expiring download links tied to your purchase email. Links expire after 14 days and can be renewed free at any time via purchase recovery.</p>
<h2>Payments</h2><p>Payments are processed securely by Stripe. Prices are in USD. We never see or store your card details.</p>
<h2>Refunds</h2><p>See our <a href="/refunds">refund policy</a>. If a file doesn't match its description, you get your money back.</p>
<h2>Contact</h2><p>Questions about these terms: see <a href="/contact">contact</a>.</p>`));
});

app.get("/privacy", (req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.type("html").send(legalPage("Privacy Policy", `
<p>Last updated: September 2026.</p>
<h2>What we collect</h2><p>Your email address (for delivery, receipts, and recovery) and purchase records (what you bought, when). That's it.</p>
<h2>What we don't do</h2><p>We never sell your data. We never share your email with advertisers. Payment details go to Stripe, never to us.</p>
<h2>Storage</h2><p>Purchase records are kept to honor your downloads and refunds. Ask for deletion via <a href="/contact">contact</a> and we'll remove what the law allows us to remove (tax records may require retention).</p>
<h2>Cookies</h2><p>This storefront uses no tracking cookies. Stripe's checkout may set its own cookies during payment; see Stripe's privacy policy.</p>`));
});

app.get("/refunds", (req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.type("html").send(legalPage("Refund Policy", `
<p>Last updated: September 2026.</p>
<p>Digital products can't be returned, but they can be wrong. Our promise:</p>
<ul><li>If a file doesn't match its product description, you get a full refund — no interrogation.</li><li>Request within 30 days of purchase via <a href="/contact">contact</a> with your order email.</li><li>Refunded purchases lose download access; that's the only catch.</li></ul>
<p>Chargebacks cost everyone more than refunds do. We'd rather refund you and keep your trust.</p>`));
});

app.get("/contact", (req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.type("html").send(legalPage("Contact", `
<p>For order help, refunds, or anything else:</p>
<p>Email us: <a href="mailto:Nicholas@fullstackassets.com">Nicholas@fullstackassets.com</a></p>
<ul><li><strong>Lost downloads?</strong> Use purchase recovery on the <a href="/success">order success page</a> — instant, no email needed.</li><li><strong>Refunds &amp; order issues:</strong> include your purchase email and we'll sort it out.</li><li><strong>Press &amp; wholesale:</strong> BeyondMythos Press titles are available for bundle licensing — get in touch.</li></ul>
<p>We answer within two business days.</p>`));
});

app.get("/api/downloads/:purchaseId/:productId/:format", (req, res) => {
  const result = resolveDownload({
    purchaseId: req.params.purchaseId,
    productId: req.params.productId,
    format: req.params.format,
    token: req.query.token
  });
  if (result.error) return res.status(401).json({ error: result.error });
  res.set("Cache-Control", "no-store");
  res.set("Content-Type", result.contentType);
  res.set("Content-Disposition", `attachment; filename="${result.fileName}"`);
  res.sendFile(result.filePath);
});

app.get("/portfolio", (req, res) => {
  const strategy = loadPortfolioStrategy();
  const summary = summarizePortfolio(strategy);
  const revenue = revenueDashboard();
  res.set("Cache-Control", "public, max-age=120, stale-while-revalidate=60");
  res.type("html").send(renderPortfolioPage(strategy, summary, revenue));
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    message: "BeyondMythos API is running",
    contentMode: contentModeLabel()
  });
});

app.get("/api/blog-sites", (req, res) => {
  res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=15");
  res.json({
    count: registry.listSites().length,
    lastGeneratedAt: registry.loadRegistry().lastGeneratedAt,
    sites: registry.listSites()
  });
});

app.get("/api/portfolio/strategy", (req, res) => {
  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=120");
  const strategy = loadPortfolioStrategy();
  res.json({
    strategy,
    summary: summarizePortfolio(strategy)
  });
});

app.get("/api/portfolio/dashboard", (req, res) => {
  res.set("Cache-Control", "no-store");
  const strategy = loadPortfolioStrategy();
  res.json({
    updatedAt: new Date().toISOString(),
    summary: summarizePortfolio(strategy),
    domainCount: listPortfolioDomains(strategy).length,
    revenue: revenueDashboard()
  });
});

app.post("/api/blog-sites/generate", async (req, res) => {
  if (!authorizeCron(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await generateBlogSite();
    res.status(201).json({ ok: true, site: result.site });
  } catch (error) {
    if (error.code === "NICHES_EXHAUSTED") {
      return res.status(409).json({ error: error.message });
    }
    console.error("Blog site generation failed:", error);
    res.status(500).json({ error: "Failed to generate blog site" });
  }
});

app.get("/healthz", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/store", (req, res) => {
  const books = listBooks();
  const kits = listProducts({ type: "digital" }).filter(
    (p) => p.category !== "books" && p.hasFiles
  );
  const markets = getMarketplaceLinks();
  const bookCards = books.map(productCard).join("");
  const kitCards = kits.map(productCard).join("");
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BeyondMythos Store</title><style>${PAGE_STYLE}.markets{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0 2rem}.trust{border:1px solid rgba(148,163,184,.2);border-radius:1rem;padding:1rem;margin:1rem 0 2rem;background:rgba(249,115,22,.08)}h2.section{margin:2.5rem 0 1rem;font-size:1.4rem}</style></head><body><main class="wrap"><p><a href="/">← Bookstore home</a></p><h1>BeyondMythos Store</h1><p>Books first, creator kits after. Guides, templates, prompt packs, launch kits, and automation assets for niche-site operators.</p><div class="checkout"><label for="checkout-email">Checkout email</label><input id="checkout-email" type="email" placeholder="you@example.com" autocomplete="email" /><span id="checkout-status" style="color:#93c5fd;font-size:.9rem"></span></div><div class="trust"><strong>Delivery and recovery</strong><p>After purchase, request account access at <code>/api/customer/access/request</code> to retrieve your digital products and renew expired links.</p></div><div class="markets">${markets.map((link) => `<a href="${escapeHtml(link.url)}" rel="noopener nofollow">${escapeHtml(link.label)}</a>`).join("")}</div><h2 class="section">Books</h2><section class="grid">${bookCards}</section><h2 class="section">Creator kits &amp; templates</h2><section class="grid">${kitCards}</section>${STOREFOOT}</main>${buyNowScript()}</body></html>`);
});

app.get("/api/store/config", (req, res) => {
  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  res.json({
    name: process.env.STORE_NAME || "BeyondMythos",
    tagline: "Creator tools, merch, and gear — shipped or delivered instantly",
    primaryColor: "#2563eb",
    secondaryColor: "#f97316",
    categories: listCategories(),
    types: listProductTypes(),
    offerTiers: ["entry", "core", "premium"]
  });
});

app.get("/api/store/products", standardLimit, async (req, res) => {
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
  const filters = {};
  if (req.query.type) filters.type = String(req.query.type);
  if (req.query.category) filters.category = String(req.query.category);
  if (req.query.fulfillment) filters.fulfillment = String(req.query.fulfillment);
  if (req.query.tier) filters.tier = String(req.query.tier);
  const products = listProducts(filters);
  res.json({ count: products.length, products });
});

app.get("/api/monetization/config", (req, res) => {
  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  res.json({
    sponsorEnabled: Boolean(getSponsorSlot()),
    marketplaces: getMarketplaceLinks(),
    disclosure: affiliateDisclosure(),
    digitalProductCount: listProducts({ type: "digital" }).length
  });
});

app.post("/api/newsletter/subscribe", strictLimit, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const site = String(req.body?.site || "").trim();
  const hp = String(req.body?.website || "").trim();
  if (hp) return res.json({ ok: true });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Valid email required" });
  }

  const recorded = recordNewsletterSignup({ email, site: site || "beyondmythos.com" });
  if (recorded.error) {
    return res.status(400).json({ error: recorded.error });
  }

  const webhookUrl = (process.env.NEWSLETTER_WEBHOOK_URL || "").trim();
  if (!webhookUrl) {
    console.log("Newsletter signup captured in local queue:", { email, site });
    return res.status(202).json({ ok: true, mode: "queued-local" });
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, site, source: "beyondmythos", createdAt: new Date().toISOString() })
    });
    if (!response.ok) throw new Error(`newsletter webhook returned ${response.status}`);
    res.status(202).json({ ok: true });
  } catch (error) {
    console.error("Newsletter subscription failed:", error.message);
    res.status(502).json({ error: "Newsletter provider failed" });
  }
});

app.get("/unsubscribe", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(legalPage("Unsubscribe", `
<p>Enter the email you signed up with and we'll remove you from the newsletter right away.</p>
<div class="checkout"><label for="unsub-email">Email</label><input id="unsub-email" type="email" placeholder="you@example.com" autocomplete="email" /><button id="unsub-btn" type="button" style="cursor:pointer;padding:.45rem .7rem;border-radius:.6rem;border:1px solid rgba(96,165,250,.45);background:#2563eb;color:#fff">Unsubscribe</button><span id="unsub-status" style="color:#93c5fd;font-size:.9rem"></span></div>
<script>document.getElementById("unsub-btn").addEventListener("click",async function(){var email=document.getElementById("unsub-email").value.trim();var status=document.getElementById("unsub-status");status.textContent="Working...";try{var r=await fetch("/api/newsletter/unsubscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:email})});var p=await r.json();if(!r.ok||!p.ok)throw new Error(p.error||"Unsubscribe failed");status.textContent="You're unsubscribed.";}catch(e){status.textContent=e.message||"Unsubscribe failed";}});</script>`));
});

app.post("/api/newsletter/unsubscribe", strictLimit, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Valid email required" });
  }

  const result = recordNewsletterUnsubscribe({ email });
  if (result.error) {
    return res.status(404).json({ error: result.error });
  }
  res.json({ ok: true });
});

// One-click unsubscribe: GET /api/newsletter/unsubscribe?email=X&sig=Y
// sig = HMAC-SHA256 (hex or base64url) of the normalized email.
app.get("/api/newsletter/unsubscribe", (req, res) => {
  const email = String(req.query.email || "").trim().toLowerCase();
  const sig = String(req.query.sig || "");
  const invalid = legalPage("Unsubscribe", `<p>This unsubscribe link is invalid. Try the <a href="/unsubscribe">unsubscribe page</a> instead.</p>`);
  if (!email || !sig || !verifyUnsubscribeSignature(email, sig)) {
    return res.status(400).type("html").send(invalid);
  }

  const result = recordNewsletterUnsubscribe({ email });
  if (result.error) {
    return res.status(404).type("html").send(legalPage("Unsubscribe", `<p>We couldn't find that email on the newsletter list.</p>`));
  }
  res.type("html").send(legalPage("Unsubscribed", `<p>You've been removed from the BeyondMythos newsletter. Sorry to see you go.</p>`));
});

app.post("/api/create-checkout", strictLimit, async (req, res) => {
  const items = req.body && Array.isArray(req.body.items) ? req.body.items : null;
  const email = String(req.body?.email || "").trim().toLowerCase();
  const site = String(req.body?.site || "beyondmythos.com").trim().toLowerCase();
  recordCheckoutStarted({ site, email, items });
  const { lineItems, error: validationError } = buildCheckoutLineItems(items);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const configuredFrontendUrl = (process.env.FRONTEND_URL || "").trim().replace(/\/+$/, "");
  const requestOrigin = (req.get("origin") || "").trim().replace(/\/+$/, "");
  const frontendUrl = configuredFrontendUrl || requestOrigin;
  if (!frontendUrl) {
    return res.status(500).json({ error: "Missing FRONTEND_URL configuration" });
  }

  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY configuration" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      customer_email: email || undefined,
      metadata: {
        email,
        site
      },
      success_url: `${frontendUrl}/success`,
      cancel_url: `${frontendUrl}/cancel`
    });
    res.json({ url: session.url });
  } catch (error) {
    console.error("Stripe checkout session failed:", error.message);
    res.status(502).json({ error: "Failed to create checkout session" });
  }
});

app.post("/api/purchases/record", (req, res) => {
  if (!authorizeCron(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const result = recordPurchase({
    email: req.body?.email,
    items: req.body?.items,
    site: req.body?.site,
    provider: req.body?.provider,
    providerSessionId: req.body?.providerSessionId,
    status: req.body?.status
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
});

async function safeRecoveryEmail(email) {
  if (!validEmail(email)) return {status:400,body:{error:'Valid email is required'}};
  if (!recoveryConfigured()) return {status:503,body:{error:'Email recovery is not configured; contact support.'}};
  const access = requestCustomerAccess(email);
  if (!access.error) {
    try { await sendCustomerAccessEmail({to:email,token:access.token}); }
    catch (_err) {
      // Deliberately do not disclose whether an email belongs to a customer.
      console.error('customer recovery mail delivery failed');
    }
  }
  return {status:202,body:{message:'If an account with purchases exists for this email, a private access link will be sent.'}};
}
app.post("/api/customer/access/request", strictLimit, async (req, res) => {
  const result = await safeRecoveryEmail(req.body?.email);
  res.status(result.status).json(result.body);
});

app.get("/api/customer/access", (req, res) => {
  const token = String(req.query.token || "");
  const result = customerAccess(token);
  if (result.error) return res.status(401).json({ error: result.error });
  res.json(result);
});

app.post("/api/purchases/recover", strictLimit, async (req, res) => {
  // Legacy route compatibility without exposing raw entitlement tokens.
  // An email-ownership check is mandatory before revealing a purchase.
  const result = await safeRecoveryEmail(req.body?.email);
  res.status(result.status).json(result.body);
});

app.get("/api/digital-access/:purchaseId/:productId", (req, res) => {
  const result = resolveDigitalAccess({
    purchaseId: req.params.purchaseId,
    productId: req.params.productId,
    token: req.query.token
  });
  if (result.error) return res.status(401).json({ error: result.error });
  res.json(result);
});

app.post("/api/purchases/refund", (req, res) => {
  if (!authorizeCron(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const result = markPurchaseRefunded({
    purchaseId: req.body?.purchaseId,
    reason: req.body?.reason
  });
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
});

app.get("/api/revenue/dashboard", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(revenueDashboard());
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  res.status(500).json({ error: "Internal server error" });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

module.exports = app;
