# DeepSeek Code Exporter (Chrome extension)

Main features:
- **Export:** turns the code blocks in DeepSeek chat responses into real files and folders, and downloads them as a ZIP.
- **Upload:** takes a project ZIP and turns it into one text prompt, with each file starting with a comment that shows its relative path.
- **📚 Book tools:** turn DeepSeek answers into a **PDF book**, or upload a **book (PDF, scans, photos, text)**. The text is extracted (with OCR for images), split into parts, and each part is sent to DeepSeek to summarize it, solve its exercises, explain it, or follow your own instruction. See [REQUIREMENTS-BOOKS.md](REQUIREMENTS-BOOKS.md).

## Install
1. Unzip this folder somewhere permanent.
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `deepseek-code-exporter` folder.
4. Open (or reload) https://chat.deepseek.com.

## Use
- **End of each answer:** every response that contains code gets a bar at the bottom:
  - **📦 Download code as ZIP**: downloads that response's files right away.
  - **Review files…**: opens a panel where you can tick/untick files, rename paths, and preview code.
- **Floating 📦 button** (bottom right): review and export the code from the **whole chat**.
- **Toolbar icon:** download the whole chat, just the last response, or open the review panel.

## Upload ZIP → text prompt
Click the green **📤** button on the page (or **Upload ZIP → text prompt…** in the toolbar popup), then drop or choose a `.zip`.

- Every text file becomes a section that starts with its relative path in that language's comment style:
  `// File: Controllers/HomeController.cs`, `# File: app.py`, `<!-- File: index.html -->`, `@* File: Views/Home/Index.cshtml *@`, `-- File: seed.sql`, `/* File: site.css */`.
- If the whole ZIP sits in one top folder (e.g. `MyShop/...`), that folder is removed so paths are relative to the project root.
- Images, binaries, `bin/`, `obj/`, `node_modules/`, `.git/`, `.vs/`, lock files, `*.min.js` and files over 150 KB are skipped or left unticked by default. You can tick any text file back in.
- Options: an instruction at the top, wrapping each file in a code fence (on by default), and a file list at the top.
- Shows the character count and a rough token estimate.
- **Insert into chat** puts the prompt in DeepSeek's message box (you still press send). **Copy** and **Save .txt** are also there.
- It round-trips: when DeepSeek answers with the same `// File: path` comments, the Export side puts each file back in the right folder.

## 📚 Book tools
Click the orange **📚** button on the page (or **📚 Book tools…** in the toolbar popup).

**Read a book**
1. Drop a PDF, page photos or scans (PNG/JPG/WEBP…), or .txt/.md files. Images are ordered by file name (`page2` comes before `page10`). Optionally set a page range (`1-20, 35`) and the OCR language.
2. **Extract text.** PDF pages with a text layer are read directly. Scanned pages and images are OCR'd locally with Tesseract (English is built in; other languages download their data once). Check and edit each page's text. Low-confidence OCR pages are marked.
3. Choose the part size (default 12,000 characters) and the task: **Summarize**, **Solve exercises / questions**, **Study notes**, **Q&A**, **Translate**, or **Custom**. Prompts are editable and use `{title} {part} {total} {pages} {text}`. You can add a final "combine everything" prompt.
4. **Start auto-run:** each part is put in the chat, sent, and the extension waits until the answer stops changing, then moves on. It retries if DeepSeek is busy. You can **Pause** (for example to open a New chat when the conversation gets too long) and **Start** again to resume. **Insert next part (manual)** plus **Capture last answer** lets you send each part yourself. Progress is saved, so a reload keeps finished answers.
5. **Results** tab: read the answers and save them as a **PDF book** (Chrome's print dialog → *Save as PDF*), **.html** or **.md**.

**Chat → PDF book:** load this chat's answers, tick, rename and reorder chapters, then save as a PDF with a cover, contents, page numbers, code blocks, tables and math (printed via MathML).

Keep the DeepSeek tab visible while auto-run works, because Chrome slows timers in background tabs. Use ▁ to shrink the panel to a progress pill.

## How file names are found (in priority order)
1. Text right before the code block: `### Controllers/HomeController.cs`, `**File: src/app.js**`, `` `Program.cs` ``.
2. A comment on the first line: `// File: src/app.js`, `# utils/helpers.py`, `<!-- Views/Home/Index.cshtml -->`.
3. A project tree (`├──`/`└──`) anywhere in the scanned answers: bare names like `Product.cs` get resolved to `Models/Product.cs`, and the tree's folders are created in the ZIP (even empty ones).
4. Otherwise the block becomes `snippets/snippet-N.<ext>` based on its language.

If the same path appears more than once (DeepSeek re-sending an updated file), the **latest version wins**. Untick that option in the panel to keep all versions as `name (2).ext`.

Unnamed shell commands, very short snippets, and tree diagrams are left **unticked** by default.

## Tip for best results
Ask DeepSeek for something like: *"Before each code block, write the full file path as a heading, e.g. `### src/Controllers/HomeController.cs`."*

## If DeepSeek changes its page
All page selectors live in `SELECTORS` at the top of `parser.js` (`.ds-markdown` = an answer, `.md-code-block` = a code block wrapper). Update them there and reload the extension.

## Files
| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3 config, runs only on chat.deepseek.com |
| `parser.js` | Finds code blocks, detects paths, parses project trees |
| `zip.js` | Small built-in ZIP writer and reader (uses Chrome's built-in decompression, no libraries) |
| `prompt.js` | Builds the text prompt from an uploaded ZIP |
| `content.js` | Bar under each answer, floating buttons, review and upload panels |
| `popup.html/js` | Toolbar popup |
| `styles.css` | Styles for the injected buttons |
| `book/book.html, book.js, book.css` | Book tools panel (an extension page shown in an iframe on DeepSeek, connected through a private MessageChannel) |
| `book/extract.js` | PDF text layer (pdf.js), OCR (Tesseract.js), text files, page ranges |
| `book/chunker.js` | Splits pages into parts, task prompt templates |
| `book/bookexport.js` | HTML sanitizer, book layout, PDF/HTML/Markdown export |
| `lib/` | Bundled pdf.js 5.4 and Tesseract.js 6 with English data (no remote code) |

No data leaves your browser: ZIPs, PDFs and images are processed locally. Text only goes to DeepSeek when you press send or start auto-run. The one network request the extension makes itself is downloading OCR language data for a language other than English, from jsDelivr.
