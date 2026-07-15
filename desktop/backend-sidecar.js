const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

/** Ask the OS for a free loopback port. main.go binds via srv.ListenAndServe()
 *  with no way to report back which port it chose, so the caller decides the
 *  port up front and passes it via PORT — see docs/specs/
 *  2026-07-15-desktop-mcp-backend-sidecar-design.md §4. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** True if `port` can currently be bound on loopback. Used to decide whether a
 *  previously-persisted preferred port is still usable this launch. Inherently
 *  racy (something could grab it before the backend binds) — the caller treats
 *  a subsequent bind failure as a normal spawn failure. */
function isPortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** Path to the bundled server binary. macOS ships a single lipo'd universal
 *  binary (see build-all.mjs), so there is no per-arch branch. */
function resolveBinaryPath() {
  if (process.platform === 'win32') {
    return path.join(__dirname, 'bin', 'win32', 'server.exe');
  }
  return path.join(__dirname, 'bin', 'darwin', 'server');
}

function resolveBoardDbPath() {
  return path.join(__dirname, 'bin', 'boards.db');
}

/** Spawn the backend. Caller owns the returned process (attach stdout/stderr/
 *  exit listeners; call stopBackend to tear it down). */
function startBackend({ dataDir, libraryDir, staticDir, boardDbPath, port }) {
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    LIBRARY_DIR: libraryDir || '',
    STATIC_DIR: staticDir,
    BOARDDB_PATH: boardDbPath,
  };
  return spawn(resolveBinaryPath(), [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Poll GET /api/health until it returns 200, or timeoutMs elapses. The
 *  backend binds its listener only after full init (databank.Open, board
 *  index), so early polls fail with connection-refused; both that and a 503
 *  "starting" body are retried. 60s default matches the Docker boot invariant. */
async function waitForHealth(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/** Seed the backend's mcp_enabled config flag so /api/mcp serves and the
 *  live-board bridge auto-connects on the next page load. On desktop,
 *  backend-running <-> MCP-enabled, so this is called on every successful
 *  start. Best-effort: a failure just means the user's first MCP call 404s
 *  until they retoggle. */
async function enableMcpConfig(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'mcp_enabled', value: 'true' }),
    });
  } catch { /* best-effort, see doc comment */ }
}

function stopBackend(proc) {
  if (!proc || proc.killed) return;
  proc.kill();
}

module.exports = {
  pickFreePort,
  isPortFree,
  resolveBinaryPath,
  resolveBoardDbPath,
  startBackend,
  waitForHealth,
  enableMcpConfig,
  stopBackend,
};
