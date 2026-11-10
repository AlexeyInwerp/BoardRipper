/**
 * Desktop self-update, end to end in the real app (desktop/updater.js).
 *
 * A local HTTP server plays ripperdoc.de: it serves desktop.json, its
 * minisign signature (made here with a throwaway key, in minisign's own
 * layout) and a zip. The dev run takes the key, feed and version from
 * BOARDRIPPER_UPDATE_* — a packaged app ignores those. A dev run is not an
 * installed app, so the install ends in the "downloaded, replace it by hand"
 * branch; the swap itself is covered by desktop/updater.test.js.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '../../../desktop');
const built = fs.existsSync(path.join(DESKTOP, 'webapp', 'index.html'));
const require_ = createRequire(path.join(DESKTOP, 'package.json'));
const { blake2b512 } = require_('./update-verify.js') as { blake2b512: (b: Buffer) => Buffer };

function makeSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const keyId = crypto.randomBytes(8);
  const pub = Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64');
  const sign = (message: Buffer) => {
    const comment = 'timestamp:0';
    const sig = crypto.sign(null, blake2b512(message), privateKey);
    const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
    return `untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64')}\n`
      + `trusted comment: ${comment}\n${global.toString('base64')}\n`;
  };
  return { pub, sign };
}

test.describe('desktop self-update', () => {
  test.skip(!built, 'desktop/webapp not built — run desktop/build-all.mjs first');

  const signer = makeSigner();
  const zip = crypto.randomBytes(300_000);
  let feed = Buffer.alloc(0);
  let sig = '';
  let server: http.Server;
  let base = '';
  let app: ElectronApplication;
  let page: Page;
  let userDataDir = '';

  const publish = (version: string, { tamper = false } = {}) => {
    feed = Buffer.from(JSON.stringify({
      version,
      notes: `## ${version}\n- Faster things`,
      notes_url: 'https://example.invalid/notes',
      builds: Object.fromEntries(['darwin-universal', 'win32-x64'].map(b => [b, {
        url_primary: `${base}/dead/BoardRipper-${version}.zip`, // a dead primary: the mirror must be tried
        url_mirrors: [`${base}/BoardRipper-${version}.zip`],
        sha256: crypto.createHash('sha256').update(zip).digest('hex'),
        size_bytes: zip.length,
      }])),
    }));
    sig = signer.sign(tamper ? Buffer.from('something else') : feed);
  };

  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url || '';
      if (url === '/desktop.json') return res.end(feed);
      if (url === '/desktop.json.minisig') return res.end(sig);
      if (/^\/BoardRipper-.*\.zip$/.test(url)) return res.end(zip);
      res.statusCode = 404; res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    publish('v0.51.0');

    const env: Record<string, string> = {
      NODE_ENV: 'production',
      BOARDRIPPER_APP_VERSION: '0.51.0',
      BOARDRIPPER_UPDATE_PUBKEY: signer.pub,
      BOARDRIPPER_UPDATE_FEEDS: base,
      BOARDRIPPER_UPDATE_NO_REVEAL: '1',
    };
    for (const [k, v] of Object.entries(process.env)) {
      if (k === 'ELECTRON_RUN_AS_NODE' || v === undefined || k in env) continue;
      env[k] = v;
    }
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-electron-upd-'));
    app = await electron.launch({
      executablePath: require_('electron') as string,
      args: [DESKTOP, `--user-data-dir=${userDataDir}`],
      env,
    });
    page = await app.firstWindow();
    await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 30000 });
  });

  test.afterAll(async () => {
    await app?.close();
    server?.close();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const badge = () => page.getByTestId('update-badge');
  const reopen = async () => {
    if (await page.getByTestId('update-dropdown').isVisible()) await badge().click();
    await badge().click();
  };

  test('the same version is not offered', async () => {
    await expect(badge()).toHaveText('v0.51.0');
    await reopen();
    await expect(page.getByTestId('update-dropdown')).toContainText('You are on the latest version.');
    await expect(badge()).not.toHaveClass(/has-update/);
  });

  test('a feed whose signature does not verify is refused', async () => {
    publish('v0.60.0', { tamper: true });
    await reopen();
    await expect(page.getByTestId('update-error')).toContainText('signature');
    await expect(badge()).not.toHaveClass(/has-update/);
  });

  test('a newer signed version is offered, downloaded from the mirror and verified', async () => {
    publish('v0.60.0');
    await reopen();
    await expect(badge()).toHaveClass(/has-update/);
    await expect(page.getByTestId('update-whats-new')).toContainText('v0.60.0');
    await page.getByTestId('update-install').click();
    // A dev run cannot replace itself: the verified zip is handed over instead.
    await expect(page.getByTestId('update-manual')).toContainText('development run');
    const zips = fs.readdirSync(path.join(userDataDir, 'updates'));
    expect(zips).toEqual(['BoardRipper-v0.60.0.zip']);
    expect(fs.readFileSync(path.join(userDataDir, 'updates', zips[0])).equals(zip)).toBe(true);
  });
});
