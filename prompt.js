// Turns files from an uploaded ZIP into a single text prompt.
// Every file starts with a comment holding its relative path, e.g. "// File: src/app.js".
const DSPrompt = (() => {
  const COMMENT = {
    line_slash: ["js", "jsx", "ts", "tsx", "mjs", "cjs", "cs", "java", "kt", "kts", "swift", "dart", "go", "rs", "c", "h", "cpp", "hpp", "cc", "php", "scss", "less", "json", "jsonc", "gradle", "groovy", "scala", "proto", "fs", ],
    hash: ["py", "rb", "sh", "bash", "zsh", "ps1", "psm1", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "r", "pl", "dockerfile", "makefile", "gitignore", "dockerignore", "editorconfig", "properties", "txt", "csv", "requirements"],
    html: ["html", "htm", "xml", "xaml", "csproj", "vbproj", "props", "targets", "config", "resx", "svg", "md", "markdown", "vue", "svelte", "aspx", "ascx", "master", "plist"],
    css: ["css"],
    sql: ["sql", "lua", "hs"],
    razor: ["cshtml", "razor"],
    vb: ["vb", "vbs", "bas"],
    bat: ["bat", "cmd"],
  };
  const STYLE_BY_EXT = {};
  for (const [style, exts] of Object.entries(COMMENT)) exts.forEach((e) => (STYLE_BY_EXT[e] = style));

  const LANG_BY_EXT = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
    cs: "csharp", java: "java", kt: "kotlin", swift: "swift", dart: "dart", go: "go", rs: "rust",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", php: "php", py: "python", rb: "ruby",
    sh: "bash", bash: "bash", ps1: "powershell", yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini",
    html: "html", htm: "html", xml: "xml", xaml: "xml", csproj: "xml", config: "xml", svg: "xml",
    css: "css", scss: "scss", less: "less", json: "json", sql: "sql", md: "markdown",
    cshtml: "cshtml", razor: "razor", vue: "vue", svelte: "svelte", vb: "vbnet", bat: "bat",
    dockerfile: "dockerfile", graphql: "graphql", txt: "text",
  };

  const BINARY_EXT = new Set(("png jpg jpeg gif bmp ico webp tiff psd ai pdf doc docx xls xlsx ppt pptx " +
    "zip rar 7z gz tar tgz bz2 exe dll pdb so dylib bin obj o a lib class jar war apk aab ipa " +
    "mp3 mp4 wav ogg webm mov avi mkv flac woff woff2 ttf otf eot db sqlite mdf ldf bak cache suo nupkg snk pfx").split(" "));
  const SKIP_DIR_RE = /(^|\/)(node_modules|bin|obj|\.git|\.vs|\.vscode|\.idea|dist|build|out|packages|__pycache__|\.venv|venv|env|\.next|\.nuxt|coverage|\.gradle|Pods|wwwroot\/lib)(\/|$)/i;
  const SKIP_FILE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.(js|css)|.*\.map|\.DS_Store|Thumbs\.db)$/i;
  const MAX_DEFAULT_BYTES = 150 * 1024;

  function extOf(path) {
    const name = path.split("/").pop().toLowerCase();
    if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
    if (name === "makefile") return "makefile";
    if (name.startsWith(".env")) return "env";
    if (name === ".gitignore") return "gitignore";
    if (name === "requirements.txt") return "requirements";
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(i + 1) : i === 0 ? name.slice(1) : "";
  }

  function pathComment(path) {
    const label = `File: ${path}`;
    switch (STYLE_BY_EXT[extOf(path)] || "line_slash") {
      case "hash": return `# ${label}`;
      case "html": return `<!-- ${label} -->`;
      case "css": return `/* ${label} */`;
      case "sql": return `-- ${label}`;
      case "razor": return `@* ${label} *@`;
      case "vb": return `' ${label}`;
      case "bat": return `REM ${label}`;
      default: return `// ${label}`;
    }
  }

  function decodeText(bytes) {
    if (!bytes) return null;
    const head = bytes.subarray(0, 8000);
    if (head.includes(0)) return null; // binary
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "").replace(/\r\n/g, "\n");
    } catch {
      return null;
    }
  }

  /** Converts raw ZIP entries into prompt candidates. */
  function prepare(entries) {
    const files = entries.filter((e) => !e.dir && !/(^|\/)__MACOSX\//.test(e.path));
    // Common single top folder ("MyShop/...") — stripped by default.
    const tops = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
    const root = tops.size === 1 && !tops.has("") ? [...tops][0] : "";

    const items = files.map((f) => {
      const rel = root ? f.path.slice(root.length + 1) : f.path;
      const ext = extOf(f.path);
      const item = { fullPath: f.path, path: rel, ext, size: f.bytes ? f.bytes.length : 0, text: null, reason: "", selected: false };
      if (f.error) item.reason = f.error;
      else if (BINARY_EXT.has(ext)) item.reason = "binary";
      else {
        item.text = decodeText(f.bytes);
        if (item.text === null) item.reason = "binary";
      }
      if (item.text !== null) {
        if (SKIP_DIR_RE.test(f.path)) item.reason = "build/dependency folder";
        else if (SKIP_FILE_RE.test(f.path)) item.reason = "generated/lock file";
        else if (item.size > MAX_DEFAULT_BYTES) item.reason = "large file";
        else if (!item.text.trim()) item.reason = "empty";
        item.selected = !item.reason;
      }
      return item;
    }).sort((a, b) => a.path.localeCompare(b.path));
    return { items, root };
  }

  function fenceFor(text) {
    const runs = text.match(/`{3,}/g) || [];
    const longest = runs.reduce((m, r) => Math.max(m, r.length), 2);
    return "`".repeat(longest + 1);
  }

  /**
   * @param {{path:string, text:string, ext:string}[]} files
   * @param {{instruction?:string, fences?:boolean, tree?:boolean, root?:string}} opts
   */
  function build(files, opts = {}) {
    const parts = [];
    if (opts.instruction && opts.instruction.trim()) parts.push(opts.instruction.trim(), "");
    parts.push(`Below are ${files.length} file(s) of my project${opts.root ? ` "${opts.root}"` : ""}. Each file starts with a comment that shows its relative path.`);
    if (opts.tree) parts.push("", "Project files:", ...files.map((f) => `- ${f.path}`));
    for (const f of files) {
      const body = `${pathComment(f.path)}\n${f.text.replace(/\n+$/, "")}`;
      parts.push("");
      if (opts.fences !== false) {
        const fence = fenceFor(f.text);
        parts.push(`${fence}${LANG_BY_EXT[f.ext] || ""}`, body, fence);
      } else {
        parts.push(body);
      }
    }
    return parts.join("\n") + "\n";
  }

  return { prepare, build, pathComment, extOf };
})();

if (typeof module !== "undefined") module.exports = DSPrompt;
