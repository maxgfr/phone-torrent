/* Optional CORS proxy for Phone Torrent, deployable for free on Cloudflare Workers.
 *
 * Torrent caches (itorrents.org, torrage.info, …), most HTTP web seeds and some cloud-fetch APIs
 * do not send CORS headers, so a web page cannot read them directly. This worker fetches the URL
 * on the page's behalf and adds the headers. Deploy it, then put
 *   https://<your-worker>.workers.dev/?url={url}
 * in Settings → "CORS proxy" in the app.
 *
 * Deploy: npm i -g wrangler && cd proxy && wrangler deploy (wrangler.jsonc beside this file names it)
 * Then set ALLOWED_ORIGINS (comma separated), e.g. https://<user>.github.io, with
 * `wrangler secret put ALLOWED_ORIGINS` from the same folder: it refuses every request until then.
 */

const PASS_REQUEST_HEADERS = ['range', 'accept', 'if-none-match', 'if-modified-since'];
// What the page may send the worker, which is more than the worker sends on. WebTorrent asks a web
// seed for every piece with Cache-Control: no-store, and sets a User-Agent that Firefox then sends;
// a browser whose preflight is not allowed them never sends the request at all.
const ALLOW_REQUEST_HEADERS = 'Range, Accept, Authorization, Content-Type, If-None-Match, If-Modified-Since, Cache-Control, User-Agent';
// Cloud-fetch API calls need POST (and PUT and DELETE: Real-Debrid adds a .torrent with PUT and
// deletes with DELETE, and so does your own server) and an Authorization header. That header
// carries the user's API key, so it and every method that writes are only ever forwarded to
// hosts named in API_HOSTS — never to an arbitrary ?url=.
const API_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'];
const WRITE_METHODS = ['POST', 'PUT', 'DELETE'];
const PASS_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-disposition'];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env && env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',') : []).map((s) => s.trim()).filter(Boolean);
    // Fail closed: without an allow-list this would be an open proxy for anyone on the internet.
    if (!allowed.length) return new Response('ALLOWED_ORIGINS is not configured; refusing to act as an open proxy', { status: 403 });
    if (!allowed.includes(origin)) return new Response('origin not allowed', { status: 403 });
    const maxBytes = Number(env && env.MAX_BYTES) || 4 * 1024 * 1024 * 1024; // 4 GiB per request by default
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': ALLOW_REQUEST_HEADERS,
      'Access-Control-Expose-Headers': PASS_RESPONSE_HEADERS.join(', '),
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!API_METHODS.includes(request.method)) return new Response('method not allowed', { status: 405, headers: cors });

    const target = new URL(request.url).searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) return new Response('missing or invalid ?url=', { status: 400, headers: cors });

    // Hosts allowed to receive an Authorization header (cloud-fetch APIs), e.g. "api.torbox.app".
    const apiHosts = (env && env.API_HOSTS ? env.API_HOSTS.split(',') : []).map((s) => s.trim()).filter(Boolean);
    const isApiHost = apiHosts.includes(new URL(target).host);
    if (WRITE_METHODS.includes(request.method) && !isApiHost) return new Response(`${request.method} is only allowed to API_HOSTS`, { status: 403, headers: cors });

    const headers = new Headers();
    for (const h of PASS_REQUEST_HEADERS) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (isApiHost) {
      for (const h of ['authorization', 'content-type']) {
        const v = request.headers.get(h);
        if (v) headers.set(h, v);
      }
    }
    headers.set('User-Agent', 'phone-torrent-proxy');

    let upstream;
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === 'POST' || request.method === 'PUT' ? request.body : undefined,
        redirect: 'follow',
      });
    } catch (err) {
      return new Response(`upstream fetch failed: ${err.message}`, { status: 502, headers: cors });
    }

    const declared = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return new Response('upstream file exceeds the size limit', { status: 413, headers: cors });

    const out = new Headers(cors);
    for (const h of PASS_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    // Workers hand us a decoded body when the upstream was compressed; the original length would lie.
    if (upstream.headers.get('content-encoding')) out.delete('content-length');
    out.set('Cache-Control', 'no-store');

    // Enforce the byte cap on streamed bodies without a declared length.
    let seen = 0;
    const capped = upstream.body && upstream.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) controller.error(new Error('size limit exceeded'));
        else controller.enqueue(chunk);
      },
    }));
    return new Response(capped, { status: upstream.status, headers: out });
  },
};
