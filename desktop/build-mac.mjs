#!/usr/bin/env node
/**
 * Build script: produces BoardRipper.app for macOS.
 *
 * Steps:
 *  1. Build the Vite frontend (production)
 *  2. Copy the build output into desktop/webapp/
 *  3. Run @electron/packager to create the .app bundle
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
const OUT_DIR = path.join(DESKTOP, 'out');

function run(cmd, cwd = ROOT) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

// ---------- 1. Build frontend ----------
// Use relative base so assets resolve from file:// in Electron
console.log('=== Building frontend (Vite) ===');
run('npx vite build --base ./', FRONTEND);

// ---------- 2. Copy dist → desktop/webapp ----------
console.log('\n=== Copying build output → desktop/webapp/ ===');
if (existsSync(WEBAPP_DIR)) rmSync(WEBAPP_DIR, { recursive: true });
mkdirSync(WEBAPP_DIR, { recursive: true });
cpSync(path.join(FRONTEND, 'dist'), WEBAPP_DIR, { recursive: true });

// ---------- 3. Package with @electron/packager ----------

// Parse --arch flag: "arm64", "x64", or "universal" (default: host arch)
const archArg = process.argv.find(a => a.startsWith('--arch='));
const requestedArch = archArg ? archArg.split('=')[1] : process.arch === 'arm64' ? 'arm64' : 'x64';

// Clean previous output
if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });

const packager = (await import('@electron/packager')).default;

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
  appVersion: JSON.parse(readFileSync(path.join(FRONTEND, 'package.json'), 'utf8')).version,
  ignore: [
    /^\/out($|\/)/,
    /^\/out-legacy($|\/)/,
    /^\/build-mac.*\.mjs$/,
    /^\/node_modules\/@electron\/packager/,
    /^\/node_modules\/@electron\/universal/,
    /^\/node_modules\/electron($|\/)/,
  ],
};

if (requestedArch === 'universal') {
  console.log('\n=== Packaging macOS universal app (arm64 + x64) ===');

  // Build both architectures
  console.log('\n--- Building arm64 ---');
  const [arm64Path] = await packager({ ...commonOpts, arch: 'arm64' });
  console.log('\n--- Building x64 ---');
  const [x64Path] = await packager({ ...commonOpts, arch: 'x64' });

  // Merge into universal binary
  const { makeUniversalApp } = await import('@electron/universal');
  const universalDir = path.join(OUT_DIR, 'BoardRipper-darwin-universal');
  mkdirSync(universalDir, { recursive: true });
  const universalAppPath = path.join(universalDir, 'BoardRipper.app');

  console.log('\n--- Merging into universal binary ---');
  await makeUniversalApp({
    x64AppPath: path.join(x64Path, 'BoardRipper.app'),
    arm64AppPath: path.join(arm64Path, 'BoardRipper.app'),
    outAppPath: universalAppPath,
    force: true,
  });

  // Clean up single-arch builds
  rmSync(arm64Path, { recursive: true });
  rmSync(x64Path, { recursive: true });

  console.log(`\n✅  Done! Universal app at:\n    ${universalDir}`);
  console.log(`\n    To run:  open "${universalAppPath}"`);
} else {
  console.log(`\n=== Packaging macOS app (${requestedArch}) ===`);
  const [appPath] = await packager({ ...commonOpts, arch: requestedArch });

  console.log(`\n✅  Done! App bundle at:\n    ${appPath}`);
  console.log(`\n    To run:  open "${appPath}/BoardRipper.app"`);
}
