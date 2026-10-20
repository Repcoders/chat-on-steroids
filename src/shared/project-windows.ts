/**
 * Project windows: one project open in its own app window. That window owns the project's chats,
 * so exactly one composer can send to each chat. The main process enforces this on every send;
 * the renderer uses the same rule to stop offering a composer it would refuse.
 */

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The project a window serves, from its page address (`?project=<id>`); null for the main window. */
export function windowProjectFrom(search: string): string | null {
  const id = new URLSearchParams(search).get('project');
  return id && PROJECT_ID.test(id) ? id : null;
}

/**
 * Whether a window's composer may send to a chat. A project window sends only to its own project's
 * chats; the main window sends to every other chat, but not to one whose project has its own window.
 */
export function mayComposeIn(windowProject: string | null, chatProject: string | null | undefined, openProjects: readonly string[]): boolean {
  if (windowProject) return chatProject === windowProject;
  return !chatProject || !openProjects.includes(chatProject);
}
