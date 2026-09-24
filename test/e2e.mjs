/* End-to-end test.
 *
 * Boots a local WebSocket tracker and a static server, seeds a two-file
 * torrent from one browser context and downloads it in another (the "phone"),
 * exercising the real UI: .torrent file input, per-file save, zip save, and
 * restore after reload from the browser's private storage.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import dgram from 'node:dgram';
import os from 'node:os';
import { inflateSync } from 'node:zlib';
import { chromium, webkit, devices } from 'playwright';
import { Server as TrackerServer } from 'bittorrent-tracker';
import { startServer } from './serve.mjs';
import proxyWorker from '../proxy/cloudflare-worker.js';

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

/** A single-file .torrent built by hand, with the trackers, web seeds and private flag asked for. */
function makeTorrent(body, { name = 'file.bin', trackers = [], urlList, private: isPrivate = false } = {}) {
  const pieceLength = 16384;
  const pieces = [];
  for (let off = 0; off < body.length; off += pieceLength) {
    pieces.push(createHash('sha1').update(body.subarray(off, off + pieceLength)).digest());
  }
  const info = { length: body.length, name, 'piece length': pieceLength, pieces: Buffer.concat(pieces), ...(isPrivate ? { private: 1 } : {}) };
  return {
    buf: bencode({
      ...(trackers.length ? { announce: trackers[0], 'announce-list': trackers.map((t) => [t]) } : {}),
      ...(urlList ? { 'url-list': urlList } : {}),
      info,
    }),
    infoHash: createHash('sha1').update(bencode(info)).digest('hex'),
  };
}

/** A .torrent as a private tracker hands it out: private flag, https-only announce. */
function privateTorrent(body, name = 'private release.bin') {
  return makeTorrent(body, { name, trackers: ['https://private.example/announce/passkey'], private: true }).buf;
}

/**
 * Save closes the dialog, and the dialog's 'close' event — where the settings are stored — comes a
 * moment later. "Test the key" no longer switches the app over before Save, so wait for Save itself.
 */
function savedService(page, provider) {
  return page.waitForFunction((p) => window.__phoneTorrent.cloudCtx().provider === p, provider, { timeout: 5000 });
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

/** The most of these calls, made at these times (in order), that fell within any one second. */
function burst(times) {
  let most = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i] - times[j] >= 1000) j++;
    most = Math.max(most, i - j + 1);
  }
  return most;
}

/** The WCAG contrast ratio of two opaque colours written as `rgb(r, g, b)`, as getComputedStyle gives them. */
function contrast(a, b) {
  const luminance = (css) => {
    const [r, g, bl] = css.match(/[\d.]+/g).slice(0, 3)
      .map((v) => Number(v) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The colour the page paints at one point, as `rgb(r, g, b)`: a screenshot of that one pixel. Its PNG
 * is a single scanline of one pixel, which no PNG filter changes, so the samples follow the filter byte.
 */
async function pixelAt(page, x, y) {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 }, scale: 'css' });
  const data = [];
  for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at)) {
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') data.push(png.subarray(at + 8, at + 8 + png.readUInt32BE(at)));
  }
  const [, r, g, b] = inflateSync(Buffer.concat(data));
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Lay a page out as an iPhone does. styles.css keeps some rules for iOS alone, behind
 * `@supports (-webkit-touch-callout: none)`, which no engine here matches: this applies them anyway.
 * `statusBar` is the height the installed app's status bar takes over the top of the page, which is
 * what `env(safe-area-inset-top)` reports there. Returns the undo.
 */
async function asOnIphone(page, { statusBar = 0 } = {}) {
  await page.evaluate((statusBar) => {
    const sheet = [...document.styleSheets].find((s) => s.href?.endsWith('/styles.css'));
    const rules = [...sheet.cssRules].flatMap((r) => (r.conditionText?.includes('-webkit-touch-callout') ? [...r.cssRules] : [r]));
    const copy = document.createElement('style');
    copy.id = 'as-on-iphone';
    copy.textContent = rules.map((r) => r.cssText).join('\n').replaceAll('env(safe-area-inset-top)', `${statusBar}px`);
    document.head.append(copy);
    sheet.disabled = true;
  }, statusBar);
  return () => page.evaluate(() => {
    document.getElementById('as-on-iphone').remove();
    [...document.styleSheets].find((s) => s.href?.endsWith('/styles.css')).disabled = false;
  });
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

    // Every active slot taken: createtorrent answers with a queued_id, and the torrent waits in
    // /queued — not in /torrents — until it starts under a torrent id of its own.
    if (url.pathname === '/v1/api/queued/getqueued') {
      const row = { id: 5, name: 'queued release', hash: QUEUED_HASH, type: 'torrent', magnet: `magnet:?xt=urn:btih:${QUEUED_HASH}` };
      if (url.searchParams.get('id')) {
        if (state.queued && url.searchParams.get('id') === '5') return json(res, { success: true, data: row });
        return json(res, { success: false, error: 'ITEM_NOT_FOUND', detail: 'Queued download not found.', data: null });
      }
      return json(res, { success: true, data: state.queued ? [row] : [] });
    }
    if (url.pathname === '/v1/api/queued/controlqueued') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      state.queueControlled = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      return json(res, { success: true, detail: 'ok' });
    }

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
      if (state.queueNext) {
        state.queueNext = false;
        state.queued = true;
        return json(res, { success: true, detail: 'Torrent queued.', data: { queued_id: 5, hash: QUEUED_HASH, auth_id: 'x', active_limit: 1, current_active_downloads: 1 } });
      }
      return json(res, { success: true, data: { torrent_id: 77, hash: 'deadbeef', auth_id: 'x' } });
    }

    if (url.pathname === '/v1/api/torrents/mylist') {
      // Only a card's own poll advances the transfer; the library reads the same state without
      // moving it on, so asking for the list does not skip the "downloading" step.
      if (url.searchParams.get('id')) state.polls++;
      const ready = state.polls > 1;
      const row = {
        id: 77,
        hash: 'deadbeef',
        name: 'private release.bin',
        size: state.payload.length,
        progress: ready ? 1 : 0.5,
        download_state: ready ? 'completed' : 'downloading',
        download_present: ready,
        download_finished: ready,
        files: ready ? [{ id: 9, short_name: 'private release.bin', size: state.payload.length }] : [],
      };
      // The queued torrent, once it has started: an ordinary row, found by its info hash.
      const started = { id: 78, hash: QUEUED_HASH, name: 'queued release', size: 1, progress: 1, download_state: 'completed', download_present: true, download_finished: true, files: [{ id: 0, short_name: 'queued release', size: 1 }] };
      // No id → the whole account, which is what the library asks for.
      if (!url.searchParams.get('id')) return json(res, { success: true, data: [...(state.deleted ? [] : [row]), ...(state.started ? [started] : [])] });
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
      state.listCalls = (state.listCalls || 0) + 1;
      if (state.down) return res.writeHead(502, { ...cors, 'Content-Type': 'text/html' }).end('<html><body><h1>502 Bad Gateway</h1></body></html>');
      const ready = state.polls > 1;
      const extra = state.extra ? [
        { id: 57, name: 'clip.mp4', status: 'COMPLETED', percent_done: 100, file_id: 1235, size: state.payload.length },
        { id: 58, name: 'still going', status: state.extraFailed ? 'ERROR' : 'DOWNLOADING', percent_done: 10, file_id: null, size: 1000 },
      ] : [];
      return send({
        status: 'OK',
        transfers: [...(state.deleted ? [] : [{
          id: 55,
          name: 'putio release.bin',
          status: ready ? 'COMPLETED' : 'DOWNLOADING',
          percent_done: ready ? 100 : 40,
          file_id: ready ? 1234 : null,
          size: state.payload.length,
        }]), ...extra],
      });
    }
    if (url.pathname === '/v2/transfers/57') {
      return send({ status: 'OK', transfer: { id: 57, name: 'clip.mp4', status: 'COMPLETED', percent_done: 100, file_id: 1235 } });
    }
    if (url.pathname === '/v2/files/1235') {
      return send({ status: 'OK', file: { id: 1235, name: 'clip.mp4', file_type: 'VIDEO', size: state.payload.length } });
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

/* A TorBox for the days it has trouble, scripted by the test as it goes: its torrents and its queue
 * are maps the test edits, `creates` is what the next createtorrent answers, and each of `outages`
 * is one failed call, answered to the first request whose path and query start with its `path` —
 * with the HTML page Cloudflare sends in front of a service that is down, not the API's JSON. */
function startScriptedTorbox() {
  const state = { key: 'scripted-key', torrents: new Map(), queue: new Map(), creates: [], created: 0, outages: [] };
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Cache-Control': 'no-store' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://torbox.test');
    if (req.method === 'OPTIONS') return res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }).end();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const json = (body, status = 200) => res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const outage = state.outages.findIndex((o) => `${url.pathname}${url.search}`.startsWith(o.path));
    if (outage >= 0) {
      const [{ status }] = state.outages.splice(outage, 1);
      return res.writeHead(status, { ...cors, 'Content-Type': 'text/html' }).end(`<html><body><h1>${status}</h1><p>cloudflare</p></body></html>`);
    }
    if ((req.headers.authorization || '') !== `Bearer ${state.key}`) return json({ success: false, detail: 'bad api key' }, 401);
    const id = Number(url.searchParams.get('id'));
    if (url.pathname === '/v1/api/user/me') return json({ success: true, data: { email: 'scripted@example.com' } });
    if (url.pathname === '/v1/api/torrents/createtorrent') {
      state.created += 1;
      return json({ success: true, data: state.creates.shift() });
    }
    if (url.pathname === '/v1/api/torrents/mylist') {
      if (!id) return json({ success: true, data: [...state.torrents.values()] });
      return state.torrents.has(id) ? json({ success: true, data: state.torrents.get(id) }) : json({ success: false, detail: 'Torrent not found.', data: null }, 404);
    }
    if (url.pathname === '/v1/api/queued/getqueued') {
      if (!id) return json({ success: true, data: [...state.queue.values()] });
      return state.queue.has(id) ? json({ success: true, data: [state.queue.get(id)] }) : json({ success: false, error: 'ITEM_NOT_FOUND', detail: 'Queued download not found.', data: null });
    }
    if (url.pathname === '/v1/api/torrents/controltorrent') {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (body.operation === 'delete') state.torrents.delete(body.torrent_id);
      return json({ success: true, detail: 'ok' });
    }
    json({ success: false, detail: 'not found' }, 404);
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
  // Beyond RD1, Real-Debrid holds a pack of twenty files, and whatever the test adds; it can refuse
  // the next few choices of files, a link once, and list more torrents than fit on one page.
  const pack = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, path: `/pack ${String(i + 1).padStart(2, '0')}.mkv`, bytes: 4096, selected: 1 }));
  const state = {
    key: 'debrid-key',
    rdSelected: false,
    adDeleted: false,
    rd: new Map([['RD3', { id: 'RD3', filename: 'rd pack', bytes: 20 * 4096, progress: 100, status: 'downloaded', files: pack, links: pack.map((f, i) => `https://real-debrid.example/restricted/pack${i}`) }]]),
    rdWaitingAdds: 0,
    rdSelectFails: 0,
    rdRefuseOnce: new Set(),
    rdUnrestrictTimes: [],
    rdMany: 0,
    adUnlockTimes: [],
  };
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
        // This one is held until its files are chosen, as RD holds every torrent it is given.
        if (state.rdMagnet.includes(RD_WAITING_HASH)) {
          state.rdWaitingAdds += 1;
          const id = `RDW${state.rdWaitingAdds}`;
          state.rd.set(id, { id, filename: 'rd waiting.mkv', bytes: 4096, progress: 0, status: 'waiting_files_selection', files: [{ id: 1, path: '/rd waiting.mkv', bytes: 4096, selected: 0 }], links: [] });
          return send({ id, uri: `/rest/1.0/torrents/info/${id}` }, 201);
        }
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
      const extra = state.rd.get(p.split('/').pop());
      if (extra && p.startsWith('torrents/selectFiles/')) {
        // RD allows 250 calls a minute, and answers the rest with 429.
        if (state.rdSelectFails > 0) {
          state.rdSelectFails -= 1;
          return send({ error: 'too_many_requests', error_code: 34 }, 429);
        }
        Object.assign(extra, {
          status: 'downloaded',
          progress: 100,
          files: extra.files.map((f) => ({ ...f, selected: 1 })),
          links: extra.files.map((f) => `https://real-debrid.example/restricted/${extra.id}-${f.id}`),
        });
        return send({}, 204);
      }
      if (extra && p.startsWith('torrents/info/')) return send(extra);
      if (p === 'torrents') {
        // A page at a time, as RD lists them: `limit` of them (at most 100, and 50 unless asked)
        // from `offset`, with the whole count in X-Total-Count.
        const rows = [
          { id: 'RD1', filename: 'rd release.mkv', bytes: 4096, progress: 100, status: 'downloaded' },
          ...[...state.rd.values()].map(({ files, links, ...row }) => row),
          ...Array.from({ length: state.rdMany }, (_, i) => ({ id: `OLD${i}`, filename: `old ${i}.mkv`, bytes: 4096, progress: 100, status: 'downloaded' })),
        ];
        state.rdTotal = rows.length;
        const limit = Math.min(100, Number(url.searchParams.get('limit')) || 50);
        const offset = Number(url.searchParams.get('offset')) || 0;
        return res.writeHead(200, { ...cors, 'X-Total-Count': String(rows.length) }).end(JSON.stringify(rows.slice(offset, offset + limit)));
      }
      if (p === 'unrestrict/link') {
        state.rdUnrestricted = body.toString();
        const now = Date.now();
        state.rdUnrestrictTimes.push(now);
        // Stricter than RD's 250 a minute, so that a burst shows within a test: five a second.
        if (state.rdUnrestrictTimes.filter((t) => now - t < 1000).length > 5) return send({ error: 'too_many_requests', error_code: 34 }, 429);
        if (state.rdRefuseOnce.delete(new URLSearchParams(body.toString()).get('link'))) return send({ error: 'hoster_unavailable', error_code: 19 }, 503);
        return send({ download: payloadUrl, filename: 'rd release.mkv', filesize: 4096 });
      }
      if (p === 'torrents/delete/RD1') {
        state.rdDeleted = req.method;
        return send({}, 204);
      }
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
        // What AllDebrid answers to a file upload: data.files, each naming the file it came
        // from — not data.magnets, which is the answer to a magnet.
        state.adUploaded = body;
        return send({ status: 'success', data: { files: [{ file: 'debrid.torrent', name: 'ad release', size: 4096, hash: 'a'.repeat(40), ready: false, id: 78 }] } });
      }
      if (url.pathname === '/v4.1/magnet/status') {
        const row = { id: 77, filename: 'ad release.mkv', size: 4096, downloaded: 4096, status: state.adDeleted ? 'Error' : 'Ready', statusCode: state.adDeleted ? 5 : 4 };
        // With an id it answers with one object; without, with the whole list.
        if (url.searchParams.get('id')) return send({ status: 'success', data: { magnets: row } });
        return send({ status: 'success', data: { magnets: state.adDeleted ? [] : [row] } });
      }
      if (url.pathname === '/v4/magnet/files') {
        // A season: more files than one burst of unlocks, all of which must be listed.
        const episodes = Array.from({ length: 60 }, (_, i) => ({ n: `ad release ${String(i + 1).padStart(2, '0')}.mkv`, s: 4096, l: `https://alldebrid.example/locked/xyz${i}` }));
        return send({ status: 'success', data: { magnets: [{ id: 77, files: [{ n: 'season', e: episodes }] }] } });
      }
      if (url.pathname === '/v4/link/unlock') {
        const now = Date.now();
        state.adUnlockTimes.push(now);
        // AllDebrid allows twelve calls a second, and answers the rest with 429.
        if (state.adUnlockTimes.filter((t) => now - t < 1000).length > 12) return send({ status: 'error', error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests' } }, 429);
        state.adUnlocks = (state.adUnlocks || 0) + 1;
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

const QUEUED_HASH = '5'.repeat(40);
const RD_WAITING_HASH = 'b'.repeat(40);

/* An HTTP mirror to use as a web seed: byte ranges, CORS for whatever headers WebTorrent sends, and
 * a delay per request, as a mirror far away has — slow enough that a pause lands mid-download. It
 * counts what each file was asked for. */
function startWebSeedMirror() {
  const state = { files: new Map(), asked: new Map() };
  const server = http.createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Range' };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    const file = decodeURIComponent(new URL(req.url, 'http://mirror.test').pathname);
    const body = state.files.get(file);
    if (!body) return res.writeHead(404, cors).end();
    state.asked.set(file, (state.asked.get(file) || 0) + 1);
    await new Promise((r) => setTimeout(r, 150));
    const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (!range) return res.writeHead(200, { ...cors, 'Content-Length': body.length }).end(body);
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), body.length - 1);
    res.writeHead(206, { ...cors, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 }).end(body.subarray(start, end + 1));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/* proxy/cloudflare-worker.js, served on localhost: the same code the user deploys, in front of
 * the stand-ins. Workers stream a request body without being asked; Node's fetch wants
 * duplex: 'half' said out loud, so the worker's upstream calls get it here. */
function startCorsProxy(env) {
  const state = { methods: [] };
  const nodeFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => nodeFetch(input, init.body && typeof init.body.getReader === 'function' ? { ...init, duplex: 'half' } : init);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    state.methods.push(req.method);
    const headers = {};
    for (const h of ['origin', 'authorization', 'content-type', 'range', 'accept', 'access-control-request-method']) {
      if (req.headers[h]) headers[h] = req.headers[h];
    }
    const request = new Request(`http://proxy.test${req.url}`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await proxyWorker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/* A STUN server on this machine, and the only one the pages are given. WebKit on Linux names its
 * host candidates with mDNS, and nothing on a CI runner resolves those names, so the one address
 * it could offer another page was what a public STUN server saw: the runner's public IP, looped
 * back through the cloud's NAT — measured at 25 seconds a connection when it worked at all, and
 * the reason the WebKit job failed about half the time. Asked here instead, STUN answers with the
 * machine's own address, which is never hidden behind mDNS, and the pages connect directly. */
function startStunServer() {
  const host = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address || '127.0.0.1';
  const socket = dgram.createSocket('udp4');
  const state = { answered: 0 };
  socket.on('message', (msg, from) => {
    // A Binding Request: type 0x0001, then the length, the magic cookie and a transaction id.
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001 || msg.readUInt32BE(4) !== 0x2112a442) return;
    const res = Buffer.alloc(32);
    res.writeUInt16BE(0x0101, 0); // Binding Success Response
    res.writeUInt16BE(12, 2); // one attribute: XOR-MAPPED-ADDRESS, 4 + 8 bytes
    msg.copy(res, 4, 4, 20); // same cookie, same transaction id
    res.writeUInt16BE(0x0020, 20);
    res.writeUInt16BE(8, 22);
    res.writeUInt16BE(0x0001, 24); // IPv4
    res.writeUInt16BE(from.port ^ 0x2112, 26);
    const ip = from.address.split('.').reduce((n, b) => n * 256 + Number(b), 0);
    res.writeUInt32BE((ip ^ 0x2112a442) >>> 0, 28);
    socket.send(res, from.port, from.address);
    state.answered += 1;
  });
  return new Promise((resolve) => socket.bind(0, host, () => resolve({ socket, state, url: `stun:${host}:${socket.address().port}` })));
}
const stun = await startStunServer();
const rtcConfig = { iceServers: [{ urls: stun.url }] };
log('STUN at', stun.url);

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

const site = await startServer(0);
log('site at', site.url);

const cloudApi = await startCloudApi();
const putioApi = await startPutioApi();
const debridApi = await startDebridApis(`${site.url}test/.tmp/debrid-payload.bin`);
const scriptedTorbox = await startScriptedTorbox();
log('cloud API stubs at', cloudApi.url, ',', putioApi.url, ',', debridApi.url, 'and', scriptedTorbox.url);
const corsProxy = await startCorsProxy({ ALLOWED_ORIGINS: new URL(site.url).origin, API_HOSTS: new URL(debridApi.url).host });
log('CORS proxy worker at', corsProxy.url);
const mirror = await startWebSeedMirror();
log('web seed mirror at', mirror.url);

// BROWSER=webkit runs the same suite on Safari's engine (what every browser on iOS uses).
const BROWSER = process.env.BROWSER || 'chromium';
const browser = BROWSER === 'webkit'
  ? await webkit.launch()
  : await chromium.launch({ executablePath: findChromium(), args: ['--allow-insecure-localhost'] });
log('browser:', BROWSER);

let failed = false;
try {
  /* ---------- npm start: this machine only, unless asked; and then the app, not the checkout ---------- */
  {
    const lanAddress = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
    const ask = (url) => fetch(url, { signal: AbortSignal.timeout(5000) });
    const alone = await startServer(0);
    if (lanAddress) await assert.rejects(ask(`http://${lanAddress}:${alone.port}/`), 'by default the dev server is not on the network');
    alone.server.close();
    const shared = await startServer(0, '0.0.0.0');
    const base = `http://${lanAddress || '127.0.0.1'}:${shared.port}/`;
    try {
      assert.equal((await ask(base)).status, 200, 'HOST=0.0.0.0 puts it on the network');
      assert.equal((await ask(`${base}app.js`)).status, 200);
      for (const inside of ['.git/HEAD', 'test/.tmp/', 'node_modules/playwright/package.json']) {
        assert.equal((await ask(`${base}${inside}`)).status, 404, `and serves the app, not /${inside}`);
      }
    } finally {
      shared.server.close();
    }
    log(`npm start: loopback unless HOST says otherwise, and then no dotfiles or node_modules${lanAddress ? ` (checked at ${lanAddress})` : ''}`);
  }

  /* ---------- the page on a small screen, in both colour schemes, and as the installed iPhone app ---------- */
  {
    const open = async (options, init) => {
      const ctx = await browser.newContext(options);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.error('layout page error:', e));
      await page.addInitScript(({ t, rtc }) => localStorage.setItem('phone-torrent:settings', JSON.stringify({ trackers: [t], trackerList: false, rtcConfig: rtc })), { t: trackerUrl, rtc: rtcConfig });
      if (init) await page.addInitScript(init);
      await page.goto(site.url);
      await page.waitForFunction(() => window.__phoneTorrent?.client);
      return { ctx, page };
    };

    // Text against what it is drawn on, by the WCAG formula, which asks 4.5:1 of text this size: an
    // error toast (nothing pasted, then Add), a primary button's label, and the muted colour of the
    // tabs not chosen and of the hints in the share, cloud and no-peers panels, on the page colour.
    for (const colorScheme of ['light', 'dark']) {
      const { ctx, page } = await open({ colorScheme, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await page.click('#magnet-form button[type="submit"]');
      await page.waitForSelector('.toast.error');
      const pairs = await page.evaluate(() => {
        const style = (selector) => getComputedStyle(document.querySelector(selector));
        return {
          'an error toast': [style('.toast.error').color, style('.toast.error').backgroundColor],
          'a primary button': [style('.add-row .btn.primary').color, style('.add-row .btn.primary').backgroundColor],
          'muted text on the page colour': [style('.tab:not(.active)').color, style('.tabs').backgroundColor],
        };
      });
      for (const [what, [text, background]] of Object.entries(pairs)) {
        const ratio = contrast(text, background);
        assert.ok(ratio >= 4.5, `${colorScheme}: ${what} is ${text} on ${background}, ${ratio.toFixed(2)}:1`);
      }
      await ctx.close();
    }
    log('error toasts, primary buttons and muted text read at 4.5:1 or more, light and dark');

    const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const within = () => page.evaluate(() => document.documentElement.clientWidth);

    // The top bar at its fullest — the widest speeds the pill shows, and Install, which Chrome offers
    // until the app is installed — at phone widths: the title gives way, and nothing is drawn over
    // anything else or pushed off the screen.
    for (const width of [320, 360, 375, 412]) {
      await page.setViewportSize({ width, height: 844 });
      for (const install of [false, true]) {
        const boxes = await page.evaluate((install) => {
          document.querySelector('#net-status').textContent = '↓ 1023 KB/s ↑ 1023 KB/s';
          document.querySelector('#install-btn').hidden = !install;
          return [...document.querySelectorAll('.brand > *, .topbar-right > :not([hidden])')].map((e) => {
            const { left, right } = e.getBoundingClientRect();
            return { what: e.id || e.localName, left, right };
          });
        }, install);
        const screen = await within();
        for (const [i, box] of boxes.entries()) {
          const before = boxes[i - 1];
          assert.ok(!before || box.left >= before.right, `${width}px${install ? ' with Install' : ''}: ${box.what} (from ${box.left}) is drawn over ${before?.what} (to ${before?.right})`);
          assert.ok(box.left >= 0 && box.right <= screen, `${width}px${install ? ' with Install' : ''}: ${box.what} is on the screen (${box.left}–${box.right} of ${screen})`);
        }
      }
    }
    await page.evaluate(() => { document.querySelector('#install-btn').hidden = true; });
    log('the top bar fits 320px with speeds and Install, the title giving way');

    // A seed opens on its share panel, whose links are text fields: their own width (twenty
    // characters, more at the 16px an iPhone gets) must not decide how narrow the card can be.
    await page.click('.tab[data-tab="seed"]');
    await page.setInputFiles('#seed-file-input', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(5000, 1) });
    await page.waitForSelector('.torrent .share-panel:not([hidden])', { timeout: 15000 });
    for (const [width, onIphone] of [[320, false], [320, true], [375, true]]) {
      const undo = onIphone ? await asOnIphone(page) : null;
      if (onIphone) assert.equal(await page.$eval('.torrent .share-magnet', (e) => getComputedStyle(e).fontSize), '16px', 'the links at 16px, as on an iPhone');
      await page.setViewportSize({ width, height: 844 });
      const fit = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        card: document.querySelector('.torrent').getBoundingClientRect().right,
        copy: document.querySelector('.torrent .share-copy-app').getBoundingClientRect().right,
      }));
      const where = `${width}px${onIphone ? ' as on an iPhone' : ''}`;
      assert.equal(fit.overflow, 0, `${where}: the open share panel scrolls the page sideways`);
      assert.ok(fit.copy <= fit.card && fit.card <= await within(), `${where}: the share panel's Copy (to ${fit.copy}) and its card (to ${fit.card}) fit the screen`);
      await undo?.();
    }
    await ctx.close();
    log('the share panel fits 320px, and 375px at an iPhone\'s 16px fields');

    // The installed app on an iPhone. Each save there waits for one more tap, on a bar that names the
    // file: a release name has nowhere to break, and must not push Cancel off the screen.
    const standalone = await open({ ...devices['iPhone 13'] }, () => {
      Object.defineProperty(navigator, 'standalone', { get: () => true });
      navigator.canShare = () => true;
      navigator.share = () => new Promise(() => {});
    });
    const iphone = standalone.page;
    for (const width of [320, 390]) {
      await iphone.setViewportSize({ width, height: 664 });
      await iphone.evaluate(() => {
        const item = { name: 'The.Show.S01E01.1080p.WEB.h264-GROUP.mkv', size: 3, stream: () => new Blob([new Uint8Array(3)]).stream() };
        window.__saved = window.__phoneTorrent.saver.save(item).then(() => 'saved', (err) => err.message);
      });
      await iphone.waitForSelector('.save-ready');
      const screen = await iphone.evaluate(() => document.documentElement.clientWidth);
      for (const button of await iphone.$$eval('.save-ready button', (els) => els.map((e) => ({ text: e.textContent, right: e.getBoundingClientRect().right })))) {
        assert.ok(button.right <= screen, `${width}px: "${button.text}" on the save bar ends at ${button.right}, off a ${screen}px screen`);
      }
      await iphone.click('.save-ready .ghost', { timeout: 5000 });
      assert.equal(await iphone.evaluate(() => window.__saved), 'Save cancelled', 'and Cancel cancels');
    }
    // Its status bar is drawn over the top of the page, and always in white: whatever is under the
    // clock and the battery has to be dark, in either colour scheme.
    assert.equal(await iphone.$eval('meta[name="apple-mobile-web-app-status-bar-style"]', (m) => m.content), 'black-translucent', 'the status bar the installed app gets is the white one, over the page');
    const undo = await asOnIphone(iphone, { statusBar: 47 });
    const screen = await iphone.evaluate(() => document.documentElement.clientWidth);
    for (const colorScheme of ['light', 'dark']) {
      await iphone.emulateMedia({ colorScheme });
      for (const x of [2, screen - 3]) {
        const under = await pixelAt(iphone, x, 20);
        const ratio = contrast('rgb(255, 255, 255)', under);
        assert.ok(ratio >= 4.5, `${colorScheme}: the white status bar is drawn on ${under} at x=${x}, ${ratio.toFixed(2)}:1`);
      }
    }
    await undo();
    await standalone.ctx.close();
    log('the installed iPhone app: Cancel on the save bar in reach, and its status bar legible, light and dark');
  }

  /* ---------- seeder ---------- */
  const seederCtx = await browser.newContext();
  const seeder = await seederCtx.newPage();
  seeder.on('pageerror', (e) => console.error('seeder page error:', e));
  // trackerList off, as for every page here: the suite's content is fixed, so is its info hash, and
  // on a public tracker it would meet every other run of this suite — the engine running beside it
  // included — and the crawlers that answer every offer, until WebRTC in WebKit gives out.
  await seeder.addInitScript(({ t, rtc }) => localStorage.setItem('phone-torrent:settings', JSON.stringify({ trackers: [t], trackerList: false, rtcConfig: rtc })), { t: trackerUrl, rtc: rtcConfig });
  await seeder.goto(site.url);
  await seeder.waitForFunction(() => window.__phoneTorrent?.client);

  const FILE_A = 3 * 1024 * 1024 + 123; // > one piece, uneven size
  // …and the torrent ends exactly on a piece boundary (16 KiB pieces), which WebTorrent's
  // File.downloaded counts one piece short: every wait for "100%" below also proves the card
  // does not stop at 99% on such a file.
  const FILE_B = 704 * 1024 - 123;
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

  // Seed through the real UI: "Seed & share" tab, pick files, name the collection. Cancel on the
  // name is a cancel: it used to seed all the same, named after the first file.
  await seeder.click('.tab[data-tab="seed"]');
  seeder.once('dialog', (d) => d.dismiss());
  await seeder.setInputFiles('#seed-file-input', files.map((f, i) => ({ name: f.name, mimeType: 'application/octet-stream', buffer: seedBuffers[i] })));
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(await seeder.evaluate(() => window.__phoneTorrent.client.torrents.length), 0, 'a cancelled name seeds nothing');
  assert.equal((await seeder.$$('.torrent')).length, 0);
  seeder.once('dialog', (d) => d.accept('Phone Torrent Test'));
  await seeder.setInputFiles('#seed-file-input', files.map((f, i) => ({ name: f.name, mimeType: 'application/octet-stream', buffer: seedBuffers[i] })));
  await seeder.waitForSelector('.torrent.seeding .file', { timeout: 30000 });
  await waitFor(() => seeder.evaluate(() => window.__phoneTorrent.client.torrents[0]?.ready), { label: 'seeder ready' });

  /**
   * Wait for something that first needs a fresh connection to the seeder, nudging the seeder to
   * re-announce along the way — reconnecting its tracker socket first if that dropped, since a
   * closed one would otherwise sit out a reconnect delay of up to five minutes. The condition is
   * unchanged; it just stops depending on that cadence.
   */
  const waitForFromSeeder = (fn, opts) => {
    let nudged = 0;
    return waitFor(async () => {
      if (Date.now() - nudged > 15000) {
        nudged = Date.now();
        await seeder.evaluate(() => {
          const t = window.__phoneTorrent.client.torrents[0];
          try { if (t) window.__phoneTorrent.askTrackersNow(t); } catch { /* page may be gone */ }
        }).catch(() => {});
      }
      return fn();
    }, opts);
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
  // A seed is there to be shared: once it is ready, its card shows the link, selected, not the details.
  await seeder.waitForSelector('.torrent .share-panel:not([hidden])', { timeout: 10000 });
  assert.ok(await seeder.evaluate(() => document.activeElement?.classList.contains('share-app-link')), 'the seed opens on its link, selected');
  assert.ok(await seeder.$eval('.torrent .details', (e) => e.hidden), 'and leaves the details closed');
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
  assert.equal(await seeder.evaluate(() => {
    const t = window.__phoneTorrent.client.torrents[0];
    return t.length % t.pieceLength;
  }), 0, 'the fixture ends on a piece boundary');
  if (opfs && await seeder.evaluate(() => Boolean(navigator.locks?.query))) {
    // A seed is never remembered, so to a second tab's housekeeping its files look orphaned: opening
    // the app again (a link from a chat, the home-screen icon) must not delete what this one shares.
    const secondTab = await seederCtx.newPage();
    secondTab.on('pageerror', (e) => console.error('second tab page error:', e));
    await secondTab.addInitScript(({ t, rtc }) => localStorage.setItem('phone-torrent:settings', JSON.stringify({ trackers: [t], trackerList: false, rtcConfig: rtc })), { t: trackerUrl, rtc: rtcConfig });
    await secondTab.goto(site.url);
    await secondTab.waitForFunction(() => window.__phoneTorrent?.client);
    // Both tabs hold the open-tab lock once the second one is past its housekeeping.
    await waitFor(() => secondTab.evaluate(async () => (await navigator.locks.query()).held
      .filter((l) => l.name === 'phone-torrent:open-tab').length === 2), { label: 'second tab past its housekeeping', timeout: 15000 });
    const storeDirs = await secondTab.evaluate(async () => {
      const names = [];
      for await (const name of (await navigator.storage.getDirectory()).keys()) names.push(name);
      return names;
    });
    const seedHash = await seeder.evaluate(() => window.__phoneTorrent.client.torrents[0].infoHash);
    assert.ok(storeDirs.some((n) => n.endsWith(` - ${seedHash.slice(0, 8)}`)), `a second tab leaves the seed's store alone (found: ${storeDirs.join(', ')})`);
    await secondTab.close();
  }
  log('seed store survives housekeeping, in this tab and from a second one');
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
  await phone.addInitScript(({ listUrl, metaUrl, rtc }) => {
    // The share-target step loads a plain form with setContent, on about:blank,
    // which has no storage to read; only the app's own pages need the settings.
    if (!location.protocol.startsWith('http')) return;
    let current = {};
    try { current = JSON.parse(localStorage.getItem('phone-torrent:settings') || '{}'); } catch { /* first load */ }
    localStorage.setItem('phone-torrent:settings', JSON.stringify({
      ...current,
      trackers: ['ws://127.0.0.1:2/dead'], trackerList: true, trackerListUrl: listUrl,
      metadataSources: ['https://127.0.0.1:1/never/{INFOHASH}.torrent', metaUrl], fallbackDelay: 5,
      dohResolver: `${new URL(listUrl).origin}/__doh`,
      rtcConfig: rtc,
    }));
  }, { listUrl, metaUrl: `${site.url}test/.tmp/{infohash}.torrent`, rtc: rtcConfig });
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

  // A network that answers nothing — a weak signal, a Wi-Fi that stalled — must not keep the
  // installed app on a blank page: after a few seconds the cached shell takes over. Here the server
  // accepts every connection and never replies.
  if (await phone.evaluate(() => Boolean(navigator.serviceWorker?.controller))) {
    const answering = site.server.listeners('request');
    const unanswered = [];
    site.server.removeAllListeners('request');
    site.server.on('request', (req, res) => { unanswered.push(res); });
    try {
      const stalled = await phoneCtx.newPage();
      const started = Date.now();
      stalled.goto(site.url, { timeout: 30000 }).catch(() => {});
      await stalled.waitForFunction(() => window.__phoneTorrent?.client, null, { timeout: 20000 });
      log(`stalled network: the app came up from the cache in ${Date.now() - started} ms`);
      await stalled.close();
    } finally {
      site.server.removeAllListeners('request');
      for (const fn of answering) site.server.on('request', fn);
      // The worker's own requests are still waiting on these, and would hold the browser's few
      // connections to this host for the rest of the suite: end them as a dropped network would.
      for (const res of unanswered) res.socket?.destroy();
    }
  } else {
    log('stalled network: skipped, the page is not controlled by the service worker in this engine');
  }

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

  // No sideways scrolling at any phone width: 320px is an iPhone SE, or any iPhone with Display Zoom,
  // and between 481px and ~530px the card's five buttons used to stay on one line.
  for (const width of [320, 500, 390]) {
    await phone.setViewportSize({ width, height: 844 });
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0, `no horizontal scroll at ${width}px`);
  }
  // The list is rewritten every 750 ms; as a live region, a screen reader would read out every tick.
  assert.equal(await phone.$eval('#torrents', (e) => e.getAttribute('aria-live')), null, 'the torrent list is not a live region');
  log('layout fits 320px and 500px; the list does not chatter to screen readers');

  try {
    await waitForFromSeeder(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { label: 'download to finish', timeout: 180000 });
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
  assert.ok(stun.state.answered > 0, 'the pages asked the STUN server on this machine');
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
  await waitForFromSeeder(() => phone.evaluate(() => window.__phoneTorrent.client.torrents[0].numPeers > 0), { label: 'peers reacquired after resume', timeout: 120000 });
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

  // A save lasts as long as the file takes to hand over — seconds to minutes on a phone — and the
  // list is redrawn every 750 ms meanwhile. Neither button may be offered again before its save is
  // over: a second tap was a second download (or, on iOS, a second copy in memory).
  await phone.evaluate(() => {
    const s = window.__phoneTorrent.saver;
    s.heldSaves = [];
    s.realSave = s.save;
    s.save = () => new Promise((resolve) => s.heldSaves.push(resolve));
  });
  const heldSaveBtn = phone.locator('.torrent .file .save-btn').nth(saveIndex);
  await heldSaveBtn.click();
  await phone.click('.torrent .zip-btn');
  await new Promise((r) => setTimeout(r, 1600)); // two redraws
  assert.deepEqual(await heldSaveBtn.evaluate((b) => [b.textContent, b.disabled]), ['Saving…', true], 'a save in progress keeps its button busy');
  assert.deepEqual(await phone.$eval('.torrent .zip-btn', (b) => [b.textContent, b.disabled]), ['Zipping…', true], 'and so does a zip');
  assert.equal(await phone.evaluate(() => window.__phoneTorrent.saver.heldSaves.length), 2, 'one save each');
  await phone.evaluate(() => {
    const s = window.__phoneTorrent.saver;
    s.save = s.realSave;
    for (const done of s.heldSaves) done();
  });
  await waitFor(() => heldSaveBtn.evaluate((b) => b.textContent === 'Save' && !b.disabled), { label: 'Save offered again once its save is over', timeout: 5000 });
  await waitFor(() => phone.$eval('.torrent .zip-btn', (b) => b.textContent === 'Save all as .zip' && !b.disabled), { label: 'the zip offered again once it is saved', timeout: 5000 });
  log('a save in progress keeps its button busy through the redraws');

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
  // Simple and Expert look like tabs but have no panel: switching them leaves the add card alone.
  assert.equal(await phone.$eval('#tab-download', (e) => e.hidden), false, 'the add card keeps its panel after a mode switch');
  assert.equal(await phone.$eval('.tabs .tab[data-tab="download"]', (e) => e.getAttribute('aria-selected')), 'true');

  // The choice is a setting: it survives a reload like the others.
  await phone.reload();
  await phone.waitForFunction(() => window.__phoneTorrent?.client);
  await phone.click('#settings-btn');
  await phone.waitForSelector('#settings-dialog[open]');
  assert.equal(await phone.isVisible('#trackers-input'), true, 'Expert is remembered');

  // A field that cannot be saved keeps the dialog open, says why, and keeps everything else typed.
  const rtcTyped = await phone.inputValue('#rtc-input');
  await phone.uncheck('#wakelock-toggle');
  await phone.fill('#rtc-input', '{"iceServers": [ { urls: "stun:typo" } ]}');
  await phone.click('#settings-dialog button[value="save"]');
  assert.equal(await phone.$eval('#settings-dialog', (e) => e.open), true, 'an invalid field keeps the dialog open');
  assert.match(await phone.$eval('#settings-error', (e) => (e.hidden ? '' : e.textContent)), /not valid JSON/, 'and says why');
  assert.equal(await phone.isChecked('#wakelock-toggle'), false, 'what else was changed is still there');
  await phone.fill('#rtc-input', rtcTyped);
  await phone.click('#settings-dialog button[value="save"]');
  await waitFor(() => phone.$eval('#settings-dialog', (e) => !e.open), { label: 'settings saved once the field is fixed', timeout: 5000 });
  // The dialog's 'close' event, where the settings are stored, is fired a task after it closes.
  await waitFor(() => phone.evaluate(() => JSON.parse(localStorage.getItem('phone-torrent:settings')).wakeLock === false), { label: 'the dialog to store what was saved', timeout: 5000 }).catch(() => {});
  assert.equal(await phone.evaluate(() => JSON.parse(localStorage.getItem('phone-torrent:settings')).wakeLock), false, 'and it is saved with the fix');
  await phone.click('#settings-btn');
  await phone.waitForSelector('#settings-dialog[open]');
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
  await waitForFromSeeder(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { label: 're-download after delete all', timeout: 180000 });
  await waitFor(() => phone.evaluate(() => window.__phoneTorrent.views.values().next().value.record?.infoHash), { label: 'record persisted after delete all' });
  await phone.reload();
  await phone.waitForSelector('.torrent .file', { timeout: 15000 });
  await waitForFromSeeder(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { label: 'restore after delete-all cycle', timeout: 180000 });
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
  await waitForFromSeeder(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { label: 'shared torrent download', timeout: 180000 });
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
  // The name is percent-encoded inside the magnet, "&" included: it must survive as one name.
  await phone.goto(`${site.url}#magnet:?xt=urn:btih:${'1'.repeat(40)}&dn=${encodeURIComponent('Tom & Jerry')}`);
  await waitFor(() => phone.$$('.torrent').then((l) => l.length === 3), { label: 'magnet from fragment to be added (pending magnets survive reload)' });
  assert.equal(new URL(phone.url()).hash, '', 'fragment is cleaned up');
  const cardNames = () => phone.$$eval('.torrent .name', (els) => els.map((e) => e.textContent));
  // While the metadata is still to come, the card is called by the magnet's display name.
  await waitFor(() => cardNames().then((n) => n.includes('Tom & Jerry')), { label: 'a pending magnet titled by its dn', timeout: 5000 });
  await phone.evaluate((h) => { location.hash = h; }, `#magnet:?xt=urn:btih:${'2'.repeat(40)}&dn=hashchange`);
  await waitFor(() => phone.$$('.torrent').then((l) => l.length === 4), { label: 'magnet from hashchange to be added' });
  // The app link that Share hands out, pasted into the app itself — how it gets from Safari into the
  // installed app on an iPhone — is a magnet, not a .torrent address to fetch.
  await phone.fill('#magnet-input', `${site.url}#magnet:?xt=urn:btih:${'3'.repeat(40)}&dn=pasted%20app%20link`);
  await phone.click('#magnet-form button[type="submit"]');
  await waitFor(() => phone.$$('.torrent').then((l) => l.length === 5), { label: 'pasted app link to be added' });
  await waitFor(() => cardNames().then((n) => n.includes('pasted app link')), { label: 'the pasted app link titled by its dn', timeout: 5000 });
  log('magnet from URL, fragment and pasted app link OK');

  /* ---------- sharing a .torrent link, an info hash, or nothing to add ---------- */
  // Android shares a link as a title and a url. Only magnets were kept from what came as text, and
  // for anything else the app opened on nothing, without a word.
  const shareFields = async (fields) => {
    const inputs = Object.entries(fields).map(([k, v]) => `<input name="${k}" value="${v}">`).join('');
    await phone.setContent(`<form id="f" method="POST" enctype="multipart/form-data" action="${site.url}share">${inputs}</form>`);
    await Promise.all([phone.waitForNavigation(), phone.evaluate(() => document.getElementById('f').submit())]);
    await phone.waitForFunction(() => window.__phoneTorrent?.client);
  };
  writeFileSync(path.join(TMP, 'shared-link.torrent'), makeTorrent(rnd(20000, 81), { name: 'shared link.bin', trackers: [trackerUrl] }).buf);
  const dialogsBeforeLink = dialogs;
  await shareFields({ title: 'Download shared link', url: `${site.url}test/.tmp/shared-link.torrent`, text: '' });
  await waitFor(() => cardNames().then((n) => n.includes('shared link.bin')), { label: 'a shared .torrent link fetched and added', timeout: 15000 });
  assert.ok(dialogs > dialogsBeforeLink, 'a shared link asked for confirmation first');
  // "abcdefghijklmnopqrst" in base32: an info hash as some apps write it.
  await shareFields({ text: 'mfrggzdfmztwq2lknnwg23tpobyxe43u' });
  await waitFor(() => cardNames().then((n) => n.includes(Buffer.from('abcdefghijklmnopqrst').toString('hex'))), { label: 'a shared base32 info hash added', timeout: 15000 });
  await shareFields({ title: 'A page', text: 'Have a look at this, it is great' });
  await waitFor(() => phone.$$eval('.toast', (els) => els.some((e) => /Nothing to add in what was shared/.test(e.textContent))), { label: 'a share with nothing to add says so', timeout: 10000 });
  log('share target: a .torrent link and an info hash added, and a share with nothing in it explained');

  // A magnet WebTorrent would refuse says what is wrong with it, not "Invalid torrent identifier",
  // and stays in the box to be fixed: a link cut short in a chat, one with no info hash, a v2-only one.
  for (const [text, reason] of [
    ['magnet:?xt=urn:btih:123', /3 characters long/],
    ['magnet:?dn=foo', /no info hash/],
    [`magnet:?xt=urn:btmh:1220${'ab'.repeat(32)}&dn=v2only`, /v2 info hash/],
  ]) {
    await phone.fill('#magnet-input', text);
    await phone.click('#magnet-form button[type="submit"]');
    await waitFor(() => phone.$$eval('.toast', (els, src) => els.some((e) => new RegExp(src).test(e.textContent)), reason.source), { label: `"${text}" explained`, timeout: 5000 });
    assert.equal(await phone.inputValue('#magnet-input'), text, 'and it is still there to fix');
  }
  assert.equal(await phone.$$eval('.toast', (els) => els.some((e) => /Invalid torrent identifier/.test(e.textContent))), false, 'no jargon');
  // A phone keyboard's capital M is no reason to refuse one.
  await phone.fill('#magnet-input', `Magnet:?xt=urn:btih:${'4'.repeat(40)}&dn=capital`);
  await phone.click('#magnet-form button[type="submit"]');
  await waitFor(() => cardNames().then((n) => n.includes('capital')), { label: 'a magnet typed with a capital M', timeout: 5000 });
  assert.equal(await phone.inputValue('#magnet-input'), '', 'an added magnet leaves the box');
  log('a magnet that cannot be added says why, and stays to be fixed; a capital M is fine');

  /* ---------- magnet-sourced torrent: restored from stored metadata, retry keeps it ---------- */
  for (const t of await phone.$$('.torrent .remove-btn')) await t.click();
  await waitFor(() => phone.$$('.torrent').then((l) => l.length === 0), { label: 'clean slate for magnet test' });
  const mainHash = await seeder.evaluate(() => window.__phoneTorrent.client.torrents[0].infoHash);
  await phone.fill('#magnet-input', `magnet:?xt=urn:btih:${mainHash}`);
  await phone.click('#magnet-form button[type="submit"]');
  // A magnet has no metadata of its own: it comes from the seeder, so this waits like a download.
  try {
    await waitForFromSeeder(() => phone.$('.torrent .file').then(Boolean), { label: 'magnet metadata from the seeder', timeout: 180000 });
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
  await waitForFromSeeder(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { label: 'magnet download', timeout: 180000 });
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
  await orphanPage.addInitScript(({ t, rtc }) => localStorage.setItem('phone-torrent:settings', JSON.stringify({ trackers: [t], trackerList: false, rtcConfig: rtc })), { t: trackerUrl, rtc: rtcConfig });
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

  // Paused as soon as it is added, a magnet stays paused when a torrent cache hands over its metadata
  // and when it is retried: both swap the torrent for a fresh one, which used to start it again.
  for (const t of await phone.$$('.torrent .remove-btn')) await t.click();
  await waitFor(() => phone.$$('.torrent').then((l) => l.length === 0), { label: 'clean slate for the paused magnet' });
  await phone.fill('#magnet-input', orphan.infoHash);
  await phone.click('#magnet-form button[type="submit"]');
  await phone.waitForSelector('.torrent', { timeout: 10000 });
  await phone.click('.torrent .pause-btn');
  await waitFor(() => phone.$eval('.torrent .name', (e) => e.textContent === 'Fallback Test').catch(() => false), { label: 'metadata via fallback source, while paused', timeout: 30000 });
  const pausedSwap = await phone.evaluate(async () => {
    const view = window.__phoneTorrent.views.values().next().value;
    await view.persisted;
    return { paused: view.torrent.paused, state: view.el.querySelector('.state').textContent, remembered: view.record.paused };
  });
  assert.deepEqual(pausedSwap, { paused: true, state: 'paused', remembered: true }, 'a paused magnet stays paused when a cache hands over its metadata');
  // A retry waits for the check of the pieces already here, which a paused torrent runs too.
  await waitFor(() => phone.evaluate(() => window.__phoneTorrent.client.torrents[0].ready), { label: 'the swapped-in torrent checked', timeout: 10000 });
  await phone.click('.torrent .details-btn');
  await phone.click('.torrent .retry-btn');
  await waitFor(() => phone.$$eval('.torrent .log li', (els) => els.some((e) => /re-announced/.test(e.textContent))), { label: 'retry of a paused torrent', timeout: 15000 });
  assert.equal(await phone.evaluate(() => window.__phoneTorrent.client.torrents[0].paused), true, 'and a retry keeps it paused');
  log('a paused magnet stays paused through a metadata fallback and a retry');

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
  await ios.addInitScript(({ t, rtc }) => {
    let current = {};
    try { current = JSON.parse(localStorage.getItem('phone-torrent:settings') || '{}'); } catch { /* first load */ }
    localStorage.setItem('phone-torrent:settings', JSON.stringify({ ...current, trackers: [t], trackerList: false, rtcConfig: rtc }));
  }, { t: trackerUrl, rtc: rtcConfig });
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
  await waitForFromSeeder(() => ios.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { label: 'iOS download', timeout: 180000 });
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
  // A video from the photo library is as easy to pick. Read whole before being refused, 1.5 GB took
  // 13 s and as much memory, which an iPhone does not survive; now its first byte says enough. The
  // file is sparse, so it costs no disk.
  const bigVideo = path.join(TMP, 'IMG_0002.MOV');
  writeFileSync(bigVideo, '');
  truncateSync(bigVideo, 3 * 1024 ** 3);
  const bigPicked = Date.now();
  await ios.setInputFiles('#torrent-file-input', bigVideo);
  await waitFor(() => ios.$$eval('.toast', (els) => els.some((e) => /"IMG_0002\.MOV" is not a \.torrent file/.test(e.textContent))), { label: 'a 3 GB non-torrent refused without reading it', timeout: 5000 });
  log(`non-torrent file refused with an explanation; a 3 GB one in ${Date.now() - bigPicked} ms`);
  rmSync(bigVideo, { force: true });

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
  assert.equal(await ios.inputValue('#magnet-input'), 'https://torrent.invalid/nope.torrent', 'and the address stays in the box, to be fixed');
  await ios.fill('#magnet-input', '');
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
  await ios.click('#settings-dialog button[value="save"]');
  await ios.waitForSelector('#settings-dialog[open]', { state: 'detached', timeout: 5000 }).catch(() => {});
  await savedService(ios, 'torbox');
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
  await ios.click('#settings-dialog button[value="save"]');
  await ios.waitForSelector('#settings-dialog[open]', { state: 'detached', timeout: 5000 }).catch(() => {});
  await savedService(ios, 'putio');

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

  // And across a reload, which is where it used to be lost: only the id was stored, so the
  // TorBox transfer came back polling put.io — with put.io's key.
  await ios.reload();
  await ios.waitForFunction(() => window.__phoneTorrent?.client);
  const torboxAgain = ios.locator('.torrent', { has: ios.locator('.name', { hasText: 'private release.bin' }) }).first();
  const putioAgain = ios.locator('.torrent', { has: ios.locator('.name', { hasText: 'putio release.bin' }) }).first();
  await waitFor(() => torboxAgain.locator('.cloud-state').textContent().then((t) => /Ready on TorBox/.test(t)).catch(() => false), { label: 'TorBox transfer restored on TorBox after a switch and a reload', timeout: 30000 });
  await waitFor(() => putioAgain.locator('.cloud-state').textContent().then((t) => /Ready on put\.io/.test(t)).catch(() => false), { label: 'put.io transfer restored on put.io', timeout: 30000 });
  const torboxHref = await torboxAgain.locator('.cloud-files a').first().getAttribute('href');
  assert.ok(torboxHref.startsWith(`${cloudApi.url}/v1/api/torrents/requestdl`), 'the restored TorBox link points at TorBox');
  assert.equal(new URL(torboxHref).searchParams.get('token'), 'test-api-key', "and carries TorBox's key, not put.io's");
  log('per-transfer service kept across a provider switch and a reload, key included');

  // TorBox with every slot taken queues the torrent: a queued id, found in /queued, which
  // becomes an ordinary torrent id once it starts. Neither step may read as a lost transfer.
  cloudApi.state.queueNext = true;
  const queued = await ios.evaluate(async (base) => {
    const ctx = window.__phoneTorrent.cloudCtx({ provider: 'torbox', base, key: 'test-api-key' });
    const id = await ctx.api.submit(ctx, { magnet: `magnet:?xt=urn:btih:${'5'.repeat(40)}` });
    const waiting = await ctx.api.status(ctx, id);
    const listed = (await ctx.api.list(ctx)).find((t) => t.id === id);
    await ctx.api.remove(ctx, id);
    return { id, waiting, listed };
  }, cloudApi.url);
  assert.match(String(queued.id), /^queued:5:/, 'a queued submit is remembered as queued');
  assert.equal(queued.waiting.state, 'queued', 'and reads as queued, not as gone');
  assert.equal(queued.waiting.ready, false);
  assert.ok(queued.listed && queued.listed.state === 'queued', 'the library lists the queued torrent');
  assert.deepEqual(cloudApi.state.queueControlled, { queued_id: 5, operation: 'delete', type: 'torrent' }, 'deleting it goes to the queue');
  cloudApi.state.queued = false;
  cloudApi.state.started = true;
  const started = await ios.evaluate(async ({ base, id }) => {
    const ctx = window.__phoneTorrent.cloudCtx({ provider: 'torbox', base, key: 'test-api-key' });
    return ctx.api.status(ctx, id);
  }, { base: cloudApi.url, id: queued.id });
  assert.equal(started.id, 78, 'once started, the transfer carries the torrent id TorBox gave it');
  assert.equal(started.ready, true);
  cloudApi.state.started = false;
  log('TorBox queue: queued, listed, deleted, and followed once it starts');

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
  // Link shows the address itself, in a text field, which has to fit its card on an iPhone SE too.
  const undoIphone = await asOnIphone(ios);
  await ios.setViewportSize({ width: 320, height: iphone.viewport.height });
  await ios.click('.cloud-copy');
  await ios.waitForSelector('.cloud-link-field:not([hidden])');
  const linkFit = await ios.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    field: document.querySelector('.cloud-link-field').getBoundingClientRect().right,
    item: document.querySelector('.cloud-item').getBoundingClientRect().right,
  }));
  assert.equal(linkFit.overflow, 0, 'the library\'s link field does not scroll the page sideways at 320px');
  assert.ok(linkFit.field <= linkFit.item, `and stays inside its entry (to ${linkFit.field}, the entry to ${linkFit.item})`);
  await ios.click('.cloud-copy');
  await ios.setViewportSize(iphone.viewport);
  await undoIphone();

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

  // A video playing in the library survives the polls that run while something else is still
  // downloading: rows are updated, not rebuilt.
  putioApi.state.extra = true;
  await ios.click('#cloud-refresh-btn');
  const clipRow = ios.locator('.cloud-item', { has: ios.locator('.cloud-item-name', { hasText: 'clip.mp4' }) });
  await clipRow.waitFor({ timeout: 15000 });
  await clipRow.locator('.cloud-item-files-btn').click();
  await clipRow.locator('.cloud-play').click();
  await ios.evaluate(() => { document.querySelector('.cloud-player video').dataset.mark = 'the same one'; });
  const listCalls = putioApi.state.listCalls;
  await waitFor(() => putioApi.state.listCalls >= listCalls + 2, { label: 'two library polls', timeout: 20000 });
  assert.equal(await ios.evaluate(() => document.querySelector('.cloud-player video')?.dataset.mark), 'the same one', 'the player is still there, untouched');
  assert.equal(await clipRow.locator('.cloud-item-files').isHidden(), false, 'and its file list is still open');
  // A transfer that failed is not downloading: the library stops asking about it.
  putioApi.state.extraFailed = true;
  await waitFor(() => ios.$$eval('.cloud-item-meta', (els) => els.some((e) => /failed: error/.test(e.textContent))), { label: 'failed transfer shown', timeout: 20000 });
  const settledCalls = putioApi.state.listCalls;
  await new Promise((r) => setTimeout(r, 12000));
  assert.equal(putioApi.state.listCalls, settledCalls, 'no polling once the only unfinished transfer has failed');
  putioApi.state.extra = false;
  log('library: a playing video survives the polls, and a failed transfer stops them');

  // An iPhone has no Escape key and no back button, so the dialog has a Cancel of its own — which
  // also gets out of a field that cannot be saved, where Save only says why it will not close.
  const rtcStored = () => ios.evaluate(() => JSON.parse(localStorage.getItem('phone-torrent:settings')).rtcConfig);
  const rtcBefore = await rtcStored();
  await ios.click('#settings-btn');
  await ios.waitForSelector('#settings-dialog[open]');
  await ios.click('#mode-expert');
  await ios.fill('#rtc-input', '{bad');
  await ios.click('#settings-dialog button[value="save"]');
  assert.equal(await ios.$eval('#settings-dialog', (e) => e.open), true, 'Save refuses the bad field and stays open');
  await ios.click('#settings-dialog button[value="cancel"]');
  await waitFor(() => ios.$eval('#settings-dialog', (e) => !e.open), { label: 'Cancel to close the dialog, bad field and all', timeout: 5000 });
  assert.deepEqual(await rtcStored(), rtcBefore, 'and nothing of it is kept');
  log('settings: Cancel, with no keyboard, gets out even past a field that cannot be saved');

  // "Test the key" tries what is typed, and Cancel leaves everything as it was. And in Simple
  // mode, where a hosted service's address is hidden, switching away from your server must not
  // carry the server's address along to where the service's key is sent.
  await ios.click('#settings-btn');
  await ios.waitForSelector('#settings-dialog[open]');
  await ios.click('#mode-simple');
  await ios.selectOption('#cloud-provider', 'server');
  await ios.fill('#cloud-base', 'https://home.example');
  await ios.selectOption('#cloud-provider', 'torbox');
  assert.equal(await ios.isVisible('#cloud-base'), false, 'a hosted service hides its address in Simple mode');
  assert.equal(await ios.inputValue('#cloud-base'), cloudApi.url, "TorBox shows its own address, not the server's");
  assert.equal(await ios.inputValue('#cloud-key'), 'test-api-key', 'and its own key');
  await ios.fill('#cloud-key', 'typed-but-not-saved');
  await ios.click('#cloud-test-btn');
  await waitFor(() => ios.$eval('#cloud-info', (e) => /^Key /.test(e.textContent)), { label: 'test answered', timeout: 15000 });
  await ios.click('#settings-dialog button[value="cancel"]');
  await ios.waitForSelector('#settings-dialog[open]', { state: 'detached', timeout: 5000 }).catch(() => {});
  const after = await ios.evaluate(() => {
    const ctx = window.__phoneTorrent.cloudCtx();
    return { provider: ctx.provider, key: ctx.key, base: ctx.base };
  });
  assert.deepEqual(after, { provider: 'putio', key: 'putio-token', base: putioApi.url }, 'a tested, cancelled key changes nothing');
  log('settings: Test changes nothing until Save; each service keeps its own address and key');

  /* ---------- Real-Debrid and AllDebrid: the same table, two other dialects ---------- */
  // Driven through the app's own provider functions rather than the UI, which
  // put.io and TorBox already cover: what is under test here is the mapping.
  const debridPayload = rnd(4096, 51);
  writeFileSync(path.join(TMP, 'debrid-payload.bin'), debridPayload);

  const debridTorrent = privateTorrent(debridPayload, 'debrid.bin').toString('base64');
  // Real-Debrid goes through the CORS proxy worker, which is where its PUT (add a .torrent) and
  // DELETE were refused; AllDebrid goes straight to its API.
  for (const [provider, label, account, viaProxy, fileCount] of [['realdebrid', 'Real-Debrid', 'rd-user', true, 1], ['alldebrid', 'AllDebrid', 'ad-user', false, 60]]) {
    // Point the app at the stand-in through its own settings dialog, which is
    // also the only place the new services have to appear.
    await ios.click('#settings-btn');
    await ios.waitForSelector('#settings-dialog[open]');
  await ios.click('#mode-expert'); // a custom base URL for a hosted service lives in Expert
    await ios.selectOption('#cloud-provider', provider);
    await ios.fill('#cloud-key', 'debrid-key');
    await ios.fill('#cloud-base', debridApi.url);
    await ios.fill('#corsproxy-input', `${corsProxy.url}/?url={url}`);
    await ios.setChecked('#cloud-proxy-toggle', viaProxy);
    await ios.click('#cloud-test-btn');
    await waitFor(() => ios.$eval('#cloud-info', (e) => /Key accepted/.test(e.textContent)), { label: `${label} key accepted`, timeout: 15000 });
    await ios.click('#settings-dialog button[value="save"]');
    await ios.waitForSelector('#settings-dialog[open]', { state: 'detached', timeout: 5000 }).catch(() => {});
    await savedService(ios, provider);

    const proxyCalls = corsProxy.state.methods.length;
    const result = await ios.evaluate(async (torrentB64) => {
      const ctx = window.__phoneTorrent.cloudCtx();
      const who = await ctx.api.check(ctx);
      const bytes = Uint8Array.from(atob(torrentB64), (c) => c.charCodeAt(0));
      const fromFile = await ctx.api.submit(ctx, { bytes, name: 'debrid' });
      const id = await ctx.api.submit(ctx, { magnet: 'magnet:?xt=urn:btih:' + '4'.repeat(40) });
      const status = await ctx.api.status(ctx, id);
      const listed = await ctx.api.list(ctx);
      const link = ctx.api.fileLink(ctx, id, status.files[0]);
      const { detail } = await ctx.api.account(ctx);
      await ctx.api.remove(ctx, id, status);
      return { who, id, fromFile, status, listed: listed.length, link, detail };
    }, debridTorrent);

    assert.equal(result.who, account, `${label} says who the key belongs to`);
    assert.ok(result.id, `${label} returned a transfer id`);
    assert.ok(result.fromFile, `${label} returned a transfer id for a .torrent file`);
    assert.equal(result.status.ready, true, `${label} reports a finished transfer`);
    assert.equal(result.status.files.length, fileCount, `${label} lists every file`);
    assert.equal(result.status.files[0].size, 4096);
    assert.equal(result.link, `${site.url}test/.tmp/debrid-payload.bin`, `${label} hands back a link that needs no key`);
    assert.ok(result.listed >= 1, `${label} lists the account's transfers`);
    const methods = corsProxy.state.methods.slice(proxyCalls);
    if (viaProxy) {
      assert.ok(methods.includes('PUT') && methods.includes('DELETE'), `${label}'s PUT and DELETE went through the proxy (${methods.join(' ')})`);
    }
    log(`${label} OK: ${result.who} · ${result.detail} · ${result.status.files[0].name} · ${result.status.files.length} file(s)${viaProxy ? ' · via the CORS proxy' : ''}`);
  }
  assert.ok(debridApi.state.rdBytes && debridApi.state.rdBytes.includes('debrid.bin'), 'the .torrent reached Real-Debrid through the proxy');
  assert.equal(debridApi.state.rdDeleted, 'DELETE', 'and so did the delete');
  assert.ok(debridApi.state.adUploaded && debridApi.state.adUploaded.includes('debrid.bin'), 'the .torrent reached AllDebrid');
  assert.equal(debridApi.state.adUnlocks, 60, 'every AllDebrid file was unlocked, not the first fifty');
  assert.ok(burst(debridApi.state.adUnlockTimes) <= 12, `and never faster than the twelve a second AllDebrid allows (${burst(debridApi.state.adUnlockTimes)} in one second)`);
  // Served by your own server, the address to call is the one you are already on:
  // `docker compose up`, open it, and there is nothing to type in settings. Compared
  // against the address the test itself served from, so the page cannot agree with itself.
  const serverFallback = await ios.evaluate(() => {
    const api = window.__phoneTorrent.CLOUD_PROVIDERS.server;
    return typeof api.defaultBase === 'function' ? api.defaultBase() : api.defaultBase;
  });
  assert.equal(serverFallback, new URL(site.url).origin, 'with no address of its own, the server provider means this page — which is where a server that serves the app is');
  log('a server with no address means this page itself:', serverFallback);

  // A server that signs its links hands one per file, used as it is: no token added to it.
  const serverLinks = await ios.evaluate(() => {
    const ctx = window.__phoneTorrent.cloudCtx({ provider: 'server', base: 'https://box.example', key: 'secret' });
    return [
      ctx.api.fileLink(ctx, 'ab', { id: 0, link: '/api/transfers/ab/files/0?expires=1&sig=x' }),
      ctx.api.fileLink(ctx, 'ab', { id: 0 }),
    ];
  });
  assert.equal(serverLinks[0], 'https://box.example/api/transfers/ab/files/0?expires=1&sig=x', 'the signed link is the link');
  assert.match(serverLinks[1], /token=secret/, 'a server from before signed links still gets the token');
  log('server file links: the signed one as it is, the token only for an older server');


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

  /* ---------- cloud fetch on a bad day: a call that fails, a transfer that dies, a service switched ---------- */
  const tb = scriptedTorbox.state;
  const tbTorrent = (id, name, { state = 'downloading', progress = 0.2, hash = '', files = [] } = {}) => {
    const ready = state === 'completed';
    return { id, hash, name, size: 1000, progress: ready ? 1 : progress, download_state: state, download_present: ready, download_finished: ready, files };
  };
  const troubleCtx = await browser.newContext();
  const trouble = await troubleCtx.newPage();
  trouble.on('pageerror', (e) => console.error('trouble page error:', e));
  trouble.on('dialog', (d) => d.accept());
  await trouble.addInitScript(({ t, rtc, base, key, putio }) => localStorage.setItem('phone-torrent:settings', JSON.stringify({
    trackers: [t], trackerList: false, rtcConfig: rtc, metadataSources: [],
    cloud: { provider: 'torbox', apiKey: key, apiBase: base, viaProxy: false, accounts: { putio: { apiKey: 'putio-token', apiBase: putio } } },
  })), { t: trackerUrl, rtc: rtcConfig, base: scriptedTorbox.url, key: tb.key, putio: putioApi.url });
  await trouble.goto(site.url);
  await trouble.waitForFunction(() => window.__phoneTorrent?.client);
  const troubleCard = (name) => trouble.locator('.torrent', { has: trouble.locator('.name', { hasText: name }) }).first();
  const sendPrivate = async (name) => {
    await trouble.setInputFiles('#torrent-file-input', { name: `${name}.torrent`, mimeType: 'application/x-bittorrent', buffer: privateTorrent(Buffer.from(`the bytes of ${name}`), name) });
    await troubleCard(name).locator('.nopeers-cloud-btn').click({ timeout: 15000 });
  };
  // Every line a card's cloud state has shown, as read while the test waits on it.
  const cloudLines = new Map();
  const cloudLine = (name, re) => troubleCard(name).locator('.cloud-state').textContent().then((text) => {
    cloudLines.set(name, (cloudLines.get(name) || new Set()).add(text));
    return re.test(text);
  }).catch(() => false);
  const oneFile = (name) => [{ id: 0, short_name: name, size: 1000 }];

  // put.io takes a .torrent on upload.put.io. Any other address — a stand-in, a clone, one that
  // happens to start with "api." too — gets it itself, with the token: never a host nobody typed.
  const uploadedTo = await trouble.evaluate(async () => {
    const urls = [];
    for (const base of ['https://api.put.io', 'https://api.example.test']) {
      const ctx = { ...window.__phoneTorrent.cloudCtx({ provider: 'putio', base, key: 'k' }), json: async (url) => { urls.push(url); return { transfer: { id: 1 } }; } };
      await ctx.api.submit(ctx, { bytes: new Uint8Array([1]), name: 'x' });
    }
    return urls;
  });
  assert.deepEqual(uploadedTo, ['https://upload.put.io/v2/files/upload', 'https://api.example.test/v2/files/upload'], 'a .torrent goes to put.io\'s upload host, or to the address typed');
  log('put.io uploads: upload.put.io for put.io, the typed address for anything else');

  // One 503 in the middle of a transfer, Cloudflare's page rather than the API's JSON: the card says
  // the service is down for now and keeps asking, and gets to the finished file with no reload.
  tb.creates.push({ torrent_id: 90, hash: 'b1'.repeat(20) });
  tb.torrents.set(90, tbTorrent(90, 'blip.bin'));
  await sendPrivate('blip.bin');
  await waitFor(() => cloudLine('blip.bin', /TorBox: downloading 20%/), { label: 'a transfer under way', timeout: 15000 });
  tb.outages.push({ path: '/v1/api/torrents/mylist?id=90', status: 503 });
  await waitFor(() => cloudLine('blip.bin', /trying again/), { label: 'a failed poll that will be tried again', timeout: 15000 });
  tb.torrents.set(90, tbTorrent(90, 'blip.bin', { state: 'completed', files: oneFile('blip.bin') }));
  await waitFor(() => cloudLine('blip.bin', /Ready on TorBox/), { label: 'ready after a failed poll, with no reload', timeout: 30000 });
  const blipLines = [...cloudLines.get('blip.bin')];
  assert.ok(blipLines.some((t) => /busy or down \(HTTP 503\)/.test(t)), `a 503 page reads as the service being down (${blipLines.join(' | ')})`);
  assert.ok(!blipLines.some((t) => /check the address/.test(t)), 'not as a wrong address');

  // A queued transfer whose look at the queue fails once is still queued, not lost.
  const waitsHash = 'a1'.repeat(20);
  tb.creates.push({ queued_id: 91, hash: waitsHash });
  tb.queue.set(91, { id: 91, name: 'waits.bin', hash: waitsHash });
  await sendPrivate('waits.bin');
  await waitFor(() => cloudLine('waits.bin', /TorBox: queued/), { label: 'a queued transfer', timeout: 15000 });
  tb.outages.push({ path: '/v1/api/queued/getqueued?id=91', status: 502 });
  await waitFor(() => cloudLine('waits.bin', /trying again/), { label: 'a failed look at the queue, to be tried again', timeout: 15000 });
  tb.queue.delete(91);
  tb.torrents.set(92, tbTorrent(92, 'waits.bin', { state: 'completed', hash: waitsHash, files: oneFile('waits.bin') }));
  await waitFor(() => cloudLine('waits.bin', /Ready on TorBox/), { label: 'the queued transfer started and finished', timeout: 30000 });
  assert.ok(![...cloudLines.get('waits.bin')].some((t) => /no longer knows/.test(t)), 'a failed look at the queue is not the transfer having left it');
  log('cloud: a failed poll is asked again, on a card and in the queue, and a 503 page reads as a service that is down');

  // A transfer that failed in the cloud is sent again from the card that says so.
  tb.creates.push({ torrent_id: 93 });
  tb.torrents.set(93, tbTorrent(93, 'first doomed try', { state: 'error' }));
  await sendPrivate('doomed.bin');
  await waitFor(() => cloudLine('doomed.bin', /TorBox: failed \(error\)/), { label: 'a failed transfer', timeout: 15000 });
  const sendAgain = troubleCard('doomed.bin').locator('.cloud-again-btn');
  await sendAgain.waitFor({ timeout: 5000 });
  const createdBefore = tb.created;
  tb.creates.push({ torrent_id: 94 });
  tb.torrents.set(94, tbTorrent(94, 'doomed.bin', { state: 'completed', files: oneFile('doomed.bin') }));
  await sendAgain.click();
  await waitFor(() => cloudLine('doomed.bin', /Ready on TorBox/), { label: 'the transfer sent again, ready', timeout: 30000 });
  assert.equal(tb.created, createdBefore + 1, 'sent to TorBox once more');
  assert.equal(await sendAgain.isVisible(), false, 'and nothing left to send again');

  // Deleted in the Cloud library, the card's transfer is gone from the card too: it offers to fetch
  // the torrent in the cloud again, and still does after a reload.
  await trouble.click('.tab[data-tab="cloud"]');
  const doomedRow = trouble.locator('.cloud-item', { has: trouble.locator('.cloud-item-name', { hasText: 'doomed.bin' }) });
  await doomedRow.locator('.cloud-item-delete').click({ timeout: 15000 });
  await waitFor(() => doomedRow.count().then((n) => n === 0), { label: 'deleted from the library', timeout: 15000 });
  assert.equal(tb.torrents.has(94), false, 'deleted on TorBox');
  const offersFetch = async () => ({
    box: await troubleCard('doomed.bin').locator('.cloud').isVisible(),
    fetch: await troubleCard('doomed.bin').locator('.nopeers-cloud-btn').isVisible(),
  });
  await waitFor(() => offersFetch().then((o) => !o.box && o.fetch), { label: 'the card to let go of the deleted transfer', timeout: 5000 });

  // Deleted on TorBox's own site instead, the transfer is found gone after a reload: the card says
  // so, and can send it again.
  tb.torrents.delete(90);
  await trouble.evaluate(() => Promise.all([...window.__phoneTorrent.views.values()].map((v) => v.persisted)));
  await trouble.reload();
  await trouble.waitForFunction(() => window.__phoneTorrent?.client);
  await waitFor(() => cloudLine('blip.bin', /TorBox: Torrent not found/), { label: 'a transfer TorBox no longer has', timeout: 15000 });
  await troubleCard('blip.bin').locator('.cloud-again-btn').waitFor({ timeout: 5000 });
  assert.deepEqual(await offersFetch(), { box: false, fetch: true }, 'the transfer deleted in the library stays forgotten after a reload');
  log('cloud: a transfer that failed or is gone can be sent again, and a library delete lets go of the card');

  // TorBox lists the files of a torrent still downloading too, but their links lead to an error
  // page until it is done: nothing to save, play or link yet.
  tb.torrents.set(95, tbTorrent(95, 'partial.mkv', { progress: 0.12, files: oneFile('partial.mkv') }));
  await trouble.click('.tab[data-tab="cloud"]');
  await trouble.click('#cloud-refresh-btn');
  const partialRow = trouble.locator('.cloud-item', { has: trouble.locator('.cloud-item-name', { hasText: 'partial.mkv' }) });
  await partialRow.locator('.cloud-item-files-btn').click({ timeout: 15000 });
  await waitFor(() => partialRow.locator('.cloud-item-files').textContent().then((t) => /once the download finishes/.test(t)), { label: 'the files of an unfinished transfer, not yet offered', timeout: 15000 });
  assert.equal(await partialRow.locator('.cloud-save, .cloud-play, .cloud-copy').count(), 0, 'no Save, Play or Link for a file not downloaded yet');
  tb.torrents.set(95, tbTorrent(95, 'partial.mkv', { state: 'completed', files: oneFile('partial.mkv') }));
  await partialRow.locator('.cloud-save').waitFor({ timeout: 20000 });
  assert.match(await partialRow.locator('.cloud-save').getAttribute('href'), /requestdl\?.*torrent_id=95/, 'and a link once it is done');
  log('cloud library: Save, Play and Link only once the download is done');

  // Switched to another service whose first listing fails, the library lets go of the old service's
  // transfers instead of showing them — and deleting them — under the new one's name.
  assert.ok(await trouble.locator('.cloud-item').count() > 0, "TorBox's transfers listed");
  putioApi.state.down = true;
  await trouble.click('#settings-btn');
  await trouble.waitForSelector('#settings-dialog[open]');
  await trouble.selectOption('#cloud-provider', 'putio');
  await trouble.click('#settings-dialog button[value="save"]');
  await trouble.waitForSelector('#settings-dialog[open]', { state: 'detached', timeout: 5000 }).catch(() => {});
  await savedService(trouble, 'putio');
  await waitFor(() => trouble.$eval('#cloud-error', (e) => !e.hidden && /^put\.io: /.test(e.textContent)), { label: "put.io's failed listing", timeout: 15000 });
  assert.match(await trouble.textContent('#cloud-error'), /busy or down \(HTTP 502\)/, 'a 502 page reads as the service being down');
  assert.equal(await trouble.locator('.cloud-item').count(), 0, "TorBox's transfers are not shown as put.io's");
  putioApi.state.down = false;
  log('cloud library: switching service never lends one account\'s transfers to another');
  await troubleCtx.close();

  /* Real-Debrid: a choice of files that did not go through, a pack of files, an account of more
   * torrents than one page holds. */
  const rdCtx = await browser.newContext();
  const rd = await rdCtx.newPage();
  rd.on('pageerror', (e) => console.error('rd page error:', e));
  await rd.addInitScript(({ t, rtc, base }) => localStorage.setItem('phone-torrent:settings', JSON.stringify({
    trackers: [t], trackerList: false, rtcConfig: rtc, metadataSources: [],
    cloud: { provider: 'realdebrid', apiKey: 'debrid-key', apiBase: base, viaProxy: false, accounts: {} },
  })), { t: trackerUrl, rtc: rtcConfig, base: debridApi.url });
  await rd.goto(site.url);
  await rd.waitForFunction(() => window.__phoneTorrent?.client);

  // Added, but RD refused the call that chooses its files: it is sent all the same — once — and
  // started when the library next sees it waiting.
  debridApi.state.rdSelectFails = 1;
  await rd.click('.tab[data-tab="cloud"]');
  await rd.fill('#cloud-input', `magnet:?xt=urn:btih:${RD_WAITING_HASH}&dn=rd+waiting`);
  await rd.click('#cloud-form button[type="submit"]');
  await waitFor(() => rd.$$eval('.toast', (els) => els.some((e) => /^Sent to Real-Debrid/.test(e.textContent))), { label: 'sent, though its files were not chosen yet', timeout: 15000 });
  assert.equal(await rd.inputValue('#cloud-input'), '', 'the magnet is not left there to be sent twice');
  const waitingRow = rd.locator('.cloud-item', { has: rd.locator('.cloud-item-name', { hasText: 'rd waiting.mkv' }) });
  await waitFor(() => waitingRow.locator('.cloud-item-meta').textContent().then((t) => /ready$/.test(t)).catch(() => false), { label: 'the waiting torrent started, and finished', timeout: 30000 });
  assert.equal(debridApi.state.rdWaitingAdds, 1, 'added to RD once');
  assert.equal(await waitingRow.count(), 1, 'and listed once');

  // A pack of twenty: its links are asked for at the pace RD allows, a file refused for now costs the
  // others nothing, and a link already had is not asked for again.
  debridApi.state.rdRefuseOnce.add('https://real-debrid.example/restricted/pack7');
  const packFiles = () => rd.evaluate(async () => {
    const ctx = window.__phoneTorrent.cloudCtx();
    return (await ctx.api.status(ctx, 'RD3')).files.map((f) => ({ name: f.name, url: f.url || '', error: f.error || '' }));
  });
  const unrestrictedBefore = debridApi.state.rdUnrestrictTimes.length;
  const pack = await packFiles();
  assert.equal(pack.length, 20, 'every file of the pack listed');
  assert.deepEqual(pack.filter((f) => !f.url).map((f) => f.name), ['pack 08.mkv'], 'every file but the one refused has its link');
  assert.match(pack[7].error, /hoster_unavailable/, 'and that one says why');
  const rdBurst = burst(debridApi.state.rdUnrestrictTimes.slice(unrestrictedBefore));
  assert.ok(rdBurst <= 4, `links asked for no faster than RD allows (${rdBurst} in one second)`);
  const packAgain = await packFiles();
  assert.equal(packAgain.filter((f) => f.url).length, 20, 'asked again, the refused link comes');
  assert.equal(debridApi.state.rdUnrestrictTimes.length - unrestrictedBefore, 21, 'and it alone was asked for again');

  // An account of more torrents than RD lists at once: all of them, not the first page.
  debridApi.state.rdMany = 120;
  const rdListed = await rd.evaluate(async () => {
    const ctx = window.__phoneTorrent.cloudCtx();
    return (await ctx.api.list(ctx)).length;
  });
  assert.equal(rdListed, debridApi.state.rdTotal, `every torrent on the account listed (${rdListed} of ${debridApi.state.rdTotal})`);
  debridApi.state.rdMany = 0;
  log('Real-Debrid: files chosen once a refused choice can be made, a pack\'s links paced and kept, every page of the list');
  await rdCtx.close();

  /* ---------- a file unticked right after adding is not downloaded ---------- */
  // Before a torrent is ready, WebTorrent selects every piece it does not have yet. With the pieces on
  // disk that check runs after the file list is shown, and used to undo a file unticked in the
  // meantime: its box stayed empty while it downloaded anyway.
  const untickCtx = await browser.newContext();
  const untick = await untickCtx.newPage();
  untick.on('pageerror', (e) => console.error('untick page error:', e));
  await untick.addInitScript(({ t, rtc }) => localStorage.setItem('phone-torrent:settings', JSON.stringify({ trackers: [t], trackerList: false, rtcConfig: rtc, downloadLimit: 1000 })), { t: trackerUrl, rtc: rtcConfig });
  await untick.goto(site.url);
  await untick.waitForFunction(() => window.__phoneTorrent?.client);
  await untick.setInputFiles('#torrent-file-input', { name: 'test.torrent', mimeType: 'application/x-bittorrent', buffer: Buffer.from(torrentFile) });
  await untick.waitForSelector('.torrent .file', { timeout: 15000 });
  const untickNames = await untick.$$eval('.torrent .file .file-name', (els) => els.map((e) => e.textContent));
  await untick.locator('.torrent .file input[type="checkbox"]').nth(untickNames.indexOf(files[1].name)).uncheck();
  const fileState = (name) => untick.evaluate((n) => {
    const f = window.__phoneTorrent.client.torrents[0].files.find((x) => x.name === n);
    return { done: f.done, progress: f.progress };
  }, name);
  await waitForFromSeeder(() => fileState(files[0].name).then((s) => s.done), { label: 'the file still ticked to arrive', timeout: 180000 });
  await new Promise((r) => setTimeout(r, 1500)); // time for anything else it would fetch
  const unticked = await fileState(files[1].name);
  // Only the piece it shares with its neighbour, which that one needs.
  assert.ok(!unticked.done && unticked.progress < 0.1, `an unticked file is not downloaded (it got to ${Math.round(unticked.progress * 100)}%)`);
  await untickCtx.close();
  log('a file unticked right after adding is left alone');

  /* ---------- a torrent's life: the screen lock, restores, retries, coming back, a second copy ---------- */
  // A screen lock that says whether it is held.
  const stubWakeLock = () => {
    window.__lock = { held: false };
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          window.__lock.held = true;
          const sentinel = new EventTarget();
          sentinel.release = async () => { window.__lock.held = false; sentinel.dispatchEvent(new Event('release')); };
          return sentinel;
        },
      },
    });
  };
  const lifeCtx = await browser.newContext();
  const life = await lifeCtx.newPage();
  life.on('pageerror', (e) => console.error('life page error:', e));
  life.on('dialog', (d) => d.accept());
  await life.addInitScript(stubWakeLock);
  await life.addInitScript(({ t, rtc }) => {
    // No metadata caches: a magnet here waits for peers, and only for peers.
    localStorage.setItem('phone-torrent:settings', JSON.stringify({ trackers: [t], trackerList: false, rtcConfig: rtc, metadataSources: [] }));
    // Every toast, kept: they leave the screen after a few seconds.
    window.__toasts = [];
    document.addEventListener('DOMContentLoaded', () => new MutationObserver((changes) => changes.forEach((c) => c.addedNodes.forEach((n) => window.__toasts.push(n.textContent))))
      .observe(document.getElementById('toasts'), { childList: true }));
    // The hashing of pieces, on hold when asked: a seed's hashing, or the check of the pieces a
    // restore finds on disk, then lasts exactly as long as the test needs, on any machine. Only pieces
    // (16 KiB here) wait; the info hash of a .torrent is a small digest and goes through.
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const held = [];
    window.__holdHashes = sessionStorage.getItem('hold-hashes') === '1';
    crypto.subtle.digest = (algorithm, data) => (window.__holdHashes && data.byteLength >= 16384 ? new Promise((resolve) => held.push(resolve)) : Promise.resolve())
      .then(() => digest(algorithm, data));
    window.__releaseHashes = () => {
      window.__holdHashes = false;
      sessionStorage.removeItem('hold-hashes');
      held.splice(0).forEach((resolve) => resolve());
    };
  }, { t: trackerUrl, rtc: rtcConfig });
  await life.goto(site.url);
  await life.waitForFunction(() => window.__phoneTorrent?.client);
  const lifeCard = (name) => life.locator('.torrent', { has: life.locator('.name', { hasText: name }) }).first();
  const lockHeld = () => life.evaluate(() => window.__lock.held);
  const lifeAdd = (name, buffer) => life.setInputFiles('#torrent-file-input', { name, mimeType: 'application/x-bittorrent', buffer });

  // A private torrent says at once that nothing will download here: the screen has no reason to stay on.
  await lifeAdd('private.torrent', privateTorrent(rnd(40000, 61), 'private life.bin'));
  await waitFor(() => lifeCard('private life.bin').locator('.nopeers-text').textContent().then((t) => /marked private/.test(t)).catch(() => false), { label: 'private torrent explained', timeout: 15000 });
  assert.equal(await lifeCard('private life.bin').locator('.state').textContent(), 'cannot download here', 'a private torrent does not claim to be looking for peers');
  assert.equal(await lockHeld(), false, 'and does not keep the screen on');

  // A download holds the lock; with every file unticked it wants nothing, and lets go.
  const unwanted = makeTorrent(rnd(60000, 62), { name: 'unwanted.bin', trackers: [trackerUrl] });
  await lifeAdd('unwanted.torrent', unwanted.buf);
  await lifeCard('unwanted.bin').locator('.file').waitFor({ timeout: 15000 });
  await waitFor(lockHeld, { label: 'a download to hold the screen lock', timeout: 5000 });
  await lifeCard('unwanted.bin').locator('.select-none-btn').click();
  assert.equal(await lifeCard('unwanted.bin').locator('.state').textContent(), 'nothing selected');
  await waitFor(() => lockHeld().then((held) => !held), { label: 'nothing selected to let the screen lock go', timeout: 5000 });

  // Trackers that are all udp:// or http:// are not the end of it: the app's own wss:// trackers may
  // still find a WebRTC peer, so this one keeps the screen on — and explains itself.
  const udpOnly = makeTorrent(rnd(50000, 63), { name: 'udp only.bin', trackers: ['udp://tracker.example.org:1337/announce', 'http://tracker.example.net/announce'] });
  await lifeAdd('udp-only.torrent', udpOnly.buf);
  const udpExplained = () => waitFor(() => lifeCard('udp only.bin').locator('.nopeers-text').textContent()
    .then((t) => /None of this torrent's 2 trackers speak ws/.test(t)).catch(() => false), { label: "the udp-only torrent's explanation", timeout: 15000 });
  await udpExplained();
  await waitFor(lockHeld, { label: 'a torrent that may still find a WebRTC peer to hold the lock', timeout: 5000 });
  log('screen lock: held for a download, let go for nothing selected and for a private torrent');

  // The explanation is about the .torrent's own trackers. A reload and a retry rebuild the torrent from
  // the file WebTorrent keeps, which has the app's wss:// trackers merged in; they must not change it.
  await life.reload();
  await life.waitForFunction(() => window.__phoneTorrent?.client);
  await udpExplained();
  await waitFor(() => life.evaluate((h) => window.__phoneTorrent.client.torrents.find((t) => t.infoHash === h)?.ready, udpOnly.infoHash), { label: 'the restored udp-only torrent checked', timeout: 10000 });
  await lifeCard('udp only.bin').locator('.details-btn').click();
  await lifeCard('udp only.bin').locator('.retry-btn').click();
  await waitFor(() => lifeCard('udp only.bin').locator('.log li').allTextContents().then((l) => l.some((t) => /re-announced/.test(t))), { label: 'retry of the udp-only torrent', timeout: 15000 });
  await udpExplained();
  log('an unreachable torrent still explains itself after a reload and a retry');

  // The card of a magnet stuck on its metadata says to add the .torrent: doing so fills it in.
  const late = makeTorrent(rnd(70000, 64), { name: 'late metadata.bin', trackers: [trackerUrl] });
  await life.fill('#magnet-input', `magnet:?xt=urn:btih:${late.infoHash}&dn=late%20metadata.bin`);
  await life.click('#magnet-form button[type="submit"]');
  await waitFor(() => lifeCard('late metadata.bin').locator('.state').textContent().then((t) => t === 'fetching metadata').catch(() => false), { label: 'a magnet waiting for metadata', timeout: 10000 });
  const toastsBefore = await life.evaluate(() => window.__toasts.length);
  await lifeAdd('late.torrent', late.buf);
  await lifeCard('late metadata.bin').locator('.file').waitFor({ timeout: 10000 });
  assert.equal(await life.locator('.torrent', { has: life.locator('.name', { hasText: 'late metadata.bin' }) }).count(), 1, 'one card, filled in');
  assert.deepEqual((await life.evaluate((n) => window.__toasts.slice(n), toastsBefore)).filter((t) => /already in the list/.test(t)), [], 'not turned away as a duplicate');
  assert.equal(await life.evaluate((h) => [...window.__phoneTorrent.views.values()].find((v) => v.torrent.infoHash === h)?.source?.type, late.infoHash), 'torrent', 'and restored from the .torrent from now on');
  log('the .torrent for a magnet waiting on its metadata fills that card in');

  /* Coming back to the app, or the network coming back, rebuilds what is waiting for peers — and only
   * that. A seed still hashing has no info hash to announce yet, and a restored torrent still checking
   * its pieces does not look for peers until it is done: rebuilding either used to lose the seed, or
   * start the check over from nothing. */
  const nobodyHasIt = createHash('sha1').update(`nobody has it ${Math.random()}`).digest('hex');
  await life.fill('#magnet-input', `magnet:?xt=urn:btih:${nobodyHasIt}&dn=nobody%20has%20it`);
  await life.click('#magnet-form button[type="submit"]');
  await lifeAdd('test.torrent', Buffer.from(torrentFile));
  await waitForFromSeeder(() => lifeCard('Phone Torrent Test').locator('.pct').textContent().then((t) => t === '100%').catch(() => false), { label: 'the life page download', timeout: 180000 });
  await waitFor(() => life.evaluate(() => window.__toasts.some((t) => /"Phone Torrent Test" finished downloading/.test(t))), { label: 'the finished toast for a download seen through', timeout: 5000 });
  await life.evaluate(() => Promise.all([...window.__phoneTorrent.views.values()].map((v) => v.persisted)));
  // On the next launch the pieces on disk are checked, and the check waits until the hashes are released.
  await life.evaluate(() => sessionStorage.setItem('hold-hashes', '1'));
  await life.reload();
  await life.waitForFunction(() => window.__phoneTorrent?.client);
  await waitFor(() => life.evaluate(() => window.__phoneTorrent.client.torrents.length === 6), { label: 'every torrent restored', timeout: 15000 });
  await lifeCard('late metadata.bin').locator('.file').waitFor({ timeout: 10000 });
  if (opfs) {
    await waitFor(() => life.evaluate(() => {
      const t = window.__phoneTorrent.client.torrents.find((x) => x.name === 'Phone Torrent Test');
      return Boolean(t?.metadata && !t.ready);
    }), { label: 'the restored download checking its pieces', timeout: 10000 });
    // A retry by hand would start the check over just the same: it waits for it instead.
    await lifeCard('Phone Torrent Test').locator('.details-btn').click();
    await lifeCard('Phone Torrent Test').locator('.retry-btn').click();
    await waitFor(() => life.evaluate(() => window.__toasts.some((t) => /still being checked/.test(t))), { label: 'a retry during the check to wait for it', timeout: 5000 });
  }
  await life.click('.tab[data-tab="seed"]');
  await life.setInputFiles('#seed-file-input', { name: 'fresh seed.bin', mimeType: 'application/octet-stream', buffer: rnd(300 * 1024, 65) });
  await waitFor(() => life.$$eval('.torrent.seeding .state', (els) => els.some((e) => e.textContent === 'hashing')), { label: 'a seed hashing', timeout: 10000 });
  const toastsAtReturn = await life.evaluate(() => {
    const { client, views } = window.__phoneTorrent;
    window.__before = new Map(client.torrents.map((t) => [views.get(t)?.seeding ? 'seed' : t.infoHash, t]));
    window.dispatchEvent(new Event('online'));
    return window.__toasts.length;
  });
  // Twelve seconds of grace, then whatever is still alone and waiting for peers is rebuilt.
  await waitFor(() => life.evaluate((h) => {
    const t = window.__phoneTorrent.client.torrents.find((x) => x.infoHash === h);
    return Boolean(t && t !== window.__before.get(h));
  }, nobodyHasIt), { label: 'the magnet waiting for peers to be rebuilt', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1000));
  const afterReturn = await life.evaluate(() => {
    const { client } = window.__phoneTorrent;
    const kept = (key) => {
      const was = window.__before.get(key);
      return Boolean(was && !was.destroyed && client.torrents.includes(was));
    };
    const byName = (name) => client.torrents.find((t) => t.name === name)?.infoHash;
    return { seed: kept('seed'), checking: kept(byName('Phone Torrent Test')), nothingSelected: kept(byName('unwanted.bin')) };
  });
  assert.equal(afterReturn.seed, true, 'a seed still hashing is left to finish');
  if (opfs) assert.equal(afterReturn.checking, true, 'a restored torrent still checking its pieces is left to finish');
  assert.equal(afterReturn.nothingSelected, true, 'a torrent with nothing selected is not waiting for anything');
  assert.deepEqual(await life.evaluate((n) => window.__toasts.slice(n), toastsAtReturn), [], 'and nothing went wrong on the way');
  await life.evaluate(() => window.__releaseHashes());
  await waitFor(() => life.$$eval('.torrent.seeding .state', (els) => els.some((e) => /^seeding/.test(e.textContent))), { label: 'the seed to finish hashing', timeout: 20000 });
  // Without OPFS the pieces were in memory, and come from the seeder again.
  await waitForFromSeeder(() => lifeCard('Phone Torrent Test').locator('.pct').textContent().then((t) => t === '100%'), { label: 'the restored download checked', timeout: 180000 });
  if (opfs) {
    assert.equal(await life.evaluate(() => window.__phoneTorrent.client.torrents.find((t) => t.name === 'Phone Torrent Test').received), 0, 'restored from disk');
    // Finished before this launch: a check that finds it complete is no news.
    assert.deepEqual(await life.evaluate(() => window.__toasts.filter((t) => /finished downloading/.test(t))), [], 'no "finished downloading" for what finished before');
  }
  log('coming back rebuilds a magnet waiting for peers, and leaves a hashing seed, a piece check and an unwanted torrent alone');

  /* Two copies of the app open at once each run every torrent. Removing one in either copy removes
   * it from the other too: the other would otherwise offer files whose pieces are gone, and write the
   * record back on its next change, bringing the torrent back at 0% on the next launch. */
  const secondCopy = await lifeCtx.newPage();
  secondCopy.on('pageerror', (e) => console.error('second copy page error:', e));
  secondCopy.on('dialog', (d) => d.accept());
  await secondCopy.goto(site.url);
  await secondCopy.waitForFunction(() => window.__phoneTorrent?.client);
  const secondCopyCard = secondCopy.locator('.torrent', { has: secondCopy.locator('.name', { hasText: 'udp only.bin' }) }).first();
  await secondCopyCard.locator('.file').waitFor({ timeout: 15000 });
  await secondCopyCard.locator('.remove-btn').click();
  await waitFor(() => life.evaluate((h) => !window.__phoneTorrent.client.torrents.some((t) => t.infoHash === h), udpOnly.infoHash), { label: 'the other copy to drop the removed torrent', timeout: 5000 });
  assert.equal(await lifeCard('udp only.bin').count(), 0, 'its card is gone there too');
  await secondCopy.close();
  const nextLaunch = await lifeCtx.newPage();
  await nextLaunch.goto(site.url);
  await nextLaunch.waitForFunction(() => window.__phoneTorrent?.client);
  await nextLaunch.locator('.torrent .name', { hasText: 'unwanted.bin' }).waitFor({ timeout: 15000 });
  assert.equal(await nextLaunch.locator('.torrent .name', { hasText: 'udp only.bin' }).count(), 0, 'and the next launch does not bring it back');
  log('removing a torrent in one open copy of the app removes it from the other');
  await lifeCtx.close();

  // Handed to a cloud service and ready there, a torrent needs the screen on no more than a private one.
  const handedCtx = await browser.newContext();
  const handed = await handedCtx.newPage();
  handed.on('pageerror', (e) => console.error('handed page error:', e));
  await handed.addInitScript(stubWakeLock);
  await handed.addInitScript(({ t, rtc, api }) => localStorage.setItem('phone-torrent:settings', JSON.stringify({
    trackers: [t], trackerList: false, rtcConfig: rtc, metadataSources: [],
    cloud: { provider: 'torbox', apiKey: 'test-api-key', apiBase: api, viaProxy: false, accounts: {} },
  })), { t: trackerUrl, rtc: rtcConfig, api: cloudApi.url });
  await handed.goto(site.url);
  await handed.waitForFunction(() => window.__phoneTorrent?.client);
  await handed.setInputFiles('#torrent-file-input', { name: 'udp-only.torrent', mimeType: 'application/x-bittorrent', buffer: udpOnly.buf });
  await waitFor(() => handed.evaluate(() => window.__lock.held), { label: 'a torrent with no peers yet to hold the screen lock', timeout: 10000 });
  await handed.click('.torrent .nopeers-cloud-btn');
  await waitFor(() => handed.$eval('.torrent .cloud-state', (e) => /Ready on TorBox/.test(e.textContent)).catch(() => false), { label: 'the cloud to have it', timeout: 20000 });
  await waitFor(() => handed.evaluate(() => !window.__lock.held), { label: 'the screen lock let go once the cloud has it', timeout: 5000 });
  log('screen lock: let go once the cloud has the torrent');
  await handedCtx.close();

  /* ---------- web seeds: a pause drops the connection, never the seed ---------- */
  // Nobody seeds these but an HTTP mirror: the torrent's own url-list, or one added by hand. "Keep
  // seeding" is off in this context, for the last of them.
  const webCtx = await browser.newContext();
  const web = await webCtx.newPage();
  web.on('pageerror', (e) => console.error('web seed page error:', e));
  let webSeedUrl = '';
  web.on('dialog', (d) => d.accept(d.type() === 'prompt' ? webSeedUrl : undefined));
  await web.addInitScript(({ t, rtc }) => localStorage.setItem('phone-torrent:settings', JSON.stringify({ trackers: [t], trackerList: false, rtcConfig: rtc, metadataSources: [], seedAfterDone: false })), { t: trackerUrl, rtc: rtcConfig });
  await web.goto(site.url);
  await web.waitForFunction(() => window.__phoneTorrent?.client);
  const webCard = (name) => web.locator('.torrent', { has: web.locator('.name', { hasText: name }) }).first();
  const webProgress = (name) => web.evaluate((n) => window.__phoneTorrent.client.torrents.find((t) => t.name === n)?.progress || 0, name);
  const webAdd = (name, buffer) => web.setInputFiles('#torrent-file-input', { name, mimeType: 'application/x-bittorrent', buffer });

  const listed = rnd(1024 * 1024, 71);
  mirror.state.files.set('/listed.bin', listed);
  await webAdd('listed.torrent', makeTorrent(listed, { name: 'listed.bin', trackers: [trackerUrl], urlList: [`${mirror.url}/listed.bin`] }).buf);
  await waitFor(() => webProgress('listed.bin').then((p) => p > 0.1), { label: 'a download from its web seed', timeout: 30000 });
  await webCard('listed.bin').locator('.pause-btn').click();
  assert.equal(await webCard('listed.bin').locator('.state').textContent(), 'paused');
  const listedAsked = mirror.state.asked.get('/listed.bin');
  await webCard('listed.bin').locator('.pause-btn').click();
  await waitFor(() => mirror.state.asked.get('/listed.bin') > listedAsked, { label: 'its web seed asked again after a resume', timeout: 10000 });
  await waitFor(() => webCard('listed.bin').locator('.pct').textContent().then((t) => t === '100%'), { label: 'the web-seeded download to finish after a resume', timeout: 60000 });

  // Added by hand, paused, and the app closed and opened again: the seed is part of the torrent now.
  const byHand = rnd(1024 * 1024, 72);
  mirror.state.files.set('/by hand.bin', byHand);
  await webAdd('by-hand.torrent', makeTorrent(byHand, { name: 'by hand.bin', trackers: [trackerUrl] }).buf);
  await webCard('by hand.bin').locator('.file').waitFor({ timeout: 10000 });
  await webCard('by hand.bin').locator('.details-btn').click();
  webSeedUrl = `${mirror.url}/by%20hand.bin`;
  await webCard('by hand.bin').locator('.webseed-btn').click();
  await waitFor(() => webProgress('by hand.bin').then((p) => p > 0.1), { label: 'a download from a web seed added by hand', timeout: 30000 });
  await webCard('by hand.bin').locator('.pause-btn').click();
  await web.evaluate(() => Promise.all([...window.__phoneTorrent.views.values()].map((v) => v.persisted)));
  await web.reload();
  await web.waitForFunction(() => window.__phoneTorrent?.client);
  await waitFor(() => webCard('by hand.bin').locator('.state').textContent().then((t) => t === 'paused').catch(() => false), { label: 'restored paused', timeout: 15000 });
  const byHandAsked = mirror.state.asked.get('/by hand.bin');
  await webCard('by hand.bin').locator('.pause-btn').click();
  await waitFor(() => mirror.state.asked.get('/by hand.bin') > byHandAsked, { label: 'the web seed added by hand asked again after a reload', timeout: 10000 });
  await waitFor(() => webCard('by hand.bin').locator('.pct').textContent().then((t) => t === '100%'), { label: 'the download from a web seed added by hand to finish', timeout: 60000 });

  // Stopped for being finished with what was selected, then one more file ticked: it comes from the
  // web seed, which the stop had dropped with every other connection.
  const pair = [rnd(512 * 1024, 73), rnd(512 * 1024, 74)];
  mirror.state.files.set('/pair/first.bin', pair[0]);
  mirror.state.files.set('/pair/second.bin', pair[1]);
  const pairBody = Buffer.concat(pair);
  const pairPieces = [];
  for (let off = 0; off < pairBody.length; off += 16384) pairPieces.push(createHash('sha1').update(pairBody.subarray(off, off + 16384)).digest());
  await webAdd('pair.torrent', bencode({
    announce: trackerUrl,
    'url-list': [`${mirror.url}/`],
    info: { files: [{ length: pair[0].length, path: ['first.bin'] }, { length: pair[1].length, path: ['second.bin'] }], name: 'pair', 'piece length': 16384, pieces: Buffer.concat(pairPieces) },
  }));
  await webCard('pair').locator('.file').first().waitFor({ timeout: 10000 });
  const pairSecond = webCard('pair').locator('.file', { has: web.locator('.file-name', { hasText: 'second.bin' }) }).locator('input[type="checkbox"]');
  await pairSecond.uncheck();
  await waitFor(() => webCard('pair').locator('.state').textContent().then((t) => t === 'complete'), { label: 'the selected file from the web seed, then the stop', timeout: 30000 });
  const secondAsked = mirror.state.asked.get('/pair/second.bin') || 0;
  await pairSecond.check();
  await waitFor(() => webCard('pair').locator('.pct').textContent().then((t) => t === '100%'), { label: 'a file ticked after the stop to come from the web seed', timeout: 30000 });
  assert.ok((mirror.state.asked.get('/pair/second.bin') || 0) > secondAsked, 'the web seed was asked for it');
  log('web seeds: kept through a pause, a reload and a stop, the url-list ones and one added by hand');
  await webCtx.close();

  /* ---------- a page that is not secure: plain http, and not localhost ---------- */
  // Your own server opened from a phone at http://192.168.1.20:8080 is one: there is no crypto.subtle
  // there, which WebTorrent hashes with, and a torrent failed with "Invalid torrent identifier" or
  // hashed for ever. The Cloud tab works there; the other two say why they do not. Playwright serves
  // the app at a name that is not localhost, which is all it takes.
  const lanCtx = await browser.newContext();
  const REPO = path.join(HERE, '..');
  await lanCtx.route('http://phone.lan/**', (route) => {
    const { pathname } = new URL(route.request().url());
    const file = path.join(REPO, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
    return statSync(file, { throwIfNoEntry: false })?.isFile() ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: 'Not found' });
  });
  const lan = await lanCtx.newPage();
  lan.on('pageerror', (e) => console.error('lan page error:', e));
  lan.on('dialog', (d) => d.accept());
  await lan.goto(`http://phone.lan/#magnet:?xt=urn:btih:${'6'.repeat(40)}&dn=from%20a%20link`);
  await lan.waitForFunction(() => window.__phoneTorrent?.client);
  assert.equal(await lan.evaluate(() => window.isSecureContext), false, 'plain http at a name that is not localhost');
  await waitFor(() => lan.$$eval('.toast', (els) => els.some((e) => /need a secure page, HTTPS or localhost/.test(e.textContent))), { label: 'a linked magnet to say why it cannot be added here', timeout: 10000 });
  assert.equal((await lan.$$('.torrent')).length, 0, 'and nothing is added that could only fail');
  assert.match(await lan.$eval('#tab-download .insecure-note', (e) => (e.hidden ? '' : e.textContent)), /Here only the Cloud tab works/, 'the Download tab says so');
  assert.deepEqual(await lan.$$eval('#torrent-file-input, #magnet-input', (els) => els.map((e) => e.disabled)), [true, true], 'with no picker or field that could only fail');
  await lan.click('.tab[data-tab="seed"]');
  assert.equal(await lan.isVisible('#tab-seed .insecure-note'), true, 'so does Seed & share');
  assert.equal(await lan.$eval('#seed-file-input', (e) => e.disabled), true);
  await lan.click('.tab[data-tab="cloud"]');
  assert.equal(await lan.$eval('#cloud-input', (e) => e.disabled), false, 'the Cloud tab is the one that works here');
  await assert.rejects(lan.evaluate(() => window.__phoneTorrent.addTorrent(`magnet:?xt=urn:btih:${'7'.repeat(40)}`)), /HTTPS or localhost/);
  assert.match(await lan.evaluate(() => window.__phoneTorrent.saver.reason), /HTTPS/, 'and saves blame the page, not the browser');
  await lanCtx.close();
  log('a page that is not secure: the Cloud tab works, the other two say why they do not');

  /* ---------- served by your own server, the page knows it ---------- */
  // server/app.mjs is stood in for by its answers: /api/health, then the account and the list. A
  // fresh page asks its own origin and makes it the service, where it used to say "No API key yet".
  const ownCtx = await browser.newContext();
  const ownCalls = [];
  await ownCtx.route(`${site.url}api/**`, (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    ownCalls.push(`${req.method()} ${pathname}`);
    const body = pathname === '/api/health' ? { ok: true, torrents: 0 }
      : pathname === '/api/account' ? { who: 'your server', detail: '0 transfers · 30 GB free', version: 1 }
        : req.method() === 'POST' ? { transfer: { id: '9'.repeat(40) } }
          : { transfers: [] };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const own = await ownCtx.newPage();
  own.on('pageerror', (e) => console.error('own server page error:', e));
  await own.goto(site.url);
  await own.waitForFunction(() => window.__phoneTorrent?.client);
  await own.evaluate(() => window.__phoneTorrent.started);
  assert.deepEqual(await own.evaluate(() => { const c = window.__phoneTorrent.cloudCtx(); return { provider: c.provider, base: c.base }; }),
    { provider: 'server', base: new URL(site.url).origin }, 'the server serving the page is the service, at this very address');
  await own.click('.tab[data-tab="cloud"]');
  await waitFor(() => own.$eval('#cloud-account', (e) => e.textContent === 'My own server · your server · 0 transfers · 30 GB free'), { label: 'the Cloud tab to show the server', timeout: 5000 });
  assert.equal(await own.isVisible('#cloud-library'), true, 'and its library');
  await own.fill('#cloud-input', `magnet:?xt=urn:btih:${'9'.repeat(40)}`);
  await own.click('#cloud-form button[type="submit"]');
  await waitFor(() => ownCalls.includes('POST /api/transfers'), { label: 'a magnet sent to the server with nothing set up', timeout: 5000 });
  await ownCtx.close();
  // Anywhere else (GitHub Pages, npm start) that address is a 404, and the default stays.
  const elsewhereCtx = await browser.newContext();
  const elsewhere = await elsewhereCtx.newPage();
  await elsewhere.goto(site.url);
  await elsewhere.waitForFunction(() => window.__phoneTorrent?.client);
  await elsewhere.evaluate(() => window.__phoneTorrent.started);
  assert.equal(await elsewhere.evaluate(() => window.__phoneTorrent.cloudCtx().provider), 'torbox', 'a page no server serves keeps its default');
  await elsewhereCtx.close();
  log('served by your own server, the page uses it with nothing to set');

  /* ---------- offline: the card says so, and nothing blames CORS ---------- */
  const offCtx = await browser.newContext();
  const off = await offCtx.newPage();
  off.on('pageerror', (e) => console.error('offline page error:', e));
  await off.addInitScript(({ t, rtc, meta }) => localStorage.setItem('phone-torrent:settings', JSON.stringify({
    trackers: [t], trackerList: false, rtcConfig: rtc, metadataSources: [meta], fallbackDelay: 5,
  })), { t: trackerUrl, rtc: rtcConfig, meta: `${site.url}test/.tmp/{infohash}.torrent` });
  await off.goto(site.url);
  await off.waitForFunction(() => window.__phoneTorrent?.client);
  await offCtx.setOffline(true);
  await off.fill('#magnet-input', `magnet:?xt=urn:btih:${'8'.repeat(40)}&dn=offline`);
  await off.click('#magnet-form button[type="submit"]');
  await waitFor(() => off.$eval('.torrent .state', (e) => e.textContent === 'offline, waiting for the network').catch(() => false), { label: 'an offline card to say so', timeout: 5000 });
  assert.equal(await off.$eval('#net-status', (e) => e.textContent), 'offline', 'and the top bar');
  // Past the metadata fallback's delay (5 s) and the no-peers panel's (twice that).
  await new Promise((r) => setTimeout(r, 11500));
  const offLog = await off.$$eval('.torrent .log li', (els) => els.map((e) => e.textContent));
  assert.ok(offLog.some((l) => /offline: the fallback sources wait for the network/.test(l)), `the caches wait for the network (log: ${offLog.join(' | ')})`);
  assert.ok(!offLog.some((l) => /CORS/.test(l)), 'and nothing blames CORS');
  assert.equal(await off.$eval('.torrent .nopeers', (e) => e.hidden), true, 'nor offers trackers and web seeds for a missing network');
  assert.equal(await off.$eval('.torrent .state', (e) => e.textContent), 'offline, waiting for the network');
  await offCtx.setOffline(false);
  await waitFor(() => off.$$eval('.torrent .log li', (els) => els.some((e) => /the network came back: asking the trackers again/.test(e.textContent))), { label: 'the return of the network to wake it', timeout: 5000 });
  await waitFor(() => off.$eval('.torrent .state', (e) => e.textContent !== 'offline, waiting for the network'), { label: 'the card to stop saying offline', timeout: 5000 });
  await offCtx.close();
  log('offline: said on the card and the top bar, the caches wait, and the network coming back wakes it');

  /* ---------- fallback: a browser without service workers or OPFS ---------- */
  // What a browser that offers neither gets (private browsing in some): saves go through memory, and
  // so do the pieces. "Keep seeding" is off here, and the download is throttled so that a file can be
  // unticked before it arrives.
  const legacyCtx = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  const legacy = await legacyCtx.newPage();
  legacy.on('pageerror', (e) => console.error('legacy page error:', e));
  await legacy.addInitScript(({ t, rtc }) => {
    localStorage.setItem('phone-torrent:settings', JSON.stringify({ trackers: [t], trackerList: false, rtcConfig: rtc, seedAfterDone: false, downloadLimit: 1000 }));
    delete StorageManager.prototype.getDirectory;
  }, { t: trackerUrl, rtc: rtcConfig });
  await legacy.goto(site.url);
  await legacy.waitForFunction(() => window.__phoneTorrent?.client);
  const legacyMode = (await waitSaver(legacy)).mode;
  assert.equal(legacyMode, 'blob', 'falls back to in-memory saving without a service worker');
  assert.equal(await legacy.evaluate(() => window.__phoneTorrent.opfsOk), false, 'and keeps the pieces in memory without OPFS');
  await legacy.setInputFiles('#torrent-file-input', { name: 'test.torrent', mimeType: 'application/x-bittorrent', buffer: Buffer.from(torrentFile) });
  await legacy.waitForSelector('.torrent .file', { timeout: 15000 });
  const legacyNames = await legacy.$$eval('.torrent .file .file-name', (els) => els.map((e) => e.textContent));
  const legacyNotes = legacy.locator('.torrent .file input[type="checkbox"]').nth(legacyNames.indexOf(files[1].name));
  const legacyPaused = () => legacy.evaluate(() => window.__phoneTorrent.client.torrents[0].paused);

  // Only the video for now: once it is in, "keep seeding" being off stops the torrent.
  await legacyNotes.uncheck();
  await waitForFromSeeder(() => legacy.$eval('.torrent .state', (e) => e.textContent === 'complete').catch(() => false), { label: 'the selected file to finish', timeout: 180000 });
  assert.equal(await legacyPaused(), true, 'finished, with "keep seeding" off: stopped');
  // Wanting one more file makes it unfinished again, and that stop no longer applies.
  await legacyNotes.check();
  assert.equal(await legacyPaused(), false, 'a newly selected file restarts a torrent stopped for being finished');
  await waitForFromSeeder(() => legacy.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { label: 'legacy download', timeout: 180000 });
  log('"keep seeding" off: one more file selected after the stop is fetched');

  const [legacyDownload] = await Promise.all([
    legacy.waitForEvent('download', { timeout: 30000 }),
    legacy.locator('.torrent .file .save-btn').nth(legacyNames.indexOf(files[1].name)).click(),
  ]);
  const legacyPath = path.join(TMP, 'legacy.bin');
  await legacyDownload.saveAs(legacyPath);
  assert.equal(legacyDownload.suggestedFilename(), files[1].name);
  assert.equal(sha(readFileSync(legacyPath)), files[1].sha, 'blob-mode save matches the seeded file');
  log('blob fallback save OK:', legacyDownload.suggestedFilename());

  // A retry, and coming back to a frozen tab, which does the same, remove the torrent and add it
  // again. With the pieces in memory that used to start it over from 0%. The seeder is paused, so
  // only what this page already had can bring it back to 100%.
  await seederPause();
  await legacy.click('.torrent .details-btn');
  await legacy.click('.torrent .retry-btn');
  await waitFor(() => legacy.$$eval('.torrent .log li', (els) => els.some((e) => /re-announced/.test(e.textContent))), { label: 'retry with the pieces in memory', timeout: 15000 });
  await waitFor(() => legacy.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { label: 'the pieces in memory to survive the retry', timeout: 15000 });
  await seederPause(); // resume
  log('memory store: a retry keeps every piece');

  console.log('\nAll end-to-end checks passed.');
} catch (err) {
  failed = true;
  console.error('\nTEST FAILED:', err);
} finally {
  await browser.close();
  site.server.close();
  stun.socket.close();
  cloudApi.server.close();
  putioApi.server.close();
  debridApi.server.close();
  scriptedTorbox.server.close();
  corsProxy.server.close();
  mirror.server.close();
  tracker.close();
  process.exit(failed ? 1 : 0);
}
