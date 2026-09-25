/* The server, against a real swarm.
 *
 * A node WebTorrent instance seeds a file over a local tracker; the server is
 * asked for it through its HTTP API, exactly as the app asks; and the file is
 * pulled back out of the API — with a Range request, because that is how a
 * <video> seeks and how a phone resumes — and compared byte for byte.
 *
 * Then the two Workers that deploy beside it, cloudflare/ and proxy/, called
 * here as plain modules: no Cloudflare account involved.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import WebTorrent from 'webtorrent';
import { Server as TrackerServer } from 'bittorrent-tracker';
import proxyWorker from '../proxy/cloudflare-worker.js';

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

/**
 * A server started beside the main one, only to see how it starts: what it says until `until`
 * matches, or until it stops, and its exit code if it did. One still running after that is stopped.
 */
async function startAside(extraEnv, { until = null, timeout = 20000 } = {}) {
  const child = spawn(process.execPath, [path.join(HERE, '..', 'server', 'app.mjs')], {
    env: { ...process.env, PORT: '0', AUTH_TOKEN: TOKEN, DOWNLOAD_DIR: downloads, WEB_DIR: path.join(HERE, '..'), ALLOWED_ORIGINS: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const said = new Promise((resolve) => {
    const read = (d) => {
      output += d;
      if (until && until.test(output)) resolve();
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
  });
  const code = await Promise.race([exited, said.then(() => null), new Promise((r) => setTimeout(() => r(null), timeout))]);
  if (code === null) {
    child.kill('SIGKILL');
    await exited;
  }
  return { output, code };
}

/**
 * A request exactly as written: fetch() would tidy up a path like `//` before sending it, and
 * sends no Host but the one in the URL.
 */
function raw(pathname, { method = 'GET', headers = {}, body } = {}) {
  const { port } = new URL(serverUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

let failed = false;
try {
  // A download directory the server cannot write to (a disk mounted over it that belongs to
  // someone else) is reported at start, by the setting's name, not left for the first
  // download to find out. One inside a file cannot be made by anyone, root included.
  const unwritable = path.join(seedFile, 'downloads');
  const refused = spawn(process.execPath, [path.join(HERE, '..', 'server', 'app.mjs')], {
    env: { ...process.env, PORT: '0', DOWNLOAD_DIR: unwritable, TORRENT_PORT: String(torrentPort), DHT_PORT: String(dhtPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let refusal = '';
  refused.stdout.on('data', (d) => { refusal += d; });
  refused.stderr.on('data', (d) => { refusal += d; });
  const refusedCode = await new Promise((resolve) => refused.once('exit', resolve));
  assert.equal(refusedCode, 1, 'a server that cannot write its downloads does not start');
  assert.ok(refusal.includes(`DOWNLOAD_DIR ${unwritable}`), `and says which setting to fix: ${refusal.trim().split('\n')[0]}`);
  log('an unwritable download directory is named at start');

  // A BitTorrent port that is taken — another client on the machine, a second copy of this server —
  // makes WebTorrent tear itself down. The server used to go on answering its health check, the
  // Docker HEALTHCHECK included, and refuse every transfer with "client is destroyed". It stops
  // instead, so that a restart policy notices, and says which setting to change.
  const heldTcp = net.createServer();
  const heldTcpPort = await new Promise((resolve) => heldTcp.listen(0, () => resolve(heldTcp.address().port)));
  const heldUdp = dgram.createSocket('udp4');
  const heldUdpPort = await new Promise((resolve) => heldUdp.bind(0, () => resolve(heldUdp.address().port)));
  try {
    for (const [setting, port, other] of [['TORRENT_PORT', heldTcpPort, { DHT_PORT: String(await freePort(true)) }], ['DHT_PORT', heldUdpPort, { TORRENT_PORT: String(await freePort()) }]]) {
      const taken = await startAside({ [setting]: String(port), ...other });
      assert.equal(taken.code, 1, `a server whose ${setting} is taken stops (it said: ${taken.output.trim().split('\n').slice(-2).join(' | ')})`);
      assert.match(taken.output, new RegExp(`${setting} ${port}\\b.*is taken`), 'and says which setting to change');
    }
  } finally {
    heldTcp.close();
    heldUdp.close();
  }
  log('a BitTorrent or DHT port already taken stops the server, naming the setting');

  // uTP comes from a native module that npm leaves out where it has no prebuilt binary and cannot be
  // built — the arm64 image, before it had a compiler to build it with. The log said "TCP and uTP" all
  // the same, and the UDP port users are told to forward for it was listened on by nobody.
  const noUtpHook = path.join(tmp, 'no-utp.cjs');
  writeFileSync(noUtpHook, [
    "const Module = require('node:module');",
    'const load = Module._load;',
    'Module._load = function (request, ...rest) {',
    "  if (request === 'utp-native') throw Object.assign(new Error(\"Cannot find module 'utp-native'\"), { code: 'MODULE_NOT_FOUND' });",
    '  return load.call(this, request, ...rest);',
    '};',
  ].join('\n'));
  const withoutUtp = await startAside({ NODE_OPTIONS: `--require ${noUtpHook}`, TORRENT_PORT: String(await freePort()), DHT_PORT: String(await freePort(true)) }, { until: /BitTorrent on port .*\n/ });
  assert.match(withoutUtp.output, /BitTorrent on port \d+ \(TCP only/, `a server without uTP does not claim it (it said: ${withoutUtp.output.match(/BitTorrent.*/)?.[0]})`);
  log('a build without uTP says it runs TCP only');

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
  // And uTP, over UDP on the same port, when the log says so: that port is taken. Where this install
  // has no utp-native (Linux on arm, `npm ci --omit=optional`), neither has the server, which shares
  // its node_modules, and the log says TCP only.
  if (WebTorrent.UTP_SUPPORT) {
    assert.match(serverLog, new RegExp(`BitTorrent on port ${torrentPort} \\(TCP and uTP\\)`), 'with uTP here, the log says so');
    const utpProbe = dgram.createSocket('udp4');
    const utpBind = await new Promise((resolve) => {
      utpProbe.once('error', (err) => resolve(err.code));
      utpProbe.bind(torrentPort, () => resolve('bound'));
    });
    try { utpProbe.close(); } catch { /* never bound */ }
    assert.equal(utpBind, 'EADDRINUSE', 'and uTP listens on that port');
    log('BitTorrent listens on the configured port', torrentPort, 'over TCP and uTP');
  } else {
    assert.match(serverLog, new RegExp(`BitTorrent on port ${torrentPort} \\(TCP only`), 'without uTP here, the log says TCP only');
    log('BitTorrent listens on the configured port', torrentPort, 'over TCP (no uTP in this install)');
  }

  // A request the server cannot parse is refused, and the server is still there after it.
  assert.equal(await raw('/%'), 400, 'a malformed escape is a bad request');
  assert.equal(await raw('//'), 400, 'so is a path that is not a URL');
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
  const submittedAt = Date.now();
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
  // A browser decides whether to ask first from the type alone, before any ";": these go out
  // unasked from any page, so a parameter that mentions JSON does not make them JSON.
  for (const [type, body] of [
    ['text/plain; charset=application/json', JSON.stringify({ magnet })],
    ['application/x-www-form-urlencoded; a=application/json', JSON.stringify({ magnet })],
    ['text/plain; x=application/x-bittorrent', seeded.torrentFile],
  ]) {
    const disguised = await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': type }, body });
    assert.equal(disguised.status, 415, `"${type}" is not a torrent`);
  }
  const withCharset = await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ magnet }) });
  assert.equal(withCharset.status, 200, 'real JSON with a charset still is');
  // And a write another website sends is refused outright, whatever it carries: the browser
  // says where it comes from. The server's own page, and a script, are not other websites.
  const fromElsewhere = { Origin: 'https://elsewhere.example', 'Sec-Fetch-Site': 'cross-site' };
  const foreignPost = await api('/api/transfers', { method: 'POST', headers: { ...fromElsewhere, 'Content-Type': 'application/json' }, body: JSON.stringify({ magnet }) });
  assert.equal(foreignPost.status, 403, 'a POST from another website is refused');
  assert.equal((await api(`/api/transfers/${seeded.infoHash}`, { method: 'DELETE', headers: fromElsewhere })).status, 403, 'so is a DELETE');
  assert.equal((await api(`/api/transfers/${seeded.infoHash}`)).status, 200, 'and the transfer is still there');
  const ownPage = await api('/api/transfers', { method: 'POST', headers: { Origin: serverUrl, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: JSON.stringify({ magnet }) });
  assert.equal(ownPage.status, 200, 'the page this server serves is not another website');
  log('same-origin by default; a simple cross-site POST adds nothing, disguised or not');

  const ready = await waitFor(async () => {
    const { transfer: t } = await (await api(`/api/transfers/${seeded.infoHash}`)).json();
    return t && t.ready ? t : false;
  }, { label: 'the server to finish the download', timeout: 90000 });
  assert.equal(ready.files.length, 1);
  assert.equal(ready.files[0].name, 'release.bin');
  assert.equal(ready.files[0].size, payload.length);
  // When data last arrived: what keeps a Cloudflare container up with the phone asleep.
  assert.ok(ready.receivedAt >= submittedAt && ready.receivedAt <= Date.now(), `the transfer says when data last arrived (${ready.receivedAt})`);
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
  // One character changed, to one it certainly was not: writing "AA" over the end left the link
  // as it was whenever the signature already ended that way, about one run in a thousand.
  const sig = signedUrl.searchParams.get('sig');
  tampered.searchParams.set('sig', `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`);
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

  // A name with an apostrophe, as release names often have. encodeURIComponent leaves ' ( ) * as
  // they are, a browser refuses such a filename*, and with nothing else to go on it saved the file
  // as the last part of the link: "0", with no name and no extension. The file is on the server's
  // disk already, so the transfer checks it and has it, with no peer.
  const quotedName = "Don't Look Up (2021).bin";
  const quotedDir = mkdtempSync(path.join(tmpdir(), 'phone-torrent-quoted-'));
  const quotedBytes = randomBytes(20 * 1024);
  writeFileSync(path.join(quotedDir, quotedName), quotedBytes);
  const quoted = await new Promise((resolve) => {
    seeder.seed(path.join(quotedDir, quotedName), { announce: [trackerUrl] }, resolve);
  });
  await new Promise((resolve) => seeder.remove(quoted.infoHash, { destroyStore: false }, resolve));
  writeFileSync(path.join(downloads, quotedName), quotedBytes);
  assert.equal((await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/x-bittorrent' }, body: quoted.torrentFile })).status, 201);
  await waitFor(async () => (await (await api(`/api/transfers/${quoted.infoHash}`)).json()).transfer?.ready, { label: 'the file with an apostrophe to be checked', timeout: 15000 });
  const disposition = (await api(`/api/transfers/${quoted.infoHash}/files/0`, { method: 'HEAD' })).headers.get('content-disposition') || '';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]*)/)?.[1] || '';
  assert.match(encodedName, /^[A-Za-z0-9!#$&+\-.^_`|~%]+$/, `the UTF-8 name is only characters a browser takes there (${disposition})`);
  assert.equal(decodeURIComponent(encodedName), quotedName, 'and reads as the file\'s name');
  assert.ok(disposition.includes(`filename="${quotedName}"`), `with the name as it is beside it (${disposition})`);
  assert.equal((await api(`/api/transfers/${quoted.infoHash}`, { method: 'DELETE' })).status, 200);
  rmSync(quotedDir, { recursive: true, force: true });
  log('a file whose name has an apostrophe is saved under that name');

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

  // A season pack whose first episode is complete and whose second is not: the first is
  // listed, with its link, while the pack as a whole is still downloading. It is set up with
  // no peer at all — the episode already on the server's disk, the rest nowhere — so nothing
  // can finish it while it is looked at. Pieces never straddle the two files.
  const packDir = path.join(tmp, 'Pack');
  mkdirSync(path.join(packDir, 'extras'), { recursive: true });
  const episode = randomBytes(64 * 1024);
  writeFileSync(path.join(packDir, 'a-episode1.bin'), episode);
  writeFileSync(path.join(packDir, 'extras', 'b-episode2.bin'), randomBytes(64 * 1024));
  const pack = await new Promise((resolve) => {
    seeder.seed(packDir, { announce: [trackerUrl], pieceLength: 16 * 1024 }, resolve);
  });
  const packTorrent = pack.torrentFile;
  await new Promise((resolve) => seeder.remove(pack.infoHash, { destroyStore: false }, resolve));
  mkdirSync(path.join(downloads, 'Pack'), { recursive: true });
  writeFileSync(path.join(downloads, 'Pack', 'a-episode1.bin'), episode);
  const packSubmit = await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/x-bittorrent' }, body: packTorrent });
  assert.equal(packSubmit.status, 201);
  const partial = await waitFor(async () => {
    const { transfer: t } = await (await api(`/api/transfers/${pack.infoHash}`)).json();
    return t && t.files.length ? t : false;
  }, { label: 'the finished episode to be listed', timeout: 15000 });
  assert.equal(partial.ready, false, 'the pack is not finished');
  assert.deepEqual(partial.files.map((f) => f.name), ['a-episode1.bin'], 'only the finished file is listed');
  const episodeLink = partial.files[0].link;
  assert.ok(episodeLink && !episodeLink.includes(TOKEN), 'with a signed link');
  assert.equal(sha(Buffer.from(await (await fetch(`${serverUrl}${episodeLink}`)).arrayBuffer())), sha(episode), 'which serves it');
  log('a finished file is listed, with its link, while the rest of its torrent downloads');

  // Deleting a transfer takes its folders with it, not only the files inside them.
  assert.equal((await api(`/api/transfers/${pack.infoHash}`, { method: 'DELETE' })).status, 200);
  await waitFor(() => !existsSync(path.join(downloads, 'Pack')), { label: 'the pack\'s folder to go', timeout: 5000 });
  log('delete leaves no empty folders behind');

  // And only what the transfer wrote. A magnet is called by its dn= until the metadata comes, and a
  // .torrent by whatever name it gives itself: a folder of that name that it never wrote to — the
  // user's own, another transfer's — stays, all of it.
  mkdirSync(path.join(downloads, 'Photos'), { recursive: true });
  writeFileSync(path.join(downloads, 'Photos', 'holiday.jpg'), 'not a download');
  const inPlace = () => ({ photos: existsSync(path.join(downloads, 'Photos', 'holiday.jpg')), release: existsSync(path.join(downloads, 'release.bin')) });
  for (const dn of ['Photos', './Photos', 'x/../Photos', './release.bin']) {
    const id = randomBytes(20).toString('hex');
    const sent = await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ magnet: `magnet:?xt=urn:btih:${id}&dn=${encodeURIComponent(dn)}` }) });
    assert.equal(sent.status, 201);
    assert.equal((await api(`/api/transfers/${id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(inPlace(), { photos: true, release: true }, `a magnet called "${dn}", deleted before its metadata came, deletes nothing`);
  }
  const photosDir = path.join(tmp, 'elsewhere', 'Photos');
  mkdirSync(photosDir, { recursive: true });
  writeFileSync(path.join(photosDir, 'a.txt'), randomBytes(1024));
  const namesake = await new Promise((resolve) => {
    seeder.seed(photosDir, { announce: [trackerUrl] }, resolve);
  });
  await new Promise((resolve) => seeder.remove(namesake.infoHash, { destroyStore: false }, resolve));
  assert.equal((await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/x-bittorrent' }, body: namesake.torrentFile })).status, 201);
  assert.equal((await api(`/api/transfers/${namesake.infoHash}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(inPlace(), { photos: true, release: true }, 'nor does a .torrent called "Photos" that brings files of its own');
  // Nor one whose single file is called "Photos": the folder of that name stands where its file
  // would go. The torrent's own store deletes every path it names, recursively, and took the folder
  // with it before anything could say it was not the transfer's.
  const photoFile = path.join(tmp, 'single', 'Photos');
  mkdirSync(path.dirname(photoFile), { recursive: true });
  writeFileSync(photoFile, randomBytes(1024));
  const singlePhotos = await new Promise((resolve) => {
    seeder.seed(photoFile, { announce: [trackerUrl] }, resolve);
  });
  await new Promise((resolve) => seeder.remove(singlePhotos.infoHash, { destroyStore: false }, resolve));
  assert.equal((await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/x-bittorrent' }, body: singlePhotos.torrentFile })).status, 201);
  assert.equal((await api(`/api/transfers/${singlePhotos.infoHash}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(inPlace(), { photos: true, release: true }, 'nor does a single-file .torrent called "Photos"');
  rmSync(path.join(downloads, 'Photos'), { recursive: true, force: true });

  // Two transfers of one file — the same bytes cut into pieces of another size are another torrent —
  // both have it, and both seed it. Deleting one leaves it to the other; deleting that one takes it.
  const sharedFile = path.join(tmp, 'shared', 'shared.bin');
  mkdirSync(path.dirname(sharedFile), { recursive: true });
  const sharedBytes = randomBytes(64 * 1024);
  writeFileSync(sharedFile, sharedBytes);
  const sharing = [];
  for (const pieceLength of [16 * 1024, 32 * 1024]) {
    const one = await new Promise((resolve) => {
      seeder.seed(sharedFile, { announce: [trackerUrl], pieceLength }, resolve);
    });
    await new Promise((resolve) => seeder.remove(one.infoHash, { destroyStore: false }, resolve));
    sharing.push(one);
  }
  writeFileSync(path.join(downloads, 'shared.bin'), sharedBytes);
  for (const one of sharing) {
    assert.equal((await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/x-bittorrent' }, body: one.torrentFile })).status, 201);
  }
  for (const one of sharing) {
    await waitFor(async () => (await (await api(`/api/transfers/${one.infoHash}`)).json()).transfer?.ready, { label: 'both transfers of one file to have it', timeout: 15000 });
  }
  assert.equal((await api(`/api/transfers/${sharing[1].infoHash}`, { method: 'DELETE' })).status, 200);
  assert.ok(existsSync(path.join(downloads, 'shared.bin')), 'a file another transfer still has stays');
  assert.equal((await (await api(`/api/transfers/${sharing[0].infoHash}`)).json()).transfer?.ready, true, 'and that transfer still has it');
  assert.equal((await api(`/api/transfers/${sharing[0].infoHash}`, { method: 'DELETE' })).status, 200);
  await waitFor(() => !existsSync(path.join(downloads, 'shared.bin')), { label: 'the file to go with the last transfer that had it', timeout: 5000 });
  log('delete takes what the transfer wrote, not a folder that has its name, nor a file another transfer has');

  // A transfer that fails — a full disk, a write the disk refuses — stays listed with the
  // reason until it is deleted, rather than vanishing: the phone says why. A folder where its
  // second file must go makes every write to that file fail.
  const blockedDir = path.join(mkdtempSync(path.join(tmpdir(), 'phone-torrent-blocked-')), 'Blocked');
  mkdirSync(blockedDir);
  const alreadyThere = randomBytes(64 * 1024);
  writeFileSync(path.join(blockedDir, 'a-written.bin'), alreadyThere);
  writeFileSync(path.join(blockedDir, 'b-blocked.bin'), randomBytes(64 * 1024));
  const blocked = await new Promise((resolve) => {
    seeder.seed(blockedDir, { announce: [trackerUrl], pieceLength: 16 * 1024 }, resolve);
  });
  const inTheWay = path.join(downloads, 'Blocked', 'b-blocked.bin');
  mkdirSync(inTheWay, { recursive: true });
  writeFileSync(path.join(inTheWay, 'keep.txt'), 'not the transfer\'s');
  // Its first file is on the disk already, whole, as the pack's first episode was above: the
  // transfer checks it and takes it as its own.
  writeFileSync(path.join(downloads, 'Blocked', 'a-written.bin'), alreadyThere);
  const blockedSubmit = await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/x-bittorrent' }, body: blocked.torrentFile });
  assert.equal(blockedSubmit.status, 201);
  const failedTransfer = await waitFor(async () => {
    const res = await api(`/api/transfers/${blocked.infoHash}`);
    if (res.status === 404) return 'gone';
    const { transfer: t } = await res.json();
    return t.failed ? t : false;
  }, { label: 'the blocked transfer to fail', timeout: 30000 });
  assert.notEqual(failedTransfer, 'gone', 'a transfer that failed is still there to say why');
  assert.equal(failedTransfer.ready, false);
  assert.match(failedTransfer.state, /EISDIR/, 'and why is its state');
  assert.ok(!failedTransfer.state.includes(downloads), 'without the server\'s own paths');
  const listedFailure = (await (await api('/api/transfers')).json()).transfers.find((t) => t.id === blocked.infoHash);
  assert.ok(listedFailure && listedFailure.failed, 'the library lists it as failed');
  // What it wrote goes with it, and only that: the folder in its way is not its own.
  await waitFor(() => !existsSync(path.join(downloads, 'Blocked', 'a-written.bin')), { label: 'the files of the failed transfer to go', timeout: 5000 });
  assert.ok(existsSync(path.join(inTheWay, 'keep.txt')), 'a failed transfer leaves what it did not write');
  assert.equal((await api(`/api/transfers/${blocked.infoHash}`, { method: 'DELETE' })).status, 200, 'deleting it clears it');
  assert.equal((await api(`/api/transfers/${blocked.infoHash}`)).status, 404, 'for good');
  await new Promise((resolve) => seeder.remove(blocked.infoHash, { destroyStore: false }, resolve));
  rmSync(path.dirname(blockedDir), { recursive: true, force: true });
  rmSync(path.join(downloads, 'Blocked'), { recursive: true, force: true });
  log('a failed transfer stays listed with its reason until it is deleted, and takes only its own files');

  // A restart picks every transfer up again, handlers and all: with SEED_AFTER_DONE=0 a
  // resumed download that is complete stops seeding, as a fresh one does. The only seeder
  // leaves first: the transfer was sent as a magnet, and what is on the server's disk must be
  // enough to bring it back, with no peer to hand over the metadata again.
  await new Promise((resolve) => seeder.remove(seeded.infoHash, { destroyStore: false }, resolve));
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
  await waitFor(() => !existsSync(path.join(downloads, 'release.bin')), { label: 'the deleted file to go', timeout: 5000 });
  log('delete OK');

  // The same DELETE twice at once — a phone retrying one whose answer it lost, two phones — used to
  // take the whole server down: the second found the transfer already gone from WebTorrent, whose
  // refusal nothing handled. Sent on two connections already open, in the same moment, so that
  // neither waits for the other.
  const twice = randomBytes(20).toString('hex');
  assert.equal((await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ magnet: twice }) })).status, 201);
  const sockets = await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
    const socket = net.connect(new URL(serverUrl).port, '127.0.0.1', () => resolve(socket));
    socket.on('error', reject);
  })));
  const answered = sockets.map((socket) => new Promise((resolve) => {
    let reply = '';
    socket.on('data', (d) => { reply += d; });
    socket.on('error', () => {});
    socket.on('close', () => resolve(Number(reply.match(/^HTTP\/1\.1 (\d+)/)?.[1]) || 'no answer'));
  }));
  for (const socket of sockets) {
    socket.write(`DELETE /api/transfers/${twice} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`);
  }
  const statuses = await Promise.all(answered);
  assert.ok(statuses.every((s) => s === 200 || s === 404) && statuses.includes(200), `both are answered, one of them deleting it (${statuses.join(', ')})`);
  assert.equal((await fetch(`${serverUrl}/api/health`)).status, 200, 'and the server is still there');
  log('two DELETEs of one transfer at once are both answered, and the server stays up');

  // Saves that overlap — a delete and an add at the same moment — each leave a whole list,
  // and the last one the current list: never two lists spliced into a file the next start
  // cannot read.
  const statePath = path.join(downloads, 'transfers.json');
  const savedIds = (when) => {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8')).map((row) => row.id).sort();
    } catch (err) {
      return assert.fail(`${when}: transfers.json no longer reads: ${err.message}`);
    }
  };
  let kept = [];
  for (let round = 0; round < 20; round++) {
    const adds = Array.from({ length: 10 }, (_, i) => api('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Names of every length, so that one list is longer than the next.
      body: JSON.stringify({ magnet: `magnet:?xt=urn:btih:${randomBytes(20).toString('hex')}&dn=${'x'.repeat((round * 37 + i * 61) % 400)}` }),
    }).then((res) => res.json()).then((body) => body.transfer.id));
    const deletes = kept.map((id) => api(`/api/transfers/${id}`, { method: 'DELETE' }));
    [kept] = await Promise.all([Promise.all(adds), Promise.all(deletes)]);
    const current = (await (await api('/api/transfers')).json()).transfers.map((t) => t.id).sort();
    assert.deepEqual(savedIds(`round ${round}`), current, `round ${round}: transfers.json is the current list`);
  }
  await Promise.all(kept.map((id) => api(`/api/transfers/${id}`, { method: 'DELETE' })));
  assert.deepEqual(savedIds('after the last deletes'), [], 'and ends as the empty list it is');
  log('overlapping saves leave a whole, current list of transfers');

  // Now with no token, which is how `docker compose up` starts. It runs from a web root of its
  // own here, with the downloads inside it.
  await stopServer();
  const web = path.join(tmp, 'web');
  const webDownloads = path.join(web, 'downloads');
  mkdirSync(path.join(webDownloads, 'Some.Movie'), { recursive: true });
  writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Phone Torrent</title>');
  writeFileSync(path.join(webDownloads, 'Some.Movie', 'movie.mkv'), 'private bytes');
  // A list of transfers that does not read — a crash mid-write, a full disk — is not a first
  // run: it is kept aside, and said so, rather than written over with an empty list.
  writeFileSync(path.join(webDownloads, 'transfers.json'), '[{"id":');
  // The hosted app's origin written as the address of its page, the way it gets pasted; and the
  // names this server answers at written as the address bar shows them, as an address, and with the
  // final dot a full name may have. A Host header is compared without its port or that dot.
  const tokenless = { AUTH_TOKEN: '', WEB_DIR: web, DOWNLOAD_DIR: webDownloads, ALLOWED_HOSTS: 'nas.local:8080, http://media.lan:8080/,files.lan.', ALLOWED_ORIGINS: 'https://hosted.example/phone-torrent/' };
  await startServer(tokenless);
  const aside = readdirSync(webDownloads).find((name) => name.startsWith('transfers.json.corrupt-'));
  assert.ok(aside, 'an unreadable transfers.json is kept aside');
  assert.equal(readFileSync(path.join(webDownloads, aside), 'utf8'), '[{"id":', 'exactly as it was');
  assert.match(serverLog, /transfers\.json could not be read/, 'and the log says so');
  log('an unreadable list of transfers is kept aside, not written over');

  // With no token, what keeps other websites out is the browser's same-origin rule, and a page
  // can step around it by pointing its own domain name at this machine (DNS rebinding): its
  // requests are then same-origin, and carry that name as their Host. Such a server answers
  // only to localhost, an IP address, and the names in ALLOWED_HOSTS.
  const port = new URL(serverUrl).port;
  const planted = randomBytes(20).toString('hex');
  const plant = JSON.stringify({ magnet: `magnet:?xt=urn:btih:${planted}` });
  const rebound = { Host: `rebind.example:${port}`, Origin: `http://rebind.example:${port}` };
  assert.equal(await raw('/api/transfers', { method: 'POST', headers: { ...rebound, 'Content-Type': 'application/json' }, body: plant }), 403, 'a rebound page adds nothing');
  assert.equal(await raw('/api/transfers', { headers: rebound }), 403, 'lists nothing');
  assert.equal(await raw('/api/transfers', { method: 'POST', headers: { Host: `localhost:${port}`, 'Content-Type': 'application/json' }, body: plant }), 201, 'while localhost is answered');
  assert.equal(await raw(`/api/transfers/${planted}`, { method: 'DELETE', headers: rebound }), 403, 'and a rebound page deletes nothing');
  for (const host of [`127.0.0.1:${port}`, `[::1]:${port}`, `app.localhost:${port}`, `nas.local:${port}`, 'nas.local', `media.lan:${port}`, `files.lan:${port}`, `files.lan.:${port}`]) {
    assert.equal(await raw('/api/transfers', { headers: { Host: host } }), 200, `${host} is answered`);
  }
  assert.match(serverLog, /or nas\.local, media\.lan, files\.lan$/m, 'and the log lists the names it took, as it compares them');
  // A site named in ALLOWED_ORIGINS is another website that may write. It was named by the
  // address of its page, path and all; a browser sends only the origin, and that matches.
  const hostedPreflight = await fetch(`${serverUrl}/api/transfers`, { method: 'OPTIONS', headers: { Origin: 'https://hosted.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(hostedPreflight.headers.get('access-control-allow-origin'), 'https://hosted.example', 'an origin given as a page address is the origin');
  assert.match(serverLog, /hosted\.example(?!\/)/, 'and the log says which origins it took');
  const hosted = await fetch(`${serverUrl}/api/transfers/${planted}`, { method: 'DELETE', headers: { Origin: 'https://hosted.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(hosted.status, 200, 'the site named in ALLOWED_ORIGINS may delete');
  log('with no token, only localhost, an IP address or ALLOWED_HOSTS is answered');

  // A second name for the downloads folder does not make its files static ones: a link here,
  // and on macOS or Windows, whose disks ignore case, "Downloads" is one already.
  if (!existsSync(path.join(web, 'DOWNLOADS'))) symlinkSync('downloads', path.join(web, 'Downloads'));
  assert.equal((await fetch(`${serverUrl}/index.html`)).status, 200, 'the web root is served');
  assert.equal((await fetch(`${serverUrl}/downloads/Some.Movie/movie.mkv`)).status, 404, 'its downloads are not');
  assert.equal((await fetch(`${serverUrl}/Downloads/Some.Movie/movie.mkv`)).status, 404, 'under another name either');
  assert.equal((await fetch(`${serverUrl}/Downloads/transfers.json`)).status, 404, 'nor is the list of transfers');
  log('the downloads are not static files under any other name');

  // A transfer an older server saved as a bare magnet, whose metadata never came back: it
  // keeps its name, and deleting it still takes its file. A folder of that name could hold
  // anything, and without the metadata nothing says which of it is the transfer's: it stays.
  await stopServer();
  const orphan = randomBytes(20).toString('hex');
  const orphanFolder = randomBytes(20).toString('hex');
  writeFileSync(path.join(webDownloads, 'transfers.json'), JSON.stringify([
    { id: orphan, source: `magnet:?xt=urn:btih:${orphan}`, addedAt: Date.now(), name: 'orphan.bin' },
    { id: orphanFolder, source: `magnet:?xt=urn:btih:${orphanFolder}`, addedAt: Date.now(), name: 'Some.Movie' },
  ]));
  writeFileSync(path.join(webDownloads, 'orphan.bin'), randomBytes(1024));
  await startServer(tokenless);
  const { transfer: stuck } = await (await fetch(`${serverUrl}/api/transfers/${orphan}`)).json();
  assert.equal(stuck.name, 'orphan.bin', 'a transfer with no metadata keeps its name');
  assert.equal((await fetch(`${serverUrl}/api/transfers/${orphan}`, { method: 'DELETE' })).status, 200);
  assert.ok(!existsSync(path.join(webDownloads, 'orphan.bin')), 'and deleting it takes its file');
  assert.equal((await fetch(`${serverUrl}/api/transfers/${orphanFolder}`, { method: 'DELETE' })).status, 200);
  assert.ok(existsSync(path.join(webDownloads, 'Some.Movie', 'movie.mkv')), 'but not a folder of its name');
  log('a transfer with no metadata keeps its name, and its file goes with it; a folder does not');

  // The Cloudflare Worker, as a plain module. What it imports, @cloudflare/containers, is not
  // installed here, so a stand-in takes its place with the little the Worker touches: the
  // Worker's own code is what runs.
  const stubDir = path.join(tmp, 'containers-stub');
  mkdirSync(stubDir);
  writeFileSync(path.join(stubDir, 'containers.mjs'), [
    'export class Container { constructor(ctx, env) { this.ctx = ctx; this.env = env; this.container = ctx.container; } }',
    'export const getContainer = (binding) => binding.get(binding.idFromName("singleton"));',
  ].join('\n'));
  writeFileSync(path.join(stubDir, 'hooks.mjs'), `export async function resolve(specifier, context, next) {
    return specifier === '@cloudflare/containers' ? { url: ${JSON.stringify(pathToFileURL(path.join(stubDir, 'containers.mjs')).href)}, shortCircuit: true } : next(specifier, context);
  }`);
  register(pathToFileURL(path.join(stubDir, 'hooks.mjs')));
  const { default: cfWorker, TorrentContainer } = await import('../cloudflare/worker.js');

  // Deployed with no AUTH_TOKEN, the container would be a torrent client anyone on the
  // internet can drive, and every website too. The Worker does not start it.
  let started = 0;
  const TORRENT = { idFromName: (name) => name, get: () => ({ fetch: async () => { started++; return new Response('the container'); } }) };
  for (const env of [{ TORRENT }, { TORRENT, AUTH_TOKEN: '  ' }]) {
    const res = await cfWorker.fetch(new Request('https://phone-torrent.example.workers.dev/api/transfers'), env);
    assert.equal(res.status, 503, `the Cloudflare Worker refuses with ${JSON.stringify(env.AUTH_TOKEN)} as the token`);
    assert.match((await res.json()).error, /wrangler secret put AUTH_TOKEN/, 'and says how to set one');
  }
  assert.equal(started, 0, 'without ever starting the container');
  const forwarded = await cfWorker.fetch(new Request('https://phone-torrent.example.workers.dev/'), { TORRENT, AUTH_TOKEN: 'k' });
  assert.equal(await forwarded.text(), 'the container', 'with a token, every request goes to the container');
  log('the Cloudflare Worker will not run the server without a token');

  // Half an hour after the last request, the library stops the container, and its disk goes
  // with it. A download's own traffic is not a request, so the server is asked first.
  const minute = 60 * 1000;
  async function expire(answer, { running = true } = {}) {
    const box = new TorrentContainer({ container: { running } }, { AUTH_TOKEN: 'k' });
    const seen = { stopped: false, asked: [] };
    box.containerFetch = async (req) => {
      seen.asked.push(`${new URL(req.url).pathname} ${req.headers.get('authorization')}`);
      if (answer instanceof Error) throw answer;
      return Response.json({ transfers: answer });
    };
    box.stop = async () => { seen.stopped = true; };
    await box.onActivityExpired();
    return seen;
  }
  const downloading = await expire([{ id: 'a', ready: false, progress: 0.4, receivedAt: Date.now() - 5 * minute }]);
  assert.equal(downloading.stopped, false, 'a download that got data in the last half hour keeps the container up');
  assert.deepEqual(downloading.asked, ['/api/transfers Bearer k'], 'the server is asked for its transfers, with the token');
  assert.equal((await expire([{ id: 'a', ready: true, progress: 1, receivedAt: Date.now() - 10 * minute }])).stopped, false, 'so does one that finished less than half an hour ago');
  assert.equal((await expire([{ id: 'a', ready: false, progress: 0.4, receivedAt: Date.now() - 31 * minute }, { id: 'b', ready: false, progress: 0 }])).stopped, true, 'torrents that got nothing for half an hour do not');
  assert.equal((await expire([{ id: 'a', ready: true, progress: 1, receivedAt: Date.now() - 40 * minute }])).stopped, true, 'nor do files finished long ago');
  assert.equal((await expire([])).stopped, true, 'nor does nothing at all');
  assert.equal((await expire(new Error('no answer'))).stopped, true, 'a server that does not answer is stopped');
  assert.deepEqual((await expire([], { running: false })).asked, [], 'and a stopped container is not started to be asked');
  log('the Cloudflare container stays up while a download is getting data, and not for ever');

  // The CORS proxy lets through what the app's requests carry. WebTorrent fetches every piece
  // from a web seed with Cache-Control: no-store, and Firefox asks about the User-Agent it sets.
  const preflight = await proxyWorker.fetch(new Request('https://proxy.example/?url=https%3A%2F%2Fmirror.example%2Ffile.bin', {
    method: 'OPTIONS',
    headers: { Origin: 'https://me.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'cache-control,range,user-agent' },
  }), { ALLOWED_ORIGINS: 'https://me.example' });
  assert.equal(preflight.status, 204);
  const allowedHeaders = (preflight.headers.get('access-control-allow-headers') || '').toLowerCase().split(/\s*,\s*/);
  for (const header of ['cache-control', 'range', 'user-agent']) {
    assert.ok(allowedHeaders.includes(header), `the CORS proxy allows ${header}, which a web seed request carries`);
  }
  log('the CORS proxy passes the preflight of a web seed request');

  // ALLOWED_ORIGINS set to the app's address as the user sees it, path or final slash and all: a
  // browser sends only the origin, and that is what the entry means, as it does for the server. The
  // proxy's refusal carries no CORS header, so all the app could ever say about it was "CORS or network".
  const proxyPreflight = (origin, allowed) => proxyWorker.fetch(new Request('https://proxy.example/?url=https%3A%2F%2Fmirror.example%2Ffile.bin', {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
  }), { ALLOWED_ORIGINS: allowed });
  for (const allowed of ['https://me.example/', 'https://me.example/phone-torrent/', 'https://elsewhere.example, https://me.example/phone-torrent/']) {
    const answer = await proxyPreflight('https://me.example', allowed);
    assert.equal(answer.status, 204, `the CORS proxy takes "${allowed}" as the origin it names`);
    assert.equal(answer.headers.get('access-control-allow-origin'), 'https://me.example');
  }
  assert.equal((await proxyPreflight('https://other.example', 'https://me.example/phone-torrent/')).status, 403, 'and still refuses any other');
  log('the CORS proxy takes an allowed origin written as the address of the app');

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
