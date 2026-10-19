import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

type Handler = (event: { sender: EventEmitter }, payload?: unknown) => Promise<unknown>;
const mock = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  appOnce: vi.fn(),
  spawn: vi.fn(),
  config: { ui: {} as { dictationLanguage?: string } }
}));

vi.mock('electron', () => ({
  app: { once: mock.appOnce },
  ipcMain: { handle: (channel: string, handler: Handler) => mock.handlers.set(channel, handler) }
}));
vi.mock('../src/main/config.js', () => ({
  getConfig: () => mock.config,
  updateConfig: async (update: (config: typeof mock.config) => typeof mock.config) => (mock.config = update(mock.config))
}));
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mock.spawn
}));

const { registerDictationIpc } = await import('../src/main/dictation.js');
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const scriptOf = (call: unknown[]) => {
  const args = call[1] as string[];
  return Buffer.from(args[args.indexOf('-EncodedCommand') + 1]!, 'base64').toString('utf16le');
};

function startTestSession() {
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() });
  const window = { isDestroyed: () => false, webContents: sender };
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stderr = { resume: vi.fn() };
  const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn(() => true) });
  mock.spawn.mockReturnValue(child);
  registerDictationIpc(() => window as never);
  const quit = mock.appOnce.mock.calls.find(([name]) => name === 'before-quit')?.[1];
  expect(quit).toBeTypeOf('function');
  return { sender, child, quit: quit as () => void };
}

beforeEach(() => {
  mock.handlers.clear();
  mock.appOnce.mockReset();
  mock.spawn.mockReset();
  mock.config = { ui: {} };
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', platformDescriptor);
});

describe('Windows dictation child lifetime', () => {
  it('kills an active recognizer synchronously on before-quit', async () => {
    const { sender, child, quit } = startTestSession();
    expect(await mock.handlers.get('dictation:start')!({ sender })).toMatchObject({ ok: true });
    expect(child.kill).not.toHaveBeenCalled();

    quit();
    // Nothing waits for an unref'ed timeout: the kill was issued in the quit callback.
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('cancels a user Stop grace timer and kills immediately if quit follows it', async () => {
    vi.useFakeTimers();
    const { sender, child, quit } = startTestSession();
    await mock.handlers.get('dictation:start')!({ sender });
    expect(await mock.handlers.get('dictation:stop')!({ sender })).toMatchObject({ ok: true });
    expect(child.kill).not.toHaveBeenCalled();
    quit();
    expect(child.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(700);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('passes the actual app PID to PowerShell and monitors it during recognition', async () => {
    const { sender } = startTestSession();
    await mock.handlers.get('dictation:start')!({ sender });
    const [command, args] = mock.spawn.mock.calls[0] as [string, string[]];
    expect(command).toBe('powershell.exe');
    const encoded = args[args.indexOf('-EncodedCommand') + 1];
    expect(encoded).toBeTypeOf('string');
    const script = Buffer.from(encoded!, 'base64').toString('utf16le');
    expect(script).toContain('$cosParentPid = ' + process.pid);
    expect(script).not.toContain('__COS_PARENT_PID__');
    expect(script).toMatch(/while\(\$true\) \{\s*\$item = Wait-Event -Timeout 1\s*if\(-not \(Get-Process -Id \$cosParentPid -ErrorAction SilentlyContinue\)\) \{ break \}/);
  });

  it('asks the recognizer to finish its last phrase before it is stopped', async () => {
    vi.useFakeTimers();
    const { sender, child } = startTestSession();
    await mock.handlers.get('dictation:start')!({ sender });
    const stopFile = scriptOf(mock.spawn.mock.calls[0]!).match(/\$cosStopFile = '([^']+)'/)?.[1];
    expect(stopFile).toBeTypeOf('string');
    expect(fs.existsSync(stopFile!)).toBe(false);
    await mock.handlers.get('dictation:stop')!({ sender });
    // The recognizer polls for this file, then stops listening and reports its last words.
    expect(fs.existsSync(stopFile!)).toBe(true);
    await vi.advanceTimersByTimeAsync(3_900);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('exit', 0, null);
    expect(fs.existsSync(stopFile!)).toBe(false);
  });

  it("dictates with Windows' online speech engine and falls back to System.Speech only when it cannot run", async () => {
    const { sender } = startTestSession();
    await mock.handlers.get('dictation:start')!({ sender });
    const script = scriptOf(mock.spawn.mock.calls[0]!);
    // Windows PowerShell cannot subscribe to WinRT events, so the engine runs in C# compiled at start
    // against the system's own metadata (no SDK), with the recognizer's default dictation topic.
    expect(script).toContain('CompileAssemblyFromSource($options, $cosRecognizerSource)');
    expect(script).toContain('\\System32\\WinMetadata\\Windows.Media.winmd');
    expect(script).toContain('recognizer = language == null ? new SpeechRecognizer() : new SpeechRecognizer(language);');
    expect(script).toContain('session.ResultGenerated += (s, e) => {');
    expect(script).not.toContain('Constraints.Add');
    expect(script).toContain("Send 'status' 'listening' 'modern'");
    // A blocked microphone would stop the fallback too, so it says where to allow it instead.
    expect(script).toContain("if($hr -eq 0x80070005) { throw 'Windows blocks microphone access");
    expect(script).toContain('DictationGrammar');
    // Without a microphone the fallback says so in words the app translates, not a raw .NET message.
    expect(script).toContain("try { $legacy.SetInputToDefaultAudioDevice() } catch { throw 'No microphone is available.");
    expect(script).toContain("Send 'status' 'listening' 'legacy'");
  });

  it("starts in the saved speech language, and in Windows' own when none or a malformed one is saved", async () => {
    mock.config.ui.dictationLanguage = 'de-DE';
    const { sender, child } = startTestSession();
    await mock.handlers.get('dictation:start')!({ sender });
    const script = scriptOf(mock.spawn.mock.calls[0]!);
    expect(script).toContain("$cosLanguage = 'de-DE'");
    expect(script).toContain('[CosDictation]::Start($cosLanguage)');
    expect(script).toContain('if (string.Equals(installed.LanguageTag, tag, StringComparison.OrdinalIgnoreCase))');
    // The fallback picks the matching installed recognizer, else one of the same language.
    expect(script).toContain('if($cosLanguage) { try { $culture = [System.Globalization.CultureInfo]::new($cosLanguage) } catch { } }');
    child.emit('exit', 0, null);

    for (const saved of [undefined, "de'; Remove-Item x"]) {
      mock.config.ui.dictationLanguage = saved;
      mock.spawn.mockClear();
      await mock.handlers.get('dictation:start')!({ sender });
      expect(scriptOf(mock.spawn.mock.calls[0]!)).toContain("$cosLanguage = ''");
      child.emit('exit', 0, null);
    }
  });

  it('lists the installed speech languages without opening the microphone', async () => {
    mock.config.ui.dictationLanguage = 'de-DE';
    const { sender, child } = startTestSession();
    const reply = mock.handlers.get('dictation:languages')!({ sender });
    const script = scriptOf(mock.spawn.mock.calls[0]!);
    expect(script).toContain('[Windows.Media.SpeechRecognition.SpeechRecognizer]::SupportedTopicLanguages');
    expect(script).toContain('InstalledRecognizers()');
    expect(script).not.toMatch(/SetInputToDefaultAudioDevice|StartAsync|RecognizeAsync/);
    child.stdout.emit('data', JSON.stringify([{ tag: 'en-US', name: 'English (United States)' }, { tag: 'de-DE', name: 'Deutsch (Deutschland)' }, { tag: 'en-US', name: 'English' }]) + '\r\n');
    child.emit('exit', 0, null);
    expect(await reply).toEqual({ ok: true, data: {
      languages: [{ tag: 'de-DE', name: 'Deutsch (Deutschland)' }, { tag: 'en-US', name: 'English (United States)' }], selected: 'de-DE'
    } });
    const stranger = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() });
    expect(await mock.handlers.get('dictation:languages')!({ sender: stranger })).toMatchObject({ ok: false });
  });

  it('remembers a picked language, and refuses anything that is not a language tag', async () => {
    const { sender } = startTestSession();
    const pick = mock.handlers.get('dictation:language')!;
    expect(await pick({ sender }, 'de-DE')).toEqual({ ok: true, data: undefined });
    expect(mock.config.ui.dictationLanguage).toBe('de-DE');
    expect(await pick({ sender }, "de'; Remove-Item x")).toMatchObject({ ok: false });
    expect(await pick({ sender }, 42)).toMatchObject({ ok: false });
    expect(mock.config.ui.dictationLanguage).toBe('de-DE');
    expect(await pick({ sender }, '')).toEqual({ ok: true, data: undefined });
    expect(mock.config.ui.dictationLanguage).toBeUndefined();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('the recognizer script parses, and its loop exits when its parent disappears or Stop asks (no microphone)', () => {
    execFileSync(process.execPath, ['scripts/fixtures/smoke-dictation-parent-windows.cjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 40_000
    });
  }, 45_000);
});
