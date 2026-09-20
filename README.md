# Phone Torrent

Download torrents from your phone's browser and save the files straight to your device.
A static web app, hosted on GitHub Pages, with no backend: the torrent is downloaded
**inside the browser** using WebRTC, kept in the browser's private storage, and then saved to
your phone either file by file or as a single `.zip`.

## Features

- **Download from a `.torrent` file, a magnet link or a bare info hash.** Pick the file from your
  phone, paste the link, or open `https://…/#magnet:?xt=…`. The file picker is deliberately
  unfiltered — iOS's Files app greys out every `.torrent` when a filter is set — and whatever you
  pick is checked by its bytes, so a file that is not a torrent is refused with an explanation.
  A link to a `.torrent` works too: paste the `https://…/x.torrent` address in the same box and the
  app fetches it (through your CORS proxy if the host blocks browser requests), keeps the bytes so a
  reload restores it offline, and tells you what went wrong if the address cannot be read.
  On Android you can also *share* a `.torrent` file or magnet link to the installed app, and
  `magnet:` links open in it once installed.
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
- **Fallbacks when nothing is found.** If a magnet link gets no metadata from peers, the
  `.torrent` is fetched from configurable torrent caches and verified against the info hash. If a
  torrent finds no peers, one tap re-fetches the public tracker list and re-announces. Any torrent
  can be given an HTTP **web seed**. An optional CORS proxy you host yourself (see `proxy/`)
  unlocks caches and seeds that block browser requests.
- **Speed limits, seeding policy, piece order.** Global download/upload limits, "keep seeding after
  a download finishes", and sequential vs rarest‑first piece selection.
- **Survives reloads.** Downloaded pieces live in the browser's Origin Private File System, and the
  torrent list, file selection and paused state are remembered.
- **Custom trackers and WebRTC configuration** (STUN/TURN), a **debug logging** switch and a
  **copy diagnostics** button for troubleshooting from a phone.
- **Private by design.** Nothing is sent to any server other than the trackers and peers that
  BitTorrent itself needs.

- **Cloud fetch for what a browser cannot reach.** A private tracker, an `http(s)://`‑only tracker or
  a swarm with no WebRTC peer is out of reach from a web page, by design. With a TorBox API key (any
  API with the same shape works — the base URL is a setting), the torrent is handed to that account,
  a real BitTorrent client downloads it there, and the phone then saves the finished file straight
  from the HTTPS link: no peers, no memory ceiling, and on iOS it lands in Files like any download.

## Important limitation: peers must speak WebRTC

A web page cannot open raw TCP or UDP sockets, so the browser can only exchange data with peers
that support **WebRTC** (other browsers running WebTorrent, WebTorrent Desktop, or "hybrid"
clients). It finds them through WebSocket (`wss://`) trackers. A torrent whose seeders are all
classic desktop clients will show *looking for peers* forever. Popular, actively seeded content
with WebTorrent‑compatible seeders works well; obscure torrents may not.

You can edit the tracker list in **Settings** (gear icon). The defaults are the public WebTorrent
trackers, plus a public list fetched automatically.

**Private‑tracker torrents cannot be downloaded peer‑to‑peer here.** A `.torrent` with the BEP 27
`private` flag may only get peers from its own tracker, which is an `http(s)://` tracker a browser
cannot announce to. The app adds such a torrent and reads its metadata, but says so at once and
never announces its info hash to the public trackers (doing so is what gets accounts banned). The
same goes for any torrent whose trackers are all `http://` or `udp://`.

### Cloud fetch: the way those torrents do work

This is what put.io and TorBox are: a real BitTorrent client running in a data centre. It has TCP,
UDP and DHT, it can announce to a private tracker, and it serves the finished file over plain
HTTPS — which is exactly what a phone browser is good at.

Settings → **Cloud fetch** takes an API key (TorBox by default; the base URL is editable, so any
API with the same shape works). Then any torrent shows **Fetch it in the cloud**:

1. The `.torrent` itself (or the magnet, when metadata has not arrived) is sent to
   `POST /v1/api/torrents/createtorrent` — the private tracker keeps seeing a normal client, with
   your passkey, from the cloud account.
2. The app polls `GET /v1/api/torrents/mylist?id=…` and shows the remote progress on the card.
3. When it is ready, each file becomes a direct link
   (`/v1/api/torrents/requestdl?token=…&torrent_id=…&file_id=…&redirect=true`). Tapping it is an
   ordinary browser download: it streams to the device, so a 900 MB file is fine on an iPhone,
   where the in‑memory saver would not be.

The key is stored on the device only, and the payload never passes through this app or its proxy.
If the API refuses browser requests (CORS), the same Settings section can route the API calls —
and only those — through your own proxy; the worker in `proxy/` forwards `Authorization` solely to
the hosts listed in its `API_HOSTS` variable.

### When a torrent is not found

The app tries, in order: the trackers you configured and the fetched public list; after the
configurable delay without metadata, the **metadata fallback sources** (torrent caches queried by
info hash, response verified against the hash); and after twice that delay without any peer, it
shows a **retry** that refreshes the tracker list and re‑announces, plus an **add web seed**
option. The Details panel's event log shows what was tried and why it failed (for example
"blocked by CORS", which the proxy in `proxy/` fixes).

### Blocked DNS

Some ISPs block tracker hostnames at the DNS level. A web page cannot pick its own DNS server, but
**Settings → Network check** resolves every tracker through DNS over HTTPS (Cloudflare 1.1.1.1,
Google or Quad9, your choice) and tries to connect to it, then tells you which trackers are simply
dead and which exist but are unreachable from your network, meaning blocked. The fix is on the
device, not in the app: Android → Settings → Network → Private DNS → `one.one.one.one`; iPhone →
the 1.1.1.1 app or Cloudflare's encrypted‑DNS profile; or set the DNS on your router. The public
tracker list itself is fetched from GitHub with two mirrors as fallback.

What no browser can do is talk to classic BitTorrent peers over UDP/TCP or query the DHT. If you
need torrents that only have such seeders, the only option is a small **bridge server** (for
example `webtorrent-hybrid` on a VPS) that downloads them the classic way and re‑seeds them over
WebRTC to this app; that is outside the scope of a static site.

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

`npm run lint` checks the sources for undefined or unused symbols. The end‑to‑end test
(`test/e2e.mjs`) starts a local WebSocket tracker and static server, seeds a two‑file torrent through
the UI of one headless browser context and downloads it in a second, phone‑sized context through the
real UI. It verifies the file list, pause/resume, the details panel, saving the `.torrent`, per‑file
save (twice), zip save (byte‑for‑byte against the seeded data), restore after reload, file selection
persistence, the delete‑all cycle, removal, the Web Share Target flow, magnet links passed in the
URL, the tracker‑list merge, the network check, metadata from a fallback source with a tampered file
rejected, the no‑peers retry, an iPhone‑emulated context (unfiltered file picker, a non‑torrent file
refused, a `.torrent` added from a URL and an unreachable URL reported, a private‑tracker torrent
explained and kept off the public trackers, and a full cloud‑fetch round trip against a stand‑in
API: submit, poll, download the file from the link, and pick the transfer back up after a reload),
and the in‑memory fallback when service workers are blocked. CI runs it on Chromium and on WebKit (`BROWSER=webkit npm test`).

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
| Web seeds (HTTP) | Yes | From the torrent or added by hand; CORS‑enabled URLs, or via your proxy |
| Fetch metadata from torrent caches | Yes | Fallback sources in Settings; verified against the info hash |
| Per‑torrent stats, ratio, trackers | Yes | Details panel |
| DHT, PeX, UDP/HTTP trackers | No | Need raw UDP/TCP sockets, impossible in a browser |
| Connecting to non‑WebRTC peers | No | Same reason; see the limitation above |
| Background downloads with the screen off | Partially | Wake lock keeps the screen on; browsers suspend background tabs |
| RSS, search, scheduler, IP filter, proxy | No | Out of scope for a static web app |

## Browser support

Recent Chrome/Edge/Firefox on Android and desktop, and Safari 16.4+ on iOS. Everything degrades
gracefully: without OPFS the pieces are kept in memory, and without a service worker files are
assembled in memory before saving, which limits the practical file size on phones.

**iOS (Safari, Brave, Chrome, Firefox).** Every browser on iOS runs Apple's WebKit engine, so they
all behave like Safari here: WebRTC and the app itself work, "Add to Home Screen" installs it, and
saved files are assembled in memory then handed to the download popup or, in the installed app, to
the share sheet (choose "Save to Files"). That memory step caps the practical file size at what the
device can hold, roughly one to two gigabytes. Share Target and `magnet:` protocol handling are not
available on iOS, so use the file picker or paste the link — the picker sets no `accept` filter,
because iOS maps it to UTIs and `.torrent` has none, which would leave every `.torrent` greyed out
in Files. In Brave, if no peers ever connect,
lower Shields for the site: aggressive blocking can interfere with tracker connections. CI runs the
whole end‑to‑end suite on WebKit as well as Chromium, including an iPhone‑emulated context. Keep the tab in the foreground while downloading: mobile
browsers throttle or suspend background pages, which is why the wake lock option exists.
