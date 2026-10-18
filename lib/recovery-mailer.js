'use strict';

/** Secure one-time-delivery transport for already-signed customer access links.
 * Tokens must NEVER be exposed in HTTP responses to unauthenticated callers.
 * Uses Resend only after operator supplies a verified sender and provider key.
 */
const normalizeEmail = input => typeof input === 'string' ? input.trim().toLowerCase() : '';
const validEmail = input => {
  const value = normalizeEmail(input);
  return value.length >= 3 && value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
};
const escapeHtml = input => String(input).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function config() {
  const apiKey = process.env.RESEND_API_KEY || '';
  const from = process.env.RECOVERY_FROM_EMAIL || '';
  const site = process.env.BEYONDMYTHOS_PUBLIC_URL || process.env.FRONTEND_URL || '';
  let baseUrl;
  try {
    const u = new URL(site);
    if (u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash) baseUrl = u.origin;
  } catch (_) { /* not configured */ }
  return {apiKey, from, baseUrl};
}
function configured() {
  const c = config();
  return Boolean(c.apiKey && validEmail(c.from) && c.baseUrl);
}
function recoveryPageUrl(token) {
  const c = config();
  if (!c.baseUrl || !token) throw new Error('Recovery service is not configured');
  const url = new URL('/library', c.baseUrl);
  url.hash = 'token=' + encodeURIComponent(token);
  return url.toString();
}
async function sendCustomerAccessEmail({to, token, fetchImpl = globalThis.fetch}) {
  if (!validEmail(to)) throw new Error('Invalid email');
  if (!configured()) throw new Error('Recovery service is not configured');
  if (typeof fetchImpl !== 'function') throw new Error('Email provider unavailable');
  const c = config();
  const url = recoveryPageUrl(token);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 8000);
  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method:'POST',
      headers:{Authorization:`Bearer ${c.apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        from:c.from, to:[normalizeEmail(to)], subject:'Your BeyondMythos download access',
        html:`<p>You requested access to your BeyondMythos purchases.</p><p><a href="${escapeHtml(url)}">Open your private downloads</a></p><p>This link expires in 14 days. If you didn't request it, you can ignore this email.</p>`
      }),
      signal:abort.signal,
      redirect:'error'
    });
    if (!response || !response.ok) throw new Error('Recovery email was not accepted');
  } finally {
    clearTimeout(timeout);
  }
}
module.exports = {validEmail, configured, recoveryPageUrl, sendCustomerAccessEmail};
