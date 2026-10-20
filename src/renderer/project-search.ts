import type { LocalProject } from '../shared/projects.js';
import type { ProjectSearchHit, ProjectSearchResult } from '../shared/project-files.js';
import { t, tn, ui } from './i18n.js';
import { el, icon } from './dom.js';

interface ProjectSearchOptions {
  mount: HTMLElement;
  onShow?: () => void;
  onEscape?: () => void;
  /** Opens one hit: the file at its line in Files. */
  onOpen: (projectId: string, path: string, line: number) => void;
}

function toggle(label: string, name: () => string): HTMLButtonElement {
  const button = el('button', 'btn project-search-toggle', label) as HTMLButtonElement;
  button.type = 'button';
  button.setAttribute('aria-pressed', 'false');
  ui(button, 'title', name); ui(button, 'aria-label', name);
  button.addEventListener('click', () => button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true')));
  return button;
}

function field(placeholder: () => string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'project-search-input';
  input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 256;
  ui(input, 'placeholder', placeholder); ui(input, 'aria-label', placeholder);
  return input;
}

/** The first span the query matches in a line, for marking it; none when it cannot be told here. */
export function matchSpan(text: string, query: string, caseSensitive: boolean, regex: boolean): [number, number] | null {
  if (!regex) {
    const at = caseSensitive ? text.indexOf(query) : text.toLowerCase().indexOf(query.toLowerCase());
    return at < 0 ? null : [at, at + query.length];
  }
  try {
    // ripgrep's regex dialect is not JavaScript's; a pattern only one of them reads stays unmarked.
    const found = new RegExp(query, caseSensitive ? '' : 'i').exec(text);
    return found && found[0] ? [found.index, found.index + found[0].length] : null;
  } catch {
    return null;
  }
}

/**
 * The right dock's Search tab: a text search over the selected project, run by main with the
 * bundled ripgrep. It holds only project-relative paths and lines; opening a hit hands it to Files.
 */
export function createProjectSearchPanel(options: ProjectSearchOptions) {
  const pane = el('aside', 'project-search-panel'); pane.hidden = true;
  ui(pane, 'aria-label', () => t('Search'));
  const form = document.createElement('form');
  form.className = 'project-search-form'; form.noValidate = true;
  const queryRow = el('div', 'project-search-query');
  const query = field(() => t('Search this project'));
  query.type = 'search'; query.maxLength = 1000;
  const matchCase = toggle('Aa', () => t('Match case'));
  const regex = toggle('.*', () => t('Use regular expression'));
  const stop = el('button', 'btn btn-icon project-search-stop') as HTMLButtonElement;
  stop.type = 'button'; stop.hidden = true; stop.append(icon('i-stop'));
  ui(stop, 'title', () => t('Stop')); ui(stop, 'aria-label', () => t('Stop'));
  queryRow.append(icon('i-search', 'ico project-search-glyph'), query, matchCase, regex, stop);
  const filters = el('div', 'project-search-filters');
  const include = field(() => t('Files to include'));
  const exclude = field(() => t('Folders to exclude'));
  ui(include, 'title', () => t('One file pattern, such as *.ts or src/**'));
  ui(exclude, 'title', () => t('Folder names, separated by commas'));
  filters.append(include, exclude);
  form.append(queryRow, filters);
  const status = el('div', 'project-search-status');
  status.setAttribute('role', 'status');
  const results = el('div', 'project-search-results');
  ui(results, 'aria-label', () => t('Search results'));
  pane.append(form, status, results);
  options.mount.append(pane);

  let project: LocalProject | null = null;
  let generation = 0;
  let running = false;

  /** Bound, so the line follows a language change. */
  function setStatus(text: () => string): void { ui(status, 'textContent', text); }

  function setRunning(value: boolean): void {
    running = value;
    stop.hidden = !value;
    pane.classList.toggle('is-searching', value);
  }

  function hitRow(projectId: string, hit: ProjectSearchHit, caseSensitive: boolean, isRegex: boolean, needle: string): HTMLElement {
    const row = el('button', 'project-search-hit') as HTMLButtonElement;
    row.type = 'button'; row.dataset.path = hit.path; row.dataset.line = String(hit.line);
    const text = el('span', 'project-search-hit-text');
    const span = matchSpan(hit.text, needle, caseSensitive, isRegex);
    if (span) {
      const mark = document.createElement('mark');
      mark.textContent = hit.text.slice(span[0], span[1]);
      text.append(hit.text.slice(0, span[0]), mark, hit.text.slice(span[1]));
    } else text.textContent = hit.text;
    row.append(el('span', 'project-search-hit-line', String(hit.line)), text);
    row.title = `${hit.path}:${hit.line}`;
    row.addEventListener('click', () => {
      for (const selected of results.querySelectorAll('.project-search-hit.is-selected')) selected.classList.remove('is-selected');
      row.classList.add('is-selected');
      options.onOpen(projectId, hit.path, hit.line);
    });
    return row;
  }

  function paint(value: ProjectSearchResult, caseSensitive: boolean, isRegex: boolean, needle: string): void {
    const groups = new Map<string, ProjectSearchHit[]>();
    for (const hit of value.hits) groups.set(hit.path, [...(groups.get(hit.path) ?? []), hit]);
    const nodes: HTMLElement[] = [];
    for (const [path, hits] of groups) {
      const group = el('section', 'project-search-file');
      const at = path.lastIndexOf('/');
      const head = el('div', 'project-search-file-head');
      head.title = path;
      head.append(icon('i-file', 'ico project-search-file-icon'), el('strong', '', at < 0 ? path : path.slice(at + 1)),
        el('span', 'project-search-file-folder', at < 0 ? '' : path.slice(0, at)), el('span', 'project-search-file-count', String(hits.length)));
      group.append(head, ...hits.map(hit => hitRow(value.projectId, hit, caseSensitive, isRegex, needle)));
      nodes.push(group);
    }
    results.replaceChildren(...nodes);
    const count = value.hits.length, files = groups.size;
    const summary = () => count === 0 ? t('No matches')
      : `${tn('{0} match', '{0} matches', count)} · ${tn('{0} file', '{0} files', files)}`;
    const why = value.stoppedBecause;
    setStatus(() => why === 'cancelled' ? `${t('Search stopped.')} ${summary()}`
      : why === 'limit' ? t('Showing the first {0} matches. Narrow the search to see the rest.', [count])
        : why ? `${t('The search ran out of time. Narrow it to see the rest.')} ${summary()}` : summary());
  }

  async function runSearch(): Promise<void> {
    const current = project;
    const needle = query.value;
    if (!current || !needle) return;
    const request = ++generation;
    const caseSensitive = matchCase.getAttribute('aria-pressed') === 'true';
    const isRegex = regex.getAttribute('aria-pressed') === 'true';
    setRunning(true);
    // The last query's hits would read as this one's while it runs.
    results.replaceChildren();
    setStatus(() => t('Searching…'));
    const reply = await window.api.searchProject({
      projectId: current.id, query: needle, include: include.value.trim(),
      excludeFolders: exclude.value.split(',').map(name => name.trim()).filter(Boolean).slice(0, 32),
      caseSensitive, regex: isRegex
    });
    if (request !== generation || project?.id !== current.id) return;
    setRunning(false);
    if (!reply.ok) {
      results.replaceChildren();
      const message = reply.error;
      setStatus(() => isRegex ? t('The search failed. Check the regular expression.') : t(message));
      return;
    }
    paint(reply.data, caseSensitive, isRegex, needle);
  }

  form.addEventListener('submit', event => { event.preventDefault(); void runSearch(); });
  // Enter in any field searches; the toggles search again when a query is already there.
  for (const input of [include, exclude]) input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); void runSearch(); }
  });
  for (const button of [matchCase, regex]) button.addEventListener('click', () => { if (query.value) void runSearch(); });
  stop.addEventListener('click', () => { if (running) void window.api.cancelProjectSearch(); query.focus(); });
  pane.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (running) { void window.api.cancelProjectSearch(); return; }
    hide(); options.onEscape?.();
  });

  function hide(): void { pane.hidden = true; }

  return {
    hide,
    show(): void {
      if (!project) return;
      options.onShow?.();
      pane.hidden = false;
      query.focus();
    },
    mountAt(parent: HTMLElement): void { if (pane.parentElement !== parent) parent.append(pane); },
    visible: () => !pane.hidden,
    update(next: LocalProject | null): void {
      if (project?.id === next?.id) { project = next; return; }
      if (running) void window.api.cancelProjectSearch();
      project = next;
      generation++;
      setRunning(false);
      results.replaceChildren();
      setStatus(() => '');
      if (!next) hide();
    }
  };
}
