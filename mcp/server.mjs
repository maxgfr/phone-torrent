#!/usr/bin/env node
/* Swarmdeck as an MCP server, over stdio: a tool per operation of cli/core.mjs, the same ones the
 * command line runs. The server it drives is SWARMDECK_URL (default http://127.0.0.1:8080, which
 * `npm run local` opens), with SWARMDECK_TOKEN when it has one. Results are JSON text; a failure is a
 * tool error whose text says what to do about it.
 */
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { check, connect, create, edit, inspect, magnet } from '../cli/core.mjs';

const api = connect();
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const server = new McpServer({ name: 'swarmdeck', version });

const id = z.string().describe('The transfer: its info hash, the first characters of it, or its exact name');
const paths = 'Paths are read and written on the machine this MCP server runs on; give them absolute.';

const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const change = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const local = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function tool(name, description, inputSchema, annotations, run) {
  server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
    try {
      const result = await run(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  });
}

/* ---------- the server's transfers ---------- */

tool('swarmdeck_status', 'Whether the Swarmdeck server answers, what it can do (features), how many transfers it has and how much disk is free. Call it first: an error here says how to start the server.', {}, read,
  () => api.status());

tool('list_transfers', 'Every transfer on the server (id, name, size, progress 0-1, state, ready, paused, metadata, peers, speeds). With `id`, that one transfer with every file numbered in detail.files ({ id, path, size, progress, done, selected }): the numbers select_files and download_files take.', {
  id: id.optional(),
  detail: z.boolean().default(false).describe('With every transfer\'s files (heavier)'),
}, read, ({ id: ref, detail }) => (ref ? api.show(ref) : api.list({ detail })));

tool('add_transfer', `Add a torrent to the server: a magnet link, an info hash, the http(s) address of a .torrent (a server started with --local only), or the path of a .torrent file. Answers { transfer, created } (created false: it was there already). A magnet added paused asks no one for its metadata, so its files cannot be chosen until it is resumed; to choose the files of a magnet before anything downloads, fetch_metadata it, then add that .torrent paused. ${paths}`, {
  source: z.string().describe('Magnet, info hash, http(s) address of a .torrent, or path of a .torrent file'),
  paused: z.boolean().default(false).describe('Add it without fetching anything yet'),
}, { ...change, idempotentHint: true }, ({ source, paused }) => api.add(source, { paused }));

tool('pause_transfer', 'Pause a transfer: every connection closes, nothing more is fetched or seeded. Kept across a restart.', { id }, change,
  ({ id: ref }) => api.setPaused(ref, true));

tool('resume_transfer', 'Resume a paused transfer.', { id }, change,
  ({ id: ref }) => api.setPaused(ref, false));

tool('select_files', 'Choose which files of a transfer are fetched, by their numbers in list_transfers({ id }).detail.files: exactly one of `only` (fetch these), `skip` (fetch all but these) or `all`. Set, not toggled. Needs the metadata (wait_transfer until "metadata" first).', {
  id,
  only: z.array(z.number().int().min(0)).optional().describe('Fetch only these files'),
  skip: z.array(z.number().int().min(0)).optional().describe('Fetch every file but these'),
  all: z.boolean().optional().describe('Fetch every file'),
}, change, ({ id: ref, only, skip, all }) => api.select(ref, { only, skip, all }));

tool('remove_transfer', 'Take a transfer off the server. Its downloaded files stay on the disk, as a torrent client\'s remove does. deleteFiles: true also deletes them, which cannot be undone: only when the user explicitly asked for the files to be deleted.', {
  id,
  deleteFiles: z.boolean().default(false).describe('Also delete its downloaded files. Irreversible: only on the user\'s explicit request'),
}, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, ({ id: ref, deleteFiles }) => api.remove(ref, { deleteFiles }));

tool('reveal_transfer', 'Show a transfer\'s files in the Finder (Explorer, the file manager) of the computer the server runs on. Only a server started with `npm run local`, asked from that computer.', { id }, change,
  ({ id: ref }) => api.reveal(ref));

tool('save_torrent', `Save a transfer's .torrent file (once its metadata is in) to \`out\`: a file path, or a folder to put "<name>.torrent" in. ${paths}`, {
  id,
  out: z.string().optional().describe('File or folder to write to; the MCP server\'s working directory by default'),
}, local, ({ id: ref, out }) => api.torrentOf(ref, { out }));

tool('fetch_metadata', `Turn a magnet into a .torrent file: the server asks the swarm (DHT and the magnet's trackers) for up to a minute, without adding a transfer, and the file is written to \`out\`. ${paths}`, {
  magnet: z.string().describe('Magnet link or info hash'),
  out: z.string().optional().describe('File or folder to write to'),
}, local, ({ magnet: m, out }) => api.metadata(m, { out }));

tool('download_files', `Copy a transfer's files from the server to a folder here, each at its path in the torrent: file \`index\`, or every complete file it fetches. Useful when the server is another machine; with npm run local the files are already in its download folder (reveal_transfer shows them). ${paths}`, {
  id,
  index: z.number().int().min(0).optional().describe('Only this file (its number in detail.files)'),
  outDir: z.string().describe('Folder to copy into'),
}, local, ({ id: ref, index, outDir }) => api.download(ref, { index, outDir }));

tool('file_links', 'The address of each file a transfer fetches (or of file `index`), to play in a player such as VLC or open on another device. Signed for that one file and a day when the server has a token, and never containing the token. A file still downloading plays as its pieces arrive.', {
  id,
  index: z.number().int().min(0).optional().describe('Only this file (its number in detail.files)'),
}, read, ({ id: ref, index }) => api.links(ref, { index }));

tool('wait_transfer', 'Wait until a transfer has its metadata ("metadata": its files are known and can be selected) or has every file it fetches ("done"). Fails at once when the transfer fails or is paused where it cannot go further, and after `timeout` seconds with its state.', {
  id,
  until: z.enum(['metadata', 'done']).default('done'),
  timeout: z.number().positive().max(3600).default(120).describe('Seconds; keep it short and call again rather than block for long'),
}, read, ({ id: ref, until, timeout }) => api.wait(ref, { until, timeout }));

/* ---------- .torrent files on this disk ---------- */

tool('inspect_torrent', `What a .torrent file holds: info hash, name, files, sizes, pieces, trackers, web seeds, private flag, source, comment, and its magnet. No server needed. ${paths}`, {
  file: z.string().describe('Path of the .torrent file'),
}, { readOnlyHint: true, openWorldHint: false }, ({ file }) => inspect(file));

tool('torrent_magnet', `The magnet link of a .torrent file. No server needed. ${paths}`, {
  file: z.string(),
}, { readOnlyHint: true, openWorldHint: false }, async ({ file }) => ({ magnet: await magnet(file) }));

const tiersOf = (urls) => urls.map((u) => [u]);

tool('edit_torrent', `Edit one or more .torrent files the same way, written to \`out\` (a file for one, a folder for several) or over each file with inPlace. Trackers, web seeds, comment and creation date leave the info hash as it is; name, private and source make another torrent (newHash: true in the answer). No server needed. ${paths}`, {
  files: z.array(z.string()).min(1).describe('Paths of the .torrent files'),
  out: z.string().optional(),
  inPlace: z.boolean().default(false).describe('Write over each file'),
  trackers: z.array(z.string()).optional().describe('Replace the trackers with these, a tier each'),
  addTrackers: z.array(z.string()).optional().describe('Add these trackers, each that is missing in a tier of its own'),
  clearTrackers: z.boolean().optional(),
  webSeeds: z.array(z.string()).optional().describe('Replace the web seeds with these'),
  addWebSeeds: z.array(z.string()).optional(),
  clearWebSeeds: z.boolean().optional(),
  comment: z.string().optional().describe('"" removes it'),
  name: z.string().optional(),
  private: z.boolean().optional(),
  source: z.string().optional().describe('"" removes it'),
  creationDate: z.union([z.literal('now'), z.literal('remove'), z.number().int().min(0)]).optional(),
}, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, (a) => {
  const changes = {};
  const list = (key, set, add, clear, tiers) => {
    if ([set, add, clear].filter((v) => v !== undefined && v !== false).length > 1) throw new Error(`set, add or clear the ${key}: one of them`);
    if (set) changes[key] = { op: 'set', value: tiers(set) };
    else if (add) changes[key] = { op: 'add', value: tiers(add) };
    else if (clear) changes[key] = { op: 'clear' };
  };
  list('trackers', a.trackers, a.addTrackers, a.clearTrackers, tiersOf);
  list('webSeeds', a.webSeeds, a.addWebSeeds, a.clearWebSeeds, (x) => x);
  for (const key of ['comment', 'name', 'source']) if (a[key] !== undefined) changes[key] = { op: 'set', value: a[key] };
  if (a.private !== undefined) changes.private = a.private ? { op: 'set', value: true } : { op: 'clear' };
  if (a.creationDate !== undefined) changes.creationDate = a.creationDate === 'remove' ? { op: 'clear' } : { op: 'set', value: a.creationDate };
  if (!Object.keys(changes).length) throw new Error('nothing to change');
  if (!a.out && !a.inPlace) throw new Error('say where the edited files go: out, or inPlace');
  return edit(a.files, changes, { out: a.out, inPlace: a.inPlace });
});

tool('create_torrent', `Make a .torrent of a file or a folder on this disk (every piece hashed: large folders take a while), written to \`out\` or "<name>.torrent" in the working directory. No server needed; add_transfer the result to seed it from a server whose download folder holds the files. ${paths}`, {
  path: z.string().describe('File or folder to make it of'),
  out: z.string().optional(),
  name: z.string().optional().describe('Its name; the folder\'s or file\'s by default'),
  trackers: z.array(z.string()).optional().describe('Tracker announce URLs, a tier each'),
  webSeeds: z.array(z.string()).optional(),
  private: z.boolean().optional(),
  source: z.string().optional(),
  comment: z.string().optional(),
  pieceLength: z.number().int().positive().optional().describe('Bytes, a power of two; chosen from the size by default'),
  exclude: z.string().optional().describe('File names left out, such as "*.nfo, Thumbs.db"'),
}, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, (a) => create(a.path, {
  out: a.out,
  ...(a.name ? { name: a.name } : {}),
  trackers: tiersOf(a.trackers || []),
  webSeeds: a.webSeeds || [],
  private: Boolean(a.private),
  ...(a.source ? { source: a.source } : {}),
  ...(a.comment ? { comment: a.comment } : {}),
  ...(a.exclude ? { exclude: a.exclude } : {}),
  pieceLength: a.pieceLength || 0,
}));

tool('check_torrent', `Are the files in a folder this torrent? Every piece hashed again, as a client does before seeding: ok, percent good, bad and missing pieces, missing files, wrong sizes. \`path\` is the torrent's folder (or file), or a folder it is in, such as the download folder. No server needed. ${paths}`, {
  file: z.string().describe('Path of the .torrent file'),
  path: z.string().describe('Folder (or file) holding its files'),
}, { readOnlyHint: true, openWorldHint: false }, ({ file, path }) => check(file, path));

await server.connect(new StdioServerTransport());
