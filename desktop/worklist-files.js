/**
 * Worklist documents on disk for the desktop app when no backend runs (MCP
 * off). Same directory, same file format and same rules as the Go backend's
 * `worklists` package — `<userData>/worklists/<id>.json` — so turning MCP on
 * (which starts the backend with DATA_DIR = userData) shows exactly the same
 * worklists, and turning it off again does too. Only one of the two writes at
 * a time: the renderer uses HTTP while a backend answers and these IPC calls
 * otherwise. Spec: docs/specs/2026-11-10-worklist-storage-redesign.md.
 *
 * Rules mirrored from the Go store (keep them in step):
 *  - a put carries the rev it was based on; a mismatch returns the stored
 *    copy as a conflict; success sets rev+1 and updatedAt = now (strictly
 *    increasing per document);
 *  - delete is a tombstone (deleted = now);
 *  - writes go through a temp file + rename;
 *  - tombstones older than 30 days move to .trash/ when the store opens.
 */
const fs = require('node:fs');
const path = require('node:path');

const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_DOC_BYTES = 4 << 20;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function writeAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.wl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

class WorklistFiles {
  constructor(dir, now = () => Date.now()) {
    this.dir = dir;
    this.now = now;
    this.docs = new Map();   // id → parsed document
    fs.mkdirSync(dir, { recursive: true });
    const cutoff = this.now() - TOMBSTONE_TTL_MS;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      let doc;
      try { doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
      if (!doc || doc.id !== id) continue;
      if (doc.deleted && doc.deleted < cutoff) { this.trash(id); continue; }
      this.docs.set(id, doc);
    }
  }

  file(id) { return path.join(this.dir, `${id}.json`); }

  trash(id) {
    const t = path.join(this.dir, '.trash');
    try { fs.mkdirSync(t, { recursive: true }); fs.renameSync(this.file(id), path.join(t, `${id}.${this.now()}.json`)); } catch { /* best effort */ }
  }

  /** { docs, now }: every document changed after `since`, oldest first. */
  list(since = 0) {
    const docs = [...this.docs.values()].filter(d => (d.updatedAt || 0) > since)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    return { docs, now: this.now() };
  }

  get(id) { return this.docs.get(id) ?? null; }

  /** { ok: true, doc } or { conflict: true, doc } or { error } */
  put(doc) {
    if (!doc || typeof doc !== 'object' || !ID_RE.test(String(doc.id))) return { error: 'bad id' };
    const id = doc.id;
    const cur = this.docs.get(id);
    let base = Number(doc.rev) || 0;
    if (cur && base !== (cur.rev || 0)) return { conflict: true, doc: cur };
    if (!cur) base = 0;
    let now = this.now();
    if (cur && now <= (cur.updatedAt || 0)) now = cur.updatedAt + 1;
    const next = { ...doc, rev: base + 1, updatedAt: now };
    const json = JSON.stringify(next);
    if (Buffer.byteLength(json) > MAX_DOC_BYTES) return { error: 'document too large' };
    writeAtomic(this.file(id), json);
    this.docs.set(id, next);
    return { ok: true, doc: next };
  }

  delete(id, rev) {
    const cur = this.docs.get(id);
    if (!cur) return { ok: true, doc: null };
    return this.put({ ...cur, rev, deleted: this.now() });
  }
}

/** Register the IPC handlers on `ipcMain`. The store opens lazily, on first use. */
function registerWorklistIpc(ipcMain, dir) {
  let store = null;
  const s = () => (store ??= new WorklistFiles(dir));
  ipcMain.handle('worklist:list', (_e, since) => s().list(Number(since) || 0));
  ipcMain.handle('worklist:get', (_e, id) => s().get(String(id)));
  ipcMain.handle('worklist:put', (_e, doc) => s().put(doc));
  ipcMain.handle('worklist:delete', (_e, id, rev) => s().delete(String(id), Number(rev) || 0));
}

module.exports = { WorklistFiles, registerWorklistIpc, TOMBSTONE_TTL_MS };
