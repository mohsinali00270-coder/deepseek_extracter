// Splits extracted pages into prompt-sized parts and fills the task templates.

export const TASKS = {
  summarize: {
    label: "Summarize",
    prompt:
`You are helping me study the book "{title}". I am sending it in {total} parts. This is part {part} of {total} (pages {pages}).

Write a clear chapter-style summary of this part:
- a short overview (2–4 sentences)
- the key ideas as headed sections with bullet points
- important definitions, formulas and examples (keep formulas exact, use LaTeX)
Do not invent content that is not in the text.

TEXT:
{text}`,
    final:
`Below are the summaries of all {total} parts of the book "{title}". Combine them into one well-organised summary of the whole book: an overview, then one section per major topic in order, then a list of the most important takeaways.

{answers}`,
  },
  exercises: {
    label: "Solve exercises / questions",
    prompt:
`This is part {part} of {total} (pages {pages}) of the book "{title}".

Find EVERY exercise, question, problem or activity in the text below and solve each one.
For each one:
1. Keep its original number/label and copy the question first (as a heading, e.g. "### Exercise 2.3").
2. Give a complete step-by-step solution, showing working (use LaTeX for maths, code blocks for code).
3. End with the final answer in bold.
If a question depends on a figure or data that is missing from the text, say what is missing and solve as far as possible.
If this part contains no exercises or questions, reply with one line: "No exercises in pages {pages}."

TEXT:
{text}`,
    final: "",
  },
  notes: {
    label: "Explain / study notes",
    prompt:
`This is part {part} of {total} (pages {pages}) of the book "{title}".

Turn this part into study notes for a student:
- explain every concept in plain language, with a simple example
- show any formulas or procedures step by step
- finish with a short glossary of the terms introduced here

TEXT:
{text}`,
    final:
`Below are my study notes for all parts of "{title}". Turn them into a one-page revision sheet: the most important concepts, formulas and facts, grouped by topic.

{answers}`,
  },
  qa: {
    label: "Q&A / flashcards",
    prompt:
`This is part {part} of {total} (pages {pages}) of the book "{title}".

Write 8–15 questions that test understanding of this part, from easy to hard, each followed by its answer. Format each as:
**Q:** …
**A:** …

TEXT:
{text}`,
    final: "",
  },
  translate: {
    label: "Translate",
    prompt:
`Translate the following text (part {part} of {total}, pages {pages}, of "{title}") into {language}. Keep the structure, headings, numbering and formulas. Output only the translation.

TEXT:
{text}`,
    final: "",
  },
  custom: {
    label: "Custom instruction",
    prompt:
`Part {part} of {total} (pages {pages}) of "{title}".

<your instruction here>

TEXT:
{text}`,
    final: "",
  },
};

export function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export const estimateTokens = (chars) => Math.round(chars / 3.5);

function pageRangeLabel(a, b) {
  return a === b ? String(a) : `${a}–${b}`;
}

/** Splits text that is longer than max on paragraph → sentence → hard boundaries. */
function splitLong(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  const units = text.split(/(\n{2,})/).flatMap((p) => (p.length > max ? p.split(/(?<=[.!?。؟])\s+/) : [p]));
  for (let u of units) {
    while (u.length > max) { push(); out.push(u.slice(0, max)); u = u.slice(max); }
    if (cur.length + u.length > max) push();
    cur += u;
  }
  push();
  return out;
}

/**
 * @param {{n:number, text:string}[]} pages
 * @param {{maxChars:number, overlap:number, markers:boolean}} opts
 * @returns {{part:number, first:number, last:number, pages:string, text:string}[]}
 */
export function buildChunks(pages, opts) {
  const max = Math.max(1000, opts.maxChars || 12000);
  const overlap = Math.max(0, Math.min(opts.overlap || 0, Math.floor(max / 3)));
  const pieces = [];
  for (const p of pages) {
    const body = (p.text || "").trim();
    if (!body) continue;
    const parts = splitLong(body, max - 40);
    parts.forEach((t, i) => {
      const head = opts.markers ? `--- Page ${p.n}${parts.length > 1 ? ` (${i + 1}/${parts.length})` : ""} ---\n` : "";
      pieces.push({ n: p.n, text: head + t });
    });
  }

  const chunks = [];
  let cur = null;
  const flush = () => { if (cur) chunks.push(cur); cur = null; };
  for (const pc of pieces) {
    if (cur && cur.text.length + pc.text.length + 2 > max) flush();
    if (!cur) cur = { first: pc.n, last: pc.n, text: "" };
    cur.text += (cur.text ? "\n\n" : "") + pc.text;
    cur.last = pc.n;
  }
  flush();

  return chunks.map((c, i) => {
    let text = c.text;
    if (overlap && i > 0) {
      const prev = chunks[i - 1].text;
      text = `[…end of previous part, for context…]\n${prev.slice(-overlap)}\n[…new part starts here…]\n\n${text}`;
    }
    return { part: i + 1, first: c.first, last: c.last, pages: pageRangeLabel(c.first, c.last), text };
  });
}
