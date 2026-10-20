import { el } from './dom.js';
import { t, ui } from './i18n.js';

/**
 * The sidebar's state filter: every chat, only those working, only those that need the person, or
 * only the pinned ones. Both layouts draw the same control and ask the same question of a chat. It is
 * window-local, like disclosure state, and never changes a chat, its project or its order.
 */
export type SidebarFilter = 'all' | 'working' | 'attention' | 'pinned';

/** What a chat is doing, its sub-agents counted as its own, read by the caller from main-owned state. */
export type SidebarFilterFacts = { working: boolean; attention: boolean; pinned: boolean };

export function sidebarFilterMatches(filter: SidebarFilter, facts: SidebarFilterFacts): boolean {
  if (filter === 'all') return true;
  return filter === 'working' ? facts.working : filter === 'attention' ? facts.attention : facts.pinned;
}

const FILTERS: ReadonlyArray<[SidebarFilter, () => string]> = [
  ['all', () => t('All')],
  ['working', () => t('Working')],
  ['attention', () => t('Needs you')],
  ['pinned', () => t('Pinned')]
];

/**
 * One row of pressed-or-not buttons, the app's segmented control. The same node moves between the
 * layouts, so a repaint that keeps it attached keeps keyboard focus on it too.
 */
export function createSidebarFilter(changed: () => void) {
  let value: SidebarFilter = 'all';
  const element = el('div', 'seg sidebar-filter');
  element.setAttribute('role', 'group');
  ui(element, 'aria-label', () => t('Filter chats'));
  const buttons = FILTERS.map(([id, label]) => {
    const button = el('button', '', label) as HTMLButtonElement;
    button.type = 'button';
    button.dataset.sidebarFilter = id;
    // The Inbox keeps focus on its header controls by this name across a repaint.
    button.dataset.inboxControl = `filter-${id}`;
    // A narrow sidebar can cut a label short; the full word stays on hover.
    ui(button, 'title', label);
    button.addEventListener('click', () => {
      if (value === id) return;
      value = id;
      sync();
      changed();
    });
    return button;
  });
  function sync(): void {
    for (const button of buttons) {
      // Drawn from aria-pressed: `.is-sel` in the sidebar means the selected chat.
      button.setAttribute('aria-pressed', String(button.dataset.sidebarFilter === value));
    }
  }
  element.append(...buttons);
  sync();
  return { element, get value(): SidebarFilter { return value; } };
}
