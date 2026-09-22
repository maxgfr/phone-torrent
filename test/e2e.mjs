/* End-to-end test.
 *
 * Boots a local WebSocket tracker and a static server, seeds a two-file
 * torrent from one browser context and downloads it in another (the "phone"),
 * exercising the real UI: .torrent file input, per-file save, zip save, and
 * restore after reload from the browser's private storage.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { chromium, webkit, devices } from 'playwright';
import { Server as TrackerServer } from 'bittorrent-tracker';
import { startServer } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, '.tmp');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    const p = chromium.executablePath();
    if (existsSync(p)) return p;
  } catch { /* fall through */ }
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  for (const dir of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
    try {
      const hit = execFileSync('sh', ['-c', `ls -d ${base}/chromium-*/${dir} 2>/dev/null | sort -V | tail -1`]).toString().trim();
      if (hit) return hit;
    } catch { /* ignore */ }
  }
  return undefined;
}

// The waits below that depend on a WebRTC handshake coming up are generous: the same commit passes
// on one runner and times out on another, and a handshake that misses is retried every six seconds
// rather than failing outright. The assertions are unchanged — only the patience is.
let lastStep = 'start';
const log = (...a) => { lastStep = a.join(' '); console.log('•', ...a); };
const WATCHDOG_MS = 14 * 60 * 1000;
setTimeout(() => {
  console.error(`\nWATCHDOG: suite exceeded ${WATCHDOG_MS / 60000} minutes; last completed step: ${lastStep}`);
  process.exit(2);
}, WATCHDOG_MS).unref();
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** Bencode just enough to build a .torrent by hand. */
function bencode(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  if (typeof v === 'string') return bencode(Buffer.from(v));
  if (typeof v === 'number') return Buffer.from(`i${v}e`);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')]);
  const keys = Object.keys(v).sort();
  return Buffer.concat([Buffer.from('d'), ...keys.map((k) => Buffer.concat([bencode(k), bencode(v[k])])), Buffer.from('e')]);
}

/** A .torrent as a private tracker hands it out: private flag, https-only announce. */
function privateTorrent(body, name = 'private release.bin') {
  const pieceLength = 16384;
  const pieces = [];
  for (let off = 0; off < body.length; off += pieceLength) {
    pieces.push(createHash('sha1').update(body.subarray(off, off + pieceLength)).digest());
  }
  return bencode({
    announce: 'https://private.example/announce/passkey',
    'announce-list': [['https://private.example/announce/passkey']],
    info: {
      length: body.length,
      name,
      'piece length': pieceLength,
      pieces: Buffer.concat(pieces),
      private: 1,
    },
  });
}

async function waitFor(fn, { timeout = 60000, interval = 250, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/* A stand-in for the TorBox API: same paths, same wire format, on localhost. It proves the client
 * side of cloud fetch end to end (submit → poll → link → the phone downloads the bytes). */
function startCloudApi() {
  // payload is filled in once the test knows the bytes the "cloud" is holding.
  const state = { calls: [], polls: 0, key: 'test-api-key', payload: Buffer.alloc(0) };
  const json = (res, body, status = 200) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Cache-Control': 'no-store',
    }).end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://cloud.test');
    state.calls.push(`${req.method} ${url.pathname}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      }).end();
      return;
    }
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    const needsKey = url.pathname !== '/v1/api/torrents/requestdl';
    if (needsKey && bearer !== state.key) return json(res, { success: false, detail: 'bad api key' }, 401);

    if (url.pathname === '/v1/api/user/me') return json(res, { success: true, data: { email: 'phone@example.com', plan: 1 } });

    if (url.pathname === '/v1/api/torrents/controltorrent') {
      const body = await new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      state.controlled = JSON.parse(body || '{}');
      if (state.controlled.operation === 'delete') state.deleted = true;
      return json(res, { success: true, detail: 'ok' });
    }

    if (url.pathname === '/v1/api/torrents/createtorrent') {
      const body = await new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
      });
      state.submitted = body;
      return json(res, { success: true, data: { torrent_id: 77, hash: 'deadbeef', auth_id: 'x' } });
    }

    if (url.pathname === '/v1/api/torrents/mylist') {
      // Only a card's own poll advances the transfer; the library reads the same state without
      // moving it on, so asking for the list does not skip the "downloading" step.
      if (url.searchParams.get('id')) state.polls++;
      const ready = state.polls > 1;
      const row = {
        id: 77,
        name: 'private release.bin',
        size: state.payload.length,
        progress: ready ? 1 : 0.5,
        download_state: ready ? 'completed' : 'downloading',
        download_present: ready,
        download_finished: ready,
        files: ready ? [{ id: 9, short_name: 'private release.bin', size: state.payload.length }] : [],
      };
      // No id → the whole account, which is what the library asks for.
      if (!url.searchParams.get('id')) return json(res, { success: true, data: state.deleted ? [] : [row] });
      if (state.deleted) return json(res, { success: true, data: null });
      return json(res, {
        success: true,
        data: {
          id: Number(url.searchParams.get('id')),
          name: 'private release.bin',
          size: state.payload.length,
          progress: ready ? 1 : 0.5,
          download_state: ready ? 'completed' : 'downloading',
          download_present: ready,
          download_finished: ready,
          files: ready ? [{ id: 9, short_name: 'private release.bin', size: state.payload.length }] : [],
        },
      });
    }

    if (url.pathname === '/v1/api/torrents/requestdl') {
      if (url.searchParams.get('token') !== state.key) return json(res, { success: false, detail: 'bad token' }, 401);
      state.dl = { torrentId: url.searchParams.get('torrent_id'), fileId: url.searchParams.get('file_id') };
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="private release.bin"',
        'Content-Length': state.payload.length,
      }).end(state.payload);
      return;
    }
    json(res, { success: false, detail: 'not found' }, 404);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** The same idea for put.io: its own paths, its own envelopes (transfer/file/files). */
function startPutioApi() {
  const state = { polls: 0, key: 'putio-token', payload: Buffer.alloc(0) };
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://putio.test');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS' }).end();
      return;
    }
    const send = (body, status = 200) => res.writeHead(status, cors).end(JSON.stringify(body));
    const download = url.pathname.match(/^\/v2\/files\/(\d+)\/download$/);
    if (download) {
      if (url.searchParams.get('oauth_token') !== state.key) return send({ status: 'ERROR', error_message: 'bad token' }, 401);
      state.downloadedId = download[1];
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="cloud-putio.bin"',
        'Content-Length': state.payload.length,
      }).end(state.payload);
      return;
    }
    if ((req.headers.authorization || '').replace(/^Bearer /, '') !== state.key) {
      return send({ status: 'ERROR', error_message: 'bad token' }, 401);
    }
    if (url.pathname === '/v2/account/info') {
      return send({ status: 'OK', info: { username: 'phone-user', disk: { used: 1024 * 1024, size: 100 * 1024 * 1024, avail: 99 * 1024 * 1024 } } });
    }
    if (url.pathname === '/v2/transfers/list') {
      const ready = state.polls > 1;
      return send({
        status: 'OK',
        transfers: state.deleted ? [] : [{
          id: 55,
          name: 'putio release.bin',
          status: ready ? 'COMPLETED' : 'DOWNLOADING',
          percent_done: ready ? 100 : 40,
          file_id: ready ? 1234 : null,
          size: state.payload.length,
        }],
      });
    }
    if (url.pathname === '/v2/transfers/cancel' || url.pathname === '/v2/files/delete') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      state[url.pathname === '/v2/files/delete' ? 'deletedFiles' : 'cancelled'] = Buffer.concat(chunks).toString();
      if (url.pathname === '/v2/files/delete') state.deleted = true;
      return send({ status: 'OK' });
    }
    if (url.pathname === '/v2/transfers/add') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      state.added = Buffer.concat(chunks).toString();
      return send({ status: 'OK', transfer: { id: 56, status: 'IN_QUEUE' } });
    }
    if (url.pathname === '/v2/files/upload') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      state.uploaded = Buffer.concat(chunks);
      return send({ status: 'OK', transfer: { id: 55, status: 'IN_QUEUE' } });
    }
    if (url.pathname === '/v2/transfers/55') {
      state.polls++;
      const ready = state.polls > 1;
      return send({
        status: 'OK',
        transfer: {
          id: 55,
          name: 'putio release.bin',
          status: ready ? 'COMPLETED' : 'DOWNLOADING',
          percent_done: ready ? 100 : 40,
          file_id: ready ? 1234 : null,
          size: state.payload.length,
        },
      });
    }
    if (url.pathname === '/v2/files/1234') {
      return send({ status: 'OK', file: { id: 1234, name: 'putio release.bin', file_type: 'VIDEO', size: state.payload.length } });
    }
    send({ status: 'ERROR', error_message: 'not found' }, 404);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// A WebSocket tracker tells clients to re-announce every fifth of its interval, and the default is
// ten minutes — so a WebRTC handshake that misses (pause/resume, a fresh magnet) waits two minutes
// for the next try, longer than any wait here. Thirty seconds means a retry every six.
/* Real-Debrid and AllDebrid, in one stand-in: two very different dialects of the
 * same idea, both answering on their own paths so the provider table is checked
 * against what they actually send, not against a tidy version of it. */
function startDebridApis(payloadUrl) {
  const state = { key: 'debrid-key', rdSelected: false, adDeleted: false };
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://debrid.test');
    const send = (body, status = 200) => res.writeHead(status, cors).end(JSON.stringify(body));
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS' }).end();
      return;
    }
    const body = await new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

    /* ---- Real-Debrid: bearer token, form bodies, links to unrestrict ---- */
    if (url.pathname.startsWith('/rest/1.0/')) {
      if ((req.headers.authorization || '') !== `Bearer ${state.key}`) return send({ error: 'bad_token' }, 401);
      const p = url.pathname.slice('/rest/1.0/'.length);
      if (p === 'user') return send({ username: 'rd-user', email: 'rd@example.com', premium: 172800, type: 'premium' });
      if (p === 'torrents/addMagnet') {
        state.rdMagnet = body.toString();
        return send({ id: 'RD1', uri: '/rest/1.0/torrents/info/RD1' });
      }
      if (p === 'torrents/addTorrent') {
        state.rdBytes = body;
        return send({ id: 'RD1' });
      }
      if (p === 'torrents/selectFiles/RD1') {
        state.rdSelected = body.toString().includes('files=all');
        return send({}, 204);
      }
      if (p === 'torrents/info/RD1') {
        return send({
          id: 'RD1',
          filename: 'rd release.mkv',
          bytes: 4096,
          progress: 100,
          status: 'downloaded',
          files: [{ id: 1, path: '/rd release.mkv', bytes: 4096, selected: 1 }],
          links: ['https://real-debrid.example/restricted/abc'],
        });
      }
      if (p === 'torrents') return send([{ id: 'RD1', filename: 'rd release.mkv', bytes: 4096, progress: 100, status: 'downloaded' }]);
      if (p === 'unrestrict/link') {
        state.rdUnrestricted = body.toString();
        return send({ download: payloadUrl, filename: 'rd release.mkv', filesize: 4096 });
      }
      if (p === 'torrents/delete/RD1') return send({}, 204);
      return send({ error: 'unknown_endpoint' }, 404);
    }

    /* ---- AllDebrid: key in the query, data envelopes, a nested file tree ---- */
    if (url.pathname.startsWith('/v4')) {
      if (url.searchParams.get('apikey') !== state.key) {
        return send({ status: 'error', error: { code: 'AUTH_BAD_APIKEY', message: 'The auth apikey is invalid' } });
      }
      if (url.pathname === '/v4/user') return send({ status: 'success', data: { user: { username: 'ad-user', isPremium: true } } });
      if (url.pathname === '/v4/magnet/upload') {
        state.adMagnet = url.searchParams.get('magnets[]');
        return send({ status: 'success', data: { magnets: [{ id: 77, magnet: state.adMagnet, ready: false }] } });
      }
      if (url.pathname === '/v4/magnet/upload/file') {
        state.adUploaded = body;
        return send({ status: 'success', data: { magnets: [{ id: 77, ready: false }] } });
      }
      if (url.pathname === '/v4.1/magnet/status') {
        const row = { id: 77, filename: 'ad release.mkv', size: 4096, downloaded: 4096, status: state.adDeleted ? 'Error' : 'Ready' };
        // With an id it answers with one object; without, with the whole list.
        if (url.searchParams.get('id')) return send({ status: 'success', data: { magnets: row } });
        return send({ status: 'success', data: { magnets: state.adDeleted ? [] : [row] } });
      }
      if (url.pathname === '/v4/magnet/files') {
        return send({
          status: 'success',
          data: { magnets: [{ id: 77, files: [{ n: 'season', e: [{ n: 'ad release.mkv', s: 4096, l: 'https://alldebrid.example/locked/xyz' }] }] }] },
        });
      }
      if (url.pathname === '/v4/link/unlock') {
        state.adUnlocked = url.searchParams.get('link');
        return send({ status: 'success', data: { link: payloadUrl, filename: 'ad release.mkv', filesize: 4096 } });
      }
      if (url.pathname === '/v4/magnet/delete') {
        state.adDeleted = true;
        return send({ status: 'success', data: { message: 'deleted' } });
      }
      return send({ status: 'error', error: { code: 'NOT_FOUND', message: 'no such endpoint' } });
    }
    send({ error: 'not found' }, 404);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const tracker = new TrackerServer({ udp: false, http: false, ws: true, stats: false, interval: 30000 });
await new Promise((resolve) => tracker.listen(0, '127.0.0.1', resolve));
const trackerUrl = `ws://127.0.0.1:${tracker.ws.address().port}`;
log('tracker at', trackerUrl);
// The tracker keeps no list of its sockets; this does, so a test can find one peer's.
const trackerSockets = new Set();
tracker.ws.on('connection', (socket) => {
  trackerSockets.add(socket);
  socket.on('close', () => trackerSockets.delete(socket));
});
// DIAG: every tracker socket that closes, and whose it was.
const t0 = Date.now();
tracker.ws.on('connection', (socket) => {
  let who = '?';
  socket.on('message', () => { if (socket.peerId) who = socket.peerId.slice(-8); });
  socket.on('close', (code) => console.error(`DIAG tracker: socket of ${who} closed (code ${code}) at ${Math.round((Date.now() - t0) / 1000)}s`));
});

const site = await startServer(0);
log('site at', site.url);

const cloudApi = await startCloudApi();
const putioApi = await startPutioApi();
const debridApi = await startDebridApis(`${site.url}test/.tmp/debrid-payload.bin`);
log('cloud API stubs at', cloudApi.url, ',', putioApi.url, 'and', debridApi.url);

// BROWSER=webkit runs the same suite on Safari's engine (what every browser on iOS uses).
const BROWSER = process.env.BROWSER || 'chromium';
const browser = BROWSER === 'webkit'
  ? await webkit.launch()
  : await chromium.launch({ executablePath: findChromium(), args: ['--allow-insecure-localhost'] });
log('browser:', BROWSER);
// DIAG: count every RTCPeerConnection a page makes, how they end, and what fails.
function pcProbe() {
  const s = window.__pc = { created: 0, closed: 0, connected: 0, failed: 0, candidates: {}, errors: [], rejections: [] };
  window.addEventListener('unhandledrejection', (e) => {
    if (s.rejections.length < 6) s.rejections.push(String((e.reason && (e.reason.stack || `${e.reason.name}: ${e.reason.message}`)) || e.reason));
  });
  const Orig = window.RTCPeerConnection;
  if (!Orig) return;
  function Probe(...args) {
    let pc;
    try { pc = new Orig(...args); } catch (e) { if (s.errors.length < 8) s.errors.push(`new: ${e}`); throw e; }
    s.created++;
    let closed = false;
    const close = pc.close.bind(pc);
    pc.close = () => { if (!closed) { closed = true; s.closed++; } return close(); };
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') s.connected++;
      else if (pc.connectionState === 'failed') s.failed++;
    });
    pc.addEventListener('icecandidate', (e) => {
      const c = e.candidate && e.candidate.candidate;
      if (!c) return;
      const parts = c.split(' ');
      const key = `${parts[7] || '?'}:${/\.local$/.test(parts[4] || '') ? 'mdns' : parts[4]}`;
      s.candidates[key] = (s.candidates[key] || 0) + 1;
    });
    for (const m of ['createOffer', 'createAnswer', 'setLocalDescription', 'setRemoteDescription', 'addIceCandidate']) {
      const f = pc[m].bind(pc);
      pc[m] = (...a) => {
        const r = f(...a);
        return r && typeof r.catch === 'function' ? r.catch((e) => { if (s.errors.length < 8) s.errors.push(`${m}: ${e}`); throw e; }) : r;
      };
    }
    return pc;
  }
  Probe.prototype = Orig.prototype;
  Object.setPrototypeOf(Probe, Orig);
  window.RTCPeerConnection = Probe;
}
const newContext = browser.newContext.bind(browser);
browser.newContext = async (opts) => {
  const ctx = await newContext(opts);
  await ctx.addInitScript(pcProbe);
  return ctx;
};
const pcStats = (page) => page.evaluate(() => {
  const s = window.__pc;
  return s && { created: s.created, open: s.created - s.closed, connected: s.connected, failed: s.failed, candidates: s.candidates, errors: s.errors, rejections: s.rejections };
}).catch((e) => ({ error: String(e) }));

let failed = false;
try {
  /* ---------- seeder ---------- */
  const seederCtx = await browser.newContext();
  const seeder = await seederCtx.newPage();
  seeder.on('pageerror', (e) => console.error('seeder page error:', e));
  // trackerList off, as for every page here: the suite's content is fixed, so is its info hash, and
  // on a public tracker it would meet every other run of this suite — the engine running beside it
  // included — and the crawlers that answer every offer, until WebRTC in WebKit gives out.
  await seeder.addInitScript((t) => localStorage.setItem('phone-torrent:settings', JSON.stringify({ trackers: [t], trackerList: false })), trackerUrl);
  await seeder.goto(site.url);
  await seeder.waitForFunction(() => window.__phoneTorrent?.client);

  const FILE_A = 3 * 1024 * 1024 + 123; // > one piece, uneven size
  const FILE_B = 700 * 1024;
  const rnd = (n, seed) => {
    const out = Buffer.alloc(n);
    let x = seed;
    for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x >> 16; }
    return out;
  };
  const seedBuffers = [rnd(FILE_A, 7), rnd(FILE_B, 11)];
  const files = [
    { name: 'video clip.bin', size: FILE_A, sha: sha(seedBuffers[0]) },
    { name: 'notes.txt', size: FILE_B, sha: sha(seedBuffers[1]) },
  ];

  // Seed through the real UI: "Seed & share" tab, pick files, name the collection.
  await seeder.click('.tab[data-tab="seed"]');
  seeder.once('dialog', (d) => d.accept('Phone Torrent Test'));
  await seeder.setInputFiles('#seed-file-input', files.map((f, i) => ({ name: f.name, mimeType: 'application/octet-stream', buffer: seedBuffers[i] })));
  await seeder.waitForSelector('.torrent.seeding .file', { timeout: 30000 });
  await waitFor(() => seeder.evaluate(() => window.__phoneTorrent.client.torrents[0]?.ready), { label: 'seeder ready' });
  console.error('DIAG seeder peerId:', (await seeder.evaluate(() => window.__phoneTorrent.client.peerId)).slice(-8));

  /**
   * Wait for something that first needs a fresh connection to the seeder, nudging the seeder to
   * re-announce along the way. Late in a run the seeder can fall out of the tracker's swarm — a
   * WebKit page under memory pressure loses its socket — and then nobody can find it again until
   * its next announce. The condition is unchanged; it just stops depending on that cadence.
   */
  // DIAG: what each side's trackers and peers look like, to see why a wait is long.
  const swarmState = (page) => page.evaluate(() => {
    const pt = window.__phoneTorrent;
    const hex = (s) => (typeof s === 'string' ? s.slice(-8) : String(s));
    return {
      peerId: hex(pt.client.peerId),
      torrents: pt.client.torrents.map((t) => ({
        infoHash: (t.infoHash || '').slice(0, 8), paused: t.paused, progress: Math.round((t.progress || 0) * 100), peers: t.numPeers, wires: t.wires.length,
        peerIds: [...(t._peers?.keys?.() || [])].map(hex),
        trackers: (t.discovery?.tracker?._trackers || []).map((tr) => ({ url: tr.announceUrl, destroyed: tr.destroyed, reconnecting: tr.reconnecting, retries: tr.retries, connected: Boolean(tr.socket?.connected) })),
      })),
    };
  }).catch((e) => ({ error: String(e) }));
  const waitForFromSeeder = async (fn, opts) => {
    let nudged = 0;
    const started = Date.now();
    let sawDown = false;
    try {
      const v = await waitFor(async () => {
        if (Date.now() - nudged > 15000) {
          nudged = Date.now();
          const down = await seeder.evaluate(() => {
            const t = window.__phoneTorrent.client.torrents[0];
            const d = (t?.discovery?.tracker?._trackers || []).filter((tr) => tr.reconnecting).map((tr) => `${tr.announceUrl} retries=${tr.retries}`);
            try { if (t) window.__phoneTorrent.askTrackersNow(t); } catch { /* page may be gone */ }
            return d;
          }).catch(() => []);
          if (down.length && !sawDown) { sawDown = true; console.error(`DIAG ${opts.label}: seeder tracker socket down, update() is a no-op:`, down.join(', ')); }
        }
        return fn();
      }, opts);
      console.error(`DIAG ${opts.label}: ${Math.round((Date.now() - started) / 1000)}s`);
      console.error(`DIAG ${opts.label} pcs: seeder`, JSON.stringify(await pcStats(seeder)), 'waiting page', opts.page ? JSON.stringify(await pcStats(opts.page)) : '-');
      return v;
    } catch (err) {
      console.error(`DIAG ${opts.label} timed out. seeder:`, JSON.stringify(await swarmState(seeder)));
      console.error(`DIAG ${opts.label} timed out. pcs: seeder`, JSON.stringify(await pcStats(seeder)), 'waiting page', opts.page ? JSON.stringify(await pcStats(opts.page)) : '-');
      if (opts.page) console.error(`DIAG ${opts.label} timed out. waiting page:`, JSON.stringify(await swarmState(opts.page)));
      const swarm = Object.entries(tracker.torrents).map(([h, sw]) => ({ h: h.slice(0, 8), peers: sw.peers?.keys?.length ?? sw.peers?.length, complete: sw.complete, incomplete: sw.incomplete }));
      console.error(`DIAG ${opts.label} timed out. tracker swarms:`, JSON.stringify(swarm));
      throw err;
    }
  };

  /* ---------- a tracker socket that drops comes back when asked, not minutes later ----------
   * bittorrent-tracker waits ten seconds plus up to five random minutes before reconnecting a
   * WebSocket that closed, and drops every announce in between — so update() alone does nothing,
   * and a peer nobody can find stays unfindable for longer than any wait below. */
  const seederPeerId = await seeder.evaluate(() => window.__phoneTorrent.client.peerId);
  const seederSocket = () => [...trackerSockets].find((ws) => ws.peerId === seederPeerId);
  const seederTracker = () => seeder.evaluate((url) => {
    const tr = window.__phoneTorrent.client.torrents[0].discovery.tracker._trackers.find((t) => t.announceUrl === url);
    return { reconnecting: tr.reconnecting, open: !tr.destroyed && Boolean(tr.socket?.connected) };
  }, trackerUrl);
  await waitFor(() => Boolean(seederSocket()), { label: 'seeder on the tracker' });
  seederSocket().terminate();
  await waitFor(() => seederTracker().then((t) => t.reconnecting), { label: 'seeder to notice its tracker socket closed', timeout: 10000 });
  await seeder.evaluate(() => window.__phoneTorrent.client.torrents[0].discovery.tracker.update());
  assert.deepEqual(await seederTracker(), { reconnecting: true, open: false }, 'update() does not reopen a closed tracker socket, which is why asking has to');
  const askedAt = Date.now();
  await seeder.evaluate(() => window.__phoneTorrent.askTrackersNow(window.__phoneTorrent.client.torrents[0]));
  await waitFor(() => seederTracker().then((t) => t.open && !t.reconnecting), { label: 'seeder tracker socket reopened once asked', timeout: 5000 });
  const reopenedIn = Date.now() - askedAt;
  // The announce itself waits for the WebRTC offers it carries, which is a few seconds at most.
  await waitFor(() => Boolean(seederSocket()), { label: 'seeder announced on the reopened socket', timeout: 20000 });
  log(`a dropped tracker socket reopens ${reopenedIn} ms after asking, and announces ${Date.now() - askedAt} ms after`);

  const torrentFile = await seeder.evaluate(() => Array.from(window.__phoneTorrent.client.torrents[0].torrentFile));
  assert.deepEqual(await seeder.evaluate(() => window.__phoneTorrent.client.torrents[0].announce), [trackerUrl], 'the seeded torrent names only the local tracker: the suite stays on this machine');
  assert.equal(await seeder.$eval('.torrent .name', (e) => e.textContent), 'Phone Torrent Test');
  assert.ok(!(await seeder.$eval('.torrent .details', (e) => e.hidden)), 'details open automatically after seeding starts');
  assert.match(await seeder.$eval('.torrent .d-infohash', (e) => e.textContent), /^[a-f0-9]{40}$/);
  await seeder.setViewportSize({ width: 390, height: 844 });
  await seeder.screenshot({ path: path.join(TMP, 'seeder.png'), fullPage: true });

  // Storage housekeeping must never delete the store of a torrent that is live in the client
  // (seeds have no persisted record). Wait until the seed's pieces are on disk, run the cleanup,
  // then read them back and verify their hashes.
  const readPieces = () => seeder.evaluate(async () => {
    const t = window.__phoneTorrent.client.torrents[0];
    for (const i of [0, t.pieces.length - 1]) {
      const buf = await new Promise((r) => t.store.get(i, (e, b) => r(e ? null : b)));
      if (!buf) return false;
      const h = await crypto.subtle.digest('SHA-1', buf);
      if ([...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('') !== t._hashes[i]) return false;
    }
    return true;
  });
  await waitFor(readPieces, { label: 'seed pieces written to the store', timeout: 20000 });
  await seeder.evaluate(() => window.__phoneTorrent.cleanOrphanStores([]));
  assert.equal(await readPieces(), true, 'orphan cleanup leaves live seed data intact');
  const opfs = await seeder.evaluate(() => window.__phoneTorrent.opfsOk);
  log('piece storage:', opfs ? 'OPFS' : 'memory (OPFS unavailable in this browser build)');
  log('seed store survives housekeeping');
  log('seeding', files.map((f) => `${f.name} (${f.size} B)`).join(', '));

  /* ---------- downloader ("the phone") ---------- */
  const phoneCtx = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phone = await phoneCtx.newPage();
  phone.on('pageerror', (e) => console.error('phone page error:', e));
  let dialogs = 0;
  phone.on('dialog', (d) => { dialogs++; d.accept(); });
  // The phone only knows a dead tracker; the real one must come from the fetched tracker list
  // (the qBittorrent-style "automatically add trackers" feature).
  writeFileSync(path.join(TMP, 'trackers.txt'), `udp://tracker.example.org:1337/announce\n\nhttp://ignored.example/announce\n${trackerUrl}\nwss://also-dead.example\n`);
  const listUrl = `${site.url}test/.tmp/trackers.txt`;
  // Merge rather than replace: this context also saves settings through the app's own
  // dialog later on, and a rewrite on every navigation would quietly undo that.
  await phone.addInitScript(({ listUrl, metaUrl }) => {
    let current = {};
    try { current = JSON.parse(localStorage.getItem('phone-torrent:settings') || '{}'); } catch { /* first load */ }
    localStorage.setItem('phone-torrent:settings', JSON.stringify({
      ...current,
      trackers: ['ws://127.0.0.1:2/dead'], trackerList: true, trackerListUrl: listUrl,
      metadataSources: ['https://127.0.0.1:1/never/{INFOHASH}.torrent', metaUrl], fallbackDelay: 5,
      dohResolver: `${new URL(listUrl).origin}/__doh`,
    }));
  }, { listUrl, metaUrl: `${site.url}test/.tmp/{infohash}.torrent` });
  await phone.goto(site.url);
  await phone.waitForFunction(() => window.__phoneTorrent?.client);
  await waitFor(() => phone.evaluate((t) => window.__phoneTorrent.effectiveTrackers().includes(t), trackerUrl), { label: 'tracker list to be fetched and merged', timeout: 15000 });
  const effective = await phone.evaluate(() => window.__phoneTorrent.effectiveTrackers());
  assert.deepEqual(effective, ['ws://127.0.0.1:2/dead', trackerUrl, 'wss://also-dead.example'], 'only ws(s) trackers are merged, deduplicated, user list first');
  log('tracker list merged:', effective.length, 'trackers');

  // PWA: manifest points at real PNG icons and the service worker precached the app shell.
  const manifest = await phone.evaluate(async () => (await fetch('./manifest.webmanifest')).json());
  for (const icon of manifest.icons.filter((i) => i.type === 'image/png')) {
    const res = await phone.evaluate(async (src) => { const r = await fetch(src); return { ok: r.ok, type: r.headers.get('content-type') }; }, icon.src);
    assert.ok(res.ok && /image\/png/.test(res.type), `icon ${icon.src} is served as PNG`);
  }
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'has a maskable icon');
  assert.ok(manifest.share_target && manifest.protocol_handlers, 'share target and protocol handler declared');
  await waitFor(() => phone.evaluate(async () => {
    const cache = await caches.open('phone-torrent-shell-v1');
    return Boolean(await cache.match('./app.js') && await cache.match('./vendor/webtorrent.min.js') && await cache.match('./index.html'));
  }), { label: 'app shell precache', timeout: 15000 });
  log('PWA manifest + app shell cache OK');

  // Network check: live tracker reachable, dead hostname flagged as dead, unreachable IP flagged as blocked.
  const netcheck = await phone.evaluate(() => window.__phoneTorrent.runNetworkCheck());
  const byUrl = Object.fromEntries(netcheck.map((r) => [r.url, r]));
  assert.equal(byUrl[trackerUrl].level, 'ok', 'local tracker reachable');
  assert.equal(byUrl['wss://also-dead.example'].level, 'bad', 'non-existent host reported dead');
  assert.equal(byUrl['ws://127.0.0.1:2/dead'].level, 'warn', 'unreachable but existing host reported as possibly blocked');
  assert.equal((await phone.$$('#netcheck-results li')).length, 3);
  log('network check OK');

  const waitSaver = (page) => page.evaluate(() => new Promise((resolve) => {
    const started = Date.now();
    const t = setInterval(() => {
      const s = window.__phoneTorrent.saver;
      if (s.mode === 'stream' || s.reason || Date.now() - started > 15000) { clearInterval(t); resolve({ mode: s.mode, reason: s.reason }); }
    }, 50);
  }));
  const saverMode = (await waitSaver(phone)).mode;
  log('saver mode:', saverMode);
  // Chromium streams saves through the service worker; WebKit (Safari) deliberately saves via memory.
  assert.equal(saverMode, BROWSER === 'webkit' ? 'blob' : 'stream', 'expected save mode for this engine');

  // Add through the real file input, as a user picking a .torrent from their phone would.
  await phone.setInputFiles('#torrent-file-input', {
    name: 'test.torrent',
    mimeType: 'application/x-bittorrent',
    buffer: Buffer.from(torrentFile),
  });

  await phone.waitForSelector('.torrent .file', { timeout: 15000 });
  assert.equal(await phone.isVisible('#install-btn'), false, 'Install button stays hidden until beforeinstallprompt');
  assert.equal(await phone.isVisible('.torrent .details'), false, 'details panel hidden until opened');
  assert.equal(await phone.isVisible('.torrent .log'), false, 'event log hidden until opened');
  const names = await phone.$$eval('.torrent .file .file-name', (els) => els.map((e) => e.textContent));
  assert.deepEqual([...names].sort(), files.map((f) => f.name).sort());
  log('file list rendered:', names.join(', '));

  try {
    await waitForFromSeeder(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { page: phone, label: 'download to finish', timeout: 180000 });
  } catch (err) {
    const dump = (page) => page.evaluate(() => window.__phoneTorrent.client.torrents.map((t) => ({
      name: t.name, peers: t.numPeers, progress: t.progress, paused: t.paused, ready: t.ready, done: t.done,
      downloaded: t.downloaded, uploaded: t.uploaded, received: t.received, selections: t._selections?._items?.length,
      warnings: window.__phoneTorrent.views.get(t)?.log?.filter((l) => /warning|error|fail/i.test(l)),
      wires: t.wires.map((w) => ({ type: w.type, peerChoking: w.peerChoking, amChoking: w.amChoking, peerInterested: w.peerInterested, amInterested: w.amInterested, requests: w.requests.length, peerRequests: w.peerRequests.length, peerPieces: w.peerPieces?.buffer?.length, uploaded: w.uploaded, downloaded: w.downloaded })),
    })));
    console.error('phone:', JSON.stringify(await dump(phone), null, 1));
    console.error('seeder:', JSON.stringify(await dump(seeder), null, 1));
    console.error('seeder piece check:', JSON.stringify(await seeder.evaluate(async () => {
      const t = window.__phoneTorrent.client.torrents[0];
      const out = { pieces: t.pieces.length, pieceLength: t.pieceLength, storeName: t.store?.store?.name || t.store?.name, results: [] };
      for (const i of [0, 1, t.pieces.length - 1]) {
        const buf = await new Promise((r) => t.store.get(i, (e, b) => r(e ? { err: String(e) } : b)));
        if (buf.err) { out.results.push({ i, err: buf.err }); continue; }
        const h = await crypto.subtle.digest('SHA-1', buf);
        const hex = [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
        out.results.push({ i, len: buf.length, ok: hex === t._hashes[i], zeros: buf.every((b) => b === 0) });
      }
      return out;
    })));
    console.error('phone warnings:', JSON.stringify(await phone.evaluate(() => window.__phoneTorrent.views.values().next().value.log.filter((l) => /verif|warning/i.test(l)))));
    console.error('tracker server torrents:', Object.keys(tracker.torrents).length);
    throw err;
  }
  log('download complete');
  assert.ok((await phone.$$('.torrent .save-btn:not([disabled])')).length === 2, 'both Save buttons enabled');
  assert.ok(await phone.$('.torrent .zip-btn:not([disabled])'), 'zip button enabled');

  // Pause / resume.
  await phone.click('.torrent .pause-btn');
  assert.ok(await phone.$('.torrent.paused'), 'torrent shows paused');
  assert.equal(await phone.$eval('.torrent .state', (e) => e.textContent), 'paused');
  assert.equal(await phone.evaluate(() => window.__phoneTorrent.client.torrents[0].paused), true);
  assert.equal(await phone.evaluate(() => window.__phoneTorrent.client.torrents[0].numPeers), 0, 'pause drops connections');
  await phone.click('.torrent .pause-btn');
  assert.equal(await phone.evaluate(() => window.__phoneTorrent.client.torrents[0].paused), false);
  assert.ok(!(await phone.$('.torrent.paused')), 'torrent resumed');
  const resumeStart = Date.now();
  await waitForFromSeeder(() => phone.evaluate(() => window.__phoneTorrent.client.torrents[0].numPeers > 0), { page: phone, label: 'peers reacquired after resume', timeout: 120000 });
  log(`pause/resume OK (peers reacquired in ${Math.round((Date.now() - resumeStart) / 1000)}s)`);

  // Sharing shows the links themselves: a toast saying "copied" is not a link.
  await phone.click('.torrent .share-link-btn');
  await phone.waitForSelector('.torrent .share-panel:not([hidden])');
  const shared = await phone.evaluate(() => ({
    app: document.querySelector('.share-app-link').value,
    magnet: document.querySelector('.share-magnet').value,
    selected: document.activeElement.classList.contains('share-app-link'),
  }));
  const liveMagnet = await phone.evaluate(() => window.__phoneTorrent.client.torrents[0].magnetURI);
  assert.equal(shared.magnet, liveMagnet, 'the magnet shown is this torrent\'s');
  assert.ok(shared.app.includes(`#magnet:?xt=urn:btih:`), 'the app link carries the magnet in its fragment');
  assert.ok(shared.selected, 'the link is selected, so one tap copies it');
  await phone.click('.torrent .share-copy-app');
  // The button answers on itself. Whether the clipboard accepts the write depends on the
  // engine's permissions, so both answers are valid — a silent button is not.
  const copyFeedback = await waitFor(async () => {
    const text = await phone.$eval('.torrent .share-copy-app', (e) => e.textContent);
    return ['Copied', 'Press and hold to copy'].includes(text) ? text : false;
  }, { label: 'the copy button to answer', timeout: 5000 });
  await phone.click('.torrent .share-close-btn');
  assert.equal(await phone.$eval('.torrent .share-panel', (e) => e.hidden), true);
  log('share shows the link:', shared.app.slice(0, 64) + `… (copy said "${copyFeedback}")`);

  // Details panel.
  await phone.click('.torrent .details-btn');
  assert.ok(!(await phone.$eval('.torrent .details', (e) => e.hidden)));
  assert.match(await phone.$eval('.torrent .d-infohash', (e) => e.textContent), /^[a-f0-9]{40}$/);
  assert.match(await phone.$eval('.torrent .d-trackers', (e) => e.textContent), /^ws:\/\/127\.0\.0\.1/);
  assert.ok((await phone.$$('.torrent .log li')).length > 0, 'event log has entries');
  const [torrentDl] = await Promise.all([
    phone.waitForEvent('download', { timeout: 30000 }),
    phone.click('.torrent .save-torrent-btn'),
  ]);
  assert.equal(torrentDl.suggestedFilename(), 'Phone Torrent Test.torrent');
  const torrentDlPath = path.join(TMP, 'saved.torrent');
  await torrentDl.saveAs(torrentDlPath);
  const phoneTorrentFile = await phone.evaluate(() => Array.from(window.__phoneTorrent.client.torrents[0].torrentFile));
  assert.deepEqual(Array.from(readFileSync(torrentDlPath)), phoneTorrentFile, '.torrent file round-trips');
  log('details + save .torrent OK');

  // Save one file: expect a real browser download whose bytes match the seed.
  const saveIndex = names.indexOf(files[0].name);
  const [download] = await Promise.all([
    phone.waitForEvent('download', { timeout: 30000 }),
    phone.locator('.torrent .file .save-btn').nth(saveIndex).click(),
  ]);
  const savedPath = path.join(TMP, 'saved.bin');
  await download.saveAs(savedPath);
  assert.equal(download.suggestedFilename(), files[0].name, 'download keeps the original file name');
  const savedBuf = readFileSync(savedPath);
  assert.equal(savedBuf.length, files[0].size);
  assert.equal(sha(savedBuf), files[0].sha, 'saved bytes match the seeded file');
  log('per-file save OK:', download.suggestedFilename());

  // Saving the same file again must work (WebTorrent caches recent pieces; they must not be detached).
  const [download2] = await Promise.all([
    phone.waitForEvent('download', { timeout: 30000 }),
    phone.locator('.torrent .file .save-btn').nth(saveIndex).click(),
  ]);
  const savedPath2 = path.join(TMP, 'saved-again.bin');
  await download2.saveAs(savedPath2);
  assert.equal(sha(readFileSync(savedPath2)), files[0].sha, 'second save of the same file matches');
  log('second save of the same file OK');

  // Save all as zip.
  const [zipDownload] = await Promise.all([
    phone.waitForEvent('download', { timeout: 30000 }),
    phone.click('.torrent .zip-btn'),
  ]);
  const zipPath = path.join(TMP, 'all.zip');
  await zipDownload.saveAs(zipPath);
  assert.equal(zipDownload.suggestedFilename(), 'Phone Torrent Test.zip');
  const extractDir = path.join(TMP, 'unzipped');
  execFileSync('unzip', ['-q', zipPath, '-d', extractDir]);
  for (const f of files) {
    const buf = readFileSync(path.join(extractDir, 'Phone Torrent Test', f.name));
    assert.equal(sha(buf), f.sha, `zip entry ${f.name} matches`);
  }
  log('zip save OK:', zipDownload.suggestedFilename());

  // Reload: the torrent must come back from storage, already complete (with OPFS) or re-downloaded (memory).
  // With OPFS the seeder is paused first, so a pass proves the pieces really came from disk.
  const seederPause = () => seeder.click('.torrent .pause-btn');
  if (opfs) await seederPause();
  await phone.reload();
  await phone.waitForSelector('.torrent .file', { timeout: 15000 });
  await waitFor(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { label: 'restored torrent to verify', timeout: 180000 });
  if (opfs) {
    assert.equal(await phone.evaluate(() => window.__phoneTorrent.client.torrents[0].received), 0, 'nothing re-downloaded: restored from OPFS');
    await seederPause(); // resume
  }
  log(opfs ? 'restored after reload with all pieces intact (seeder was paused)' : 'restored after reload and re-downloaded (memory store)');

  await phone.screenshot({ path: path.join(TMP, 'phone.png'), fullPage: true });
  await phone.click('#settings-btn');
  await phone.waitForSelector('#settings-dialog[open]');

  // Simple is the default and hides the settings nobody needs to touch.
  const hiddenInSimple = await phone.$$eval('#settings-dialog [data-expert]', (els) => els.filter((e) => !e.hidden).length);
  assert.equal(hiddenInSimple, 0, 'Simple hides every expert setting');
  assert.equal(await phone.isVisible('#cloud-key'), true, 'and keeps the one that makes it work');
  assert.equal(await phone.isVisible('#trackers-input'), false);
  await phone.screenshot({ path: path.join(TMP, 'settings.png') });

  await phone.click('#mode-expert');
  assert.equal(await phone.isVisible('#trackers-input'), true, 'Expert shows them');
  assert.equal(await phone.$$eval('#settings-dialog [data-expert]', (els) => els.filter((e) => e.hidden).length), 0);
  await phone.screenshot({ path: path.join(TMP, 'settings-expert.png') });
  await phone.keyboard.press('Escape');

  // The choice is a setting: it survives a reload like the others.
  await phone.reload();
  await phone.waitForFunction(() => window.__phoneTorrent?.client);
  await phone.click('#settings-btn');
  await phone.waitForSelector('#settings-dialog[open]');
  assert.equal(await phone.isVisible('#trackers-input'), true, 'Expert is remembered');
  await phone.click('#mode-simple');
  await phone.keyboard.press('Escape');
  log('settings: Simple by default, Expert when asked, remembered');
  await phone.waitForSelector('.torrent .file', { timeout: 15000 });

  // Deselecting a file survives a reload.
  const notesIndex = names.indexOf(files[1].name);
  await phone.locator('.torrent .file input[type="checkbox"]').nth(notesIndex).uncheck();
  assert.equal(await phone.evaluate((i) => window.__phoneTorrent.views.values().next().value.record.deselected.includes(i), notesIndex), true);
  await phone.evaluate(() => Promise.race([window.__phoneTorrent.views.values().next().value.persisted, new Promise((r) => setTimeout(r, 5000))]));
  await phone.reload();
  await phone.waitForSelector('.torrent .file', { timeout: 15000 });
  const restoredRecord = await phone.evaluate(() => { const r = window.__phoneTorrent.views.values().next().value.record; return { deselected: r?.deselected, source: r?.source?.type, paused: r?.paused }; });
  log('restored record:', JSON.stringify(restoredRecord));
  const namesAfter = await phone.$$eval('.torrent .file .file-name', (els) => els.map((e) => e.textContent));
  assert.equal(await phone.locator('.torrent .file input[type="checkbox"]').nth(namesAfter.indexOf(files[1].name)).isChecked(), false, 'deselection restored');
  assert.equal(await phone.$eval('.torrent .zip-btn', (e) => e.textContent), 'Save 1 selected as .zip');
  await phone.locator('.torrent .file input[type="checkbox"]').nth(namesAfter.indexOf(files[1].name)).check();
  log('file selection persisted across reload');

  // "Delete all stored torrent data", then adding a torrent again must still persist.
  await phone.click('#settings-btn');
  await phone.waitForSelector('#settings-dialog[open]');
  await phone.click('#clear-storage-btn');
  await waitFor(() => phone.$$('.torrent').then((l) => l.length === 0), { label: 'delete all' });
  await phone.setInputFiles('#torrent-file-input', { name: 'test.torrent', mimeType: 'application/x-bittorrent', buffer: Buffer.from(torrentFile) });
  await phone.waitForSelector('.torrent .file', { timeout: 15000 });
  await waitForFromSeeder(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { page: phone, label: 're-download after delete all', timeout: 180000 });
  await waitFor(() => phone.evaluate(() => window.__phoneTorrent.views.values().next().value.record?.infoHash), { label: 'record persisted after delete all' });
  await phone.reload();
  await phone.waitForSelector('.torrent .file', { timeout: 15000 });
  await waitForFromSeeder(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { page: phone, label: 'restore after delete-all cycle', timeout: 180000 });
  log('delete-all then re-add persists OK');

  // Removing deletes it from the list and from the persisted set.
  await phone.click('.torrent .remove-btn');
  await waitFor(() => phone.$$('.torrent').then((l) => l.length === 0), { label: 'torrent removal' });
  await waitFor(() => phone.evaluate(() => window.__phoneTorrent.client.torrents.length === 0), { label: 'client to drop the torrent' });
  await phone.reload();
  await phone.waitForFunction(() => window.__phoneTorrent?.client);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await phone.$$('.torrent')).length, 0, 'removed torrent does not come back');
  log('remove OK');

  /* ---------- Web Share Target: a .torrent shared to the installed app ---------- */
  await phone.setContent(`<form id="f" method="POST" enctype="multipart/form-data" action="${site.url}share">
    <input type="file" name="torrents" id="file"><input name="title" value="Phone Torrent Test"></form>`);
  await phone.setInputFiles('#file', { name: 'shared.torrent', mimeType: 'application/x-bittorrent', buffer: Buffer.from(torrentFile) });
  const dialogsBeforeShare = dialogs;
  await Promise.all([phone.waitForNavigation(), phone.evaluate(() => document.getElementById('f').submit())]);
  assert.equal(new URL(phone.url()).pathname, new URL(site.url).pathname, 'share target redirects back to the app');
  await phone.waitForSelector('.torrent .file', { timeout: 15000 });
  assert.ok(dialogs > dialogsBeforeShare, 'shared torrent asked for confirmation before being added');
  assert.equal(await phone.$eval('.torrent .name', (e) => e.textContent), 'Phone Torrent Test');
  await waitForFromSeeder(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { page: phone, label: 'shared torrent download', timeout: 180000 });
  log('share target OK');

  // Opening the app with a magnet in the URL adds it (protocol handler / shared link).
  const dialogsBeforeUrl = dialogs;
  await phone.goto(`${site.url}?magnet=${encodeURIComponent('magnet:?xt=urn:btih:' + '0'.repeat(40) + '&dn=fake')}`);
  await phone.waitForSelector('.torrent', { timeout: 15000 });
  await waitFor(() => phone.$$('.torrent').then((l) => l.length === 2), { label: 'magnet from URL to be added' });
  assert.equal(new URL(phone.url()).search, '', 'query string is cleaned up');
  assert.ok(dialogs > dialogsBeforeUrl, 'URL magnet asked for confirmation');
  // Fragment form as well (app links / #magnet:…): as a fresh load, and as a hash change on the open app.
  await phone.goto('about:blank');
  await phone.goto(`${site.url}#magnet:?xt=urn:btih:${'1'.repeat(40)}&dn=fragment`);
  await waitFor(() => phone.$$('.torrent').then((l) => l.length === 3), { label: 'magnet from fragment to be added (pending magnets survive reload)' });
  assert.equal(new URL(phone.url()).hash, '', 'fragment is cleaned up');
  await phone.evaluate((h) => { location.hash = h; }, `#magnet:?xt=urn:btih:${'2'.repeat(40)}&dn=hashchange`);
  await waitFor(() => phone.$$('.torrent').then((l) => l.length === 4), { label: 'magnet from hashchange to be added' });
  log('magnet from URL and fragment OK');

  /* ---------- magnet-sourced torrent: restored from stored metadata, retry keeps it ---------- */
  for (const t of await phone.$$('.torrent .remove-btn')) await t.click();
  await waitFor(() => phone.$$('.torrent').then((l) => l.length === 0), { label: 'clean slate for magnet test' });
  const mainHash = await seeder.evaluate(() => window.__phoneTorrent.client.torrents[0].infoHash);
  await phone.fill('#magnet-input', `magnet:?xt=urn:btih:${mainHash}`);
  await phone.click('#magnet-form button[type="submit"]');
  // A magnet has no metadata of its own: it comes from the seeder, so this waits like a download.
  try {
    await waitForFromSeeder(() => phone.$('.torrent .file').then(Boolean), { page: phone, label: 'magnet metadata from the seeder', timeout: 180000 });
  } catch (err) {
    // Both sides of the swarm, so a failure says whether the two ever found each other at all.
    const swarm = tracker.torrents[mainHash];
    console.error('swarm:', JSON.stringify({ known: Boolean(swarm), complete: swarm?.complete, incomplete: swarm?.incomplete }));
    console.error('phone:', JSON.stringify(await phone.evaluate(() => {
      const t = window.__phoneTorrent.client.torrents[0];
      const view = window.__phoneTorrent.views.values().next().value;
      return {
        infoHash: t?.infoHash,
        peers: t?.numPeers,
        wires: t?.wires?.length,
        announce: t?.announce,
        metadata: Boolean(t?.metadata),
        log: view?.log?.slice(-8),
      };
    })));
    console.error('seeder:', JSON.stringify(await seeder.evaluate(() => {
      const t = window.__phoneTorrent.client.torrents[0];
      return { infoHash: t?.infoHash, paused: t?.paused, peers: t?.numPeers, announce: t?.announce };
    })));
    throw err;
  }
  await waitForFromSeeder(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { page: phone, label: 'magnet download', timeout: 180000 });
  await phone.evaluate(() => Promise.race([window.__phoneTorrent.views.values().next().value.persisted, new Promise((r) => setTimeout(r, 5000))]));
  await seederPause(); // no peers available from here on
  await phone.reload();
  await phone.waitForSelector('.torrent .file', { timeout: 10000 });
  const magnetRestore = await phone.evaluate(() => {
    const t = window.__phoneTorrent.client.torrents[0];
    const r = window.__phoneTorrent.views.get(t).record;
    return { hasMetadata: Boolean(t.metadata), name: t.name, sourceType: r?.source?.type, peers: t.numPeers };
  });
  assert.deepEqual({ hasMetadata: magnetRestore.hasMetadata, name: magnetRestore.name, sourceType: magnetRestore.sourceType },
    { hasMetadata: true, name: 'Phone Torrent Test', sourceType: 'magnet' }, 'magnet torrent restored from its stored metadata without peers');
  if (opfs) {
    await waitFor(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { label: 'magnet torrent verified from disk', timeout: 30000 });
    assert.equal(await phone.evaluate(() => window.__phoneTorrent.client.torrents[0].received), 0, 'magnet torrent data came from OPFS');
  }
  await phone.click('.torrent .details-btn');
  await phone.click('.torrent .retry-btn');
  await waitFor(() => phone.$$eval('.torrent .log li', (els) => els.some((e) => /re-announced/.test(e.textContent))), { label: 'retry on magnet torrent', timeout: 15000 });
  assert.equal(await phone.evaluate(() => Boolean(window.__phoneTorrent.client.torrents[0].metadata)), true, 'retry keeps metadata on a magnet torrent');
  assert.equal(await phone.$eval('.torrent .name', (e) => e.textContent), 'Phone Torrent Test');
  await seederPause(); // resume seeder
  log('magnet torrent restore + retry OK');

  /* ---------- fallback "resolvers": metadata from a torrent cache, retry with fresh trackers ---------- */
  // A torrent nobody seeds: created in a context of its own, which is then closed. Removing the
  // torrent is not enough — the tracker keeps handing out a peer that is still connected to it, and
  // the phone then finds one, which is exactly what the no-peers hint below must not see. Closing
  // the context drops the WebSocket, and the tracker forgets the peer there and then.
  // Its bytes are random per run, so two CI jobs never share this info hash either.
  log('creating orphan torrent');
  const orphanCtx = await browser.newContext();
  const orphanPage = await orphanCtx.newPage();
  orphanPage.on('pageerror', (e) => console.error('orphan page error:', e));
  await orphanPage.addInitScript((t) => localStorage.setItem('phone-torrent:settings', JSON.stringify({ trackers: [t], trackerList: false })), trackerUrl);
  await orphanPage.goto(site.url);
  await orphanPage.waitForFunction(() => window.__phoneTorrent?.client);
  const orphan = await orphanPage.evaluate(async (bytes) => {
    const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms));
    const f = new File([new Uint8Array(bytes)], 'orphan.bin');
    // Use the app's own seeding path so it picks the same piece store the app would (OPFS or memory).
    const t = await window.__phoneTorrent.seedFiles([f], { name: 'Fallback Test' });
    await Promise.race([
      new Promise((resolve) => (t.ready ? resolve() : t.once('ready', resolve))),
      timeout(20000, 'seed orphan'),
    ]);
    return { infoHash: t.infoHash, torrentFile: Array.from(t.torrentFile) };
  }, Array.from(rnd(200 * 1024, Math.floor(Math.random() * 1e9) + 1)));
  await orphanCtx.close();
  await waitFor(() => !tracker.torrents[orphan.infoHash] || tracker.torrents[orphan.infoHash].complete + tracker.torrents[orphan.infoHash].incomplete === 0,
    { label: 'tracker to forget the orphan seeder', timeout: 15000 });
  log('orphan torrent created');
  writeFileSync(path.join(TMP, `${orphan.infoHash}.torrent`), Buffer.from(orphan.torrentFile));

  // The info-hash check must reject: another valid torrent, a corrupted info dict, and a duplicate info key.
  const verify = (bytes, hash) => phone.evaluate(async ({ bytes, hash }) => {
    try { await window.__phoneTorrent.verifyTorrentBytes(new Uint8Array(bytes), hash); return 'accepted'; } catch (e) { return e.message; }
  }, { bytes: Array.from(bytes), hash });
  assert.match(await verify(Buffer.from(torrentFile), orphan.infoHash), /info hash mismatch/, 'a different valid torrent is rejected by hash');
  const tampered = Buffer.from(orphan.torrentFile);
  const infoAt = tampered.indexOf('4:infod');
  assert.ok(infoAt > 0, 'torrent has an info dictionary');
  tampered[infoAt + 12] ^= 0xff; // inside the info dictionary
  assert.notEqual(await verify(tampered, orphan.infoHash), 'accepted', 'corrupted info dictionary is rejected');
  const duplicated = await phone.evaluate(({ real, other }) => {
    const enc = new TextEncoder();
    const a = new Uint8Array(real); const b = new Uint8Array(other);
    const [as, ae] = window.__phoneTorrent.findInfoSpan(a);
    const [bs, be] = window.__phoneTorrent.findInfoSpan(b);
    // d 4:info <real info> 4:info <other info> e  → a decoder keeps the last one, a naive check hashes the first
    const parts = [enc.encode('d4:info'), a.subarray(as, ae), enc.encode('4:info'), b.subarray(bs, be), enc.encode('e')];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return Array.from(out);
  }, { real: orphan.torrentFile, other: torrentFile });
  assert.match(await verify(Buffer.from(duplicated), orphan.infoHash), /duplicate|malformed/, 'duplicate info key is rejected');
  const accepted = await phone.evaluate(async ({ bytes, hash }) => {
    await window.__phoneTorrent.verifyTorrentBytes(new Uint8Array(bytes), hash); return true;
  }, { bytes: orphan.torrentFile, hash: orphan.infoHash });
  assert.ok(accepted, 'genuine .torrent passes the info-hash check');

  // Add by bare info hash: no peer can send metadata, so it must come from the fallback source.
  for (const t of await phone.$$('.torrent .remove-btn')) await t.click();
  await waitFor(() => phone.$$('.torrent').then((l) => l.length === 0), { label: 'clean slate' });
  await phone.fill('#magnet-input', orphan.infoHash);
  await phone.click('#magnet-form button[type="submit"]');
  await phone.waitForSelector('.torrent', { timeout: 10000 });
  await waitFor(() => phone.$eval('.torrent .name', (e) => e.textContent === 'Fallback Test').catch(() => false), { label: 'metadata via fallback source', timeout: 30000 });
  await phone.waitForSelector('.torrent .file', { timeout: 5000 });
  const fallbackLog = await phone.$$eval('.torrent .log li', (els) => els.map((e) => e.textContent).join('\n'));
  if (!/fallback/.test(fallbackLog)) console.error('event log was:\n' + fallbackLog);
  assert.match(fallbackLog, /fallback 127\.0\.0\.1:1: blocked by CORS or unreachable/, 'unreachable source is reported');
  assert.match(fallbackLog, /got \.torrent/, 'working source is reported');
  assert.match(fallbackLog, /metadata from fallback source/);
  log('metadata fallback OK');

  // No peers for a while → hint with retry; retry re-announces with a refreshed tracker list.
  try {
    await waitFor(() => phone.isVisible('.torrent .nopeers'), { label: 'no-peers hint', timeout: 30000 });
  } catch (err) {
    // The hint only appears while the torrent has no peer at all: say what the app saw instead.
    console.error('no-peers state:', JSON.stringify(await phone.evaluate(() => {
      const view = window.__phoneTorrent.views.values().next().value;
      const t = view.torrent;
      return {
        cards: document.querySelectorAll('.torrent').length,
        peers: t.numPeers,
        wires: t.wires.map((w) => ({ type: w.type, peerId: (w.peerId || '').slice(0, 8) })),
        done: t.done,
        paused: t.paused,
        progress: t.progress,
        sinceStart: Date.now() - view.startedAt,
        log: view.log.slice(-6),
      };
    })));
    throw err;
  }
  assert.match(await phone.$eval('.torrent .nopeers-text', (e) => e.textContent), /No peers found on \d+ trackers/);
  await phone.click('.torrent .nopeers-retry-btn');
  await waitFor(() => phone.$$eval('.torrent .log li', (els) => els.some((e) => /re-announced/.test(e.textContent))), { label: 'retry re-announce', timeout: 15000 });
  assert.equal(await phone.isVisible('.torrent .nopeers'), false, 'hint resets after retry');
  assert.equal(await phone.$eval('.torrent .name', (e) => e.textContent), 'Fallback Test', 'metadata kept across retry');
  log('retry with fresh trackers OK');

  // Coming back to a tab the phone froze: its sockets are dead, and BitTorrent's own
  // answer is to wait minutes for the next announce. This torrent still wants peers,
  // so the return must send it looking again by itself.
  await phone.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await new Promise((r) => setTimeout(r, 4500));
  await phone.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitFor(() => phone.$$eval('.torrent .log li', (els) => els.some((e) => /back after .*asking the trackers again/.test(e.textContent))),
    { label: 'the return to wake the torrent', timeout: 15000 });
  assert.equal(await phone.$eval('.torrent .state', (e) => e.textContent), 'reconnecting', 'and says so while it does');
  assert.equal(await phone.evaluate(() => window.__phoneTorrent.client.torrents[0].paused), false, 'coming back pauses nothing');
  log('coming back goes looking for peers by itself');

  /* ---------- iOS (Safari / Brave / Chrome on iPhone all report a WebKit iPhone UA) ---------- */
  const iphone = devices['iPhone 13'];
  const iosCtx = await browser.newContext({ ...iphone, acceptDownloads: true });
  const ios = await iosCtx.newPage();
  ios.on('pageerror', (e) => console.error('ios page error:', e));
  ios.on('dialog', (d) => d.accept());
  // This context saves settings from the app's own dialog later on, so the init script merges its
  // tracker choice into whatever is stored instead of replacing it on every navigation.
  await ios.addInitScript((t) => {
    let current = {};
    try { current = JSON.parse(localStorage.getItem('phone-torrent:settings') || '{}'); } catch { /* first load */ }
    localStorage.setItem('phone-torrent:settings', JSON.stringify({ ...current, trackers: [t], trackerList: false }));
  }, trackerUrl);
  await ios.goto(site.url);
  await ios.waitForFunction(() => window.__phoneTorrent?.client);
  const iosSaver = await waitSaver(ios);
  assert.equal(iosSaver.mode, 'blob', 'iOS saves through memory, not the streaming worker');
  assert.match(iosSaver.reason, /iOS/);
  // iOS maps the accept attribute to UTIs and .torrent has none, so any filter greys out every
  // .torrent in the Files picker: the input must stay unfiltered and judge the bytes instead.
  assert.equal(await ios.$eval('#torrent-file-input', (e) => e.getAttribute('accept')), null, 'no accept filter (it would hide .torrent files on iOS)');
  await ios.setInputFiles('#torrent-file-input', { name: 'test.torrent', mimeType: 'application/x-bittorrent', buffer: Buffer.from(torrentFile) });
  await ios.waitForSelector('.torrent .file', { timeout: 15000 });
  await waitForFromSeeder(() => ios.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { page: ios, label: 'iOS download', timeout: 180000 });
  const iosNames = await ios.$$eval('.torrent .file .file-name', (els) => els.map((e) => e.textContent));
  const [iosDownload] = await Promise.all([
    ios.waitForEvent('download', { timeout: 30000 }),
    ios.locator('.torrent .file .save-btn').nth(iosNames.indexOf(files[1].name)).click(),
  ]);
  const iosPath = path.join(TMP, 'ios.bin');
  await iosDownload.saveAs(iosPath);
  assert.equal(sha(readFileSync(iosPath)), files[1].sha, 'iOS save matches the seeded file');
  const [iosZip] = await Promise.all([
    ios.waitForEvent('download', { timeout: 30000 }),
    ios.click('.torrent .zip-btn'),
  ]);
  assert.equal(iosZip.suggestedFilename(), 'Phone Torrent Test.zip');
  await ios.screenshot({ path: path.join(TMP, 'ios.png'), fullPage: true });
  log('iOS-emulated save + zip OK');

  // Picking something that is not a .torrent (the picker can no longer filter) says so and adds nothing.
  const torrentsBefore = (await ios.$$('.torrent')).length;
  await ios.setInputFiles('#torrent-file-input', { name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: Buffer.from('ftypheic not a torrent') });
  await waitFor(() => ios.$$eval('.toast', (els) => els.some((e) => /is not a \.torrent file/.test(e.textContent))), { label: 'non-torrent rejected', timeout: 10000 });
  assert.equal((await ios.$$('.torrent')).length, torrentsBefore, 'a non-torrent file is not added');
  log('non-torrent file refused with an explanation');

  // A .torrent handed over as a link (what you get from a tracker on a phone) is fetched by the app.
  const hostedTorrent = path.join(TMP, 'hosted.torrent');
  writeFileSync(hostedTorrent, Buffer.from(torrentFile));
  await ios.click('.torrent .remove-btn');
  await waitFor(() => ios.$$('.torrent').then((l) => l.length === 0), { label: 'list cleared before the URL test' });
  await ios.fill('#magnet-input', `${site.url}test/.tmp/hosted.torrent`);
  await ios.click('#magnet-form button[type="submit"]');
  await ios.waitForSelector('.torrent .file', { timeout: 20000 });
  assert.equal(await ios.$eval('.torrent .name', (e) => e.textContent), 'Phone Torrent Test');
  // Stored as bytes, so a reload restores it without fetching the URL again.
  assert.equal(await ios.evaluate(() => window.__phoneTorrent.views.values().next().value.source?.type), 'torrent');
  log('.torrent URL fetched and added');

  // An unreachable .torrent URL explains itself instead of failing silently.
  await ios.fill('#magnet-input', 'https://torrent.invalid/nope.torrent');
  await ios.click('#magnet-form button[type="submit"]');
  await waitFor(() => ios.$$eval('.toast', (els) => els.some((e) => /Could not fetch that \.torrent/.test(e.textContent))), { label: 'bad .torrent URL reported', timeout: 15000 });
  log('unreachable .torrent URL reported');

  // A private-tracker .torrent parses and is listed, but says up front that no browser can reach it,
  // and its info hash must never be announced to the public trackers (BEP 27).
  const privatePayload = rnd(40000, 23);
  await ios.setInputFiles('#torrent-file-input', { name: 'private.torrent', mimeType: 'application/x-bittorrent', buffer: privateTorrent(privatePayload) });
  await waitFor(() => ios.$$eval('.torrent .name', (els) => els.some((e) => e.textContent === 'private release.bin')), { label: 'private torrent listed', timeout: 15000 });
  const privateHint = await ios.$$eval('.torrent', (els) => {
    const el = els.find((t) => t.querySelector('.name').textContent === 'private release.bin');
    return { text: el.querySelector('.nopeers-text').textContent, hidden: el.querySelector('.nopeers').hidden, retry: el.querySelector('.nopeers-retry-btn').hidden };
  });
  assert.equal(privateHint.hidden, false, 'private torrent explains itself immediately');
  assert.match(privateHint.text, /marked private \(private\.example\)/);
  assert.equal(privateHint.retry, true, 'no "retry with fresh trackers" for a private torrent');
  const privateAnnounce = await ios.evaluate(() => window.__phoneTorrent.client.torrents.find((t) => t.name === 'private release.bin').announce);
  assert.deepEqual(privateAnnounce, ['https://private.example/announce/passkey'], 'a private torrent is announced to its own tracker only');
  log('private torrent: listed, explained, not leaked to public trackers');

  /* ---------- cloud fetch: what a browser cannot reach, a remote client can ---------- */
  // The private torrent above is the case for it: no WebRTC peer will ever appear.
  cloudApi.state.payload = privatePayload;
  await ios.click('#settings-btn');
  await ios.waitForSelector('#settings-dialog[open]');
  await ios.click('#mode-expert'); // a custom base URL for a hosted service lives in Expert
  await ios.fill('#cloud-key', 'test-api-key');
  await ios.fill('#cloud-base', cloudApi.url);
  await ios.click('#cloud-test-btn');
  await waitFor(() => ios.$eval('#cloud-info', (e) => /Key accepted \(phone@example\.com\)/.test(e.textContent)), { label: 'cloud key accepted', timeout: 15000 });
  await ios.click('#settings-dialog button[type="submit"]');
  await ios.waitForSelector('#settings-dialog[open]', { state: 'detached', timeout: 5000 }).catch(() => {});
  log('cloud key validated and saved');

  const privateCard = ios.locator('.torrent', { has: ios.locator('.name', { hasText: 'private release.bin' }) }).first();
  await privateCard.locator('.nopeers-cloud-btn').click();
  await waitFor(() => privateCard.locator('.cloud-state').textContent().then((t) => /TorBox: downloading 50%/.test(t)).catch(() => false), { label: 'cloud transfer progress', timeout: 20000 });
  await waitFor(() => privateCard.locator('.cloud-state').textContent().then((t) => /Ready on TorBox/.test(t)).catch(() => false), { label: 'cloud transfer ready', timeout: 30000 });
  assert.ok(cloudApi.state.submitted && cloudApi.state.submitted.includes('private release.bin'), 'the .torrent itself was uploaded to the API');
  const cloudLinkText = await privateCard.locator('.cloud-files a').first().textContent();
  assert.match(cloudLinkText, /^private release\.bin · /);

  // The phone downloads the finished file straight from the API link: no peers, no memory ceiling.
  const [cloudDownload] = await Promise.all([
    ios.waitForEvent('download', { timeout: 30000 }),
    privateCard.locator('.cloud-files a').first().click(),
  ]);
  const cloudPath = path.join(TMP, 'cloud.bin');
  await cloudDownload.saveAs(cloudPath);
  assert.equal(sha(readFileSync(cloudPath)), sha(privatePayload), 'the file saved from the cloud matches the payload');
  assert.deepEqual(cloudApi.state.dl, { torrentId: '77', fileId: '9' }, 'the link asked for the right torrent and file');
  await ios.screenshot({ path: path.join(TMP, 'ios-cloud.png'), fullPage: true });
  log('cloud fetch OK: submitted, polled, downloaded through the API link');

  // The transfer survives a reload: the app picks the cloud id back up from storage. Wait for the
  // write to land first — WebKit's IndexedDB is slow enough that a reload can outrun it.
  const cloudPersisted = await ios.evaluate(async () => {
    const view = [...window.__phoneTorrent.views.values()].find((v) => v.torrent.name === 'private release.bin');
    await Promise.race([view.persisted, new Promise((r) => setTimeout(r, 10000))]);
    return Boolean(view.record && view.record.cloud && view.record.cloud.id !== undefined);
  });
  assert.ok(cloudPersisted, 'the cloud transfer id is stored with the torrent');
  await ios.reload();
  await ios.waitForFunction(() => window.__phoneTorrent?.client);
  const restoredCard = ios.locator('.torrent', { has: ios.locator('.name', { hasText: 'private release.bin' }) }).first();
  try {
    await waitFor(() => restoredCard.locator('.cloud-state').textContent().then((t) => /Ready on TorBox/.test(t)).catch(() => false), { label: 'cloud transfer restored', timeout: 30000 });
  } catch (err) {
    // Say what the app actually restored, so a failure here does not cost another CI round.
    console.error('restore state:', JSON.stringify(await ios.evaluate(() => ({
      cards: [...document.querySelectorAll('.torrent .name')].map((e) => e.textContent),
      cloudStates: [...document.querySelectorAll('.cloud-state')].map((e) => e.textContent),
      views: [...window.__phoneTorrent.views.values()].map((v) => ({ name: v.torrent.name, cloud: v.cloud, record: v.record && v.record.cloud })),
      key: Boolean(JSON.parse(localStorage.getItem('phone-torrent:settings') || '{}').cloud?.apiKey), // no key → nothing polls
    }))));
    throw err;
  }
  log('cloud transfer restored after reload');

  /* ---------- the same round trip on put.io, whose API looks nothing like TorBox's ---------- */
  putioApi.state.payload = rnd(30000, 31);
  await ios.setInputFiles('#torrent-file-input', {
    name: 'putio.torrent',
    mimeType: 'application/x-bittorrent',
    buffer: privateTorrent(putioApi.state.payload, 'putio release.bin'),
  });
  await waitFor(() => ios.$$eval('.torrent .name', (els) => els.some((e) => e.textContent === 'putio release.bin')), { label: 'second private torrent listed', timeout: 15000 });

  await ios.click('#settings-btn');
  await ios.waitForSelector('#settings-dialog[open]');
  await ios.click('#mode-expert'); // a custom base URL for a hosted service lives in Expert
  await ios.selectOption('#cloud-provider', 'putio');
  await ios.fill('#cloud-key', 'putio-token');
  await ios.fill('#cloud-base', putioApi.url);
  await ios.click('#cloud-test-btn');
  await waitFor(() => ios.$eval('#cloud-info', (e) => /Key accepted \(phone-user\)/.test(e.textContent)), { label: 'put.io token accepted', timeout: 15000 });
  await ios.click('#settings-dialog button[type="submit"]');
  await ios.waitForSelector('#settings-dialog[open]', { state: 'detached', timeout: 5000 }).catch(() => {});

  const putioCard = ios.locator('.torrent', { has: ios.locator('.name', { hasText: 'putio release.bin' }) }).first();
  await putioCard.locator('.nopeers-cloud-btn').click();
  await waitFor(() => putioCard.locator('.cloud-state').textContent().then((t) => /put\.io: downloading 40%/.test(t)).catch(() => false), { label: 'put.io transfer progress', timeout: 20000 });
  await waitFor(() => putioCard.locator('.cloud-state').textContent().then((t) => /Ready on put\.io/.test(t)).catch(() => false), { label: 'put.io transfer ready', timeout: 30000 });
  assert.ok(putioApi.state.uploaded && putioApi.state.uploaded.includes('putio release.bin'), 'the .torrent was uploaded to put.io');

  const [putioDownload] = await Promise.all([
    ios.waitForEvent('download', { timeout: 30000 }),
    putioCard.locator('.cloud-files a').first().click(),
  ]);
  const putioPath = path.join(TMP, 'cloud-putio.bin');
  await putioDownload.saveAs(putioPath);
  assert.equal(sha(readFileSync(putioPath)), sha(putioApi.state.payload), 'the file saved from put.io matches the payload');
  assert.equal(putioApi.state.downloadedId, '1234', 'the link pointed at the file the transfer produced');
  log('put.io round trip OK');

  // Switching the service does not break a transfer that belongs to the other one: each card keeps
  // the API it was started on.
  const torboxLink = await restoredCard.locator('.cloud-files a').first().getAttribute('href');
  assert.ok(torboxLink.startsWith(cloudApi.url), 'the TorBox transfer still links to TorBox after switching provider');
  log('per-transfer service kept across a provider switch');

  /* ---------- the cloud library: the account itself, no local torrent involved ---------- */
  await ios.click('.tab[data-tab="cloud"]');
  await waitFor(() => ios.$eval('#cloud-account', (e) => /put\.io · phone-user · [\d.]+ MB of 100 MB used/.test(e.textContent)), { label: 'cloud account line', timeout: 15000 });
  await waitFor(() => ios.$$eval('.cloud-item-name', (els) => els.some((e) => e.textContent === 'putio release.bin')), { label: 'library lists the transfer', timeout: 15000 });
  assert.match(await ios.$eval('.cloud-item-meta', (e) => e.textContent), /ready$/);

  // Files on demand, with a direct link per file — what the phone actually saves or streams.
  await ios.click('.cloud-item-files-btn');
  await waitFor(() => ios.$$eval('.cloud-file-name', (els) => els.some((e) => e.textContent === 'putio release.bin')), { label: 'file row', timeout: 15000 });
  const libraryHref = await ios.$eval('.cloud-save', (e) => e.getAttribute('href'));
  assert.ok(libraryHref.startsWith(`${putioApi.url}/v2/files/1234/download?oauth_token=`), 'the file links straight at the account');
  const [libraryDownload] = await Promise.all([
    ios.waitForEvent('download', { timeout: 30000 }),
    ios.click('.cloud-save'),
  ]);
  const libraryPath = path.join(TMP, 'library.bin');
  await libraryDownload.saveAs(libraryPath);
  assert.equal(sha(readFileSync(libraryPath)), sha(putioApi.state.payload), 'the library download matches the payload');

  // Sending a magnet from here never creates a local torrent: it is the account that downloads it.
  const localBefore = await ios.evaluate(() => window.__phoneTorrent.client.torrents.length);
  await ios.fill('#cloud-input', `magnet:?xt=urn:btih:${'3'.repeat(40)}&dn=cloud-only`);
  await ios.click('#cloud-form button[type="submit"]');
  await waitFor(() => Boolean(putioApi.state.added), { label: 'magnet handed to the cloud', timeout: 15000 });
  assert.match(putioApi.state.added, /magnet/, 'the magnet reached transfers/add');
  assert.equal(await ios.evaluate(() => window.__phoneTorrent.client.torrents.length), localBefore, 'nothing was added locally');

  // Delete removes it from the account: the transfer is cancelled and its file dropped.
  await ios.click('.cloud-item-delete');
  await waitFor(() => ios.$$('.cloud-item').then((l) => l.length === 0), { label: 'library entry removed', timeout: 15000 });
  assert.match(putioApi.state.cancelled, /transfer_ids=55/);
  assert.match(putioApi.state.deletedFiles, /file_ids=1234/);
  log('cloud library OK: listed, streamed link, magnet sent, deleted');

  /* ---------- Real-Debrid and AllDebrid: the same table, two other dialects ---------- */
  // Driven through the app's own provider functions rather than the UI, which
  // put.io and TorBox already cover: what is under test here is the mapping.
  const debridPayload = rnd(4096, 51);
  writeFileSync(path.join(TMP, 'debrid-payload.bin'), debridPayload);

  for (const [provider, label, account] of [['realdebrid', 'Real-Debrid', 'rd-user'], ['alldebrid', 'AllDebrid', 'ad-user']]) {
    // Point the app at the stand-in through its own settings dialog, which is
    // also the only place the new services have to appear.
    await ios.click('#settings-btn');
    await ios.waitForSelector('#settings-dialog[open]');
  await ios.click('#mode-expert'); // a custom base URL for a hosted service lives in Expert
    await ios.selectOption('#cloud-provider', provider);
    await ios.fill('#cloud-key', 'debrid-key');
    await ios.fill('#cloud-base', debridApi.url);
    await ios.click('#cloud-test-btn');
    await waitFor(() => ios.$eval('#cloud-info', (e) => /Key accepted/.test(e.textContent)), { label: `${label} key accepted`, timeout: 15000 });
    await ios.click('#settings-dialog button[type="submit"]');
    await ios.waitForSelector('#settings-dialog[open]', { state: 'detached', timeout: 5000 }).catch(() => {});

    const result = await ios.evaluate(async () => {
      const ctx = window.__phoneTorrent.cloudCtx();
      const who = await ctx.api.check(ctx);
      const id = await ctx.api.submit(ctx, { magnet: 'magnet:?xt=urn:btih:' + '4'.repeat(40) });
      const status = await ctx.api.status(ctx, id);
      const listed = await ctx.api.list(ctx);
      const link = ctx.api.fileLink(ctx, id, status.files[0]);
      const { detail } = await ctx.api.account(ctx);
      await ctx.api.remove(ctx, id, status);
      return { who, id, status, listed: listed.length, link, detail };
    });

    assert.equal(result.who, account, `${label} says who the key belongs to`);
    assert.ok(result.id, `${label} returned a transfer id`);
    assert.equal(result.status.ready, true, `${label} reports a finished transfer`);
    assert.equal(result.status.files.length, 1, `${label} lists the file`);
    assert.equal(result.status.files[0].size, 4096);
    assert.equal(result.link, `${site.url}test/.tmp/debrid-payload.bin`, `${label} hands back a link that needs no key`);
    assert.ok(result.listed >= 1, `${label} lists the account's transfers`);
    log(`${label} OK: ${result.who} · ${result.detail} · ${result.status.files[0].name}`);
  }
  // Served by your own server, the address to call is the one you are already on:
  // `docker compose up`, open it, and there is nothing to type in settings. Compared
  // against the address the test itself served from, so the page cannot agree with itself.
  const serverFallback = await ios.evaluate(() => {
    const api = window.__phoneTorrent.CLOUD_PROVIDERS.server;
    return typeof api.defaultBase === 'function' ? api.defaultBase() : api.defaultBase;
  });
  assert.equal(serverFallback, new URL(site.url).origin, 'with no address of its own, the server provider means this page — which is where a server that serves the app is');
  log('a server with no address means this page itself:', serverFallback);

  assert.ok(debridApi.state.rdSelected, 'Real-Debrid was told to select every file, without which it downloads nothing');
  assert.match(debridApi.state.rdUnrestricted, /link=https/, 'the restricted link was unrestricted');
  assert.match(debridApi.state.adUnlocked, /alldebrid\.example/, 'the locked link was unlocked');
  assert.equal(debridApi.state.adDeleted, true, 'AllDebrid delete reached the API');

  // The link a debrid service hands back is a plain file: the phone saves it like any download.
  const [debridDownload] = await Promise.all([
    ios.waitForEvent('download', { timeout: 30000 }),
    ios.evaluate((href) => {
      const a = document.createElement('a');
      a.href = href;
      a.download = 'debrid.bin';
      document.body.appendChild(a);
      a.click();
    }, `${site.url}test/.tmp/debrid-payload.bin`),
  ]);
  const debridPath = path.join(TMP, 'debrid-saved.bin');
  await debridDownload.saveAs(debridPath);
  assert.equal(sha(readFileSync(debridPath)), sha(debridPayload), 'the file behind a debrid link arrives intact');
  log('a debrid link downloads to the phone');
  await iosCtx.close();

  /* ---------- fallback: browser without service workers ---------- */
  const legacyCtx = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  const legacy = await legacyCtx.newPage();
  legacy.on('pageerror', (e) => console.error('legacy page error:', e));
  await legacy.addInitScript((t) => localStorage.setItem('phone-torrent:settings', JSON.stringify({ trackers: [t], trackerList: false })), trackerUrl);
  await legacy.goto(site.url);
  await legacy.waitForFunction(() => window.__phoneTorrent?.client);
  const legacyMode = (await waitSaver(legacy)).mode;
  assert.equal(legacyMode, 'blob', 'falls back to in-memory saving without a service worker');
  await legacy.setInputFiles('#torrent-file-input', { name: 'test.torrent', mimeType: 'application/x-bittorrent', buffer: Buffer.from(torrentFile) });
  await legacy.waitForSelector('.torrent .file', { timeout: 15000 });
  await waitForFromSeeder(() => legacy.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { page: legacy, label: 'legacy download', timeout: 180000 });
  const legacyNames = await legacy.$$eval('.torrent .file .file-name', (els) => els.map((e) => e.textContent));
  const [legacyDownload] = await Promise.all([
    legacy.waitForEvent('download', { timeout: 30000 }),
    legacy.locator('.torrent .file .save-btn').nth(legacyNames.indexOf(files[1].name)).click(),
  ]);
  const legacyPath = path.join(TMP, 'legacy.bin');
  await legacyDownload.saveAs(legacyPath);
  assert.equal(legacyDownload.suggestedFilename(), files[1].name);
  assert.equal(sha(readFileSync(legacyPath)), files[1].sha, 'blob-mode save matches the seeded file');
  log('blob fallback save OK:', legacyDownload.suggestedFilename());

  console.log('\nAll end-to-end checks passed.');
} catch (err) {
  failed = true;
  console.error('\nTEST FAILED:', err);
} finally {
  await browser.close();
  site.server.close();
  cloudApi.server.close();
  putioApi.server.close();
  debridApi.server.close();
  tracker.close();
  process.exit(failed ? 1 : 0);
}
