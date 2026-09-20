# Optional CORS proxy

Phone Torrent is a static site, so it can only read HTTP resources that allow cross‑origin
requests. Two features need that and usually don't get it from the origin server:

- **Metadata fallback sources** (torrent caches queried by info hash when peers never send the
  metadata of a magnet link).
- **Web seeds** and **remote files to seed**.
- **Cloud fetch API calls**, if the API does not allow browser requests.

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
# optional: hosts allowed to receive POST and your Authorization header (cloud fetch)
wrangler secret put API_HOSTS   # e.g. api.torbox.app
```

The origin check keeps browsers on other sites from using your worker; a scripted client can still
forge the header, which is why the size cap exists. Keep the worker URL to yourself.

Then in the app open **Settings → CORS proxy** and enter
`https://phone-torrent-proxy.<you>.workers.dev/?url={url}`.

The proxy only relays what the app asks for. GET and HEAD go anywhere; POST and the `Authorization`
header — which carries your cloud API key — are accepted only for the hosts in `API_HOSTS`, so a
stray `?url=` can never be used to hand your key to someone else. Leave `API_HOSTS` unset unless you
turn on "route cloud API calls through my CORS proxy". The proxy never sees torrent payload traffic,
which stays peer‑to‑peer over WebRTC, nor the cloud download itself, which the browser fetches
straight from the API's CDN link.
