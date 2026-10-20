import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createProjectCodeEditor } from '../src/renderer/file-code-editor.js';

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<body><div id="editor"></div></body>', {
    url: 'https://cos.local/',
    pretendToBeVisual: true
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
  vi.stubGlobal('DOMRect', dom.window.DOMRect);
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  if (!dom.window.Range.prototype.getClientRects) {
    Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { value: () => [] });
  }
  if (!dom.window.Range.prototype.getBoundingClientRect) {
    Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { value: () => new dom.window.DOMRect() });
  }
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

it('loads syntax support from the filename and renders a real line-number gutter', async () => {
  const changes: string[] = [];
  const parent = document.getElementById('editor')!;
  const editor = await createProjectCodeEditor({
    parent,
    filename: 'main.ts',
    text: 'const first = 1;\nfunction second() { return first; }\n',
    onChange: value => changes.push(value)
  });

  expect(editor.language).toMatch(/JavaScript|TypeScript/i);
  expect(parent.querySelector('.cm-editor')).not.toBeNull();
  expect(parent.querySelector('.cm-lineNumbers')).not.toBeNull();
  expect(parent.querySelectorAll('.cm-gutterElement').length).toBeGreaterThan(1);

  editor.view.dispatch({ changes: { from: 0, to: 5, insert: 'let' } });
  expect(editor.getValue()).toContain('let first');
  expect(changes.at(-1)).toContain('let first');
  editor.destroy();
});

it('falls back to plain text while keeping the same editor and line numbers for unknown files', async () => {
  const parent = document.getElementById('editor')!;
  const editor = await createProjectCodeEditor({
    parent,
    filename: 'notes.unknown-extension',
    text: 'one\ntwo\n',
    onChange: () => undefined
  });

  expect(editor.language).toBe('Plain text');
  expect(parent.querySelector('.cm-lineNumbers')).not.toBeNull();
  editor.destroy();
});

it('uses the same highlighted CodeMirror surface as a read-only viewer', async () => {
  const parent = document.getElementById('editor')!;
  const viewer = await createProjectCodeEditor({
    parent,
    filename: 'preview.ts',
    text: 'export function answer() { return 42; }\n',
    readOnly: true
  });

  expect(viewer.language).toMatch(/JavaScript|TypeScript/i);
  expect(parent.querySelector('.cm-lineNumbers')).not.toBeNull();
  expect(parent.querySelector<HTMLElement>('.cm-content')?.getAttribute('contenteditable')).toBe('false');
  expect(parent.querySelector('.cm-line span')).not.toBeNull();
  viewer.destroy();
});

it('preserves CRLF and the final newline when editing and bounds retained text', async () => {
  const editor = await createProjectCodeEditor({ parent: document.getElementById('editor')!, filename: 'notes.txt', text: '\uFEFFone\r\ntwo\r\n' });
  expect(editor.getValue()).toBe('\uFEFFone\r\ntwo\r\n');
  editor.view.dispatch({ changes: { from: 1, to: 4, insert: 'three' } });
  expect(editor.getValue()).toBe('\uFEFFthree\r\ntwo\r\n');
  editor.view.dispatch({ changes: { from: 0, insert: 'x'.repeat(256 * 1024) } });
  expect(editor.getValue()).toBe('\uFEFFthree\r\ntwo\r\n');
  editor.destroy();
});

it('shows a blame gutter that labels each commit once and marks lines rewritten after the read as not committed', async () => {
  const parent = document.getElementById('editor')!;
  const editor = await createProjectCodeEditor({ parent, filename: 'main.ts', text: 'one\ntwo\nthree\nfour\n' });
  const ada = { key: 'a'.repeat(40), label: 'Ada · Jan 2, 2026', title: 'Ada\nFirst', uncommitted: false };
  const bo = { key: 'b'.repeat(40), label: 'Bo · Jan 3, 2026', title: 'Bo\nSecond', uncommitted: false };
  const none = { key: '', label: 'Not committed yet', title: 'Not committed yet', uncommitted: true };
  const cells = () => [...parent.querySelectorAll('.cm-blame-gutter .cm-gutterElement')].map(cell => cell.textContent);

  const stale = editor.blame();
  const request = editor.blame();
  expect(request.text).toBe('one\ntwo\nthree\nfour\n');
  // Typed while the read was out: it lands on the newer text, with that line not committed.
  editor.view.dispatch({ changes: { from: 4, to: 7, insert: 'TWO' } });
  stale.apply([none, none, none, none], none);
  expect(parent.querySelector('.cm-blame-gutter')).toBeNull();
  request.apply([ada, ada, bo, bo], none);
  expect(cells()).toEqual(['Ada · Jan 2, 2026', 'Not committed yet', 'Bo · Jan 3, 2026', '']);
  expect(parent.querySelectorAll<HTMLElement>('.cm-blame')[3]!.title).toBe('Bo\nSecond');
  expect(parent.querySelector('.cm-blame-gutter + .cm-lineNumbers, .cm-blame-gutter ~ .cm-lineNumbers')).not.toBeNull();

  // A line break at the end of a line adds a new line; the line it was typed on keeps its commit.
  editor.view.dispatch({ changes: { from: editor.view.state.doc.line(3).to, insert: '\n' } });
  expect(cells()).toEqual(['Ada · Jan 2, 2026', 'Not committed yet', 'Bo · Jan 3, 2026', 'Not committed yet', 'Bo · Jan 3, 2026']);
  // Removing a whole line leaves the lines around it as they were.
  editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.line(2).from } });
  expect(cells()).toEqual(['Not committed yet', 'Bo · Jan 3, 2026', 'Not committed yet', 'Bo · Jan 3, 2026']);

  editor.clearBlame();
  expect(parent.querySelector('.cm-blame-gutter')).toBeNull();
  editor.destroy();
});
