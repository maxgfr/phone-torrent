/* Phone Torrent service worker.
 *
 * Its only job is to turn a ReadableStream that lives in the page into a real
 * HTTP download. The page registers a stream under an id, then navigates a
 * hidden iframe to `<scope>dl/<id>/<filename>`. This worker answers that
 * request by asking the open pages for the stream and piping its chunks into
 * the response with a `Content-Disposition: attachment` header, so the browser
 * hands the bytes to its download manager as they arrive instead of first
 * buffering the whole file in memory.
 */

const ANSWER_TIMEOUT_MS = 8000;

/* App shell cache so the installed app opens offline and loads instantly.
 * Network first, cache as fallback: a deploy is picked up on the next online load. */
const SHELL_CACHE = 'phone-torrent-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './saver.js',
  './styles.css',
  './icon.svg',
  './manifest.webmanifest',
  './vendor/webtorrent.min.js',
  './vendor/client-zip.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(SHELL_FILES);
    } catch (err) {
      console.warn('shell precache failed', err);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('phone-torrent-shell-') && k !== SHELL_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const SHELL_PATHS = new Set(SHELL_FILES.map((f) => new URL(f, self.registration.scope).pathname));

function isShellRequest(url) {
  return SHELL_PATHS.has(url.pathname);
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
    return fresh;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const index = await cache.match('./index.html');
      if (index) return index;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const scope = new URL(self.registration.scope).pathname;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === scope + 'keepalive') {
    event.respondWith(new Response('ok', { headers: { 'Cache-Control': 'no-store' } }));
    return;
  }
  if (event.request.method === 'POST' && url.pathname === scope + 'share') {
    event.respondWith(receiveShare(event.request, scope));
    return;
  }
  if (url.pathname.startsWith(scope + 'dl/')) {
    const id = url.pathname.slice((scope + 'dl/').length).split('/')[0];
    event.respondWith(serve(id));
    return;
  }
  // Only the app shell is cached; everything else (tracker lists, remote files) goes straight to the network.
  if (event.request.method === 'GET' && (isShellRequest(url) || event.request.mode === 'navigate')) {
    event.respondWith(networkFirst(event.request));
  }
});

/* Web Share Target: Android lets the user "share" a .torrent file or a magnet
 * link to this app. The browser POSTs it here; we park it in the Cache API and
 * redirect to the app, which picks it up (see app.js, takeSharedInbox). */
const INBOX_CACHE = 'phone-torrent-inbox';

async function receiveShare(request, scope) {
  try {
    const form = await request.formData();
    const cache = await caches.open(INBOX_CACHE);
    const stamp = Date.now();
    let i = 0;
    for (const file of form.getAll('torrents')) {
      if (!(file instanceof File)) continue;
      await cache.put(
        `${scope}inbox/${stamp}-${i++}`,
        new Response(file, { headers: { 'X-Name': encodeURIComponent(file.name), 'X-Kind': 'torrent' } }),
      );
    }
    const text = [form.get('url'), form.get('text'), form.get('title')].filter((v) => typeof v === 'string').join('\n');
    if (/magnet:\?|\b[a-f0-9]{40}\b/i.test(text)) {
      await cache.put(`${scope}inbox/${stamp}-${i++}`, new Response(text, { headers: { 'X-Kind': 'text' } }));
    }
  } catch (err) {
    console.error('share target failed', err);
  }
  return Response.redirect(`${scope}?shared=1`, 303);
}

async function serve(id) {
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clientList.length === 0) return notFound();

  const answer = await new Promise((resolve) => {
    let remaining = clientList.length;
    const timer = setTimeout(() => resolve(null), ANSWER_TIMEOUT_MS);
    for (const client of clientList) {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = ({ data }) => {
        if (data && data.type === 'head') {
          clearTimeout(timer);
          resolve({ head: data, port: port1 });
        } else {
          port1.close();
          if (--remaining === 0) {
            clearTimeout(timer);
            resolve(null);
          }
        }
      };
      client.postMessage({ type: 'phone-torrent:request', id }, [port2]);
    }
  });

  if (!answer) return notFound();
  const { head, port } = answer;

  const body = new ReadableStream({
    pull(controller) {
      return new Promise((resolve, reject) => {
        port.onmessage = ({ data }) => {
          if (data === null) {
            controller.close();
            port.close();
          } else if (data && data.type === 'error') {
            controller.error(new Error(data.message || 'stream error'));
            port.close();
          } else {
            controller.enqueue(data);
          }
          resolve();
        };
        port.onmessageerror = () => {
          controller.error(new Error('message error'));
          port.close();
          reject(new Error('message error'));
        };
        port.postMessage('pull');
      });
    },
    cancel() {
      port.postMessage('cancel');
      port.close();
    },
  });

  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDisposition(head.name),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (Number.isFinite(head.size) && head.size >= 0) headers.set('Content-Length', String(head.size));

  return new Response(body, { status: 200, headers });
}

function notFound() {
  return new Response('Download expired. Go back to the app and try again.', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function contentDisposition(name) {
  const safeName = String(name || 'download').replace(/[/\\]/g, '_');
  const ascii = safeName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(safeName)}`;
}

function encodeRFC5987(str) {
  return encodeURIComponent(str)
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%(7C|60|5E)/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}
