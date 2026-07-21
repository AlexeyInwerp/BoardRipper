#!/usr/bin/env node
/**
 * Serves dist-lite/ under the /boardripper/web/ sub-path — mirroring the
 * production mount at ripperdoc.de — so relative-base regressions surface in
 * the lite E2E (and in manual checks via `npm run serve:lite`) instead of on
 * the live host. Dependency-free on purpose.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// Robust against junk argv (e.g. a copy-pasted trailing `# comment` that zsh
// forwards to the script as an argument): fall back to the default on anything
// that isn't a valid port number.
const argPort = Number(process.argv[2]);
const PORT = Number.isInteger(argPort) && argPort > 0 && argPort < 65536 ? argPort : 18086;
const PREFIX = '/boardripper/web';
const ROOT = fileURLToPath(new URL('../dist-lite', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (!url.pathname.startsWith(PREFIX)) {
    res.writeHead(302, { Location: `${PREFIX}/` });
    return res.end();
  }
  let rel = url.pathname.slice(PREFIX.length) || '/';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`not found: ${url.pathname}`);
  }
}).listen(PORT, () => {
  console.log(`lite build at http://localhost:${PORT}${PREFIX}/`);
});
