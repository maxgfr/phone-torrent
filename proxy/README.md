# Optional CORS proxy

Phone Torrent is a static site, so it can only read HTTP resources that allow cross‑origin
requests. These need that and usually don't get it from the origin server:

- **Metadata fallback sources** (torrent caches queried by info hash when peers never send the
  metadata of a magnet link).
- **A `.torrent` added by its `https://` address.**
- **Web seeds** and **remote files to seed**.
- **Cloud fetch API calls**, if the API does not allow browser requests.

`cloudflare-worker.js` is a ~100‑line pass‑through proxy that adds CORS headers and forwards
`Range` requests. It runs on Cloudflare's free tier.

```sh
npm i -g wrangler
wrangler login
cd proxy                # wrangler.jsonc here names the worker for every command below
wrangler deploy
# required: the worker refuses every request until this is set
wrangler secret put ALLOWED_ORIGINS   # e.g. https://<user>.github.io (the app's address works too: it is cut down to its origin)
# optional: per-request size cap in bytes (default 4 GiB)
wrangler secret put MAX_BYTES
# needed for cloud fetch: hosts allowed to receive POST, PUT, DELETE and your Authorization header
wrangler secret put API_HOSTS   # e.g. api.torbox.app (put.io needs api.put.io,upload.put.io)
```

The origin check keeps browsers on other sites from using your worker; a scripted client can still
forge the header, which is why the size cap exists. Keep the worker URL to yourself.

Then in the app open **Settings → Expert → CORS proxy** and enter
`https://phone-torrent-proxy.<you>.workers.dev/?url={url}`.

The proxy only relays what the app asks for. GET and HEAD go anywhere; POST, PUT, DELETE and the
`Authorization` header — which carries your cloud API key — are accepted only for the hosts in `API_HOSTS`, so a
stray `?url=` can never be used to hand your key to someone else. If you use a cloud service, set
`API_HOSTS` to its API hosts — `api.torbox.app`; `api.put.io,upload.put.io`; `api.real-debrid.com`;
`api.alldebrid.com`; your own server's host — even with "route cloud API calls through my CORS proxy"
off. A cloud call the browser cannot make is retried through the proxy by itself, key included, and
without `API_HOSTS` that retry is refused (a write) or reaches the API without the `Authorization`
header that carries your key. The toggle only skips the direct attempt: every call then goes through
the proxy. Apart from a web seed or a remote file it relays, the proxy never sees torrent payload
traffic, which stays peer‑to‑peer over WebRTC, nor the cloud download itself, which the browser
fetches straight from the API's CDN link.
