import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';
import { setLanguage } from '../src/renderer/i18n.js';
import { dateGroup, dateGroupLabel, dateLabels } from '../src/renderer/sidebar-dates.js';

let dom: JSDOM | undefined;
afterEach(() => {
  if (dom) { setLanguage('en'); dom.window.close(); dom = undefined; }
});

// 19 October 2026, 09:30 on this machine's own clock: the groups follow the local calendar.
const now = new Date(2026, 9, 19, 9, 30).getTime();
const at = (month: number, date: number, hours = 12, minutes = 0) => new Date(2026, month, date, hours, minutes).getTime();

it('groups a chat by the local day it was last active, then by month', () => {
  expect(dateGroup(at(9, 19, 0, 1), now)).toEqual({ kind: 'today' });
  expect(dateGroup(now + 60_000, now)).toEqual({ kind: 'today' });
  expect(dateGroup(at(9, 18, 23, 59), now)).toEqual({ kind: 'yesterday' });
  expect(dateGroup(at(9, 18, 0, 0), now)).toEqual({ kind: 'yesterday' });
  expect(dateGroup(at(9, 17, 23, 59), now)).toEqual({ kind: 'week' });
  expect(dateGroup(at(9, 12, 0, 0), now)).toEqual({ kind: 'week' });
  expect(dateGroup(at(9, 11, 23, 59), now)).toEqual({ kind: 'month', year: 2026, month: 9 });
  expect(dateGroup(at(8, 30), now)).toEqual({ kind: 'month', year: 2026, month: 8 });
  expect(dateGroup(new Date(2025, 11, 31).getTime(), now)).toEqual({ kind: 'month', year: 2025, month: 11 });
});

it('labels the first chat of each group in a list in date order', () => {
  const rows = [
    { id: 'a', updatedAt: at(9, 19, 9) }, { id: 'b', updatedAt: at(9, 19, 8) },
    { id: 'c', updatedAt: at(9, 18) },
    { id: 'd', updatedAt: at(9, 15) }, { id: 'e', updatedAt: at(9, 13) },
    { id: 'f', updatedAt: at(9, 2) },
    { id: 'g', updatedAt: at(8, 20) }, { id: 'h', updatedAt: at(8, 3) },
    { id: 'i', updatedAt: new Date(2025, 9, 25).getTime() }
  ];
  expect([...dateLabels(rows, now)]).toEqual([
    ['a', { kind: 'today' }], ['c', { kind: 'yesterday' }], ['d', { kind: 'week' }],
    ['f', { kind: 'month', year: 2026, month: 9 }], ['g', { kind: 'month', year: 2026, month: 8 }],
    ['i', { kind: 'month', year: 2025, month: 9 }]
  ]);
  expect(dateLabels([], now).size).toBe(0);
});

it('keeps the labels for chats dragged inside their group and drops them all for a list sorted out of date order', () => {
  const inGroup = [{ id: 'b', updatedAt: at(9, 19, 8) }, { id: 'a', updatedAt: at(9, 19, 9) }, { id: 'c', updatedAt: at(9, 18) }];
  expect([...dateLabels(inGroup, now).keys()]).toEqual(['b', 'c']);
  const across = [{ id: 'c', updatedAt: at(9, 18) }, { id: 'a', updatedAt: at(9, 19, 9) }, { id: 'd', updatedAt: at(8, 1) }];
  expect(dateLabels(across, now).size).toBe(0);
});

it('words the labels in the interface language, naming the year only for another year', () => {
  expect(dateGroupLabel({ kind: 'today' }, now)).toBe('Today');
  expect(dateGroupLabel({ kind: 'yesterday' }, now)).toBe('Yesterday');
  expect(dateGroupLabel({ kind: 'week' }, now)).toBe('Previous 7 days');
  expect(dateGroupLabel({ kind: 'month', year: 2026, month: 8 }, now)).toBe('September');
  expect(dateGroupLabel({ kind: 'month', year: 2025, month: 11 }, now)).toBe('December 2025');
  dom = new JSDOM('<body></body>', { url: 'https://local.test' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  setLanguage('ru');
  expect(dateGroupLabel({ kind: 'yesterday' }, now)).toBe('Вчера');
  // Russian writes a month in lower case; as a label it starts with a capital.
  expect(dateGroupLabel({ kind: 'month', year: 2026, month: 8 }, now)).toBe('Сентябрь');
});
