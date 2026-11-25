// Finds code blocks in DeepSeek responses and works out a file path for each one.
const DSParser = (() => {
  // DeepSeek's class names change from time to time; these are the only selectors used.
  const SELECTORS = {
    response: ".ds-markdown", // rendered markdown of an assistant reply
    codeWrapper: ".md-code-block", // wrapper around a code block (banner + <pre>)
    banner: '[class*="banner"]', // language label / copy button row
  };

  const LANG_EXT = {
    javascript: "js", js: "js", jsx: "jsx", typescript: "ts", ts: "ts", tsx: "tsx",
    python: "py", py: "py", csharp: "cs", "c#": "cs", cs: "cs", java: "java",
    kotlin: "kt", swift: "swift", dart: "dart", go: "go", rust: "rs", ruby: "rb",
    php: "php", c: "c", cpp: "cpp", "c++": "cpp", h: "h",
    html: "html", xml: "xml", xaml: "xaml", css: "css", scss: "scss", less: "less",
    json: "json", yaml: "yml", yml: "yml", toml: "toml", ini: "ini",
    sql: "sql", tsql: "sql", bash: "sh", sh: "sh", shell: "sh", zsh: "sh",
    powershell: "ps1", ps1: "ps1", bat: "bat", cmd: "bat",
    markdown: "md", md: "md", razor: "cshtml", cshtml: "cshtml", vue: "vue", svelte: "svelte",
    dockerfile: "Dockerfile", docker: "Dockerfile", graphql: "graphql", env: "env",
    text: "txt", plaintext: "txt", txt: "txt",
  };
  const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "powershell", "ps1", "cmd", "bat", "console", "terminal"]);

  const SPECIAL_NAMES = "Dockerfile|Makefile|Procfile|Jenkinsfile|\\.env(?:\\.[\\w-]+)?|\\.gitignore|\\.dockerignore|\\.editorconfig|\\.prettierrc|\\.eslintrc|\\.babelrc|\\.npmrc";
  const SEGMENT = "[\\w@\\-][\\w@.\\-]*";
  const FILE_RE_SRC = `(?:(?:${SEGMENT}|\\.{1,2})[\\/\\\\])*(?:${SEGMENT}\\.[A-Za-z][A-Za-z0-9]{0,11}|${SPECIAL_NAMES})`;
  const FULL_FILE_RE = new RegExp(`^${FILE_RE_SRC}$`);
  const FIND_FILE_RE = new RegExp(`(?:^|[\\s\`'"(*:])(${FILE_RE_SRC})(?=$|[\\s\`'")*:,])`, "g");

  // Words that look like file names but usually aren't.
  const FALSE_POSITIVES = /^(node\.js|next\.js|vue\.js|react\.js|asp\.net|ado\.net|vb\.net|e\.g|i\.e|etc|express\.js|nuxt\.js|three\.js|d3\.js|chart\.js|socket\.io)$/i;

  function cleanPath(p) {
    if (!p) return "";
    let s = p.trim().replace(/\\/g, "/").replace(/^[a-zA-Z]:\//, "");
    s = s.split("/").filter((seg) => seg && seg !== "." && seg !== "..").join("/");
    return s.replace(/[<>:"|?*\x00-\x1f]/g, "_");
  }

  function isFilePath(s) {
    if (!s || s.includes("://") || s.length > 200) return false;
    const t = s.trim();
    return FULL_FILE_RE.test(t) && !FALSE_POSITIVES.test(t.split(/[\\/]/).pop());
  }

  function findPathsInText(text) {
    const out = [];
    if (!text || text.includes("://") && text.length < 15) return out;
    FIND_FILE_RE.lastIndex = 0;
    let m;
    while ((m = FIND_FILE_RE.exec(text))) {
      if (isFilePath(m[1])) out.push(m[1]);
    }
    return out;
  }

  function segments(p) {
    return cleanPath(p).split("/").length;
  }

  // ---------- language + code text ----------
  function getWrapper(pre) {
    return pre.closest(SELECTORS.codeWrapper) || pre;
  }

  function getLanguage(pre, wrapper) {
    const code = pre.querySelector("code");
    const cls = (code && code.className) || pre.className || "";
    const m = cls.match(/language-([\w#+-]+)/);
    if (m) return m[1].toLowerCase();
    if (wrapper !== pre) {
      const banner = wrapper.querySelector(SELECTORS.banner);
      const scope = banner || wrapper;
      for (const el of scope.querySelectorAll("span, div")) {
        if (el.contains(pre) || el.children.length) continue;
        const t = (el.textContent || "").trim().toLowerCase();
        if (t && t.length <= 15 && /^[\w#+.-]+$/.test(t) && !/^(copy|copied|download|run|复制|下载|运行)$/.test(t)) return t;
      }
    }
    return "";
  }

  function getCode(pre) {
    const code = pre.querySelector("code") || pre;
    return (code.textContent || "").replace(/\r\n/g, "\n").replace(/\n$/, "");
  }

  // ---------- file name detection ----------
  function nameFromFirstLine(code) {
    const first = code.split("\n").find((l) => l.trim()) || "";
    const m = first.match(
      /^\s*(?:\/\/+|#+|--|\/\*+|<!--|;+|'|@\*|\{\/\*|%)\s*(?:(?:file(?:name)?|path)\s*[:=]\s*)?(.+?)\s*(?:\*+\/|-->|\*@|\*\/\})?\s*$/i
    );
    if (m && isFilePath(m[1])) return m[1];
    return null;
  }

  function scorePathCandidates(el) {
    // Prefer explicit inline code / bold, then headings, then short plain lines.
    const picks = [];
    el.querySelectorAll("code, strong, b").forEach((c) => {
      const t = (c.textContent || "").trim().replace(/^(?:file(?:name)?|path)\s*:\s*/i, "");
      if (isFilePath(t)) picks.push(t);
      else picks.push(...findPathsInText(t));
    });
    if (picks.length) return picks[picks.length - 1];
    const text = (el.textContent || "").trim();
    if (/^H[1-6]$/.test(el.tagName) || text.length <= 160) {
      const found = findPathsInText(text);
      if (found.length) return found[found.length - 1];
    }
    return null;
  }

  function isCodeBlockEl(el) {
    return el && (el.matches?.(SELECTORS.codeWrapper) || el.tagName === "PRE" || el.querySelector?.("pre"));
  }

  function nameFromContext(wrapper, root) {
    // Walk up until we have a previous sibling (code blocks are sometimes nested in <li> etc.)
    let node = wrapper;
    while (node && node !== root && !node.previousElementSibling) node = node.parentElement;
    if (!node || node === root) return null;
    let prev = node.previousElementSibling;
    for (let i = 0; i < 2 && prev; i++, prev = prev.previousElementSibling) {
      if (isCodeBlockEl(prev) && prev.tagName !== "LI" && prev.tagName !== "OL" && prev.tagName !== "UL") break;
      // Two steps back only counts if it's a heading or a short "file label" line, never a list.
      if (i === 1) {
        const short = (prev.textContent || "").trim().length <= 100 && prev.querySelector("code, strong, b");
        if (!/^H[1-6]$/.test(prev.tagName) && !(prev.tagName === "P" && short)) break;
      }
      // For lists, look at the last item only.
      const target = /^(OL|UL)$/.test(prev.tagName) ? prev.lastElementChild || prev : prev;
      const p = scorePathCandidates(target);
      if (p) return p;
    }
    // Code block inside an <li> whose own text starts with a path.
    const li = wrapper.closest("li");
    if (li && root.contains(li)) {
      const clone = li.cloneNode(true);
      clone.querySelectorAll("pre, " + SELECTORS.codeWrapper).forEach((x) => x.remove());
      const p = scorePathCandidates(clone);
      if (p) return p;
    }
    return null;
  }

  // ---------- project tree parsing ----------
  function isTree(code) {
    return /[├└]──|[|`]--\s/.test(code);
  }

  function parseTree(code) {
    const rows = [];
    for (const raw of code.split("\n")) {
      if (!raw.trim()) continue;
      const m = raw.match(/^([\s│|├└─`+\-]*)(.*)$/);
      let name = (m[2] || "")
        .replace(/\s+(#|\/\/|<-+|←|-->|\().*$/, "")
        .trim();
      if (!name || /^\.\.\.?$/.test(name)) continue;
      rows.push({ indent: m[1].length, name });
    }
    if (!rows.length) return { files: [], dirs: [] };
    const nonZero = rows.map((r) => r.indent).filter((x) => x > 0);
    const unit = nonZero.length ? Math.min(...nonZero) : 4;
    const stack = [];
    const files = [];
    const dirs = [];
    for (const r of rows) {
      const depth = Math.round(r.indent / unit);
      const clean = r.name.replace(/\/$/, "");
      stack.length = depth;
      stack[depth] = clean;
      const path = stack.filter(Boolean).join("/");
      const looksDir = r.name.endsWith("/") || (!isFilePath(clean) && !/\.[A-Za-z0-9]+$/.test(clean));
      (looksDir ? dirs : files).push(cleanPath(path));
    }
    // Strip a single shared root folder (the ZIP already has a project root).
    const roots = new Set([...files, ...dirs].map((p) => p.split("/")[0]));
    if (roots.size === 1 && dirs.includes([...roots][0])) {
      const root = [...roots][0];
      const strip = (p) => p.slice(root.length + 1);
      return { files: files.map(strip).filter(Boolean), dirs: dirs.map(strip).filter(Boolean) };
    }
    return { files, dirs };
  }

  // ---------- main scan ----------
  function listResponses(doc = document) {
    const all = [...doc.querySelectorAll(SELECTORS.response)];
    return all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
  }

  /**
   * Scans one or more response roots and returns file entries.
   * @returns {{files: object[], treeDirs: string[], treeFiles: string[]}}
   */
  function scan(roots) {
    const blocks = [];
    const treeFiles = [];
    const treeDirs = [];
    let snippet = 0;

    roots.forEach((root, responseIndex) => {
      root.querySelectorAll("pre").forEach((pre) => {
        if (pre.closest(".dsx-root")) return;
        const wrapper = getWrapper(pre);
        const lang = getLanguage(pre, wrapper);
        const code = getCode(pre);
        if (!code.trim()) return;

        if (isTree(code)) {
          const t = parseTree(code);
          treeFiles.push(...t.files);
          treeDirs.push(...t.dirs);
          blocks.push({ kind: "tree", lang, code, responseIndex, path: "project-structure.txt", source: "tree" });
          return;
        }

        const fromCtx = nameFromContext(wrapper, root);
        const fromLine = nameFromFirstLine(code);
        let path = null;
        let source = "none";
        if (fromCtx && fromLine) {
          path = segments(fromLine) > segments(fromCtx) ? fromLine : fromCtx;
          source = path === fromLine ? "comment" : "text";
        } else if (fromCtx) { path = fromCtx; source = "text"; }
        else if (fromLine) { path = fromLine; source = "comment"; }

        blocks.push({ kind: "code", lang, code, responseIndex, path: path ? cleanPath(path) : null, source });
      });
    });

    // Resolve bare names (e.g. "HomeController.cs") against the project tree.
    for (const b of blocks) {
      if (b.kind !== "code" || !b.path || b.path.includes("/")) continue;
      const matches = treeFiles.filter((f) => f === b.path || f.endsWith("/" + b.path));
      if (matches.length === 1) { b.path = matches[0]; b.source += "+tree"; }
    }

    // Unnamed blocks get a placeholder name.
    for (const b of blocks) {
      if (b.kind === "code" && !b.path) {
        snippet++;
        const ext = LANG_EXT[b.lang] || "txt";
        b.path = ext === "Dockerfile" ? `snippets/Dockerfile-${snippet}` : `snippets/snippet-${snippet}.${ext}`;
      }
      b.lines = b.code.split("\n").length;
      // Default selection: named files yes; tree diagrams, unnamed shell commands and tiny snippets no.
      b.selected =
        b.kind === "code" &&
        !(b.source === "none" && (SHELL_LANGS.has(b.lang) || b.lines <= 3));
    }

    return { files: blocks, treeFiles: [...new Set(treeFiles)], treeDirs: [...new Set(treeDirs)] };
  }

  return { scan, listResponses, cleanPath, isFilePath, parseTree, nameFromFirstLine, SELECTORS };
})();

if (typeof module !== "undefined") module.exports = DSParser;
