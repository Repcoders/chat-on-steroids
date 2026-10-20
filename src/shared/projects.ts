export const PROJECT_COLORS = ['blue', 'green', 'amber', 'purple', 'rose', 'teal'] as const;
export type ProjectColor = typeof PROJECT_COLORS[number];

/**
 * A named command the person runs from the project's menu: it opens a new workspace terminal in
 * the project's folder and types the command there. The app and models never run it themselves.
 */
export interface ProjectScript { name: string; command: string }
export const PROJECT_SCRIPT_LIMITS = { count: 20, name: 60, command: 2000 } as const;

/** Explicit local folder selection. The project grants no filesystem permission. */
export interface LocalProject {
  id: string;
  name: string;
  path: string;
  /** A folder on a server (#1469); `path` is then its `host[:port]:/path` identity. */
  remote?: import('./types.js').RemoteFolder;
  /** Optional presentation-only sidebar accent. Never changes workspace or permission semantics. */
  color?: ProjectColor;
  /** Optional named commands for the workspace terminal; they grant no permission of their own. */
  scripts?: ProjectScript[];
  createdAt: number;
  /** Removed sidebar group; existing conversations and queued work retain their folder. */
  ungrouped?: boolean;
  /**
   * The native ChatGPT Project this CoS project's new chats open in. Only projects created after
   * this existed have one; it grants no filesystem permission.
   */
  chatgpt?: ChatgptProjectLink;
}

/**
 * One CoS project's native ChatGPT Project, from request to verified identity.
 *
 * `requested` and `claimed` are before any click, so nothing can exist remotely yet.
 * `creating` is written before the click that creates it, so from there ChatGPT may hold a Project
 * whose id never came back: that ends as `linked` (its id seen on its own page) or `uncertain`,
 * which is never retried on its own because a retry could create a second Project.
 */
export type ChatgptProjectLink =
  | { state: 'requested'; requestId: string; updatedAt: number }
  | { state: 'claimed'; requestId: string; owner: string; updatedAt: number }
  | { state: 'creating'; requestId: string; owner: string; updatedAt: number }
  | { state: 'linked'; id: string; updatedAt: number }
  | { state: 'failed'; requestId: string; error: string; updatedAt: number }
  | { state: 'uncertain'; requestId: string; error: string; updatedAt: number };

/** ChatGPT addresses a Project as `g-p-` and 32 hex digits; nothing else is one. */
export const CHATGPT_PROJECT_ID = /^g-p-[0-9a-f]{32}$/;
