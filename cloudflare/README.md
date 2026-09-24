# The server on Cloudflare

One command and the server runs on Cloudflare's network, not on a machine of
yours. Docker has to be installed and running where you deploy from, once:
`wrangler deploy` builds the image there.

```sh
cd cloudflare
npm install
npx wrangler secret put AUTH_TOKEN   # paste a long random string
npx wrangler deploy
```

`wrangler deploy` builds `server/Dockerfile`, pushes the image to Cloudflare's
registry and puts a Worker in front of it. The address it prints is what goes
in the app: **Settings → Cloud fetch → service “My own server”**, with the same
token as the key.

The token is not optional. That address is public the moment it exists, and a
server with no token would be a torrent client anyone could drive — any website
too, since `ALLOWED_ORIGINS` is `*` here. Until `AUTH_TOKEN` is set, the Worker
answers `503` and does not start the server at all.

## What this is good at, and what it is not

Be clear-eyed about it before you rely on it:

- **It needs a paid Workers plan.** Containers are not on the free tier.
- **The disk is ephemeral, and it goes when the container sleeps.** The
  container sleeps once half an hour has passed with no request from the app
  and no download getting any data; the downloaded files go with it. An app
  left open does not keep it awake: it stops asking once nothing is
  downloading. So a download carries on with the phone locked, and what it
  finishes stays for at least half an hour after, not overnight. Save what you
  want to keep soon after it finishes. A torrent that gets nothing for half an
  hour does not keep it awake.
- **There is no inbound port.** Peers cannot connect to it; it connects to
  them. That is enough for a healthy swarm and thin for a rare one, and it
  means this is a downloader, not a seedbox.
- **UDP is not available**, so `udp://` trackers and the DHT do not work here.
  Torrents with `http(s)://` or `wss://` trackers — which includes every
  private tracker — are unaffected, and those are the ones a browser could not
  reach in the first place.

If you want files that stay, a download that waits for you and a swarm you
take part in for longer, run the same image on a machine you own
(`docker compose up -d`, with `docker-compose.tunnel.yml` if you want to reach
it from outside), or on Render or Fly, whose disk stays. Those are in the main
README.
