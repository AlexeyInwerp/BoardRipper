// Desktop self-update (issue #42). Plan: docs/plans/2026-10-29-desktop-update-path.md
//
// 1. Check: fetch desktop.json + .minisig from the feed sources in order; the
//    first whose signature verifies under a trusted key wins (the Docker
//    manifest rule). Offer only a version newer than the running one.
// 2. Install, when the user says so: download this build's zip, verify size
//    and sha256 against the signed feed, extract it next to the running app
//    (same volume, so the swap is a rename), check the extracted version.
// 3. Swap on quit: a detached shell / cmd helper waits for this process to
//    exit, renames running → old and staged → running, optionally relaunches.
//    Neither OS lets a running binary be replaced in place.
// Where a swap cannot be safe (dev run, translocated or read-only app, odd
// path) the verified zip is revealed in Finder / Explorer instead.
//
// No Electron imports here: main.js injects them, so the pure parts run under
// `node --test` (updater.test.js).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { verifyAny } = require('./update-verify');

const DEFAULT_FEEDS = [
  'https://www.ripperdoc.de/boardripper/desktop',
  'https://github.com/AlexeyInwerp/BoardRipper/releases/latest/download',
];
const FEED_NAME = 'desktop.json';
const STAGE_DIR = '.boardripper-update';
const FEED_TIMEOUT_MS = 30_000;
const ZIP_TIMEOUT_MS = 10 * 60_000;
const MAX_FEED_BYTES = 1 << 20;
const MAX_ZIP_BYTES = 1 << 30;

// ── pure helpers ──

/** Digit-wise version compare; a pre-release sorts before its release
 *  (the rule of updater.parseVersion on the Go side). */
function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v || '').trim().replace(/^v/, '');
    const dash = s.indexOf('-');
    const core = dash >= 0 ? s.slice(0, dash) : s;
    const pre = dash >= 0 ? s.slice(dash + 1) : '';
    return { nums: core.split('.').map(n => parseInt(n, 10) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Validate a parsed feed and return the entry for this build, or throw. */
function pickBuild(feed, build) {
  if (!feed || typeof feed !== 'object') throw new Error('feed is not an object');
  if (typeof feed.version !== 'string' || !/^v?\d+\.\d+\.\d+/.test(feed.version)) {
    throw new Error('feed has no valid version');
  }
  const entry = feed.builds && feed.builds[build];
  if (!entry) throw new Error(`feed has no build for ${build}`);
  if (typeof entry.url_primary !== 'string' || !entry.url_primary) throw new Error('build has no url');
  if (!/^[0-9a-f]{64}$/i.test(entry.sha256 || '')) throw new Error('build has no sha256');
  if (!Number.isInteger(entry.size_bytes) || entry.size_bytes <= 0 || entry.size_bytes > MAX_ZIP_BYTES) {
    throw new Error('build has no valid size');
  }
  const mirrors = Array.isArray(entry.url_mirrors) ? entry.url_mirrors.filter(u => typeof u === 'string') : [];
  return { ...entry, urls: [entry.url_primary, ...mirrors] };
}

/** Where the running app lives and whether it may be replaced.
 *  → { ok: true, target, parent, kind } | { ok: false, reason } */
function planInstall({ execPath, platform, isPackaged, writable }) {
  if (!isPackaged) return { ok: false, reason: 'this is a development run, not an installed app' };
  if (platform === 'darwin') {
    const m = execPath.match(/^(.*?\.app)\/Contents\/MacOS\/[^/]+$/);
    if (!m) return { ok: false, reason: 'the app bundle could not be located' };
    const target = m[1];
    if (target.includes('/AppTranslocation/')) {
      return { ok: false, reason: 'macOS is running the app from a temporary copy (move it to Applications to enable updates)' };
    }
    const parent = path.dirname(target);
    if (!writable(parent) || !writable(target)) {
      return { ok: false, reason: `the folder ${parent} is not writable` };
    }
    return { ok: true, target, parent, kind: 'darwin' };
  }
  if (platform === 'win32') {
    const target = path.win32.dirname(execPath);
    const parent = path.win32.dirname(target);
    // The cmd helper cannot quote these safely.
    if (/[%"!^]/.test(target)) return { ok: false, reason: 'the install path contains characters the updater cannot handle' };
    if (!writable(parent) || !writable(target)) {
      return { ok: false, reason: `the folder ${parent} is not writable` };
    }
    return { ok: true, target, parent, kind: 'win32', exe: path.win32.basename(execPath) };
  }
  return { ok: false, reason: `no installer for ${platform}` };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** /bin/sh helper: wait for pid, swap bundles, relaunch. */
function darwinSwapScript({ pid, target, staged, stage, log, relaunch }) {
  const old = path.join(stage, 'previous.app');
  return `#!/bin/sh
PID=${Number(pid)}
TARGET=${shq(target)}
NEW=${shq(staged)}
OLD=${shq(old)}
STAGE=${shq(stage)}
LOG=${shq(log)}
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }
log "waiting for pid $PID to exit"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -gt 600 ]; then log "app did not exit within 60 s, update left staged"; exit 1; fi
  sleep 0.1
done
rm -rf "$OLD"
if ! mv "$TARGET" "$OLD"; then log "could not move $TARGET aside, update left staged"; exit 1; fi
if mv "$NEW" "$TARGET"; then
  log "installed $TARGET"
  rm -rf "$STAGE"
else
  log "could not move the new app into place, restoring the old one"
  mv "$OLD" "$TARGET"
fi
${relaunch ? 'open "$TARGET"\nlog "relaunched"' : ''}
`;
}

/** cmd helper: same steps; ping is the sleep because `timeout` needs a console. */
function win32SwapScript({ pid, target, staged, stage, log, relaunch, exe }) {
  const old = path.win32.join(stage, 'previous');
  return [
    '@echo off',
    `set "PID=${Number(pid)}"`,
    `set "TARGET=${target}"`,
    `set "NEW=${staged}"`,
    `set "OLD=${old}"`,
    `set "STAGE=${stage}"`,
    `set "LOG=${log}"`,
    `set "EXE=${exe}"`,
    'set N=0',
    '>>"%LOG%" echo waiting for pid %PID% to exit',
    ':wait',
    'tasklist /FI "PID eq %PID%" /NH 2>NUL | find " %PID% " >NUL',
    'if errorlevel 1 goto gone',
    'set /a N+=1',
    'if %N% GTR 120 goto timeout',
    'ping -n 2 127.0.0.1 >NUL',
    'goto wait',
    ':gone',
    'if exist "%OLD%" rmdir /s /q "%OLD%"',
    'set R=0',
    ':moveold',
    'move "%TARGET%" "%OLD%" >NUL 2>&1',
    'if not errorlevel 1 goto movenew',
    'set /a R+=1',
    'if %R% GTR 15 goto busy',
    'ping -n 2 127.0.0.1 >NUL',
    'goto moveold',
    ':movenew',
    'move "%NEW%" "%TARGET%" >NUL 2>&1',
    'if errorlevel 1 goto restore',
    '>>"%LOG%" echo installed %TARGET%',
    'rmdir /s /q "%STAGE%"',
    relaunch ? 'start "" "%TARGET%\\%EXE%"' : 'rem no relaunch',
    'exit /b 0',
    ':restore',
    '>>"%LOG%" echo could not move the new app into place, restoring the old one',
    'move "%OLD%" "%TARGET%" >NUL 2>&1',
    relaunch ? 'start "" "%TARGET%\\%EXE%"' : 'rem no relaunch',
    'exit /b 1',
    ':busy',
    '>>"%LOG%" echo %TARGET% stayed in use, update left staged',
    'exit /b 1',
    ':timeout',
    '>>"%LOG%" echo app did not exit within 2 minutes, update left staged',
    'exit /b 1',
    '',
  ].join('\r\n');
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${(stderr || err.message).toString().trim()}`));
      else resolve(String(stdout));
    });
  });
}

// ── the updater ──

/**
 * deps:
 *   currentVersion, build, pubKeys[], feeds[]
 *   request(url, { maxBytes, timeoutMs, file?, onProgress? }) → Promise<Buffer | void>
 *   loadSettings(), saveSettings(s), log(level, msg)
 *   userData, logDir, tmpDir, execPath, platform, isPackaged, pid
 *   revealFile(path), onState(state)
 */
function createUpdater(deps) {
  const state = {
    current: deps.currentVersion,
    build: deps.build,
    enabled: deps.pubKeys.length > 0,
    phase: 'idle', // idle | checking | available | downloading | staging | ready | manual | error
    latest: null, // { version, released_at, notes_url, notes }
    progress: null, // { received, total }
    error: null,
    manualPath: null,
    manualReason: null,
    checkedAt: deps.loadSettings().lastUpdateCheck || 0,
    skipped: deps.loadSettings().skippedVersion || null,
  };
  let feedEntry = null;
  let staged = null; // { plan, staged, stage }
  let checking = null;
  let installing = null;

  const emit = () => deps.onState({ ...state });
  const set = (patch) => { Object.assign(state, patch); emit(); };

  async function fetchFeed() {
    const errors = [];
    for (const base of deps.feeds) {
      const url = `${base.replace(/\/$/, '')}/${FEED_NAME}`;
      try {
        const body = await deps.request(url, { maxBytes: MAX_FEED_BYTES, timeoutMs: FEED_TIMEOUT_MS });
        const sig = await deps.request(`${url}.minisig`, { maxBytes: 8192, timeoutMs: FEED_TIMEOUT_MS });
        if (!verifyAny(body, sig.toString('utf8'), deps.pubKeys)) {
          throw new Error('signature does not verify under any trusted key');
        }
        const feed = JSON.parse(body.toString('utf8'));
        return { feed, entry: pickBuild(feed, deps.build), url };
      } catch (err) {
        errors.push(`${url}: ${err.message}`);
        deps.log('WARN', `update feed ${url} rejected: ${err.message}`);
      }
    }
    throw new Error(errors.join('; ') || 'no feed sources configured');
  }

  /** Check the feed. `manual` = the user asked: errors are shown, a skipped
   *  version is offered again. */
  function check({ manual = false } = {}) {
    if (!state.enabled) return Promise.resolve({ ...state });
    if (checking) return checking;
    // Never step back from a download or a staged update.
    if (['downloading', 'staging', 'ready'].includes(state.phase)) return Promise.resolve({ ...state });
    checking = (async () => {
      const prev = state.phase;
      set({ phase: 'checking', error: null });
      try {
        const { feed, entry, url } = await fetchFeed();
        const s = deps.loadSettings();
        s.lastUpdateCheck = Date.now();
        deps.saveSettings(s);
        const newer = compareVersions(feed.version, deps.currentVersion) > 0;
        if (manual && state.skipped === feed.version) {
          state.skipped = null;
          const s2 = deps.loadSettings(); delete s2.skippedVersion; deps.saveSettings(s2);
        }
        feedEntry = newer ? entry : null;
        deps.log('INFO', `update check via ${url}: running ${deps.currentVersion}, feed ${feed.version}${newer ? ' — update available' : ''}`);
        set({
          checkedAt: s.lastUpdateCheck,
          phase: newer ? 'available' : 'idle',
          latest: {
            version: feed.version,
            released_at: feed.released_at || null,
            notes_url: feed.notes_url || null,
            notes: typeof feed.notes === 'string' ? feed.notes : '',
          },
        });
      } catch (err) {
        deps.log('WARN', `update check failed: ${err.message}`);
        // A background check that fails keeps whatever was known before.
        if (manual) set({ phase: 'error', error: err.message });
        else set({ phase: prev === 'checking' ? 'idle' : prev });
      }
      return { ...state };
    })().finally(() => { checking = null; });
    return checking;
  }

  function skip() {
    if (!state.latest) return;
    const s = deps.loadSettings();
    s.skippedVersion = state.latest.version;
    deps.saveSettings(s);
    set({ skipped: state.latest.version });
  }

  async function download(entry, version) {
    const dir = path.join(deps.userData, 'updates');
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, path.basename(new URL(entry.url_primary).pathname) || `BoardRipper-${version}.zip`);
    const part = `${zip}.part`;
    // A zip already downloaded and verified is reused.
    if (fs.existsSync(zip) && fs.statSync(zip).size === entry.size_bytes
        && (await sha256File(zip)) === entry.sha256.toLowerCase()) {
      return zip;
    }
    const errors = [];
    for (const url of entry.urls) {
      try {
        fs.rmSync(part, { force: true });
        set({ progress: { received: 0, total: entry.size_bytes } });
        await deps.request(url, {
          maxBytes: entry.size_bytes,
          timeoutMs: ZIP_TIMEOUT_MS,
          file: part,
          onProgress: (received) => set({ progress: { received, total: entry.size_bytes } }),
        });
        const size = fs.statSync(part).size;
        if (size !== entry.size_bytes) throw new Error(`size ${size}, expected ${entry.size_bytes}`);
        const sum = await sha256File(part);
        if (sum !== entry.sha256.toLowerCase()) throw new Error('sha256 does not match the signed feed');
        fs.renameSync(part, zip);
        deps.log('INFO', `update ${version} downloaded from ${url}`);
        return zip;
      } catch (err) {
        errors.push(`${url}: ${err.message}`);
        deps.log('WARN', `update download ${url} failed: ${err.message}`);
      }
    }
    fs.rmSync(part, { force: true });
    throw new Error(errors.join('; '));
  }

  async function stage(zip, plan, version) {
    const stageDir = path.join(plan.parent, STAGE_DIR);
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });
    const extract = path.join(stageDir, 'new');
    fs.mkdirSync(extract);
    const want = version.replace(/^v/, '');
    if (plan.kind === 'darwin') {
      await run('/usr/bin/ditto', ['-x', '-k', zip, extract]);
      const apps = fs.readdirSync(extract).filter(n => n.endsWith('.app'));
      if (apps.length !== 1) throw new Error(`expected one .app in the zip, found ${apps.length}`);
      const app = path.join(extract, apps[0]);
      const got = (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-',
        path.join(app, 'Contents', 'Info.plist')])).trim();
      if (got !== want) throw new Error(`the downloaded app is version ${got}, expected ${want}`);
      // A file Node downloaded carries no quarantine flag; clear it anyway so
      // the swapped-in bundle never asks for right-click ▸ Open.
      await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]).catch(() => {});
      return { staged: app, stage: stageDir };
    }
    // Windows 10+ ships bsdtar, which reads zip.
    await run('tar', ['-xf', zip, '-C', extract]);
    const dirs = fs.readdirSync(extract).filter(n => fs.existsSync(path.join(extract, n, plan.exe)));
    if (dirs.length !== 1) throw new Error(`expected one app folder with ${plan.exe} in the zip`);
    return { staged: path.join(extract, dirs[0]), stage: stageDir };
  }

  /** Download, verify and stage the offered update. */
  function install() {
    if (installing) return installing;
    if (!feedEntry || !state.latest) return Promise.resolve({ ...state });
    const entry = feedEntry;
    const version = state.latest.version;
    installing = (async () => {
      set({ phase: 'downloading', error: null, progress: { received: 0, total: entry.size_bytes } });
      try {
        const zip = await download(entry, version);
        const plan = planInstall({
          execPath: deps.execPath,
          platform: deps.platform,
          isPackaged: deps.isPackaged,
          writable: (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } },
        });
        if (!plan.ok) {
          deps.log('INFO', `update ${version} cannot be installed in place (${plan.reason}); revealing ${zip}`);
          deps.revealFile(zip);
          set({ phase: 'manual', progress: null, manualPath: zip, manualReason: plan.reason });
          return { ...state };
        }
        set({ phase: 'staging', progress: null });
        const s = await stage(zip, plan, version);
        staged = { plan, ...s };
        deps.log('INFO', `update ${version} staged at ${s.staged}; installs when the app quits`);
        set({ phase: 'ready' });
      } catch (err) {
        deps.log('ERROR', `update ${version} failed: ${err.message}`);
        set({ phase: 'error', progress: null, error: err.message });
      }
      return { ...state };
    })().finally(() => { installing = null; });
    return installing;
  }

  /** Called from the app's quit path: hand the staged update to a detached
   *  helper that swaps it in once this process is gone. */
  function applyOnQuit({ relaunch }) {
    if (!staged) return false;
    const { plan } = staged;
    const swapLog = path.join(deps.logDir, 'update-swap.log');
    const args = { pid: deps.pid, target: plan.target, staged: staged.staged, stage: staged.stage, log: swapLog, relaunch, exe: plan.exe };
    try {
      if (plan.kind === 'darwin') {
        // The helper lives outside the staging folder it deletes.
        const script = path.join(deps.tmpDir, `boardripper-swap-${deps.pid}.sh`);
        fs.writeFileSync(script, darwinSwapScript(args), { mode: 0o755 });
        spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
      } else {
        const script = path.join(deps.tmpDir, `boardripper-swap-${deps.pid}.cmd`);
        fs.writeFileSync(script, win32SwapScript(args));
        spawn('cmd.exe', ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
      deps.log('INFO', `update swap helper started (relaunch=${relaunch}); log: ${swapLog}`);
      staged = null;
      return true;
    } catch (err) {
      deps.log('ERROR', `could not start the update swap helper: ${err.message}`);
      return false;
    }
  }

  /** Leftovers of an earlier update: the downloaded zips, and a staging
   *  folder next to the app (a completed swap removes it; a failed one
   *  leaves it for the log to explain). */
  function cleanupOnLaunch() {
    try { fs.rmSync(path.join(deps.userData, 'updates'), { recursive: true, force: true }); } catch {}
    const plan = planInstall({ execPath: deps.execPath, platform: deps.platform, isPackaged: deps.isPackaged, writable: () => true });
    if (plan.ok) {
      const dir = path.join(plan.parent, STAGE_DIR);
      if (fs.existsSync(dir)) {
        deps.log('INFO', `removing update leftovers at ${dir}`);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  return {
    getState: () => ({ ...state }),
    check,
    skip,
    install,
    applyOnQuit,
    hasStaged: () => !!staged,
    cleanupOnLaunch,
  };
}

module.exports = {
  DEFAULT_FEEDS,
  compareVersions,
  pickBuild,
  planInstall,
  darwinSwapScript,
  win32SwapScript,
  createUpdater,
};
