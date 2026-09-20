/* Phone Torrent server: the BitTorrent half a browser cannot do.
 *
 * A web page has no TCP, no UDP and no DHT, so a private tracker, an http(s)
 * tracker or a swarm without a WebRTC peer is out of its reach. This is a real
 * client — the same swarm every other client sees — with an HTTP API in front
 * of it, and it serves the app from the same origin so there is no CORS to
 * configure and nothing else to deploy.
 *
 * The API is the one the app already speaks to a cloud service: submit, list,
 * status, delete, and a plain link per file that the phone downloads or plays.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebTorrent from 'webtorrent';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 0 means "any free port", which is how the tests run it; `|| 8080` would eat that.
const PORT = process.env.PORT === undefined || process.env.PORT === '' ? 8080 : Number(process.env.PORT);
const TOKEN = (process.env.AUTH_TOKEN || '').trim();
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(HERE, '..', 'downloads');
const WEB_DIR = process.env.WEB_DIR || path.join(HERE, '..');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
const SEED_AFTER_DONE = process.env.SEED_AFTER_DONE !== '0';
const STATE_FILE = path.join(DOWNLOAD_DIR, 'transfers.json');

await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });

const client = new WebTorrent({ dht: true });
client.on('error', (err) => console.error('client error:', err.message || err));

/* ---------- what survives a restart ---------- */

/** @type {Map<string, {id: string, source: string, addedAt: number}>} */
const records = new Map();

async function saveState() {
  const rows = [...records.values()];
  await fsp.writeFile(STATE_FILE, JSON.stringify(rows, null, 2)).catch(() => {});
}

async function loadState() {
  try {
    const rows = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
    for (const row of rows) {
      records.set(row.id, row);
      // The bytes are already on disk; WebTorrent verifies them instead of fetching again.
      addToClient(row.source);
    }
    if (rows.length) console.log(`resumed ${rows.length} transfer(s)`);
  } catch { /* first run */ }
}

function addToClient(source) {
  const id = source.startsWith('torrent:') ? Buffer.from(source.slice(8), 'base64') : source;
  return client.add(id, { path: DOWNLOAD_DIR });
}

/* ---------- the shape the app reads ---------- */

function describe(torrent) {
  const record = records.get(torrent.infoHash);
  const ready = Boolean(torrent.done);
  return {
    id: torrent.infoHash,
    name: torrent.name || torrent.infoHash,
    size: torrent.length || 0,
    progress: Number(torrent.progress) || 0,
    state: torrent.done ? (torrent.paused ? 'completed' : 'seeding') : (torrent.numPeers ? 'downloading' : 'looking for peers'),
    ready,
    peers: torrent.numPeers,
    downloadSpeed: torrent.downloadSpeed,
    addedAt: record ? record.addedAt : undefined,
    files: ready
      ? torrent.files.map((f, i) => ({ id: i, name: f.name, size: f.length }))
      : [],
  };
}

function findTorrent(id) {
  return client.torrents.find((t) => t.infoHash === id) || null;
}

/* ---------- http ---------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.includes('*') ? (origin || '*') : (ALLOWED_ORIGINS.includes(origin) ? origin : '');
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range, X-Torrent-Name',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition',
    'Access-Control-Max-Age': '86400',
  };
}

function send(req, res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(req),
    ...headers,
  });
  res.end(payload);
}

/** The token may travel in a header, or in the query string — a <video> tag cannot set headers. */
function authorized(req, url) {
  if (!TOKEN) return true;
  const header = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const given = header || url.searchParams.get('token') || '';
  // Constant-time compare so the token cannot be guessed a character at a time.
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serveFile(req, res, torrent, index, url) {
  const file = torrent.files[index];
  if (!file) return send(req, res, 404, { error: 'no such file' });
  const total = file.length;
  const range = req.headers.range;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${url.searchParams.get('inline') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    ...corsHeaders(req),
  };
  // Range matters twice over: it is how a <video> seeks, and how a phone resumes a download.
  const m = range && range.match(/bytes=(\d*)-(\d*)/);
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Number(m[2]) : total - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      return send(req, res, 416, { error: 'range not satisfiable' }, { 'Content-Range': `bytes */${total}` });
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return file.createReadStream({ start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': total });
  if (req.method === 'HEAD') return res.end();
  return file.createReadStream().pipe(res);
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(WEB_DIR, path.normalize(rel));
  if (!file.startsWith(path.resolve(WEB_DIR))) return send(req, res, 403, { error: 'forbidden' });
  let stat;
  try { stat = fs.statSync(file); } catch { stat = null; }
  if (!stat || !stat.isFile()) return send(req, res, 404, { error: 'not found' });
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://server');
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  if (pathname === '/api/health') return send(req, res, 200, { ok: true, torrents: client.torrents.length });

  if (pathname.startsWith('/api/')) {
    if (!authorized(req, url)) return send(req, res, 401, { error: 'bad or missing token' });

    if (pathname === '/api/account' && req.method === 'GET') {
      const active = client.torrents.length;
      let free = '';
      try {
        const { bavail, bsize } = await fsp.statfs(DOWNLOAD_DIR);
        free = `${Math.round((bavail * bsize) / 1e9)} GB free`;
      } catch { /* statfs is not everywhere */ }
      return send(req, res, 200, {
        who: 'your server',
        detail: [`${active} transfer${active === 1 ? '' : 's'}`, free].filter(Boolean).join(' · '),
        version: 1,
      });
    }

    if (pathname === '/api/transfers' && req.method === 'GET') {
      return send(req, res, 200, { transfers: client.torrents.map(describe) });
    }

    if (pathname === '/api/transfers' && req.method === 'POST') {
      let source;
      try {
        const type = String(req.headers['content-type'] || '');
        if (type.includes('application/json')) {
          const { magnet } = JSON.parse((await readBody(req)).toString() || '{}');
          if (!magnet || !/^(magnet:|[a-f0-9]{40}$)/i.test(String(magnet).trim())) throw new Error('need a magnet link or an info hash');
          source = /^magnet:/i.test(magnet) ? magnet : `magnet:?xt=urn:btih:${magnet.trim()}`;
        } else {
          const bytes = await readBody(req);
          if (!bytes.length || bytes[0] !== 0x64) throw new Error('that body is not a .torrent file');
          source = `torrent:${bytes.toString('base64')}`;
        }
      } catch (err) {
        return send(req, res, 400, { error: err.message });
      }
      let torrent;
      try {
        torrent = addToClient(source);
      } catch (err) {
        return send(req, res, 400, { error: err.message });
      }
      // infoHash is known synchronously for a .torrent, and on 'infoHash' for a magnet.
      const id = torrent.infoHash || await new Promise((resolve) => torrent.once('infoHash', () => resolve(torrent.infoHash)));
      if (!records.has(id)) {
        records.set(id, { id, source, addedAt: Date.now() });
        await saveState();
      }
      torrent.on('done', () => {
        console.log(`done: ${torrent.name}`);
        if (!SEED_AFTER_DONE) torrent.pause();
      });
      return send(req, res, 201, { transfer: describe(torrent) });
    }

    const one = pathname.match(/^\/api\/transfers\/([a-f0-9]{40})$/i);
    if (one) {
      const torrent = findTorrent(one[1].toLowerCase());
      if (!torrent) return send(req, res, 404, { error: 'no such transfer' });
      if (req.method === 'GET') return send(req, res, 200, { transfer: describe(torrent) });
      if (req.method === 'DELETE') {
        records.delete(torrent.infoHash);
        await saveState();
        // Take the files with it: this is the delete of a cloud service, not a "stop".
        await new Promise((resolve) => client.remove(torrent, { destroyStore: true }, resolve));
        return send(req, res, 200, { ok: true });
      }
    }

    const fileReq = pathname.match(/^\/api\/transfers\/([a-f0-9]{40})\/files\/(\d+)$/i);
    if (fileReq && (req.method === 'GET' || req.method === 'HEAD')) {
      const torrent = findTorrent(fileReq[1].toLowerCase());
      if (!torrent) return send(req, res, 404, { error: 'no such transfer' });
      if (!torrent.files.length) return send(req, res, 409, { error: 'no metadata yet' });
      return serveFile(req, res, torrent, Number(fileReq[2]), url);
    }

    return send(req, res, 404, { error: 'no such endpoint' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, { error: 'method not allowed' });
  return serveStatic(req, res, pathname === '/' ? '/index.html' : pathname);
});

await loadState();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`phone-torrent server on http://0.0.0.0:${server.address().port}`);
  console.log(TOKEN ? 'a token is required' : 'NO TOKEN SET: anyone who can reach this can drive it');
  console.log(`downloads in ${DOWNLOAD_DIR}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    client.destroy(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
