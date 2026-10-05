---
name: swarmdeck
description: Use when asked to download, add, pause, resume, choose the files of, remove, save or watch a torrent or magnet link with Swarmdeck, or to inspect, edit, create, check or convert .torrent files (trackers, magnet to .torrent, a folder into a torrent).
---

# Driving Swarmdeck

Swarmdeck's server (`npm run local` on this computer, or the Docker image elsewhere) is a real
BitTorrent client with a JSON API. Two front ends drive it, both on `cli/core.mjs`:

- **MCP tools** (`swarmdeck_status`, `add_transfer`, `select_files`…), when this session lists them.
- **The CLI** otherwise: `node cli/swarmdeck.mjs <command> --json` from the repository root.
  `node cli/swarmdeck.mjs help` lists every command.

The server is `SWARMDECK_URL` (default `http://127.0.0.1:8080`), with `SWARMDECK_TOKEN` when it has
an `AUTH_TOKEN`. Put the token in the environment, never on a command line that gets logged.

## Start

1. `node cli/swarmdeck.mjs status` (or `swarmdeck_status`).
2. If nothing answers and the user means this computer, start it in the background with
   `npm run local -- --no-open` and check `status` again. Don't start one for a remote URL.

A transfer `<id>` is its info hash, the first characters of it, or its exact name. Its files are
numbered in `show <id>` (`list_transfers` with `id`), in torrent order: those numbers are what
`select` and `download` take. When "the first file" or "the video" is ambiguous, show the list and
say which number you picked.

## Workflows

| The user wants | Do |
|---|---|
| A magnet, everything | `add <magnet>`, then `wait <id>` (`--for done`) |
| A magnet, **paused or only some files** | `metadata <magnet> -o <tmp>/x.torrent` (`<tmp>`: your scratch folder), then `add <tmp>/x.torrent --paused`, `select <id> --only 0,2`, `resume <id>`, `wait <id>` |
| A .torrent file or its URL | `add <path or url>` (a URL needs `npm run local`) |
| Its files | `reveal <id>` on this computer; `download <id> [index] -o <dir>` from a remote server |
| To play it (VLC…) or share a file | `link <id> [index]`: an address without the token, signed for a day when the server has one; plays while downloading |
| A magnet as a .torrent | `metadata <magnet> -o <file>`, no transfer made |
| A transfer's .torrent | `torrent <id> -o <file or dir/>` |
| Trackers on many .torrent files | `edit a.torrent b.torrent --add-tracker URL --in-place` (or `-o dir/`) |
| A .torrent of a folder | `create <folder> -o x.torrent --tracker URL`, then `check x.torrent <folder>` |

Why the metadata-first row: a magnet added paused asks no one for its metadata, so its files are
unknown and cannot be chosen. Resuming it to get them starts downloading every file. `metadata`
fetches the .torrent without downloading anything (up to a minute). If it finds nobody, add
unpaused, `wait --for metadata`, then `select` immediately, and tell the user some data may already
have arrived.

`wait` ends with an error, not a hang, when the transfer is paused or failed. `--timeout` is in
seconds. Call it again rather than set a long one.

A transfer stuck below 100% with `downloadSpeed` 0 for minutes: `pause` then `resume` asks its
trackers and web seeds again, which is often all it needs.

A file left out can still show progress, even 100% for a small one: the pieces it shares with a kept
file come with it. That is expected.

The files are in the server's download folder, at their path in the torrent: `~/Downloads/Swarmdeck`
for `npm run local` unless `DOWNLOAD_DIR` says otherwise (it prints `downloads in …` at start). Tell
the user that path. `reveal` only opens it in the Finder.

## Removing

`remove <id>` takes the transfer off the server and **keeps its files**. "Take it out", "remove
it", "I'm done with it" mean exactly that. Pass `--delete-files` (`deleteFiles: true`) only when
the user explicitly asks for the downloaded files to be deleted: it cannot be undone. When the
request is unclear, keep the files and say where they are.

## Out of reach

The torrents running inside a browser tab, the page's settings, and the cloud services set up in the
page are not reachable from here. Say so rather than guess.
