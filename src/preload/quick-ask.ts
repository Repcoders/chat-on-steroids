import { contextBridge, ipcRenderer } from 'electron';
import type { QuickAskAnswer, QuickAskState } from '../shared/quick-ask.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
const call = <T>(channel: string, payload?: unknown): Promise<Reply<T>> => ipcRenderer.invoke(channel, payload) as Promise<Reply<T>>;

/** The quick-ask window's whole API: one fixed channel per method, as in the main preload. */
const api = {
  state: () => call<QuickAskState>('quick-ask:state'),
  send: (text: string, projectId: string | null) => call<{ sessionId: string; error: string | null }>('quick-ask:send', { text, projectId }),
  openChat: (sessionId: string): void => ipcRenderer.send('quick-ask:openChat', { sessionId }),
  hide: (): void => ipcRenderer.send('quick-ask:hide'),
  onShown: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('quick-ask:shown', wrapped);
    return () => ipcRenderer.removeListener('quick-ask:shown', wrapped);
  },
  onAnswer: (listener: (answer: QuickAskAnswer) => void): (() => void) => {
    const wrapped = (_event: unknown, answer: QuickAskAnswer): void => listener(answer);
    ipcRenderer.on('quick-ask:answer', wrapped);
    return () => ipcRenderer.removeListener('quick-ask:answer', wrapped);
  }
};

export type QuickAskApi = typeof api;
contextBridge.exposeInMainWorld('quickAskApi', api);
