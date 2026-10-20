import { afterEach, expect, it, vi } from 'vitest';
import { createTaskbarProgress, runningTitle } from '../src/main/taskbar-progress.js';
import { workingChats } from '../src/main/keep-awake.js';
import { setMainTextTranslations } from '../src/main/main-texts.js';
import type { SessionSummary } from '../src/shared/session.js';

// While chats work, the taskbar button shows progress and the window title says how many, so a
// minimized app still tells you when it is done. Off unless switched on in General.

const NOW = Date.UTC(2026, 9, 20, 12);
const chat = (id: string, activityExpiresAt: number | null, extra: Partial<SessionSummary> = {}) =>
  ({ id, startedAt: NOW - 600_000, activityExpiresAt, ...extra }) as SessionSummary;

afterEach(() => { vi.useRealTimers(); setMainTextTranslations({}); });

it('counts the chats keep-awake counts as working, and says when to look again', () => {
  expect(workingChats([chat('a', null), chat('b', NOW + 90_000), chat('c', NOW + 30_000)], NOW)).toEqual({ count: 2, nextAt: NOW + 30_000 });
  expect(workingChats([chat('a', null), chat('b', NOW - 1)], NOW)).toEqual({ count: 0, nextAt: null });
  // A worker that reported its finish is done, whatever its last deadline says.
  expect(workingChats([chat('w', NOW + 60_000, { origin: { kind: 'worker' } as SessionSummary['origin'], lastFinishReportAt: NOW - 10, lastToolCallAt: NOW - 20 })], NOW).count).toBe(0);
});

it('puts the running count in front of the window title, in the interface language', () => {
  expect(runningTitle(0)).toBe('Chat On Steroids');
  expect(runningTitle(2)).toBe('(2 running) Chat On Steroids');
  setMainTextTranslations({ '{0} running': '{0} aktiv' });
  expect(runningTitle(1)).toBe('(1 aktiv) Chat On Steroids');
});

it('shows the count while chats work, clears it when they finish or it is switched off', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  let sessions = [chat('a', NOW + 30_000), chat('b', NOW + 60_000)];
  let enabled = true;
  const shown: number[] = [];
  const progress = createTaskbarProgress({ sessions: async () => sessions, enabled: () => enabled, show: count => { shown.push(count); } });

  await progress.refresh();
  expect(shown).toEqual([2]);
  // Nothing changed: the taskbar is not touched again.
  await progress.refresh();
  expect(shown).toEqual([2]);

  // The first deadline passes with no new work: one chat is left, then none.
  await vi.advanceTimersByTimeAsync(30_100);
  expect(shown).toEqual([2, 1]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(shown).toEqual([2, 1, 0]);

  sessions = [chat('a', NOW + 300_000)];
  await progress.refresh();
  expect(shown.at(-1)).toBe(1);
  enabled = false;
  await progress.refresh();
  expect(shown.at(-1)).toBe(0);

  // A new window or language shows the same count again.
  enabled = true;
  await progress.refresh();
  await progress.repaint();
  expect(shown.slice(-2)).toEqual([1, 1]);
  progress.dispose();
  expect(shown.at(-1)).toBe(0);
});

it('tries again soon when reading the sessions fails, not only at the next minute', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  let fail = 2;
  const shown: number[] = [];
  const progress = createTaskbarProgress({
    sessions: async () => { if (fail-- > 0) throw new Error('store busy'); return [chat('a', NOW + 600_000), chat('b', NOW + 600_000)]; },
    enabled: () => true,
    show: count => { shown.push(count); }
  });
  await progress.refresh();
  expect(shown).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(shown).toEqual([]);
  // The second retry waits longer.
  await vi.advanceTimersByTimeAsync(2_000);
  expect(shown).toEqual([2]);
  progress.dispose();
});

it('never shows anything while switched off', async () => {
  const shown: number[] = [];
  const progress = createTaskbarProgress({ sessions: async () => [chat('a', Date.now() + 60_000)], enabled: () => false, show: count => { shown.push(count); } });
  await progress.refresh();
  await progress.refresh();
  progress.dispose();
  expect(shown).toEqual([]);
});
