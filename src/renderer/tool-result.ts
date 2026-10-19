import { t } from './i18n.js';
import { readableToolResult } from '../shared/tool-result.js';
/** Presentation only. The stored result and overflow asset remain byte-for-byte intact. */
export function toolResultText(text: string, truncated: boolean, hasImages: boolean): string {
  return readableToolResult(text, truncated, hasImages) ?? t("Image result. Full response retained in the recording.");
}
