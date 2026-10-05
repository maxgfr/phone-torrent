/* What the command line and the MCP server do, written once.
 *
 * Two halves. The first talks to a Swarmdeck server — `npm run local` on this computer, or the image
 * somewhere else — through the same /api the page uses (server/README.md says what each call does).
 * The second works on .torrent files on the disk, with the page's own lib/ modules, no server needed.
 *
 * Nothing here prints or exits: an operation answers a plain object, or throws an Error whose message
 * is a sentence a person, or an AI, can act on.
 */
import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { applyEdits, batchEdits, createTorrent, identityChanges, parseMagnet, readTorrent, toMagnet } from '../lib/torrent-meta.js';
import { hashInline } from '../lib/torrent-hash.js';
import { checkTorrent, describeCheck, isAllGood } from '../lib/torrent-check.js';

export const DEFAULT_SERVER = 'http://127.0.0.1:8080';

/** Where `download` copies to when told nowhere: the folder `npm run local` downloads to. */
export const defaultDownloadDir = () => path.join(os.homedir(), 'Downloads', 'Swarmdeck');

const HEX_HASH = /^[a-f0-9]{40}$/i;
const BASE32_HASH = /^[a-z2-7]{32}$/i;

/** The v1 info hash of a magnet or a bare info hash, in lowercase hex; '' when it has none. */
export function infoHashIn(given) {
  const s = String(given || '').trim();
  if (HEX_HASH.test(s)) return s.toLowerCase();
  try {
    return parseMagnet(BASE32_HASH.test(s) ? `magnet:?xt=urn:btih:${s}` : s).infoHash;
  } catch {
    return '';
  }
}

/** A name that can be a file's on any disk: what the torrent calls itself, without the characters no file name may have. */
export function safeName(name, fallback = 'download') {
  const clean = [...String(name || '')].filter((c) => c >= ' ' && !'<>:"/\\|?*'.includes(c)).join('').trim().replace(/^\.+/, '');
  return clean || fallback;
}

/* ---------- the server ---------- */

/**
 * A client of one server. `server` and `token` default to SWARMDECK_URL and SWARMDECK_TOKEN; the token
 * is sent as a bearer, never in the address.
 */
export function connect({ server, token } = {}) {
  const base = String(server || process.env.SWARMDECK_URL || DEFAULT_SERVER).replace(/\/+$/, '');
  const secret = token ?? process.env.SWARMDECK_TOKEN ?? '';

  async function request(method, pathname, { json, body, type, timeout = 30000, raw = false } = {}) {
    const headers = {};
    if (secret) headers.Authorization = `Bearer ${secret}`;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (type) headers['Content-Type'] = type;
    let res;
    try {
      res = await fetch(`${base}${pathname}`, { method, headers, body, signal: timeout ? AbortSignal.timeout(timeout) : undefined });
    } catch (err) {
      if (err.name === 'TimeoutError') throw new Error(`${base} did not answer ${method} ${pathname} within ${Math.round(timeout / 1000)} s`);
      throw new Error(`No Swarmdeck server answers at ${base} (${err.cause?.code || err.message}). Start one on this computer with \`npm run local -- --no-open\`, or point SWARMDECK_URL (or --server) at yours.`);
    }
    if (!res.ok) {
      let reason = '';
      try { reason = (await res.json()).error || ''; } catch { /* not JSON */ }
      if (res.status === 401) reason = `${reason || 'unauthorized'}: set SWARMDECK_TOKEN (or --token) to the server's AUTH_TOKEN`;
      const err = new Error(`${method} ${pathname}: ${res.status} ${reason || res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return raw ? res : res.json();
  }

  const api = {
    server: base,

    /** Is it there, what can it do, and how much room is left. */
    async status() {
      const health = await request('GET', '/api/health');
      const account = await request('GET', '/api/account').catch((err) => ({ error: err.message }));
      return { server: base, ...health, account };
    },

    async list({ detail = false } = {}) {
      return (await request('GET', `/api/transfers${detail ? '?detail=1' : ''}`)).transfers;
    },

    /**
     * The transfer `ref` names: its info hash, the start of one when only one transfer starts so, or
     * its name exactly. With every file in `detail`.
     */
    async show(ref) {
      const id = await api.resolve(ref);
      return (await request('GET', `/api/transfers/${id}?detail=1`)).transfer;
    },

    async resolve(ref) {
      const given = String(ref || '').trim();
      if (!given) throw new Error('name a transfer: its info hash, the start of it, or its name');
      if (HEX_HASH.test(given)) return given.toLowerCase();
      const all = await api.list();
      const byName = all.filter((t) => t.name === given);
      if (byName.length === 1) return byName[0].id;
      const byPrefix = /^[a-f0-9]+$/i.test(given) ? all.filter((t) => t.id.startsWith(given.toLowerCase())) : [];
      const hits = byName.length ? byName : byPrefix;
      if (hits.length === 1) return hits[0].id;
      if (hits.length > 1) throw new Error(`"${given}" names ${hits.length} transfers: ${hits.map((t) => `${t.id.slice(0, 12)} ${t.name}`).join(', ')}; give more of the info hash`);
      throw new Error(`no transfer is "${given}" (${all.length} on ${base}; \`list\` shows them)`);
    },

    /**
     * Add a torrent: a magnet or an info hash, the address of a .torrent (a server started with
     * --local fetches it), or the path of a .torrent on this disk. Answers { transfer, created }:
     * created is false when the server already had it.
     */
    async add(source, { paused = false } = {}) {
      const given = String(source || '').trim();
      if (!given) throw new Error('add what? a magnet, an info hash, a .torrent address or a .torrent file');
      let res;
      if (/^magnet:\?/i.test(given) || HEX_HASH.test(given) || BASE32_HASH.test(given)) {
        res = await request('POST', '/api/transfers', { json: { magnet: given, paused }, raw: true });
      } else if (/^https?:\/\//i.test(given)) {
        res = await request('POST', '/api/transfers', { json: { url: given, paused }, raw: true, timeout: 60000 });
      } else {
        let bytes;
        try {
          bytes = await readFile(given);
        } catch (err) {
          throw new Error(`${given} is not a magnet, an info hash, an http(s) address, nor a file that can be read (${err.code || err.message})`);
        }
        res = await request('POST', `/api/transfers${paused ? '?paused=1' : ''}`, { body: bytes, type: 'application/x-bittorrent', raw: true });
      }
      const { transfer } = await res.json();
      return { transfer, created: res.status === 201 };
    },

    async setPaused(ref, paused) {
      const id = await api.resolve(ref);
      return (await request('POST', `/api/transfers/${id}`, { json: { paused: Boolean(paused) } })).transfer;
    },

    /**
     * Which files it fetches, by index (`show` lists them): `only` those, every one but `skip`, or
     * `all`. Set as told rather than added to, so the same call twice does the same thing.
     */
    async select(ref, { only, skip, all = false } = {}) {
      const ways = [only !== undefined, skip !== undefined, Boolean(all)].filter(Boolean).length;
      if (ways !== 1) throw new Error('choose the files one way: only these, all but these (skip), or all');
      const transfer = await api.show(ref);
      if (!transfer.metadata) throw new Error(`${transfer.name} has no metadata yet, so its files are not known: wait for it (\`wait ${transfer.id.slice(0, 8)} --for metadata\`)`);
      const count = transfer.detail.files.length;
      const indexes = (list) => {
        const out = [...new Set(list.map(Number))];
        const wrong = out.filter((i) => !Number.isInteger(i) || i < 0 || i >= count);
        if (wrong.length) throw new Error(`${transfer.name} has files 0 to ${count - 1}: ${wrong.join(', ')} is not one of them`);
        return out;
      };
      let deselected = [];
      if (only !== undefined) {
        const keep = new Set(indexes(only));
        if (!keep.size) throw new Error('keep at least one file, or pause the transfer');
        deselected = transfer.detail.files.map((f, i) => i).filter((i) => !keep.has(i));
      } else if (skip !== undefined) deselected = indexes(skip);
      return (await request('POST', `/api/transfers/${transfer.id}`, { json: { deselected } })).transfer;
    },

    /**
     * Take a transfer off the server. Its files stay on the disk unless `deleteFiles` says otherwise:
     * that one is not undone.
     */
    async remove(ref, { deleteFiles = false } = {}) {
      const id = await api.resolve(ref);
      const transfer = (await request('GET', `/api/transfers/${id}`)).transfer;
      await request('DELETE', `/api/transfers/${id}${deleteFiles ? '' : '?keepFiles=1'}`);
      return { removed: id, name: transfer.name, filesDeleted: Boolean(deleteFiles) };
    },

    /** Show its files in the Finder (or the file manager): a server started with --local, on this computer. */
    async reveal(ref) {
      const id = await api.resolve(ref);
      await request('POST', `/api/transfers/${id}/reveal`, { json: {} });
      return { revealed: id };
    },

    /** Its .torrent, written to `out` (a file, or a folder to put `<name>.torrent` in; this folder by default). */
    async torrentOf(ref, { out } = {}) {
      const transfer = await api.show(ref);
      const res = await request('GET', `/api/transfers/${transfer.id}/torrent`, { raw: true });
      const bytes = Buffer.from(await res.arrayBuffer());
      const file = await outputPath(out, `${safeName(transfer.name, transfer.id)}.torrent`);
      await writeFile(file, bytes);
      return { path: file, infoHash: transfer.id, name: transfer.name, size: bytes.length };
    },

    /**
     * A magnet's .torrent, asked of the swarm by the server (a minute at most) without adding it, and
     * written to `out` as torrentOf does.
     */
    async metadata(magnet, { out } = {}) {
      const given = String(magnet || '').trim();
      // The server asks the swarm through the transfer of that magnet when it has one, and a transfer
      // added paused asks no one: the minute would run out for nothing.
      const hash = infoHashIn(given);
      const same = hash && (await api.list()).find((t) => t.id === hash);
      if (same && same.paused && !same.metadata) {
        throw new Error(`${same.name} is on the server already, paused before its metadata came, and the server asks the swarm for it through that transfer: resume it (then \`torrent\` saves its .torrent), or remove it and ask again`);
      }
      const { torrent } = await request('POST', '/api/metadata', { json: { magnet: given }, timeout: 120000 });
      if (!torrent) throw new Error('nobody sent this magnet\'s metadata within a minute: no peer has it, or none was found');
      const bytes = Buffer.from(torrent, 'base64');
      const model = await readTorrent(bytes);
      const file = await outputPath(out, `${safeName(model.fields.name, model.infoHash)}.torrent`);
      await writeFile(file, bytes);
      return { path: file, infoHash: model.infoHash, name: model.fields.name, size: bytes.length };
    },

    /**
     * Copy its files from the server to `outDir` (~/Downloads/Swarmdeck when told nowhere), each at
     * its path in the torrent: file `index`, or else every file wanted that is complete. A file still
     * downloading is not copied half-done. The server on this computer writing to that very folder
     * has them there already: nothing is copied, and each file says where it is (copied: false).
     */
    async download(ref, { index, outDir } = {}) {
      const transfer = await api.show(ref);
      if (!transfer.metadata) throw new Error(`${transfer.name} has no metadata yet: it has no files to copy`);
      const files = transfer.detail.files;
      let chosen;
      if (index !== undefined && index !== null) {
        const f = files[Number(index)];
        if (!f) throw new Error(`${transfer.name} has files 0 to ${files.length - 1}: ${index} is not one of them`);
        if (!f.done) throw new Error(`file ${f.id} (${f.path}) is not complete yet: ${Math.floor(f.progress * 100)}%`);
        chosen = [f];
      } else {
        chosen = files.filter((f) => f.done && f.selected);
        if (!chosen.length) throw new Error(`${transfer.name} has no complete file yet (${Math.floor(transfer.progress * 100)}%)`);
      }
      const root = path.resolve(outDir || defaultDownloadDir());
      const { downloadDir } = await request('GET', '/api/account').catch(() => ({}));
      const inPlace = Boolean(downloadDir) && path.resolve(downloadDir) === root;
      const written = [];
      for (const f of chosen) {
        const parts = String(f.path).split(/[\\/]/).map((p) => safeName(p, '_')).filter((p) => p !== '..');
        const target = path.join(root, ...parts);
        if (!target.startsWith(root + path.sep)) throw new Error(`refusing to write ${f.path} outside ${root}`);
        if (inPlace) {
          written.push({ index: f.id, path: target, size: f.size, copied: false });
          continue;
        }
        await mkdir(path.dirname(target), { recursive: true });
        const res = await request('GET', `/api/transfers/${transfer.id}/files/${f.id}`, { raw: true, timeout: 0 });
        const partial = `${target}.part`;
        await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
        await rename(partial, target);
        written.push({ index: f.id, path: target, size: f.size, copied: true });
      }
      return { infoHash: transfer.id, name: transfer.name, files: written };
    },

    /**
     * The address of each file it fetches (or of file `index`), to play in a player or open on another
     * device: signed for that file and a day when the server has a token, never containing the token.
     * A file still downloading plays as its pieces arrive.
     */
    async links(ref, { index } = {}) {
      const transfer = await api.show(ref);
      if (!transfer.metadata) throw new Error(`${transfer.name} has no metadata yet: its files are not known`);
      const files = transfer.detail.files;
      let chosen = files.filter((f) => f.selected);
      if (index !== undefined && index !== null) {
        const f = files[Number(index)];
        if (!f) throw new Error(`${transfer.name} has files 0 to ${files.length - 1}: ${index} is not one of them`);
        chosen = [f];
      }
      return {
        infoHash: transfer.id,
        name: transfer.name,
        files: chosen.map((f) => ({ index: f.id, path: f.path, size: f.size, done: f.done, url: new URL(f.link, `${base}/`).href })),
      };
    },

    /**
     * Until its metadata is in (`until: 'metadata'`) or the files wanted are all there ('done'). A
     * transfer that fails, or is paused where it can get no further, ends the wait with an error.
     */
    async wait(ref, { until = 'done', timeout = 600, interval = 1000, onUpdate } = {}) {
      if (until !== 'metadata' && until !== 'done') throw new Error('wait for "metadata" or "done"');
      const id = await api.resolve(ref);
      const deadline = Date.now() + timeout * 1000;
      for (;;) {
        const { transfer } = await request('GET', `/api/transfers/${id}`);
        onUpdate?.(transfer);
        if (transfer.failed) throw new Error(`${transfer.name} failed: ${transfer.state}`);
        if (until === 'metadata' ? transfer.metadata : transfer.ready) return transfer;
        if (transfer.paused) {
          throw new Error(until === 'metadata' || !transfer.metadata
            ? `${transfer.name} is paused before its metadata came, and a paused transfer asks no one for it: resume it, or get its .torrent with \`metadata\` and add that`
            : `${transfer.name} is paused at ${Math.floor(transfer.progress * 100)}%: resume it to finish`);
        }
        if (Date.now() >= deadline) {
          const err = new Error(`${transfer.name} is still "${transfer.state}" after ${timeout} s (${Math.floor(transfer.progress * 100)}%)`);
          err.code = 'TIMEOUT';
          err.transfer = transfer;
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    },
  };
  return api;
}

/** `out` as a file to write; a folder (or nothing: this one) gets `name` in it. */
async function outputPath(out, name) {
  if (!out) return path.resolve(name);
  const isDir = await stat(out).then((s) => s.isDirectory(), () => /[\\/]$/.test(out));
  if (isDir) {
    await mkdir(out, { recursive: true });
    return path.resolve(out, name);
  }
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  return path.resolve(out);
}

/* ---------- .torrent files, on this disk ---------- */

async function loadTorrent(file) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (err) {
    throw new Error(`cannot read ${file} (${err.code || err.message})`);
  }
  try {
    return await readTorrent(bytes);
  } catch (err) {
    throw new Error(`${file} is not a .torrent file (${err.message})`);
  }
}

/** What a .torrent says, with its magnet. */
export async function inspect(file) {
  const model = await loadTorrent(file);
  const f = model.fields;
  return {
    file: path.resolve(file),
    infoHash: model.infoHash,
    name: f.name,
    totalLength: f.totalLength,
    pieceLength: f.pieceLength,
    pieceCount: f.pieceCount,
    private: f.private,
    source: f.source,
    comment: f.comment,
    createdBy: f.createdBy,
    creationDate: f.creationDate,
    trackers: f.trackers,
    webSeeds: f.webSeeds,
    metaVersion: f.metaVersion,
    files: f.files,
    magnet: magnetOf(model),
  };
}

const magnetOf = (model) => toMagnet({ infoHash: model.infoHash, name: model.fields.name, trackers: model.fields.trackers, webSeeds: model.fields.webSeeds });

export async function magnet(file) {
  return magnetOf(await loadTorrent(file));
}

/**
 * The same changes to several .torrent files, as the page's batch editor makes them. `changes` is
 * lib/torrent-meta.js's batch form, a field each: { trackers: { op: 'add', value: [[url]] }, comment:
 * { op: 'set', value }, ... }, op being 'set', 'add' (trackers, web seeds) or 'clear'. Written to
 * `out` (a file for one, a folder for several), or over each file with `inPlace`.
 */
export async function edit(files, changes, { out, inPlace = false } = {}) {
  const list = [].concat(files);
  if (!list.length) throw new Error('edit which .torrent files?');
  if (!out && !inPlace) throw new Error('say where the edited .torrent goes: an output path, or in place');
  if (out && list.length > 1 && !(await stat(out).then((s) => s.isDirectory(), () => false))) {
    throw new Error(`${list.length} files edited go into a folder: ${out} is not one`);
  }
  const done = [];
  for (const file of list) {
    const model = await loadTorrent(file);
    const edits = batchEdits(model, changes);
    const bytes = applyEdits(model, edits);
    const newHash = identityChanges(model, edits).length > 0;
    const target = inPlace ? path.resolve(file) : await outputPath(out, path.basename(file));
    await writeFile(target, bytes);
    const after = newHash ? (await readTorrent(bytes)).infoHash : model.infoHash;
    done.push({ file: path.resolve(file), path: target, infoHash: after, previousInfoHash: model.infoHash, newHash });
  }
  return done;
}

/**
 * The files under `target` (a file, or a folder walked whole), as Blobs read from the disk when they
 * are hashed, each with the path a folder picked in the page would give it: "<folder>/<sub>/<file>".
 */
async function blobsAt(target) {
  const root = path.resolve(target);
  const info = await stat(root).catch((err) => { throw new Error(`cannot read ${target} (${err.code || err.message})`); });
  const named = async (file, rel) => {
    const blob = await openAsBlob(file);
    Object.defineProperty(blob, 'fullPath', { value: rel });
    Object.defineProperty(blob, 'name', { value: path.basename(file) });
    return blob;
  };
  if (!info.isDirectory()) return [await named(root, path.basename(root))];
  const top = path.basename(root);
  const out = [];
  const walk = async (dir, rel) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, `${rel}/${e.name}`);
      else if (e.isFile()) out.push(await named(full, `${rel}/${e.name}`));
    }
  };
  await walk(root, top);
  if (!out.length) throw new Error(`${target} has no file in it`);
  return out;
}

/**
 * A .torrent of a file or a folder, written to `out` (by default `<name>.torrent` here). Options are
 * lib/torrent-meta.js createTorrent's: trackers (tiers), webSeeds, private, source, comment, createdBy,
 * pieceLength, exclude, name.
 */
export async function create(target, { out, onProgress, ...options } = {}) {
  const files = await blobsAt(target);
  const made = await createTorrent(files, { createdBy: 'Swarmdeck', ...options, hash: hashInline, onProgress });
  const file = await outputPath(out, `${safeName(made.name)}.torrent`);
  await writeFile(file, made.bytes);
  const total = made.files.reduce((n, f) => n + f.size, 0);
  const model = await readTorrent(made.bytes);
  return { path: file, infoHash: made.infoHash, name: made.name, pieceLength: made.pieceLength, files: made.files.length, totalLength: total, magnet: magnetOf(model) };
}

/**
 * Are the files at `target` this torrent? Every piece hashed again, as a client does before seeding.
 * `target` is the torrent's folder (or file), or a folder it is in, such as the download directory.
 */
export async function check(file, target, { onProgress } = {}) {
  const model = await loadTorrent(file);
  let where = path.resolve(target);
  // The folder it is in, given: the torrent's own folder in it is the one to read, not all of it.
  const inside = path.join(where, safeName(model.fields.name));
  if (await stat(inside).then(() => true, () => false)) where = inside;
  const result = await checkTorrent(model, await blobsAt(where), { hash: hashInline, onProgress });
  // Not its `files`: the Blobs it matched, which say nothing once printed.
  const { pieces, good, bad, missing, percent, missingFiles, wrongSizes } = result;
  return { file: path.resolve(file), path: where, infoHash: model.infoHash, ok: isAllGood(result), summary: describeCheck(result), pieces, good, bad, missing, percent, missingFiles, wrongSizes };
}
