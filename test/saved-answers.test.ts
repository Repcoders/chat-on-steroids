import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../src/shared/session.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const electron = vi.hoisted(() => ({
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  app: { getPath: vi.fn(() => '/downloads') }
}));
const store = vi.hoisted(() => ({
  getSession: vi.fn(), readEvents: vi.fn(), readOverflowText: vi.fn(), sessionDirectoryMissing: vi.fn()
}));
const files = vi.hoisted(() => ({ writeFile: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('electron', () => electron);
vi.mock('../src/main/session/store.js', () => store);
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  // The exported file is mocked; the durable state file is written for real.
  return { ...actual, promises: { ...actual.promises, writeFile: (...args: Parameters<typeof actual.promises.writeFile>) =>
    String(args[0]).startsWith('/downloads') ? files.writeFile(...args) : actual.promises.writeFile(...args) } };
});

const shelf = await import('../src/main/session/saved-answers.js');

const events: SessionEvent[] = [
  { seq: 1, time: 1, source: 'extension', kind: 'user_message', turnId: 't1', messageId: 'u1', message: { text: 'Plan the trip', truncated: false, chars: 13 } },
  { seq: 2, time: 2, source: 'extension', kind: 'assistant_message', turnId: 't1', messageId: 'a1', final: true, state: 'final',
    message: { text: 'Day one', truncated: true, chars: 40, assetId: 'abcdef12.txt' } },
  { seq: 3, time: 3, source: 'extension', kind: 'turn_end', turnId: 't1', outcome: 'completed' },
  { seq: 4, time: 4, source: 'extension', kind: 'assistant_message', messageId: 'loose', final: true, state: 'final',
    message: { text: 'An answer outside any turn', truncated: false, chars: 26 } }
] as SessionEvent[];
let dir = '';

beforeEach(async () => {
  vi.clearAllMocks();
  shelf.resetSavedAnswersForTests();
  resetDurableForTests();
  if (dir) await removeTempDir(dir);
  dir = await makeTempDir('cos-saved-answers-');
  initDurableStore(dir);
  store.getSession.mockImplementation(async (id: string) => ({ id, title: id === 'session-b' ? 'Second chat' : 'Trip plan' }));
  store.readEvents.mockResolvedValue(events);
  store.readOverflowText.mockResolvedValue('Day one, then day two.');
  store.sessionDirectoryMissing.mockResolvedValue(false);
});

afterAll(async () => {
  resetDurableForTests();
  if (dir) await removeTempDir(dir);
});

it('saves a completed answer whole, once, and keeps it across a restart', async () => {
  const saved = await shelf.saveAnswer('session-a', 't1', undefined, 1000);
  expect(saved).toEqual([expect.objectContaining({
    sessionId: 'session-a', turnId: 't1', messageId: null, anchorMessageId: 'a1', title: 'Trip plan',
    markdown: 'Day one, then day two.\n', savedAt: 1000, orphaned: false
  })]);
  // The same answer starred again stays one entry.
  expect(await shelf.saveAnswer('session-a', 't1', undefined, 2000)).toHaveLength(1);
  await shelf.saveAnswer('session-b', undefined, 'loose', 3000);
  await flushDurable();

  shelf.resetSavedAnswersForTests();
  const restored = await shelf.listSavedAnswers();
  expect(restored.map(entry => [entry.title, entry.markdown])).toEqual([
    ['Second chat', 'An answer outside any turn\n'], ['Trip plan', 'Day one, then day two.\n']
  ]);
});

it('refuses an answer whose turn has not completed, and keeps the shelf as it was', async () => {
  await expect(shelf.saveAnswer('session-a', 'open-turn')).rejects.toThrow('has not completed');
  expect(await shelf.listSavedAnswers()).toEqual([]);
});

it('marks an entry orphaned once its chat is removed, and still exports its text', async () => {
  const [entry] = await shelf.saveAnswer('session-a', 't1');
  store.sessionDirectoryMissing.mockResolvedValue(true);
  store.getSession.mockResolvedValue(null);
  const [listed] = await shelf.listSavedAnswers();
  expect(listed).toMatchObject({ id: entry!.id, orphaned: true, markdown: 'Day one, then day two.\n' });

  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/Trip plan - answer.md' });
  await expect(shelf.exportSavedAnswer(entry!.id, null)).resolves.toEqual({ done: 'saved', name: 'Trip plan - answer.md' });
  expect(electron.dialog.showSaveDialog.mock.calls[0]![0]).toMatchObject({ defaultPath: expect.stringContaining('Trip plan - answer.md') });
  expect(files.writeFile).toHaveBeenCalledWith('/downloads/Trip plan - answer.md', 'Day one, then day two.\n', 'utf8');
});

it('locates an entry at its first answer message, and removes it', async () => {
  const [entry] = await shelf.saveAnswer('session-a', 't1');
  store.readEvents.mockResolvedValue(events.filter(event => event.kind === 'assistant_message'));
  await expect(shelf.locateSavedAnswer(entry!.id)).resolves.toEqual({
    sessionId: 'session-a', location: { seq: 2, kind: 'assistant_message', messageId: 'a1', position: 2 }
  });
  expect(await shelf.removeSavedAnswer(entry!.id)).toEqual([]);
  await expect(shelf.locateSavedAnswer(entry!.id)).resolves.toBeNull();
});

it('refuses an answer longer than the shelf keeps', async () => {
  store.readOverflowText.mockResolvedValue('x'.repeat(shelf.MAX_SAVED_ANSWER_CHARS + 1));
  await expect(shelf.saveAnswer('session-a', 't1')).rejects.toThrow('too long to save');
  expect(await shelf.listSavedAnswers()).toEqual([]);
});

it('refuses an answer once the shelf holds as many characters as it keeps', async () => {
  const turns = Array.from({ length: 21 }, (_, n) => `turn-${n}`);
  store.readEvents.mockResolvedValue(turns.flatMap((turnId, n) => [
    { seq: n * 2 + 1, time: n, source: 'extension', kind: 'assistant_message', turnId, messageId: `m-${n}`, final: true, state: 'final',
      message: { text: 'x', truncated: true, chars: 99_000, assetId: 'abcdef12.txt' } },
    { seq: n * 2 + 2, time: n, source: 'extension', kind: 'turn_end', turnId, outcome: 'completed' }
  ]) as SessionEvent[]);
  store.readOverflowText.mockResolvedValue('x'.repeat(99_000));
  for (const turnId of turns.slice(0, 20)) await shelf.saveAnswer('session-a', turnId);
  await expect(shelf.saveAnswer('session-a', turns[20])).rejects.toThrow('Saved answers are full');
  const saved = await shelf.listSavedAnswers();
  expect(saved).toHaveLength(20);
  expect(saved.reduce((sum, entry) => sum + entry.markdown.length, 0)).toBeLessThanOrEqual(shelf.MAX_SHELF_CHARS);
});
