#!/usr/bin/env node
/* promote-listing.js — human review gate for engine-built products (V2).
 *
 * The Dropfable engine appends new products with release_status: "draft".
 * This script promotes a draft to "published" after human QA, or lists drafts.
 *
 * Usage:
 *   node scripts/promote-listing.js --list        # show draft listings
 *   node scripts/promote-listing.js --promote 404 # publish product 404
 *   node scripts/promote-listing.js --retire 404  # retire a published product
 */
"use strict";
const fs = require("fs");
const path = require("path");

const PRODUCTS = path.join(__dirname, "..", "lib", "products.js");
const args = process.argv.slice(2);

function load() {
  delete require.cache[require.resolve(PRODUCTS)];
  const m = require(PRODUCTS);
  return m.PRODUCTS || m.products;
}

if (args.includes("--list")) {
  const products = load();
  const drafts = products.filter((p) => (p.release_status || "published") === "draft");
  if (!drafts.length) { console.log("No draft listings."); process.exit(0); }
  console.log("Draft listings awaiting review:");
  for (const d of drafts) {
    console.log(`  ${d.id} | ${d.name} | $${d.price} | files: ${d.files ? Object.keys(d.files).join(",") : "none"}`);
  }
  process.exit(0);
}

const promoteIdx = args.indexOf("--promote");
const retireIdx = args.indexOf("--retire");
if (promoteIdx < 0 && retireIdx < 0) {
  console.error("Usage: --list | --promote <id> | --retire <id>");
  process.exit(2);
}

const id = Number(args[(promoteIdx >= 0 ? promoteIdx : retireIdx) + 1]);
const toStatus = promoteIdx >= 0 ? "published" : "retired";
if (!Number.isInteger(id)) { console.error("Invalid product id"); process.exit(2); }

let src = fs.readFileSync(PRODUCTS, "utf8");
const re = new RegExp(`(    id: ${id},\\n(?:.*\\n)*?    release_status: ")draft("|published")`);
if (!re.test(src)) {
  console.error(`Product ${id} not found or has no release_status field (legacy products are grandfathered).`);
  process.exit(1);
}
src = src.replace(re, `$1${toStatus}"`);
fs.writeFileSync(PRODUCTS, src);

// Verify
const products = load();
const p = products.find((x) => x.id === id);
console.log(`Product ${id} "${p.name}" is now ${p.release_status}.`);
if (toStatus === "published") {
  const { buildCheckoutLineItems } = require("../lib/checkout");
  const { error } = buildCheckoutLineItems([{ id, quantity: 1 }]);
  console.log(error ? `Checkout check FAILED: ${error}` : "Checkout check: purchasable.");
}
