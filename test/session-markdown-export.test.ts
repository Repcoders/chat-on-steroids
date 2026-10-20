import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../src/shared/session.js';

const electron = vi.hoisted(() => ({
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  app: { getPath: vi.fn(() => '/downloads') }
}));
const store = vi.hoisted(() => ({ getSession: vi.fn(), readEvents: vi.fn(), readOverflowText: vi.fn() }));
const files = vi.hoisted(() => ({ writeFile: vi.fn(async () => undefined) }));
vi.mock('electron', () => electron);
vi.mock('../src/main/session/store.js', () => store);
vi.mock('node:fs', () => ({ promises: files }));

const { artifactsInSession, exportSessionMarkdown } = await import('../src/main/session/markdown-export.js');

const events: SessionEvent[] = [
  { seq: 1, time: 1, source: 'extension', kind: 'user_message', turnId: 't1', messageId: 'u1', message: { text: 'Explain it', truncated: false, chars: 10 } },
  { seq: 2, time: 2, source: 'extension', kind: 'assistant_message', turnId: 't1', messageId: 'a1', final: true, state: 'final',
    message: { text: 'The first part', truncated: true, chars: 40, assetId: 'abcdef12.txt' } },
  { seq: 3, time: 3, source: 'extension', kind: 'turn_end', turnId: 't1', outcome: 'completed' }
] as SessionEvent[];

beforeEach(() => {
  vi.clearAllMocks();
  store.getSession.mockResolvedValue({ id: 'session-1', title: 'Explain: it?' });
  store.readEvents.mockResolvedValue(events);
  store.readOverflowText.mockResolvedValue('The first part, and the rest of the answer.');
});

it('copies a completed answer whole, reading the part the log cut', async () => {
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'clipboard' }, null)).resolves.toEqual({ done: 'copied' });
  expect(store.readOverflowText).toHaveBeenCalledWith('session-1', 'abcdef12.txt');
  expect(electron.clipboard.writeText).toHaveBeenCalledWith('The first part, and the rest of the answer.\n');
});

it('saves the session transcript where the person chooses, named after the chat', async () => {
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/Explain it.md' });
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'session', target: 'file' }, null)).resolves.toEqual({ done: 'saved', name: 'Explain it.md' });
  expect(electron.dialog.showSaveDialog.mock.calls[0]![0]).toMatchObject({ defaultPath: expect.stringContaining('Explain it.md') });
  expect(files.writeFile).toHaveBeenCalledWith('/downloads/Explain it.md',
    '# Explain: it?\n\n## You\n\nExplain it\n\n## ChatGPT\n\nThe first part, and the rest of the answer.\n', 'utf8');
});

it('writes nothing when the save dialog is cancelled, and refuses unfinished turns', async () => {
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true });
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'file' }, null)).resolves.toEqual({ done: 'cancelled' });
  expect(files.writeFile).not.toHaveBeenCalled();
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 'open-turn', target: 'clipboard' }, null)).rejects.toThrow('has not completed');
});

// The clipboard write is asynchronous. It was not awaited, so a failed copy still answered "copied".
it('says a copy failed when the clipboard refuses it, instead of "copied"', async () => {
  electron.clipboard.writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'clipboard' }, null)).rejects.toThrow('clipboard unavailable');
});


// ChatGPT's link cards are private-use markup in the raw text; the copy gets a real Markdown link.
it('copies link cards as Markdown links instead of their raw markers', async () => {
  store.readOverflowText.mockResolvedValue('Open urlthe comparisonhttps://github.com/o/r/compare and merge it.');
  await exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'clipboard' }, null);
  expect(electron.clipboard.writeText).toHaveBeenCalledWith('Open [the comparison](https://github.com/o/r/compare) and merge it.\n');
});

it('copies the rows of a table ChatGPT drew but wrote with only its header (#1477)', async () => {
  const html = '<div data-d-component="table"><table><tr><td><p><span>Item</span></p></td><td><p>Qty</p></td></tr>' +
    '<tr><td><p>Rice</p></td><td><p>1 kg</p></td></tr><tr><td><p>Milk</p></td><td><p>2 l</p></td></tr></table></div>' +
    '<button type="button" data-d-component="button"><span>Copy list</span></button>';
  store.readEvents.mockResolvedValue([
    events[0]!,
    { seq: 2, time: 2, source: 'extension', kind: 'assistant_message', turnId: 't1', messageId: 'a1', final: true, state: 'final',
      message: { text: '| **Item** | **Qty** |\n|---|---|\n\n[Copy list]', truncated: false, chars: 40 },
      renderedHtml: { text: html, truncated: false, chars: html.length } },
    events[2]!
  ] as SessionEvent[]);
  await exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'clipboard' }, null);
  expect(electron.clipboard.writeText).toHaveBeenCalledWith('| **Item** | **Qty** |\n|---|---|\n| Rice | 1 kg |\n| Milk | 2 l |\n');
});

// An answer recorded outside any turn (copied branch history, an adopted chat) has no turn to name.
it('copies an answer recorded without a turn by its message id, and only such an answer', async () => {
  store.readEvents.mockResolvedValue([...events,
    { seq: 4, time: 4, source: 'extension', kind: 'assistant_message', messageId: 'loose-1', final: true, state: 'final',
      message: { text: 'An earlier answer', truncated: false, chars: 17 } }] as SessionEvent[]);
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', messageId: 'loose-1', target: 'clipboard' }, null)).resolves.toEqual({ done: 'copied' });
  expect(electron.clipboard.writeText).toHaveBeenCalledWith('An earlier answer\n');
  // A turn's own answer is exported by its turn; an unknown or turn-owned id is refused.
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', messageId: 'a1', target: 'clipboard' }, null)).rejects.toThrow('no answer to export');
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', target: 'clipboard' }, null)).rejects.toThrow('has not completed');
});

// Artifacts: the whole recording's answers, with the part the log cut, each tied to its answer.
it('lists the code, tables and formulas of every answer with its question and place', async () => {
  const fence = '```';
  store.readEvents.mockResolvedValue([
    events[0]!,
    { ...events[1]!, origin: 2, seq: 6 },
    events[2]!,
    { seq: 4, time: 4, source: 'extension', kind: 'user_message', turnId: 't2', messageId: 'u2', message: { text: 'And   the  table?', truncated: false, chars: 17 } },
    { seq: 5, time: 5, source: 'extension', kind: 'assistant_message', turnId: 't2', messageId: 'a2', final: true, state: 'final',
      message: { text: '| A | B |\n|---|---|\n| 1 | 2 |', truncated: false, chars: 29 } },
    { seq: 7, time: 7, source: 'extension', kind: 'assistant_message', turnId: 't2', messageId: 'p2', final: false, state: 'streaming',
      message: { text: `${fence}js\nnot final\n${fence}`, truncated: false, chars: 20 } }
  ] as SessionEvent[]);
  store.readOverflowText.mockResolvedValue(`The first part.\n\n${fence}python\nprint(1)\n${fence}\n\n\\[\nx^2\n\\]`);
  const first = { seq: 6, kind: 'assistant_message', messageId: 'a1', position: 2 };
  await expect(artifactsInSession('session-1')).resolves.toEqual({ artifacts: [
    { kind: 'code', language: 'python', text: 'print(1)', answer: 1, question: 'Explain it', location: first },
    { kind: 'formula', text: 'x^2', answer: 1, question: 'Explain it', location: first },
    { kind: 'table', text: '| A | B |\n|---|---|\n| 1 | 2 |', answer: 2, question: 'And the table?',
      location: { seq: 5, kind: 'assistant_message', messageId: 'a2', position: 5 } }
  ] });
  expect(store.readOverflowText).toHaveBeenCalledWith('session-1', 'abcdef12.txt');
});

it('bounds a chat\'s artifacts and says when it lists only part of them', async () => {
  const block = (n: number) => `\`\`\`\nline ${n}\n\`\`\``;
  store.readEvents.mockResolvedValue(Array.from({ length: 30 }, (_, at) => (
    { seq: at + 1, time: at + 1, source: 'extension', kind: 'assistant_message', messageId: `m${at}`, final: true, state: 'final',
      message: { text: Array.from({ length: 20 }, (_, n) => block(at * 20 + n)).join('\n\n'), truncated: false, chars: 1 } })) as SessionEvent[]);
  const reply = await artifactsInSession('session-1');
  expect(reply.limited).toBe(true);
  expect(reply.artifacts).toHaveLength(500);
  expect(reply.artifacts.at(-1)).toMatchObject({ text: 'line 499', answer: 25 });
});


it('numbers the answers of one turn as one answer, as Copy answer joins them', async () => {
  const said = (seq: number, kind: 'user_message' | 'assistant_message', turnId: string, messageId: string, text: string) => (
    { seq, time: seq, source: 'extension', kind, turnId, messageId, ...(kind === 'assistant_message' ? { final: true, state: 'final' } : {}),
      message: { text, truncated: false, chars: text.length } });
  store.readEvents.mockResolvedValue([
    said(1, 'user_message', 't1', 'u1', 'Two steps'),
    said(2, 'assistant_message', 't1', 'a1', '```sh\nfirst\n```'),
    said(3, 'assistant_message', 't1', 'a2', '```sh\nsecond\n```'),
    said(4, 'user_message', 't2', 'u2', 'Next'),
    said(5, 'assistant_message', 't2', 'a3', '```sh\nthird\n```')
  ] as SessionEvent[]);
  const reply = await artifactsInSession('session-1');
  expect(reply.artifacts.map(artifact => [artifact.text, artifact.answer])).toEqual([['first', 1], ['second', 1], ['third', 2]]);
});
