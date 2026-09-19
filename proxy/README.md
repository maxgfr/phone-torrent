# Optional CORS proxy

Phone Torrent is a static site, so it can only read HTTP resources that allow cross‑origin
requests. Two features need that and usually don't get it from the origin server:

- **Metadata fallback sources** (torrent caches queried by info hash when peers never send the
  metadata of a magnet link).
- **Web seeds** and **remote files to seed**.

`cloudflare-worker.js` is a ~50‑line pass‑through proxy that adds CORS headers and forwards
`Range` requests. It runs on Cloudflare's free tier.

```sh
npm i -g wrangler
wrangler login
wrangler deploy proxy/cloudflare-worker.js --name phone-torrent-proxy
# required: the worker refuses every request until this is set
wrangler secret put ALLOWED_ORIGINS   # e.g. https://<user>.github.io
# optional: per-request size cap in bytes (default 4 GiB)
wrangler secret put MAX_BYTES
```

The origin check keeps browsers on other sites from using your worker; a scripted client can still
forge the header, which is why the size cap exists. Keep the worker URL to yourself.

Then in the app open **Settings → CORS proxy** and enter
`https://phone-torrent-proxy.<you>.workers.dev/?url={url}`.

The proxy only relays what the app asks for, and only GET/HEAD; it never sees torrent payload
traffic, which stays peer‑to‑peer over WebRTC.
