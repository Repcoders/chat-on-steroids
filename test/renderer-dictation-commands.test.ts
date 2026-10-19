import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DictationEvent } from '../src/shared/dictation.js';

let dom: JSDOM;
let input: HTMLTextAreaElement;
let button: HTMLButtonElement;
let emit: (event: DictationEvent) => void;
let commands = true;
let sends: string[] = [];
const start = vi.fn(async () => ({ ok: true as const, data: { status: 'starting' } }));
const stop = vi.fn(async () => ({ ok: true as const, data: undefined }));

beforeAll(async () => {
  dom = new JSDOM(`<!doctype html><html><body>
    <form id="composer"><textarea id="chatInput"></textarea>
      <button id="dictationButton" type="button" disabled aria-pressed="false"></button>
      <p id="dictationStatus" role="status" hidden></p></form>
  </body></html>`, { url: 'https://local.test/' });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => null) as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  const api = { dictationSupported: true, startDictation: start, stopDictation: stop,
    onDictationEvent: (listener: (event: DictationEvent) => void) => { emit = listener; return () => undefined; } };
  Object.defineProperty(dom.window, 'api', { value: api });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    Event: dom.window.Event });
  const { initComposerDictation } = await import('../src/renderer/chat.js');
  input = dom.window.document.getElementById('chatInput') as HTMLTextAreaElement;
  button = dom.window.document.getElementById('dictationButton') as HTMLButtonElement;
  dom.window.document.getElementById('composer')!.addEventListener('submit', event => {
    event.preventDefault(); sends.push(input.value);
  });
  initComposerDictation({ commands: () => commands });
});

afterAll(() => dom?.window.close());

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const sendDialog = () => dom.window.document.querySelector<HTMLDialogElement>('.dictation-send-dialog');

async function listen(language?: string): Promise<void> {
  input.value = ''; input.setSelectionRange(0, 0);
  button.click(); await flush();
  emit({ type: 'status', status: 'listening', engine: 'modern', ...(language ? { language } : {}) });
}

function stopped(): void { emit({ type: 'status', status: 'stopped' }); }

describe('voice commands while dictating', () => {
  it('turns "new line" and "scratch that" into edits of the dictated text', async () => {
    await listen('en-US');
    emit({ type: 'final', text: 'Hello new line world.' });
    expect(input.value).toBe('Hello\nworld.');
    emit({ type: 'final', text: 'Scratch that.' });
    expect(input.value).toBe('Hello\n');
    emit({ type: 'final', text: 'there' });
    expect(input.value).toBe('Hello\nthere');
    expect(sends).toEqual([]);
    button.click(); await flush(); stopped();
  });

  it('keeps every spoken line break, so "new line" twice leaves an empty line', async () => {
    await listen('en-US');
    emit({ type: 'final', text: 'Steps new line new line' });
    emit({ type: 'final', text: 'one' });
    expect(input.value).toBe('Steps\n\none');
    button.click(); await flush(); stopped();
  });

  it('applies a command said again as its own phrase, not as a repeat of the last one', async () => {
    await listen('en-US');
    emit({ type: 'final', text: 'First' });
    emit({ type: 'final', text: 'New line.' });
    emit({ type: 'final', text: 'New line.' });
    emit({ type: 'final', text: 'Second' });
    emit({ type: 'final', text: 'Third' });
    expect(input.value).toBe('First\n\nSecond Third');
    emit({ type: 'final', text: 'Scratch that.' });
    emit({ type: 'final', text: 'Scratch that.' });
    expect(input.value).toBe('First\n\n');
    button.click(); await flush(); stopped();
  });

  it('stops listening on "send" and sends only after the person confirms', async () => {
    await listen('en-US');
    emit({ type: 'final', text: 'Ship it today' });
    emit({ type: 'final', text: 'Send.' });
    expect(input.value).toBe('Ship it today');
    expect(sends).toEqual([]);
    expect(button.getAttribute('data-state')).toBe('stopping');
    const dialog = sendDialog()!;
    expect(dialog.querySelector('h2')?.textContent).toBe('Send this message?');
    expect(dialog.querySelector('p')?.textContent).toBe('Ship it today');
    [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Send')!.click();
    expect(sends).toEqual(['Ship it today']);
    expect(sendDialog()).toBeNull();
    stopped();
  });

  it('keeps the draft unsent when the person keeps editing', async () => {
    sends = [];
    await listen('en-US');
    emit({ type: 'final', text: 'Not yet' });
    emit({ type: 'final', text: 'send' });
    [...sendDialog()!.querySelectorAll('button')].find(b => b.textContent === 'Keep editing')!.click();
    expect(sends).toEqual([]);
    expect(input.value).toBe('Not yet');
    stopped();
  });

  it('dictates the words as text when the setting is off or the speech language has no phrases', async () => {
    commands = false;
    await listen('en-US');
    emit({ type: 'final', text: 'Hello new line world.' });
    emit({ type: 'final', text: 'Send.' });
    expect(input.value).toBe('Hello new line world. Send.');
    expect(sendDialog()).toBeNull();
    button.click(); await flush(); stopped();
    commands = true;
    await listen('ja-JP');
    emit({ type: 'final', text: 'new line' });
    expect(input.value).toBe('new line');
    button.click(); await flush(); stopped();
    expect(sends).toEqual([]);
  });
});
