#!/usr/bin/env node
// Post-process the `--mode offline` build into ONE self-contained file:
//   dist-offline/boardripper-lite.html
// vite-plugin-singlefile already inlines JS + CSS into index.html; this step
// inlines the favicon and drops the leftover files (the stray parse-worker
// chunk + public assets), which the offline build parses on the main thread and
// never references. Result: a single HTML you can open straight from file://.
import { readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../dist-offline', import.meta.url));
let html = await readFile(join(OUT, 'index.html'), 'utf8');

// Inline the favicon (logo.svg) as a data URI so no external file is needed.
try {
  const svg = await readFile(join(OUT, 'logo.svg'), 'utf8');
  const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  html = html.replace(/href="\.\/logo\.svg"/g, `href="${dataUri}"`);
} catch { /* no favicon shipped — fine */ }

await writeFile(join(OUT, 'boardripper-lite.html'), html);

// Keep ONLY the single file.
for (const entry of await readdir(OUT)) {
  if (entry !== 'boardripper-lite.html') await rm(join(OUT, entry), { recursive: true, force: true });
}

// The authoritative "no external refs" check is the file:// E2E
// (tests/offline-file.spec.ts): any real external reference would fail to load
// under file:// and surface as a failed request. A regex scan here can't tell a
// real tag from the src=/href= string literals inside 7 MB of inlined app JS.
console.log(`packed dist-offline/boardripper-lite.html (${(html.length / 1024 / 1024).toFixed(1)} MB)`);
