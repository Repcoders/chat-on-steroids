import type { SessionSearchLocation } from '../shared/session.js';
import type { ArtifactKind, SessionArtifact, SessionArtifactsReply } from '../shared/answer-artifacts.js';
import { el, icon, setIcon } from './dom.js';
import { t, tn, ui } from './i18n.js';

/**
 * Artifacts in the right dock: the open chat's code blocks, tables and display formulas, one list
 * filtered by kind. Main reads them from the whole recording (`sessions:artifacts`), so a folded
 * round or an answer above the loaded page is listed too. Each one copies as written (code, the
 * table's Markdown, the formula's LaTeX) and opens the chat at the answer it is in.
 */

export type ArtifactFilter = 'all' | ArtifactKind;

export interface ArtifactsDrawerDeps {
  load(id: string): Promise<SessionArtifactsReply | null>;
  copy(text: string): Promise<boolean>;
  /** Scrolls the open chat to the answer, loading the history page around it when needed. */
  reveal(id: string, location: SessionSearchLocation): void;
  onEscape?(): void;
}

/** Lines, and characters, a list entry shows before it is cut; the copy is always whole. */
const PREVIEW_LINES = 8;
const PREVIEW_CHARS = 2000;

const FILTERS: Array<[ArtifactFilter, () => string]> = [
  ['all', () => t('All')], ['code', () => t('Code')], ['table', () => t('Tables')], ['formula', () => t('Formulas')]
];

export function createArtifactsDrawer(deps: ArtifactsDrawerDeps) {
  const pane = el('section', 'artifacts'); pane.hidden = true;
  ui(pane, 'aria-label', () => t('Artifacts'));
  const filters = el('div', 'artifacts-filters'); filters.setAttribute('role', 'group');
  ui(filters, 'aria-label', () => t('Artifacts filter'));
  const list = el('ol', 'artifacts-list');
  const status = el('p', 'artifacts-status');
  pane.append(filters, list, status);
  let filter: ArtifactFilter = 'all', sessionId: string | null = null, wanted = '', loaded: string | null = null;
  let artifacts: SessionArtifact[] = [], limited = false, loading = false, failed = false, generation = 0, painted = '';
  const choices = new Map<ArtifactFilter, { button: HTMLButtonElement; count: HTMLElement }>();
  for (const [key, label] of FILTERS) {
    const button = el('button', 'artifacts-filter') as HTMLButtonElement;
    const count = el('span', 'artifacts-count');
    button.type = 'button'; button.dataset.filter = key;
    button.append(el('span', '', label), count);
    button.addEventListener('click', () => { filter = key; paint(); });
    choices.set(key, { button, count }); filters.append(button);
  }

  const heading = (artifact: SessionArtifact): string => artifact.kind === 'code' ? artifact.language || t('Code')
    : artifact.kind === 'table' ? t('Table') : t('Formula');
  const item = (artifact: SessionArtifact): HTMLElement => {
    const entry = el('li', `artifact is-${artifact.kind}`);
    const head = el('div', 'artifact-head');
    const lines = artifact.text.split('\n');
    head.append(el('span', 'artifact-kind', heading(artifact)));
    if (artifact.kind !== 'formula') head.append(el('span', 'artifact-lines', () => tn('{0} line', '{0} lines', lines.length)));
    const copy = el('button', 'btn btn-icon artifact-copy') as HTMLButtonElement;
    copy.type = 'button';
    const glyph = icon('i-copy'); copy.append(glyph);
    ui(copy, 'title', () => t('Copy')); ui(copy, 'aria-label', () => t('Copy'));
    let copied = 0;
    copy.addEventListener('click', async () => {
      if (!await deps.copy(artifact.text)) return;
      setIcon(glyph, 'i-check'); ui(copy, 'title', () => t('Copied'));
      window.clearTimeout(copied);
      copied = window.setTimeout(() => { setIcon(glyph, 'i-copy'); ui(copy, 'title', () => t('Copy')); }, 1500);
    });
    head.append(copy);
    const shown = lines.slice(0, PREVIEW_LINES).join('\n');
    const preview = el('pre', 'artifact-preview', shown.slice(0, PREVIEW_CHARS));
    preview.classList.toggle('is-cut', lines.length > PREVIEW_LINES || shown.length > PREVIEW_CHARS);
    if (artifact.kind !== 'formula') preview.dir = 'ltr';
    const source = el('button', 'artifact-source') as HTMLButtonElement;
    source.type = 'button';
    source.append(el('span', 'artifact-answer', () => t('Answer {0}', [artifact.answer])));
    if (artifact.question) {
      const question = el('span', 'artifact-question', artifact.question);
      question.dir = 'auto'; source.append(question);
    }
    ui(source, 'title', () => t('Show in chat'));
    source.addEventListener('click', () => { if (sessionId) deps.reveal(sessionId, artifact.location); });
    entry.append(head, preview, source);
    return entry;
  };

  function paint(): void {
    const counts = new Map<ArtifactFilter, number>([['all', artifacts.length]]);
    for (const artifact of artifacts) counts.set(artifact.kind, (counts.get(artifact.kind) ?? 0) + 1);
    // A kind this chat has none of cannot be chosen; a choice whose kind is gone falls back to All.
    if (filter !== 'all' && !counts.get(filter)) filter = 'all';
    for (const [key, { button, count }] of choices) {
      const n = counts.get(key) ?? 0;
      button.disabled = key !== 'all' && n === 0;
      button.setAttribute('aria-pressed', String(key === filter)); button.classList.toggle('is-selected', key === filter);
      count.textContent = n ? String(n) : '';
    }
    const shown = filter === 'all' ? artifacts : artifacts.filter(artifact => artifact.kind === filter);
    // The same list again (a reload after paging, a repaint) keeps the reader's place in it.
    const next = JSON.stringify([sessionId, filter, shown]);
    if (next !== painted) { painted = next; list.replaceChildren(...shown.map(item)); }
    status.hidden = shown.length > 0 && !limited;
    ui(status, 'textContent', () => loading && !shown.length ? t('Loading…')
      : failed && !shown.length ? t("Could not read this chat's artifacts.")
        : !shown.length ? t('No code, tables or formulas in this chat') : t('Showing the first {0}', [artifacts.length]));
  }

  function load(): void {
    if (pane.hidden || !sessionId) return;
    const key = `${sessionId}\u0000${wanted}`;
    if (key === loaded) return;
    loaded = key;
    const id = sessionId, mine = ++generation;
    loading = true; paint();
    void deps.load(id).catch(() => null).then(reply => {
      if (mine !== generation) return;
      loading = false;
      // A failed read keeps what was listed, or says it failed, instead of claiming the chat has none.
      // It is tried again when the panel next opens or the answers change, not on every repaint.
      failed = !reply;
      if (reply) { artifacts = reply.artifacts; limited = Boolean(reply.limited); }
      paint();
    });
  }

  pane.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); deps.onEscape?.(); }
  });

  return {
    element: pane,
    show(mount: HTMLElement): void {
      if (pane.parentElement !== mount) mount.append(pane);
      pane.hidden = false;
      if (failed) { failed = false; loaded = null; }
      paint(); load();
    },
    hide(): void { pane.hidden = true; },
    /**
     * The open chat and what its answers last changed by; listed again when either moves, now
     * while the panel shows, else when it next opens.
     */
    update(id: string | null, version: string): void {
      if (id !== sessionId) {
        sessionId = id; artifacts = []; limited = false; loaded = null; generation++; loading = false; failed = false;
        if (!pane.hidden) paint();
      }
      wanted = version;
      load();
    }
  };
}
