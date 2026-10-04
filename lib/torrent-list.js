/* The list of torrents: on a wide screen, one row each beside the one open; on any screen, what the
 * search, the filter and the sort make of the cards.
 *
 * The rules are plain functions of plain rows, which the app builds from its cards, and are tested
 * without a browser (test/meta.mjs). The list itself is the DOM part: it keeps one node per torrent and
 * only writes the text that changed, since the app redraws everything every 750 ms and a row built
 * again each time would lose the keyboard's focus, and the pointer's hover, three times a second.
 */

/** What the list can be cut down to. A row can be in more than one: a finished download still sharing is done and seeding. */
export const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'downloading', label: 'Downloading' },
  { key: 'seeding', label: 'Seeding' },
  { key: 'paused', label: 'Paused' },
  { key: 'done', label: 'Done' },
  { key: 'problem', label: 'Problem' },
];

/** What it can be put in order by, and the way each goes first: the newest, the biggest, the fastest on top. */
export const SORTS = [
  { key: 'added', label: 'Added', dir: 'desc' },
  { key: 'name', label: 'Name', dir: 'asc' },
  { key: 'size', label: 'Size', dir: 'desc' },
  { key: 'progress', label: 'Progress', dir: 'desc' },
  { key: 'speed', label: 'Speed', dir: 'desc' },
];

// Named as the app's other storage (see SETTINGS_KEY in app.js), and moved there from Phone Torrent's with it.
export const LIST_PREFS_KEY = 'swarmdeck:list';
const DEFAULT_PREFS = { filter: 'all', sort: 'added', dir: 'desc', view: 'cards' };

/**
 * Whether a row is in this filter and matches this search. Every word searched for has to be in its
 * name or its info hash, case ignored: "show s01" finds "The.Show.S01E01".
 */
export function rowMatches(row, { filter = 'all', query = '' } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${row.name || ''} ${row.key || ''}`.toLowerCase();
  if (!words.every((w) => haystack.includes(w))) return false;
  switch (filter) {
    case 'downloading': return !row.paused && !row.complete && !row.seeding;
    case 'seeding': return !row.paused && Boolean(row.seeding);
    case 'paused': return Boolean(row.paused);
    case 'done': return Boolean(row.complete);
    case 'problem': return Boolean(row.problem);
    default: return true;
  }
}

const collator = typeof Intl === 'object' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;

const SORT_VALUE = {
  added: (r) => Number(r.addedAt) || 0,
  name: (r) => String(r.name || ''),
  size: (r) => Number(r.size) || 0,
  progress: (r) => Number(r.progress) || 0,
  speed: (r) => (Number(r.down) || 0) + (Number(r.up) || 0),
};

/**
 * The rows in this order, as a new array. Stable: rows that compare the same keep the order they came
 * in, so two torrents at 0 KB/s do not swap places at every tick.
 */
export function sortRows(rows, { sort = 'added', dir = 'desc' } = {}) {
  const value = SORT_VALUE[sort] || SORT_VALUE.added;
  const sign = dir === 'asc' ? 1 : -1;
  const compare = (a, b) => {
    const x = value(a);
    const y = value(b);
    if (typeof x === 'string') return collator ? collator.compare(x, y) : x.localeCompare(y);
    return x - y;
  };
  return rows.map((row, i) => ({ row, i }))
    .sort((a, b) => sign * compare(a.row, b.row) || a.i - b.i)
    .map(({ row }) => row);
}

/** The keys from one to the other, both included, in the order listed: what a Shift-click selects. */
export function rangeKeys(keys, from, to) {
  const a = keys.indexOf(from);
  const b = keys.indexOf(to);
  if (b < 0) return [];
  if (a < 0) return [to];
  return keys.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** The list's filter, sort and density as last left. Storage that throws (a private window, blocked site data) is no storage. */
export function loadListPrefs(storage = globalThis.localStorage) {
  let saved = {};
  try {
    saved = JSON.parse(storage.getItem(LIST_PREFS_KEY) || '{}') || {};
  } catch { /* the defaults */ }
  return {
    filter: FILTERS.some((f) => f.key === saved.filter) ? saved.filter : DEFAULT_PREFS.filter,
    sort: SORTS.some((s) => s.key === saved.sort) ? saved.sort : DEFAULT_PREFS.sort,
    dir: saved.dir === 'asc' || saved.dir === 'desc' ? saved.dir : DEFAULT_PREFS.dir,
    view: saved.view === 'table' ? 'table' : DEFAULT_PREFS.view,
  };
}

export function saveListPrefs(prefs, storage = globalThis.localStorage) {
  try {
    const { filter, sort, dir, view } = prefs;
    storage.setItem(LIST_PREFS_KEY, JSON.stringify({ filter, sort, dir, view }));
  } catch { /* kept for this visit only */ }
}

/* ---------- the list on the page ---------- */

/** The columns of the table. In the cards density only the name shows, with the rest on a line under it. */
const COLUMNS = [
  { key: 'name', label: 'Name', sort: 'name' },
  { key: 'size', label: 'Size', sort: 'size' },
  { key: 'progress', label: 'Progress', sort: 'progress' },
  { key: 'down', label: '↓', title: 'Download speed', sort: 'speed' },
  { key: 'up', label: '↑', title: 'Upload speed' },
  { key: 'peers', label: 'Peers' },
  { key: 'eta', label: 'ETA' },
  { key: 'state', label: 'State' },
];

const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

/**
 * The list in `root` (a role="grid"). `onActivate(key, { shift, toggle })` is a row clicked, with what
 * Shift and Ctrl or Cmd asked for; `onCheck(key, checked, { shift })` its box ticked ('*' for the one
 * in the header); `onSort(sortKey)` a column's header clicked; `onKey(event, key)` a key pressed in the
 * list, with the row it was pressed on.
 */
export function createTorrentList(root, { onActivate, onCheck, onSort, onKey } = {}) {
  const doc = root.ownerDocument;
  const make = (tag, props = {}) => Object.assign(doc.createElement(tag), props);
  /** key → { el, cells, check, bar } */
  const nodes = new Map();

  const head = make('div', { className: 'tl-head' });
  head.setAttribute('role', 'row');
  const allCell = make('div', { className: 'tl-cell tl-check' });
  allCell.setAttribute('role', 'columnheader');
  const all = make('input', { type: 'checkbox' });
  all.setAttribute('aria-label', 'Select every torrent listed');
  all.addEventListener('change', () => onCheck?.('*', all.checked, {}));
  allCell.append(all);
  head.append(allCell);
  const headers = new Map();
  for (const col of COLUMNS) {
    const cell = make('div', { className: `tl-cell tl-${col.key}` });
    cell.setAttribute('role', 'columnheader');
    if (col.sort) {
      const button = make('button', { type: 'button', className: 'tl-sort', textContent: col.label });
      if (col.title) button.title = col.title;
      button.setAttribute('aria-label', `Sort by ${(col.title || col.label).toLowerCase()}`);
      button.addEventListener('click', () => onSort?.(col.sort));
      cell.append(button);
      headers.set(col.sort, cell);
    } else {
      cell.textContent = col.label;
      if (col.title) cell.title = col.title;
    }
    head.append(cell);
  }
  const body = make('div', { className: 'tl-body' });
  body.setAttribute('role', 'rowgroup');
  const empty = make('p', { className: 'tl-empty empty', hidden: true });
  root.replaceChildren(head, body, empty);

  root.addEventListener('keydown', (event) => {
    const row = event.target.closest?.('.tl-row');
    onKey?.(event, row ? row.dataset.key : null);
  });

  function build(key) {
    const el = make('div', { className: 'tl-row', tabIndex: -1 });
    el.setAttribute('role', 'row');
    el.dataset.key = key;
    const checkCell = make('div', { className: 'tl-cell tl-check' });
    checkCell.setAttribute('role', 'gridcell');
    const check = make('input', { type: 'checkbox', tabIndex: -1 });
    checkCell.append(check);
    el.append(checkCell);
    const cells = {};
    for (const col of COLUMNS) {
      const cell = make('div', { className: `tl-cell tl-${col.key}` });
      cell.setAttribute('role', 'gridcell');
      el.append(cell);
      cells[col.key] = cell;
    }
    const name = make('span', { className: 'tl-title' });
    const sub = make('span', { className: 'tl-sub' });
    cells.name.append(name, sub);
    const track = make('span', { className: 'tl-track' });
    const bar = make('span', { className: 'tl-bar' });
    const pct = make('span', { className: 'tl-pct' });
    track.append(bar);
    cells.progress.append(track, pct);
    // Ticked and clicked are told apart: the box adds to the selection, the row opens the torrent.
    // A click, not a change: only the click knows whether Shift was held.
    check.addEventListener('click', (event) => {
      event.stopPropagation();
      onCheck?.(key, check.checked, { shift: event.shiftKey });
    });
    el.addEventListener('click', (event) => {
      onActivate?.(key, { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey });
    });
    const node = { el, check, cells, name, sub, bar, pct };
    nodes.set(key, node);
    return node;
  }

  function render(rows, state = {}) {
    const { selected = new Set(), focused = null, sort = 'added', dir = 'desc', emptyText = '' } = state;
    const keys = new Set(rows.map((r) => r.key));
    for (const [key, node] of nodes) {
      if (!keys.has(key)) {
        node.el.remove();
        nodes.delete(key);
      }
    }
    let at = body.firstElementChild;
    for (const row of rows) {
      const node = nodes.get(row.key) || build(row.key);
      // Moved only when out of place: a node taken out of the page and put back loses the focus.
      if (node.el !== at) body.insertBefore(node.el, at);
      else at = at.nextElementSibling;
      const isSelected = selected.has(row.key);
      const isFocused = row.key === focused;
      node.el.classList.toggle('selected', isSelected);
      node.el.classList.toggle('focused', isFocused);
      node.el.classList.toggle('paused', Boolean(row.paused));
      node.el.classList.toggle('done', Boolean(row.complete));
      node.el.classList.toggle('seeding', Boolean(row.seeding));
      node.el.classList.toggle('problem', Boolean(row.problem));
      node.el.setAttribute('aria-selected', String(isSelected));
      if (isFocused) node.el.setAttribute('aria-current', 'true');
      else node.el.removeAttribute('aria-current');
      if (node.check.checked !== isSelected) node.check.checked = isSelected;
      const label = `Select ${row.name}`;
      if (node.check.getAttribute('aria-label') !== label) node.check.setAttribute('aria-label', label);
      setText(node.name, row.name);
      setText(node.sub, [row.sizeText, `${row.pct}%`, row.state, row.speedText].filter(Boolean).join(' · '));
      setText(node.cells.size, row.sizeText);
      const width = `${row.pct}%`;
      if (node.bar.style.width !== width) node.bar.style.width = width;
      setText(node.pct, `${row.pct}%`);
      setText(node.cells.down, row.downText);
      setText(node.cells.up, row.upText);
      setText(node.cells.peers, String(row.peers));
      setText(node.cells.eta, row.etaText);
      setText(node.cells.state, row.state);
      // Cut short with an ellipsis in a narrow column: the whole of it on hover.
      if (node.cells.name.title !== row.name) node.cells.name.title = row.name;
      if (node.cells.state.title !== row.state) node.cells.state.title = row.state;
    }
    // One row the Tab key lands on: the one open, or else the first.
    const tabStop = nodes.has(focused) ? focused : rows[0]?.key;
    for (const [key, node] of nodes) {
      const index = key === tabStop ? 0 : -1;
      if (node.el.tabIndex !== index) node.el.tabIndex = index;
    }
    all.checked = rows.length > 0 && rows.every((r) => selected.has(r.key));
    all.indeterminate = !all.checked && rows.some((r) => selected.has(r.key));
    for (const [key, cell] of headers) {
      const value = key === sort ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
      if (cell.getAttribute('aria-sort') !== value) cell.setAttribute('aria-sort', value);
    }
    empty.hidden = rows.length > 0 || !emptyText;
    setText(empty, emptyText);
  }

  /** Put the keyboard's focus on this row, scrolled into view. */
  function focusRow(key) {
    const node = nodes.get(key);
    if (!node) return;
    for (const other of nodes.values()) other.el.tabIndex = other === node ? 0 : -1;
    node.el.focus({ preventScroll: true });
    node.el.scrollIntoView({ block: 'nearest' });
  }

  return { render, focusRow };
}
