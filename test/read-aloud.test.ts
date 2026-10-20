import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The window's speechSynthesis as Chromium runs it: a queue that cancel() fails as interrupted. */
class FakeUtterance extends EventTarget {
  voice: unknown = null; lang = ''; rate = 1;
  constructor(public text: string) { super(); }
}
function fakeSpeech(voices = [{ voiceURI: 'urn:voice:one', name: 'Voice One', lang: 'en-US' }, { voiceURI: 'urn:voice:two', name: 'Voice Two', lang: 'de-DE' }]) {
  const queue: FakeUtterance[] = [];
  const speech = Object.assign(new EventTarget(), {
    paused: false,
    getVoices: () => voices,
    speak: vi.fn((utterance: FakeUtterance) => { queue.push(utterance); }),
    cancel: vi.fn(() => { for (const utterance of queue.splice(0)) utterance.dispatchEvent(Object.assign(new Event('error'), { error: 'interrupted' })); }),
    pause: vi.fn(() => { speech.paused = true; }),
    resume: vi.fn(() => { speech.paused = false; })
  });
  /** The engine finishes everything it was given. */
  const finish = () => { for (const utterance of queue.splice(0)) utterance.dispatchEvent(new Event('end')); };
  return { speech, queue, finish };
}

async function load(speech: unknown) {
  vi.resetModules();
  vi.stubGlobal('window', { speechSynthesis: speech, SpeechSynthesisUtterance: FakeUtterance });
  return import('../src/renderer/read-aloud.js');
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('read aloud text', () => {
  it('reads the words an answer shows, without code blocks, markup or ChatGPT\'s citation markers', async () => {
    const { readAloudText } = await load(undefined);
    const answer = '## Steps\n\nRun **npm test** in `C:\\Users\\you\\project`:\n\n```sh\nnpm test -- --watch\n```\n\n- [Read the guide](https://example.test/guide)\u{E200}cite\u{E202}turn0search1\u{E201}\n- Done.';
    expect(readAloudText(answer)).toBe('Steps\nRun npm test in C:\\Users\\you\\project:\nRead the guide\nDone.');
  });

  it('cuts long lines at sentence ends, then spaces, and keeps every line its own utterance', async () => {
    const { speechChunks } = await load(undefined);
    expect(speechChunks('Short title\nOne two. Three four five. Six.', 20)).toEqual(['Short title', 'One two.', 'Three four five.', 'Six.']);
    const long = speechChunks('word '.repeat(30).trim(), 40);
    expect(long.every(chunk => chunk.length <= 40)).toBe(true);
    expect(long.join(' ')).toBe('word '.repeat(30).trim());
    // A language without spaces still splits at its own sentence ends.
    expect(speechChunks('今日は晴れです。明日は雨です。', 10)).toEqual(['今日は晴れです。', '明日は雨です。']);
  });
});

describe('the reader', () => {
  it('reads one answer at a time with the chosen voice and speed, pauses, resumes and ends', async () => {
    const { speech, queue, finish } = fakeSpeech();
    const reader = await load(speech);
    const changes = vi.fn();
    reader.onReadAloudChange(changes);
    expect(reader.readAloudAvailable()).toBe(true);
    reader.startReadAloud('chat\u0000turn-a', 'First line.\n\n```js\nconsole.log(1)\n```\n\nSecond line.', { voice: 'urn:voice:two', rate: 1.5 });
    expect(queue.map(utterance => utterance.text)).toEqual(['First line.', 'Second line.']);
    expect(queue.every(utterance => (utterance.voice as { voiceURI: string }).voiceURI === 'urn:voice:two' && utterance.lang === 'de-DE' && utterance.rate === 1.5)).toBe(true);
    expect(reader.readAloudState('chat\u0000turn-a')).toBe('reading');
    expect(reader.readAloudState('chat\u0000turn-b')).toBe('idle');

    reader.pauseReadAloud();
    expect(speech.pause).toHaveBeenCalledOnce();
    expect(reader.readAloudState('chat\u0000turn-a')).toBe('paused');
    reader.resumeReadAloud();
    expect(reader.readAloudState('chat\u0000turn-a')).toBe('reading');

    finish();
    expect(reader.readAloudState('chat\u0000turn-a')).toBe('idle');
    expect(changes).toHaveBeenCalledTimes(4);
  });

  it('ends the previous answer when another starts, and a stale end does not end the new one', async () => {
    const { speech, queue, finish } = fakeSpeech();
    const reader = await load(speech);
    reader.startReadAloud('a', 'Answer A.');
    const stale = queue[0]!;
    reader.pauseReadAloud();
    reader.startReadAloud('b', 'Answer B.', { voice: 'urn:voice:gone' });
    expect(speech.cancel).toHaveBeenCalledOnce();
    // A paused engine would keep the new answer silent.
    expect(speech.paused).toBe(false);
    expect(reader.readAloudState('a')).toBe('idle');
    expect(queue.map(utterance => utterance.text)).toEqual(['Answer B.']);
    // A voice that is no longer installed reads with the system default.
    expect(queue[0]!.voice).toBeNull();
    stale.dispatchEvent(new Event('end'));
    expect(reader.readAloudState('b')).toBe('reading');
    reader.stopReadAloud();
    expect(reader.readAloudState('b')).toBe('idle');
    finish();
    expect(speech.speak).toHaveBeenCalledTimes(2);
  });

  it('offers nothing without voices or without speechSynthesis, and reads nothing for an answer of only code', async () => {
    const empty = fakeSpeech([]);
    expect((await load(empty.speech)).readAloudAvailable()).toBe(false);
    expect((await load(undefined)).readAloudAvailable()).toBe(false);
    const { speech, queue } = fakeSpeech();
    const reader = await load(speech);
    reader.startReadAloud('code', '```py\nprint(1)\n```');
    expect(queue).toEqual([]);
    expect(reader.readAloudState('code')).toBe('idle');
  });

  it('holds every queued utterance until the reading ends, so Chromium cannot collect one first', async () => {
    // Chromium's engine does not keep an utterance alive for the page: one nothing holds can be
    // collected before its end event, and the reading would never end.
    v8.setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const queued: Array<WeakRef<FakeUtterance>> = [];
    const speech = Object.assign(new EventTarget(), {
      paused: false, getVoices: () => [{ voiceURI: 'urn:voice:one', name: 'Voice One', lang: 'en-US' }],
      speak: (utterance: FakeUtterance) => { queued.push(new WeakRef(utterance)); },
      cancel: () => undefined, pause: () => undefined, resume: () => undefined
    });
    const reader = await load(speech);
    reader.startReadAloud('long', 'First line.\nSecond line.\nThird line.');
    expect(queued).toHaveLength(3);
    for (let round = 0; round < 3; round++) { await new Promise(resolve => setTimeout(resolve, 0)); gc(); }
    expect(queued.every(ref => ref.deref() !== undefined)).toBe(true);
    queued.at(-1)!.deref()!.dispatchEvent(new Event('end'));
    expect(reader.readAloudState('long')).toBe('idle');
  });

  it('tells its listeners when the system\'s voices arrive', async () => {
    const { speech } = fakeSpeech();
    const reader = await load(speech);
    const changes = vi.fn();
    reader.onReadAloudChange(changes);
    speech.dispatchEvent(new Event('voiceschanged'));
    expect(changes).toHaveBeenCalledOnce();
  });
});
