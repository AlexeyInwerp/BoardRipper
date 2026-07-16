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

// Parse --arch flag: "arm64", "x64", or "universal" (default: host arch).
// Parsed up here because the backend cross-compile step (below) needs it.
const archArg = process.argv.find(a => a.startsWith('--arch='));
const requestedArch = archArg ? archArg.split('=')[1] : process.arch === 'arm64' ? 'arm64' : 'x64';

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

// ---------- 2.5. Cross-compile the Go backend sidecar ----------
const BACKEND = path.join(ROOT, 'src', 'backend');
const BIN_DIR = path.join(DESKTOP, 'bin');
const APP_VERSION = JSON.parse(readFileSync(path.join(FRONTEND, 'package.json'), 'utf8')).version;
if (existsSync(BIN_DIR)) rmSync(BIN_DIR, { recursive: true });
mkdirSync(BIN_DIR, { recursive: true });

function goBuild(goarch, outFile) {
  // Map Electron/packager arch naming ('x64') to Go's GOARCH ('amd64').
  const goGoarch = goarch === 'x64' ? 'amd64' : goarch;
  mkdirSync(path.dirname(outFile), { recursive: true });
  console.log(`\n=== Cross-compiling backend darwin/${goGoarch} ===`);
  execSync(
    `go build -ldflags="-s -w -X boardripper/updater.Version=${APP_VERSION}" -o "${outFile}" .`,
    {
      cwd: BACKEND,
      stdio: 'inherit',
      env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: goGoarch },
    },
  );
}

const fat = path.join(BIN_DIR, 'darwin', 'server');
mkdirSync(path.dirname(fat), { recursive: true });
if (requestedArch === 'universal') {
  const armTmp = path.join(BIN_DIR, '.darwin-arm64');
  const x64Tmp = path.join(BIN_DIR, '.darwin-x64');
  goBuild('arm64', armTmp);
  goBuild('x64', x64Tmp);
  execSync(`lipo -create "${armTmp}" "${x64Tmp}" -output "${fat}"`, { stdio: 'inherit' });
  rmSync(armTmp);
  rmSync(x64Tmp);
} else {
  goBuild(requestedArch, fat);
}
cpSync(path.join(ROOT, 'Board Database', 'boards.db'), path.join(BIN_DIR, 'boards.db'));

// ---------- 3. Package with @electron/packager ----------

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

/** Ad-hoc sign + zip an .app bundle for distribution. */
function signAndZip(appPath, appName, archLabel) {
  console.log('\n--- Ad-hoc code signing ---');
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });

  const zipName = `BoardRipper-macOS-${archLabel}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);
  console.log(`\n--- Creating ${zipName} ---`);
  execSync(
    `cd "${path.dirname(appPath)}" && ditto -c -k --sequesterRsrc --keepParent "${appName}" "${zipPath}"`,
    { stdio: 'inherit' },
  );

  console.log(`\n✅  Done!`);
  console.log(`    App:  ${appPath}`);
  console.log(`    Zip:  ${zipPath}`);
  console.log(`\n    Distribute the .zip — unzipping preserves framework symlinks and clears quarantine.`);
}

if (requestedArch === 'universal') {
  console.log('\n=== Packaging macOS universal app (arm64 + x64) ===');

  console.log('\n--- Building arm64 ---');
  const [arm64Path] = await packager({ ...commonOpts, arch: 'arm64' });
  console.log('\n--- Building x64 ---');
  const [x64Path] = await packager({ ...commonOpts, arch: 'x64' });

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

  rmSync(arm64Path, { recursive: true });
  rmSync(x64Path, { recursive: true });

  signAndZip(universalAppPath, 'BoardRipper.app', 'universal');
} else {
  console.log(`\n=== Packaging macOS app (${requestedArch}) ===`);
  const [appPath] = await packager({ ...commonOpts, arch: requestedArch });

  signAndZip(`${appPath}/BoardRipper.app`, 'BoardRipper.app', requestedArch);
}
