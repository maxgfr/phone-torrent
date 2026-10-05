/* The local server against the real internet: an archive.org item, in the public domain.
 *
 * Not part of the CI: it needs the network, and archive.org. `npm run smoke:archive` starts the server
 * as `npm run local` does, in a directory of its own, sends it the item's .torrent, leaves one of its
 * files out, pauses and resumes, restarts, and removes it with and without its files. What arrives is
 * checked against the checksums archive.org lists for the item.
 *
 * Only media files are fetched: an item's _meta.xml and _files.xml change after its .torrent is made,
 * and would never match it. SMOKE_ITEM names another item (in the public domain, please).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import parseTorrent from 'parse-torrent';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Franz Kafka, "Auf der Galerie", read for LibriVox: the text and the recording are in the public domain.
const ITEM = process.env.SMOKE_ITEM || 'kafka_galerie_librivox';
const MEDIA = /\.(mp3|ogg|m4b|flac|mp4|ogv)$/i;
const log = (...a) => console.log('•', ...a);
const digest = (algo, buf) => createHash(algo).update(buf).digest('hex');

setTimeout(() => {
  console.error('\nWATCHDOG: the archive.org smoke test took more than 10 minutes');
  process.exit(2);
}, 10 * 60 * 1000).unref();

async function waitFor(fn, { timeout = 120000, interval = 250, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** A port nothing listens on yet, for BitTorrent and the DHT. */
function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const dir = mkdtempSync(path.join(tmpdir(), 'swarmdeck-archive-'));
const ports = { TORRENT_PORT: String(await freePort()), DHT_PORT: String(await freePort()) };
let server = null;
let base = '';

async function startServer() {
  base = '';
  let said = '';
  server = spawn(process.execPath, [path.join(HERE, '..', 'server', 'app.mjs'), '--local', '--no-open'], {
    env: { ...process.env, PORT: '0', HOST: '', AUTH_TOKEN: '', DOWNLOAD_DIR: dir, ...ports },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const read = (d) => {
    said += d;
    const m = said.match(/swarmdeck server on http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) base = `http://127.0.0.1:${m[1]}`;
  };
  server.stdout.on('data', read);
  server.stderr.on('data', (d) => { read(d); process.stderr.write(`  server: ${d}`); });
  await waitFor(() => base, { label: 'the server to listen', timeout: 20000 });
}

async function stopServer() {
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
}

const api = (p, init) => fetch(`${base}${p}`, { ...init, signal: AbortSignal.timeout(30000) });
const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const transfer = async (id) => (await (await api(`/api/transfers/${id}?detail=1`)).json()).transfer;

let failed = false;
try {
  const metadata = await (await fetch(`https://archive.org/metadata/${ITEM}`)).json();
  assert.ok(metadata.files, `archive.org knows ${ITEM}`);
  log(ITEM, '·', metadata.metadata.title, '·', metadata.metadata.licenseurl || 'no license URL');
  const sums = new Map(metadata.files.map((f) => [f.name, f]));
  const torrentBytes = Buffer.from(await (await fetch(`https://archive.org/download/${ITEM}/${ITEM}_archive.torrent`)).arrayBuffer());
  const parsed = await parseTorrent(torrentBytes);
  assert.ok(parsed.urlList.length, 'archive.org lists itself as a web seed');

  // The media files the item lists checksums for; the largest of them is left out.
  const inItem = (f) => f.path.split(/[\\/]/).slice(1).join('/');
  const media = parsed.files.map((f, i) => ({ i, name: inItem(f), length: f.length }))
    .filter((f) => MEDIA.test(f.name) && sums.get(f.name)?.md5 && Number(sums.get(f.name).size) === f.length)
    .sort((a, b) => b.length - a.length);
  assert.ok(media.length >= 2, `the item has two media files at least (${media.map((f) => f.name).join(', ')})`);
  const [leftOut, ...kept] = media;
  const keptIdx = new Set(kept.map((f) => f.i));
  const deselected = parsed.files.map((_, i) => i).filter((i) => !keptIdx.has(i));
  const keptBytes = kept.reduce((n, f) => n + f.length, 0);
  log(`fetching ${kept.map((f) => f.name).join(', ')} (${keptBytes} B), leaving out ${leftOut.name} and ${deselected.length - 1} other file(s)`);

  await startServer();
  const health = await (await api('/api/health')).json();
  assert.equal(health.local, true);
  assert.equal((await api('/api/transfers?paused=1', { method: 'POST', headers: { 'Content-Type': 'application/x-bittorrent' }, body: torrentBytes })).status, 201);
  const id = parsed.infoHash;
  await waitFor(async () => {
    const t = await transfer(id);
    return t.metadata && !t.checking;
  }, { label: 'the torrent to be checked', timeout: 30000 });
  assert.equal((await post(`/api/transfers/${id}`, { deselected })).status, 200);
  assert.equal((await post(`/api/transfers/${id}`, { paused: false })).status, 200);

  // Paused as soon as something arrives: the web seed is cut, and nothing more comes for 3 s.
  const started = await waitFor(async () => {
    const t = await transfer(id);
    return t.downloaded > 0 ? t : false;
  }, { label: 'the first bytes from archive.org', timeout: 120000, interval: 50 });
  assert.equal((await post(`/api/transfers/${id}`, { paused: true })).status, 200);
  await waitFor(async () => (await transfer(id)).peers === 0, { label: 'every wire to close', timeout: 2000, interval: 100 });
  await new Promise((r) => setTimeout(r, 500));
  const pausedAt = await transfer(id);
  await new Promise((r) => setTimeout(r, 3000));
  const stillPaused = await transfer(id);
  assert.ok(!pausedAt.ready, `paused before the end (${pausedAt.downloaded} of ${keptBytes} B): pick a larger SMOKE_ITEM if this one is too quick`);
  assert.equal(stillPaused.downloaded, pausedAt.downloaded, 'nothing arrives while it is paused');
  log(`paused at ${pausedAt.downloaded} B (${started.peers} peer(s) before), nothing arrived for 3 s`);

  assert.equal((await post(`/api/transfers/${id}`, { paused: false })).status, 200);
  const done = await waitFor(async () => {
    const t = await transfer(id);
    return t.ready ? t : false;
  }, { label: 'the files wanted to arrive', timeout: 480000, interval: 1000 });
  assert.equal(done.detail.files[leftOut.i].done, false, 'the file left out is not fetched');
  for (const f of kept) {
    const bytes = Buffer.from(await (await api(`/api/transfers/${id}/files/${f.i}`)).arrayBuffer());
    assert.equal(digest('md5', bytes), sums.get(f.name).md5, `${f.name}: the md5 archive.org lists`);
    if (sums.get(f.name).sha1) assert.equal(digest('sha1', bytes), sums.get(f.name).sha1, `${f.name}: and its sha1`);
    assert.equal(digest('md5', readFileSync(path.join(dir, parsed.files[f.i].path))), sums.get(f.name).md5, `${f.name}: on the disk too`);
  }
  log('resumed, the files wanted arrived, and their checksums are the ones archive.org lists');

  await stopServer();
  await startServer();
  const back = await waitFor(async () => {
    const t = await transfer(id);
    return t && t.metadata && !t.checking ? t : false;
  }, { label: 'the transfer to be checked after a restart', timeout: 60000 });
  assert.equal(back.ready, true, 'after a restart the files are there');
  assert.deepEqual(back.deselected, deselected, 'and the same files are left out');
  log('a restart finds everything where it was');

  const onDisk = () => kept.every((f) => existsSync(path.join(dir, parsed.files[f.i].path)));
  assert.equal((await api(`/api/transfers/${id}?keepFiles=1`, { method: 'DELETE' })).status, 200);
  assert.ok(onDisk(), 'removed keeping its files, they stay');
  assert.equal((await api('/api/transfers?paused=1', { method: 'POST', headers: { 'Content-Type': 'application/x-bittorrent' }, body: torrentBytes })).status, 201);
  const again = await waitFor(async () => {
    const t = await transfer(id);
    return t && t.metadata && !t.checking ? t : false;
  }, { label: 'the torrent added again to be checked', timeout: 60000 });
  assert.ok(kept.every((f) => again.detail.files[f.i].done), 'added again, it has them from the disk');
  assert.equal((await api(`/api/transfers/${id}`, { method: 'DELETE' })).status, 200);
  await waitFor(() => !onDisk() && !existsSync(path.join(dir, parsed.name)), { label: 'its files and folder to go', timeout: 10000 });
  log('removed keeping its files, then added again from the disk; removed with them, they go');

  console.log('\narchive.org smoke test passed.');
} catch (err) {
  failed = true;
  console.error('\nARCHIVE SMOKE TEST FAILED:', err);
} finally {
  if (server) await stopServer();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
