// Builds a printable book (HTML → Chrome "Save as PDF") from DeepSeek answers.

const DROP_TAGS = "script,style,link,meta,iframe,frame,object,embed,form,input,button,select,textarea,svg,canvas,video,audio,noscript,template";

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Keeps DeepSeek's formatting (headings, lists, tables, code, KaTeX MathML) and strips anything active. */
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<div id="r">${html || ""}</div>`, "text/html");
  const root = doc.getElementById("r");
  // Code block banners hold the language label + copy/download buttons.
  root.querySelectorAll('[class*="banner"], .dsx-bar, [role="button"]').forEach((el) => {
    if (!el.querySelector("pre")) el.remove();
  });
  // Math rendered without MathML: keep KaTeX's HTML version visible instead.
  root.querySelectorAll(".katex").forEach((k) => { if (!k.querySelector(".katex-mathml math")) k.classList.add("nomml"); });
  root.querySelectorAll(DROP_TAGS).forEach((el) => {
    // KaTeX's visual HTML is hidden in the book (MathML is used), so its SVGs can go too.
    el.remove();
  });
  for (const el of root.querySelectorAll("*")) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith("on") || n === "style" || n === "id" || n.startsWith("data-") || n === "contenteditable") el.removeAttribute(a.name);
      else if ((n === "href" || n === "src") && !/^(https?:|data:image\/|#)/i.test(a.value.trim())) el.removeAttribute(a.name);
    }
    if (el.tagName === "A") { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
  }
  return root.innerHTML;
}

/** Plain text → simple HTML paragraphs (for original book text). */
export function textToHtml(text) {
  return (text || "")
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export function titleFromHtml(html, fallback) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const h = doc.querySelector("h1,h2,h3,h4");
  let t = (h ? h.textContent : doc.body.textContent || "").trim().split("\n")[0].trim();
  if (t.length > 80) t = t.slice(0, 77).replace(/\s+\S*$/, "") + "…";
  return t || fallback;
}

const BOOK_CSS = (o) => `
  @page { size: ${o.pageSize === "letter" ? "letter" : "A4"}; margin: 20mm 18mm 22mm;
    @bottom-center { content: counter(page); font: 10pt Georgia, serif; color: #666; } }
  @page :first { @bottom-center { content: none; } }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font: ${o.fontSize || 11}pt/1.55 Georgia, "Times New Roman", "Noto Naskh Arabic", "Noto Nastaliq Urdu", serif; color: #111; background: #fff; }
  .cover { height: 245mm; display: flex; flex-direction: column; justify-content: center; text-align: center; page-break-after: always; break-after: page; }
  .cover h1 { font-size: 30pt; margin: 0 0 12pt; line-height: 1.2; }
  .cover .sub { font-size: 14pt; color: #444; margin-bottom: 30pt; }
  .cover .meta { font-size: 10.5pt; color: #777; }
  .toc { page-break-after: always; break-after: page; }
  .toc h2 { font-size: 18pt; border-bottom: 1px solid #ccc; padding-bottom: 6pt; }
  .toc ol { padding-left: 18pt; } .toc li { margin: 4pt 0; }
  .toc a { color: #111; text-decoration: none; }
  .chapter { break-before: page; page-break-before: always; }
  .chapter:first-of-type { break-before: auto; page-break-before: auto; }
  .chapter > h2.ch-title { font-size: 19pt; margin: 0 0 4pt; line-height: 1.25; }
  .chapter > .ch-meta { color: #777; font-size: 9.5pt; margin-bottom: 14pt; border-bottom: 1px solid #ddd; padding-bottom: 6pt; }
  h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; line-height: 1.3; }
  .content h1 { font-size: 16pt; } .content h2 { font-size: 14.5pt; } .content h3 { font-size: 13pt; } .content h4 { font-size: 12pt; }
  p, li { orphans: 3; widows: 3; }
  a { color: #1a4fd6; }
  img { max-width: 100%; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: .92em; break-inside: auto; }
  tr { break-inside: avoid; }
  th, td { border: 1px solid #bbb; padding: 4pt 6pt; vertical-align: top; text-align: start; }
  th { background: #f1f3f5; }
  blockquote { margin: 8pt 0; padding: 2pt 10pt; border-left: 3px solid #ccc; color: #444; }
  pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 4pt; padding: 8pt 10pt; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; font: ${Math.max(7.5, (o.fontSize || 11) - 2)}pt/1.45 Consolas, "Courier New", monospace; }
  code { font-family: Consolas, "Courier New", monospace; font-size: .9em; background: #f3f4f6; padding: 0 2pt; border-radius: 2pt; }
  pre code { background: none; padding: 0; font-size: inherit; }
  hr { border: 0; border-top: 1px solid #ddd; margin: 14pt 0; }
  /* KaTeX: print the MathML version (no KaTeX fonts needed) and hide the visual HTML. */
  .katex-html { display: none !important; }
  .katex.nomml .katex-html { display: inline !important; }
  .katex-mathml { position: static !important; clip: auto !important; width: auto !important; height: auto !important; overflow: visible !important; }
  .katex-display { display: block; text-align: center; margin: 8pt 0; }
  math[display="block"] { display: block math; margin: 6pt 0; }
  .original { margin-top: 14pt; padding: 8pt 10pt; border: 1px dashed #bbb; background: #fafafa; font-size: .9em; color: #333; }
  .original > summary, .original > .o-h { font-weight: bold; margin-bottom: 4pt; }
  [dir="rtl"], :lang(ur), :lang(ar) { text-align: right; }
  @media screen { body { max-width: 820px; margin: 0 auto; padding: 24px; } .cover { height: auto; min-height: 60vh; } }
`;

/**
 * @param {{title:string, subtitle?:string, author?:string, pageSize?:string, fontSize?:number, toc?:boolean,
 *          chapters:{title:string, meta?:string, html:string, original?:string}[]}} book
 * @returns {string} full HTML document
 */
export function buildBookHtml(book) {
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const chapters = book.chapters || [];
  const toc = book.toc !== false && chapters.length > 1
    ? `<nav class="toc"><h2>Contents</h2><ol>${chapters.map((c, i) => `<li><a href="#ch-${i + 1}">${escapeHtml(c.title)}</a></li>`).join("")}</ol></nav>`
    : "";
  const body = chapters.map((c, i) => `
    <section class="chapter" id="ch-${i + 1}">
      <h2 class="ch-title">${escapeHtml(c.title)}</h2>
      ${c.meta ? `<div class="ch-meta">${escapeHtml(c.meta)}</div>` : ""}
      <div class="content" dir="auto">${c.html}</div>
      ${c.original ? `<div class="original"><div class="o-h">Original text</div>${textToHtml(c.original)}</div>` : ""}
    </section>`).join("\n");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(book.title || "Book")}</title>
<style>${BOOK_CSS(book)}</style></head>
<body>
  <div class="cover">
    <h1>${escapeHtml(book.title || "Untitled book")}</h1>
    ${book.subtitle ? `<div class="sub">${escapeHtml(book.subtitle)}</div>` : ""}
    <div class="meta">${book.author ? `${escapeHtml(book.author)} · ` : ""}${escapeHtml(date)} · generated with DeepSeek</div>
  </div>
  ${toc}
  ${body}
</body></html>`;
}

export function buildMarkdown(book) {
  const out = [`# ${book.title || "Book"}`];
  if (book.subtitle) out.push(`_${book.subtitle}_`);
  for (const c of book.chapters || []) {
    out.push("", `## ${c.title}`);
    if (c.meta) out.push(`_${c.meta}_`);
    out.push("", (c.text || "").trim());
    if (c.original) out.push("", "<details><summary>Original text</summary>", "", c.original.trim(), "", "</details>");
  }
  return out.join("\n") + "\n";
}

/** Opens Chrome's print dialog (→ "Save as PDF") for the given book HTML. */
export function printHtml(html) {
  return new Promise((resolve) => {
    const old = document.getElementById("dsx-print-frame");
    if (old) old.remove();
    const f = document.createElement("iframe");
    f.id = "dsx-print-frame";
    f.setAttribute("aria-hidden", "true");
    f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    f.onload = () => {
      setTimeout(() => {
        f.contentWindow.focus();
        f.contentWindow.print();
        resolve();
      }, 300); // let fonts/MathML lay out
    };
    f.srcdoc = html;
    document.body.appendChild(f);
  });
}

export function downloadText(text, filename, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function safeFileName(s, fallback = "book") {
  return (s || "").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || fallback;
}
