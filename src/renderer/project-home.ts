/**
 * A project's home (its menu › Project home): the folder, the Git branch and how many paths changed
 * (the same `projectGit:snapshot` read Review uses), the project's chats with their sub-agents, when
 * it was last active, and New chat. It reads and links; Files and Review open their own panels, and
 * nothing here changes the project. A project on a server (#1469) has no Git read, as in Review.
 */
import type { LocalProject } from '../shared/projects.js';
import type { ProjectGitSnapshot } from '../shared/project-git.js';
import { ago, el, icon } from './dom.js';
import { currentLanguage, t, tn } from './i18n.js';

/** When something happened: "5m ago" within the day, its date once older. */
export function projectHomeWhen(atMs: number, now = Date.now()): string {
  // ago() counts from the clock; shift the time so it counts from `now`.
  if (now - atMs < 24 * 3600_000) return ago(Date.now() - (now - atMs));
  const at = new Date(atMs);
  return at.toLocaleDateString(currentLanguage(), { month: 'short', day: 'numeric',
    ...(at.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }) });
}

/** One of the project's chats as the sidebar holds it. */
export interface ProjectHomeChat {
  id: string;
  title: string;
  /** The chat's or its sub-agents' latest activity. */
  updatedAt: number;
  workers: number;
  working: boolean;
}

export interface ProjectHomeDeps {
  project(id: string): LocalProject | undefined;
  /** The project's chats the sidebar has loaded, newest first. */
  chats(id: string): ProjectHomeChat[];
  /** Asks the sidebar for the project's own chats; their rows arrive through `update()`. */
  loadChats(id: string): void;
  /** The project's Git snapshot; null when the read failed. */
  snapshot(id: string): Promise<ProjectGitSnapshot | null>;
  open(sessionId: string): void;
  newChat(projectId: string): void;
  files(projectId: string): void;
  review(projectId: string): void;
}

/** What the Git line says: the branch and change count, or why there is none. */
export function projectGitLine(snapshot: ProjectGitSnapshot | null | undefined): { branch?: string; text: string } {
  if (snapshot === undefined) return { text: t('Reading Git changes…') };
  if (!snapshot || snapshot.state === 'unavailable') return { text: t('Git changes are unavailable.') };
  if (snapshot.state === 'not-repository') return { text: t('This folder is not a Git repository.') };
  const count = snapshot.truncated ? `${snapshot.changes.length}+` : snapshot.changes.length;
  return { ...(snapshot.currentBranch ? { branch: snapshot.currentBranch } : {}), text: t('Changes ({0})', [count]) };
}

export function createProjectHome(deps: ProjectHomeDeps): { open(projectId: string): void; update(): void } {
  let dialog: HTMLDialogElement | null = null;
  let projectId: string | null = null;
  let git: ProjectGitSnapshot | null | undefined;
  let body: HTMLElement | null = null;
  let signature = '';

  /** Takes a closed home out of the document; the dialog's own close (Escape) comes here too. */
  const retire = (box: HTMLDialogElement): void => {
    box.remove();
    if (dialog === box) { dialog = null; body = null; projectId = null; }
  };
  // Electron has the dialog methods; a bare DOM (the tests) gets the same effect by hand.
  const closeDialog = (): void => {
    const box = dialog;
    if (!box) return;
    if (typeof box.close === 'function') box.close();
    else box.removeAttribute('open');
    retire(box);
  };
  /** Closes the home, then runs what replaces it. */
  const leave = (work: () => void) => () => { closeDialog(); work(); };

  const button = (className: string, symbol: string, label: () => string, action: string, work: () => void): HTMLButtonElement => {
    const node = el('button', className) as HTMLButtonElement;
    node.type = 'button'; node.dataset.homeAction = action;
    node.append(icon(symbol), el('span', '', label));
    node.onclick = leave(work);
    return node;
  };

  const paint = (): void => {
    if (!dialog || !body || !projectId) return;
    const id = projectId;
    const project = deps.project(id);
    // The project was removed from the sidebar while its home was open.
    if (!project || project.ungrouped) { closeDialog(); return; }
    const chats = deps.chats(id);
    const next = JSON.stringify([project.name, project.path, !!project.remote, git === undefined ? null : git?.state ?? 'failed',
      git?.currentBranch, git?.changes.length, git?.truncated, chats]);
    // Activity repaints the sidebar many times a second; an unchanged home keeps its nodes and focus.
    if (next === signature) return;
    signature = next;
    const heading = dialog.querySelector<HTMLElement>('#projectHomeTitle');
    if (heading) heading.textContent = project.name;

    const facts = el('div', 'project-home-facts');
    const folder = el('p', 'project-home-fact');
    const path = el('span', 'project-home-path', project.path);
    path.dir = 'ltr'; path.title = project.path;
    folder.append(icon('i-folder'), path);
    if (project.remote) folder.append(el('span', 'project-badge', 'SSH'));
    facts.append(folder);
    if (!project.remote) {
      const line = projectGitLine(git);
      const gitFact = el('p', 'project-home-fact project-home-git');
      gitFact.append(icon('i-git-branch'));
      if (line.branch) { const branch = el('span', 'project-home-branch', line.branch); branch.dir = 'ltr'; gitFact.append(branch); }
      gitFact.append(el('span', 'project-home-changes', line.text));
      facts.append(gitFact);
    }
    const latest = chats.reduce((max, chat) => Math.max(max, chat.updatedAt), 0);
    if (latest) {
      const active = el('p', 'project-home-fact', t('Last activity {0}', [projectHomeWhen(latest)]));
      active.prepend(icon('i-clock'));
      facts.append(active);
    }

    const actions = el('div', 'project-home-actions');
    actions.append(button('btn btn-solid', 'i-pencil', () => t('New chat'), 'new-chat', () => deps.newChat(id)),
      button('btn', 'i-folder', () => t('Files'), 'files', () => deps.files(id)));
    if (!project.remote) actions.append(button('btn', 'i-git-diff', () => t('Review'), 'review', () => deps.review(id)));

    const list = el('ul', 'project-home-chats');
    for (const chat of chats) {
      const item = el('li', 'project-home-chat');
      item.dataset.id = chat.id;
      const link = el('button', 'project-home-chat-title', chat.title) as HTMLButtonElement;
      link.type = 'button'; link.title = chat.title; link.dir = 'auto';
      link.onclick = leave(() => deps.open(chat.id));
      const meta = [
        ...(chat.working ? [t('Working')] : []),
        ...(chat.workers ? [tn('{0} sub-agent', '{0} sub-agents', chat.workers)] : []),
        projectHomeWhen(chat.updatedAt)
      ].join(' · ');
      item.append(link, el('span', 'project-home-chat-meta', meta));
      list.append(item);
    }
    const chatsHeading = el('h3', 'project-home-heading', () => t('Chats'));
    const section = chats.length ? list : el('p', 'project-home-empty', () => t('No chats yet.'));
    // Keep the keyboard on the same control when the home repaints under it.
    const focused = document.activeElement instanceof HTMLElement && body.contains(document.activeElement)
      ? (document.activeElement.dataset.homeAction ?? document.activeElement.closest<HTMLElement>('.project-home-chat')?.dataset.id) : undefined;
    body.replaceChildren(facts, actions, chatsHeading, section);
    if (focused) {
      const target = body.querySelector<HTMLElement>(`[data-home-action="${focused}"]`)
        ?? [...body.querySelectorAll<HTMLElement>('.project-home-chat')].find(row => row.dataset.id === focused)?.querySelector('button');
      target?.focus({ preventScroll: true });
    }
  };

  return {
    open(id) {
      const project = deps.project(id);
      if (!project) return;
      closeDialog();
      const box = document.createElement('dialog');
      box.className = 'plugin-dialog project-home-dialog';
      box.dataset.projectId = id;
      const head = el('div', 'plugin-dialog-head');
      const heading = el('h2', '', project.name);
      heading.id = 'projectHomeTitle';
      box.setAttribute('aria-labelledby', heading.id);
      const close = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
      close.type = 'button';
      close.onclick = closeDialog;
      head.append(heading, close);
      const content = el('div', 'plugin-dialog-body project-home-body');
      box.append(head, content);
      box.addEventListener('close', () => retire(box));
      document.body.append(box);
      dialog = box; body = content; projectId = id; git = undefined; signature = '';
      paint();
      if (typeof box.showModal === 'function') box.showModal(); else box.setAttribute('open', '');
      close.focus();
      deps.loadChats(id);
      if (!project.remote) {
        void deps.snapshot(id).catch(() => null).then(snapshot => {
          // A home opened again (or for another project) meanwhile reads its own snapshot.
          if (dialog !== box) return;
          git = snapshot; paint();
        });
      }
    },
    /** Repaints an open home from the sidebar's latest chats; a closed one costs nothing. */
    update: paint
  };
}
