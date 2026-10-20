import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';
import { archiveSurfaces, createSidebarArchive } from '../src/renderer/sidebar-archive.js';

let dom: JSDOM;
afterEach(() => dom?.window.close());

function fixture(saved?: string) {
  dom = new JSDOM('<div></div>', { url: 'https://local.test' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  if (saved !== undefined) dom.window.localStorage.setItem('chat-on-steroids.sidebar-archive', saved);
  return createSidebarArchive();
}

it('remembers archived chats across a restart and ignores broken or oversized storage', () => {
  const archive = fixture();
  archive.archive('kept', null, 10);
  archive.archive('blocked', 'blocked', 20);
  archive.archive('gone', null, 30);
  archive.unarchive('gone');
  archive.archive('handled', 'approval', 40);
  archive.settle('handled');
  const saved = dom.window.localStorage.getItem('chat-on-steroids.sidebar-archive')!;
  const again = fixture(saved);
  expect(again.get('kept')).toEqual({ needs: null, activeAt: 10 });
  expect(again.get('blocked')).toEqual({ needs: 'blocked', activeAt: 20 });
  expect(again.get('gone')).toBeUndefined();
  expect(again.get('handled')).toEqual({ needs: null, activeAt: 40 });
  expect(fixture('{not json').get('kept')).toBeUndefined();
  const mixed = fixture(JSON.stringify([['ok', null, 1], ['x'.repeat(161), null, 1], ['bad-needs', 7, 1], ['no-time', null, 'soon'], 'flat']));
  expect(['ok', 'x'.repeat(161), 'bad-needs', 'no-time', 'flat'].filter(id => mixed.get(id))).toEqual(['ok']);
});

it('never refuses an archive: the oldest one gives way at the bound', () => {
  const archive = fixture(JSON.stringify(Array.from({ length: 1000 }, (_, index) => [`chat-${index}`, null, index])));
  archive.archive('newest', null, 1);
  expect(archive.get('chat-0')).toBeUndefined();
  expect(archive.get('chat-1')).toBeDefined();
  expect(archive.get('newest')).toBeDefined();
});

it('brings an archived chat back only while something new needs the person', () => {
  const quiet = { needs: null, activeAt: 100 };
  expect(archiveSurfaces(quiet, null, 200)).toBe(false);
  expect(archiveSurfaces(quiet, 'approval', 100)).toBe(true);
  // Archived while blocked: it stays archived until it needs something else, or the same again later.
  const blocked = { needs: 'blocked', activeAt: 100 };
  expect(archiveSurfaces(blocked, 'blocked', 100)).toBe(false);
  expect(archiveSurfaces(blocked, 'approval', 100)).toBe(true);
  expect(archiveSurfaces(blocked, 'blocked', 150)).toBe(true);
  expect(archiveSurfaces(blocked, null, 150)).toBe(false);
});
