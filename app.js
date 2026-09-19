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

const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  torrents: $('#torrents'),
  empty: $('#empty-state'),
  fileInput: $('#torrent-file-input'),
  magnetForm: $('#magnet-form'),
  magnetInput: $('#magnet-input'),
  dropZone: $('#drop-zone'),
  netStatus: $('#net-status'),
  settingsBtn: $('#settings-btn'),
  settingsDialog: $('#settings-dialog'),
  trackersInput: $('#trackers-input'),
  resetTrackersBtn: $('#reset-trackers-btn'),
  clearStorageBtn: $('#clear-storage-btn'),
  storageInfo: $('#storage-info'),
  saverInfo: $('#saver-info'),
  toasts: $('#toasts'),
  torrentTemplate: $('#torrent-template'),
  fileTemplate: $('#file-template'),
};

/* ---------- settings ---------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.trackers)) return parsed;
    }
  } catch { /* ignore */ }
  return { trackers: [...DEFAULT_TRACKERS] };
}

function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

let settings = loadSettings();

/* ---------- persistence of added torrents (so a reload restores them) ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE, { keyPath: 'infoHash' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAll() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE).objectStore(DB_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function dbPut(record) {
  try {
    const db = await openDb();
    db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(record);
  } catch { /* ignore */ }
}

async function dbDelete(infoHash) {
  try {
    const db = await openDb();
    db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(infoHash);
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

function toast(message, { error = false, timeout = 4500 } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

function parseTorrentText(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^magnet:\?/i.test(t)) return t;
  if (/^[a-f0-9]{40}$/i.test(t) || /^[a-z2-7]{32}$/i.test(t)) return `magnet:?xt=urn:btih:${t}`;
  if (/^https?:\/\//i.test(t)) return t;
  return null;
}

/* ---------- WebTorrent client ---------- */

const client = new WebTorrent({
  tracker: { announce: settings.trackers },
});

client.on('error', (err) => toast(err.message || String(err), { error: true }));

/** @type {Map<string, {torrent: any, el: HTMLElement, fileEls: HTMLElement[], record: any}>} */
const views = new Map();

function updateEmptyState() {
  els.empty.hidden = client.torrents.length > 0;
}

async function addTorrent(id, { record } = {}) {
  const existing = await client.get(id).catch(() => null);
  if (existing) {
    toast(`"${existing.name || existing.infoHash}" is already in the list.`);
    return existing;
  }

  const torrent = client.add(id, {
    announce: settings.trackers,
    destroyStoreOnDestroy: false,
    deselect: Boolean(record && record.deselected && record.deselected.length),
  });

  const view = createTorrentView(torrent, record);
  torrent.on('error', (err) => {
    toast(`${torrent.name || 'Torrent'}: ${err.message || err}`, { error: true });
    removeView(torrent);
    updateEmptyState();
  });
  updateEmptyState();
  return torrent;
}

function createTorrentView(torrent, record) {
  const el = els.torrentTemplate.content.firstElementChild.cloneNode(true);
  const view = { torrent, el, fileEls: [], record: record || null };
  views.set(torrent, view);

  $('.name', el).textContent = torrent.name || 'Fetching metadata…';
  $('.state', el).textContent = 'connecting';
  $('.size', el).textContent = '—';

  $('.remove-btn', el).addEventListener('click', () => removeTorrent(torrent));
  $('.zip-btn', el).addEventListener('click', () => saveZip(torrent));
  $('.select-all-btn', el).addEventListener('click', () => setAllSelected(torrent, true));
  $('.select-none-btn', el).addEventListener('click', () => setAllSelected(torrent, false));

  torrent.on('infoHash', () => {
    if (!torrent.name) $('.name', el).textContent = torrent.infoHash;
  });
  torrent.on('metadata', () => renderFiles(view));
  torrent.on('done', () => {
    el.classList.add('done');
    toast(`"${torrent.name}" finished downloading.`);
    refreshView(view);
  });
  torrent.on('noPeers', () => {
    if (!torrent.done && torrent.numPeers === 0) $('.state', el).textContent = 'no peers found yet';
  });

  els.torrents.prepend(el);
  return view;
}

function renderFiles(view) {
  const { torrent, el, record } = view;
  $('.name', el).textContent = torrent.name;
  $('.size', el).textContent = formatBytes(torrent.length);

  const list = $('.files', el);
  list.textContent = '';
  view.fileEls = [];

  const deselected = new Set((record && record.deselected) || []);
  torrent.files.forEach((file, index) => {
    const li = els.fileTemplate.content.firstElementChild.cloneNode(true);
    const checkbox = $('input[type="checkbox"]', li);
    $('.file-name', li).textContent = file.path === torrent.name ? file.name : file.path.slice(torrent.name.length + 1) || file.name;
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
    });

    $('.save-btn', li).addEventListener('click', () => saveFile(torrent, file, li));
    list.appendChild(li);
    view.fileEls.push(li);
  });

  persistTorrent(view);
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
}

function persistTorrent(view) {
  const { torrent } = view;
  if (!torrent.torrentFile) return;
  const deselected = [];
  view.fileEls.forEach((li, i) => {
    if (!$('input[type="checkbox"]', li).checked) deselected.push(i);
  });
  view.record = {
    infoHash: torrent.infoHash,
    torrentFile: new Uint8Array(torrent.torrentFile),
    deselected,
    addedAt: (view.record && view.record.addedAt) || Date.now(),
  };
  dbPut(view.record);
}

function refreshView(view) {
  const { torrent, el } = view;
  if (torrent.destroyed) return;

  const selected = selectedFiles(view);
  const selectedBytes = selected.reduce((n, f) => n + f.length, 0);
  const selectedDownloaded = selected.reduce((n, f) => n + f.downloaded, 0);
  const progress = torrent.files.length
    ? (selectedBytes ? selectedDownloaded / selectedBytes : 1)
    : torrent.progress;
  const pct = Math.min(100, Math.floor(progress * 100));

  $('.progress .bar', el).style.width = `${pct}%`;
  $('.progress', el).setAttribute('aria-valuenow', String(pct));
  $('.pct', el).textContent = `${pct}%`;

  const allSelectedDone = selected.length > 0 && selected.every((f) => f.done || f.progress >= 1);
  el.classList.toggle('done', torrent.done || allSelectedDone);

  const state = torrent.done || allSelectedDone
    ? (torrent.numPeers ? `seeding to ${torrent.numPeers}` : 'complete')
    : !torrent.metadata
      ? 'fetching metadata'
      : torrent.numPeers === 0
        ? 'looking for peers'
        : 'downloading';
  $('.state', el).textContent = state;

  $('.speed', el).textContent = torrent.downloadSpeed > 1024 || torrent.uploadSpeed > 1024
    ? `↓ ${formatBytes(torrent.downloadSpeed)}/s  ↑ ${formatBytes(torrent.uploadSpeed)}/s`
    : '';
  $('.peers', el).textContent = `${torrent.numPeers} peer${torrent.numPeers === 1 ? '' : 's'}`;
  $('.eta', el).textContent = !torrent.done && torrent.downloadSpeed > 0 && selectedBytes > selectedDownloaded
    ? formatEta(((selectedBytes - selectedDownloaded) / torrent.downloadSpeed) * 1000)
    : '';

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
}

function removeView(torrent) {
  const view = views.get(torrent);
  if (!view) return;
  view.el.remove();
  views.delete(torrent);
}

async function removeTorrent(torrent) {
  const name = torrent.name || torrent.infoHash || 'this torrent';
  if (!confirm(`Remove "${name}"?\n\nIts downloaded data will be deleted from the browser. Files you already saved to your phone are not affected.`)) return;
  const infoHash = torrent.infoHash;
  removeView(torrent);
  try {
    await client.remove(torrent, { destroyStore: true });
  } catch (err) {
    toast(err.message || String(err), { error: true });
  }
  if (infoHash) dbDelete(infoHash);
  updateEmptyState();
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

/* ---------- inputs ---------- */

async function addFiles(fileList) {
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
  await addFiles(files);
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

['dragenter', 'dragover'].forEach((type) => els.dropZone.addEventListener(type, (e) => {
  e.preventDefault();
  els.dropZone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((type) => els.dropZone.addEventListener(type, (e) => {
  e.preventDefault();
  els.dropZone.classList.remove('dragover');
}));
els.dropZone.addEventListener('drop', async (e) => {
  const files = Array.from(e.dataTransfer?.files || []).filter((f) => /\.torrent$/i.test(f.name));
  if (files.length) return addFiles(files);
  const text = e.dataTransfer?.getData('text');
  const id = text && parseTorrentText(text);
  if (id) await addTorrent(id);
});

/* ---------- settings dialog ---------- */

els.settingsBtn.addEventListener('click', async () => {
  els.trackersInput.value = settings.trackers.join('\n');
  els.saverInfo.textContent = saver.mode === 'stream'
    ? 'Files stream straight to your downloads folder, so even very large files work.'
    : `Files are assembled in memory before saving, so very large files may fail. ${saver.reason}`;
  try {
    const est = await navigator.storage.estimate();
    els.storageInfo.textContent = `Downloaded pieces are kept in the browser's private storage so you can reload the page without losing progress. Currently using ${formatBytes(est.usage)} of ${formatBytes(est.quota)} available.`;
  } catch { /* keep default text */ }
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
  settings = { ...settings, trackers };
  saveSettings(settings);
  client.tracker.announce = trackers;
  toast('Trackers saved. They apply to torrents added from now on.');
});

els.clearStorageBtn.addEventListener('click', async () => {
  if (!confirm('Delete all torrents and their downloaded data from this browser?')) return;
  for (const torrent of [...client.torrents]) {
    removeView(torrent);
    await client.remove(torrent, { destroyStore: true }).catch(() => {});
  }
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  } catch { /* OPFS unavailable */ }
  try { indexedDB.deleteDatabase(DB_NAME); } catch { /* ignore */ }
  updateEmptyState();
  els.settingsDialog.close();
  toast('All stored torrent data deleted.');
});

/* ---------- periodic refresh ---------- */

setInterval(() => {
  for (const view of views.values()) refreshView(view);
  const down = client.downloadSpeed;
  const up = client.uploadSpeed;
  els.netStatus.textContent = down > 1024 || up > 1024
    ? `↓ ${formatBytes(down)}/s ↑ ${formatBytes(up)}/s`
    : client.torrents.length ? `${client.torrents.reduce((n, t) => n + t.numPeers, 0)} peers` : 'idle';
}, 750);

/* ---------- startup ---------- */

(async function start() {
  await saver.init();

  const records = await dbAll();
  records.sort((a, b) => a.addedAt - b.addedAt);
  for (const record of records) {
    try {
      await addTorrent(new Uint8Array(record.torrentFile), { record });
    } catch (err) {
      toast(`Could not restore a torrent: ${err.message}`, { error: true });
    }
  }

  const fromHash = decodeURIComponent(location.hash.slice(1));
  const id = parseTorrentText(fromHash);
  if (id) {
    history.replaceState(null, '', location.pathname + location.search);
    await addTorrent(id);
  }

  updateEmptyState();
})();

// Expose for debugging and tests.
window.__phoneTorrent = { client, views, saver, addTorrent };
