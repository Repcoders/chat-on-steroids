import type { SessionSummary } from '../shared/session.js';
import { workingChats } from './keep-awake.js';
import { mainText } from './main-texts.js';

/**
 * While chats work, the taskbar button shows progress and the window title says how many, so a
 * minimized app still tells you when it is done (macOS: the count on the Dock icon). Off unless
 * `ui.taskbarProgress` is on. The count is keep-awake's: a chat that died mid-turn drops out
 * when its activity deadline passes.
 */

const APP_TITLE = 'Chat On Steroids';

/** The window title for this many working chats: "(2 running) Chat On Steroids". */
export function runningTitle(count: number): string {
  return count > 0 ? `(${mainText('{0} running').replace('{0}', () => String(count))}) ${APP_TITLE}` : APP_TITLE;
}

export function createTaskbarProgress(options: { sessions: () => Promise<readonly SessionSummary[]>; enabled: () => boolean; show: (count: number) => void }) {
  let shown = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let disposed = false;
  let force = false;
  // A failed session read clears the deadline timer, so it is retried soon, then less often.
  let retryMs = 1_000;
  const retry = (): void => {
    if (disposed || timer) return;
    timer = setTimeout(() => { void refresh(); }, retryMs);
    timer.unref?.();
    retryMs = Math.min(60_000, retryMs * 2);
  };
  const show = (count: number): void => {
    try { options.show(count); shown = count; } catch { /* A closed window shows nothing; the next refresh tries again. */ }
  };
  const once = async (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    const { count, nextAt } = options.enabled() ? workingChats(await options.sessions(), Date.now()) : { count: 0, nextAt: null };
    if (disposed) return;
    retryMs = 1_000;
    if (count !== shown || (force && count > 0)) show(count);
    force = false;
    if (nextAt !== null) {
      timer = setTimeout(() => { void refresh(); }, Math.max(1_000, nextAt - Date.now() + 100));
      timer.unref?.();
    }
  };
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (running) { again = true; return running; }
    running = once().catch(retry).finally(() => {
      running = null;
      if (again) { again = false; void refresh(); }
    });
    return running;
  };
  return {
    refresh,
    /** Shows the count again: a new window has the plain title, a language change a new one. */
    repaint(): Promise<void> {
      force = true;
      return refresh();
    },
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (shown > 0) show(0);
    }
  };
}

let installed: ReturnType<typeof createTaskbarProgress> | null = null;
/** The app's one instance, so a settings change applies at once. */
export function installTaskbarProgress(instance: ReturnType<typeof createTaskbarProgress>): void { installed = instance; }
export function refreshTaskbarProgress(): void { void installed?.refresh(); }
export function repaintTaskbarProgress(): void { void installed?.repaint(); }
