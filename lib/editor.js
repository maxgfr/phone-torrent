/* The .torrent editor: one dialog, one form, for every way a torrent arrives in it.
 *
 * A .torrent opens in full: trackers, web seeds and details, which leave the torrent what it is, and
 * its identity (name, private flag, source, entropy), which makes another one — said as it happens,
 * with the info hash worked out again on every change. A magnet opens with the three things a magnet
 * has (name, trackers, web seeds) until its metadata is fetched. Several .torrent files open together,
 * each field then kept, set, cleared (or added to) in all of them, and saved as one .zip.
 *
 * It takes what it needs from the app (saving, toasts, the clipboard, the metadata caches, the
 * presets) and holds no state of the app's own. Its menu also checks files against the torrent open:
 * every piece hashed again, off the page, and compared.
 */
import { infoHashOf } from './bencode.js';
import { hashPieces } from './torrent-hash.js';
import { checkTorrent, describeCheck, describeWrongSize, isAllGood } from './torrent-check.js';
import {
  readTorrent, applyEdits, applyBatch, identityChanges, parseTiers, formatTiers, parseLines, parseMagnet, toMagnet,
  randomEntropy, ruleFor, describeRule, ruleProblems, formatSize,
} from './torrent-meta.js';

const FILES_SHOWN = 100;

/** A file name any device will take: no path separators or characters Windows refuses. */
export function torrentFileName(name) {
  const clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 200);
  return `${clean || 'torrent'}.torrent`;
}

/** Names for a .zip's entries: the same name twice gets " (2)" before its extension. */
function uniqueNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : name.replace(/(\.torrent)?$/, ` (${n})$1`);
  });
}

export function createEditor({
  saver, toast, copyText, fetchMetadata, publicTrackers, makeZip, getPresets = () => [], isShared = () => false,
}) {
  const dialog = document.getElementById('editor-dialog');
  const $ = (id) => document.getElementById(id);
  const el = {
    title: $('editor-title'),
    hash: $('editor-hash'),
    newPill: $('editor-new'),
    note: $('editor-note'),
    chips: $('editor-chips'),
    magnetSection: $('ed-magnet'),
    dn: $('ed-dn'),
    getMetadata: $('ed-get-metadata'),
    metadataState: $('ed-metadata-state'),
    trackers: $('ed-trackers'),
    addPublic: $('ed-add-public'),
    preset: $('ed-preset'),
    clearTrackers: $('ed-clear-trackers'),
    ruleLine: $('ed-rule-line'),
    rule: $('ed-rule'),
    ruleSource: $('ed-rule-source'),
    webSeeds: $('ed-webseeds'),
    details: $('ed-details'),
    comment: $('ed-comment'),
    createdBy: $('ed-created-by'),
    date: $('ed-date'),
    identity: $('ed-identity'),
    identityBanner: $('ed-identity-banner'),
    identityLocked: $('ed-identity-locked'),
    name: $('ed-name'),
    private: $('ed-private'),
    privateWarning: $('ed-private-warning'),
    source: $('ed-source'),
    entropy: $('ed-entropy'),
    regenerate: $('ed-regenerate'),
    inspector: $('ed-inspector'),
    inspect: $('ed-inspect'),
    files: $('ed-files'),
    problems: $('ed-problems'),
    save: $('ed-save'),
    copyMagnet: $('ed-copy-magnet'),
    share: $('ed-share'),
    menu: $('ed-menu'),
    reset: $('ed-reset'),
    close: $('ed-close'),
    checkOpen: $('ed-check-open'),
    check: $('ed-check'),
    checkFiles: $('ed-check-files'),
    checkFolder: $('ed-check-folder'),
    checkFolderBtn: $('ed-check-folder-btn'),
    checkProgress: $('ed-check-progress'),
    checkState: $('ed-check-state'),
    checkResult: $('ed-check-result'),
    checkSummary: $('ed-check-summary'),
    checkCounts: $('ed-check-counts'),
    checkProblems: $('ed-check-problems'),
    checkStop: $('ed-check-stop'),
    checkBack: $('ed-check-back'),
  };
  // A phone that cannot pick a folder (an iPhone) is offered files alone.
  el.checkFolderBtn.hidden = !('webkitdirectory' in el.checkFolder);
  const ops = [...dialog.querySelectorAll('.ed-op')];
  const opFor = (field) => ops.find((o) => o.dataset.field === field);
  /** The input each Keep / Set / Clear stands for, in a batch. */
  const opTargets = {
    trackers: [el.trackers, el.clearTrackers, el.addPublic],
    webSeeds: [el.webSeeds],
    comment: [el.comment],
    createdBy: [el.createdBy],
    source: [el.source],
    private: [el.private],
  };
  const canShare = typeof navigator.share === 'function';

  /**
   * What is open: { mode: 'torrent', model, live }, { mode: 'magnet', magnet } or { mode: 'batch',
   * items: [{ name, model }] }, plus what the form makes of it now — `bytes` and `hash`, or a batch's
   * `results` — once update() has run.
   */
  let state = null;
  let updating = 0;
  let timer = null;
  /** The check running, to stop it: an AbortController. */
  let checking = null;

  const show = () => {
    if (!dialog.open) dialog.showModal();
    el.menu.open = false;
  };

  /**
   * The form as typed, nothing trimmed. A field that still shows what it was filled with stands for
   * the torrent's own value, byte for byte: a text field drops a line break and a text area rewrites
   * one, and a name ending in a space, trimmed, read as a change — and as a new torrent.
   */
  function readForm() {
    const untouched = state?.mode === 'torrent' && state.filled;
    const value = (key) => (untouched && el[key].value === state.filled[key] ? state.model.fields[key] : el[key].value);
    return {
      trackers: parseTiers(el.trackers.value),
      webSeeds: parseLines(el.webSeeds.value),
      comment: value('comment'),
      createdBy: value('createdBy'),
      creationDate: el.date.value,
      name: value('name'),
      private: el.private.checked,
      source: value('source'),
      entropy: value('entropy'),
    };
  }

  /** A batch's form: each field with what to do with it in every file. */
  function readBatch() {
    const form = readForm();
    const fields = {};
    for (const o of ops) fields[o.dataset.field] = { op: o.value, value: form[o.dataset.field] };
    fields.creationDate = form.creationDate === 'keep' ? { op: 'keep' } : form.creationDate === 'now' ? { op: 'set', value: 'now' } : { op: 'clear' };
    return fields;
  }

  function dateLabel(seconds) {
    return seconds ? new Date(seconds * 1000).toLocaleString() : 'none';
  }

  function fillTorrent() {
    const { model } = state;
    const f = model.fields;
    el.trackers.value = formatTiers(f.trackers);
    el.webSeeds.value = f.webSeeds.join('\n');
    el.comment.value = f.comment;
    el.createdBy.value = f.createdBy;
    el.date.options[0].textContent = `Keep (${dateLabel(f.creationDate)})`;
    el.date.value = 'keep';
    el.name.value = f.name;
    el.private.checked = f.private;
    el.source.value = f.source;
    el.entropy.value = f.entropy;
    state.filled = Object.fromEntries(['comment', 'createdBy', 'name', 'source', 'entropy'].map((k) => [k, el[k].value]));
    for (const input of [el.name, el.private, el.source, el.entropy, el.regenerate]) input.disabled = model.identityLocked;
    el.identityLocked.hidden = !model.identityLocked;
    el.identityLocked.textContent = model.identityLocked
      ? 'This is a BitTorrent v2 or hybrid torrent: it also hashes its files with SHA-256, which this editor does not compute, so what is inside its info stays as it is. Its trackers, web seeds and details can still change.'
      : '';
    fillInspector(model);
  }

  function fillMagnet() {
    const { magnet } = state;
    el.dn.value = magnet.name;
    el.trackers.value = magnet.trackers.join('\n');
    el.webSeeds.value = magnet.webSeeds.join('\n');
    el.metadataState.textContent = '';
    el.getMetadata.disabled = false;
  }

  /** A batch starts from nothing: every field kept, and empty until it is set. */
  function fillBatch() {
    for (const input of [el.trackers, el.webSeeds, el.comment, el.createdBy, el.source]) input.value = '';
    el.private.checked = false;
    el.date.options[0].textContent = 'Keep';
    el.date.value = 'keep';
    for (const o of ops) o.value = 'keep';
    for (const input of [el.private, el.source]) input.disabled = false;
    el.identityLocked.hidden = !state.items.some((i) => i.model.identityLocked);
    el.identityLocked.textContent = 'BitTorrent v2 and hybrid torrents among these keep their source and private flag: what is inside their info is not rehashed here.';
    applyOps();
  }

  /** In a batch, a field kept or cleared is not typed in. */
  function applyOps() {
    const batch = state?.mode === 'batch';
    // Out of a batch every field is typed in, except the identity of a torrent that keeps its own.
    const locked = state?.mode === 'torrent' && state.model.identityLocked;
    for (const o of ops) {
      o.hidden = !batch;
      for (const target of opTargets[o.dataset.field] || []) {
        target.disabled = batch ? o.value === 'keep' || o.value === 'clear' : locked && (target === el.source || target === el.private);
      }
    }
  }

  function fillInspector(model) {
    const f = model.fields;
    const rows = [
      ['Info hash', model.infoHash, 'The SHA-1 of the info dictionary: what identifies this torrent to every peer.'],
      ['Pieces', `${f.pieceCount.toLocaleString()} × ${formatSize(f.pieceLength)}${f.pieceCount > 1 ? ` (last: ${formatSize(f.lastPieceLength)})` : ''}`, 'The content is cut into pieces of this size, each checked against its own hash.'],
      ['Total size', `${formatSize(f.totalLength)} (${f.totalLength.toLocaleString()} bytes)`, 'The size of every file together.'],
      ['Files', String(f.files.length), 'How many files the torrent holds.'],
      ['.torrent size', formatSize(model.bytes.length), 'The size of this .torrent file itself: mostly the piece hashes.'],
      ['Version', f.metaVersion >= 2 ? (f.pieceCount ? 'hybrid (v1 + v2)' : 'v2') : 'v1', 'BitTorrent v2 hashes each file with SHA-256; a hybrid torrent carries both kinds.'],
    ];
    const unknown = [
      ...model.unknownKeys.root,
      ...model.unknownKeys.info.map((k) => `info.${k}`),
    ];
    if (unknown.length) rows.push(['Other keys', unknown.join(', '), 'Keys this editor does not know. They are kept exactly as they are.']);
    el.inspect.replaceChildren(...rows.flatMap(([k, v, tip]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      dt.title = tip;
      const dd = document.createElement('dd');
      dd.textContent = v;
      if (k === 'Info hash' || k === 'Other keys') dd.classList.add('mono');
      if (k === 'Info hash') el.inspectHash = dd;
      return [dt, dd];
    }));
    const items = f.files.slice(0, FILES_SHOWN).map((file) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = file.path;
      const size = document.createElement('span');
      size.className = 'file-size';
      size.textContent = formatSize(file.length);
      li.append(name, size);
      return li;
    });
    if (f.files.length > FILES_SHOWN) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = `…and ${(f.files.length - FILES_SHOWN).toLocaleString()} more`;
      items.push(li);
    }
    el.files.replaceChildren(...items);
  }

  function fillPresets() {
    const presets = getPresets();
    el.preset.hidden = presets.length === 0;
    el.preset.replaceChildren(new Option('Apply preset…', ''), ...presets.map((p) => new Option(p.name, p.id)));
  }

  function setMode(mode) {
    dialog.dataset.mode = mode;
    const magnet = mode === 'magnet';
    const batch = mode === 'batch';
    el.magnetSection.hidden = !magnet;
    el.details.hidden = magnet;
    el.identity.hidden = magnet;
    el.inspector.hidden = magnet || batch;
    el.chips.hidden = !batch;
    el.hash.parentElement.hidden = batch;
    el.copyMagnet.hidden = batch;
    el.share.hidden = batch || !canShare;
    for (const single of dialog.querySelectorAll('[data-single]')) single.hidden = batch;
    el.save.disabled = magnet;
    el.save.textContent = batch ? `Save ${state.items.length} .torrent (zip)` : 'Save .torrent';
    el.note.hidden = !(magnet || batch);
    el.note.textContent = magnet
      ? 'A magnet carries only a name, trackers and web seeds. Get the metadata to edit the rest, or to save a .torrent.'
      : batch ? 'Each field is kept in every file until you set, add to or clear it.' : '';
    el.privateWarning.hidden = true;
    el.identityBanner.hidden = true;
    el.checkOpen.hidden = mode !== 'torrent';
    el.check.hidden = true;
    // What the torrent open before set (a private one's refusals) goes with it.
    el.copyMagnet.disabled = false;
    el.copyMagnet.title = '';
    el.share.disabled = false;
    applyOps();
    fillPresets();
  }

  /* ---------- checking files ---------- */

  function enterCheck() {
    el.menu.open = false;
    if (state?.mode !== 'torrent') return;
    dialog.dataset.mode = 'check';
    el.check.hidden = false;
    el.checkResult.hidden = true;
    el.checkProgress.hidden = true;
    el.checkState.textContent = `${state.model.fields.files.length} file${state.model.fields.files.length === 1 ? '' : 's'}, ${formatSize(state.model.fields.totalLength)}, ${state.model.fields.pieceCount.toLocaleString()} pieces to check.`;
  }

  function leaveCheck() {
    checking?.abort();
    dialog.dataset.mode = 'torrent';
    el.check.hidden = true;
  }

  async function runCheck(picked) {
    if (!picked.length || state?.mode !== 'torrent') return;
    checking?.abort();
    const run = new AbortController();
    checking = run;
    const bar = el.checkProgress.firstElementChild;
    el.checkResult.hidden = true;
    el.checkProgress.hidden = false;
    el.checkStop.hidden = false;
    bar.style.width = '0%';
    el.checkState.textContent = 'Hashing…';
    try {
      const report = await checkTorrent(state.model, picked, {
        hash: hashPieces,
        signal: run.signal,
        onProgress: (done, total) => {
          const pct = total ? Math.floor((done / total) * 100) : 100;
          bar.style.width = `${pct}%`;
          el.checkProgress.setAttribute('aria-valuenow', String(pct));
          el.checkState.textContent = `Hashing… ${pct}% of ${formatSize(total)}`;
        },
      });
      if (checking !== run) return;
      showReport(report);
    } catch (err) {
      if (checking !== run) return;
      el.checkState.textContent = err?.name === 'AbortError' ? 'Stopped.' : `Could not check: ${err.message}`;
    } finally {
      if (checking === run) {
        checking = null;
        el.checkStop.hidden = true;
        el.checkProgress.hidden = true;
      }
    }
  }

  function showReport(r) {
    el.checkState.textContent = '';
    el.checkResult.hidden = false;
    el.checkResult.classList.toggle('all-good', isAllGood(r));
    el.checkSummary.textContent = describeCheck(r);
    el.checkCounts.replaceChildren(...[['Good pieces', r.good], ['Bad pieces', r.bad], ['Missing pieces', r.missing]].flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v.toLocaleString();
      return [dt, dd];
    }));
    const lines = [
      ...r.missingFiles.map((p) => `Not found: ${p}`),
      ...r.wrongSizes.map((w) => `Wrong size: ${describeWrongSize(w)}`),
    ];
    el.checkProblems.replaceChildren(...lines.slice(0, FILES_SHOWN).map((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      return li;
    }));
    if (lines.length > FILES_SHOWN) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = `…and ${(lines.length - FILES_SHOWN).toLocaleString()} more`;
      el.checkProblems.append(li);
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(update, 120);
  }

  function problem(lines) {
    el.problems.hidden = lines.length === 0;
    el.problems.replaceChildren(...lines.map((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      return p;
    }));
  }

  function showRule(rule, source) {
    el.ruleLine.hidden = !rule;
    el.rule.textContent = rule ? `Tracker rules — ${describeRule(rule)}` : '';
    // The source a tracker expects, one tap away: never set by itself, as it makes a new torrent.
    const offer = Boolean(rule?.source) && state.mode !== 'magnet' && source !== rule.source
      && !(state.mode === 'torrent' && state.model.identityLocked);
    el.ruleSource.hidden = !offer;
    if (offer) el.ruleSource.textContent = `Set source ${rule.source}`;
  }

  /** The form, made into a torrent (or a magnet, or a batch) again, and what changed said where it shows. */
  async function update() {
    if (!state) return;
    const run = ++updating;
    const form = readForm();
    const rule = ruleFor(form.trackers[0]?.[0] || '');
    showRule(rule, form.source);
    const privateNow = state.mode === 'torrent' ? form.private : state.mode === 'batch' && opFor('private').value === 'set' && form.private;
    el.addPublic.disabled = privateNow || (state.mode === 'batch' && ['keep', 'clear'].includes(opFor('trackers').value));
    el.addPublic.title = privateNow ? 'A private torrent may only be announced to its own tracker.' : '';

    if (state.mode === 'magnet') {
      state.hash = state.magnet.infoHash;
      el.title.textContent = el.dn.value.trim() || state.magnet.infoHash;
      el.hash.textContent = state.hash;
      el.newPill.hidden = true;
      problem([]);
      return;
    }
    if (state.mode === 'batch') return updateBatch(run);

    const { model } = state;
    const lines = [];
    let bytes = null;
    let hash = model.infoHash;
    const changed = identityChanges(model, form);
    try {
      bytes = applyEdits(model, form);
      if (changed.length) hash = await infoHashOf(bytes);
    } catch (err) {
      lines.push(err.message);
    }
    if (run !== updating) return;
    state.bytes = bytes;
    state.hash = hash;
    el.title.textContent = form.name || model.fields.name || model.infoHash;
    el.hash.textContent = hash;
    if (el.inspectHash) el.inspectHash.textContent = hash;
    const isNew = hash !== model.infoHash;
    el.newPill.hidden = !isNew;
    el.identityBanner.hidden = !isNew;
    if (isNew) el.identity.open = true;
    const sharedNowPrivate = form.private && !model.fields.private && isShared(model.infoHash);
    el.privateWarning.hidden = !sharedNowPrivate;
    if (bytes) lines.push(...ruleProblems(rule, { torrentSize: bytes.length, pieceLength: model.fields.pieceLength }));
    problem(lines);
    el.save.disabled = !bytes;
    el.copyMagnet.disabled = form.private;
    el.copyMagnet.title = form.private ? 'A private torrent\'s magnet would be announced to public trackers: save the .torrent instead.' : '';
    el.share.disabled = !bytes;
  }

  async function updateBatch(run) {
    const lines = [];
    let results = null;
    try {
      results = applyBatch(state.items.map((i) => i.model), readBatch());
    } catch (err) {
      lines.push(err.message);
    }
    if (run !== updating) return;
    state.results = results;
    const n = state.items.length;
    el.title.textContent = `${n} .torrent files`;
    el.newPill.hidden = true;
    const anyNew = Boolean(results?.some((r) => r.newHash));
    el.identityBanner.hidden = !anyNew;
    if (anyNew) el.identity.open = true;
    el.chips.replaceChildren(...state.items.map((item, i) => {
      const li = document.createElement('li');
      const isNew = Boolean(results?.[i].newHash);
      li.className = `chip${isNew ? ' new' : ''}`;
      const name = document.createElement('span');
      name.className = 'chip-name';
      name.textContent = item.model.fields.name || item.name;
      const tag = document.createElement('span');
      tag.className = 'chip-state';
      tag.textContent = isNew ? 'new hash' : 'hash unchanged';
      li.append(name, tag);
      return li;
    }));
    // Each file against the rule of its own first tracker, as it will be saved.
    for (const [i, r] of (results || []).entries()) {
      const fileRule = ruleFor((r.edits.trackers ?? r.model.fields.trackers)[0]?.[0] || '');
      for (const line of ruleProblems(fileRule, { torrentSize: r.bytes.length, pieceLength: r.model.fields.pieceLength })) lines.push(`${state.items[i].name}: ${line}`);
    }
    problem(lines);
    el.save.disabled = !results;
  }

  function currentMagnet() {
    const form = readForm();
    if (state.mode === 'magnet') {
      return toMagnet({ ...state.magnet, name: el.dn.value.trim(), trackers: form.trackers, webSeeds: form.webSeeds });
    }
    return toMagnet({ infoHash: state.hash, name: form.name, trackers: form.trackers, webSeeds: form.webSeeds });
  }

  function currentFile() {
    return { name: torrentFileName(readForm().name || state.hash), bytes: state.bytes };
  }

  async function openTorrent(bytes, { live = false } = {}) {
    const model = await readTorrent(bytes);
    state = { mode: 'torrent', model, live };
    setMode('torrent');
    fillTorrent();
    el.identity.open = false;
    el.inspector.open = false;
    await update();
    show();
    return model;
  }

  async function openMagnet(uri) {
    state = { mode: 'magnet', magnet: parseMagnet(uri) };
    setMode('magnet');
    fillMagnet();
    await update();
    show();
  }

  /** Several .torrent files, `[{ name, bytes }]`: the ones that read as one are opened together. */
  async function openBatch(files) {
    const items = [];
    for (const f of files) {
      try {
        items.push({ name: f.name, model: await readTorrent(f.bytes) });
      } catch (err) {
        toast(`Could not read ${f.name}: ${err.message}`, { error: true });
      }
    }
    if (items.length === 0) return;
    if (items.length === 1) {
      await openTorrent(items[0].model.bytes);
      return;
    }
    state = { mode: 'batch', items };
    setMode('batch');
    fillBatch();
    el.identity.open = false;
    await update();
    show();
  }

  async function getMetadata() {
    if (state?.mode !== 'magnet') return;
    const { magnet } = state;
    // What was typed for the magnet goes on with it: its name is only a label, its trackers and web
    // seeds are added to the ones the .torrent has.
    const form = readForm();
    el.getMetadata.disabled = true;
    el.metadataState.textContent = 'Looking for the metadata…';
    let bytes = null;
    try {
      bytes = await fetchMetadata(magnet.infoHash);
    } catch { /* said below */ }
    // Closed, or another torrent opened, while it was on the way: it is not wanted any more.
    if (state?.magnet !== magnet || !dialog.open) return;
    if (!bytes) {
      el.getMetadata.disabled = false;
      el.metadataState.textContent = 'No metadata found: no torrent in the list has it, and the torrent caches set in Settings do not either.';
      return;
    }
    const model = await openTorrent(bytes);
    const have = new Set(model.fields.trackers.flat());
    const extra = form.trackers.flat().filter((t) => !have.has(t));
    if (extra.length) el.trackers.value = formatTiers([...model.fields.trackers, ...extra.map((t) => [t])]);
    const seeds = [...new Set([...model.fields.webSeeds, ...form.webSeeds])];
    el.webSeeds.value = seeds.join('\n');
    await update();
    toast('Metadata found: everything can be edited now.');
  }

  async function addPublicTrackers() {
    el.addPublic.disabled = true;
    const was = el.addPublic.textContent;
    el.addPublic.textContent = 'Fetching…';
    try {
      const list = await publicTrackers();
      const tiers = parseTiers(el.trackers.value);
      const have = new Set(tiers.flat());
      const fresh = list.filter((t) => !have.has(t));
      el.trackers.value = formatTiers([...tiers, ...fresh.map((t) => [t])]);
      toast(fresh.length ? `Added ${fresh.length} public tracker${fresh.length === 1 ? '' : 's'}.` : 'Every public tracker found is in the list already.');
    } catch (err) {
      toast(`Could not get the public trackers: ${err.message}`, { error: true });
    } finally {
      el.addPublic.textContent = was;
      await update();
    }
  }

  /**
   * A preset fills in what it has: its trackers and web seeds replace the ones there, its comment and
   * source are set, and private is turned on when it says so. In a batch, those fields become "Set".
   */
  function applyPreset(id) {
    const p = getPresets().find((x) => x.id === id);
    if (!p || !state) return;
    const set = (field) => { if (state.mode === 'batch' && opFor(field)) opFor(field).value = 'set'; };
    if (p.trackers.length) {
      el.trackers.value = formatTiers(p.trackers);
      set('trackers');
    }
    if (p.webSeeds.length) {
      el.webSeeds.value = p.webSeeds.join('\n');
      set('webSeeds');
    }
    if (state.mode !== 'magnet') {
      if (p.comment) {
        el.comment.value = p.comment;
        set('comment');
      }
      const locked = state.mode === 'torrent' && state.model.identityLocked;
      if (p.source && !locked) {
        el.source.value = p.source;
        set('source');
      }
      if (p.private && !locked) {
        el.private.checked = true;
        set('private');
      }
    }
    applyOps();
    update();
    toast(`Preset "${p.name}" applied.`);
  }

  async function save() {
    clearTimeout(timer);
    await update();
    if (state?.mode === 'batch') return saveBatch();
    if (!state?.bytes) return;
    const { name, bytes } = currentFile();
    try {
      await saver.save({ name, size: bytes.length, stream: () => new Blob([bytes]).stream() });
      toast(`Saved ${name}`);
    } catch (err) {
      toast(`Could not save ${name}: ${err.message}`, { error: true });
    }
  }

  async function saveBatch() {
    const { results } = state;
    if (!results) return;
    const names = uniqueNames(results.map((r, i) => torrentFileName(r.edits.name || r.model.fields.name || state.items[i].name.replace(/\.torrent$/i, ''))));
    const now = new Date();
    const entries = results.map((r, i) => ({ name: names[i], lastModified: now, input: r.bytes }));
    const name = 'edited torrents.zip';
    try {
      const blob = await new Response(makeZip(entries)).blob();
      await saver.save({ name, size: blob.size, stream: () => blob.stream() });
      toast(`Saved ${name}: ${results.length} .torrent files`);
    } catch (err) {
      toast(`Could not save ${name}: ${err.message}`, { error: true });
    }
  }

  async function copyMagnet() {
    clearTimeout(timer);
    await update();
    const ok = await copyText(currentMagnet());
    const was = el.copyMagnet.textContent;
    el.copyMagnet.textContent = ok ? 'Copied' : 'Could not copy';
    setTimeout(() => { el.copyMagnet.textContent = was; }, 1400);
  }

  /** The .torrent itself where this device can share a file, or else its magnet. */
  async function share() {
    clearTimeout(timer);
    await update();
    const form = readForm();
    try {
      if (state.bytes) {
        const { name, bytes } = currentFile();
        const file = new File([bytes], name, { type: 'application/x-bittorrent' });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: form.name });
          return;
        }
      }
      if (state.mode === 'torrent' && form.private) {
        toast('This browser cannot share a file from here, and a private torrent\'s magnet is not for sharing: save the .torrent instead.', { error: true, timeout: 7000 });
        return;
      }
      await navigator.share({ title: form.name || el.dn.value.trim() || 'Torrent', text: currentMagnet() });
    } catch (err) {
      if (err?.name !== 'AbortError') toast(`Could not share: ${err.message}`, { error: true });
    }
  }

  dialog.addEventListener('input', schedule);
  dialog.addEventListener('change', (e) => {
    if (e.target.classList.contains('ed-op')) applyOps();
    schedule();
  });
  el.getMetadata.addEventListener('click', getMetadata);
  el.addPublic.addEventListener('click', addPublicTrackers);
  el.preset.addEventListener('change', () => {
    const id = el.preset.value;
    el.preset.value = '';
    applyPreset(id);
  });
  el.ruleSource.addEventListener('click', () => {
    const rule = ruleFor(parseTiers(el.trackers.value)[0]?.[0] || '');
    if (!rule?.source) return;
    el.source.value = rule.source;
    if (state?.mode === 'batch') opFor('source').value = 'set';
    applyOps();
    el.identity.open = true;
    update();
  });
  el.clearTrackers.addEventListener('click', () => {
    el.trackers.value = '';
    update();
  });
  el.regenerate.addEventListener('click', () => {
    el.entropy.value = randomEntropy();
    update();
  });
  el.save.addEventListener('click', save);
  el.copyMagnet.addEventListener('click', copyMagnet);
  el.share.hidden = !canShare;
  el.share.addEventListener('click', share);
  el.reset.addEventListener('click', () => {
    el.menu.open = false;
    if (state?.mode === 'torrent') fillTorrent();
    else if (state?.mode === 'magnet') fillMagnet();
    else if (state?.mode === 'batch') fillBatch();
    update();
  });
  el.checkOpen.addEventListener('click', enterCheck);
  el.checkBack.addEventListener('click', leaveCheck);
  el.checkStop.addEventListener('click', () => checking?.abort());
  for (const input of [el.checkFiles, el.checkFolder]) {
    input.addEventListener('change', () => {
      const picked = Array.from(input.files || []);
      input.value = '';
      runCheck(picked);
    });
  }
  el.close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    clearTimeout(timer);
    checking?.abort();
    el.menu.open = false;
  });

  return {
    openTorrent,
    openMagnet,
    openBatch,
    get state() { return state; },
    update,
  };
}
