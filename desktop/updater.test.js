// node --test desktop/updater.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { blake2b512, verifyAny } = require('./update-verify');
const {
  compareVersions, pickBuild, planInstall, darwinSwapScript, win32SwapScript, createUpdater,
} = require('./updater');

// A minisign key pair and signer in minisign's own layout, so the tests need
// no minisign binary.
function makeSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const keyId = crypto.randomBytes(8);
  const pub = Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64');
  const sign = (message, comment = 'timestamp:0') => {
    const sig = crypto.sign(null, blake2b512(message), privateKey);
    const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
    return `untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64')}\n`
      + `trusted comment: ${comment}\n${global.toString('base64')}\n`;
  };
  return { pub, sign };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'br-upd-'));

test('blake2b512 matches the RFC 7693 vector for "abc"', () => {
  assert.strictEqual(blake2b512('abc').toString('hex'),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1'
    + '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923');
});

test('minisign verification: good, tampered, wrong key, edited comment, no keys', () => {
  const a = makeSigner();
  const b = makeSigner();
  const msg = Buffer.from('{"version":"v1.2.3"}');
  const sig = a.sign(msg);
  assert.strictEqual(verifyAny(msg, sig, [a.pub]), true);
  assert.strictEqual(verifyAny(Buffer.from('{"version":"v9.9.9"}'), sig, [a.pub]), false);
  assert.strictEqual(verifyAny(msg, sig, [b.pub]), false);
  assert.strictEqual(verifyAny(msg, sig, [b.pub, a.pub]), true, 'rotation window: any trusted key');
  assert.strictEqual(verifyAny(msg, sig.replace('timestamp:0', 'timestamp:1'), [a.pub]), false);
  assert.throws(() => verifyAny(msg, sig, []), /no trusted/);
});

test('compareVersions', () => {
  assert.strictEqual(compareVersions('v0.52.0', '0.51.9'), 1);
  assert.strictEqual(compareVersions('0.51.0', 'v0.51.0'), 0);
  assert.strictEqual(compareVersions('0.9.0', '0.10.0'), -1);
  assert.strictEqual(compareVersions('0.52.0-beta', '0.52.0'), -1);
  assert.strictEqual(compareVersions('1.0', '1.0.0'), 0);
});

test('pickBuild validates the entry', () => {
  const entry = { url_primary: 'https://x/a.zip', url_mirrors: ['https://y/a.zip'], sha256: 'a'.repeat(64), size_bytes: 10 };
  const feed = { version: 'v1.0.0', builds: { 'darwin-universal': entry } };
  assert.deepStrictEqual(pickBuild(feed, 'darwin-universal').urls, ['https://x/a.zip', 'https://y/a.zip']);
  assert.throws(() => pickBuild(feed, 'win32-x64'), /no build/);
  assert.throws(() => pickBuild({ ...feed, builds: { w: { ...entry, sha256: 'xyz' } } }, 'w'), /sha256/);
  assert.throws(() => pickBuild({ ...feed, version: 'latest' }, 'darwin-universal'), /version/);
});

test('planInstall refuses what it cannot replace safely', () => {
  const ok = () => true;
  const mac = '/Applications/BoardRipper.app/Contents/MacOS/BoardRipper';
  assert.deepStrictEqual(planInstall({ execPath: mac, platform: 'darwin', isPackaged: true, writable: ok }),
    { ok: true, target: '/Applications/BoardRipper.app', parent: '/Applications', kind: 'darwin' });
  assert.strictEqual(planInstall({ execPath: mac, platform: 'darwin', isPackaged: false, writable: ok }).ok, false);
  assert.match(planInstall({
    execPath: '/private/var/folders/x/AppTranslocation/ABC/d/BoardRipper.app/Contents/MacOS/BoardRipper',
    platform: 'darwin', isPackaged: true, writable: ok,
  }).reason, /temporary copy/);
  assert.match(planInstall({ execPath: mac, platform: 'darwin', isPackaged: true, writable: () => false }).reason, /not writable/);
  const win = planInstall({ execPath: 'C:\\Tools\\BoardRipper-win32-x64\\BoardRipper.exe', platform: 'win32', isPackaged: true, writable: ok });
  assert.deepStrictEqual(win, { ok: true, target: 'C:\\Tools\\BoardRipper-win32-x64', parent: 'C:\\Tools', kind: 'win32', exe: 'BoardRipper.exe' });
  assert.strictEqual(planInstall({ execPath: 'C:\\100%\\BoardRipper-win32-x64\\BoardRipper.exe', platform: 'win32', isPackaged: true, writable: ok }).ok, false);
});

test('win32 swap script carries the paths and the relaunch', () => {
  const s = win32SwapScript({ pid: 42, target: 'C:\\A\\B', staged: 'C:\\A\\.u\\new\\B', stage: 'C:\\A\\.u', log: 'C:\\L\\swap.log', relaunch: true, exe: 'BoardRipper.exe' });
  assert.match(s, /set "TARGET=C:\\A\\B"/);
  assert.match(s, /start "" "%TARGET%\\%EXE%"/);
  assert.ok(s.includes('\r\n'));
});

test('darwin swap script swaps once the pid is gone, and keeps the old app on failure', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  const target = path.join(dir, "Board 'Ripper'.app"); // a quote in the path
  const stage = path.join(dir, '.boardripper-update');
  const staged = path.join(stage, 'new', 'BoardRipper.app');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'v'), 'old');
  fs.mkdirSync(staged, { recursive: true }); fs.writeFileSync(path.join(staged, 'v'), 'new');
  const deadPid = spawnSync('true').pid; // exited already
  const log = path.join(dir, 'swap.log');
  const script = path.join(dir, 'swap.sh');
  fs.writeFileSync(script, darwinSwapScript({ pid: deadPid, target, staged, stage, log, relaunch: false }));
  execFileSync('/bin/sh', [script]);
  assert.strictEqual(fs.readFileSync(path.join(target, 'v'), 'utf8'), 'new');
  assert.strictEqual(fs.existsSync(stage), false);
  assert.match(fs.readFileSync(log, 'utf8'), /installed/);

  // Nothing staged: the old app must still be in place afterwards.
  fs.mkdirSync(stage);
  execFileSync('/bin/sh', [script]);
  assert.strictEqual(fs.readFileSync(path.join(target, 'v'), 'utf8'), 'new');
  assert.match(fs.readFileSync(log, 'utf8'), /restoring the old one/);
});

// ── the whole flow against an in-memory feed ──

function fakeApp(dir, version) {
  const app = path.join(dir, 'BoardRipper.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'BoardRipper'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`
    + `<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`);
  return app;
}

function setup({ feedVersion = 'v0.60.0', zipVersion = '0.60.0', tamper = false, writable = true } = {}) {
  const root = tmp();
  const installDir = path.join(root, 'Applications');
  fs.mkdirSync(installDir);
  const running = fakeApp(installDir, '0.51.0');
  if (!writable) fs.chmodSync(installDir, 0o555);
  const build = path.join(root, 'build');
  fs.mkdirSync(build);
  fakeApp(build, zipVersion);
  const zip = path.join(root, 'BoardRipper-macOS-universal-v0.60.0.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(build, 'BoardRipper.app'), zip]);
  const zipBytes = fs.readFileSync(zip);
  const signer = makeSigner();
  const feed = Buffer.from(JSON.stringify({
    version: feedVersion,
    notes: '## v0.60.0\n- things',
    notes_url: 'https://example.invalid/notes',
    builds: { 'darwin-universal': {
      url_primary: 'https://dl.invalid/BoardRipper-macOS-universal-v0.60.0.zip',
      url_mirrors: ['https://mirror.invalid/BoardRipper-macOS-universal-v0.60.0.zip'],
      sha256: crypto.createHash('sha256').update(zipBytes).digest('hex'),
      size_bytes: zipBytes.length,
    } },
  }));
  const files = {
    'https://feed.invalid/desktop.json': feed,
    'https://feed.invalid/desktop.json.minisig': Buffer.from(signer.sign(tamper ? Buffer.from('other') : feed)),
    'https://mirror.invalid/BoardRipper-macOS-universal-v0.60.0.zip': zipBytes,
  };
  const requested = [];
  let settings = {};
  const states = [];
  const revealed = [];
  const updater = createUpdater({
    currentVersion: '0.51.0',
    build: 'darwin-universal',
    pubKeys: [signer.pub],
    feeds: ['https://feed.invalid'],
    request: async (url, { maxBytes, file, onProgress }) => {
      requested.push(url);
      const body = files[url];
      if (!body) throw new Error('HTTP 404');
      if (body.length > maxBytes) throw new Error('too large');
      if (file) { fs.writeFileSync(file, body); onProgress?.(body.length); return undefined; }
      return body;
    },
    loadSettings: () => ({ ...settings }),
    saveSettings: (s) => { settings = s; },
    log: () => {},
    userData: path.join(root, 'userData'),
    logDir: root,
    tmpDir: root,
    execPath: path.join(running, 'Contents', 'MacOS', 'BoardRipper'),
    platform: 'darwin',
    isPackaged: true,
    pid: spawnSync('true').pid,
    revealFile: (p) => revealed.push(p),
    onState: (s) => states.push(s.phase),
  });
  return { root, installDir, running, updater, requested, states, revealed, getSettings: () => settings };
}

const onMac = { skip: process.platform !== 'darwin' };

test('check → install → swap on quit installs the new app', onMac, async () => {
  const t = setup();
  const st = await t.updater.check();
  assert.strictEqual(st.phase, 'available');
  assert.strictEqual(st.latest.version, 'v0.60.0');
  assert.ok(t.getSettings().lastUpdateCheck > 0);

  const done = await t.updater.install();
  assert.strictEqual(done.phase, 'ready', done.error || '');
  assert.ok(t.requested.includes('https://dl.invalid/BoardRipper-macOS-universal-v0.60.0.zip'), 'primary tried first');
  assert.ok(t.states.includes('downloading') && t.states.includes('staging'));

  assert.strictEqual(t.updater.applyOnQuit({ relaunch: false }), true);
  // The helper is detached; wait for it.
  const plist = path.join(t.running, 'Contents', 'Info.plist');
  for (let i = 0; i < 100 && !fs.readFileSync(plist, 'utf8').includes('0.60.0'); i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  assert.match(fs.readFileSync(plist, 'utf8'), /0\.60\.0/);
  assert.deepStrictEqual(fs.readdirSync(t.installDir), ['BoardRipper.app']);
});

test('a feed whose signature does not verify offers nothing', onMac, async () => {
  const t = setup({ tamper: true });
  const st = await t.updater.check({ manual: true });
  assert.strictEqual(st.phase, 'error');
  assert.match(st.error, /signature/);
  assert.ok(!t.requested.some(u => u.endsWith('.zip')));
});

test('an equal version is not offered', onMac, async () => {
  const t = setup({ feedVersion: 'v0.51.0' });
  assert.strictEqual((await t.updater.check()).phase, 'idle');
});

test('a zip whose app reports another version is not staged', onMac, async () => {
  const t = setup({ zipVersion: '0.59.0' });
  await t.updater.check();
  const st = await t.updater.install();
  assert.strictEqual(st.phase, 'error');
  assert.match(st.error, /version 0\.59\.0/);
  assert.strictEqual(t.updater.applyOnQuit({ relaunch: false }), false);
});

test('a read-only install folder gets the verified zip revealed instead', onMac, async () => {
  const t = setup({ writable: false });
  try {
    await t.updater.check();
    const st = await t.updater.install();
    assert.strictEqual(st.phase, 'manual');
    assert.match(st.manualReason, /not writable/);
    assert.deepStrictEqual(t.revealed, [st.manualPath]);
  } finally {
    fs.chmodSync(t.installDir, 0o755);
  }
});

test('skip remembers the version; a manual check offers it again', onMac, async () => {
  const t = setup();
  await t.updater.check();
  t.updater.skip();
  assert.strictEqual(t.getSettings().skippedVersion, 'v0.60.0');
  const st = await t.updater.check({ manual: true });
  assert.strictEqual(st.skipped, null);
  assert.strictEqual(t.getSettings().skippedVersion, undefined);
});
