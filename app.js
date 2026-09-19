import WebTorrent from './vendor/webtorrent.min.js';
import { makeZip, predictLength } from './vendor/client-zip.js';
import { saver } from './saver.js';

const DEFAULT_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.files.fm:7073/announce',
];

const SETTINGS_KEY = 'phone-torrent:settings';
const DB_NAME = 'phone-torrent';
const DB_STORE = 'torrents';
const INBOX_CACHE = 'phone-torrent-inbox';
const DEBUG_NAMESPACES = 'webtorrent*,bittorrent-tracker*,simple-peer*';
const TRACKER_LIST_KEY = 'phone-torrent:trackerlist';
const TRACKER_LIST_TTL = 6 * 60 * 60 * 1000;
const DEFAULT_TRACKER_LIST_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_ws.txt';
// Torrent caches that serve a .torrent by info hash. Tried only when peers never deliver the metadata.
const DEFAULT_METADATA_SOURCES = [
  'https://itorrents.org/torrent/{INFOHASH}.torrent',
  'https://torrage.info/torrent.php?h={INFOHASH}',
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const els = {
  torrents: $('#torrents'),
  empty: $('#empty-state'),
  fileInput: $('#torrent-file-input'),
  magnetForm: $('#magnet-form'),
  magnetInput: $('#magnet-input'),
  seedFileInput: $('#seed-file-input'),
  seedUrlForm: $('#seed-url-form'),
  seedUrlInput: $('#seed-url-input'),
  dropZone: $('#drop-zone'),
  netStatus: $('#net-status'),
  settingsBtn: $('#settings-btn'),
  settingsDialog: $('#settings-dialog'),
  trackersInput: $('#trackers-input'),
  trackerListToggle: $('#trackerlist-toggle'),
  trackerListUrl: $('#trackerlist-url'),
  trackerListInfo: $('#trackerlist-info'),
  downLimit: $('#down-limit'),
  upLimit: $('#up-limit'),
  seedAfterToggle: $('#seed-after-toggle'),
  strategySelect: $('#strategy-select'),
  installBtn: $('#install-btn'),
  metaSourcesInput: $('#metasources-input'),
  corsProxyInput: $('#corsproxy-input'),
  fallbackDelayInput: $('#fallback-delay'),
  rtcInput: $('#rtc-input'),
  wakelockToggle: $('#wakelock-toggle'),
  debugToggle: $('#debug-toggle'),
  resetTrackersBtn: $('#reset-trackers-btn'),
  clearStorageBtn: $('#clear-storage-btn'),
  copyDiagBtn: $('#copy-diag-btn'),
  storageInfo: $('#storage-info'),
  saverInfo: $('#saver-info'),
  clientInfo: $('#client-info'),
  toasts: $('#toasts'),
  torrentTemplate: $('#torrent-template'),
  fileTemplate: $('#file-template'),
};

/* ---------- settings ---------- */

function loadSettings() {
  const defaults = {
    trackers: [...DEFAULT_TRACKERS],
    rtcConfig: null,
    wakeLock: true,
    trackerList: true,
    trackerListUrl: DEFAULT_TRACKER_LIST_URL,
    downloadLimit: 0, // KB/s, 0 = unlimited
    uploadLimit: 0,
    seedAfterDone: true,
    strategy: 'sequential',
    metadataSources: [...DEFAULT_METADATA_SOURCES],
    corsProxy: '',
    fallbackDelay: 20, // seconds
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...defaults, ...parsed, trackers: Array.isArray(parsed.trackers) && parsed.trackers.length ? parsed.trackers : defaults.trackers };
    }
  } catch { /* ignore */ }
  return defaults;
}

function saveSettings(next) {
  settings = next;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

let settings = loadSettings();

function debugEnabled() {
  try { return Boolean(localStorage.getItem('debug')); } catch { return false; }
}

/* ---------- public tracker list (qBittorrent-style "automatically add trackers") ---------- */

function loadTrackerListCache() {
  try {
    const raw = localStorage.getItem(TRACKER_LIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.trackers) ? parsed : null;
  } catch {
    return null;
  }
}

function parseTrackerList(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^wss?:\/\//i.test(l));
}

/** All trackers to announce to: the user's list plus the fetched public list, deduplicated. */
function effectiveTrackers() {
  const extra = settings.trackerList ? (loadTrackerListCache()?.trackers || []) : [];
  return Array.from(new Set([...settings.trackers, ...extra]));
}

async function refreshTrackerList({ force = false } = {}) {
  if (!settings.trackerList || !/^https?:\/\//i.test(settings.trackerListUrl || '')) return null;
  const cached = loadTrackerListCache();
  if (!force && cached && cached.url === settings.trackerListUrl && Date.now() - cached.fetchedAt < TRACKER_LIST_TTL) return cached;
  try {
    const res = await fetch(settings.trackerListUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const trackers = parseTrackerList(await res.text());
    const record = { url: settings.trackerListUrl, fetchedAt: Date.now(), trackers };
    try { localStorage.setItem(TRACKER_LIST_KEY, JSON.stringify(record)); } catch { /* ignore */ }
    applyTrackers();
    return record;
  } catch (err) {
    console.warn('tracker list fetch failed', err);
    return cached;
  }
}

function applyTrackers() {
  client.tracker.announce = effectiveTrackers();
}

function applySpeedLimits() {
  client.throttleDownload(settings.downloadLimit > 0 ? settings.downloadLimit * 1024 : -1);
  client.throttleUpload(settings.uploadLimit > 0 ? settings.uploadLimit * 1024 : -1);
}

/* ---------- persistence of added torrents (so a reload restores them) ---------- */

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE, { keyPath: 'infoHash' });
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

function runTx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const req = fn(tx.objectStore(DB_STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

async function dbAll() {
  try { return (await runTx('readonly', (store) => store.getAll())) || []; } catch { return []; }
}

async function dbPut(record) {
  try { await runTx('readwrite', (store) => store.put(record)); } catch { /* ignore */ }
}

async function dbDelete(infoHash) {
  try { await runTx('readwrite', (store) => store.delete(infoHash)); } catch { /* ignore */ }
}

async function dbClear() {
  try { await runTx('readwrite', (store) => store.clear()); } catch { /* ignore */ }
}

/** Our OPFS store directories are named "<torrent name> - <first 8 hex of info hash>". */
const STORE_DIR_RE = / - ([a-f0-9]{8})$/;

/** Remove OPFS directories that belong to no remembered torrent (closed seeds, failed removals). */
async function cleanOrphanStores(records) {
  if (!navigator.storage?.getDirectory) return;
  try {
    const root = await navigator.storage.getDirectory();
    const known = new Set(records.map((r) => String(r.infoHash).slice(0, 8)));
    for await (const name of root.keys()) {
      const m = name.match(STORE_DIR_RE);
      if (m && !known.has(m[1])) await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  } catch { /* ignore */ }
}

/* ---------- helpers ---------- */

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function formatEta(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s left`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m left`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m left`;
}

function formatSpeed(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function toast(message, { error = false, timeout = 4500 } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

function parseTorrentText(text) {
  const t = (text || '').trim();
  if (!t) return null;
  if (/^magnet:\?/i.test(t)) return t;
  if (/^[a-f0-9]{40}$/i.test(t) || /^[a-z2-7]{32}$/i.test(t)) return `magnet:?xt=urn:btih:${t}`;
  if (/^https?:\/\/\S+$/i.test(t)) return t;
  const embedded = t.match(/magnet:\?\S+/i);
  if (embedded) return embedded[0];
  return null;
}

function safeDecode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

function describeTorrentId(id) {
  if (typeof id !== 'string') return 'a .torrent file';
  if (/^magnet:/i.test(id)) {
    const dn = new URLSearchParams(id.slice(id.indexOf('?') + 1)).get('dn');
    const hash = id.match(/btih:([a-z0-9]+)/i);
    return dn ? `"${dn}"` : hash ? `info hash ${hash[1]}` : 'a magnet link';
  }
  return id;
}

/** Torrents that arrive from outside the app (shared, magnet: handler, URL) need a tap first. */
function confirmExternalAdd(label) {
  return confirm(`Add ${label} to Phone Torrent and start downloading it?`);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

function appLinkFor(torrent) {
  return `${location.origin}${location.pathname}#${torrent.magnetURI}`;
}

/* ---------- fallback "resolvers": metadata caches, fresh trackers, web seeds ---------- */

function proxied(url) {
  const tpl = (settings.corsProxy || '').trim();
  return tpl && tpl.includes('{url}') ? tpl.replace('{url}', encodeURIComponent(url)) : url;
}

function fallbackDelayMs() {
  return Math.max(5, Number(settings.fallbackDelay) || 20) * 1000;
}

/**
 * Minimal bencode walker: returns the [start, end) byte span of the top-level "info" dictionary,
 * so its SHA-1 can be compared with the expected info hash before trusting a downloaded .torrent.
 */
function findInfoSpan(bytes) {
  let pos = 0;
  const dec = new TextDecoder();
  const fail = () => { throw new Error('not a valid .torrent file'); };
  function skip() {
    const c = bytes[pos];
    if (c === 0x69) { // i<int>e
      const e = bytes.indexOf(0x65, pos);
      if (e < 0) fail();
      pos = e + 1;
    } else if (c === 0x6c || c === 0x64) { // l / d
      pos++;
      while (bytes[pos] !== 0x65) { if (pos >= bytes.length) fail(); skip(); }
      pos++;
    } else if (c >= 0x30 && c <= 0x39) { // <len>:<bytes>
      const colon = bytes.indexOf(0x3a, pos);
      if (colon < 0) fail();
      const len = Number(dec.decode(bytes.subarray(pos, colon)));
      if (!Number.isFinite(len)) fail();
      pos = colon + 1 + len;
    } else fail();
  }
  if (bytes[pos] !== 0x64) fail();
  pos++;
  while (bytes[pos] !== 0x65) {
    const colon = bytes.indexOf(0x3a, pos);
    if (colon < 0) fail();
    const len = Number(dec.decode(bytes.subarray(pos, colon)));
    const key = dec.decode(bytes.subarray(colon + 1, colon + 1 + len));
    pos = colon + 1 + len;
    const start = pos;
    skip();
    if (key === 'info') return [start, pos];
  }
  fail();
}

async function verifyTorrentBytes(bytes, expectedInfoHash) {
  const [start, end] = findInfoSpan(bytes);
  const digest = await crypto.subtle.digest('SHA-1', bytes.subarray(start, end));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== expectedInfoHash.toLowerCase()) throw new Error('info hash mismatch');
  return bytes;
}

/** Fetch the .torrent for an info hash from the configured caches; resolves with verified bytes or null. */
async function fetchMetadataFallback(infoHash, onAttempt = () => {}) {
  for (const template of settings.metadataSources || []) {
    const url = template.replace(/\{infohash\}/gi, (m) => (m === m.toUpperCase() ? infoHash.toUpperCase() : infoHash));
    try {
      const res = await fetch(proxied(url), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await verifyTorrentBytes(bytes, infoHash);
      onAttempt(url, null);
      return bytes;
    } catch (err) {
      // A TypeError from fetch almost always means the cache does not allow browser (CORS) requests.
      onAttempt(url, err instanceof TypeError ? new Error('blocked by CORS or unreachable') : err);
    }
  }
  return null;
}

/* ---------- WebTorrent client ---------- */

const clientOpts = { tracker: { announce: settings.trackers } };
if (settings.rtcConfig && typeof settings.rtcConfig === 'object') clientOpts.tracker.rtcConfig = settings.rtcConfig;

const client = new WebTorrent(clientOpts);
applyTrackers();
applySpeedLimits();

client.on('error', (err) => toast(err.message || String(err), { error: true }));

/** @type {Map<any, {torrent: any, el: HTMLElement, fileEls: HTMLElement[], record: any, seeding: boolean, log: string[]}>} */
const views = new Map();

function updateEmptyState() {
  els.empty.hidden = client.torrents.length > 0;
}

const LOG_LIMIT = 60;

function logEvent(view, message) {
  const logEl = $('.log', view.el);
  logEl.hidden = false;
  // Collapse repeats (tracker reconnect warnings fire endlessly) into one line with a counter.
  if (view.lastLogMessage === message && logEl.lastElementChild) {
    view.lastLogCount = (view.lastLogCount || 1) + 1;
    const line = `${new Date().toLocaleTimeString()}  ${message} (×${view.lastLogCount})`;
    view.log[view.log.length - 1] = line;
    logEl.lastElementChild.textContent = line;
    return;
  }
  view.lastLogMessage = message;
  view.lastLogCount = 1;
  const line = `${new Date().toLocaleTimeString()}  ${message}`;
  view.log.push(line);
  if (view.log.length > LOG_LIMIT) view.log.shift();
  const li = document.createElement('li');
  li.textContent = line;
  logEl.appendChild(li);
  while (logEl.children.length > LOG_LIMIT) logEl.firstElementChild.remove();
}

async function addTorrent(id, { record } = {}) {
  const existing = await client.get(id).catch(() => null);
  if (existing) {
    toast(`"${existing.name || existing.infoHash}" is already in the list.`);
    return existing;
  }

  const torrent = client.add(id, {
    announce: effectiveTrackers(),
    strategy: settings.strategy === 'rarest' ? 'rarest' : 'sequential',
    destroyStoreOnDestroy: false,
    deselect: Boolean(record && record.deselected && record.deselected.length),
  });

  // Remember what the user gave us (not the tracker-augmented file WebTorrent builds) for restores.
  const source = record?.source || (typeof id === 'string'
    ? { type: 'magnet', uri: id }
    : { type: 'torrent', bytes: new Uint8Array(id) });
  const view = attachTorrent(torrent, { record, seeding: false });
  view.source = source;
  return torrent;
}

function sourceToId(record) {
  if (record.source?.type === 'magnet') return record.source.uri;
  if (record.source?.type === 'torrent') return new Uint8Array(record.source.bytes);
  return new Uint8Array(record.torrentFile);
}

function seedFiles(files, { name } = {}) {
  if (!files.length) return;
  // Seeds copy the files into OPFS; drop that copy when the seed is removed.
  const opts = { announce: effectiveTrackers(), destroyStoreOnDestroy: true };
  if (name) opts.name = name;
  const torrent = client.seed(files, opts);
  attachTorrent(torrent, { seeding: true });
  torrent.once('ready', () => {
    toast(`Seeding "${torrent.name}". Share the link so others can download it.`);
    openDetails(torrent, true);
  });
  return torrent;
}

async function seedRemoteUrl(url) {
  toast('Fetching the remote file…');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const blob = await res.blob();
  let name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'file';
  const cd = res.headers.get('Content-Disposition');
  const m = cd && cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m) name = decodeURIComponent(m[1]);
  return seedFiles([new File([blob], name, { type: blob.type })]);
}

function attachTorrent(torrent, { record, seeding }) {
  const view = createTorrentView(torrent, record, seeding);
  torrent.on('error', (err) => {
    toast(`${torrent.name || 'Torrent'}: ${err.message || err}`, { error: true });
    if (torrent.infoHash && !seeding) dbDelete(torrent.infoHash);
    removeView(torrent);
    updateEmptyState();
  });
  // A torrent can be destroyed without an error (e.g. seeding files that are already seeded).
  torrent.on('close', () => {
    if (views.has(torrent)) {
      removeView(torrent);
      updateEmptyState();
      updateWakeLock();
    }
  });
  torrent.on('warning', (err) => {
    const msg = String(err && err.message || err);
    // udp:// and http:// trackers in .torrent files are expected to be unusable from a browser.
    if (/Unsupported tracker protocol/i.test(msg)) return;
    logEvent(view, `warning: ${msg}`);
  });
  torrent.on('wire', (wire, addr) => logEvent(view, `peer connected ${addr || wire.type || ''}`.trim()));
  updateEmptyState();
  updateWakeLock();
  return view;
}

function createTorrentView(torrent, record, seeding) {
  const el = els.torrentTemplate.content.firstElementChild.cloneNode(true);
  const view = { torrent, el, fileEls: [], record: record || null, seeding: Boolean(seeding), log: [], startedAt: Date.now() };
  views.set(torrent, view);
  el.classList.toggle('seeding', view.seeding);

  $('.name', el).textContent = torrent.name || (seeding ? 'Preparing files…' : 'Fetching metadata…');
  $('.state', el).textContent = seeding ? 'hashing' : 'connecting';
  $('.size', el).textContent = '—';

  $('.remove-btn', el).addEventListener('click', () => removeTorrent(torrent));
  $('.pause-btn', el).addEventListener('click', () => togglePause(torrent));
  $('.share-btn', el).addEventListener('click', () => shareTorrent(torrent));
  $('.share-link-btn', el).addEventListener('click', () => shareTorrent(torrent));
  $('.zip-btn', el).addEventListener('click', () => saveZip(torrent));
  $('.select-all-btn', el).addEventListener('click', () => setAllSelected(torrent, true));
  $('.select-none-btn', el).addEventListener('click', () => setAllSelected(torrent, false));
  $('.details-btn', el).addEventListener('click', () => openDetails(torrent));
  $('.copy-magnet-btn', el).addEventListener('click', async () => {
    toast((await copyText(torrent.magnetURI)) ? 'Magnet link copied.' : 'Could not copy.', { error: false });
  });
  $('.copy-link-btn', el).addEventListener('click', async () => {
    toast((await copyText(appLinkFor(torrent))) ? 'App link copied. Anyone opening it downloads this torrent here.' : 'Could not copy.');
  });
  $('.save-torrent-btn', el).addEventListener('click', () => saveTorrentFile(torrent));
  for (const sel of ['.webseed-btn', '.nopeers-webseed-btn']) {
    $(sel, el).addEventListener('click', () => addWebSeedPrompt(torrent));
  }
  for (const sel of ['.retry-btn', '.nopeers-retry-btn']) {
    $(sel, el).addEventListener('click', () => retryDiscovery(torrent));
  }

  torrent.on('infoHash', () => {
    if (!torrent.name) $('.name', el).textContent = torrent.infoHash;
    logEvent(view, `info hash ${torrent.infoHash}`);
    if (!torrent.metadata && !view.seeding) scheduleMetadataFallback(view);
  });
  torrent.on('metadata', () => {
    logEvent(view, `metadata received: ${torrent.files.length} file${torrent.files.length === 1 ? '' : 's'}, ${formatBytes(torrent.length)}`);
    renderFiles(view);
  });
  torrent.on('done', () => {
    el.classList.add('done');
    if (!view.seeding) {
      toast(`"${torrent.name}" finished downloading.`);
      if (!settings.seedAfterDone) {
        view.autoStopped = true; // finished and idle by policy, not paused by the user
        stopTransfer(torrent);
      }
    }
    logEvent(view, 'download complete');
    refreshView(view);
    updateWakeLock();
  });
  torrent.on('noPeers', (source) => logEvent(view, `no peers from ${source}`));

  els.torrents.prepend(el);
  return view;
}

function renderFiles(view) {
  const { torrent, el, record } = view;
  $('.name', el).textContent = torrent.name;
  $('.size', el).textContent = formatBytes(torrent.length);
  $('.d-infohash', el).textContent = torrent.infoHash;
  $('.d-trackers', el).textContent = (torrent.announce || []).join('\n');

  const list = $('.files', el);
  list.textContent = '';
  view.fileEls = [];

  const deselected = new Set((record && record.deselected) || []);
  torrent.files.forEach((file, index) => {
    const li = els.fileTemplate.content.firstElementChild.cloneNode(true);
    const checkbox = $('input[type="checkbox"]', li);
    const rel = file.path.startsWith(torrent.name + '/') ? file.path.slice(torrent.name.length + 1) : file.name;
    $('.file-name', li).textContent = rel;
    $('.file-size', li).textContent = formatBytes(file.length);

    if (deselected.has(index)) {
      checkbox.checked = false;
      li.classList.add('deselected');
    } else if (deselected.size) {
      // Torrent was added with `deselect: true`; re-select the wanted files.
      file.select();
    }

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) file.select();
      else file.deselect();
      li.classList.toggle('deselected', !checkbox.checked);
      persistTorrent(view);
      refreshView(view);
      updateWakeLock();
    });

    $('.save-btn', li).addEventListener('click', () => saveFile(torrent, file, li));
    list.appendChild(li);
    view.fileEls.push(li);
  });

  if (!view.seeding) persistTorrent(view);
  refreshView(view);
}

function selectedFiles(view) {
  return view.torrent.files.filter((file, i) => {
    const li = view.fileEls[i];
    return !li || $('input[type="checkbox"]', li).checked;
  });
}

function setAllSelected(torrent, selected) {
  const view = views.get(torrent);
  if (!view) return;
  view.fileEls.forEach((li, i) => {
    const checkbox = $('input[type="checkbox"]', li);
    if (checkbox.checked === selected) return;
    checkbox.checked = selected;
    li.classList.toggle('deselected', !selected);
    if (selected) torrent.files[i].select();
    else torrent.files[i].deselect();
  });
  persistTorrent(view);
  refreshView(view);
  updateWakeLock();
}

function persistTorrent(view) {
  const { torrent } = view;
  if (view.seeding || !torrent.infoHash || torrent.destroyed) return;
  const deselected = [];
  view.fileEls.forEach((li, i) => {
    if (!$('input[type="checkbox"]', li).checked) deselected.push(i);
  });
  view.record = {
    infoHash: torrent.infoHash,
    source: view.source || (view.record && view.record.source) || null,
    // Only a torrent with metadata has a restorable .torrent file; a bare magnet does not.
    torrentFile: torrent.metadata ? new Uint8Array(torrent.torrentFile) : null,
    deselected,
    paused: Boolean(torrent.paused) && !view.autoStopped,
    addedAt: (view.record && view.record.addedAt) || Date.now(),
  };
  view.persisted = dbPut(view.record);
  return view.persisted;
}

function refreshView(view) {
  const { torrent, el } = view;
  if (torrent.destroyed) return;

  const selected = selectedFiles(view);
  const selectedBytes = selected.reduce((n, f) => n + f.length, 0);
  const selectedDownloaded = selected.reduce((n, f) => n + f.downloaded, 0);
  const progress = torrent.files.length
    ? (selectedBytes ? selectedDownloaded / selectedBytes : 0)
    : torrent.progress;
  const pct = Math.min(100, Math.floor(progress * 100));

  $('.progress .bar', el).style.width = `${pct}%`;
  $('.progress', el).setAttribute('aria-valuenow', String(pct));
  $('.pct', el).textContent = `${pct}%`;

  const allSelectedDone = selected.length > 0 && selected.every((f) => f.done || f.progress >= 1);
  const complete = torrent.done || allSelectedDone;
  el.classList.toggle('done', complete);
  el.classList.toggle('paused', Boolean(torrent.paused));

  let state;
  if (selected.length === 0 && torrent.files.length) state = 'nothing selected';
  else if (torrent.paused && !view.autoStopped) state = 'paused';
  else if (view.seeding && !torrent.ready) state = 'hashing';
  else if (complete) state = torrent.numPeers ? `seeding to ${torrent.numPeers}` : (view.seeding ? 'seeding · waiting for peers' : 'complete');
  else if (!torrent.metadata) state = 'fetching metadata';
  else if (torrent.numPeers === 0) state = 'looking for peers';
  else state = 'downloading';
  $('.state', el).textContent = state;

  const pauseBtn = $('.pause-btn', el);
  pauseBtn.title = torrent.paused ? 'Resume' : 'Pause';
  pauseBtn.setAttribute('aria-label', pauseBtn.title);

  $('.speed', el).textContent = torrent.downloadSpeed > 512 || torrent.uploadSpeed > 512
    ? `↓ ${formatSpeed(torrent.downloadSpeed)}  ↑ ${formatSpeed(torrent.uploadSpeed)}`
    : '';
  $('.peers', el).textContent = `${torrent.numPeers} peer${torrent.numPeers === 1 ? '' : 's'}`;
  $('.eta', el).textContent = !complete && torrent.downloadSpeed > 0 && selectedBytes > selectedDownloaded
    ? formatEta(((selectedBytes - selectedDownloaded) / torrent.downloadSpeed) * 1000)
    : '';

  const stuck = !complete && !torrent.paused && torrent.numPeers === 0 && Date.now() - view.startedAt > 2 * fallbackDelayMs();
  const noPeersEl = $('.nopeers', el);
  if (stuck !== !noPeersEl.hidden) {
    noPeersEl.hidden = !stuck;
    if (stuck) {
      const n = (torrent.announce || effectiveTrackers()).length;
      $('.nopeers-text', el).textContent = torrent.metadata
        ? `No peers found on ${n} trackers yet. Browsers only reach WebRTC peers; this torrent may only have classic seeders. You can retry with a fresh tracker list or add an HTTP web seed.`
        : `Still waiting for metadata from ${n} trackers. If the fallback sources could not provide the .torrent either, try again later or add the .torrent file directly.`;
    }
  }

  $('.zip-btn', el).disabled = !allSelectedDone;
  $('.zip-btn', el).textContent = selected.length === torrent.files.length
    ? 'Save all as .zip'
    : `Save ${selected.length} selected as .zip`;

  torrent.files.forEach((file, i) => {
    const li = view.fileEls[i];
    if (!li) return;
    const fp = Math.min(100, Math.floor(file.progress * 100));
    $('.file-progress .bar', li).style.width = `${fp}%`;
    const done = file.done || file.progress >= 1;
    li.classList.toggle('done', done);
    $('.save-btn', li).disabled = !done;
  });

  if (!$('.details', el).hidden) {
    $('.d-downloaded', el).textContent = formatBytes(torrent.downloaded);
    $('.d-uploaded', el).textContent = formatBytes(torrent.uploaded);
    $('.d-ratio', el).textContent = Number.isFinite(torrent.ratio) ? torrent.ratio.toFixed(2) : '—';
    $('.d-pieces', el).textContent = torrent.pieces
      ? `${torrent.pieces.filter((p) => p === null).length} / ${torrent.pieces.length} · ${formatBytes(torrent.pieceLength)} each`
      : '—';
    $('.d-peers', el).textContent = torrent.wires
      ? `${torrent.numPeers} connected${torrent._peersLength ? ` · ${torrent._peersLength} known` : ''}`
      : '—';
  }
}

function openDetails(torrent, force) {
  const view = views.get(torrent);
  if (!view) return;
  const details = $('.details', view.el);
  const show = force === undefined ? details.hidden : force;
  details.hidden = !show;
  $('.details-btn', view.el).setAttribute('aria-expanded', String(show));
  $('.details-btn', view.el).textContent = show ? 'Hide details' : 'Details';
  if (show) {
    $('.d-infohash', view.el).textContent = torrent.infoHash || '—';
    $('.d-trackers', view.el).textContent = (torrent.announce || effectiveTrackers()).join('\n');
    refreshView(view);
  }
}

function stopTransfer(torrent) {
  torrent.pause();
  // pause() only stops new connections; drop the current ones so transfer really stops.
  for (const wire of [...torrent.wires]) wire.destroy();
}

function togglePause(torrent) {
  const view = views.get(torrent);
  if (!view) return;
  if (torrent.paused) {
    view.autoStopped = false;
    torrent.resume();
    logEvent(view, 'resumed');
  } else {
    view.autoStopped = false;
    stopTransfer(torrent);
    logEvent(view, 'paused');
  }
  persistTorrent(view);
  refreshView(view);
  updateWakeLock();
}

function scheduleMetadataFallback(view) {
  const { torrent } = view;
  clearTimeout(view.fallbackTimer);
  view.fallbackTimer = setTimeout(async () => {
    if (torrent.destroyed || torrent.metadata || !views.has(torrent)) return;
    if (!(settings.metadataSources || []).length) return;
    logEvent(view, 'no metadata from peers yet, trying fallback sources');
    const bytes = await fetchMetadataFallback(torrent.infoHash, (url, err) => {
      logEvent(view, err ? `fallback ${new URL(url).host}: ${err.message}` : `fallback ${new URL(url).host}: got .torrent`);
    });
    if (!bytes || torrent.destroyed || torrent.metadata || !views.has(torrent)) return;
    await replaceTorrent(torrent, bytes, 'metadata from fallback source');
  }, fallbackDelayMs());
}

/** Swap a running torrent for a fresh one (new trackers or a real .torrent), keeping its data and card position. */
async function replaceTorrent(torrent, id, why) {
  const view = views.get(torrent);
  if (!view) return null;
  const record = view.record ? { ...view.record, paused: false } : null;
  const source = view.source;
  const anchor = view.el.nextElementSibling;
  clearTimeout(view.fallbackTimer);
  removeView(torrent);
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    client.remove(torrent, { destroyStore: false }, done).catch(done);
  });
  const next = await addTorrent(id, { record });
  const nextView = views.get(next);
  if (nextView) {
    if (source && typeof id !== 'string' && !(record && record.source)) nextView.source = { type: 'torrent', bytes: new Uint8Array(id) };
    else if (source) nextView.source = source;
    nextView.log = [...view.log];
    $('.log', nextView.el).hidden = view.log.length === 0;
    for (const line of view.log) {
      const li = document.createElement('li');
      li.textContent = line;
      $('.log', nextView.el).appendChild(li);
    }
    logEvent(nextView, why);
    if (anchor && anchor.parentNode === els.torrents) els.torrents.insertBefore(nextView.el, anchor);
    else if (!anchor) els.torrents.appendChild(nextView.el);
    persistTorrent(nextView);
  }
  return next;
}

async function retryDiscovery(torrent) {
  const view = views.get(torrent);
  if (!view) return;
  const before = new Set(torrent.announce || []);
  const btns = $$('.retry-btn, .nopeers-retry-btn', view.el);
  btns.forEach((b) => { b.disabled = true; b.textContent = 'Refreshing…'; });
  await refreshTrackerList({ force: true });
  const now = effectiveTrackers();
  const added = now.filter((t) => !before.has(t));
  const id = view.source?.type === 'magnet' ? view.source.uri : torrent.metadata ? new Uint8Array(torrent.torrentFile) : torrent.magnetURI;
  toast(added.length ? `Re-announcing with ${added.length} new tracker${added.length === 1 ? '' : 's'}.` : 'No new trackers found; re-announcing to the current ones.');
  const next = await replaceTorrent(torrent, id, `re-announced (${added.length} new trackers)`);
  if (next) {
    const nv = views.get(next);
    if (nv) nv.startedAt = Date.now();
  }
}

function addWebSeedPrompt(torrent) {
  const url = prompt('HTTP(S) URL of the file (or folder for multi-file torrents) to use as a web seed:');
  if (!url) return;
  if (!/^https?:\/\//i.test(url.trim())) {
    toast('Web seed must be an http(s) URL.', { error: true });
    return;
  }
  const view = views.get(torrent);
  try {
    torrent.addWebSeed(proxied(url.trim()));
    if (view) logEvent(view, `web seed added: ${url.trim()}`);
    toast('Web seed added.');
  } catch (err) {
    toast(`Could not add web seed: ${err.message}`, { error: true });
  }
}

async function shareTorrent(torrent) {
  if (!torrent.infoHash) {
    toast('Wait until the torrent has an info hash.');
    return;
  }
  const url = appLinkFor(torrent);
  const title = torrent.name || 'Torrent';
  if (navigator.share) {
    try {
      await navigator.share({ title, text: `Download "${title}" with Phone Torrent`, url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  toast((await copyText(url)) ? 'Link copied to the clipboard.' : 'Could not share.', { error: false });
}

function removeView(torrent) {
  const view = views.get(torrent);
  if (!view) return;
  view.el.remove();
  views.delete(torrent);
}

async function removeTorrent(torrent) {
  const view = views.get(torrent);
  const name = torrent.name || torrent.infoHash || 'this torrent';
  const message = view && view.seeding
    ? `Stop sharing "${name}"?`
    : `Remove "${name}"?\n\nIts downloaded data will be deleted from the browser. Files you already saved to your phone are not affected.`;
  if (!confirm(message)) return;
  const infoHash = torrent.infoHash;
  removeView(torrent);
  // Forget it first so a quick reload cannot restore it while the store is being destroyed.
  if (infoHash) await dbDelete(infoHash);
  await removeFromClient(torrent);
  updateEmptyState();
  updateWakeLock();
}

/** client.remove() resolves before the store is gone; wait for the destroy callback instead. */
function removeFromClient(torrent) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) toast(err.message || String(err), { error: true });
      resolve();
    };
    client.remove(torrent, { destroyStore: true }, done).catch(done);
  });
}

/* ---------- saving ---------- */

async function saveFile(torrent, file, li) {
  const btn = $('.save-btn', li);
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await saver.save({ name: file.name, size: file.length, stream: () => file.stream() });
    toast(`Saved ${file.name}`);
  } catch (err) {
    toast(`Could not save ${file.name}: ${err.message}`, { error: true });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function saveZip(torrent) {
  const view = views.get(torrent);
  if (!view) return;
  const files = selectedFiles(view).filter((f) => f.done || f.progress >= 1);
  if (files.length === 0) return;

  const btn = $('.zip-btn', view.el);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Zipping…';

  // Multi-file torrents keep their folder structure inside the zip.
  const entryName = (file) => (torrent.files.length > 1 ? file.path : file.name);
  const entries = () => files.map((file) => ({
    name: entryName(file),
    size: file.length,
    lastModified: new Date(),
    input: file.stream(),
  }));
  const metadata = files.map((file) => ({ name: entryName(file), size: file.length }));

  let size;
  try { size = Number(predictLength(metadata)); } catch { size = undefined; }

  try {
    await saver.save({
      name: `${torrent.name}.zip`,
      size,
      stream: () => makeZip(entries(), { metadata }),
    });
    toast(`Saved ${torrent.name}.zip`);
  } catch (err) {
    toast(`Could not save zip: ${err.message}`, { error: true });
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function saveTorrentFile(torrent) {
  if (!torrent.torrentFile) {
    toast('The .torrent file is not available until metadata arrives.');
    return;
  }
  const bytes = new Uint8Array(torrent.torrentFile);
  try {
    await saver.save({
      name: `${torrent.name || torrent.infoHash}.torrent`,
      size: bytes.byteLength,
      stream: () => new Blob([bytes]).stream(),
    });
  } catch (err) {
    toast(`Could not save .torrent: ${err.message}`, { error: true });
  }
}

/* ---------- inputs ---------- */

async function addTorrentFiles(fileList) {
  for (const f of fileList) {
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      await addTorrent(buf);
    } catch (err) {
      toast(`Could not read ${f.name}: ${err.message}`, { error: true });
    }
  }
}

els.fileInput.addEventListener('change', async () => {
  const files = Array.from(els.fileInput.files || []);
  els.fileInput.value = '';
  await addTorrentFiles(files);
});

els.magnetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = parseTorrentText(els.magnetInput.value);
  if (!id) {
    toast('Paste a magnet link, a 40-character info hash, or a .torrent URL.', { error: true });
    return;
  }
  els.magnetInput.value = '';
  await addTorrent(id);
});

els.seedFileInput.addEventListener('change', () => {
  const files = Array.from(els.seedFileInput.files || []);
  els.seedFileInput.value = '';
  if (!files.length) return;
  let name;
  if (files.length > 1) {
    name = prompt('Name for this collection of files:', 'Shared files') || undefined;
  }
  seedFiles(files, { name });
});

els.seedUrlForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = els.seedUrlInput.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    toast('Enter an http(s) URL.', { error: true });
    return;
  }
  try {
    await seedRemoteUrl(url);
    els.seedUrlInput.value = '';
  } catch (err) {
    toast(`Could not fetch that URL: ${err.message}. The server must allow cross-origin requests.`, { error: true });
  }
});

$$('.tab').forEach((tab) => tab.addEventListener('click', () => {
  $$('.tab').forEach((t) => {
    const active = t === tab;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  $$('.tab-panel').forEach((p) => { p.hidden = p.id !== `tab-${tab.dataset.tab}`; });
}));

['dragenter', 'dragover'].forEach((type) => els.dropZone.addEventListener(type, (e) => {
  e.preventDefault();
  els.dropZone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((type) => els.dropZone.addEventListener(type, (e) => {
  e.preventDefault();
  els.dropZone.classList.remove('dragover');
}));
els.dropZone.addEventListener('drop', async (e) => {
  const files = Array.from(e.dataTransfer?.files || []);
  const torrents = files.filter((f) => /\.torrent$/i.test(f.name));
  if (torrents.length) return addTorrentFiles(torrents);
  if (files.length) return seedFiles(files, { name: files.length > 1 ? 'Shared files' : undefined });
  const text = e.dataTransfer?.getData('text');
  const id = text && parseTorrentText(text);
  if (id) await addTorrent(id);
});

/* ---------- screen wake lock: phones suspend the page when the screen locks ---------- */

let wakeLock = null; // Promise<WakeLockSentinel> while requested or held

function wantsWakeLock() {
  if (!settings.wakeLock) return false;
  return client.torrents.some((t) => !t.paused && (!t.done || t.numPeers > 0 || views.get(t)?.seeding));
}

async function updateWakeLock() {
  if (!('wakeLock' in navigator)) return;
  const want = wantsWakeLock() && document.visibilityState === 'visible';
  if (want && !wakeLock) {
    const pending = navigator.wakeLock.request('screen');
    wakeLock = pending;
    try {
      const sentinel = await pending;
      sentinel.addEventListener('release', () => { if (wakeLock === pending) wakeLock = null; });
    } catch {
      if (wakeLock === pending) wakeLock = null;
    }
  } else if (!want && wakeLock) {
    const pending = wakeLock;
    wakeLock = null;
    try { (await pending).release(); } catch { /* ignore */ }
  }
}

document.addEventListener('visibilitychange', updateWakeLock);

/* ---------- settings dialog ---------- */

els.settingsBtn.addEventListener('click', async () => {
  els.trackersInput.value = settings.trackers.join('\n');
  els.trackerListToggle.checked = Boolean(settings.trackerList);
  els.trackerListUrl.value = settings.trackerListUrl || '';
  const listCache = loadTrackerListCache();
  els.trackerListInfo.textContent = settings.trackerList && listCache
    ? `${listCache.trackers.length} tracker${listCache.trackers.length === 1 ? '' : 's'} from the list, refreshed ${new Date(listCache.fetchedAt).toLocaleString()}.`
    : 'Only ws:// and wss:// entries are used; the rest cannot be reached from a browser.';
  els.downLimit.value = String(settings.downloadLimit || 0);
  els.upLimit.value = String(settings.uploadLimit || 0);
  els.seedAfterToggle.checked = Boolean(settings.seedAfterDone);
  els.strategySelect.value = settings.strategy === 'rarest' ? 'rarest' : 'sequential';
  els.metaSourcesInput.value = (settings.metadataSources || []).join('\n');
  els.corsProxyInput.value = settings.corsProxy || '';
  els.fallbackDelayInput.value = String(settings.fallbackDelay || 20);
  els.rtcInput.value = settings.rtcConfig ? JSON.stringify(settings.rtcConfig) : '';
  els.wakelockToggle.checked = Boolean(settings.wakeLock);
  els.debugToggle.checked = debugEnabled();
  els.saverInfo.textContent = saver.mode === 'stream'
    ? 'Files stream straight to your downloads folder, so even very large files work.'
    : `Files are assembled in memory before saving, so very large files may fail. ${saver.reason}`;
  els.clientInfo.textContent = `WebTorrent ${WebTorrent.VERSION || ''} · peer ${client.peerId ? client.peerId.slice(0, 12) + '…' : '—'} · ${client.torrents.length} torrent${client.torrents.length === 1 ? '' : 's'} · ↓ ${formatSpeed(client.downloadSpeed)} ↑ ${formatSpeed(client.uploadSpeed)}`;
  try {
    const est = await navigator.storage.estimate();
    els.storageInfo.textContent = `Downloaded pieces are kept in the browser's private storage so you can reload the page without losing progress. Currently using ${formatBytes(est.usage)} of ${formatBytes(est.quota)} available.`;
  } catch { /* keep default text */ }
  els.settingsDialog.returnValue = '';
  els.settingsDialog.showModal();
});

els.resetTrackersBtn.addEventListener('click', () => {
  els.trackersInput.value = DEFAULT_TRACKERS.join('\n');
});

els.settingsDialog.addEventListener('close', () => {
  if (els.settingsDialog.returnValue !== 'save') return;

  const trackers = els.trackersInput.value.split('\n').map((s) => s.trim()).filter((s) => /^wss?:\/\//i.test(s));
  if (trackers.length === 0) {
    toast('Keeping the previous trackers: at least one wss:// tracker is needed.', { error: true });
    return;
  }

  let rtcConfig = null;
  const rtcText = els.rtcInput.value.trim();
  if (rtcText) {
    try {
      rtcConfig = JSON.parse(rtcText);
      if (!rtcConfig || typeof rtcConfig !== 'object') throw new Error('not an object');
    } catch (err) {
      toast(`WebRTC configuration is not valid JSON: ${err.message}`, { error: true });
      return;
    }
  }

  const trackerListUrl = els.trackerListUrl.value.trim();
  if (els.trackerListToggle.checked && !/^https?:\/\//i.test(trackerListUrl)) {
    toast('The tracker list URL must start with http(s)://', { error: true });
    return;
  }

  const rtcChanged = JSON.stringify(rtcConfig) !== JSON.stringify(settings.rtcConfig || null);
  const listChanged = els.trackerListToggle.checked !== Boolean(settings.trackerList) || trackerListUrl !== settings.trackerListUrl;
  saveSettings({
    ...settings,
    trackers,
    rtcConfig,
    wakeLock: els.wakelockToggle.checked,
    trackerList: els.trackerListToggle.checked,
    trackerListUrl: trackerListUrl || DEFAULT_TRACKER_LIST_URL,
    downloadLimit: Math.max(0, Number(els.downLimit.value) || 0),
    uploadLimit: Math.max(0, Number(els.upLimit.value) || 0),
    seedAfterDone: els.seedAfterToggle.checked,
    strategy: els.strategySelect.value === 'rarest' ? 'rarest' : 'sequential',
    metadataSources: els.metaSourcesInput.value.split('\n').map((s) => s.trim()).filter((s) => /^https?:\/\/.*\{infohash\}/i.test(s)),
    corsProxy: /^https?:\/\/.*\{url\}/i.test(els.corsProxyInput.value.trim()) ? els.corsProxyInput.value.trim() : '',
    fallbackDelay: Math.max(5, Number(els.fallbackDelayInput.value) || 20),
  });
  applyTrackers();
  applySpeedLimits();
  updateWakeLock();
  if (listChanged) refreshTrackerList({ force: true });

  const wantDebug = els.debugToggle.checked;
  if (wantDebug !== debugEnabled()) {
    try {
      if (wantDebug) localStorage.setItem('debug', DEBUG_NAMESPACES);
      else localStorage.removeItem('debug');
    } catch { /* ignore */ }
    toast(`Debug logging ${wantDebug ? 'enabled' : 'disabled'}. Reloading…`);
    setTimeout(() => location.reload(), 600);
    return;
  }

  toast(rtcChanged ? 'Settings saved. Reload the page to apply the WebRTC configuration.' : 'Settings saved. Trackers apply to torrents added from now on.');
});

els.clearStorageBtn.addEventListener('click', async () => {
  if (!confirm('Delete all torrents and their downloaded data from this browser?')) return;
  await dbClear();
  for (const torrent of [...client.torrents]) {
    removeView(torrent);
    await removeFromClient(torrent);
  }
  // Only touch our own directories: on *.github.io every project page shares one origin.
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      if (STORE_DIR_RE.test(name) || name === 'chunks') await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  } catch { /* OPFS unavailable */ }
  updateEmptyState();
  updateWakeLock();
  els.settingsDialog.close();
  toast('All stored torrent data deleted.');
});

els.copyDiagBtn.addEventListener('click', async () => {
  const diag = {
    app: 'phone-torrent',
    time: new Date().toISOString(),
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    saver: { mode: saver.mode, reason: saver.reason },
    opfs: Boolean(navigator.storage && navigator.storage.getDirectory),
    webrtc: typeof RTCPeerConnection === 'function',
    settings,
    effectiveTrackers: effectiveTrackers(),
    client: {
      version: WebTorrent.VERSION,
      peerId: client.peerId,
      downloadSpeed: client.downloadSpeed,
      uploadSpeed: client.uploadSpeed,
    },
    torrents: client.torrents.map((t) => ({
      name: t.name,
      infoHash: t.infoHash,
      length: t.length,
      progress: t.progress,
      downloaded: t.downloaded,
      uploaded: t.uploaded,
      numPeers: t.numPeers,
      paused: t.paused,
      done: t.done,
      announce: t.announce,
      files: t.files.map((f) => ({ path: f.path, length: f.length, progress: f.progress })),
      log: views.get(t)?.log || [],
    })),
  };
  toast((await copyText(JSON.stringify(diag, null, 2))) ? 'Diagnostics copied to the clipboard.' : 'Could not copy.');
});

/* ---------- periodic refresh ---------- */

setInterval(() => {
  for (const view of views.values()) refreshView(view);
  const down = client.downloadSpeed;
  const up = client.uploadSpeed;
  const peers = client.torrents.reduce((n, t) => n + t.numPeers, 0);
  els.netStatus.textContent = down > 512 || up > 512
    ? `↓ ${formatSpeed(down)} ↑ ${formatSpeed(up)}`
    : client.torrents.length ? `${peers} peer${peers === 1 ? '' : 's'}` : 'idle';
}, 750);

/* ---------- share target inbox (Android "Share to Phone Torrent") ---------- */

async function takeSharedInbox() {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open(INBOX_CACHE);
    const keys = await cache.keys();
    for (const req of keys) {
      const res = await cache.match(req);
      await cache.delete(req);
      if (!res) continue;
      if (res.headers.get('X-Kind') === 'torrent') {
        const name = safeDecode(res.headers.get('X-Name') || 'shared.torrent');
        if (confirmExternalAdd(`the shared file "${name}"`)) await addTorrentFiles([new File([await res.blob()], name)]);
      } else {
        const id = parseTorrentText(await res.text());
        if (id && confirmExternalAdd(describeTorrentId(id))) await addTorrent(id);
      }
    }
  } catch { /* ignore */ }
}

/* ---------- install (PWA) ---------- */

let installPrompt = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  if (!isStandalone()) els.installBtn.hidden = false;
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  els.installBtn.hidden = true;
  toast('Installed. Open Phone Torrent from your home screen.');
});

els.installBtn.addEventListener('click', async () => {
  if (!installPrompt) return;
  els.installBtn.hidden = true;
  try {
    await installPrompt.prompt();
    await installPrompt.userChoice;
  } catch { /* dismissed */ }
  installPrompt = null;
});

function maybeShowIosInstallHint() {
  const isIos = /iP(hone|ad|od)/.test(navigator.userAgent) && !window.MSStream;
  if (!isIos || isStandalone()) return;
  try {
    if (localStorage.getItem('phone-torrent:ios-hint')) return;
    localStorage.setItem('phone-torrent:ios-hint', '1');
  } catch { /* ignore */ }
  toast('Tip: tap Share, then "Add to Home Screen" to install this app.', { timeout: 9000 });
}

/* ---------- startup ---------- */

(async function start() {
  await saver.init();
  // Give the public tracker list a moment so restored torrents announce to it too; the cached list is
  // already applied, so on a slow network we simply continue and it merges in when it arrives.
  await Promise.race([refreshTrackerList(), new Promise((r) => setTimeout(r, 2500))]);
  maybeShowIosInstallHint();

  const records = await dbAll();
  records.sort((a, b) => a.addedAt - b.addedAt);
  await cleanOrphanStores(records);
  for (const record of records) {
    try {
      const torrent = await addTorrent(sourceToId(record), { record });
      if (record.paused) {
        torrent.pause();
        const view = views.get(torrent);
        if (view) refreshView(view);
      }
    } catch (err) {
      toast(`Could not restore a torrent: ${err.message}`, { error: true });
    }
  }

  const params = new URLSearchParams(location.search);
  const fromQuery = parseTorrentText(params.get('magnet') || '');
  const fromHash = parseTorrentText(safeDecode(location.hash.slice(1)));
  if (fromQuery || fromHash || params.has('shared')) {
    history.replaceState(null, '', location.pathname);
  }
  // Anything a link or another app handed us gets a confirmation: a web page must not be able to
  // make this app download and seed something just by opening a URL.
  for (const id of [fromQuery, fromHash]) {
    if (id && confirmExternalAdd(describeTorrentId(id))) await addTorrent(id);
  }
  await takeSharedInbox();

  updateEmptyState();
  updateWakeLock();
})();

// Expose for debugging and tests.
window.__phoneTorrent = { client, views, saver, addTorrent, seedFiles, effectiveTrackers, refreshTrackerList, fetchMetadataFallback, verifyTorrentBytes };
