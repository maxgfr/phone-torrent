/* The .torrent workshop's own logic, without a browser.
 *
 * lib/bencode.js and lib/torrent-meta.js are plain modules: they are read here as Node reads them,
 * against .torrent files built by test/torrents.mjs — a bencoder of its own, so a mistake in one is
 * not repeated in the other.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decode, encode, infoHashOf, Raw, text } from '../lib/bencode.js';
import {
  readTorrent, applyEdits, applyBatch, identityChanges, parseTiers, formatTiers, parseMagnet, toMagnet,
  autoPieceLength, ruleFor, describeRule, ruleProblems, createTorrent, excludeTest,
} from '../lib/torrent-meta.js';
import { normalizePreset, normalizePresets, presetSummary } from '../lib/presets.js';
import { hashInline } from '../lib/torrent-hash.js';
import { createSummary, creationOptions, normalizeCreate } from '../lib/create-options.js';
import createTorrentPackage from 'create-torrent';
import { bencode, makeTorrent } from './torrents.mjs';

const log = (...a) => console.log('•', ...a);
const body = (n, seed = 1) => {
  const out = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x >> 16; }
  return out;
};
const u8 = (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/* ---------- bencode ---------- */
{
  const fixture = makeTorrent(body(50000), { name: 'clip.bin', trackers: ['wss://a.example', 'udp://b.example:1337'], urlList: ['https://mirror.example/clip.bin'] });
  const bytes = u8(fixture.buf);
  assert.deepEqual(encode(decode(bytes)), bytes, 'decode then encode gives the bytes back');
  assert.equal(await infoHashOf(bytes), fixture.infoHash, 'the info hash is the SHA-1 of the info bytes');

  // Kept as they are: an integer past 2^53, a name that is not UTF-8, key order as written.
  const big = decode(new TextEncoder().encode('i12345678901234567890e'));
  assert.equal(big, 12345678901234567890n);
  assert.deepEqual(encode(big), new TextEncoder().encode('i12345678901234567890e'));
  const latin = decode(Uint8Array.from([0x33, 0x3a, 0xe9, 0x74, 0xe9]));
  assert.deepEqual(latin, Uint8Array.from([0xe9, 0x74, 0xe9]));
  assert.equal(text(latin), 'été', 'a byte string that is not UTF-8 reads one character per byte');
  const unsorted = decode(new TextEncoder().encode('d1:bi1e1:ai2ee'));
  assert.deepEqual([...unsorted.keys()], ['b', 'a'], 'keys in the order the file has them');
  assert.deepEqual(new TextDecoder().decode(encode(unsorted)), 'd1:ai2e1:bi1ee', 'and sorted when written');
  assert.deepEqual(encode({ x: new Raw(new TextEncoder().encode('i7e')) }), new TextEncoder().encode('d1:xi7ee'), 'a Raw value is written as it is');
  for (const bad of ['d1:ai1e1:ai2ee', 'l', 'i1', '5:abc', 'd1:ai1ee extra', 'i1.5e']) {
    assert.throws(() => decode(new TextEncoder().encode(bad)), /not valid bencode/, `refused: ${bad}`);
  }
  log('bencode: byte-exact round trip, big integers, non-UTF-8 names, key order, and malformed input refused');
}

/* ---------- reading and editing a .torrent ---------- */
{
  const fixture = makeTorrent(body(70000, 3), {
    name: 'release.mkv',
    trackers: ['wss://one.example', 'https://two.example/announce'],
    urlList: ['https://seed.example/release.mkv'],
    extra: { comment: 'hello', 'created by': 'someone', 'creation date': 1700000000, 'x-custom': 'kept' },
  });
  const model = await readTorrent(u8(fixture.buf));
  assert.equal(model.infoHash, fixture.infoHash);
  const f = model.fields;
  assert.equal(f.name, 'release.mkv');
  assert.deepEqual(f.trackers, [['wss://one.example'], ['https://two.example/announce']]);
  assert.deepEqual(f.webSeeds, ['https://seed.example/release.mkv']);
  assert.equal(f.comment, 'hello');
  assert.equal(f.createdBy, 'someone');
  assert.equal(f.creationDate, 1700000000);
  assert.equal(f.pieceLength, 16384);
  assert.equal(f.pieceCount, 5);
  assert.equal(f.lastPieceLength, 70000 - 4 * 16384);
  assert.equal(f.totalLength, 70000);
  assert.deepEqual(f.files, [{ path: 'release.mkv', length: 70000 }]);
  assert.deepEqual(model.unknownKeys, { root: ['x-custom'], info: [] });

  assert.deepEqual(applyEdits(model, {}), model.bytes, 'no edits: the same bytes');
  assert.deepEqual(applyEdits(model, { ...f, creationDate: 'keep' }), model.bytes, 'every field set to what it says: the same bytes');

  // Outside info: the same torrent.
  const outside = applyEdits(model, {
    trackers: [['wss://new.example', 'wss://other.example'], ['udp://third.example:6969']],
    webSeeds: [],
    comment: 'changed',
    createdBy: '',
    creationDate: 'remove',
  });
  assert.equal(await infoHashOf(outside), fixture.infoHash, 'trackers, web seeds, comment, created by and date leave the info hash');
  const edited = await readTorrent(outside);
  assert.deepEqual(edited.fields.trackers, [['wss://new.example', 'wss://other.example'], ['udp://third.example:6969']]);
  assert.deepEqual(edited.fields.webSeeds, []);
  assert.equal(edited.fields.comment, 'changed');
  assert.equal(edited.fields.createdBy, '');
  assert.equal(edited.fields.creationDate, null);
  assert.equal(text(edited.root.get('x-custom')), 'kept', 'a key this editor does not know is kept');
  const now = applyEdits(model, { creationDate: 'now' }, { now: 1800000000123 });
  assert.equal((await readTorrent(now)).fields.creationDate, 1800000000);

  // An info dictionary written by a client that does not sort its keys: decoded and written again,
  // its bytes would change, and its hash with them. Copied as it is, they do not.
  const s = (v) => `${v.length}:${v}`;
  const careless = new TextEncoder().encode(`d${s('announce')}${s('wss://x.example')}${s('info')}d${s('name')}${s('a')}${s('length')}i1e${s('piece length')}i16384e${s('pieces')}${s('a'.repeat(20))}ee`);
  const carelessModel = await readTorrent(careless);
  assert.equal(await infoHashOf(applyEdits(carelessModel, { trackers: [['wss://y.example']], comment: 'c' })), carelessModel.infoHash, 'info bytes are copied, not written again');

  // One tracker: announce alone; none: neither key.
  const single = decode(applyEdits(model, { trackers: [['wss://only.example']] }));
  assert.equal(text(single.get('announce')), 'wss://only.example');
  assert.equal(single.has('announce-list'), false);
  const none = decode(applyEdits(model, { trackers: [] }));
  assert.equal(none.has('announce') || none.has('announce-list'), false);
  log('edits outside info keep the info hash, unknown keys and the tiers of trackers');

  // Inside info: a different torrent, each field on its own.
  const hashes = new Set([fixture.infoHash]);
  for (const edits of [{ name: 'renamed.mkv' }, { private: true }, { source: 'PTP' }, { entropy: 'abc123' }]) {
    assert.deepEqual(identityChanges(model, edits), Object.keys(edits));
    const out = applyEdits(model, edits);
    const hash = await infoHashOf(out);
    assert.ok(!hashes.has(hash), `${Object.keys(edits)[0]} makes a new info hash`);
    hashes.add(hash);
    const back = await readTorrent(out);
    assert.equal(back.fields[Object.keys(edits)[0]], Object.values(edits)[0]);
    assert.equal(back.fields.pieceCount, f.pieceCount, 'and keeps the pieces');
  }
  // The private flag off again, and the source emptied: the original torrent once more.
  const priv = await readTorrent(applyEdits(model, { private: true, source: 'X' }));
  assert.equal(await infoHashOf(applyEdits(priv, { private: false, source: '' })), fixture.infoHash);
  assert.throws(() => applyEdits(model, { name: '  ' }), /needs a name/);

  // A v2 or hybrid torrent: what is inside info is not changed here.
  const hybrid = makeTorrent(body(20000, 5), { name: 'hybrid.bin' });
  const hybridInfo = decode(u8(hybrid.buf));
  hybridInfo.get('info').set('meta version', 2);
  const hybridModel = await readTorrent(encode(hybridInfo));
  assert.equal(hybridModel.identityLocked, true);
  assert.throws(() => applyEdits(hybridModel, { source: 'X' }), /v2 or hybrid/);
  assert.equal(await infoHashOf(applyEdits(hybridModel, { comment: 'fine' })), hybridModel.infoHash, 'its trackers and comment still change');
  log('name, private, source and entropy each make a new torrent; v2 and hybrid torrents keep theirs');
}

/* ---------- multi-file torrents ---------- */
{
  const pieces = createHash('sha1').update(Buffer.alloc(16384)).digest();
  const multi = bencode({ info: { name: 'album', 'piece length': 16384, pieces, files: [{ length: 10000, path: ['cd1', 'a.flac'] }, { length: 6384, path: ['b.flac'] }], 'x-info-extra': 1 } });
  const model = await readTorrent(u8(multi));
  assert.deepEqual(model.fields.files, [{ path: 'cd1/a.flac', length: 10000 }, { path: 'b.flac', length: 6384 }]);
  assert.equal(model.fields.totalLength, 16384);
  assert.deepEqual(model.unknownKeys.info, ['x-info-extra']);
  const renamed = await readTorrent(applyEdits(model, { name: 'Album (2024)' }));
  assert.equal(renamed.fields.name, 'Album (2024)');
  assert.deepEqual(renamed.fields.files, model.fields.files, 'renaming the folder leaves the files');
  assert.equal(renamed.info.get('x-info-extra'), 1, 'and keeps what else info has');
  log('multi-file torrents: paths, sizes, and a rename of the folder');
}

/* ---------- trackers as text, one tier per paragraph ---------- */
{
  assert.deepEqual(parseTiers('wss://a\n wss://b \n\n\nudp://c\nwss://a\n\n'), [['wss://a', 'wss://b'], ['udp://c']]);
  assert.equal(formatTiers([['wss://a', 'wss://b'], ['udp://c']]), 'wss://a\nwss://b\n\nudp://c');
  assert.deepEqual(parseTiers(formatTiers([['x'], ['y', 'z']])), [['x'], ['y', 'z']]);
  assert.deepEqual(parseTiers(''), []);
  log('trackers as text: a blank line between tiers, duplicates dropped');
}

/* ---------- magnet links ---------- */
{
  const hash = 'c9e15763f722f23e98a29decdfae341b98d53056';
  const m = parseMagnet(`magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=Some+Name%20(2020)&tr=wss%3A%2F%2Fa.example&tr.1=udp://b.example:80&ws=https%3A%2F%2Fw.example%2Ff&xs=https://x.example/t.torrent&x.pe=1.2.3.4:5`);
  assert.equal(m.infoHash, hash);
  assert.equal(m.name, 'Some Name (2020)');
  assert.deepEqual(m.trackers, ['wss://a.example', 'udp://b.example:80']);
  assert.deepEqual(m.webSeeds, ['https://w.example/f']);
  assert.deepEqual(m.xs, ['https://x.example/t.torrent']);
  assert.deepEqual(m.rest, [['x.pe', '1.2.3.4:5']]);
  const back = parseMagnet(toMagnet(m));
  assert.deepEqual(back, m, 'written and read again, a magnet says the same');
  assert.equal(toMagnet({ infoHash: hash, name: 'a&b', trackers: [['wss://t']] }), `magnet:?xt=urn:btih:${hash}&dn=a%26b&tr=wss%3A%2F%2Ft`);
  assert.equal(parseMagnet('magnet:?xt=urn:btih:ZHQVOY7XELZD5GFCTXWN7LRUDOMNKMCW').infoHash, hash, 'a base32 info hash is read as hex');
  assert.throws(() => parseMagnet('magnet:?dn=x'), /no v1 info hash/);
  log('magnets: dn, tr, ws and xs read and written, other parameters kept, base32 hashes read');
}

/* ---------- piece sizes and tracker rules ---------- */
{
  const KiB = 1024;
  const MiB = 1024 * KiB;
  const GiB = 1024 * MiB;
  // What WebTorrent's own seed makes (create-torrent and piece-length): what sharing has always used.
  const webtorrent = (bytes) => Math.min(Math.max(16384, 1 << Math.log2(bytes < 1024 ? 1 : bytes / 1024) + 0.5 | 0), 4 * MiB);
  for (const size of [1, 5000, 3 * MiB + 123, 700 * MiB, 3 * GiB, 40 * GiB]) {
    assert.equal(autoPieceLength(size), webtorrent(size), `auto for ${size} bytes is what WebTorrent made`);
  }
  assert.equal(autoPieceLength(50 * MiB, { mode: 'mkbrr' }), 32 * KiB);
  assert.equal(autoPieceLength(1.5 * GiB, { mode: 'mkbrr' }), MiB);
  assert.equal(autoPieceLength(200 * GiB, { mode: 'mkbrr' }), 16 * MiB, 'mkbrr caps its own table at 16 MiB');
  assert.equal(autoPieceLength(GiB, { mode: 'target', targetCount: 1000 }), 2 * MiB);
  assert.equal(autoPieceLength(40 * GiB, { mode: 'mkbrr', max: 4 * MiB }), 4 * MiB, 'never past the maximum asked');
  assert.equal(autoPieceLength(100, { mode: 'target', targetCount: 1000 }), 16 * KiB, 'never under 16 KiB');

  const ptp = ruleFor('https://please.passthepopcorn.me:2710/abcdef/announce');
  assert.equal(ptp.label, 'PTP');
  assert.equal(describeRule(ptp), 'PTP: source PTP, pieces ≤ 16 MiB');
  assert.equal(autoPieceLength(100 * MiB, { rule: ptp }), 128 * KiB, 'auto takes the tracker\'s own table');
  assert.equal(autoPieceLength(100 * GiB, { rule: ptp }), 16 * MiB);
  assert.equal(autoPieceLength(100 * GiB, { rule: ruleFor('https://tracker.morethantv.me/x/announce') }), 8 * MiB, 'and its largest piece');
  assert.equal(ruleFor('wss://tracker.openwebtorrent.com'), null);
  assert.equal(ruleFor(''), null);
  const ggn = ruleFor('https://tracker.gazellegames.net/passkey/announce');
  assert.deepEqual(ruleProblems(ggn, { torrentSize: 2 * MiB, pieceLength: 128 * MiB }), [
    'GGn takes .torrent files up to 1 MiB; this one is 2 MiB.',
    'GGn takes pieces up to 64 MiB; these are 128 MiB.',
  ]);
  assert.deepEqual(ruleProblems(ggn, { torrentSize: 1000, pieceLength: MiB }), []);
  log('piece sizes: WebTorrent\'s rule by default, mkbrr\'s table, a piece count, and the trackers\' own rules');
}

/* ---------- several .torrent files at once ---------- */
{
  const a = await readTorrent(u8(makeTorrent(body(30000, 7), { name: 'a.bin', trackers: ['wss://keep.example'] }).buf));
  const b = await readTorrent(u8(makeTorrent(body(30000, 8), { name: 'b.bin', extra: { comment: 'x' }, urlList: ['https://w.example/b'] }).buf));
  const added = applyBatch([a, b], { trackers: { op: 'add', value: [['wss://keep.example'], ['wss://new.example']] }, webSeeds: { op: 'clear' }, comment: { op: 'keep' } });
  assert.deepEqual((await readTorrent(added[0].bytes)).fields.trackers, [['wss://keep.example'], ['wss://new.example']], 'add appends what each lacks');
  assert.deepEqual((await readTorrent(added[1].bytes)).fields.trackers, [['wss://keep.example'], ['wss://new.example']], 'and all of it to a file without trackers');
  assert.deepEqual((await readTorrent(added[1].bytes)).fields.webSeeds, []);
  assert.deepEqual(added.map((r) => r.newHash), [false, false]);
  for (const r of added) assert.equal(await infoHashOf(r.bytes), r.model.infoHash, 'keep the info hash');

  const set = applyBatch([a, b], { trackers: { op: 'set', value: [['wss://only.example']] }, source: { op: 'set', value: 'GGn' }, comment: { op: 'set', value: 'hi' } });
  for (const r of set) {
    const back = await readTorrent(r.bytes);
    assert.deepEqual(back.fields.trackers, [['wss://only.example']]);
    assert.equal(back.fields.source, 'GGn');
    assert.equal(back.fields.comment, 'hi');
    assert.equal(r.newHash, true);
    assert.notEqual(back.infoHash, r.model.infoHash, 'a source makes a new torrent of each');
  }
  const cleared = applyBatch([a, b], { trackers: { op: 'clear' }, comment: { op: 'clear' }, creationDate: { op: 'clear' } });
  assert.deepEqual((await readTorrent(cleared[0].bytes)).fields.trackers, []);
  assert.equal((await readTorrent(cleared[1].bytes)).fields.comment, '');
  log('batch: keep, set, clear and add, each file told whether its info hash changed');
}

/* ---------- presets ---------- */
{
  const p = normalizePreset({ name: '  PTP  ', trackers: [['https://please.passthepopcorn.me/key/announce']], source: 'PTP', private: 1, maxPiece: 2 ** 24, junk: true });
  assert.deepEqual(Object.keys(p).sort(), ['comment', 'id', 'maxPiece', 'name', 'private', 'source', 'trackers', 'webSeeds']);
  assert.equal(p.name, 'PTP');
  assert.equal(p.private, true);
  assert.equal(presetSummary(p), '1 tracker · source PTP · private · pieces ≤ 16 MiB');
  assert.equal(normalizePreset({ maxPiece: 12345 }).maxPiece, 0, 'a piece limit that is not one on offer is none');
  assert.equal(normalizePreset({}).name, 'Preset');
  assert.deepEqual(normalizePresets('nonsense'), []);
  assert.deepEqual(normalizePreset({ trackers: ['wss://a', ['wss://b', '']] }).trackers, [['wss://a'], ['wss://b']], 'a tier written as a bare address is one tier');
  log('presets: whatever was stored read as a preset, and summed up in a line');
}

/* ---------- hashing pieces ---------- */
{
  const a = body(40000, 21);
  const b = body(9000, 22);
  const whole = Buffer.concat([a, b]);
  const len = 16384;
  const want = [];
  for (let off = 0; off < whole.length; off += len) want.push(createHash('sha1').update(whole.subarray(off, off + len)).digest());
  const { hashes, absent } = await hashInline([{ blob: new Blob([a]), length: a.length }, { blob: new Blob([b]), length: b.length }], len);
  assert.deepEqual(Buffer.from(hashes), Buffer.concat(want), 'pieces run on from one file into the next');
  assert.deepEqual([...absent], [0, 0, 0]);
  // A file missing, and one shorter than the torrent says: the pieces they would fill are absent.
  const gone = await hashInline([{ blob: new Blob([a]), length: a.length }, { blob: null, length: b.length }], len);
  assert.deepEqual([...gone.absent], [0, 0, 1], 'a missing file: the piece it shares with the one before');
  assert.deepEqual(Buffer.from(gone.hashes.subarray(0, 40)), Buffer.concat(want.slice(0, 2)));
  const short = await hashInline([{ blob: new Blob([a.subarray(0, 20000)]), length: a.length }, { blob: new Blob([b]), length: b.length }], len);
  assert.deepEqual([...short.absent], [0, 1, 1], 'a short file: the pieces past its end');
  let seen = 0;
  await hashInline([{ blob: new Blob([whole]), length: whole.length }], len, { onProgress: (done) => { seen = done; } });
  assert.equal(seen, whole.length, 'progress ends at the whole length');
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(hashInline([{ blob: new Blob([whole]), length: whole.length }], len, { signal: stop.signal }), /stopped/);
  log('hashing: pieces across files, a missing file and a short one marked absent, progress, and a stop');
}

/* ---------- making a torrent ---------- */
{
  const hash = (parts, len, o) => hashInline(parts, len, o);
  const content = body(70000, 31);
  const made = await createTorrent([new File([content], 'file.bin')], { pieceLength: 16384, hash, creationDate: 1700000000 });
  assert.equal(made.infoHash, makeTorrent(content, { name: 'file.bin' }).infoHash, 'the same info hash as a .torrent made by hand from the same bytes');
  assert.equal(await infoHashOf(made.bytes), made.infoHash);

  // What WebTorrent's own seed made (create-torrent): the same info, file for file — a folder they all
  // share as the name, system files left out, and its piece size.
  const file = (data, path) => Object.assign(new File([data], path.split('/').pop()), { fullPath: path });
  const picked = () => [file(body(30000, 41), 'Album/cd1/one.flac'), file(body(500, 42), 'Album/.DS_Store'), file(body(20000, 43), 'Album/two.flac'), file(body(10, 44), 'Album/Thumbs.db')];
  const theirs = await new Promise((resolve, reject) => createTorrentPackage(picked(), { announce: ['wss://t.example'], createdBy: 'WebTorrent/0208' }, (err, buf) => (err ? reject(err) : resolve(new Uint8Array(buf)))));
  const ours = await createTorrent(picked(), { trackers: [['wss://t.example']], createdBy: 'WebTorrent/0208', hash });
  assert.equal(ours.infoHash, await infoHashOf(theirs), 'the same torrent WebTorrent makes of the same files');
  const back = await readTorrent(ours.bytes);
  assert.equal(back.fields.name, 'Album');
  assert.deepEqual(back.fields.files.map((f) => f.path), ['cd1/one.flac', 'two.flac', 'Thumbs.db'], '.DS_Store left out, Thumbs.db kept, as create-torrent does');
  assert.deepEqual(back.fields.trackers, (await readTorrent(theirs)).fields.trackers);
  assert.equal(back.fields.createdBy, 'WebTorrent/0208');
  assert.deepEqual(ours.files.map((f) => f.name), ['one.flac', 'two.flac', 'Thumbs.db'], 'and the files to seed, in the torrent\'s order');

  // Every option, written where it goes.
  const full = await createTorrent(picked(), {
    name: 'Renamed', exclude: '*.db', trackers: [['https://tracker.passthepopcorn.me/k/announce'], ['udp://b.example:80']], webSeeds: ['https://w.example/'],
    private: true, source: 'PTP', comment: 'made here', createdBy: '', creationDate: null, entropy: 'ab12', pieceMode: 'mkbrr', hash,
  });
  const fb = await readTorrent(full.bytes);
  assert.equal(fb.fields.name, 'Renamed');
  assert.deepEqual(fb.fields.files.map((f) => f.path), ['cd1/one.flac', 'two.flac'], 'an exclusion leaves its files out');
  assert.equal(fb.fields.private, true);
  assert.equal(fb.fields.source, 'PTP');
  assert.equal(fb.fields.entropy, 'ab12');
  assert.equal(fb.fields.comment, 'made here');
  assert.equal(fb.fields.createdBy, '');
  assert.equal(fb.fields.creationDate, null, 'no date when asked for none');
  assert.deepEqual(fb.fields.trackers, [['https://tracker.passthepopcorn.me/k/announce'], ['udp://b.example:80']]);
  assert.deepEqual(fb.fields.webSeeds, ['https://w.example/']);
  assert.equal(fb.fields.pieceLength, 64 * 1024, 'PTP\'s own table for 50 KB');
  await assert.rejects(createTorrent([file(body(5, 1), 'x/.DS_Store')], { hash }), /nothing to make a torrent of/);
  assert.equal(excludeTest('*.nfo, Thumbs.db')('Movie.NFO'), true);
  assert.equal(excludeTest('*.nfo, Thumbs.db')('movie.mkv'), false);
  assert.equal(excludeTest('')('anything'), false);
  log('making a torrent: the info hash WebTorrent makes of the same files, and every option where it goes');
}

/* ---------- the Seed & share tab's options ---------- */
{
  assert.equal(createSummary({}), 'Auto pieces · public · app trackers', 'folded, the defaults in one line');
  assert.equal(createSummary({ pieceMode: 'fixed', pieceSize: 2 ** 20, private: true, trackers: 'udp://a\n\nudp://b', source: 'X', onlyTorrent: true }), '1 MiB pieces · private · 2 trackers · source X · .torrent only');
  const defaults = creationOptions({}, { appTrackers: ['wss://one', 'wss://two'], createdBy: 'WebTorrent/0208', now: 1700000000000 });
  assert.deepEqual(defaults, {
    trackers: [['wss://one'], ['wss://two']], webSeeds: [], private: false, source: '', comment: '', createdBy: 'WebTorrent/0208',
    creationDate: 1700000000, pieceMode: 'auto', pieceLength: 0, targetCount: 1000, maxPiece: 0, exclude: '',
  }, 'left alone: the app\'s trackers, a tier each, as sharing always wrote them');
  const ruled = creationOptions({ trackers: 'https://tracker.passthepopcorn.me/k/announce', noDate: true, noCreatedBy: true }, { createdBy: 'x' });
  assert.equal(ruled.source, 'PTP', 'the tracker\'s rule gives the source it expects');
  assert.equal(ruled.creationDate, null);
  assert.equal(ruled.createdBy, '');
  assert.equal(creationOptions({ trackers: 'https://tracker.passthepopcorn.me/k/announce', source: 'mine' }).source, 'mine', 'unless one is set');
  assert.deepEqual(normalizeCreate({ pieceMode: 'nonsense', pieceSize: 3, targetCount: -5 }), { ...normalizeCreate({}), targetCount: 1 });
  log('Seed & share options: one line for the defaults, the app\'s trackers when none are written, the rule\'s source');
}

console.log('\nAll .torrent workshop checks passed.');
