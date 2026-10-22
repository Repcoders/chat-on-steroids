import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../src/shared/session.js';

let dom: JSDOM;
afterEach(() => {
  dom?.window.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// Monday 2026-10-19, 10:00 local time.
const NOW = new Date(2026, 9, 19, 10, 0).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

let ids = 0;
const chat = (fields: Partial<SessionSummary>): SessionSummary => ({
  id: `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`, title: 'Placeholder chat', conversationId: `conv-${ids}`,
  projectId: null, chatIds: [], startedAt: 0, updatedAt: 0, endedAt: null, events: 0, userMessages: 1, toolCalls: 0,
  lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0, estimatedTokens: 0,
  contextTokens: 0, lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: 'completed', agents: [], origin: null,
  ...fields
}) as SessionSummary;

const PROJECTS: Record<string, string> = { 'project-a': 'Placeholder project A', 'project-b': 'Placeholder project B' };

async function mount(start: SessionSummary[]) {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('Event', dom.window.Event);
  vi.stubGlobal('navigator', { platform: 'Win32', language: 'en', languages: ['en'] });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const doc = dom.window.document;
  let chats = start;
  const opened: string[] = [];
  const { createWorkLog } = await import('../src/renderer/work-log.js');
  const log = createWorkLog({
    chats: () => chats,
    project: summary => summary.projectId && PROJECTS[summary.projectId] ? { id: summary.projectId, name: PROJECTS[summary.projectId]! } : null,
    title: summary => summary.title,
    open: id => opened.push(id)
  });
  const days = () => [...doc.querySelectorAll<HTMLElement>('.work-log-day')].map(day => [
    day.querySelector('.work-log-day-head')!.textContent,
    [...day.querySelectorAll<HTMLElement>('.work-log-row')].map(row => [
      row.querySelector('.work-log-time')!.textContent,
      row.querySelector('.work-log-outcome')!.textContent,
      row.querySelector('.work-log-title')!.textContent,
      row.querySelector('.work-log-project')?.textContent ?? null
    ])
  ]);
  const select = (label: string) => doc.querySelector<HTMLSelectElement>(`.work-log-filter[aria-label="${label}"]`)!;
  const choose = (label: string, value: string) => {
    const node = select(label);
    node.value = value;
    node.dispatchEvent(new dom.window.Event('change'));
  };
  const empty = () => doc.querySelector('.work-log-empty')?.textContent ?? null;
  return { doc, log, days, select, choose, empty, opened, set: (next: SessionSummary[]) => { chats = next; } };
}

const time = (value: number) => new Date(value).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });

it("lists each chat's last finished turn by day, newest first, and opens the chat on click", async () => {
  const failed = chat({ title: 'Failed overnight', projectId: 'project-b', lastTurnOutcome: 'failed', lastTurnEndAt: at(18, 23, 40) });
  const view = await mount([
    chat({ title: 'Finished this morning', projectId: 'project-a', lastTurnEndAt: at(19, 8, 15) }),
    failed,
    chat({ title: 'Stopped late', projectId: 'project-a', lastTurnOutcome: 'stopped', lastTurnEndAt: at(18, 21, 5) }),
    // Metadata from before lastTurnEndAt existed: the final answer's time stands in.
    chat({ title: 'Older metadata', lastAssistantFinalAt: at(16, 14, 30) }),
    chat({ title: 'Never finished a turn', lastTurnOutcome: null }),
    chat({ title: 'A worker', origin: { kind: 'worker' } as SessionSummary['origin'], lastTurnEndAt: at(19, 9) }),
    chat({ title: 'A helper', origin: { kind: 'helper' } as SessionSummary['origin'], lastTurnEndAt: at(19, 9) }),
    chat({ title: 'Reserved, nothing to open', conversationId: null, lastTurnEndAt: at(19, 9) })
  ]);
  view.log.open();
  const dialog = view.doc.querySelector('dialog.work-log-dialog')!;
  expect(dialog.querySelector('h2')!.textContent).toBe('Work log');
  expect(view.days()).toEqual([
    ['Today', [[time(at(19, 8, 15)), 'Completed', 'Finished this morning', 'Placeholder project A']]],
    ['Yesterday', [
      [time(at(18, 23, 40)), 'Failed', 'Failed overnight', 'Placeholder project B'],
      [time(at(18, 21, 5)), 'Stopped', 'Stopped late', 'Placeholder project A']
    ]],
    ['Friday, October 16', [[time(at(16, 14, 30)), 'Completed', 'Older metadata', null]]]
  ]);
  view.doc.querySelector<HTMLButtonElement>(`.work-log-row[data-session-id="${failed.id}"]`)!.click();
  expect(view.opened).toEqual([failed.id]);
  expect(view.doc.querySelector('dialog.work-log-dialog')).toBeNull();
});

it('filters by project and by outcome, and keeps the filters when it opens again', async () => {
  const view = await mount([
    chat({ title: 'Done in A', projectId: 'project-a', lastTurnEndAt: at(18, 22) }),
    chat({ title: 'Failed in B', projectId: 'project-b', lastTurnOutcome: 'failed', lastTurnEndAt: at(18, 23) }),
    chat({ title: 'Done in B', projectId: 'project-b', lastTurnEndAt: at(18, 21) }),
    chat({ title: 'Loose chat', lastTurnOutcome: 'interrupted', lastTurnEndAt: at(18, 20) })
  ]);
  view.log.open();
  // Only the projects that have a row, by name, then chats in no project.
  expect([...view.select('Project').options].map(option => option.textContent))
    .toEqual(['All projects', 'Placeholder project A', 'Placeholder project B', 'No project']);
  expect([...view.select('Outcome').options].map(option => option.textContent))
    .toEqual(['All outcomes', 'Completed', 'Failed', 'Stopped', 'Interrupted', 'Stalled', 'Unknown']);

  view.choose('Outcome', 'failed');
  expect(view.days()).toEqual([['Yesterday', [[time(at(18, 23)), 'Failed', 'Failed in B', 'Placeholder project B']]]]);
  view.choose('Outcome', '');
  view.choose('Project', 'project-b');
  expect(view.days().flatMap(([, rows]) => (rows as string[][]).map(row => row[2]))).toEqual(['Failed in B', 'Done in B']);
  view.choose('Project', 'none');
  expect(view.days().flatMap(([, rows]) => (rows as string[][]).map(row => row[2]))).toEqual(['Loose chat']);
  view.choose('Outcome', 'stalled');
  expect(view.days()).toEqual([]);
  expect(view.empty()).toBe('No chats match these filters.');

  view.doc.querySelector<HTMLButtonElement>('dialog .plugin-dialog-head .btn')!.click();
  view.log.open();
  expect(view.select('Project').value).toBe('none');
  expect(view.select('Outcome').value).toBe('stalled');
});

it('repaints from the latest list while open, and says when nothing has finished yet', async () => {
  const view = await mount([chat({ title: 'Still on its first turn', lastTurnOutcome: null })]);
  view.log.open();
  expect(view.days()).toEqual([]);
  expect(view.empty()).toBe('No finished turns yet.');
  view.set([chat({ title: 'Just finished', projectId: 'project-a', lastTurnEndAt: at(19, 9, 55) })]);
  view.log.update();
  expect(view.days()).toEqual([['Today', [[time(at(19, 9, 55)), 'Completed', 'Just finished', 'Placeholder project A']]]]);
  expect(view.empty()).toBeNull();
  // A chosen project that no longer has a row falls back to all projects.
  view.choose('Project', 'project-a');
  view.set([chat({ title: 'Elsewhere', projectId: 'project-b', lastTurnEndAt: at(19, 9, 58) })]);
  view.log.update();
  expect(view.select('Project').value).toBe('');
  expect(view.days().flatMap(([, rows]) => (rows as string[][]).map(row => row[2]))).toEqual(['Elsewhere']);
});

it('keeps keyboard focus on its row and an unchanged project list in place when the sidebar reloads', async () => {
  const first = chat({ title: 'First', projectId: 'project-a', lastTurnEndAt: at(19, 8) });
  const second = chat({ title: 'Second', projectId: 'project-b', lastTurnEndAt: at(19, 7) });
  const view = await mount([first, second]);
  view.log.open();
  const row = (id: string) => view.doc.querySelector<HTMLButtonElement>(`.work-log-row[data-session-id="${id}"]`)!;
  row(second.id).focus();
  const options = [...view.select('Project').options];
  // The second chat finishes again and moves to the top.
  view.set([{ ...second, lastTurnEndAt: at(19, 9) }, first]);
  view.log.update();
  expect(view.days().flatMap(([, rows]) => (rows as string[][]).map(entry => entry[2]))).toEqual(['Second', 'First']);
  expect((view.doc.activeElement as HTMLElement).dataset.sessionId).toBe(second.id);
  expect([...view.select('Project').options]).toEqual(options);
});

it("leaves out a chat whose end time is past what a date can hold, so the log still opens", async () => {
  const view = await mount([
    chat({ title: 'Beyond any date', lastTurnEndAt: 9e15 }),
    chat({ title: 'Finished', lastTurnEndAt: at(19, 9) })
  ]);
  view.log.open();
  expect(view.days()).toEqual([['Today', [[time(at(19, 9)), 'Completed', 'Finished', null]]]]);
});

it("names the days in the app's language, with the year once it differs", async () => {
  await mount([]);
  const { setLanguage } = await import('../src/renderer/i18n.js');
  const { workLogDay } = await import('../src/renderer/work-log.js');
  setLanguage('de');
  expect(workLogDay(at(19, 7), NOW)).toBe('Heute');
  expect(workLogDay(at(18, 23, 59), NOW)).toBe('Gestern');
  setLanguage('en');
  expect(workLogDay(at(17, 1), NOW)).toBe('Saturday, October 17');
  expect(workLogDay(new Date(2025, 11, 31, 12).getTime(), NOW)).toBe('Wednesday, December 31, 2025');
});
