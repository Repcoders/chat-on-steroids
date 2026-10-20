import { Lexer, type Token, type Tokens } from 'marked';
import type { SessionSearchLocation } from './session.js';

/*
 * Artifacts: the code blocks, tables and display formulas of ChatGPT's answers, read from the
 * recorded Markdown rather than from the drawn timeline, so a folded round or an answer far above
 * the loaded page counts too. Main lists them for one chat (`sessions:artifacts`); the renderer's
 * Artifacts panel copies them and opens the answer each came from.
 */

export type ArtifactKind = 'code' | 'table' | 'formula';

/** One piece of an answer, as written: a block's code, a table's Markdown, a formula's LaTeX. */
export interface AnswerArtifact {
  kind: ArtifactKind;
  text: string;
  /** A code block's language, as its fence names it. */
  language?: string;
}

/** One artifact of a chat (`sessions:artifacts`), with the answer it is in. */
export interface SessionArtifact extends AnswerArtifact {
  /** The answer's number among the chat's answers, from 1. */
  answer: number;
  /** The question that answer replied to, at most 120 characters; empty before any question. */
  question: string;
  location: SessionSearchLocation;
}

export interface SessionArtifactsReply {
  artifacts: SessionArtifact[];
  /** The chat holds more than the reply carries. */
  limited?: true;
}

/** A display formula opens a line, after any quote or list marker, as ChatGPT writes it (math.ts). */
const DISPLAY_OPEN = /(^|\n)[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(\\\[|\$\$)/g;
/** A code fence, after the same quote or list marker a formula may follow. */
const FENCE = /^([ \t>]*)((?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/;

/** The text with code fences and code spans blanked, offsets kept: a formula in code is code. */
function withoutCode(text: string): string {
  // The open fence: closed by a run of the same character at least as long, with nothing after it,
  // in the same quote and not after a list marker. A quoted or listed fence inside a block is code.
  let fence: string | null = null, quote = '';
  const kept = text.split('\n').map(line => {
    const [, lead = '', item, marker, rest] = FENCE.exec(line) ?? [];
    const depth = lead.replace(/[^>]/g, '');
    if (fence === null && !marker) return line;
    if (fence === null) { fence = marker!; quote = depth; }
    else if (marker && !item && depth === quote && marker[0] === fence[0] && marker.length >= fence.length && !rest!.trim()) fence = null;
    return ' '.repeat(line.length);
  });
  return kept.join('\n').replace(/(`+)(?:[^`\n]|[^`\n][^\n]*?[^`\n])\1(?!`)/g, span => ' '.repeat(span.length));
}

/** The formulas outside code; `code` holds the spans of marked's code blocks, indented ones too. */
function displayFormulas(text: string, code: Array<[number, number]>): Array<{ at: number; artifact: AnswerArtifact }> {
  if (!text.includes('\\[') && !text.includes('$$')) return [];
  let prose = withoutCode(text);
  for (const [from, to] of code) prose = prose.slice(0, from) + prose.slice(from, to).replace(/[^\n]/g, ' ') + prose.slice(to);
  const out: Array<{ at: number; artifact: AnswerArtifact }> = [];
  DISPLAY_OPEN.lastIndex = 0;
  for (let match = DISPLAY_OPEN.exec(prose); match; match = DISPLAY_OPEN.exec(prose)) {
    const opener = match[2]!;
    const start = match.index + match[0].length;
    const end = prose.indexOf(opener === '$$' ? '$$' : '\\]', start);
    if (end < 0) break;
    const tex = text.slice(start, end).trim();
    if (tex) out.push({ at: start, artifact: { kind: 'formula', text: tex } });
    DISPLAY_OPEN.lastIndex = end + 2;
  }
  return out;
}

/** The code blocks, tables and display formulas of one answer's Markdown, in the order written. */
export function answerArtifacts(markdown: string): AnswerArtifact[] {
  const text = markdown.replace(/\r\n?/g, '\n');
  let tokens: Token[];
  try { tokens = new Lexer({ gfm: true }).lex(text); } catch { return []; }
  const found: Array<{ at: number; artifact: AnswerArtifact }> = [];
  const spans: Array<[number, number]> = [];
  const visit = (token: Token, at: number): void => {
    if (token.type === 'code') {
      const code = token as Tokens.Code;
      // The block's lines from where it starts: a nested block's raw has lost its indent, not its lines.
      let end = at - 1;
      for (let lines = code.raw.trim().split('\n').length; lines > 0 && end < text.length; lines--) {
        end = text.indexOf('\n', end + 1);
        if (end < 0) end = text.length;
      }
      spans.push([at, end]);
      if (!code.text.trim()) return;
      const language = code.lang?.trim().split(/\s+/)[0];
      found.push({ at, artifact: { kind: 'code', text: code.text, ...(language ? { language } : {}) } });
    } else if (token.type === 'table') {
      found.push({ at, artifact: { kind: 'table', text: token.raw.trim() } });
    }
    const children = token.type === 'list' ? (token as Tokens.List).items.flatMap(item => item.tokens)
      : token.type === 'blockquote' ? (token as Tokens.Blockquote).tokens : [];
    // A block in a list or a quote is written without its marker and indent, so it is placed by
    // its first line, searched from where the block before it was: formulas sort on the same scale.
    let from = at;
    for (const child of children) {
      const first = child.raw.split('\n').map(line => line.trim()).find(Boolean);
      const place = first ? text.indexOf(first, from) : -1;
      if (place >= 0) from = place;
      visit(child, from);
      if (first && place >= 0) from += first.length;
    }
  };
  let offset = 0;
  for (const token of tokens) { visit(token, offset); offset += token.raw.length; }
  found.push(...displayFormulas(text, spans));
  return found.sort((a, b) => a.at - b.at).map(entry => entry.artifact);
}
