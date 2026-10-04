/* How the Seed & share tab makes its torrents: the piece size, the trackers written in the file, the
 * private flag, source, comment, web seeds, what to leave out, and whether to share it at all. Folded
 * into one line by default — left as they are, a torrent is made exactly as it always was — and kept
 * in the settings once changed.
 */
import { parseTiers, parseLines, ruleFor, describeRule, formatSize } from './torrent-meta.js';
import { PIECE_LIMITS } from './presets.js';

export const PIECE_SIZES = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26].map((e) => 2 ** e);

export const DEFAULT_CREATE = {
  trackers: '',
  pieceMode: 'auto',
  pieceSize: 0,
  targetCount: 1000,
  maxPiece: 0,
  private: false,
  source: '',
  comment: '',
  webSeeds: '',
  noDate: false,
  noCreatedBy: false,
  exclude: '',
  onlyTorrent: false,
};

export function normalizeCreate(o = {}) {
  const v = { ...DEFAULT_CREATE, ...(o && typeof o === 'object' ? o : {}) };
  return {
    trackers: String(v.trackers || ''),
    pieceMode: ['auto', 'mkbrr', 'target', 'fixed'].includes(v.pieceMode) ? v.pieceMode : 'auto',
    pieceSize: PIECE_SIZES.includes(Number(v.pieceSize)) ? Number(v.pieceSize) : 0,
    targetCount: Math.max(1, Math.round(Number(v.targetCount) || DEFAULT_CREATE.targetCount)),
    maxPiece: PIECE_LIMITS.includes(Number(v.maxPiece)) ? Number(v.maxPiece) : 0,
    private: Boolean(v.private),
    source: String(v.source || '').trim(),
    comment: String(v.comment || ''),
    webSeeds: String(v.webSeeds || ''),
    noDate: Boolean(v.noDate),
    noCreatedBy: Boolean(v.noCreatedBy),
    exclude: String(v.exclude || ''),
    onlyTorrent: Boolean(v.onlyTorrent),
  };
}

/** "Auto pieces · public · app trackers", and what else differs from the defaults. */
export function createSummary(o) {
  const v = normalizeCreate(o);
  const pieces = v.pieceMode === 'fixed' && v.pieceSize ? `${formatSize(v.pieceSize)} pieces`
    : v.pieceMode === 'target' ? `~${v.targetCount.toLocaleString()} pieces`
      : v.pieceMode === 'mkbrr' ? 'mkbrr pieces' : 'Auto pieces';
  const n = parseTiers(v.trackers).flat().length;
  return [
    `${pieces}${v.maxPiece ? ` ≤ ${formatSize(v.maxPiece)}` : ''}`,
    v.private ? 'private' : 'public',
    n ? `${n} tracker${n === 1 ? '' : 's'}` : 'app trackers',
    v.source && `source ${v.source}`,
    parseLines(v.webSeeds).length && 'web seeds',
    v.onlyTorrent && '.torrent only',
  ].filter(Boolean).join(' · ');
}

/**
 * What createTorrent is given for these options. `appTrackers` stand in when none are written; a
 * tracker's rule gives the source it expects when none is set, as mkbrr does.
 */
export function creationOptions(o, { appTrackers = [], createdBy = '', now = Date.now() } = {}) {
  const v = normalizeCreate(o);
  const own = parseTiers(v.trackers);
  const trackers = own.length ? own : appTrackers.map((t) => [t]);
  const rule = ruleFor(trackers[0]?.[0] || '');
  return {
    trackers,
    webSeeds: parseLines(v.webSeeds),
    private: v.private,
    source: v.source || rule?.source || '',
    comment: v.comment.trim(),
    createdBy: v.noCreatedBy ? '' : createdBy,
    creationDate: v.noDate ? null : Math.floor(now / 1000),
    pieceMode: v.pieceMode === 'fixed' ? 'auto' : v.pieceMode,
    pieceLength: v.pieceMode === 'fixed' ? v.pieceSize : 0,
    targetCount: v.targetCount,
    maxPiece: v.maxPiece,
    exclude: v.exclude,
  };
}

/** The folded options in the Seed & share tab. `load` and `save` read and keep them in the settings. */
export function createOptionsUI(root, { load, save, getPresets = () => [] }) {
  const $ = (id) => root.querySelector(`#${id}`);
  const f = {
    details: $('seed-options'),
    summary: $('seed-options-summary'),
    preset: $('so-preset'),
    trackers: $('so-trackers'),
    rule: $('so-rule'),
    pieceMode: $('so-piece'),
    targetField: $('so-target-field'),
    targetCount: $('so-target'),
    maxPiece: $('so-max'),
    private: $('so-private'),
    source: $('so-source'),
    comment: $('so-comment'),
    webSeeds: $('so-webseeds'),
    noDate: $('so-no-date'),
    noCreatedBy: $('so-no-created-by'),
    exclude: $('so-exclude'),
    onlyTorrent: $('so-only'),
    reset: $('so-reset'),
  };
  // One select for the piece size: three rules, or a size of its own.
  f.pieceMode.replaceChildren(
    new Option('Auto', 'auto'),
    new Option('mkbrr\'s table', 'mkbrr'),
    new Option('A number of pieces', 'target'),
    ...PIECE_SIZES.map((s) => new Option(formatSize(s), `fixed:${s}`)),
  );
  f.maxPiece.replaceChildren(...PIECE_LIMITS.map((v) => new Option(v ? formatSize(v) : 'No limit', String(v))));

  function read() {
    const [mode, size] = f.pieceMode.value.split(':');
    return normalizeCreate({
      trackers: f.trackers.value,
      pieceMode: mode,
      pieceSize: Number(size) || 0,
      targetCount: f.targetCount.value,
      maxPiece: f.maxPiece.value,
      private: f.private.checked,
      source: f.source.value,
      comment: f.comment.value,
      webSeeds: f.webSeeds.value,
      noDate: f.noDate.checked,
      noCreatedBy: f.noCreatedBy.checked,
      exclude: f.exclude.value,
      onlyTorrent: f.onlyTorrent.checked,
    });
  }

  function show(v) {
    f.trackers.value = v.trackers;
    f.pieceMode.value = v.pieceMode === 'fixed' && v.pieceSize ? `fixed:${v.pieceSize}` : v.pieceMode === 'fixed' ? 'auto' : v.pieceMode;
    f.targetCount.value = String(v.targetCount);
    f.maxPiece.value = String(v.maxPiece);
    f.private.checked = v.private;
    f.source.value = v.source;
    f.comment.value = v.comment;
    f.webSeeds.value = v.webSeeds;
    f.noDate.checked = v.noDate;
    f.noCreatedBy.checked = v.noCreatedBy;
    f.exclude.value = v.exclude;
    f.onlyTorrent.checked = v.onlyTorrent;
    refresh(v);
  }

  function refresh(v = read()) {
    f.summary.textContent = createSummary(v);
    f.targetField.hidden = v.pieceMode !== 'target';
    const rule = ruleFor(parseTiers(v.trackers)[0]?.[0] || '');
    f.rule.hidden = !rule;
    f.rule.textContent = rule ? `Tracker rules — ${describeRule(rule)}${rule.source && !v.source ? `. Source ${rule.source} is used unless you set one.` : '.'}` : '';
  }

  function fillPresets() {
    const presets = getPresets();
    f.preset.closest('.field').hidden = presets.length === 0;
    f.preset.replaceChildren(new Option('None', ''), ...presets.map((p) => new Option(p.name, p.id)));
  }

  root.addEventListener('input', (e) => {
    if (!f.details.contains(e.target) || e.target === f.preset) return;
    const v = read();
    refresh(v);
    save(v);
  });
  root.addEventListener('change', (e) => {
    if (!f.details.contains(e.target) || e.target === f.preset) return;
    const v = read();
    refresh(v);
    save(v);
  });
  f.preset.addEventListener('change', () => {
    const p = getPresets().find((x) => x.id === f.preset.value);
    f.preset.value = '';
    if (!p) return;
    const v = read();
    const next = normalizeCreate({
      ...v,
      trackers: p.trackers.length ? p.trackers.map((t) => t.join('\n')).join('\n\n') : v.trackers,
      source: p.source || v.source,
      private: p.private || v.private,
      webSeeds: p.webSeeds.length ? p.webSeeds.join('\n') : v.webSeeds,
      comment: p.comment || v.comment,
      maxPiece: p.maxPiece || v.maxPiece,
    });
    show(next);
    save(next);
  });
  f.reset.addEventListener('click', () => {
    const v = normalizeCreate(DEFAULT_CREATE);
    show(v);
    save(v);
  });
  f.details.addEventListener('toggle', () => { if (f.details.open) fillPresets(); });

  show(normalizeCreate(load()));
  fillPresets();
  return {
    get value() { return read(); },
    reload() {
      show(normalizeCreate(load()));
      fillPresets();
    },
  };
}
