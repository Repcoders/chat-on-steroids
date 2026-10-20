/**
 * The work log (View › Work log): the chats the sidebar has loaded, one row each for its last
 * finished turn, newest first and grouped by day. A row says when the turn ended, how it ended
 * (`lastTurnOutcome`), the chat and its project, and opens the chat on click. It is read-only and
 * reads nothing of its own: summaries hold only a chat's last turn, so it is not a list of every
 * turn, and an older turn of the same chat never shows here.
 */
import type { SessionSummary, TurnOutcome } from '../shared/session.js';
import { el } from './dom.js';
import { currentLanguage, t, ui } from './i18n.js';

export interface WorkLogDeps {
  /** The chats the sidebar lists, as it last loaded them. */
  chats(): readonly SessionSummary[];
  /** A project's name; null for a chat in no project (or in one removed from the sidebar). */
  project(summary: SessionSummary): { id: string; name: string } | null;
  title(summary: SessionSummary): string;
  open(sessionId: string): void;
}

export interface WorkLogRow {
  id: string;
  title: string;
  endedAt: number;
  outcome: TurnOutcome;
  project: { id: string; name: string } | null;
}

/** The outcome filter's choices, in the order it lists them. */
const OUTCOMES: readonly TurnOutcome[] = ['completed', 'failed', 'stopped', 'interrupted', 'stalled', 'unknown'];
const outcomeLabel = (outcome: TurnOutcome): string => outcome === 'completed' ? t('Completed')
  : outcome === 'failed' ? t('Failed') : outcome === 'stopped' ? t('Stopped')
    : outcome === 'interrupted' ? t('Interrupted') : outcome === 'stalled' ? t('Stalled') : t('Unknown');

/** The project filter's value for chats in no project; project ids are UUIDs, so it never collides. */
const NO_PROJECT = 'none';

/**
 * One row per chat whose last turn has ended, newest end first. Sub-agents and helpers stay out, as
 * they do in the sidebar's own list, and so does a reserved chat with nothing to open yet. Metadata
 * from before `lastTurnEndAt` existed falls back to the last final answer's time.
 */
export function workLogRows(chats: readonly SessionSummary[], deps: Pick<WorkLogDeps, 'project' | 'title'>): WorkLogRow[] {
  const rows: WorkLogRow[] = [];
  for (const chat of chats) {
    if (chat.origin?.kind === 'worker' || chat.origin?.kind === 'helper') continue;
    if (!chat.conversationId && chat.origin?.kind !== 'desktop') continue;
    const endedAt = chat.lastTurnEndAt ?? chat.lastAssistantFinalAt ?? null;
    if (!chat.lastTurnOutcome || endedAt === null) continue;
    rows.push({ id: chat.id, title: deps.title(chat), endedAt, outcome: chat.lastTurnOutcome, project: deps.project(chat) });
  }
  return rows.sort((a, b) => b.endedAt - a.endedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const dayKey = (at: number): string => { const day = new Date(at); return `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`; };

/** "Today", "Yesterday" in the app's language, then the weekday and date (with the year once it differs). */
export function workLogDay(at: number, now = Date.now()): string {
  const language = currentLanguage();
  const day = new Date(at); day.setHours(0, 0, 0, 0);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  // Rounded: a day across a daylight-saving change is 23 or 25 hours long.
  const back = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (back === 0 || back === 1) {
    const text = new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(-back, 'day');
    return text.charAt(0).toLocaleUpperCase(language) + text.slice(1);
  }
  return new Date(at).toLocaleDateString(language, {
    weekday: 'long', month: 'long', day: 'numeric', ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' })
  });
}

export function createWorkLog(deps: WorkLogDeps): { open(): void; update(): void } {
  let dialog: HTMLDialogElement | null = null;
  let body: HTMLElement | null = null;
  let projectFilter: HTMLSelectElement | null = null;
  let outcomeFilter: HTMLSelectElement | null = null;
  // The filters last chosen, kept while the app runs so reopening the log shows the same view.
  let chosen = { project: '', outcome: '' };

  // Electron has the dialog methods; a bare DOM (the tests) gets the same effect by hand.
  const closeDialog = (): void => {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); }
  };

  const option = (value: string, label: string): HTMLOptionElement => {
    const node = document.createElement('option');
    node.value = value; node.textContent = label;
    return node;
  };

  /** The project choices are the projects that have a row, by name; a chosen project stays listed. */
  const paintProjects = (rows: readonly WorkLogRow[]): void => {
    if (!projectFilter) return;
    const named = new Map<string, string>();
    let none = false;
    for (const row of rows) {
      if (row.project) named.set(row.project.id, row.project.name);
      else none = true;
    }
    const sorted = [...named].sort(([, a], [, b]) => a.localeCompare(b, currentLanguage()));
    const options = [option('', t('All projects')), ...sorted.map(([id, name]) => option(id, name))];
    if (none) options.push(option(NO_PROJECT, t('No project')));
    if (chosen.project && !options.some(node => node.value === chosen.project)) chosen.project = '';
    // The sidebar reloads often while chats work: the same choices stay as they are, so an open
    // dropdown is not closed under the pointer.
    const same = projectFilter.options.length === options.length &&
      options.every((node, index) => projectFilter!.options[index]!.value === node.value && projectFilter!.options[index]!.textContent === node.textContent);
    if (!same) projectFilter.replaceChildren(...options);
    projectFilter.value = chosen.project;
  };

  const rowNode = (row: WorkLogRow): HTMLElement => {
    const item = el('li', 'work-log-item');
    const button = el('button', 'work-log-row') as HTMLButtonElement;
    button.type = 'button';
    button.dataset.sessionId = row.id;
    button.dataset.outcome = row.outcome;
    const time = el('time', 'work-log-time', new Date(row.endedAt).toLocaleTimeString(currentLanguage(), { hour: 'numeric', minute: '2-digit' }));
    time.setAttribute('datetime', new Date(row.endedAt).toISOString());
    const title = el('span', 'work-log-title', row.title);
    title.dir = 'auto';
    button.append(time, el('span', 'work-log-outcome', outcomeLabel(row.outcome)), title);
    if (row.project) button.append(el('span', 'work-log-project', row.project.name));
    button.onclick = () => { closeDialog(); deps.open(row.id); };
    item.append(button);
    return item;
  };

  const paint = (): void => {
    if (!body) return;
    const all = workLogRows(deps.chats(), deps);
    paintProjects(all);
    const rows = all.filter(row => (!chosen.project || (row.project?.id ?? NO_PROJECT) === chosen.project) &&
      (!chosen.outcome || row.outcome === chosen.outcome));
    const days: HTMLElement[] = [];
    let list: HTMLElement | null = null;
    let current = '';
    for (const row of rows) {
      const key = dayKey(row.endedAt);
      if (key !== current || !list) {
        current = key;
        const section = el('section', 'work-log-day');
        list = el('ul', 'work-log-list');
        section.append(el('h3', 'work-log-day-head', workLogDay(row.endedAt)), list);
        days.push(section);
      }
      list.append(rowNode(row));
    }
    if (!rows.length) days.push(el('p', 'work-log-empty', all.length ? t('No chats match these filters.') : t('No finished turns yet.')));
    // A repaint keeps keyboard focus on the row it was on, wherever that row moved to.
    const active = document.activeElement;
    const focused = active && body.contains(active) ? active.closest<HTMLElement>('.work-log-row')?.dataset.sessionId : undefined;
    body.replaceChildren(...days);
    if (focused) [...body.querySelectorAll<HTMLElement>('.work-log-row')].find(row => row.dataset.sessionId === focused)?.focus();
  };

  const filter = (label: () => string, pick: (value: string) => void): HTMLSelectElement => {
    const select = document.createElement('select');
    select.className = 'work-log-filter';
    ui(select, 'aria-label', label);
    select.onchange = () => { pick(select.value); paint(); };
    return select;
  };

  return {
    open() {
      if (dialog?.open) return;
      dialog?.remove();
      const box = document.createElement('dialog');
      box.className = 'plugin-dialog work-log-dialog';
      const head = el('div', 'plugin-dialog-head');
      const heading = el('h2', '', () => t('Work log'));
      heading.id = 'workLogTitle';
      box.setAttribute('aria-labelledby', heading.id);
      const close = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
      close.type = 'button';
      close.onclick = closeDialog;
      head.append(heading, close);
      const content = el('div', 'plugin-dialog-body');
      const bar = el('div', 'work-log-filters');
      projectFilter = filter(() => t('Project'), value => { chosen = { ...chosen, project: value }; });
      outcomeFilter = filter(() => t('Outcome'), value => { chosen = { ...chosen, outcome: value }; });
      outcomeFilter.replaceChildren(option('', t('All outcomes')), ...OUTCOMES.map(outcome => option(outcome, outcomeLabel(outcome))));
      outcomeFilter.value = chosen.outcome;
      bar.append(projectFilter, outcomeFilter);
      body = el('div', 'work-log-days');
      content.append(el('p', 'work-log-note', () => t("Each chat's last finished turn, newest first.")), bar, body);
      box.append(head, content);
      box.addEventListener('close', () => {
        box.remove();
        if (dialog === box) { dialog = null; body = null; projectFilter = null; outcomeFilter = null; }
      });
      document.body.append(box);
      dialog = box;
      paint();
      if (typeof box.showModal === 'function') box.showModal(); else box.setAttribute('open', '');
      close.focus();
    },
    /** Repaints an open log from the sidebar's latest list; a closed one costs nothing. */
    update: paint
  };
}
