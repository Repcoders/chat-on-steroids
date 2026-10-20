import type { BrowserWindow } from 'electron';

/** What the registry needs from a window; BrowserWindow in the app, a plain object in tests. */
export interface ProjectWindowLike {
  isDestroyed(): boolean;
  webContents: { id: number };
}

/**
 * Which project each project window serves. At most one live window per project. The page's id is
 * kept when the window is added: Electron's members throw once the window is destroyed, and that is
 * exactly when `remove` runs.
 */
export function createProjectWindowRegistry<W extends ProjectWindowLike>() {
  const open = new Map<string, { window: W; contentsId: number }>();
  const listeners = new Set<() => void>();
  const changed = (): void => { for (const listener of listeners) listener(); };
  const live = (projectId: string): W | null => {
    const entry = open.get(projectId);
    return entry && !entry.window.isDestroyed() ? entry.window : null;
  };
  return {
    /** The project's live window, if it has one. */
    get: live,
    add(projectId: string, window: W): void {
      if (live(projectId)) throw new Error('This project already has its own window');
      open.set(projectId, { window, contentsId: window.webContents.id });
      changed();
    },
    remove(window: W): void {
      for (const [projectId, entry] of open) if (entry.window === window) open.delete(projectId);
      changed();
    },
    /** The project whose window owns this page, or null for the main window (and any other page). */
    projectOf(contentsId: number | undefined): string | null {
      for (const [projectId, entry] of open) {
        if (entry.contentsId === contentsId && !entry.window.isDestroyed()) return projectId;
      }
      return null;
    },
    projectIds(): string[] {
      return [...open.keys()].filter(projectId => live(projectId));
    },
    windows(): W[] {
      return [...open.values()].map(entry => entry.window).filter(window => !window.isDestroyed());
    },
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export const projectWindows = createProjectWindowRegistry<BrowserWindow>();
