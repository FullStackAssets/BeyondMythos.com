/**
 * Build script for BeyondMythos Press books.
 *
 * Usage: node scripts/build-books.js
 *
 * Reads books/<slug>/manuscript.md and produces:
 *   downloads/<slug>.epub  (EPUB 2, packaged with the system `zip` binary)
 *   downloads/<slug>.pdf   (hand-rolled minimal PDF, stdlib only)
 *   books/<slug>/manifest.json (sizes, chapter/page counts)
 *
 * No npm dependencies — stdlib only plus the `zip` CLI for EPUB packaging.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BOOKS = [
  {
    slug: "autonomous-publishers-handbook",
    title: "The Autonomous Publisher's Handbook",
    subtitle: "How to design, launch, and operate a network of niche publications that runs itself",
    author: "BeyondMythos Press",
    language: "en",
    identifier: "urn:beyondmythos:book:autonomous-publishers-handbook:1"
  }
];

const REPO_ROOT = path.join(__dirname, "..");
const DOWNLOADS_DIR = path.join(REPO_ROOT, "downloads");

/* ---------------- manuscript parsing ---------------- */

function stripInline(text) {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").replace(/`(.+?)`/g, "$1");
}

function parseManuscript(markdown) {
  const blocks = [];
  const lines = markdown.split("\n");
  let para = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ type: "p", text: stripInline(para.join(" ").trim()) });
      para = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line === "---") {
      flush();
      blocks.push({ type: "hr" });
      continue;
    }
    const h1 = line.match(/^# (.+)/);
    if (h1) {
      flush();
      blocks.push({ type: "h1", text: stripInline(h1[1]) });
      continue;
    }
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      flush();
      blocks.push({ type: "h2", text: stripInline(h2[1]) });
      continue;
    }
    const li = line.match(/^(\d+\.|-|\*) (.+)/);
    if (li) {
      flush();
      blocks.push({ type: "li", ordered: /^\d/.test(li[1]), text: stripInline(li[2]) });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks.filter((b) => b.text && b.text.length);
}

function splitChapters(blocks) {
  const chapters = [];
  let current = null;
  for (const block of blocks) {
    if (block.type === "h1") {
      current = { title: block.text, blocks: [] };
      chapters.push(current);
    } else if (current) {
      current.blocks.push(block);
    }
  }
  return chapters;
}

/* ---------------- EPUB ---------------- */

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function chapterXhtml(chapter) {
  const body = chapter.blocks
    .map((b) => {
      if (b.type === "h2") return `<h2>${escapeXml(b.text)}</h2>`;
      if (b.type === "li") return `<p class="li">• ${escapeXml(b.text)}</p>`;
      if (b.type === "hr") return `<hr/>`;
      return `<p>${escapeXml(b.text)}</p>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>${escapeXml(chapter.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>\n<body>\n<h1>${escapeXml(chapter.title)}</h1>\n${body}\n</body>\n</html>\n`;
}

function buildEpub(book, chapters, outPath) {
  const stage = path.join(REPO_ROOT, "books", book.slug, ".epub-stage");
  fs.rmSync(stage, { recursive: true, force: true });
  const oebps = path.join(stage, "OEBPS");
  const metaInf = path.join(stage, "META-INF");
  fs.mkdirSync(oebps, { recursive: true });
  fs.mkdirSync(metaInf, { recursive: true });

  fs.writeFileSync(path.join(stage, "mimetype"), "application/epub+zip");
  fs.writeFileSync(
    path.join(metaInf, "container.xml"),
    `<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles>\n<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n</rootfiles>\n</container>\n`
  );
  fs.writeFileSync(
    path.join(oebps, "style.css"),
    `body{font-family:Georgia,serif;line-height:1.6;margin:5%;}h1{font-size:1.6em;margin-bottom:1em;}h2{font-size:1.25em;margin-top:1.5em;}p{margin:0 0 1em;text-indent:0;}p.li{text-indent:0;margin-left:1.2em;}hr{margin:2em 0;border:none;border-top:1px solid #999;}\n`
  );

  const items = [];
  const spine = [];
  chapters.forEach((ch, i) => {
    const name = `ch${String(i).padStart(2, "0")}.xhtml`;
    fs.writeFileSync(path.join(oebps, name), chapterXhtml(ch));
    items.push(`<item id="ch${i}" href="${name}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="ch${i}"/>`);
  });

  const ncxNav = chapters
    .map((ch, i) => `<navPoint id="np${i}" playOrder="${i + 1}"><navLabel><text>${escapeXml(ch.title)}</text></navLabel><content src="ch${String(i).padStart(2, "0")}.xhtml"/></navPoint>`)
    .join("\n");

  fs.writeFileSync(
    path.join(oebps, "content.opf"),
    `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n<dc:title>${escapeXml(book.title)}</dc:title>\n<dc:creator>${escapeXml(book.author)}</dc:creator>\n<dc:language>${book.language}</dc:language>\n<dc:identifier id="bookid">${escapeXml(book.identifier)}</dc:identifier>\n</metadata>\n<manifest>\n<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n<item id="css" href="style.css" media-type="text/css"/>\n${items.join("\n")}\n</manifest>\n<spine toc="ncx">\n${spine.join("\n")}\n</spine>\n</package>\n`
  );
  fs.writeFileSync(
    path.join(oebps, "toc.ncx"),
    `<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n<head><meta name="dtb:uid" content="${escapeXml(book.identifier)}"/></head>\n<docTitle><text>${escapeXml(book.title)}</text></docTitle>\n<navMap>\n${ncxNav}\n</navMap>\n</ncx>\n`
  );

  fs.rmSync(outPath, { force: true });
  execFileSync("zip", ["-X0", "-q", outPath, "mimetype"], { cwd: stage });
  execFileSync("zip", ["-X9", "-q", "-r", outPath, ".", "-x", "mimetype"], { cwd: stage });
  fs.rmSync(stage, { recursive: true, force: true });
}

/* ---------------- PDF (hand-rolled, Helvetica) ---------------- */

// Helvetica widths (units per 1000) for printable ASCII — compact table.
const WIDTHS = {
  " ": 278, "!": 278, '"': 355, "#": 556, $: 556, "%": 889, "&": 667, "'": 191,
  "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
  0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
  ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556, "@": 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, "[": 278, "\\": 278, "]": 278,
  "^": 469, _: 556, "`": 233, a: 556, b: 556, c: 500, d: 556, e: 556, f: 278,
  g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556,
  q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  "{": 334, "|": 260, "}": 334, "~": 584
};
const BOLD_EXTRA = 1.06; // bold is slightly wider; approximation

function textWidth(text, size, bold) {
  let w = 0;
  for (const ch of text) w += WIDTHS[ch] || 600;
  return (w / 1000) * size * (bold ? BOLD_EXTRA : 1);
}

function pdfEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(book, chapters, outPath) {
  const PAGE_W = 612; // Letter
  const PAGE_H = 792;
  const MARGIN = 72;
  const MAX_W = PAGE_W - MARGIN * 2;

  const pages = []; // each page: array of {x,y,size,bold,text}
  let current = [];
  let y = 0;
  const newPage = () => {
    if (current.length) pages.push(current);
    current = [];
    y = PAGE_H - MARGIN;
  };
  newPage();
  const need = (h) => {
    if (y - h < MARGIN) newPage();
  };
  // The hand-rolled PDF uses WinAnsi Helvetica; multi-byte Unicode punctuation
  // (em/en dashes etc.) would render as garbage, so normalize to ASCII here.
  // Manuscripts keep their Unicode (EPUB/HTML render it fine).
  const asciiSafe = (s) =>
    s.replace(/[—–]/g, "-").replace(/[·•]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const wrapLines = (text, size, bold) => {
    const words = asciiSafe(text).split(/\s+/).filter(Boolean);
    let line = "";
    const lines = [];
    for (const word of words) {
      const trial = line ? line + " " + word : word;
      if (textWidth(trial, size, bold) > MAX_W && line) {
        lines.push(line);
        line = word;
      } else {
        line = trial;
      }
    }
    if (line) lines.push(line);
    return lines;
  };
  const drawText = (text, size, bold) => {
    const lh = size * 1.45;
    for (const ln of wrapLines(text, size, bold)) {
      need(lh);
      current.push({ x: MARGIN, y, size, bold, text: ln });
      y -= lh;
    }
  };
  const spacer = (h) => {
    need(h);
    y -= h;
  };

  // Title page (titles wrapped + centered per line — never past the margins)
  const drawCentered = (text, size, bold) => {
    for (const ln of wrapLines(text, size, bold)) {
      need(size * 1.45);
      const cx = (PAGE_W - textWidth(ln, size, bold)) / 2;
      current.push({ x: Math.max(cx, MARGIN), y, size, bold, text: ln });
      y -= size * 1.45;
    }
  };
  y = PAGE_H - 200;
  drawCentered(book.title, 28, true);
  y -= 24;
  drawCentered(book.subtitle, 13, false);
  y -= 30;
  current.push({ x: MARGIN, y, size: 12, bold: false, centered: true, text: book.author + " - First Edition" });
  newPage();

  let firstChapter = true;
  for (const ch of chapters) {
    if (!firstChapter) newPage();
    firstChapter = false;
    // chapter title (wrapped — long titles must not run past the margin)
    for (const ln of wrapLines(ch.title, 20, true)) {
      need(29);
      current.push({ x: MARGIN, y, size: 20, bold: true, text: ln });
      y -= 29;
    }
    y -= 5;
    for (const b of ch.blocks) {
      if (b.type === "h2") {
        spacer(10);
        for (const ln of wrapLines(b.text, 14, true)) {
          need(21);
          current.push({ x: MARGIN, y, size: 14, bold: true, text: ln });
          y -= 21;
        }
      } else if (b.type === "li") {
        // ASCII hyphen — the • glyph is not in the hand-rolled PDF's encoding
        drawText("-  " + b.text, 11, false);
        spacer(2);
      } else if (b.type === "hr") {
        spacer(12);
      } else {
        drawText(b.text, 11, false);
        spacer(6);
      }
    }
  }
  if (current.length) pages.push(current);

  // Emit PDF
  const objects = [];
  const addObj = (body) => {
    objects.push(body);
    return objects.length; // 1-based
  };

  const fontRegular = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontBold = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

  const pageObjs = [];
  const contentObjs = [];
  for (let i = 0; i < pages.length; i++) {
    const items = pages[i];
    let stream = "BT\n";
    for (const it of items) {
      const font = it.bold ? "F2" : "F1";
      let x = it.x;
      if (it.centered) x = (PAGE_W - textWidth(it.text, it.size, it.bold)) / 2;
      // NOTE: Tm (absolute text matrix), not Td — Td is relative to the previous
      // text position and would send every line after the first off the page.
      stream += `/${font} ${it.size} Tf\n1 0 0 1 ${x.toFixed(2)} ${it.y.toFixed(2)} Tm\n(${pdfEscape(it.text)}) Tj\n`;
    }
    // footer page number
    const label = `${i + 1}`;
    const fx = (PAGE_W - textWidth(label, 9, false)) / 2;
    stream += `/F1 9 Tf\n1 0 0 1 ${fx.toFixed(2)} 40 Tm\n(${label}) Tj\nET`;
    const streamBody = `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`;
    contentObjs.push(addObj(streamBody));
  }
  const kids = [];
  for (let i = 0; i < pages.length; i++) {
    kids.push(
      addObj(
        `<< /Type /Page /Parent PARENTREF /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentObjs[i]} 0 R >>`
      )
    );
    pageObjs.push(kids[kids.length - 1]);
  }
  const pagesObj = addObj(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  // fix parent refs
  for (let i = 0; i < objects.length; i++) {
    objects[i] = objects[i].replace(/PARENTREF/g, `${pagesObj} 0 R`);
  }
  const catalogObj = addObj(
    `<< /Type /Catalog /Pages ${pagesObj} 0 R /Metadata ${addObj(
      `<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(`<?xpacket?>`, "utf8")} >>\nstream\n<?xpacket?>\nendstream`
    )} 0 R >>`
  );

  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(out, "utf8"));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(out, "utf8");
  out += `xref\n0 ${objects.length + 1}\n`;
  out += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObj} 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  fs.writeFileSync(outPath, out, "utf8");
  return pages.length;
}

/* ---------------- main ---------------- */

function main() {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const report = [];
  for (const book of BOOKS) {
    const bookDir = path.join(REPO_ROOT, "books", book.slug);
    const manuscript = fs.readFileSync(path.join(bookDir, "manuscript.md"), "utf8");
    const blocks = parseManuscript(manuscript);
    const chapters = splitChapters(blocks).filter((c) => c.blocks.length);
    const wordCount = blocks.reduce((n, b) => n + (b.text ? b.text.split(/\s+/).length : 0), 0);

    const epubPath = path.join(DOWNLOADS_DIR, `${book.slug}.epub`);
    const pdfPath = path.join(DOWNLOADS_DIR, `${book.slug}.pdf`);
    buildEpub(book, chapters, epubPath);
    const pdfPages = buildPdf(book, chapters, pdfPath);

    const manifest = {
      slug: book.slug,
      title: book.title,
      author: book.author,
      chapters: chapters.length,
      wordCount,
      pdfPages,
      files: {
        epub: { path: `downloads/${book.slug}.epub`, bytes: fs.statSync(epubPath).size },
        pdf: { path: `downloads/${book.slug}.pdf`, bytes: fs.statSync(pdfPath).size }
      },
      builtAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(bookDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    report.push(manifest);
    console.log(`built ${book.slug}: ${chapters.length} chapters, ${wordCount} words, ${pdfPages} pdf pages`);
  }
  return report;
}

if (require.main === module) {
  main();
}

module.exports = { parseManuscript, splitChapters, buildEpub, buildPdf };
