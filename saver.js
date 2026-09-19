/* Saving files to the device.
 *
 * Preferred path: hand a ReadableStream to the service worker (see sw.js) and
 * let the browser's download manager pull it. Nothing is buffered in memory,
 * so multi-gigabyte files work on a phone.
 *
 * Fallback path (no service worker, e.g. private browsing in some browsers):
 * collect the stream into a Blob and click a temporary <a download> link.
 */

const pending = new Map();
let registration = null;
let keepAliveTimer = null;
let activeStreams = 0;

const UA = navigator.userAgent;
const IS_IOS = /iP(hone|ad|od)/.test(UA) && !window.MSStream;
// Safari on macOS, and every browser on iOS (Safari, Brave, Chrome, Firefox all use WebKit there),
// do not hand a service-worker streamed attachment to a download manager.
const IS_WEBKIT_ONLY = IS_IOS || (/AppleWebKit/.test(UA) && !/Chrome|Chromium|CriOS|EdgiOS|Edg\/|Firefox|FxiOS/.test(UA));
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export const saver = {
  mode: 'blob',
  reason: '',

  async init() {
    if (!('serviceWorker' in navigator)) {
      this.reason = 'Service workers are not available in this browser.';
      return this;
    }
    if (!window.isSecureContext) {
      this.reason = 'Streaming saves need HTTPS.';
      return this;
    }
    try {
      registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      await waitForActive(registration);
      navigator.serviceWorker.addEventListener('message', onWorkerMessage);
      if (IS_WEBKIT_ONLY) {
        // Keep the worker (offline shell, share target) but save via memory.
        this.reason = IS_IOS
          ? 'On iOS files are prepared in memory, then saved with the share sheet or the download popup.'
          : 'Safari prepares files in memory before saving.';
      } else {
        this.mode = 'stream';
      }
    } catch (err) {
      this.reason = `Service worker failed: ${err.message}`;
    }
    return this;
  },

  /**
   * Save a stream to the device.
   * @param {{ name: string, size?: number, stream: () => ReadableStream<Uint8Array> }} item
   */
  async save(item) {
    if (this.mode === 'stream') return saveViaWorker(item);
    return saveViaBlob(item);
  },
};

function waitForActive(reg) {
  return new Promise((resolve, reject) => {
    const sw = reg.installing || reg.waiting || reg.active;
    if (!sw) return reject(new Error('no worker'));
    if (sw.state === 'activated') return resolve();
    const timer = setTimeout(() => reject(new Error('activation timed out')), 10000);
    sw.addEventListener('statechange', () => {
      if (sw.state === 'activated') {
        clearTimeout(timer);
        resolve();
      } else if (sw.state === 'redundant') {
        clearTimeout(timer);
        reject(new Error('worker became redundant'));
      }
    });
  });
}

function onWorkerMessage(event) {
  const data = event.data;
  if (!data || data.type !== 'phone-torrent:request') return;
  const port = event.ports[0];
  const job = pending.get(data.id);
  if (!job) {
    port.postMessage({ type: 'notfound' });
    port.close();
    return;
  }
  pending.delete(data.id);
  clearTimeout(job.expiry);

  let reader;
  try {
    reader = job.stream().getReader();
  } catch (err) {
    port.postMessage({ type: 'notfound' });
    port.close();
    job.reject(err);
    return;
  }

  activeStreams++;
  startKeepAlive();
  port.postMessage({ type: 'head', name: job.name, size: job.size });

  const finish = (err) => {
    activeStreams = Math.max(0, activeStreams - 1);
    if (activeStreams === 0) stopKeepAlive();
    port.onmessage = null;
    if (err) job.reject(err);
    else job.resolve();
  };

  port.onmessage = async ({ data: msg }) => {
    if (msg === 'cancel') {
      try { await reader.cancel(); } catch { /* ignore */ }
      finish(new Error('Download cancelled'));
      return;
    }
    if (msg !== 'pull') return;
    try {
      const { value, done } = await reader.read();
      if (done) {
        port.postMessage(null);
        finish();
        return;
      }
      // Copy, never transfer: the chunk may be WebTorrent's cached piece buffer, and
      // transferring would detach it for every later read (second save, zip, uploads).
      port.postMessage(value.slice());
    } catch (err) {
      port.postMessage({ type: 'error', message: err.message });
      finish(err);
    }
  };
}

function saveViaWorker(item) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const job = {
      name: item.name,
      size: item.size,
      stream: item.stream,
      resolve,
      reject,
      expiry: setTimeout(() => {
        if (pending.delete(id)) reject(new Error('The browser never requested the download.'));
      }, 15000),
    };
    pending.set(id, job);

    const scope = new URL(registration.scope).pathname;
    const url = `${scope}dl/${id}/${encodeURIComponent(item.name)}`;
    const iframe = document.createElement('iframe');
    iframe.hidden = true;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.src = url;
    document.body.appendChild(iframe);
    // Keep the iframe around long enough for the navigation to become a download.
    setTimeout(() => iframe.remove(), 60000);
  });
}

async function saveViaBlob(item) {
  const chunks = [];
  const reader = item.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  if (IS_IOS && isStandalone() && navigator.canShare) {
    const file = new File([blob], item.name, { type: 'application/octet-stream' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: item.name });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') throw new Error('Save cancelled');
        // fall through to the download link
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = item.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function startKeepAlive() {
  if (keepAliveTimer || !registration) return;
  const scope = new URL(registration.scope).pathname;
  keepAliveTimer = setInterval(() => {
    fetch(`${scope}keepalive`, { cache: 'no-store' }).catch(() => {});
  }, 10000);
}

function stopKeepAlive() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}
