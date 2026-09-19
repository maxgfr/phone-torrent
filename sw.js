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

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const scope = new URL(self.registration.scope).pathname;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === scope + 'keepalive') {
    event.respondWith(new Response('ok', { headers: { 'Cache-Control': 'no-store' } }));
    return;
  }
  if (!url.pathname.startsWith(scope + 'dl/')) return;
  const id = url.pathname.slice((scope + 'dl/').length).split('/')[0];
  event.respondWith(serve(id));
});

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
