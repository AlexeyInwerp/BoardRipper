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

/** Cross-platform zip: uses ditto on macOS (preserves resource forks for .app bundles),
 *  zip -r -y on Linux (-y preserves symlinks), Compress-Archive on Windows. */
function zipApp(sourcePath, zipPath) {
  const parentDir = path.dirname(sourcePath);
  const baseName = path.basename(sourcePath);
  if (process.platform === 'darwin') {
    execSync(
      `cd "${parentDir}" && ditto -c -k --sequesterRsrc --keepParent "${baseName}" "${zipPath}"`,
      { stdio: 'inherit' },
    );
  } else if (process.platform === 'win32') {
    execSync(
      `powershell -Command "Compress-Archive -Path '${sourcePath}' -DestinationPath '${zipPath}' -Force"`,
      { stdio: 'inherit' },
    );
  } else {
    // Linux: use zip -y to preserve symlinks (important for macOS .app bundles)
    execSync(
      `cd "${parentDir}" && zip -r -y -q "${zipPath}" "${baseName}"`,
      { stdio: 'inherit' },
    );
  }
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

// ═══════════════════════════════════════════════════════════════
// Step 1.5: Cross-compile the Go backend sidecar (CGO_ENABLED=0, no
// update ldflags — the Docker self-update pipeline doesn't apply here).
// macOS ships a single lipo'd universal binary so @electron/universal's
// makeUniversalApp sees one identical resource in both arch passes.
// ═══════════════════════════════════════════════════════════════
const BACKEND = path.join(ROOT, 'src', 'backend');
const BIN_DIR = path.join(DESKTOP, 'bin');
if (existsSync(BIN_DIR)) rmSync(BIN_DIR, { recursive: true });
mkdirSync(BIN_DIR, { recursive: true });

function goBuild(goos, goarch, outFile) {
  mkdirSync(path.dirname(outFile), { recursive: true });
  console.log(`\n=== Cross-compiling backend ${goos}/${goarch} ===`);
  execSync(
    `go build -ldflags="-s -w -X boardripper/updater.Version=${APP_VERSION}" -o "${outFile}" .`,
    {
      cwd: BACKEND,
      stdio: 'inherit',
      env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
    },
  );
}

if (buildMac || buildLegacy) {
  const armTmp = path.join(BIN_DIR, '.darwin-arm64');
  const x64Tmp = path.join(BIN_DIR, '.darwin-x64');
  goBuild('darwin', 'arm64', armTmp);
  goBuild('darwin', 'amd64', x64Tmp);
  const fat = path.join(BIN_DIR, 'darwin', 'server');
  mkdirSync(path.dirname(fat), { recursive: true });
  console.log('\n=== lipo → universal darwin/server ===');
  execSync(`lipo -create "${armTmp}" "${x64Tmp}" -output "${fat}"`, { stdio: 'inherit' });
  rmSync(armTmp);
  rmSync(x64Tmp);
}
if (buildWin) {
  goBuild('windows', 'amd64', path.join(BIN_DIR, 'win32', 'server.exe'));
}

console.log('\n=== Copying Board Database → desktop/bin/boards.db ===');
cpSync(path.join(ROOT, 'Board Database', 'boards.db'), path.join(BIN_DIR, 'boards.db'));

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
    ignore: [...IGNORE_PATTERNS, /^\/bin\/win32($|\/)/],
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

  const zipName = `BoardRipper-macOS-universal-v${APP_VERSION}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);
  console.log(`  --- Creating ${zipName} ---`);
  zipApp(universalAppPath, zipPath);

  results.push({ target: 'macOS universal', path: zipPath, time: elapsed(t1) });
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
    // Ship the fat darwin/server (macOS runs its x64 slice on legacy).
    ignore: [...IGNORE_PATTERNS, /^\/bin\/win32($|\/)/],
  });

  const zipName = `BoardRipper-Legacy-macOS-x64-v${APP_VERSION}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);
  console.log(`  --- Creating ${zipName} ---`);
  zipApp(path.join(appPath, 'BoardRipper Legacy.app'), zipPath);

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
    ignore: [...IGNORE_PATTERNS, /^\/bin\/darwin($|\/)/],
  });

  const zipName = `BoardRipper-Windows-x64-v${APP_VERSION}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);
  console.log(`  --- Creating ${zipName} ---`);
  zipApp(appPath, zipPath);

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
