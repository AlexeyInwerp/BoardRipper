#!/usr/bin/env node
/**
 * Legacy macOS build — uses Electron 22 (last version supporting macOS 10.15 Catalina).
 * Produces an x64-only .app (Catalina never ran on Apple Silicon).
 */
import { execSync } from 'child_process';
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONTEND = path.join(ROOT, 'src', 'frontend');
const DESKTOP = __dirname;
const WEBAPP_DIR = path.join(DESKTOP, 'webapp');
const OUT_DIR = path.join(DESKTOP, 'out-legacy');

// Electron 22.3.27 — last release supporting macOS 10.15 Catalina
const ELECTRON_VERSION = '22.3.27';

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

// ---------- 3. Package with Electron 22 (x64 only) ----------
console.log(`\n=== Packaging legacy macOS app (Electron ${ELECTRON_VERSION}, x64) ===`);

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });

const packager = (await import('@electron/packager')).default;
const [appPath] = await packager({
  dir: DESKTOP,
  name: 'BoardRipper Legacy',
  platform: 'darwin',
  arch: 'x64',
  electronVersion: ELECTRON_VERSION,
  out: OUT_DIR,
  overwrite: true,
  icon: existsSync(path.join(DESKTOP, 'icon.icns'))
    ? path.join(DESKTOP, 'icon.icns')
    : undefined,
  appBundleId: 'com.boardripper.app',
  appVersion: JSON.parse(readFileSync(path.join(FRONTEND, 'package.json'), 'utf8')).version,
  ignore: [
    /^\/out($|\/)/,
    /^\/out-legacy($|\/)/,
    /^\/build-mac.*\.mjs$/,
    /^\/node_modules\/@electron\/packager/,
    /^\/node_modules\/@electron\/universal/,
    /^\/node_modules\/electron($|\/)/,
  ],
});

// Ad-hoc code sign so macOS doesn't block the app
console.log('\n--- Ad-hoc code signing ---');
execSync(`codesign --force --deep --sign - "${appPath}/BoardRipper Legacy.app"`, { stdio: 'inherit' });

// Create a zip for safe distribution (avoids App Translocation on macOS 10.15+)
const zipName = 'BoardRipper-Legacy-macOS-x64.zip';
const zipPath = path.join(OUT_DIR, zipName);
console.log(`\n--- Creating ${zipName} ---`);
execSync(
  `cd "${appPath}" && ditto -c -k --sequesterRsrc --keepParent "BoardRipper Legacy.app" "${zipPath}"`,
  { stdio: 'inherit' },
);

console.log(`\n✅  Done!`);
console.log(`    App:  ${appPath}/BoardRipper Legacy.app`);
console.log(`    Zip:  ${zipPath}`);
console.log(`\n    Supports: macOS 10.15 Catalina and later (Intel x64)`);
console.log(`    Distribute the .zip — unzipping clears quarantine and avoids App Translocation.`);
