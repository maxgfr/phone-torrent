/* Hashes pieces away from the page: see lib/torrent-hash.js. */
import { hashInline } from './torrent-hash.js';

self.onmessage = async ({ data }) => {
  try {
    const { hashes, absent } = await hashInline(data.parts, data.pieceLength, {
      onProgress: (done, total) => self.postMessage({ type: 'progress', done, total }),
    });
    self.postMessage({ type: 'done', hashes, absent }, [hashes.buffer, absent.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
