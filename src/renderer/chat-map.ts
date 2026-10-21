import type { SessionEvent } from '../shared/session.js';
import { normalizedToolOutcome, toolCallSummary } from '../shared/session.js';
import { userPromptText } from '../shared/user-prompt.js';
import type { RoundPart } from './timeline-rounds.js';
import { el, icon } from './dom.js';
import { t, tn, ui } from './i18n.js';

/**
 * The Chat map in the right dock: the open chat as an outline. Each of your questions, then the
 * rounds of work that answered it (titled with ChatGPT's recap, else the round's latest action), with
 * their action counts and failed calls, and the chat's errors where they happened.
 *
 * It reads the rounds the timeline drew (timeline-rounds.ts) and points at the rows that show them,
 * so a click lands on what the timeline shows, open or folded. It covers the pages the timeline has
 * loaded, nothing older.
 */

/** One drawn part of the timeline: the part, the key of the row that shows it, and the events of its rows. */
export interface MapSource { part: RoundPart; target: string | undefined; events: readonly SessionEvent[] }
export interface MapRound { target: string; label: string; actions: number; failed: number; live: boolean; error: boolean }
/** `number` counts your questions from 1; 0 is what came before the first one. */
export interface MapPrompt { target: string | null; number: number; text: string; edited: boolean; rounds: MapRound[] }
export type MapFilter = 'all' | 'errors' | 'edits';

const failedCall = (event: SessionEvent): boolean => {
  if (event.kind !== 'tool_call' || event.call.nested) return false;
  const outcome = normalizedToolOutcome(event.call);
  return outcome !== null && outcome !== 'ok';
};

/** What a round without a recap is doing: its latest action, as the timeline titles it. */
function latestAction(events: readonly SessionEvent[]): string {
  for (const event of [...events].reverse()) {
    if (event.kind === 'tool_call') return toolCallSummary(event.call).title;
    if (event.kind === 'page_tool') return event.label;
  }
  return '';
}

export function chatMap(sources: readonly MapSource[]): MapPrompt[] {
  const out: MapPrompt[] = [];
  let asked = 0;
  const current = (): MapPrompt => {
    if (!out.length) out.push({ target: null, number: 0, text: '', edited: false, rounds: [] });
    return out.at(-1)!;
  };
  for (const { part, target, events } of sources) {
    if (!target || part.kind === 'say') continue;
    if (part.kind === 'row') {
      const event = events[0];
      if (event?.kind === 'user_message') {
        const text = event.authoredText ?? userPromptText(event.message.text.trimStart()) ?? event.message.text;
        out.push({ target, number: ++asked, text: text.replace(/\s+/g, ' ').trim(),
          edited: !!event.replaces, rounds: [] });
      } else if (event?.kind === 'chat_error') {
        current().rounds.push({ target, label: event.message.text, actions: 0, failed: 0, live: false, error: true });
      }
      continue;
    }
    current().rounds.push({ target, label: part.recap ?? latestAction(events), actions: events.length,
      failed: events.filter(failedCall).length, live: part.live, error: false });
  }
  return out;
}

/** Errors keeps the questions with an error or a failed call, and only those rounds; Edits keeps edited questions. */
export function filterMap(prompts: readonly MapPrompt[], filter: MapFilter): MapPrompt[] {
  if (filter === 'edits') return prompts.filter(prompt => prompt.edited);
  if (filter === 'all') return [...prompts];
  return prompts.flatMap(prompt => {
    const rounds = prompt.rounds.filter(round => round.error || round.failed > 0);
    return rounds.length ? [{ ...prompt, rounds }] : [];
  });
}

export function createChatMap(options: { onJump: (target: string) => void; onEscape?: () => void }) {
  const pane = el('section', 'chat-map'); pane.hidden = true;
  ui(pane, 'aria-label', () => t('Chat map'));
  const filters = el('div', 'chat-map-filters'); filters.setAttribute('role', 'group');
  ui(filters, 'aria-label', () => t('Chat map filter'));
  const list = el('ol', 'chat-map-list');
  const empty = el('p', 'chat-map-empty');
  pane.append(filters, list, empty);
  let filter: MapFilter = 'all', prompts: MapPrompt[] = [], signature = '', current: string | null = null;
  const choices = new Map<MapFilter, HTMLButtonElement>();
  for (const [key, label] of [['all', () => t('All')], ['errors', () => t('Errors')], ['edits', () => t('Edits')]] as const) {
    const choice = el('button', 'chat-map-filter', label) as HTMLButtonElement;
    choice.type = 'button'; choice.dataset.filter = key;
    choice.addEventListener('click', () => { filter = key; paint(); });
    choices.set(key, choice); filters.append(choice);
  }

  const node = (target: string | null, className: string): HTMLButtonElement => {
    const button = el('button', `chat-map-node ${className}`) as HTMLButtonElement;
    button.type = 'button';
    if (target) {
      button.dataset.target = target;
      button.classList.toggle('is-current', target === current);
      button.addEventListener('click', () => {
        current = target;
        for (const other of list.querySelectorAll<HTMLElement>('.chat-map-node')) other.classList.toggle('is-current', other === button);
        options.onJump(target);
      });
    } else button.disabled = true;
    return button;
  };
  const roundItem = (round: MapRound): HTMLElement => {
    const button = node(round.target, `is-round${round.error ? ' is-error' : ''}${round.failed ? ' is-failed' : ''}${round.live ? ' is-live' : ''}`);
    const label = round.label || t('Activity');
    button.append(icon(round.error || round.failed ? 'i-warning' : round.live ? 'i-pulse' : 'i-check-circle'),
      el('span', 'chat-map-text', label));
    if (round.actions > 1) button.append(el('span', 'chat-map-count', String(round.actions)));
    if (round.failed) button.append(el('span', 'chat-map-failed', () => tn('{0} failed', '{0} failed', round.failed)));
    ui(button, 'title', () => round.error ? label : [tn('{0} action · {1}', '{0} actions · {1}', round.actions, [round.actions, label]),
      ...round.failed ? [tn('{0} failed', '{0} failed', round.failed)] : []].join(' · '));
    const item = el('li'); item.append(button);
    return item;
  };
  const promptItem = (prompt: MapPrompt): HTMLElement => {
    const button = node(prompt.target, 'is-prompt');
    button.append(el('span', 'chat-map-number', prompt.number ? String(prompt.number) : ''),
      prompt.number ? el('span', 'chat-map-text', prompt.text) : el('span', 'chat-map-text', () => t('Start of chat')));
    if (prompt.edited) button.append(el('span', 'chat-map-edited', () => t('Edited')));
    const item = el('li', 'chat-map-prompt'); item.append(button);
    if (prompt.rounds.length) {
      const rounds = el('ol', 'chat-map-rounds'); rounds.append(...prompt.rounds.map(roundItem));
      item.append(rounds);
    }
    return item;
  };
  function paint(): void {
    for (const [key, choice] of choices) {
      choice.setAttribute('aria-pressed', String(key === filter)); choice.classList.toggle('is-selected', key === filter);
    }
    const shown = filterMap(prompts, filter);
    const next = JSON.stringify([filter, shown]);
    if (next === signature) return;
    signature = next;
    // A repaint while the reader steps through the map keeps their place.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.chat-map-node');
    const focusTarget = focused && list.contains(focused) ? focused.dataset.target : undefined;
    list.replaceChildren(...shown.map(promptItem));
    if (focusTarget) list.querySelector<HTMLElement>(`.chat-map-node[data-target="${CSS.escape(focusTarget)}"]`)?.focus();
    empty.hidden = shown.length > 0;
    ui(empty, 'textContent', () => filter === 'errors' ? t('No errors in the loaded part of this chat')
      : filter === 'edits' ? t('No edited questions in the loaded part of this chat') : t('Nothing to map yet'));
  }
  pane.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); options.onEscape?.(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const nodes = [...list.querySelectorAll<HTMLButtonElement>('.chat-map-node:not(:disabled)')];
    if (!nodes.length) return;
    event.preventDefault();
    const index = nodes.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1
      : index < 0 ? 0 : Math.max(0, Math.min(nodes.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    nodes[next]!.focus();
  });

  return {
    element: pane,
    show(mount: HTMLElement): void {
      if (pane.parentElement !== mount) mount.append(pane);
      pane.hidden = false; signature = ''; paint();
    },
    hide(): void { pane.hidden = true; },
    /** The latest outline; drawn now when the map shows, else when it next opens. */
    update(next: MapPrompt[]): void { prompts = next; if (!pane.hidden) paint(); }
  };
}
