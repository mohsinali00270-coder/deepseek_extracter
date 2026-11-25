# Requirements: Book tools (PDF books + reading books in chunks)

Version 2.0 of DeepSeek Code Exporter adds a **📚 Book tools** panel next to the existing code-export and ZIP-upload features.
It does two jobs:

1. **Make a PDF book** from DeepSeek's answers.
2. **Read a book in chunks.** You upload a PDF, scanned pages, photos or text. The extension pulls the text out, using OCR for images, splits it into parts and sends each part to DeepSeek with a task (summarize, solve the exercises, explain, or your own instruction). It then collects every answer into one result that you can also save as a PDF book.

---

## 1. Goals and limits

| # | Requirement |
|---|---|
| G1 | Everything runs in the browser. Files are never uploaded to any server other than DeepSeek, and only as the text you choose to send. |
| G2 | No remote code. pdf.js and Tesseract.js (OCR) ship inside the extension (`lib/`), as Manifest V3 requires. |
| G3 | Works offline for English OCR, because the English language data is bundled. Other OCR languages download their language data (data only, not code) from the jsDelivr CDN the first time they are used, then come from the cache. |
| G4 | Nothing is sent to DeepSeek without the user acting. Auto-run starts only when the user presses **Start**, and it can be paused or stopped at any time. |
| G5 | Changes to DeepSeek's page should only break selectors, never the extension. All DeepSeek DOM access stays in `content.js` / `parser.js`. |

## 2. Inputs (what counts as a "book")

| # | Input | How text is obtained |
|---|---|---|
| I1 | **PDF with a text layer** (normal e-book or exported document) | pdf.js `getTextContent()`, rebuilt into lines and paragraphs per page |
| I2 | **Scanned PDF** (pages are pictures) | Each page is rendered to a canvas at about 2× scale, then OCR'd with Tesseract |
| I3 | **Mixed PDF** | Per page: use the text layer if it has at least 40 meaningful characters, otherwise OCR the page. A **Force OCR on every page** option is available. |
| I4 | **Images**: PNG, JPG, WEBP, BMP, GIF (one photo of a page, or many) | OCR. Several images are treated as pages, in natural file-name order (`page2` comes before `page10`). |
| I5 | **Plain text / Markdown** (`.txt`, `.md`) | Read directly and split into virtual "pages" of about 3,000 characters |
| I6 | **Multiple files at once** | Joined in the order they were picked, and each page is labelled with its source file |
| I7 | **Page range** | The user can limit processing to pages, e.g. `1-20, 35, 40-45` |
| I8 | **OCR language** | Choose eng (bundled), urd, ara, hin, fra, deu, spa, chi_sim and others, or combine them like `eng+urd` |

Extracted text is shown per page with its source (text layer / OCR and its confidence). The user can **edit it** before chunking, for example to fix OCR mistakes or delete an index page.

## 3. Chunking

| # | Requirement |
|---|---|
| C1 | Chunks are built from whole pages, up to a **max characters per part** limit (default 12,000, about 3.5k tokens, adjustable from 2,000 to 60,000). |
| C2 | A page larger than the limit is split on paragraph, then sentence, then hard boundaries. |
| C3 | Each chunk remembers its page range (`pp. 12–18`) and its part number (`3 / 17`). |
| C4 | The panel shows the number of parts, the characters and an estimated token count before anything is sent. |
| C5 | **Overlap** option (default 0): repeat the last N characters of the previous part at the start of the next part, so a question split across pages keeps its context. |

## 4. Tasks (what DeepSeek is asked to do)

Built-in prompt templates. Each one can be edited, and the edited version is saved for next time. Placeholders: `{title} {part} {total} {pages} {text}`.

| Task | Per-part prompt | Final step (optional) |
|---|---|---|
| **Summarize** | Chapter-style summary: key ideas, definitions, important formulas | "Combine the partial summaries into one book summary" |
| **Solve exercises / questions** | Find every exercise, question or problem in this part and solve each one step by step. Keep the original numbering and copy the question before its answer. If there are none, say so in one line. | none |
| **Explain / study notes** | Plain-language explanation, examples, a glossary of terms | "Make a one-page revision sheet" |
| **Q&A / flashcards** | Write questions and answers that test this part | none |
| **Translate** | Translate this part into the target language | none |
| **Custom** | The user's own instruction, which can use the placeholders | none |

The final combining step sends the collected answers. If they exceed the part limit, they are trimmed, and the user is warned.

## 5. Sending to DeepSeek (the runner)

| # | Requirement |
|---|---|
| R1 | **Manual mode:** "Insert part N" puts the prompt in the chat box, and the user presses send. |
| R2 | **Auto mode:** for each part, insert the prompt, submit it, wait until DeepSeek has finished answering, then save the answer's text and HTML. |
| R3 | "Finished" means a new answer has appeared **and** the chat's text has not changed for a settle time (default 5 s), with an overall timeout per part (default 10 min). This also covers DeepThink, where the reasoning streams first. |
| R4 | A delay between parts (default 3 s) keeps the rate low. |
| R5 | **Retry:** if an answer looks like "server is busy" or is empty, wait and retry up to 2 times. |
| R6 | **Pause / Resume / Stop.** The user can pause, open a **new chat** in DeepSeek (because of context-length limits), and resume from the next part. The job keeps running across DeepSeek's in-page navigation. |
| R7 | **Progress** shows the current part, its status (queued, sending, waiting, done, failed) and the time elapsed. The panel can be minimised to a small progress pill so the user can watch DeepSeek answer. |
| R8 | **Persistence:** the job (chunks, settings, answers) is saved in `chrome.storage.local`, so reloading the tab does not lose finished answers. "Clear job" deletes it. |
| R9 | Any answer can be re-run on its own. |

## 6. PDF book output

| # | Requirement |
|---|---|
| P1 | **Book from this chat:** each DeepSeek answer becomes a chapter. The user picks which answers to include, can rename chapter titles (the default is the answer's first heading or first line) and can reorder them. |
| P2 | **Book from a processed job:** one chapter per part ("Part 3 — pp. 12–18"), plus the final combined answer first if there is one. It can optionally include the original extracted text under each answer. |
| P3 | Book layout: cover page (title, subtitle/author, date), table of contents, chapters that each start on a new page, page numbers in the footer, A4 or Letter, and an adjustable base font size. |
| P4 | Keep DeepSeek's formatting: headings, lists, tables, bold and italics, code blocks (monospace, wrapped, no page overflow), and math (KaTeX output is shown through its MathML so formulas print correctly). |
| P5 | Copy buttons, "Download ZIP" bars, scripts and event handlers are removed from the HTML before it goes into the book. |
| P6 | **Save as PDF** opens Chrome's print dialog with the book ready (choose "Save as PDF"). This keeps selectable text, Unicode (Urdu, Arabic, Chinese) and vector text, with no font embedding problems. |
| P7 | Other exports: **Download .html** (a standalone book file) and **Download .md** (plain text answers with headings). |

## 7. User interface

* A new floating **📚** button on chat.deepseek.com, plus **📚 Book tools…** in the toolbar popup.
* A panel with three tabs:
  1. **Chat → PDF book**
  2. **Read a book** (upload → extract → chunk → task → run)
  3. **Results** (answers per part, re-run, export)
* The panel is an extension page shown in an iframe on DeepSeek. It needs its own origin so pdf.js and Tesseract can run their workers and WebAssembly. It talks to the content script over a private `MessageChannel`.
* It follows the light/dark colour scheme, and the existing panels stay unchanged.

## 8. Permissions and packaging

* `storage` and `unlimitedStorage` for saved jobs and the OCR data cache.
* `web_accessible_resources`: `book.html` and its scripts and libraries, only for `https://chat.deepseek.com/*`.
* `content_security_policy.extension_pages`: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` (WebAssembly for OCR).
* Bundled size is about 12.5 MB: pdf.js 1.5 MB, the Tesseract core 8 MB and English data 3 MB.

## 9. Not in scope (possible later)

* Uploading the original PDF or images straight into DeepSeek's own attachment button
* Starting a new DeepSeek chat automatically every N parts (pause/resume covers this for now)
* EPUB / DOCX input
* Writing PDFs directly without the print dialog

## 10. Acceptance checks

1. A 300-page text PDF splits into parts within 10 s, with correct page ranges.
2. A 10-page scanned PDF, or 10 phone photos, is OCR'd with confidence shown per page, and the text can be edited.
3. In auto mode, "Solve exercises" sends every part, waits for each answer, and survives a pause, new chat and resume.
4. A book from the chat with code and math prints to PDF with a TOC, page numbers and no clipped code.
5. Reloading DeepSeek mid-job keeps the finished answers, and the job resumes from the first unfinished part.
