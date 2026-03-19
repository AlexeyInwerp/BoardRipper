#!/usr/bin/env node
/**
 * Build script: produces BoardRipper for Windows (x64).
 *
 * Cross-compilation from macOS requires Wine for code-signing (optional).
 * The app itself packages fine without it.
 */
import { execSync } from 'child_process';
import { cpSync, rmSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONTEND = path.join(ROOT, 'src', 'frontend');
const DESKTOP = __dirname;
const WEBAPP_DIR = path.join(DESKTOP, 'webapp');
const OUT_DIR = path.join(DESKTOP, 'out-win');

function run(cmd, cwd = ROOT) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

// ---------- 1. Build frontend ----------
console.log('=== Building frontend (Vite) ===');
run('npx vite build --base ./', FRONTEND);

// ---------- 2. Copy dist → desktop/webapp ----------
console.log('\n=== Copying build output → desktop/webapp/ ===');
if (existsSync(WEBAPP_DIR)) rmSync(WEBAPP_DIR, { recursive: true });
mkdirSync(WEBAPP_DIR, { recursive: true });
cpSync(path.join(FRONTEND, 'dist'), WEBAPP_DIR, { recursive: true });

// ---------- 3. Package for Windows ----------
const archArg = process.argv.find(a => a.startsWith('--arch='));
const requestedArch = archArg ? archArg.split('=')[1] : 'x64';

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });

const packager = (await import('@electron/packager')).default;

const [appPath] = await packager({
  dir: DESKTOP,
  name: 'BoardRipper',
  platform: 'win32',
  arch: requestedArch,
  out: OUT_DIR,
  overwrite: true,
  icon: existsSync(path.join(DESKTOP, 'icon.ico'))
    ? path.join(DESKTOP, 'icon.ico')
    : undefined,
  appVersion: '1.0.0',
  win32metadata: {
    ProductName: 'BoardRipper',
    CompanyName: 'BoardRipper',
    FileDescription: 'PCB Boardview File Viewer',
  },
  ignore: [
    /^\/out($|\/)/,
    /^\/out-legacy($|\/)/,
    /^\/out-win($|\/)/,
    /^\/build-mac.*\.mjs$/,
    /^\/build-win\.mjs$/,
    /^\/node_modules\/@electron\/packager/,
    /^\/node_modules\/@electron\/universal/,
    /^\/node_modules\/electron($|\/)/,
  ],
});

// Create a zip
const zipName = `BoardRipper-Windows-${requestedArch}.zip`;
const zipPath = path.join(OUT_DIR, zipName);
console.log(`\n--- Creating ${zipName} ---`);
execSync(
  `cd "${OUT_DIR}" && ditto -c -k --keepParent "${path.basename(appPath)}" "${zipPath}"`,
  { stdio: 'inherit' },
);

console.log(`\n✅  Done!`);
console.log(`    App:  ${appPath}`);
console.log(`    Zip:  ${zipPath}`);
