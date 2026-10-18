#!/usr/bin/env node
/* Rich, full-color PDF builder for BeyondMythos Press guidebooks.
 * Markdown manuscript -> styled HTML -> headless Chromium -> PDF.
 * Presentation-only enrichment: no content is invented.
 * Usage: node scripts/build-rich-pdf.js <slug> "<title>" "<subtitle>" [theme]
 * Themes: medicare | fantasy | crash | default
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = "/home/hatch/workspace/beyondmythos-enhancement";
const BUILDER = require(path.join(REPO, "scripts/build-books.js"));
const CHROME = "/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux/chrome";

const THEMES = {
  medicare: { primary: "#1e3a8a", dark: "#172554", accent: "#f59e0b", soft: "#eff6ff", softBorder: "#bfdbfe" },
  fantasy:  { primary: "#065f46", dark: "#064e3b", accent: "#f97316", soft: "#ecfdf5", softBorder: "#a7f3d0" },
  crash:    { primary: "#7f1d1d", dark: "#450a0a", accent: "#f59e0b", soft: "#fef2f2", softBorder: "#fecaca" },
  default:  { primary: "#312e81", dark: "#1e1b4b", accent: "#f59e0b", soft: "#eef2ff", softBorder: "#c7d2fe" },
};

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// A paragraph becomes a warning callout when it matches one of these.
function warnKind(text) {
  if (/not legal advice/i.test(text)) return "Important";
  if (/confirm[^.]{0,80}(medicare\.gov|ssa\.gov)/i.test(text)) return "Verify before you act";
  return null;
}

function buildHtml(slug, title, subtitle, themeName) {
  const t = THEMES[themeName] || THEMES.default;
  const md = fs.readFileSync(path.join(REPO, "books", slug, "manuscript.md"), "utf8");
  const blocks = BUILDER.parseManuscript(md);
  const chapters = BUILDER.splitChapters(blocks).filter((c) => c.blocks.length);

  const toc = chapters
    .map((c, i) => `<li><span class="toc-num">${i + 1}</span><span>${esc(c.title)}</span></li>`)
    .join("\n");

  let body = "";
  chapters.forEach((ch, ci) => {
    body += `<section class="chapter">
      <div class="chapter-band">
        <div class="chapter-kicker">Chapter ${ci + 1}</div>
        <h1 class="chapter-title">${esc(ch.title)}</h1>
      </div>`;
    let listOpen = null; // 'ul' | 'ol'
    const closeList = () => { if (listOpen) { body += `</${listOpen}>`; listOpen = null; } };
    for (const b of ch.blocks) {
      if (b.type === "h2") {
        closeList();
        body += `<h2 class="section-head">${esc(b.text)}</h2>`;
      } else if (b.type === "li") {
        const tag = b.ordered ? "ol" : "ul";
        if (listOpen !== tag) { closeList(); body += `<${tag} class="chk">`; listOpen = tag; }
        body += `<li>${esc(b.text)}</li>`;
      } else if (b.type === "hr") {
        closeList();
        body += `<hr class="rule"/>`;
      } else {
        closeList();
        const w = warnKind(b.text);
        if (w) {
          body += `<div class="callout warn"><div class="callout-title">${esc(w)}</div><p>${esc(b.text)}</p></div>`;
        } else {
          body += `<p>${esc(b.text)}</p>`;
        }
      }
    }
    closeList();
    body += `</section>`;
  });

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  @page { size: Letter; margin: 0; }
  @page content {
    margin: 72px 72px 84px 72px;
    @bottom-center {
      content: "BeyondMythos Press  ·  " counter(page);
      font: 9px/1 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
      color: #9ca3af;
    }
  }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 11.5pt; line-height: 1.65; color: #1f2937;
  }
  .page { page: content; }

  /* ---- cover ---- */
  .cover {
    page: cover;
    height: 100vh; position: relative; overflow: hidden;
    background: linear-gradient(150deg, ${t.dark} 0%, ${t.primary} 60%, ${t.primary} 100%);
    color: #fff; display: flex; flex-direction: column; justify-content: center;
    padding: 0 72px;
  }
  .cover::before {
    content: ""; position: absolute; inset: 0;
    background:
      radial-gradient(circle at 85% 15%, ${t.accent}33 0, transparent 42%),
      radial-gradient(circle at 10% 90%, #ffffff14 0, transparent 38%);
  }
  .cover-accent { width: 72px; height: 6px; background: ${t.accent}; border-radius: 3px; margin-bottom: 28px; position: relative; }
  .cover h1 { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 40pt; line-height: 1.12; margin: 0 0 18px 0; position: relative; letter-spacing: -0.5px; }
  .cover .subtitle { font-size: 14pt; line-height: 1.6; color: #e5e7eb; max-width: 34em; position: relative; margin: 0 0 40px 0; }
  .cover .brand { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 11pt; letter-spacing: 3px; text-transform: uppercase; color: ${t.accent}; position: relative; }

  /* ---- TOC ---- */
  .toc h2 { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 20pt; color: ${t.primary}; margin: 0 0 6px 0; }
  .toc .toc-sub { color: #6b7280; margin: 0 0 22px 0; font-size: 10.5pt; }
  .toc ol { list-style: none; margin: 0; padding: 0; }
  .toc li { display: flex; gap: 14px; align-items: baseline; padding: 9px 0;
    border-bottom: 1px solid #e5e7eb; font-size: 11pt; }
  .toc-num { flex: 0 0 30px; height: 30px; border-radius: 50%;
    background: ${t.primary}; color: #fff; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 10pt; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }

  /* ---- chapters ---- */
  .chapter { page-break-before: always; }
  .chapter-band {
    background: linear-gradient(120deg, ${t.primary}, ${t.dark});
    color: #fff; border-radius: 10px; padding: 26px 28px; margin: 0 0 26px 0;
  }
  .chapter-kicker { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 10pt; letter-spacing: 2.5px; text-transform: uppercase; color: ${t.accent}; margin-bottom: 8px; }
  .chapter-title { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 22pt; line-height: 1.25; margin: 0; letter-spacing: -0.3px; }

  .section-head { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 14pt; color: ${t.primary}; margin: 26px 0 10px 0;
    padding-bottom: 6px; border-bottom: 3px solid ${t.accent}; }
  p { margin: 0 0 12px 0; }

  ul.chk, ol.chk { margin: 0 0 14px 0; padding: 0; list-style: none; }
  ul.chk li { position: relative; padding: 5px 0 5px 30px; }
  ul.chk li::before { content: ""; position: absolute; left: 4px; top: 12px;
    width: 11px; height: 11px; border-radius: 3px; background: ${t.accent}; }
  ol.chk { counter-reset: step; }
  ol.chk li { position: relative; padding: 5px 0 5px 34px; counter-increment: step; }
  ol.chk li::before { content: counter(step); position: absolute; left: 0; top: 5px;
    width: 24px; height: 24px; border-radius: 50%; background: ${t.primary}; color: #fff;
    font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 10pt; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }

  .callout { border-radius: 10px; padding: 16px 18px; margin: 18px 0; page-break-inside: avoid; }
  .callout.warn { background: #fffbeb; border: 1px solid #fcd34d; border-left: 6px solid ${t.accent}; }
  .callout-title { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    font-weight: 700; font-size: 10.5pt; text-transform: uppercase; letter-spacing: 1px;
    color: #92400e; margin-bottom: 6px; }
  .callout p { margin: 0; font-size: 10.5pt; }
  hr.rule { border: none; border-top: 1px solid #e5e7eb; margin: 20px 0; }
</style></head>
<body>
  <div class="cover">
    <div class="cover-accent"></div>
    <h1>${esc(title)}</h1>
    <p class="subtitle">${esc(subtitle)}</p>
    <div class="brand">BeyondMythos Press</div>
  </div>
  <div class="page">
    <div class="toc">
      <h2>Inside this guide</h2>
      <p class="toc-sub">${chapters.length} chapters · ${esc(title)}</p>
      <ol>${toc}</ol>
    </div>
    ${body}
  </div>
</body></html>`;
}

function main() {
  const [slug, title, subtitle, themeName] = process.argv.slice(2);
  if (!slug || !title) { console.error("usage: build-rich-pdf.js <slug> <title> <subtitle> [theme]"); process.exit(1); }
  const html = buildHtml(slug, title, subtitle || "", themeName || "default");
  const htmlPath = path.join("/tmp", `rich-${slug}.html`);
  const pdfPath = path.join(REPO, "downloads", `${slug}.pdf`);
  fs.writeFileSync(htmlPath, html, "utf8");
  execFileSync(CHROME, [
    "--headless", "--no-sandbox", "--disable-gpu",
    "--print-to-pdf=" + pdfPath, "--print-to-pdf-no-header",
    "--no-pdf-header-footer", htmlPath,
  ], { timeout: 120000 });
  const bytes = fs.statSync(pdfPath).size;
  console.log(`rich PDF: ${slug} -> ${pdfPath} (${bytes} bytes)`);

  // refresh manifest page/byte counts (word count unchanged)
  const manPath = path.join(REPO, "books", slug, "manifest.json");
  if (fs.existsSync(manPath)) {
    const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
    man.files.pdf.bytes = bytes;
    man.builtAt = new Date().toISOString();
    fs.writeFileSync(manPath, JSON.stringify(man, null, 2) + "\n");
  }
}

main();
