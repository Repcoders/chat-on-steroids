import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';
import { createSidebarSnooze, snoozeUntil, wakeLabel } from '../src/renderer/sidebar-snooze.js';

const KEY = 'chat-on-steroids.sidebar-snooze';
const HOUR = 60 * 60_000;
let dom: JSDOM;
let clock = 0;
afterEach(() => dom?.window.close());

function fixture(saved?: string) {
  dom = new JSDOM('<div></div>', { url: 'https://local.test' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  if (saved !== undefined) dom.window.localStorage.setItem(KEY, saved);
  return createSidebarSnooze(() => clock);
}

it('keeps a chat snoozed until its time, then wakes it for good', () => {
  clock = 1_000_000;
  const snooze = fixture();
  snooze.snooze('a', clock + HOUR, 500);
  expect(snooze.until('a', 500)).toBe(clock + HOUR);
  expect(snooze.until('b', 500)).toBeNull();
  expect(snooze.nextWake()).toBe(clock + HOUR);
  clock += HOUR;
  expect(snooze.until('a', 500)).toBeNull();
  // Woken, it stays awake even if the clock went back.
  clock -= HOUR;
  expect(snooze.until('a', 500)).toBeNull();
  expect(snooze.nextWake()).toBeNull();
});

it('wakes a chat that does anything after it was snoozed, and on Unsnooze', () => {
  clock = 1_000_000;
  const snooze = fixture();
  snooze.snooze('a', clock + HOUR, 500);
  snooze.snooze('b', clock + 2 * HOUR, 700);
  expect(snooze.until('a', 501)).toBeNull();
  expect(snooze.until('a', 500)).toBeNull();
  snooze.wake('b');
  expect(snooze.until('b', 700)).toBeNull();
});

it('keeps a chat snoozed while it works and as that work ends, then wakes it on anything after', () => {
  clock = 1_000_000;
  const snooze = fixture();
  snooze.snooze('a', clock + HOUR, 500, true);
  expect(snooze.until('a', 600, true)).toBe(clock + HOUR);
  expect(snooze.until('a', 700, false)).toBe(clock + HOUR);
  expect(snooze.until('a', 700, false)).toBe(clock + HOUR);
  // Kept across a restart, from the end of that work on.
  const saved = fixture(dom.window.localStorage.getItem(KEY)!);
  expect(saved.until('a', 700)).toBe(clock + HOUR);
  expect(saved.until('a', 701, true)).toBeNull();
});

it('remembers snoozes across a restart and ignores broken, oversized or far-off storage', () => {
  clock = 1_000_000;
  fixture().snooze('kept', clock + HOUR, 1);
  const saved = dom.window.localStorage.getItem(KEY)!;
  expect(fixture(saved).until('kept', 1)).toBe(clock + HOUR);
  expect(fixture('{not json').until('kept', 1)).toBeNull();
  // A time no choice can pick would hold the sidebar's one repaint timer far beyond its range.
  const far = fixture(JSON.stringify([['far', clock + 400 * 24 * HOUR, 1], ['bad', 'soon', 1], ['x'.repeat(161), clock + HOUR, 1], ['ok', clock + HOUR, 1]]));
  expect(far.until('far', 1)).toBeNull();
  expect(far.until('bad', 1)).toBeNull();
  expect(far.until('x'.repeat(161), 1)).toBeNull();
  expect(far.until('ok', 1)).toBe(clock + HOUR);
});

it('never refuses a snooze: the oldest one gives way at the bound', () => {
  clock = 1_000_000;
  const snooze = fixture(JSON.stringify(Array.from({ length: 500 }, (_, index) => [`chat-${index}`, clock + HOUR, 1])));
  snooze.snooze('newest', clock + HOUR, 1);
  expect(snooze.until('newest', 1)).toBe(clock + HOUR);
  expect(snooze.until('chat-0', 1)).toBeNull();
  expect(snooze.until('chat-1', 1)).toBe(clock + HOUR);
});

it('offers an hour from now, tomorrow at 8:00 and next Monday at 8:00, in local time', () => {
  const at = (year: number, month: number, day: number, hour: number, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime();
  // Wednesday 21:30.
  const wednesday = at(2026, 10, 14, 21, 30);
  expect(snoozeUntil('hour', wednesday)).toBe(wednesday + HOUR);
  expect(snoozeUntil('tomorrow', wednesday)).toBe(at(2026, 10, 15, 8));
  expect(snoozeUntil('week', wednesday)).toBe(at(2026, 10, 19, 8));
  // Sunday: next week starts tomorrow. Monday: a week on, never today.
  expect(snoozeUntil('week', at(2026, 10, 18, 7))).toBe(at(2026, 10, 19, 8));
  expect(snoozeUntil('week', at(2026, 10, 19, 7))).toBe(at(2026, 10, 26, 8));
  // The last day of a month rolls into the next one.
  expect(snoozeUntil('tomorrow', at(2026, 10, 31, 12))).toBe(at(2026, 11, 1, 8));
});

it('names the day a snooze ends, with its date once the weekday alone would read as this week', () => {
  const monday = new Date(2026, 9, 19, 7).getTime();
  // ICU versions differ in the space before AM, so the shape is checked, not every character.
  expect(wakeLabel(snoozeUntil('tomorrow', monday), monday, 'en-US')).toMatch(/^Tue 8:00\s?AM$/u);
  // Next Monday, seen on a Monday: not this morning.
  expect(wakeLabel(snoozeUntil('week', monday), monday, 'en-US')).toMatch(/^Mon, Oct 26, 8:00\s?AM$/u);
  expect(wakeLabel(snoozeUntil('week', monday), monday, 'de')).toMatch(/^Mo\., 26\. Okt\., 0?8:00$/u);
});
