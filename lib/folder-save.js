/* Saving a torrent's files straight into a folder of the computer, as they are in the torrent.
 *
 * Only where the browser lets a page write into a folder the user picked (the File System Access API:
 * Chrome and Edge on a computer). Everywhere else the files are saved one at a time, or zipped, as
 * before. Each file is written as it is read, so a film is never held in memory whole.
 */
import { endedEarly } from '../saver.js';

/** Whether this browser can be asked for a folder to write into. */
export const canPickFolder = () => typeof globalThis.showDirectoryPicker === 'function';

/**
 * Ask for the folder. It has to be the first thing a click does: the browser shows the picker only
 * while that click still counts, and anything awaited before it uses that up.
 */
export function pickFolder() {
  return globalThis.showDirectoryPicker({ id: 'save', mode: 'readwrite', startIn: 'downloads' });
}

/**
 * A name a folder on any system takes. A torrent's paths are whatever its maker typed: a "/" or a ":"
 * in one, or a name that is only dots, would be refused, or worse, go somewhere else.
 */
export function safeSegment(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/[. ]+$/, '');
  return !cleaned || cleaned === '.' || cleaned === '..' ? '_' : cleaned;
}

const isMissing = (err) => err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError');

/** The folder at this path under `dir`, made if asked to; null when it is not there. */
async function folderAt(dir, parts, create) {
  let at = dir;
  for (const part of parts) {
    try {
      at = await at.getDirectoryHandle(safeSegment(part), { create });
    } catch (err) {
      if (!create && isMissing(err)) return null;
      throw err;
    }
  }
  return at;
}

/** The items (each { path: [...folders, name] }) that would replace a file already in `dir`. */
export async function existing(dir, items) {
  const found = [];
  for (const item of items) {
    const folder = await folderAt(dir, item.path.slice(0, -1), false);
    if (!folder) continue;
    try {
      await folder.getFileHandle(safeSegment(item.path[item.path.length - 1]));
      found.push(item);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  return found;
}

/**
 * Write each item ({ path, size, stream: () => ReadableStream }) into `dir`, its folders made as
 * needed. A stream that ends short of its size (the torrent was removed meanwhile, or another open copy
 * of the app took it over) throws, and the file is not left behind cut short: a new one goes, and one
 * that was there before stays as it was. `onFile(item, index)` is told as each one is done.
 */
export async function writeToFolder(dir, items, { onFile } = {}) {
  for (const [index, item] of items.entries()) {
    const folder = await folderAt(dir, item.path.slice(0, -1), true);
    const name = safeSegment(item.path[item.path.length - 1]);
    let isNew = false;
    try {
      await folder.getFileHandle(name);
    } catch (err) {
      if (!isMissing(err)) throw err;
      isNew = true;
    }
    const handle = await folder.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    const reader = item.stream().getReader();
    let written = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        await writable.write(value);
        written += value.byteLength;
      }
      if (Number.isFinite(item.size) && written !== item.size) throw endedEarly();
      await writable.close();
    } catch (err) {
      reader.cancel().catch(() => {});
      await writable.abort().catch(() => {});
      if (isNew) await folder.removeEntry(name).catch(() => {});
      throw err;
    }
    onFile?.(item, index);
  }
}
