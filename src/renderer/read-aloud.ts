import { markdownVisibleText } from '../shared/markdown-text.js';

/*
 * Read aloud: an answer spoken by the window's own speechSynthesis, with the system's voices, so
 * nothing leaves the computer and main is not involved. One answer reads at a time. Without any
 * voice (Linux often has none installed) there is nothing to offer, and the button stays hidden.
 */

export type ReadAloudState = 'idle' | 'reading' | 'paused';
export type ReadAloudPrefs = { voice?: string; rate?: number };

/** ChatGPT's entity and citation markers: private-use delimiters around an id, never words. */
const PAGE_MARKERS = /[^]*|[-]/g;

/** The words an answer shows, without its code blocks: spoken, code is noise. */
export function readAloudText(markdown: string): string {
  return markdownVisibleText(markdown, { codeBlocks: false }).replace(PAGE_MARKERS, '')
    .split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/**
 * The text as short utterances: one per line, longer lines cut at sentence ends, then spaces.
 * Chromium's voices can stop part way through a long utterance, and a pause takes effect sooner.
 */
export function speechChunks(text: string, max = 240): string[] {
  const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const chunks: string[] = [];
  for (const line of text.split('\n')) {
    let chunk = '';
    for (const { segment } of sentences.segment(line)) {
      if (chunk && chunk.length + segment.length > max) { chunks.push(chunk.trim()); chunk = ''; }
      chunk += segment;
      while (chunk.length > max) {
        const space = chunk.lastIndexOf(' ', max);
        const cut = space > 0 ? space : max;
        chunks.push(chunk.slice(0, cut).trim()); chunk = chunk.slice(cut);
      }
    }
    if (chunk.trim()) chunks.push(chunk.trim());
  }
  return chunks.filter(Boolean);
}

function synth(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis : null;
}

export function readAloudVoices(): SpeechSynthesisVoice[] {
  try { return synth()?.getVoices() ?? []; } catch { return []; }
}

export function readAloudAvailable(): boolean {
  return readAloudVoices().length > 0 && typeof window.SpeechSynthesisUtterance === 'function';
}

/**
 * The answer reading now. It holds its utterances: Chromium can collect one nothing in the page
 * holds before its end event fires, and the reading would then never end.
 */
let current: { key: string; state: 'reading' | 'paused'; generation: number; utterances: SpeechSynthesisUtterance[] } | null = null;
let generation = 0;
const listeners = new Set<() => void>();
let watchingVoices = false;

function changed(): void {
  for (const listener of listeners) {
    try { listener(); } catch { /* One listener cannot stop the others. */ }
  }
}

/** Called when the reading state changes, and when the system's voices arrive or change. */
export function onReadAloudChange(listener: () => void): () => void {
  listeners.add(listener);
  const speech = synth();
  // Chromium lists voices only after loading them: the first getVoices() is often empty.
  if (speech && !watchingVoices) { watchingVoices = true; speech.addEventListener('voiceschanged', changed); }
  return () => listeners.delete(listener);
}

export function readAloudState(key: string): ReadAloudState {
  return current?.key === key ? current.state : 'idle';
}

export function stopReadAloud(): void {
  if (!current) return;
  current = null; generation++;
  synth()?.cancel();
  changed();
}

export function pauseReadAloud(): void {
  if (current?.state !== 'reading') return;
  current.state = 'paused';
  synth()?.pause();
  changed();
}

export function resumeReadAloud(): void {
  if (current?.state !== 'paused') return;
  current.state = 'reading';
  synth()?.resume();
  changed();
}

/** Reads `markdown` aloud as `key`, ending whatever was reading before. */
export function startReadAloud(key: string, markdown: string, prefs: ReadAloudPrefs = {}): void {
  const speech = synth();
  if (!speech || !readAloudAvailable()) return;
  stopReadAloud();
  // A paused engine stays paused across cancel(), and would hold the new answer silent.
  speech.resume();
  const chunks = speechChunks(readAloudText(markdown));
  if (!chunks.length) return;
  const voice = readAloudVoices().find(entry => entry.voiceURI === prefs.voice);
  const mine = ++generation;
  current = { key, state: 'reading', generation: mine, utterances: [] };
  const held = current.utterances;
  const finish = () => { if (current?.generation === mine) { current = null; changed(); } };
  chunks.forEach((chunk, index) => {
    const utterance = new window.SpeechSynthesisUtterance(chunk);
    held.push(utterance);
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
    utterance.rate = prefs.rate ?? 1;
    if (index === chunks.length - 1) utterance.addEventListener('end', finish);
    // cancel() fails the queued utterances as interrupted; only a real failure ends the reading.
    utterance.addEventListener('error', event => {
      if (event.error !== 'interrupted' && event.error !== 'canceled' && current?.generation === mine) stopReadAloud();
    });
    speech.speak(utterance);
  });
  changed();
}
