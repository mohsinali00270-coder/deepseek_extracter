// DeepSeek Code Exporter — content script
(() => {
  const ICON = "📦";
  let panelHost = null;

  // ---------------- helpers ----------------
  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  function chatTitle() {
    const t = (document.title || "").replace(/\s*[-|–]\s*DeepSeek.*$/i, "").trim();
    return (t && !/^deepseek/i.test(t) ? t : "deepseek-project")
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "deepseek-project";
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Marks earlier blocks that a later block with the same path will overwrite.
  function markReplaced(files) {
    const last = new Map();
    files.forEach((f, i) => { if (f.selected) last.set(f.path, i); });
    files.forEach((f, i) => { f.replaced = f.selected && last.get(f.path) !== i; });
  }

  function buildZip(state) {
    const { files, treeDirs, opts } = state;
    const root = DSParser.cleanPath(opts.projectName) || "deepseek-project";
    const picked = new Map();

    for (const f of files) {
      if (!f.selected) continue;
      let p = DSParser.cleanPath(f.path) || "untitled.txt";
      if (!opts.latestWins && picked.has(p)) {
        const dot = p.lastIndexOf(".");
        let n = 2, cand;
        do {
          cand = dot > p.lastIndexOf("/") ? `${p.slice(0, dot)} (${n})${p.slice(dot)}` : `${p} (${n})`;
          n++;
        } while (picked.has(cand));
        p = cand;
      }
      picked.set(p, f.code.endsWith("\n") ? f.code : f.code + "\n");
    }

    const dirs = new Set();
    const addParents = (p) => {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    };
    [...picked.keys()].forEach(addParents);
    if (opts.treeFolders) treeDirs.forEach((d) => { dirs.add(d); addParents(d); });

    const entries = [{ path: root, dir: true }];
    [...dirs].sort().forEach((d) => entries.push({ path: `${root}/${d}`, dir: true }));
    [...picked.entries()].forEach(([p, content]) => entries.push({ path: `${root}/${p}`, content }));
    return { blob: DSZip.build(entries), count: picked.size, root };
  }

  function scanState(roots) {
    const res = DSParser.scan(roots);
    return {
      files: res.files,
      treeDirs: res.treeDirs,
      treeFiles: res.treeFiles,
      opts: { projectName: chatTitle(), latestWins: true, treeFolders: true },
    };
  }

  function quickDownload(roots) {
    const state = scanState(roots);
    markReplaced(state.files);
    if (!state.files.some((f) => f.selected)) {
      openPanel(roots, "No named files were found — pick the blocks you want here.");
      return;
    }
    const { blob, root } = buildZip(state);
    downloadBlob(blob, `${root}.zip`);
  }

  // ---------------- review panel ----------------
  function openPanel(roots, notice) {
    closePanel();
    const state = scanState(roots);
    const scopeLabel = roots.length === 1 ? "This response" : `Whole chat (${roots.length} responses)`;

    panelHost = document.createElement("div");
    panelHost.className = "dsx-root";
    const shadow = panelHost.attachShadow({ mode: "open" });
    document.body.appendChild(panelHost);

    shadow.innerHTML = `
      <style>${PANEL_CSS}</style>
      <div class="overlay">
        <div class="panel" role="dialog" aria-label="DeepSeek Code Exporter">
          <header>
            <div>
              <h2>${ICON} Export code as files</h2>
              <div class="sub">${escapeHtml(scopeLabel)} · <span id="sum"></span></div>
            </div>
            <button class="x" id="close" title="Close">✕</button>
          </header>
          ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
          <div class="opts">
            <label>Project folder <input id="proj" type="text" value="${escapeHtml(state.opts.projectName)}"></label>
            <label class="chk"><input id="latest" type="checkbox" checked> Same path → keep latest version</label>
            <label class="chk"><input id="tree" type="checkbox" checked> Create folders from project tree${state.treeDirs.length ? ` (${state.treeDirs.length})` : ""}</label>
          </div>
          <div class="list" id="list"></div>
          <footer>
            <div class="left">
              <button id="all">Select all</button>
              <button id="none">Select none</button>
            </div>
            <button class="primary" id="dl">Download ZIP</button>
          </footer>
        </div>
      </div>`;

    const $ = (id) => shadow.getElementById(id);
    const list = $("list");

    function render() {
      markReplaced(state.files);
      if (!state.files.length) {
        list.innerHTML = `<div class="empty">No code blocks found in ${escapeHtml(scopeLabel.toLowerCase())}.</div>`;
      } else {
        list.innerHTML = state.files
          .map((f, i) => {
            const badge =
              f.kind === "tree" ? `<span class="b tree">tree</span>`
              : f.source === "none" ? `<span class="b warn" title="No file name found next to this block">unnamed</span>`
              : `<span class="b ok" title="Name found from: ${escapeHtml(f.source)}">${escapeHtml(f.source.replace("text", "named").replace("comment", "from comment"))}</span>`;
            return `
            <div class="row ${f.replaced ? "replaced" : ""}" data-i="${i}">
              <input type="checkbox" class="sel" ${f.selected ? "checked" : ""} title="Include in ZIP">
              <input type="text" class="path" value="${escapeHtml(f.path)}" spellcheck="false">
              <span class="meta">${escapeHtml(f.lang || "—")} · ${f.lines} ln</span>
              ${badge}
              ${f.replaced ? `<span class="b old" title="A later block with the same path will be used">older</span>` : ""}
              <button class="pv" title="Preview">👁</button>
              <pre class="preview" hidden>${escapeHtml(f.code.slice(0, 4000))}${f.code.length > 4000 ? "\n…" : ""}</pre>
            </div>`;
          })
          .join("");
      }
      const n = state.files.filter((f) => f.selected && !(f.replaced && state.opts.latestWins)).length;
      $("sum").textContent = `${state.files.length} code blocks · ${n} file${n === 1 ? "" : "s"} selected`;
      $("dl").disabled = n === 0;
      $("dl").textContent = n ? `Download ZIP (${n})` : "Download ZIP";
    }

    list.addEventListener("change", (e) => {
      const row = e.target.closest(".row");
      if (!row) return;
      const f = state.files[+row.dataset.i];
      if (e.target.classList.contains("sel")) f.selected = e.target.checked;
      if (e.target.classList.contains("path")) f.path = DSParser.cleanPath(e.target.value) || f.path;
      render();
    });
    list.addEventListener("click", (e) => {
      if (!e.target.classList.contains("pv")) return;
      const pre = e.target.closest(".row").querySelector(".preview");
      pre.hidden = !pre.hidden;
    });

    $("proj").addEventListener("input", (e) => (state.opts.projectName = e.target.value));
    $("latest").addEventListener("change", (e) => { state.opts.latestWins = e.target.checked; render(); });
    $("tree").addEventListener("change", (e) => (state.opts.treeFolders = e.target.checked));
    $("all").onclick = () => { state.files.forEach((f) => (f.selected = true)); render(); };
    $("none").onclick = () => { state.files.forEach((f) => (f.selected = false)); render(); };
    $("close").onclick = closePanel;
    shadow.querySelector(".overlay").addEventListener("click", (e) => { if (e.target.classList.contains("overlay")) closePanel(); });
    $("dl").onclick = () => {
      const { blob, root } = buildZip(state);
      downloadBlob(blob, `${root}.zip`);
    };
    shadow.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });

    render();
  }

  // ---------------- upload ZIP → text prompt ----------------
  function findChatInput() {
    return (
      document.querySelector("textarea#chat-input") ||
      document.querySelector('textarea[placeholder*="DeepSeek" i]') ||
      [...document.querySelectorAll("textarea")].filter((t) => t.offsetParent).pop() ||
      null
    );
  }

  function insertIntoChat(text) {
    const ta = findChatInput();
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
    ta.setSelectionRange(text.length, text.length);
    return true;
  }

  function openUploadPanel() {
    closePanel();
    const state = { items: [], root: "", zipName: "" };

    panelHost = document.createElement("div");
    panelHost.className = "dsx-root";
    const shadow = panelHost.attachShadow({ mode: "open" });
    document.body.appendChild(panelHost);

    shadow.innerHTML = `
      <style>${PANEL_CSS}${UPLOAD_CSS}</style>
      <div class="overlay">
        <div class="panel" role="dialog" aria-label="Upload ZIP as prompt">
          <header>
            <div>
              <h2>📤 Upload ZIP → text prompt</h2>
              <div class="sub" id="sum">Each file goes into the prompt with a comment showing its relative path.</div>
            </div>
            <button class="x" id="close" title="Close">✕</button>
          </header>
          <div class="drop" id="drop">
            <input type="file" id="file" accept=".zip,application/zip" hidden>
            <div><b>Drop a .zip here</b> or <button id="pick" class="link">choose a file</button></div>
            <div class="small" id="zipname">Unzipped in your browser. Nothing is uploaded anywhere.</div>
          </div>
          <div class="opts">
            <label class="grow">Instruction (optional, goes at the top)
              <textarea id="instr" rows="2" placeholder="e.g. Review this project and add a Products CRUD page."></textarea>
            </label>
            <label class="chk"><input id="fences" type="checkbox" checked> Wrap files in code fences</label>
            <label class="chk"><input id="tree" type="checkbox" checked> Add file list at top</label>
          </div>
          <div class="list" id="list"><div class="empty">No ZIP loaded yet.</div></div>
          <footer>
            <div class="left">
              <button id="all" disabled>Select all text files</button>
              <button id="none" disabled>Select none</button>
            </div>
            <div class="left">
              <span class="count" id="count"></span>
              <button id="txt" disabled>Save .txt</button>
              <button id="copy" disabled>Copy</button>
              <button class="primary" id="insert" disabled>Insert into chat</button>
            </div>
          </footer>
        </div>
      </div>`;

    const $ = (id) => shadow.getElementById(id);
    const list = $("list");

    const selected = () => state.items.filter((f) => f.selected && f.text !== null);
    const promptText = () =>
      DSPrompt.build(selected(), {
        instruction: $("instr").value,
        fences: $("fences").checked,
        tree: $("tree").checked,
        root: state.root,
      });

    function render() {
      if (!state.items.length) return;
      list.innerHTML = state.items
        .map((f, i) => `
          <div class="row ${f.text === null ? "disabled" : ""}" data-i="${i}">
            <input type="checkbox" class="sel" ${f.selected ? "checked" : ""} ${f.text === null ? "disabled" : ""}>
            <code class="cm">${escapeHtml(DSPrompt.pathComment(f.path))}</code>
            <span class="meta">${(f.size / 1024).toFixed(1)} KB</span>
            ${f.reason ? `<span class="b ${f.text === null ? "old" : "warn"}">${escapeHtml(f.reason)}</span>` : ""}
          </div>`)
        .join("");
      const sel = selected();
      const text = sel.length ? promptText() : "";
      $("count").textContent = sel.length
        ? `${sel.length} files · ${text.length.toLocaleString()} chars · ~${Math.round(text.length / 3.5).toLocaleString()} tokens`
        : "";
      ["txt", "copy", "insert"].forEach((id) => ($(id).disabled = !sel.length));
      ["all", "none"].forEach((id) => ($(id).disabled = false));
      $("sum").textContent = `${state.zipName}: ${state.items.length} files, ${sel.length} selected${state.root ? ` · top folder "${state.root}/" removed from paths` : ""}`;
    }

    async function loadZip(file) {
      if (!file) return;
      $("zipname").textContent = `Reading ${file.name}…`;
      try {
        const entries = await DSZip.read(await file.arrayBuffer());
        const { items, root } = DSPrompt.prepare(entries);
        Object.assign(state, { items, root, zipName: file.name });
        $("zipname").textContent = `${file.name} loaded. Drop another ZIP to replace it.`;
        if (!items.length) list.innerHTML = `<div class="empty">The ZIP has no files.</div>`;
        render();
      } catch (e) {
        $("zipname").textContent = `❌ ${e.message || e}`;
      }
    }

    function flash(btn, msg) {
      const old = btn.textContent;
      btn.textContent = msg;
      setTimeout(() => (btn.textContent = old), 1500);
    }

    $("pick").onclick = () => $("file").click();
    $("file").onchange = (e) => loadZip(e.target.files[0]);
    const drop = $("drop");
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); loadZip(e.dataTransfer.files[0]); });

    list.addEventListener("change", (e) => {
      const row = e.target.closest(".row");
      if (row && e.target.classList.contains("sel")) { state.items[+row.dataset.i].selected = e.target.checked; render(); }
    });
    ["instr", "fences", "tree"].forEach((id) => $(id).addEventListener(id === "instr" ? "input" : "change", debounce(render, 250)));
    $("all").onclick = () => { state.items.forEach((f) => (f.selected = f.text !== null)); render(); };
    $("none").onclick = () => { state.items.forEach((f) => (f.selected = false)); render(); };
    $("copy").onclick = async () => {
      try { await navigator.clipboard.writeText(promptText()); flash($("copy"), "Copied ✓"); }
      catch { flash($("copy"), "Copy blocked"); }
    };
    $("txt").onclick = () => {
      const name = (state.zipName || "project.zip").replace(/\.zip$/i, "") + "-prompt.txt";
      downloadBlob(new Blob([promptText()], { type: "text/plain;charset=utf-8" }), name);
    };
    $("insert").onclick = () => {
      if (insertIntoChat(promptText())) closePanel();
      else flash($("insert"), "Chat box not found, use Copy");
    };
    $("close").onclick = closePanel;
    shadow.querySelector(".overlay").addEventListener("click", (e) => { if (e.target.classList.contains("overlay")) closePanel(); });
    shadow.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });
  }

  function closePanel() {
    if (panelHost) { panelHost.remove(); panelHost = null; }
  }

  // ---------------- 📚 Book tools (extension page in an iframe + private MessageChannel) ----------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let book = null; // { host, frame, port, mode }
  let waitCancelled = false;

  const BOOK_MODES = {
    full: "position:fixed;inset:0;z-index:2147483645;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);",
    mini: "position:fixed;right:80px;bottom:96px;z-index:2147483645;display:block;width:380px;height:48px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.25);overflow:hidden;",
    hidden: "display:none;",
  };

  function setBookMode(mode) {
    if (!book) return;
    book.mode = mode;
    book.host.style.cssText = BOOK_MODES[mode];
    book.frame.style.cssText = mode === "full"
      ? "width:min(1040px,96vw);height:92vh;border:0;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.35);background:#fff;color-scheme:normal;"
      : "width:100%;height:100%;border:0;color-scheme:normal;";
    book.port?.postMessage({ event: "show", mode });
  }

  function openBookPanel(tab) {
    closePanel();
    if (book) {
      setBookMode("full");
      if (tab) book.port?.postMessage({ event: "tab", tab });
      return;
    }
    const host = document.createElement("div");
    host.className = "dsx-root";
    host.id = "dsx-book-host";
    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("book/book.html");
    frame.allow = "clipboard-read; clipboard-write";
    frame.title = "Book tools";
    host.appendChild(frame);
    host.addEventListener("click", (e) => { if (e.target === host && book.mode === "full") setBookMode("hidden"); });
    document.body.appendChild(host);
    book = { host, frame, port: null, mode: "full" };
    setBookMode("full");

    frame.addEventListener("load", () => {
      if (book.port) return;
      const ch = new MessageChannel();
      book.port = ch.port1;
      ch.port1.onmessage = (e) => handleBookCall(e.data);
      frame.contentWindow.postMessage({ type: "dsx-book-port", tab: tab || "" }, new URL(frame.src).origin, [ch.port2]);
    });
  }

  async function handleBookCall(msg) {
    if (!msg || !msg.id) return;
    const reply = (result, error) => book?.port?.postMessage({ id: msg.id, result, error });
    try {
      const fn = BOOK_API[msg.method];
      if (!fn) throw new Error(`Unknown call ${msg.method}`);
      reply(await fn(...(msg.args || [])));
    } catch (e) {
      reply(undefined, e.message || String(e));
    }
  }

  function answerPayload(el) {
    return el ? { html: el.innerHTML, text: el.innerText || el.textContent || "" } : null;
  }

  const totalChatText = () => DSParser.listResponses().reduce((s, el) => s + (el.textContent || "").length, 0);

  function sendButtonCandidates(ta) {
    // The send button is normally the last enabled button-like element near the chat box.
    let box = ta.parentElement;
    for (let i = 0; i < 5 && box; i++, box = box.parentElement) {
      const btns = [...box.querySelectorAll('button, [role="button"]')].filter(
        (b) => b.offsetParent && b.getAttribute("aria-disabled") !== "true" && !b.disabled && !b.closest(".dsx-root") && b.querySelector("svg")
      );
      if (btns.length) return btns.slice(-1);
    }
    return [];
  }

  async function submitChat(text) {
    const ta = findChatInput();
    if (!ta) throw new Error("DeepSeek chat box not found");
    ta.focus();
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    ta.dispatchEvent(new KeyboardEvent("keydown", opts));
    ta.dispatchEvent(new KeyboardEvent("keypress", opts));
    ta.dispatchEvent(new KeyboardEvent("keyup", opts));
    await sleep(1200);
    if (findChatInput()?.value.trim() === text.trim()) {
      // Enter did not send (e.g. still uploading or a different key setting): click the send button.
      const [btn] = sendButtonCandidates(ta);
      if (btn) btn.click();
      await sleep(1200);
      if (findChatInput()?.value.trim() === text.trim()) throw new Error("Message did not start: DeepSeek did not accept the message. Is it still answering?");
    }
  }

  const BOOK_API = {
    setMode: (mode) => { setBookMode(BOOK_MODES[mode] ? mode : "full"); return true; },
    chatTitle: () => (document.title || "").replace(/\s*[-|–]\s*DeepSeek.*$/i, "").trim(),
    collect: () => DSParser.listResponses().map(answerPayload),
    lastAnswer: () => answerPayload(DSParser.listResponses().pop()),
    insert: (text) => {
      if (!insertIntoChat(text)) throw new Error("DeepSeek chat box not found");
      return true;
    },
    cancelWait: () => { waitCancelled = true; return true; },
    /** Inserts and sends a prompt, waits until DeepSeek's answer has stopped changing, returns it. */
    async sendAndWait(text, { settleMs = 5000, timeoutMs = 600000, startTimeoutMs = 90000 } = {}) {
      waitCancelled = false;
      const before = DSParser.listResponses();
      if (!insertIntoChat(text)) throw new Error("DeepSeek chat box not found");
      await sleep(400);
      await submitChat(text);

      const t0 = Date.now();
      // 1) wait for a new answer element
      let started = false;
      while (!started) {
        const now = DSParser.listResponses();
        started = now.length > before.length || (now.length && !before.includes(now[now.length - 1]));
        if (started) break;
        if (waitCancelled) return { cancelled: true };
        if (Date.now() - t0 > startTimeoutMs) throw new Error("Answer did not start within 90 s");
        await sleep(500);
      }
      // 2) wait until the whole chat text is still for settleMs (covers DeepThink reasoning + answer)
      let lastLen = -1, stableSince = Date.now(), timedOut = false;
      for (;;) {
        const len = totalChatText();
        if (len !== lastLen) { lastLen = len; stableSince = Date.now(); }
        else if (Date.now() - stableSince >= settleMs) break;
        if (waitCancelled) {
          const a = answerPayload(DSParser.listResponses().pop());
          return { cancelled: true, ...(Date.now() - stableSince >= 2000 ? a : {}) };
        }
        if (Date.now() - t0 > timeoutMs) { timedOut = true; break; }
        await sleep(500);
      }
      return { ...answerPayload(DSParser.listResponses().pop()), timedOut };
    },
  };

  // ---------------- per-response bar ("at the end" of each answer) ----------------
  function ensureBars() {
    const responses = DSParser.listResponses();
    for (const resp of responses) {
      const count = resp.querySelectorAll("pre").length;
      let bar = resp.nextElementSibling?.classList?.contains("dsx-bar") ? resp.nextElementSibling : null;
      if (!count) { bar?.remove(); continue; }
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "dsx-bar dsx-root";
        bar.innerHTML = `
          <button class="dsx-btn dsx-primary" data-act="zip"></button>
          <button class="dsx-btn" data-act="review">Review files…</button>`;
        bar.addEventListener("click", (e) => {
          const act = e.target.closest("button")?.dataset.act;
          if (act === "zip") quickDownload([resp]);
          if (act === "review") openPanel([resp]);
        });
        resp.insertAdjacentElement("afterend", bar);
      }
      const label = `${ICON} Download code as ZIP (${count} block${count === 1 ? "" : "s"})`;
      const btn = bar.querySelector('[data-act="zip"]');
      if (btn.textContent !== label) btn.textContent = label;
    }
  }

  function ensureFab() {
    if (document.getElementById("dsx-fab")) return;
    const fab = document.createElement("button");
    fab.id = "dsx-fab";
    fab.className = "dsx-root";
    fab.title = "Export all code in this chat";
    fab.textContent = ICON;
    fab.onclick = () => openPanel(DSParser.listResponses());
    document.body.appendChild(fab);

    const up = document.createElement("button");
    up.id = "dsx-fab-up";
    up.className = "dsx-root";
    up.title = "Upload a ZIP and turn it into a prompt";
    up.textContent = "📤";
    up.onclick = openUploadPanel;
    document.body.appendChild(up);

    const bk = document.createElement("button");
    bk.id = "dsx-fab-book";
    bk.className = "dsx-root";
    bk.title = "Book tools: PDF book from this chat, or read a PDF / scans in chunks";
    bk.textContent = "📚";
    bk.onclick = () => openBookPanel();
    document.body.appendChild(bk);
  }

  const refresh = debounce(() => { ensureBars(); ensureFab(); }, 700);

  new MutationObserver((muts) => {
    if (muts.every((m) => m.target.closest?.(".dsx-root") || [...m.addedNodes].every((n) => n.classList?.contains("dsx-root")))) return;
    refresh();
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  refresh();

  // Messages from the toolbar popup
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    const roots = DSParser.listResponses();
    if (msg.type === "dsx-status") {
      const res = DSParser.scan(roots);
      reply({ responses: roots.length, blocks: res.files.length, named: res.files.filter((f) => f.selected).length });
    } else if (msg.type === "dsx-open") {
      openPanel(roots);
      reply({ ok: true });
    } else if (msg.type === "dsx-zip-all") {
      quickDownload(roots);
      reply({ ok: true });
    } else if (msg.type === "dsx-upload") {
      openUploadPanel();
      reply({ ok: true });
    } else if (msg.type === "dsx-book") {
      openBookPanel(msg.tab);
      reply({ ok: true });
    } else if (msg.type === "dsx-zip-last") {
      if (roots.length) quickDownload([roots[roots.length - 1]]);
      reply({ ok: !!roots.length });
    }
    return true;
  });

  const UPLOAD_CSS = `
    .drop { margin: 12px 20px 0; padding: 18px; border: 2px dashed #c7cdd6; border-radius: 10px; text-align: center; font-size: 14px; }
    .drop.over { border-color: #4d6bfe; background: rgba(77,107,254,.07); }
    .drop .small { font-size: 12px; color: #6b7280; margin-top: 6px; }
    .link { border: 0; background: none; color: #4d6bfe; cursor: pointer; font-size: 14px; text-decoration: underline; padding: 0; }
    .grow { flex: 1 1 100%; display: flex; flex-direction: column; gap: 4px; }
    .grow textarea { width: 100%; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font: 13px system-ui, sans-serif; resize: vertical; background: inherit; color: inherit; }
    .cm { flex: 1; min-width: 240px; font: 12.5px ui-monospace, Consolas, monospace; color: #0550ae; }
    .row.disabled .cm { color: #9ca3af; }
    .count { font-size: 12px; color: #6b7280; align-self: center; }
    @media (prefers-color-scheme: dark) { .cm { color: #79c0ff; } .drop { border-color: #3a3d42; } }`;

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2147483646; display: flex; align-items: center; justify-content: center; }
    .panel { width: min(880px, 94vw); max-height: 88vh; display: flex; flex-direction: column; background: #fff; color: #1f2328; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.35); overflow: hidden; }
    header { display: flex; justify-content: space-between; align-items: flex-start; padding: 16px 20px 10px; border-bottom: 1px solid #e5e7eb; }
    h2 { margin: 0; font-size: 17px; }
    .sub { font-size: 12.5px; color: #6b7280; margin-top: 4px; }
    .x { border: 0; background: transparent; font-size: 18px; cursor: pointer; color: #6b7280; }
    .notice { margin: 10px 20px 0; padding: 8px 12px; background: #fff7e6; border: 1px solid #f5c26b; border-radius: 8px; font-size: 13px; }
    .opts { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; padding: 12px 20px; font-size: 13px; border-bottom: 1px solid #f0f0f0; }
    .opts input[type=text] { margin-left: 6px; padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; width: 220px; }
    .chk { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .list { overflow: auto; padding: 8px 12px; flex: 1; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; }
    .row:hover { background: #f6f8fa; }
    .row.replaced .path { text-decoration: line-through; color: #9ca3af; }
    .path { flex: 1; min-width: 240px; padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 6px; font: 12.5px ui-monospace, Consolas, monospace; }
    .meta { font-size: 12px; color: #6b7280; min-width: 90px; }
    .b { font-size: 11px; padding: 2px 7px; border-radius: 999px; white-space: nowrap; }
    .b.ok { background: #e7f6ec; color: #1a7f37; } .b.warn { background: #fff4e5; color: #9a6700; }
    .b.tree { background: #eef2ff; color: #4338ca; } .b.old { background: #f3f4f6; color: #6b7280; }
    .pv { border: 0; background: transparent; cursor: pointer; font-size: 14px; }
    .preview { width: 100%; margin: 4px 0 6px 28px; max-height: 260px; overflow: auto; background: #0d1117; color: #e6edf3; padding: 10px; border-radius: 8px; font: 12px/1.45 ui-monospace, Consolas, monospace; white-space: pre; }
    .empty { padding: 30px; text-align: center; color: #6b7280; }
    footer { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; border-top: 1px solid #e5e7eb; background: #fafafa; }
    footer .left { display: flex; gap: 8px; }
    button { font-size: 13px; }
    footer button { padding: 7px 12px; border: 1px solid #d1d5db; background: #fff; border-radius: 8px; cursor: pointer; }
    footer .primary { background: #4d6bfe; border-color: #4d6bfe; color: #fff; font-weight: 600; padding: 8px 18px; }
    footer .primary:disabled { opacity: .5; cursor: not-allowed; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #1e1f22; color: #e6e6e6; }
      header, .opts, footer { border-color: #33363b; } footer { background: #191a1c; }
      .row:hover { background: #2a2c30; }
      .path, .opts input[type=text], footer button { background: #26282c; color: #e6e6e6; border-color: #3a3d42; }
      .notice { background: #3a2f17; border-color: #8a6a2a; }
    }`;
})();
