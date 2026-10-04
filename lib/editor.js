/* The .torrent editor: one dialog, one form, for every way a torrent arrives in it.
 *
 * A .torrent opens in full: trackers, web seeds and details, which leave the torrent what it is, and
 * its identity (name, private flag, source, entropy), which makes another one — said as it happens,
 * with the info hash worked out again on every change. A magnet opens with the three things a magnet
 * has (name, trackers, web seeds) until its metadata is fetched.
 *
 * It takes what it needs from the app (saving, toasts, the clipboard, the metadata caches) and holds
 * no state of the app's own.
 */
import { infoHashOf } from './bencode.js';
import {
  readTorrent, applyEdits, identityChanges, parseTiers, formatTiers, parseLines, parseMagnet, toMagnet,
  randomEntropy, ruleFor, describeRule, ruleProblems, formatSize,
} from './torrent-meta.js';

const FILES_SHOWN = 100;

/** A file name the phone will take: no path separators or characters Windows refuses. */
export function torrentFileName(name) {
  const clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 200);
  return `${clean || 'torrent'}.torrent`;
}

export function createEditor({
  saver, toast, copyText, fetchMetadata, publicTrackers, isShared = () => false,
}) {
  const dialog = document.getElementById('editor-dialog');
  const $ = (id) => document.getElementById(id);
  const el = {
    title: $('editor-title'),
    hash: $('editor-hash'),
    newPill: $('editor-new'),
    note: $('editor-note'),
    magnetSection: $('ed-magnet'),
    dn: $('ed-dn'),
    getMetadata: $('ed-get-metadata'),
    metadataState: $('ed-metadata-state'),
    trackers: $('ed-trackers'),
    addPublic: $('ed-add-public'),
    clearTrackers: $('ed-clear-trackers'),
    rule: $('ed-rule'),
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
  };

  /**
   * What is open: { mode: 'torrent', model, live } or { mode: 'magnet', magnet }, plus what the form
   * makes of it now — `bytes` and `hash` — once update() has run.
   */
  let state = null;
  let updating = 0;
  let timer = null;

  const show = () => {
    if (!dialog.open) dialog.showModal();
    el.menu.open = false;
  };

  function readForm() {
    return {
      trackers: parseTiers(el.trackers.value),
      webSeeds: parseLines(el.webSeeds.value),
      comment: el.comment.value.trim(),
      createdBy: el.createdBy.value.trim(),
      creationDate: el.date.value,
      name: el.name.value.trim(),
      private: el.private.checked,
      source: el.source.value.trim(),
      entropy: el.entropy.value.trim(),
    };
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
      ...model.unknownKeys.root.map((k) => k),
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

  function setMode(mode) {
    dialog.dataset.mode = mode;
    const magnet = mode === 'magnet';
    el.magnetSection.hidden = !magnet;
    el.details.hidden = magnet;
    el.identity.hidden = magnet;
    el.inspector.hidden = magnet;
    el.save.disabled = magnet;
    el.note.hidden = !magnet;
    el.note.textContent = magnet
      ? 'A magnet carries only a name, trackers and web seeds. Get the metadata to edit the rest, or to save a .torrent.'
      : '';
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

  /** The form, made into a torrent (or a magnet) again, and what changed said where it shows. */
  async function update() {
    if (!state) return;
    const run = ++updating;
    const form = readForm();
    const firstTracker = form.trackers[0]?.[0] || '';
    const rule = ruleFor(firstTracker);
    el.rule.textContent = rule ? `Tracker rules — ${describeRule(rule)}` : '';
    el.rule.hidden = !rule;
    const privateNow = state.mode === 'torrent' ? form.private : false;
    el.addPublic.disabled = privateNow;
    el.addPublic.title = privateNow ? 'A private torrent may only be announced to its own tracker.' : '';

    if (state.mode === 'magnet') {
      state.hash = state.magnet.infoHash;
      el.title.textContent = el.dn.value.trim() || state.magnet.infoHash;
      el.hash.textContent = state.hash;
      el.newPill.hidden = true;
      problem([]);
      return;
    }

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
    if (state?.magnet !== magnet) return;
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

  async function save() {
    await update();
    if (!state?.bytes) return;
    const { name, bytes } = currentFile();
    try {
      await saver.save({ name, size: bytes.length, stream: () => new Blob([bytes]).stream() });
      toast(`Saved ${name}`);
    } catch (err) {
      toast(`Could not save ${name}: ${err.message}`, { error: true });
    }
  }

  async function copyMagnet() {
    await update();
    const ok = await copyText(currentMagnet());
    const was = el.copyMagnet.textContent;
    el.copyMagnet.textContent = ok ? 'Copied' : 'Could not copy';
    setTimeout(() => { el.copyMagnet.textContent = was; }, 1400);
  }

  /** The .torrent itself where the phone can share a file, or else its magnet. */
  async function share() {
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
        toast('This phone cannot share a file from here, and a private torrent\'s magnet is not for sharing: save the .torrent instead.', { error: true, timeout: 7000 });
        return;
      }
      await navigator.share({ title: form.name || el.dn.value.trim() || 'Torrent', text: currentMagnet() });
    } catch (err) {
      if (err?.name !== 'AbortError') toast(`Could not share: ${err.message}`, { error: true });
    }
  }

  dialog.addEventListener('input', schedule);
  dialog.addEventListener('change', schedule);
  el.getMetadata.addEventListener('click', getMetadata);
  el.addPublic.addEventListener('click', addPublicTrackers);
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
  el.share.hidden = typeof navigator.share !== 'function';
  el.share.addEventListener('click', share);
  el.reset.addEventListener('click', () => {
    el.menu.open = false;
    if (state?.mode === 'torrent') fillTorrent();
    else if (state?.mode === 'magnet') fillMagnet();
    update();
  });
  el.close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    clearTimeout(timer);
    el.menu.open = false;
  });

  return {
    openTorrent,
    openMagnet,
    get state() { return state; },
    update,
  };
}
