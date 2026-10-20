import { describe, expect, it, vi } from 'vitest';
import { createProjectWindowRegistry } from '../src/main/project-windows.js';
import { mayComposeIn, windowProjectFrom } from '../src/shared/project-windows.js';

// Project windows: one project open in its own app window owns that project's chats.
const P = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const Q = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';

function fakeWindow(id: number) {
  let destroyed = false;
  return { isDestroyed: () => destroyed, webContents: { id }, destroy: () => { destroyed = true; } };
}

describe('which composer may send to a chat', () => {
  it('lets a project window send only to its own project', () => {
    expect(mayComposeIn(P, P, [P])).toBe(true);
    expect(mayComposeIn(P, Q, [P])).toBe(false);
    expect(mayComposeIn(P, null, [P])).toBe(false);
  });

  it('keeps the main window off a project that has its own window, and on every other chat', () => {
    expect(mayComposeIn(null, P, [P])).toBe(false);
    expect(mayComposeIn(null, Q, [P])).toBe(true);
    expect(mayComposeIn(null, null, [P])).toBe(true);
    expect(mayComposeIn(null, undefined, [])).toBe(true);
  });

  it('reads the window\'s project from its page address and nothing else', () => {
    expect(windowProjectFrom(`?project=${P}`)).toBe(P);
    expect(windowProjectFrom('')).toBeNull();
    expect(windowProjectFrom('?project=../../settings')).toBeNull();
    expect(windowProjectFrom(`?other=${P}`)).toBeNull();
  });
});

describe('project window registry', () => {
  it('holds one live window per project and forgets it once closed', () => {
    const registry = createProjectWindowRegistry<ReturnType<typeof fakeWindow>>();
    const changed = vi.fn();
    registry.onChange(changed);
    const first = fakeWindow(7);
    registry.add(P, first);
    expect(registry.get(P)).toBe(first);
    expect(registry.projectIds()).toEqual([P]);
    expect(registry.projectOf(7)).toBe(P);
    expect(registry.projectOf(1)).toBeNull();
    expect(registry.projectOf(undefined)).toBeNull();
    expect(() => registry.add(P, fakeWindow(8))).toThrow();
    // Electron's members throw on a destroyed window; the registry asks only isDestroyed and the id it kept.
    first.destroy();
    expect(registry.get(P)).toBeNull();
    expect(registry.projectIds()).toEqual([]);
    expect(registry.projectOf(7)).toBeNull();
    registry.remove(first);
    expect(registry.windows()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
    const second = fakeWindow(9);
    registry.add(P, second);
    expect(registry.windows()).toEqual([second]);
  });
});
