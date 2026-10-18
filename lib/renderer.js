const fs = require("fs");
const path = require("path");
const { PUBLIC_SITES_DIR } = require("./paths");
const { savePostArchive } = require("./post-archive");
const { themeKeyForNiche, THEMES } = require("./themes");
const { escapeHtml, escapeXml, imageFor, formatDate, formatLongDate } = require("./html-utils");
const { commerceConfig } = require("./monetization");

function themeCss(theme) {
  return `:root {
  color-scheme: ${theme.mode};
  --paper: ${theme.paper};
  --panel: ${theme.panel};
  --ink: ${theme.ink};
  --body: ${theme.body};
  --muted: ${theme.muted};
  --line: ${theme.line};
  --accent: ${theme.accent};
  --accent-deep: ${theme.accentDeep};
  --accent-2: ${theme.accent2};
  --glow: ${theme.glow};
  --radius: ${theme.radius};
  --display-font: "${theme.displayFont}", "Inter", sans-serif;
  --display-weight: ${theme.displayWeight};
  --display-transform: ${theme.displayTransform};
  --display-tracking: ${theme.displayTracking};
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--body);
  font-family: "Inter", ui-sans-serif, system-ui, sans-serif;
  font-size: 1.0625rem;
  line-height: 1.75;
}
a { color: inherit; }
img { max-width: 100%; display: block; }

.shell { max-width: 72rem; margin: 0 auto; padding: 0 1.5rem; }
.narrow { max-width: 46rem; }

.display {
  font-family: var(--display-font);
  font-weight: var(--display-weight);
  text-transform: var(--display-transform);
  letter-spacing: var(--display-tracking);
  color: var(--ink);
  line-height: 1.02;
}
.text-gradient {
  background: ${theme.gradient};
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.mono-label {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.25em;
  color: var(--muted);
}

.site-header {
  position: sticky; top: 0; z-index: 40;
  background: color-mix(in srgb, var(--paper) 80%, transparent);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line);
}
.site-header::before {
  content: ""; display: block; height: 2px;
  background: ${theme.gradient};
}
.site-header .bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.9rem 0; }
.wordmark { text-decoration: none; }
.wordmark .name { font-size: 1.35rem; }
.wordmark .tag { display: block; margin-top: 0.1rem; }
.site-nav { display: flex; gap: 1.25rem; align-items: center; flex-wrap: wrap; }
.site-nav a { text-decoration: none; }
.site-nav a:hover { color: var(--accent); }

.masthead { padding: 3.5rem 0 2.5rem; }
.masthead .kicker { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; }
.live-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 0 4px var(--glow); }
.masthead h1 { margin: 0; font-size: clamp(2.8rem, 8vw, 4.8rem); }
.masthead .sub { max-width: 38rem; color: var(--muted); margin: 1.1rem 0 0; }

.chip {
  display: inline-block;
  border: 1px solid var(--accent);
  color: var(--accent);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.65rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.2em;
  padding: 0.25rem 0.6rem;
  text-decoration: none;
}
.chip:hover { background: var(--accent); color: var(--paper); }

.card {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: var(--radius);
  overflow: hidden;
  transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}
.card:hover { transform: translateY(-3px); border-color: var(--accent); box-shadow: 0 0 22px -4px var(--glow), 0 14px 30px -18px rgba(0,0,0,0.4); }
.card .thumb { display: block; overflow: hidden; }
.card .thumb img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; display: block; transition: transform 0.35s ease; }
.card:hover .thumb img { transform: scale(1.04); }
.card .body { display: flex; flex-direction: column; align-items: flex-start; gap: 0.15rem; padding: 1.15rem 1.25rem 1.35rem; }
.card h2, .card h3 { margin: 0.6rem 0 0.45rem; font-size: 1.18rem; line-height: 1.25; }
.card h2 a, .card h3 a { color: var(--ink); text-decoration: none; }
.card h2 a:hover, .card h3 a:hover { color: var(--accent); }
.card p { margin: 0 0 0.8rem; color: var(--muted); font-size: 0.95rem; }
.meta { color: var(--muted); font-size: 0.8rem; font-family: "JetBrains Mono", monospace; }

.featured { display: grid; gap: 0; grid-template-columns: 1fr; margin-bottom: 3rem; }
.featured .thumb img { aspect-ratio: 4 / 3; }
.featured .body { padding: 1.6rem 1.75rem; display: flex; flex-direction: column; justify-content: center; }
.featured h2 { font-size: clamp(1.6rem, 3.5vw, 2.3rem); }
@media (min-width: 800px) { .featured { grid-template-columns: 3fr 2fr; } }

.divider { display: flex; align-items: center; gap: 1rem; margin: 2.5rem 0 1.75rem; }
.divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, transparent, var(--line)); }
.divider::after { background: linear-gradient(90deg, var(--line), transparent); }

.grid-cards { display: grid; gap: 1.5rem; grid-template-columns: 1fr; padding-bottom: 1rem; }
@media (min-width: 640px) { .grid-cards { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 1024px) { .grid-cards { grid-template-columns: repeat(3, 1fr); } }

article.post { padding: 3rem 0 1rem; }
article.post .headline { font-size: clamp(2.1rem, 6vw, 3.4rem); margin: 0.9rem 0 1rem; }
article.post .dek { font-size: 1.2rem; color: var(--muted); font-style: italic; margin: 0 0 2rem; }
article.post figure { margin: 0 0 2.25rem; }
article.post figure img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: var(--radius); border: 1px solid var(--line); }
article.post figcaption { margin-top: 0.5rem; }
article.post h2 { font-family: var(--display-font); color: var(--ink); font-size: 1.45rem; margin: 2.4rem 0 0.8rem; }
article.post h2::before { content: "// "; color: var(--accent); font-family: "JetBrains Mono", monospace; font-size: 1rem; }

.callout { border-left: 3px solid var(--accent); background: var(--panel); padding: 1rem 1.25rem; margin: 2rem 0; border-radius: 0 var(--radius) var(--radius) 0; }
.callout .mono-label { color: var(--accent); }
.callout p { margin: 0.4rem 0 0; color: var(--ink); }
.callout.warn { border-left-color: #d97706; }
.callout.warn .mono-label { color: #d97706; }

.procon { display: grid; gap: 1px; grid-template-columns: 1fr; background: var(--line); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; margin: 2rem 0; }
@media (min-width: 640px) { .procon { grid-template-columns: 1fr 1fr; } }
.procon section { background: var(--paper); padding: 1.1rem 1.25rem; }
.procon ul { margin: 0.6rem 0 0; padding-left: 1.1rem; }
.procon li { margin: 0.3rem 0; font-size: 0.95rem; }
.procon .pro .mono-label { color: #059669; }
.procon .con .mono-label { color: #e11d48; }

details.faq { border: 1px solid var(--line); border-radius: var(--radius); margin: 0.6rem 0; background: var(--panel); }
details.faq summary { cursor: pointer; padding: 0.85rem 1.1rem; font-weight: 600; color: var(--ink); list-style: none; display: flex; justify-content: space-between; gap: 1rem; }
details.faq summary::after { content: "+"; font-family: "JetBrains Mono", monospace; color: var(--accent); transition: transform 0.2s ease; }
details.faq[open] summary::after { transform: rotate(45deg); }
details.faq .answer { padding: 0 1.1rem 1rem; color: var(--muted); }

.sources { margin: 2rem 0; padding: 0; list-style: none; }
.sources li { display: flex; gap: 0.9rem; padding: 0.55rem 0; border-bottom: 1px solid var(--line); }
.sources .num { font-family: "JetBrains Mono", monospace; color: var(--accent); font-size: 0.8rem; padding-top: 0.2rem; }
.sources a { color: var(--ink); text-decoration: none; }
.sources a:hover { color: var(--accent); }

.tags { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 2rem 0; }

.newsletter { border: 1px solid var(--line); background: var(--panel); border-radius: var(--radius); padding: 1.6rem 1.75rem; margin: 2.5rem 0; }
.newsletter h3 { margin: 0.4rem 0 0.3rem; color: var(--ink); }
.newsletter p { margin: 0 0 1rem; color: var(--muted); font-size: 0.95rem; }
.newsletter form { display: flex; gap: 0.6rem; flex-wrap: wrap; }
.newsletter input[type="email"] {
  flex: 1; min-width: 200px;
  background: var(--paper); color: var(--ink);
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: 0.65rem 0.9rem; font: inherit;
}
.newsletter button {
  background: ${theme.gradient};
  color: #fff; border: 0; border-radius: var(--radius);
  padding: 0.65rem 1.3rem; font: inherit; font-weight: 700; cursor: pointer;
}
.newsletter button:hover { box-shadow: 0 0 18px -2px var(--glow); }
.newsletter .hp { position: absolute; left: -9999px; }
.newsletter .ack { color: var(--accent); font-size: 0.9rem; margin-top: 0.6rem; display: none; }

.monetize { border: 1px solid var(--line); background: var(--panel); border-radius: var(--radius); padding: 1.4rem; margin: 2.5rem 0; }
.monetize h2, .monetize h3 { margin-top: 0.35rem; }
.commerce-grid { display: grid; gap: 1rem; grid-template-columns: 1fr; margin-top: 1rem; }
@media (min-width: 720px) { .commerce-grid { grid-template-columns: repeat(3, 1fr); } }
.commerce-item { border: 1px solid var(--line); border-radius: var(--radius); padding: 1rem; background: color-mix(in srgb, var(--paper) 70%, var(--panel)); }
.commerce-item strong { display: block; color: var(--ink); line-height: 1.25; }
.commerce-item p { margin: 0.5rem 0 0.8rem; color: var(--muted); font-size: 0.9rem; }
.commerce-item a, .market-links a, .sponsor a { color: var(--accent); text-decoration: none; font-weight: 700; }
.sponsor { border-left: 3px solid var(--accent-2); padding-left: 1rem; margin: 1rem 0; }
.market-links { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 1rem; }
.disclosure { color: var(--muted); font-size: 0.78rem; line-height: 1.5; }

.keep-reading { margin: 2.5rem 0; }
.keep-reading ul { list-style: none; padding: 0; margin: 1rem 0 0; }
.keep-reading li { border-bottom: 1px solid var(--line); padding: 0.7rem 0; display: flex; justify-content: space-between; gap: 1rem; }
.keep-reading a { color: var(--ink); text-decoration: none; font-weight: 600; }
.keep-reading a:hover { color: var(--accent); }

.site-footer { border-top: 1px solid var(--line); margin-top: 4rem; padding: 3rem 0 3.5rem; }
.site-footer .cols { display: grid; gap: 2rem; grid-template-columns: 1fr; }
@media (min-width: 800px) { .site-footer .cols { grid-template-columns: 1.2fr 1fr; } }
.site-footer .links { display: flex; gap: 1.25rem; flex-wrap: wrap; margin: 0.9rem 0; }
.site-footer .links a { text-decoration: none; }
.site-footer .links a:hover { color: var(--accent); }
.site-footer .fine { color: var(--muted); font-size: 0.85rem; line-height: 1.6; }
`;
}

function fontLinks(theme) {
  return `<link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?${theme.fontQuery}&family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@700&display=swap" />`;
}

const PORTFOLIO_ANALYTICS_SCRIPT = `<script defer src="/portfolio-analytics.js"></script>`;

function resolveElevenLabsAgentId(site) {
  if (site.elevenlabsAgentId) return String(site.elevenlabsAgentId).trim();
  const defaultAgentId = String(process.env.ELEVENLABS_AGENT_ID || "").trim();
  const mappingRaw = String(process.env.ELEVENLABS_AGENT_IDS_JSON || "").trim();
  if (!mappingRaw) return defaultAgentId;
  try {
    const mapping = JSON.parse(mappingRaw);
    if (mapping && typeof mapping === "object") {
      const bySlug = mapping[site.slug];
      const byNiche = mapping[site.nicheId];
      const resolved = String(bySlug || byNiche || defaultAgentId || "").trim();
      return resolved;
    }
  } catch (_error) {}
  return defaultAgentId;
}

function renderElevenLabsAgent(site) {
  const agentId = resolveElevenLabsAgentId(site);
  if (!agentId) return "";
  return `<section class="newsletter" style="margin-top:1rem">
      <span class="mono-label">AI guide</span>
      <h3 class="display">Talk to the ${escapeHtml(site.name)} assistant</h3>
      <p>Ask for summaries, product recommendations, and next-step guidance for this niche.</p>
      <elevenlabs-convai agent-id="${escapeHtml(agentId)}"></elevenlabs-convai>
    </section>
    <script src="https://unpkg.com/@elevenlabs/convai-widget-embed" async></script>`;
}

const NEWSLETTER_SCRIPT = `<script>
document.addEventListener("submit", function (event) {
  var form = event.target.closest("[data-newsletter]");
  if (!form) return;
  event.preventDefault();
  var ack = form.parentElement.querySelector(".ack");
  var email = form.querySelector('input[name="email"]');
  var hp = form.querySelector('input[name="website"]');
  fetch(form.getAttribute('data-endpoint') || '/api/newsletter/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email && email.value, website: hp && hp.value, site: form.getAttribute('data-site') || document.title })
  }).catch(function () {});
  if (ack) { ack.style.display = "block"; }
  form.reset();
});
</script>`;

function renderNewsletter(site) {
  return `<aside class="newsletter">
      <span class="mono-label">Newsletter</span>
      <h3 class="display">Get the weekly dispatch</h3>
      <p>The week's highest-signal ${escapeHtml(site.name)} stories, synthesized. No spam.</p>
      <form data-newsletter data-site="${escapeHtml(site.slug || site.name)}" data-endpoint="/api/newsletter/subscribe">
        <input type="email" name="email" placeholder="you@example.com" required />
        <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" />
        <button type="submit">Subscribe</button>
      </form>
      <p class="ack">You're on the list. Watch for the next dispatch.</p>
    </aside>`;
}

function renderMonetization(site, root = "") {
  const commerce = commerceConfig(site);
  // REVIVE-KIT 2026-10-18: never render a "Shop the stack" section with no
  // real offers behind it (dead product links, empty grids).
  const hasOffers = commerce.products.length > 0 || commerce.marketplaces.length > 0 || commerce.sponsor;
  if (!hasOffers) return "";
  const shopPath = `${root}#shop`;
  const storeBase = (site.streamUrl || "/").replace(/\/+$/, "");
  const sponsor = commerce.sponsor
    ? `<div class="sponsor"><span class="mono-label">${escapeHtml(commerce.sponsor.label)}</span><p><strong>${escapeHtml(commerce.sponsor.name)}</strong> — ${escapeHtml(commerce.sponsor.tagline)}</p><a data-analytics-event="sponsor_click" data-placement="publication_offer" href="${escapeHtml(commerce.sponsor.url)}" rel="sponsored noopener nofollow">Visit sponsor →</a></div>`
    : "";
  const products = commerce.products.length
    ? `<div class="commerce-grid">${commerce.products
        .map(
          (product) => `<article class="commerce-item"><strong>${escapeHtml(product.name)}</strong><p>${escapeHtml(product.description)}</p><a data-analytics-event="product_cta" data-placement="publication_offer" href="${escapeHtml(storeBase)}/store#product-${product.id}">View product →</a></article>`
        )
        .join("\n")}</div>`
    : "";
  const marketplaces = commerce.marketplaces.length
    ? `<div class="market-links">${commerce.marketplaces.map((link) => `<a data-analytics-event="affiliate_click" data-merchant="${escapeHtml(link.label)}" data-placement="publication_marketplace" href="${escapeHtml(link.url)}" rel="noopener nofollow">${escapeHtml(link.label)}</a>`).join("\n")}</div>`
    : "";
  return `<section class="monetize" id="shop">
      <span class="mono-label">Shop the stack</span>
      <h2 class="display">Useful tools for ${escapeHtml(site.audience || site.name)}</h2>
      <p>Digital guides, templates, and partner picks selected for this niche.</p>
      ${sponsor}
      ${products}
      ${marketplaces}
      <p style="margin-top:1rem"><a href="${escapeHtml(shopPath)}" style="color:var(--accent);text-decoration:none">Browse offers for this dispatch →</a></p>
      <p class="disclosure">${escapeHtml(commerce.disclosure)}</p>
    </section>`;
}

function renderChrome(site, { root, title, description, body, theme }) {
  const categories = site.categories.slice(0, 3);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  ${fontLinks(theme)}
  <link rel="stylesheet" href="${root}assets/site.css" />
  <link rel="alternate" type="application/rss+xml" title="${escapeHtml(site.name)}" href="${root}feed.xml" />
</head>
<body>
  <header class="site-header">
    <div class="shell bar">
      <a class="wordmark" href="${root}">
        <span class="name display text-gradient">${escapeHtml(site.name)}</span>
        <span class="tag mono-label">${categories.map(escapeHtml).join(" · ")}</span>
      </a>
      <nav class="site-nav mono-label">
        <a href="${root}#dispatches">Latest</a>
        ${categories.map((category) => `<a href="${root}#dispatches">${escapeHtml(category)}</a>`).join("\n        ")}
        <a href="${root}about.html">About</a>
        <a href="${root}#shop">Shop</a>
        <a href="${root}feed.xml">RSS</a>
      </nav>
    </div>
  </header>
${body}
  <footer class="site-footer">
    <div class="shell cols">
      <div>
        <span class="display text-gradient" style="font-size:1.3rem">${escapeHtml(site.name)}</span>
        <p class="fine">${escapeHtml(site.tagline)} A new dispatch lands on its own schedule, generated from what's trending.</p>
        <div class="links mono-label">
          <a href="${root}about.html">About</a>
          <a href="${root}feed.xml">RSS</a>
          <a href="${site.streamUrl}" rel="noopener">BeyondMythos stream</a>
        </div>
        <p class="fine">© 2026 ${escapeHtml(site.name)} — No humans were harmed in the making of this blog.</p>
      </div>
      <div>
        ${renderNewsletter(site)}
        ${renderElevenLabsAgent(site)}
        <p class="fine"><strong>Editorial standards:</strong> articles on this site are researched and drafted with AI and published under editorial oversight as part of the BeyondMythos network. Every post cites its sources.</p>
      </div>
    </div>
  </footer>
  ${NEWSLETTER_SCRIPT}
  ${PORTFOLIO_ANALYTICS_SCRIPT}
</body>
</html>`;
}

function renderCard(site, post, { heading = "h3" } = {}) {
  return `<article class="card">
      <a class="thumb" href="posts/${post.slug}.html" tabindex="-1" aria-hidden="true">
        <img src="${imageFor(site, post.slug, 640, 400)}" alt="" loading="lazy" />
      </a>
      <div class="body">
        <span class="chip">${escapeHtml(post.category)}</span>
        <${heading} class="display"><a href="posts/${post.slug}.html">${escapeHtml(post.title)}</a></${heading}>
        <p>${escapeHtml(post.dek)}</p>
        <span class="meta">${formatDate(post.publishedAt)} · ${post.readMinutes} min read</span>
      </div>
    </article>`;
}

function renderHome(site, posts, theme) {
  const [featured, ...rest] = posts;
  const body = `  <main class="shell">
    <section class="masthead">
      <div class="kicker">
        <span class="live-dot"></span>
        <span class="mono-label">${escapeHtml(formatLongDate(site.createdAt))} · Updated on deploy</span>
      </div>
      <h1 class="display"><span class="text-gradient">${escapeHtml(site.name)}</span></h1>
      <p class="sub">${escapeHtml(site.tagline)} ${escapeHtml(`Dispatches for ${site.audience}, synthesized from across the web.`)}</p>
    </section>

    <section class="featured card">
      <a class="thumb" href="posts/${featured.slug}.html" tabindex="-1" aria-hidden="true">
        <img src="${imageFor(site, featured.slug, 960, 720)}" alt="" />
      </a>
      <div class="body">
        <span class="chip">${escapeHtml(featured.category)}</span>
        <h2 class="display"><a href="posts/${featured.slug}.html">${escapeHtml(featured.title)}</a></h2>
        <p>${escapeHtml(featured.dek)}</p>
        <span class="meta">${formatDate(featured.publishedAt)} · ${featured.readMinutes} min read</span>
      </div>
    </section>

    <div class="divider" id="dispatches"><span class="mono-label" style="color:var(--accent)">More dispatches</span></div>

    <section class="grid-cards">
${rest.map((post) => renderCard(site, post)).join("\n")}
    </section>

    ${renderMonetization(site)}
  </main>`;

  return renderChrome(site, {
    root: "",
    title: `${site.name} · ${site.tagline}`,
    description: `${site.tagline} Dispatches for ${site.audience}.`,
    body,
    theme
  });
}

function renderPost(site, post, posts, theme) {
  const related = posts.filter((other) => other.slug !== post.slug).slice(0, 3);
  const body = `  <main class="shell narrow">
    <article class="post">
      <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
        <span class="chip">${escapeHtml(post.category)}</span>
        <span class="meta">${formatDate(post.publishedAt)} · ${post.readMinutes} min read</span>
      </div>
      <h1 class="headline display text-gradient">${escapeHtml(post.title)}</h1>
      <p class="dek">${escapeHtml(post.dek)}</p>
      <figure>
        <img src="${imageFor(site, post.slug, 1280, 720)}" alt="" />
        <figcaption class="mono-label">Photo via LoremFlickr</figcaption>
      </figure>

      <div class="callout">
        <span class="mono-label">Takeaway</span>
        <p>${escapeHtml(post.takeaway)}</p>
      </div>

      <h2>What happened</h2>
      <p>${escapeHtml(post.whatHappened)}</p>

      <h2>Why it matters</h2>
      <p>${escapeHtml(post.whyItMatters)}</p>

      <h2>How to think about it</h2>
      <p>${escapeHtml(post.howToThink)}</p>

      <div class="procon">
        <section class="pro">
          <span class="mono-label">Pros</span>
          <ul>${post.pros.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </section>
        <section class="con">
          <span class="mono-label">Cons</span>
          <ul>${post.cons.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </section>
      </div>

      <div class="callout warn">
        <span class="mono-label">Watch out</span>
        <p>${escapeHtml(post.watchOut)}</p>
      </div>

      <h2>FAQ</h2>
${post.faq.map((item) => `      <details class="faq"><summary>${escapeHtml(item.q)}</summary><p class="answer">${escapeHtml(item.a)}</p></details>`).join("\n")}

      <h2>Sources</h2>
      <ul class="sources">
${post.sources.map((source, index) => `        <li><span class="num">${String(index + 1).padStart(2, "0")}</span><a href="${escapeHtml(source.url)}" rel="noopener nofollow">${escapeHtml(source.label)}</a></li>`).join("\n")}
      </ul>

      <div class="tags">
${post.tags.map((tag) => `        <span class="chip">#${escapeHtml(tag)}</span>`).join("\n")}
      </div>

      ${renderNewsletter(site)}

      ${renderMonetization(site, "../")}

      <section class="keep-reading">
        <span class="mono-label" style="color:var(--accent)">Keep reading</span>
        <ul>
${related.map((other) => `          <li><a href="${other.slug}.html">${escapeHtml(other.title)}</a><span class="meta">${formatDate(other.publishedAt)}</span></li>`).join("\n")}
        </ul>
        <p style="margin-top:1.2rem"><a href="../" style="color:var(--accent);text-decoration:none">← Back to ${escapeHtml(site.name)}</a></p>
      </section>
    </article>
  </main>`;

  return renderChrome(site, {
    root: "../",
    title: `${post.title} · ${site.name}`,
    description: post.dek,
    body,
    theme
  });
}

function renderAbout(site, theme) {
  const body = `  <main class="shell narrow">
    <article class="post">
      <span class="mono-label" style="color:var(--accent)">About</span>
      <h1 class="headline display text-gradient">About ${escapeHtml(site.name)}</h1>
      <p class="dek">${escapeHtml(site.tagline)}</p>

      <h2>What this is</h2>
      <p>${escapeHtml(site.name)} is an automated niche dispatch for ${escapeHtml(site.audience)}, published by the BeyondMythos network. New sites and new posts are generated on a continuous schedule — synthesized from what's trending, then shaped into short, practical briefs.</p>

      <h2>Editorial standards</h2>
      <p>Articles on this site are researched and drafted with AI and published under editorial oversight. Every post carries a dated byline, a reading time, and a numbered list of sources. Nothing here is presented as first-hand reporting.</p>

      <h2>Topics we cover</h2>
      <p>${site.categories.map(escapeHtml).join(" · ")}</p>

      <div class="callout">
        <span class="mono-label">The network</span>
        <p>This site is one of a continuously growing stream. See everything the forge has deployed at the <a href="${site.streamUrl}" rel="noopener" style="color:var(--accent)">BeyondMythos live stream</a>.</p>
      </div>
    </article>
  </main>`;

  return renderChrome(site, {
    root: "",
    title: `About · ${site.name}`,
    description: `About ${site.name} — an automated dispatch for ${site.audience}.`,
    body,
    theme
  });
}

function canonicalSiteUrl(site) {
  return (site.localUrl || site.url || "").replace(/\/+$/, "");
}

function renderFeed(site, posts) {
  const base = canonicalSiteUrl(site);
  const items = posts
    .slice(0, 30)
    .map(
      (post) => `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${base}/posts/${post.slug}.html</link>
      <guid>${base}/posts/${post.slug}.html</guid>
      <pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>
      <description>${escapeXml(post.dek)}</description>
    </item>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(site.name)}</title>
    <link>${base}/</link>
    <description>${escapeXml(site.tagline)}</description>
${items}
  </channel>
</rss>
`;
}

function writeSiteFiles(site, posts, baseUrl) {
  const theme = THEMES[site.design] || THEMES[themeKeyForNiche(site.nicheId)];
  site.design = site.design || themeKeyForNiche(site.nicheId);
  site.streamUrl = `${baseUrl}/`;
  site.localUrl = site.localUrl || `${baseUrl}/sites/${site.slug}/`;
  site.elevenlabsAgentId = resolveElevenLabsAgentId(site) || null;
  site.url = site.localUrl;

  const siteDir = path.join(PUBLIC_SITES_DIR, site.slug);
  const postsDir = path.join(siteDir, "posts");
  const assetsDir = path.join(siteDir, "assets");
  fs.rmSync(siteDir, { recursive: true, force: true });
  fs.mkdirSync(postsDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  fs.writeFileSync(path.join(assetsDir, "site.css"), themeCss(theme), "utf8");
  fs.writeFileSync(path.join(siteDir, "index.html"), renderHome(site, posts, theme), "utf8");
  fs.writeFileSync(path.join(siteDir, "about.html"), renderAbout(site, theme), "utf8");
  fs.writeFileSync(path.join(siteDir, "feed.xml"), renderFeed(site, posts), "utf8");

  for (const post of posts) {
    fs.writeFileSync(path.join(postsDir, `${post.slug}.html`), renderPost(site, post, posts, theme), "utf8");
  }

  savePostArchive(site.slug, posts);
  return siteDir;
}

module.exports = { writeSiteFiles, renderHome, renderPost, renderFeed, themeCss };
