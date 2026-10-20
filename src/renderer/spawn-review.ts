import type { AppApi } from '../preload/index.js';
import type { SpawnReviewKept, SpawnReviewRequest } from '../shared/spawn-review.js';
import { effortLabel, observedModelChoices, type ModelChoice } from './chat-models.js';
import { $, el } from './dom.js';
import { currentLanguage, t } from './i18n.js';

/**
 * The sheet for a spawn of several workers (`multiAgent.reviewSpawns`, spawn-review.ts in main).
 * The prime's call waits on it, so it opens at once; a second batch waits behind the first. The
 * person changes each task, model and reasoning, or drops workers. Only positions in the request
 * and the edited values go back: the main process rebuilds the batch and checks it as usual.
 */
export function initSpawnReview(
  api: Pick<AppApi, 'onSpawnReview' | 'onSpawnReviewClosed' | 'answerSpawnReview'>,
  models: () => ModelChoice[] = observedModelChoices
): void {
  const dialog = $<HTMLDialogElement>('spawnReviewDialog');
  const form = $<HTMLFormElement>('spawnReviewForm');
  const list = $('spawnReviewWorkers');
  const deadline = $('spawnReviewDeadline');
  const contextBox = $<HTMLDetailsElement>('spawnReviewContextBox');
  const submit = $<HTMLButtonElement>('spawnReviewSubmit');
  const cancel = $<HTMLButtonElement>('spawnReviewCancel');
  const queue: SpawnReviewRequest[] = [];
  let rows: Array<{ dropped: boolean; task: HTMLTextAreaElement; model: HTMLSelectElement; effort: HTMLSelectElement; drop: HTMLButtonElement }> = [];
  let busy = false;

  const isOpen = () => dialog.open || dialog.hasAttribute('open');
  const fillEfforts = (select: HTMLSelectElement, model: string, value: string) => {
    const choices = models();
    const efforts = model ? choices.find(choice => choice.id === model)?.efforts ?? []
      : [...new Set(choices.flatMap(choice => choice.efforts))];
    const ids = ['', ...efforts, ...(value && !efforts.includes(value) ? [value] : [])];
    select.replaceChildren(...ids.map(id => {
      const option = el('option', '', id ? effortLabel(id) : t('App default')) as HTMLOptionElement;
      option.value = id;
      return option;
    }));
    select.value = ids.includes(value) ? value : '';
  };
  const paintCount = () => {
    const kept = rows.filter(row => !row.dropped).length;
    submit.textContent = t('Start {0} of {1}', [kept, rows.length]);
    submit.disabled = busy || kept === 0;
    cancel.disabled = busy;
  };

  const show = () => {
    const request = queue[0];
    if (!request) return;
    const by = new Date(request.expiresAt).toLocaleTimeString(currentLanguage(), { hour: 'numeric', minute: '2-digit' });
    deadline.textContent = t("If you don't answer by {0}, none of them starts.", [by]);
    contextBox.hidden = !request.context;
    $('spawnReviewContext').textContent = request.context ?? '';
    list.replaceChildren();
    rows = request.workers.map((worker, index) => {
      const section = el('section', 'spawn-review-worker');
      const head = el('div', 'spawn-review-worker-head');
      const name = el('b', '', worker.label?.trim() || t('Worker {0}', [index + 1]));
      const drop = el('button', 'btn', t('Drop')) as HTMLButtonElement;
      drop.type = 'button';
      head.append(name, drop);
      const field = (label: string, control: HTMLElement) => {
        const wrap = el('label', 'plugin-field');
        wrap.append(el('span', '', label), control);
        return wrap;
      };
      const task = el('textarea') as HTMLTextAreaElement;
      task.rows = 3;
      task.maxLength = 4000;
      task.value = worker.task;
      const model = el('select') as HTMLSelectElement;
      const requested = worker.model ?? '';
      const choices: Array<Pick<ModelChoice, 'id' | 'label'>> = [{ id: '', label: t('App default') }, ...models()];
      if (requested && !choices.some(choice => choice.id === requested)) choices.push({ id: requested, label: requested });
      model.replaceChildren(...choices.map(choice => {
        const option = el('option', '', choice.label) as HTMLOptionElement;
        option.value = choice.id;
        return option;
      }));
      model.value = requested;
      const effort = el('select') as HTMLSelectElement;
      fillEfforts(effort, requested, worker.reasoning_effort ?? '');
      model.addEventListener('change', () => fillEfforts(effort, model.value, effort.value));
      const pair = el('div', 'spawn-review-pair');
      pair.append(field(t('Model'), model), field(t('Reasoning'), effort));
      section.append(head, field(t('Task'), task), pair);
      list.append(section);
      const row = { dropped: false, task, model, effort, drop };
      drop.addEventListener('click', () => {
        row.dropped = !row.dropped;
        section.classList.toggle('dropped', row.dropped);
        for (const control of [task, model, effort]) control.disabled = row.dropped;
        drop.textContent = row.dropped ? t('Keep') : t('Drop');
        paintCount();
      });
      return row;
    });
    busy = false;
    paintCount();
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  };
  const next = () => {
    queue.shift();
    rows = [];
    list.replaceChildren();
    if (typeof dialog.close === 'function' && dialog.open) dialog.close(); else dialog.removeAttribute('open');
    show();
  };
  const answer = async (kept: SpawnReviewKept[] | null) => {
    const request = queue[0];
    if (!request || busy) return;
    busy = true;
    paintCount();
    try { await api.answerSpawnReview(request.id, kept); } catch { /* An answer that came too late started nothing. */ }
    if (queue[0] === request) next();
  };

  form.addEventListener('submit', event => {
    event.preventDefault();
    const kept = rows.flatMap((row, index) => row.dropped ? [] : [{
      index, task: row.task.value.trim() || queue[0]!.workers[index]!.task, model: row.model.value, reasoningEffort: row.effort.value
    }]);
    if (kept.length) void answer(kept);
  });
  cancel.addEventListener('click', () => void answer(null));
  // Escape is Start none, the same as the button: closing the sheet must not leave the prime waiting.
  dialog.addEventListener('cancel', event => { event.preventDefault(); void answer(null); });

  api.onSpawnReview?.(request => {
    queue.push(request);
    if (!isOpen()) show();
  });
  api.onSpawnReviewClosed?.(id => {
    if (queue[0]?.id === id) next();
    else queue.splice(0, queue.length, ...queue.filter(request => request.id !== id));
  });
}
