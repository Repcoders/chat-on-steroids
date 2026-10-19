import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { initSessionStore } from '../src/main/session/store.js';
import { stageInputAttachment, stageInputAttachments, validateInputAttachments, readInputAttachmentChunk, readInputAttachmentImage, ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES } from '../src/main/session/input-attachments.js';
let directory: string;
beforeEach(async () => { directory = await makeTempDir('cos-attachments-'); initSessionStore(directory); });
afterEach(async () => { await removeTempDir(directory); });
it('snapshots arbitrary file bytes across chunks without exposing the source path', async () => {
  const original = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 19, 173);
  const source = path.join(directory, 'notes.md'); await fs.writeFile(source, original);
  const file = await stageInputAttachment(source, new Set());
  await fs.writeFile(source, 'later user edit');
  expect(file).toMatchObject({ name: 'notes.md', size: original.length, mimeType: 'text/markdown' });
  expect(JSON.stringify(file)).not.toContain(directory);
  await validateInputAttachments([file]);
  const chunks = await Promise.all([0, ATTACHMENT_CHUNK_BYTES].map(offset => readInputAttachmentChunk(file, offset)));
  expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk, 'base64')))).toEqual(original);
  await expect(readInputAttachmentChunk(file, 1)).rejects.toThrow('offset');
  await expect(validateInputAttachments([{ ...file, name: 'spoof.pdf' }])).rejects.toThrow('changed');
});
it('keeps dropped Unicode text exact and permits empty native files', async () => {
  const text = 'Text\n中文 — ä 🎈';
  const file = await stageInputAttachment({ text }, new Set());
  expect(Buffer.from(await readInputAttachmentChunk(file, 0), 'base64').toString()).toBe(text);
  const empty = await stageInputAttachment({ text: '' }, new Set());
  expect(empty.size).toBe(0); await validateInputAttachments([empty]);
});
it('prunes and measures staging once for a multi-file batch', async () => {
  const read = vi.spyOn(fs, 'readdir');
  try {
    const files = await stageInputAttachments([
      { text: 'first' },
      { text: 'second' },
      { name: 'third.bin', bytes: new Uint8Array([1, 2, 3]) }
    ], new Set());
    expect(files).toHaveLength(3);
    expect(read).toHaveBeenCalledTimes(1);
    await validateInputAttachments(files);
  } finally {
    read.mockRestore();
  }
});
it('rejects folders, traversal IDs, oversized files and oversized messages', async () => {
  await expect(stageInputAttachment(directory, new Set())).rejects.toThrow('folders');
  const source = path.join(directory, 'big.bin');
  const handle = await fs.open(source, 'w'); await handle.truncate(MAX_ATTACHMENT_BYTES + 1); await handle.close();
  await expect(stageInputAttachment(source, new Set())).rejects.toThrow('512 MB');
  const file = await stageInputAttachment({ text: 'x' }, new Set());
  await expect(validateInputAttachments([{ ...file, id: '../config' }])).rejects.toThrow();
  await expect(validateInputAttachments(Array(21).fill(file))).rejects.toThrow('20 files');
});
it('prunes only expired unreferenced staging while durable input members survive', async () => {
  const keep = await stageInputAttachment({ text: 'keep' }, new Set());
  const discard = await stageInputAttachment({ text: 'discard' }, new Set());
  const old = new Date(Date.now() - 48 * 3600000);
  for (const file of [keep, discard]) await fs.utimes(path.join(directory, 'input-attachments', file.id), old, old);
  await stageInputAttachment({ text: 'new' }, new Set([keep.id]));
  await validateInputAttachments([keep]);
  await expect(validateInputAttachments([discard])).rejects.toThrow();
});
it('releases thumbnail source files so expired image originals can be pruned immediately', async () => {
  const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#437b79' } }).webp().toBuffer();
  const cachedFiles = sharp.cache().files.current;
  const image = await stageInputAttachment({ name: 'reference.webp', bytes }, new Set());
  expect(image.preview).toMatch(/^data:image\/webp;base64,/);
  expect(sharp.cache().files.current).toBe(cachedFiles);
  expect(Buffer.from(await readInputAttachmentChunk(image, 0), 'base64')).toEqual(bytes);
  const original = path.join(directory, 'input-attachments', image.id);
  const old = new Date(Date.now() - 48 * 3600000);
  await fs.utimes(original, old, old);
  await stageInputAttachment({ text: 'next draft' }, new Set());
  await expect(fs.stat(original)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(original + '.json')).rejects.toMatchObject({ code: 'ENOENT' });
});
it('opens a staged image upright within the edit bound for the editor, never changing the original', async () => {
  // Stored 6x2 with an EXIF quarter turn: it shows, and is edited, 2x6 like its thumbnail.
  const jpeg = await sharp({ create: { width: 6, height: 2, channels: 3, background: '#437b79' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const photo = await stageInputAttachment({ name: 'photo.jpg', bytes: jpeg }, new Set());
  const opened = await readInputAttachmentImage(photo);
  expect(opened).toMatchObject({ width: 2, height: 6 });
  expect(await sharp(Buffer.from(opened.dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64')).metadata()).toMatchObject({ format: 'png', width: 2, height: 6 });
  expect(Buffer.from(await readInputAttachmentChunk(photo, 0), 'base64')).toEqual(jpeg);
  const wide = await sharp({ create: { width: 5000, height: 1000, channels: 3, background: '#ffffff' } }).png().toBuffer();
  expect(await readInputAttachmentImage(await stageInputAttachment({ name: 'wide.png', bytes: wide }, new Set()))).toMatchObject({ width: 4096, height: 819 });
  await expect(readInputAttachmentImage({ ...photo, name: 'other.jpg' })).rejects.toThrow('changed');
  await expect(readInputAttachmentImage(await stageInputAttachment({ text: 'notes' }, new Set()))).rejects.toThrow('PNG, JPEG and WebP');
});
it('refuses to open an animated WebP for editing, which would keep only its first frame', async () => {
  const frame = (background: string) => sharp({ create: { width: 4, height: 4, channels: 3, background } }).png().toBuffer();
  const animated = await sharp([await frame('#ff0000'), await frame('#0000ff')], { join: { animated: true } }).webp().toBuffer();
  await expect(readInputAttachmentImage(await stageInputAttachment({ name: 'loop.webp', bytes: animated }, new Set()))).rejects.toThrow('Animated');
  const still = await stageInputAttachment({ name: 'still.webp', bytes: await sharp(await frame('#00ff00')).webp().toBuffer() }, new Set());
  expect(await readInputAttachmentImage(still)).toMatchObject({ width: 4, height: 4 });
});
