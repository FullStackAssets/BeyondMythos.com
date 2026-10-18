const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const NEWSLETTER_STATE_PATH = path.join(__dirname, "..", "data", "newsletter-signups.json");

// Same secret pattern as lib/fulfillment.js accessSecret(). Never logged.
function newsletterSecret() {
  return String(process.env.CUSTOMER_ACCESS_SECRET || process.env.CRON_SECRET || "local-dev-access-secret");
}

function normalizeNewsletterEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// One-click unsubscribe signature: HMAC-SHA256 of the normalized email (hex).
function unsubscribeSignature(email) {
  return crypto.createHmac("sha256", newsletterSecret()).update(normalizeNewsletterEmail(email)).digest("hex");
}

// Accepts hex or base64url signatures; constant-time comparison.
function verifyUnsubscribeSignature(email, sig) {
  const provided = String(sig || "");
  if (!provided) return false;
  const normalized = normalizeNewsletterEmail(email);
  if (!normalized) return false;
  const expectedHex = unsubscribeSignature(normalized);
  const expectedB64 = crypto.createHmac("sha256", newsletterSecret()).update(normalized).digest("base64url");
  for (const expected of [expectedHex, expectedB64]) {
    if (expected.length !== provided.length) continue;
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return true;
  }
  return false;
}

function ensureStateFile() {
  if (fs.existsSync(NEWSLETTER_STATE_PATH)) return;
  fs.writeFileSync(NEWSLETTER_STATE_PATH, `${JSON.stringify({ signups: [] }, null, 2)}\n`, "utf8");
}

function loadNewsletterState() {
  ensureStateFile();
  const raw = fs.readFileSync(NEWSLETTER_STATE_PATH, "utf8");
  const parsed = JSON.parse(raw);
  return {
    signups: Array.isArray(parsed.signups) ? parsed.signups : []
  };
}

function saveNewsletterState(state) {
  const next = {
    signups: Array.isArray(state.signups) ? state.signups : []
  };
  fs.writeFileSync(NEWSLETTER_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function recordNewsletterSignup({ email, site }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedSite = String(site || "beyondmythos.com").trim().toLowerCase();
  if (!normalizedEmail) return { error: "Valid email required" };

  const state = loadNewsletterState();
  const existing = state.signups.find((entry) => entry.email === normalizedEmail && entry.site === normalizedSite);
  if (existing) {
    // Re-subscribing after an unsubscribe counts as fresh consent.
    if (existing.unsubscribedAt) delete existing.unsubscribedAt;
    existing.updatedAt = new Date().toISOString();
    saveNewsletterState(state);
    return { signup: existing, existing: true };
  }

  const signup = {
    id: `sub_${Date.now().toString(36)}`,
    email: normalizedEmail,
    site: normalizedSite,
    source: "site-newsletter",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.signups.push(signup);
  saveNewsletterState(state);
  return { signup, existing: false };
}

// Marks every signup for this email (any site) as unsubscribed. Keeps the record.
function recordNewsletterUnsubscribe({ email }) {
  const normalizedEmail = normalizeNewsletterEmail(email);
  if (!normalizedEmail) return { error: "Valid email required" };

  const state = loadNewsletterState();
  const matches = state.signups.filter((entry) => entry.email === normalizedEmail);
  if (!matches.length) return { error: "Email not found" };

  const now = new Date().toISOString();
  for (const entry of matches) {
    entry.unsubscribedAt = now;
    entry.updatedAt = now;
  }
  saveNewsletterState(state);
  return { ok: true, email: normalizedEmail, count: matches.length };
}

module.exports = {
  NEWSLETTER_STATE_PATH,
  loadNewsletterState,
  saveNewsletterState,
  recordNewsletterSignup,
  recordNewsletterUnsubscribe,
  unsubscribeSignature,
  verifyUnsubscribeSignature
};
