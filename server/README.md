# The server

A real BitTorrent client with an HTTP API in front of it, and the app served
from the same origin. It exists because a web page has no TCP, no UDP and no
DHT: a private tracker, an `http(s)://` tracker or a swarm with no WebRTC peer
is out of a browser's reach no matter what the page does. This is not a
browser, so none of that applies.

## Run it

```sh
docker compose up -d          # then open http://localhost:8080
```

That is the whole thing: the API, the client, and the app on one origin — no
CORS to configure, nothing else to deploy. Downloads land in the `downloads`
volume and survive restarts; unfinished transfers resume by themselves. With no
`ALLOWED_ORIGINS`, no other website open in your browser can call it. With no
`AUTH_TOKEN` either, it answers only at `localhost` or an IP address: a site that
points its own domain name at your machine (DNS rebinding) is otherwise
same-origin with it. To reach it by a name such as `nas.local`, set a token or
list the name in `ALLOWED_HOSTS`.

Set `AUTH_TOKEN` in `docker-compose.yml` the moment the server is reachable
from anywhere but your own machine, and put the same value in the app as the
key.

To reach it from your phone when you are out:

```sh
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml logs cloudflared | grep trycloudflare.com
```

Every command about the tunnel takes both files, `down` included. That address
is public — `AUTH_TOKEN` is not optional with a tunnel.

Prefer no machine at all? `render.yaml`, `fly.toml` and `cloudflare/` deploy
the same image; the main README compares them. The server in it runs as an
unprivileged user (uid 10001). The container starts as root only to hand that
user the download directory, since the disk Fly or Render mounts over `/data`
arrives owned by root — and only when it is root's and empty, as such a disk
is. A folder of yours mounted there, files and all, keeps its owner: the server
then says it cannot write there, and `--user <uid>:<gid>` runs it as that
owner instead, which skips that step.

## Point the app at it

**Settings → Cloud fetch → service “My own server”**, `AUTH_TOKEN` as the key
(nothing, for a server with no token), then **Test the key**. Opened from this
server, the base URL can stay empty — empty means this page’s own address,
which is already the right one — and while no service has been set up, the
page picks “My own server” by itself, so a server with no token needs nothing
set at all. Fill the address in only to drive a server somewhere else. From
then on the Cloud tab and the library drive this server exactly as they drive
TorBox or put.io: send a magnet or a `.torrent`, watch the progress, then play
or save each file — in the library, as soon as that file is complete.

## The API

Everything under `/api` needs the token (`Authorization: Bearer …`, or
`?token=…`). A file can also be fetched with the `link` the API hands out for
it: signed with the token instead of containing it, it opens that one file for a
day and nothing else — which is what a `<video>`, a download manager or another
device gets, rather than the key to the whole server.

| | |
|---|---|
| `GET /api/health` | no token; `{ ok, torrents }` |
| `GET /api/account` | `{ who, detail }` — transfer count and free space |
| `GET /api/transfers` | `{ transfers: [...] }` |
| `POST /api/transfers` | `{"magnet": "..."}` as `application/json`, or the `.torrent` bytes as `application/x-bittorrent`; anything else is `415`, whatever follows a `;` |
| `GET /api/transfers/{infoHash}` | one transfer |
| `DELETE /api/transfers/{infoHash}` | removes it **and its files**, and the folders they leave empty; nothing it did not write, whatever its name |
| `GET /api/transfers/{infoHash}/files/{index}` | the file, with `Range` support; the token, or the file's signed `link` |

A transfer is `{ id, name, size, progress, state, ready, peers, downloadSpeed, receivedAt, files: [{ id, name, size, link }] }`,
`receivedAt` being when data last arrived for it (absent until some has, since
the server started): that is how the Cloudflare Worker tells a download still
getting somewhere from one that is not, with no request coming in.
`files` lists each file as soon as it is complete, so the first episode of a
season can be played while the rest downloads. A transfer that fails — a full
disk, a write the disk refuses — stays listed with `failed: true` and the reason
as its `state`, until it is deleted or the server restarts.

A `POST` or `DELETE` that a browser marks as sent by another website
(`Sec-Fetch-Site`) is `403` unless that site is in `ALLOWED_ORIGINS`.

The list of transfers is kept as `transfers.json` in the download directory, so
a torrent whose top-level name is `transfers.json`, or starts with
`transfers.json.`, is refused rather than allowed to write over it. A magnet is
kept there as the `.torrent` it turns into once its metadata arrives, so a
restart checks the files on disk without needing a peer. If the file cannot be
read at start, it is kept as `transfers.json.corrupt-<time>`, the log says so,
and the server starts with no transfers.

## Settings

| variable | default | |
|---|---|---|
| `PORT` | `8080` | |
| `AUTH_TOKEN` | *(none)* | set it whenever the server is not alone on your machine |
| `ALLOWED_ORIGINS` | *(none)* | comma-separated origins allowed to call the API from a browser, such as `https://<user>.github.io` (a page's address is cut down to its origin, and the log lists what was taken); none means only the page this server serves, `*` means any |
| `ALLOWED_HOSTS` | *(none)* | with no `AUTH_TOKEN`, comma-separated host names the API answers at besides `localhost` and IP addresses, e.g. `nas.local` |
| `DOWNLOAD_DIR` | `/data/downloads` | where files land (`downloads/` beside `server/` when run from a checkout; never served as static files); a server that cannot write there says so and does not start |
| `WEB_DIR` | the app | the static files served at `/` |
| `SEED_AFTER_DONE` | `1` | keep seeding once a download finishes |
| `TORRENT_PORT` | `6881` | BitTorrent over TCP and uTP |
| `DHT_PORT` | `6882` | the DHT, over UDP |

Ports `6881` (TCP and UDP) and `6882` (UDP) are the BitTorrent side. Forward
them and peers can connect to you as well as the other way round; without them
you can still download, from fewer peers. `fly.toml` publishes the TCP one, but
on Fly peers seldom find it: a tracker hands out the address a machine
announced from, and a Fly machine's outbound address is not the one the port
is published on.

## A note on the dependency pin

`package.json` pins `uint8-util` to 2.2.5 through an override. WebTorrent 2.8
hands `parse-torrent`'s hex-string info hash to `uint8-util`'s `arr2hex`, which
from 2.3 accepts only a typed array — so a fresh install of the two throws on
the very first `add`. The pin is what makes `npm install` produce a working
client today.
