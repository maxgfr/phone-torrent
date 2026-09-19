/* Optional CORS proxy for Phone Torrent, deployable for free on Cloudflare Workers.
 *
 * Torrent caches (itorrents.org, torrage.info, …) and most HTTP web seeds do not send CORS
 * headers, so a web page cannot read them directly. This worker fetches the URL on the page's
 * behalf and adds the headers. Deploy it, then put
 *   https://<your-worker>.workers.dev/?url={url}
 * in Settings → "CORS proxy" in the app.
 *
 * Deploy: npm i -g wrangler && wrangler deploy proxy/cloudflare-worker.js --name phone-torrent-proxy
 * Restrict it to your own site by setting ALLOWED_ORIGINS (comma separated) as a Worker variable,
 * e.g. https://<user>.github.io
 */

const PASS_REQUEST_HEADERS = ['range', 'accept', 'if-none-match', 'if-modified-since'];
const PASS_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-disposition'];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env && env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',') : []).map((s) => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(origin)) return new Response('origin not allowed', { status: 403 });
    const cors = {
      'Access-Control-Allow-Origin': allowed.length ? origin : '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Accept, If-None-Match, If-Modified-Since',
      'Access-Control-Expose-Headers': PASS_RESPONSE_HEADERS.join(', '),
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: cors });

    const target = new URL(request.url).searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) return new Response('missing or invalid ?url=', { status: 400, headers: cors });

    const headers = new Headers();
    for (const h of PASS_REQUEST_HEADERS) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('User-Agent', 'phone-torrent-proxy');

    let upstream;
    try {
      upstream = await fetch(target, { method: request.method, headers, redirect: 'follow' });
    } catch (err) {
      return new Response(`upstream fetch failed: ${err.message}`, { status: 502, headers: cors });
    }

    const out = new Headers(cors);
    for (const h of PASS_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    out.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
