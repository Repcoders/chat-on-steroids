/**
 * Snoozed chats: a local presentation preference, like pins (#1133). A snoozed chat leaves its list
 * for the Snoozed group at the end of the sidebar until its time comes or it does something new,
 * whichever is first; then it is back in its place and stays there. Work it was already doing when
 * it was snoozed is not new: its updates and its end leave it snoozed. A turn it was not snoozed in
 * is new, even one that starts with no idle update after the last. The chat itself, its project and
 * its search results never change.
 */
const STORAGE_KEY = 'chat-on-steroids.sidebar-snooze';
const MAX_SNOOZED = 500;
/** Longer than any choice offers: a stored time past this is not one the app picked. */
const MAX_SNOOZE_MS = 14 * 24 * 60 * 60_000;
const WAKE_HOUR = 8;

export type SnoozeChoice = 'hour' | 'tomorrow' | 'week';
export const SNOOZE_CHOICES: readonly SnoozeChoice[] = ['hour', 'tomorrow', 'week'];

/** When a snooze picked at `now` ends: in an hour, tomorrow at 8:00, or next Monday at 8:00, local time. */
export function snoozeUntil(choice: SnoozeChoice, now: number): number {
  if (choice === 'hour') return now + 60 * 60_000;
  const at = new Date(now);
  at.setHours(WAKE_HOUR, 0, 0, 0);
  // Monday is day 1; on a Monday, next week's.
  at.setDate(at.getDate() + (choice === 'tomorrow' ? 1 : (8 - at.getDay()) % 7 || 7));
  return at.getTime();
}

/**
 * When a snooze ends, for its menu hint, row and toast: "Mon 8:00 AM" in English, with the date
 * ("Mon, Oct 26, 8:00 AM") once it is six days off or more, where the weekday alone reads as this week's.
 */
export function wakeLabel(at: number, now: number, language: string): string {
  const far = at - now >= 6 * 24 * 60 * 60_000;
  return new Date(at).toLocaleString(language, { weekday: 'short', ...(far ? { month: 'short', day: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' });
}

/** The open turns (`activeTurnId`) of a chat and of its sub-agents. */
export interface SnoozeTurns {
  own: string | null;
  workers: string[];
}
const NO_TURNS: SnoozeTurns = { own: null, workers: [] };
/** Sub-agent turns kept per snooze, the newest: past this, one left out can wake the chat early, never keep it hidden. */
const MAX_WORKER_TURNS = 8;
const turnId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160;

interface Snooze {
  until: number;
  /** The chat's last activity when it was snoozed: anything later wakes it. */
  activeAt: number;
  /** Still in the work it was doing when it was snoozed: that work moves `activeAt` on instead. */
  busy: boolean;
  /** The turns it was snoozed in: any other one wakes it. Unknown for a snooze saved before they were kept. */
  turns: SnoozeTurns | null;
}

export function createSidebarSnooze(now: () => number = Date.now) {
  const snoozed = new Map<string, Snooze>();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    // 500 snoozes with their open turns fit.
    const saved: unknown = raw && raw.length <= 250_000 ? JSON.parse(raw) : [];
    const latest = now() + MAX_SNOOZE_MS;
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (snoozed.size >= MAX_SNOOZED) break;
        if (!Array.isArray(entry)) continue;
        const [id, until, activeAt, busy, own, workers] = entry as unknown[];
        const turns = entry.length > 4 && (own === null || turnId(own)) && Array.isArray(workers) && workers.every(turnId)
          ? { own, workers: workers.slice(-MAX_WORKER_TURNS) } : null;
        if (typeof id === 'string' && id.length > 0 && id.length <= 160 && Number.isFinite(until) && Number.isFinite(activeAt) &&
            (until as number) <= latest) snoozed.set(id, { until: until as number, activeAt: activeAt as number, busy: busy === true, turns });
      }
    }
  } catch { /* Unavailable/corrupt layout storage must not prevent opening chats. */ }

  function save(): void {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...snoozed].map(([id, entry]) =>
      entry.turns ? [id, entry.until, entry.activeAt, entry.busy, entry.turns.own, entry.turns.workers] : [id, entry.until, entry.activeAt, entry.busy]))); }
    catch { /* Keep the snoozes in this window when layout storage is unavailable. */ }
  }

  return {
    /**
     * Snoozes one chat until `until`; `activeAt` is its last activity now, `busy` whether it is
     * working, `turns` the turns open now.
     */
    snooze(id: string, until: number, activeAt: number, busy = false, turns: SnoozeTurns = NO_TURNS): void {
      snoozed.delete(id);
      // The oldest snooze gives way at the bound; a snooze is never refused.
      if (snoozed.size >= MAX_SNOOZED) snoozed.delete(snoozed.keys().next().value!);
      snoozed.set(id, { until, activeAt, busy, turns: { own: turns.own, workers: turns.workers.slice(-MAX_WORKER_TURNS) } });
      save();
    },
    wake(id: string): void {
      if (snoozed.delete(id)) save();
    },
    /**
     * When a snoozed chat wakes, or null when it is not snoozed. Its time passing or any activity
     * after `activeAt` wakes it for good, except while the work it was doing when snoozed goes on
     * (`busy`) and in the update that ends it. A turn it was not snoozed in wakes it however busy
     * it stays, but a sub-agent's turn that starts while the chat's own snoozed turn runs on is
     * part of that turn.
     */
    until(id: string, activeAt: number, busy = false, turns: SnoozeTurns = NO_TURNS): number | null {
      const entry = snoozed.get(id);
      if (!entry) return null;
      // Saved before turns were kept: the ones open now are the ones it was snoozed in.
      const seen = entry.turns ?? { own: turns.own, workers: turns.workers };
      const workers = turns.workers.slice(-MAX_WORKER_TURNS);
      const added = workers.filter(turn => !seen.workers.includes(turn));
      const newTurn = (turns.own !== null && turns.own !== seen.own) || (added.length > 0 && (seen.own === null || turns.own !== seen.own));
      if (entry.until > now() && !newTurn && (entry.busy || activeAt <= entry.activeAt)) {
        // Turns that ended never come back: only the open ones are kept.
        if (!entry.turns || workers.join() !== seen.workers.join() || (entry.busy && (activeAt > entry.activeAt || !busy))) {
          entry.turns = { own: seen.own, workers };
          if (entry.busy) {
            entry.activeAt = Math.max(entry.activeAt, activeAt);
            entry.busy = busy;
          }
          save();
        }
        return entry.until;
      }
      snoozed.delete(id);
      save();
      return null;
    },
    /** The nearest wake time still ahead, for one repaint then. */
    nextWake(): number | null {
      const ahead = [...snoozed.values()].map(entry => entry.until).filter(until => until > now());
      return ahead.length ? Math.min(...ahead) : null;
    }
  };
}
