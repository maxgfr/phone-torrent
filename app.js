import WebTorrent from './vendor/webtorrent.min.js';
import { makeZip, predictLength } from './vendor/client-zip.js';
import { saver } from './saver.js';

const DEFAULT_CLOUD_PROVIDER = 'torbox';
const CLOUD_POLL_MS = 5000;

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
// Same list from other hosts, for networks that block GitHub's raw domain.
const TRACKER_LIST_MIRRORS = [
  'https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_all_ws.txt',
  'https://cdn.statically.io/gh/ngosang/trackerslist/master/trackers_all_ws.txt',
];
const DEFAULT_DOH = 'https://cloudflare-dns.com/dns-query';
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
  dohSelect: $('#doh-select'),
  netcheckBtn: $('#netcheck-btn'),
  netcheckResults: $('#netcheck-results'),
  corsProxyInput: $('#corsproxy-input'),
  cloudProviderSelect: $('#cloud-provider'),
  cloudKeyInput: $('#cloud-key'),
  cloudBaseInput: $('#cloud-base'),
  cloudProxyToggle: $('#cloud-proxy-toggle'),
  cloudTestBtn: $('#cloud-test-btn'),
  cloudInfo: $('#cloud-info'),
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
    // Cloud fetch: a remote client (TorBox and anything speaking its API) downloads what a browser
    // cannot reach — private trackers, http(s)-only trackers, swarms without a single WebRTC peer.
    cloud: { provider: DEFAULT_CLOUD_PROVIDER, apiKey: '', apiBase: '', viaProxy: false },
    fallbackDelay: 20, // seconds
    dohResolver: DEFAULT_DOH,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...defaults,
        ...parsed,
        trackers: Array.isArray(parsed.trackers) && parsed.trackers.length ? parsed.trackers : defaults.trackers,
        cloud: { ...defaults.cloud, ...(parsed.cloud || {}) },
      };
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

// Ports browsers refuse to open sockets to (the Fetch "bad port" list). WebKit throws synchronously
// from `new WebSocket` for them, which would abort WebTorrent's tracker setup for the whole torrent.
const BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080]);

function usableTracker(url) {
  try {
    const u = new URL(url);
    if (!/^wss?:$/.test(u.protocol)) return false;
    const port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80));
    return !BAD_PORTS.has(port);
  } catch {
    return false;
  }
}

/** All trackers to announce to: the user's list plus the fetched public list, deduplicated. */
function effectiveTrackers() {
  const extra = settings.trackerList ? (loadTrackerListCache()?.trackers || []) : [];
  return Array.from(new Set([...settings.trackers, ...extra])).filter(usableTracker);
}

async function refreshTrackerList({ force = false } = {}) {
  if (!settings.trackerList || !/^https?:\/\//i.test(settings.trackerListUrl || '')) return null;
  const cached = loadTrackerListCache();
  if (!force && cached && cached.url === settings.trackerListUrl && Date.now() - cached.fetchedAt < TRACKER_LIST_TTL) return cached;
  const urls = [settings.trackerListUrl, ...(settings.trackerListUrl === DEFAULT_TRACKER_LIST_URL ? TRACKER_LIST_MIRRORS : [])];
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const trackers = parseTrackerList(await res.text());
      if (!trackers.length) throw new Error('empty list');
      const record = { url: settings.trackerListUrl, fetchedAt: Date.now(), trackers, via: url };
      try { localStorage.setItem(TRACKER_LIST_KEY, JSON.stringify(record)); } catch { /* ignore */ }
      applyTrackers();
      return record;
    } catch (err) {
      console.warn('tracker list fetch failed', url, err);
    }
  }
  return cached;
}

/* ---------- network check: is a tracker dead, or blocked by this network's DNS? ---------- */

function wsReachable(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let ws;
    const timer = setTimeout(() => { try { ws && ws.close(); } catch { /* ignore */ } resolve(false); }, timeoutMs);
    try {
      ws = new WebSocket(url);
    } catch {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(true); };
    ws.onerror = () => { clearTimeout(timer); resolve(false); };
  });
}

/** Look a hostname up through a DNS-over-HTTPS JSON resolver: 'exists' | 'nxdomain' | 'unknown'. */
async function dohLookup(host) {
  const resolver = settings.dohResolver || DEFAULT_DOH;
  try {
    const res = await fetch(`${resolver}${resolver.includes('?') ? '&' : '?'}name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: 'application/dns-json' },
      cache: 'no-store',
    });
    if (!res.ok) return 'unknown';
    const data = await res.json();
    if (data.Status === 3) return 'nxdomain';
    if (data.Status === 0) return Array.isArray(data.Answer) && data.Answer.length ? 'exists' : 'unknown';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function checkTracker(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return { url, level: 'bad', text: 'invalid URL' }; }
  const [reachable, dns] = await Promise.all([wsReachable(url), /^[\d.]+$|^\[/.test(host) ? 'exists' : dohLookup(host)]);
  if (reachable) return { url, level: 'ok', text: 'reachable' };
  if (dns === 'nxdomain') return { url, level: 'bad', text: 'does not exist any more (dead tracker)' };
  if (dns === 'exists') return { url, level: 'warn', text: 'exists but unreachable from this network: likely blocked by your DNS or firewall, try DNS 1.1.1.1' };
  return { url, level: 'warn', text: 'unreachable (could not verify its DNS either)' };
}

async function runNetworkCheck() {
  const trackers = effectiveTrackers();
  els.netcheckBtn.disabled = true;
  els.netcheckBtn.textContent = `Checking ${trackers.length} trackers…`;
  els.netcheckResults.hidden = false;
  els.netcheckResults.textContent = '';
  const results = await Promise.all(trackers.map(checkTracker));
  for (const r of results) {
    const li = document.createElement('li');
    const mark = document.createElement('span');
    mark.className = r.level;
    mark.textContent = r.level === 'ok' ? '✓' : r.level === 'bad' ? '✗' : '!';
    const text = document.createElement('span');
    text.textContent = `${r.url} — ${r.text}`;
    li.append(mark, text);
    els.netcheckResults.appendChild(li);
  }
  const okCount = results.filter((r) => r.level === 'ok').length;
  els.netcheckBtn.disabled = false;
  els.netcheckBtn.textContent = `Check again (${okCount}/${results.length} reachable)`;
  return results;
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

/**
 * Remove OPFS directories that belong to no remembered torrent (closed seeds, failed removals).
 * Directories of torrents currently in the client are never touched, so a torrent added or seeded
 * while this runs keeps its data.
 */
async function cleanOrphanStores(records) {
  if (!opfsOk) return;
  try {
    const root = await navigator.storage.getDirectory();
    const known = new Set(records.map((r) => String(r.infoHash).slice(0, 8)));
    for await (const name of root.keys()) {
      const m = name.match(STORE_DIR_RE);
      if (!m || known.has(m[1])) continue;
      if (client.torrents.some((t) => t.infoHash && t.infoHash.startsWith(m[1]))) continue;
      await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  } catch { /* ignore */ }
}

/** Resolves once persisted records are loaded and orphan stores are cleaned; adding waits for it. */
let storageReady = Promise.resolve([]);

/* ---------- piece storage: OPFS when it really works, otherwise memory ---------- */

let opfsOk = false;

/** WebKit exposes navigator.storage.getDirectory but may reject every call; probe before trusting it. */
async function probeOpfs() {
  if (!navigator.storage?.getDirectory) return false;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('.phone-torrent-probe', { create: true });
    if (typeof handle.createSyncAccessHandle !== 'function' && typeof handle.createWritable !== 'function') throw new Error('no write API');
    await root.removeEntry('.phone-torrent-probe').catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Minimal in-memory chunk store with the interface WebTorrent expects. */
class MemoryChunkStore {
  constructor(chunkLength) {
    this.chunkLength = Number(chunkLength);
    this.chunks = new Map();
    this.closed = false;
  }

  put(index, buf, cb = () => {}) {
    if (this.closed) return queueMicrotask(() => cb(new Error('store is closed')));
    this.chunks.set(index, buf);
    queueMicrotask(() => cb(null));
  }

  get(index, opts, cb = () => {}) {
    if (typeof opts === 'function') return this.get(index, null, opts);
    if (this.closed) return queueMicrotask(() => cb(new Error('store is closed')));
    const buf = this.chunks.get(index);
    if (!buf) return queueMicrotask(() => cb(new Error(`chunk ${index} not found`)));
    const offset = (opts && opts.offset) || 0;
    const length = (opts && opts.length) || buf.length - offset;
    queueMicrotask(() => cb(null, buf.subarray(offset, offset + length)));
  }

  close(cb = () => {}) {
    this.closed = true;
    queueMicrotask(() => cb(null));
  }

  destroy(cb = () => {}) {
    this.chunks.clear();
    this.close(cb);
  }
}

function storeOpts() {
  return opfsOk ? {} : { store: MemoryChunkStore };
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

/** Complete for the user's purposes: every selected file is done (WebTorrent's `done` needs every file). */
function isComplete(torrent) {
  if (torrent.done) return true;
  const view = views.get(torrent);
  if (!view || !torrent.files.length) return false;
  const selected = selectedFiles(view);
  return selected.length > 0 && selected.every((f) => f.done || f.progress >= 1);
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
  let span = null;
  let prevKey = null;
  while (bytes[pos] !== 0x65) {
    if (pos >= bytes.length) fail();
    const colon = bytes.indexOf(0x3a, pos);
    if (colon < 0) fail();
    const len = Number(dec.decode(bytes.subarray(pos, colon)));
    if (!Number.isFinite(len)) fail();
    const key = dec.decode(bytes.subarray(colon + 1, colon + 1 + len));
    // Bencode dictionaries must have unique, sorted keys; a decoder would let a second "info"
    // override the first, so anything ambiguous is rejected instead of hashed.
    if (prevKey !== null && key <= prevKey) throw new Error('malformed .torrent (duplicate or unsorted keys)');
    prevKey = key;
    pos = colon + 1 + len;
    const start = pos;
    skip();
    if (key === 'info') span = [start, pos];
  }
  if (!span) fail();
  return span;
}

/**
 * Minimal bencode reader for the few fields the UI needs from a .torrent the user picked.
 * Byte strings longer than 4 KiB (the piece hashes) are skipped instead of decoded.
 */
function bdecode(bytes) {
  const dec = new TextDecoder();
  let pos = 0;
  const fail = () => { throw new Error('not a valid .torrent file'); };
  function read() {
    const c = bytes[pos];
    if (c === 0x69) { // i<int>e
      const e = bytes.indexOf(0x65, pos);
      if (e < 0) fail();
      const n = Number(dec.decode(bytes.subarray(pos + 1, e)));
      pos = e + 1;
      return n;
    }
    if (c === 0x6c || c === 0x64) { // l…e / d…e
      const isDict = c === 0x64;
      pos++;
      const out = isDict ? {} : [];
      while (bytes[pos] !== 0x65) {
        if (pos >= bytes.length) fail();
        if (isDict) {
          const key = read();
          out[typeof key === 'string' ? key : ''] = read();
        } else out.push(read());
      }
      pos++;
      return out;
    }
    if (c >= 0x30 && c <= 0x39) { // <len>:<bytes>
      const colon = bytes.indexOf(0x3a, pos);
      if (colon < 0) fail();
      const len = Number(dec.decode(bytes.subarray(pos, colon)));
      if (!Number.isFinite(len) || len < 0) fail();
      const start = colon + 1;
      pos = start + len;
      if (pos > bytes.length) fail();
      return len > 4096 ? '' : dec.decode(bytes.subarray(start, pos));
    }
    return fail();
  }
  const value = read();
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value;
}

/**
 * What a .torrent can hope for in a browser: its own trackers, whether any of them speaks
 * WebSocket, and the BEP 27 private flag (which forbids DHT, PEX and extra trackers).
 * Returns null when the bytes are not a .torrent at all.
 */
function torrentReach(bytes) {
  let meta;
  try { meta = bdecode(bytes); } catch { return null; }
  if (!meta.info || typeof meta.info !== 'object') return null;
  const urls = [meta.announce, ...[].concat(...(Array.isArray(meta['announce-list']) ? meta['announce-list'] : []))]
    .filter((u) => typeof u === 'string' && u);
  const trackers = Array.from(new Set(urls));
  return {
    name: typeof meta.info.name === 'string' ? meta.info.name : '',
    private: meta.info.private === 1 || meta.info.private === true,
    trackers,
    webrtc: trackers.some((u) => /^wss?:\/\//i.test(u)),
  };
}

/** Human explanation of why a torrent will find no peers here, or '' when it might. */
function unreachableReason(reach) {
  if (!reach || reach.webrtc) return '';
  let host = '';
  try { host = new URL(reach.trackers[0]).host; } catch { /* no usable tracker at all */ }
  const cloud = ' Hand it to your cloud account with "Fetch it in the cloud": it downloads there and your phone saves it over HTTPS.';
  if (reach.private) {
    return `This torrent is marked private${host ? ` (${host})` : ''}: only that tracker may hand out peers, `
      + 'and a browser cannot announce to it, so nothing will download here.' + cloud;
  }
  return reach.trackers.length
    ? `None of this torrent's ${reach.trackers.length} trackers speak ws:// or wss://, so a browser cannot ask them for peers.`
      + cloud
    : 'This torrent carries no tracker at all, and browsers have no DHT, so peers can only come from the app\'s own trackers.'
      + cloud;
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

/* ---------- cloud fetch ----------
 *
 * The browser is not a BitTorrent peer in the usual sense: no TCP, no UDP, no DHT. A private
 * tracker, an http(s)-only tracker or a swarm without a single WebRTC client is therefore out of
 * reach, whatever the app does. What put.io and TorBox do instead is run a real client in a data
 * centre and hand the finished file back over HTTPS — the one protocol a browser is good at.
 *
 * So: submit the .torrent (or magnet) to the account's API, watch it download there, then let the
 * phone pull the file straight from the link. Nothing of the payload goes through this app.
 */

/** Accepts both the snake_case wire format and the camelCase some SDKs document. */
function pick(obj, ...names) {
  for (const n of names) if (obj && obj[n] !== undefined && obj[n] !== null) return obj[n];
  return undefined;
}

function cloudReady() {
  return Boolean(settings.cloud && settings.cloud.apiKey);
}

/** Where a transfer lives: which API, at which base URL. Stored with the torrent so it survives a reload. */
function cloudCtx(over = {}) {
  const provider = CLOUD_PROVIDERS[over.provider] ? over.provider : (CLOUD_PROVIDERS[settings.cloud.provider] ? settings.cloud.provider : 'torbox');
  const base = (over.base || settings.cloud.apiBase || CLOUD_PROVIDERS[provider].defaultBase).replace(/\/+$/, '');
  return { provider, base, key: settings.cloud.apiKey, api: CLOUD_PROVIDERS[provider] };
}

/**
 * One call to a cloud API. The key travels in an Authorization header, which makes this a request
 * the API must allow with CORS; when it does not, the user's own proxy relays it instead.
 */
async function cloudFetch(url, { method = 'GET', body } = {}) {
  const viaProxy = proxied(url);
  const hasProxy = viaProxy !== url;
  const targets = settings.cloud.viaProxy && hasProxy ? [viaProxy] : hasProxy ? [url, viaProxy] : [url];
  let last = null;
  for (const target of targets) {
    try {
      return await fetch(target, {
        method,
        body,
        headers: { Authorization: `Bearer ${settings.cloud.apiKey}` },
        cache: 'no-store',
      });
    } catch {
      // A network-level rejection is indistinguishable from CORS in script; in practice it is CORS.
      last = target === url ? 'the browser could not reach the API (CORS or network)' : 'the proxy did not answer';
    }
  }
  throw new Error(hasProxy ? `${last}, and the proxy did not help` : `${last}. Set a CORS proxy in Settings to relay it.`);
}

async function cloudJson(url, opts) {
  const res = await cloudFetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* an error page, not JSON */ }
  const failed = !res.ok || (json && (json.success === false || json.status === 'ERROR'));
  if (failed) {
    const detail = (json && (json.detail || json.error_message || json.error)) || text.slice(0, 120) || `HTTP ${res.status}`;
    throw new Error(String(detail));
  }
  return json || {};
}

const CLOUD_PROVIDERS = {
  torbox: {
    label: 'TorBox',
    defaultBase: 'https://api.torbox.app',
    keyPlaceholder: 'TorBox API key',

    async check(ctx) {
      const { data } = await cloudJson(`${ctx.base}/v1/api/user/me?settings=false`);
      return pick(data || {}, 'email', 'customer', 'id');
    },

    async submit(ctx, { bytes, name, magnet }) {
      const form = new FormData();
      if (bytes) form.append('file', new Blob([bytes], { type: 'application/x-bittorrent' }), `${name}.torrent`);
      else form.append('magnet', magnet);
      const { data } = await cloudJson(`${ctx.base}/v1/api/torrents/createtorrent`, { method: 'POST', body: form });
      const id = pick(data || {}, 'torrent_id', 'torrentId', 'queued_id', 'queuedId', 'id');
      if (id === undefined) throw new Error('the API did not return a torrent id');
      return id;
    },

    async status(ctx, id) {
      const { data } = await cloudJson(`${ctx.base}/v1/api/torrents/mylist?id=${encodeURIComponent(id)}&bypass_cache=true`);
      const raw = Array.isArray(data) ? data[0] : data;
      if (!raw) throw new Error('the cloud no longer knows this transfer');
      const ready = Boolean(pick(raw, 'download_present', 'downloadPresent')) || Boolean(pick(raw, 'download_finished', 'downloadFinished'));
      return {
        state: String(pick(raw, 'download_state', 'downloadState') || 'unknown'),
        progress: Number(pick(raw, 'progress') || 0),
        ready,
        name: pick(raw, 'name') || '',
        files: (Array.isArray(raw.files) ? raw.files : []).map((f) => ({
          id: pick(f, 'id'),
          name: String(pick(f, 'short_name', 'shortName', 'name') || 'file'),
          size: Number(pick(f, 'size') || 0),
        })),
      };
    },

    // A permalink: the browser follows it by itself, so no CORS and no API call to render the list.
    fileLink(ctx, id, file) {
      const url = new URL(`${ctx.base}/v1/api/torrents/requestdl`);
      url.searchParams.set('token', ctx.key);
      url.searchParams.set('torrent_id', String(id));
      if (file) url.searchParams.set('file_id', String(file.id));
      else url.searchParams.set('zip_link', 'true');
      url.searchParams.set('redirect', 'true');
      return url.toString();
    },
    zipLink: true,
  },

  putio: {
    label: 'put.io',
    defaultBase: 'https://api.put.io',
    keyPlaceholder: 'put.io OAuth token',

    async check(ctx) {
      const { info } = await cloudJson(`${ctx.base}/v2/account/info`);
      return info && (info.username || info.mail);
    },

    async submit(ctx, { bytes, name, magnet }) {
      let json;
      if (bytes) {
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: 'application/x-bittorrent' }), `${name}.torrent`);
        // put.io takes uploads on upload.put.io; a custom base (a stand-in, a clone) keeps its host.
        json = await cloudJson(`${ctx.base.replace('://api.', '://upload.')}/v2/files/upload`, { method: 'POST', body: form });
      } else {
        json = await cloudJson(`${ctx.base}/v2/transfers/add`, { method: 'POST', body: new URLSearchParams({ url: magnet }) });
      }
      const id = json.transfer && json.transfer.id;
      if (id === undefined) throw new Error('put.io did not start a transfer for that torrent');
      return id;
    },

    async status(ctx, id) {
      const { transfer } = await cloudJson(`${ctx.base}/v2/transfers/${encodeURIComponent(id)}`);
      if (!transfer) throw new Error('the cloud no longer knows this transfer');
      const state = String(transfer.status || 'unknown').toLowerCase();
      if (state === 'error') throw new Error(transfer.error_message || 'the transfer failed');
      const ready = state === 'completed' || state === 'seeding';
      const out = {
        state,
        progress: Number(transfer.percent_done || 0) / 100,
        ready,
        name: transfer.name || '',
        files: [],
      };
      if (!ready || transfer.file_id === undefined || transfer.file_id === null) return out;
      // A transfer points at one file, or at the folder holding them.
      const { file } = await cloudJson(`${ctx.base}/v2/files/${encodeURIComponent(transfer.file_id)}`);
      if (file && file.file_type !== 'FOLDER') {
        out.files = [{ id: file.id, name: file.name, size: Number(file.size || 0) }];
        return out;
      }
      const listed = await cloudJson(`${ctx.base}/v2/files/list?parent_id=${encodeURIComponent(transfer.file_id)}&per_page=1000`);
      // A sub-folder keeps its own link: put.io serves a folder as a zip.
      out.files = (listed.files || []).map((f) => ({
        id: f.id,
        name: f.file_type === 'FOLDER' ? `${f.name} (folder, .zip)` : f.name,
        size: Number(f.size || 0),
      }));
      return out;
    },

    fileLink(ctx, id, file) {
      if (!file) return '';
      return `${ctx.base}/v2/files/${encodeURIComponent(file.id)}/download?oauth_token=${encodeURIComponent(ctx.key)}`;
    },
    zipLink: false,
  },
};

async function cloudSubmit(view) {
  const { torrent } = view;
  const ctx = cloudCtx();
  const payload = torrent.metadata && torrent.torrentFile
    ? { bytes: new Uint8Array(torrent.torrentFile), name: torrent.name || torrent.infoHash }
    : { magnet: torrent.magnetURI };
  const id = await ctx.api.submit(ctx, payload);
  return { id, provider: ctx.provider, base: ctx.base, state: 'queued', progress: 0, ready: false, files: [] };
}

async function cloudRefresh(view) {
  if (!view.cloud || view.cloud.id === undefined) return null;
  const ctx = cloudCtx(view.cloud);
  view.cloud = { ...view.cloud, ...(await ctx.api.status(ctx, view.cloud.id)) };
  renderCloud(view);
  return view.cloud;
}

function stopCloudPoll(view) {
  if (view.cloudTimer) {
    clearInterval(view.cloudTimer);
    view.cloudTimer = null;
  }
}

function startCloudPoll(view) {
  stopCloudPoll(view);
  const tick = async () => {
    if (!views.has(view.torrent)) return stopCloudPoll(view);
    try {
      const cloud = await cloudRefresh(view);
      if (cloud && cloud.ready) {
        stopCloudPoll(view);
        if (!view.cloudAnnounced) {
          view.cloudAnnounced = true;
          logEvent(view, `cloud download ready: ${cloud.files.length} file${cloud.files.length === 1 ? '' : 's'}`);
          toast(`"${cloud.name || view.torrent.name}" is ready in the cloud: tap a file to download it.`, { timeout: 9000 });
        }
      }
    } catch (err) {
      stopCloudPoll(view);
      logEvent(view, `cloud error: ${err.message}`);
      renderCloud(view, err.message);
    }
  };
  view.cloudTimer = setInterval(tick, CLOUD_POLL_MS);
  tick();
}

async function startCloudFetch(view) {
  if (!cloudReady()) {
    toast('Add your cloud API key first: Settings → Cloud fetch.', { error: true });
    els.settingsBtn.click();
    setTimeout(() => els.cloudKeyInput.focus(), 100);
    return;
  }
  const btns = $$('.cloud-btn, .nopeers-cloud-btn', view.el);
  btns.forEach((b) => { b.disabled = true; });
  try {
    if (!view.cloud) {
      view.cloud = await cloudSubmit(view);
      logEvent(view, `sent to ${cloudCtx(view.cloud).api.label} (transfer ${view.cloud.id})`);
      toast('Sent to the cloud. It downloads there, then you save it from the link.');
      persistTorrent(view);
    }
    renderCloud(view);
    startCloudPoll(view);
  } catch (err) {
    logEvent(view, `cloud error: ${err.message}`);
    toast(`Cloud fetch failed: ${err.message}`, { error: true, timeout: 9000 });
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

function renderCloud(view, error) {
  const box = $('.cloud', view.el);
  if (!box) return;
  const cloud = view.cloud;
  box.hidden = !cloud;
  // One transfer per torrent: the buttons that start one go away once it exists.
  $$('.cloud-btn, .nopeers-cloud-btn', view.el).forEach((b) => { b.hidden = Boolean(cloud); });
  if (!cloud) return;
  const ctx = cloudCtx(cloud);
  const pct = Math.min(100, Math.round((cloud.progress || 0) * 100));
  $('.cloud-state', box).textContent = error
    ? `${ctx.api.label}: ${error}`
    : cloud.ready
      ? `Ready on ${ctx.api.label} — tap a file to download it to your phone.`
      : `${ctx.api.label}: ${cloud.state}${pct ? ` ${pct}%` : ''}…`;
  const list = $('.cloud-files', box);
  list.textContent = '';
  if (!cloud.ready) return;
  const entries = cloud.files.map((f) => ({ href: ctx.api.fileLink(ctx, cloud.id, f), text: `${f.name} · ${formatBytes(f.size)}` }));
  if (ctx.api.zipLink && cloud.files.length > 1) {
    entries.push({ href: ctx.api.fileLink(ctx, cloud.id, null), text: 'Everything as one .zip' });
  }
  for (const entry of entries) {
    if (!entry.href) continue;
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'btn small';
    a.href = entry.href;
    a.rel = 'noopener';
    a.target = '_blank';
    a.setAttribute('download', '');
    a.textContent = entry.text;
    li.appendChild(a);
    list.appendChild(li);
  }
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

/** Download a .torrent from an http(s) URL, through the CORS proxy if the direct fetch is blocked. */
async function fetchTorrentUrl(url) {
  const targets = [url];
  const viaProxy = proxied(url);
  if (viaProxy !== url) targets.push(viaProxy);
  let last = new Error('unreachable');
  for (const target of targets) {
    try {
      const res = await fetch(target, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!torrentReach(bytes)) throw new Error('that address did not return a .torrent file');
      return bytes;
    } catch (err) {
      // A TypeError from fetch almost always means the server does not allow browser (CORS) requests.
      last = err instanceof TypeError ? new Error('blocked by CORS or unreachable') : err;
    }
  }
  throw new Error(`Could not fetch that .torrent: ${last.message}${proxied(url) === url ? '. A CORS proxy can be set in Settings.' : ''}`);
}

async function addTorrent(id, { record } = {}) {
  await storageReady;
  // A .torrent URL is fetched here rather than inside WebTorrent: the proxy can help, the error is
  // a real message, and the rules below get to see the bytes before anything is announced.
  if (typeof id === 'string' && /^https?:\/\//i.test(id)) {
    toast('Fetching that .torrent…');
    return addTorrent(await fetchTorrentUrl(id), { record });
  }
  const existing = await client.get(id).catch(() => null);
  if (existing) {
    toast(`"${existing.name || existing.infoHash}" is already in the list.`);
    return existing;
  }

  // A private torrent (BEP 27) may only be announced to its own tracker: adding public ones
  // would publish its info hash and can get the user banned from the tracker it came from.
  const reach = typeof id === 'string' ? null : torrentReach(new Uint8Array(id));
  const torrent = client.add(id, {
    ...storeOpts(),
    announce: reach && reach.private ? reach.trackers : effectiveTrackers(),
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
  view.reach = reach;
  const reason = unreachableReason(reach);
  if (reason) {
    logEvent(view, reason);
    refreshView(view); // surface the warning straight away instead of after the no-peers delay
    toast(reason, { error: true, timeout: 9000 });
  }
  return torrent;
}

function sourceToId(record) {
  // A stored .torrent (real metadata) restores instantly and without peers; trackers are re-merged anyway.
  if (record.torrentFile && record.torrentFile.byteLength) return new Uint8Array(record.torrentFile);
  if (record.source?.type === 'torrent') return new Uint8Array(record.source.bytes);
  if (record.source?.type === 'magnet') return record.source.uri;
  return null;
}

async function seedFiles(files, { name } = {}) {
  if (!files.length) return null;
  await storageReady;
  // Seeds copy the files into OPFS; drop that copy when the seed is removed.
  const opts = { ...storeOpts(), announce: effectiveTrackers(), destroyStoreOnDestroy: true };
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
  const res = await fetch(proxied(url));
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
    const msg = String(err && err.message || err);
    toast(`${torrent.name || 'Torrent'}: ${msg}`, { error: true });
    // Forget the record only when this torrent could not even be set up (unparseable source).
    // A duplicate-add error belongs to another live torrent, and a runtime store error must not
    // orphan data that is still on disk.
    const isDuplicate = /duplicate/i.test(msg);
    if (torrent.infoHash && !seeding && !isDuplicate && !torrent.ready && !torrent.metadata) dbDelete(torrent.infoHash);
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
    console.warn('torrent warning:', msg);
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
  for (const sel of ['.cloud-btn', '.nopeers-cloud-btn']) {
    $(sel, el).addEventListener('click', () => startCloudFetch(view));
  }
  // A transfer started before a reload keeps going in the cloud; pick it up again.
  if (record && record.cloud && record.cloud.id !== undefined) {
    view.cloud = { id: record.cloud.id, state: 'checking', progress: 0, ready: false, files: [] };
    renderCloud(view);
    if (cloudReady()) startCloudPoll(view);
  }

  torrent.on('infoHash', () => {
    if (!torrent.name) $('.name', el).textContent = torrent.infoHash;
    logEvent(view, `info hash ${torrent.infoHash}`);
    if (!torrent.metadata && !view.seeding) {
      scheduleMetadataFallback(view);
      persistTorrent(view); // a pending magnet must survive a reload too
    }
  });
  torrent.on('metadata', () => {
    logEvent(view, `metadata received: ${torrent.files.length} file${torrent.files.length === 1 ? '' : 's'}, ${formatBytes(torrent.length)}`);
    // A magnet only reveals what it is here; a torrent added from bytes was judged before it started.
    if (!view.reach && torrent.torrentFile) {
      view.reach = torrentReach(new Uint8Array(torrent.torrentFile));
      const reason = unreachableReason(view.reach);
      if (reason) {
        logEvent(view, reason);
        toast(reason, { error: true, timeout: 9000 });
      }
    }
    renderFiles(view);
  });
  torrent.on('done', () => {
    el.classList.add('done');
    refreshView(view); // completion (all files, or all selected files) is handled there
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
  // Before the file list exists (pending magnet, or metadata not yet processed) keep the saved selection.
  const deselected = view.fileEls.length
    ? view.fileEls.flatMap((li, i) => ($('input[type="checkbox"]', li).checked ? [] : [i]))
    : [...((view.record && view.record.deselected) || [])];
  view.record = {
    infoHash: torrent.infoHash,
    source: view.source || (view.record && view.record.source) || null,
    // Only a torrent with metadata has a restorable .torrent file; a bare magnet does not.
    torrentFile: torrent.metadata ? new Uint8Array(torrent.torrentFile) : null,
    deselected,
    paused: Boolean(torrent.paused) && !view.autoStopped,
    cloud: view.cloud ? { id: view.cloud.id } : ((view.record && view.record.cloud) || null),
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
  if (!complete && torrent.metadata) view.sawIncomplete = true;
  if (complete && !view.completed && torrent.metadata) {
    view.completed = true;
    logEvent(view, 'download complete');
    if (!view.seeding && view.sawIncomplete) toast(`"${torrent.name}" finished downloading.`);
    if (!view.seeding && !settings.seedAfterDone && !torrent.paused) {
      view.autoStopped = true; // finished and idle by policy, not paused by the user
      stopTransfer(torrent);
    }
  } else if (!complete) {
    view.completed = false;
  }
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

  // When the .torrent itself says no browser can reach its swarm, say so at once instead of
  // making the user wait out the no-peers delay.
  const reason = unreachableReason(view.reach);
  const stuck = !complete && !torrent.paused && torrent.numPeers === 0
    && !(view.cloud && view.cloud.ready) // the cloud already has it; the peer hunt is moot
    && (Boolean(reason) || Date.now() - view.startedAt > 2 * fallbackDelayMs());
  const noPeersEl = $('.nopeers', el);
  if (stuck !== !noPeersEl.hidden) {
    noPeersEl.hidden = !stuck;
    if (stuck) {
      const n = (torrent.announce || effectiveTrackers()).length;
      // A private torrent is stuck on its own tracker; a fresh public tracker list cannot help it.
      $('.nopeers-retry-btn', el).hidden = Boolean(view.reach?.private);
      $('.retry-btn', el).hidden = Boolean(view.reach?.private);
      $('.nopeers-text', el).textContent = reason || (torrent.metadata
        ? `No peers found on ${n} trackers yet. Browsers only reach WebRTC peers; this torrent may only have classic seeders. You can retry with a fresh tracker list or add an HTTP web seed.`
        : `Still waiting for metadata from ${n} trackers. If the fallback sources could not provide the .torrent either, try again later or add the .torrent file directly.`);
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
    // resume() only lifts the pause flag; ask the trackers for peers again right away, and once
    // more shortly after if nobody showed up (an announce can race the socket reconnect).
    const reannounce = () => { try { torrent.discovery?.tracker?.update?.(); } catch { /* ignore */ } };
    reannounce();
    setTimeout(() => { if (!torrent.destroyed && !torrent.paused && torrent.numPeers === 0) reannounce(); }, 8000);
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
    const expected = torrent.infoHash;
    const next = await replaceTorrent(torrent, bytes, 'metadata from fallback source');
    if (next && next.infoHash && next.infoHash !== expected) {
      // Belt and braces: the hash check should make this impossible.
      toast('Fallback source returned a different torrent; ignored.', { error: true });
      const nv = views.get(next);
      if (nv) removeView(next);
      await removeFromClient(next);
      dbDelete(next.infoHash);
      await addTorrent(`magnet:?xt=urn:btih:${expected}`);
    }
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
  // A private torrent stays on its own tracker; refreshing the public list would not help it.
  if (!view.reach?.private) await refreshTrackerList({ force: true });
  const now = view.reach?.private ? (torrent.announce || []) : effectiveTrackers();
  const added = now.filter((t) => !before.has(t));
  const id = torrent.metadata ? new Uint8Array(torrent.torrentFile) : (view.source?.type === 'magnet' ? view.source.uri : torrent.magnetURI);
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
    // WebTorrent appends "/<file path>" to a web seed for multi-file torrents; that cannot go through
    // a ?url= proxy template, so the proxy is only used for single-file torrents.
    torrent.addWebSeed(torrent.files.length > 1 ? url.trim() : proxied(url.trim()));
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
  stopCloudPoll(view);
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
  if (!torrent.metadata || !torrent.torrentFile) {
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

/** addTorrent for ids handed to us by a link, a drop or another app: never throws, always explains. */
async function tryAddTorrent(id) {
  try {
    return await addTorrent(id);
  } catch (err) {
    toast(err.message, { error: true, timeout: 9000 });
    return null;
  }
}

async function addTorrentFiles(fileList) {
  for (const f of fileList) {
    let buf;
    try {
      buf = new Uint8Array(await f.arrayBuffer());
    } catch (err) {
      toast(`Could not read ${f.name}: ${err.message}`, { error: true });
      continue;
    }
    // The picker cannot filter by file type on iOS, so the bytes have the last word.
    if (!torrentReach(buf)) {
      toast(`"${f.name}" is not a .torrent file. To share a file of your own, use the "Seed & share" tab.`, { error: true });
      continue;
    }
    try {
      await addTorrent(buf);
    } catch (err) {
      toast(`Could not add ${f.name}: ${err.message}`, { error: true });
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
  try {
    await addTorrent(id);
  } catch (err) {
    toast(err.message, { error: true, timeout: 9000 });
  }
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
  if (id) await tryAddTorrent(id);
});

/* ---------- screen wake lock: phones suspend the page when the screen locks ---------- */

let wakeLock = null; // Promise<WakeLockSentinel> while requested or held

function wantsWakeLock() {
  if (!settings.wakeLock) return false;
  return client.torrents.some((t) => !t.paused && (!isComplete(t) || t.numPeers > 0 || views.get(t)?.seeding));
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
  if (settings.dohResolver && ![...els.dohSelect.options].some((o) => o.value === settings.dohResolver)) {
    const opt = document.createElement('option');
    opt.value = settings.dohResolver;
    opt.textContent = `Custom: ${settings.dohResolver}`;
    els.dohSelect.appendChild(opt);
  }
  els.dohSelect.value = settings.dohResolver || DEFAULT_DOH;
  els.netcheckResults.hidden = true;
  els.netcheckBtn.disabled = false;
  els.netcheckBtn.textContent = 'Check tracker connectivity';
  els.corsProxyInput.value = settings.corsProxy || '';
  els.cloudProviderSelect.value = CLOUD_PROVIDERS[settings.cloud.provider] ? settings.cloud.provider : DEFAULT_CLOUD_PROVIDER;
  els.cloudKeyInput.value = settings.cloud.apiKey || '';
  els.cloudBaseInput.value = settings.cloud.apiBase || '';
  applyCloudProviderFields();
  els.cloudProxyToggle.checked = Boolean(settings.cloud.viaProxy);
  els.cloudInfo.textContent = cloudReady()
    ? 'A key is set. Torrents no browser can reach offer "Fetch it in the cloud".'
    : 'Without a key, cloud fetch stays hidden and nothing is sent anywhere.';
  els.fallbackDelayInput.value = String(settings.fallbackDelay || 20);
  els.rtcInput.value = settings.rtcConfig ? JSON.stringify(settings.rtcConfig) : '';
  els.wakelockToggle.checked = Boolean(settings.wakeLock);
  els.debugToggle.checked = debugEnabled();
  els.saverInfo.textContent = saver.mode === 'stream'
    ? 'Files stream straight to your downloads folder, so even very large files work.'
    : `Files are assembled in memory before saving, so very large files may fail. ${saver.reason}`;
  els.clientInfo.textContent = `WebTorrent ${WebTorrent.VERSION || ''} · peer ${client.peerId ? client.peerId.slice(0, 12) + '…' : '—'} · ${client.torrents.length} torrent${client.torrents.length === 1 ? '' : 's'} · ↓ ${formatSpeed(client.downloadSpeed)} ↑ ${formatSpeed(client.uploadSpeed)}`;
  if (!opfsOk) {
    els.storageInfo.textContent = 'This browser does not provide private file storage, so downloaded pieces are kept in memory: they are lost on reload and very large torrents may not fit.';
  } else {
    try {
      const est = await navigator.storage.estimate();
      els.storageInfo.textContent = `Downloaded pieces are kept in the browser's private storage so you can reload the page without losing progress. Currently using ${formatBytes(est.usage)} of ${formatBytes(est.quota)} available.`;
    } catch { /* keep default text */ }
  }
  els.settingsDialog.returnValue = '';
  els.settingsDialog.showModal();
});

els.netcheckBtn.addEventListener('click', () => {
  // Use the resolver currently chosen in the dialog, even before Save.
  settings = { ...settings, dohResolver: els.dohSelect.value || DEFAULT_DOH };
  runNetworkCheck();
});

/** Keep the key placeholder and the base-URL hint in step with the chosen provider. */
function applyCloudProviderFields() {
  const api = CLOUD_PROVIDERS[els.cloudProviderSelect.value] || CLOUD_PROVIDERS[DEFAULT_CLOUD_PROVIDER];
  els.cloudKeyInput.placeholder = api.keyPlaceholder;
  els.cloudBaseInput.placeholder = api.defaultBase;
}

els.cloudProviderSelect.addEventListener('change', () => {
  // A base URL typed for the other provider would not answer; only a custom one is worth keeping.
  const known = Object.values(CLOUD_PROVIDERS).map((p) => p.defaultBase);
  if (known.includes(els.cloudBaseInput.value.trim())) els.cloudBaseInput.value = '';
  applyCloudProviderFields();
  els.cloudInfo.textContent = '';
});

els.cloudTestBtn.addEventListener('click', async () => {
  // Use what is typed in the dialog, even before Save.
  settings = {
    ...settings,
    cloud: {
      provider: els.cloudProviderSelect.value,
      apiKey: els.cloudKeyInput.value.trim(),
      apiBase: /^https?:\/\//i.test(els.cloudBaseInput.value.trim()) ? els.cloudBaseInput.value.trim().replace(/\/+$/, '') : '',
      viaProxy: els.cloudProxyToggle.checked,
    },
  };
  els.cloudTestBtn.disabled = true;
  els.cloudInfo.textContent = 'Checking…';
  try {
    const ctx = cloudCtx();
    const who = await ctx.api.check(ctx);
    els.cloudInfo.textContent = `Key accepted${who ? ` (${who})` : ''}. Save to keep it.`;
  } catch (err) {
    els.cloudInfo.textContent = `Key not usable: ${err.message}`;
  } finally {
    els.cloudTestBtn.disabled = false;
  }
});

els.resetTrackersBtn.addEventListener('click', () => {
  els.trackersInput.value = DEFAULT_TRACKERS.join('\n');
});

els.settingsDialog.addEventListener('close', () => {
  if (els.settingsDialog.returnValue !== 'save') return;

  const typed = els.trackersInput.value.split('\n').map((s) => s.trim()).filter((s) => /^wss?:\/\//i.test(s));
  const trackers = typed.filter(usableTracker);
  if (typed.length !== trackers.length) toast(`Ignored ${typed.length - trackers.length} tracker(s) on a port browsers refuse to open.`, { error: true });
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
    cloud: {
      provider: els.cloudProviderSelect.value,
      apiKey: els.cloudKeyInput.value.trim(),
      apiBase: /^https?:\/\//i.test(els.cloudBaseInput.value.trim()) ? els.cloudBaseInput.value.trim().replace(/\/+$/, '') : '',
      viaProxy: els.cloudProxyToggle.checked,
    },
    fallbackDelay: Math.max(5, Number(els.fallbackDelayInput.value) || 20),
    dohResolver: els.dohSelect.value || DEFAULT_DOH,
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
    if (!opfsOk) throw new Error('no OPFS');
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
    opfs: opfsOk,
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
        if (id && confirmExternalAdd(describeTorrentId(id))) await tryAddTorrent(id);
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

// A magnet pasted into the address bar of the already open app arrives as a hash change.
window.addEventListener('hashchange', async () => {
  const id = parseTorrentText(safeDecode(location.hash.slice(1)));
  if (!id) return;
  history.replaceState(null, '', location.pathname);
  if (confirmExternalAdd(describeTorrentId(id))) await tryAddTorrent(id);
});

/* ---------- startup ---------- */

(async function start() {
  // Storage housekeeping first, before anything can be added or seeded.
  storageReady = (async () => {
    opfsOk = await probeOpfs();
    if (!opfsOk) console.warn('OPFS unavailable: pieces are kept in memory for this session');
    const records = await dbAll();
    records.sort((a, b) => a.addedAt - b.addedAt);
    await cleanOrphanStores(records);
    return records;
  })();
  const [records] = await Promise.all([storageReady, saver.init()]);

  // Give the public tracker list a moment so restored torrents announce to it too; the cached list is
  // already applied, so on a slow network we simply continue and it merges in when it arrives.
  await Promise.race([refreshTrackerList(), new Promise((r) => setTimeout(r, 2500))]);
  maybeShowIosInstallHint();

  for (const record of records) {
    try {
      const id = sourceToId(record);
      if (!id) { dbDelete(record.infoHash); continue; }
      const torrent = await addTorrent(id, { record });
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
    if (id && confirmExternalAdd(describeTorrentId(id))) await tryAddTorrent(id);
  }
  await takeSharedInbox();

  updateEmptyState();
  updateWakeLock();
})();

// Expose for debugging and tests.
window.__phoneTorrent = { client, views, saver, addTorrent, seedFiles, torrentReach, unreachableReason, cloudCtx, CLOUD_PROVIDERS, effectiveTrackers, refreshTrackerList, fetchMetadataFallback, verifyTorrentBytes, findInfoSpan, runNetworkCheck, cleanOrphanStores, isComplete, get opfsOk() { return opfsOk; } };
