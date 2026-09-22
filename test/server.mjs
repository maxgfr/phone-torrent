/* The server, against a real swarm.
 *
 * A node WebTorrent instance seeds a file over a local tracker; the server is
 * asked for it through its HTTP API, exactly as the app asks; and the file is
 * pulled back out of the API — with a Range request, because that is how a
 * <video> seeks and how a phone resumes — and compared byte for byte.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import WebTorrent from 'webtorrent';
import { Server as TrackerServer } from 'bittorrent-tracker';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-server-token';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
/** RFC 4648 base32, the other way an info hash is written on a tracker page. */
function base32(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
const log = (...a) => console.log('•', ...a);

const WATCHDOG_MS = 3 * 60 * 1000;
setTimeout(() => {
  console.error(`\nWATCHDOG: the server suite exceeded ${WATCHDOG_MS / 60000} minutes`);
  process.exit(2);
}, WATCHDOG_MS).unref();

async function waitFor(fn, { timeout = 60000, interval = 250, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), 'phone-torrent-server-'));
const tracker = new TrackerServer({ udp: false, http: true, ws: false, stats: false });
await new Promise((resolve) => tracker.listen(0, '127.0.0.1', resolve));
const trackerUrl = `http://127.0.0.1:${tracker.http.address().port}/announce`;
log('tracker at', trackerUrl);

// A seeder that is not a browser: plain TCP, like every torrent a phone cannot reach.
const payload = randomBytes(512 * 1024);
const seedFile = path.join(tmp, 'release.bin');
writeFileSync(seedFile, payload);
const seeder = new WebTorrent({ dht: false });
const seeded = await new Promise((resolve) => {
  seeder.seed(seedFile, { announce: [trackerUrl] }, resolve);
});
log('seeding', seeded.name, `${payload.length} B`, seeded.infoHash);

// The downloads live inside the web root, exactly as they do when the server runs from a
// checkout with its defaults: the static side must still not hand them out.
const downloads = path.join(HERE, '.tmp', 'server-downloads');
rmSync(downloads, { recursive: true, force: true });
mkdirSync(downloads, { recursive: true });

/** A port nothing is using right now, TCP or UDP. */
async function freePort(udp = false) {
  if (udp) {
    const socket = dgram.createSocket('udp4');
    await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
    const { port } = socket.address();
    await new Promise((resolve) => socket.close(resolve));
    return port;
  }
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
const torrentPort = await freePort();
const dhtPort = await freePort(true);

let server = null;
let serverUrl = '';
let serverLog = '';
function startServer(extraEnv = {}) {
  serverUrl = '';
  server = spawn(process.execPath, [path.join(HERE, '..', 'server', 'app.mjs')], {
    env: {
      ...process.env,
      PORT: '0',
      AUTH_TOKEN: TOKEN,
      DOWNLOAD_DIR: downloads,
      WEB_DIR: path.join(HERE, '..'),
      TORRENT_PORT: String(torrentPort),
      DHT_PORT: String(dhtPort),
      ALLOWED_ORIGINS: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => {
    const text = String(d);
    serverLog += text;
    process.stdout.write(`  server: ${text}`);
    const m = text.match(/http:\/\/0\.0\.0\.0:(\d+)/);
    if (m) serverUrl = `http://127.0.0.1:${m[1]}`;
  });
  server.stderr.on('data', (d) => {
    serverLog += String(d);
    process.stderr.write(`  server: ${d}`);
  });
  return waitFor(() => serverUrl, { label: 'the server to say which port it took', timeout: 20000 });
}
async function stopServer() {
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
}

/** A request exactly as written: fetch() would tidy up a path like `//` before sending it. */
function rawGet(pathname) {
  const { port } = new URL(serverUrl);
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

let failed = false;
try {
  await startServer();
  const api = (path, init = {}) => fetch(`${serverUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });

  // The BitTorrent side listens where it was told, so the port a user forwards is the
  // port peers reach. WebTorrent's own default is a random one per start.
  assert.match(serverLog, new RegExp(`BitTorrent on port ${torrentPort} `), 'the server says which port it took for BitTorrent');
  await new Promise((resolve, reject) => {
    const socket = net.connect(torrentPort, '127.0.0.1', () => { socket.destroy(); resolve(); });
    socket.on('error', reject);
  });
  log('BitTorrent listens on the configured port', torrentPort);

  // A request the server cannot parse is refused, and the server is still there after it.
  assert.equal(await rawGet('/%'), 400, 'a malformed escape is a bad request');
  assert.equal(await rawGet('//'), 400, 'so is a path that is not a URL');
  assert.equal((await fetch(`${serverUrl}/api/health`)).status, 200, 'and the server survived both');
  log('malformed requests are refused without taking the server down');

  assert.equal((await (await fetch(`${serverUrl}/api/health`)).json()).ok, true, 'health needs no token');
  assert.equal((await api('/api/transfers')).status, 200);
  assert.equal((await fetch(`${serverUrl}/api/transfers`)).status, 401, 'no token, no answer');
  log('health and auth OK');

  // The app itself is served from the same origin: that is what makes one container a product.
  const page = await fetch(`${serverUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Phone Torrent/);
  log('the app is served from the same origin');

  // Submit exactly as the app does: a magnet, as JSON.
  const magnet = `magnet:?xt=urn:btih:${seeded.infoHash}&tr=${encodeURIComponent(trackerUrl)}`;
  const created = await api('/api/transfers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ magnet }),
  });
  assert.equal(created.status, 201);
  const { transfer } = await created.json();
  assert.equal(transfer.id, seeded.infoHash);
  log('submitted', transfer.id);

  // The same torrent again is the same transfer, not an error: a phone whose
  // connection dropped mid-tap sends it twice.
  const again = await api('/api/transfers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ magnet }),
  });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).transfer.id, seeded.infoHash, 'a repeat submit answers with the transfer it already is');
  assert.equal((await (await api('/api/transfers')).json()).transfers.length, 1, 'and does not add a second one');
  log('a repeated submit is idempotent');

  // A bare info hash is a valid thing to paste, in hex and in the base32 some sites
  // still print. Both name the same transfer, so neither adds a second one.
  for (const [shape, given] of [['hex', seeded.infoHash], ['base32', base32(Buffer.from(seeded.infoHash, 'hex'))]]) {
    const bare = await api('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet: given }),
    });
    assert.equal(bare.status, 200, `a bare ${shape} info hash is accepted`);
    assert.equal((await bare.json()).transfer.id, seeded.infoHash, `a bare ${shape} info hash names the same transfer`);
  }
  assert.equal((await (await api('/api/transfers')).json()).transfers.length, 1, 'and neither added a second one');
  log('a bare info hash works in hex and in base32');

  const badBody = await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"magnet":"not a torrent"}' });
  assert.equal(badBody.status, 400);
  assert.match((await badBody.json()).error, /magnet link or an info hash/);
  // Things that look like a torrent until WebTorrent parses them: they used to leave the
  // request waiting for an info hash that never came.
  const badTorrent = await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/x-bittorrent' }, body: 'd4:spam4:eggse' });
  assert.equal(badTorrent.status, 400, 'a .torrent with no info dictionary is answered, and refused');
  const badMagnet = await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"magnet":"magnet:?dn=no-hash"}' });
  assert.equal(badMagnet.status, 400, 'a magnet with no info hash is answered, and refused');
  log('a body that is not a torrent is refused with a reason, never left hanging');

  // No ALLOWED_ORIGINS means same-origin only: another site gets no CORS header, and a
  // body it could send without asking first (text/plain) is not taken as a torrent.
  const crossSite = await api('/api/transfers', { headers: { Origin: 'https://elsewhere.example' } });
  assert.equal(crossSite.headers.get('access-control-allow-origin'), null, 'no CORS for an origin nobody named');
  const plain = await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'd8:announce0:e' });
  assert.equal(plain.status, 415, 'a text/plain body is not a torrent');
  log('same-origin by default; a simple cross-site POST adds nothing');

  const ready = await waitFor(async () => {
    const { transfer: t } = await (await api(`/api/transfers/${seeded.infoHash}`)).json();
    return t && t.ready ? t : false;
  }, { label: 'the server to finish the download', timeout: 90000 });
  assert.equal(ready.files.length, 1);
  assert.equal(ready.files[0].name, 'release.bin');
  assert.equal(ready.files[0].size, payload.length);
  log('downloaded from a real peer:', ready.name, ready.state);

  // The whole file, then a range out of the middle — a <video> seek, and a resumed download.
  const whole = Buffer.from(await (await api(`/api/transfers/${seeded.infoHash}/files/0`)).arrayBuffer());
  assert.equal(sha(whole), sha(payload), 'the file the API serves is the file that was seeded');
  const ranged = await api(`/api/transfers/${seeded.infoHash}/files/0`, { headers: { Range: 'bytes=1000-1999' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 1000-1999/${payload.length}`);
  assert.equal(sha(Buffer.from(await ranged.arrayBuffer())), sha(payload.subarray(1000, 2000)), 'the range is the right slice');
  const suffix = await api(`/api/transfers/${seeded.infoHash}/files/0`, { headers: { Range: 'bytes=-100' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), `bytes ${payload.length - 100}-${payload.length - 1}/${payload.length}`, '"-100" is the last hundred bytes');
  assert.equal(sha(Buffer.from(await suffix.arrayBuffer())), sha(payload.subarray(payload.length - 100)));
  const past = await api(`/api/transfers/${seeded.infoHash}/files/0`, { headers: { Range: `bytes=${payload.length - 10}-${payload.length + 5000}` } });
  assert.equal(past.status, 206);
  assert.equal(past.headers.get('content-range'), `bytes ${payload.length - 10}-${payload.length - 1}/${payload.length}`, 'an end past the file stops at the file');
  assert.equal(past.headers.get('content-length'), '10', 'and promises only the bytes there are');
  assert.equal(sha(Buffer.from(await past.arrayBuffer())), sha(payload.subarray(payload.length - 10)));
  log('file served whole and by range, suffix ranges and ranges past the end included');

  // The downloads are inside the web root here, as they are when the server runs from a
  // checkout. The static side must not serve what /api guards with the token.
  const leaked = path.relative(path.join(HERE, '..'), downloads).split(path.sep).join('/');
  assert.equal((await fetch(`${serverUrl}/${leaked}/release.bin`)).status, 404, 'a downloaded file is not a static file');
  assert.equal((await fetch(`${serverUrl}/${leaked}/transfers.json`)).status, 404, 'nor is the list of transfers');
  assert.equal((await fetch(`${serverUrl}/.gitignore`)).status, 404, 'nor a dotfile');
  log('the static side serves the app, not the downloads');

  // The link the API hands out for a file carries a signature, not the token: it opens
  // that one file, for a day, and nothing else.
  const link = ready.files[0].link;
  assert.ok(link && !link.includes(TOKEN), 'the file link does not contain the token');
  const viaLink = await fetch(`${serverUrl}${link}`);
  assert.equal(viaLink.status, 200, 'the signed link needs no token');
  assert.equal(sha(Buffer.from(await viaLink.arrayBuffer())), sha(payload), 'and serves the file');
  const signedUrl = new URL(link, serverUrl);
  const tampered = new URL(signedUrl);
  tampered.searchParams.set('sig', `${signedUrl.searchParams.get('sig').slice(0, -2)}AA`);
  assert.equal((await fetch(tampered)).status, 401, 'a tampered signature is refused');
  const otherFile = new URL(signedUrl);
  otherFile.pathname = otherFile.pathname.replace(/\/0$/, '/1');
  assert.equal((await fetch(otherFile)).status, 401, 'the signature of one file opens no other');
  const past24h = Date.now() - 1000;
  const expired = new URL(`/api/transfers/${seeded.infoHash}/files/0`, serverUrl);
  expired.searchParams.set('expires', String(past24h));
  expired.searchParams.set('sig', createHmac('sha256', TOKEN).update(`${seeded.infoHash}/0/${past24h}`).digest('base64url'));
  assert.equal((await fetch(expired)).status, 401, 'an expired link is refused');
  log('file links are signed per file and expire; they never carry the token');

  // A torrent whose file is called transfers.json would write over the server's list of
  // transfers, and every transfer would be forgotten at the next start. It is refused.
  const clashDir = mkdtempSync(path.join(tmpdir(), 'phone-torrent-clash-'));
  writeFileSync(path.join(clashDir, 'transfers.json'), randomBytes(4096));
  const clash = await new Promise((resolve) => {
    seeder.seed(path.join(clashDir, 'transfers.json'), { announce: [trackerUrl] }, resolve);
  });
  const clashSubmit = await api('/api/transfers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ magnet: `magnet:?xt=urn:btih:${clash.infoHash}&tr=${encodeURIComponent(trackerUrl)}` }),
  });
  assert.ok([201, 400].includes(clashSubmit.status), `the clashing torrent is answered (${clashSubmit.status})`);
  await waitFor(() => /refused .*transfers\.json/.test(serverLog), { label: 'the clashing torrent to be refused', timeout: 60000 });
  const listed = (await (await api('/api/transfers')).json()).transfers.map((t) => t.id);
  assert.ok(!listed.includes(clash.infoHash), 'the clashing torrent is not kept');
  const state = JSON.parse(readFileSync(path.join(downloads, 'transfers.json'), 'utf8'));
  assert.deepEqual(state.map((row) => row.id), [seeded.infoHash], 'the list of transfers is intact, and still lists the real one');
  rmSync(clashDir, { recursive: true, force: true });
  log('a torrent that would overwrite the list of transfers is refused');

  // A restart picks every transfer up again, handlers and all: with SEED_AFTER_DONE=0 a
  // resumed download that is complete stops seeding, as a fresh one does.
  await stopServer();
  await startServer({ SEED_AFTER_DONE: '0' });
  const resumed = await waitFor(async () => {
    const { transfer: t } = await (await api(`/api/transfers/${seeded.infoHash}`)).json();
    return t && t.ready && t.state === 'completed' ? t : false;
  }, { label: 'the resumed transfer to be verified and stop seeding', timeout: 30000 });
  assert.equal(resumed.files[0].size, payload.length);
  assert.equal((await fetch(`${serverUrl}${link}`)).status, 200, 'a link handed out before the restart still works');
  log('a restart resumes the transfer and applies the same rules to it');

  // The token in the query still works: it is what an app from before signed links sends.
  const viaQuery = await fetch(`${serverUrl}/api/transfers/${seeded.infoHash}/files/0?token=${TOKEN}`);
  assert.equal(viaQuery.status, 200);
  assert.match(viaQuery.headers.get('content-disposition') || '', /attachment/);
  assert.equal((await fetch(`${serverUrl}/api/transfers/${seeded.infoHash}/files/0?token=wrong`)).status, 401);
  log('token in the query works, and a wrong one does not');

  // Delete takes the files with it, as a cloud service's delete does.
  assert.equal((await api(`/api/transfers/${seeded.infoHash}`, { method: 'DELETE' })).status, 200);
  const { transfers } = await (await api('/api/transfers')).json();
  assert.equal(transfers.length, 0, 'deleted from the server');
  log('delete OK');

  console.log('\nServer checks passed.');
} catch (err) {
  failed = true;
  console.error('\nSERVER TEST FAILED:', err);
} finally {
  if (server) {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    server.kill('SIGKILL');
  }
  await new Promise((resolve) => seeder.destroy(resolve));
  tracker.close();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
