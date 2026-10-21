import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatMap, createChatMap, filterMap, type MapSource } from '../src/renderer/chat-map.js';
import { structureTimeline, type FlowRow } from '../src/renderer/timeline-rounds.js';
import type { SessionEvent } from '../src/shared/session.js';
import type { TurnTrace } from '../src/shared/turn-trace.js';

let seq = 0;
const text = (value: string) => ({ text: value, chars: value.length, truncated: false });
const base = (turnId = 'turn-1') => ({ seq: ++seq, time: 1_000 + seq, source: 'extension' as const, turnId });
const user = (value: string, extra: Record<string, unknown> = {}) =>
  ({ ...base(), kind: 'user_message', messageId: `q${seq}`, message: text(value), ...extra }) as unknown as SessionEvent;
const call = (title: string, outcome = 'ok', turnId = 'turn-1') =>
  ({ ...base(turnId), kind: 'tool_call', call: { callId: `c${seq}`, tool: 'exec_command', outcome, summary: { kind: 'command', title, tone: 'neutral' } } }) as unknown as SessionEvent;
const answer = (turnId = 'turn-1') => ({ ...base(turnId), kind: 'assistant_message', message: text('Done'), final: true, state: 'final' }) as unknown as SessionEvent;
const chatError = (value: string) => ({ ...base(), kind: 'chat_error', message: text(value) }) as unknown as SessionEvent;

/** The parts the timeline draws for `events`, each pointing at the row key the timeline gives it. */
function sources(events: SessionEvent[], traces: Record<string, TurnTrace> = {}, working = false): MapSource[] {
  const rows: FlowRow[] = events.map(event => ({ key: `event:${event.seq}`, event }));
  const byKey = new Map(rows.map(row => [row.key, row.event!]));
  return structureTimeline(rows, traces, working).map(part => ({
    part,
    target: part.kind === 'work' ? `group:${part.key}` : part.kind === 'say' ? part.key : part.key,
    events: part.kind === 'work' ? part.rows.map(key => byKey.get(key)!) : part.kind === 'row' ? [byKey.get(part.key)!] : []
  }));
}

describe('chat map outline', () => {
  it('lists each question with the rounds that answered it, their recaps, action counts and failed calls', () => {
    const first = user('Fix the   failing\n tests');
    const read = call('Ran npm test'), fail = call('Ran npm run lint', 'process_exit_nonzero');
    const second = call('Edited src/a.ts', 'ok', 'turn-1');
    const trace: TurnTrace = [
      { kind: 'call', id: read.kind === 'tool_call' ? read.call.callId : '', tool: 'exec_command', done: true },
      { kind: 'call', id: fail.kind === 'tool_call' ? fail.call.callId : '', tool: 'exec_command', done: true },
      { kind: 'recap', text: 'Checked the test suite' },
      { kind: 'call', id: second.kind === 'tool_call' ? second.call.callId : '', tool: 'exec_command', done: true }
    ];
    const done = answer();
    const later = user('Now update the docs', { turnId: 'turn-2' });
    const map = chatMap(sources([first, read, fail, second, done, later], { 'turn-1': trace }));
    expect(map.map(prompt => [prompt.number, prompt.text, prompt.edited])).toEqual([[1, 'Fix the failing tests', false], [2, 'Now update the docs', false]]);
    expect(map[0]!.target).toBe(`event:${first.seq}`);
    expect(map[0]!.rounds.map(round => [round.label, round.actions, round.failed, round.live])).toEqual([
      ['Checked the test suite', 2, 1, false],
      // A round without a recap is titled with its latest action, as the timeline titles it.
      ['Edited src/a.ts', 1, 0, false]
    ]);
    expect(map[0]!.rounds.every(round => round.target.startsWith('group:'))).toBe(true);
    expect(map[1]!.rounds).toEqual([]);
  });

  it('places a chat error under its question, marks edited questions and keeps work before any question apart', () => {
    const early = call('Read README.md', 'ok', 'turn-0');
    const question = user('Try again', { replaces: 'q-old' });
    const broken = chatError('Something went wrong while generating the response.');
    const map = chatMap(sources([early, answer('turn-0'), question, broken]));
    expect(map.map(prompt => [prompt.number, prompt.target, prompt.edited])).toEqual([[0, null, false], [1, `event:${question.seq}`, true]]);
    expect(map[0]!.rounds.map(round => round.label)).toEqual(['Read README.md']);
    expect(map[1]!.rounds).toEqual([{ target: `event:${broken.seq}`, label: 'Something went wrong while generating the response.',
      actions: 0, failed: 0, live: false, error: true }]);
  });

  it('marks the running round live', () => {
    const question = user('Build it');
    const running = call('Ran npm run build');
    const map = chatMap(sources([question, running], {}, true));
    expect(map[0]!.rounds.map(round => round.live)).toEqual([true]);
  });

  it('filters to the rounds with errors, or to edited questions', () => {
    const map = chatMap(sources([user('One'), call('Ran a'), answer(), user('Two', { replaces: 'q-x' }), call('Ran b', 'tool_execution_error'),
      call('Ran c'), answer(), user('Three'), chatError('Network error')]));
    expect(filterMap(map, 'all')).toEqual(map);
    expect(filterMap(map, 'errors').map(prompt => [prompt.text, prompt.rounds.map(round => round.label)]))
      .toEqual([['Two', ['Ran c']], ['Three', ['Network error']]]);
    expect(filterMap(map, 'edits').map(prompt => prompt.text)).toEqual(['Two']);
  });
});

describe('chat map panel', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());
  function setup() {
    dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true });
    Object.assign(globalThis, { document: dom.window.document, window: dom.window, CSS: { escape: (value: string) => value.replace(/["\\]/g, '\\$&') } });
    const onJump = vi.fn(), onEscape = vi.fn();
    const map = createChatMap({ onJump, onEscape });
    const mount = document.getElementById('mount')!;
    return { map, mount, onJump, onEscape };
  }
  const outline = () => chatMap(sources([user('First question'), call('Ran a'), call('Ran b', 'tool_rejected'), answer(),
    user('Second question', { replaces: 'q-old' }), chatError('Network error')]));

  it('jumps to the row of the question or round clicked, and marks it as the current place', () => {
    const { map, mount, onJump } = setup();
    map.update(outline());
    // Hidden, it draws nothing until it opens.
    expect(mount.childElementCount).toBe(0);
    map.show(mount);
    const nodes = [...mount.querySelectorAll<HTMLButtonElement>('.chat-map-node')];
    expect(nodes.map(node => node.textContent)).toEqual(['1First question', 'Ran b21 failed', '2Second questionEdited', 'Network error']);
    expect(nodes[1]!.title).toBe('2 actions · Ran b · 1 failed');
    expect(nodes[1]!.classList.contains('is-failed')).toBe(true);
    nodes[1]!.click();
    expect(onJump).toHaveBeenCalledWith(nodes[1]!.dataset.target);
    expect(nodes[1]!.classList.contains('is-current')).toBe(true);
    nodes[2]!.click();
    expect(onJump).toHaveBeenLastCalledWith(nodes[2]!.dataset.target);
    expect(mount.querySelectorAll('.is-current')).toHaveLength(1);
  });

  it('filters in place, says when nothing matches, and steps through the nodes with the arrow keys', () => {
    const { map, mount, onEscape } = setup();
    map.show(mount);
    expect(mount.querySelector<HTMLElement>('.chat-map-empty')!.hidden).toBe(false);
    expect(mount.querySelector('.chat-map-empty')!.textContent).toBe('Nothing to map yet');
    map.update(outline());
    expect(mount.querySelector<HTMLElement>('.chat-map-empty')!.hidden).toBe(true);
    const filter = (key: string) => mount.querySelector<HTMLButtonElement>(`.chat-map-filter[data-filter="${key}"]`)!;
    expect(filter('all').getAttribute('aria-pressed')).toBe('true');
    filter('edits').click();
    expect(filter('edits').getAttribute('aria-pressed')).toBe('true');
    expect([...mount.querySelectorAll('.chat-map-node.is-prompt')].map(node => node.textContent)).toEqual(['2Second questionEdited']);
    filter('errors').click();
    expect([...mount.querySelectorAll('.chat-map-node')].map(node => node.textContent)).toEqual(['1First question', 'Ran b21 failed', '2Second questionEdited', 'Network error']);
    const fine = [user('Fine'), call('Ran a'), answer()];
    map.update(chatMap(sources(fine)));
    expect(mount.querySelector('.chat-map-empty')!.textContent).toBe('No errors in the loaded part of this chat');
    filter('all').click();
    const nodes = [...mount.querySelectorAll<HTMLButtonElement>('.chat-map-node')];
    nodes[0]!.focus();
    nodes[0]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(nodes[1]);
    // A repaint while stepping keeps the focused node.
    map.update(chatMap(sources([...fine, user('More')])));
    expect((document.activeElement as HTMLElement).dataset.target).toBe(nodes[1]!.dataset.target);
    (document.activeElement as HTMLElement).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement!.textContent).toBe('2More');
    document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onEscape).toHaveBeenCalledOnce();
  });
});
