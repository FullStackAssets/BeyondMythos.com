const { listProducts } = require("./products");

const MARKETPLACES = [
  ["etsy", "Etsy", "ETSY_SHOP_URL"],
  ["gumroad", "Gumroad", "GUMROAD_PROFILE_URL"],
  ["shopify", "Shopify", "SHOPIFY_STORE_URL"],
  ["payhip", "Payhip", "PAYHIP_STORE_URL"],
  ["lemon-squeezy", "Lemon Squeezy", "LEMONSQUEEZY_STORE_URL"],
  ["ko-fi", "Ko-fi", "KOFI_SHOP_URL"]
];

function cleanUrl(value) {
  const url = String(value || "").trim();
  if (!url || !/^https?:\/\//i.test(url)) return "";
  return url;
}

function getMarketplaceLinks() {
  return MARKETPLACES.map(([key, label, env]) => ({ key, label, url: cleanUrl(process.env[env]) })).filter((link) => link.url);
}

function getSponsorSlot(site = {}) {
  const url = cleanUrl(process.env.SPONSOR_URL || process.env.SPONSOR_CTA_URL);
  if (!url) return null;
  return {
    label: process.env.SPONSOR_LABEL || "Sponsor",
    name: process.env.SPONSOR_NAME || "Featured partner",
    tagline:
      process.env.SPONSOR_TAGLINE ||
      `A relevant partner for ${site.audience || "builders and niche operators"}.`,
    url
  };
}

function affiliateDisclosure() {
  return (
    process.env.AFFILIATE_DISCLOSURE ||
    "Disclosure: some outbound links may be affiliate or partner links. We may earn a commission at no extra cost to you."
  );
}

function affiliateSearchUrl(query) {
  const template = cleanUrl(process.env.AFFILIATE_SEARCH_URL);
  const encoded = encodeURIComponent(query);
  if (template) return template.replace(/\{query\}/g, encoded);
  const amazonTag = String(process.env.AMAZON_ASSOCIATE_TAG || "").trim();
  const tag = amazonTag ? `&tag=${encodeURIComponent(amazonTag)}` : "";
  return `https://www.amazon.com/s?k=${encoded}${tag}`;
}

function productMatchesSite(product, site = {}) {
  const haystack = [
    site.name,
    site.nicheId,
    site.audience,
    ...(Array.isArray(site.categories) ? site.categories : [])
  ]
    .join(" ")
    .toLowerCase();
  const productText = [product.name, product.category, product.description].join(" ").toLowerCase();
  return productText.split(/[^a-z0-9]+/).some((word) => word.length > 4 && haystack.includes(word));
}

function recommendedProducts(site = {}, limit = 6) {
  // REVIVE-KIT 2026-10-18: only products with real downloadable files are
  // eligible for blog CTAs — never link fixture/dead products. Niche-matched
  // first, then any real products as fallback. As real Dropfable products land
  // in products.js, the funnel activates automatically with no code change.
  // Returns [] when nothing real exists — the renderer then shows no CTA.
  const digital = listProducts({ type: "digital" }).filter((product) => product.hasFiles);
  const matched = digital.filter((product) => productMatchesSite(product, site));
  const rest = digital.filter((product) => !matched.some((m) => m.id === product.id));
  const seen = new Set();
  return [...matched, ...rest].filter((product) => {
    if (seen.has(product.id)) return false;
    seen.add(product.id);
    return true;
  }).slice(0, limit);
}

function commerceConfig(site = {}) {
  return {
    sponsor: getSponsorSlot(site),
    marketplaces: getMarketplaceLinks(),
    disclosure: affiliateDisclosure(),
    affiliateSearchUrl: affiliateSearchUrl(site.audience || site.name || "niche site tools"),
    products: recommendedProducts(site)
  };
}

module.exports = {
  commerceConfig,
  getMarketplaceLinks,
  getSponsorSlot,
  recommendedProducts,
  affiliateDisclosure,
  affiliateSearchUrl
};
