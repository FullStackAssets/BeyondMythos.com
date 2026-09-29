#!/usr/bin/env node
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const { slugify } = require("../lib/slug");
const { buildCheckoutLineItems } = require("../lib/checkout");
const { getProductById, listProducts, offerTierForProduct } = require("../lib/products");
const { purchasePayloadFromSession } = require("../lib/stripe-webhooks");
const { parseModelJson, extractPostsArray } = require("../lib/content-prompts");
const {
  resolveContentProvider,
  isAiContentEnabled,
  contentModeLabel
} = require("../lib/content-provider");
const { postTemplates, hourlyPostTemplate } = require("../lib/templates");
const { themeKeyForNiche, THEMES } = require("../lib/themes");
const { renderHome } = require("../lib/renderer");
const { mapWithConcurrency } = require("../lib/concurrency");
const { getBaseUrl } = require("../lib/config");
const { pickNiche } = require("../lib/niches");
const { getMarketplaceLinks, getSponsorSlot, recommendedProducts, affiliateSearchUrl } = require("../lib/monetization");
const { loadPortfolioStrategy, summarizePortfolio, listPortfolioDomains } = require("../lib/portfolio");
const {
  COMMERCE_STATE_PATH,
  saveCommerceState,
  recordCheckoutStarted,
  recordPurchase,
  customerAccess,
  resolveDigitalAccess,
  revenueDashboard
} = require("../lib/fulfillment");
const {
  NEWSLETTER_STATE_PATH,
  saveNewsletterState,
  recordNewsletterSignup
} = require("../lib/newsletter");

describe("slugify", () => {
  it("converts text to kebab-case", () => {
    assert.equal(slugify("Hello World!"), "hello-world");
    assert.equal(slugify("  Retro   Gaming  "), "retro-gaming");
  });

  it("truncates long slugs", () => {
    const long = "a".repeat(60);
    assert.equal(slugify(long).length, 48);
  });
});

describe("products and checkout", () => {
  it("lists catalog products with stable ids", () => {
    const products = listProducts();
    assert.ok(products.length >= 30);
    assert.ok(getProductById(1));
    assert.equal(getProductById(1).price, 29.99);
  });

  it("filters products by type and category", () => {
    const digital = listProducts({ type: "digital" });
    const merch = listProducts({ category: "merch" });
    assert.ok(digital.length >= 25);
    assert.ok(digital.every((product) => product.type === "digital"));
    assert.ok(merch.length >= 8);
    assert.ok(merch.every((product) => product.category === "merch"));
  });

  it("assigns offer tiers and supports tier filtering", () => {
    assert.equal(offerTierForProduct(getProductById(202)), "entry");
    assert.equal(offerTierForProduct(getProductById(226)), "core");
    assert.equal(offerTierForProduct(getProductById(213)), "premium");
    const premium = listProducts({ type: "digital", tier: "premium" });
    assert.ok(premium.every((product) => product.offerTier === "premium"));
  });

  it("rejects unknown product ids", () => {
    const result = buildCheckoutLineItems([{ id: 999, quantity: 1 }]);
    assert.match(result.error, /Unknown product/);
  });

  it("rejects client-supplied prices in favor of catalog prices", () => {
    const result = buildCheckoutLineItems([{ id: 1, quantity: 2, price: 0.01, name: "Hacked" }]);
    assert.equal(result.lineItems.length, 1);
    assert.equal(result.lineItems[0].price_data.unit_amount, 2999);
    assert.equal(result.lineItems[0].price_data.product_data.name, "Wireless Charger");
    assert.equal(result.lineItems[0].price_data.product_data.metadata.type, "physical");
  });

  it("rejects invalid quantities", () => {
    const result = buildCheckoutLineItems([{ id: 1, quantity: 0 }]);
    assert.match(result.error, /Invalid quantity/);
  });

  it("limits digital products to one per order", () => {
    const result = buildCheckoutLineItems([{ id: 301, quantity: 2 }]);
    assert.match(result.error, /Digital products are limited/);
  });

  it("rejects digital products with no downloadable files", () => {
    const result = buildCheckoutLineItems([{ id: 201, quantity: 1 }]);
    assert.match(result.error, /not available for purchase yet/);
  });
});

describe("model JSON parsing", () => {
  it("strips markdown fences before parsing", () => {
    const parsed = parseModelJson('```json\n{"title":"Test"}\n```');
    assert.equal(parsed.title, "Test");
  });

  it("extracts posts from wrapped or bare arrays", () => {
    assert.equal(extractPostsArray({ posts: [{ title: "A" }] }).length, 1);
    assert.equal(extractPostsArray([{ title: "B" }]).length, 1);
  });
});

describe("templates", () => {
  const niche = {
    id: "retro-gaming",
    name: "Retro Pixel Press",
    audience: "retro game collectors",
    categories: ["Hardware", "Speedruns", "Preservation", "Indie"],
    subreddits: ["retrogaming"],
    braveQueries: ["crt setup guide"]
  };

  it("generates starter post blueprints", () => {
    const posts = postTemplates(niche);
    assert.equal(posts.length, 6);
    assert.ok(posts[0].title);
    assert.ok(Array.isArray(posts[0].faq));
    assert.ok(posts[0].sources.length >= 1);
  });

  it("rotates hourly archetypes by niche", () => {
    const post = hourlyPostTemplate(niche, 3);
    assert.ok(post.title);
    assert.ok(post.slug);
    assert.ok(niche.categories.includes(post.category));
  });
});

describe("themes", () => {
  it("maps known niches to preset themes", () => {
    assert.equal(themeKeyForNiche("retro-gaming"), "cinema");
    assert.equal(themeKeyForNiche("home-coffee"), "ember");
  });

  it("falls back to a hash-based theme for unknown niches", () => {
    const key = themeKeyForNiche("unknown-niche");
    assert.ok(THEMES[key]);
  });
});

describe("niche selection", () => {
  it("uses unused niches before reusing existing ones", () => {
    const niche = pickNiche(new Set(["retro-gaming"]));
    assert.notEqual(niche.id, "retro-gaming");
  });

  it("reuses configured niches after all niches are used", () => {
    const allIds = new Set(require("../data/niches.json").map((niche) => niche.id));
    const niche = pickNiche(allIds);
    assert.ok(niche);
    assert.ok(allIds.has(niche.id));
  });
});

describe("monetization", () => {
  it("builds marketplace links only from configured URLs", () => {
    const saved = process.env.ETSY_SHOP_URL;
    process.env.ETSY_SHOP_URL = "https://example.com/etsy";
    const links = getMarketplaceLinks();
    assert.ok(links.some((link) => link.key === "etsy" && link.url === "https://example.com/etsy"));
    if (saved === undefined) delete process.env.ETSY_SHOP_URL;
    else process.env.ETSY_SHOP_URL = saved;
  });

  it("builds sponsor slots and affiliate links from env", () => {
    const savedSponsor = process.env.SPONSOR_URL;
    const savedAffiliate = process.env.AFFILIATE_SEARCH_URL;
    process.env.SPONSOR_URL = "https://example.com/sponsor";
    process.env.AFFILIATE_SEARCH_URL = "https://example.com/search?q={query}";
    assert.equal(getSponsorSlot({ audience: "testers" }).url, "https://example.com/sponsor");
    assert.equal(affiliateSearchUrl("niche tools"), "https://example.com/search?q=niche%20tools");
    if (savedSponsor === undefined) delete process.env.SPONSOR_URL;
    else process.env.SPONSOR_URL = savedSponsor;
    if (savedAffiliate === undefined) delete process.env.AFFILIATE_SEARCH_URL;
    else process.env.AFFILIATE_SEARCH_URL = savedAffiliate;
  });

  it("recommends products for generated niche sites", () => {
    const products = recommendedProducts({ name: "Retro Pixel Press", audience: "retro game collectors", categories: ["Hardware"] });
    assert.ok(products.length > 0);
    assert.ok(products.every((product) => product.id));
  });
});

describe("concurrency helper", () => {
  it("runs mappers with a concurrency limit", async () => {
    const order = [];
    const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      order.push(value);
      return value * 2;
    });
    assert.deepEqual(results, [2, 4, 6, 8]);
    assert.equal(order.length, 4);
  });
});

describe("config", () => {
  it("prefers BEYONDMYTHOS_URL over legacy aliases", () => {
    const previous = {
      beyond: process.env.BEYONDMYTHOS_URL,
      store: process.env.STOREFORGE_URL,
      front: process.env.FRONTEND_URL
    };
    process.env.BEYONDMYTHOS_URL = "https://beyond.example.com/";
    delete process.env.STOREFORGE_URL;
    delete process.env.FRONTEND_URL;
    assert.equal(getBaseUrl(), "https://beyond.example.com");

    if (previous.beyond === undefined) delete process.env.BEYONDMYTHOS_URL;
    else process.env.BEYONDMYTHOS_URL = previous.beyond;
    if (previous.store === undefined) delete process.env.STOREFORGE_URL;
    else process.env.STOREFORGE_URL = previous.store;
    if (previous.front === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previous.front;
  });

  describe("portfolio strategy", () => {
    it("contains tier/domain role mappings and campaign structure", () => {
      const strategy = loadPortfolioStrategy();
      const summary = summarizePortfolio(strategy);
      const domains = listPortfolioDomains(strategy);
      assert.ok(summary.tierCount >= 3);
      assert.ok(summary.domainCount >= 10);
      assert.ok(domains.some((domain) => domain.domain === "beyondmythos.com" && domain.northStarKpi === "digital sales"));
      assert.ok((strategy.campaignCalendar?.weeklyThemes || []).length >= 13);
    });
  });

  describe("fulfillment and revenue", () => {
    it("records purchases and serves tokenized digital access", () => {
      const original = fs.readFileSync(COMMERCE_STATE_PATH, "utf8");
      try {
        saveCommerceState({ customers: [], purchases: [], events: [] });
        recordCheckoutStarted({ site: "beyondmythos.com", email: "buyer@example.com", items: [{ id: 201, quantity: 1 }] });
        const created = recordPurchase({
          email: "buyer@example.com",
          site: "beyondmythos.com",
          items: [{ id: 201, quantity: 1 }, { id: 205, quantity: 1 }]
        });
        assert.ok(created.purchase.id);
        assert.ok(created.accessToken);
        const access = customerAccess(created.accessToken);
        assert.equal(access.customer.email, "buyer@example.com");
        assert.ok(access.purchases[0].downloads.length >= 1);
        const download = access.purchases[0].downloads[0];
        const resolved = resolveDigitalAccess({
          purchaseId: access.purchases[0].id,
          productId: download.productId,
          token: created.accessToken
        });
        assert.match(resolved.message, /Delivery access granted/);
      } finally {
        fs.writeFileSync(COMMERCE_STATE_PATH, original, "utf8");
      }
    });

    it("computes cross-site revenue dashboard metrics", () => {
      const original = fs.readFileSync(COMMERCE_STATE_PATH, "utf8");
      try {
        saveCommerceState({ customers: [], purchases: [], events: [] });
        recordCheckoutStarted({ site: "beyondmythos.com", email: "a@example.com", items: [{ id: 201, quantity: 1 }] });
        recordCheckoutStarted({ site: "wireandlogic.com", email: "b@example.com", items: [{ id: 213, quantity: 1 }] });
        recordPurchase({ email: "a@example.com", site: "beyondmythos.com", items: [{ id: 201, quantity: 1 }] });
        const dashboard = revenueDashboard();
        assert.equal(dashboard.totals.checkoutsStarted, 2);
        assert.equal(dashboard.totals.purchasesCompleted, 1);
        assert.equal(dashboard.totals.conversionRate, 0.5);
        assert.ok(dashboard.topFunnels.length >= 1);
      } finally {
        fs.writeFileSync(COMMERCE_STATE_PATH, original, "utf8");
      }
    });

    it("avoids duplicate purchases for the same provider session id", () => {
      const original = fs.readFileSync(COMMERCE_STATE_PATH, "utf8");
      try {
        saveCommerceState({ customers: [], purchases: [], events: [] });
        const first = recordPurchase({
          email: "idempotent@example.com",
          site: "beyondmythos.com",
          provider: "stripe",
          providerSessionId: "cs_test_123",
          items: [{ id: 201, quantity: 1 }]
        });
        const second = recordPurchase({
          email: "idempotent@example.com",
          site: "beyondmythos.com",
          provider: "stripe",
          providerSessionId: "cs_test_123",
          items: [{ id: 201, quantity: 1 }]
        });
        const snapshot = JSON.parse(fs.readFileSync(COMMERCE_STATE_PATH, "utf8"));
        assert.equal(snapshot.purchases.length, 1);
        assert.equal(second.purchase.id, first.purchase.id);
        assert.equal(second.existing, true);
      } finally {
        fs.writeFileSync(COMMERCE_STATE_PATH, original, "utf8");
      }
    });
  });
});

describe("stripe webhook mapping", () => {
  it("maps Stripe checkout session + line items to catalog purchase payload", () => {
    const payload = purchasePayloadFromSession({
      session: {
        id: "cs_test_456",
        customer_email: "buyer@example.com",
        metadata: { site: "beyondmythos.com" }
      },
      lineItems: [
        { quantity: 1, price: { product: { metadata: { product_id: "201" } } } },
        { quantity: 2, price: { product: { metadata: { product_id: "205" } } } }
      ]
    });
    assert.equal(payload.provider, "stripe");
    assert.equal(payload.providerSessionId, "cs_test_456");
    assert.equal(payload.email, "buyer@example.com");
    assert.equal(payload.items.length, 2);
    assert.deepEqual(payload.items[0], { id: 201, quantity: 1 });
    assert.deepEqual(payload.items[1], { id: 205, quantity: 2 });
  });
});

describe("newsletter persistence", () => {
  it("records signups locally and deduplicates repeats", () => {
    const hadFile = fs.existsSync(NEWSLETTER_STATE_PATH);
    const original = hadFile ? fs.readFileSync(NEWSLETTER_STATE_PATH, "utf8") : null;
    try {
      saveNewsletterState({ signups: [] });
      const first = recordNewsletterSignup({ email: "reader@example.com", site: "retro-pixel-press" });
      const second = recordNewsletterSignup({ email: "reader@example.com", site: "retro-pixel-press" });
      const state = JSON.parse(fs.readFileSync(NEWSLETTER_STATE_PATH, "utf8"));
      assert.equal(first.existing, false);
      assert.equal(second.existing, true);
      assert.equal(state.signups.length, 1);
    } finally {
      if (!hadFile) fs.rmSync(NEWSLETTER_STATE_PATH, { force: true });
      else fs.writeFileSync(NEWSLETTER_STATE_PATH, original, "utf8");
    }
  });
});

describe("site AI agent embed", () => {
  it("renders ElevenLabs widget when ELEVENLABS_AGENT_ID is configured", () => {
    const saved = process.env.ELEVENLABS_AGENT_ID;
    try {
      process.env.ELEVENLABS_AGENT_ID = "agent_test_123";
      const html = renderHome(
        {
          slug: "test-site",
          name: "Test Site",
          tagline: "Tagline",
          audience: "audience",
          categories: ["Tools"],
          createdAt: new Date().toISOString(),
          streamUrl: "https://www.beyondmythos.com/"
        },
        [
          {
            slug: "hello",
            title: "Hello",
            category: "Tools",
            dek: "Dek",
            publishedAt: new Date().toISOString(),
            readMinutes: 2
          }
        ],
        THEMES[themeKeyForNiche("retro-gaming")]
      );
      assert.match(html, /elevenlabs-convai/);
    } finally {
      if (saved === undefined) delete process.env.ELEVENLABS_AGENT_ID;
      else process.env.ELEVENLABS_AGENT_ID = saved;
    }
  });
});

describe("content provider", () => {
  it("uses template mode when no API key is set", () => {
    const saved = {
      groq: process.env.GROQ_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      disable: process.env.DISABLE_AI_CONTENT,
      provider: process.env.CONTENT_PROVIDER
    };
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.DISABLE_AI_CONTENT;
    process.env.CONTENT_PROVIDER = "auto";
    assert.equal(isAiContentEnabled(), false);
    assert.equal(contentModeLabel(), "template");

    for (const [key, value] of Object.entries(saved)) {
      const envName = {
        groq: "GROQ_API_KEY",
        openrouter: "OPENROUTER_API_KEY",
        openai: "OPENAI_API_KEY",
        gemini: "GEMINI_API_KEY",
        disable: "DISABLE_AI_CONTENT",
        provider: "CONTENT_PROVIDER"
      }[key];
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
  });

  it("prefers groq in auto mode when GROQ_API_KEY is set", () => {
    const saved = {
      groq: process.env.GROQ_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      provider: process.env.CONTENT_PROVIDER
    };
    process.env.GROQ_API_KEY = "gsk_test_key";
    process.env.GEMINI_API_KEY = "AIzaSyD-real-looking-key";
    process.env.CONTENT_PROVIDER = "auto";
    assert.equal(resolveContentProvider(), "groq");

    for (const [key, value] of Object.entries(saved)) {
      const envName = { groq: "GROQ_API_KEY", gemini: "GEMINI_API_KEY", provider: "CONTENT_PROVIDER" }[key];
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
  });

  it("respects DISABLE_AI_CONTENT=true", () => {
    const savedKey = process.env.GROQ_API_KEY;
    const savedDisable = process.env.DISABLE_AI_CONTENT;
    process.env.GROQ_API_KEY = "gsk_test_key";
    process.env.DISABLE_AI_CONTENT = "true";
    assert.equal(resolveContentProvider(), "template");

    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
    if (savedDisable === undefined) delete process.env.DISABLE_AI_CONTENT;
    else process.env.DISABLE_AI_CONTENT = savedDisable;
  });
});
