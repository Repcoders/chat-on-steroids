import type { TurnTrace } from '../shared/turn-trace.js';
import { ui, t, tn } from './i18n.js';
import type { AgentInfo, SessionSummary, SessionEvent } from '../shared/session.js';
import { workerReportedFinish } from '../shared/session-activity.js';
import { evaluateWorkerOverviewHealth } from '../shared/agent-health.js';
import { workerOwnTask } from '../shared/worker-brief.js';
import { compactNumber, el, icon } from './dom.js';
import { attachWorkPanelResize } from './work-panel-resize.js';
import { workerAvatar } from './agent-communication.js';
import { renderWorkerActivity } from './agent-activity.js';

/**
 * What to call a worker: the name the prime gave it for this job ("Security review"), else
 * "Worker 2". Its id (worker-2) is what the prime and the chat address it by; a label equal to it,
 * which is what a worker reused for new work carries, is no name.
 */
export function workerName(id: string, label: string | undefined): string {
  const given = label?.trim();
  if (given && given !== id) return given;
  const number = /^worker-(\d+)$/.exec(id)?.[1];
  return number ? t('Worker {0}', [number]) : id;
}

/** One word per agent state, the same in the panel, Settings and Activity (English catalog keys). */
export const AGENT_STATE_WORDS: Readonly<Record<string, string>> = {
  active: 'Working', invited: 'Opening', waking: 'Waking', detached: 'No tab', sleeping: 'Idle', failed: 'Failed', finished: 'Finished'
};

/** One message of a worker note, as `sessions:send` takes it. */
export type WorkerNoteMessage = { sessionId: string; projectId: string | null; text: string; mode: 'auto' | 'after-turn'; authoredSource?: 'none' };

/**
 * A note typed in a working worker's row (#59): the message its own chat gets, joining its running
 * turn, and with the copy on, an ordinary message to its prime saying what the worker is told. The
 * copy is the app's wording, not typed text (`authoredSource: 'none'`), and is sent the way the
 * prime's Follow-up behavior sends a message (`primeMode`).
 */
export function workerNoteMessages(note: { worker: Pick<SessionSummary, 'id' | 'projectId'>; prime?: Pick<SessionSummary, 'id' | 'projectId'> | null;
  identity: string; text: string; copy: boolean; primeMode: WorkerNoteMessage['mode'] }): WorkerNoteMessage[] {
  const messages: WorkerNoteMessage[] = [{ sessionId: note.worker.id, projectId: note.worker.projectId ?? null, text: note.text, mode: 'auto' }];
  if (note.copy && note.prime) messages.push({ sessionId: note.prime.id, projectId: note.prime.projectId ?? null, mode: note.primeMode,
    authoredSource: 'none', text: t('I am telling {0} directly: {1}', [note.identity, note.text]) });
  return messages;
}

/**
 * Sends a note's messages in order; true once the worker's own message is in the outbox. A message
 * the outbox already refused (failed or cancelled) stops the rest, so the prime never hears of it.
 */
export async function sendWorkerNote(messages: readonly WorkerNoteMessage[],
  send: (message: WorkerNoteMessage) => Promise<{ state: string } | null | undefined>): Promise<boolean> {
  let queued = false;
  for (const message of messages) {
    const entry = await send(message);
    if (!entry || entry.state === 'failed' || entry.state === 'cancelled') break;
    queued = true;
  }
  return queued;
}

/** How long a round's workers glow as the panel opens on them (`agent-arrive` in styles.css). */
const ARRIVAL_MS = 1600;

/** A second pane. Its selection never changes the main chat's composer; a working worker's row takes a note of its own. */
export function createAgentPanel(options: {
  host: HTMLElement;
  mount?: HTMLElement;
  toggle?: HTMLButtonElement;
  onShow?: () => void;
  onEscape?: () => void;
  load: (id: string) => Promise<{ events: SessionEvent[]; traces?: Record<string, TurnTrace> } | null>;
  render: (events: SessionEvent[], id: string, current: () => boolean, traces: Record<string, TurnTrace>) => HTMLElement[];
  /** A worker's tool calls for its Activity view (#105); without it a worker opens on its conversation. */
  loadActivity?: (id: string) => Promise<SessionEvent[] | null>;
  openMain: (id: string) => void;
  working: (summary: SessionSummary) => boolean;
  agent?: (summary: SessionSummary) => (Pick<AgentInfo, 'state' | 'task'> & Partial<Pick<AgentInfo, 'label'>> & { conversationId?: string | null }) | null;
  /** The model as the composer names it ("GPT-6 Sol · Instant"); the raw id without a catalog. */
  modelLabel?: (model: string, reasoningEffort: string | undefined) => string;
  /** Sends a note typed in a working worker's row; true once the worker's message is in the outbox. Without it rows take no notes. */
  sendNote?: (note: { sessionId: string; identity: string; text: string; copy: boolean }) => Promise<boolean>;
}) {
  const pane = el('aside', 'agent-panel'); pane.hidden = true;
  ui(pane, 'aria-label', () => t("Sub-agents"));
  if (!options.mount) attachWorkPanelResize(options.host, pane);
  const head = el('div', 'agent-panel-header'); head.hidden = true;
  const back = el('button', 'btn btn-icon agent-back'); back.append(icon('i-back'));
  ui(back, 'title', () => t("Back to sub-agents")); back.setAttribute('type', 'button');
  ui(back, 'aria-label', () => t("Back to sub-agents"));
  const title = el('strong');
  const body = el('div', 'agent-panel-body');
  head.append(back, title); pane.append(head, body); (options.mount ?? options.host).append(pane);
  // A worker opens on what it did; its conversation is one tab away. The choice holds from worker to worker.
  type View = 'activity' | 'conversation';
  let view: View = options.loadActivity ? 'activity' : 'conversation';
  const views = el('div', 'agent-panel-views'); views.setAttribute('role', 'tablist');
  ui(views, 'aria-label', () => t('Sub-agent view'));
  const viewTabs = new Map<View, HTMLButtonElement>();
  for (const [key, label] of [['activity', () => t('Activity')], ['conversation', () => t('Conversation')]] as const) {
    const tab = el('button', 'agent-panel-view', label) as HTMLButtonElement;
    tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.dataset.view = key;
    tab.onclick = () => { if (view !== key && selected) { view = key; void open(selected); } };
    viewTabs.set(key, tab); views.append(tab);
  }
  views.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !selected) return;
    event.preventDefault();
    const next: View = event.key === 'Home' ? 'activity' : event.key === 'End' ? 'conversation' : view === 'activity' ? 'conversation' : 'activity';
    if (next !== view) { view = next; void open(selected); }
    viewTabs.get(view)?.focus();
  });
  if (options.loadActivity) head.append(views);
  const paintViews = (): void => {
    for (const [key, tab] of viewTabs) {
      tab.setAttribute('aria-selected', String(key === view));
      tab.tabIndex = key === view ? 0 : -1;
      tab.classList.toggle('is-selected', key === view);
    }
  };
  let parent: string | null = null, workers: SessionSummary[] = [], selected: string | null = null;
  let generation = 0;
  let highlighted = new Set<string>();
  // The round's workers glow once as the panel opens on them, not on every repaint after.
  let arriving = false;
  // Every worker update repaints the list, so a note being typed lives here, not in its field.
  const notes = new Map<string, string>(), sendingNotes = new Set<string>();
  let noteCopy = false;
  // A repaint would replace a field mid-composition and lose the IME's unfinished conversion; it waits.
  let composing = false, repaintAfterComposition = false;
  function paintNote(form: HTMLElement): void {
    const id = form.dataset.workerSession!;
    const input = form.querySelector<HTMLInputElement>('.agent-note-input')!;
    input.value = notes.get(id) ?? '';
    input.readOnly = sendingNotes.has(id);
    form.querySelector<HTMLInputElement>('.agent-note-copy-box')!.checked = noteCopy;
    form.toggleAttribute('aria-busy', sendingNotes.has(id));
  }
  async function submitNote(id: string, identity: string): Promise<void> {
    const text = notes.get(id)?.trim();
    if (!text || sendingNotes.has(id) || !options.sendNote) return;
    sendingNotes.add(id);
    const paint = (): void => { for (const form of body.querySelectorAll<HTMLElement>('.agent-note')) if (form.dataset.workerSession === id) paintNote(form); };
    paint();
    let sent = false;
    try { sent = await options.sendNote({ sessionId: id, identity, text, copy: noteCopy }); }
    finally {
      sendingNotes.delete(id);
      // Queued: the field empties for the next note. Refused: the words stay to send again.
      if (sent && notes.get(id)?.trim() === text) notes.delete(id);
      paint();
    }
  }
  function noteField(id: string, identity: string, name: string): HTMLElement {
    const form = el('form', 'agent-note'); form.dataset.workerSession = id;
    const input = el('input', 'agent-note-input') as HTMLInputElement; input.type = 'text';
    ui(input, 'placeholder', () => t('Note to {0}', [name])); ui(input, 'aria-label', () => t('Note to {0}', [name]));
    input.oninput = () => { if (input.value) notes.set(id, input.value); else notes.delete(id); };
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => {
      composing = false;
      if (repaintAfterComposition) { repaintAfterComposition = false; if (!selected && !pane.hidden) list(); }
    });
    const copy = el('label', 'agent-note-copy');
    const box = el('input', 'agent-note-copy-box') as HTMLInputElement; box.type = 'checkbox';
    box.onchange = () => { noteCopy = box.checked; };
    copy.append(box, el('span', '', () => t('Also tell the main chat')));
    const send = el('button', 'btn btn-icon agent-note-send') as HTMLButtonElement; send.type = 'submit'; send.append(icon('i-arrow-up'));
    ui(send, 'title', () => t('Send note')); ui(send, 'aria-label', () => t('Send note'));
    form.onsubmit = event => { event.preventDefault(); void submitNote(id, identity); };
    form.append(input, send, copy); paintNote(form);
    return form;
  }
  function hide(): void {
    generation++; selected = null; highlighted.clear(); pane.hidden = true; composing = repaintAfterComposition = false;
    if (!options.mount) options.host.classList.remove('has-agent-panel');
    options.toggle?.setAttribute('aria-expanded', 'false');
  }
  function show(): void {
    options.onShow?.();
    pane.hidden = false;
    if (!options.mount) options.host.classList.add('has-agent-panel');
    options.toggle?.setAttribute('aria-expanded', 'true');
  }
  /** Who a worker is and its own task: the run's shared context, the same for every worker, left out. */
  function describe(worker: SessionSummary): { identity: string; task: string; name: string } {
    const owner = options.agent?.(worker);
    const identity = worker.origin?.agentId ?? worker.title.split(' · ')[0] ?? worker.title;
    const saved = worker.workerAssignment?.agentId === identity && worker.workerAssignment.conversationId === worker.conversationId
      ? worker.workerAssignment : null;
    const task = workerOwnTask(owner?.task?.trim() || saved?.task || worker.origin?.task || worker.title);
    return { identity, task, name: workerName(identity, owner?.label ?? saved?.label) };
  }
  function list(): void {
    if (composing && !selected) { repaintAfterComposition = true; return; }
    // A note field being typed in keeps focus and caret through the repaint.
    const active = document.activeElement as HTMLInputElement | null;
    const typing = active && body.contains(active) ? active.closest<HTMLElement>('.agent-note') : null;
    const caret = typing && active!.type === 'text' ? [active!.selectionStart, active!.selectionEnd] as const : null;
    generation++; selected = null; head.hidden = true; body.replaceChildren();
    const isActive = (worker: SessionSummary): boolean => {
      const state = options.agent?.(worker)?.state;
      return state ? ['invited', 'active', 'detached', 'waking'].includes(state) : options.working(worker);
    };
    for (const active of [true, false]) {
      const group = workers.filter(worker => isActive(worker) === active);
      const failed = active ? 0 : group.filter(worker => options.agent?.(worker)?.state === 'failed').length;
      body.append(el('h3', '', () =>
        `${active ? t("Active") : t("History")} · ${group.length}${failed ? ` · ${tn('{0} failed', '{0} failed', failed)}` : ''}`));
      if (!group.length) { body.append(el('p', 'meta', () => active ? t("No active sub-agents") : t("No recorded sub-agents"))); continue; }
      for (const worker of group) {
        const row = el('button', 'agent-panel-row'); row.setAttribute('type', 'button');
        row.dataset.workerSession = worker.id;
        row.classList.toggle('is-round-worker', highlighted.has(worker.id));
        if (arriving && highlighted.has(worker.id)) {
          // The glow plays once: the class leaves with it, so a later layout change (closing the
          // sidebar, the dock showing again) has nothing to replay. Reduced motion shows it as
          // still, for the same time.
          row.classList.add('is-arriving');
          const settle = (): void => { row.classList.remove('is-arriving'); };
          row.addEventListener('animationend', settle, { once: true });
          setTimeout(settle, ARRIVAL_MS);
        }
        const owner = options.agent?.(worker);
        const state = owner?.state ?? (workerReportedFinish(worker) ? 'sleeping' : active ? 'working' : 'history');
        row.dataset.state = state;
        const health = evaluateWorkerOverviewHealth({
          state: owner?.state ?? null,
          exactIdentity: Boolean(owner?.conversationId && worker.conversationId &&
            owner.conversationId === worker.conversationId),
          working: options.working(worker),
          activeTurn: worker.activeTurnId !== null && worker.activeTurnId !== undefined
        });
        row.dataset.health = health.health;
        const { identity, task, name } = describe(worker);
        // A worker still opening has no conversation yet; undefined === undefined must not read a model.
        const observed = worker.selectedModel && worker.conversationId && worker.selectedModel.conversationId === worker.conversationId
          ? worker.selectedModel : null;
        const elapsedMs = Math.max(0, (active ? Date.now() : worker.endedAt ?? worker.updatedAt) - worker.startedAt);
        const elapsed = elapsedMs < 60_000 ? `${Math.floor(elapsedMs / 1000)}s`
          : elapsedMs < 3_600_000 ? `${Math.floor(elapsedMs / 60_000)}m` : `${Math.floor(elapsedMs / 3_600_000)}h`;
        const working = state === 'working' || state === 'active';
        // The avatar carries the state: a dot of presence, and while working the app's traveling
        // light around it (the connection capsule's). Its phase follows the clock, so the many
        // repaints of a working list never restart it.
        const portrait = el('span', 'agent-card-avatar');
        portrait.append(workerAvatar(worker.origin?.agentId ?? '•'), el('span', 'agent-card-presence'));
        if (working) portrait.style.setProperty('--phase', `${-(Date.now() % 2400)}ms`);
        const content = el('span', 'agent-card-content');
        const heading = el('span', 'agent-card-heading');
        heading.append(el('strong', 'agent-card-name', name), el('span', 'agent-card-time', elapsed));
        const statusLabel: Record<string, string> = { ...AGENT_STATE_WORDS, working: 'Working', history: 'Finished' };
        const meta = el('span', 'agent-card-meta');
        const part = (className: string, text: string | (() => string)): void => {
          if (meta.childElementCount) meta.append(el('span', 'agent-card-sep', '·'));
          meta.append(el('span', className, text));
        };
        part('agent-card-state', () => t(statusLabel[state] ?? state));
        if (observed) part('agent-card-model', () => options.modelLabel?.(observed.model, observed.reasoningEffort)
          ?? [observed.model, observed.reasoningEffort === 'none' ? t('Instant') : observed.reasoningEffort].filter(Boolean).join(' · '));
        // A worker still opening has done nothing yet: no count until there is one.
        if (worker.toolCalls) part('agent-card-actions', () => t('{0} actions', [compactNumber(worker.toolCalls ?? 0)]));
        // Only a problem is worth a word; a healthy or unknown worker says nothing about it, and a
        // failed one has already said it.
        if (health.health === 'degraded' && state !== 'failed') part('agent-card-health', () => t('Degraded'));
        const activityBoundary = Math.max(worker.lastFinishReportAt ?? 0, worker.lastTurnEndAt ?? 0);
        const currentActivity = worker.lastToolCallAt != null && worker.lastToolCallAt > activityBoundary &&
          worker.lastToolCallAt >= (worker.finishTurn?.startedAt ?? 0);
        // A failed worker keeps its last action in view: where it stopped is the first thing to know.
        const lastAction = state === 'failed' && worker.lastToolActivity
          ? el('span', 'agent-card-last', () => t('Last action: {0}', [worker.lastToolActivity!.title])) : null;
        const activity = working && currentActivity && worker.lastToolActivity ? el('span', 'agent-card-activity', worker.lastToolActivity.title) : null;
        if (activity) {
          activity.dataset.kind = worker.lastToolActivity!.kind;
          activity.style.setProperty('--phase', `${-(Date.now() % 1800)}ms`);
        }
        content.append(heading, el('span', 'agent-card-task', task), ...(activity ? [activity] : lastAction ? [lastAction] : []), meta);
        row.append(portrait, content);
        // The id the prime and the chat use for it (worker-2) stays one hover away, and in its avatar.
        row.title = `${identity} · ${task}`;
        row.onclick = () => void open(worker.id);
        body.append(row);
        if (working && options.sendNote) body.append(noteField(worker.id, identity, name));
      }
    }
    arriving = false;
    if (typing) {
      const form = [...body.querySelectorAll<HTMLElement>('.agent-note')].find(node => node.dataset.workerSession === typing.dataset.workerSession);
      const field = form?.querySelector<HTMLInputElement>(`.${active!.classList[0]}`);
      field?.focus({ preventScroll: true });
      if (field && caret) field.setSelectionRange(caret[0], caret[1]);
    }
  }
  async function open(id: string, refresh = false): Promise<void> {
    const worker = workers.find(row => row.id === id);
    if (!worker) return;
    const preserve = refresh && selected === id && !pane.hidden;
    if (!refresh) show();
    selected = id; const request = ++generation;
    head.hidden = false; title.textContent = worker.title; paintViews();
    const shown = view;
    if (!preserve) body.replaceChildren(el('p', 'meta', () => shown === 'activity' ? t("Loading activity…") : t("Loading conversation…")));
    const current = () => request === generation && selected === id && view === shown && !pane.hidden;
    const openMain = el('button', 'btn', () => t("Open full chat")); openMain.setAttribute('type', 'button');
    openMain.onclick = () => { if (current()) { hide(); options.openMain(id); } };
    const position = body.scrollTop;
    if (shown === 'activity' && options.loadActivity) {
      const events = await options.loadActivity(id);
      if (!current()) return;
      if (!events) { body.replaceChildren(el('p', 'meta', () => t("Activity unavailable"))); return; }
      const follow = !preserve || position + body.clientHeight >= body.scrollHeight - 40;
      body.replaceChildren(openMain, ...renderWorkerActivity(events, describe(worker).task));
      body.scrollTop = follow ? body.scrollHeight : position;
      return;
    }
    const detail = await options.load(id);
    if (!current()) return;
    if (!detail) { body.replaceChildren(el('p', 'meta', () => t("Conversation unavailable"))); return; }
    const follow = !preserve || position + body.clientHeight >= body.scrollHeight - 40;
    body.replaceChildren(openMain, ...options.render(detail.events, id, current, detail.traces ?? {}));
    body.scrollTop = follow ? body.scrollHeight : position;
  }
  back.onclick = list;
  pane.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); hide();
    if (options.onEscape) options.onEscape(); else options.toggle?.focus();
  });
  if (options.toggle) options.toggle.onclick = () => { if (pane.hidden) { show(); list(); } else hide(); };
  return {
    hide,
    show: () => { highlighted.clear(); show(); list(); },
    /** Opens the list on a round's workers; `focus` (the keyboard's way in) moves focus to the first. */
    showWorkers(ids: string[], focus = true): void {
      highlighted = new Set(workers.filter(worker => ids.includes(worker.id)).map(worker => worker.id));
      if (!highlighted.size) return;
      arriving = true;
      show(); list();
      if (focus) body.querySelector<HTMLButtonElement>('.is-round-worker')?.focus({ preventScroll: true });
    },
    open,
    update(id: string | null, next: SessionSummary[]): void {
      if (parent !== id) { hide(); parent = id; }
      const previous = workers.find(worker => worker.id === selected);
      workers = next;
      highlighted = new Set([...highlighted].filter(id => workers.some(worker => worker.id === id)));
      if (options.toggle) {
        options.toggle.hidden = id === null;
        ui(options.toggle, 'title', () => t("Sub-agents · {0} recorded", [workers.length]));
      }
      if (pane.hidden) return;
      const latest = workers.find(worker => worker.id === selected);
      if (!selected || !latest) list();
      else if (latest.updatedAt !== previous?.updatedAt) void open(latest.id, true);
    }
  };
}
