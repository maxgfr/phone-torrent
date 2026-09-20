# The server on Cloudflare

One command and the server runs on Cloudflare's network, with no machine of
your own:

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

## What this is good at, and what it is not

Be clear-eyed about it before you rely on it:

- **It needs a paid Workers plan.** Containers are not on the free tier.
- **The disk is ephemeral.** When the container sleeps or is replaced, the
  downloaded files go with it. Save what you want to keep while it is there.
  That is why `sleepAfter` is half an hour rather than a minute.
- **There is no inbound port.** Peers cannot connect to it; it connects to
  them. That is enough for a healthy swarm and thin for a rare one, and it
  means this is a downloader, not a seedbox.
- **UDP is not available**, so `udp://` trackers and the DHT do not work here.
  Torrents with `http(s)://` or `wss://` trackers — which includes every
  private tracker — are unaffected, and those are the ones a browser could not
  reach in the first place.

If you want files that stay, peers that can reach you and a swarm you really
take part in, run the same image on a machine you own (`docker compose up -d`,
with `docker-compose.tunnel.yml` if you want to reach it from outside) or on
Fly, where the machine gets its own address. Those are in the main README.
