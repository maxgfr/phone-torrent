# Swarmdeck

Torrents from a web page, on a phone or a computer. Add a `.torrent` or a magnet, watch it arrive,
save the files to the device; share files of your own, edit, make and check `.torrent` files — and
when the swarm is one a browser cannot reach, hand the same torrent to a real client: one you run in
a container, or an account you already pay for.

On a phone it is one column you can install like an app. On a computer it is a list of torrents beside
the one open, with a table view, a search, several selected at once, files and folders dropped
anywhere on the window, the keyboard, and files saved straight into a folder.

The page itself is static — HTML, CSS and two vendored libraries, hosted on GitHub Pages. Everything
else is optional and yours: nothing is enabled until you give it a key or an address.

## Five ways to use it

| | what you need | private and `http(s)` trackers | best for |
|---|---|---|---|
| **1. The page alone** — [maxgfr.github.io/swarmdeck](https://maxgfr.github.io/swarmdeck/) | nothing | no — a browser cannot reach those swarms | torrents with WebRTC peers, and seeding from your phone or computer |
| **2. Your own server** | one `docker compose up -d` on a machine you own | yes — a real client, TCP, UDP and DHT | everything, with the files staying on your disk |
| **3. A quick deploy** | one click or one command: Render, Fly, or Cloudflare | yes | any device, from anywhere, with no machine at home |
| **4. A cloud service** | a TorBox, put.io, Real‑Debrid or AllDebrid key | yes | no machine and no deploy at all |
| **5. On your computer** | Node 20 and a clone: `npm install && npm run local` | yes | a torrent client on your Mac, its files in `~/Downloads/Swarmdeck`, with no Docker |

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
  holds nothing it can add. On desktop Chrome and Edge, `magnet:` links open in the installed app
  (or, from **Settings → Magnet links**, in a browser tab), and so do `.torrent` files opened from
  the system; no Android browser hands them to a web app, so there it is share or paste. The card of a torrent
  you add is brought into view, below the cloud library when that is long.
- **Choose the files you want.** Untick one and its pieces are never requested.
- **Save file by file, or everything as one `.zip`** with the folder structure. A service worker
  turns each save into an ordinary browser download, so a multi‑gigabyte file never has to fit in
  memory; without a service worker the app falls back to building it in memory. A button stays busy
  for as long as its save runs, so a second tap does not start a second download.
- **Seed and share.** Turn files on this device into a torrent, and its card opens on the link, selected,
  as soon as it is ready; send it with the system share sheet, and whoever opens it downloads
  straight from your browser. A folder, picked where the browser can pick one or dropped, is shared as
  itself, subfolders and all, under its own name. Several loose files are named as one collection
  ("Shared files" unless you say otherwise; Cancel there seeds nothing). Picked again, files already being shared open the link
  of the seed there is. A seed stays a seed through a retry: never remembered, and gone with the page.
  A CORS‑enabled remote URL can be seeded too. The `.torrent` and the magnet are one tap away.
  The app makes the torrent itself, hashing the files off the page in a Worker (on the page where there
  is none), with its progress on the card — and with the defaults it is the very torrent WebTorrent's
  own seed made of the same files. **Torrent options**, folded into one line above the picker ("Auto
  pieces · public · app trackers"), change that: a preset; the trackers the file names (browsers are
  still told on the app's own, unless it is private); the piece size — Auto, mkbrr's table, a number of
  pieces or a size of your own, with a largest piece, and a private tracker's own table when its first
  tracker has one; private, source (the tracker's expected one unless you set another), comment, web
  seeds; no creation date, no *created by*; names to leave out (`*.nfo`); and **Only make the .torrent**,
  which saves the very `.torrent` sharing would have shared, and shares nothing. They are remembered,
  and another open copy follows them. A piece size of your own over the largest the tracker (or you)
  set is said before anything is made, and a `.torrent` larger than its tracker takes once it is.
- **Share hands you the link.** Not a message saying it was copied: the app link and the magnet, both
  shown, selected and one tap from the clipboard — plus the system share sheet where there is one, and
  **Save .torrent**. Every torrent can be shared, not only the ones you seed — except a private one:
  its links carry your passkey, and the copy of the app that opened one would announce its info hash
  to the public trackers, so its share panel says so and offers only the `.torrent`, which keeps the
  private flag — for your own devices, as it carries the passkey too. Nothing on its card copies a
  link either.
- **Edit a `.torrent`.** The **Edit** tab opens a `.torrent` (picked, dropped or at a link), a magnet or an
  info hash — the whole `.torrent` when the list already has that torrent — and every card has **Edit
  .torrent** beside **Save .torrent**. One form for all of it: the trackers (one per line, a blank line
  between tiers), the web seeds, the comment, *created by* and the creation date leave the torrent what
  it is, and are written around its `info` without touching a byte of it, so the info hash stays. Its
  identity — name, private flag, source, entropy — makes another torrent: the info hash is worked out
  again as you type, a **New torrent** mark and a banner say so, and making private a torrent the app is
  sharing says the public one stays out there. A key the editor does not know is kept, at the top and
  inside `info`; a BitTorrent v2 or hybrid torrent keeps its identity, which this does not rehash.
  **Add public trackers** adds the app's own, the `wss://` list and newTrackon's stable list, each once
  and a tier of its own (not for a private torrent). An inspector shows the pieces, sizes, files and
  unknown keys; **Copy magnet**, **Share…** (the `.torrent` itself, where the device shares files) and
  **Save .torrent** take the result. A magnet opens with what it has — name, trackers, web seeds — and
  **Get metadata** fetches the rest from the list, the torrent caches, or else its peers (for a minute,
  without adding it to the list); **Save .torrent** does that and saves, in one click. Your own server,
  when it is the cloud service, is asked at the same time: it reaches the DHT and the udp:// and
  http:// trackers a page cannot. A torrent cache the page may not read (CORS) is said at once, with
  three choices: open it in a tab, which saves the `.torrent` it serves as it is; set a CORS proxy,
  and it is asked again through it; or keep waiting for peers. Several `.torrent` files open
  together: each field is kept in all of them until you set it, clear it or (trackers, web seeds) add
  to it, each file says whether its info hash changes, and they are saved as one `.zip`.
  **Apply preset** fills in what a preset holds. The first tracker is matched against the rules of
  private trackers that [mkbrr](https://github.com/autobrr/mkbrr) knows — largest piece, size of the
  `.torrent`, the source they expect: shown under the trackers, a file that breaks one is said so, and
  the expected source is one tap away (never set by itself, as it makes a new torrent).
  **⋯ → Check files…** checks files against the torrent open — picked one by one, or a whole folder
  where the browser can pick one: every piece hashed again off the page, with progress and a stop, and
  the result in words — how much is good, how many pieces are bad or missing, the files not found and
  the ones of another size; "ready to seed" only when every piece is good and every file is there, at
  its size. A field left as it was opened is written back as it was, byte for byte — a name ending in a
  space, a comment with Windows line ends — so nothing untouched turns into a new torrent.
- **Pause, resume, remove**, per‑torrent and total speeds, ETA, peer counts, and a details panel with
  the info hash, ratio, pieces, trackers and an event log. Pausing really pauses: a connection that
  was already in flight is dropped rather than allowed to resume the transfer — and it stays paused
  when the metadata arrives from a cache or the torrent is retried. Resuming brings back its web
  seeds, the torrent's own and any added by hand.
- **Every open copy in step.** A second tab, or a link opened in the browser beside the installed
  app, is a second copy of the app on the same storage. One copy runs the torrents; every other one
  shows the same list as it goes — progress, peers, ticks, the log — and whatever is done there is
  done for real: add, seed, pause, tick, save (the file streams over from the copy that runs it),
  retry, remove, delete everything. Settings saved in one apply in all. Close the copy that runs the
  torrents and the next one picks them up from storage, seeds included; open or look at another
  while a phone has frozen the first, and it takes over within seconds. (Without Web Locks every
  copy runs every torrent, as before; settings still apply in all of them, and with BroadcastChannel
  a removal or a delete-all is passed on.)
- **Installable.** Proper icons, an offline app shell, an **Install** button on Android and in Chrome
  and Edge on a computer (dock, Start menu or apps list), and the "Add to Home Screen" hint on iOS. Dark mode, big touch targets, safe‑area aware, and an optional
  **wake lock** so the screen staying on keeps the download alive — held only while something can
  still arrive: not with every file unticked, and not for a private torrent the page cannot reach,
  unless a web seed is sending it.
- **Automatic trackers**, as qBittorrent does it: your list plus a public list of `wss://` trackers,
  fetched and merged every six hours, an app left open included.
- **Fallbacks.** No metadata from peers → the `.torrent` is fetched from configurable caches and
  checked against the info hash — the default one sends no CORS headers, so it answers through your
  CORS proxy; or add the `.torrent` yourself, and it fills in the magnet's card.
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
  say `offline`, and the metadata caches are left alone until it is back. The first torrent added
  asks the browser to keep that storage rather than clear it when the device runs low on space;
  **Settings → Storage** says whether it will.
- **Settings with two levels.** **Simple** — the default — shows what decides whether this works:
  the cloud service and its key, whether to keep seeding, the screen lock, and the stored data.
  Nothing behind **Expert** has to be touched to download anything; it holds the trackers, the
  metadata fallbacks, the network check, speed limits, piece order, the CORS proxy, the WebRTC
  configuration, the debug switch and the **presets** (what a tracker wants in every torrent for it —
  trackers, source, private flag, web seeds, comment, largest piece — kept under a name), for when a
  default is wrong for you. The choice is remembered.
  Your own server's address stays in Simple, because for that one the address *is* the setting — and
  so does **pick up where it left off**, which is what makes leaving the app and coming back work.
  **Cancel** leaves everything as it was, a field that cannot be saved included: an iPhone has no
  Escape key. Enter in a field, or a phone keyboard's Go, is Save. A field that cannot be used is
  never dropped on Save: a CORS proxy without `{url}` (the address its deploy prints) and a server
  address without `http://` (`192.168.1.5:8080`, `nas.local`) are mended in the field, to be saved as
  they read then, and a metadata source without `{infohash}` is named. **Copy diagnostics**, for a bug
  report, says which keys, proxy and TURN credentials are set without giving them, and an `http(s)`
  tracker by its host alone.

### On a computer

From 1024px wide the page is two panes, still one web page, nothing to install:

- **The list beside the torrent open.** One row a torrent on the left, under the ways in; the one
  open on the right, its card as on a phone, staying in view as the list scrolls. A click opens a
  row; a torrent just added, or shared, opens by itself, and a search or a filter that would hide it
  gives way; one removed hands over to the next. **Cards** shows two lines a torrent, **Table** one,
  in columns (name, size, progress, ↓, ↑, peers, ETA, state) sorted by a click on a header, and a
  narrow window keeps the columns that matter. The choice is remembered.
- **Search, filter, order** — on a phone too, where they apply to the cards. The search takes words
  from a name or an info hash; the filter (all, downloading, seeding, paused, done, problem) shows
  how many are in each; the order is when it was added, name, size, progress or speed, either way.
- **Several at once.** Shift‑click selects every row up to the one clicked, Ctrl‑ or Cmd‑click one
  more or one less, the boxes the same, the one in the header every row listed. The bar over the list
  pauses, resumes, saves their `.torrent` files (one as it is, several in one zip) or removes them,
  asking once for all. In a second open copy of the app, the same rows, and the same actions.
- **Dropped anywhere.** A file let go of anywhere on the window is taken, the window saying what it
  will do on the tab open: **Download** adds `.torrent` files, and asks before sharing anything else
  it is given; **Seed & share** shares, a folder as itself; **Cloud** sends `.torrent` files and
  magnets to the account, and says why it takes nothing else; **Edit** opens. A magnet or a link
  dropped from another page is read as a shared one. Text dropped into a field stays the field's.
- **Pasted.** Ctrl+V or Cmd+V on the page, out of any field, does what a drop would: a magnet copied
  from anywhere is added at once, with no question, since you pasted it.
- **The keyboard.** <kbd>/</kbd> the search; <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Home</kbd> <kbd>End</kbd>
  the list, with <kbd>Shift</kbd> to select as you go; <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>A</kbd> every
  torrent listed; <kbd>Space</kbd> pauses or resumes the selection, or the one open; <kbd>Delete</kbd>
  or <kbd>⌘</kbd>+<kbd>⌫</kbd> removes them; <kbd>Esc</kbd> empties the search, then the selection;
  <kbd>?</kbd> lists all this. Not in a field, nor under a dialog. The tabs take the arrow keys; the
  editor's ⋯ menu closes on <kbd>Esc</kbd> (the editor stays) and on a click away. Every control shows
  the keyboard's focus ring, and a hover only where there is a pointer.
- **Saved into a folder.** Where the browser lets a page write into a folder you pick (Chrome and
  Edge on a computer), a card offers **Save to a folder…**: its files land there as they are in the
  torrent, folders and all, each written as it arrives, never held in memory whole. Files already
  there are replaced only once you say so, and a file that comes up short is not left behind.
- **Opened by the system.** The installed app opens `.torrent` files (double‑click one, or *Open
  with*), and magnet links; both are asked about first, as anything handed over from outside is.
- **Asked before closing.** Closing or reloading the tab stops what it runs, so the browser asks
  first — only while this copy is seeding or downloading something not paused, and not when another
  open copy is waiting to take it over. The question is taken back as soon as it no longer applies,
  so the page is not kept from the browser's back/forward cache for nothing.

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
curl -fsSLO https://raw.githubusercontent.com/maxgfr/swarmdeck/main/docker-compose.yml
docker compose up -d          # then open http://localhost:8080
```

The first line fetches the compose file, which `docker compose` runs; a clone of the repository has
it too, and the tunnel below needs the clone. [`server/README.md`](server/README.md) has the same as
one `docker run`, with no file at all. A compose file fetched when the project was called Phone
Torrent names its service `phone-torrent`: fetch it again and run `docker compose up -d --remove-orphans`,
which replaces that service with this one and keeps the downloads, whose volume is still `downloads`.

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

A phone that opens it at `http://<its LAN address>:8080` can drive the server from the Cloud tab, but
not run torrents in the browser itself: that is not a secure page, and the Download, Seed and Edit
tabs say so ([Browsers](#browsers) says why). Through the tunnel below, or a deploy, it is HTTPS, and the whole
app works.

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
| [**Render**](https://render.com/deploy?repo=https://github.com/maxgfr/swarmdeck) | a disk that persists, an HTTPS address, a token it generates for you | a paid plan for the disk |
| **Fly** — `fly launch --no-deploy --copy-config --name <a-name-of-yours> && fly secrets set AUTH_TOKEN=… && fly deploy` (app names are global on Fly) | a disk that persists (10 GB, and it can grow) and a machine that never stops, so a download carries on and keeps seeding with the phone off; like Render, it reaches peers by connecting out to them | a card on file; the disk is billed by size |
| **Cloudflare** — `cd cloudflare && npm install && npx wrangler secret put AUTH_TOKEN && npx wrangler deploy` | the quickest start, no server of your own (Docker, once, to build the image) | Workers paid plan; an ephemeral disk, emptied once half an hour passes with no download getting data and no request from the app, which stops asking once nothing is downloading, open or not; no UDP and no inbound port — [the details](cloudflare/README.md) |

All three build the same `server/Dockerfile`. The image is also published for `amd64` and `arm64` at
`ghcr.io/maxgfr/swarmdeck:latest`, which is what `docker compose` pulls.

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
| **Real‑Debrid** | `addMagnet` / `addTorrent`, then `selectFiles` — without which it downloads nothing; if RD refuses that call, the files are chosen when the torrent is next seen waiting — only for the torrents the app added: one left waiting on RD's site is left to you | `/torrents/info/{id}`; the library reads `/torrents` a hundred at a time | `unrestrict/link`, resolved when the transfer turns ready, under three a second and once a session |
| **AllDebrid** | `/v4/magnet/upload`, or `/v4/magnet/upload/file` | `/v4.1/magnet/status` | `/v4/link/unlock` for every file, eight a second and once a session; its nested folders are flattened |
| **Your own server** | `POST /api/transfers` | `/api/transfers/{infoHash}` | `/api/transfers/{id}/files/{i}`, signed for that one file, with `Range` |

The library polls while something is running and leaves the API alone once nothing is — a transfer
that failed is not running. A listing that fails is said in the library itself, which is on every tab,
rather than taken for an empty account, and one that may work next time is asked again, less often
each time, and at once when the network comes back. A card follows its transfer through calls that
fail but may work next time — a dropped network, a service answering 429 or 5xx, or Cloudflare's
error page in front of it: it says the service is busy or down and asks again, less often each time,
up to once a minute. Only an answer that will not change stops it, such as a key refused or a
transfer the service no longer knows. A transfer that failed or is gone can be replaced with **Send to the cloud again** on its card;
a key refused is not that — the transfer may still be there — so the card says to fix the key, and
asks again once Settings are saved. Deleting a transfer in the library lets go of the card that sent it. A file the service refuses a
link for is shown with the reason, and asked for again; the others keep theirs. Playback is a plain
`<video>`/`<audio>` on the same direct link, so seeking is whatever the other end supports, and the
next poll leaves a playing video alone; a file the browser cannot play (an `.mkv` on Safari) says so,
and to use Save or a player app instead, while one whose connection drops mid-play says that, and
**Play** goes on from where it stopped. Each transfer remembers the service it started on, and each
service keeps its own key and address in Settings, so switching services does not break older links;
the library shows only the service chosen now. The key is stored on the device, and no
payload ever passes through this app. If an API refuses browser requests, the call is retried through
your own CORS proxy automatically, key included — the worker in [`proxy/`](proxy/) forwards
`Authorization` only to the hosts in its `API_HOSTS` variable, and a call it refuses for that says so,
with the host to add.

**A TorBox or put.io link is your key.** Their file links carry it — TorBox's permalink as `token=`,
put.io's download link as `oauth_token=` — because that is what lets a `<video>` or a download follow
them without an API call. Anyone who has such a link can use your whole account, so **Copy link** is
for your own devices, not for sharing. Real‑Debrid and AllDebrid links carry no key, and your own
server hands out a link signed for one file, which opens that file for a day and nothing else.

## 5. On your computer

```sh
git clone https://github.com/maxgfr/swarmdeck && cd swarmdeck
npm install
npm run local                 # opens http://127.0.0.1:8080/
```

The server of option 2, without Docker, as the torrent client of the machine it runs on. It listens
on that machine only (`127.0.0.1`), keeps the files in `~/Downloads/Swarmdeck`, and opens the app in
the browser; started again while it runs, it opens the copy that runs instead of failing on its ports.
`DOWNLOAD_DIR`, `PORT`, `HOST` and every other setting of [`server/README.md`](server/README.md) still
apply. The first time, macOS asks whether `node` may use the Downloads folder and accept connections:
say yes to both, or peers cannot connect to you.

The page it opens knows it is that client's window (its `/api/health` says `local`), and its
transfers are cards in the list like any other, marked **On this Mac**, in the table and the search,
selected several at once:

- **Pause and resume**: the connections close, web seeds included, and come back on resume.
- **Choose the files**: untick one and it is not fetched, while the files around it still finish. The
  pieces it shares with them are fetched with them, so it may appear in the folder, partly written.
- **Remove** asks whether the files go too; kept by default, as a torrent client does.
- **Save**, **Save .torrent**, **Edit .torrent**, and **Show in Finder**.
- **Close the tab**, or the browser: the downloads go on. Ctrl‑C stops the server; `npm run local`
  picks everything up again, paused or not, with the same files chosen.

What is added on the Download tab — a magnet, an info hash, a `.torrent` file or its address, a drop,
a share — goes to that client; **Download on: this browser**, beside the field, keeps it in the page
instead. A `.torrent` address is fetched by the server itself, so one with no CORS header (archive.org
sends none) needs no proxy. Seed & share and Edit stay in the page. The Cloud library, when the
service it shows is this same server, says the transfers are in the list rather than show them twice.
A server in Docker or on a NAS is not this: its health does not say `local`, and it stays the cloud
service of option 2.

---

## When something does not work

**No peers, no metadata.** The event log in the details panel says what was tried: the trackers, then
the metadata caches, then the retry. "Blocked by CORS" there means the proxy in [`proxy/`](proxy/)
would fix it.

**Your own server answers 403.** With no `AUTH_TOKEN` it answers only at `localhost` or an IP
address, not at a name such as `nas.local` or a tunnel's address: set a token (the app takes it as
the key), or list the name in `ALLOWED_HOSTS`.

**The installed app cannot reach your own server** ("does not allow this page") while the page the
server serves can: name the installed app's origin in `ALLOWED_ORIGINS`, e.g. `https://<user>.github.io`.
The server logs the origins it took when it starts. On the server's own page, "not answering" means
just that: the server is stopped or out of reach.

**"This page is https, and a browser will not let it call an http:// address."** The installed app is
on https, and your server's address is `http://`: the browser refuses the call before it is sent, and
`ALLOWED_ORIGINS` does not change that. A CORS proxy set in Settings is asked instead, and reaches a
server on the internet — never a LAN address, which a proxy out there cannot reach. Open the app at
the server's own address, or reach the server over https (the tunnel, or a deploy).

**Your own server stops at start**, and its log says `TORRENT_PORT … or DHT_PORT … is taken`: another
BitTorrent client on the machine, or a second copy of the server, has the port. Stop it, or set
`TORRENT_PORT` and `DHT_PORT` to ports that are free.

**Your own server does not start**, and its log says `cannot write downloads to DOWNLOAD_DIR`: the
directory, or a disk mounted over it, belongs to another user. The image hands its download directory
to the user it runs as (uid 10001) by itself when it is empty and root's, as the disk Fly or Render
mounts is; a folder of yours mounted there keeps its owner, so run the container as that owner
(`docker run --user <uid>:<gid>`). Run any other way, give the directory to the user that runs the
server.

**Cloudflare answers `503`, "no AUTH_TOKEN is set".** It will not start the server without one: run
`npx wrangler secret put AUTH_TOKEN` in `cloudflare/`.

**Blocked DNS.** Some ISPs blackhole tracker hostnames. **Settings → Expert → Network check**
resolves each tracker over DNS‑over‑HTTPS (Cloudflare, Google or Quad9) and tries to connect, then
tells you which are dead and which exist but are unreachable from your network — the second is
blocking. A tracker is dead, not blocked, when its name no longer exists, when it points at no
server (`127.0.0.1`, as a parked domain's does), or when its server answers but refuses the tracker
connection; a resolver that does not answer within seconds leaves the name unverified rather than
holding the check. The fix is on the device: Android → Private DNS → `one.one.one.one`; iPhone → the 1.1.1.1
app or Cloudflare's encrypted‑DNS profile; or your router.

**A phone that suspends the tab.** No web page downloads while you are in another app: the browser
freezes it. What the app can do is come back quickly, and it does — see "comes back from a freeze"
above. Keep the tab in front and the wake lock on for a download you are watching; for one you are
not, use your own server or a cloud service, where the download does not depend on the phone at all.
That difference is the honest reason the other three ways exist.

## Browsers

Recent Chrome, Edge and Firefox on Android and on a computer; Safari 16.4+ on iOS and macOS. Everything degrades:
without OPFS the pieces stay in memory, without a service worker files are assembled in memory before
saving.

**A secure page**, HTTPS or `localhost`, is the one thing that does not degrade: WebTorrent hashes
every piece with `crypto.subtle`, which a browser gives only to a secure page. Opened over plain
`http://` from any other address — your own server on the phone at `http://192.168.1.20:8080` — the
Download, Seed and Edit tabs say so and offer nothing that could only fail (the editor hashes with it
too), and the Cloud tab works as anywhere else. Reach the server through its tunnel, or a deploy, for the rest.

**iOS**, where every browser is WebKit: the app, WebRTC and "Add to Home Screen" all work, and a save
is assembled in memory then handed to the download popup — or, in the installed app, to the share
sheet ("Save to Files"). That memory step caps a practical save at what the device can hold, one or
two gigabytes. Share Target does not exist on iOS, and `magnet:` links open an installed web app only
on desktop Chrome and Edge, so on an iPhone use the picker or paste the link. A file from one of the
other three ways has no such cap: it is an ordinary download.
In Brave, if nothing ever connects, lower Shields for the site.

**WebRTC turned off** (Tor Browser, Mullvad Browser, Firefox with `media.peerconnection.enabled`
off): no peer can be reached, and the Download and Seed tabs say so. Web seeds, the Cloud tab and the
Edit tab, which talks to no peer, still work. Where a browser cannot pick a folder, the editor's check
offers files alone.

**On a computer**, what each part asks of the browser — and where it is missing, it is not offered,
or the page does without:

| | needs | where |
|---|---|---|
| Two panes, table, search, selection, keys, paste | a window 1024px wide or more | every browser |
| A folder dropped and read all the way down | `webkitGetAsEntry` on what is dropped | Chrome, Edge, Firefox, Safari |
| **Pick a folder** to share | `<input webkitdirectory>` | Chrome, Edge, Firefox, Safari on a computer (not on an iPhone) |
| **Save to a folder…** | the File System Access API (`showDirectoryPicker`) | Chrome and Edge; Firefox and Safari save file by file or as a zip |
| `.torrent` files opened from the system | the installed app, `file_handlers` | Chrome and Edge |
| `magnet:` links | the installed app, or **Settings → Magnet links** (`registerProtocolHandler`) | Chrome, Edge and Firefox; not Safari |
| Saves streamed to disk | a service worker the download manager reads | Chrome, Edge and Firefox; Safari builds each save in memory first |

## Upgrading from Phone Torrent

Swarmdeck was called Phone Torrent.

- **What the browser holds comes along.** The first time Swarmdeck opens where Phone Torrent ran, it
  moves the settings, the presets, the list's layout, the remembered torrents (their pieces stay where
  they are) and a share still waiting, from the old names to the new ones, then drops the old ones.
  Close every tab of the old version first: the two do not share the lead, and would run the same
  torrents side by side until the old one is closed.
- **The page** is at `maxgfr.github.io/swarmdeck/`; `maxgfr.github.io/phone-torrent/` is gone, and links
  shared with that address with it. An app installed from the old address goes on opening its last
  cached copy: remove it, and install Swarmdeck from the new address. Both are on the same origin, so
  the new page finds what the old one kept.
- **`docker compose`**: fetch `docker-compose.yml` again, then run `docker compose up -d
  --remove-orphans`. The service is called `swarmdeck` now and the old `phone-torrent` one goes; the
  downloads stay, in the same `downloads` volume. The image is `ghcr.io/maxgfr/swarmdeck`: the old
  `ghcr.io/maxgfr/phone-torrent` is gone, and a compose file still naming it no longer pulls.
- **`docker run`**: the new command names a `swarmdeck` volume. Keep `-v phone-torrent:/data` to go on
  with the old one, or copy it over first (see [`server/README.md`](server/README.md)).
- **The Cloudflare Workers** keep their names (`phone-torrent`, `phone-torrent-proxy`): a renamed
  Worker is a new one at a new address, with none of your transfers, and the proxy address set in
  your Settings would stop answering.
- **The repository** is `maxgfr/swarmdeck`; GitHub sends the old address there. A clone can point at
  it with `git remote set-url origin git@github.com:maxgfr/swarmdeck.git`.

## Tests

```sh
npm run lint          # undefined and unused symbols, across the app, the server and the tests
npm test              # the app, in a real browser
npm run test:server   # the server, against a real peer
npm run test:unit     # the .torrent workshop, the list's rules, drops and folder saves, no browser
npm run smoke:archive # the local server against archive.org, for real; not in CI
```

`npm run smoke:archive` needs the network: it starts the server as `npm run local` does, in a folder of
its own, and sends it the `.torrent` of an archive.org item in the public domain (`SMOKE_ITEM` names
another). It leaves one file out, pauses as soon as anything arrives and checks that nothing more does,
resumes, restarts, removes it keeping its files and adds it again from them, then removes it with them;
what arrived is checked against the md5 and sha1 archive.org lists. Only media files are fetched: an
item's other files change after its `.torrent` is made.

`test/meta.mjs` reads and writes `.torrent` files built by a bencoder of the tests' own: decoded and
encoded again byte for byte (integers past 2^53, names that are not UTF‑8, keys in their own order);
the trackers, web seeds, comment, *created by* and date edited with the info hash unchanged — an `info`
whose keys are not sorted included, which only a copy of its bytes leaves alone — and the name, private
flag, source and entropy each making a new one; v2 and hybrid torrents keeping theirs; tiers of
trackers as text; magnets read and written again, base32 hashes and unknown parameters included;
piece sizes; the trackers' rules; the same edits across several files; presets, read from whatever
was stored; pieces hashed across file boundaries, with a missing file and a short one marked absent,
progress and a stop; a torrent made with the info hash of a hand‑made one, and of WebTorrent's own
`create-torrent` for a folder (its name taken from it, `.DS_Store` left out and `Thumbs.db` kept, as
there), every option written where it goes, and a private tracker's own piece table; and the Seed &
share options, folded into their line, giving the app's trackers when none are written and a rule's
source when none is set, and a piece size of one's own over a tracker's largest, or over the one set,
said; and files checked against a torrent — matched by folder, path or name, whole, with a byte
changed, with a file missing and with one cut short, and not "ready to seed" with an empty file missing
or a file too long. And the computer's parts: the list's search (every word, a name or an info hash),
its filters, a sort that keeps ties in place either way and puts ep9 before ep10, Shift‑click ranges,
its settings read back, and read as the defaults from storage that throws; folders dropped, read in
batches all the way down, an empty one giving nothing, their paths put back after crossing to another
open copy and making the same info hash; and files written into a folder, with names any system takes,
and a stream that comes up short refused without leaving a file cut short behind. And the upgrade from
Phone Torrent (in `test/e2e.mjs`): an origin prepared as the old version left it — its settings, the
list's layout, a paused torrent in its database, a share in its inbox — opened by Swarmdeck, which
moves all of it to the new names, removes the old ones, and finds it all again after a reload.

`test/e2e.mjs` boots a WebSocket tracker and a static server, seeds a two‑file torrent through the
UI of one browser context and downloads it in a second, phone‑sized one — the real UI throughout. It
covers the file list, pause/resume, coming back from a frozen tab (the page is hidden, then shown,
and the torrent must go looking for peers by itself), the share panel (the real link, selected, and
the copy button answering on itself), Simple hiding every expert setting while Expert shows them and the choice
surviving a reload, the details panel, saving the `.torrent`, per‑file save (twice),
zip save byte‑for‑byte, restore after reload, file‑selection persistence, the delete‑all cycle,
removal, the Web Share Target, magnets in the URL and in the fragment, the tracker‑list merge (a
tracker written with its default port counted once), dead default trackers and caches leaving
settings saved before them, the network check (a dead tracker whose name still resolves named dead
rather than blocked, and a resolver that never answers given up on), metadata from a fallback
source with a tampered file rejected, the no‑peers retry,
and an iPhone‑emulated context: the unfiltered picker, a non‑torrent file refused, a `.torrent` added
from a URL, an unreachable URL reported and a web page's address told apart from it, a private torrent
explained and kept off the public trackers, its share panel offering the `.torrent` and no passkey, the
Cloud tab's picker refusing a 3 GB video unread and sending a `.torrent`, two complete cloud round trips against stand‑ins speaking TorBox's and put.io's own wire
formats, the whole cloud library (account line, listing, a file downloaded from its link
byte‑for‑byte, a magnet sent with nothing added locally, a delete that cancels the transfer and drops
its file), and the Real‑Debrid and AllDebrid mappings against stand‑ins speaking theirs — a TorBox
torrent that waits in the queue, an AllDebrid `.torrent` upload and a sixty‑file season, Real‑Debrid
through the CORS proxy worker, cloud transfers that keep their service across a switch and a reload,
a video that keeps playing through the library's polls, and a key tested then cancelled. Then cloud
fetch on a bad day, against a TorBox scripted call by call: a 503 or 502 page in the middle of a
transfer or of its wait in the queue, asked again until it is ready; a failed transfer sent again, and
one deleted in the library or on the service let go of; a key refused asked again once Settings
are saved, and nothing sent twice; files offered only once they are done; and a
switch of service whose first listing fails. Against Real‑Debrid, a refused `selectFiles` that still
sends the torrent once and starts it while one someone else left waiting is left alone, a twenty‑file
pack whose links come paced with one refused, and an account of more torrents than one page. Then each service answering as its current docs write it: AllDebrid refusing a key with a 200 and an `AUTH_` code, a link still being made and a magnet gone between two calls; put.io deleting a seeding transfer, which a cancel only stops; Real-Debrid refusing the choice of files for good, delivering three files as one archive, listing one torrent on two pages and one left waiting; a delete of a transfer already gone; and TorBox with no torrent at all, between its queue and its list, with stored files expired, and its plan by name. And a torrent's life around all that: a paused magnet staying paused through a metadata fallback and a
retry, the screen lock held for a download and let go for nothing selected (a peer connected or not)
or a private torrent, an unreachable torrent's explanation surviving a reload and a retry, the
`.torrent` for a waiting magnet filling in its card, the network coming back while a seed is hashing and a restore is checking its
pieces (hashing is held in place for as long as that takes) with only the torrent waiting for peers
rebuilt and no "finished" for what had finished before, a second open copy of the app showing the
same list and handing the first its adds, pauses, ticks, saves (a file and a zip, byte for byte), a
seed, settings and removals, then taking over from storage when the first closes, and a third copy
taking over from it when it stops answering, and web seeds on a slow mirror kept through a pause, a reload and a "keep seeding"
stop, the screen lock held for a private torrent one of them is sending.

Around the edges of the app itself: a seed's name cancelled (nothing is seeded) and a seed opening
on its link, again when its files are picked a second time, and still a seed, not remembered, once
retried; a save and a zip still busy through the redraws while they run; a `.torrent` link and a
base32 info hash shared into the app, and a share with nothing to add explained, a web page's
address included; magnets cut short, without an info hash or v2‑only refused with the reason and
left in the box, and a capital `M` and a sentence around a link accepted; Settings cancelled with no
keyboard, past a field that cannot be saved, and saved by Enter in a field; a page that is not
secure (plain `http` at a name that is not `localhost`) saying why only the Cloud tab works, without
first asking to start a linked magnet, a `.torrent` dropped on its Edit tab included; a page served by your own server taking it as the service
with nothing set, asking for its token when it has one, and one that is not keeping its default; the
account line counting a transfer as soon as the library lists it, and no longer once it is deleted there; a library file list, open while your own server finishes a season, taking on each episode in its place
and leaving the rows it has alone, a file it cannot play saying so and one whose connection drops
saying that instead, and a torrent added below a full library brought into view; a library turned
away by a token, or by a server that stopped, saying so rather than that the account is empty, and
listing it again once it is back; your own server at another address, or an `http://` one from an
https page, blamed on what it is and not on CORS, and reached through a CORS proxy when one is set; a
CORS proxy's refusal passed on with the host to add; a card and a top bar that say `offline`, caches
that wait for the network, and the network's return waking the torrent; a browser without WebRTC
saying so; diagnostics without the keys, the proxy, TURN credentials or a passkey; a proxy, a
metadata source and a server address that cannot be used mended or named rather than dropped on
Save; the storage asked, once, to be kept; the public tracker list fetched again six hours on, on a
clock of the test's own; and `npm start` staying on loopback unless `HOST` says otherwise, and then
serving the app's own files and nothing else of the checkout.

And how it looks: error toasts, primary buttons, muted text and the network check's marks at 4.5:1
or better in light and dark; at 320px, a top bar at its fullest (the widest speeds and Install) with
nothing drawn over anything, and a share panel and a cloud library link that stay on the screen, also
at the 16px iOS gives text fields (the suite applies the stylesheet's iOS‑only rules to check that);
and, for the installed iPhone app, Cancel in reach beside a long release name on the save bar, and
something dark under its white status bar in either colour scheme; and a file picker focused from
the keyboard showing it.

And the `.torrent` editor, read back from what it saves: a `.torrent`'s trackers, comment and web seeds
changed with the same info hash and an unknown key kept; its source changed for a new one, marked as
such, and the one marked being the one saved; private, with no public trackers and no magnet; public
trackers added once each, from the app, the `wss://` list and newTrackon; a magnet with only its name,
trackers and web seeds until **Get metadata** fetches it from a cache, its tracker kept; a magnet no cache
has saved as a `.torrent` in one click, its metadata from the seeder, with the magnet's trackers and not
the app's, the list left empty, and the search for peers stopped when the editor closes; a card's torrent
opened from its **Edit .torrent**, and made private with a warning; two `.torrent` files at once, a
tracker added and a comment cleared with their info hashes kept, then a source set with a new hash
each, both times unzipped from the `.zip` saved; a preset made in Settings (Enter keeping it, not
closing Settings) filling the trackers and comment, the PTP rule it brings shown and its source set in
one tap, never by itself; files checked against a two‑file torrent — all good, a byte changed as one bad
piece, a file missing named; a name ending in a space opened and saved with its info hash; a magnet's
**Copy magnet** usable after a private torrent's refusal; the editor closed while its metadata is on
the way staying closed; a hybrid torrent's identity staying locked through a preset; the Seed & share
options following another open copy; a private torrent with a source made in Seed & share, saved alone with
**Only make the .torrent** (its piece size the one sharing always used, nothing shared), then the same
files shared — the same info hash, its card private, announced to its own tracker alone, the options
remembered — and downloaded from the saved file by another page, byte for byte; a seed removed while
its files are hashed no longer hashed; and at 320px, four tabs and the
whole dialog on the screen, its banner, mark, hints and Save at 4.5:1 or better in light and dark.

And on a computer, at 1280px: the list beside the one torrent open, a row clicked opening another; the
two panes side by side at 1024, 1280, 1440 and 1920px without scrolling sideways, in cards and in
table, and one column with every card at 900px; the list read at 4.5:1 or better, light and dark; the
search (the cards on one column following it), the filters and their counts, the order and its
direction, a header clicked sorting by it and saying so (`aria-sort`); the table and the order kept
across a reload, and cards at phone width; Shift‑ and Ctrl‑click and the boxes, a bulk pause, resume
and zip of `.torrent` files, and two downloads removed with one question and gone from IndexedDB; a
second open copy listing the same rows and its bulk actions run in the first; a drag showing what a
drop will do, a `.torrent` dropped off the card added with the app still there, a file that is not a
`.torrent` dropped on Download shared only once that is said yes to, and on Cloud a `.torrent` sent
to TorBox's stand‑in and any other file refused; a folder shared as itself — dropped, picked (Chromium)
and from a follower — with the info hash Node makes of the same files; a magnet pasted on the page; the
keys (`/`, Escape, the arrows, Home, End, Shift, Ctrl+A, Space, Delete, `?`, the tabs' arrows) and the
editor's ⋯ menu; the question before closing asked only while something runs unpaused in the copy
that leads with no other waiting; a `.torrent` opened by the system and magnet links registered, both
through stand‑ins; the manifest, and every module the app imports in the offline shell; and a
torrent's files saved into a folder, tree and bytes, in an in‑memory folder on both engines and through
a real folder handle on Chromium, asked before replacing, from a follower too, and no such button on
WebKit.

`test/server.mjs` is the other half, with no browser anywhere: a plain BitTorrent client seeds a file
over an http tracker, the server is asked for it through its API, and the file comes back out whole
and by `Range` (suffix ranges and ranges past the end included), byte for byte, through the token and
through a signed link, before being deleted — it, and a transfer that fails, taking what they wrote
and nothing else, whatever their name says: a single file named like a folder of the user's leaves the
folder, and a file two transfers share goes with the last of them. A bare info hash, with no tracker,
is found on a DHT of the test's own, from a router named `localhost` — which resolves to IPv6 first,
while the DHT speaks IPv4. A file whose name has an apostrophe
is served under that name; the same DELETE twice at once is answered twice, and the server stays up. On the way it is sent requests it cannot parse and
torrents that are not torrents, and must answer them; it must not serve its downloads as static files,
nor answer another origin; it refuses a torrent that would overwrite its list of transfers; and it is
restarted, and picks the transfer up again. A BitTorrent or DHT port already taken stops it with the
setting to change; a build without uTP says it runs TCP only; `ALLOWED_HOSTS` is taken as written in
an address bar. As the client of a computer: a torrent of three files whose edges fall inside pieces,
seeded slowly, added paused and fetching nothing, its middle file left out while the two around it
finish byte for byte; a download from a peer and a web seed paused in the middle, every wire closed and
nothing more arriving for three seconds, the web seed asked nothing, then resumed to the end; a remove
that keeps the files, after which the same torrent comes back from the disk alone; the changes refused
from another website, as text, or naming a file it does not have; the pause and the files left out kept
through a restart, and a file chosen again fetched. Started with `--local`, it listens on `127.0.0.1`
in the folder it is given, says `local` in its health, fetches a `.torrent` from its address, and a
second start on its port leaves without an error. Then both Workers are called as plain modules, with no
Cloudflare account: the Cloudflare one refuses to start the server without a token, and keeps its
container up while a download is getting data, not for ever; the CORS proxy passes a web seed's
preflight, and takes an allowed origin written as the app's address. CI runs both suites, the browser one on Chromium and on WebKit (`BROWSER=webkit npm test`).
`image.yml` publishes the server image on every change to it pushed to `main`, once the image has
started on a root‑owned `/data`, as Fly and Render mount their disk, and once its `arm64` build has
been checked to load uTP, which it builds from source; a pull request gets those checks alone.

Real‑world peer discovery is the one thing the suite cannot cover: public trackers are unreachable
from the sandbox this was developed in.

## Running locally

```sh
npm install
npm start            # the page alone, at http://localhost:8080
```

`npm start` listens on this machine only. `HOST=0.0.0.0 npm start` lets a phone on the same network
in, at the address it prints, and then serves the app and nothing else of the checkout: the files
the page loads, by name — not `downloads/`, where the server keeps what it fetched when it runs from
here, nor the server, the tests or a dotfile. That is plain `http` at an address that is not
`localhost`, so not a secure page: the Cloud tab works there, while in-browser torrents and
streaming saves need HTTPS or `localhost` (see [Browsers](#browsers)). There is no build step: plain
HTML, CSS and ES modules, with WebTorrent and client‑zip vendored in `vendor/`.

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
| `index.html`, `styles.css` | the UI: one column on a phone, two panes from 1024px |
| `app.js` | the client: adding, seeding, selection, pause/resume, sharing, settings, persistence, and the cloud provider table |
| `saver.js` | hands a `ReadableStream` to the service worker, or falls back to a Blob |
| `lib/bencode.js` | bencode without loss: byte strings stay bytes, big integers BigInts, keys in their order |
| `lib/torrent-meta.js` | a `.torrent` read and edited (its `info` copied when untouched), magnets, piece sizes, the trackers' rules |
| `lib/editor.js` | the editor's dialog: one form for a `.torrent`, a magnet and several files at once |
| `lib/presets.js` | presets, and their list and form in Settings |
| `lib/torrent-hash.js`, `lib/hash-worker.js` | the SHA‑1 of every piece, across files, in a Worker, with progress and a stop |
| `lib/create-options.js` | Seed & share's torrent options, folded into one line |
| `lib/torrent-check.js` | files checked against a torrent, piece by piece |
| `lib/torrent-list.js` | the list: search, filters, order, selection ranges, and its rows on the page |
| `lib/drop.js` | what is dropped: folders read all the way down, and text |
| `lib/folder-save.js` | a torrent's files written into a folder of the computer |
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
| Select the files to download | yes | on the page; the server fetches the whole torrent — but [on your computer](#5-on-your-computer), from its card |
| Pause, resume, remove | yes, one or several at once | remove, on the account — [on your computer](#5-on-your-computer), all three, keeping the files or not |
| A list with columns, search, filters, the keyboard | yes, on a computer | yes, on the page |
| Speed limits, sequential download | yes | the service's own settings |
| Seeding, creating a torrent | yes, while the page is open — piece size, private, source, trackers, or only the `.torrent` | the server keeps seeding after a download |
| Web seeds | yes | n/a |
| Edit a `.torrent` (trackers, web seeds, comment, name, source, private) | yes | yes, on the page |
| DHT, PEX, `udp://` and `http(s)://` trackers | **no** — impossible in a browser | **yes** |
| Private trackers | **no** | **yes** |
| Downloading with this device asleep | no | **yes** — nothing depends on it; on Cloudflare, though, finished files go once half an hour passes with no download getting data and no request from the app — which stops asking once nothing is downloading, even left open |
| RSS, search, scheduler, IP filter | no | no |

## Privacy

The page talks to the trackers and peers BitTorrent needs, and beyond them only to:

- the public list of `wss://` trackers, fetched from GitHub (or its jsDelivr and Statically mirrors)
  every six hours — **Settings → Expert** turns it off or points it somewhere else;
- for a magnet whose metadata no peer delivers, the torrent caches that serve a `.torrent` by info
  hash (`itorrents.net` by default), which therefore learn that info hash — the list is in
  **Settings → Expert**, and an empty one asks nobody. A `.torrent` you add, private or not, never
  goes there: it already has its metadata;
- the DNS‑over‑HTTPS resolver you choose, and only when you run the network check;
- the STUN servers WebRTC asks for your public address as it connects to peers, which therefore see
  that address, and when you download or seed: Google's (`stun.l.google.com`) and Twilio's
  (`global.stun.twilio.com`) unless **Settings → Expert → WebRTC configuration** names others.

A cloud key is stored on the device and sent only to that service and, when the browser cannot make
a call directly, through the CORS proxy set in Settings, even with "route cloud API calls through my
CORS proxy" off (with it on, every call goes through the proxy) — so set only a proxy you run. For
TorBox and put.io the key is also inside the file links, as above. The files a cloud service or your
own server holds are downloaded straight from it by the browser: they never pass through this app.
