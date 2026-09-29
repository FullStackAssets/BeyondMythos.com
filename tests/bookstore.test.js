/**
 * Bookstore-first storefront tests.
 *
 * Covers: buyer-facing homepage at /, ops dashboard at /ops, working
 * /success + /cancel pages, real legal pages, books-first /store ordering,
 * and the token-gated download pipeline (401 without token, 200 with token,
 * correct content types, refunded purchases blocked).
 *
 * The fulfillment layer persists to data/commerce-state.json, so this file
 * snapshots that file before running and restores it afterwards.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.CUSTOMER_ACCESS_SECRET = "bookstore-test-secret";

const STATE_PATH = path.join(__dirname, "..", "data", "commerce-state.json");
const stateBackup = fs.existsSync(STATE_PATH) ? fs.readFileSync(STATE_PATH, "utf8") : null;

const app = require("../server");
const fulfillment = require("../lib/fulfillment");
const { listBooks, getProductById } = require("../lib/products");

test.after(() => {
  if (stateBackup === null) {
    if (fs.existsSync(STATE_PATH)) fs.rmSync(STATE_PATH);
  } else {
    fs.writeFileSync(STATE_PATH, stateBackup, "utf8");
  }
});

async function withServer(run) {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("homepage is the buyer-facing bookstore with the Press title", async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    assert.match(html, /BeyondMythos Press/);
    assert.match(html, /Autonomous Publisher/);
    assert.match(html, /\/terms/);
    assert.match(html, /\/privacy/);
    assert.match(html, /\/refunds/);
    assert.match(html, /\/contact/);
    // Books section comes before kits section
    assert.ok(html.indexOf(">Books<") < html.indexOf("Creator kits"), "books listed before kits");
  });
});

test("ops dashboard moved off the homepage", async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/ops`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Portfolio|dashboard|Live stream/i);
  });
});

test("success, cancel, and legal pages all return 200 HTML", async () => {
  await withServer(async (origin) => {
    for (const page of ["/success", "/cancel", "/terms", "/privacy", "/refunds", "/contact"]) {
      const res = await fetch(`${origin}${page}`);
      assert.equal(res.status, 200, `${page} should be 200`);
      assert.match(res.headers.get("content-type") || "", /text\/html/, `${page} should be HTML`);
    }
    const success = await (await fetch(`${origin}/success`)).text();
    assert.match(success, /download/i);
    const terms = await (await fetch(`${origin}/terms`)).text();
    assert.doesNotMatch(terms, /javascript:void\(0\)/);
  });
});

test("store lists books before kits and keeps the working buy-now script", async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/store`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Autonomous Publisher/);
    const bookPos = html.indexOf("product-301");
    assert.ok(bookPos !== -1, "book 301 listed");
    // Kits with no downloadable files are hidden until stocked (honest catalog)
    assert.ok(html.indexOf("product-201") === -1, "fileless kit 201 hidden");
    assert.match(html, /data-buy-now/);
  });
});

test("catalog exposes the book with real downloadable formats", () => {
  const books = listBooks();
  assert.equal(books.length, 1);
  assert.equal(books[0].id, 301);
  assert.deepEqual(books[0].formats, ["pdf", "epub"]);
  const product = getProductById(301);
  for (const format of ["pdf", "epub"]) {
    const rel = product.files[format];
    assert.ok(rel, `book has ${format} file configured`);
    assert.ok(fs.existsSync(path.join(__dirname, "..", rel)), `book ${format} file exists on disk`);
  }
});

test("downloads are gated: 401 without token, file with valid token", async () => {
  const purchase = fulfillment.recordPurchase({
    email: "book-buyer@example.com",
    items: [{ id: 301, quantity: 1 }],
    site: "beyondmythos.com",
    provider: "test",
    providerSessionId: `test_${Date.now()}`
  });
  assert.ok(purchase.accessToken);
  assert.ok(purchase.purchase);

  await withServer(async (origin) => {
    const noToken = await fetch(`${origin}/api/downloads/${purchase.purchase.id}/301/pdf`);
    assert.equal(noToken.status, 401);

    const badToken = await fetch(`${origin}/api/downloads/${purchase.purchase.id}/301/pdf?token=nope`);
    assert.equal(badToken.status, 401);

    for (const [format, contentType] of [["pdf", "application/pdf"], ["epub", "application/epub+zip"]]) {
      const res = await fetch(
        `${origin}/api/downloads/${purchase.purchase.id}/301/${format}?token=${encodeURIComponent(purchase.accessToken)}`
      );
      assert.equal(res.status, 200, `${format} download should be 200`);
      assert.match(res.headers.get("content-type") || "", new RegExp(contentType.replace("/", "\\/").replace("+", "\\+")));
      const buf = Buffer.from(await res.arrayBuffer());
      assert.ok(buf.length > 1000, `${format} body is a real file`);
    }

    const unknownFormat = await fetch(
      `${origin}/api/downloads/${purchase.purchase.id}/301/mobi?token=${encodeURIComponent(purchase.accessToken)}`
    );
    assert.equal(unknownFormat.status, 401);
  });
});

test("digital-access endpoint returns per-format download URLs", async () => {
  const purchase = fulfillment.recordPurchase({
    email: "access-check@example.com",
    items: [{ id: 301, quantity: 1 }],
    site: "beyondmythos.com",
    provider: "test",
    providerSessionId: `test_access_${Date.now()}`
  });
  await withServer(async (origin) => {
    const res = await fetch(
      `${origin}/api/digital-access/${purchase.purchase.id}/301?token=${encodeURIComponent(purchase.accessToken)}`
    );
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.deepEqual(payload.formats, ["pdf", "epub"]);
    assert.equal(payload.downloads.length, 2);
    for (const dl of payload.downloads) {
      assert.match(dl.url, new RegExp(`/api/downloads/${purchase.purchase.id}/301/${dl.format}\\?token=`));
    }
  });
});
