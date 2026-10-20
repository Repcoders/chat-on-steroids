import type { WorkerWorktreeReview, WorkerWorktreeReviewFile } from '../shared/session.js';
import { disclosureChevron, el, icon } from './dom.js';
import { t, ui } from './i18n.js';

/** One file in the same read-only card and line diff that edit cards use. */
function fileCard(file: WorkerWorktreeReviewFile, current: () => boolean): HTMLElement {
  const card = document.createElement('details'); card.className = 'edit-card worktree-review-file';
  const header = el('summary', 'edit-card-header');
  header.append(icon('i-file-text'), el('b', '', () =>
    `${t(file.status === 'added' ? 'Created' : file.status === 'deleted' ? 'Deleted' : 'Edited')} ${file.path.split('/').pop()}`),
  disclosureChevron('edit-chevron'));
  const viewport = el('div', 'unified-diff'); viewport.tabIndex = 0;
  ui(viewport, 'aria-label', () => t('Diff for {0}', [file.path]));
  const body = el('div', 'edit-card-body'); body.append(el('div', 'edit-card-path', file.path), viewport);
  card.append(header, body);
  let loaded = false;
  card.addEventListener('toggle', async () => {
    if (!card.open || loaded || !current()) return;
    loaded = true;
    if (file.binary || file.tooLarge) {
      viewport.replaceChildren(el('p', 'meta', () => file.binary ? t('Binary diff · preview unavailable') : t('This diff is too large to display.')));
      return;
    }
    viewport.replaceChildren(el('p', 'meta', () => t('Loading diff…')));
    const module = await import('./unified-diff.js');
    if (!current() || !card.isConnected) return;
    await module.renderUnifiedDiff(viewport, file.path, file.baseText ?? '', file.currentText ?? '', () => current() && card.isConnected);
  });
  return card;
}

/** What removal would discard comes first; branch-only commits stay in Git either way. */
export function renderWorktreeReview(review: WorkerWorktreeReview, current: () => boolean): HTMLElement {
  const panel = el('div', 'worktree-checkout-review');
  const group = (scope: WorkerWorktreeReviewFile['scope'], title: () => string, hint: () => string): void => {
    const files = review.files.filter(file => file.scope === scope);
    if (!files.length) return;
    const head = el('div', 'worktree-review-head');
    head.append(el('b', '', title), el('span', '', hint));
    const cards = el('div', 'edit-cards');
    cards.append(...files.map(file => fileCard(file, current)));
    panel.append(head, cards);
  };
  group('uncommitted', () => t('Uncommitted changes'), () => t('Removed with the checkout.'));
  if (review.ignoredFiles) panel.append(el('p', 'meta', () => t('Ignored files are not shown.')));
  group('committed', () => t('Commits only on this branch'), () => t('Kept on the Git branch.'));
  if (review.truncated) panel.append(el('p', 'meta', () => t('More changed files are not shown.')));
  if (!panel.childElementCount) panel.append(el('p', 'meta', () => t('No file changes in this checkout.')));
  return panel;
}

/** Show changes toggles a review under its row; the main process decides whether it may be read. */
export async function toggleWorktreeReview(
  button: HTMLButtonElement,
  load: (runId: string, agentId: string) => Promise<WorkerWorktreeReview | null>
): Promise<void> {
  const row = button.closest<HTMLElement>('.worktree-checkout-row');
  const { runId, agentId } = button.dataset;
  if (!row || !runId || !agentId || button.disabled) return;
  const shown = row.querySelector('.worktree-checkout-review');
  if (shown) {
    shown.remove();
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  button.disabled = true;
  try {
    const review = await load(runId, agentId);
    if (!review || !row.isConnected || review.runId !== runId || review.agentId !== agentId) return;
    const panel = renderWorktreeReview(review, () => panel.isConnected);
    panel.id = `worktree-review-${runId}-${agentId}`;
    row.append(panel);
    button.setAttribute('aria-controls', panel.id);
    button.setAttribute('aria-expanded', 'true');
  } finally {
    button.disabled = false;
  }
}
