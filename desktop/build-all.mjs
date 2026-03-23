#!/usr/bin/env node
/**
 * Build all desktop targets:
 *   1. macOS (universal: arm64 + x64)
 *   2. macOS Legacy (Electron 22, x64 — Catalina 10.15+)
 *   3. Windows (x64)
 *
 * The Vite frontend is built once and shared across all targets.
 *
 * Usage:
 *   node build-all.mjs              # build all targets
 *   node build-all.mjs --mac        # macOS only
 *   node build-all.mjs --legacy     # macOS legacy only
 *   node build-all.mjs --win        # Windows only
 *   node build-all.mjs --mac --win  # macOS + Windows
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

// Read version from frontend package.json
const pkg = JSON.parse(readFileSync(path.join(FRONTEND, 'package.json'), 'utf8'));
const APP_VERSION = pkg.version;

// Electron 22.3.27 — last release supporting macOS 10.15 Catalina
const LEGACY_ELECTRON_VERSION = '22.3.27';

// Parse flags
const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const buildAll = !hasFlag('--mac') && !hasFlag('--legacy') && !hasFlag('--win');
const buildMac = buildAll || hasFlag('--mac');
const buildLegacy = buildAll || hasFlag('--legacy');
const buildWin = buildAll || hasFlag('--win');

function run(cmd, cwd = ROOT) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function elapsed(start) {
  const s = ((Date.now() - start) / 1000).toFixed(1);
  return `${s}s`;
}

// Common ignore patterns for @electron/packager
const IGNORE_PATTERNS = [
  /^\/out($|\/)/,
  /^\/out-legacy($|\/)/,
  /^\/out-win($|\/)/,
  /^\/build-.*\.mjs$/,
  /^\/node_modules\/@electron\/packager/,
  /^\/node_modules\/@electron\/universal/,
  /^\/node_modules\/electron($|\/)/,
];

// ═══════════════════════════════════════════════════════════════
// Step 1: Build frontend (once)
// ═══════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}`);
console.log(`  BoardRipper v${APP_VERSION} — Desktop Build`);
console.log(`${'═'.repeat(60)}`);

const targets = [
  buildMac && 'macOS',
  buildLegacy && 'macOS Legacy',
  buildWin && 'Windows',
].filter(Boolean);
console.log(`  Targets: ${targets.join(', ')}`);

const t0 = Date.now();
console.log('\n=== Building frontend (Vite) ===');
run('npx vite build --base ./', FRONTEND);

console.log('\n=== Copying dist → desktop/webapp/ ===');
if (existsSync(WEBAPP_DIR)) rmSync(WEBAPP_DIR, { recursive: true });
mkdirSync(WEBAPP_DIR, { recursive: true });
cpSync(path.join(FRONTEND, 'dist'), WEBAPP_DIR, { recursive: true });

const packager = (await import('@electron/packager')).default;
const results = [];

// ═══════════════════════════════════════════════════════════════
// Step 2: macOS (universal)
// ═══════════════════════════════════════════════════════════════
if (buildMac) {
  const t1 = Date.now();
  const OUT_DIR = path.join(DESKTOP, 'out');
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });

  console.log('\n=== Packaging macOS universal (arm64 + x64) ===');

  const commonOpts = {
    dir: DESKTOP,
    name: 'BoardRipper',
    platform: 'darwin',
    out: OUT_DIR,
    overwrite: true,
    icon: existsSync(path.join(DESKTOP, 'icon.icns'))
      ? path.join(DESKTOP, 'icon.icns')
      : undefined,
    appBundleId: 'com.boardripper.app',
    appVersion: APP_VERSION,
    ignore: IGNORE_PATTERNS,
  };

  console.log('  --- arm64 ---');
  const [arm64Path] = await packager({ ...commonOpts, arch: 'arm64' });
  console.log('  --- x64 ---');
  const [x64Path] = await packager({ ...commonOpts, arch: 'x64' });

  const { makeUniversalApp } = await import('@electron/universal');
  const universalDir = path.join(OUT_DIR, 'BoardRipper-darwin-universal');
  mkdirSync(universalDir, { recursive: true });
  const universalAppPath = path.join(universalDir, 'BoardRipper.app');

  console.log('  --- Merging into universal binary ---');
  await makeUniversalApp({
    x64AppPath: path.join(x64Path, 'BoardRipper.app'),
    arm64AppPath: path.join(arm64Path, 'BoardRipper.app'),
    outAppPath: universalAppPath,
    force: true,
  });

  rmSync(arm64Path, { recursive: true });
  rmSync(x64Path, { recursive: true });

  results.push({ target: 'macOS universal', path: universalDir, time: elapsed(t1) });
}

// ═══════════════════════════════════════════════════════════════
// Step 3: macOS Legacy (Electron 22, x64)
// ═══════════════════════════════════════════════════════════════
if (buildLegacy) {
  const t2 = Date.now();
  const OUT_DIR = path.join(DESKTOP, 'out-legacy');
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });

  console.log(`\n=== Packaging macOS legacy (Electron ${LEGACY_ELECTRON_VERSION}, x64) ===`);

  const [appPath] = await packager({
    dir: DESKTOP,
    name: 'BoardRipper Legacy',
    platform: 'darwin',
    arch: 'x64',
    electronVersion: LEGACY_ELECTRON_VERSION,
    out: OUT_DIR,
    overwrite: true,
    icon: existsSync(path.join(DESKTOP, 'icon.icns'))
      ? path.join(DESKTOP, 'icon.icns')
      : undefined,
    appBundleId: 'com.boardripper.app',
    appVersion: APP_VERSION,
    ignore: IGNORE_PATTERNS,
  });

  const zipName = `BoardRipper-Legacy-macOS-x64-v${APP_VERSION}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);
  console.log(`  --- Creating ${zipName} ---`);
  execSync(
    `cd "${appPath}" && ditto -c -k --sequesterRsrc --keepParent "BoardRipper Legacy.app" "${zipPath}"`,
    { stdio: 'inherit' },
  );

  results.push({ target: 'macOS legacy (x64)', path: zipPath, time: elapsed(t2) });
}

// ═══════════════════════════════════════════════════════════════
// Step 4: Windows (x64)
// ═══════════════════════════════════════════════════════════════
if (buildWin) {
  const t3 = Date.now();
  const OUT_DIR = path.join(DESKTOP, 'out-win');
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });

  console.log('\n=== Packaging Windows (x64) ===');

  const [appPath] = await packager({
    dir: DESKTOP,
    name: 'BoardRipper',
    platform: 'win32',
    arch: 'x64',
    out: OUT_DIR,
    overwrite: true,
    icon: existsSync(path.join(DESKTOP, 'icon.ico'))
      ? path.join(DESKTOP, 'icon.ico')
      : undefined,
    appVersion: APP_VERSION,
    win32metadata: {
      ProductName: 'BoardRipper',
      CompanyName: 'BoardRipper',
      FileDescription: 'PCB Boardview File Viewer',
    },
    ignore: IGNORE_PATTERNS,
  });

  const zipName = `BoardRipper-Windows-x64-v${APP_VERSION}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);
  console.log(`  --- Creating ${zipName} ---`);
  execSync(
    `cd "${OUT_DIR}" && ditto -c -k --keepParent "${path.basename(appPath)}" "${zipPath}"`,
    { stdio: 'inherit' },
  );

  results.push({ target: 'Windows (x64)', path: zipPath, time: elapsed(t3) });
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}`);
console.log(`  Build complete — BoardRipper v${APP_VERSION}  (${elapsed(t0)} total)`);
console.log(`${'═'.repeat(60)}`);
for (const r of results) {
  console.log(`  ✅  ${r.target.padEnd(22)} ${r.time.padStart(7)}  →  ${r.path}`);
}
console.log();
