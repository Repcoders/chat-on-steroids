import { diff } from '@codemirror/merge';

export interface WordPiece { kind: 'same' | 'removed' | 'added'; text: string }

/**
 * A word, a run of whitespace, or one other character. Chinese and Japanese are written without
 * spaces, so each of their characters is a word of its own; otherwise a changed character would
 * mark the whole sentence around it.
 */
const TOKEN = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]|(?:(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])[\p{L}\p{M}\p{N}_])+|\s+|[^]/gu;
/** Distinct tokens one diff can tell apart: one UTF-16 code unit each, surrogates left out. */
const DISTINCT = 0x10000 - 0x800;

/**
 * Two texts compared word by word: `before` as pieces kept or removed, `after` as pieces kept or
 * added. Each distinct token becomes one character, so the character diff is a word diff. Spaces
 * between two changes on one line count as changed too, so a reworded phrase reads as one change.
 */
export function wordDiff(before: string, after: string): { before: WordPiece[]; after: WordPiece[] } {
  const a = before.match(TOKEN) ?? [], b = after.match(TOKEN) ?? [];
  const codes = new Map<string, string>();
  const encode = (tokens: string[]): string | null => {
    let out = '';
    for (const token of tokens) {
      let code = codes.get(token);
      if (code === undefined) {
        if (codes.size >= DISTINCT) return null;
        const n = codes.size;
        code = String.fromCharCode(n < 0xd800 ? n : n + 0x800);
        codes.set(token, code);
      }
      out += code;
    }
    return out;
  };
  const left = encode(a), right = encode(b);
  if (left === null || right === null) return { before: pieces([[a, 'removed']]), after: pieces([[b, 'added']]) };
  const changes: Array<{ fromA: number; toA: number; fromB: number; toB: number }> = [];
  for (const change of diff(left, right, { scanLimit: 2000, timeout: 100 })) {
    const last = changes.at(-1);
    if (last && a.slice(last.toA, change.fromA).every(token => /^[^\S\n]+$/.test(token))) {
      last.toA = change.toA; last.toB = change.toB;
    } else changes.push({ fromA: change.fromA, toA: change.toA, fromB: change.fromB, toB: change.toB });
  }
  const sideA: Array<[string[], WordPiece['kind']]> = [], sideB: Array<[string[], WordPiece['kind']]> = [];
  let atA = 0, atB = 0;
  for (const change of changes) {
    sideA.push([a.slice(atA, change.fromA), 'same'], [a.slice(change.fromA, change.toA), 'removed']);
    sideB.push([b.slice(atB, change.fromB), 'same'], [b.slice(change.fromB, change.toB), 'added']);
    atA = change.toA; atB = change.toB;
  }
  sideA.push([a.slice(atA), 'same']); sideB.push([b.slice(atB), 'same']);
  return { before: pieces(sideA), after: pieces(sideB) };
}

function pieces(runs: Array<[string[], WordPiece['kind']]>): WordPiece[] {
  const out: WordPiece[] = [];
  const add = (kind: WordPiece['kind'], text: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (last?.kind === kind) last.text += text; else out.push({ kind, text });
  };
  for (const [tokens, kind] of runs) {
    // A change starts and ends on a word; spaces around it are marked as kept.
    const [, lead = '', core = '', trail = ''] = /^(\s*)([^]*?)(\s*)$/.exec(tokens.join('')) ?? [];
    if (kind === 'same' || !core) { add('same', lead + core + trail); continue; }
    add('same', lead); add(kind, core); add('same', trail);
  }
  return out;
}
