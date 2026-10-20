/**
 * Sources: one list of every page the open chat's answers cite, opened from the globe under an
 * answer that cites any. Main reads it from the whole recording (`sessions:sources`), so the list
 * does not depend on which page of the chat is loaded. Each page opens through the app's link
 * route; each answer citing it opens the chat at that answer. The list, or the part a search
 * leaves, copies as a Markdown list.
 */
import type { SessionSearchLocation, SessionSource, SessionSourcesReply } from '../shared/session.js';
import { $, el } from './dom.js';
import { currentLanguage, t, ui } from './i18n.js';

export interface ChatSourcesDeps {
  sources(id: string): Promise<SessionSourcesReply | null>;
  /** Opens the page through the main process's validated link route. */
  openLink(url: string): void;
  /** Scrolls the open chat to the answer, loading the history page around it when needed. */
  reveal(id: string, location: SessionSearchLocation): void;
  copy(text: string): Promise<boolean>;
}

const siteOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

/** `- [Title](url)` per page: brackets in a title and parentheses in a link cannot end them early. */
export function sourcesMarkdown(sources: readonly SessionSource[]): string {
  return sources.map(source => `- [${source.title.replace(/[\\[\]]/g, '\\$&')}](${source.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`).join('\n');
}

export function initChatSources(deps: ChatSourcesDeps): { open(id: string): void; selectionChanged(): void } {
  const dialog = $<HTMLDialogElement>('sourcesDialog');
  const field = $<HTMLInputElement>('sourcesFilter');
  const copy = $<HTMLButtonElement>('sourcesCopy');
  const list = $('sourcesList');
  let sessionId: string | null = null;
  let all: SessionSource[] = [];
  let limited = false;
  let generation = 0;
  let copiedTimer = 0;

  const shown = (): SessionSource[] => {
    const words = field.value.toLocaleLowerCase(currentLanguage()).split(/\s+/).filter(Boolean);
    if (!words.length) return all;
    return all.filter(source => {
      const text = [source.title, source.url, source.source ?? '', source.snippet ?? ''].join(' ').toLocaleLowerCase(currentLanguage());
      return words.every(word => text.includes(word));
    });
  };

  const row = (source: SessionSource): HTMLElement => {
    const box = el('div', 'source-row');
    box.setAttribute('role', 'listitem');
    const title = el('button', 'source-title', source.title) as HTMLButtonElement;
    title.type = 'button';
    title.dir = 'auto';
    title.title = source.url;
    title.addEventListener('click', () => deps.openLink(source.url));
    const meta = [source.source || siteOf(source.url)];
    if (source.date) meta.push(new Date(source.date).toLocaleDateString(currentLanguage(), { year: 'numeric', month: 'short', day: 'numeric' }));
    box.append(title, el('span', 'source-meta', meta.join(' · ')));
    if (source.snippet) {
      const snippet = el('span', 'search-snippet', source.snippet);
      snippet.dir = 'auto';
      box.append(snippet);
    }
    const cited = el('div', 'source-cited');
    cited.append(el('span', 'source-cited-label', () => t('Cited in')));
    for (const { answer: number, question, location } of source.citedBy) {
      const answer = el('button', 'source-answer', question || (() => t('Answer {0}', [number]))) as HTMLButtonElement;
      answer.type = 'button';
      answer.dir = 'auto';
      if (question) answer.title = question;
      answer.addEventListener('click', () => {
        const id = sessionId;
        dialog.close();
        if (id) deps.reveal(id, location);
      });
      cited.append(answer);
    }
    if (source.moreAnswers) cited.append(el('span', 'source-cited-label', `+${source.moreAnswers}`));
    box.append(cited);
    return box;
  };

  const paint = (): void => {
    const sources = shown();
    copy.disabled = !sources.length;
    // A page the search would find may be among those left out.
    const note = limited ? [el('p', 'search-status', () => t('Only the first 500 cited pages are listed.'))] : [];
    if (!sources.length) {
      list.replaceChildren(el('p', 'empty search-status', () => all.length ? t('No sources match') : t('No sources in this chat')), ...note);
      return;
    }
    const rows = el('div', 'search-list');
    rows.setAttribute('role', 'list');
    rows.append(...sources.map(row));
    list.replaceChildren(rows, ...note);
  };

  const open = (id: string): void => {
    const mine = ++generation;
    sessionId = id;
    all = [];
    limited = false;
    field.value = '';
    list.replaceChildren();
    copy.disabled = true;
    if (!dialog.open) dialog.showModal();
    field.focus();
    void deps.sources(id).then(sources => {
      if (mine !== generation || !dialog.open) return;
      all = sources?.sources ?? [];
      limited = Boolean(sources?.limited);
      paint();
    });
  };

  ui(dialog, 'aria-label', () => t('Sources'));
  ui(field, 'placeholder', () => t('Search sources'));
  ui(field, 'aria-label', () => t('Search sources'));
  ui(copy, 'textContent', () => t('Copy as Markdown'));
  field.addEventListener('input', paint);
  copy.addEventListener('click', async () => {
    const sources = shown();
    if (!sources.length || !await deps.copy(sourcesMarkdown(sources))) return;
    ui(copy, 'textContent', () => t('Copied'));
    window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => ui(copy, 'textContent', () => t('Copy as Markdown')), 1500);
  });
  // A click on the backdrop lands on the dialog itself, never on its contents.
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { generation++; });
  // Another chat was opened (a shortcut works behind the dialog): this list is not its list.
  return { open, selectionChanged: () => { if (dialog.open) dialog.close(); } };
}
