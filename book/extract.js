// Text extraction for the Book tools: PDF text layer (pdf.js), OCR for scans and images (Tesseract.js),
// and plain text files. Runs inside the extension page (book.html), never on chat.deepseek.com itself.
import * as pdfjsLib from "../lib/pdfjs/pdf.min.mjs";

const LIB = new URL("../lib/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + "pdfjs/pdf.worker.min.mjs";

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;
const TEXT_RE = /\.(txt|md|markdown|text|csv)$/i;
const MIN_TEXT_CHARS = 40; // a PDF page with less real text than this is OCR'd
const VIRTUAL_PAGE_CHARS = 3000;

export function kindOf(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (file.type.startsWith("image/") || IMAGE_RE.test(file.name)) return "image";
  if (file.type.startsWith("text/") || TEXT_RE.test(file.name)) return "text";
  return "";
}

/** "1-5, 8, 10-12" → predicate on 1-based page numbers. Empty → all pages. */
export function parseRange(spec) {
  const s = (spec || "").trim();
  if (!s) return () => true;
  const ranges = [];
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)?\s*[-–]\s*(\d+)?$/);
    if (m) ranges.push([m[1] ? +m[1] : 1, m[2] ? +m[2] : Infinity]);
    else if (/^\d+$/.test(part)) ranges.push([+part, +part]);
    else throw new Error(`Bad page range: "${part}"`);
  }
  return (n) => ranges.some(([a, b]) => n >= a && n <= b);
}

/** Natural sort so "page2.jpg" comes before "page10.jpg". */
export function naturalSort(files) {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...files].sort((a, b) => coll.compare(a.name, b.name));
}

// ---------------- OCR (Tesseract) ----------------
let ocr = null; // { worker, lang }

async function getOcr(lang, onLog) {
  if (ocr && ocr.lang === lang) return ocr.worker;
  if (ocr) { await ocr.worker.terminate(); ocr = null; }
  const T = globalThis.Tesseract;
  if (!T) throw new Error("Tesseract.js failed to load");
  const bundled = lang === "eng";
  const worker = await T.createWorker(lang, 1 /* LSTM_ONLY */, {
    workerPath: LIB + "tesseract/worker.min.js",
    corePath: LIB + "tesseract/core",
    // English ships with the extension; other languages are fetched once (data only) and cached.
    ...(bundled ? { langPath: LIB + "tesseract/lang" } : {}),
    workerBlobURL: false,
    logger: (m) => onLog && onLog(m),
  });
  ocr = { worker, lang };
  return worker;
}

export async function disposeOcr() {
  if (ocr) { await ocr.worker.terminate(); ocr = null; }
}

async function recognize(image, lang, onLog) {
  const worker = await getOcr(lang, onLog);
  const { data } = await worker.recognize(image);
  return { text: tidy(data.text || ""), conf: Math.round(data.confidence || 0) };
}

// ---------------- helpers ----------------
function tidy(t) {
  return t
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/(\w)-\n(\w)/g, "$1$2") // re-join words hyphenated across lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function meaningfulLength(t) {
  return (t.match(/[\p{L}\p{N}]/gu) || []).length;
}

function pageTextFromContent(content) {
  let out = "";
  let lastY = null;
  for (const it of content.items) {
    if (!("str" in it)) continue;
    const y = it.transform ? Math.round(it.transform[5]) : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !out.endsWith("\n")) {
      // Larger vertical jumps are paragraph breaks.
      out += Math.abs(y - lastY) > (it.height || 10) * 1.8 ? "\n\n" : "\n";
    }
    out += it.str;
    if (it.hasEOL) out += "\n";
    lastY = y;
  }
  return tidy(out);
}

async function renderPage(page, maxWidth = 2200) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, Math.max(1.5, maxWidth / base.width));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

function splitVirtualPages(text) {
  const pages = [];
  const paras = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > VIRTUAL_PAGE_CHARS) { pages.push(cur); cur = ""; }
    cur += (cur ? "\n\n" : "") + p;
  }
  if (cur.trim()) pages.push(cur);
  return pages.length ? pages : [""];
}

/**
 * Extracts text from the given files.
 * @param {File[]} files
 * @param {{range?:string, lang?:string, forceOcr?:boolean}} opts
 * @param {(p:{label:string, done:number, total:number, detail?:string})=>void} onProgress
 * @param {{aborted:boolean}} signal
 * @returns {Promise<{n:number, file:string, filePage:number, method:"text"|"ocr"|"plain", conf:number|null, text:string}[]>}
 */
export async function extractFiles(files, opts, onProgress, signal) {
  const inRange = parseRange(opts.range);
  const lang = (opts.lang || "eng").trim() || "eng";
  const pages = [];
  const progress = (label, done, total, detail) => onProgress && onProgress({ label, done, total, detail });

  // First pass: open everything and count pages so the progress bar and page numbers are global.
  const jobs = [];
  for (const file of files) {
    const kind = kindOf(file);
    if (kind === "pdf") {
      const doc = await pdfjsLib.getDocument({
        data: new Uint8Array(await file.arrayBuffer()),
        cMapUrl: LIB + "pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: LIB + "pdfjs/standard_fonts/",
        wasmUrl: LIB + "pdfjs/wasm/",
        isEvalSupported: false, // extension CSP forbids eval

      }).promise;
      jobs.push({ file, kind, doc, count: doc.numPages });
    } else if (kind === "image") {
      jobs.push({ file, kind, count: 1 });
    } else if (kind === "text") {
      const vp = splitVirtualPages(await file.text());
      jobs.push({ file, kind, vp, count: vp.length });
    } else {
      throw new Error(`Unsupported file: ${file.name} (use PDF, images, .txt or .md)`);
    }
  }
  const totalPages = jobs.reduce((s, j) => s + j.count, 0);
  let wanted = 0;
  for (let n = 1; n <= totalPages; n++) if (inRange(n)) wanted++;
  if (!wanted) throw new Error("The page range selects no pages.");

  let n = 0, done = 0;
  const ocrLog = (m) => {
    if (m.status && m.status !== "recognizing text") progress(`OCR: ${m.status}`, done, wanted);
  };

  for (const job of jobs) {
    for (let i = 1; i <= job.count; i++) {
      n++;
      if (!inRange(n)) continue;
      if (signal && signal.aborted) throw new Error("Stopped");
      const base = { n, file: job.file.name, filePage: i };

      if (job.kind === "text") {
        progress(`Reading ${job.file.name}`, done, wanted);
        pages.push({ ...base, method: "plain", conf: null, text: job.vp[i - 1].trim() });
      } else if (job.kind === "image") {
        progress(`OCR page ${n}: ${job.file.name}`, done, wanted);
        const r = await recognize(job.file, lang, ocrLog);
        pages.push({ ...base, method: "ocr", conf: r.conf, text: r.text });
      } else {
        const page = await job.doc.getPage(i);
        let text = opts.forceOcr ? "" : pageTextFromContent(await page.getTextContent());
        if (meaningfulLength(text) >= MIN_TEXT_CHARS) {
          progress(`Text layer page ${n}`, done, wanted);
          pages.push({ ...base, method: "text", conf: null, text });
        } else {
          progress(`OCR page ${n} of ${job.file.name}`, done, wanted, "rendering");
          const canvas = await renderPage(page);
          const r = await recognize(canvas, lang, ocrLog);
          canvas.width = canvas.height = 0; // free memory
          // Keep the text layer if OCR found less (e.g. a mostly blank page with a caption).
          if (meaningfulLength(r.text) >= meaningfulLength(text)) pages.push({ ...base, method: "ocr", conf: r.conf, text: r.text });
          else pages.push({ ...base, method: "text", conf: null, text });
        }
        page.cleanup();
      }
      done++;
      progress("Extracting", done, wanted);
    }
    if (job.doc) await job.doc.destroy();
  }
  return pages;
}
