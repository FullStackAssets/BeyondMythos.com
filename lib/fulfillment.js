const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getProductById } = require("./products");

function commerceStatePath() {
  // DATA_DIR lets production point commerce state at a persistent disk.
  // Default keeps the historical data/commerce-state.json location.
  return path.join(
    process.env.DATA_DIR || path.join(__dirname, "..", "data"),
    "commerce-state.json"
  );
}
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 14;

function ensureStateFile() {
  const statePath = commerceStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  if (fs.existsSync(statePath)) return;
  saveCommerceState({ customers: [], purchases: [], events: [] });
}

function loadCommerceState() {
  ensureStateFile();
  const raw = fs.readFileSync(commerceStatePath(), "utf8");
  const parsed = JSON.parse(raw);
  return {
    customers: Array.isArray(parsed.customers) ? parsed.customers : [],
    purchases: Array.isArray(parsed.purchases) ? parsed.purchases : [],
    events: Array.isArray(parsed.events) ? parsed.events : []
  };
}

function saveCommerceState(state) {
  const next = {
    customers: Array.isArray(state.customers) ? state.customers : [],
    purchases: Array.isArray(state.purchases) ? state.purchases : [],
    events: Array.isArray(state.events) ? state.events : []
  };
  fs.writeFileSync(commerceStatePath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function accessSecret() {
  if (process.env.NODE_ENV === 'production') {
    const secret = process.env.CUSTOMER_ACCESS_SECRET || '';
    if (secret.length < 32) throw new Error('Production customer access secret is missing or too short');
    return secret;
  }
  return String(process.env.CUSTOMER_ACCESS_SECRET || process.env.CRON_SECRET || 'local-dev-access-secret');
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function parseBase64url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signToken(payload, ttlSeconds = ACCESS_TOKEN_TTL_SECONDS) {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const body = { ...payload, exp: expiresAt };
  const encoded = base64url(JSON.stringify(body));
  const sig = crypto.createHmac("sha256", accessSecret()).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function verifyToken(token) {
  const [encoded, providedSig] = String(token || "").split(".");
  if (!encoded || !providedSig) return { ok: false, error: "Invalid token format" };
  const expectedSig = crypto.createHmac("sha256", accessSecret()).update(encoded).digest("base64url");
  if (expectedSig.length !== providedSig.length) {
    return { ok: false, error: "Invalid token signature" };
  }
  if (!crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(providedSig))) {
    return { ok: false, error: "Invalid token signature" };
  }

  try {
    const payload = JSON.parse(parseBase64url(encoded));
    if (!payload.exp || payload.exp < Date.now()) {
      return { ok: false, error: "Token expired" };
    }
    if (payload.mode !== 'customer-access' || !payload.customerId) {
      return { ok: false, error: 'Invalid token scope' };
    }
    return { ok: true, payload };
  } catch (_error) {
    return { ok: false, error: "Invalid token payload" };
  }
}

function asCatalogItem(item) {
  const productId = Number(item?.id ?? item?.productId ?? item?.product_id);
  const quantity = Number(item?.quantity || 1);
  if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity < 1) return null;
  const product = getProductById(productId);
  if (!product) return null;
  return {
    productId,
    name: product.name,
    type: product.type,
    category: product.category,
    quantity,
    unitAmountCents: Math.round(Number(product.price) * 100),
    totalAmountCents: Math.round(Number(product.price) * 100) * quantity,
    offerTier: product.offerTier || null
  };
}

function findOrCreateCustomer(state, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  let customer = state.customers.find((entry) => entry.email === normalized);
  if (customer) {
    customer.lastSeenAt = new Date().toISOString();
    return customer;
  }

  customer = {
    id: `cus_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    email: normalized,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    tags: []
  };
  state.customers.push(customer);
  return customer;
}

function digitalDeliverablesForPurchase(purchase) {
  return purchase.items
    .filter((item) => item.type === "digital")
    .map((item) => {
      const product = getProductById(item.productId);
      const formats = Array.isArray(product?.formats) && product.formats.length ? product.formats : ["file"];
      return {
        productId: item.productId,
        name: item.name,
        quantity: item.quantity,
        formats,
        path: `/api/digital-access/${purchase.id}/${item.productId}`
      };
    });
}

function accessResponseForPurchase(purchase, customer) {
  const accessToken = signToken({ customerId: customer.id, email: customer.email, mode: "customer-access" });
  return {
    purchase,
    accessToken,
    accessExpiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    deliverables: digitalDeliverablesForPurchase(purchase)
  };
}

function recordEvent(state, event) {
  state.events.push({
    id: `evt_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`,
    createdAt: new Date().toISOString(),
    ...event
  });
}

function recordCheckoutStarted(payload = {}) {
  const state = loadCommerceState();
  recordEvent(state, {
    type: "checkout_started",
    site: String(payload.site || "beyondmythos.com"),
    emailHash: payload.email ? hash(normalizeEmail(payload.email)) : null,
    itemCount: Array.isArray(payload.items) ? payload.items.length : 0
  });
  saveCommerceState(state);
}

function recordPurchase(payload = {}) {
  const email = normalizeEmail(payload.email);
  if (!email) return { error: "Valid email is required" };

  const items = Array.isArray(payload.items) ? payload.items.map(asCatalogItem).filter(Boolean) : [];
  if (!items.length) return { error: "At least one valid catalog item is required" };

  const state = loadCommerceState();
  const provider = String(payload.provider || "manual");
  const providerSessionId = payload.providerSessionId ? String(payload.providerSessionId) : null;
  const existingPurchase =
    providerSessionId &&
    state.purchases.find((purchase) => purchase.provider === provider && purchase.providerSessionId === providerSessionId);
  if (existingPurchase) {
    const existingCustomer =
      state.customers.find((entry) => entry.id === existingPurchase.customerId) || findOrCreateCustomer(state, email);
    saveCommerceState(state);
    return {
      ...accessResponseForPurchase(existingPurchase, existingCustomer),
      existing: true
    };
  }

  const customer = findOrCreateCustomer(state, email);

  const purchase = {
    id: `ord_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    customerId: customer.id,
    email,
    site: String(payload.site || "beyondmythos.com"),
    provider,
    providerSessionId,
    status: String(payload.status || "paid"),
    currency: "usd",
    amountCents: items.reduce((sum, item) => sum + item.totalAmountCents, 0),
    items,
    sequences: {
      receipt: { status: "ready", updatedAt: new Date().toISOString() },
      onboarding: { status: "ready", updatedAt: new Date().toISOString() },
      upsell: { status: "queued", updatedAt: new Date().toISOString() },
      reactivation: { status: "queued", updatedAt: new Date().toISOString() }
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  state.purchases.push(purchase);

  recordEvent(state, {
    type: "purchase_completed",
    site: purchase.site,
    purchaseId: purchase.id,
    amountCents: purchase.amountCents,
    digitalItemCount: purchase.items.filter((item) => item.type === "digital").length,
    emailHash: hash(email)
  });

  saveCommerceState(state);
  return accessResponseForPurchase(purchase, customer);
}

function requestCustomerAccess(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { error: "Valid email is required" };

  const state = loadCommerceState();
  const customer = state.customers.find((entry) => entry.email === normalized);
  if (!customer) return { error: "No purchases found for this email" };

  customer.lastSeenAt = new Date().toISOString();
  saveCommerceState(state);

  const token = signToken({ customerId: customer.id, email: customer.email, mode: "customer-access" });
  return {
    token,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    accessUrl: `/api/customer/access?token=${encodeURIComponent(token)}`
  };
}

function customerAccess(token) {
  const verified = verifyToken(token);
  if (!verified.ok) return { error: verified.error };

  const state = loadCommerceState();
  const customer = state.customers.find((entry) => entry.id === verified.payload.customerId);
  if (!customer) return { error: "Customer not found" };

  const purchases = state.purchases
    .filter((purchase) => purchase.customerId === customer.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((purchase) => ({
      id: purchase.id,
      status: purchase.status,
      site: purchase.site,
      amountCents: purchase.amountCents,
      currency: purchase.currency,
      createdAt: purchase.createdAt,
      items: purchase.items,
      sequences: purchase.sequences,
      downloads: digitalDeliverablesForPurchase(purchase).map((deliverable) => ({
        ...deliverable,
        url: `${deliverable.path}?token=${encodeURIComponent(token)}`
      }))
    }));

  return {
    customer: {
      id: customer.id,
      email: customer.email,
      createdAt: customer.createdAt,
      lastSeenAt: customer.lastSeenAt
    },
    purchases
  };
}

function resolveDigitalAccess({ purchaseId, productId, token }) {
  const verified = verifyToken(token);
  if (!verified.ok) return { error: verified.error };

  const state = loadCommerceState();
  const purchase = state.purchases.find((entry) => entry.id === purchaseId);
  if (!purchase) return { error: "Purchase not found" };

  if (purchase.customerId !== verified.payload.customerId) {
    return { error: "Unauthorized for this purchase" };
  }

  const productIdNumber = Number(productId);
  const item = purchase.items.find((entry) => entry.productId === productIdNumber && entry.type === "digital");
  if (!item) return { error: "Digital deliverable not found" };

  const product = getProductById(productIdNumber);
  const formats = Array.isArray(product?.formats) && product.formats.length ? product.formats : [];
  const tokenParam = encodeURIComponent(String(token || ""));
  const downloads = formats.map((format) => ({
    format,
    url: `/api/downloads/${purchase.id}/${item.productId}/${format}?token=${tokenParam}`
  }));

  return {
    purchaseId: purchase.id,
    productId: item.productId,
    productName: item.name,
    offerTier: item.offerTier,
    formats,
    downloads,
    message:
      downloads.length > 0
        ? `Your download links are ready for ${item.name}.`
        : `Delivery access granted for ${item.name}.`,
    support: {
      recoverUrl: "/api/customer/access/request",
      instructions:
        "If a link expires, request a fresh access link with your purchase email."
    }
  };
}

const DOWNLOAD_CONTENT_TYPES = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  zip: "application/zip"
};

function resolveDownload({ purchaseId, productId, format, token }) {
  const verified = verifyToken(token);
  if (!verified.ok) return { error: verified.error };

  const state = loadCommerceState();
  const purchase = state.purchases.find((entry) => entry.id === purchaseId);
  if (!purchase) return { error: "Purchase not found" };

  if (purchase.customerId !== verified.payload.customerId) {
    return { error: "Unauthorized for this purchase" };
  }

  if (purchase.status === "refunded") {
    return { error: "This purchase was refunded" };
  }

  const productIdNumber = Number(productId);
  const item = purchase.items.find((entry) => entry.productId === productIdNumber && entry.type === "digital");
  if (!item) return { error: "Digital deliverable not found" };
  if (purchase.status !== 'paid') return { error: 'This purchase is not eligible for delivery' };

  const product = getProductById(productIdNumber);
  const formats = Array.isArray(product?.formats) ? product.formats : [];
  const requestedFormat = String(format || "").toLowerCase();
  if (!formats.includes(requestedFormat)) {
    return { error: "Format not available for this product" };
  }

  const relativePath = product?.files?.[requestedFormat];
  if (!relativePath) return { error: "Download file is not configured" };
  const filePath = path.join(__dirname, "..", relativePath);
  if (!fs.existsSync(filePath)) return { error: "Download file is missing" };

  const base = path.basename(filePath);
  return {
    filePath,
    fileName: base,
    contentType: DOWNLOAD_CONTENT_TYPES[requestedFormat] || "application/octet-stream",
    productName: item.name
  };
}

function recoverPurchaseAccess({ email, purchaseId }) {
  const access = requestCustomerAccess(email);
  if (access.error) return access;
  const details = customerAccess(access.token);
  if (details.error) return details;

  const purchase = details.purchases.find((entry) => entry.id === purchaseId);
  if (!purchase) return { error: "Purchase not found for this email" };

  return {
    purchaseId,
    token: access.token,
    expiresAt: access.expiresAt,
    downloads: purchase.downloads
  };
}

function markPurchaseRefunded({ purchaseId, reason }) {
  const state = loadCommerceState();
  const purchase = state.purchases.find((entry) => entry.id === purchaseId);
  if (!purchase) return { error: "Purchase not found" };

  purchase.status = "refunded";
  purchase.updatedAt = new Date().toISOString();
  purchase.refundReason = String(reason || "unspecified");

  recordEvent(state, {
    type: "refund",
    site: purchase.site,
    purchaseId: purchase.id,
    amountCents: purchase.amountCents
  });

  saveCommerceState(state);
  return { purchase };
}

function revenueDashboard() {
  const state = loadCommerceState();
  const started = state.events.filter((event) => event.type === "checkout_started").length;
  const completedPurchases = state.purchases.filter((purchase) => purchase.status === "paid");
  const refundedPurchases = state.purchases.filter((purchase) => purchase.status === "refunded");

  const grossRevenueCents = completedPurchases.reduce((sum, purchase) => sum + purchase.amountCents, 0);
  const refundedCents = refundedPurchases.reduce((sum, purchase) => sum + purchase.amountCents, 0);
  const netRevenueCents = grossRevenueCents - refundedCents;

  const topFunnels = Object.values(
    state.purchases.reduce((acc, purchase) => {
      const key = purchase.site || "unknown";
      const current = acc[key] || {
        site: key,
        purchases: 0,
        revenueCents: 0,
        refunded: 0
      };
      current.purchases += 1;
      current.revenueCents += purchase.amountCents;
      if (purchase.status === "refunded") current.refunded += 1;
      acc[key] = current;
      return acc;
    }, {})
  )
    .sort((a, b) => b.revenueCents - a.revenueCents)
    .slice(0, 10);

  const productPerformance = Object.values(
    state.purchases.reduce((acc, purchase) => {
      for (const item of purchase.items) {
        const key = String(item.productId);
        const row = acc[key] || {
          productId: item.productId,
          name: item.name,
          quantity: 0,
          revenueCents: 0,
          offerTier: item.offerTier || null
        };
        row.quantity += item.quantity;
        row.revenueCents += item.totalAmountCents;
        acc[key] = row;
      }
      return acc;
    }, {})
  )
    .sort((a, b) => b.revenueCents - a.revenueCents)
    .slice(0, 10);

  return {
    totals: {
      checkoutsStarted: started,
      purchasesCompleted: completedPurchases.length,
      refunds: refundedPurchases.length,
      conversionRate: started ? Number((completedPurchases.length / started).toFixed(4)) : 0,
      grossRevenueCents,
      refundedCents,
      netRevenueCents
    },
    topFunnels,
    productPerformance
  };
}

module.exports = {
  get COMMERCE_STATE_PATH() { return commerceStatePath(); },
  commerceStatePath,
  loadCommerceState,
  saveCommerceState,
  recordCheckoutStarted,
  recordPurchase,
  requestCustomerAccess,
  customerAccess,
  resolveDigitalAccess,
  resolveDownload,
  recoverPurchaseAccess,
  markPurchaseRefunded,
  revenueDashboard,
  verifyToken
};
