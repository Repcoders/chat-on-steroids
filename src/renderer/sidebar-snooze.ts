/**
 * Snoozed chats: a local presentation preference, like pins (#1133). A snoozed chat leaves its list
 * for the Snoozed group at the end of the sidebar until its time comes or it does something new,
 * whichever is first; then it is back in its place and stays there. Work it was already doing when
 * it was snoozed is not new: its updates and its end leave it snoozed. The chat itself, its project
 * and its search results never change.
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

interface Snooze {
  until: number;
  /** The chat's last activity when it was snoozed: anything later wakes it. */
  activeAt: number;
  /** Still in the work it was doing when it was snoozed: that work moves `activeAt` on instead. */
  busy: boolean;
}

export function createSidebarSnooze(now: () => number = Date.now) {
  const snoozed = new Map<string, Snooze>();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const saved: unknown = raw && raw.length <= 100_000 ? JSON.parse(raw) : [];
    const latest = now() + MAX_SNOOZE_MS;
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (snoozed.size >= MAX_SNOOZED) break;
        if (!Array.isArray(entry)) continue;
        const [id, until, activeAt, busy] = entry as unknown[];
        if (typeof id === 'string' && id.length > 0 && id.length <= 160 && Number.isFinite(until) && Number.isFinite(activeAt) &&
            (until as number) <= latest) snoozed.set(id, { until: until as number, activeAt: activeAt as number, busy: busy === true });
      }
    }
  } catch { /* Unavailable/corrupt layout storage must not prevent opening chats. */ }

  function save(): void {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...snoozed].map(([id, entry]) => [id, entry.until, entry.activeAt, entry.busy]))); }
    catch { /* Keep the snoozes in this window when layout storage is unavailable. */ }
  }

  return {
    /** Snoozes one chat until `until`; `activeAt` is its last activity now, `busy` whether it is working. */
    snooze(id: string, until: number, activeAt: number, busy = false): void {
      snoozed.delete(id);
      // The oldest snooze gives way at the bound; a snooze is never refused.
      if (snoozed.size >= MAX_SNOOZED) snoozed.delete(snoozed.keys().next().value!);
      snoozed.set(id, { until, activeAt, busy });
      save();
    },
    wake(id: string): void {
      if (snoozed.delete(id)) save();
    },
    /**
     * When a snoozed chat wakes, or null when it is not snoozed. Its time passing or any activity
     * after `activeAt` wakes it for good, except while the work it was doing when snoozed goes on
     * (`busy`) and in the update that ends it.
     */
    until(id: string, activeAt: number, busy = false): number | null {
      const entry = snoozed.get(id);
      if (!entry) return null;
      if (entry.until > now() && entry.busy) {
        if (activeAt > entry.activeAt || !busy) {
          entry.activeAt = Math.max(entry.activeAt, activeAt);
          entry.busy = busy;
          save();
        }
        return entry.until;
      }
      if (entry.until > now() && activeAt <= entry.activeAt) return entry.until;
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
