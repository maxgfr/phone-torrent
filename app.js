import WebTorrent from './vendor/webtorrent.min.js';
import { makeZip, predictLength } from './vendor/client-zip.js';
import { saver } from './saver.js';

const DEFAULT_CLOUD_PROVIDER = 'torbox';
const CLOUD_POLL_MS = 5000;

const DEFAULT_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://open.ftorrent.com',
];
// Defaults that stopped answering: tracker.btorrent.xyz's name now points at 127.0.0.1, and files.fm
// refuses the WebSocket with a 403. Settings saved before still hold them; see loadSettings.
const OLD_DEFAULT_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.files.fm:7073/announce',
];
const RETIRED_TRACKERS = ['wss://tracker.btorrent.xyz', 'wss://tracker.files.fm:7073/announce'];

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
  'https://itorrents.net/torrent/{INFOHASH}.torrent',
];
// Where an old default went: itorrents.org redirects to itorrents.net through plain http, which
// sends the info hash in the clear; torrage.info serves a page now, never a .torrent (null: dropped).
const RETIRED_METADATA_SOURCES = new Map([
  ['https://itorrents.org/torrent/{INFOHASH}.torrent', 'https://itorrents.net/torrent/{INFOHASH}.torrent'],
  ['https://torrage.info/torrent.php?h={INFOHASH}', null],
]);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * WebTorrent hashes every piece with crypto.subtle, which a browser gives only to a secure page:
 * HTTPS, or localhost. Opened over plain http from any other address — your own server at home, at
 * http://192.168.1.20:8080 — a torrent failed with "Invalid torrent identifier", or hashed for ever.
 * The cloud needs none of that, so the Cloud tab works there; the other two say why they do not.
 */
const IN_BROWSER_BLOCKED = window.isSecureContext && globalThis.crypto?.subtle
  ? ''
  : 'In-browser torrents need a secure page, HTTPS or localhost, and this one was opened over plain http. '
    + 'Here only the Cloud tab works: open the app over https (a tunnel or a deploy) for the rest.';

/**
 * Peers in a browser are WebRTC peers, found through ws:// and wss:// trackers, and some browsers turn
 * WebRTC off (Tor Browser, Mullvad Browser, Firefox with media.peerconnection.enabled false). WebTorrent
 * then skips every such tracker with a warning, and the card said it was waiting on four trackers it
 * talked to none of. Web seeds and the metadata caches are plain HTTP, and still work.
 */
const NO_WEBRTC = (WebTorrent.WEBRTC_SUPPORT ?? typeof RTCPeerConnection === 'function')
  ? ''
  : 'WebRTC is turned off in this browser, so it cannot reach any peer: only web seeds can send a torrent here. '
    + 'The Cloud tab still works.';

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
  autoResumeToggle: $('#autoresume-toggle'),
  seedAfterToggle: $('#seed-after-toggle'),
  strategySelect: $('#strategy-select'),
  installBtn: $('#install-btn'),
  metaSourcesInput: $('#metasources-input'),
  dohSelect: $('#doh-select'),
  netcheckBtn: $('#netcheck-btn'),
  netcheckResults: $('#netcheck-results'),
  corsProxyInput: $('#corsproxy-input'),
  cloudTab: $('.tab[data-tab="cloud"]'),
  cloudForm: $('#cloud-form'),
  cloudInput: $('#cloud-input'),
  cloudFileInput: $('#cloud-file-input'),
  cloudAccount: $('#cloud-account'),
  cloudError: $('#cloud-error'),
  cloudRefreshBtn: $('#cloud-refresh-btn'),
  cloudLibrary: $('#cloud-library'),
  cloudList: $('#cloud-list'),
  cloudEmpty: $('#cloud-empty'),
  cloudItemTemplate: $('#cloud-item-template'),
  cloudFileTemplate: $('#cloud-file-template'),
  modeSimpleBtn: $('#mode-simple'),
  modeExpertBtn: $('#mode-expert'),
  modeHint: $('#mode-hint'),
  cloudProviderSelect: $('#cloud-provider'),
  cloudKeyInput: $('#cloud-key'),
  cloudBaseInput: $('#cloud-base'),
  cloudBaseField: $('#cloud-base-field'),
  cloudProxyToggle: $('#cloud-proxy-toggle'),
  cloudTestBtn: $('#cloud-test-btn'),
  cloudInfo: $('#cloud-info'),
  fallbackDelayInput: $('#fallback-delay'),
  rtcInput: $('#rtc-input'),
  wakelockToggle: $('#wakelock-toggle'),
  debugToggle: $('#debug-toggle'),
  resetTrackersBtn: $('#reset-trackers-btn'),
  settingsForm: $('#settings-dialog form'),
  settingsError: $('#settings-error'),
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
    // `accounts` keeps the key and address of every service used before, so a transfer
    // started on one still answers after switching to another.
    cloud: { provider: DEFAULT_CLOUD_PROVIDER, apiKey: '', apiBase: '', viaProxy: false, accounts: {} },
    // Simple by default: the trackers, the fallbacks and the storage are already
    // set to what works, and nothing in Expert has to be touched to download.
    expert: false,
    // Phones freeze tabs they cannot see. On return, go and find the peers again
    // instead of waiting for BitTorrent's own timers.
    autoResume: true,
    fallbackDelay: 20, // seconds
    dohResolver: DEFAULT_DOH,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // A save writes every field, so the defaults of the day it was saved stay in it: a list that
      // was the old defaults becomes today's, and any other loses only the entries that died.
      let trackers = Array.isArray(parsed.trackers) ? parsed.trackers : [];
      if (trackers.join('\n') === OLD_DEFAULT_TRACKERS.join('\n')) trackers = defaults.trackers;
      trackers = trackers.filter((t) => !RETIRED_TRACKERS.includes(t));
      const sources = Array.isArray(parsed.metadataSources)
        ? [...new Set(parsed.metadataSources.map((s) => (RETIRED_METADATA_SOURCES.has(s) ? RETIRED_METADATA_SOURCES.get(s) : s)).filter(Boolean))]
        : defaults.metadataSources;
      return {
        ...defaults,
        ...parsed,
        trackers: trackers.length ? trackers : defaults.trackers,
        metadataSources: sources,
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

/**
 * One tracker however its address is written: the public list says wss://tracker.webtorrent.dev:443
 * where the defaults say wss://tracker.webtorrent.dev, and both were announced to.
 */
function trackerKey(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** All trackers to announce to: the user's list plus the fetched public list, deduplicated. */
function effectiveTrackers() {
  const extra = settings.trackerList ? (loadTrackerListCache()?.trackers || []) : [];
  const seen = new Set();
  return [...settings.trackers, ...extra].filter((t) => {
    const key = trackerKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    return usableTracker(t);
  });
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

/**
 * Look a hostname up through a DNS-over-HTTPS JSON resolver: 'exists' | 'nowhere' | 'nxdomain' |
 * 'unknown'. 'nowhere' is a name the public DNS points at no machine — 127.0.0.1 or 0.0.0.0, what a
 * parked domain's name is given. A resolver that does not answer within seconds is 'unknown': the
 * check is run on networks that drop things, and waited on it for ever.
 */
async function dohLookup(host) {
  const resolver = settings.dohResolver || DEFAULT_DOH;
  try {
    const res = await fetch(`${resolver}${resolver.includes('?') ? '&' : '?'}name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: 'application/dns-json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 'unknown';
    const data = await res.json();
    if (data.Status === 3) return 'nxdomain';
    if (data.Status !== 0 || !Array.isArray(data.Answer) || !data.Answer.length) return 'unknown';
    const addresses = data.Answer.filter((a) => a && a.type === 1).map((a) => String(a.data));
    return addresses.length && addresses.every((ip) => /^(127|0)\./.test(ip)) ? 'nowhere' : 'exists';
  } catch {
    return 'unknown';
  }
}

/**
 * Whether anything answers plain HTTP(S) at a tracker's host and port from this network. If it does,
 * nothing on the way is blocking that host: a WebSocket it refuses is the tracker's own doing.
 */
async function hostAnswers(url) {
  try {
    const u = new URL(url);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    await fetch(u, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

async function checkTracker(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return { url, level: 'bad', text: 'invalid URL' }; }
  const [reachable, dns] = await Promise.all([wsReachable(url), /^[\d.]+$|^\[/.test(host) ? 'exists' : dohLookup(host)]);
  if (reachable) return { url, level: 'ok', text: 'reachable' };
  if (dns === 'nxdomain') return { url, level: 'bad', text: 'does not exist any more (dead tracker)' };
  if (dns === 'nowhere') return { url, level: 'bad', text: 'its name points at no server any more (dead tracker)' };
  if (await hostAnswers(url)) return { url, level: 'bad', text: 'its server answers but refuses tracker connections (tracker down or closed)' };
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

const TAB_LOCK = 'phone-torrent:open-tab';

/**
 * A seed is never remembered, so to the housekeeping above the files another open tab is sharing
 * look orphaned. Every tab holds a shared lock for as long as it is open, and the cleanup only runs
 * when that lock can be had exclusively — when this is the only tab. Without Web Locks there is no
 * way to know, and the cleanup runs as it always did.
 */
async function cleanOrphanStoresIfAlone(records) {
  if (!navigator.locks?.request) return cleanOrphanStores(records);
  try {
    await navigator.locks.request(TAB_LOCK, { mode: 'exclusive', ifAvailable: true }, (lock) => (lock ? cleanOrphanStores(records) : null));
  } catch { /* no cleanup this time; it is only housekeeping */ }
  navigator.locks.request(TAB_LOCK, { mode: 'shared' }, () => new Promise(() => {})).catch(() => {});
}

/**
 * More than one copy of the app open at once — a second tab, a link opened in the browser while the
 * installed app runs — share one storage, and the same torrent run twice would download twice into
 * it. So one copy leads: it runs every torrent. The others follow: each shows the leading copy's
 * list as it goes and hands it whatever is done there — an add, a pause, a tick, a removal — and a
 * file saved there streams over from it. Settings saved in any copy apply in all of them.
 *
 * Leading goes with a Web Lock. When the leading copy closes, the next one takes over and restores
 * the torrents from storage; one being looked at while the leading copy no longer answers (a phone
 * freezes what it does not show) takes over at once. Without Web Locks every copy runs every
 * torrent, as it always did; with BroadcastChannel a removal or a delete-all is passed on, and
 * settings apply in every copy all the same.
 */
const LEAD_LOCK = 'phone-torrent:lead';
/** How long the leading copy may stay silent to a follower being looked at before that one takes over. */
const LEAD_SILENCE_MS = 6000;
const otherCopies = typeof BroadcastChannel === 'function' ? new BroadcastChannel('phone-torrent') : null;
const copyId = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
/** This copy shows the torrents another one runs, instead of running them. */
let follower = false;
/** Whether this copy knows yet which it is: one still starting answers no other copy. */
let decided = false;
/** When this copy took the lead: a copy that led before it, and thaws, is older, and not followed. */
let leadSince = 0;
/** When a follower last asked for anything: while one is about, the leading copy tells it what happens. */
let followerSeenAt = 0;

function followersNear() {
  return Boolean(otherCopies) && Date.now() - followerSeenAt < 15000;
}

/**
 * confirm() and prompt() stop this copy until they are answered. In the copy that runs the torrents,
 * a follower being looked at (another window) would take that for a copy the phone froze: it is told
 * first, and waits.
 */
function askUser(ask) {
  const tell = decided && !follower && followersNear();
  if (tell) otherCopies.postMessage({ type: 'asking', from: copyId });
  try {
    return ask();
  } finally {
    if (tell) otherCopies.postMessage({ type: 'answered', from: copyId });
  }
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

/**
 * Unless the page asks, what it stores is best-effort: a browser short of space clears it as a whole,
 * gigabytes of a half-finished torrent and the list of torrents with it, and Safari caps it. Asked
 * once, when a torrent is first added or seeded rather than on opening the page: a browser that asks
 * the user (Firefox) does it after something they did, and one that decides by itself (Chrome) has a
 * reason to say yes. Settings → Storage says which it is.
 */
let storageKept = null;
function keepStorage() {
  if (storageKept || !navigator.storage?.persist) return;
  storageKept = navigator.storage.persist().catch(() => false);
}

/**
 * Memory stores by name ("<torrent name> - <first 8 hex of info hash>", as WebTorrent names them).
 * A retry, or coming back to a frozen tab, removes a torrent and adds it again; with OPFS the new
 * torrent finds its pieces on disk, and this is what lets it find them in memory too.
 */
const memoryStores = new Map();

/** Minimal in-memory chunk store with the interface WebTorrent expects. */
class MemoryChunkStore {
  constructor(chunkLength, opts = {}) {
    // The same torrent added again gets the store it had, pieces and all: close() kept them.
    const kept = opts.name ? memoryStores.get(opts.name) : null;
    if (kept && kept.chunkLength === Number(chunkLength)) {
      kept.closed = false;
      return kept;
    }
    this.name = opts.name || '';
    this.chunkLength = Number(chunkLength);
    this.chunks = new Map();
    this.closed = false;
    if (this.name) memoryStores.set(this.name, this);
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
    if (memoryStores.get(this.name) === this) memoryStores.delete(this.name);
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
  // What the copy running the torrents says is for the copy being looked at (see LEAD_LOCK) — unless
  // this is the one in use, and it answers what was done in it.
  if (decided && !follower && followersNear() && !document.hasFocus()) otherCopies.postMessage({ type: 'toast', message: String(message), error, timeout });
}

function parseTorrentText(text) {
  const t = (text || '').trim();
  if (!t) return null;
  // A magnet anywhere in the text wins, and only the magnet: the app's own link carries one in its
  // fragment (https://…/#magnet:?…), which is not a .torrent to fetch, and shared text often has a
  // title on the next line, which is not part of the last parameter. A phone keyboard capitalises the
  // first letter of what is typed, and WebTorrent takes only a lower-case "magnet:".
  const magnet = t.match(/magnet:\?[^\s"<>]+/i);
  if (magnet) return trimSentence(magnet[0]).replace(/^magnet:/i, 'magnet:');
  if (/^[a-f0-9]{40}$/i.test(t) || /^[a-z2-7]{32}$/i.test(t)) return `magnet:?xt=urn:btih:${t}`;
  if (/^https?:\/\/\S+$/i.test(t)) return t;
  return null;
}

/**
 * A link as it sits in a sentence, without the sentence around it: "here: magnet:?….",
 * "(magnet:?…)", "[link](magnet:?…)". A closing bracket whose opening one is in the link is the
 * link's own, as in a name like "Show_(2020)".
 */
function trimSentence(link) {
  const count = (c) => link.split(c).length - 1;
  for (;;) {
    const last = link.slice(-1);
    const opening = { ')': '(', ']': '[', '}': '{' }[last];
    if (opening ? count(opening) < count(last) : /[.,;:!?']/.test(last)) link = link.slice(0, -1);
    else return link;
  }
}

/**
 * Why this magnet cannot be added, in words, or '' when it can. WebTorrent needs a v1 info hash —
 * xt=urn:btih: and 40 hexadecimal or 32 base32 characters — and without one says only "Invalid
 * torrent identifier", which tells whoever pasted a link cut short in a chat nothing at all. It
 * reads the first 40 characters after "btih:" (the first 32 when there are fewer), and what comes
 * after them is no reason to refuse a link it takes.
 */
function magnetProblem(magnet) {
  const xts = magnet.slice(magnet.indexOf('?') + 1).split('&').filter((p) => p.startsWith('xt=')).map((p) => p.slice(3));
  const hashes = xts.filter((xt) => xt.startsWith('urn:btih:')).map((xt) => xt.slice(9));
  if (hashes.some((h) => (h.length >= 40 ? /^[a-f0-9]{40}/i : /^[a-z2-7]{32}/i).test(h))) return '';
  if (hashes.length) {
    const [h] = hashes;
    // Shorter than a base32 hash, or hexadecimal and shorter than a hex one: the end is missing.
    return h.length < 32 || (h.length < 40 && /^[a-f0-9]+$/i.test(h))
      ? `This magnet's info hash is ${h.length} characters long where it takes 40 (or 32 in base32): `
        + 'the link was probably cut short. Copy the whole of it again.'
      : 'This magnet\'s info hash has characters no info hash has: it was changed on the way. Copy the whole link again.';
  }
  if (xts.some((xt) => /^urn:btmh:/i.test(xt))) {
    return 'This magnet only carries a BitTorrent v2 info hash (btmh), and this app needs a v1 one (btih). '
      + 'Try the .torrent file instead, or a magnet that has both.';
  }
  return 'This magnet has no info hash (xt=urn:btih:…), so there is nothing to look for. Copy the whole link again.';
}

function safeDecode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

/**
 * The magnet in this page's fragment. It is kept as it is — its parameters are percent-encoded
 * already, and decoding the whole of it turns a "%26" inside a name into a separator — unless the
 * magnet itself arrived encoded (#magnet%3A%3F…).
 */
function magnetFromHash() {
  const raw = location.hash.slice(1);
  return parseTorrentText(/^magnet%3a/i.test(raw) ? safeDecode(raw) : raw);
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

/** Something is still wanted from the swarm: the metadata, or a selected file. Nothing selected wants nothing. */
function wantsData(torrent) {
  if (!torrent.metadata) return true;
  const view = views.get(torrent);
  return Boolean(view) && selectedFiles(view).some((f) => !(f.done || f.progress >= 1));
}

/**
 * Getting ready rather than looking for peers: a seed whose files are still being hashed and copied
 * in, or a torrent checking the pieces it already has (a restore, a rebuild). WebTorrent starts
 * discovery only once that is done, so such a torrent has no peers yet — and rebuilding it would
 * start that work over, or, for a seed that has no info hash yet, lose it altogether.
 */
function preparing(torrent) {
  return !torrent.infoHash || (Boolean(torrent.metadata) && !torrent.ready) || Boolean(views.get(torrent)?.seeding && !torrent.done);
}

/**
 * Torrents that arrive from outside the app (shared, magnet: handler, URL) need a tap first. Where
 * torrents cannot run in the page, the answer is no before anything is asked: the question was
 * whether to start a download that could only be refused once it was said yes to.
 */
function confirmExternalAdd(label) {
  if (IN_BROWSER_BLOCKED) {
    toast(IN_BROWSER_BLOCKED, { error: true, timeout: 9000 });
    return false;
  }
  return askUser(() => confirm(`Add ${label} to Phone Torrent and start downloading it?`));
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
    // iOS ignores select() on a read-only field: without a selection range, "copy" copies nothing.
    ta.setSelectionRange(0, ta.value.length);
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

/**
 * Private, and no tracker of its own a page can talk to: nothing will ever download here. A public
 * torrent with only udp:// or http:// trackers is not that — the app's own wss:// trackers are asked.
 */
function cannotDownloadHere(reach) {
  return Boolean(reach && reach.private && !reach.webrtc);
}

/**
 * What a fetch that threw means. Offline, it is that — and a CORS proxy would not help. Online, it
 * is almost always a server that does not allow browser (CORS) requests.
 */
function unreachable() {
  return new Error(navigator.onLine ? 'blocked by CORS or unreachable' : 'you are offline');
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
      onAttempt(url, err instanceof TypeError ? unreachable() : err);
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

/**
 * Served by your own server, the page is at the server's own address, so it needs no setting at
 * all. When no service has been set up yet — TorBox by default, and no key for any service — it
 * asks its own origin whether it is one, and if so makes it the service, with the address left
 * empty ("this page"). Anywhere else, GitHub Pages or `npm start`, that address is a 404 and nothing
 * changes. Without this the server's own page said "No API key yet" and asked for a TorBox key.
 */
async function adoptOwnServer() {
  const untouched = () => settings.cloud.provider === DEFAULT_CLOUD_PROVIDER && !settings.cloud.apiKey
    && !Object.values(settings.cloud.accounts || {}).some((a) => a && a.apiKey);
  if (!untouched()) return false;
  try {
    const res = await fetch(new URL('/api/health', location.origin), { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    const health = res.ok ? await res.json() : null;
    if (health?.ok !== true || typeof health.torrents !== 'number') return false;
  } catch {
    return false;
  }
  // Settings saved while this was asking have the say.
  if (!untouched()) return false;
  const accounts = { ...settings.cloud.accounts, [settings.cloud.provider]: { apiKey: '', apiBase: settings.cloud.apiBase || '' } };
  saveSettings({ ...settings, cloud: { ...settings.cloud, provider: 'server', apiKey: '', apiBase: '', accounts } });
  return true;
}

function cloudReady() {
  // Your own server may run without a token, alone on your machine; every hosted service needs a key.
  return Boolean(settings.cloud && (settings.cloud.apiKey || settings.cloud.provider === 'server'));
}

/** The key and address saved for one service: the current one, or one used before. */
function cloudAccount(provider) {
  if (provider === settings.cloud.provider) return { apiKey: settings.cloud.apiKey || '', apiBase: settings.cloud.apiBase || '' };
  const saved = (settings.cloud.accounts || {})[provider] || {};
  return { apiKey: saved.apiKey || '', apiBase: saved.apiBase || '' };
}

/**
 * A provider's built-in address, used when none was typed. It can depend on where the page is:
 * served by your own server, the address to call is the one you are already on — hence a function.
 */
function providerBase(api) {
  return (typeof api.defaultBase === 'function' ? api.defaultBase() : api.defaultBase) || '';
}

/**
 * Where a transfer lives: which API, at which base URL, with which key. The provider and base are
 * stored with the torrent so it survives a reload; the key is that service's own, not whichever
 * service is selected now. `over.key` and `over.viaProxy` let the settings dialog try what is typed
 * before it is saved.
 */
function cloudCtx(over = {}) {
  const provider = CLOUD_PROVIDERS[over.provider] ? over.provider : (CLOUD_PROVIDERS[settings.cloud.provider] ? settings.cloud.provider : DEFAULT_CLOUD_PROVIDER);
  const api = CLOUD_PROVIDERS[provider];
  const account = cloudAccount(provider);
  const base = (over.base || account.apiBase || providerBase(api)).replace(/\/+$/, '');
  const key = over.key !== undefined ? over.key : account.apiKey;
  const viaProxy = over.viaProxy !== undefined ? Boolean(over.viaProxy) : Boolean(settings.cloud.viaProxy);
  return { provider, base, key, api, json: (url, opts = {}) => cloudJson(url, { ...opts, key, viaProxy, provider }) };
}

/**
 * An https page may not call an http:// address (mixed content): the browser refuses before anything
 * is sent, and tells a script nothing it could tell from CORS. The installed app, on https, pointed at
 * your own server's http:// address is the case. A CORS proxy fetches that address itself, so it is
 * asked instead when one is set, and reaches a server on the internet; ALLOWED_ORIGINS cannot help,
 * and a proxy cannot reach a machine at home on its LAN address. Loopback (localhost, *.localhost,
 * 127.0.0.0/8, [::1]) is allowed by the browsers that allow it, and asked as usual.
 */
function mixedContent(url) {
  let target;
  try { target = new URL(url, location.href); } catch { return ''; }
  if (location.protocol !== 'https:' || target.protocol !== 'http:' || /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(target.hostname)) return '';
  return `this page is https, and a browser will not let it call an http:// address. Open the app at ${target.origin} itself, or reach the server over https (the tunnel, or a deploy)`;
}

/**
 * What a call the browser could not make at all means, in words that lead to the fix. A script cannot
 * tell a refusal of CORS from a server that is not there. A hosted service is there, and refuses
 * browser requests: that is what the CORS proxy is for. Your own server is never that: from the page it
 * serves there is no CORS at all, so it is not answering; from another page it may be that too, or a
 * server that does not name this page in ALLOWED_ORIGINS. A proxy would not reach a machine at home.
 */
function unreachableApi(url, provider) {
  if (provider !== 'server') return 'the browser could not reach the API (CORS or network)';
  if (new URL(url, location.href).origin === location.origin) return 'your server is not answering (is it running?)';
  return `the server did not answer, or does not allow this page: add ${location.origin} to its ALLOWED_ORIGINS`;
}

/**
 * One call to a cloud API. The key travels in an Authorization header, which makes this a request
 * the API must allow with CORS; when it does not, the user's own proxy relays it instead. Resolves
 * with the answer, and whether it came through that proxy.
 */
async function cloudFetch(url, { method = 'GET', body, json = false, contentType, key = '', viaProxy: onlyProxy = false, provider = '' } = {}) {
  const viaProxy = proxied(url);
  const hasProxy = viaProxy !== url;
  // An address the browser will not call from here is not asked directly: only through the proxy,
  // if there is one, and otherwise not at all.
  const mixed = mixedContent(url);
  if (mixed && !hasProxy) throw Object.assign(new Error(mixed), { transient: false });
  const targets = (onlyProxy || mixed) && hasProxy ? [viaProxy] : hasProxy ? [url, viaProxy] : [url];
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  if (json) headers['Content-Type'] = 'application/json';
  if (contentType) headers['Content-Type'] = contentType;
  let last = null;
  for (const target of targets) {
    try {
      return { res: await fetch(target, { method, body, headers, cache: 'no-store' }), relayed: target !== url };
    } catch {
      // A network-level rejection is indistinguishable from CORS in script.
      last = target === url ? unreachableApi(url, provider) : 'the proxy did not answer';
    }
  }
  const err = !navigator.onLine ? new Error('you are offline')
    : new Error(mixed ? `${last}, and ${mixed}` : hasProxy ? `${last}, and the proxy did not help` : provider === 'server' ? last : `${last}. Set a CORS proxy in Settings to relay it.`);
  // Worth asking again all the same: a phone changes networks, and a poll of a transfer that was
  // sent through this very API was not refused by CORS.
  err.transient = true;
  throw err;
}

/**
 * An answer that may well be different next time: the service is busy (408, 425, 429) or down
 * (5xx — also what Cloudflare in front of these APIs answers for the service behind it). Anything
 * else, a key refused or a transfer the service does not know, will be the same answer again.
 */
function transientStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** The host an error should name, without throwing on a URL that never parsed. */
function hostOf(url) {
  try { return new URL(url, location.href).host; } catch { return String(url).slice(0, 60); }
}

async function cloudJson(url, opts) {
  // Every provider has a base URL now (your own server's is this page's origin), so a
  // relative one means a bug or a half-written setting — never a request worth sending.
  if (/^\/+api\//.test(url) || url.startsWith('/')) throw new Error('Set the server address in Settings → Cloud fetch.');
  const { res, relayed } = await cloudFetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* an error page, not JSON */ }
  // Each service says "no" in its own dialect: TorBox with success:false, put.io
  // with status ERROR, AllDebrid with status error and an {error:{message}}. A
  // Real-Debrid torrent whose own status is "error" is an answer, not a failed call.
  const status = json && typeof json.status === 'string' ? json.status.toLowerCase() : '';
  const failed = !res.ok || (json && json.success === false) || (status === 'error' && Boolean(json.error || json.error_message));
  if (failed) {
    const busy = !res.ok && transientStatus(res.status);
    // Through the CORS proxy, a refusal in one line of plain text is the proxy's own — a write to a
    // host its API_HOSTS does not name, most often — and that line is the reason, not the address.
    const proxyRefused = relayed && text.trim() && !/[<{]/.test(text);
    const detail = (json && (json.detail || json.error_message
      || (json.error && (json.error.message || (typeof json.error === 'string' ? json.error : '')))))
      // Not JSON at all: from a service that is busy or down, that is the error page of whatever
      // stands in front of it. Otherwise the address is not an API — most often a server address
      // that was never set, so the page's own host answered with its 404 page.
      || (json ? '' : busy
        ? `${hostOf(url)} is busy or down (HTTP ${res.status})`
        : proxyRefused
          ? `your CORS proxy refused it (${res.status}: ${text.trim().slice(0, 120)})${/API_HOSTS/.test(text) ? `: add ${hostOf(url)} to its API_HOSTS` : ''}`
          : `${hostOf(url)} answered ${res.status}, and not with this API — check the address in Settings → Cloud fetch.`)
      || text.slice(0, 120) || `HTTP ${res.status}`;
    throw Object.assign(new Error(String(detail)), { status: res.status, transient: busy });
  }
  return json || {};
}

/**
 * A queue for calls a service allows only so many of: at most `inFlight` at once, and `gap` ms
 * between one starting and the next. One per service, shared by every card and the library, so
 * that cards restored together ask no faster than one does.
 */
function pacer(gap, inFlight) {
  const waiting = [];
  let running = 0;
  let lastStart = 0;
  let timer = null;
  const next = () => {
    if (timer || running >= inFlight || !waiting.length) return;
    const wait = lastStart + gap - Date.now();
    if (wait > 0) {
      timer = setTimeout(() => { timer = null; next(); }, wait);
      return;
    }
    lastStart = Date.now();
    running += 1;
    const { call, resolve, reject } = waiting.shift();
    call().then(resolve, reject).finally(() => { running -= 1; next(); });
    next();
  };
  return (call) => new Promise((resolve, reject) => {
    waiting.push({ call, resolve, reject });
    next();
  });
}

/**
 * Each file's download link, asked for on its own: a file the service refuses for now keeps its
 * place with the reason instead of a link (asked for again on the next look), and the others keep
 * theirs. Only when not one came is it the call that failed, and its error is the answer.
 */
async function withLinks(files, linkFor) {
  const settled = await Promise.allSettled(files.map((f, i) => linkFor(i)));
  if (files.length && settled.every((s) => s.status === 'rejected')) throw settled[0].reason;
  return files.map((f, i) => (settled[i].status === 'fulfilled'
    ? { ...f, url: settled[i].value }
    : { ...f, url: '', error: settled[i].reason.message }));
}

const CLOUD_PROVIDERS = {
  torbox: {
    label: 'TorBox',
    defaultBase: 'https://api.torbox.app',
    keyPlaceholder: 'TorBox API key',

    async check(ctx) {
      const { data } = await ctx.json(`${ctx.base}/v1/api/user/me?settings=false`);
      return pick(data || {}, 'email', 'customer', 'id');
    },

    async submit(ctx, { bytes, name, magnet }) {
      const form = new FormData();
      if (bytes) form.append('file', new Blob([bytes], { type: 'application/x-bittorrent' }), `${name}.torrent`);
      else form.append('magnet', magnet);
      const { data } = await ctx.json(`${ctx.base}/v1/api/torrents/createtorrent`, { method: 'POST', body: form });
      const id = pick(data || {}, 'torrent_id', 'torrentId', 'id');
      if (id !== undefined) return id;
      // With every active slot taken, TorBox queues the torrent instead: it gets a queued id,
      // lives in /queued rather than /torrents, and gets a torrent id of its own once it starts.
      const queuedId = pick(data || {}, 'queued_id', 'queuedId');
      if (queuedId === undefined) throw new Error('the API did not return a torrent id');
      return this.queuedKey(queuedId, pick(data || {}, 'hash'));
    },

    /** A queued transfer's id: its queue id, and the info hash that finds it once it has started. */
    queuedKey(queuedId, hash) {
      return `queued:${queuedId}:${String(hash || '').toLowerCase()}`;
    },

    queued(id) {
      const m = String(id).match(/^queued:(\d+):([a-f0-9]*)$/i);
      return m ? { id: m[1], hash: m[2].toLowerCase() } : null;
    },

    normalizeQueued(raw) {
      return { state: 'queued', progress: 0, ready: false, failed: false, name: pick(raw, 'name') || '', size: Number(pick(raw, 'size') || 0), files: [] };
    },

    normalize(raw) {
      const ready = Boolean(pick(raw, 'download_present', 'downloadPresent')) || Boolean(pick(raw, 'download_finished', 'downloadFinished'));
      const state = String(pick(raw, 'download_state', 'downloadState') || 'unknown');
      return {
        state,
        progress: Number(pick(raw, 'progress') || 0),
        ready,
        // Nothing left to wait for: polling it again would only ask the same question.
        failed: !ready && /error|fail/i.test(state),
        name: pick(raw, 'name') || '',
        size: Number(pick(raw, 'size') || 0),
        // Its list names the files of a torrent still downloading too, but their links lead to an
        // error page until it is done: no files until then, as every other service does.
        files: (ready && Array.isArray(raw.files) ? raw.files : []).map((f) => ({
          id: pick(f, 'id'),
          name: String(pick(f, 'short_name', 'shortName', 'name') || 'file'),
          size: Number(pick(f, 'size') || 0),
        })),
      };
    },

    /**
     * The queue, or one entry of it. TorBox answers "not found" for an entry that has left it, and
     * a clone may have no queue at all: both read as an empty queue. A failed call does not — it
     * would pass for the transfer having left the queue, and the transfer for lost.
     */
    getQueued(ctx, queuedId) {
      const one = queuedId === undefined ? '' : `id=${queuedId}&`;
      return ctx.json(`${ctx.base}/v1/api/queued/getqueued?${one}type=torrent&bypass_cache=true`).catch((err) => {
        if (err.transient) throw err;
        return {};
      });
    },

    async status(ctx, id) {
      const queued = this.queued(id);
      if (queued) {
        const waiting = await this.getQueued(ctx, queued.id);
        const row = Array.isArray(waiting.data) ? waiting.data[0] : waiting.data;
        if (row) return { id, ...this.normalizeQueued(row) };
        // It has left the queue: an ordinary torrent now, under the id TorBox gave it.
        const { data } = await ctx.json(`${ctx.base}/v1/api/torrents/mylist?bypass_cache=true`);
        const started = (Array.isArray(data) ? data : []).find((t) => queued.hash && String(pick(t, 'hash') || '').toLowerCase() === queued.hash);
        if (!started) throw new Error('the cloud no longer knows this transfer');
        return { id: pick(started, 'id'), ...this.normalize(started) };
      }
      const { data } = await ctx.json(`${ctx.base}/v1/api/torrents/mylist?id=${encodeURIComponent(id)}&bypass_cache=true`);
      const raw = Array.isArray(data) ? data[0] : data;
      if (!raw) throw new Error('the cloud no longer knows this transfer');
      return this.normalize(raw);
    },

    async list(ctx) {
      const [{ data }, waiting] = await Promise.all([
        ctx.json(`${ctx.base}/v1/api/torrents/mylist?bypass_cache=true`),
        this.getQueued(ctx),
      ]);
      const rows = Array.isArray(data) ? data : (data ? [data] : []);
      const queue = Array.isArray(waiting.data) ? waiting.data : [];
      return [
        ...rows.map((raw) => ({ id: pick(raw, 'id'), ...this.normalize(raw) })),
        ...queue.map((raw) => ({ id: this.queuedKey(pick(raw, 'id'), pick(raw, 'hash')), ...this.normalizeQueued(raw) })),
      ];
    },

    async remove(ctx, id) {
      const queued = this.queued(id);
      if (queued) {
        await ctx.json(`${ctx.base}/v1/api/queued/controlqueued`, {
          method: 'POST',
          body: JSON.stringify({ queued_id: Number(queued.id), operation: 'delete', type: 'torrent' }),
          json: true,
        });
        return;
      }
      await ctx.json(`${ctx.base}/v1/api/torrents/controltorrent`, {
        method: 'POST',
        body: JSON.stringify({ torrent_id: Number(id), operation: 'delete' }),
        json: true,
      });
    },

    async account(ctx) {
      const { data } = await ctx.json(`${ctx.base}/v1/api/user/me?settings=false`);
      const who = pick(data || {}, 'email', 'customer', 'id');
      const plan = pick(data || {}, 'plan');
      return { who: who ? String(who) : '', detail: plan !== undefined ? `plan ${plan}` : '' };
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

  // Your own machine, or one you deployed: a real client with real TCP, UDP and
  // DHT, so the swarms a browser cannot reach are ordinary here. See server/.
  server: {
    label: 'My own server',
    // Empty means "this page's own origin", which is exactly right when the
    // server is the one serving the app — `docker compose up` and nothing to type.
    defaultBase: () => location.origin,
    keyPlaceholder: 'Server token (AUTH_TOKEN)',

    async check(ctx) {
      const { who, detail } = await ctx.json(`${ctx.base}/api/account`);
      return [who, detail].filter(Boolean).join(' · ');
    },

    async submit(ctx, { bytes, magnet }) {
      const { transfer } = bytes
        ? await ctx.json(`${ctx.base}/api/transfers`, { method: 'POST', body: bytes, contentType: 'application/x-bittorrent' })
        : await ctx.json(`${ctx.base}/api/transfers`, { method: 'POST', body: JSON.stringify({ magnet }), json: true });
      if (!transfer || !transfer.id) throw new Error('the server did not return a transfer');
      return transfer.id;
    },

    async status(ctx, id) {
      const { transfer } = await ctx.json(`${ctx.base}/api/transfers/${encodeURIComponent(id)}`);
      if (!transfer) throw new Error('the server no longer knows this transfer');
      return transfer;
    },

    async list(ctx) {
      const { transfers } = await ctx.json(`${ctx.base}/api/transfers`);
      return transfers || [];
    },

    async remove(ctx, id) {
      await ctx.json(`${ctx.base}/api/transfers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    async account(ctx) {
      const { who, detail } = await ctx.json(`${ctx.base}/api/account`);
      return { who: who || 'your server', detail: detail || '' };
    },

    // A <video> cannot send an Authorization header. The server hands out a link per
    // file, signed with the token rather than carrying it, good for one file and one day.
    // A server from before those links takes the token in the query string instead.
    fileLink(ctx, id, file) {
      if (!file) return '';
      if (file.link) return `${ctx.base}${file.link}`;
      const url = new URL(`${ctx.base}/api/transfers/${encodeURIComponent(id)}/files/${encodeURIComponent(file.id)}`);
      if (ctx.key) url.searchParams.set('token', ctx.key);
      return url.toString();
    },
    zipLink: false,
  },

  // Real-Debrid hands back one link per file, and each has to be unrestricted
  // before it can be downloaded — so that happens when a transfer turns ready.
  realdebrid: {
    label: 'Real-Debrid',
    defaultBase: 'https://api.real-debrid.com',
    keyPlaceholder: 'Real-Debrid API token',

    async check(ctx) {
      const user = await ctx.json(`${ctx.base}/rest/1.0/user`);
      return user && (user.username || user.email);
    },

    async submit(ctx, { bytes, magnet }) {
      const added = bytes
        ? await ctx.json(`${ctx.base}/rest/1.0/torrents/addTorrent`, { method: 'PUT', body: bytes, contentType: 'application/x-bittorrent' })
        : await ctx.json(`${ctx.base}/rest/1.0/torrents/addMagnet`, { method: 'POST', body: new URLSearchParams({ magnet }) });
      if (!added || !added.id) throw new Error('Real-Debrid did not return a torrent id');
      // The torrent is on the account from here on. A choice of files that does not go through
      // is made when it is next seen waiting (startIfWaiting), not reported as a failed send —
      // which would only have the same torrent sent twice.
      try {
        await this.selectAll(ctx, added.id);
      } catch {
        this.owed(added.id, true);
      }
      return added.id;
    },

    // Nothing downloads until files are chosen; "all" is what a torrent client does.
    selectAll(ctx, id) {
      return ctx.json(`${ctx.base}/rest/1.0/torrents/selectFiles/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: new URLSearchParams({ files: 'all' }),
      });
    },

    /**
     * RD holds a torrent until its files are chosen, and never chooses them itself. When that did
     * not happen on adding — RD allows so many calls a minute, and a magnet may still be being
     * converted — the choice is owed: whoever next sees the torrent waiting makes it, and again
     * only after a failure that may go away. Only for a torrent this app added: one added on RD's
     * site, or by another tool, and left waiting is its owner's choice still to make, and RD cannot
     * undo one. Kept on the device, so that a reload in between still finishes the job.
     */
    owedIds: null,
    owed(id, on) {
      const key = 'phone-torrent:rd-owed';
      if (!this.owedIds) {
        let saved = [];
        try { saved = JSON.parse(localStorage.getItem(key) || '[]'); } catch { /* none */ }
        this.owedIds = new Set(Array.isArray(saved) ? saved.map(String) : []);
      }
      if (on === undefined) return this.owedIds.has(String(id));
      if (on) this.owedIds.add(String(id));
      else this.owedIds.delete(String(id));
      try { localStorage.setItem(key, JSON.stringify([...this.owedIds])); } catch { /* for this session only, then */ }
      return on;
    },
    async startIfWaiting(ctx, raw) {
      if (!raw || raw.status !== 'waiting_files_selection' || !this.owed(raw.id)) return raw;
      try {
        await this.selectAll(ctx, raw.id);
        this.owed(raw.id, false);
        return { ...raw, status: 'starting' };
      } catch (err) {
        if (!err.transient) this.owed(raw.id, false);
        return raw;
      }
    },

    normalize(raw) {
      const state = String(raw.status || 'unknown');
      return {
        id: raw.id,
        state,
        progress: Number(raw.progress || 0) / 100,
        ready: state === 'downloaded',
        failed: ['magnet_error', 'error', 'virus', 'dead'].includes(state),
        name: raw.filename || raw.original_filename || '',
        size: Number(raw.bytes || raw.original_bytes || 0),
        files: [],
      };
    },

    async status(ctx, id) {
      const raw = await this.startIfWaiting(ctx, await ctx.json(`${ctx.base}/rest/1.0/torrents/info/${encodeURIComponent(id)}`));
      if (!raw || !raw.id) throw new Error('Real-Debrid no longer knows this transfer');
      const out = this.normalize(raw);
      if (!out.ready) return out;
      // links[] lines up with the files the torrent selected, in the same order.
      const links = raw.links || [];
      const selected = (raw.files || []).filter((f) => f.selected).slice(0, links.length);
      out.files = await withLinks(selected.map((f, i) => ({
        id: f.id,
        name: String(f.path || '').replace(/^\//, '') || `file ${i + 1}`,
        size: Number(f.bytes || 0),
      })), (i) => this.unrestrict(ctx, links[i]));
      return out;
    },

    // RD allows 250 calls a minute and counts the ones it refuses: links are asked for under three
    // a second, which leaves room for the polls. One asked for already is not asked for again this
    // session — a pack's links on every reload and every look would soon use up the minute.
    pace: pacer(350, 2),
    links: new Map(),
    async unrestrict(ctx, link) {
      if (!this.links.has(link)) {
        const unrestricted = await this.pace(() => ctx.json(`${ctx.base}/rest/1.0/unrestrict/link`, {
          method: 'POST',
          body: new URLSearchParams({ link }),
        }));
        if (unrestricted && unrestricted.download) this.links.set(link, unrestricted.download);
      }
      return this.links.get(link) || '';
    },

    // RD lists an account a page at a time, and a small page unless asked for more: pages of a
    // hundred, a size every version of its docs allows, until one comes back short. Ten at most.
    async list(ctx) {
      const rows = [];
      for (let page = 0; page < 10; page++) {
        const batch = await ctx.json(`${ctx.base}/rest/1.0/torrents?offset=${rows.length}&limit=100`);
        const got = Array.isArray(batch) ? batch : [];
        // An API that ignored the offset would hand the first page back again, and again.
        if (rows.length && got.length && got[0].id === rows[0].id) break;
        rows.push(...got);
        if (got.length < 100) break;
      }
      const started = [];
      for (const raw of rows) started.push(await this.startIfWaiting(ctx, raw));
      return started.map((raw) => this.normalize(raw));
    },

    async remove(ctx, id) {
      await ctx.json(`${ctx.base}/rest/1.0/torrents/delete/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    async account(ctx) {
      const user = await ctx.json(`${ctx.base}/rest/1.0/user`);
      const days = user && user.premium ? Math.round(Number(user.premium) / 86400) : 0;
      return {
        who: (user && (user.username || user.email)) || '',
        detail: days ? `premium, ${days} day${days === 1 ? '' : 's'} left` : (user && user.type) || '',
      };
    },

    // The unrestricted link needs no key of its own, which is what makes it
    // something a <video> or a download can follow.
    fileLink(ctx, id, file) {
      return (file && file.url) || '';
    },
    zipLink: false,
  },

  alldebrid: {
    label: 'AllDebrid',
    defaultBase: 'https://api.alldebrid.com',
    keyPlaceholder: 'AllDebrid API key',

    // Its key rides in the query string, and it wants to know who is calling.
    query(ctx, extra = {}) {
      return new URLSearchParams({ agent: 'phone-torrent', apikey: ctx.key, ...extra }).toString();
    },

    async check(ctx) {
      const { data } = await ctx.json(`${ctx.base}/v4/user?${this.query(ctx)}`);
      return data && data.user && data.user.username;
    },

    async submit(ctx, { bytes, magnet, name }) {
      let magnets;
      if (bytes) {
        const form = new FormData();
        form.append('files[]', new Blob([bytes], { type: 'application/x-bittorrent' }), `${name || 'torrent'}.torrent`);
        // A file upload answers with data.files (each { file, name, id, ... }), not data.magnets.
        ({ data: { files: magnets } = {} } = await ctx.json(`${ctx.base}/v4/magnet/upload/file?${this.query(ctx)}`, { method: 'POST', body: form }));
      } else {
        ({ data: { magnets } = {} } = await ctx.json(`${ctx.base}/v4/magnet/upload?${this.query(ctx, { 'magnets[]': magnet })}`, { method: 'POST' }));
      }
      const first = Array.isArray(magnets) ? magnets[0] : magnets;
      if (!first || first.id === undefined) throw new Error((first && first.error && first.error.message) || 'AllDebrid did not return a transfer id');
      return first.id;
    },

    normalize(raw) {
      const state = String(raw.status || 'unknown').toLowerCase();
      const size = Number(raw.size || 0);
      return {
        id: raw.id,
        state,
        progress: size ? Math.min(1, Number(raw.downloaded || 0) / size) : 0,
        ready: state === 'ready',
        // statusCode 5 and up: an error, or expired. It will not become ready.
        failed: Number(raw.statusCode) >= 5,
        name: raw.filename || '',
        size,
        files: [],
      };
    },

    async status(ctx, id) {
      const { data } = await ctx.json(`${ctx.base}/v4.1/magnet/status?${this.query(ctx, { id })}`);
      const raw = data && (data.magnets && !Array.isArray(data.magnets) ? data.magnets : (data.magnets || [])[0]);
      if (!raw) throw new Error('AllDebrid no longer knows this transfer');
      const out = this.normalize(raw);
      if (!out.ready) return out;
      const files = await ctx.json(`${ctx.base}/v4/magnet/files?${this.query(ctx, { 'id[]': id })}`);
      const entry = ((files.data && files.data.magnets) || [])[0] || {};
      // Its file tree nests folders; a flat list is what the app shows.
      const flat = [];
      const walk = (nodes, prefix) => {
        for (const node of nodes || []) {
          if (node.e) walk(node.e, `${prefix}${node.n}/`);
          else if (node.l) flat.push({ name: `${prefix}${node.n}`, size: Number(node.s || 0), link: node.l });
        }
      };
      walk(entry.files, '');
      out.files = await withLinks(flat.map((f, i) => ({ id: i, name: f.name, size: f.size })), (i) => this.unlock(ctx, flat[i].link));
      return out;
    },

    // Every file, however many: a season pack has more than fifty. AllDebrid refuses more than
    // about twelve calls a second (and 600 a minute), so unlocks go eight a second, and each link
    // at most once a session.
    pace: pacer(125, 4),
    links: new Map(),
    async unlock(ctx, link) {
      if (!this.links.has(link)) {
        const unlocked = await this.pace(() => ctx.json(`${ctx.base}/v4/link/unlock?${this.query(ctx, { link })}`));
        if (unlocked.data && unlocked.data.link) this.links.set(link, unlocked.data.link);
      }
      return this.links.get(link) || '';
    },

    async list(ctx) {
      const { data } = await ctx.json(`${ctx.base}/v4.1/magnet/status?${this.query(ctx)}`);
      const rows = data && (Array.isArray(data.magnets) ? data.magnets : Object.values(data.magnets || {}));
      return (rows || []).map((raw) => this.normalize(raw));
    },

    async remove(ctx, id) {
      await ctx.json(`${ctx.base}/v4/magnet/delete?${this.query(ctx, { id })}`);
    },

    async account(ctx) {
      const { data } = await ctx.json(`${ctx.base}/v4/user?${this.query(ctx)}`);
      const user = (data && data.user) || {};
      return { who: user.username || '', detail: user.isPremium ? 'premium' : (user.isSubscribed ? 'subscribed' : 'free') };
    },

    fileLink(ctx, id, file) {
      return (file && file.url) || '';
    },
    zipLink: false,
  },

  putio: {
    label: 'put.io',
    defaultBase: 'https://api.put.io',
    keyPlaceholder: 'put.io OAuth token',

    async check(ctx) {
      const { info } = await ctx.json(`${ctx.base}/v2/account/info`);
      return info && (info.username || info.mail);
    },

    async submit(ctx, { bytes, name, magnet }) {
      let json;
      if (bytes) {
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: 'application/x-bittorrent' }), `${name}.torrent`);
        // put.io takes uploads on upload.put.io; any other base (a stand-in, a clone) keeps its host,
        // even one that starts with "api." too: the token goes nowhere that was not typed.
        const uploadBase = /^https:\/\/api\.put\.io$/i.test(ctx.base) ? 'https://upload.put.io' : ctx.base;
        json = await ctx.json(`${uploadBase}/v2/files/upload`, { method: 'POST', body: form });
      } else {
        json = await ctx.json(`${ctx.base}/v2/transfers/add`, { method: 'POST', body: new URLSearchParams({ url: magnet }) });
      }
      const id = json.transfer && json.transfer.id;
      if (id === undefined) throw new Error('put.io did not start a transfer for that torrent');
      return id;
    },

    async status(ctx, id) {
      const { transfer } = await ctx.json(`${ctx.base}/v2/transfers/${encodeURIComponent(id)}`);
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
      const { file } = await ctx.json(`${ctx.base}/v2/files/${encodeURIComponent(transfer.file_id)}`);
      if (file && file.file_type !== 'FOLDER') {
        out.files = [{ id: file.id, name: file.name, size: Number(file.size || 0) }];
        return out;
      }
      const listed = await ctx.json(`${ctx.base}/v2/files/list?parent_id=${encodeURIComponent(transfer.file_id)}&per_page=1000`);
      // A sub-folder keeps its own link: put.io serves a folder as a zip.
      out.files = (listed.files || []).map((f) => ({
        id: f.id,
        name: f.file_type === 'FOLDER' ? `${f.name} (folder, .zip)` : f.name,
        size: Number(f.size || 0),
      }));
      return out;
    },

    async list(ctx) {
      const { transfers } = await ctx.json(`${ctx.base}/v2/transfers/list`);
      return (transfers || []).map((t) => {
        const state = String(t.status || 'unknown').toLowerCase();
        return {
          id: t.id,
          fileId: t.file_id,
          state,
          progress: Number(t.percent_done || 0) / 100,
          ready: state === 'completed' || state === 'seeding',
          failed: state === 'error',
          name: t.name || '',
          size: Number(t.size || 0),
          files: [],
        };
      });
    },

    async remove(ctx, id, item) {
      await ctx.json(`${ctx.base}/v2/transfers/cancel`, { method: 'POST', body: new URLSearchParams({ transfer_ids: String(id) }) });
      // Cancelling only drops the transfer; the file it produced is what takes up the account's space.
      const fileId = item && (item.fileId !== undefined && item.fileId !== null ? item.fileId : (item.files && item.files[0] && item.files[0].id));
      if (fileId !== undefined && fileId !== null) {
        await ctx.json(`${ctx.base}/v2/files/delete`, { method: 'POST', body: new URLSearchParams({ file_ids: String(fileId) }) });
      }
    },

    async account(ctx) {
      const { info } = await ctx.json(`${ctx.base}/v2/account/info`);
      const disk = (info && info.disk) || {};
      return {
        who: (info && (info.username || info.mail)) || '',
        detail: disk.size ? `${formatBytes(disk.used || 0)} of ${formatBytes(disk.size)} used` : '',
      };
    },

    fileLink(ctx, id, file) {
      if (!file) return '';
      return `${ctx.base}/v2/files/${encodeURIComponent(file.id)}/download?oauth_token=${encodeURIComponent(ctx.key)}`;
    },
    zipLink: false,
  },
};

/* ---------- the cloud library: everything the account holds, like a cloud torrent service ---------- */

const PLAYABLE = /\.(mp4|m4v|webm|ogv|mov|mkv|mp3|m4a|aac|ogg|opus|flac|wav)$/i;
let cloudItems = [];
// The service, address and key the items were listed from.
let cloudItemsFrom = '';
let cloudPollTimer = null;
// Why the last listing failed, and how many have failed in a row; null once one works. With nothing
// listed, an empty library is not an empty account: it says why, and asks again.
let cloudListError = null;
let cloudListFailures = 0;
// Which transfers the last listing had, and which were ready. The account line counts them (your own
// server) or the space they take (put.io), and is asked again when they change, not on every poll.
let cloudItemsShape = '';

/** Send a magnet, an info hash or a .torrent straight to the account, with no local torrent at all. */
async function cloudSend({ bytes, name, magnet }) {
  const ctx = cloudCtx();
  const id = await ctx.api.submit(ctx, { bytes, name, magnet });
  toast(`Sent to ${ctx.api.label}. It downloads there; the library below shows the progress.`);
  await refreshCloudLibrary();
  return id;
}

async function refreshCloudLibrary({ quiet = false } = {}) {
  if (!cloudReady()) {
    renderCloudLibrary();
    return;
  }
  const ctx = cloudCtx();
  const from = [ctx.provider, ctx.base, ctx.key].join(' ');
  // Transfers listed from another service, address or key are not this account's. Until it has
  // listed its own the library shows none, rather than the old ones under the new service's name,
  // where Files and Delete would send their ids to it.
  if (from !== cloudItemsFrom) {
    cloudItems = [];
    cloudItemsFrom = from;
    cloudListError = null;
    cloudListFailures = 0;
  }
  try {
    const items = await ctx.api.list(ctx);
    // The settings changed while this call was out: the listing that follows them has the say.
    if (from !== cloudItemsFrom) return;
    // Each item carries where it lives, which is where its files and its delete go.
    cloudItems = items.map((item) => ({ ...item, provider: ctx.provider, base: ctx.base }));
    cloudListError = null;
    cloudListFailures = 0;
    els.cloudError.hidden = true;
    noteServerToken(ctx, null);
    const shape = `${from}\n${cloudItems.map((i) => `${i.id}:${Boolean(i.ready)}`).sort().join(',')}`;
    if (cloudItemsShape && shape !== cloudItemsShape) cloudAccountLine();
    cloudItemsShape = shape;
  } catch (err) {
    if (from !== cloudItemsFrom) return;
    cloudListError = err;
    cloudListFailures += 1;
    noteServerToken(ctx, err);
    els.cloudError.hidden = false;
    els.cloudError.textContent = `${ctx.api.label}: ${err.message}`;
    if (!quiet) toast(`Could not read the cloud library: ${err.message}`, { error: true, timeout: 9000 });
  }
  renderCloudLibrary();
  scheduleCloudPoll();
}

/**
 * Poll while something is still downloading up there, and leave it alone once nothing is. A
 * transfer that failed is not downloading: it will not change until someone deletes it.
 */
function scheduleCloudPoll() {
  clearTimeout(cloudPollTimer);
  if (!cloudReady()) return;
  // A listing that failed but may work next time — a dropped network, a server restarting — is asked
  // for again, less often the more it fails, as a card's poll is: after 5, 10, 20, 40, then every 60
  // seconds. Nothing else would ask, and the library would go on saying what it said.
  if (cloudListError?.transient) {
    cloudPollTimer = setTimeout(() => refreshCloudLibrary({ quiet: true }), CLOUD_POLL_MS * Math.min(12, 2 ** (cloudListFailures - 1)));
    return;
  }
  if (!cloudItems.some((i) => !i.ready && !i.failed)) return;
  // An account of hundreds of transfers is asked less often: Real-Debrid lists a hundred a call,
  // and every call counts against the 250 a minute it allows.
  cloudPollTimer = setTimeout(() => refreshCloudLibrary({ quiet: true }), CLOUD_POLL_MS * Math.max(1, Math.ceil(cloudItems.length / 100)));
}

async function cloudAccountLine() {
  if (!cloudReady()) {
    els.cloudAccount.textContent = 'No API key yet: add one in Settings → Cloud fetch.';
    return;
  }
  const ctx = cloudCtx();
  try {
    const { who, detail } = await ctx.api.account(ctx);
    els.cloudAccount.textContent = [`${ctx.api.label}${who ? ` · ${who}` : ''}`, detail].filter(Boolean).join(' · ');
    noteServerToken(ctx, null);
  } catch (err) {
    els.cloudAccount.textContent = `${ctx.api.label}: ${err.message}`;
    noteServerToken(ctx, err);
  }
}

/**
 * Your own server turned the last call away for want of its token (401). The page picks a server
 * that serves it as the service by itself, with no key (adoptOwnServer), and one deployed on Render,
 * Fly or behind a tunnel has an AUTH_TOKEN: Settings then says to paste it, not that a server alone
 * on your machine needs none.
 */
let serverWantsToken = false;
function noteServerToken(ctx, err) {
  if (ctx.provider === 'server') serverWantsToken = Boolean(err && err.status === 401);
}

async function cloudExpand(item, el) {
  const filesEl = $('.cloud-item-files', el);
  if (!filesEl.hidden) {
    filesEl.hidden = true;
    return;
  }
  filesEl.hidden = false;
  await fillCloudFiles(item, filesEl);
}

async function fillCloudFiles(item, filesEl) {
  // A file whose link did not come last time is asked for again; the links that did are kept.
  if (item.files.length && !item.files.some((f) => f.error)) return renderCloudFiles(item, filesEl);
  filesEl.textContent = 'Loading…';
  const ctx = cloudCtx({ provider: item.provider, base: item.base });
  try {
    const status = await ctx.api.status(ctx, item.id);
    item.files = status.files;
    renderCloudFiles(item, filesEl);
  } catch (err) {
    filesEl.textContent = `Could not list the files: ${err.message}`;
  }
}

function renderCloudFiles(item, filesEl) {
  filesEl.textContent = '';
  if (!item.files.length) {
    filesEl.textContent = item.ready ? 'No files in this transfer.' : 'Files appear once the download finishes.';
    return;
  }
  addCloudFiles(item, filesEl);
}

/**
 * Rows for the files an open list does not show yet, each in its place. Your own server lists a
 * file as soon as it is complete, so a list can grow while it is open; the rows it already has are
 * left as they are, and a video playing in one keeps playing.
 */
function addCloudFiles(item, filesEl) {
  const ctx = cloudCtx({ provider: item.provider, base: item.base });
  const shown = new Map([...filesEl.children].map((el) => [el.dataset.file, el]).filter(([id]) => id !== undefined));
  // Nothing listed yet: what is there is a message saying so.
  if (!shown.size) filesEl.textContent = '';
  let before = filesEl.firstElementChild;
  for (const file of item.files) {
    const had = shown.get(String(file.id));
    if (had) {
      before = had.nextElementSibling;
      continue;
    }
    const row = els.cloudFileTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.file = String(file.id);
    filesEl.insertBefore(row, before);
    const href = ctx.api.fileLink(ctx, item.id, file);
    $('.cloud-file-name', row).textContent = file.name;
    $('.cloud-file-size', row).textContent = file.error ? `${formatBytes(file.size)} · no link yet: ${file.error}` : formatBytes(file.size);
    // A file the service would not hand a link for (Real-Debrid and AllDebrid refuse one now and
    // then): named, with why, and nothing to save or play.
    if (!href) {
      $('.cloud-file-actions', row).hidden = true;
      continue;
    }
    const save = $('.cloud-save', row);
    save.href = href;
    save.setAttribute('download', file.name);
    const play = $('.cloud-play', row);
    if (PLAYABLE.test(file.name)) {
      // Where a file that was playing stopped, when the connection went; and whether this browser
      // ever decoded any of it, which is what it takes to play it.
      let resumeAt = 0;
      let played = false;
      play.addEventListener('click', () => {
        const holder = $('.cloud-player', row);
        holder.hidden = false;
        holder.textContent = '';
        const media = document.createElement(/\.(mp3|m4a|aac|ogg|opus|flac|wav)$/i.test(file.name) ? 'audio' : 'video');
        media.controls = true;
        media.playsInline = true;
        const from = resumeAt;
        resumeAt = 0;
        if (from) media.addEventListener('loadedmetadata', () => { media.currentTime = from; }, { once: true });
        media.addEventListener('loadeddata', () => { played = true; }, { once: true });
        // Offered by the name alone: whether this browser can play the file is known only by trying —
        // an .mkv, the most common, plays in Chrome and not in Safari, whatever canPlayType says. One
        // that cannot says so, with what to do instead, rather than leaving a black box. A network
        // error, or any error once some of it has played, is the connection instead — the phone
        // changed networks, the server restarted — and Play goes on from where it stopped. (Chrome
        // reports a link refused before anything played as a format it does not know.)
        media.addEventListener('error', () => {
          play.hidden = false;
          if (played || media.error?.code === MediaError.MEDIA_ERR_NETWORK) {
            resumeAt = media.currentTime || from;
            toast(`Lost the connection while playing "${file.name}": tap Play to go on from where it stopped.`, { error: true, timeout: 9000 });
            return;
          }
          holder.hidden = true;
          toast(`This browser cannot play "${file.name}": use Save, or copy the Link into a player app such as VLC.`, { error: true, timeout: 9000 });
        }, { once: true });
        media.src = href;
        holder.appendChild(media);
        play.hidden = true;
      });
    } else {
      play.hidden = true;
    }
    const linkField = $('.cloud-link-field', row);
    const linkInput = $('.cloud-link', row);
    linkInput.value = href;
    linkInput.addEventListener('focus', () => linkInput.setSelectionRange(0, linkInput.value.length));
    $('.cloud-link-copy', row).addEventListener('click', (e) => copyFrom(e.currentTarget, href));
    $('.cloud-copy', row).addEventListener('click', () => {
      // The link, in full: paste it into a player, or into another device's browser.
      linkField.hidden = !linkField.hidden;
      if (!linkField.hidden) {
        linkInput.focus();
        linkInput.setSelectionRange(0, linkInput.value.length);
      }
    });
  }
}

async function cloudRemoveItem(item) {
  const ctx = cloudCtx({ provider: item.provider, base: item.base });
  if (!askUser(() => confirm(`Delete "${item.name || item.id}" from your ${ctx.api.label} account?\n\nFiles you already saved to this device are not affected.`))) return;
  try {
    await ctx.api.remove(ctx, item.id, item);
    cloudItems = cloudItems.filter((i) => i.id !== item.id);
    renderCloudLibrary();
    // Taken off here without listing again, so the account line (a count, the space used) is asked
    // for directly: nothing else may come to correct it, with nothing left downloading.
    cloudAccountLine();
    // A card that sent it lets go of it too, and can send the torrent again.
    for (const view of views.values()) {
      if (!view.cloud || String(view.cloud.id) !== String(item.id)) continue;
      const own = cloudCtx(view.cloud);
      if (own.provider !== ctx.provider || own.base !== ctx.base) continue;
      if (view.torrent.remote) tellLead({ op: 'uncloud', ...refOf(view.torrent), id: String(item.id) });
      else forgetCloud(view);
    }
    toast('Deleted from the cloud.');
  } catch (err) {
    toast(`Could not delete it: ${err.message}`, { error: true, timeout: 9000 });
  }
}

/** Why the library shows nothing, when its last listing failed, and what comes next. */
function cloudListProblem() {
  const reason = String(cloudListError.message || cloudListError).replace(/[.\s]+$/, '');
  const next = cloudListError.transient ? ' Trying again…' : keyRefused(cloudListError) ? ' Check the key in Settings → Cloud fetch.' : '';
  return `Could not read the library from ${cloudCtx().api.label}: ${reason}.${next}`;
}

/**
 * The rows on screen, by service and transfer id. A poll updates them in place rather than
 * rebuilding the list, so an open file list, a link being copied or a video playing in the
 * page survives the next poll — which, while anything downloads, is every few seconds.
 */
const cloudRows = new Map();

function renderCloudLibrary() {
  els.cloudEmpty.hidden = Boolean(cloudItems.length);
  // Without a key there is no account to show; the Cloud tab is where you learn about it.
  els.cloudLibrary.hidden = !cloudReady();
  if (!cloudReady()) {
    els.cloudList.textContent = '';
    cloudRows.clear();
    return;
  }
  // The library is on every tab, and the Cloud tab's own error line is not: a listing that failed says
  // so here, rather than that the account is empty.
  els.cloudEmpty.textContent = cloudListError ? cloudListProblem() : 'Nothing in your cloud account yet. Send a magnet or a .torrent above.';
  const seen = new Set();
  cloudItems.forEach((item, index) => {
    const key = `${item.provider}:${item.id}`;
    seen.add(key);
    let row = cloudRows.get(key);
    if (!row) {
      const el = els.cloudItemTemplate.content.firstElementChild.cloneNode(true);
      row = { el, item };
      $('.cloud-item-files-btn', el).addEventListener('click', () => cloudExpand(row.item, el));
      $('.cloud-item-delete', el).addEventListener('click', () => cloudRemoveItem(row.item));
      cloudRows.set(key, row);
    } else {
      const becameReady = !row.item.ready && item.ready;
      const had = row.item.files.length;
      // Files fetched on demand stay with the row while the transfer is what it was.
      if (!becameReady && !item.files.length && had) item.files = row.item.files;
      row.item = item;
      const filesEl = $('.cloud-item-files', row.el);
      if (!filesEl.hidden) {
        // Listed with the transfer (your own server names each file once it is complete, TorBox
        // all of them once it is done): an open list takes on the new ones.
        if (item.files.length > had) addCloudFiles(item, filesEl);
        // Not listed with it: asked for, now that there is something to ask for.
        else if (becameReady && !item.files.length) fillCloudFiles(item, filesEl);
      }
    }
    const { el } = row;
    const pct = Math.min(100, Math.round((item.progress || 0) * 100));
    $('.cloud-item-name', el).textContent = item.name || `Transfer ${item.id}`;
    $('.cloud-item-meta', el).textContent = item.ready
      ? `${formatBytes(item.size)} · ready`
      : item.failed
        ? `${formatBytes(item.size)} · failed: ${item.state}`
        : `${formatBytes(item.size)} · ${item.state}${pct ? ` ${pct}%` : ''}`;
    $('.cloud-item-bar', el).style.width = `${pct}%`;
    el.classList.toggle('ready', Boolean(item.ready));
    // Moved only when out of place, so a playing <video> inside is left alone.
    if (els.cloudList.children[index] !== el) els.cloudList.insertBefore(el, els.cloudList.children[index] || null);
  });
  for (const [key, row] of cloudRows) {
    if (seen.has(key)) continue;
    row.el.remove();
    cloudRows.delete(key);
  }
}

async function cloudSubmit(view) {
  const { torrent } = view;
  const ctx = cloudCtx();
  const payload = torrent.metadata && torrent.torrentFile
    ? { bytes: new Uint8Array(torrent.torrentFile), name: torrent.name || torrent.infoHash }
    : { magnet: torrent.magnetURI };
  const id = await ctx.api.submit(ctx, payload);
  return { id, provider: ctx.provider, base: ctx.base, state: 'queued', progress: 0, ready: false, files: [] };
}

/**
 * The card's transfer failed, or its poll ended on an answer that will not change: nothing more will
 * come of it. A key refused is not that: the transfer may well still be there, and sending it again
 * would start a second one beside it. Such a card asks again once Settings are saved.
 */
function cloudDead(view) {
  return Boolean(view.cloud && (view.cloud.failed || (view.cloudError && !view.cloudRefused)));
}

/** The service turned the key away (401, 403): a matter for Settings, not for this transfer. */
function keyRefused(err) {
  return err.status === 401 || err.status === 403;
}

/** The card's transfer is gone from the account: the card lets go of it, for good — a reload does not bring it back. */
function forgetCloud(view) {
  stopCloudPoll(view);
  view.cloud = null;
  view.cloudError = '';
  view.cloudRefused = false;
  view.cloudAnnounced = false;
  if (view.record) view.record.cloud = null;
  renderCloud(view);
  persistTorrent(view);
  updateWakeLock(); // without the cloud, the download here is what counts again
}

function stopCloudPoll(view) {
  view.cloudPoll = null;
  if (view.cloudTimer) {
    clearInterval(view.cloudTimer);
    view.cloudTimer = null;
  }
}

/**
 * Follow a card's transfer until it is ready or failed. A call that fails but may work next time
 * (a dropped network, a service busy or down: see transientStatus) does not end that — the card
 * says so and asks again, less often the more it fails: after 5, 10, 20, 40, then every 60
 * seconds. Only an answer that will not change ends it: a key refused, a transfer the service no
 * longer knows.
 */
function startCloudPoll(view) {
  stopCloudPoll(view);
  view.cloudError = '';
  view.cloudRefused = false;
  const poll = {};
  view.cloudPoll = poll;
  let failures = 0;
  let skip = 0;
  let busy = false;
  const backOff = () => {
    failures += 1;
    skip = Math.min(12, 2 ** (failures - 1)) - 1;
  };
  const tick = async () => {
    if (!views.has(view.torrent) || !view.cloud || view.cloud.id === undefined) return stopCloudPoll(view);
    // A slow answer is not asked for again on top of itself.
    if (busy) return;
    if (skip > 0) {
      skip -= 1;
      return;
    }
    busy = true;
    try {
      const before = view.cloud.id;
      const ctx = cloudCtx(view.cloud);
      const status = await ctx.api.status(ctx, before);
      // Stopped while the call was out: the card has moved on, and this answer is stale.
      if (view.cloudPoll !== poll) return;
      const cloud = { ...view.cloud, ...status };
      view.cloud = cloud;
      renderCloud(view);
      // A TorBox transfer that waited in the queue gets a torrent id of its own when it
      // starts; the stored one must follow, or a reload would look for the queue entry.
      if (cloud.id !== before) persistTorrent(view);
      if (cloud.failed) {
        stopCloudPoll(view);
        logEvent(view, `cloud transfer failed: ${cloud.state}`);
        return;
      }
      // Ready, but with a file whose link did not come yet: that link is asked for again, as a
      // failed call would be.
      if (cloud.ready && cloud.files.some((f) => f.error)) backOff();
      else failures = 0;
      if (cloud.ready) {
        if (!failures) stopCloudPoll(view);
        updateWakeLock(); // the cloud has it: nothing here needs the screen on for it any more
        if (!view.cloudAnnounced) {
          view.cloudAnnounced = true;
          logEvent(view, `cloud download ready: ${cloud.files.length} file${cloud.files.length === 1 ? '' : 's'}`);
          toast(`"${cloud.name || view.torrent.name}" is ready in the cloud: tap a file to download it.`, { timeout: 9000 });
        }
      }
    } catch (err) {
      if (view.cloudPoll !== poll) return;
      if (err.transient) {
        backOff();
        if (failures === 1) logEvent(view, `cloud: ${err.message}; trying again`);
        renderCloud(view, `${err.message} — trying again…`);
        return;
      }
      stopCloudPoll(view);
      view.cloudRefused = keyRefused(err);
      view.cloudError = view.cloudRefused ? `${err.message}. Fix the key in Settings → Cloud fetch, and this card asks again.` : err.message;
      logEvent(view, `cloud error: ${err.message}`);
      renderCloud(view);
    } finally {
      busy = false;
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
  // One transfer per card: a second tap, here or in another open copy, while one is on its way, is not a second one.
  if (view.cloudSending) return;
  view.cloudSending = true;
  const btns = $$('.cloud-btn, .nopeers-cloud-btn, .cloud-again-btn', view.el);
  btns.forEach((b) => { b.disabled = true; });
  if (view.torrent.remote) {
    await tellLead({ op: 'cloud', ...refOf(view.torrent) });
    view.cloudSending = false;
    btns.forEach((b) => { b.disabled = false; });
    refreshCloudLibrary({ quiet: true }); // the library on this copy's screen has it too
    return;
  }
  try {
    // A transfer that failed, or that the service no longer knows, is replaced once a new one exists.
    if (!view.cloud || cloudDead(view)) {
      const cloud = await cloudSubmit(view);
      stopCloudPoll(view);
      view.cloud = cloud;
      view.cloudError = '';
      view.cloudAnnounced = false;
      logEvent(view, `sent to ${cloudCtx(view.cloud).api.label} (transfer ${view.cloud.id})`);
      toast('Sent to the cloud. It downloads there, then you save it from the link.');
      refreshCloudLibrary({ quiet: true });
      // The transfer keeps going in the cloud even if this tab closes now, so make its id durable
      // before anything else: without it the app cannot find the transfer again.
      await persistTorrent(view);
    }
    renderCloud(view);
    startCloudPoll(view);
  } catch (err) {
    logEvent(view, `cloud error: ${err.message}`);
    toast(`Cloud fetch failed: ${err.message}`, { error: true, timeout: 9000 });
  } finally {
    view.cloudSending = false;
    btns.forEach((b) => { b.disabled = false; });
  }
}

/** The card's transfer, as last heard; `note` is a passing word about it, such as a poll to be tried again. */
function renderCloud(view, note) {
  const box = $('.cloud', view.el);
  if (!box) return;
  view.cloudNote = note || ''; // a copy that follows this one shows it too
  const cloud = view.cloud;
  box.hidden = !cloud;
  // One transfer per torrent: the buttons that start one go away once it exists. One that failed,
  // or that the service no longer knows, is replaced from the box that says so.
  $$('.cloud-btn, .nopeers-cloud-btn', view.el).forEach((b) => { b.hidden = Boolean(cloud); });
  $('.cloud-again', box).hidden = !cloudDead(view);
  if (!cloud) return;
  const error = note || view.cloudError;
  const ctx = cloudCtx(cloud);
  const pct = Math.min(100, Math.round((cloud.progress || 0) * 100));
  $('.cloud-state', box).textContent = error
    ? `${ctx.api.label}: ${error}`
    : cloud.ready
      ? `Ready on ${ctx.api.label} — tap a file to download it to your phone.`
      : cloud.failed
        ? `${ctx.api.label}: failed (${cloud.state}).`
        : `${ctx.api.label}: ${cloud.state}${pct ? ` ${pct}%` : ''}…`;
  const list = $('.cloud-files', box);
  list.textContent = '';
  if (!cloud.ready) return;
  const entries = cloud.files.map((f) => ({ href: ctx.api.fileLink(ctx, cloud.id, f), name: f.name, text: `${f.name} · ${formatBytes(f.size)}`, error: f.error }));
  if (ctx.api.zipLink && cloud.files.length > 1) {
    entries.push({ href: ctx.api.fileLink(ctx, cloud.id, null), text: 'Everything as one .zip' });
  }
  for (const entry of entries) {
    const li = document.createElement('li');
    if (!entry.href) {
      // A file the service would not hand a link for yet: the poll asks again.
      if (!entry.error) continue;
      li.className = 'hint';
      li.textContent = `${entry.text} · no link yet: ${entry.error}`;
      list.appendChild(li);
      continue;
    }
    const a = document.createElement('a');
    a.className = 'btn small';
    a.href = entry.href;
    a.rel = 'noopener';
    a.target = '_blank';
    // The file's own name, for a browser that takes it from here (a link on the page's own origin);
    // one on another origin goes by what the service says.
    a.setAttribute('download', entry.name || '');
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
  els.empty.hidden = views.size > 0;
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
  // Whether anything answered at all: a script cannot tell CORS from a host that is not there.
  let answered = false;
  for (const target of targets) {
    try {
      const res = await fetch(target, { cache: 'no-store' });
      answered = true;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!torrentReach(bytes)) throw new Error('that address did not return a .torrent file');
      return bytes;
    } catch (err) {
      last = err instanceof TypeError ? unreachable() : err;
    }
  }
  const proxyHint = viaProxy === url && navigator.onLine;
  // An address that names no .torrent is most often a torrent site's page about one, pasted from the
  // browser: a proxy would only fetch that page. What is wanted is the magnet or the link on it. Some
  // download links name no .torrent either (/torrent/download/<hash>, download.php?id=): when nothing
  // answered, that one may be blocked by CORS, which is what the proxy is for.
  if (!torrentLink(url)) {
    const orProxy = !answered && proxyHint ? '; if it is the .torrent\'s own download link, a CORS proxy can be set in Settings' : '';
    throw new Error(`Could not fetch a .torrent from that address: ${last.message}. If it is a web page, open it and copy its magnet or its .torrent link${orProxy}.`);
  }
  throw new Error(`Could not fetch that .torrent: ${last.message}${proxyHint ? '. A CORS proxy can be set in Settings.' : ''}`);
}

/**
 * `seeding` is for a seed rebuilt by a retry: it stays a seed, which is never remembered, and its
 * copy of the files goes when it is removed — not a download that comes back at every launch.
 */
async function addTorrent(id, { record, seeding = false } = {}) {
  if (IN_BROWSER_BLOCKED) throw new Error(IN_BROWSER_BLOCKED);
  // A copy that follows hands it to the one that runs the torrents (see LEAD_LOCK).
  if (!(await leading)) return record ? null : addThroughLead({ op: 'add', id: typeof id === 'string' ? id : new Uint8Array(id), seeding });
  await storageReady;
  // A .torrent URL is fetched here rather than inside WebTorrent: the proxy can help, the error is
  // a real message, and the rules below get to see the bytes before anything is announced.
  if (typeof id === 'string' && /^https?:\/\//i.test(id)) {
    toast('Fetching that .torrent…');
    return addTorrent(await fetchTorrentUrl(id), { record, seeding });
  }
  const problem = typeof id === 'string' && /^magnet:/i.test(id) ? magnetProblem(id) : '';
  if (problem) throw new Error(problem);
  const existing = await client.get(id).catch(() => null);
  if (existing) {
    // The .torrent of a magnet still waiting for its metadata is what that magnet is waiting for —
    // its card says to add it — so it fills that card in instead of being turned away.
    if (typeof id !== 'string' && !existing.metadata && views.has(existing)) {
      return replaceTorrent(existing, id, 'metadata from the .torrent you added', { source: { type: 'torrent', bytes: new Uint8Array(id) } });
    }
    toast(`"${existing.name || existing.infoHash}" is already in the list.`);
    return existing;
  }

  // Another copy took the lead over meanwhile: it runs the torrents now, and a restore is its to do.
  if (follower) return record ? null : addThroughLead({ op: 'add', id: typeof id === 'string' ? id : new Uint8Array(id), seeding });

  // What the torrent's own trackers allow, judged from the bytes the user gave (or known from the
  // record) — never from the file WebTorrent rebuilds, which a restore and a retry start from: its
  // tracker list has the app's wss:// trackers merged in, and the explanation would vanish.
  const original = record?.source?.type === 'torrent' ? record.source.bytes : (typeof id === 'string' ? null : id);
  const reach = record?.reach || (original ? torrentReach(new Uint8Array(original)) : null);
  // A private torrent (BEP 27) may only be announced to its own tracker: adding public ones
  // would publish its info hash and can get the user banned from the tracker it came from.
  const torrent = client.add(id, {
    ...storeOpts(),
    announce: reach && reach.private ? reach.trackers : effectiveTrackers(),
    strategy: settings.strategy === 'rarest' ? 'rarest' : 'sequential',
    destroyStoreOnDestroy: seeding,
    deselect: Boolean(record && record.deselected && record.deselected.length),
  });

  // Remember what the user gave us (not the tracker-augmented file WebTorrent builds) for restores.
  const source = record?.source || (typeof id === 'string'
    ? { type: 'magnet', uri: id }
    : { type: 'torrent', bytes: new Uint8Array(id) });
  const view = attachTorrent(torrent, { record, seeding, reach });
  view.source = source;
  // Added now, not restored: the pieces it will have are worth keeping.
  if (!record) keepStorage();
  const reason = unreachableReason(reach);
  if (reason) {
    refreshView(view); // surface the warning straight away instead of after the no-peers delay
    // Said when the torrent arrives; a restore or a rebuild already knew, and the card still shows it.
    if (!unreachableReason(record?.reach)) {
      logEvent(view, reason);
      toast(reason, { error: true, timeout: 9000 });
    }
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

async function seedFiles(files, { name, pickedIn = '', handedOver = false } = {}) {
  if (!files.length) return null;
  if (IN_BROWSER_BLOCKED) throw new Error(IN_BROWSER_BLOCKED);
  if (!(await leading)) return addThroughLead({ op: 'seed', files: [...files], name }, { share: true });
  await storageReady;
  if (follower) return addThroughLead({ op: 'seed', files: [...files], name }, { share: true });
  // Seeds copy the files into OPFS; drop that copy when the seed is removed.
  const opts = { ...storeOpts(), announce: effectiveTrackers(), destroyStoreOnDestroy: true };
  if (name) opts.name = name;
  // Files already being shared make the same torrent: WebTorrent closes the new one without a word
  // and hands over the one there is. Picked again to get the link back, that is where it is.
  const torrent = client.seed(files, opts, (seeded) => {
    if (seeded === torrent || !views.has(seeded) || handedOver) return;
    toast(`"${seeded.name}" is already being shared.`);
    shareTorrent(seeded);
    // Picked in a copy that follows this one: that is where its link is wanted.
    if (pickedIn) {
      postState();
      otherCopies?.postMessage({ type: 'share', to: pickedIn, sid: syncId(seeded) });
    }
  });
  const view = attachTorrent(torrent, { seeding: true });
  // A seed is never remembered: what was picked is what another open copy needs to go on sharing it.
  view.picked = { files: [...files], name };
  keepStorage();
  // Shared already, in the copy that ran it before this one: nothing new to say.
  if (handedOver) return torrent;
  // Sharing is what a seed is for: the link, shown and selected, rather than the details panel.
  torrent.once('ready', () => {
    toast(`Seeding "${torrent.name}". Share the link so others can download it.`);
    shareTorrent(torrent);
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

function attachTorrent(torrent, { record, seeding, reach = null }) {
  const view = createTorrentView(torrent, record, seeding);
  view.reach = reach;
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
    // udp:// and http:// trackers in .torrent files are expected to be unusable from a browser, and so
    // is a ws:// one on an https page (mixed content). With no WebRTC at all (see NO_WEBRTC), every
    // ws:// and wss:// one is refused too, and that is worth saying.
    if (/Unsupported tracker protocol/i.test(msg) && !(NO_WEBRTC && /Unsupported tracker protocol: wss?:/i.test(msg))) return;
    console.warn('torrent warning:', msg);
    logEvent(view, `warning: ${msg}`);
  });
  torrent.on('wire', (wire, addr) => {
    // pause() stops us reaching out, but a handshake already in flight still lands a wire; a paused
    // torrent must not start transferring again because of it.
    if (torrent.paused) {
      wire.destroy();
      return;
    }
    logEvent(view, `peer connected ${addr || wire.type || ''}`.trim());
    // Whether the screen stays on can turn on a connection: a private torrent this page cannot
    // announce still downloads from a web seed (see wantsWakeLock). Asked again as each one comes and goes.
    wire.once('close', updateWakeLock);
    updateWakeLock();
  });
  updateEmptyState();
  updateWakeLock();
  return view;
}

function createTorrentView(torrent, record, seeding) {
  const el = els.torrentTemplate.content.firstElementChild.cloneNode(true);
  const view = { torrent, el, fileEls: [], record: record || null, seeding: Boolean(seeding), log: [], startedAt: Date.now(), webSeeds: [...((record && record.webSeeds) || [])] };
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
  $('.copy-magnet-btn', el).addEventListener('click', (e) => copyFrom(e.currentTarget, torrent.magnetURI));
  $('.copy-link-btn', el).addEventListener('click', (e) => copyFrom(e.currentTarget, appLinkFor(torrent)));
  $('.share-copy-app', el).addEventListener('click', (e) => copyFrom(e.currentTarget, $('.share-app-link', el).value));
  $('.share-copy-magnet', el).addEventListener('click', (e) => copyFrom(e.currentTarget, $('.share-magnet', el).value));
  $('.share-native-btn', el).addEventListener('click', () => shareNatively(torrent));
  $('.share-torrent-btn', el).addEventListener('click', () => saveTorrentFile(torrent));
  $('.share-close-btn', el).addEventListener('click', () => { $('.share-panel', el).hidden = true; });
  // Tapping a link field selects all of it, which is what you want to do with it.
  for (const field of $$('.share-app-link, .share-magnet', el)) {
    field.addEventListener('focus', () => field.setSelectionRange(0, field.value.length));
  }
  $('.save-torrent-btn', el).addEventListener('click', () => saveTorrentFile(torrent));
  for (const sel of ['.webseed-btn', '.nopeers-webseed-btn']) {
    $(sel, el).addEventListener('click', () => addWebSeedPrompt(torrent));
  }
  for (const sel of ['.retry-btn', '.nopeers-retry-btn']) {
    $(sel, el).addEventListener('click', () => retryDiscovery(torrent));
  }
  for (const sel of ['.cloud-btn', '.nopeers-cloud-btn', '.cloud-again-btn']) {
    $(sel, el).addEventListener('click', () => startCloudFetch(view));
  }
  // A transfer started before a reload keeps going in the cloud; pick it up again.
  if (record && record.cloud && record.cloud.id !== undefined) {
    const { id, provider, base } = record.cloud;
    view.cloud = { id, provider, base, state: 'checking', progress: 0, ready: false, files: [] };
    renderCloud(view);
    const ctx = cloudCtx(view.cloud);
    if (ctx.key || ctx.provider === 'server') startCloudPoll(view);
  }

  torrent.on('infoHash', () => {
    removedHere.delete(torrent.infoHash); // added again: a seed of it handed over later is welcome
    // A magnet's display name (dn) is already torrent.name here, before any metadata: show it, or
    // the info hash without one, rather than "Fetching metadata…" — the state line says that.
    if (!torrent.metadata) $('.name', el).textContent = torrent.name || torrent.infoHash;
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
    restoreWebSeeds(view); // the ones added by hand, before a reload or a rebuild
  });
  // Before a torrent is ready WebTorrent checks which pieces it already has, and selects every one
  // it does not — which undoes a file unticked in the meantime, right after adding, while its box
  // stays unticked. Nothing has been requested yet at this point, so the ticks go back on here.
  torrent.on('ready', () => {
    if (view.fileEls.length && !view.seeding) applySelection(view);
    // What the check found is known only once 'ready' has run: WebTorrent marks the files done
    // right after. Look then, so a torrent that was complete before this launch is not taken for
    // one that just finished.
    queueMicrotask(() => refreshView(view));
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
      li.classList.toggle('deselected', !checkbox.checked);
      selectionChanged(view);
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

/**
 * Hand the ticks to WebTorrent. A file is a range of pieces, and two neighbours share the piece
 * where one ends and the next begins: deselecting a file drops that piece from the selection too,
 * and the neighbour still wanted could then never finish — it sat at 99% for ever. So the unwanted
 * files are deselected first and the wanted ones selected after, which puts their edges back.
 */
function applySelection(view) {
  const wanted = view.torrent.files.map((file, i) => !view.fileEls[i] || $('input[type="checkbox"]', view.fileEls[i]).checked);
  view.torrent.files.forEach((file, i) => { if (!wanted[i]) file.deselect(); });
  view.torrent.files.forEach((file, i) => { if (wanted[i]) file.select(); });
}

function setAllSelected(torrent, selected) {
  const view = views.get(torrent);
  if (!view) return;
  view.fileEls.forEach((li) => {
    $('input[type="checkbox"]', li).checked = selected;
    li.classList.toggle('deselected', !selected);
  });
  selectionChanged(view);
}

/** The ticks on a card changed: the torrent, its record and the card follow, in the copy that runs it. */
function selectionChanged(view) {
  if (view.torrent.remote) {
    view.ticksSentAt = Date.now(); // the next word from the leading copy may predate them
    tellLead({ op: 'select', ...refOf(view.torrent), deselected: deselectedFiles(view) });
    refreshView(view);
    return;
  }
  applySelection(view);
  resumeAutoStopped(view);
  persistTorrent(view);
  refreshView(view);
  updateWakeLock();
}

/** The indexes of the files unticked on a card; before its file list exists, the ones remembered. */
function deselectedFiles(view) {
  return view.fileEls.length
    ? view.fileEls.flatMap((li, i) => ($('input[type="checkbox"]', li).checked ? [] : [i]))
    : [...((view.record && view.record.deselected) || [])];
}

function persistTorrent(view) {
  const { torrent } = view;
  // A card that was removed — here, or in another open copy of the app — must not write its record
  // back; nor may one that only shows a torrent another copy runs.
  if (torrent.remote || view.seeding || !torrent.infoHash || torrent.destroyed || views.get(torrent) !== view) return;
  // Before the file list exists (pending magnet, or metadata not yet processed) keep the saved selection.
  const deselected = deselectedFiles(view);
  view.record = {
    infoHash: torrent.infoHash,
    source: view.source || (view.record && view.record.source) || null,
    // Only a torrent with metadata has a restorable .torrent file; a bare magnet does not.
    torrentFile: torrent.metadata ? new Uint8Array(torrent.torrentFile) : null,
    deselected,
    paused: Boolean(torrent.paused) && !view.autoStopped,
    // The service and address go with the id: switching services later must not send this
    // transfer's id to another one.
    cloud: view.cloud ? { id: view.cloud.id, provider: view.cloud.provider, base: view.cloud.base } : ((view.record && view.record.cloud) || null),
    reach: view.reach || null,
    webSeeds: view.webSeeds,
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
  // WebTorrent's File.downloaded counts one piece short for a file that ends exactly on a piece
  // boundary, so a finished download would sit at 99% for ever; a file that is done is all there.
  const selectedDownloaded = selected.reduce((n, f) => n + (f.done ? f.length : Math.max(0, f.downloaded)), 0);
  const progress = torrent.files.length
    ? (selectedBytes ? selectedDownloaded / selectedBytes : 0)
    : torrent.progress;
  const pct = Math.min(100, Math.floor(progress * 100));

  $('.progress .bar', el).style.width = `${pct}%`;
  $('.progress', el).setAttribute('aria-valuenow', String(pct));
  $('.pct', el).textContent = `${pct}%`;

  const allSelectedDone = selected.length > 0 && selected.every((f) => f.done || f.progress >= 1);
  const complete = torrent.done || allSelectedDone;
  // Only once the check of the pieces already here is over: a restore is incomplete until then.
  if (!complete && torrent.ready && selected.length) view.sawIncomplete = true;
  if (complete && !view.completed && torrent.metadata) {
    view.completed = true;
    // A copy that only shows the torrent hears all of this from the one that runs it.
    if (!torrent.remote) {
      logEvent(view, 'download complete');
      if (!view.seeding && view.sawIncomplete) toast(`"${torrent.name}" finished downloading.`);
      if (!view.seeding && !settings.seedAfterDone && !torrent.paused) {
        view.autoStopped = true; // finished and idle by policy, not paused by the user
        stopTransfer(torrent);
      }
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
  else if (!navigator.onLine && torrent.numPeers === 0) state = 'offline, waiting for the network';
  else if (!torrent.metadata) state = 'fetching metadata';
  else if (torrent.numPeers === 0 && cannotDownloadHere(view.reach)) state = 'cannot download here';
  else if (torrent.numPeers === 0 && NO_WEBRTC) state = 'no WebRTC in this browser';
  else if (torrent.numPeers === 0 && view.reconnectingUntil > Date.now()) state = 'reconnecting';
  else if (torrent.numPeers === 0) state = 'looking for peers';
  else state = 'downloading';
  $('.state', el).textContent = state;

  const pauseBtn = $('.pause-btn', el);
  pauseBtn.title = torrent.paused ? 'Resume' : 'Pause';
  pauseBtn.setAttribute('aria-label', pauseBtn.title);
  // A private torrent's links carry the passkey (see shareTorrent): nothing offers to copy them.
  for (const button of $$('.copy-magnet-btn, .copy-link-btn', el)) button.hidden = Boolean(view.reach?.private);

  $('.speed', el).textContent = torrent.downloadSpeed > 512 || torrent.uploadSpeed > 512
    ? `↓ ${formatSpeed(torrent.downloadSpeed)}  ↑ ${formatSpeed(torrent.uploadSpeed)}`
    : '';
  $('.peers', el).textContent = `${torrent.numPeers} peer${torrent.numPeers === 1 ? '' : 's'}`;
  $('.eta', el).textContent = !complete && torrent.downloadSpeed > 0 && selectedBytes > selectedDownloaded
    ? formatEta(((selectedBytes - selectedDownloaded) / torrent.downloadSpeed) * 1000)
    : '';

  // When the .torrent itself says no browser can reach its swarm, or this browser has no WebRTC to
  // reach any, say so at once instead of making the user wait out the no-peers delay.
  const reason = unreachableReason(view.reach) || NO_WEBRTC;
  const stuck = !complete && !torrent.paused && torrent.numPeers === 0
    && !(view.cloud && view.cloud.ready) // the cloud already has it; the peer hunt is moot
    // A long check of the pieces already here is not a hunt for peers that failed, and offline,
    // trackers, caches and web seeds are not the problem: the state line says what is.
    && (Boolean(reason) || (navigator.onLine && !preparing(torrent) && Date.now() - view.startedAt > 2 * fallbackDelayMs()));
  const noPeersEl = $('.nopeers', el);
  if (stuck !== !noPeersEl.hidden) {
    noPeersEl.hidden = !stuck;
    if (stuck) {
      const n = (torrent.announce || effectiveTrackers()).length;
      // A private torrent is stuck on its own tracker, and a browser without WebRTC on none: a fresh
      // public tracker list cannot help either.
      $('.nopeers-retry-btn', el).hidden = Boolean(view.reach?.private || NO_WEBRTC);
      $('.retry-btn', el).hidden = Boolean(view.reach?.private || NO_WEBRTC);
      $('.nopeers-text', el).textContent = reason || (torrent.metadata
        ? `No peers found on ${n} trackers yet. Browsers only reach WebRTC peers; this torrent may only have classic seeders. You can retry with a fresh tracker list or add an HTTP web seed.`
        : `Still waiting for metadata from ${n} trackers. If the fallback sources could not provide the .torrent either, try again later or add the .torrent file directly.`);
    }
  }

  // A save in progress keeps its button busy: a save lasts as long as the file takes to hand over,
  // seconds to minutes on a phone, and a button offered again meanwhile started a second one.
  if (!view.zipSaving) {
    $('.zip-btn', el).disabled = !allSelectedDone;
    $('.zip-btn', el).textContent = selected.length === torrent.files.length
      ? 'Save all as .zip'
      : `Save ${selected.length} selected as .zip`;
  }

  torrent.files.forEach((file, i) => {
    const li = view.fileEls[i];
    if (!li) return;
    const fp = file.done ? 100 : Math.max(0, Math.min(100, Math.floor(file.progress * 100)));
    $('.file-progress .bar', li).style.width = `${fp}%`;
    const done = file.done || file.progress >= 1;
    li.classList.toggle('done', done);
    if (!li.dataset.saving) $('.save-btn', li).disabled = !done;
  });

  if (!$('.details', el).hidden) {
    $('.d-downloaded', el).textContent = formatBytes(torrent.downloaded);
    $('.d-uploaded', el).textContent = formatBytes(torrent.uploaded);
    $('.d-ratio', el).textContent = Number.isFinite(torrent.ratio) ? torrent.ratio.toFixed(2) : '—';
    const pieces = pieceCounts(torrent);
    $('.d-pieces', el).textContent = pieces ? `${pieces.have} / ${pieces.total} · ${formatBytes(torrent.pieceLength)} each` : '—';
    $('.d-peers', el).textContent = torrent.wires
      ? `${torrent.numPeers} connected${torrent._peersLength ? ` · ${torrent._peersLength} known` : ''}`
      : '—';
  }
}

/** How many of a torrent's pieces are here, of how many; a copy that only shows it is told. */
function pieceCounts(torrent) {
  if (torrent.remote) return torrent.pieceCounts;
  return torrent.pieces ? { have: torrent.pieces.filter((p) => p === null).length, total: torrent.pieces.length } : null;
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

/**
 * Ask a torrent's trackers for peers now. update() alone is not always enough: once a tracker's
 * WebSocket has closed, bittorrent-tracker drops every announce until it has reconnected, and it
 * waits ten seconds plus a random delay of up to five minutes before it tries. A tracker in that
 * state is reconnected on the spot instead, and announces by itself as soon as the socket opens.
 */
function askTrackersNow(torrent) {
  const trackers = torrent.discovery?.tracker;
  if (!trackers || trackers.destroyed || torrent.destroyed) return;
  for (const tracker of trackers._trackers || []) {
    // Waiting out that delay, a tracker has destroyed itself and only its timer brings it back.
    if (!tracker.reconnecting || !tracker.destroyed || typeof tracker._openSocket !== 'function') continue;
    clearTimeout(tracker.reconnectTimer);
    tracker.retries += 1; // as the timer would: a tracker that is really gone still backs off
    tracker._openSocket();
  }
  try { trackers.update(); } catch { /* ignore */ }
}

function stopTransfer(torrent) {
  torrent.pause();
  // pause() only stops new connections; drop the current ones so transfer really stops.
  for (const wire of [...torrent.wires]) wire.destroy();
}

/**
 * A web seed is a connection like any other, so a pause drops it with the rest — and nothing in
 * WebTorrent brings it back: resume() only reconnects queued peers, and the torrent's own url-list
 * is read once, when the metadata arrives. So every web seed the torrent has, its own and the ones
 * added by hand, is added again whenever it may transfer.
 */
function restoreWebSeeds(view) {
  const { torrent } = view;
  if (torrent.destroyed || torrent.paused || !torrent.metadata) return;
  for (const url of new Set([...(torrent.urlList || []), ...view.webSeeds])) {
    if (!torrent._peers?.has(url)) torrent.addWebSeed(url);
  }
}

/**
 * With "keep seeding" off, a finished torrent is stopped — finished meaning every selected file.
 * Selecting one more makes it unfinished again, and that stop no longer applies: without this it
 * would sit paused for ever while its card said it was looking for peers. Selecting nothing at all
 * leaves nothing to fetch, so that keeps it stopped.
 */
function resumeAutoStopped(view) {
  const { torrent } = view;
  if (!view.autoStopped || !torrent.paused || !selectedFiles(view).length || isComplete(torrent)) return;
  view.autoStopped = false;
  view.completed = false;
  torrent.resume();
  restoreWebSeeds(view);
  askTrackersNow(torrent);
  logEvent(view, 'resumed for the newly selected files');
}

function togglePause(torrent) {
  const view = views.get(torrent);
  if (!view) return;
  if (torrent.remote) {
    tellLead({ op: 'pause', ...refOf(torrent), paused: !torrent.paused });
    return;
  }
  if (torrent.paused) {
    view.autoStopped = false;
    torrent.resume();
    restoreWebSeeds(view);
    // resume() only lifts the pause flag; ask the trackers for peers again right away, and once
    // more shortly after if nobody showed up (an announce can race the socket reconnect).
    askTrackersNow(torrent);
    setTimeout(() => { if (!torrent.destroyed && !torrent.paused && torrent.numPeers === 0) askTrackersNow(torrent); }, 8000);
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
    if (!navigator.onLine) {
      // Asked now, every cache would fail, and the log would blame them. Their turn comes back.
      logEvent(view, 'offline: the fallback sources wait for the network');
      scheduleMetadataFallback(view);
      return;
    }
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

/**
 * Swap a running torrent for a fresh one (new trackers or a real .torrent), keeping its data, its
 * card position and its pause. `source` replaces what the torrent is restored from.
 */
async function replaceTorrent(torrent, id, why, { source: newSource } = {}) {
  const view = views.get(torrent);
  if (!view) return null;
  // Paused by the user, or stopped for being finished: a metadata fallback, a retry or the .torrent
  // added for a magnet changes how it connects, not whether it may.
  const wasPaused = torrent.paused && !view.autoStopped;
  const autoStopped = Boolean(view.autoStopped && torrent.paused);
  const record = view.record
    ? { ...view.record, paused: wasPaused, reach: view.reach || view.record.reach || null, webSeeds: view.webSeeds, ...(newSource ? { source: newSource } : {}) }
    : null;
  const source = newSource || view.source;
  const anchor = view.el.nextElementSibling;
  clearTimeout(view.fallbackTimer);
  removeView(torrent);
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    client.remove(torrent, { destroyStore: false }, done).catch(done);
  });
  // A seed rebuilt stays a seed: rebuilt as a download, it was remembered, and shared again at every launch.
  const next = await addTorrent(id, { record, seeding: view.seeding });
  // Another copy took the lead over meanwhile: it runs the torrent now, and the card is its own.
  if (!next || next.remote) return next;
  const nextView = views.get(next);
  if (nextView) {
    if (wasPaused || autoStopped) {
      nextView.autoStopped = autoStopped;
      stopTransfer(next);
    }
    if (source && typeof id !== 'string' && !(record && record.source)) nextView.source = { type: 'torrent', bytes: new Uint8Array(id) };
    else if (source) nextView.source = source;
    nextView.log = [...view.log];
    nextView.picked = view.picked;
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

async function retryDiscovery(torrent, { quiet = false } = {}) {
  const view = views.get(torrent);
  if (!view) return;
  if (torrent.remote) {
    await tellLead({ op: 'retry', ...refOf(torrent) });
    return;
  }
  if (preparing(torrent)) {
    if (!quiet) toast('Its files are still being checked; it looks for peers once that is done.');
    return;
  }
  const before = new Set(torrent.announce || []);
  const btns = $$('.retry-btn, .nopeers-retry-btn', view.el);
  btns.forEach((b) => { b.disabled = true; b.textContent = 'Refreshing…'; });
  // A private torrent stays on its own tracker; refreshing the public list would not help it.
  if (!view.reach?.private) await refreshTrackerList({ force: true });
  const now = view.reach?.private ? (torrent.announce || []) : effectiveTrackers();
  const added = now.filter((t) => !before.has(t));
  const id = torrent.metadata ? new Uint8Array(torrent.torrentFile) : (view.source?.type === 'magnet' ? view.source.uri : torrent.magnetURI);
  if (!quiet) toast(added.length ? `Re-announcing with ${added.length} new tracker${added.length === 1 ? '' : 's'}.` : 'No new trackers found; re-announcing to the current ones.');
  const next = await replaceTorrent(torrent, id, `re-announced (${added.length} new trackers)`);
  if (next) {
    const nv = views.get(next);
    if (nv) nv.startedAt = Date.now();
  }
}

/* ---------- coming back ----------
 *
 * A phone freezes a tab it cannot see. The WebRTC connections die with it and so
 * does the tracker's WebSocket, and BitTorrent's own answer to that is to wait for
 * the next announce — minutes away. Which is why a torrent looks dead on return.
 *
 * So when the page comes back, or the network does, every unfinished torrent asks
 * its trackers again at once; the ones still alone a few seconds later have their
 * discovery rebuilt, which is what the retry button does by hand.
 */
const RECONNECT_GRACE_MS = 12000;
let awaySince = 0;
/** Until when the torrents woken last are given to find their peers again, before a rebuild. */
let wokenUntil = 0;

function needsPeers(torrent) {
  return !torrent.destroyed && !torrent.paused && !preparing(torrent) && wantsData(torrent);
}

async function pickUpWhereWeLeftOff(why) {
  if (!settings.autoResume) return;
  // Coming back to a copy that follows is coming back to the torrents the leading one runs.
  if (follower) {
    askLead({ op: 'wake', why }).catch(() => {});
    return;
  }
  const waking = client.torrents.filter(needsPeers);
  if (!waking.length) return;
  wokenUntil = Date.now() + RECONNECT_GRACE_MS;
  for (const torrent of waking) {
    const view = views.get(torrent);
    if (view) {
      view.reconnectingUntil = Date.now() + RECONNECT_GRACE_MS;
      logEvent(view, `${why}: asking the trackers again`);
      refreshView(view);
    }
    askTrackersNow(torrent);
  }
  // An announce on a socket that died while the tab was frozen goes nowhere. Give it
  // a few seconds, then rebuild discovery for whoever is still alone.
  setTimeout(() => {
    for (const torrent of waking) {
      if (!needsPeers(torrent) || torrent.numPeers > 0) continue;
      const view = views.get(torrent);
      if (view) logEvent(view, 'still no peers: rebuilding the connection');
      retryDiscovery(torrent, { quiet: true });
    }
  }, RECONNECT_GRACE_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    awaySince = Date.now();
    return;
  }
  const away = awaySince ? Date.now() - awaySince : 0;
  awaySince = 0;
  // A glance at another app is not a freeze; a few seconds away is.
  if (away > 4000) pickUpWhereWeLeftOff(`back after ${formatDuration(away)}`);
  // The public tracker list is due every six hours, and a phone's timers stop while it is away.
  refreshTrackerList();
  retryCloudLibrary();
});

/** A cloud library whose last listing failed is asked again at once when there is reason to think it would work now. */
function retryCloudLibrary() {
  if (cloudListError && cloudReady()) {
    cloudAccountLine();
    refreshCloudLibrary({ quiet: true });
  }
}

window.addEventListener('online', () => {
  // Every open copy hears this: the leading one wakes its torrents, and a follower has none to wake.
  if (!follower) pickUpWhereWeLeftOff('the network came back');
  retryCloudLibrary();
});
// Safari restores a page from its cache with every socket already dead.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) pickUpWhereWeLeftOff('the browser restored this page');
});

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

function addWebSeedPrompt(torrent) {
  const url = askUser(() => prompt('HTTP(S) URL of the file (or folder for multi-file torrents) to use as a web seed:'));
  if (!url) return;
  if (!/^https?:\/\//i.test(url.trim())) {
    toast('Web seed must be an http(s) URL.', { error: true });
    return;
  }
  if (torrent.remote) tellLead({ op: 'webseed', ...refOf(torrent), url: url.trim() });
  else addWebSeed(torrent, url.trim());
}

function addWebSeed(torrent, url) {
  const view = views.get(torrent);
  try {
    // WebTorrent appends "/<file path>" to a web seed for multi-file torrents; that cannot go through
    // a ?url= proxy template, so the proxy is only used for single-file torrents.
    const seed = torrent.files.length > 1 ? url : proxied(url);
    // Added again while connected, WebTorrent warns "ignoring duplicate web seed: <proxied address>".
    if (!torrent._peers?.has(seed)) torrent.addWebSeed(seed);
    if (view) {
      // Kept with the torrent: a pause, a reload or a rebuild drops the connection, not the seed.
      if (!view.webSeeds.includes(seed)) view.webSeeds.push(seed);
      persistTorrent(view);
      logEvent(view, `web seed added: ${url}`);
    }
    toast('Web seed added.');
  } catch (err) {
    toast(`Could not add web seed: ${err.message}`, { error: true });
  }
}

/** Say "Copied" on the button itself: a toast about a link is not the link. */
async function copyFrom(button, text) {
  const ok = await copyText(text);
  const was = button.textContent;
  button.textContent = ok ? 'Copied' : 'Press and hold to copy';
  setTimeout(() => { button.textContent = was; }, ok ? 1400 : 2600);
}

/**
 * Sharing shows the links. A share sheet is one more way to send them, not the
 * only one — and on a desktop, or when the sheet is dismissed, there has to be
 * something to select and copy.
 */
function shareTorrent(torrent) {
  const view = views.get(torrent);
  if (!view) return;
  if (!torrent.infoHash) {
    toast('Wait until the torrent has an info hash.');
    return;
  }
  const panel = $('.share-panel', view.el);
  const appLink = $('.share-app-link', view.el);
  const magnet = $('.share-magnet', view.el);
  // A private torrent's links are not for sharing. Its magnet names its own tracker, whose address
  // carries the user's passkey; and a magnet has no private flag, so the copy of this app that opens
  // one adds the public trackers and asks the torrent caches for its info hash — what gets accounts
  // banned. The .torrent keeps the flag: it is what the panel offers instead, for the user's own
  // devices, since it carries the passkey too.
  const secret = Boolean(view.reach?.private);
  $('.share-private', view.el).hidden = !secret;
  for (const row of $$('.share-row', view.el)) row.hidden = secret;
  appLink.value = secret ? '' : appLinkFor(torrent);
  magnet.value = secret ? '' : torrent.magnetURI;
  panel.hidden = false;
  $('.share-native-btn', view.el).hidden = secret || !navigator.share;
  if (secret) return;
  // Selected, so one tap on the phone's own "Copy" does the job too.
  appLink.focus();
  appLink.setSelectionRange(0, appLink.value.length);
}

async function shareNatively(torrent) {
  const url = appLinkFor(torrent);
  const title = torrent.name || 'Torrent';
  try {
    await navigator.share({ title, text: `Download "${title}" with Phone Torrent`, url });
  } catch (err) {
    if (err && err.name !== 'AbortError') toast(`Could not share: ${err.message}`, { error: true });
  }
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
  if (!askUser(() => confirm(message))) return;
  if (torrent.remote) await tellLead({ op: 'remove', ...refOf(torrent) });
  else await dropTorrent(torrent);
}

/** Remove a torrent and delete its data: asked for here, or in a copy that follows this one. */
async function dropTorrent(torrent) {
  const infoHash = torrent.infoHash;
  if (infoHash) removedHere.add(infoHash);
  removeView(torrent);
  // Forget it first so a quick reload cannot restore it while the store is being destroyed.
  if (infoHash) await dbDelete(infoHash);
  // Taken over meanwhile (this copy was stopped by the question): the copy that leads removes it.
  if (follower) {
    if (infoHash) await askLead({ op: 'remove', infoHash });
    return;
  }
  if (infoHash) otherCopies?.postMessage({ type: 'removed', infoHash });
  await removeFromClient(torrent);
  updateEmptyState();
  updateWakeLock();
}

/* ---------- more than one open copy (see LEAD_LOCK) ---------- */

/** Resolves true once this copy runs the torrents itself, false when it follows another one. */
let leading = Promise.resolve(true);
/** Resolves once the torrents are back: as the app starts, or as the lead comes to this copy. */
let restored = Promise.resolve();
let startupRestored = () => {};
/** Leading goes with a Web Lock here: only the copy that leads removes, and no other is listened to. */
let withLocks = false;
let leadQueue = null;
let takingLead = false;

/**
 * Ask for the lead. Resolves true once this copy holds it — until the copy closes, or another one
 * takes it over — false when it is not to be had now, null when the request failed or was dropped.
 */
function requestLead(options) {
  return new Promise((resolve) => {
    let held = false;
    navigator.locks.request(LEAD_LOCK, options, (lock) => {
      held = Boolean(lock);
      resolve(held);
      return held ? new Promise(() => {}) : null;
    }).catch(() => {
      if (held) demote(); // another copy took the lead over
      else resolve(null);
    });
  });
}

/** Called once, as the app starts: whether this copy runs the torrents. */
async function electLead() {
  const held = otherCopies && navigator.locks?.request ? await requestLead({ ifAvailable: true }) : null;
  decided = true;
  withLocks = held !== null;
  if (held !== false) leadSince = Date.now();
  // Web Locks that refuse to work are no Web Locks: this copy runs its own torrents, as it always did.
  if (held !== false) return true;
  follow();
  return false;
}

/** Wait in line for the lead: it comes when the copy holding it closes. */
function queueForLead() {
  leadQueue = new AbortController();
  requestLead({ signal: leadQueue.signal }).then((held) => { if (held) promote(); });
}

/** The leading copy does not answer the one being looked at: this one takes the lead from it. */
function takeLead() {
  if (!follower || takingLead) return;
  takingLead = true;
  leadQueue?.abort();
  requestLead({ steal: true }).then((held) => {
    takingLead = false;
    if (held) promote();
    else if (follower) queueForLead();
  });
}

/* A follower: what the leading copy runs, shown here. */

/** The torrents the leading copy runs, as this copy shows them, by their number there. */
const remotes = new Map();
let leadHeard = '';
let leadHeardAt = 0;
let leadTotals = { down: 0, up: 0, peers: 0, count: 0 };
let pingTimer = null;
let pingedAt = 0;
/** When the copy followed started to lead, and until when it asked the user something (askUser). */
let leadHeardSince = 0;
let leadAskingUntil = 0;
/** LEAD_SILENCE_MS and a little more, different in each copy: two looked at do not both take over. */
let silenceLimit = LEAD_SILENCE_MS;
/** Requests to the leading copy waiting for their answer. */
const calls = new Map();
let lastCallId = 0;
/** Files streaming over from the leading copy, to be failed if it goes away. */
const incoming = new Set();

function follow() {
  follower = true;
  leadHeardAt = Date.now();
  pingedAt = leadHeardAt;
  silenceLimit = LEAD_SILENCE_MS + Math.floor(Math.random() * 2000);
  queueForLead();
  clearInterval(pingTimer);
  pingTimer = setInterval(ping, 1000);
  ping();
}

/** Asks the leading copy for its list; asked every second while this copy is looked at. */
function ping() {
  if (!follower || document.visibilityState !== 'visible') return;
  const now = Date.now();
  // This copy was stopped itself — a question it asked (Remove?), a freeze — and the answers that
  // came meanwhile are still to be read: the leading copy was not silent, this one was not listening.
  if (now - pingedAt > 2500) leadHeardAt = now;
  pingedAt = now;
  otherCopies.postMessage({ type: 'ping', from: copyId, sentAt: now });
  // A phone freezes the copy it does not show, and a frozen copy answers nothing.
  if (now - leadHeardAt > silenceLimit && now > leadAskingUntil) takeLead();
}

document.addEventListener('visibilitychange', () => {
  if (!follower || document.hidden) return;
  // Hidden, this copy did not ask; the leading copy has not been silent to it.
  leadHeardAt = Date.now();
  pingedAt = leadHeardAt;
  ping();
});

/** What stands for a torrent the leading copy runs: the fields the cards read, as it last said them. */
function remoteTorrent(sid) {
  const torrent = { sid, remote: true, files: [], wires: [], destroyed: false };
  torrent.on = () => torrent;
  torrent.once = () => torrent;
  return torrent;
}

function remoteFile(torrent, index) {
  return { select() {}, deselect() {}, stream: () => streamFromLead(torrent, { file: index }) };
}

/** Which torrent a request is about: its number in the leading copy, or across a change of lead, its info hash. */
function refOf(torrent) {
  return { sid: torrent.sid, infoHash: torrent.infoHash || '' };
}

function followState(state) {
  if (!follower) return;
  // A copy that led before the one followed now, thawed, and not yet told: it is not followed back.
  if (state.lead !== leadHeard && leadHeard && state.since < leadHeardSince) return;
  leadHeardAt = Date.now();
  leadHeardSince = state.since || 0;
  // Another copy leads now: what the last one ran is shown afresh, and what was asked of the last
  // one and never answered is asked of this one.
  if (state.lead !== leadHeard) {
    for (const torrent of [...remotes.values()]) dropRemote(torrent);
    // Another copy took over from the one that handed its seeds over as it closed: they are its to run.
    if (handedOver && handedOver.from !== state.lead && state.lead) {
      for (const message of handedOver.seeds) askLead(message).catch(() => {});
      handedOver = null;
    }
    if (leadHeard && state.lead) {
      for (const entry of [...incoming]) entry.fail(new Error('the copy of this app that ran the torrents went away; save it again'));
      for (const [id, call] of [...calls]) {
        if (call.taken && call.message.op === 'cloud') {
          calls.delete(id);
          clearTimeout(call.timer);
          call.reject(new Error(UNSURE_CLOUD));
        } else {
          postCall(id, call.message, state.lead);
        }
      }
    }
    leadHeard = state.lead;
  }
  if (handedOver && handedOver.from === state.lead) handedOver = null;
  leadTotals = state.totals;
  const listed = new Set();
  let previous = null;
  for (const s of state.torrents) {
    listed.add(s.sid);
    let torrent = remotes.get(s.sid);
    const fresh = !torrent;
    if (fresh) {
      torrent = remoteTorrent(s.sid);
      remotes.set(s.sid, torrent);
    }
    const { files, card, ...fields } = s;
    Object.assign(torrent, fields);
    if (torrent.files.length !== files.length) torrent.files = files.map((f, i) => remoteFile(torrent, i));
    files.forEach((f, i) => Object.assign(torrent.files[i], f));
    if (fresh) createTorrentView(torrent, null, card.seeding);
    const view = views.get(torrent);
    showRemote(view, card);
    // In the order the leading copy shows them.
    const at = previous ? previous.nextElementSibling : els.torrents.firstElementChild;
    if (at !== view.el) els.torrents.insertBefore(view.el, at);
    previous = view.el;
  }
  for (const torrent of [...remotes.values()]) if (!listed.has(torrent.sid)) dropRemote(torrent);
  updateEmptyState();
  updateWakeLock();
}

function showRemote(view, card) {
  const { torrent, el } = view;
  view.seeding = card.seeding;
  el.classList.toggle('seeding', card.seeding);
  view.autoStopped = card.autoStopped;
  view.reach = card.reach;
  view.webSeeds = card.webSeeds;
  view.startedAt = card.startedAt;
  view.reconnectingUntil = card.reconnectingUntil;
  if (!torrent.metadata) $('.name', el).textContent = torrent.name || torrent.infoHash || (view.seeding ? 'Preparing files…' : 'Fetching metadata…');
  if (torrent.metadata && !view.fileEls.length && torrent.files.length) {
    view.record = { deselected: card.deselected };
    renderFiles(view);
  } else if (!(Date.now() - (view.ticksSentAt || 0) < 3000)) {
    const off = new Set(card.deselected);
    view.fileEls.forEach((li, i) => {
      $('input[type="checkbox"]', li).checked = !off.has(i);
      li.classList.toggle('deselected', off.has(i));
    });
  }
  if (card.log.join('\n') !== view.log.join('\n')) {
    view.log = card.log;
    const logEl = $('.log', el);
    logEl.hidden = view.log.length === 0;
    logEl.replaceChildren(...view.log.map((line) => Object.assign(document.createElement('li'), { textContent: line })));
  }
  const cloudWas = JSON.stringify([view.cloud, view.cloudError, view.cloudNote]);
  view.cloud = card.cloud;
  view.cloudError = card.cloudError;
  view.cloudRefused = card.cloudRefused;
  if (JSON.stringify([view.cloud, view.cloudError, card.cloudNote]) !== cloudWas) renderCloud(view, card.cloudNote);
  // Files picked for sharing here: the links, once there are links.
  if (torrent.shareOnReady && torrent.infoHash && torrent.ready) {
    torrent.shareOnReady = false;
    shareTorrent(torrent);
  }
  refreshView(view);
}

function dropRemote(torrent) {
  torrent.destroyed = true;
  remotes.delete(torrent.sid);
  removeView(torrent);
}

/** Hand a request to the leading copy; resolves with its answer. */
function askLead(message) {
  return new Promise((resolve, reject) => {
    const id = `${copyId}.${++lastCallId}`;
    const call = { message, resolve, reject };
    call.timer = setTimeout(() => {
      calls.delete(id);
      reject(new Error('The copy of this app that runs the torrents did not answer. Reload this page, or close the app\'s other tabs.'));
    }, 120000);
    calls.set(id, call);
    try {
      postCall(id, message, leadHeard);
    } catch (err) {
      // Something that cannot be handed over, such as files this browser will not pass between tabs.
      clearTimeout(call.timer);
      calls.delete(id);
      reject(err);
    }
  });
}

/**
 * A request, for the copy that leads as far as this one knows (any, before it has heard of one), and
 * only for a while: a copy that thaws after a follower took the lead over, and re-ran what was
 * waiting, must not run it a second time.
 */
function postCall(id, message, to) {
  const call = calls.get(id);
  const sentAt = Date.now();
  if (call) Object.assign(call, { to, sentAt, taken: false });
  otherCopies.postMessage({ type: 'call', id, from: copyId, to, sentAt, message });
}

/** askLead for a button: what goes wrong is said, not thrown. */
function tellLead(message) {
  return askLead(message).catch((err) => toast(err.message || String(err), { error: true, timeout: 9000 }));
}

/** An add or a seed, run by the leading copy: the card it gets, as shown here. */
async function addThroughLead(message, { share = false } = {}) {
  const { sid } = await askLead(message);
  // Taken over meanwhile, this copy ran the request itself.
  if (!follower) return client.torrents.find((t) => syncIds.get(t) === sid) || null;
  const torrent = remotes.get(sid) || null;
  if (torrent && share) torrent.shareOnReady = true;
  return torrent;
}

/** How many chunks of a file streaming over from the leading copy may be on their way at once. */
const STREAM_WINDOW = 4;

/**
 * A file of a torrent the leading copy runs, streamed over from it: asked for a few chunks at a time
 * (STREAM_WINDOW), and for more only as they are read, so a save that waits holds little. Nothing
 * is asked before the first read: a zip opens a stream for every file it will hold, and reads them
 * one after the other.
 */
function streamFromLead(torrent, what) {
  const id = `${copyId}.${++lastCallId}`;
  const size = what.torrentFile ? torrent.torrentFileSize : torrent.files[what.file]?.length;
  let received = 0;
  let channel = null;
  let controller = null;
  let asked = 0; // chunks asked for and not come yet
  let wake = null;
  let silence = null;
  const entry = {};
  const done = () => {
    clearTimeout(silence);
    channel?.close();
    incoming.delete(entry);
  };
  entry.fail = (err) => {
    try { channel?.postMessage({ type: 'cancel' }); } catch { /* already closed */ }
    done();
    try { controller.error(err); } catch { /* already over */ }
    wake?.();
  };
  const expect = () => {
    clearTimeout(silence);
    if (asked > 0) silence = setTimeout(() => entry.fail(new Error('the copy of this app that runs the torrents stopped sending it')), 30000);
  };
  return new ReadableStream({
    start(c) {
      controller = c;
    },
    pull() {
      // What is asked for and what waits to be read make the window, never more.
      const credit = STREAM_WINDOW - asked - Math.max(0, -controller.desiredSize);
      if (!channel) {
        channel = new BroadcastChannel(`phone-torrent:stream:${id}`);
        incoming.add(entry);
        channel.onmessage = ({ data }) => {
          if (data.type === 'chunk') {
            asked -= 1;
            received += data.bytes.byteLength;
            controller.enqueue(data.bytes);
            expect();
          } else if (data.type === 'end') {
            // Removed, or taken over, while it was being sent: what came is not the whole file.
            if (Number.isFinite(size) && received !== size) {
              entry.fail(new Error('it ended early: the torrent was removed, or another open copy of the app took it over. Save it again'));
            } else {
              done();
              controller.close();
            }
          } else if (data.type === 'error') {
            entry.fail(new Error(data.message));
          }
          wake?.();
          wake = null;
        };
        asked = STREAM_WINDOW;
        otherCopies.postMessage({ type: 'stream', id, to: leadHeard, sentAt: Date.now(), credit: STREAM_WINDOW, ...refOf(torrent), ...what });
      } else if (credit > 0) {
        asked += credit;
        channel.postMessage({ type: 'more', credit });
      }
      expect();
      return new Promise((resolve) => { wake = resolve; });
    },
    cancel() {
      try { channel?.postMessage({ type: 'cancel' }); } catch { /* already closed */ }
      done();
    },
  }, { highWaterMark: 0 });
}

/* Leading: the torrents run here, and what the followers see of them. */

/** A torrent's number in the messages between copies. */
const syncIds = new WeakMap();
let lastSyncId = 0;

function syncId(torrent) {
  if (!torrent) return '';
  if (!syncIds.has(torrent)) syncIds.set(torrent, `${copyId}.${++lastSyncId}`);
  return syncIds.get(torrent);
}

function torrentFor({ sid, infoHash }) {
  return client.torrents.find((t) => views.has(t) && syncIds.get(t) === sid)
    || (infoHash && client.torrents.find((t) => views.has(t) && t.infoHash === infoHash))
    || null;
}

function torrentState(view) {
  const { torrent } = view;
  const metadata = Boolean(torrent.metadata);
  return {
    sid: syncId(torrent),
    infoHash: torrent.infoHash || '',
    name: torrent.name || '',
    magnetURI: torrent.infoHash ? torrent.magnetURI : '',
    length: torrent.length || 0,
    progress: torrent.progress || 0,
    downloadSpeed: torrent.downloadSpeed || 0,
    uploadSpeed: torrent.uploadSpeed || 0,
    numPeers: torrent.numPeers || 0,
    _peersLength: torrent._peersLength || 0,
    paused: Boolean(torrent.paused),
    ready: Boolean(torrent.ready),
    metadata,
    done: Boolean(torrent.done),
    downloaded: torrent.downloaded || 0,
    uploaded: torrent.uploaded || 0,
    ratio: torrent.ratio,
    pieceLength: torrent.pieceLength || 0,
    pieceCounts: pieceCounts(torrent),
    announce: [...(torrent.announce || [])],
    torrentFileSize: metadata && torrent.torrentFile ? torrent.torrentFile.byteLength : 0,
    files: torrent.files.map((f) => ({ name: f.name, path: f.path, length: f.length, downloaded: f.downloaded, progress: f.progress, done: Boolean(f.done) })),
    card: {
      seeding: view.seeding,
      autoStopped: Boolean(view.autoStopped),
      deselected: deselectedFiles(view),
      reach: view.reach || null,
      webSeeds: [...view.webSeeds],
      startedAt: view.startedAt,
      reconnectingUntil: view.reconnectingUntil || 0,
      cloud: view.cloud || null,
      cloudError: view.cloudError || '',
      cloudRefused: Boolean(view.cloudRefused),
      cloudNote: view.cloudNote || '',
      log: [...view.log],
    },
  };
}

/** What runs here, in the order it is shown, as the followers are told it. */
function lastState() {
  const order = [...els.torrents.children];
  const shown = [...views.values()].filter((v) => !v.torrent.destroyed && !v.torrent.remote).sort((a, b) => order.indexOf(a.el) - order.indexOf(b.el));
  return {
    type: 'state',
    lead: copyId,
    since: leadSince,
    torrents: shown.map(torrentState),
    totals: { down: client.downloadSpeed, up: client.uploadSpeed, peers: client.torrents.reduce((n, t) => n + t.numPeers, 0), count: client.torrents.length },
  };
}

/** Tell the followers what runs here. */
function postState() {
  if (!decided || follower || !otherCopies) return;
  try {
    otherCopies.postMessage(lastState());
  } catch (err) {
    console.warn('could not tell the other open copies:', err);
  }
}

async function answerCall({ id, from, message }) {
  followerSeenAt = Date.now();
  // Started on: should this copy stop answering now, the follower knows not to have it done twice.
  otherCopies.postMessage({ type: 'taken', id, to: from, from: copyId });
  await restored.catch(() => {});
  // Taken over while the torrents came back: the follower asks the copy that leads now.
  if (follower) return;
  let answer;
  try {
    answer = { value: await runCall(message || {}, from) };
  } catch (err) {
    answer = { error: err?.message || String(err) };
  }
  // The list first: an add is answered with the card it made, which must be there to be found.
  postState();
  otherCopies.postMessage({ type: 'reply', id, to: from, from: copyId, ...answer });
}

/** What a follower asked for, done here as if asked here — without the questions it already asked. */
async function runCall(message, from = '') {
  const torrent = torrentFor(message);
  const needed = () => {
    if (!torrent) throw new Error('That torrent is no longer in the list.');
    return torrent;
  };
  switch (message.op) {
    // A seed handed over by a copy that led before this one is added as a seed again: its data is here.
    case 'add': {
      if (message.handover && !takesHandOver(message)) return { sid: '' };
      // Handed over twice (as it closed, and again by a copy that got that word first): once is enough.
      const already = message.handover ? await client.get(message.id).catch(() => null) : null;
      if (already) return { sid: syncId(already) };
      const added = await addTorrent(message.id, { seeding: message.seeding === true });
      if (message.handover && added && !added.remote) {
        checkHandedOver(added);
        keepPaused(added, message);
      }
      return { sid: syncId(added) };
    }
    case 'seed': {
      if (message.handover && !takesHandOver(message)) return { sid: '' };
      // A seed whose link was never shown (it was still getting ready) shows it here.
      const quiet = message.handover === true && message.ready === true;
      const seeded = await seedFiles(message.files || [], { name: message.name, pickedIn: message.handover ? '' : from, handedOver: quiet });
      if (message.handover && seeded && !seeded.remote) keepPaused(seeded, message);
      return { sid: syncId(seeded) };
    }
    case 'remove':
      // Not here (it ran in a copy that is frozen now): when that copy hands it over, it stays gone.
      if (message.infoHash) removedHere.add(message.infoHash);
      if (torrent) await dropTorrent(torrent);
      return null;
    case 'pause':
      if (Boolean(needed().paused) !== Boolean(message.paused)) togglePause(torrent);
      return null;
    case 'select': {
      const view = views.get(needed());
      if (!view.fileEls.length) return null;
      const off = new Set(message.deselected || []);
      view.fileEls.forEach((li, i) => {
        $('input[type="checkbox"]', li).checked = !off.has(i);
        li.classList.toggle('deselected', off.has(i));
      });
      selectionChanged(view);
      return null;
    }
    case 'webseed':
      addWebSeed(needed(), String(message.url || ''));
      return null;
    case 'retry':
      await retryDiscovery(needed());
      return null;
    case 'cloud':
      if (!cloudReady()) throw new Error('Add your cloud API key first: Settings → Cloud fetch.');
      await startCloudFetch(views.get(needed()));
      return null;
    case 'uncloud': {
      // Deleted from the account in a copy that follows: the card lets go of it here, where it is kept.
      const view = views.get(needed());
      if (view.cloud && String(view.cloud.id) === String(message.id)) forgetCloud(view);
      return null;
    }
    case 'clear':
      await deleteEverything();
      return null;
    case 'wake':
      // Shown again, a follower says so; what was woken a moment ago is already on its way back.
      if (Date.now() >= wokenUntil) pickUpWhereWeLeftOff(String(message.why || 'back'));
      return null;
    default:
      throw new Error(`Nothing to do for "${message.op}".`);
  }
}

/**
 * A seed handed over by the copy that led before this one: its data is in storage, but the last of it
 * can land there a moment after the check WebTorrent makes as it is added, which then finds nothing to
 * seed. Its pieces are checked again, a few times, until they are all there.
 */
function checkHandedOver(torrent, waits = [1000, 3000, 6000, 12000]) {
  if (!waits.length) return;
  setTimeout(() => {
    if (torrent.destroyed || !views.has(torrent) || torrent.done) return;
    if (!torrent.ready) {
      checkHandedOver(torrent, waits.slice(1));
      return;
    }
    try {
      torrent.rescanFiles((err) => {
        const view = views.get(torrent);
        if (view) refreshView(view);
        if (!err && !torrent.done) checkHandedOver(torrent, waits.slice(1));
      });
    } catch { /* removed meanwhile */ }
  }, waits[0]);
}

/** A seed handed over is taken, unless it was removed here, or everything was deleted, since this copy leads. */
function takesHandOver(message) {
  return !(message.infoHash && removedHere.has(message.infoHash)) && !(clearedAt && clearedAt >= leadSince);
}

/** A seed handed over paused stays paused. */
function keepPaused(torrent, message) {
  if (!message.paused) return;
  const view = views.get(torrent);
  if (view) view.autoStopped = false;
  stopTransfer(torrent);
  if (view) refreshView(view);
}

/** Stream a file to the follower saving it: as many chunks as it has room for, and more as it asks. */
function sendStream({ id, sid, infoHash, file, torrentFile, credit: first }) {
  const channel = new BroadcastChannel(`phone-torrent:stream:${id}`);
  let reader = null;
  let closed = false;
  let idle = null;
  let credit = Math.max(1, Math.min(STREAM_WINDOW, Number(first) || 1));
  let pumping = false;
  let expected = 0;
  let sent = 0;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(idle);
    channel.close();
    reader?.cancel().catch(() => {});
  };
  const post = (message) => { if (!closed) channel.postMessage(message); };
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    // A follower closed in the middle of a save asks for nothing more: its stream is let go.
    clearTimeout(idle);
    idle = setTimeout(stop, 60 * 60 * 1000);
    try {
      if (!reader) {
        const torrent = torrentFor({ sid, infoHash });
        const source = !torrent ? null
          : torrentFile ? (torrent.torrentFile ? new Blob([new Uint8Array(torrent.torrentFile)]) : null)
            : torrent.files[file];
        if (!source) throw new Error('it is no longer here');
        expected = source instanceof Blob ? source.size : source.length;
        reader = source.stream().getReader();
      }
      while (credit > 0 && !closed) {
        const { value, done } = await reader.read();
        if (done) {
          if (sent !== expected) throw new Error('it ended early: the torrent was removed, or another open copy of the app took it over. Save it again');
          post({ type: 'end' });
          stop();
          break;
        }
        credit -= 1;
        sent += value.byteLength;
        // A chunk can be a window on a bigger buffer, all of which would be copied over with it.
        post({ type: 'chunk', bytes: value.byteLength === value.buffer.byteLength ? value : value.slice() });
      }
    } catch (err) {
      post({ type: 'error', message: err?.message || String(err) });
      stop();
    } finally {
      pumping = false;
    }
    if (credit > 0 && !closed) pump();
  };
  channel.onmessage = ({ data }) => {
    if (data?.type === 'more') {
      credit = Math.min(STREAM_WINDOW, credit + Math.max(1, Number(data.credit) || 1));
      pump();
    } else if (data?.type === 'cancel') {
      stop();
    }
  };
  pump();
}

/** The lead came to this copy: the one that had it closed, or stopped answering. */
async function promote() {
  if (!follower) return;
  follower = false;
  decided = true;
  leadSince = Date.now();
  leading = Promise.resolve(true);
  clearInterval(pingTimer);
  for (const torrent of [...remotes.values()]) dropRemote(torrent);
  for (const entry of [...incoming]) entry.fail(new Error('the copy of this app that ran the torrents went away; save it again'));
  leadHeard = '';
  updateEmptyState();
  const waiting = [...calls.keys()];
  const seeds = handedOver?.seeds || [];
  handedOver = null;
  // What other copies ask meanwhile waits for the torrents to be back: a pause names one of them.
  restored = dbAll().catch(() => []).then(async (records) => {
    await restoreTorrents(records.sort((a, b) => a.addedAt - b.addedAt));
    for (const message of seeds) if (!follower) await runCall(message).catch(() => {});
  });
  await restored;
  // Taken over in turn meanwhile: the seeds not run here go to the copy that leads now.
  if (follower) for (const message of seeds) askLead(message).catch(() => {});
  for (const id of waiting) settleWaiting(id);
  if (follower) return;
  updateEmptyState();
  updateWakeLock();
  postState();
}

/**
 * A request that the copy which led before never answered. Run here once that copy can no longer take
 * it (a call is only taken while fresh, see postCall), and not if it answered meanwhile. A cloud
 * transfer it had started is not sent again: done twice, it is two transfers in the account.
 */
function settleWaiting(id) {
  const call = calls.get(id);
  if (!call) return;
  if (follower) {
    if (call.taken && call.message.op === 'cloud') {
      calls.delete(id);
      clearTimeout(call.timer);
      call.reject(new Error(UNSURE_CLOUD));
    } else {
      postCall(id, call.message, leadHeard);
    }
    return;
  }
  const fresh = (call.sentAt || 0) + LEAD_SILENCE_MS - Date.now();
  if (fresh > 0 && !call.taken) {
    setTimeout(() => settleWaiting(id), fresh + 100);
    return;
  }
  calls.delete(id);
  clearTimeout(call.timer);
  if (call.taken && call.message.op === 'cloud') call.reject(new Error(UNSURE_CLOUD));
  else runCall(call.message).then(call.resolve, call.reject);
}

const UNSURE_CLOUD = 'The copy of this app that was sending it to the cloud stopped answering: look in the cloud library before sending it again.';

/** Another copy took the lead over: it runs the torrents from storage now, and this one shows them. */
function demote() {
  if (follower) return;
  leading = Promise.resolve(false);
  // Until the copy that took over answers, the list stays as it was rather than going blank.
  const last = lastState();
  // A seed is not remembered, so the copy that took over cannot restore it: it is handed over.
  const seeds = seedsToHandOver();
  // Handed over once their stores are closed: what was written is only there for another copy then.
  const closed = [...client.torrents].map((torrent) => {
    removeView(torrent);
    return new Promise((resolve) => client.remove(torrent, { destroyStore: false }, () => resolve()).catch(() => resolve()));
  });
  follow();
  followState({ ...last, lead: '' });
  leadHeard = '';
  updateEmptyState();
  updateWakeLock();
  // The lead may have come straight back here meanwhile (the copy that took it closed): then they run here.
  Promise.all(closed).then(() => {
    for (const message of seeds) (follower ? askLead(message) : restored.then(() => runCall(message))).catch(() => {});
  });
}

/**
 * What another copy needs to go on sharing this one's seeds, which are never remembered: the files
 * that were picked, or for a seed rebuilt by a retry, its .torrent, whose data is in storage.
 */
function seedsToHandOver() {
  // Everything is being deleted: nothing to hand over.
  if (clearing) return [];
  return [...views.values()].filter((v) => v.seeding && !v.torrent.remote && !v.torrent.destroyed).map((v) => {
    const { torrent } = v;
    const about = { handover: true, infoHash: torrent.infoHash || '', paused: Boolean(torrent.paused), ready: Boolean(torrent.ready) };
    if (v.picked) return { op: 'seed', files: v.picked.files, name: v.picked.name, ...about };
    if (opfsOk && torrent.metadata && torrent.torrentFile) return { op: 'add', id: new Uint8Array(torrent.torrentFile), seeding: true, ...about };
    return null;
  }).filter(Boolean);
}

/** Set while everything is being deleted. */
let clearing = false;
/** What was removed, or deleted all at once, in this copy: a seed handed over later does not bring it back. */
const removedHere = new Set();
let clearedAt = 0;

/** Seeds the leading copy handed over as it closed, for whichever copy takes over from it. */
let handedOver = null;

// Closing, the copy that leads hands its seeds to the one that will take over: a seed started in a
// copy that follows went on for as long as that copy was open before, and goes on for as long as one is.
window.addEventListener('pagehide', (event) => {
  // Kept in the back/forward cache, it may come back still leading.
  if (event.persisted || !decided || follower || !withLocks) return;
  const seeds = seedsToHandOver();
  try {
    if (seeds.length) otherCopies.postMessage({ type: 'handover', from: copyId, seeds });
  } catch { /* files this browser will not pass between tabs */ }
});

/**
 * Without Web Locks every copy runs every torrent, and a removal in one is passed to the others:
 * they would otherwise go on showing files whose pieces are gone, and write the record back on their
 * next change, which brought it back at 0% on the next launch. The copy that removes it deletes the
 * data; the others only let go of it. A follower drops the card at once.
 */
function letGo(data) {
  // With Web Locks, only the copy that leads removes: one that says so and runs torrents here is one
  // that was frozen, and finishes what it started before it knew another copy had taken over.
  if (withLocks && !follower) return;
  const gone = [...views.keys()].filter((t) => data.type === 'cleared' || (data.type === 'removed' && Boolean(t.infoHash) && t.infoHash === data.infoHash));
  for (const torrent of gone) {
    if (torrent.remote) {
      dropRemote(torrent);
      continue;
    }
    removeView(torrent);
    client.remove(torrent, { destroyStore: false }).catch(() => {});
  }
  if (gone.length) {
    updateEmptyState();
    updateWakeLock();
  }
}

otherCopies?.addEventListener('message', ({ data }) => {
  if (!data || typeof data !== 'object') return;
  switch (data.type) {
    // A copy still starting may be about to follow: it answers nothing yet.
    case 'ping':
      // Pings a frozen copy finds waiting when it thaws are not to be answered: it no longer leads.
      if (decided && !follower && !(Date.now() - data.sentAt > 2000)) {
        followerSeenAt = Date.now();
        postState();
      }
      break;
    case 'call':
      if (decided && !follower && (!data.to || data.to === copyId) && !(Date.now() - data.sentAt > LEAD_SILENCE_MS)) answerCall(data);
      break;
    case 'stream':
      if (decided && !follower && (!data.to || data.to === copyId) && !(Date.now() - data.sentAt > LEAD_SILENCE_MS)) sendStream(data);
      break;
    case 'asking':
      if (follower && data.from === leadHeard) leadAskingUntil = Date.now() + 5 * 60 * 1000;
      break;
    case 'answered':
      if (follower && data.from === leadHeard) {
        leadAskingUntil = 0;
        leadHeardAt = Date.now();
      }
      break;
    case 'share': {
      // Files picked here that another copy already shares: their card, and its links.
      const torrent = follower && data.to === copyId && remotes.get(data.sid);
      if (torrent) shareTorrent(torrent);
      break;
    }
    case 'state':
      followState(data);
      break;
    case 'handover':
      if (!Array.isArray(data.seeds)) break;
      if (follower) handedOver = { from: data.from, seeds: data.seeds };
      // The lead came here before the word from the copy that closed: its seeds are run here all the same.
      else if (decided) restored.then(() => { for (const message of data.seeds) if (!follower) runCall(message).catch(() => {}); });
      break;
    case 'taken': {
      const call = data.to === copyId && calls.get(data.id);
      if (call && (!call.to || call.to === data.from)) call.taken = true;
      break;
    }
    case 'reply': {
      // Only from the copy it was asked of: another that thawed and still thinks it leads may answer too.
      const call = data.to === copyId && calls.get(data.id);
      if (!call || (call.to && call.to !== data.from)) break;
      calls.delete(data.id);
      clearTimeout(call.timer);
      if (data.error) call.reject(new Error(data.error));
      else call.resolve(data.value);
      break;
    }
    case 'toast':
      if (follower && document.visibilityState === 'visible') toast(data.message, { error: Boolean(data.error), timeout: data.timeout });
      break;
    case 'removed':
    case 'cleared':
      letGo(data);
      break;
    default:
  }
});

// Settings saved in another open copy apply here too.
window.addEventListener('storage', (event) => {
  if (event.key !== SETTINGS_KEY) return;
  const was = settings;
  // The Simple / Expert switch of a Settings dialog open here is this copy's own until it is saved.
  settings = { ...loadSettings(), ...(els.settingsDialog.open ? { expert: was.expert } : {}) };
  applyTrackers();
  applySpeedLimits();
  updateWakeLock();
  if (JSON.stringify(settings.cloud) !== JSON.stringify(was.cloud)) {
    cloudAccountLine();
    refreshCloudLibrary({ quiet: true });
    if (!follower) for (const view of views.values()) if (view.cloud && view.cloudRefused) startCloudPoll(view);
  }
});

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
  if (li.dataset.saving) return;
  const btn = $('.save-btn', li);
  li.dataset.saving = '1';
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await saver.save({ name: file.name, size: file.length, stream: () => file.stream() });
    toast(`Saved ${file.name}`);
  } catch (err) {
    toast(`Could not save ${file.name}: ${err.message}`, { error: true });
  } finally {
    delete li.dataset.saving;
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function saveZip(torrent) {
  const view = views.get(torrent);
  if (!view || view.zipSaving) return;
  const files = selectedFiles(view).filter((f) => f.done || f.progress >= 1);
  if (files.length === 0) return;

  const btn = $('.zip-btn', view.el);
  view.zipSaving = true;
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
    view.zipSaving = false;
    refreshView(view); // the label and the state for what is selected now
  }
}

async function saveTorrentFile(torrent) {
  const size = torrent.remote ? torrent.torrentFileSize : torrent.torrentFile?.byteLength;
  if (!torrent.metadata || !size) {
    toast('The .torrent file is not available until metadata arrives.');
    return;
  }
  const bytes = torrent.remote ? null : new Uint8Array(torrent.torrentFile);
  try {
    await saver.save({
      name: `${torrent.name || torrent.infoHash}.torrent`,
      size,
      stream: () => (bytes ? new Blob([bytes]).stream() : streamFromLead(torrent, { torrentFile: true })),
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

/** Far above any real .torrent, which is kilobytes to a few megabytes of piece hashes. */
const TORRENT_FILE_MAX = 64 * 1024 * 1024;

/**
 * A picked file's bytes when it is a .torrent, or null. No picker can filter by file type on iOS, so a
 * video from the photo library is one tap away in each of them. Reading gigabytes just to refuse them
 * would take the tab down: a .torrent is a small bencoded dictionary, so its size and first byte say
 * enough before anything else is read. The bytes have the last word.
 */
async function readTorrentFile(f) {
  if (f.size > TORRENT_FILE_MAX || new Uint8Array(await f.slice(0, 1).arrayBuffer())[0] !== 0x64) return null;
  const bytes = new Uint8Array(await f.arrayBuffer());
  return torrentReach(bytes) ? bytes : null;
}

/**
 * Bring the card of a torrent just added into view. The cloud library sits above the list, on every
 * tab: with a few transfers in it, a new card landed screens below, and nothing on screen said it came.
 */
function showCard(torrent) {
  views.get(torrent)?.el.scrollIntoView({ block: 'nearest' });
}

async function addTorrentFiles(fileList) {
  for (const f of fileList) {
    let buf;
    try {
      buf = await readTorrentFile(f);
    } catch (err) {
      toast(`Could not read ${f.name}: ${err.message}`, { error: true });
      continue;
    }
    if (!buf) {
      toast(`"${f.name}" is not a .torrent file. To share a file of your own, use the "Seed & share" tab.`, { error: true });
      continue;
    }
    try {
      showCard(await addTorrent(buf));
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
  const value = els.magnetInput.value;
  const id = parseTorrentText(value);
  if (!id) {
    toast('Paste a magnet link, a 40-character info hash, or a .torrent URL.', { error: true });
    return;
  }
  // What could not be added comes back, to be fixed rather than pasted again from wherever it was.
  els.magnetInput.value = '';
  try {
    showCard(await addTorrent(id));
  } catch (err) {
    if (!els.magnetInput.value) els.magnetInput.value = value;
    toast(err.message, { error: true, timeout: 9000 });
  }
});

els.cloudForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = parseTorrentText(els.cloudInput.value);
  if (!id) {
    toast('Paste a magnet link, a 40-character info hash, or a .torrent URL.', { error: true });
    return;
  }
  const problem = /^magnet:/.test(id) ? magnetProblem(id) : '';
  if (problem) {
    toast(problem, { error: true, timeout: 9000 });
    return;
  }
  if (!cloudReady()) {
    toast('Add your cloud API key first: Settings → Cloud fetch.', { error: true });
    els.settingsBtn.click();
    return;
  }
  const value = els.cloudInput.value;
  els.cloudInput.value = '';
  try {
    // A .torrent URL is fetched here so the cloud gets the file itself, exactly as the picker does.
    if (/^https?:\/\//i.test(id)) await cloudSend({ bytes: await fetchTorrentUrl(id), name: 'torrent' });
    else await cloudSend({ magnet: id });
  } catch (err) {
    els.cloudInput.value = value;
    toast(`Could not send it: ${err.message}`, { error: true, timeout: 9000 });
  }
});

els.cloudFileInput.addEventListener('change', async () => {
  const files = Array.from(els.cloudFileInput.files || []);
  els.cloudFileInput.value = '';
  if (!cloudReady() && files.length) {
    toast('Add your cloud API key first: Settings → Cloud fetch.', { error: true });
    els.settingsBtn.click();
    return;
  }
  for (const f of files) {
    try {
      const bytes = await readTorrentFile(f);
      if (!bytes) {
        toast(`"${f.name}" is not a .torrent file.`, { error: true });
        continue;
      }
      await cloudSend({ bytes, name: f.name.replace(/\.torrent$/i, '') });
    } catch (err) {
      toast(`Could not send ${f.name}: ${err.message}`, { error: true, timeout: 9000 });
    }
  }
});

els.cloudRefreshBtn.addEventListener('click', () => {
  cloudAccountLine();
  refreshCloudLibrary();
});

els.seedFileInput.addEventListener('change', () => {
  const files = Array.from(els.seedFileInput.files || []);
  els.seedFileInput.value = '';
  if (!files.length) return;
  let name;
  if (files.length > 1) {
    // Cancel means not now. A collection with no name would be called after its first file — "a.jpg"
    // for two photos, and "a.jpg.zip" for whoever saves them — so an empty one is "Shared files".
    name = askUser(() => prompt('Name for this collection of files:', 'Shared files'));
    if (name === null) return;
    name = name.trim() || 'Shared files';
  }
  seedFiles(files, { name }).catch((err) => toast(err.message, { error: true, timeout: 9000 }));
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

// Only the add card's tabs: the Simple / Expert switch in Settings looks like one (class "tab") but
// has no panel, and matching it too hid every panel the moment the mode was changed.
$$('.tabs .tab').forEach((tab) => tab.addEventListener('click', () => {
  if (tab.dataset.tab === 'cloud') {
    cloudAccountLine();
    refreshCloudLibrary({ quiet: true });
  }
  $$('.tabs .tab').forEach((t) => {
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
  if (files.length) {
    return seedFiles(files, { name: files.length > 1 ? 'Shared files' : undefined })
      .catch((err) => toast(err.message, { error: true, timeout: 9000 }));
  }
  const text = e.dataTransfer?.getData('text');
  const id = text && parseTorrentText(text);
  if (id) await tryAddTorrent(id);
});

// Where torrents cannot run in the page (see IN_BROWSER_BLOCKED), the Download and Seed tabs say
// so, instead of offering pickers that could only fail.
if (IN_BROWSER_BLOCKED) {
  for (const note of $$('.insecure-note')) {
    note.textContent = IN_BROWSER_BLOCKED;
    note.hidden = false;
  }
  for (const control of $$('#tab-download input, #tab-download button, #tab-seed input, #tab-seed button')) control.disabled = true;
  // Not "pick a .torrent or paste a magnet above", under a picker and a field that are switched off.
  els.empty.textContent = 'No torrents here: they cannot run on this page. The Cloud tab can fetch them for you.';
} else if (NO_WEBRTC) {
  // Said where torrents are added, and nothing switched off: a web seed can still send one here.
  for (const note of $$('.insecure-note')) {
    note.textContent = NO_WEBRTC;
    note.hidden = false;
  }
}

/* ---------- screen wake lock: phones suspend the page when the screen locks ---------- */

let wakeLock = null; // Promise<WakeLockSentinel> while requested or held

function wantsWakeLock() {
  if (!settings.wakeLock) return false;
  // The cards, not the client: a copy that follows keeps the screen on for what the leading one runs,
  // which a phone does not let hold the screen when it is not the one shown.
  return [...views.keys()].some((t) => {
    if (t.paused) return false;
    const view = views.get(t);
    if (view?.seeding) return true;
    // A finished download is seeding while someone is there to take it. One still to finish is
    // not kept on by its peers alone: with every file unticked there is nothing it wants from them.
    if (isComplete(t)) return t.numPeers > 0;
    // Nothing will arrive for a private torrent this page cannot announce, and nothing is needed for
    // one the cloud already holds: the screen staying on would only drain the battery. Unless the
    // private one has a connection all the same: a web seed, its own url-list or one added by hand.
    if ((cannotDownloadHere(view?.reach) && t.numPeers === 0) || view?.cloud?.ready) return false;
    return wantsData(t);
  });
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
  els.autoResumeToggle.checked = settings.autoResume !== false;
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
  applySettingsMode(Boolean(settings.expert));
  els.cloudProviderSelect.value = CLOUD_PROVIDERS[settings.cloud.provider] ? settings.cloud.provider : DEFAULT_CLOUD_PROVIDER;
  els.cloudKeyInput.value = settings.cloud.apiKey || '';
  els.cloudBaseInput.value = settings.cloud.apiBase || '';
  cloudDraft = { ...(settings.cloud.accounts || {}), [els.cloudProviderSelect.value]: { apiKey: settings.cloud.apiKey || '', apiBase: settings.cloud.apiBase || '' } };
  cloudDraftProvider = els.cloudProviderSelect.value;
  applyCloudProviderFields();
  els.cloudProxyToggle.checked = Boolean(settings.cloud.viaProxy);
  els.cloudInfo.textContent = settings.cloud.apiKey
    ? 'A key is set. Torrents no browser can reach offer "Fetch it in the cloud".'
    : settings.cloud.provider === 'server'
      ? serverWantsToken
        ? 'This server asks for a token: paste its AUTH_TOKEN here as the key.'
        : 'No token: fine for a server alone on your machine. Set AUTH_TOKEN before anyone else can reach it.'
      : 'Without a key, cloud fetch stays hidden and nothing is sent anywhere.';
  els.fallbackDelayInput.value = String(settings.fallbackDelay || 20);
  els.rtcInput.value = settings.rtcConfig ? JSON.stringify(settings.rtcConfig) : '';
  els.wakelockToggle.checked = Boolean(settings.wakeLock);
  els.debugToggle.checked = debugEnabled();
  els.saverInfo.textContent = saver.mode === 'stream'
    ? 'Files stream straight to your downloads folder, so even very large files work.'
    : `Files are assembled in memory before saving, so very large files may fail. ${saver.reason}`;
  els.clientInfo.textContent = follower
    ? `WebTorrent ${WebTorrent.VERSION || ''} · the torrents run in another open copy of this app, and show here · ${leadTotals.count} torrent${leadTotals.count === 1 ? '' : 's'} · ↓ ${formatSpeed(leadTotals.down)} ↑ ${formatSpeed(leadTotals.up)}`
    : `WebTorrent ${WebTorrent.VERSION || ''} · peer ${client.peerId ? client.peerId.slice(0, 12) + '…' : '—'} · ${client.torrents.length} torrent${client.torrents.length === 1 ? '' : 's'} · ↓ ${formatSpeed(client.downloadSpeed)} ↑ ${formatSpeed(client.uploadSpeed)}`;
  if (!opfsOk) {
    els.storageInfo.textContent = 'This browser does not provide private file storage, so downloaded pieces are kept in memory: they are lost on reload and very large torrents may not fit.';
  } else {
    try {
      const est = await navigator.storage.estimate();
      const kept = navigator.storage.persisted ? await navigator.storage.persisted().catch(() => null) : null;
      els.storageInfo.textContent = `Downloaded pieces are kept in the browser's private storage so you can reload the page without losing progress. Currently using ${formatBytes(est.usage)} of ${formatBytes(est.quota)} available.`
        + (kept === true ? ' The browser keeps it until you delete it.' : kept === false ? ' The browser may clear it when the device runs low on space.' : '');
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

/**
 * Simple shows the two things that decide whether this works at all — a cloud
 * service, and whether to keep seeding — and hides the rest. Nothing behind
 * Expert needs touching for the app to do its job; it is there for when the
 * defaults are wrong for you.
 */
function applySettingsMode(expert) {
  settings = { ...settings, expert };
  els.modeSimpleBtn.classList.toggle('active', !expert);
  els.modeExpertBtn.classList.toggle('active', expert);
  els.modeSimpleBtn.setAttribute('aria-pressed', String(!expert));
  els.modeExpertBtn.setAttribute('aria-pressed', String(expert));
  for (const el of $$('[data-expert]', els.settingsDialog)) el.hidden = !expert;
  applyCloudProviderFields();
  els.modeHint.textContent = expert
    ? 'Everything, including the settings you can break things with.'
    : 'The settings that matter. Trackers, fallbacks and storage are already set to what works.';
}

/** Keep the key placeholder and the base-URL hint in step with the chosen provider. */
function applyCloudProviderFields() {
  const provider = els.cloudProviderSelect.value;
  const api = CLOUD_PROVIDERS[provider] || CLOUD_PROVIDERS[DEFAULT_CLOUD_PROVIDER];
  els.cloudKeyInput.placeholder = api.keyPlaceholder;
  const base = providerBase(api);
  els.cloudBaseInput.placeholder = typeof api.defaultBase === 'function' ? `${base} (this page)` : base;
  // A hosted service's address is a detail; your own server's address is the point,
  // so that one stays in Simple.
  els.cloudBaseField.hidden = !settings.expert && provider !== 'server';
}

for (const [button, expert] of [[els.modeSimpleBtn, false], [els.modeExpertBtn, true]]) {
  button.addEventListener('click', () => {
    applySettingsMode(expert);
    saveSettings({ ...settings, expert });
  });
}

/** The key and address of each service, as typed in the dialog since it opened. Saved on Save. */
let cloudDraft = {};
let cloudDraftProvider = DEFAULT_CLOUD_PROVIDER;

function typedCloudBase() {
  const typed = els.cloudBaseInput.value.trim();
  return /^https?:\/\//i.test(typed) ? typed.replace(/\/+$/, '') : '';
}

els.cloudProviderSelect.addEventListener('change', () => {
  // Each service keeps its own key and address. The ones typed for the previous service stay
  // with it, and the one chosen now shows its own: your server's address, hidden in Simple
  // mode for a hosted service, must not become where that service's key is sent.
  cloudDraft[cloudDraftProvider] = { apiKey: els.cloudKeyInput.value.trim(), apiBase: typedCloudBase() };
  cloudDraftProvider = els.cloudProviderSelect.value;
  const saved = cloudDraft[cloudDraftProvider] || {};
  els.cloudKeyInput.value = saved.apiKey || '';
  els.cloudBaseInput.value = saved.apiBase || '';
  applyCloudProviderFields();
  els.cloudInfo.textContent = '';
});

els.cloudTestBtn.addEventListener('click', async () => {
  // Try what is typed in the dialog, as it is. Nothing is saved, and nothing else in the app
  // starts using it: Cancel leaves the settings exactly as they were.
  const provider = els.cloudProviderSelect.value;
  const api = CLOUD_PROVIDERS[provider] || CLOUD_PROVIDERS[DEFAULT_CLOUD_PROVIDER];
  // An address without its scheme was taken for none at all, and this page's own was tested instead.
  const problem = cloudBaseProblem();
  if (problem) {
    els.cloudInfo.textContent = problem.mended ? `${problem.message} Test it again.` : problem.message;
    return;
  }
  els.cloudTestBtn.disabled = true;
  els.cloudInfo.textContent = 'Checking…';
  try {
    const ctx = cloudCtx({
      provider,
      base: typedCloudBase() || providerBase(api),
      key: els.cloudKeyInput.value.trim(),
      viaProxy: els.cloudProxyToggle.checked,
    });
    const who = await ctx.api.check(ctx);
    els.cloudInfo.textContent = `Key accepted${who ? ` (${who})` : ''}. Save to keep it.`;
  } catch (err) {
    // Only an answer says anything of the key: a call that got none (the address, the network, a
    // browser refusing it) did not ask.
    els.cloudInfo.textContent = `${err.status ? 'Key not usable' : 'Could not check the key'}: ${err.message}`;
  } finally {
    els.cloudTestBtn.disabled = false;
  }
});

els.resetTrackersBtn.addEventListener('click', () => {
  els.trackersInput.value = DEFAULT_TRACKERS.join('\n');
});

/** The dialog's checked values, set on submit and saved on close. */
let checkedSettings = null;

/**
 * Checked on submit, while the dialog is still open: a field that cannot be saved says so next to
 * the Save button and keeps everything else that was typed. Checked on close instead, one typo
 * used to shut the dialog and throw every other change away with it.
 */
els.settingsForm.addEventListener('submit', (event) => {
  checkedSettings = null;
  els.settingsError.hidden = true;
  if (event.submitter && event.submitter.value !== 'save') return;
  const refuse = (message, field) => {
    event.preventDefault();
    els.settingsError.textContent = message;
    els.settingsError.hidden = false;
    if (!field.closest('[hidden]')) field.focus();
  };

  const typed = els.trackersInput.value.split('\n').map((s) => s.trim()).filter((s) => /^wss?:\/\//i.test(s));
  const trackers = typed.filter(usableTracker);
  if (trackers.length === 0) return refuse('At least one wss:// tracker is needed.', els.trackersInput);

  let rtcConfig = null;
  const rtcText = els.rtcInput.value.trim();
  if (rtcText) {
    try {
      rtcConfig = JSON.parse(rtcText);
      if (!rtcConfig || typeof rtcConfig !== 'object') throw new Error('not an object');
    } catch (err) {
      return refuse(`WebRTC configuration is not valid JSON: ${err.message}`, els.rtcInput);
    }
  }

  const trackerListUrl = els.trackerListUrl.value.trim();
  if (els.trackerListToggle.checked && !/^https?:\/\//i.test(trackerListUrl)) {
    return refuse('The tracker list URL must start with http(s)://', els.trackerListUrl);
  }

  // Three fields whose mistakes used to be dropped on Save, which then said "Settings saved": the
  // field was empty the next time, and the proxy, the cache or the server was simply not used. The
  // usual mistake is mended in the field instead, to be saved as it reads then, or changed.
  const sources = els.metaSourcesInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
  const badSource = sources.find((s) => !/^https?:\/\/.*\{infohash\}/i.test(s));
  if (badSource) return refuse(`A metadata source must be an http(s):// address with {infohash} where the info hash goes: ${badSource}`, els.metaSourcesInput);

  const corsProxy = els.corsProxyInput.value.trim();
  if (corsProxy && !/^https?:\/\/.*\{url\}/i.test(corsProxy)) {
    // The address a worker's deploy prints has no {url}: the app's is the ?url= of the worker in proxy/.
    let mended = '';
    try {
      const u = new URL(corsProxy);
      if (/^https?:$/.test(u.protocol)) mended = `${u.origin}${u.pathname}${u.search ? `${u.search}&` : '?'}url={url}`;
    } catch { /* not an address at all */ }
    if (!mended) return refuse('The CORS proxy must be an http(s):// address with {url} where the address to fetch goes.', els.corsProxyInput);
    els.corsProxyInput.value = mended;
    return refuse(`The CORS proxy needs {url} where the address to fetch goes. It now reads ${mended}: Save again to keep it.`, els.corsProxyInput);
  }

  const base = cloudBaseProblem();
  if (base) return refuse(base.mended ? `${base.message} Save again to keep it.` : base.message, els.cloudBaseInput);
  checkedSettings = { typed, trackers, rtcConfig, trackerListUrl };
});

/**
 * What is wrong with the service address typed, or null: its message, and whether the field was
 * mended, to be saved (or tested) again as it reads then. "nas.local:8080" was taken as no address at
 * all: this page's. A name and a port are mended with the scheme a server at home has, a bare name
 * with a deploy's. The field is plain text, not a URL one: the browser's own check turned an IP and
 * a port, or a bare name, away with "Please enter a URL" before they got here.
 */
function cloudBaseProblem() {
  const typed = els.cloudBaseInput.value.trim();
  const unusable = { mended: false, message: 'The service address must be an http:// or https:// address: correct it, or empty the field.' };
  if (!typed) return null;
  if (/^https?:\/\//i.test(typed)) {
    try { new URL(typed); } catch { return unusable; }
    return null;
  }
  if (!/^[\w.-]+(:\d+)?(\/\S*)?$/.test(typed)) return unusable;
  const home = /:\d+/.test(typed) || /^[\d.]+(:|\/|$)/.test(typed) || /\.(local|lan|home|internal)(:|\/|$)/i.test(typed);
  els.cloudBaseInput.value = `${home ? 'http' : 'https'}://${typed}`;
  return { mended: true, message: `The service address needs http:// or https://. It now reads ${els.cloudBaseInput.value}.` };
}

// Leaves without checking or saving anything, a field that cannot be saved included.
$('button[value="cancel"]', els.settingsDialog).addEventListener('click', () => els.settingsDialog.close('cancel'));

els.settingsDialog.addEventListener('close', () => {
  els.settingsError.hidden = true;
  if (els.settingsDialog.returnValue !== 'save' || !checkedSettings) return;
  const { typed, trackers, rtcConfig, trackerListUrl } = checkedSettings;
  checkedSettings = null;
  if (typed.length !== trackers.length) toast(`Ignored ${typed.length - trackers.length} tracker(s) on a port browsers refuse to open.`, { error: true });

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
    autoResume: els.autoResumeToggle.checked,
    seedAfterDone: els.seedAfterToggle.checked,
    strategy: els.strategySelect.value === 'rarest' ? 'rarest' : 'sequential',
    metadataSources: els.metaSourcesInput.value.split('\n').map((s) => s.trim()).filter((s) => /^https?:\/\/.*\{infohash\}/i.test(s)),
    corsProxy: /^https?:\/\/.*\{url\}/i.test(els.corsProxyInput.value.trim()) ? els.corsProxyInput.value.trim() : '',
    cloud: {
      provider: els.cloudProviderSelect.value,
      apiKey: els.cloudKeyInput.value.trim(),
      apiBase: typedCloudBase(),
      viaProxy: els.cloudProxyToggle.checked,
      // Every service's key, so transfers started on one keep working after a switch.
      accounts: { ...cloudDraft, [els.cloudProviderSelect.value]: { apiKey: els.cloudKeyInput.value.trim(), apiBase: typedCloudBase() } },
    },
    fallbackDelay: Math.max(5, Number(els.fallbackDelayInput.value) || 20),
    dohResolver: els.dohSelect.value || DEFAULT_DOH,
    expert: Boolean(settings.expert),
  });
  applyTrackers();
  applySpeedLimits();
  updateWakeLock();
  cloudAccountLine();
  refreshCloudLibrary({ quiet: true });
  // Cards whose key was refused ask again, with the key saved now.
  if (!follower) for (const view of views.values()) if (view.cloud && view.cloudRefused) startCloudPoll(view);
  if (listChanged) refreshTrackerList({ force: true });

  const wantDebug = els.debugToggle.checked;
  if (wantDebug !== debugEnabled()) {
    try {
      if (wantDebug) localStorage.setItem('debug', DEBUG_NAMESPACES);
      else localStorage.removeItem('debug');
    } catch { /* ignore */ }
    // The torrents may run in another open copy, which reads this as it starts; and reloading this one
    // may hand them to a copy that started without it.
    if (otherCopies && (follower || followersNear())) {
      toast(`Debug logging ${wantDebug ? 'enabled' : 'disabled'}. Reload every open copy of this app to apply it: the one that runs the torrents logs them in its own console.`, { timeout: 9000 });
      return;
    }
    toast(`Debug logging ${wantDebug ? 'enabled' : 'disabled'}. Reloading…`);
    setTimeout(() => location.reload(), 600);
    return;
  }

  // The WebRTC configuration is read as the app starts, by every open copy: the one that runs the
  // torrents may be another, and closing this one may hand them to a third.
  toast(rtcChanged
    ? `Settings saved. Reload the page to apply the WebRTC configuration${otherCopies && (follower || followersNear()) ? ', in every open copy of this app' : ''}.`
    : 'Settings saved. Trackers apply to torrents added from now on.');
});

els.clearStorageBtn.addEventListener('click', async () => {
  if (!askUser(() => confirm('Delete all torrents and their downloaded data from this browser?'))) return;
  try {
    if (follower) await askLead({ op: 'clear' });
    else await deleteEverything();
  } catch (err) {
    toast(`Could not delete everything: ${err.message}`, { error: true, timeout: 9000 });
    return;
  }
  els.settingsDialog.close();
  toast('All stored torrent data deleted.');
});

/** Every torrent and its data, gone: asked for here, or in a copy that follows this one. */
async function deleteEverything() {
  clearing = true;
  clearedAt = Date.now();
  try {
    await dbClear();
    // Taken over meanwhile (this copy was stopped by the question, or frozen): the copy that leads now
    // has the torrents, and deletes them.
    if (follower) {
      await askLead({ op: 'clear' });
      return;
    }
    otherCopies?.postMessage({ type: 'cleared' });
    for (const torrent of [...client.torrents]) {
      if (follower) break;
      removeView(torrent);
      await removeFromClient(torrent);
    }
    await deleteStoreDirs();
  } finally {
    clearing = false;
  }
  updateEmptyState();
  updateWakeLock();
}

async function deleteStoreDirs() {
  // Only touch our own directories: on *.github.io every project page shares one origin. A copy that
  // lost the lead meanwhile (frozen, then taken over) leaves them to the one that runs the torrents now.
  try {
    if (!opfsOk || follower) throw new Error('not here');
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      if (follower) break;
      if (STORE_DIR_RE.test(name) || name === 'chunks') await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  } catch { /* OPFS unavailable */ }
}

/**
 * The settings as Copy diagnostics hands them over, which is into a bug report, in public: without what
 * would hand over the accounts. Every cloud key and TURN credential is only said to be set, and so is
 * the CORS proxy, whose address is as good as a key to it.
 */
function redactedSettings(s) {
  const set = (value) => (value ? '<set>' : '');
  const accounts = Object.fromEntries(Object.entries(s.cloud?.accounts || {}).map(([provider, account]) => [provider, { ...account, apiKey: set(account?.apiKey) }]));
  const iceServers = Array.isArray(s.rtcConfig?.iceServers)
    ? s.rtcConfig.iceServers.map((server) => ({ ...server, ...(server?.username ? { username: '<set>' } : {}), ...(server?.credential ? { credential: '<set>' } : {}) }))
    : s.rtcConfig?.iceServers;
  return {
    ...s,
    corsProxy: set(s.corsProxy),
    cloud: { ...s.cloud, apiKey: set(s.cloud?.apiKey), accounts },
    rtcConfig: s.rtcConfig && typeof s.rtcConfig === 'object' ? { ...s.rtcConfig, iceServers } : s.rtcConfig,
  };
}

/** A tracker as diagnostics show it: an http(s) one without its path, where a private tracker puts the passkey. */
function redactedTracker(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && (u.pathname.length > 1 || u.search) ? `${u.protocol}//${u.host}/…` : url;
  } catch {
    return url;
  }
}

els.copyDiagBtn.addEventListener('click', async () => {
  // What the log may say of them too — a web seed added by hand, a warning naming a tracker — goes.
  // The proxy is never logged as its template, only filled in by proxied(): what goes is what comes
  // before {url}, then its host on its own.
  const proxyPrefix = (settings.corsProxy || '').trim().split('{url}')[0];
  const proxyHost = (() => { try { return new URL(proxyPrefix).host; } catch { return ''; } })();
  const secrets = [
    settings.cloud?.apiKey, ...Object.values(settings.cloud?.accounts || {}).map((a) => a?.apiKey),
    ...(proxyHost ? [proxyPrefix, proxyHost] : []),
    ...[...views.keys()].flatMap((t) => (t.announce || []).filter((u) => redactedTracker(u) !== u)),
  ].filter((secret) => typeof secret === 'string' && secret.length >= 4);
  const scrub = (line) => secrets.reduce((text, secret) => text.split(secret).join('<hidden>'), line);
  const diag = {
    app: 'phone-torrent',
    time: new Date().toISOString(),
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    saver: { mode: saver.mode, reason: saver.reason },
    // A copy that follows shows, and describes, the torrents another open copy runs.
    copy: follower ? 'follows another open copy' : 'runs the torrents',
    opfs: opfsOk,
    webrtc: typeof RTCPeerConnection === 'function',
    settings: redactedSettings(settings),
    effectiveTrackers: effectiveTrackers(),
    client: {
      version: WebTorrent.VERSION,
      peerId: client.peerId,
      downloadSpeed: follower ? leadTotals.down : client.downloadSpeed,
      uploadSpeed: follower ? leadTotals.up : client.uploadSpeed,
    },
    torrents: [...views.keys()].map((t) => ({
      name: t.name,
      infoHash: t.infoHash,
      length: t.length,
      progress: t.progress,
      downloaded: t.downloaded,
      uploaded: t.uploaded,
      numPeers: t.numPeers,
      paused: t.paused,
      done: t.done,
      announce: (t.announce || []).map(redactedTracker),
      files: t.files.map((f) => ({ path: f.path, length: f.length, progress: f.progress })),
      log: (views.get(t)?.log || []).map(scrub),
    })),
  };
  toast((await copyText(JSON.stringify(diag, null, 2))) ? 'Diagnostics copied to the clipboard.' : 'Could not copy.');
});

/* ---------- periodic refresh ---------- */

function refreshAll() {
  for (const view of views.values()) refreshView(view);
  const { down, up, peers, count } = follower ? leadTotals : {
    down: client.downloadSpeed,
    up: client.uploadSpeed,
    peers: client.torrents.reduce((n, t) => n + t.numPeers, 0),
    count: client.torrents.length,
  };
  els.netStatus.textContent = !navigator.onLine ? 'offline'
    : down > 512 || up > 512
      ? `↓ ${formatSpeed(down)} ↑ ${formatSpeed(up)}`
      : count ? `${peers} peer${peers === 1 ? '' : 's'}` : 'idle';
}

setInterval(refreshAll, 750);

// Offline, a torrent waits for the network, not for peers, trackers or a CORS proxy: say so at once.
// Coming back is handled with the other returns (pickUpWhereWeLeftOff).
window.addEventListener('offline', () => {
  for (const [torrent, view] of views) if (needsPeers(torrent)) logEvent(view, 'the network went away');
  refreshAll();
});

/* ---------- share target inbox (Android "Share to Phone Torrent") ---------- */

/**
 * A share hands over the page's title, its address and whatever text came with them, one per line:
 * "Download X" above "https://…/x.torrent". A magnet anywhere wins, as in the paste box; failing
 * that, the first word that is an info hash or a link to a .torrent. Not any link: a browser shares
 * the address of the page it is on, a torrent site's page about a torrent, and that fetched as a
 * .torrent could only fail, and send whoever shared it off to set up a CORS proxy.
 */
function parseSharedText(text) {
  const usable = (id) => (id && /^https?:/i.test(id) ? torrentLink(id) : id);
  return usable(parseTorrentText(text)) || String(text || '').split(/\s+/).map((word) => usable(parseTorrentText(word))).find(Boolean) || null;
}

/** A link that names a .torrent file, in its path or in its query (download.php?file=x.torrent). */
function torrentLink(url) {
  try {
    const { pathname, search } = new URL(url);
    return /\.torrent$/i.test(pathname) || /\.torrent(?:&|$)/i.test(safeDecode(search)) ? url : null;
  } catch {
    return null;
  }
}

/** Adds what was shared to the app; resolves with how many shared items were something to add. */
async function takeSharedInbox() {
  let usable = 0;
  if (!('caches' in window)) return usable;
  try {
    const cache = await caches.open(INBOX_CACHE);
    const keys = await cache.keys();
    for (const req of keys) {
      const res = await cache.match(req);
      await cache.delete(req);
      if (!res) continue;
      if (res.headers.get('X-Kind') === 'torrent') {
        usable += 1;
        const name = safeDecode(res.headers.get('X-Name') || 'shared.torrent');
        if (confirmExternalAdd(`the shared file "${name}"`)) await addTorrentFiles([new File([await res.blob()], name)]);
      } else {
        const id = parseSharedText(await res.text());
        if (!id) continue;
        usable += 1;
        if (confirmExternalAdd(describeTorrentId(id))) await tryAddTorrent(id);
      }
    }
  } catch { /* ignore */ }
  return usable;
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
  const id = magnetFromHash();
  if (!id) return;
  history.replaceState(null, '', location.pathname);
  if (confirmExternalAdd(describeTorrentId(id))) await tryAddTorrent(id);
});

/* ---------- startup ---------- */

const started = (async function start() {
  // Whether this copy runs the torrents or shows the ones another open copy runs (see LEAD_LOCK).
  // What another copy asks of this one waits until its torrents are back, or there are none to restore.
  restored = new Promise((resolve) => { startupRestored = resolve; });
  const elected = electLead();
  leading = elected;
  // Asked alongside everything below; only the cloud part at the end waits for the answer.
  const ownServer = adoptOwnServer();
  // Storage housekeeping first, before anything can be added or seeded.
  storageReady = (async () => {
    opfsOk = await probeOpfs();
    if (!opfsOk) console.warn('OPFS unavailable: pieces are kept in memory for this session');
    const records = await dbAll();
    records.sort((a, b) => a.addedAt - b.addedAt);
    await cleanOrphanStoresIfAlone(records);
    return records;
  })();
  const [records] = await Promise.all([storageReady, saver.init()]);

  // Give the public tracker list a moment so restored torrents announce to it too; the cached list is
  // already applied, so on a slow network we simply continue and it merges in when it arrives.
  await Promise.race([refreshTrackerList(), new Promise((r) => setTimeout(r, 2500))]);
  // And every six hours after that, for an app left open — a seed on a desktop, a phone on its
  // charger. Looked at more often than that, so that one fetched a little after this started is not
  // left for twice as long: the look is free, and nothing is fetched before the list is six hours old.
  setInterval(() => refreshTrackerList(), TRACKER_LIST_TTL / 24);
  maybeShowIosInstallHint();

  // A copy that follows restores nothing: the leading one runs them, and this one takes over from storage.
  if (await elected) await restoreTorrents(records).catch(() => {});
  startupRestored();

  const params = new URLSearchParams(location.search);
  const fromQuery = parseTorrentText(params.get('magnet') || '');
  const fromHash = magnetFromHash();
  if (fromQuery || fromHash || params.has('shared')) {
    history.replaceState(null, '', location.pathname);
  }
  // Anything a link or another app handed us gets a confirmation: a web page must not be able to
  // make this app download and seed something just by opening a URL.
  for (const id of [fromQuery, fromHash]) {
    if (id && confirmExternalAdd(describeTorrentId(id))) await tryAddTorrent(id);
  }
  // Opened by a share, the app says when there was nothing in it to add, rather than open on nothing.
  if (!(await takeSharedInbox()) && params.has('shared')) {
    toast('Nothing to add in what was shared: share a magnet, a .torrent file, or a link to one.', { error: true, timeout: 9000 });
  }

  updateEmptyState();
  updateWakeLock();

  // The cloud account is the one part of the app that exists without any local torrent.
  await ownServer;
  renderCloudLibrary();
  if (cloudReady()) {
    cloudAccountLine();
    refreshCloudLibrary({ quiet: true });
  }
})();

/** Run the remembered torrents: as the app starts, or as the lead comes to this copy. */
async function restoreTorrents(records) {
  // Nothing restores where nothing can run; the notice on the Download tab says why.
  for (const record of IN_BROWSER_BLOCKED ? [] : records) {
    // Another copy took the lead over: it restores them itself.
    if (follower) return;
    try {
      const id = sourceToId(record);
      if (!id) { dbDelete(record.infoHash); continue; }
      const torrent = await addTorrent(id, { record });
      if (!torrent || torrent.remote) continue;
      if (record.paused) {
        torrent.pause();
        const view = views.get(torrent);
        if (view) refreshView(view);
      }
    } catch (err) {
      toast(`Could not restore a torrent: ${err.message}`, { error: true });
    }
  }
}

// Whatever became of the start, another copy's requests are not held up for ever.
started.then(() => startupRestored(), () => startupRestored());

// Expose for debugging and tests.
window.__phoneTorrent = { get follower() { return follower; }, get settings() { return settings; }, client, views, saver, started, addTorrent, askTrackersNow, seedFiles, torrentReach, unreachableReason, cloudCtx, CLOUD_PROVIDERS, cloudSend, refreshCloudLibrary, effectiveTrackers, refreshTrackerList, fetchMetadataFallback, verifyTorrentBytes, findInfoSpan, runNetworkCheck, cleanOrphanStores, isComplete, get opfsOk() { return opfsOk; } };
