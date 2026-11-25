// Book tools panel. Runs as an extension page inside an iframe on chat.deepseek.com and talks to
// the content script through a private MessageChannel (see openBookPanel in content.js).
import { extractFiles, kindOf, naturalSort, disposeOcr, parseRange } from "./extract.js";
import { TASKS, fill, buildChunks, estimateTokens } from "./chunker.js";
import { sanitizeHtml, titleFromHtml, buildBookHtml, buildMarkdown, printHtml, downloadText, safeFileName, escapeHtml } from "./bookexport.js";

const $ = (id) => document.getElementById(id);
const DEEPSEEK_ORIGIN = "https://chat.deepseek.com";
const JOB_KEY = "dsxBookJob";
const TPL_KEY = "dsxBookTemplates";
const BUSY_RE = /server is busy|服务器繁忙|try again later|too many requests|rate limit/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ====================== bridge to the DeepSeek page ======================
let port = null;
let seq = 0;
const pending = new Map();

window.addEventListener("message", (e) => {
  if (e.origin !== DEEPSEEK_ORIGIN || e.data?.type !== "dsx-book-port" || !e.ports?.[0] || port) return;
  port = e.ports[0];
  port.onmessage = ({ data }) => {
    if (data?.event === "show") return setMini(data.mode === "mini");
    if (data?.event === "tab") return switchTab(data.tab);
    const p = pending.get(data?.id);
    if (!p) return;
    pending.delete(data.id);
    data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
  };
  $("conn").textContent = "Connected to this DeepSeek chat";
  if (e.data.tab) switchTab(e.data.tab);
});

function call(method, ...args) {
  if (!port) return Promise.reject(new Error("Not connected to a DeepSeek tab. Open Book tools from chat.deepseek.com."));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage({ id, method, args });
  });
}

setTimeout(() => { if (!port) $("conn").textContent = "Not connected: open this panel with the 📚 button on chat.deepseek.com"; }, 1500);

// ====================== state ======================
let files = [];
let job = newJob();
let templates = {};
const run = { active: false, pauseReq: false, current: -1, startedAt: 0, extracting: null, manualPart: -1 };

function newJob() {
  return {
    title: "", pages: [], chunks: [], results: [], final: null,
    chunkOpts: { maxChars: 12000, overlap: 0, markers: true },
    task: "exercises", prompt: TASKS.exercises.prompt, finalOn: false, finalPrompt: "", language: "English",
    runOpts: { settle: 5, delay: 3, timeout: 10 },
    source: { range: "", lang: "eng", forceOcr: false, files: [] },
  };
}

const store = {
  async get(k) { try { return (await chrome.storage.local.get(k))[k]; } catch { return undefined; } },
  async set(k, v) { try { await chrome.storage.local.set({ [k]: v }); } catch (e) { console.warn("save failed", e); } },
  async del(k) { try { await chrome.storage.local.remove(k); } catch {} },
};
const saveJob = debounce(() => store.set(JOB_KEY, job), 400);
const saveTemplates = debounce(() => store.set(TPL_KEY, templates), 400);

// ====================== tabs / mini ======================
function switchTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.id === `tab-${name}`));
  if (name === "results") renderResults();
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

function setMini(on) { document.body.classList.toggle("mini", !!on); }
$("minBtn").onclick = () => { call("setMode", "mini").catch(() => {}); setMini(true); };
$("miniExpand").onclick = () => { call("setMode", "full").catch(() => {}); setMini(false); };
$("miniPause").onclick = () => pause();
$("closeBtn").onclick = () => {
  if (run.active) { call("setMode", "mini").catch(() => {}); setMini(true); return; } // keep the job alive
  call("setMode", "hidden").catch(() => {});
};

// Shared book layout options (page size / font / TOC) for both export tabs.
document.querySelectorAll("[data-bookopts]").forEach((el) => el.appendChild($("bookOpts").content.cloneNode(true)));
function bookOpts(prefix) {
  const el = document.querySelector(`[data-bookopts="${prefix}"]`);
  return {
    pageSize: el.querySelector(".bo-size").value,
    fontSize: +el.querySelector(".bo-font").value || 11,
    toc: el.querySelector(".bo-toc").checked,
  };
}

// ====================== step 1: files + extraction ======================
function setFiles(list) {
  const arr = [...list].filter((f) => kindOf(f));
  const skipped = list.length - arr.length;
  // Images are pages: sort them naturally. PDFs/text keep the order they were picked.
  const imgs = naturalSort(arr.filter((f) => kindOf(f) === "image"));
  files = [...arr.filter((f) => kindOf(f) !== "image"), ...imgs];
  $("fileList").textContent = files.length
    ? `${files.length} file(s): ${files.map((f) => f.name).slice(0, 6).join(", ")}${files.length > 6 ? "…" : ""}${skipped ? ` · ${skipped} unsupported skipped` : ""}`
    : "No supported files (use PDF, images, .txt or .md).";
  $("extractBtn").disabled = !files.length;
  if (files.length && !$("title").value) {
    $("title").value = files[0].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    job.title = $("title").value;
  }
}
$("pick").onclick = () => $("file").click();
$("file").onchange = (e) => setFiles(e.target.files);
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); setFiles(e.dataTransfer.files); });

$("title").oninput = (e) => { job.title = e.target.value; saveJob(); renderChunkSum(); };
$("lang").onchange = (e) => {
  if (e.target.value === "custom") {
    const code = prompt("Tesseract language code(s), e.g. 'ben' or 'eng+ara':", "eng");
    if (code) {
      const opt = new Option(code, code, true, true);
      e.target.add(opt, e.target.options.length - 1);
    } else e.target.value = "eng";
  }
  $("langNote").hidden = e.target.value === "eng";
};

$("extractBtn").onclick = async () => {
  try { parseRange($("range").value); } catch (err) { return alert(err.message); }
  const signal = { aborted: false };
  run.extracting = signal;
  $("exProg").hidden = false;
  $("extractBtn").disabled = true;
  const t0 = Date.now();
  try {
    const pages = await extractFiles(files, {
      range: $("range").value, lang: $("lang").value, forceOcr: $("forceOcr").checked,
    }, ({ label, done, total }) => {
      $("exBar").style.width = `${total ? (done / total) * 100 : 0}%`;
      $("exText").textContent = `${label} · ${done}/${total} pages · ${Math.round((Date.now() - t0) / 1000)}s`;
    }, signal);
    job.pages = pages;
    job.source = { range: $("range").value, lang: $("lang").value, forceOcr: $("forceOcr").checked, files: files.map((f) => f.name) };
    job.title = $("title").value || job.title || "Book";
    job.results = []; job.final = null;
    $("exText").textContent = `Done: ${pages.length} pages in ${Math.round((Date.now() - t0) / 1000)}s`;
    rechunk();
    renderPages();
    showSteps();
  } catch (err) {
    $("exText").textContent = `❌ ${err.message || err}`;
  } finally {
    run.extracting = null;
    $("extractBtn").disabled = !files.length;
    disposeOcr().catch(() => {});
  }
};
$("exStop").onclick = () => { if (run.extracting) run.extracting.aborted = true; };

function showSteps() {
  const has = job.pages.length > 0;
  ["pagesStep", "chunkStep", "runStep"].forEach((id) => ($(id).hidden = !has));
}

// ====================== step 2: pages ======================
function renderPages() {
  const ocrPages = job.pages.filter((p) => p.method === "ocr");
  const avg = ocrPages.length ? Math.round(ocrPages.reduce((s, p) => s + p.conf, 0) / ocrPages.length) : null;
  $("pagesSum").textContent = `· ${job.pages.length} pages · ${ocrPages.length} OCR'd${avg !== null ? ` (avg confidence ${avg}%)` : ""}`;
  $("pages").innerHTML = job.pages.map((p, i) => {
    const badge = p.method === "ocr"
      ? `<span class="b ${p.conf < 70 ? "low" : "ocr"}" title="OCR confidence">OCR ${p.conf}%</span>`
      : `<span class="b ${p.method}">${p.method === "text" ? "text layer" : "text file"}</span>`;
    const first = (p.text || "").replace(/\s+/g, " ").slice(0, 120);
    return `<details class="page" data-i="${i}">
      <summary><b>Page ${p.n}</b>${badge}<span class="t">${escapeHtml(first || "(empty)")}</span><span class="sum">${p.text.length} chars</span></summary>
      <textarea spellcheck="false" dir="auto">${escapeHtml(p.text)}</textarea>
    </details>`;
  }).join("");
}
$("pages").addEventListener("input", debounce((e) => {
  const d = e.target.closest(".page");
  if (!d || e.target.tagName !== "TEXTAREA") return;
  job.pages[+d.dataset.i].text = e.target.value;
  rechunk();
}, 500));

// ====================== step 3: chunks + task ======================
function rechunk() {
  job.chunkOpts = { maxChars: +$("maxChars").value || 12000, overlap: +$("overlap").value || 0, markers: $("markers").checked };
  const old = job.chunks;
  job.chunks = buildChunks(job.pages, job.chunkOpts);
  // Keep answers only while the parts are unchanged.
  const same = old.length === job.chunks.length && old.every((c, i) => c.text === job.chunks[i].text);
  if (!same || job.results.length !== job.chunks.length) { job.results = job.chunks.map(() => ({ status: "queued" })); job.final = null; }
  renderChunkSum();
  renderParts();
  saveJob();
}
["maxChars", "overlap"].forEach((id) => $(id).addEventListener("change", rechunk));
$("markers").onchange = rechunk;

function renderChunkSum() {
  const chars = job.chunks.reduce((s, c) => s + c.text.length, 0);
  const promptLen = (job.prompt || "").replace("{text}", "").length;
  $("chunkSum").textContent = job.chunks.length
    ? `${job.chunks.length} part(s) · ${chars.toLocaleString()} chars · ~${estimateTokens(chars + promptLen * job.chunks.length).toLocaleString()} tokens to send`
    : "No text to send.";
}

$("task").innerHTML = Object.entries(TASKS).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join("");
function loadTask(key, keepPrompt) {
  job.task = key;
  const t = { ...TASKS[key], ...(templates[key] || {}) };
  if (!keepPrompt) { job.prompt = t.prompt; job.finalPrompt = t.final || ""; job.finalOn = !!t.final; }
  $("task").value = key;
  $("prompt").value = job.prompt;
  $("finalPrompt").value = job.finalPrompt;
  $("finalOn").checked = job.finalOn;
  $("finalWrap").hidden = !job.finalOn;
  $("langWrap").hidden = key !== "translate";
  renderChunkSum();
}
$("task").onchange = (e) => { loadTask(e.target.value); saveJob(); };
$("prompt").oninput = (e) => {
  job.prompt = e.target.value;
  templates[job.task] = { ...(templates[job.task] || {}), prompt: job.prompt };
  saveTemplates(); saveJob(); renderChunkSum();
};
$("finalPrompt").oninput = (e) => {
  job.finalPrompt = e.target.value;
  templates[job.task] = { ...(templates[job.task] || {}), final: job.finalPrompt };
  saveTemplates(); saveJob();
};
$("finalOn").onchange = (e) => {
  job.finalOn = e.target.checked;
  $("finalWrap").hidden = !job.finalOn;
  if (job.finalOn && !job.finalPrompt) {
    job.finalPrompt = TASKS.summarize.final;
    $("finalPrompt").value = job.finalPrompt;
  }
  saveJob();
};
$("tLang").oninput = (e) => { job.language = e.target.value; saveJob(); };
$("resetTpl").onclick = () => { delete templates[job.task]; saveTemplates(); loadTask(job.task); saveJob(); };

function promptFor(i) {
  const c = job.chunks[i];
  return fill(job.prompt, {
    title: job.title || "Book", part: c.part, total: job.chunks.length, pages: c.pages, text: c.text, language: job.language || "English",
  });
}

function finalPromptText() {
  const max = Math.max(job.chunkOpts.maxChars * 2, 20000);
  let answers = job.chunks.map((c, i) => `### Part ${c.part} (pages ${c.pages})\n${(job.results[i]?.text || "").trim()}`).join("\n\n");
  let trimmed = false;
  if (answers.length > max) { answers = answers.slice(0, max) + "\n[…trimmed…]"; trimmed = true; }
  return { text: fill(job.finalPrompt, { title: job.title || "Book", total: job.chunks.length, answers, language: job.language }), trimmed };
}

// ====================== step 4: runner ======================
["settle", "delay", "timeout"].forEach((id) => $(id).addEventListener("change", () => {
  job.runOpts = { settle: +$("settle").value || 5, delay: +$("delay").value || 0, timeout: +$("timeout").value || 10 };
  saveJob();
}));

function statusLabel(r) {
  return { queued: "queued", sending: "sending…", waiting: "waiting for answer…", retry: "retrying…", done: "done", failed: "failed", inserted: "inserted, send it" }[r?.status] || "queued";
}

function renderParts() {
  const items = job.chunks.map((c, i) => {
    const r = job.results[i] || { status: "queued" };
    const meta = r.status === "failed" ? r.error : r.status === "done" ? (r.text || "").replace(/\s+/g, " ").slice(0, 140) : `${c.text.length.toLocaleString()} chars`;
    return `<div class="part ${run.current === i ? "cur" : ""}" data-i="${i}">
      <span class="lbl">Part ${c.part} · pp. ${c.pages}</span>
      <span class="b ${r.status || "queued"}">${statusLabel(r)}${r.timedOut ? " (timed out)" : ""}</span>
      <span class="meta" title="${escapeHtml(meta || "")}">${escapeHtml(meta || "")}</span>
      <button class="small-btn" data-act="insert" title="Put this part's prompt in the chat box">Insert</button>
      <button class="small-btn" data-act="run" ${run.active ? "disabled" : ""}>${r.status === "done" ? "Re-run" : "Run"}</button>
      <button class="small-btn" data-act="copy" title="Copy this part's prompt">Copy</button>
    </div>`;
  });
  if (job.finalOn) {
    const r = job.final || { status: "queued" };
    items.push(`<div class="part ${run.current === -2 ? "cur" : ""}" data-i="final">
      <span class="lbl">Final combine</span><span class="b ${r.status || "queued"}">${statusLabel(r)}</span>
      <span class="meta">${escapeHtml(r.status === "done" ? (r.text || "").replace(/\s+/g, " ").slice(0, 140) : r.error || "after all parts")}</span>
      <button class="small-btn" data-act="run" ${run.active ? "disabled" : ""}>Run</button></div>`);
  }
  $("parts").innerHTML = items.join("") || `<div class="empty">No parts.</div>`;
  const done = job.results.filter((r) => r.status === "done").length;
  $("resCount").textContent = done ? String(done + (job.final?.status === "done" ? 1 : 0)) : "";
  $("startBtn").disabled = run.active || !job.chunks.length;
  $("pauseBtn").disabled = !run.active;
  $("startBtn").textContent = done && done < job.chunks.length ? `▶ Resume (${done}/${job.chunks.length} done)` : "▶ Start auto-run";
  updateMini();
}

function updateMini() {
  const done = job.results.filter((r) => r.status === "done").length;
  const total = job.chunks.length;
  let t = run.active
    ? `📚 ${run.current === -2 ? "Final combine" : `Part ${run.current + 1}/${total}`} · ${statusLabel(run.current === -2 ? job.final : job.results[run.current])} · ${Math.round((Date.now() - run.startedAt) / 1000)}s`
    : total ? `📚 ${done}/${total} parts done${run.pauseReq ? " · paused" : ""}` : "📚 Book tools";
  $("miniText").textContent = t;
  $("miniPause").disabled = !run.active;
}
setInterval(() => { if (run.active) updateMini(); }, 1000);

$("parts").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  const row = e.target.closest(".part");
  if (!btn || !row) return;
  const i = row.dataset.i === "final" ? "final" : +row.dataset.i;
  try {
    if (btn.dataset.act === "insert") {
      await call("insert", promptFor(i));
      job.results[i] = { ...job.results[i], status: job.results[i]?.status === "done" ? "done" : "inserted" };
      run.manualPart = i;
      renderParts();
    } else if (btn.dataset.act === "copy") {
      await navigator.clipboard.writeText(promptFor(i));
      btn.textContent = "Copied ✓"; setTimeout(() => (btn.textContent = "Copy"), 1200);
    } else if (btn.dataset.act === "run") {
      startRun(i === "final" ? ["final"] : [i]);
    }
  } catch (err) { alert(err.message); }
});

$("startBtn").onclick = () => {
  const todo = job.chunks.map((_, i) => i).filter((i) => job.results[i]?.status !== "done");
  if (job.finalOn && job.final?.status !== "done") todo.push("final");
  if (!todo.length) return alert("Every part is already done. Use Re-run on a part, or Clear job.");
  startRun(todo);
};
$("pauseBtn").onclick = () => pause();
function pause() { run.pauseReq = true; call("cancelWait").catch(() => {}); updateMini(); }

$("nextBtn").onclick = async () => {
  const i = job.chunks.findIndex((_, k) => !["done", "inserted"].includes(job.results[k]?.status));
  if (i < 0) return alert("No unfinished parts left.");
  try {
    await call("insert", promptFor(i));
    job.results[i] = { status: "inserted" };
    run.manualPart = i;
    renderParts(); saveJob();
  } catch (err) { alert(err.message); }
};
$("captureBtn").onclick = async () => {
  let i = run.manualPart;
  if (i < 0) i = job.results.findIndex((r) => r.status === "inserted");
  if (i < 0) return alert("Insert a part first, send it in DeepSeek, wait for the answer, then press Capture.");
  try {
    const ans = await call("lastAnswer");
    if (!ans) return alert("No DeepSeek answer found on the page.");
    job.results[i] = { status: "done", text: ans.text, html: sanitizeHtml(ans.html), at: Date.now() };
    run.manualPart = -1;
    renderParts(); saveJob();
  } catch (err) { alert(err.message); }
};
$("clearJob").onclick = async () => {
  if (run.active) return alert("Pause the run first.");
  if (!confirm("Clear the extracted text, parts and all answers?")) return;
  job = newJob();
  await store.del(JOB_KEY);
  applyJobToUi();
};

async function startRun(list) {
  if (run.active) return;
  run.active = true; run.pauseReq = false; run.startedAt = Date.now();
  renderParts();
  try {
    for (let k = 0; k < list.length; k++) {
      if (run.pauseReq) break;
      const i = list[k];
      if (i === "final") {
        if (job.chunks.some((_, j) => job.results[j]?.status !== "done")) {
          job.final = { status: "failed", error: "Finish all parts first" };
          continue;
        }
        run.current = -2;
        const { text, trimmed } = finalPromptText();
        job.final = await sendWithRetry(text, (r) => { job.final = r; renderParts(); });
        if (trimmed) job.final.note = "Part answers were trimmed to fit.";
      } else {
        run.current = i;
        job.results[i] = await sendWithRetry(promptFor(i), (r) => { job.results[i] = r; renderParts(); });
      }
      saveJob();
      renderParts();
      if (k < list.length - 1 && !run.pauseReq) await sleep((job.runOpts.delay || 0) * 1000);
    }
  } finally {
    run.active = false; run.current = -1;
    renderParts(); saveJob();
  }
}

async function sendWithRetry(text, onStatus) {
  const opts = { settleMs: (job.runOpts.settle || 5) * 1000, timeoutMs: (job.runOpts.timeout || 10) * 60000 };
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (run.pauseReq) return { status: "queued" };
    onStatus({ status: attempt ? "retry" : "sending" });
    try {
      const waitingTimer = setTimeout(() => onStatus({ status: "waiting" }), 1500);
      const ans = await call("sendAndWait", text, opts);
      clearTimeout(waitingTimer);
      if (ans.cancelled) {
        // Paused while waiting: keep whatever DeepSeek has written so far only if it settled.
        return ans.text ? { status: "done", text: ans.text, html: sanitizeHtml(ans.html), at: Date.now(), timedOut: true } : { status: "queued" };
      }
      const t = (ans.text || "").trim();
      if ((!t || (BUSY_RE.test(t) && t.length < 300)) && attempt < 2) {
        lastErr = t ? "DeepSeek was busy" : "Empty answer";
        onStatus({ status: "retry", error: lastErr });
        await sleep(15000 * (attempt + 1));
        continue;
      }
      return { status: "done", text: ans.text, html: sanitizeHtml(ans.html), at: Date.now(), timedOut: !!ans.timedOut };
    } catch (err) {
      lastErr = err.message || String(err);
      // A missing chat box / send failure won't fix itself quickly: stop and tell the user.
      if (/not found|not connected|did not start/i.test(lastErr) || attempt === 2) break;
      await sleep(5000);
    }
  }
  run.pauseReq = true;
  return { status: "failed", error: lastErr || "Failed" };
}

// ====================== results tab ======================
function resultChapters() {
  const ch = job.chunks.map((c, i) => ({ c, r: job.results[i] })).filter(({ r }) => r?.status === "done").map(({ c, r }) => ({
    title: `Part ${c.part} · pages ${c.pages}`,
    meta: `${job.title || "Book"} · ${TASKS[job.task]?.label || ""}`,
    html: r.html || `<pre>${escapeHtml(r.text || "")}</pre>`,
    text: r.text || "",
    original: $("rOrig").checked ? c.text : "",
  }));
  if (job.final?.status === "done") {
    const f = { title: "Overall result", meta: job.final.note || "Combined from all parts", html: job.final.html || "", text: job.final.text || "" };
    $("rFinalFirst").checked ? ch.unshift(f) : ch.push(f);
  }
  return ch;
}

function renderResults() {
  if (!$("rTitle").value) $("rTitle").value = job.title ? `${job.title} (${TASKS[job.task]?.label || "answers"})` : "";
  const ch = resultChapters();
  $("results").innerHTML = ch.length
    ? ch.map((c, i) => `<details class="res" ${i === 0 ? "open" : ""}><summary><span class="t">${escapeHtml(c.title)}</span><span class="sum">${c.text.length.toLocaleString()} chars</span></summary><div class="answer" dir="auto">${c.html}</div></details>`).join("")
    : `<div class="empty">No answers yet. Run a book in “Read a book”.</div>`;
}
$("rOrig").onchange = renderResults;
$("rFinalFirst").onchange = renderResults;

function resultBook() {
  return { title: $("rTitle").value || job.title || "Book", subtitle: $("rSub").value, ...bookOpts("r"), chapters: resultChapters() };
}
function needChapters(book) { if (!book.chapters.length) { alert("Nothing to export yet."); return false; } return true; }
$("rPdf").onclick = () => { const b = resultBook(); if (needChapters(b)) printHtml(buildBookHtml(b)); };
$("rHtml").onclick = () => { const b = resultBook(); if (needChapters(b)) downloadText(buildBookHtml(b), `${safeFileName(b.title)}.html`, "text/html;charset=utf-8"); };
$("rMd").onclick = () => { const b = resultBook(); if (needChapters(b)) downloadText(buildMarkdown(b), `${safeFileName(b.title)}.md`, "text/markdown;charset=utf-8"); };
$("rCopy").onclick = async () => {
  const b = resultBook();
  if (!needChapters(b)) return;
  await navigator.clipboard.writeText(buildMarkdown({ ...b, chapters: b.chapters.map((c) => ({ ...c, original: "" })) }));
  $("rCopy").textContent = "Copied ✓"; setTimeout(() => ($("rCopy").textContent = "Copy all text"), 1200);
};

// ====================== chat → PDF book tab ======================
let chat = [];
$("loadChat").onclick = async () => {
  try {
    const items = await call("collect");
    const t = await call("chatTitle").catch(() => "");
    chat = items.map((it, i) => {
      const html = sanitizeHtml(it.html);
      return { html, text: it.text, title: titleFromHtml(html, `Answer ${i + 1}`), selected: (it.text || "").trim().length > 0 };
    });
    if (!$("cTitle").value) $("cTitle").value = t || "DeepSeek chat";
    renderChat();
  } catch (err) { alert(err.message); }
};
function renderChat() {
  const n = chat.filter((c) => c.selected).length;
  $("chatSum").textContent = chat.length ? `${chat.length} answers · ${n} selected` : "";
  $("chatList").innerHTML = chat.length
    ? chat.map((c, i) => `<div class="ci ${c.selected ? "" : "off"}" data-i="${i}">
        <div class="ci-h">
          <input type="checkbox" class="sel" ${c.selected ? "checked" : ""} title="Include">
          <span class="ord"><button data-act="up" title="Move up">▲</button><button data-act="down" title="Move down">▼</button></span>
          <span class="t"><input type="text" class="ttl" value="${escapeHtml(c.title)}" title="Chapter title"></span>
          <span class="sum">${c.text.length.toLocaleString()} chars</span>
          <button class="small-btn" data-act="pv">Preview</button>
        </div>
        <div class="answer" hidden dir="auto">${c.html}</div>
      </div>`).join("")
    : `<div class="empty">No answers found in this chat.</div>`;
}
$("chatList").addEventListener("change", (e) => {
  const row = e.target.closest(".ci"); if (!row) return;
  const c = chat[+row.dataset.i];
  if (e.target.classList.contains("sel")) { c.selected = e.target.checked; renderChat(); }
});
$("chatList").addEventListener("input", (e) => {
  const row = e.target.closest(".ci");
  if (row && e.target.classList.contains("ttl")) chat[+row.dataset.i].title = e.target.value;
});
$("chatList").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); const row = e.target.closest(".ci");
  if (!btn || !row) return;
  const i = +row.dataset.i;
  if (btn.dataset.act === "pv") { const a = row.querySelector(".answer"); a.hidden = !a.hidden; return; }
  const j = btn.dataset.act === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= chat.length) return;
  [chat[i], chat[j]] = [chat[j], chat[i]];
  renderChat();
});
$("cAll").onclick = () => { chat.forEach((c) => (c.selected = true)); renderChat(); };
$("cNone").onclick = () => { chat.forEach((c) => (c.selected = false)); renderChat(); };
function chatBook() {
  return {
    title: $("cTitle").value || "DeepSeek chat", subtitle: $("cSub").value, ...bookOpts("c"),
    chapters: chat.filter((c) => c.selected).map((c) => ({ title: c.title, html: c.html, text: c.text })),
  };
}
$("cPdf").onclick = () => { const b = chatBook(); if (needChapters(b)) printHtml(buildBookHtml(b)); };
$("cHtml").onclick = () => { const b = chatBook(); if (needChapters(b)) downloadText(buildBookHtml(b), `${safeFileName(b.title)}.html`, "text/html;charset=utf-8"); };
$("cMd").onclick = () => { const b = chatBook(); if (needChapters(b)) downloadText(buildMarkdown(b), `${safeFileName(b.title)}.md`, "text/markdown;charset=utf-8"); };

// ====================== restore saved job ======================
function applyJobToUi() {
  $("title").value = job.title || "";
  $("range").value = job.source?.range || "";
  if (job.source?.lang && ![...$("lang").options].some((o) => o.value === job.source.lang)) {
    $("lang").add(new Option(job.source.lang, job.source.lang), $("lang").options.length - 1);
  }
  $("lang").value = job.source?.lang || "eng";
  $("langNote").hidden = $("lang").value === "eng";
  $("forceOcr").checked = !!job.source?.forceOcr;
  $("maxChars").value = job.chunkOpts.maxChars;
  $("overlap").value = job.chunkOpts.overlap;
  $("markers").checked = job.chunkOpts.markers;
  $("settle").value = job.runOpts.settle; $("delay").value = job.runOpts.delay; $("timeout").value = job.runOpts.timeout;
  $("tLang").value = job.language || "English";
  loadTask(job.task || "exercises", true);
  if (job.source?.files?.length && !files.length) $("fileList").textContent = `Saved job from: ${job.source.files.join(", ")}`;
  renderPages();
  renderChunkSum();
  renderParts();
  showSteps();
}

(async () => {
  templates = (await store.get(TPL_KEY)) || {};
  const saved = await store.get(JOB_KEY);
  if (saved && saved.pages) {
    job = { ...newJob(), ...saved };
    // Parts that were in flight when the page closed go back to the queue.
    job.results = job.chunks.map((_, i) => {
      const r = job.results[i] || { status: "queued" };
      return ["sending", "waiting", "retry"].includes(r.status) ? { status: "queued" } : r;
    });
    if (job.final && job.final.status !== "done") job.final = null;
  } else {
    job.prompt = templates.exercises?.prompt || TASKS.exercises.prompt;
  }
  applyJobToUi();
})();
