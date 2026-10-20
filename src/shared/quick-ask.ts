/** What the quick-ask window shows (src/main/quick-ask.ts): presentation only, no permission. */
export interface QuickAskState {
  theme: 'light' | 'dark';
  /** The saved palette's page and accent colors for that theme. */
  background: string;
  accent: string;
  /** Projects a new chat can start in, as the sidebar lists them. */
  projects: Array<{ id: string; name: string }>;
}

/** The finished answer of the chat a quick ask started; `text` is null when the turn ended without one. */
export interface QuickAskAnswer {
  sessionId: string;
  text: string | null;
}
