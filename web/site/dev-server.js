// Tiny zero-dep dev server: serves static files from this directory,
// proxies /api/* to the gateway. Shipped gateway builds serve the
// checked-in static files themselves.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:4001';
const PROXY_PREFIXES = ['/api/'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function shouldProxy(urlPath) {
  return PROXY_PREFIXES.some((p) => urlPath.startsWith(p));
}

function proxyToGateway(req, res) {
  const target = new URL(GATEWAY);
  const options = {
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: target.host },
  };
  const upstream = httpRequest(options, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `gateway unreachable: ${err.message}` }));
  });
  req.pipe(upstream);
}

async function serveStatic(req, res) {
  const safePath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let filePath = resolve(__dirname, '.' + safePath);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // not a real path on disk — fall back to index.html for SPA-like clients
    filePath = join(__dirname, 'index.html');
  }
  try {
    const buf = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

createServer((req, res) => {
  if (shouldProxy(req.url ?? '')) return proxyToGateway(req, res);
  return serveStatic(req, res);
}).listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`site: http://localhost:${PORT} (proxying /api/* → ${GATEWAY})`);
});
