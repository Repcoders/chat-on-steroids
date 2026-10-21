import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { LocalProject } from '../src/shared/projects.js';
import type { ProjectGitSnapshot } from '../src/shared/project-git.js';
import type { ProjectHomeChat } from '../src/renderer/project-home.js';

let dom: JSDOM;
afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const local: LocalProject = { id: 'project-a', name: 'Placeholder project', path: 'C:\\Users\\you\\project', createdAt: 1 };
const remote: LocalProject = { id: 'project-b', name: 'Server project', path: 'example.test:/home/you/project', createdAt: 1,
  remote: { host: 'example.test', path: '/home/you/project' } as LocalProject['remote'] };
const snapshot = (fields: Partial<ProjectGitSnapshot> = {}): ProjectGitSnapshot => ({
  projectId: 'project-a', state: 'ready', changes: [], truncated: false, revision: 'r', currentBranch: 'feature/placeholder', ...fields
});
const change = (path: string) => ({ status: 'M' as const, path, additions: 1, deletions: 0, binary: false });

async function mount(options: { projects?: LocalProject[]; chats?: ProjectHomeChat[]; snapshot?: (id: string) => Promise<ProjectGitSnapshot | null> } = {}) {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('Event', dom.window.Event);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('navigator', { platform: 'Win32', language: 'en', languages: ['en'] });
  const doc = dom.window.document;
  let projects = options.projects ?? [local, remote];
  let chats = options.chats ?? [];
  const calls: string[] = [];
  const read = vi.fn(options.snapshot ?? (async () => snapshot({ changes: [change('a.ts'), change('b.ts')] })));
  const { createProjectHome } = await import('../src/renderer/project-home.js');
  const home = createProjectHome({
    project: id => projects.find(row => row.id === id),
    chats: () => chats,
    loadChats: id => calls.push(`load ${id}`),
    snapshot: read,
    open: id => calls.push(`open ${id}`),
    newChat: id => calls.push(`new ${id}`),
    files: id => calls.push(`files ${id}`),
    review: id => calls.push(`review ${id}`)
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const dialog = () => doc.querySelector<HTMLDialogElement>('.project-home-dialog');
  const text = (selector: string) => dialog()?.querySelector(selector)?.textContent ?? null;
  const actions = () => [...doc.querySelectorAll<HTMLElement>('.project-home-actions button')].map(button => button.dataset.homeAction);
  const rows = () => [...doc.querySelectorAll<HTMLElement>('.project-home-chat')].map(row => [
    row.querySelector('.project-home-chat-title')!.textContent, row.querySelector('.project-home-chat-meta')!.textContent]);
  return { doc, home, calls, read, settle, dialog, text, actions, rows,
    setChats: (next: ProjectHomeChat[]) => { chats = next; }, setProjects: (next: LocalProject[]) => { projects = next; } };
}

it('shows the folder, branch and change count, the chats with their sub-agents, and the last activity', async () => {
  const now = Date.now();
  const view = await mount({ chats: [
    { id: 'chat-1', title: 'Placeholder chat one', updatedAt: now - 120_000, workers: 2, working: true },
    { id: 'chat-2', title: 'Placeholder chat two', updatedAt: now - 3_600_000, workers: 0, working: false }
  ] });
  view.home.open(local.id);
  expect(view.dialog()?.open).toBe(true);
  expect(view.text('#projectHomeTitle')).toBe('Placeholder project');
  expect(view.text('.project-home-path')).toBe('C:\\Users\\you\\project');
  // Git is read once, in the background; until it answers the home says it is reading.
  expect(view.text('.project-home-git')).toBe('Reading Git changes…');
  expect(view.calls).toEqual([`load ${local.id}`]);
  await view.settle();
  expect(view.read).toHaveBeenCalledWith(local.id);
  expect(view.text('.project-home-branch')).toBe('feature/placeholder');
  expect(view.text('.project-home-changes')).toBe('Changes (2)');
  expect([...view.dialog()!.querySelectorAll('.project-home-fact')].at(-1)!.textContent).toBe('Last activity 2m ago');
  expect(view.rows()).toEqual([
    ['Placeholder chat one', 'Working · 2 sub-agents · 2m ago'],
    ['Placeholder chat two', '60m ago']
  ]);
  expect(view.actions()).toEqual(['new-chat', 'files', 'review']);
});

it('opens a chat, a new chat, Files or Review in the project, closing the home first', async () => {
  const view = await mount({ chats: [{ id: 'chat-1', title: 'Placeholder chat', updatedAt: Date.now(), workers: 0, working: false }] });
  for (const action of ['new-chat', 'files', 'review'] as const) {
    view.home.open(local.id); await view.settle();
    view.doc.querySelector<HTMLButtonElement>(`[data-home-action="${action}"]`)!.click();
    expect(view.dialog()).toBeNull();
  }
  view.home.open(local.id); await view.settle();
  view.doc.querySelector<HTMLButtonElement>('.project-home-chat-title')!.click();
  expect(view.dialog()).toBeNull();
  expect(view.calls.filter(call => !call.startsWith('load'))).toEqual([`new ${local.id}`, `files ${local.id}`, `review ${local.id}`, 'open chat-1']);
});

it('reads no Git for a project on a server and offers no Review there', async () => {
  const view = await mount();
  view.home.open(remote.id); await view.settle();
  expect(view.read).not.toHaveBeenCalled();
  expect(view.dialog()!.querySelector('.project-home-git')).toBeNull();
  expect(view.text('.project-badge')).toBe('SSH');
  expect(view.actions()).toEqual(['new-chat', 'files']);
  expect(view.text('.project-home-empty')).toBe('No chats yet.');
});

it('says why there is no branch: not a repository, a failed read, or more changes than were read', async () => {
  const answers: Array<ProjectGitSnapshot | null | Error> = [
    snapshot({ state: 'not-repository', currentBranch: undefined }), null, new Error('ipc failed'),
    snapshot({ changes: Array.from({ length: 3 }, (_, index) => change(`${index}.ts`)), truncated: true })
  ];
  const view = await mount({ snapshot: async () => { const next = answers.shift()!; if (next instanceof Error) throw next; return next; } });
  const shown = [];
  for (let index = 0; index < 4; index++) {
    view.home.open(local.id); await view.settle();
    shown.push(view.text('.project-home-git'));
  }
  expect(shown).toEqual(['This folder is not a Git repository.', 'Git changes are unavailable.', 'Git changes are unavailable.', 'feature/placeholderChanges (3+)']);
});

it('ignores a Git answer for a home that was opened again for another project', async () => {
  let answer: (value: ProjectGitSnapshot) => void = () => undefined;
  const view = await mount({ snapshot: id => id === local.id ? new Promise(resolve => { answer = resolve; }) : Promise.resolve(null) });
  view.home.open(local.id);
  view.home.open(remote.id);
  answer(snapshot({ currentBranch: 'stale-branch' }));
  await view.settle();
  expect(view.dialog()!.dataset.projectId).toBe(remote.id);
  expect(view.doc.querySelectorAll('.project-home-dialog')).toHaveLength(1);
  expect(view.dialog()!.textContent).not.toContain('stale-branch');
});

it('follows the sidebar while open: new chats appear, and a removed project closes its home', async () => {
  const view = await mount();
  view.home.open(local.id); await view.settle();
  const newChat = view.doc.querySelector<HTMLButtonElement>('[data-home-action="new-chat"]')!;
  newChat.focus();
  view.setChats([{ id: 'chat-9', title: 'Placeholder later chat', updatedAt: Date.now(), workers: 1, working: false }]);
  view.home.update();
  expect(view.rows()).toEqual([['Placeholder later chat', '1 sub-agent · just now']]);
  // The repaint keeps the keyboard where it was.
  expect(view.doc.activeElement).toBe(view.doc.querySelector('[data-home-action="new-chat"]'));
  view.setProjects([{ ...local, ungrouped: true }, remote]);
  view.home.update();
  expect(view.dialog()).toBeNull();
});

it('says how long ago within the day, and the date for older activity', async () => {
  await mount();
  const { projectHomeWhen } = await import('../src/renderer/project-home.js');
  const now = Date.UTC(2026, 0, 9, 12);
  expect(projectHomeWhen(now - 5 * 3600_000, now)).toBe('5h ago');
  expect(projectHomeWhen(Date.UTC(2026, 0, 5, 12), now)).toBe('Jan 5');
  expect(projectHomeWhen(Date.UTC(2025, 11, 30, 12), now)).toBe('Dec 30, 2025');
});
