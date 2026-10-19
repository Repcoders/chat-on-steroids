import type { ToolCallRecord } from './session.js';

/** Image results a call's row previews below its result. */
export const TOOL_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * A recorded result as its row reads it: an MCP envelope's text blocks, else its structured
 * content. Null for a cut result with images, which the row replaces with a note. Presentation
 * only: the stored result and overflow asset remain byte-for-byte intact.
 */
export function readableToolResult(text: string, truncated: boolean, hasImages: boolean): string | null {
  try {
    const value = JSON.parse(text);
    if (value && Array.isArray(value.content)) {
      const readable = value.content.flatMap((block: any) => {
        if (block?.type === 'text' && typeof block.text === 'string') return [block.text];
        if (block?.type === 'resource' && typeof block.resource?.text === 'string') return [block.resource.text];
        return [];
      });
      if (readable.length) return readable.join('\n\n');
      if (value.structuredContent !== undefined) return JSON.stringify(value.structuredContent, null, 2);
      if (hasImages) return '';
    }
  } catch { /* An overflow prefix may end inside a binary field; never paint that payload. */ }
  if (hasImages && truncated) return null;
  return text;
}

/**
 * The recorded text an opened call shows: its arguments and its readable result, each as stored
 * inline (cut past the per-event cap; the overflow asset is not shown, so it is not read).
 */
export function toolCallShownText(call: ToolCallRecord): string[] {
  const hasImages = call.assets?.some(asset => TOOL_IMAGE_TYPES.includes(asset.mimeType)) ?? false;
  const result = readableToolResult(call.result.text, call.result.truncated, hasImages);
  return result ? [call.args.text, result] : [call.args.text];
}
