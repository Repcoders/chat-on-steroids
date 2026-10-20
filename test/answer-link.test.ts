import { readFileSync } from 'node:fs';
import vm from 'node:vm';
// @ts-ignore js-yaml is a transitive electron-builder dependency; tests only need its runtime parser.
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import { answerLinkInArgv, answerLinkUrl, parseAnswerLink } from '../src/shared/answer-link.js';
import { createAnswerLinkDelivery, type AnswerLinkTarget } from '../src/main/answer-link-delivery.js';

const SESSION = '2026-10-19-1a2b3c4d';
const MESSAGE = '2b06482d-0dc6-4847-bf7a-2e1a0f671e89';
const LINK = `chat-on-steroids://answer/${SESSION}/${MESSAGE}`;

describe('answer link format', () => {
  it('round-trips a local session id and a native message id', () => {
    expect(answerLinkUrl(SESSION, MESSAGE)).toBe(LINK);
    expect(parseAnswerLink(LINK)).toEqual({ sessionId: SESSION, messageId: MESSAGE });
    expect(parseAnswerLink(`${LINK}/`)).toEqual({ sessionId: SESSION, messageId: MESSAGE });
  });

  it('makes no link for an answer without a native id', () => {
    expect(answerLinkUrl(SESSION, 'assistant:interim:1')).toBeNull();
    expect(answerLinkUrl('../escape', MESSAGE)).toBeNull();
  });

  it.each([
    ['another scheme', `https://answer/${SESSION}/${MESSAGE}`],
    ['another route', `chat-on-steroids://chat/${SESSION}/${MESSAGE}`],
    ['a query', `${LINK}?send=1`],
    ['a fragment', `${LINK}#x`],
    ['an extra segment', `${LINK}/more`],
    ['an encoded path', `chat-on-steroids://answer/..%2F${SESSION}/${MESSAGE}`],
    ['a short message id', `chat-on-steroids://answer/${SESSION}/2b06482d`],
    ['a non-string', 42]
  ])('ignores %s', (_name, value) => {
    expect(parseAnswerLink(value)).toBeNull();
  });

  it('finds the link among a launch\'s other arguments', () => {
    expect(answerLinkInArgv(['C:\\Program Files\\Chat On Steroids\\Chat On Steroids.exe', '--allow-file-access', LINK]))
      .toEqual({ sessionId: SESSION, messageId: MESSAGE });
    expect(answerLinkInArgv(['/usr/bin/chat-on-steroids', '--background'])).toBeNull();
    expect(answerLinkInArgv(['app', 'chat-on-steroids://answer/bad'])).toBeNull();
  });
});

function contents(loading = false) {
  let loaded: (() => void) | null = null;
  const target: AnswerLinkTarget & { sent: unknown[]; finishLoad: () => void } = {
    sent: [],
    isDestroyed: () => false,
    isLoadingMainFrame: () => loading,
    once: (_event, listener) => { loaded = listener; },
    send: (_channel, link) => { target.sent.push(link); },
    finishLoad: () => { loading = false; loaded?.(); }
  };
  return target;
}

describe('answer link delivery', () => {
  const link = { sessionId: SESSION, messageId: MESSAGE };

  it('focuses the window and sends the link once its page has loaded', () => {
    const target = contents(true);
    const show = vi.fn();
    const delivery = createAnswerLinkDelivery(show, () => target);
    delivery.open(link);
    expect(show).toHaveBeenCalledTimes(1);
    expect(target.sent).toEqual([]);
    target.finishLoad();
    expect(target.sent).toEqual([link]);
  });

  it('keeps the newest link until a window exists, then sends it once', () => {
    let target: ReturnType<typeof contents> | null = null;
    const delivery = createAnswerLinkDelivery(() => undefined, () => target);
    delivery.open({ sessionId: SESSION, messageId: '00000000-0000-4000-8000-000000000000' });
    delivery.open(link);
    target = contents();
    delivery.flush();
    delivery.flush();
    expect(target.sent).toEqual([link]);
  });

  it('opens nothing on a later flush when no link came', () => {
    const show = vi.fn();
    createAnswerLinkDelivery(show, () => contents()).flush();
    expect(show).not.toHaveBeenCalled();
  });
});

describe('answer link launch wiring', () => {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');

  it('opens a second launch\'s link instead of only focusing the window', () => {
    const start = source.indexOf("app.on('second-instance'");
    const handler = source.slice(start, source.indexOf('\n});', start) + 4);
    let listener: ((event: unknown, argv: string[]) => void) | undefined;
    const opened: unknown[] = [];
    const focused = vi.fn();
    vm.runInNewContext(handler, {
      app: { on: (_name: string, fn: typeof listener) => { listener = fn; } },
      answerLinkInArgv, isBackgroundLaunch: (argv: string[]) => argv.includes('--background'),
      answerLinks: { open: (value: unknown) => opened.push(value) },
      windowActivation: { request: focused }
    });
    listener!({}, ['app', LINK]);
    expect(opened).toEqual([{ sessionId: SESSION, messageId: MESSAGE }]);
    expect(focused).not.toHaveBeenCalled();
    listener!({}, ['app']);
    expect(focused).toHaveBeenCalledTimes(1);
  });

  it('declares the scheme for the macOS and Linux packages', () => {
    const builder = loadYaml(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')) as { protocols?: Array<{ schemes: string[] }> };
    expect(builder.protocols?.flatMap(protocol => protocol.schemes)).toContain('chat-on-steroids');
  });
});
