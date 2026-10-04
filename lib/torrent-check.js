/* Do these files make this torrent? Each piece hashed again and compared with the one the .torrent
 * lists — the check a client does before seeding — with what is wrong said in words: the files not
 * found, the ones of another size, and how many pieces are good, bad, or cannot be read at all.
 */
import { formatSize } from './torrent-meta.js';

const pathOf = (file) => (file.webkitRelativePath || file.fullPath || file.name || '').replace(/^\/+/, '');

/**
 * The picked File for each file of the torrent, in its order, or null. Found by its place in a
 * folder picked (with or without the torrent's own folder at the top), by its path, or by its name
 * when only one picked file has it; a one-file torrent takes the one file picked, whatever its name.
 */
export function matchFiles(fields, picked) {
  const files = [...picked];
  if (fields.files.length === 1 && files.length === 1) return [files[0]];
  const byPath = new Map();
  for (const f of files) {
    const parts = pathOf(f).split('/');
    // Every ending of its path, from the whole of it to its name: one two files share says neither.
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(i).join('/');
      byPath.set(key, byPath.has(key) ? null : f);
    }
  }
  const used = new Set();
  return fields.files.map((t) => {
    const name = t.path.split('/').pop();
    const hit = byPath.get(`${fields.name}/${t.path}`) || byPath.get(t.path) || byPath.get(name) || null;
    if (!hit || used.has(hit)) return null;
    used.add(hit);
    return hit;
  });
}

/**
 * The files checked against the torrent. `hash` is lib/torrent-hash.js's hashPieces (or hashInline).
 * Returns { pieces, good, bad, missing, percent, missingFiles, wrongSizes, files }.
 */
export async function checkTorrent(model, picked, { hash, onProgress, signal } = {}) {
  const { fields } = model;
  const expected = model.info.get('pieces');
  if (!(expected instanceof Uint8Array) || !fields.pieceCount) {
    throw new Error('This is a BitTorrent v2 torrent, which lists no SHA-1 pieces to check files against.');
  }
  const files = matchFiles(fields, picked);
  const parts = fields.files.map((f, i) => ({ blob: files[i], length: f.length }));
  const { hashes, absent } = await hash(parts, fields.pieceLength, { onProgress, signal });
  let good = 0;
  let bad = 0;
  let missing = 0;
  for (let i = 0; i < fields.pieceCount; i++) {
    if (absent[i]) {
      missing += 1;
      continue;
    }
    let same = true;
    for (let b = 0; b < 20; b++) {
      if (hashes[i * 20 + b] !== expected[i * 20 + b]) {
        same = false;
        break;
      }
    }
    if (same) good += 1;
    else bad += 1;
  }
  return {
    pieces: fields.pieceCount,
    good,
    bad,
    missing,
    percent: Math.floor((good / fields.pieceCount) * 1000) / 10,
    missingFiles: fields.files.filter((f, i) => !files[i]).map((f) => f.path),
    wrongSizes: fields.files.flatMap((f, i) => (files[i] && files[i].size !== f.length ? [{ path: f.path, size: files[i].size, length: f.length }] : [])),
    files,
  };
}

/** A check's result in a sentence or two. */
export function describeCheck(r) {
  if (r.good === r.pieces) return `All ${r.pieces.toLocaleString()} pieces are good: these files are this torrent, ready to seed.`;
  const parts = [`${r.percent}% good: ${r.good.toLocaleString()} of ${r.pieces.toLocaleString()} pieces`];
  if (r.bad) parts.push(`${r.bad.toLocaleString()} bad`);
  if (r.missing) parts.push(`${r.missing.toLocaleString()} missing`);
  return `${parts.join(', ')}.`;
}

export function describeWrongSize(w) {
  return `${w.path}: ${formatSize(w.size)} where the torrent says ${formatSize(w.length)}`;
}
