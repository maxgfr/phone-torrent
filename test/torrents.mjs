/* .torrent files built by hand, for the tests: bencode written here, apart from the app's own, so a
 * mistake in one is not repeated in the other. */
import { createHash } from 'node:crypto';

/** Bencode just enough to build a .torrent by hand. */
export function bencode(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  if (typeof v === 'string') return bencode(Buffer.from(v));
  if (typeof v === 'number') return Buffer.from(`i${v}e`);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')]);
  const keys = Object.keys(v).sort();
  return Buffer.concat([Buffer.from('d'), ...keys.map((k) => Buffer.concat([bencode(k), bencode(v[k])])), Buffer.from('e')]);
}

/** A single-file .torrent built by hand, with the trackers, web seeds and private flag asked for. */
export function makeTorrent(body, { name = 'file.bin', trackers = [], urlList, private: isPrivate = false, pieceLength = 16384, extra = {} } = {}) {
  const pieces = [];
  for (let off = 0; off < body.length; off += pieceLength) {
    pieces.push(createHash('sha1').update(body.subarray(off, off + pieceLength)).digest());
  }
  const info = { length: body.length, name, 'piece length': pieceLength, pieces: Buffer.concat(pieces), ...(isPrivate ? { private: 1 } : {}) };
  return {
    buf: bencode({
      ...(trackers.length ? { announce: trackers[0], 'announce-list': trackers.map((t) => [t]) } : {}),
      ...(urlList ? { 'url-list': urlList } : {}),
      ...extra,
      info,
    }),
    infoHash: createHash('sha1').update(bencode(info)).digest('hex'),
  };
}
