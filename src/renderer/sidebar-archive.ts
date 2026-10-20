/**
 * Archived chats: a local presentation preference, like pins (#1133). An archived chat leaves its
 * list, in the tree and the inbox, for a closed Archived group at the end of the sidebar until
 * Unarchive. Nothing is archived in ChatGPT (that is #1460, for retired workers only), and the chat,
 * its project and its search results never change.
 */
const STORAGE_KEY = 'chat-on-steroids.sidebar-archive';
const MAX_ARCHIVED = 1000;

export interface ArchivedChat {
  /** What the chat needed from the person when it was archived (a block, a failed turn), if anything. */
  needs: string | null;
  /** The chat's last activity then. */
  activeAt: number;
}

/**
 * Whether an archived chat is back in its list for now: something needs the person that did not when
 * it was archived, or the same need came up again since. Once handled, it is archived again.
 */
export function archiveSurfaces(archived: ArchivedChat, needs: string | null, activeAt: number): boolean {
  return needs !== null && (needs !== archived.needs || activeAt > archived.activeAt);
}

export function createSidebarArchive() {
  const archived = new Map<string, ArchivedChat>();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const saved: unknown = raw && raw.length <= 200_000 ? JSON.parse(raw) : [];
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (archived.size >= MAX_ARCHIVED) break;
        if (!Array.isArray(entry)) continue;
        const [id, needs, activeAt] = entry as unknown[];
        if (typeof id === 'string' && id.length > 0 && id.length <= 160 && (needs === null || typeof needs === 'string') &&
            Number.isFinite(activeAt)) archived.set(id, { needs, activeAt: activeAt as number });
      }
    }
  } catch { /* Unavailable/corrupt layout storage must not prevent opening chats. */ }

  function save(): void {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...archived].map(([id, entry]) => [id, entry.needs, entry.activeAt]))); }
    catch { /* Keep the archive in this window when layout storage is unavailable. */ }
  }

  return {
    get: (id: string): ArchivedChat | undefined => archived.get(id),
    archive(id: string, needs: string | null, activeAt: number): void {
      archived.delete(id);
      // The oldest archived chat gives way at the bound, back to its list; an archive is never refused.
      if (archived.size >= MAX_ARCHIVED) archived.delete(archived.keys().next().value!);
      archived.set(id, { needs, activeAt });
      save();
    },
    unarchive(id: string): void {
      if (archived.delete(id)) save();
    }
  };
}
