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
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(HERE, '..', 'downloads'));
const WEB_DIR = path.resolve(process.env.WEB_DIR || path.join(HERE, '..'));
// Unset means same-origin only: the page this server serves needs no CORS at all, and
// any other site the browser has open gets nothing. Name the origins that may call it.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const SEED_AFTER_DONE = process.env.SEED_AFTER_DONE !== '0';
const STATE_FILE = path.join(DOWNLOAD_DIR, 'transfers.json');
// Fixed, so that forwarding them means something: TCP and uTP on the first, the DHT on
// the second. WebTorrent's default is a random port per start, which no mapping can reach.
const portFrom = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));
const TORRENT_PORT = portFrom(process.env.TORRENT_PORT, 6881);
const DHT_PORT = portFrom(process.env.DHT_PORT, 6882);
// How long a file link the API hands out keeps working without the token.
const LINK_TTL_MS = 24 * 3600 * 1000;

await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });

const client = new WebTorrent({ dht: true, torrentPort: TORRENT_PORT, dhtPort: DHT_PORT });
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
      track(addToClient(row.source), row.id);
    }
    if (rows.length) console.log(`resumed ${rows.length} transfer(s)`);
  } catch { /* first run */ }
}

/** The id WebTorrent takes: a magnet string, or the .torrent bytes a record kept as base64. */
function torrentId(source) {
  return source.startsWith('torrent:') ? Buffer.from(source.slice('torrent:'.length), 'base64') : source;
}

function addToClient(source) {
  return client.add(torrentId(source), { path: DOWNLOAD_DIR });
}

/**
 * The list of transfers lives in the download directory, so a torrent whose top-level name
 * is that file's would write its bytes over it — and every transfer would be forgotten at
 * the next start. Such a torrent is refused rather than allowed to do that.
 */
function claimsStateFile(torrent) {
  const own = path.basename(STATE_FILE).toLowerCase();
  return torrent.files.some((f) => String(f.path).split(/[\\/]/)[0].toLowerCase() === own);
}

async function refuse(torrent, id, why) {
  console.error(`refused ${torrent.name || id}: ${why}`);
  records.delete(id);
  await saveState();
  // Not destroyStore: the file it would have written is the one being protected.
  if (!torrent.destroyed) torrent.destroy({ destroyStore: false });
}

/**
 * What a transfer does over its life, the same whether it was sent a minute ago or picked
 * up again after a restart. Answers false when the torrent was refused on the spot.
 */
function track(torrent, id) {
  const guard = () => {
    if (!claimsStateFile(torrent)) return true;
    refuse(torrent, id, `it would overwrite ${path.basename(STATE_FILE)}, the server's list of transfers`);
    return false;
  };
  if (torrent.metadata) {
    if (!guard()) return false;
  } else {
    torrent.once('metadata', guard);
  }
  torrent.on('done', () => {
    console.log(`done: ${torrent.name}`);
    if (!SEED_AFTER_DONE) torrent.pause();
  });
  // Metadata is when a transfer's name — and so its files on disk — becomes known.
  torrent.on('ready', async () => {
    const record = records.get(id);
    if (record && record.name !== torrent.name) {
      record.name = torrent.name;
      await saveState();
    }
  });
  torrent.on('error', async (err) => {
    console.error(`transfer failed: ${torrent.name || id}: ${err.message || err}`);
    const record = records.get(id);
    records.delete(id);
    await saveState();
    // Take the half-written files with it: nothing lists this transfer any more,
    // so anything it left behind is unreachable rather than resumable.
    try {
      if (!torrent.destroyed) await new Promise((resolve) => client.remove(torrent, { destroyStore: true }, resolve));
    } catch { /* webtorrent had already torn it down */ }
    await forgetFiles((record && record.name) || torrent.name);
  });
  return true;
}

/* ---------- file links that do not carry the token ---------- */

/**
 * A link to one file, good for a day, signed with the token instead of containing it: it
 * can be handed to a <video>, a download manager or another device without handing over
 * the key to the whole server.
 */
function signature(infoHash, index, expires) {
  return crypto.createHmac('sha256', TOKEN).update(`${infoHash}/${index}/${expires}`).digest('base64url');
}

function fileLink(infoHash, index) {
  const base = `/api/transfers/${infoHash}/files/${index}`;
  if (!TOKEN) return base;
  // Rounded to the hour, so a list polled every few seconds hands out the same link.
  const expires = Math.ceil((Date.now() + LINK_TTL_MS) / 3600000) * 3600000;
  return `${base}?expires=${expires}&sig=${signature(infoHash, index, expires)}`;
}

function signedFor(url, infoHash, index) {
  const expires = Number(url.searchParams.get('expires'));
  const given = Buffer.from(url.searchParams.get('sig') || '');
  if (!TOKEN || !Number.isFinite(expires) || expires < Date.now()) return false;
  const expected = Buffer.from(signature(infoHash, index, expires));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/* ---------- the shape the app reads ---------- */

/** Delete what a transfer wrote, and nothing else: only inside the download directory. */
async function forgetFiles(name) {
  if (!name) return;
  const target = path.resolve(DOWNLOAD_DIR, name);
  if (!target.startsWith(DOWNLOAD_DIR + path.sep) || target === STATE_FILE) return;
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
}

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
      ? torrent.files.map((f, i) => ({ id: i, name: f.name, size: f.length, link: fileLink(torrent.infoHash, i) }))
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

/**
 * A reader that goes away — a <video> seeking, a download cancelled — ends the read too, rather
 * than leaving WebTorrent fetching pieces for nobody; and a read that fails ends the response
 * instead of the process.
 */
function streamTo(source, res) {
  res.on('close', () => source.destroy());
  source.on('error', () => res.destroy());
  source.pipe(res);
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
  // One range only; anything else (several ranges, garbage) is answered with the whole file,
  // which RFC 9110 allows.
  const m = range && range.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    let start;
    let end;
    if (m[1] === '') {
      // "-500" is a suffix: the last 500 bytes, not the first 501.
      start = Math.max(0, total - Number(m[2]));
      end = m[2] === '0' ? -1 : total - 1;
    } else {
      start = Number(m[1]);
      // An end past the file means "to the end": promising bytes that do not exist
      // leaves the client waiting for them.
      end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
    }
    if (start > end || start >= total) {
      return send(req, res, 416, { error: 'range not satisfiable' }, { 'Content-Range': `bytes */${total}` });
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return streamTo(file.createReadStream({ start, end }), res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': total });
  if (req.method === 'HEAD') return res.end();
  return streamTo(file.createReadStream(), res);
}

const isInside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(WEB_DIR, path.normalize(rel));
  if (!isInside(file, WEB_DIR)) return send(req, res, 403, { error: 'forbidden' });
  // Run from a checkout, the web root is the repository and the downloads sit inside it.
  // Everything under /api asks for the token; the same files must not be one plain GET
  // away here. Dotfiles (.git, .env) are not the app either.
  if (isInside(file, DOWNLOAD_DIR) || path.relative(WEB_DIR, file).split(path.sep).some((part) => part.startsWith('.'))) {
    return send(req, res, 404, { error: 'not found' });
  }
  let stat;
  try { stat = fs.statSync(file); } catch { stat = null; }
  if (!stat || !stat.isFile()) return send(req, res, 404, { error: 'not found' });
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  return streamTo(fs.createReadStream(file), res);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://server');
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  if (pathname === '/api/health') return send(req, res, 200, { ok: true, torrents: client.torrents.length });

  if (pathname.startsWith('/api/')) {
    const fileReq = pathname.match(/^\/api\/transfers\/([a-f0-9]{40})\/files\/(\d+)$/i);
    const signed = fileReq && signedFor(url, fileReq[1].toLowerCase(), Number(fileReq[2]));
    if (!signed && !authorized(req, url)) return send(req, res, 401, { error: 'bad or missing token' });

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
      const type = String(req.headers['content-type'] || '');
      // Both types make a browser ask first (a CORS preflight), which a page on another
      // site does not get past. A text/plain or form body would not, and would let any
      // page the browser has open add torrents to a server with no token.
      if (!type.includes('application/json') && !type.includes('application/x-bittorrent')) {
        return send(req, res, 415, { error: 'send a magnet as application/json, or the .torrent file as application/x-bittorrent' });
      }
      try {
        if (type.includes('application/json')) {
          const { magnet } = JSON.parse((await readBody(req)).toString() || '{}');
          const given = String(magnet || '').trim();
          const isHash = /^[a-f0-9]{40}$/i.test(given) || /^[a-z2-7]{32}$/i.test(given);
          if (!given || !(/^magnet:\?/i.test(given) || isHash)) throw new Error('need a magnet link or an info hash');
          source = isHash ? `magnet:?xt=urn:btih:${given}` : given;
        } else {
          const bytes = await readBody(req);
          if (!bytes.length || bytes[0] !== 0x64) throw new Error('that body is not a .torrent file');
          source = `torrent:${bytes.toString('base64')}`;
        }
      } catch (err) {
        return send(req, res, 400, { error: err.message });
      }
      // Sending the same torrent twice is not a mistake — a phone that lost its
      // connection mid-tap does exactly that. Answer with the transfer it already is.
      const existing = await client.get(torrentId(source)).catch(() => null);
      if (existing) return send(req, res, 200, { transfer: describe(existing) });
      let torrent;
      try {
        torrent = addToClient(source);
      } catch (err) {
        return send(req, res, 400, { error: err.message });
      }
      // infoHash is known synchronously for a .torrent, and on 'infoHash' for a magnet —
      // unless the torrent is refused first (unparseable, or a duplicate that raced this
      // one in), in which case WebTorrent destroys it and 'infoHash' never comes.
      let failure = null;
      const id = torrent.infoHash || await new Promise((resolve) => {
        const settle = (value) => {
          torrent.removeListener('infoHash', onHash);
          torrent.removeListener('error', onError);
          resolve(value);
        };
        const onHash = () => settle(torrent.infoHash);
        const onError = (err) => {
          failure = err;
          settle(null);
        };
        torrent.once('infoHash', onHash);
        torrent.once('error', onError);
      });
      if (!id) {
        const raced = await client.get(torrentId(source)).catch(() => null);
        if (raced) return send(req, res, 200, { transfer: describe(raced) });
        return send(req, res, 400, { error: (failure && failure.message) || 'that is not a torrent' });
      }
      if (!records.has(id)) {
        records.set(id, { id, source, addedAt: Date.now() });
        await saveState();
      }
      if (!track(torrent, id)) {
        return send(req, res, 400, { error: `refused: it would overwrite ${path.basename(STATE_FILE)}, the server's list of transfers` });
      }
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
}

const server = http.createServer((req, res) => {
  // A request the server cannot make sense of (`GET /%`, `GET //`) is that request's
  // problem. Left to reject, it would take the process — and every transfer — with it.
  handle(req, res).catch((err) => {
    console.error(`${req.method} ${String(req.url).slice(0, 200)}: ${err.message || err}`);
    if (!res.headersSent) send(req, res, 400, { error: 'bad request' });
    else res.destroy();
  });
});

await loadState();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`phone-torrent server on http://0.0.0.0:${server.address().port}`);
  console.log(`BitTorrent on port ${TORRENT_PORT} (TCP and uTP), DHT on ${DHT_PORT}/udp`);
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
