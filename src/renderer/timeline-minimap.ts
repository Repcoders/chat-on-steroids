import { t, ui } from './i18n.js';

/**
 * Your messages in the open chat as a column of dashes beside it (a proximity minimap), and
 * Alt+Up/Down to step between them.
 *
 * One dash per message of yours in the loaded rows, in order. A dash is full width while its part
 * of the chat (from the message to your next one) is on screen and shrinks with distance from the
 * view, so the column shows where you are reading without a scrollbar of its own. The dashes
 * brighten while the chat scrolls and fade back after. A click, or Alt+Up/Down while the chat has
 * focus, puts that message at the top of the view. Moving there is reading: `jumped` releases
 * following the chat's end before the scroll starts.
 *
 * Only the loaded rows are drawn. History further up joins the column when it is loaded, by
 * scrolling up as before; nothing here reads history of its own.
 */

/** A dash far from the view, as a share of the full width. */
export const MIN_SCALE = 0.35;
/** Room above a message the reader moved to, as a sent message keeps it. */
export const TOP_GAP = 12;
/** How long the dashes stay bright after the chat last scrolled. */
export const PULSE_MS = 900;
const PREVIEW_CHARS = 80;
/** A smooth jump still on its way counts as arrived after this, even without a `scrollend`. */
const JUMP_SETTLE_MS = 1000;

/** A dash's width for a part of the chat `gap` pixels from the view: full on screen, smallest from `reach` on. */
export function proximityScale(gap: number, reach: number): number {
  const near = reach > 0 ? Math.max(0, 1 - Math.max(0, gap) / reach) : gap <= 0 ? 1 : 0;
  return MIN_SCALE + (1 - MIN_SCALE) * near;
}

/** Where the next (1) or previous (-1) message starts, from a view starting at `from`; `starts` in order. */
export function jumpTarget(starts: readonly number[], from: number, direction: 1 | -1): number | null {
  return (direction > 0 ? starts.find(start => start > from + 1) : starts.findLast(start => start < from - 1)) ?? null;
}

/** The first words of a message, for the dash's tooltip and name. */
function preview(row: HTMLElement): string {
  const text = (row.querySelector('.user-message-text') ?? row.querySelector('.said'))?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : text;
}

export interface TimelineMinimapOptions {
  /** The scroll pane the chat shows in. */
  pane: HTMLElement;
  /** The timeline's rows. */
  timeline: HTMLElement;
  /** Whether a chat's timeline is what the pane shows. */
  shown: () => boolean;
  /** The reader moved to a message on purpose; called before the scroll starts. */
  jumped: () => void;
}

export interface TimelineMinimap {
  element: HTMLElement;
  /** Draws the dashes again from the loaded rows. Call after the timeline changed. */
  paint: () => void;
}

export function initTimelineMinimap(options: TimelineMinimapOptions): TimelineMinimap {
  const { pane, timeline } = options;
  const nav = document.createElement('nav');
  nav.className = 'timeline-minimap';
  nav.hidden = true;
  nav.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
  ui(nav, 'aria-label', () => t('Your messages'));
  let rows: HTMLElement[] = [];
  let dashes: HTMLButtonElement[] = [];
  let frame: number | null = null;
  let pulse: ReturnType<typeof setTimeout> | null = null;
  /** Where a smooth jump is headed, so a second Alt+Down goes on from there. */
  let heading: { top: number; until: number } | null = null;

  const messages = (): HTMLElement[] => [...timeline.querySelectorAll<HTMLElement>('.ev-user_message[data-timeline-key]')]
    .filter(row => !row.closest('[hidden], .earlier-version'));
  /** Each message's position in the pane's scroll content. */
  const starts = (): number[] => {
    const edge = pane.getBoundingClientRect().top;
    return rows.map(row => pane.scrollTop + row.getBoundingClientRect().top - edge);
  };
  const reduced = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const update = (): void => {
    frame = null;
    if (nav.hidden) return;
    const at = starts();
    const top = pane.scrollTop, bottom = top + pane.clientHeight;
    let current = -1;
    at.forEach((start, index) => {
      const end = at[index + 1] ?? pane.scrollHeight;
      const gap = start > bottom ? start - bottom : end < top ? top - end : 0;
      dashes[index]!.style.setProperty('--dash-scale', proximityScale(gap, pane.clientHeight).toFixed(3));
      if (start <= top + TOP_GAP + 1) current = index;
    });
    dashes.forEach((dash, index) => {
      if (index === current) dash.setAttribute('aria-current', 'location');
      else dash.removeAttribute('aria-current');
    });
  };
  const schedule = (): void => {
    if (frame === null) frame = window.requestAnimationFrame(update);
  };

  const jumpTo = (top: number): void => {
    const target = Math.max(0, Math.min(top, pane.scrollHeight - pane.clientHeight));
    options.jumped();
    const smooth = !reduced() && typeof pane.scrollTo === 'function';
    heading = smooth ? { top: target, until: Date.now() + JUMP_SETTLE_MS } : null;
    if (smooth) pane.scrollTo({ top: target, behavior: 'smooth' });
    else pane.scrollTop = target;
    schedule();
  };

  const paint = (): void => {
    const next = messages();
    const same = next.length === rows.length && next.every((row, index) => row === rows[index]);
    rows = next;
    if (!same) {
      dashes = rows.map((_, index) => {
        const dash = document.createElement('button');
        dash.type = 'button';
        dash.className = 'timeline-minimap-dash';
        // One tab stop for the chat, not one per message: the keyboard has Alt+Up/Down.
        dash.tabIndex = -1;
        dash.append(document.createElement('span'));
        dash.addEventListener('click', () => {
          const row = rows[index];
          if (!row?.isConnected) return;
          jumpTo(starts()[index]! - TOP_GAP);
        });
        return dash;
      });
      nav.replaceChildren(...dashes);
    }
    rows.forEach((row, index) => {
      const words = preview(row);
      const label = words || t('Message {0}', [index + 1]);
      if (dashes[index]!.title !== label) { dashes[index]!.title = label; dashes[index]!.setAttribute('aria-label', label); }
    });
    nav.hidden = !options.shown() || rows.length < 2 || pane.scrollHeight <= pane.clientHeight + 1;
    if (frame !== null) window.cancelAnimationFrame(frame);
    update();
  };

  pane.addEventListener('scroll', () => {
    if (nav.hidden) return;
    nav.classList.add('is-active');
    if (pulse !== null) clearTimeout(pulse);
    pulse = setTimeout(() => { pulse = null; nav.classList.remove('is-active'); }, PULSE_MS);
    schedule();
  }, { passive: true });
  pane.addEventListener('scrollend', () => { heading = null; }, { passive: true });
  // The reader's own scrolling takes over from a jump still on its way.
  for (const type of ['wheel', 'touchstart', 'pointerdown'] as const) pane.addEventListener(type, () => { heading = null; }, { passive: true });
  // Whether the chat still overflows can change without a scroll or a new row: a resized window or
  // pane, an opened disclosure. Check again whenever the pane or its rows change size.
  if (typeof ResizeObserver === 'function') {
    const sizes = new ResizeObserver(() => paint());
    sizes.observe(pane); sizes.observe(timeline);
  } else window.addEventListener('resize', paint);

  document.addEventListener('keydown', event => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.defaultPrevented) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const target = event.target as Element | null;
    const inChat = !target || target === document.body || target === document.documentElement || pane.contains(target) || nav.contains(target);
    if (!inChat || target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || !options.shown()) return;
    paint();
    if (!rows.length) return;
    const from = heading && Date.now() < heading.until ? heading.top : pane.scrollTop;
    const top = jumpTarget(starts().map(start => start - TOP_GAP), from, event.key === 'ArrowDown' ? 1 : -1);
    event.preventDefault();
    if (top !== null) jumpTo(top);
  });

  return { element: nav, paint };
}
