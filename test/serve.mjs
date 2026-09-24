// Tiny static file server for local development and tests.
// Usage: node test/serve.mjs [port]; HOST=0.0.0.0 to reach it from a phone on the same network.
import http from 'node:http';
import os from 'node:os';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * On loopback only this machine asks, and the tests fetch their scratch files from test/.tmp. Bound
 * to any other address it serves the app to the network, and nothing else of the checkout: no
 * dotfiles (.git, .env, the tests' scratch) and no node_modules.
 */
const NOT_THE_APP = /(^|\/)(\.[^/]*|node_modules)(\/|$)/;

export function startServer(port = 0, host = '127.0.0.1') {
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://localhost');
    if (reqUrl.pathname === '/__doh') {
      // Test double for a DNS-over-HTTPS JSON resolver: *.dead.example does not exist, anything else resolves.
      const name = reqUrl.searchParams.get('name') || '';
      const body = /dead\.example$/.test(name)
        ? { Status: 3, Answer: [] }
        : { Status: 0, Answer: [{ name, type: 1, data: '127.0.0.1' }] };
      res.writeHead(200, { 'Content-Type': 'application/dns-json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(reqUrl.pathname); } catch { res.writeHead(400).end(); return; }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.join(ROOT, path.normalize(pathname));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    if (!loopback && NOT_THE_APP.test(path.relative(ROOT, file).split(path.sep).join('/'))) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    let stat;
    try { stat = statSync(file); } catch { stat = null; }
    if (!stat || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      const at = ['0.0.0.0', '::', 'localhost'].includes(host) ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
      resolve({ server, port: actual, url: `http://${at}:${actual}/` });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  const { url, port } = await startServer(Number(process.argv[2]) || 8080, host);
  console.log(`Phone Torrent served at ${url}`);
  if (host === '127.0.0.1') console.log('Only this machine can open it; HOST=0.0.0.0 npm start lets a phone on the same network in.');
  else {
    const lan = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal && ['0.0.0.0', '::', a.address].includes(host));
    for (const a of lan) console.log(`On the network: http://${a.address}:${port}/ (not a secure page there: the Cloud tab works, in-browser torrents need HTTPS or localhost)`);
  }
}
