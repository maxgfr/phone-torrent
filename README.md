# Phone Torrent

Download torrents from your phone's browser and save the files straight to your device.
A static web app, hosted on GitHub Pages, with no backend: the torrent is downloaded
**inside the browser** using WebRTC, kept in the browser's private storage, and then saved to
your phone either file by file or as a single `.zip`.

## Features

- **Download from a `.torrent` file, a magnet link or a bare info hash.** Pick the file from your
  phone, paste the link, or open `https://…/#magnet:?xt=…`. On Android you can also *share* a
  `.torrent` file or magnet link to the installed app, and `magnet:` links open in it once installed.
- **Choose the files you want.** Untick a file and its pieces are not downloaded.
- **Save file by file** or **save everything as one `.zip`** (folder structure preserved).
  A small service worker turns each save into a normal browser download, so multi‑gigabyte files never
  have to fit in memory. Browsers without service workers fall back to building the file in memory.
- **Seed and share.** Turn files on your phone into a torrent and send the link with the system
  share sheet; whoever opens it downloads straight from your browser. CORS‑enabled remote URLs can be
  seeded too. The `.torrent` file and magnet link are one tap away.
- **Pause / resume**, **remove**, per‑torrent and total **download / upload speed**, ETA and peer
  counts, and a **details panel** with info hash, ratio, pieces, trackers and an event log.
- **Installable PWA.** Proper icons, offline app shell, an **Install** button on Android and a hint on
  iOS ("Add to Home Screen"). Big touch targets, dark mode, safe‑area aware, and an optional
  **screen wake lock** so the phone does not suspend a running download.
- **Automatic trackers, like qBittorrent.** Your own tracker list is added to every torrent, and a
  public list of WebSocket trackers is fetched and merged automatically (refreshed every 6 hours).
- **Speed limits, seeding policy, piece order.** Global download/upload limits, "keep seeding after
  a download finishes", and sequential vs rarest‑first piece selection.
- **Survives reloads.** Downloaded pieces live in the browser's Origin Private File System, and the
  torrent list, file selection and paused state are remembered.
- **Custom trackers and WebRTC configuration** (STUN/TURN), a **debug logging** switch and a
  **copy diagnostics** button for troubleshooting from a phone.
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

`.github/workflows/deploy.yml` publishes the site automatically on every push to `main` (and on
manual dispatch). One‑time setup: open **Settings → Pages** and set **Source** to **GitHub Actions**.
GitHub does not let a workflow token create the Pages site itself, so the first deploy run fails at
the "configure-pages" step until that switch is flipped; after that every push to `main` goes live at
`https://<user>.github.io/<repo>/`.

The deploy job deliberately does not declare `environment: github-pages`. Declaring it makes GitHub
apply the environment's "deployment branches" rule, which is pinned to whatever branch was the
default when Pages was enabled, and the job then fails instantly if that is not `main`.

### Custom domain (DNS)

1. At your DNS provider, add a `CNAME` record for the subdomain you want (for example
   `torrent.example.com`) pointing to `<user>.github.io`. For an apex domain (`example.com`) add
   `A` records to `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   (and optionally `AAAA` records to GitHub's IPv6 addresses).
2. In **Settings → Pages → Custom domain**, enter the domain and save. GitHub verifies the DNS,
   issues a certificate, then tick **Enforce HTTPS**. Service workers, WebRTC and the share target
   all require HTTPS, so this step matters.
3. With the GitHub Actions source, no `CNAME` file in the repository is needed; the setting is
   stored by GitHub.

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
two‑file torrent through the UI of one headless Chromium context and downloads it in a second,
phone‑sized context through the real UI. It verifies the file list, pause/resume, the details panel,
saving the `.torrent`, per‑file save, zip save (byte‑for‑byte against the seeded data), restore
after reload, removal, the Web Share Target flow, magnet links passed in the URL, and the in‑memory
fallback when service workers are blocked.

To try it against the real network, seed something with the app on one device (or with any
WebTorrent‑compatible client) and open the shared link on your phone; public trackers are not
reachable from the sandbox this was developed in, so real‑world peer discovery is the one thing the
automated test cannot cover.

## How it works

| Part | Role |
| --- | --- |
| `index.html`, `styles.css` | Mobile‑first UI |
| `app.js` | Wires the UI to a WebTorrent client: adding, seeding, selection, pause/resume, sharing, settings, wake lock, persistence |
| `saver.js` | Hands a `ReadableStream` to the service worker, or falls back to a Blob download |
| `sw.js` | Turns a page stream into an HTTP response with `Content-Disposition: attachment`; receives Web Share Target posts |
| `vendor/webtorrent.min.js` | WebTorrent 3 browser bundle (MIT) |
| `vendor/client-zip.js` | Streaming zip writer, store mode (MIT) |

## Compared with qBittorrent

| qBittorrent feature | Phone Torrent | Notes |
| --- | --- | --- |
| Add by magnet / info hash / .torrent | Yes | Also share‑to‑app and `magnet:` links on Android |
| Automatically add trackers | Yes | Your list plus a fetched public list of `wss://` trackers |
| Select files to download | Yes | |
| Pause / resume / remove | Yes | |
| Global speed limits | Yes | Settings |
| Sequential download | Yes | Default; rarest‑first available |
| Seeding, create torrent | Yes | "Seed & share" tab; only while the page is open |
| Web seeds (HTTP) | Yes | When the torrent lists CORS‑enabled URLs |
| Per‑torrent stats, ratio, trackers | Yes | Details panel |
| DHT, PeX, UDP/HTTP trackers | No | Need raw UDP/TCP sockets, impossible in a browser |
| Connecting to non‑WebRTC peers | No | Same reason; see the limitation above |
| Background downloads with the screen off | Partially | Wake lock keeps the screen on; browsers suspend background tabs |
| RSS, search, scheduler, IP filter, proxy | No | Out of scope for a static web app |

## Browser support

Recent Chrome/Edge/Firefox on Android and desktop, and Safari 16.4+ on iOS. Everything degrades
gracefully: without OPFS the pieces are kept in memory, and without a service worker files are
assembled in memory before saving, which limits the practical file size on phones. Share Target and
`magnet:` protocol handling are Android/Chromium features; iOS Safari does not offer them, so use the
file picker or paste the link there. On iOS, saved files are assembled in memory and handed to the
share sheet (choose "Save to Files"), because Safari has no download manager for streamed files. Keep the tab in the foreground while downloading: mobile
browsers throttle or suspend background pages, which is why the wake lock option exists.
