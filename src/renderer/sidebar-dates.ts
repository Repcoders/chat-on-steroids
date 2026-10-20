/**
 * Date labels above the unpinned chats of the Chats list: Today, Yesterday, Previous 7 days, then
 * one per month. They are labels only, never folders: nothing opens, closes, moves or is saved.
 */
import { currentLanguage, t } from './i18n.js';

export type DateGroup = { kind: 'today' } | { kind: 'yesterday' } | { kind: 'week' } | { kind: 'month'; year: number; month: number };

/** The group of a chat last active at `at`, by the local calendar of `now`. A future time counts as today. */
export function dateGroup(at: number, now: number): DateGroup {
  const today = new Date(now);
  const day = (offset: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset).getTime();
  if (at >= day(0)) return { kind: 'today' };
  if (at >= day(1)) return { kind: 'yesterday' };
  if (at >= day(7)) return { kind: 'week' };
  const date = new Date(at);
  return { kind: 'month', year: date.getFullYear(), month: date.getMonth() };
}

/** How far back a group lies: newer groups rank lower, so a list in date order never ranks down. */
function rank(group: DateGroup, now: number): number {
  if (group.kind === 'today') return 0;
  if (group.kind === 'yesterday') return 1;
  if (group.kind === 'week') return 2;
  const today = new Date(now);
  return 3 + (today.getFullYear() * 12 + today.getMonth()) - (group.year * 12 + group.month);
}

/**
 * The label each chat stands under, keyed by the first chat of its group in drawn order. A list
 * sorted by hand out of date order gets no labels: one would misstate the dates of the rows below it.
 */
export function dateLabels(rows: ReadonlyArray<{ id: string; updatedAt: number }>, now: number): Map<string, DateGroup> {
  const labels = new Map<string, DateGroup>();
  let last: number | undefined;
  for (const row of rows) {
    const group = dateGroup(row.updatedAt, now);
    const at = rank(group, now);
    if (last !== undefined && at < last) return new Map();
    if (at !== last) labels.set(row.id, group);
    last = at;
  }
  return labels;
}

/** The label's words in the interface language; a month of another year names the year too. */
export function dateGroupLabel(group: DateGroup, now: number): string {
  if (group.kind === 'today') return t("Today");
  if (group.kind === 'yesterday') return t("Yesterday");
  if (group.kind === 'week') return t("Previous 7 days");
  const language = currentLanguage();
  const sameYear = group.year === new Date(now).getFullYear();
  const name = new Intl.DateTimeFormat(language, { month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })
    .format(new Date(group.year, group.month, 1));
  // Some languages write a month in lower case ("октябрь", "octubre"); as a label it leads.
  return name.charAt(0).toLocaleUpperCase(language) + name.slice(1);
}
