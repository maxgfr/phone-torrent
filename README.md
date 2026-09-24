# Phone Torrent

Torrents on a phone, from a web page. Add a `.torrent` or a magnet, watch it arrive, save the files
to the device — and when the swarm is one a browser cannot reach, hand the same torrent to a real
client: one you run in a container, or an account you already pay for.

The page itself is static — HTML, CSS and two vendored libraries, hosted on GitHub Pages. Everything
else is optional and yours: nothing is enabled until you give it a key or an address.

## Four ways to use it

| | what you need | private and `http(s)` trackers | best for |
|---|---|---|---|
| **1. The page alone** — [maxgfr.github.io/phone-torrent](https://maxgfr.github.io/phone-torrent/) | nothing | no — a browser cannot reach those swarms | torrents with WebRTC peers, and seeding from your phone |
| **2. Your own server** | one `docker compose up -d` on a machine you own | yes — a real client, TCP, UDP and DHT | everything, with the files staying on your disk |
| **3. A quick deploy** | one click: Render, Fly, or Cloudflare | yes | a phone, from anywhere, with no machine at home |
| **4. A cloud service** | a TorBox, put.io, Real‑Debrid or AllDebrid key | yes | no machine and no deploy at all |

They are the same page. **Settings → Cloud fetch** takes one service, one key and one address, and
the **Cloud** tab drives whatever is behind it. With neither, the app is the page alone.

---

## 1. The page alone

The torrent is downloaded **inside the browser** over WebRTC, kept in the browser's private storage,
and saved to the device file by file or as one `.zip`.

- **Add a `.torrent`, a magnet, an info hash, or a `.torrent` link.** Pick the file, paste the link,
  or open `https://…/#magnet:?xt=…`. The picker sets no `accept` filter on purpose — iOS maps
  `accept` to UTIs, `.torrent` has none, and a filter greys out every one of them in Files — so what
  you picked is judged by its bytes instead, and anything that is not a torrent is refused with a
  reason. A `https://…/x.torrent` address is fetched by the app itself (through your CORS proxy if
  the host refuses browser requests), and its bytes are kept so a reload restores it offline.
  A magnet that cannot work — cut short in a chat, with no info hash, or BitTorrent v2 only — is
  refused with the reason, and stays in the box to be fixed. On Android you can also *share* a
  `.torrent`, a magnet or a link to a `.torrent` into the installed app, which says so when a share
  holds nothing it can add. On desktop Chrome and Edge, `magnet:` links open in the installed app;
  no Android browser hands them to a web app, so there it is share or paste.
- **Choose the files you want.** Untick one and its pieces are never requested.
- **Save file by file, or everything as one `.zip`** with the folder structure. A service worker
  turns each save into an ordinary browser download, so a multi‑gigabyte file never has to fit in
  memory; without a service worker the app falls back to building it in memory. A button stays busy
  for as long as its save runs, so a second tap does not start a second download.
- **Seed and share.** Turn files on the phone into a torrent, and its card opens on the link, selected,
  as soon as it is ready; send it with the system share sheet, and whoever opens it downloads
  straight from your browser. Several files are named as one collection ("Shared files" unless you
  say otherwise; Cancel there seeds nothing). A CORS‑enabled remote URL can be seeded too. The
  `.torrent` and the magnet are one tap away.
- **Share hands you the link.** Not a message saying it was copied: the app link and the magnet, both
  shown, selected and one tap from the clipboard — plus the system share sheet where there is one, and
  **Save .torrent**. Every torrent can be shared, not only the ones you seed.
- **Pause, resume, remove**, per‑torrent and total speeds, ETA, peer counts, and a details panel with
  the info hash, ratio, pieces, trackers and an event log. Pausing really pauses: a connection that
  was already in flight is dropped rather than allowed to resume the transfer — and it stays paused
  when the metadata arrives from a cache or the torrent is retried. Resuming brings back its web
  seeds, the torrent's own and any added by hand. Removing a torrent in one open copy of the app (a
  second tab, a link opened in the browser beside the installed app) removes it from the others.
- **Installable.** Proper icons, an offline app shell, an **Install** button on Android and the
  "Add to Home Screen" hint on iOS. Dark mode, big touch targets, safe‑area aware, and an optional
  **wake lock** so the screen staying on keeps the download alive — held only while something can
  still arrive: not with every file unticked, and not for a private torrent the page cannot reach.
- **Automatic trackers**, as qBittorrent does it: your list plus a public list of `wss://` trackers,
  fetched and merged every six hours.
- **Fallbacks.** No metadata from peers → the `.torrent` is fetched from configurable caches and
  checked against the info hash; or add the `.torrent` yourself, and it fills in the magnet's card.
  No peers at all → one tap refreshes the tracker list and
  re‑announces, or adds an HTTP **web seed**.
- **Survives reloads, and comes back from a freeze.** Pieces live in the Origin Private File System;
  the list, the file selection and the paused state are remembered. And because a phone freezes a tab
  it cannot see — killing the WebRTC connections and the tracker's socket with it — returning to the
  page makes every unfinished torrent ask its trackers again straight away, rather than waiting out
  BitTorrent's own timers; anything still alone a few seconds later has its discovery rebuilt. The
  same happens when the network comes back. The card says `reconnecting` while it does, and the event
  log records it. A seed still being hashed and a torrent still checking the pieces it has are not
  looking for peers yet, and are left to finish. With no network at all, the card and the top bar
  say `offline`, and the metadata caches are left alone until it is back.
- **Settings with two levels.** **Simple** — the default — shows what decides whether this works:
  the cloud service and its key, whether to keep seeding, the screen lock, and the stored data.
  Nothing behind **Expert** has to be touched to download anything; it holds the trackers, the
  metadata fallbacks, the network check, speed limits, piece order, the CORS proxy, the WebRTC
  configuration and the debug switch, for when a default is wrong for you. The choice is remembered.
  Your own server's address stays in Simple, because for that one the address *is* the setting — and
  so does **pick up where it left off**, which is what makes leaving the app and coming back work.
  **Cancel** leaves everything as it was, a field that cannot be saved included: an iPhone has no
  Escape key.

### What the page alone cannot do, and why

A web page has no raw TCP or UDP sockets, so it can only exchange data with peers that speak
**WebRTC** — other browsers, WebTorrent Desktop, hybrid clients — found through `wss://` trackers.
A torrent seeded only by classic clients will sit at *looking for peers* for ever. There is no DHT
and no PEX either.

**A private‑tracker torrent therefore cannot download here at all.** With the BEP 27 `private` flag,
only its own tracker may hand out peers, and that tracker is `http(s)://`, which a page cannot
announce to. The app says so the moment you add one, rather than spinning — and it never announces a
private info hash to the public trackers, because that is what gets accounts banned. The same is
true of any torrent whose trackers are all `http://` or `udp://`.

That is the wall the other three ways exist to cross.

---

## 2. Your own server

```sh
docker compose up -d          # then open http://localhost:8080
```

One container holds a real BitTorrent client, its HTTP API, and this app — on the same origin, so
there is no CORS to configure and nothing else to deploy. Open it and the app already knows where
its server is: the address field can stay empty, because empty means *this page*.

Set `AUTH_TOKEN` before the server is reachable by anyone else, and put the same value in the app as
the key. Until you name one in `ALLOWED_ORIGINS`, no other website can call it from your browser.
Without a token it answers only at `localhost` or an IP address, which keeps out a site that points
its own domain name at your machine; to reach it by a name such as `nas.local`, set a token or list
the name in `ALLOWED_HOSTS`.
Forward `6881` (TCP and UDP) and `6882` (UDP) and peers can connect to you, not only you to them.
[`server/README.md`](server/README.md) documents the API and every setting.

Away from home, without opening a port:

```sh
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml logs cloudflared | grep trycloudflare.com
```

Every command about the tunnel takes both files, `down` included. That address is public, so
`AUTH_TOKEN` is no longer optional.

## 3. A quick deploy

| | what it gives you | what it costs |
|---|---|---|
| [**Render**](https://render.com/deploy?repo=https://github.com/maxgfr/phone-torrent) | a disk that persists, an HTTPS address, a token it generates for you | a paid plan for the disk |
| **Fly** — `fly launch --no-deploy && fly secrets set AUTH_TOKEN=… && fly deploy` | a disk that persists (10 GB, and it can grow) and a machine that never stops, so a download carries on and keeps seeding with the phone off; like Render, it reaches peers by connecting out to them | a card on file; the disk is billed by size |
| **Cloudflare** — `cd cloudflare && npm install && npx wrangler secret put AUTH_TOKEN && npx wrangler deploy` | the quickest start, no server of your own (Docker, once, to build the image) | Workers paid plan; an ephemeral disk, emptied once half an hour passes with no download running and the app closed; no UDP and no inbound port — [the details](cloudflare/README.md) |

All three build the same `server/Dockerfile`. The image is also published for `amd64` and `arm64` at
`ghcr.io/maxgfr/phone-torrent:latest`, which is what `docker compose` pulls.

## 4. A cloud service

The same idea, run by someone else: a real client in a data centre that can announce to a private
tracker, and serves the finished file over plain HTTPS — which is what a phone browser is good at.

The **Cloud** tab is a client for the account: send a magnet or a `.torrent` straight to it with no
local torrent at all, watch the transfers, open one to see its files, **play video and audio in the
page**, save a file, copy its link, or delete the transfer. On a torrent the page could not reach,
**Fetch it in the cloud** on the card does the same thing for that torrent — the `.torrent` itself is
submitted, so a private tracker keeps seeing a normal client with your passkey.

Five services, five dialects, one table in the app:

| | submit | watch | the link per file |
|---|---|---|---|
| **TorBox** | `POST /v1/api/torrents/createtorrent`; with every slot taken it is queued, and followed in `/v1/api/queued/getqueued` until it starts | `/v1/api/torrents/mylist` | `requestdl?token=…&redirect=true`, once the torrent is done |
| **put.io** | `POST /v2/files/upload` (on `upload.put.io`; a custom address gets it itself), or `/v2/transfers/add` | `/v2/transfers/{id}` | `/v2/files/{id}/download?oauth_token=…` |
| **Real‑Debrid** | `addMagnet` / `addTorrent`, then `selectFiles` — without which it downloads nothing; if RD refuses that call, the files are chosen when the torrent is next seen waiting | `/torrents/info/{id}`; the library reads `/torrents` a hundred at a time | `unrestrict/link`, resolved when the transfer turns ready, under three a second and once a session |
| **AllDebrid** | `/v4/magnet/upload`, or `/v4/magnet/upload/file` | `/v4.1/magnet/status` | `/v4/link/unlock` for every file, eight a second and once a session; its nested folders are flattened |
| **Your own server** | `POST /api/transfers` | `/api/transfers/{infoHash}` | `/api/transfers/{id}/files/{i}`, signed for that one file, with `Range` |

The library polls while something is running and leaves the API alone once nothing is — a transfer
that failed is not running. A card follows its transfer through calls that fail but may work next
time — a dropped network, a service answering 429 or 5xx, or Cloudflare's error page in front of it:
it says the service is busy or down and asks again, less often each time, up to once a minute. Only
an answer that will not change stops it, such as a key refused or a transfer the service no longer
knows. A transfer that failed or is gone can be replaced with **Send to the cloud again** on its card,
and deleting a transfer in the library lets go of the card that sent it. A file the service refuses a
link for is shown with the reason, and asked for again; the others keep theirs. Playback is a plain
`<video>`/`<audio>` on the same direct link, so seeking is whatever the other end supports, and the
next poll leaves a playing video alone. Each transfer remembers the service it started on, and each
service keeps its own key and address in Settings, so switching services does not break older links;
the library shows only the service chosen now. The key stays on the device, and no
payload ever passes through this app. If an API refuses browser requests, the call is retried through
your own CORS proxy automatically — the worker in [`proxy/`](proxy/) forwards `Authorization` only to
the hosts in its `API_HOSTS` variable.

**A TorBox or put.io link is your key.** Their file links carry it — TorBox's permalink as `token=`,
put.io's download link as `oauth_token=` — because that is what lets a `<video>` or a download follow
them without an API call. Anyone who has such a link can use your whole account, so **Copy link** is
for your own devices, not for sharing. Real‑Debrid and AllDebrid links carry no key, and your own
server hands out a link signed for one file, which opens that file for a day and nothing else.

---

## When something does not work

**No peers, no metadata.** The event log in the details panel says what was tried: the trackers, then
the metadata caches, then the retry. "Blocked by CORS" there means the proxy in [`proxy/`](proxy/)
would fix it.

**Your own server answers 403.** With no `AUTH_TOKEN` it answers only at `localhost` or an IP
address, not at a name such as `nas.local` or a tunnel's address: set a token (the app takes it as
the key), or list the name in `ALLOWED_HOSTS`.

**The installed app cannot reach your own server** ("CORS or network") while the page the server
serves can: name the installed app's origin in `ALLOWED_ORIGINS`, e.g. `https://<user>.github.io`.
The server logs the origins it took when it starts.

**Your own server does not start**, and its log says `cannot write downloads to DOWNLOAD_DIR`: the
directory, or a disk mounted over it, belongs to another user. The image hands its download directory
to the user it runs as (uid 10001) by itself, a disk mounted there included; run any other way, give
the directory to the user that runs the server.

**Cloudflare answers `503`, "no AUTH_TOKEN is set".** It will not start the server without one: run
`npx wrangler secret put AUTH_TOKEN` in `cloudflare/`.

**Blocked DNS.** Some ISPs blackhole tracker hostnames. **Settings → Network check** resolves each
tracker over DNS‑over‑HTTPS (Cloudflare, Google or Quad9) and tries to connect, then tells you which
are dead and which exist but are unreachable from your network — the second is blocking. The fix is
on the device: Android → Private DNS → `one.one.one.one`; iPhone → the 1.1.1.1 app or Cloudflare's
encrypted‑DNS profile; or your router.

**A phone that suspends the tab.** No web page downloads while you are in another app: the browser
freezes it. What the app can do is come back quickly, and it does — see "comes back from a freeze"
above. Keep the tab in front and the wake lock on for a download you are watching; for one you are
not, use your own server or a cloud service, where the download does not depend on the phone at all.
That difference is the honest reason the other three ways exist.

## Browsers

Recent Chrome, Edge and Firefox on Android and desktop; Safari 16.4+ on iOS. Everything degrades:
without OPFS the pieces stay in memory, without a service worker files are assembled in memory before
saving.

**A secure page**, HTTPS or `localhost`, is the one thing that does not degrade: WebTorrent hashes
every piece with `crypto.subtle`, which a browser gives only to a secure page. Opened over plain
`http://` from any other address — your own server on the phone at `http://192.168.1.20:8080` — the
Download and Seed tabs say so and offer nothing that could only fail, and the Cloud tab works as
anywhere else. Reach the server through its tunnel, or a deploy, for the rest.

**iOS**, where every browser is WebKit: the app, WebRTC and "Add to Home Screen" all work, and a save
is assembled in memory then handed to the download popup — or, in the installed app, to the share
sheet ("Save to Files"). That memory step caps a practical save at what the device can hold, one or
two gigabytes. Share Target does not exist on iOS, and `magnet:` links open an installed web app only
on desktop Chrome and Edge, so on an iPhone use the picker or paste the link. A file from one of the
other three ways has no such cap: it is an ordinary download.
In Brave, if nothing ever connects, lower Shields for the site.

## Tests

```sh
npm run lint          # undefined and unused symbols, across the app, the server and the tests
npm test              # the app, in a real browser
npm run test:server   # the server, against a real peer
```

`test/e2e.mjs` boots a WebSocket tracker and a static server, seeds a two‑file torrent through the
UI of one browser context and downloads it in a second, phone‑sized one — the real UI throughout. It
covers the file list, pause/resume, coming back from a frozen tab (the page is hidden, then shown,
and the torrent must go looking for peers by itself), the share panel (the real link, selected, and
the copy button answering on itself), Simple hiding every expert setting while Expert shows them and the choice
surviving a reload, the details panel, saving the `.torrent`, per‑file save (twice),
zip save byte‑for‑byte, restore after reload, file‑selection persistence, the delete‑all cycle,
removal, the Web Share Target, magnets in the URL and in the fragment, the tracker‑list merge, the
network check, metadata from a fallback source with a tampered file rejected, the no‑peers retry,
and an iPhone‑emulated context: the unfiltered picker, a non‑torrent file refused, a `.torrent` added
from a URL, an unreachable URL reported, a private torrent explained and kept off the public
trackers, two complete cloud round trips against stand‑ins speaking TorBox's and put.io's own wire
formats, the whole cloud library (account line, listing, a file downloaded from its link
byte‑for‑byte, a magnet sent with nothing added locally, a delete that cancels the transfer and drops
its file), and the Real‑Debrid and AllDebrid mappings against stand‑ins speaking theirs — a TorBox
torrent that waits in the queue, an AllDebrid `.torrent` upload and a sixty‑file season, Real‑Debrid
through the CORS proxy worker, cloud transfers that keep their service across a switch and a reload,
a video that keeps playing through the library's polls, and a key tested then cancelled. Then cloud
fetch on a bad day, against a TorBox scripted call by call: a 503 or 502 page in the middle of a
transfer or of its wait in the queue, asked again until it is ready; a failed transfer sent again, and
one deleted in the library or on the service let go of; files offered only once they are done; and a
switch of service whose first listing fails. Against Real‑Debrid, a refused `selectFiles` that still
sends the torrent once and starts it, a twenty‑file pack whose links come paced with one refused, and
an account of more torrents than one page. And a torrent's life around all that: a paused magnet staying paused through a metadata fallback and a
retry, the screen lock held for a download and let go for nothing selected or a private torrent, an
unreachable torrent's explanation surviving a reload and a retry, the `.torrent` for a waiting magnet
filling in its card, the network coming back while a seed is hashing and a restore is checking its
pieces (hashing is held in place for as long as that takes) with only the torrent waiting for peers
rebuilt and no "finished" for what had finished before, a removal in one open copy of the app
reaching another, and web seeds on a slow mirror kept through a pause, a reload and a "keep seeding"
stop.

Around the edges of the app itself: a seed's name cancelled (nothing is seeded) and a seed opening on
its link; a save and a zip still busy through the redraws while they run; a `.torrent` link and a
base32 info hash shared into the app, and a share with nothing to add explained; magnets cut short,
without an info hash or v2‑only refused with the reason and left in the box, and a capital `M`
accepted; Settings cancelled with no keyboard, past a field that cannot be saved; a page that is not
secure (plain `http` at a name that is not `localhost`) saying why only the Cloud tab works; a page
served by your own server taking it as the service with nothing set, and one that is not keeping
its default; a card and a top bar that say `offline`, caches that wait for the network, and the
network's return waking the torrent; and `npm start` staying on loopback unless `HOST` says
otherwise, and then serving no dotfiles and no `node_modules`.

And how it looks: error toasts, primary buttons and muted text at 4.5:1 or better in light and dark;
at 320px, a top bar at its fullest (the widest speeds and Install) with nothing drawn over anything,
and a share panel and a cloud library link that stay on the screen, also at the 16px iOS gives text
fields (the suite applies the stylesheet's iOS‑only rules to check that); and, for the installed
iPhone app, Cancel in reach beside a long release name on the save bar, and something dark under
its white status bar in either colour scheme.

`test/server.mjs` is the other half, with no browser anywhere: a plain BitTorrent client seeds a file
over an http tracker, the server is asked for it through its API, and the file comes back out whole
and by `Range` (suffix ranges and ranges past the end included), byte for byte, through the token and
through a signed link, before being deleted. On the way it is sent requests it cannot parse and
torrents that are not torrents, and must answer them; it must not serve its downloads as static files,
nor answer another origin; it refuses a torrent that would overwrite its list of transfers; and it is
restarted, and picks the transfer up again. CI runs both on Chromium and on WebKit
(`BROWSER=webkit npm test`), and publishes the server image on every change to it.

Real‑world peer discovery is the one thing the suite cannot cover: public trackers are unreachable
from the sandbox this was developed in.

## Running locally

```sh
npm install
npm start            # the page alone, at http://localhost:8080
```

`npm start` listens on this machine only. `HOST=0.0.0.0 npm start` lets a phone on the same network
in, at the address it prints, and then serves the app and nothing else of the checkout — no
dotfiles, no `node_modules`. That is plain `http` at an address that is not `localhost`, so not a
secure page: the Cloud tab works there, while in-browser torrents and streaming saves need HTTPS or
`localhost` (see [Browsers](#browsers)). There is no build step: plain HTML, CSS and ES modules, with
WebTorrent and client‑zip vendored in `vendor/`.

## Deploying the page to GitHub Pages

`.github/workflows/deploy.yml` publishes on every push to `main`. One‑time setup: **Settings → Pages
→ Source → GitHub Actions**. GitHub will not let a workflow token create the Pages site itself, so
the first run fails at "configure-pages" until that switch is flipped.

The job deliberately does not declare `environment: github-pages`: that would apply the environment's
"deployment branches" rule, pinned to whatever branch was default when Pages was enabled, and fail
instantly if that is not `main`.

**A custom domain**: add a `CNAME` for the subdomain pointing at `<user>.github.io` (or `A` records
to `185.199.108.153`, `.109.153`, `.110.153`, `.111.153` for an apex), enter it in **Settings → Pages
→ Custom domain**, then tick **Enforce HTTPS** — service workers, WebRTC and the share target all
require it.

## What is in here

| | |
|---|---|
| `index.html`, `styles.css` | the mobile‑first UI |
| `app.js` | the client: adding, seeding, selection, pause/resume, sharing, settings, persistence, and the cloud provider table |
| `saver.js` | hands a `ReadableStream` to the service worker, or falls back to a Blob |
| `sw.js` | turns that stream into a download, and receives Web Share Target posts |
| `server/` | the real BitTorrent client, its API and its Dockerfile |
| `cloudflare/` | the Worker and container config for `wrangler deploy` |
| `proxy/` | the optional CORS proxy, as a Cloudflare Worker |
| `vendor/` | WebTorrent and client‑zip, vendored (MIT) |

## Compared with qBittorrent

| | the page alone | with a server or a service |
|---|---|---|
| Add by magnet, info hash or `.torrent` | yes | yes |
| Automatic trackers | yes | n/a |
| Select the files to download | yes | on the page; the server fetches the whole torrent |
| Pause, resume, remove | yes | remove, on the account |
| Speed limits, sequential download | yes | the service's own settings |
| Seeding, creating a torrent | yes, while the page is open | the server keeps seeding after a download |
| Web seeds | yes | n/a |
| DHT, PEX, `udp://` and `http(s)://` trackers | **no** — impossible in a browser | **yes** |
| Private trackers | **no** | **yes** |
| Downloading with the phone asleep | no | **yes** — nothing depends on the phone |
| RSS, search, scheduler, IP filter | no | no |

## Privacy

The page talks to the trackers and peers BitTorrent needs, and beyond them only to:

- the public list of `wss://` trackers, fetched from GitHub (or its jsDelivr and Statically mirrors)
  every six hours — **Settings → Expert** turns it off or points it somewhere else;
- for a magnet whose metadata no peer delivers, the torrent caches that serve a `.torrent` by info
  hash (`itorrents.org` and `torrage.info`), which therefore learn that info hash — the list is in
  **Settings → Expert**, and an empty one asks nobody. A `.torrent` you add, private or not, never
  goes there: it already has its metadata;
- the DNS‑over‑HTTPS resolver you choose, and only when you run the network check;
- the STUN servers WebRTC asks for your public address as it connects to peers, which therefore see
  that address, and when you download or seed: Google's (`stun.l.google.com`) and Twilio's
  (`global.stun.twilio.com`) unless **Settings → Expert → WebRTC configuration** names others.

A cloud key is stored
on the device and sent only to that service (or, if you turn it on, through your own proxy) — and,
for TorBox and put.io, inside the file links, as above. The
files a cloud service or your own server holds are downloaded straight from it by the browser: they
never pass through this app.
