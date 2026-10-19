import { t } from './i18n.js';

/** A `datetime-local` value: the local wall-clock minute, as the picker shows it. */
function localMinute(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Send at…: the person picks when the text they typed goes to this chat. The outbox keeps it
 * as a queued message with that `dueAt`, so it waits across a restart and can be cancelled from the
 * chat until then. The picker offers the next full hour; a time that has passed is refused here.
 */
export function initSendLaterDialog(schedule: (dueAt: number) => void): { open(): void } {
  const dialog = document.getElementById('sendLaterDialog') as HTMLDialogElement;
  const form = document.getElementById('sendLaterForm') as HTMLFormElement;
  const time = document.getElementById('sendLaterTime') as HTMLInputElement;
  const error = document.getElementById('sendLaterError')!;

  const close = () => { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); };
  const showError = (message: string | null) => {
    error.hidden = !message;
    error.textContent = message ?? '';
  };

  form.addEventListener('submit', event => {
    event.preventDefault();
    // A `datetime-local` value has no offset, so the Date parser reads it as local time.
    const dueAt = time.value ? new Date(time.value).getTime() : NaN;
    if (!Number.isFinite(dueAt)) { showError(t('Choose a date and time.')); return; }
    if (dueAt <= Date.now()) { showError(t('Choose a time later than now.')); return; }
    close();
    schedule(dueAt);
  });
  for (const id of ['sendLaterCancel', 'sendLaterClose']) document.getElementById(id)!.addEventListener('click', () => close());

  return {
    open() {
      showError(null);
      const now = Date.now();
      time.min = localMinute(now + 60_000);
      const nextHour = new Date(now); nextHour.setMinutes(60, 0, 0);
      time.value = localMinute(nextHour.getTime());
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      time.focus();
    }
  };
}
