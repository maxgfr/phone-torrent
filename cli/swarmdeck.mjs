#!/usr/bin/env node
/* Swarmdeck from a terminal, or from an AI that runs commands: the transfers of a Swarmdeck server
 * (`npm run local`, or the image), and .torrent files on this disk. A short text by default, the raw
 * result with --json. Exit code 0 when it worked, 1 when it did not (the reason on stderr), 2 when the
 * command itself is wrong.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { check, connect, create, edit, inspect, magnet, DEFAULT_SERVER } from './core.mjs';
import { formatSize } from '../lib/torrent-meta.js';

const HELP = `swarmdeck — drive a Swarmdeck server, and make and edit .torrent files

Usage: swarmdeck <command> [arguments] [options]

The server's transfers (SWARMDECK_URL, default ${DEFAULT_SERVER}; SWARMDECK_TOKEN if it has one)
  status                          is it there, what it can do, free space
  list [--detail]                 every transfer
  show <id>                       one transfer, with its files numbered
  add <source...> [--paused]      a magnet, an info hash, a .torrent file, or its http(s) address
  pause <id...>                   stop fetching and seeding
  resume <id...>                  start again
  select <id> --only 0,2 | --skip 1 | --all
                                  the files it fetches, by number (see show)
  remove <id...> [--delete-files] take it off the server; its files stay unless --delete-files
  reveal <id>                     show its files in the Finder (npm run local only)
  torrent <id> [-o file|dir]      save its .torrent
  metadata <magnet> [-o file|dir] a magnet's .torrent, asked of the swarm, without adding it
  download <id> [index] [-o dir]  copy its complete files (or that one) from the server
  link <id> [index]               the address of its files (or that one), to play or share;
                                  it never contains the token
  wait <id> [--for metadata|done] [--timeout s]
                                  until its metadata is in, or its files are all there

.torrent files on this disk (no server needed)
  inspect <file>                  what it holds
  magnet <file>                   its magnet link
  edit <file...> (-o file|dir | --in-place) [changes]
      --tracker URL (set, repeatable) --add-tracker URL --clear-trackers
      --webseed URL (set, repeatable) --add-webseed URL --clear-webseeds
      --comment TEXT --name TEXT --source TEXT --private | --public --date now|remove|SECONDS
  create <file|folder> [-o file|dir] [--tracker URL...] [--webseed URL...] [--private]
      [--source TEXT] [--comment TEXT] [--name TEXT] [--piece-length BYTES] [--exclude "*.nfo,*.txt"]
  check <file> <folder>           are these files this torrent? every piece hashed again

<id> is an info hash, its first characters, or the transfer's name.

Options
  --server URL   the server (or SWARMDECK_URL)
  --token TOKEN  its AUTH_TOKEN (or SWARMDECK_TOKEN, which keeps it out of your shell history)
  --json         the raw result, for scripts and AIs
  --version      the version
  -h, --help     this
`;

const OPTIONS = {
  server: { type: 'string' },
  token: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  detail: { type: 'boolean' },
  paused: { type: 'boolean' },
  only: { type: 'string' },
  skip: { type: 'string' },
  all: { type: 'boolean' },
  'delete-files': { type: 'boolean' },
  out: { type: 'string', short: 'o' },
  for: { type: 'string' },
  timeout: { type: 'string' },
  tracker: { type: 'string', multiple: true },
  'add-tracker': { type: 'string', multiple: true },
  'clear-trackers': { type: 'boolean' },
  webseed: { type: 'string', multiple: true },
  'add-webseed': { type: 'string', multiple: true },
  'clear-webseeds': { type: 'boolean' },
  comment: { type: 'string' },
  name: { type: 'string' },
  source: { type: 'string' },
  private: { type: 'boolean' },
  public: { type: 'boolean' },
  date: { type: 'string' },
  'in-place': { type: 'boolean' },
  'piece-length': { type: 'string' },
  exclude: { type: 'string' },
  'created-by': { type: 'string' },
};

class UsageError extends Error {}

const pct = (p) => `${Math.floor((p || 0) * 1000) / 10}%`;
const speed = (n) => `${formatSize(n || 0)}/s`;

function need(args, count, what) {
  if (args.length < count) throw new UsageError(`missing ${what}`);
}

function indexList(value, flag) {
  const list = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length || list.some((s) => !/^\d+$/.test(s))) throw new UsageError(`${flag} takes file numbers, such as 0,2`);
  return list.map(Number);
}

/** The edit flags as lib/torrent-meta.js's batch changes. */
function changesFrom(o) {
  const changes = {};
  const listField = (key, set, add, clear) => {
    const given = [set, add, clear].filter((v) => v !== undefined && v !== false).length;
    if (given > 1) throw new UsageError(`set, add or clear the ${key}: one of them`);
    const tiers = key === 'trackers' ? (urls) => urls.map((u) => [u]) : (urls) => urls;
    if (set) changes[key] = { op: 'set', value: tiers(set) };
    else if (add) changes[key] = { op: 'add', value: tiers(add) };
    else if (clear) changes[key] = { op: 'clear' };
  };
  listField('trackers', o.tracker, o['add-tracker'], o['clear-trackers']);
  listField('webSeeds', o.webseed, o['add-webseed'], o['clear-webseeds']);
  for (const key of ['comment', 'name', 'source']) if (o[key] !== undefined) changes[key] = { op: 'set', value: o[key] };
  if (o.private && o.public) throw new UsageError('--private or --public, not both');
  if (o.private) changes.private = { op: 'set', value: true };
  if (o.public) changes.private = { op: 'clear' };
  if (o.date !== undefined) {
    if (o.date === 'remove') changes.creationDate = { op: 'clear' };
    else if (o.date === 'now') changes.creationDate = { op: 'set', value: 'now' };
    else if (/^\d+$/.test(o.date)) changes.creationDate = { op: 'set', value: Number(o.date) };
    else throw new UsageError('--date is now, remove, or seconds since 1970');
  }
  if (!Object.keys(changes).length) throw new UsageError('nothing to change: see `swarmdeck help` for what edit takes');
  return changes;
}

function describeTransfer(t) {
  const lines = [`${t.name}`, `  id        ${t.id}`, `  state     ${t.state}${t.failed ? ' (failed)' : ''}`, `  progress  ${pct(t.progress)} of ${formatSize(t.size)}${t.ready ? ', ready' : ''}`];
  if (!t.failed) lines.push(`  peers     ${t.peers}, ↓ ${speed(t.downloadSpeed)} ↑ ${speed(t.uploadSpeed)}, ratio ${(t.ratio || 0).toFixed(2)}`);
  if (t.detail?.files?.length) {
    lines.push('  files');
    for (const f of t.detail.files) lines.push(`    [${f.id}] ${f.selected ? (f.done ? '✓' : '·') : '✗'} ${pct(f.progress).padStart(6)}  ${formatSize(f.size).padStart(9)}  ${f.path}`);
    lines.push('    (✓ complete, · fetching, ✗ left out)');
  } else if (!t.metadata && !t.failed) lines.push('  files     not known until its metadata is in');
  return lines.join('\n');
}

const listLine = (t) => `${t.id.slice(0, 8)}  ${pct(t.progress).padStart(6)}  ${formatSize(t.size).padStart(9)}  ${String(t.state).padEnd(18)}  ${t.name}`;

async function run(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values: o, positionals } = parsed;
  const [command = 'help', ...args] = positionals;
  if (o.version) {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    return { result: { version }, text: version };
  }
  if (o.help || command === 'help') return { text: HELP };
  const server = () => connect({ server: o.server, token: o.token });
  const each = async (ids, fn) => {
    need(ids, 1, 'a transfer: its info hash, the start of it, or its name');
    const out = [];
    for (const id of ids) out.push(await fn(id));
    return out.length === 1 ? out[0] : out;
  };

  switch (command) {
    case 'status': {
      const s = await server().status();
      const lines = [`Swarmdeck at ${s.server}: ${s.ok ? 'running' : 'not ok'}${s.local ? ' (this computer)' : ''}, ${s.torrents} transfer${s.torrents === 1 ? '' : 's'}`];
      lines.push(`  can also: ${(s.features || []).join(', ') || 'nothing more'}`);
      if (s.account?.detail) lines.push(`  ${s.account.detail}`);
      if (s.account?.error) lines.push(`  account: ${s.account.error}`);
      return { result: s, text: lines.join('\n') };
    }
    case 'list': {
      const all = await server().list({ detail: o.detail });
      return { result: all, text: all.length ? all.map(listLine).join('\n') : 'no transfers' };
    }
    case 'show': {
      need(args, 1, 'a transfer');
      const t = await server().show(args[0]);
      return { result: t, text: describeTransfer(t) };
    }
    case 'add': {
      need(args, 1, 'what to add: a magnet, an info hash, a .torrent file or its address');
      const api = server();
      const added = await each(args, (s) => api.add(s, { paused: o.paused }));
      const text = [].concat(added).map(({ transfer: t, created }) => `${created ? 'added' : 'already there:'} ${t.name} (${t.id})${t.paused ? ', paused' : ''}`).join('\n');
      // On stderr, so that --json stays the result alone.
      if ([].concat(added).some(({ transfer: t }) => t.paused && !t.metadata)) {
        process.stderr.write('note: a magnet added paused asks no one for its metadata, so its files cannot be chosen until it is resumed. To choose them before anything downloads: `swarmdeck metadata <magnet> -o x.torrent`, then `swarmdeck add x.torrent --paused`.\n');
      }
      return { result: added, text };
    }
    case 'pause':
    case 'resume': {
      const api = server();
      const done = await each(args, (id) => api.setPaused(id, command === 'pause'));
      return { result: done, text: [].concat(done).map((t) => `${t.name}: ${t.state}`).join('\n') };
    }
    case 'select': {
      need(args, 1, 'a transfer');
      const choice = {};
      if (o.only !== undefined) choice.only = indexList(o.only, '--only');
      if (o.skip !== undefined) choice.skip = indexList(o.skip, '--skip');
      if (o.all) choice.all = true;
      if (Object.keys(choice).length !== 1) throw new UsageError('select takes one of --only 0,2, --skip 1 or --all');
      const t = await server().select(args[0], choice);
      return { result: t, text: describeTransfer(t) };
    }
    case 'remove': {
      const api = server();
      const done = await each(args, (id) => api.remove(id, { deleteFiles: o['delete-files'] }));
      return { result: done, text: [].concat(done).map((r) => `removed ${r.name}: ${r.filesDeleted ? 'its files deleted' : 'its files stay on the disk'}`).join('\n') };
    }
    case 'reveal': {
      need(args, 1, 'a transfer');
      const r = await server().reveal(args[0]);
      return { result: r, text: 'shown in the file manager' };
    }
    case 'torrent': {
      need(args, 1, 'a transfer');
      const r = await server().torrentOf(args[0], { out: o.out });
      return { result: r, text: `wrote ${r.path}` };
    }
    case 'metadata': {
      need(args, 1, 'a magnet or an info hash');
      const r = await server().metadata(args[0], { out: o.out });
      return { result: r, text: `wrote ${r.path} (${r.name})` };
    }
    case 'download': {
      need(args, 1, 'a transfer');
      if (args[1] !== undefined && !/^\d+$/.test(args[1])) throw new UsageError('the file to copy is its number (see show)');
      const r = await server().download(args[0], { index: args[1] === undefined ? undefined : Number(args[1]), outDir: o.out || '.' });
      return { result: r, text: r.files.map((f) => `wrote ${f.path} (${formatSize(f.size)})`).join('\n') };
    }
    case 'link': {
      need(args, 1, 'a transfer');
      if (args[1] !== undefined && !/^\d+$/.test(args[1])) throw new UsageError('the file is its number (see show)');
      const r = await server().links(args[0], { index: args[1] === undefined ? undefined : Number(args[1]) });
      // One file asked for: its address alone, to hand to a player.
      const text = args[1] !== undefined ? r.files[0].url : r.files.map((f) => `${f.url}  ${f.path}${f.done ? '' : ' (downloading)'}`).join('\n');
      return { result: r, text };
    }
    case 'wait': {
      need(args, 1, 'a transfer');
      const until = o.for || 'done';
      if (until !== 'metadata' && until !== 'done') throw new UsageError('--for is metadata or done');
      const timeout = o.timeout === undefined ? 600 : Number(o.timeout);
      if (!(timeout > 0)) throw new UsageError('--timeout is a number of seconds');
      const live = !o.json && process.stderr.isTTY;
      const t = await server().wait(args[0], {
        until,
        timeout,
        onUpdate: live ? (x) => process.stderr.write(`\r${x.state}, ${pct(x.progress)}, ${x.peers} peers   `) : undefined,
      }).finally(() => live && process.stderr.write('\n'));
      return { result: t, text: `${t.name}: ${until === 'metadata' ? 'metadata in' : 'all there'} (${t.state}, ${pct(t.progress)})` };
    }
    case 'inspect': {
      need(args, 1, 'a .torrent file');
      const r = await inspect(args[0]);
      const lines = [
        r.name, `  info hash   ${r.infoHash}`, `  size        ${formatSize(r.totalLength)} in ${r.files.length} file${r.files.length === 1 ? '' : 's'}, ${r.pieceCount} pieces of ${formatSize(r.pieceLength)}`,
      ];
      if (r.private) lines.push('  private');
      if (r.source) lines.push(`  source      ${r.source}`);
      if (r.comment) lines.push(`  comment     ${r.comment}`);
      if (r.createdBy) lines.push(`  created by  ${r.createdBy}${r.creationDate ? `, ${new Date(r.creationDate * 1000).toISOString()}` : ''}`);
      r.trackers.forEach((tier, i) => lines.push(`  ${i ? '            ' : 'trackers    '}${tier.join(', ')}`));
      r.webSeeds.forEach((w, i) => lines.push(`  ${i ? '            ' : 'web seeds   '}${w}`));
      lines.push('  files');
      for (const f of r.files) lines.push(`    ${formatSize(f.length).padStart(9)}  ${f.path}`);
      return { result: r, text: lines.join('\n') };
    }
    case 'magnet': {
      need(args, 1, 'a .torrent file');
      const m = await magnet(args[0]);
      return { result: { magnet: m }, text: m };
    }
    case 'edit': {
      need(args, 1, 'the .torrent files to edit');
      if (!o.out && !o['in-place']) throw new UsageError('say where the edited file goes: -o file (a folder for several), or --in-place');
      if (o.out && o['in-place']) throw new UsageError('-o or --in-place, not both');
      const r = await edit(args, changesFrom(o), { out: o.out, inPlace: o['in-place'] });
      return { result: r, text: r.map((x) => `wrote ${x.path}${x.newHash ? `: a new torrent, ${x.infoHash}` : ''}`).join('\n') };
    }
    case 'create': {
      need(args, 1, 'a file or a folder');
      if (o.private && o.public) throw new UsageError('--private or --public, not both');
      const pieceLength = o['piece-length'] === undefined ? 0 : Number(o['piece-length']);
      if (!Number.isInteger(pieceLength) || pieceLength < 0 || (pieceLength && (pieceLength & (pieceLength - 1)))) throw new UsageError('--piece-length is a power of two, in bytes (16384, 262144, ...)');
      const options = { out: o.out, pieceLength, trackers: (o.tracker || []).map((u) => [u]), webSeeds: o.webseed || [], private: Boolean(o.private) };
      for (const [flag, key] of [['source', 'source'], ['comment', 'comment'], ['name', 'name'], ['exclude', 'exclude'], ['created-by', 'createdBy']]) if (o[flag] !== undefined) options[key] = o[flag];
      const r = await create(args[0], options);
      return { result: r, text: `wrote ${r.path}\n  ${r.name}: ${r.files} file${r.files === 1 ? '' : 's'}, ${formatSize(r.totalLength)}, pieces of ${formatSize(r.pieceLength)}\n  ${r.infoHash}` };
    }
    case 'check': {
      need(args, 2, 'a .torrent file and the folder its files are in');
      const r = await check(args[0], args[1]);
      const lines = [r.summary];
      for (const f of r.missingFiles) lines.push(`  missing: ${f}`);
      for (const w of r.wrongSizes) lines.push(`  ${w.path}: ${formatSize(w.size)} where the torrent says ${formatSize(w.length)}`);
      return { result: r, text: lines.join('\n'), code: r.ok ? 0 : 1 };
    }
    default:
      throw new UsageError(`no command "${command}": see \`swarmdeck help\``);
  }
}

const json = process.argv.includes('--json');
try {
  const { result, text, code = 0 } = await run(process.argv.slice(2));
  process.stdout.write(`${json && result !== undefined ? JSON.stringify(result, null, 2) : text}\n`);
  process.exitCode = code;
} catch (err) {
  process.stderr.write(`swarmdeck: ${err.message}\n`);
  if (err instanceof UsageError) process.stderr.write('see `swarmdeck help`\n');
  process.exitCode = err instanceof UsageError ? 2 : 1;
}
