/* The command line and the MCP server, without a network.
 *
 * What they do to .torrent files on the disk — inspect, magnet, edit, create, check — is run here as
 * a person or an AI runs it: the CLI as a process, its output read back as JSON, and the MCP server
 * through the SDK's own client. What they do with a server is in test/server.mjs, against a real one.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createTorrentPackage from 'create-torrent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readTorrent } from '../lib/torrent-meta.js';
import { infoHashOf } from '../lib/bencode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CLI = path.join(ROOT, 'cli', 'swarmdeck.mjs');
const log = (...a) => console.log('•', ...a);

/** The CLI as a process: its exit code, what it printed, and that output read as JSON when it is. */
function cli(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, SWARMDECK_URL: '', SWARMDECK_TOKEN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.once('error', reject);
    child.once('exit', (code) => {
      let json;
      try { json = JSON.parse(stdout); } catch { json = undefined; }
      resolve({ code, stdout, stderr, json });
    });
  });
}

/** A port nothing listens on: a server that is not running. */
async function closedPort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

const tmp = mkdtempSync(path.join(tmpdir(), 'swarmdeck-cli-'));
let failed = false;
try {
  // A folder as one is picked to make a torrent of: two files, one in a subfolder, and a system file
  // that is left out.
  const album = path.join(tmp, 'Album');
  mkdirSync(path.join(album, 'disc2'), { recursive: true });
  const one = randomBytes(100 * 1024 + 7);
  const two = randomBytes(50 * 1024);
  writeFileSync(path.join(album, 'one.flac'), one);
  writeFileSync(path.join(album, 'disc2', 'two.flac'), two);
  writeFileSync(path.join(album, '.DS_Store'), 'junk');

  /* ---------- create ---------- */
  const made = path.join(tmp, 'album.torrent');
  const created = await cli(['create', album, '-o', made, '--tracker', 'udp://t.example:80', '--tracker', 'wss://w.example', '--piece-length', '16384', '--comment', 'made here', '--json']);
  assert.equal(created.code, 0, `create succeeds: ${created.stderr}`);
  assert.equal(created.json.path, made);
  const model = await readTorrent(readFileSync(made));
  assert.equal(created.json.infoHash, model.infoHash, 'it says the info hash of the file it wrote');
  assert.equal(model.fields.name, 'Album', 'named after the folder');
  assert.deepEqual(model.fields.files.map((f) => f.path), ['disc2/two.flac', 'one.flac'], 'its files in order, the system file left out');
  assert.equal(model.fields.pieceLength, 16384);
  assert.deepEqual(model.fields.trackers, [['udp://t.example:80'], ['wss://w.example']], 'a tier per tracker');
  assert.equal(model.fields.comment, 'made here');
  const theirs = await new Promise((resolve, reject) => createTorrentPackage(album, { pieceLength: 16384, announceList: [] }, (err, buf) => (err ? reject(err) : resolve(new Uint8Array(buf)))));
  assert.equal(model.infoHash, await infoHashOf(theirs), 'the torrent WebTorrent makes of the same folder');
  const single = await cli(['create', path.join(album, 'one.flac'), '-o', path.join(tmp, 'one.torrent'), '--json']);
  assert.equal(single.code, 0, single.stderr);
  assert.deepEqual((await readTorrent(readFileSync(path.join(tmp, 'one.torrent')))).fields.files, [{ path: 'one.flac', length: one.length }], 'a file makes a one-file torrent');
  log('create: a folder as WebTorrent makes it, with its trackers, piece size and comment; a single file too');

  /* ---------- inspect and magnet ---------- */
  const inspected = await cli(['inspect', made, '--json']);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.equal(inspected.json.infoHash, model.infoHash);
  assert.equal(inspected.json.name, 'Album');
  assert.equal(inspected.json.totalLength, one.length + two.length);
  assert.equal(inspected.json.files.length, 2);
  assert.match(inspected.json.magnet, new RegExp(`^magnet:\\?xt=urn:btih:${model.infoHash}&dn=Album&tr=`));
  const readable = await cli(['inspect', made]);
  assert.equal(readable.code, 0);
  assert.match(readable.stdout, /Album/);
  assert.match(readable.stdout, new RegExp(model.infoHash));
  assert.match(readable.stdout, /disc2\/two\.flac/, 'read as text, it lists its files');
  const magnet = await cli(['magnet', made]);
  assert.equal(magnet.code, 0);
  assert.equal(magnet.stdout.trim(), inspected.json.magnet, 'magnet prints the link alone');
  log('inspect says what a .torrent holds, as text or JSON; magnet prints its link');

  /* ---------- check ---------- */
  const good = await cli(['check', made, album, '--json']);
  assert.equal(good.code, 0, good.stderr);
  assert.equal(good.json.ok, true, 'the files it was made of are this torrent');
  assert.equal(good.json.percent, 100);
  assert.deepEqual(good.json.missingFiles, []);
  const fromParent = await cli(['check', made, tmp, '--json']);
  assert.equal(fromParent.json.ok, true, 'checked against the folder its folder is in, it finds it');
  const changed = Buffer.from(two);
  changed[100] ^= 0xff;
  writeFileSync(path.join(album, 'disc2', 'two.flac'), changed);
  const bad = await cli(['check', made, album, '--json']);
  assert.equal(bad.code, 1, 'files that are not the torrent end in an error code');
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.bad, 1, 'one piece bad');
  assert.ok(bad.json.percent < 100);
  rmSync(path.join(album, 'disc2', 'two.flac'));
  const missing = await cli(['check', made, album]);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /disc2\/two\.flac/, 'a missing file is named');
  writeFileSync(path.join(album, 'disc2', 'two.flac'), two);
  log('check: every piece good, one piece bad, a file missing, found from the folder above');

  /* ---------- edit ---------- */
  const edited = path.join(tmp, 'edited.torrent');
  const outside = await cli(['edit', made, '--add-tracker', 'udp://new.example:80', '--add-tracker', 'udp://t.example:80', '--webseed', 'https://mirror.example/', '--comment', 'changed', '-o', edited, '--json']);
  assert.equal(outside.code, 0, outside.stderr);
  const after = await readTorrent(readFileSync(edited));
  assert.equal(after.infoHash, model.infoHash, 'trackers, web seeds and comment leave the info hash alone');
  assert.equal(outside.json[0].newHash, false);
  assert.deepEqual(after.fields.trackers, [['udp://t.example:80'], ['wss://w.example'], ['udp://new.example:80']], 'a tracker it has is not added twice');
  assert.deepEqual(after.fields.webSeeds, ['https://mirror.example/']);
  assert.equal(after.fields.comment, 'changed');
  const renamed = await cli(['edit', made, '--name', 'Other', '--private', '--source', 'ABC', '-o', path.join(tmp, 'renamed.torrent'), '--json']);
  assert.equal(renamed.code, 0, renamed.stderr);
  const renamedModel = await readTorrent(readFileSync(path.join(tmp, 'renamed.torrent')));
  assert.equal(renamed.json[0].newHash, true, 'a name, the private flag or a source make another torrent, and it says so');
  assert.equal(renamed.json[0].infoHash, renamedModel.infoHash);
  assert.notEqual(renamedModel.infoHash, model.infoHash);
  assert.equal(renamedModel.fields.private, true);
  assert.equal(renamedModel.fields.source, 'ABC');
  // A batch, in place: the trackers cleared from both.
  const batchDir = path.join(tmp, 'batch');
  mkdirSync(batchDir);
  writeFileSync(path.join(batchDir, 'a.torrent'), readFileSync(made));
  writeFileSync(path.join(batchDir, 'b.torrent'), readFileSync(edited));
  const batch = await cli(['edit', path.join(batchDir, 'a.torrent'), path.join(batchDir, 'b.torrent'), '--clear-trackers', '--in-place', '--json']);
  assert.equal(batch.code, 0, batch.stderr);
  assert.equal(batch.json.length, 2);
  for (const name of ['a.torrent', 'b.torrent']) {
    assert.deepEqual((await readTorrent(readFileSync(path.join(batchDir, name)))).fields.trackers, [], `${name} has no tracker left`);
  }
  const nowhere = await cli(['edit', made, '--comment', 'x']);
  assert.equal(nowhere.code, 2, 'an edit with nowhere to write is refused');
  assert.match(nowhere.stderr, /-o|--in-place/);
  assert.equal(readFileSync(made).equals(Buffer.from(model.bytes)), true, 'and writes nothing');
  log('edit: trackers added once, web seeds, comment; a name makes another hash and says so; a batch in place');

  /* ---------- the command line itself ---------- */
  const help = await cli(['help']);
  assert.equal(help.code, 0);
  for (const command of ['status', 'list', 'add', 'select', 'remove', 'download', 'link', 'wait', 'inspect', 'create', 'check']) {
    assert.match(help.stdout, new RegExp(`\\b${command}\\b`), `help lists ${command}`);
  }
  const unknown = await cli(['frobnicate']);
  assert.equal(unknown.code, 2, 'an unknown command is a usage error');
  assert.match(unknown.stderr, /frobnicate/);
  const noFile = await cli(['inspect']);
  assert.equal(noFile.code, 2, 'a missing argument is a usage error');
  const notThere = await cli(['inspect', path.join(tmp, 'nope.torrent')]);
  assert.equal(notThere.code, 1, 'a file that is not there is an error');
  assert.match(notThere.stderr, /nope\.torrent/);
  const badOption = await cli(['list', '--bogus']);
  assert.equal(badOption.code, 2);
  const port = await closedPort();
  const down = await cli(['list', '--server', `http://127.0.0.1:${port}`]);
  assert.equal(down.code, 1, 'no server, an error');
  assert.match(down.stderr, new RegExp(`127\\.0\\.0\\.1:${port}`), 'that says where it looked');
  assert.match(down.stderr, /npm run local/, 'and how to start one');
  const fromEnv = await cli(['status'], { env: { SWARMDECK_URL: `http://127.0.0.1:${port}` } });
  assert.match(fromEnv.stderr, new RegExp(`127\\.0\\.0\\.1:${port}`), 'SWARMDECK_URL says where the server is');
  assert.equal(stdoutIsEmpty(down), true, 'and nothing on stdout');
  log('help, usage errors (exit 2), a missing file and a server that is not there (exit 1)');

  /* ---------- the MCP server ---------- */
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'mcp', 'server.mjs')],
    env: { ...process.env, SWARMDECK_URL: `http://127.0.0.1:${port}`, SWARMDECK_TOKEN: '' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'swarmdeck-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'add_transfer', 'check_torrent', 'create_torrent', 'download_files', 'edit_torrent', 'fetch_metadata', 'file_links', 'inspect_torrent',
      'list_transfers', 'pause_transfer', 'remove_transfer', 'resume_transfer', 'reveal_transfer', 'save_torrent', 'select_files',
      'swarmdeck_status', 'torrent_magnet', 'wait_transfer',
    ], 'one tool per operation');
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.remove_transfer.annotations.destructiveHint, true, 'removing is marked destructive');
    assert.equal(byName.list_transfers.annotations.readOnlyHint, true, 'listing is marked read-only');
    assert.equal(byName.inspect_torrent.annotations.readOnlyHint, true);
    assert.equal(byName.remove_transfer.inputSchema.properties.deleteFiles.default, false, 'and keeps the files unless told');
    const inspectedByMcp = await client.callTool({ name: 'inspect_torrent', arguments: { file: made } });
    assert.ok(!inspectedByMcp.isError, inspectedByMcp.content?.[0]?.text);
    const result = JSON.parse(inspectedByMcp.content[0].text);
    assert.equal(result.infoHash, model.infoHash, 'inspect_torrent reads the file');
    assert.equal(result.name, 'Album');
    const offline = await client.callTool({ name: 'list_transfers', arguments: {} });
    assert.equal(offline.isError, true, 'a server that is not there is an error the AI can read');
    assert.match(offline.content[0].text, /npm run local/);
    const madeByMcp = path.join(tmp, 'mcp.torrent');
    const mcpCreated = await client.callTool({ name: 'create_torrent', arguments: { path: album, out: madeByMcp, pieceLength: 16384, trackers: ['udp://t.example:80', 'wss://w.example'], comment: 'made here' } });
    assert.ok(!mcpCreated.isError, mcpCreated.content?.[0]?.text);
    assert.equal(JSON.parse(mcpCreated.content[0].text).infoHash, model.infoHash, 'create_torrent makes the same torrent as the CLI');
    const mcpChecked = JSON.parse((await client.callTool({ name: 'check_torrent', arguments: { file: madeByMcp, path: album } })).content[0].text);
    assert.equal(mcpChecked.ok, true);
  } finally {
    await client.close();
  }
  log('MCP: 18 tools, annotated; inspect, create and check through it; a server that is not there is an error');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function stdoutIsEmpty(r) {
  return r.stdout.trim() === '';
}

if (failed) process.exit(1);
console.log('cli: all good');
