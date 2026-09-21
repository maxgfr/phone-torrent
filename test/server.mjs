/* The server, against a real swarm.
 *
 * A node WebTorrent instance seeds a file over a local tracker; the server is
 * asked for it through its HTTP API, exactly as the app asks; and the file is
 * pulled back out of the API — with a Range request, because that is how a
 * <video> seeks and how a phone resumes — and compared byte for byte.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

const server = spawn(process.execPath, [path.join(HERE, '..', 'server', 'app.mjs')], {
  env: {
    ...process.env,
    PORT: '0',
    AUTH_TOKEN: TOKEN,
    DOWNLOAD_DIR: path.join(tmp, 'downloads'),
    WEB_DIR: path.join(HERE, '..'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverUrl = '';
server.stdout.on('data', (d) => {
  const text = String(d);
  process.stdout.write(`  server: ${text}`);
  const m = text.match(/http:\/\/0\.0\.0\.0:(\d+)/);
  if (m) serverUrl = `http://127.0.0.1:${m[1]}`;
});
server.stderr.on('data', (d) => process.stderr.write(`  server: ${d}`));

let failed = false;
try {
  await waitFor(() => serverUrl, { label: 'the server to say which port it took', timeout: 20000 });
  const api = (path, init = {}) => fetch(`${serverUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });

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
  log('a body that is not a torrent is refused with a reason');

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
  log('file served whole and by range');

  // The link the app hands to <video> or to a download carries its token in the query.
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
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  server.kill('SIGKILL');
  await new Promise((resolve) => seeder.destroy(resolve));
  tracker.close();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
