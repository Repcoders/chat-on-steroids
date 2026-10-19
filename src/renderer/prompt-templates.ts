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

export type PromptTemplate = { name: string; text: string };
export type TemplateField = { start: number; end: number; name: string };

/** `{{name}}`, `{{ name }}`: one line, no braces inside, the name 60 characters at most. */
const FIELD = /\{\{[ \t]*([^{}\s][^{}\r\n]{0,59}?)[ \t]*\}\}/g;

const ticks = (text: string): number => [...text.matchAll(/(?<!\\)`/g)].length;

/**
 * The fields of a draft, in order. Braces in code are code the user is writing (a Jinja or
 * Handlebars snippet), so a field inside a fenced block or an inline code span is not one; this
 * reads code the way the slash menu does, in one pass however many braces were pasted.
 */
export function templateFields(text: string): TemplateField[] {
  const fields: TemplateField[] = [];
  let fenced = false, open = 0, offset = 0;
  for (const line of text.split('\n')) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) { fenced = !fenced; open = 0; }
    else if (!fenced) {
      let from = 0;
      for (const match of line.matchAll(FIELD)) {
        open += ticks(line.slice(from, match.index)); from = match.index;
        if (open % 2 === 0) fields.push({ start: offset + match.index, end: offset + match.index + match[0].length, name: match[1]!.trim() });
      }
      open += ticks(line.slice(from));
    }
    offset += line.length + 1;
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
    const saved: unknown = raw && raw.length <= 1_000_000 ? JSON.parse(raw) : [];
    if (Array.isArray(saved)) {
      templates = saved.filter((row): row is PromptTemplate => !!row && typeof row.name === 'string' && typeof row.text === 'string' &&
        !!row.name && row.name.length <= MAX_NAME_CHARS && !!row.text.trim() && row.text.length <= MAX_TEMPLATE_CHARS).slice(0, MAX_TEMPLATES);
    }
  } catch { /* Unavailable or corrupt storage must not stop the composer. */ }

  function store(): void {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(templates)); }
    catch { /* Keep the templates in this window when storage is unavailable. */ }
  }

  return {
    /** The newest first. */
    list: (): readonly PromptTemplate[] => templates,
    /** Saves a draft under its first line, replacing a template of the same name. */
    save(text: string): { saved: PromptTemplate } | { error: 'empty' | 'long' } {
      const body = text.replace(/^\s*\n/, '').trimEnd();
      if (!body.trim()) return { error: 'empty' };
      if (body.length > MAX_TEMPLATE_CHARS) return { error: 'long' };
      const saved = { name: templateName(body), text: body };
      // The oldest template gives way at the bound; a save is never refused for it.
      templates = [saved, ...templates.filter(row => row.name !== saved.name)].slice(0, MAX_TEMPLATES);
      store();
      return { saved };
    },
    remove(name: string): void {
      templates = templates.filter(row => row.name !== name);
      store();
    }
  };
}
