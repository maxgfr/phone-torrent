/* What a .torrent says, and the same .torrent changed.
 *
 * The rule everything here keeps: what is not changed is not touched. The `info` dictionary — what the
 * info hash is the hash of — is copied byte for byte unless a field inside it is changed (the name, the
 * private flag, the source, the entropy), so editing the trackers, the web seeds or the comment never
 * makes a different torrent. Keys this file does not know are kept, at the top and inside `info`.
 *
 * Pure: no DOM, so it runs in Node for the tests too.
 */
import { decode, encode, Raw, text, bytesOf, hex, sha1, keyText } from './bencode.js';

const ROOT_KNOWN = new Set(['announce', 'announce-list', 'comment', 'comment.utf-8', 'created by', 'creation date', 'encoding', 'info', 'url-list', 'piece layers']);
const INFO_KNOWN = new Set(['files', 'length', 'name', 'name.utf-8', 'piece length', 'pieces', 'private', 'source', 'entropy', 'meta version', 'file tree']);

/** The fields that live inside `info`: changing one makes a different torrent, with a new info hash. */
export const IDENTITY_FIELDS = ['name', 'private', 'source', 'entropy'];

const asNumber = (v) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : null);
const toBytes = (input) => (input instanceof Uint8Array ? input : new Uint8Array(input));

function filesOf(info) {
  const files = info.get('files');
  if (Array.isArray(files)) {
    return files.filter((f) => f instanceof Map).map((f) => {
      const parts = f.get('path.utf-8') || f.get('path') || [];
      return { path: (Array.isArray(parts) ? parts : []).map(text).join('/'), length: asNumber(f.get('length')) || 0 };
    });
  }
  const name = text(info.get('name.utf-8') || info.get('name'));
  if (info.has('length')) return [{ path: name, length: asNumber(info.get('length')) || 0 }];
  // BitTorrent v2 only: a tree of files instead of a list.
  const out = [];
  const walk = (node, at) => {
    if (!(node instanceof Map)) return;
    for (const [k, v] of node) {
      if (k === '' && v instanceof Map) out.push({ path: at.join('/'), length: asNumber(v.get('length')) || 0 });
      else walk(v, [...at, keyText(k)]);
    }
  };
  walk(info.get('file tree'), []);
  return out;
}

export function trackersOf(root) {
  const list = root.get('announce-list');
  const tiers = Array.isArray(list)
    ? list.map((tier) => (Array.isArray(tier) ? tier : [tier]).map(text).map((u) => u.trim()).filter(Boolean)).filter((t) => t.length)
    : [];
  if (tiers.length) return tiers;
  const one = text(root.get('announce')).trim();
  return one ? [[one]] : [];
}

function webSeedsOf(root) {
  const v = root.get('url-list');
  if (v instanceof Uint8Array) return text(v) ? [text(v)] : [];
  return Array.isArray(v) ? v.map(text).filter(Boolean) : [];
}

function fieldsOf(root, info) {
  const pieceLength = asNumber(info.get('piece length')) || 0;
  const pieces = info.get('pieces');
  const files = filesOf(info);
  const totalLength = files.reduce((n, f) => n + f.length, 0);
  const pieceCount = pieces instanceof Uint8Array ? Math.floor(pieces.length / 20) : (pieceLength ? Math.ceil(totalLength / pieceLength) : 0);
  return {
    name: text(info.get('name.utf-8') || info.get('name')),
    private: asNumber(info.get('private')) === 1,
    source: text(info.get('source')),
    entropy: text(info.get('entropy')),
    trackers: trackersOf(root),
    webSeeds: webSeedsOf(root),
    comment: text(root.get('comment.utf-8') || root.get('comment')),
    createdBy: text(root.get('created by')),
    creationDate: asNumber(root.get('creation date')),
    pieceLength,
    pieceCount,
    lastPieceLength: pieceCount ? totalLength - (pieceCount - 1) * pieceLength : 0,
    totalLength,
    files,
    metaVersion: asNumber(info.get('meta version')),
  };
}

/** Everything the editor shows of a .torrent, and what it needs to write it back. */
export async function readTorrent(input) {
  const bytes = toBytes(input);
  const { value: root, spans } = decode(bytes, { spans: true });
  if (!(root instanceof Map)) throw new Error('not a .torrent file');
  const info = root.get('info');
  if (!(info instanceof Map)) throw new Error('not a .torrent file: it has no info dictionary');
  const [start, end] = spans.get('info');
  const infoBytes = bytes.subarray(start, end);
  const fields = fieldsOf(root, info);
  return {
    bytes,
    root,
    info,
    infoBytes,
    infoHash: hex(await sha1(infoBytes)),
    fields,
    // A v2 or hybrid torrent hashes its files a second way (SHA-256, per file), which this does not
    // compute: changing its info would leave that hash wrong. Only the outside of it is edited.
    identityLocked: fields.metaVersion !== null && fields.metaVersion >= 2,
    unknownKeys: {
      root: [...root.keys()].filter((k) => !ROOT_KNOWN.has(k)).map(keyText),
      info: [...info.keys()].filter((k) => !INFO_KNOWN.has(k)).map(keyText),
    },
  };
}

/* ---------- trackers, one per line, a blank line between tiers ---------- */

export function parseTiers(textValue) {
  const seen = new Set();
  const tiers = [[]];
  for (const raw of String(textValue || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (tiers[tiers.length - 1].length) tiers.push([]);
      continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    tiers[tiers.length - 1].push(line);
  }
  return tiers.filter((t) => t.length);
}

export function formatTiers(tiers) {
  return (tiers || []).map((t) => t.join('\n')).join('\n\n');
}

export function parseLines(textValue) {
  return [...new Set(String(textValue || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
}

const sameTiers = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function setTrackers(root, tiers) {
  root.delete('announce');
  root.delete('announce-list');
  const clean = tiers.map((t) => t.filter(Boolean)).filter((t) => t.length);
  if (!clean.length) return;
  root.set('announce', bytesOf(clean[0][0]));
  if (clean.length > 1 || clean[0].length > 1) root.set('announce-list', clean.map((t) => t.map(bytesOf)));
}

/* ---------- edits ---------- */

/** Which of the fields inside `info` these edits change. */
export function identityChanges(model, edits = {}) {
  const f = model.fields;
  return IDENTITY_FIELDS.filter((k) => edits[k] !== undefined && (k === 'private' ? Boolean(edits[k]) !== f.private : String(edits[k]) !== f[k]));
}

export function randomEntropy() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return hex(b);
}

/**
 * The .torrent with these edits made. A field left undefined is kept as it is, and so is one set to
 * what it already says. `creationDate` is 'keep', 'now', 'remove' or a number of seconds.
 */
export function applyEdits(model, edits = {}, { now = Date.now() } = {}) {
  const f = model.fields;
  const root = new Map(model.root);
  if (edits.trackers !== undefined && !sameTiers(edits.trackers, f.trackers)) setTrackers(root, edits.trackers);
  if (edits.webSeeds !== undefined && !sameTiers(edits.webSeeds, f.webSeeds)) {
    if (edits.webSeeds.length) root.set('url-list', edits.webSeeds.map(bytesOf));
    else root.delete('url-list');
  }
  if (edits.comment !== undefined && edits.comment !== f.comment) {
    root.delete('comment.utf-8');
    if (edits.comment) root.set('comment', bytesOf(edits.comment));
    else root.delete('comment');
  }
  if (edits.createdBy !== undefined && edits.createdBy !== f.createdBy) {
    if (edits.createdBy) root.set('created by', bytesOf(edits.createdBy));
    else root.delete('created by');
  }
  const date = edits.creationDate;
  if (date === 'now') root.set('creation date', Math.floor(now / 1000));
  else if (date === 'remove' || date === null) root.delete('creation date');
  else if (typeof date === 'number') root.set('creation date', Math.floor(date));

  const changed = identityChanges(model, edits);
  if (!changed.length) {
    root.set('info', new Raw(model.infoBytes));
    return encode(root);
  }
  if (model.identityLocked) throw new Error('This is a BitTorrent v2 or hybrid torrent: its name, private flag, source and entropy cannot be changed here.');
  const info = new Map(model.info);
  for (const k of changed) {
    const v = edits[k];
    if (k === 'name') {
      if (!String(v).trim()) throw new Error('A torrent needs a name.');
      info.set('name', bytesOf(v));
      if (info.has('name.utf-8')) info.set('name.utf-8', bytesOf(v));
    } else if (k === 'private') {
      if (v) info.set('private', 1);
      else info.delete('private');
    } else if (v) info.set(k, bytesOf(v));
    else info.delete(k);
  }
  root.set('info', info);
  return encode(root);
}

/**
 * The same edits across several .torrent files, each field as { op, value }: 'keep' leaves it, 'set'
 * writes value, 'clear' empties it, and 'add' (trackers and web seeds) appends what each lacks.
 */
export function batchEdits(model, fields) {
  const f = model.fields;
  const edits = {};
  for (const [key, spec] of Object.entries(fields || {})) {
    if (!spec || spec.op === 'keep' || spec.op === undefined) continue;
    if (key === 'trackers') {
      if (spec.op === 'clear') edits.trackers = [];
      else if (spec.op === 'set') edits.trackers = spec.value;
      else if (spec.op === 'add') {
        const have = new Set(f.trackers.flat());
        edits.trackers = [...f.trackers, ...spec.value.map((t) => t.filter((u) => !have.has(u))).filter((t) => t.length)];
      }
    } else if (key === 'webSeeds') {
      if (spec.op === 'clear') edits.webSeeds = [];
      else if (spec.op === 'set') edits.webSeeds = spec.value;
      else if (spec.op === 'add') edits.webSeeds = [...new Set([...f.webSeeds, ...spec.value])];
    } else if (key === 'creationDate') {
      edits.creationDate = spec.op === 'clear' ? 'remove' : spec.value;
    } else if (key === 'private') {
      edits.private = spec.op === 'clear' ? false : Boolean(spec.value);
    } else {
      edits[key] = spec.op === 'clear' ? '' : spec.value;
    }
  }
  if (model.identityLocked) for (const k of IDENTITY_FIELDS) delete edits[k];
  return edits;
}

export function applyBatch(models, fields, opts) {
  return models.map((model) => {
    const edits = batchEdits(model, fields);
    return { model, edits, bytes: applyEdits(model, edits, opts), newHash: identityChanges(model, edits).length > 0 };
  });
}

/* ---------- magnet links ---------- */

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32ToHex(s) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const c of s.toLowerCase()) {
    value = (value << 5) | BASE32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out += ((value >>> (bits - 8)) & 0xff).toString(16).padStart(2, '0');
      bits -= 8;
    }
  }
  return out;
}

const decodeParam = (v) => {
  try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch { return v; }
};

/** A magnet's parts: dn, tr, ws and xs, the v1 info hash in hex, and every other parameter as it was. */
export function parseMagnet(uri) {
  const s = String(uri || '').trim();
  if (!/^magnet:\?/i.test(s)) throw new Error('not a magnet link');
  const out = { infoHash: '', name: '', trackers: [], webSeeds: [], xs: [], rest: [] };
  for (const part of s.slice(s.indexOf('?') + 1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).toLowerCase();
    const raw = eq < 0 ? '' : part.slice(eq + 1);
    const value = decodeParam(raw);
    const btih = key === 'xt' && value.match(/^urn:btih:([a-f0-9]{40}|[a-z2-7]{32})$/i);
    if (btih && !out.infoHash) out.infoHash = btih[1].length === 40 ? btih[1].toLowerCase() : base32ToHex(btih[1]);
    else if (key === 'dn') out.name = value;
    else if (key === 'tr' || /^tr\.\d+$/.test(key)) out.trackers.push(value);
    else if (key === 'ws') out.webSeeds.push(value);
    else if (key === 'xs') out.xs.push(value);
    else out.rest.push([eq < 0 ? part : part.slice(0, eq), raw]);
  }
  if (!out.infoHash) throw new Error('This magnet has no v1 info hash (xt=urn:btih:…).');
  out.trackers = [...new Set(out.trackers)];
  out.webSeeds = [...new Set(out.webSeeds)];
  return out;
}

export function toMagnet({ infoHash, name = '', trackers = [], webSeeds = [], xs = [], rest = [] }) {
  const enc = encodeURIComponent;
  const parts = [`xt=urn:btih:${infoHash}`];
  if (name) parts.push(`dn=${enc(name)}`);
  for (const t of [...new Set(trackers.flat())]) parts.push(`tr=${enc(t)}`);
  for (const w of webSeeds) parts.push(`ws=${enc(w)}`);
  for (const x of xs) parts.push(`xs=${enc(x)}`);
  for (const [k, v] of rest) parts.push(v === '' ? k : `${k}=${v}`);
  return `magnet:?${parts.join('&')}`;
}

/* ---------- piece sizes, and what private trackers ask for ---------- */

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

export const MIN_PIECE = 16 * KiB;
export const MAX_PIECE = 128 * MiB;

/** mkbrr's table: piece size by content size, to about 2,000 pieces. Its own cap is 16 MiB. */
const MKBRR_RANGES = [[64 * MiB, 15], [128 * MiB, 16], [256 * MiB, 17], [512 * MiB, 18], [GiB, 19], [2 * GiB, 20],
  [4 * GiB, 21], [8 * GiB, 22], [16 * GiB, 23], [32 * GiB, 24], [64 * GiB, 25], [128 * GiB, 26], [Infinity, 27]];

const fromRanges = (size, ranges) => 2 ** (ranges.find(([max]) => size <= max) || ranges[ranges.length - 1])[1];

/**
 * Rules of private trackers for the torrents uploaded to them, as mkbrr has them: the largest piece
 * (2^maxExp), a piece-size table of their own, the largest .torrent file, and the source they expect.
 * Matched on the first tracker's address. Built in, not editable: they are the trackers' rules.
 */
export const TRACKER_RULES = [
  { hosts: ['anthelion.me'], label: 'ANT', source: 'ANT', maxTorrentSize: 250 * KiB },
  { hosts: ['nebulance.io'], label: 'NBL', source: 'NBL', maxTorrentSize: MiB },
  { hosts: ['hdbits.org', 'superbits.org', 'sptracker.cc'], label: 'HDB', maxExp: 24, ranges: MKBRR_RANGES },
  { hosts: ['beyond-hd.me'], label: 'BHD', source: 'BHD', maxExp: 24, ranges: MKBRR_RANGES },
  { hosts: ['passthepopcorn.me'], label: 'PTP', source: 'PTP', maxExp: 24, ranges: [[58 * MiB, 16], [122 * MiB, 17], [213 * MiB, 18], [444 * MiB, 19], [922 * MiB, 20], [3977 * MiB, 21], [6861 * MiB, 22], [14234 * MiB, 23], [Infinity, 24]] },
  { hosts: ['morethantv.me'], label: 'MTV', source: 'MTV', maxExp: 23, ranges: MKBRR_RANGES },
  { hosts: ['empornium.sx'], label: 'Emp', source: 'Emp', maxExp: 23, ranges: MKBRR_RANGES },
  { hosts: ['gazellegames.net'], label: 'GGn', source: 'GGn', maxExp: 26, maxTorrentSize: MiB, ranges: MKBRR_RANGES.slice(0, 11).concat([[Infinity, 26]]) },
  { hosts: ['tracker.alpharatio.cc'], label: 'AlphaRatio', source: 'AlphaRatio', maxExp: 26, maxTorrentSize: 2 * MiB, ranges: MKBRR_RANGES.slice(0, 11).concat([[Infinity, 26]]) },
  { hosts: ['seedpool.org'], label: 'seedpool', source: 'seedpool.org', maxExp: 27, ranges: MKBRR_RANGES },
  { hosts: ['norbits.net'], label: 'NorBits', maxExp: 24, ranges: [[250 * MiB, 18], [GiB, 20], [5 * GiB, 21], [20 * GiB, 22], [40 * GiB, 23], [Infinity, 24]] },
  { hosts: ['landof.tv'], label: 'BTN', maxExp: 24, ranges: [[32 * MiB, 15], [62 * MiB, 16], [125 * MiB, 17], [250 * MiB, 18], [500 * MiB, 19], [1000 * MiB, 20], [1945 * MiB, 21], [3906 * MiB, 22], [7810 * MiB, 23], [Infinity, 24]] },
  { hosts: ['torrent-syndikat.org', 'tee-stube.org'], label: 'Syndikat', maxExp: 24, ranges: [[5 * GiB, 20], [20 * GiB, 22], [50 * GiB, 23], [Infinity, 24]] },
  { hosts: ['onlyencodes.cc'], label: 'OE', maxExp: 24, ranges: [[GiB, 20], [4 * GiB, 21], [12 * GiB, 22], [20 * GiB, 23], [Infinity, 24]] },
  { hosts: ['portugas.org'], label: 'Portugas', maxTorrentSize: 2 * MiB, ranges: [[40 * MiB, 14], [70 * MiB, 15], [150 * MiB, 16], [300 * MiB, 17], [600 * MiB, 18], [GiB, 19], [2304 * MiB, 20], [5 * GiB, 21], [8 * GiB, 22], [16 * GiB, 23], [35 * GiB, 24], [Infinity, 25]] },
  { hosts: ['lst.gg'], label: 'LST', source: 'lst.gg', maxExp: 24, ranges: [[GiB, 20], [4 * GiB, 21], [12 * GiB, 22], [20 * GiB, 23], [Infinity, 24]] },
  { hosts: ['aither.cc'], label: 'Aither', source: 'Aither', maxExp: 27, ranges: [[GiB, 20], [4 * GiB, 21], [12 * GiB, 22], [20 * GiB, 23], [Infinity, 24]] },
  { hosts: ['upload.cx'], label: 'ULCX', source: 'ULCX' },
  { hosts: ['capybarabr.com'], label: 'CapybaraBR', source: 'CapybaraBR' },
  { hosts: ['hawke.uno'], label: 'HUNO', source: 'HUNO' },
  { hosts: ['tracker.torrentleech.org', 'tracker.tleechreload.org'], label: 'TL', source: 'TorrentLeech.org', maxExp: 27, ranges: [[50 * MiB, 15], [150 * MiB, 16], [350 * MiB, 17], [512 * MiB, 18], [GiB, 19], [2 * GiB, 20], [4 * GiB, 21], [8 * GiB, 22], [16 * GiB, 23], [32 * GiB, 24], [64 * GiB, 25], [120 * GiB, 26], [Infinity, 27]] },
];

/** The rule for a tracker address, matched as mkbrr does (the address contains the host), or null. */
export function ruleFor(url) {
  const u = String(url || '');
  if (!u) return null;
  return TRACKER_RULES.find((r) => r.hosts.some((h) => u.includes(h))) || null;
}

/** What a rule asks, in a few words: "PTP: source PTP, pieces ≤ 16 MiB". */
export function describeRule(rule) {
  if (!rule) return '';
  const parts = [];
  if (rule.source) parts.push(`source ${rule.source}`);
  if (rule.maxExp) parts.push(`pieces ≤ ${formatSize(2 ** rule.maxExp)}`);
  if (rule.maxTorrentSize) parts.push(`.torrent ≤ ${formatSize(rule.maxTorrentSize)}`);
  return `${rule.label}: ${parts.join(', ') || 'no special rule'}`;
}

export function formatSize(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${Number.isInteger(v) ? v : v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * The piece size for content this big. `mode`:
 *   'auto'   — WebTorrent's own rule (what sharing always used: a piece per KiB of content, rounded
 *              to a power of two, 16 KiB to 4 MiB);
 *   'mkbrr'  — mkbrr's table (about 2,000 pieces, up to 16 MiB);
 * either way, the tracker rule's own table when it has one, as mkbrr does;
 *   'target' — the power of two that makes about `targetCount` pieces.
 * Never more than `max`, nor than the rule's largest piece.
 */
export function autoPieceLength(size, { mode = 'auto', targetCount, max, rule } = {}) {
  let length;
  if (mode === 'target' && targetCount > 0) {
    length = 2 ** Math.ceil(Math.log2(Math.max(1, size / targetCount)));
  } else if (rule?.ranges) {
    length = fromRanges(size, rule.ranges);
  } else if (mode === 'mkbrr') {
    length = Math.min(fromRanges(size, MKBRR_RANGES), 2 ** 24);
  } else {
    length = Math.min(2 ** (Math.log2(size < 1024 ? 1 : size / 1024) + 0.5 | 0), 4 * MiB);
  }
  if (rule?.maxExp) length = Math.min(length, 2 ** rule.maxExp);
  if (max > 0) length = Math.min(length, max);
  return Math.min(MAX_PIECE, Math.max(MIN_PIECE, length));
}

/** What a rule finds wrong with a .torrent of this size and piece length, in words; [] when nothing. */
export function ruleProblems(rule, { torrentSize, pieceLength }) {
  if (!rule) return [];
  const out = [];
  if (rule.maxTorrentSize && torrentSize > rule.maxTorrentSize) out.push(`${rule.label} takes .torrent files up to ${formatSize(rule.maxTorrentSize)}; this one is ${formatSize(torrentSize)}.`);
  if (rule.maxExp && pieceLength > 2 ** rule.maxExp) out.push(`${rule.label} takes pieces up to ${formatSize(2 ** rule.maxExp)}; these are ${formatSize(pieceLength)}.`);
  return out;
}

/* ---------- making a torrent ---------- */

// The files create-torrent (WebTorrent's own) leaves out: system files, and only hidden ones among
// them — Thumbs.db is kept, .DS_Store is not. The same, so the same files make the same torrent.
const JUNK = /^npm-debug\.log$|^\..*\.swp$|^\.DS_Store$|^\.AppleDouble$|^\.LSOverride$|^Icon\r$|^\._.*|^\.Spotlight-V100(?:$|\/)|\.Trashes|^__MACOSX$|~$|^Thumbs\.db$|^ehthumbs\.db$|^[Dd]esktop\.ini$|@eaDir$/;
const isJunk = (name) => name[0] === '.' && JUNK.test(name);

/** "*.nfo, Thumbs.db" as a test of a file name: * and ? as in a shell, case ignored. */
export function excludeTest(patterns) {
  const list = (Array.isArray(patterns) ? patterns : String(patterns || '').split(/[,\n]/)).map((p) => p.trim()).filter(Boolean);
  if (!list.length) return () => false;
  const re = new RegExp(`^(?:${list.map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')).join('|')})$`, 'i');
  return (name) => re.test(name);
}

/** Where a picked file goes in the torrent: its folders as dropped or picked, then its name. */
const pathOf = (file, i) => (file.fullPath || file.webkitRelativePath || file.name || `Unknown File ${i + 1}`).split('/').filter((part, at) => part || at > 0);

/** The same, as one string: "Photos/2024/a.jpg" for a file in a folder dropped or picked, its name otherwise. */
export const relativePath = (file, i = 0) => pathOf(file, i).join('/');

/**
 * These files with the paths they had, put back. A File sent to another open copy of the app arrives
 * without the folder it came in (a drop's fullPath, a picker's webkitRelativePath), and the torrent
 * made of it there would lay the files out flat: another torrent, with another info hash.
 */
export function withPaths(files, paths) {
  return [...files].map((file, i) => {
    const path = paths?.[i];
    if (path && path !== file.name && relativePath(file, i) !== path) Object.defineProperty(file, 'fullPath', { value: path, configurable: true });
    return file;
  });
}

/** The folder every one of these files is in, as dropped or picked ("Photos"), or '' when they share none. */
export function commonFolder(files) {
  const paths = [...files].map((file, i) => pathOf(file, i));
  if (!paths.length || paths.some((p) => p.length < 2)) return '';
  const [first] = paths[0];
  return paths.every((p) => p[0] === first) ? first : '';
}

/**
 * The files of a torrent made from these, as WebTorrent makes it: system files left out (and any
 * name `exclude` matches), a folder they all share taken as the torrent's name, and the name
 * otherwise `name` or the first file's. Returns { name, entries: [{ file, path }] }.
 */
export function layoutFiles(files, { name = '', exclude = '' } = {}) {
  const left = excludeTest(exclude);
  const items = [...files].map((file, i) => ({ file, path: pathOf(file, i) }));
  let prefix = null;
  items.forEach((item, i) => {
    if (item.path.length < 2) prefix = null;
    else if (i === 0 && items.length > 1) prefix = item.path[0];
    else if (item.path[0] !== prefix) prefix = null;
  });
  const kept = items.filter((item) => {
    const last = item.path[item.path.length - 1];
    return !isJunk(last) && !left(last);
  });
  if (!kept.length) throw new Error('Every file picked is left out: nothing to make a torrent of.');
  if (prefix) for (const item of kept) item.path = item.path.slice(1);
  return { name: name || prefix || kept[0].path[kept[0].path.length - 1], entries: kept };
}

/**
 * A .torrent of these files. `hash` hashes the pieces (lib/torrent-hash.js); the rest is the
 * torrent's: trackers (tiers), webSeeds, private, source, comment, createdBy, entropy, creationDate
 * (seconds, or null for none), and the piece size — pieceLength, or else autoPieceLength's options.
 * Returns { bytes, infoHash, name, files: the File objects in the torrent's order, pieceLength }.
 */
export async function createTorrent(files, {
  name = '', exclude = '', trackers = [], webSeeds = [], private: isPrivate = false, source = '', comment = '',
  createdBy = '', entropy = '', creationDate = Math.floor(Date.now() / 1000), pieceLength = 0,
  pieceMode = 'auto', targetCount = 0, maxPiece = 0, hash, onProgress, signal,
} = {}) {
  const layout = layoutFiles(files, { name, exclude });
  const total = layout.entries.reduce((n, e) => n + e.file.size, 0);
  const rule = ruleFor(trackers[0]?.[0] || '');
  const length = pieceLength || autoPieceLength(total, { mode: pieceMode, targetCount, max: maxPiece, rule });
  const { hashes } = await hash(layout.entries.map((e) => ({ blob: e.file, length: e.file.size })), length, { onProgress, signal });
  const single = layout.entries.length === 1;
  const info = new Map([
    ['name', bytesOf(layout.name)],
    ['piece length', length],
    ['pieces', hashes],
  ]);
  if (single) info.set('length', total);
  else info.set('files', layout.entries.map((e) => new Map([['length', e.file.size], ['path', e.path.map(bytesOf)]])));
  if (isPrivate) info.set('private', 1);
  if (source) info.set('source', bytesOf(source));
  if (entropy) info.set('entropy', bytesOf(entropy));
  const root = new Map([['info', info], ['encoding', bytesOf('UTF-8')]]);
  if (creationDate !== null && creationDate !== undefined) root.set('creation date', Math.floor(creationDate));
  if (createdBy) root.set('created by', bytesOf(createdBy));
  if (comment) root.set('comment', bytesOf(comment));
  const tiers = trackers.map((t) => t.filter(Boolean)).filter((t) => t.length);
  if (tiers.length) {
    root.set('announce', bytesOf(tiers[0][0]));
    root.set('announce-list', tiers.map((t) => t.map(bytesOf)));
  }
  if (webSeeds.length) root.set('url-list', webSeeds.map(bytesOf));
  return {
    bytes: encode(root),
    infoHash: hex(await sha1(encode(info))),
    name: layout.name,
    files: layout.entries.map((e) => e.file),
    pieceLength: length,
  };
}
