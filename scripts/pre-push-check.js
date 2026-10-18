#!/usr/bin/env node
/* Pre-push check for the BeyondMythos storefront (production-readiness §3).
 * Run before `git push`: verifies the catalog loads, every product file
 * resolves, and reports what the push would deploy.
 * Exit 0 = safe to push; exit 1 = problems found.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = "/home/hatch/workspace/beyondmythos-enhancement";
let errors = 0;
const err = (m) => { errors++; console.log("  FAIL:", m); };

// 1. catalog loads
let products;
try {
  delete require.cache[require.resolve(path.join(REPO, "lib/products.js"))];
  products = require(path.join(REPO, "lib/products.js"));
  console.log("catalog loads: ok");
} catch (e) {
  err(`lib/products.js does not load: ${e.message}`);
  process.exit(1);
}

// 2. every product that claims file delivery must resolve
const list = products.PRODUCTS || products.products || [];
let checked = 0, skipped = 0;
for (const p of list) {
  if (!p.files || (!p.files.pdf && !p.files.epub)) { skipped++; continue; } // physical / legacy
  for (const kind of ["pdf", "epub"]) {
    const rel = p.files[kind];
    if (!rel) continue;
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) {
      err(`product ${p.id} "${p.name}": ${kind} missing at ${rel}`);
    } else if (fs.statSync(abs).size === 0) {
      err(`product ${p.id} "${p.name}": ${kind} is empty at ${rel}`);
    }
    checked++;
  }
  // engine-built products (ids 401+) must never carry social-proof fields
  if (p.id >= 401 && ("rating" in p || "testimonials" in p)) {
    err(`product ${p.id}: invented social proof field present`);
  }
}
console.log(`file links checked: ${checked} (${errors ? errors + " broken" : "all resolve"}), ${skipped} physical/legacy skipped`);

// 3. what would this push deploy?
try {
  const status = execFileSync("git", ["status", "--short"], { cwd: REPO, encoding: "utf8", timeout: 15000 }).trim();
  const ahead = execFileSync("git", ["rev-list", "--count", "@{u}..HEAD"], { cwd: REPO, encoding: "utf8", timeout: 15000 }).trim();
  console.log(`uncommitted changes:\n${status ? status.split("\n").map((l) => "    " + l).join("\n") : "    (none)"}`);
  console.log(`commits ahead of remote: ${ahead}`);
  if (status && !status.split("\n").every((l) => /products\.js|books\/|downloads\//.test(l))) {
    console.log("  WARN: uncommitted changes outside products/books/downloads would ride along");
  }
} catch (e) {
  console.log("  WARN: git inspection failed:", e.message.split("\n")[0]);
}

console.log(errors ? `\nPRE-PUSH CHECK: ${errors} problem(s) — do not push` : "\nPRE-PUSH CHECK: clean — safe to push");
process.exit(errors ? 1 : 0);
