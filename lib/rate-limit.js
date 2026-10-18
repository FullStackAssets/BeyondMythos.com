// WORKER-4R 2026-10-18 — roadmap item 378: rate-limit expensive endpoints.
// In-memory sliding-window limiter. No dependency, no persistence.
// REVIEW BEFORE DEPLOY. Deploying is Nic's call.
"use strict";

const buckets = new Map();

function clientKey(req) {
  // trust proxy is set (app.set("trust proxy", 1)); fall back safely.
  const fwd = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.ip || "unknown";
}

function prune(now, windowMs) {
  for (const [key, stamps] of buckets) {
    const fresh = stamps.filter((t) => now - t < windowMs);
    if (fresh.length) buckets.set(key, fresh);
    else buckets.delete(key);
  }
  // guard against unbounded growth
  if (buckets.size > 20000) buckets.clear();
}

// max requests per windowMs per client key. Sends 429 with Retry-After.
function rateLimit({ windowMs = 60000, max = 60 } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    if (Math.random() < 0.01) prune(now, windowMs);
    const key = `${clientKey(req)}`;
    const stamps = buckets.get(key) || [];
    const fresh = stamps.filter((t) => now - t < windowMs);
    if (fresh.length >= max) {
      res.set("Retry-After", Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: "Too many requests, slow down." });
    }
    fresh.push(now);
    buckets.set(key, fresh);
    next();
  };
}

const strict = rateLimit({ windowMs: 60000, max: 30 }); // checkout, access, recover, newsletter
const standard = rateLimit({ windowMs: 60000, max: 200 }); // everything else under /api

module.exports = { rateLimit, strict, standard };
