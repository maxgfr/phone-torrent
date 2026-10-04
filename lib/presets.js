/* Presets: what a tracker wants in every torrent made or edited for it — its announce address, its
 * source, the private flag, web seeds, a comment, the largest piece — kept under a name, and applied
 * in one tap in the editor and when making a torrent. Edited in Settings, saved with the rest of it.
 */
import { parseTiers, formatTiers, parseLines, formatSize } from './torrent-meta.js';

export const PIECE_LIMITS = [0, 2 ** 20, 2 ** 21, 2 ** 22, 2 ** 23, 2 ** 24, 2 ** 25, 2 ** 26];

/** A preset as stored, whatever was stored: every field there, of the right kind. */
export function normalizePreset(p = {}) {
  const tiers = Array.isArray(p.trackers) ? p.trackers.map((t) => (Array.isArray(t) ? t : [t]).map(String).filter(Boolean)).filter((t) => t.length) : [];
  return {
    id: String(p.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`),
    name: String(p.name || '').trim() || 'Preset',
    trackers: tiers,
    source: String(p.source || '').trim(),
    private: Boolean(p.private),
    webSeeds: Array.isArray(p.webSeeds) ? p.webSeeds.map(String).filter(Boolean) : [],
    comment: String(p.comment || ''),
    maxPiece: PIECE_LIMITS.includes(Number(p.maxPiece)) ? Number(p.maxPiece) : 0,
  };
}

export function normalizePresets(list) {
  return Array.isArray(list) ? list.map(normalizePreset) : [];
}

/** "2 trackers · source PTP · private · pieces ≤ 16 MiB" */
export function presetSummary(p) {
  const n = p.trackers.flat().length;
  return [
    n ? `${n} tracker${n === 1 ? '' : 's'}` : 'no trackers',
    p.source && `source ${p.source}`,
    p.private && 'private',
    p.webSeeds.length && `${p.webSeeds.length} web seed${p.webSeeds.length === 1 ? '' : 's'}`,
    p.comment && 'a comment',
    p.maxPiece && `pieces ≤ ${formatSize(p.maxPiece)}`,
  ].filter(Boolean).join(' · ');
}

/** The list in Settings, and the form that adds or changes one. Works on a draft until Save. */
export function createPresetsUI(root) {
  const $ = (sel) => root.querySelector(sel);
  const list = $('#preset-list');
  const form = $('#preset-form');
  const fields = {
    name: $('#preset-name'),
    trackers: $('#preset-trackers'),
    source: $('#preset-source'),
    private: $('#preset-private'),
    webSeeds: $('#preset-webseeds'),
    comment: $('#preset-comment'),
    maxPiece: $('#preset-maxpiece'),
  };
  fields.maxPiece.replaceChildren(...PIECE_LIMITS.map((v) => new Option(v ? formatSize(v) : 'No limit', String(v))));
  let draft = [];
  let editing = null;

  function render() {
    list.replaceChildren(...draft.map((p) => {
      const li = document.createElement('li');
      li.className = 'preset-item';
      const about = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'preset-name';
      name.textContent = p.name;
      const summary = document.createElement('div');
      summary.className = 'hint';
      summary.textContent = presetSummary(p);
      about.append(name, summary);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn small';
      edit.textContent = 'Edit';
      edit.setAttribute('aria-label', `Edit the preset ${p.name}`);
      edit.addEventListener('click', () => open(p));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn small ghost';
      remove.textContent = 'Delete';
      remove.setAttribute('aria-label', `Delete the preset ${p.name}`);
      remove.addEventListener('click', () => {
        draft = draft.filter((x) => x.id !== p.id);
        if (editing === p.id) close();
        render();
      });
      const actions = document.createElement('div');
      actions.className = 'head-actions';
      actions.append(edit, remove);
      li.append(about, actions);
      return li;
    }));
    list.hidden = draft.length === 0;
  }

  function open(p = null) {
    editing = p ? p.id : '';
    const v = p || normalizePreset({ name: '' });
    fields.name.value = p ? v.name : '';
    fields.trackers.value = formatTiers(v.trackers);
    fields.source.value = v.source;
    fields.private.checked = v.private;
    fields.webSeeds.value = v.webSeeds.join('\n');
    fields.comment.value = v.comment;
    fields.maxPiece.value = String(v.maxPiece);
    form.hidden = false;
    fields.name.focus();
  }

  function close() {
    editing = null;
    form.hidden = true;
  }

  function keep() {
    const p = normalizePreset({
      id: editing || undefined,
      name: fields.name.value,
      trackers: parseTiers(fields.trackers.value),
      source: fields.source.value,
      private: fields.private.checked,
      webSeeds: parseLines(fields.webSeeds.value),
      comment: fields.comment.value.trim(),
      maxPiece: Number(fields.maxPiece.value),
    });
    const at = draft.findIndex((x) => x.id === editing);
    if (at >= 0) draft[at] = p;
    else draft.push(p);
    close();
    render();
  }

  $('#preset-add').addEventListener('click', () => open());
  $('#preset-keep').addEventListener('click', keep);
  $('#preset-cancel').addEventListener('click', close);
  // Enter in Settings is Save, which would close the dialog with this preset half typed: here it keeps
  // the preset instead (a new line in the text areas, as anywhere).
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.localName === 'input') {
      e.preventDefault();
      keep();
    }
  });

  return {
    load(presets) {
      draft = normalizePresets(presets);
      close();
      render();
    },
    get value() { return draft.map((p) => ({ ...p })); },
  };
}
