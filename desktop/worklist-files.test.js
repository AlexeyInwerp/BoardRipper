const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorklistFiles, TOMBSTONE_TTL_MS } = require('./worklist-files');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wl-'));

test('put, conflict, reopen — same rules as the Go store', () => {
  const dir = tmp();
  const s = new WorklistFiles(dir);
  const a = s.put({ id: 'w1', rev: 0, name: 'No power', board: '820-02016' });
  assert.ok(a.ok);
  assert.strictEqual(a.doc.rev, 1);
  const c = s.put({ id: 'w1', rev: 0, name: 'other' });
  assert.ok(c.conflict);
  assert.strictEqual(c.doc.name, 'No power');
  const b = s.put({ ...a.doc, name: 'No power v2' });
  assert.strictEqual(b.doc.rev, 2);
  const again = new WorklistFiles(dir);
  assert.strictEqual(again.get('w1').name, 'No power v2');
  assert.ok(!fs.readdirSync(dir).some(n => n.endsWith('.tmp')));
});

test('updatedAt strictly increases and since sees every write', () => {
  const s = new WorklistFiles(tmp(), () => 1000);
  const a = s.put({ id: 'a', rev: 0 }).doc;
  const b = s.put({ ...a }).doc;
  assert.ok(b.updatedAt > a.updatedAt);
  assert.strictEqual(s.list(a.updatedAt).docs.length, 1);
});

test('delete is a tombstone; an old one moves to .trash on open', () => {
  const dir = tmp();
  const s = new WorklistFiles(dir);
  const a = s.put({ id: 'x', rev: 0, name: 'gone' }).doc;
  assert.ok(s.delete('x', 99).conflict);
  const t = s.delete('x', a.rev);
  assert.ok(t.ok && t.doc.deleted && t.doc.name === 'gone');
  const later = new WorklistFiles(dir, () => Date.now() + TOMBSTONE_TTL_MS + 3600e3);
  assert.strictEqual(later.get('x'), null);
  assert.strictEqual(fs.readdirSync(path.join(dir, '.trash')).length, 1);
});

test('bad ids are refused', () => {
  const s = new WorklistFiles(tmp());
  assert.ok(s.put({ id: '../evil', rev: 0 }).error);
});
