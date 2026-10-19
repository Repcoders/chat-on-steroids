/**
 * Speech-to-text events from the opt-in Windows recognizer. Raw audio never crosses IPC.
 * `engine` on listening says which Windows recognizer runs: `modern` is Windows' online
 * dictation (punctuation, current accuracy), `legacy` the offline System.Speech fallback.
 */
export type DictationEngine = 'modern' | 'legacy';
export type DictationEvent =
  | { type: 'status'; status: 'starting' | 'listening' | 'stopped'; engine?: DictationEngine }
  | { type: 'partial' | 'final'; text: string }
  | { type: 'error'; message: string };

/** Ignore untrusted child stdout, malformed JSON and implausibly large transcripts. */
export function parseDictationEvent(line: string): DictationEvent | null {
  if (!line || line.length > 16_384) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (event.type === 'status' && ['starting', 'listening', 'stopped'].includes(String(event.status))) {
    const status = event.status as 'starting' | 'listening' | 'stopped';
    return status === 'listening' && (event.engine === 'modern' || event.engine === 'legacy')
      ? { type: 'status', status, engine: event.engine } : { type: 'status', status };
  }
  if ((event.type === 'partial' || event.type === 'final') && typeof event.text === 'string') {
    const text = event.text.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 4_000).trim();
    return text ? { type: event.type, text } : null;
  }
  if (event.type === 'error' && typeof event.message === 'string') {
    const message = event.message.replace(/[\u0000-\u001f]/g, ' ').slice(0, 240).trim();
    return { type: 'error', message: message || 'Speech recognition failed' };
  }
  return null;
}

/** A speech language Windows can dictate in, as `dictation:languages` lists it. */
export type DictationLanguage = { tag: string; name: string };

/** BCP 47 shape only (`en-US`, `zh-Hant-TW`); it is also spliced into the recognizer script. */
export function isDictationLanguageTag(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(value);
}

/**
 * The child's JSON list of speech languages: well-formed tags only, the first
 * of each tag (the modern engine lists first), sorted by name, at most 64.
 */
export function parseDictationLanguages(output: string): DictationLanguage[] {
  let value: unknown;
  try { value = JSON.parse(output.trim()); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const seen = new Map<string, DictationLanguage>();
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const { tag, name } = row as Record<string, unknown>;
    if (!isDictationLanguageTag(tag) || seen.has(tag.toLowerCase())) continue;
    const label = typeof name === 'string' ? name.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80) : '';
    seen.set(tag.toLowerCase(), { tag, name: label || tag });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 64);
}
