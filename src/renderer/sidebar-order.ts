/** Sidebar order is a local presentation preference; session/project ownership never changes. */
const STORAGE_KEY = 'chat-on-steroids.sidebar-order';
const SORT_KEY = 'chat-on-steroids.sidebar-sort';
const MAX_IDS = 5000;
export const SIDEBAR_PROJECT_SCOPE = ':projects';
/** How the project tree is ordered: the hand order, latest activity first, or by name. */
export const SIDEBAR_SORTS = ['manual', 'recent', 'name'] as const;
export type SidebarSort = typeof SIDEBAR_SORTS[number];
/** What a row is sorted by outside the hand order. */
export type SortKeys<T> = { recent: (row: T) => number; name: (row: T) => string };
type Entry = { id: string; scope: string };

export function createSidebarOrder(list: HTMLElement, entries: () => Entry[], repaint: () => void) {
  const orders = new Map<string, string[]>();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const saved: unknown = raw && raw.length <= 600_000 ? JSON.parse(raw) : [];
    let count = 0;
    if (Array.isArray(saved)) for (const item of saved) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [scope, ids] = item;
      if (typeof scope !== 'string' || scope.length > 160 || !Array.isArray(ids)) continue;
      const valid = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 160))];
      if (count + valid.length > MAX_IDS) break;
      orders.set(scope, valid); count += valid.length;
    }
  } catch { /* Unavailable/corrupt layout storage must not prevent opening chats. */ }
  let mode: SidebarSort = 'manual';
  try {
    const saved = window.localStorage.getItem(SORT_KEY);
    if (SIDEBAR_SORTS.includes(saved as SidebarSort)) mode = saved as SidebarSort;
  } catch { /* The hand order is the default. */ }
  list.classList.toggle('is-auto-sorted', mode !== 'manual');
  // Names compare in the app language, built once per language rather than on every repaint.
  let collator: { lang: string; compare: (a: string, b: string) => number } | undefined;

  /**
   * Rows in the hand order or, given `keys`, in the chosen sort. Equal keys keep the hand order, and
   * a sort never rewrites it: switching back to Manual finds it intact.
   */
  function ordered<T extends { id: string }>(scope: string, rows: T[], keys?: SortKeys<T>): T[] {
    const rank = new Map((orders.get(scope) ?? []).map((id, index) => [id, index]));
    // Newly encountered chats precede the saved sequence, preserving their native order.
    const manual = [...rows].sort((a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1));
    if (!keys || mode === 'manual') return manual;
    if (mode === 'recent') return manual.sort((a, b) => keys.recent(b) - keys.recent(a));
    const lang = document.documentElement.lang;
    if (collator?.lang !== lang) collator = { lang, compare: new Intl.Collator(lang || undefined, { numeric: true, sensitivity: 'base' }).compare };
    const compare = collator.compare;
    return manual.sort((a, b) => compare(keys.name(a), keys.name(b)));
  }

  function setMode(next: SidebarSort): void {
    if (next === mode) return;
    mode = next;
    list.classList.toggle('is-auto-sorted', mode !== 'manual');
    try { window.localStorage.setItem(SORT_KEY, mode); }
    catch { /* Keep the choice in this window when layout storage is unavailable. */ }
    repaint();
  }

  function move(id: string, target: string, after: boolean, scope: string): void {
    const members = entries().filter(entry => entry.scope === scope);
    if (id === target || !members.some(entry => entry.id === id) || !members.some(entry => entry.id === target)) return;
    const current = ordered(scope, members).map(entry => entry.id);
    const next = current.filter(key => key !== id);
    next.splice(next.indexOf(target) + Number(after), 0, id);
    if (next.every((key, index) => key === current[index])) return;
    // Off-page members keep their slots. A partial list is never deletion evidence.
    const present = new Set(current);
    const previous = orders.get(scope) ?? [];
    let index = 0;
    const merged = previous.map(key => present.has(key) ? next[index++]! : key);
    merged.push(...next.slice(index));
    orders.delete(scope); orders.set(scope, merged);
    let remaining = MAX_IDS;
    const bounded = [...orders].reverse().map(([key, ids]) => {
      const kept = ids.slice(0, remaining); remaining -= kept.length;
      return [key, kept] as const;
    }).filter(([, ids]) => ids.length).reverse();
    orders.clear(); for (const [key, ids] of bounded) orders.set(key, ids);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bounded)); }
    catch { /* Keep the order in this window when layout storage is unavailable. */ }
  }

  let drag: { pointer: number; id: string; scope: string; x: number; y: number; row: HTMLElement; active: boolean; target?: string; after?: boolean } | null = null;
  let suppressClick = false;
  const rowId = (row: HTMLElement): string | undefined => row.dataset.sortId ?? row.dataset.id;
  const handle = (row: HTMLElement): HTMLElement => row.querySelector<HTMLElement>('[data-sort-handle]') ?? row;
  const rows = (scope: string) => [...list.querySelectorAll<HTMLElement>('[data-sort-scope]')]
    .filter(row => row.dataset.sortScope === scope && row.getClientRects().length > 0);
  function clearMarkers(): void {
    for (const row of list.querySelectorAll('.sort-before, .sort-after')) row.classList.remove('sort-before', 'sort-after');
  }
  function finish(commit: boolean): void {
    const current = drag;
    if (!current) return;
    drag = null;
    if (commit && current.active && current.target) move(current.id, current.target, !!current.after, current.scope);
    current.row.classList.remove('is-sorting'); list.classList.remove('is-sorting'); clearMarkers();
    if (list.hasPointerCapture(current.pointer)) list.releasePointerCapture(current.pointer);
    // Normal clicks retain the original row until their selection handler has run.
    if (current.active) {
      repaint();
      // Replacing the captured row can cancel Chromium's synthetic drop click entirely.
      // Suppress only this gesture, never a later keyboard/programmatic button click.
      window.requestAnimationFrame(() => { suppressClick = false; });
    }
  }
  list.addEventListener('pointerdown', event => {
    suppressClick = false;
    // A sorted list has no hand order to change: dragging is for Manual only.
    if (mode !== 'manual' || event.button !== 0 || event.isPrimary === false || drag || (event.target as Element).closest('button, input, a')) return;
    const row = (event.target as Element).closest<HTMLElement>('[data-sort-scope]');
    const id = row && rowId(row);
    if (!row || !id || !list.contains(row) || !handle(row).contains(event.target as Node)) return;
    drag = { pointer: event.pointerId, id, scope: row.dataset.sortScope!, x: event.clientX, y: event.clientY, row, active: false };
  });
  list.addEventListener('pointermove', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    if (!drag.active) {
      drag.active = true; suppressClick = true;
      list.setPointerCapture(event.pointerId);
      list.classList.add('is-sorting'); drag.row.classList.add('is-sorting');
      document.getElementById('sessionTooltip')?.remove();
    }
    event.preventDefault();
    const scroll = list.closest<HTMLElement>('.scroll');
    if (scroll) {
      const bounds = scroll.getBoundingClientRect();
      if (event.clientY < bounds.top + 28) scroll.scrollTop -= 18;
      else if (event.clientY > bounds.bottom - 28) scroll.scrollTop += 18;
    }
    const candidates = rows(drag.scope).filter(row => rowId(row) !== drag!.id);
    clearMarkers();
    const before = candidates.find(row => { const rect = row.getBoundingClientRect(); return event.clientY < rect.top + rect.height / 2; });
    const target = before ?? candidates.at(-1);
    drag.target = target && rowId(target); drag.after = !before;
    target?.classList.add(before ? 'sort-before' : 'sort-after');
  });
  window.addEventListener('pointerup', event => { if (event.pointerId === drag?.pointer) finish(true); });
  window.addEventListener('pointercancel', event => { if (event.pointerId === drag?.pointer) finish(false); });
  list.addEventListener('lostpointercapture', () => finish(false));
  window.addEventListener('blur', () => finish(false));
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); finish(false); }
  });
  list.addEventListener('click', event => {
    if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  list.addEventListener('keydown', event => {
    if (mode !== 'manual' || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const row = (event.target as Element).closest<HTMLElement>('[data-sort-scope]');
    const id = row && rowId(row);
    if (!row || !id || event.target !== handle(row)) return;
    const siblings = rows(row.dataset.sortScope!);
    const target = siblings[siblings.indexOf(row) + (event.key === 'ArrowUp' ? -1 : 1)];
    event.preventDefault();
    const targetId = target && rowId(target);
    if (!targetId) return;
    move(id, targetId, event.key === 'ArrowDown', row.dataset.sortScope!);
    repaint();
    const replacement = [...list.querySelectorAll<HTMLElement>('[data-sort-scope]')]
      .find(next => rowId(next) === id && next.dataset.sortScope === row.dataset.sortScope);
    if (replacement) handle(replacement).focus({ preventScroll: true });
  });
  return { ordered, setMode, get mode() { return mode; }, get interacting() { return drag !== null; } };
}
