import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<div id="pane"><div id="timeline"></div></div><textarea id="composer"></textarea>', { url: 'https://local.test/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'Node', 'HTMLElement', 'Element'] as const) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); dom.window.close(); });

/**
 * A chat of four questions, each 1000px of content apart, in a 400px pane at the top of the window.
 * Rows report where they are on screen from the pane's scroll position, as a browser would.
 */
function chat(questions = ['Plan the login page', 'Add a remember-me box', 'Write the tests', 'Ship it']) {
  const pane = document.getElementById('pane')!;
  const timeline = document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400, configurable: true }, scrollHeight: { value: 4000, configurable: true } });
  pane.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
  timeline.innerHTML = questions.map((words, index) =>
    `<div class="ev ev-user_message" data-timeline-key="message:user_message\u0000q${index}"><div class="said is-user"><div class="msg user-message-text">${words}</div></div></div>` +
    `<div class="ev ev-assistant_message" data-timeline-key="message:assistant_message\u0000a${index}"><div class="said">Answer ${index}</div></div>`).join('');
  [...timeline.querySelectorAll<HTMLElement>('.ev-user_message')].forEach((row, index) => {
    row.getBoundingClientRect = () => ({ top: index * 1000 - pane.scrollTop } as DOMRect);
  });
  return { pane, timeline };
}

async function minimap(shown = () => true) {
  const { pane, timeline } = chat();
  const { initTimelineMinimap } = await import('../src/renderer/timeline-minimap.js');
  const jumped = vi.fn();
  const map = initTimelineMinimap({ pane, timeline, shown, jumped });
  document.body.append(map.element);
  map.paint();
  const dashes = () => [...map.element.querySelectorAll<HTMLButtonElement>('.timeline-minimap-dash')];
  const scale = (index: number) => Number(dashes()[index]!.style.getPropertyValue('--dash-scale'));
  const key = (key: string, target: Element = document.body, init: KeyboardEventInit = { altKey: true }) => {
    const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  return { pane, timeline, map, jumped, dashes, scale, key };
}

it('sizes a dash by how far its part of the chat is from the view', async () => {
  const { proximityScale, MIN_SCALE } = await import('../src/renderer/timeline-minimap.js');
  expect(proximityScale(0, 400)).toBe(1);
  expect(proximityScale(-50, 400)).toBe(1);
  expect(proximityScale(200, 400)).toBeCloseTo((1 + MIN_SCALE) / 2);
  expect(proximityScale(400, 400)).toBe(MIN_SCALE);
  expect(proximityScale(5000, 400)).toBe(MIN_SCALE);
});

it('steps to the next or previous message start from where the view starts', async () => {
  const { jumpTarget } = await import('../src/renderer/timeline-minimap.js');
  const starts = [0, 1000, 2000];
  expect(jumpTarget(starts, 0, 1)).toBe(1000);
  expect(jumpTarget(starts, 1000, 1)).toBe(2000);
  expect(jumpTarget(starts, 2000, 1)).toBeNull();
  // Inside a long answer, up goes back to its own question first.
  expect(jumpTarget(starts, 1500, -1)).toBe(1000);
  expect(jumpTarget(starts, 1000, -1)).toBe(0);
  expect(jumpTarget(starts, 0, -1)).toBeNull();
});

it('draws one dash per message of yours, named by its first words, largest where you read', async () => {
  const { dashes, scale, map, pane, timeline } = await minimap();
  const { MIN_SCALE } = await import('../src/renderer/timeline-minimap.js');
  expect(map.element.hidden).toBe(false);
  expect(map.element.getAttribute('aria-label')).toBe('Your messages');
  expect(dashes().map(dash => dash.getAttribute('aria-label'))).toEqual(['Plan the login page', 'Add a remember-me box', 'Write the tests', 'Ship it']);
  expect(dashes().every(dash => dash.tabIndex === -1)).toBe(true);
  // At the top, the first question's part fills the view; the others are more than a view away.
  expect([0, 1, 2, 3].map(scale)).toEqual([1, MIN_SCALE, MIN_SCALE, MIN_SCALE]);
  expect(dashes()[0]!.getAttribute('aria-current')).toBe('location');
  // Reading the second answer, 100px above the third question.
  pane.scrollTop = 1500;
  map.paint();
  expect(scale(1)).toBe(1);
  expect(scale(2)).toBeCloseTo(MIN_SCALE + (1 - MIN_SCALE) * 0.75, 3);
  expect(scale(0)).toBe(MIN_SCALE);
  expect(dashes().map(dash => dash.hasAttribute('aria-current'))).toEqual([false, true, false, false]);
  // A folded earlier version of an edited question is not a message of its own.
  const fold = document.createElement('div'); fold.className = 'earlier-version';
  fold.innerHTML = '<div class="ev ev-user_message" data-timeline-key="old"><div class="msg user-message-text">Old words</div></div>';
  timeline.append(fold);
  map.paint();
  expect(dashes()).toHaveLength(4);
});

it('stays out of the way with fewer than two messages, a chat that fits, or another view', async () => {
  let shown = true;
  const { map, pane, timeline } = await minimap(() => shown);
  shown = false; map.paint();
  expect(map.element.hidden).toBe(true);
  shown = true;
  Object.defineProperty(pane, 'scrollHeight', { value: 400, configurable: true });
  map.paint();
  expect(map.element.hidden).toBe(true);
  Object.defineProperty(pane, 'scrollHeight', { value: 4000, configurable: true });
  timeline.querySelectorAll('.ev-user_message:not([data-timeline-key$="q0"])').forEach(row => row.remove());
  map.paint();
  expect(map.element.hidden).toBe(true);
});

it('checks again whether the chat fits when the pane or its rows change size', async () => {
  const observers: Array<{ callback: () => void; targets: Element[] }> = [];
  vi.stubGlobal('ResizeObserver', class {
    targets: Element[] = [];
    constructor(public callback: () => void) { observers.push(this); }
    observe(target: Element) { this.targets.push(target); }
    disconnect() {}
  });
  const { map, pane, timeline } = await minimap();
  expect(observers.flatMap(observer => observer.targets)).toEqual([pane, timeline]);
  // A wider window: the chat now fits, then an opened disclosure makes it overflow again.
  Object.defineProperty(pane, 'scrollHeight', { value: 400, configurable: true });
  observers.forEach(observer => observer.callback());
  expect(map.element.hidden).toBe(true);
  Object.defineProperty(pane, 'scrollHeight', { value: 4000, configurable: true });
  observers.forEach(observer => observer.callback());
  expect(map.element.hidden).toBe(false);
});

it('jumps to a message on click, releasing the follow hold first', async () => {
  const { dashes, jumped, pane } = await minimap();
  const { TOP_GAP } = await import('../src/renderer/timeline-minimap.js');
  let atJump = -1;
  jumped.mockImplementation(() => { atJump = pane.scrollTop; });
  dashes()[2]!.click();
  expect(jumped).toHaveBeenCalledOnce();
  expect(atJump).toBe(0);
  expect(pane.scrollTop).toBe(2000 - TOP_GAP);
});

it('steps between your messages with Alt+Up and Alt+Down while the chat has focus', async () => {
  const { key, pane, jumped } = await minimap();
  const { TOP_GAP } = await import('../src/renderer/timeline-minimap.js');
  expect(key('ArrowDown').defaultPrevented).toBe(true);
  expect(pane.scrollTop).toBe(1000 - TOP_GAP);
  key('ArrowDown', pane.querySelector('.said')!);
  expect(pane.scrollTop).toBe(2000 - TOP_GAP);
  // Halfway through the third answer, up goes back to its question, then to the one before.
  pane.scrollTop = 2500;
  key('ArrowUp');
  expect(pane.scrollTop).toBe(2000 - TOP_GAP);
  key('ArrowUp');
  expect(pane.scrollTop).toBe(1000 - TOP_GAP);
  expect(jumped).toHaveBeenCalledTimes(4);
  // Typing keeps the keys: the composer, plain arrows, and other modifiers.
  const composer = document.getElementById('composer')!;
  expect(key('ArrowUp', composer).defaultPrevented).toBe(false);
  expect(key('ArrowUp', document.body, {}).defaultPrevented).toBe(false);
  expect(key('ArrowUp', document.body, { altKey: true, shiftKey: true }).defaultPrevented).toBe(false);
  expect(pane.scrollTop).toBe(1000 - TOP_GAP);
  expect(jumped).toHaveBeenCalledTimes(4);
});

it('goes on from where a smooth jump is headed, not from where it has got to', async () => {
  const { key, pane } = await minimap();
  const { TOP_GAP } = await import('../src/renderer/timeline-minimap.js');
  const targets: number[] = [];
  // A smooth scroll that has not moved yet when the next key arrives.
  pane.scrollTo = ((options: ScrollToOptions) => { targets.push(options.top!); }) as HTMLElement['scrollTo'];
  key('ArrowDown');
  key('ArrowDown');
  expect(targets).toEqual([1000 - TOP_GAP, 2000 - TOP_GAP]);
  // Once it has arrived, the next step starts from where the view is. Reduced motion jumps at once.
  pane.dispatchEvent(new dom.window.Event('scrollend'));
  dom.window.matchMedia = (() => ({ matches: true })) as unknown as typeof dom.window.matchMedia;
  pane.scrollTop = 0;
  key('ArrowDown');
  expect(pane.scrollTop).toBe(1000 - TOP_GAP);
  expect(targets).toHaveLength(2);
});

it('brightens while the chat scrolls and fades back after', async () => {
  vi.useFakeTimers();
  const { map, pane } = await minimap();
  const { PULSE_MS } = await import('../src/renderer/timeline-minimap.js');
  pane.dispatchEvent(new dom.window.Event('scroll'));
  expect(map.element.classList.contains('is-active')).toBe(true);
  vi.advanceTimersByTime(PULSE_MS - 100);
  pane.dispatchEvent(new dom.window.Event('scroll'));
  vi.advanceTimersByTime(PULSE_MS - 100);
  expect(map.element.classList.contains('is-active')).toBe(true);
  vi.advanceTimersByTime(200);
  expect(map.element.classList.contains('is-active')).toBe(false);
});
