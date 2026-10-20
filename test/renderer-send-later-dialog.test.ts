import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Send at…: the dialog offers the next full hour, refuses a time that has passed, and hands the
 * chosen local time over as one timestamp.
 */
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event });
});
afterEach(() => { vi.restoreAllMocks(); dom.window.close(); });

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const submit = () => $('sendLaterForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));

it('offers the next full hour and schedules the local time that was picked', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 18, 21, 40, 15).getTime());
  const { initSendLaterDialog } = await import('../src/renderer/send-later-dialog.js');
  const schedule = vi.fn();
  initSendLaterDialog(schedule).open();
  expect($<HTMLDialogElement>('sendLaterDialog').open).toBe(true);
  expect($<HTMLInputElement>('sendLaterTime').value).toBe('2026-10-18T22:00');
  $<HTMLInputElement>('sendLaterTime').value = '2026-10-19T07:30';
  submit();
  expect(schedule).toHaveBeenCalledWith(new Date(2026, 9, 19, 7, 30).getTime());
  expect($<HTMLDialogElement>('sendLaterDialog').open).toBe(false);
});

it('refuses a time that has already passed and keeps the dialog open', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 18, 21, 40).getTime());
  const { initSendLaterDialog } = await import('../src/renderer/send-later-dialog.js');
  const schedule = vi.fn();
  initSendLaterDialog(schedule).open();
  $<HTMLInputElement>('sendLaterTime').value = '2026-10-18T21:40';
  submit();
  expect(schedule).not.toHaveBeenCalled();
  expect($('sendLaterError').hidden).toBe(false);
  expect($('sendLaterError').textContent).toBe('Choose a time later than now.');
  expect($<HTMLDialogElement>('sendLaterDialog').open).toBe(true);
  $<HTMLInputElement>('sendLaterTime').value = '2026-10-18T21:41';
  submit();
  expect(schedule).toHaveBeenCalledTimes(1);
});
