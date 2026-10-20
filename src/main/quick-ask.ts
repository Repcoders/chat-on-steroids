/**
 * Quick ask: an opt-in global shortcut (`ui.quickAsk`) opens a small window that takes a question
 * and a project from any app, starts a new chat with it and shows the finished answer.
 *
 * It is not a second send path. The question goes through `sendDesktopInput` as a new chat's first
 * message, exactly as the composer's New chat and the control API send one, and the outbox stays
 * the only owner of what was admitted and delivered. The answer is read back from the recorded
 * session, the way turn-done notifications read it; this module owns no fact of its own.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import { z } from 'zod';
import { defaultAppearance } from '../shared/appearance.js';
import { resolveChatModel } from '../shared/chat-models.js';
import type { QuickAskAnswer, QuickAskState } from '../shared/quick-ask.js';
import type { ReasoningEffort } from '../shared/session.js';
import { MAX_CHATGPT_MESSAGE_CHARS } from '../shared/user-prompt.js';
import { getChatModels } from './chat-models.js';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';
import { listProjects } from './projects.js';
import { onSessionChange } from './session/recorder.js';
import { getSession, readRecentEvents } from './session/store.js';
import { sendDesktopInput } from './session/start-input.js';

/** Ctrl+Alt+Space leaves editors' Ctrl+Shift+Space alone; on macOS Option+Space is often taken. */
export const QUICK_ASK_SHORTCUT = process.platform === 'darwin' ? 'Command+Shift+Space' : 'Control+Alt+Space';

const sendArgs = z.object({
  text: z.string().trim().min(1).max(MAX_CHATGPT_MESSAGE_CHARS),
  projectId: z.string().uuid().nullable()
}).strict();
const sessionArg = z.object({ sessionId: z.string().regex(/^[0-9a-z-]{8,64}$/i) }).strict();

let ownerWindow: (() => BrowserWindow | null) | null = null;
let activateOwner: (() => void) | null = null;
let win: BrowserWindow | null = null;
let registered = false;
let ipcReady = false;
/** Between start and shutdown; a shortcut press outside it opens nothing. */
let started = false;
let stopSessions: (() => void) | null = null;
/** The one question this window waits on; a newer one replaces it. */
let pending: { sessionId: string; sentAt: number } | null = null;

function validSender(id: number): boolean { return !!win && !win.isDestroyed() && win.webContents.id === id; }
function reply<T>(work: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  return work().then(data => ({ ok: true as const, data }), (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
}

function palette(): { theme: 'light' | 'dark'; background: string; accent: string } {
  const ui = getConfig().ui, theme = ui.theme === 'light' ? 'light' : 'dark';
  const { background, accent } = (ui.appearance ?? defaultAppearance())[theme];
  return { theme, background, accent };
}

async function state(): Promise<QuickAskState> {
  // A removed sidebar group keeps its chats but takes no new ones from here.
  const projects = (await listProjects()).filter(project => !project.ungrouped).map(project => ({ id: project.id, name: project.name }));
  return { ...palette(), projects };
}

/**
 * The composer's default for a fresh ordinary chat, when the account still offers it; else ChatGPT's
 * own. Without a saved effort the composer picks High where the model has it, else its first.
 */
function defaultModel(): { model: string | null; reasoningEffort: ReasoningEffort | null } {
  const { defaultChatModel, defaultChatReasoning } = getConfig().ui;
  const catalog = getChatModels();
  const choice = defaultChatModel && catalog.state === 'ready' ? resolveChatModel(catalog.models, defaultChatModel) : undefined;
  const effort = !choice ? undefined : defaultChatReasoning
    ? choice.efforts.find(item => item === defaultChatReasoning)
    : choice.efforts.includes('high') ? 'high' : choice.efforts[0];
  return choice && effort ? { model: choice.id, reasoningEffort: effort } : { model: null, reasoningEffort: null };
}

async function send(raw: unknown): Promise<{ sessionId: string; error: string | null }> {
  const { text, projectId } = sendArgs.parse(raw);
  if (projectId && !(await listProjects()).some(project => project.id === projectId && !project.ungrouped)) throw new Error('This project is no longer in the app.');
  const id = randomUUID(), sentAt = Date.now();
  const entry = await sendDesktopInput({ id, sessionId: null, ...(projectId ? { projectId } : {}), text, mode: 'auto', dueAt: Date.now(), ...defaultModel(), authoredSource: 'text' });
  // A new chat's first message is filed under its own id.
  const sessionId = entry.sessionId ?? id;
  pending = { sessionId, sentAt };
  logInfo(`quick ask: started chat ${sessionId}`);
  return { sessionId, error: entry.error ?? null };
}

/** The chat's finished answer once its turn ended after the question went out. */
export async function quickAskAnswer(sessionId: string, sentAt: number): Promise<QuickAskAnswer | null> {
  const session = await getSession(sessionId);
  if (!session || session.activeTurnId || (session.lastTurnEndAt ?? 0) < sentAt) return null;
  // A fresh turn for long work (#1402) ends the turn before it as interrupted; the answer follows.
  if (session.lastTurnOutcome === 'interrupted') return null;
  if (session.lastTurnOutcome !== 'completed') return { sessionId, text: null };
  const [answer] = await readRecentEvents(sessionId, 1, { kinds: ['assistant_message'] });
  return { sessionId, text: answer?.kind === 'assistant_message' ? answer.message.text : null };
}

async function checkPending(): Promise<void> {
  const waiting = pending;
  if (!waiting) return;
  const answer = await quickAskAnswer(waiting.sessionId, waiting.sentAt).catch(() => null);
  if (!answer || pending !== waiting) return;
  pending = null;
  if (win && !win.isDestroyed()) win.webContents.send('quick-ask:answer', answer);
}

function openChat(sessionId: string): void {
  activateOwner?.();
  const owner = ownerWindow?.() ?? null;
  if (!owner || owner.isDestroyed()) return;
  const open = (): void => { if (!owner.webContents.isDestroyed()) owner.webContents.send('session:write', sessionId); };
  if (owner.webContents.isLoadingMainFrame()) owner.webContents.once('did-finish-load', open); else open();
  win?.hide();
}

function registerIpc(): void {
  if (ipcReady) return;
  ipcReady = true;
  ipcMain.handle('quick-ask:state', event => validSender(event.sender.id) ? reply(state) : { ok: false, error: 'Not allowed' });
  ipcMain.handle('quick-ask:send', (event, payload: unknown) => validSender(event.sender.id) ? reply(() => send(payload)) : { ok: false, error: 'Not allowed' });
  ipcMain.on('quick-ask:openChat', (event, payload: unknown) => {
    const parsed = sessionArg.safeParse(payload);
    if (validSender(event.sender.id) && parsed.success) openChat(parsed.data.sessionId);
  });
  ipcMain.on('quick-ask:hide', event => { if (validSender(event.sender.id)) win?.hide(); });
}

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  const next = new BrowserWindow({
    width: 560, height: 420, show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, title: 'Quick ask',
    // Painted before the page loads, so a dark window never flashes white.
    backgroundColor: palette().background,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, preload: path.join(__dirname, '../preload/quick-ask.js') }
  });
  win = next;
  next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  next.webContents.on('will-navigate', event => event.preventDefault());
  next.webContents.on('will-redirect', event => event.preventDefault());
  // Like a launcher, it steps aside when another window takes focus; a pending answer still arrives.
  next.on('blur', () => { if (!next.webContents.isDevToolsOpened()) next.hide(); });
  next.on('closed', () => { if (win === next) win = null; });
  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.endsWith('/') ? process.env.ELECTRON_RENDERER_URL : `${process.env.ELECTRON_RENDERER_URL}/`;
    void next.loadURL(new URL('quick-ask.html', base).toString());
  } else void next.loadFile(path.join(__dirname, '../renderer/quick-ask.html'));
  return next;
}

/** The shortcut toggles the window, centered near the top of the display under the pointer. */
export function toggleQuickAsk(): void {
  if (!started) return;
  const current = win && !win.isDestroyed() ? win : null;
  if (current?.isVisible() && current.isFocused()) { current.hide(); return; }
  const target = ensureWindow();
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [width] = target.getSize() as [number, number];
  target.setPosition(Math.round(area.x + (area.width - width) / 2), Math.round(area.y + area.height / 5));
  const show = (): void => {
    if (target.isDestroyed()) return;
    target.show(); target.focus();
    target.webContents.send('quick-ask:shown');
  };
  if (target.webContents.isLoadingMainFrame()) target.webContents.once('did-finish-load', show); else show();
}

/** Registers or releases the shortcut. Throws when another app already holds it. */
export function setQuickAskShortcut(enabled: boolean): void {
  if (!enabled) {
    if (registered) globalShortcut.unregister(QUICK_ASK_SHORTCUT);
    registered = false;
    win?.hide();
    return;
  }
  if (registered) return;
  if (!globalShortcut.register(QUICK_ASK_SHORTCUT, toggleQuickAsk)) {
    logWarn(`quick ask: ${QUICK_ASK_SHORTCUT} is already used by another app`);
    throw new Error(`Quick ask could not use ${QUICK_ASK_SHORTCUT}: another app already uses it.`);
  }
  registered = true;
  logInfo(`quick ask: ${QUICK_ASK_SHORTCUT} opens quick ask`);
}

export function startQuickAsk(getOwner: () => BrowserWindow | null, requestOwner: () => void): void {
  ownerWindow = getOwner; activateOwner = requestOwner; started = true;
  registerIpc();
  stopSessions ??= onSessionChange(change => {
    if (pending && (change.allTranscripts || change.sessionIds?.includes(pending.sessionId))) void checkPending();
  });
  // A shortcut another app took at startup must not stop the app. It is logged, and turning the
  // setting off and on again says so in Settings.
  try { setQuickAskShortcut(getConfig().ui.quickAsk === true); } catch { /* logged */ }
}

export function shutdownQuickAsk(): void {
  started = false;
  if (registered) globalShortcut.unregister(QUICK_ASK_SHORTCUT);
  registered = false;
  stopSessions?.(); stopSessions = null;
  pending = null;
  const current = win; win = null;
  if (current && !current.isDestroyed()) current.destroy();
}
