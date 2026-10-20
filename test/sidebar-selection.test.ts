import { expect, it } from 'vitest';
import { createSidebarSelection } from '../src/renderer/sidebar-selection.js';

const order = ['a', 'b', 'c', 'd', 'e', 'f'];

it('Ctrl-click picks chats one at a time, starting with the open chat', () => {
  const picked = createSidebarSelection();
  picked.toggle('c', 'a', order);
  expect(picked.ids(order)).toEqual(['a', 'c']);
  picked.toggle('e', 'a', order);
  picked.toggle('a', 'a', order);
  expect(picked.ids(order)).toEqual(['c', 'e']);
  expect(picked.size).toBe(2);
});

it('a first pick on the open chat, or with no chat open, takes only that chat', () => {
  const onOpen = createSidebarSelection();
  onOpen.toggle('b', 'b', order);
  expect(onOpen.ids(order)).toEqual(['b']);
  const none = createSidebarSelection();
  none.toggle('d', null, order);
  expect(none.ids(order)).toEqual(['d']);
  // An open chat the sidebar does not list (a worker, a collapsed project) is not picked.
  const hidden = createSidebarSelection();
  hidden.toggle('d', 'worker-1', order);
  expect(hidden.ids(order)).toEqual(['d']);
});

it('Shift-click adds the run from the last picked chat, in either direction', () => {
  const picked = createSidebarSelection();
  picked.toggle('b', null, order);
  picked.extend('e', null, order);
  expect(picked.ids(order)).toEqual(['b', 'c', 'd', 'e']);
  const upwards = createSidebarSelection();
  upwards.extend('b', 'e', order);
  expect(upwards.ids(order)).toEqual(['b', 'c', 'd', 'e']);
  const alone = createSidebarSelection();
  alone.extend('c', null, order);
  expect(alone.ids(order)).toEqual(['c']);
});

it('lets go of chats the sidebar no longer shows', () => {
  const picked = createSidebarSelection();
  for (const id of ['a', 'c', 'f']) picked.toggle(id, null, order);
  expect(picked.keep(order)).toBe(false);
  expect(picked.keep(['a', 'b', 'd'])).toBe(true);
  expect(picked.ids(order)).toEqual(['a']);
  expect(picked.clear()).toBe(true);
  expect(picked.clear()).toBe(false);
  expect(picked.size).toBe(0);
});
