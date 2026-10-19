/**
 * Prompt templates: drafts saved with /template and inserted again from the slash menu. Each
 * `{{name}}` in one is a field to fill in, and Tab or Shift+Tab selects the next or previous field.
 * A local preference of this window, kept in localStorage like the sidebar pins: a template is
 * never sent anywhere until it is inserted and the message is sent as usual.
 */
const STORAGE_KEY = 'chat-on-steroids.prompt-templates';
const MAX_TEMPLATES = 50;
export const MAX_TEMPLATE_CHARS = 10_000;
const MAX_NAME_CHARS = 60;
/** The most stored JSON that is read back, and so the most that is written. */
const MAX_STORED_CHARS = 1_000_000;

export type PromptTemplate = { name: string; text: string };
export type TemplateField = { start: number; end: number; name: string };

/** `{{name}}`, `{{ name }}`: one line, no braces inside, the name 60 characters at most. */
const FIELD = /\{\{[ \t]*([^{}\s][^{}\r\n]{0,59}?)[ \t]*\}\}/g;

/**
 * The inline code spans of one paragraph, as [start, end) offsets. As in CommonMark, a backtick
 * run opens a span only when a later run of the same length closes it, so ``a ` b`` is one span
 * and a run with no partner is literal text. A backslash escapes only an opening backtick (an odd
 * number of them before it); inside a span it is literal, so `a\` closes. Each run is looked at once.
 */
function codeSpans(text: string): Array<[number, number]> {
  const runs = [...text.matchAll(/`+/g)].map(match => {
    let slashes = 0;
    while (text[match.index - 1 - slashes] === '\\') slashes++;
    return { at: match.index, length: match[0].length, escaped: slashes % 2 === 1 };
  });
  const byLength = new Map<number, number[]>();
  runs.forEach((run, index) => { const same = byLength.get(run.length); if (same) same.push(index); else byLength.set(run.length, [index]); });
  const next = new Map<number, number>();
  const spans: Array<[number, number]> = [];
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    // An escaped first backtick is a character; the rest of its run may still open a span.
    const at = run.escaped ? run.at + 1 : run.at, length = run.escaped ? run.length - 1 : run.length;
    const same = byLength.get(length);
    if (!length || !same) continue;
    let partner = next.get(length) ?? 0;
    while (partner < same.length && same[partner]! <= index) partner++;
    next.set(length, partner);
    if (partner === same.length) continue;
    const close = runs[same[partner]!]!;
    spans.push([at, close.at + close.length]);
    index = same[partner]!;
  }
  return spans;
}

/**
 * The fields of a draft, in order. Braces in code are code the user is writing (a Jinja or
 * Handlebars snippet), so a field inside a fenced block or an inline code span is not one. A fence
 * closes only on the same character, at least as long and with nothing after it, and a code span
 * never runs past a blank line, as in Markdown. Linear, however many braces were pasted.
 */
export function templateFields(text: string): TemplateField[] {
  // The paragraphs outside fences, as [start, end) offsets.
  const paragraphs: Array<[number, number]> = [];
  let fence = '', offset = 0, from = 0;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker && !fence) { paragraphs.push([from, offset]); fence = marker[1]!; }
    else if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) { fence = ''; from = offset + line.length + 1; }
    else if (!fence && !line.trim()) { paragraphs.push([from, offset]); from = offset + line.length + 1; }
    offset += line.length + 1;
  }
  if (!fence) paragraphs.push([from, text.length]);
  const fields: TemplateField[] = [];
  for (const [start, end] of paragraphs) {
    const paragraph = text.slice(start, end), spans = codeSpans(paragraph);
    let span = 0;
    for (const match of paragraph.matchAll(FIELD)) {
      while (span < spans.length && spans[span]![1] <= match.index) span++;
      if (span < spans.length && spans[span]![0] <= match.index) continue;
      fields.push({ start: start + match.index, end: start + match.index + match[0].length, name: match[1]!.trim() });
    }
  }
  return fields;
}

/**
 * The field Tab selects from this selection: the first one after it, or with Shift the last one
 * before it. Past the last field there is none, so Tab leaves the composer as it always did.
 */
export function nextTemplateField(text: string, start: number, end: number, backwards = false): TemplateField | null {
  const fields = templateFields(text);
  return (backwards ? fields.filter(field => field.end <= start).at(-1) : fields.find(field => field.start >= end)) ?? null;
}

/** A template is named after its first line, which the slash menu shows and filters by. */
export function templateName(text: string): string {
  const line = text.split('\n').map(row => row.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  return line.length > MAX_NAME_CHARS ? `${line.slice(0, MAX_NAME_CHARS - 1).trimEnd()}…` : line;
}

export function createPromptTemplates() {
  let templates: PromptTemplate[] = [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const saved: unknown = raw && raw.length <= MAX_STORED_CHARS ? JSON.parse(raw) : [];
    if (Array.isArray(saved)) {
      templates = saved.filter((row): row is PromptTemplate => !!row && typeof row.name === 'string' && typeof row.text === 'string' &&
        !!row.name && row.name.length <= MAX_NAME_CHARS && !!row.text.trim() && row.text.length <= MAX_TEMPLATE_CHARS).slice(0, MAX_TEMPLATES);
    }
  } catch { /* Unavailable or corrupt storage must not stop the composer. */ }

  /** Whether the templates reached storage; when it is full or blocked they last only in this window. */
  function store(): boolean {
    // What is written must load again: escaped quotes or control characters can make 50 templates
    // longer than the stored bound, so the oldest give way until the list fits it.
    const sizes = templates.map(row => JSON.stringify(row).length + 1);
    let total = sizes.reduce((sum, size) => sum + size, 1);
    while (templates.length > 1 && total > MAX_STORED_CHARS) {
      total -= sizes[templates.length - 1]!;
      templates = templates.slice(0, -1);
    }
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(templates)); return true; }
    catch { return false; }
  }

  return {
    /** The newest first. */
    list: (): readonly PromptTemplate[] => templates,
    /** Saves a draft under its first line, replacing a template of the same name. */
    save(text: string): { saved: PromptTemplate; stored: boolean } | { error: 'empty' | 'long' } {
      const body = text.replace(/^\s*\n/, '').trimEnd();
      if (!body.trim()) return { error: 'empty' };
      if (body.length > MAX_TEMPLATE_CHARS) return { error: 'long' };
      const saved = { name: templateName(body), text: body };
      // The oldest template gives way at the bound; a save is never refused for it.
      templates = [saved, ...templates.filter(row => row.name !== saved.name)].slice(0, MAX_TEMPLATES);
      return { saved, stored: store() };
    },
    /** Removes a template and says whether storage has the change. */
    remove(name: string): boolean {
      templates = templates.filter(row => row.name !== name);
      return store();
    }
  };
}
