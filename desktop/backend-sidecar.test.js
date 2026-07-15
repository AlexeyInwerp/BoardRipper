const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { spawn } = require('node:child_process');
const {
  pickFreePort,
  isPortFree,
  waitForHealth,
  stopBackend,
} = require('./backend-sidecar');

test('pickFreePort returns a usable port in range', async () => {
  const p = await pickFreePort();
  assert.ok(Number.isInteger(p) && p > 0 && p < 65536);
});

test('isPortFree is true for an unused port, false for a bound one', async () => {
  const p = await pickFreePort();
  assert.strictEqual(await isPortFree(p), true);
  const srv = net.createServer();
  await new Promise(res => srv.listen(p, '127.0.0.1', res));
  try {
    assert.strictEqual(await isPortFree(p), false);
  } finally {
    srv.close();
  }
});

test('waitForHealth resolves true once a /api/health server comes up', async () => {
  const port = await pickFreePort();
  // Fake backend that starts serving 200 after a short delay (simulates real
  // startup latency without depending on the Go binary).
  const proc = spawn(process.execPath, ['-e', `
    const http = require('http');
    setTimeout(() => {
      http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
      }).listen(${port}, '127.0.0.1');
    }, 300);
  `]);
  try {
    assert.strictEqual(await waitForHealth(port, 5000), true);
  } finally {
    stopBackend(proc);
  }
});

test('waitForHealth resolves false when nothing ever listens', async () => {
  const port = await pickFreePort();
  assert.strictEqual(await waitForHealth(port, 500), false);
});

test('stopBackend kills the process', async () => {
  const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  const exited = new Promise(resolve => proc.on('exit', resolve));
  stopBackend(proc);
  await exited;
  assert.ok(proc.killed);
});
