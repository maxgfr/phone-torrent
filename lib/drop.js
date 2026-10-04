/* What was dropped on the page: files, the folders they came in, or text.
 *
 * A drop's items can only be read during the drop event itself; once the handler has awaited anything,
 * the browser has emptied them. So grabEntries takes what it needs at once, and the folders are read
 * afterwards, from the entries it kept. A folder is only ever seen through its entry: as a File, it is
 * an empty one named after it.
 */

/**
 * Taken from a drop, synchronously: `entries`, the files and folders as entries, when the browser gives
 * them for every file dropped (webkitGetAsEntry), or else null; `files`, the files themselves.
 */
export function grabEntries(dataTransfer) {
  const items = [...(dataTransfer?.items || [])].filter((item) => item.kind === 'file');
  const entries = items.map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null));
  return {
    entries: entries.length && entries.every(Boolean) ? entries : null,
    files: [...(dataTransfer?.files || [])],
  };
}

const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

/** Every entry in a folder: readEntries hands them over a hundred or so at a time, and an empty batch is the end. */
async function childrenOf(directory) {
  const reader = directory.createReader();
  const all = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

/**
 * The files under these entries, folders opened all the way down, each with `fullPath`: where it sits
 * in what was dropped ("Photos/2024/a.jpg"), which is where it goes in the torrent made of them. An
 * empty folder gives nothing.
 */
export async function filesFromEntries(entries) {
  const out = [];
  const walk = async (entry) => {
    if (entry.isDirectory) {
      for (const child of await childrenOf(entry)) await walk(child);
    } else if (entry.isFile) {
      const file = await fileOf(entry);
      const fullPath = String(entry.fullPath || file.name).replace(/^\/+/, '');
      Object.defineProperty(file, 'fullPath', { value: fullPath, configurable: true });
      out.push(file);
    }
  };
  for (const entry of entries) await walk(entry);
  return out;
}

/** Text dropped from another page or app: a link (the first line of a uri-list that is not a comment) or plain text. */
export function droppedText(dataTransfer) {
  if (!dataTransfer) return '';
  const get = (type) => {
    try { return dataTransfer.getData(type) || ''; } catch { return ''; }
  };
  const link = get('text/uri-list').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return (link || get('text/plain') || get('text')).trim();
}

/** Whether a drag carries files (and not only text): what decides that the page takes the drop. */
export function draggingFiles(dataTransfer) {
  return [...(dataTransfer?.types || [])].includes('Files');
}
