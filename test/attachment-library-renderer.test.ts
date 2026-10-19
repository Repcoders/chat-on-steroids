import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { InputAttachment } from '../src/shared/input.js';

let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; vi.unstubAllGlobals(); vi.resetModules(); });

const png: InputAttachment = { id: '0f3c9a7e-5b21-4d8a-9c6e-000000000001', name: 'screenshot.png', size: 48_213, mimeType: 'image/png', preview: 'data:image/webp;base64,AAAA' };
const pdf: InputAttachment = { id: '0f3c9a7e-5b21-4d8a-9c6e-000000000002', name: 'report.pdf', size: 1_532_000, mimeType: 'application/pdf' };

async function mount(list: () => Promise<{ ok: true; data: InputAttachment[] } | { ok: false; error: string }>, attached = new Set<string>()) {
  dom = new JSDOM(`<!doctype html><body><details id="attachmentMenu" open><summary></summary><div class="composer-popover">
    <button id="attachRecent" type="button" data-keep-menu="true">Recent files</button><div id="attachmentLibrary" hidden></div></div></details></body>`, { url: 'https://library.test/' });
  const w = dom.window;
  for (const [key, value] of Object.entries({ window: w, document: w.document, HTMLElement: w.HTMLElement, HTMLButtonElement: w.HTMLButtonElement })) vi.stubGlobal(key, value);
  const choose = vi.fn();
  const { initAttachmentLibrary } = await import('../src/renderer/attachment-library.js');
  initAttachmentLibrary({ menu: w.document.getElementById('attachmentMenu') as HTMLDetailsElement, toggle: w.document.getElementById('attachRecent') as HTMLButtonElement,
    host: w.document.getElementById('attachmentLibrary')!, list, attached: () => attached, choose });
  return { w, choose, toggle: w.document.getElementById('attachRecent') as HTMLButtonElement, host: w.document.getElementById('attachmentLibrary')! };
}

it('lists recent files under the + menu row and hands the picked one to the draft', async () => {
  const list = vi.fn(async () => ({ ok: true as const, data: [png, pdf] }));
  const { w, choose, toggle, host } = await mount(list, new Set([png.id]));
  expect(host.hidden).toBe(true);
  toggle.click();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  await vi.waitFor(() => expect(host.querySelectorAll('.attachment-library-item')).toHaveLength(1));
  // The file already in this draft is not offered a second time.
  const row = host.querySelector<HTMLButtonElement>(`[data-attachment-id="${pdf.id}"]`)!;
  expect(row.textContent).toContain('report.pdf');
  expect(row.textContent).toContain('1.5 MB');
  expect(row.getAttribute('aria-label')).toBe('Attach report.pdf again');
  row.click();
  expect(choose).toHaveBeenCalledWith(pdf);
  expect(host.hidden).toBe(true);
  // Each expansion reads staging again; closing the menu collapses the list.
  toggle.click();
  await vi.waitFor(() => expect(host.querySelectorAll('.attachment-library-item')).toHaveLength(1));
  expect(list).toHaveBeenCalledTimes(2);
  const menu = w.document.getElementById('attachmentMenu') as HTMLDetailsElement;
  menu.open = false; menu.dispatchEvent(new w.Event('toggle'));
  expect(host.hidden).toBe(true);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

it('shows the image preview, the empty state and a load failure', async () => {
  let reply: { ok: true; data: InputAttachment[] } | { ok: false; error: string } = { ok: true, data: [png] };
  const { toggle, host } = await mount(async () => reply);
  toggle.click();
  await vi.waitFor(() => expect(host.querySelector('.attachment-library-thumb img')?.getAttribute('src')).toBe(png.preview));
  expect(host.textContent).toContain('Image · 47 KB');
  toggle.click(); reply = { ok: true, data: [] }; toggle.click();
  await vi.waitFor(() => expect(host.textContent).toBe('No files attached in the last 24 hours'));
  toggle.click(); reply = { ok: false, error: 'Session storage is not ready' }; toggle.click();
  await vi.waitFor(() => expect(host.textContent).toBe('Recent files could not be loaded'));
});

it('puts Recent files in the composer + menu, keeping the menu open for the list', () => {
  const page = new JSDOM(readFileSync('src/renderer/index.html', 'utf8')).window.document;
  const toggle = page.querySelector('#attachmentMenu .composer-popover #attachRecent')!;
  expect(toggle.getAttribute('data-keep-menu')).toBe('true');
  expect(toggle.nextElementSibling?.id).toBe('attachmentLibrary');
});
