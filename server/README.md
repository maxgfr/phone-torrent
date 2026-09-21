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
volume and survive restarts; unfinished transfers resume by themselves.

Set `AUTH_TOKEN` in `docker-compose.yml` the moment the server is reachable
from anywhere but your own machine, and put the same value in the app as the
key.

To reach it from your phone when you are out:

```sh
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
docker compose logs cloudflared | grep trycloudflare.com
```

That address is public — `AUTH_TOKEN` is not optional with a tunnel.

Prefer no machine at all? `render.yaml`, `fly.toml` and `cloudflare/` deploy
the same image; the main README compares them.

## Point the app at it

**Settings → Cloud fetch → service “My own server”**, `AUTH_TOKEN` as the key,
then **Test the key**. Opened from this server, the base URL can stay empty —
empty means this page’s own address, which is already the right one. Fill it in
only to drive a server somewhere else. From then on the Cloud tab and the
library drive this server exactly as they drive TorBox or put.io: send a magnet
or a `.torrent`, watch the progress, then play or save each file.

## The API

Everything under `/api` needs the token (`Authorization: Bearer …`, or
`?token=…` for links a `<video>` or a download has to follow on its own).

| | |
|---|---|
| `GET /api/health` | no token; `{ ok, torrents }` |
| `GET /api/account` | `{ who, detail }` — transfer count and free space |
| `GET /api/transfers` | `{ transfers: [...] }` |
| `POST /api/transfers` | `{"magnet": "..."}` as JSON, or the `.torrent` bytes as the body |
| `GET /api/transfers/{infoHash}` | one transfer |
| `DELETE /api/transfers/{infoHash}` | removes it **and its files** |
| `GET /api/transfers/{infoHash}/files/{index}` | the file, with `Range` support |

A transfer is `{ id, name, size, progress, state, ready, peers, files: [{ id, name, size }] }`.

## Settings

| variable | default | |
|---|---|---|
| `PORT` | `8080` | |
| `AUTH_TOKEN` | *(none)* | set it whenever the server is not alone on your machine |
| `ALLOWED_ORIGINS` | `*` | comma-separated origins allowed to call the API from a browser |
| `DOWNLOAD_DIR` | `/data/downloads` | where files land |
| `WEB_DIR` | the app | the static files served at `/` |
| `SEED_AFTER_DONE` | `1` | keep seeding once a download finishes |

Port `6881` (TCP and UDP) is the BitTorrent side. Forward it and peers can
connect to you as well as the other way round; without it you can still
download, from fewer peers.

## A note on the dependency pin

`package.json` pins `uint8-util` to 2.2.5 through an override. WebTorrent 2.8
hands `parse-torrent`'s hex-string info hash to `uint8-util`'s `arr2hex`, which
from 2.3 accepts only a typed array — so a fresh install of the two throws on
the very first `add`. The pin is what makes `npm install` produce a working
client today.
