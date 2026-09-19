/* End-to-end test.
 *
 * Boots a local WebSocket tracker and a static server, seeds a two-file
 * torrent from one browser context and downloads it in another (the "phone"),
 * exercising the real UI: .torrent file input, per-file save, zip save, and
 * restore after reload from the browser's private storage.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
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

const log = (...a) => console.log('•', ...a);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function waitFor(fn, { timeout = 60000, interval = 250, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

const tracker = new TrackerServer({ udp: false, http: false, ws: true, stats: false });
await new Promise((resolve) => tracker.listen(0, '127.0.0.1', resolve));
const trackerUrl = `ws://127.0.0.1:${tracker.ws.address().port}`;
log('tracker at', trackerUrl);

const site = await startServer(0);
log('site at', site.url);

const browser = await chromium.launch({ executablePath: findChromium(), args: ['--allow-insecure-localhost'] });

let failed = false;
try {
  /* ---------- seeder ---------- */
  const seederCtx = await browser.newContext();
  const seeder = await seederCtx.newPage();
  seeder.on('pageerror', (e) => console.error('seeder page error:', e));
  await seeder.addInitScript((t) => localStorage.setItem('phone-torrent:settings', JSON.stringify({ trackers: [t] })), trackerUrl);
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
  const torrentFile = await seeder.evaluate(() => Array.from(window.__phoneTorrent.client.torrents[0].torrentFile));
  assert.equal(await seeder.$eval('.torrent .name', (e) => e.textContent), 'Phone Torrent Test');
  assert.ok(!(await seeder.$eval('.torrent .details', (e) => e.hidden)), 'details open automatically after seeding starts');
  assert.match(await seeder.$eval('.torrent .d-infohash', (e) => e.textContent), /^[a-f0-9]{40}$/);
  await seeder.setViewportSize({ width: 390, height: 844 });
  await seeder.screenshot({ path: path.join(TMP, 'seeder.png'), fullPage: true });
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
  await phone.addInitScript((t) => localStorage.setItem('phone-torrent:settings', JSON.stringify({ trackers: [t] })), trackerUrl);
  await phone.goto(site.url);
  await phone.waitForFunction(() => window.__phoneTorrent?.client);

  const saverMode = await phone.evaluate(() => new Promise((resolve) => {
    const t = setInterval(() => {
      const s = window.__phoneTorrent.saver;
      if (s.mode === 'stream' || s.reason) { clearInterval(t); resolve(s.mode); }
    }, 50);
  }));
  log('saver mode:', saverMode);
  assert.equal(saverMode, 'stream', 'service worker streaming should be active on localhost');

  // Add through the real file input, as a user picking a .torrent from their phone would.
  await phone.setInputFiles('#torrent-file-input', {
    name: 'test.torrent',
    mimeType: 'application/x-bittorrent',
    buffer: Buffer.from(torrentFile),
  });

  await phone.waitForSelector('.torrent .file', { timeout: 15000 });
  const names = await phone.$$eval('.torrent .file .file-name', (els) => els.map((e) => e.textContent));
  assert.deepEqual([...names].sort(), files.map((f) => f.name).sort());
  log('file list rendered:', names.join(', '));

  await waitFor(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { label: 'download to finish', timeout: 90000 });
  log('download complete');
  assert.ok((await phone.$$('.torrent .save-btn:not([disabled])')).length === 2, 'both Save buttons enabled');
  assert.ok(await phone.$('.torrent .zip-btn:not([disabled])'), 'zip button enabled');

  // Pause / resume.
  await phone.click('.torrent .pause-btn');
  assert.ok(await phone.$('.torrent.paused'), 'torrent shows paused');
  assert.equal(await phone.$eval('.torrent .state', (e) => e.textContent), 'paused');
  assert.equal(await phone.evaluate(() => window.__phoneTorrent.client.torrents[0].paused), true);
  await phone.click('.torrent .pause-btn');
  assert.equal(await phone.evaluate(() => window.__phoneTorrent.client.torrents[0].paused), false);
  assert.ok(!(await phone.$('.torrent.paused')), 'torrent resumed');
  log('pause/resume OK');

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
  assert.deepEqual(Array.from(readFileSync(torrentDlPath)), torrentFile, '.torrent file round-trips');
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

  // Reload: the torrent must come back from storage, already complete.
  await phone.reload();
  await phone.waitForSelector('.torrent .file', { timeout: 15000 });
  await waitFor(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { label: 'restored torrent to verify', timeout: 30000 });
  log('restored after reload with all pieces intact');

  await phone.screenshot({ path: path.join(TMP, 'phone.png'), fullPage: true });
  await phone.click('#settings-btn');
  await phone.waitForSelector('#settings-dialog[open]');
  await phone.screenshot({ path: path.join(TMP, 'settings.png') });
  await phone.keyboard.press('Escape');

  // Removing deletes it from the list and from the persisted set.
  phone.once('dialog', (d) => d.accept());
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
  await Promise.all([phone.waitForNavigation(), phone.evaluate(() => document.getElementById('f').submit())]);
  assert.equal(new URL(phone.url()).pathname, new URL(site.url).pathname, 'share target redirects back to the app');
  await phone.waitForSelector('.torrent .file', { timeout: 15000 });
  assert.equal(await phone.$eval('.torrent .name', (e) => e.textContent), 'Phone Torrent Test');
  await waitFor(() => phone.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { label: 'shared torrent download', timeout: 90000 });
  log('share target OK');

  // Opening the app with a magnet in the URL adds it (protocol handler / shared link).
  await phone.goto(`${site.url}?magnet=${encodeURIComponent('magnet:?xt=urn:btih:' + '0'.repeat(40) + '&dn=fake')}`);
  await phone.waitForSelector('.torrent', { timeout: 15000 });
  await waitFor(() => phone.$$('.torrent').then((l) => l.length === 2), { label: 'magnet from URL to be added' });
  assert.equal(new URL(phone.url()).search, '', 'query string is cleaned up');
  log('magnet from URL OK');

  /* ---------- fallback: browser without service workers ---------- */
  const legacyCtx = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  const legacy = await legacyCtx.newPage();
  legacy.on('pageerror', (e) => console.error('legacy page error:', e));
  await legacy.addInitScript((t) => localStorage.setItem('phone-torrent:settings', JSON.stringify({ trackers: [t] })), trackerUrl);
  await legacy.goto(site.url);
  await legacy.waitForFunction(() => window.__phoneTorrent?.client);
  const legacyMode = await legacy.evaluate(() => new Promise((resolve) => {
    const t = setInterval(() => {
      const s = window.__phoneTorrent.saver;
      if (s.mode === 'stream' || s.reason) { clearInterval(t); resolve(s.mode); }
    }, 50);
  }));
  assert.equal(legacyMode, 'blob', 'falls back to in-memory saving without a service worker');
  await legacy.setInputFiles('#torrent-file-input', { name: 'test.torrent', mimeType: 'application/x-bittorrent', buffer: Buffer.from(torrentFile) });
  await legacy.waitForSelector('.torrent .file', { timeout: 15000 });
  await waitFor(() => legacy.$eval('.torrent .pct', (e) => e.textContent === '100%').catch(() => false), { label: 'legacy download', timeout: 90000 });
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
  tracker.close();
  process.exit(failed ? 1 : 0);
}
