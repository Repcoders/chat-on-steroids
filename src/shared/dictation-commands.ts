/**
 * Spoken edits in dictated text, for the optional `ui.dictationCommands`. Windows dictates in its
 * speech language, so each language has its own phrases; a language without a table dictates as
 * plain text. "Send" only counts as a phrase of its own, because it is an ordinary word inside a
 * sentence; the renderer still asks before it sends.
 */
export type DictationCommand = 'newLine' | 'newParagraph' | 'scratch' | 'send';
export type DictationPiece = { text: string } | { command: DictationCommand };

const PHRASES: Record<string, Record<DictationCommand, string[]>> = {
  en: { newLine: ['new line', 'newline'], newParagraph: ['new paragraph'], scratch: ['scratch that'], send: ['send', 'send it'] },
  de: { newLine: ['neue zeile'], newParagraph: ['neuer absatz'], scratch: ['das löschen', 'lösch das', 'lösche das'], send: ['senden', 'abschicken'] },
  es: { newLine: ['nueva línea', 'nueva linea'], newParagraph: ['nuevo párrafo', 'nuevo parrafo'], scratch: ['borra eso', 'borrar eso'], send: ['enviar', 'envía', 'envia'] },
  fr: { newLine: ['nouvelle ligne', 'à la ligne'], newParagraph: ['nouveau paragraphe'], scratch: ['efface ça', 'effacer ça'], send: ['envoyer', 'envoie'] },
  pt: { newLine: ['nova linha'], newParagraph: ['novo parágrafo', 'novo paragrafo'], scratch: ['apaga isso', 'apagar isso'], send: ['enviar', 'envia'] }
};

const EDITS = ['newParagraph', 'newLine', 'scratch'] as const;
const patterns = new Map<string, RegExp>();

const primary = (language: string | undefined): string => language?.toLowerCase().split('-')[0] ?? '';
const phrasesFor = (language: string | undefined) => Object.hasOwn(PHRASES, primary(language)) ? PHRASES[primary(language)] : undefined;

/** Whether spoken commands exist for this BCP 47 speech language. */
export function hasDictationCommands(language: string | undefined): boolean {
  return phrasesFor(language) !== undefined;
}

function editPattern(table: Record<DictationCommand, string[]>): RegExp {
  const phrases = EDITS.flatMap(command => table[command]).sort((a, b) => b.length - a.length)
    .map(phrase => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
  // Whole words only; the punctuation the engine puts after a command belongs to the command.
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${phrases.join('|')})(?![\\p{L}\\p{N}])[.,!?;:…]*`, 'giu');
}

/** Splits a final dictation chunk into dictated text and the commands spoken in it, in order. */
export function dictationPieces(chunk: string, language: string | undefined): DictationPiece[] {
  const text = chunk.normalize('NFC').trim();
  const table = phrasesFor(language);
  if (!table) return text ? [{ text }] : [];
  const bare = text.toLowerCase().replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '').replace(/\s+/g, ' ');
  if (table.send.includes(bare)) return [{ command: 'send' }];
  const pattern = patterns.get(primary(language)) ?? editPattern(table);
  patterns.set(primary(language), pattern);
  const pieces: DictationPiece[] = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(at, match.index).trim();
    if (before) pieces.push({ text: before });
    const said = match[0].toLowerCase().replace(/[.,!?;:…]+$/u, '').replace(/\s+/g, ' ');
    pieces.push({ command: EDITS.find(command => table[command].includes(said))! });
    at = match.index + match[0].length;
  }
  const rest = text.slice(at).trim();
  if (rest) pieces.push({ text: rest });
  return pieces;
}
