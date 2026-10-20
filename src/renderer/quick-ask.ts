/**
 * The quick-ask window's page (src/main/quick-ask.ts). It sends one question as a new chat through
 * its fixed preload API and shows that chat's finished answer; the main window keeps the chat.
 */
import { Marked } from 'marked';
import { t } from './i18n.js';
import { sanitizeHtmlTree } from './sanitize-html.js';
import { providerEntitiesAsMarkdown } from '../shared/content-reference.js';
import type { QuickAskApi } from '../preload/quick-ask.js';
import type { QuickAskState } from '../shared/quick-ask.js';

const ANSWER_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'STRONG', 'EM', 'DEL', 'BR', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']);
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'LINK', 'META']);
const markdown = new Marked({ gfm: true });

/** The answer drawn from its Markdown; links read as their text, and nothing from the page can run. */
export function renderAnswer(target: HTMLElement, source: string): void {
  const template = document.createElement('template');
  template.innerHTML = markdown.parse(providerEntitiesAsMarkdown(source), { async: false }) as string;
  sanitizeHtmlTree(template.content, { allowedTags: ANSWER_TAGS, dropTags: DROP_TAGS, safeHref: () => null });
  target.replaceChildren(template.content);
}

const PROJECT_KEY = 'cos.quickAsk.project';

export function startQuickAskPage(api: QuickAskApi): void {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const text = $<HTMLTextAreaElement>('text'), project = $<HTMLSelectElement>('project'), send = $<HTMLButtonElement>('send');
  const result = $('result'), asked = $('question'), status = $('status'), answer = $('answer'), open = $<HTMLButtonElement>('open');
  /** The chat the result area speaks for; a newer question takes it over. */
  let sessionId: string | null = null;

  const remembered = (): string => { try { return localStorage.getItem(PROJECT_KEY) ?? ''; } catch { return ''; } };
  const paint = (state: QuickAskState): void => {
    const root = document.documentElement;
    root.dataset.theme = state.theme;
    root.style.setProperty('--page', state.background);
    root.style.setProperty('--accent', state.accent);
    const wanted = project.value || remembered();
    project.replaceChildren(new Option(t('No project'), ''), ...state.projects.map(row => new Option(row.name, row.id)));
    project.value = state.projects.some(row => row.id === wanted) ? wanted : '';
  };
  const show = (message: string, body: string | null): void => {
    result.hidden = false;
    status.textContent = message;
    if (body === null) answer.replaceChildren(); else renderAnswer(answer, body);
    open.hidden = !sessionId;
  };
  const submit = async (): Promise<void> => {
    const question = text.value.trim();
    if (!question || send.disabled) return;
    send.disabled = true;
    try {
      const reply = await api.send(question, project.value || null);
      if (!reply.ok) { show(reply.error, null); return; }
      sessionId = reply.data.sessionId;
      asked.textContent = question;
      try { localStorage.setItem(PROJECT_KEY, project.value); } catch { /* A convenience only. */ }
      text.value = '';
      show(reply.data.error ?? t('Waiting for the answer…'), null);
    } finally { send.disabled = false; }
  };
  const refresh = async (): Promise<void> => {
    const reply = await api.state();
    if (reply.ok) paint(reply.data);
    text.focus();
  };

  document.title = t('Quick ask');
  text.placeholder = t('Ask anything…');
  project.setAttribute('aria-label', t('Project'));
  send.textContent = t('Send');
  open.textContent = t('Open chat');
  $('form').addEventListener('submit', event => { event.preventDefault(); void submit(); });
  text.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit(); }
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') api.hide(); });
  open.addEventListener('click', () => { if (sessionId) api.openChat(sessionId); });
  api.onAnswer(reply => {
    if (reply.sessionId !== sessionId) return;
    if (reply.text === null) show(t('The chat ended without an answer. Open it to see what happened.'), null);
    else show('', reply.text);
  });
  api.onShown(() => void refresh());
  void refresh();
}

const bridge = (window as unknown as { quickAskApi?: QuickAskApi }).quickAskApi;
if (bridge) startQuickAskPage(bridge);
