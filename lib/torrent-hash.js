/* The SHA-1 of every piece of a set of files, as a .torrent lists them.
 *
 * The files are one run of bytes cut into pieces, a piece running on from one file into the next.
 * They are read in slices — a few megabytes at a time, never a whole file — in a Worker when the
 * browser has one, so a phone hashing gigabytes does not freeze the page, and with progress and a way
 * to stop. The same code makes a torrent and checks files against one: a part can be missing (null),
 * or shorter than the torrent says, and the pieces that need bytes it does not have are reported
 * absent rather than hashed.
 */

const WINDOW = 8 * 1024 * 1024;

/**
 * parts: [{ blob: Blob | null, length }] in the torrent's order. Returns { hashes, absent }: 20 bytes
 * per piece, and 1 for each piece that could not be read whole.
 */
export async function hashInline(parts, pieceLength, { onProgress = () => {}, signal } = {}) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const count = Math.ceil(total / pieceLength);
  const hashes = new Uint8Array(count * 20);
  const absent = new Uint8Array(count);
  // Where each part starts in the run of bytes, and how much of it there is to read.
  let at = 0;
  const spans = parts.map((p) => {
    const span = { start: at, end: at + p.length, blob: p.blob, have: p.blob ? Math.min(p.blob.size, p.length) : 0 };
    at += p.length;
    return span;
  });
  const perWindow = Math.max(1, Math.floor(WINDOW / pieceLength));
  let lastReport = 0;
  for (let first = 0; first < count; first += perWindow) {
    if (signal?.aborted) throw new DOMException('Hashing stopped', 'AbortError');
    const last = Math.min(count, first + perWindow);
    const from = first * pieceLength;
    const to = Math.min(total, last * pieceLength);
    // Which bytes of this window can be read, as Blob slices; a gap marks the pieces it touches.
    const slices = [];
    const gaps = [];
    for (const s of spans) {
      if (s.end <= from || s.start >= to) continue;
      const a = Math.max(from, s.start);
      const b = Math.min(to, s.end);
      const readable = Math.min(b, s.start + s.have);
      if (readable > a) slices.push(s.blob.slice(a - s.start, readable - s.start));
      if (readable < b) {
        gaps.push([Math.max(a, readable), b]);
        // Keep the offsets right: what is missing is read as zeros, and its pieces marked absent.
        slices.push(new Uint8Array(b - Math.max(a, readable)));
      }
    }
    const buf = new Uint8Array(await new Blob(slices).arrayBuffer());
    const digests = [];
    for (let i = first; i < last; i++) {
      const start = i * pieceLength;
      const end = Math.min(total, start + pieceLength);
      if (gaps.some(([a, b]) => a < end && b > start)) {
        absent[i] = 1;
        continue;
      }
      digests.push(crypto.subtle.digest('SHA-1', buf.subarray(start - from, end - from)).then((d) => hashes.set(new Uint8Array(d), i * 20)));
    }
    await Promise.all(digests);
    const done = to;
    const now = Date.now();
    if (now - lastReport > 100 || done === total) {
      lastReport = now;
      onProgress(done, total);
    }
  }
  if (count === 0) onProgress(0, 0);
  return { hashes, absent };
}

/** In a Worker where there is one, and here where there is not (or it cannot start). */
export function hashPieces(parts, pieceLength, { onProgress = () => {}, signal, useWorker = typeof Worker === 'function' && typeof document !== 'undefined' } = {}) {
  if (!useWorker) return hashInline(parts, pieceLength, { onProgress, signal });
  let worker;
  try {
    worker = new Worker(new URL('./hash-worker.js', import.meta.url), { type: 'module' });
  } catch {
    return hashInline(parts, pieceLength, { onProgress, signal });
  }
  return new Promise((resolve, reject) => {
    const stop = () => {
      worker.terminate();
      reject(new DOMException('Hashing stopped', 'AbortError'));
    };
    if (signal?.aborted) return stop();
    signal?.addEventListener('abort', stop, { once: true });
    const finish = () => {
      signal?.removeEventListener('abort', stop);
      worker.terminate();
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress(data.done, data.total);
      else if (data.type === 'done') {
        finish();
        resolve({ hashes: data.hashes, absent: data.absent });
      } else if (data.type === 'error') {
        finish();
        reject(new Error(data.message));
      }
    };
    // A worker that cannot load (an engine without module workers) hashes here instead.
    worker.onerror = (event) => {
      event.preventDefault?.();
      finish();
      hashInline(parts, pieceLength, { onProgress, signal }).then(resolve, reject);
    };
    worker.postMessage({ parts, pieceLength });
  });
}
