# Phone Torrent

Download torrents from your phone's browser and save the files straight to your device.
A static web app, hosted on GitHub Pages, with no backend: the torrent is downloaded
**inside the browser** using WebRTC, kept in the browser's private storage, and then saved to
your phone either file by file or as a single `.zip`.

## Features

- **Add torrents** by picking a `.torrent` file from your phone, pasting a magnet link or info
  hash, or opening the app with a magnet in the URL fragment (`https://…/#magnet:?xt=…`).
- **Choose the files you want.** Untick a file and its pieces are not downloaded.
- **Save file by file** or **save everything as one `.zip`** (folder structure preserved).
- **Streams to the download manager.** A small service worker turns each save into a normal
  browser download, so multi‑gigabyte files never have to fit in memory. Browsers without
  service workers fall back to building the file in memory.
- **Survives reloads.** Downloaded pieces live in the browser's Origin Private File System, and the
  torrent list is remembered, so closing the tab does not lose progress.
- **Installable.** Comes with a web manifest, so you can "Add to Home Screen".
- **Private by design.** Nothing is sent to any server other than the trackers and peers that
  BitTorrent itself needs.

## Important limitation: peers must speak WebRTC

A web page cannot open raw TCP or UDP sockets, so the browser can only exchange data with peers
that support **WebRTC** (other browsers running WebTorrent, WebTorrent Desktop, or "hybrid"
clients). It finds them through WebSocket (`wss://`) trackers. A torrent whose seeders are all
classic desktop clients will show *looking for peers* forever. Popular, actively seeded content
with WebTorrent‑compatible seeders works well; obscure torrents may not.

You can edit the tracker list in **Settings** (gear icon). The defaults are the public WebTorrent
trackers.

## Deploying to GitHub Pages

1. Push this repository to GitHub (the default branch is `main`).
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Every push to `main` runs `.github/workflows/deploy.yml`, which publishes the site to
   `https://<user>.github.io/<repo>/`.

No build step is needed. The site is plain HTML, CSS and ES modules; the two libraries it uses
(WebTorrent and client‑zip) are vendored in `vendor/`.

## Running locally

```sh
npm install
npm start            # serves the app at http://localhost:8080
```

Service workers require HTTPS or `localhost`, so open it via `localhost`, not a LAN IP, if you want
streaming saves during development.

## Tests

```sh
npm test
```

The end‑to‑end test (`test/e2e.mjs`) starts a local WebSocket tracker and static server, seeds a
two‑file torrent from one headless Chromium context and downloads it in a second, phone‑sized
context through the real UI. It verifies the file list, per‑file save, zip save (byte‑for‑byte
against the seeded data), restore after reload, removal, and the in‑memory fallback when service
workers are blocked.

## How it works

| Part | Role |
| --- | --- |
| `index.html`, `styles.css` | Mobile‑first UI |
| `app.js` | Wires the UI to a WebTorrent client, tracks selection, persists the torrent list in IndexedDB |
| `saver.js` | Hands a `ReadableStream` to the service worker, or falls back to a Blob download |
| `sw.js` | Turns a page stream into an HTTP response with `Content-Disposition: attachment` |
| `vendor/webtorrent.min.js` | WebTorrent 3 browser bundle (MIT) |
| `vendor/client-zip.js` | Streaming zip writer, store mode (MIT) |

## Browser support

Recent Chrome/Edge/Firefox on Android and desktop, and Safari 16.4+ on iOS. Everything degrades
gracefully: without OPFS the pieces are kept in memory, and without a service worker files are
assembled in memory before saving, which limits the practical file size on phones.
