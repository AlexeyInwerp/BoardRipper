# Worklist v2 — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the worklist's separate "AI measurement list" onto the net rows as an inline V/Diode/Ω field (user- and agent-settable), make the agent see user-recorded readings, reduce the AI section to just the relay, and replace the two overlapping board-highlight systems with one off-by-default toggle.

**Architecture:** The measurement becomes a property of `NetWorklistEntry` (`measurement?: NetMeasurement`) instead of a flat `Worklist.measurements[]` array. A hydrate-time migration moves any persisted array onto net rows. The store gains net-measurement methods; the MCP bridge/tools route net targets to those and part/pin targets to the relay; `get_measurements` reads inline (source-agnostic). The net row gains a measurement strip. The `AiWorklistSection` loses its measurement block (becomes relay-only). `redrawMultiHighlight` only paints worklist outlines when the new single `connectionHighlight` toggle is on, keeping mark colours and adding the shared-net glow.

**Tech Stack:** React 19 + TypeScript (frontend), Go (backend MCP server), Playwright (frontend tests), `go test` (backend tests). Stores are plain classes with `subscribe`/`notify`; persistence is IndexedDB (`boardripper-worklist`).

## Global Constraints

- **TypeScript strict mode.** No `any` in new code.
- **Logging:** use scoped loggers from `store/log-store.ts` (`log.cache.*` etc.), never `console.*`.
- **Frontend tests are Playwright only** (`npx playwright test`, run from `src/frontend/`). There is no unit-test runner — store/migration logic is tested by driving `window.__worklistStore` / `window.__boardStore` (DEV-only globals). Specs that need a board are fixture-guarded with `fs.existsSync` and `test.skip`.
- **Geometry assertions, not bare `toBeVisible()`** for any positioned UI (per `feedback_playwright_verify_ui`): assert `boundingBox()` is on-screen and anchored to its trigger.
- **Backend tests:** `go test ./mcpserver/` from `src/backend/`.
- **Persisted-format compatibility:** worklists persisted before this change MUST hydrate without data loss (the migration). Bump `schemaVersion` to `1`.
- **Measurement kinds on net rows are exactly `voltage | diode | resistance`** (UI: V / Diode / Ω). No `continuity`/`other` on net rows.
- **Commit before deleting >10 lines** (project safety rule). Frequent commits.
- **Branch:** `feature/worklist-unify-measurements` (already exists, off `main` @ v0.31.24; base also carries an unmerged CAD-OOM fix to reconcile at merge time — do not rebase away).
- **Spec:** `docs/specs/2026-06-23-worklist-unify-per-net-measurements-design.md`.

---

## File Structure

- `src/frontend/src/store/worklist-store.ts` — **modify.** Data model (`NetMeasurement`, `NetWorklistEntry.measurement`, `schemaVersion`, `Worklist.updatedAt`), migration, net-measurement methods, `aiSnapshot` shape, remove flat-array methods, expose `window.__worklistStore` in DEV.
- `src/frontend/src/panels/WorklistPanel.tsx` — **modify.** Net-row measurement strip (`WorklistNetRow`), strip the measurements block from `AiWorklistSection` (→ relay-only), repurpose the header "Connections" button as the single "Highlight" toggle.
- `src/frontend/src/renderer/BoardRenderer.ts` — **modify.** `redrawMultiHighlight` only paints worklist outlines when `connectionHighlight` is on; shared-net glow no longer needs the cyan selection set (keep mark colours).
- `src/backend/mcpserver/tools_live.go` — **modify.** `request_measurement` net-vs-part/pin routing; `get_measurements` reads inline net measurements (source-agnostic); `worklist_get` measurement section.
- `src/backend/mcpserver/bridge.go` / `bridge_ws.go` — **modify if needed.** Dispatch passthrough (most logic is frontend `mcp-bridge.ts`).
- `src/frontend/src/store/mcp-bridge.ts` — **modify.** Bridge handlers for the new net-measurement routing + `get_measurements` shape.
- `.claude/skills/boardripper-repair-helper/SKILL.md` — **modify.** Worklist-loop playbook: measurements per net; part/pin asks via relay.
- `src/frontend/tests/worklist-measurements.spec.ts` — **create.** Store/migration + net-row UI + highlight specs.
- `src/backend/mcpserver/mcpserver_test.go` — **modify.** `request_measurement` routing + `get_measurements` source-agnostic.

---

### Task 1: Data model — `NetMeasurement` + net entry field + structural fields

**Files:**
- Modify: `src/frontend/src/store/worklist-store.ts` (interfaces near `NetWorklistEntry` ~line 65, `Worklist` ~line 103, `BoardWorklistes` ~line 124)
- Test: `src/frontend/tests/worklist-measurements.spec.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export interface NetMeasurement {
    kind: 'voltage' | 'diode' | 'resistance';
    value?: string;
    unit?: string;
    status: 'requested' | 'recorded';
    prompt?: string;
    expected?: string;
    source: 'agent' | 'user';
    at: number;
  }
  // NetWorklistEntry gains: measurement?: NetMeasurement
  // Worklist gains: updatedAt: number
  // BoardWorklistes gains: schemaVersion: number   (device?: DeviceRef is Phase 2 — NOT here)
  export const NET_MEASUREMENT_UNITS: Record<NetMeasurement['kind'], string> =
    { voltage: 'V', diode: 'V', resistance: 'Ω' };
  ```
- Note: keep the existing `MeasurementEntry` interface in the file for now — the migration (Task 2) reads it. It is removed from the *active* model (no longer produced).

- [ ] **Step 1: Expose the store for tests (DEV-only global)**

At the bottom of `worklist-store.ts`, after `export const worklistStore = new WorklistStore();`, add (mirroring board-store.ts:2006):
```ts
if (import.meta.env.DEV) {
  (window as unknown as { __worklistStore?: typeof worklistStore }).__worklistStore = worklistStore;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/frontend/tests/worklist-measurements.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

// Store-level tests drive the DEV-exposed worklist store directly (no board UI).
test('NetMeasurement type + units table exist', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
  const units = await page.evaluate(() => {
    // @ts-expect-error DEV global
    return window.__worklistStore?.NET_MEASUREMENT_UNITS_PROBE?.();
  });
  expect(units).toEqual({ voltage: 'V', diode: 'V', resistance: 'Ω' });
});
```
Add a tiny probe getter on the store class so the test can read the constant without importing the module:
```ts
// In WorklistStore class:
NET_MEASUREMENT_UNITS_PROBE() { return NET_MEASUREMENT_UNITS; }
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd src/frontend && npx playwright test tests/worklist-measurements.spec.ts -g "units table" --reporter=line`
Expected: FAIL (`units` is `undefined` — store/probe not added yet).

- [ ] **Step 4: Add the interfaces + constant**

In `worklist-store.ts`, add `NetMeasurement` + `NET_MEASUREMENT_UNITS` (exact code from Interfaces above) before `NetWorklistEntry`. Add `measurement?: NetMeasurement;` to `NetWorklistEntry`. Add `updatedAt: number;` to `Worklist`. Add `schemaVersion: number;` to `BoardWorklistes`. Add the `NET_MEASUREMENT_UNITS_PROBE()` method.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd src/frontend && npx playwright test tests/worklist-measurements.spec.ts -g "units table" --reporter=line`
Expected: PASS. Then `npx tsc --noEmit` → clean (the `MeasurementEntry`/`measurements[]` are still present, so no break yet).

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/store/worklist-store.ts src/frontend/tests/worklist-measurements.spec.ts
git commit -m "feat(worklist): NetMeasurement model + structural fields (schemaVersion, updatedAt)"
```

---

### Task 2: Migration — persisted `measurements[]` → net rows / relay

**Files:**
- Modify: `src/frontend/src/store/worklist-store.ts` (the hydrate path — the method that back-fills `netEntries: []`, ~lines 200–263)
- Test: `src/frontend/tests/worklist-measurements.spec.ts`

**Interfaces:**
- Consumes: `NetMeasurement`, `MeasurementEntry`, `NET_MEASUREMENT_UNITS` (Task 1).
- Produces: `migrateLegacyMeasurements(w: Worklist, board: BoardData | null): void` (private) — idempotent; stamps `w.updatedAt` if unset; called once per worklist in the hydrate loop. After migration `w.measurements` is deleted.

- [ ] **Step 1: Write the failing test**

Append to `worklist-measurements.spec.ts`:
```ts
test('migration: legacy net-targeted measurement moves onto the net row; part target → relay', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
  const out = await page.evaluate(() => {
    // @ts-expect-error DEV global
    const ws = window.__worklistStore;
    const w = {
      id: 'w1', name: 't', createdAt: 1, entries: [{ refdes: 'D4200', mark: 'none', note: '' }],
      netEntries: [{ netName: 'PPBUS_AON', mark: 'none', note: '' }],
      measurements: [
        { id: 'm1', target: 'PPBUS_AON', kind: 'voltage', prompt: 'measure', value: '12.4', unit: 'V', status: 'answered', source: 'agent', requestedAt: 1, answeredAt: 2 },
        { id: 'm2', target: 'D4200', kind: 'diode', prompt: 'diode drop?', status: 'pending', source: 'agent', requestedAt: 1 },
      ],
    };
    ws.MIGRATE_PROBE(w);
    return { net: w.netEntries[0].measurement, msgs: (w.messages ?? []).length, hasArray: 'measurements' in w };
  });
  expect(out.net).toMatchObject({ kind: 'voltage', value: '12.4', unit: 'V', status: 'recorded', source: 'agent' });
  expect(out.msgs).toBe(1);        // D4200 (part) → relay message
  expect(out.hasArray).toBe(false); // array deleted
});
```
Add a probe wrapper on the store:
```ts
MIGRATE_PROBE(w: Worklist) { this.migrateLegacyMeasurements(w, boardStore.board); }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/frontend && npx playwright test tests/worklist-measurements.spec.ts -g "migration" --reporter=line`
Expected: FAIL (`MIGRATE_PROBE`/`migrateLegacyMeasurements` undefined).

- [ ] **Step 3: Implement the migration**

Add the private method:
```ts
private migrateLegacyMeasurements(w: Worklist, _board: BoardData | null): void {
  const legacy = (w as Worklist & { measurements?: MeasurementEntry[] }).measurements;
  if (!Array.isArray(legacy) || legacy.length === 0) {
    delete (w as { measurements?: unknown }).measurements;
    if (w.updatedAt == null) w.updatedAt = w.createdAt ?? Date.now();
    return;
  }
  const netByName = new Map<string, NetWorklistEntry>();
  for (const e of w.netEntries) netByName.set(e.netName.toLowerCase(), e);
  for (const m of legacy) {
    if (m.status === 'skipped') continue;
    const net = netByName.get(m.target.toLowerCase());
    const kind = (m.kind === 'voltage' || m.kind === 'diode' || m.kind === 'resistance') ? m.kind : null;
    if (net && kind) {
      const next: NetMeasurement = {
        kind,
        value: m.value,
        unit: m.unit ?? NET_MEASUREMENT_UNITS[kind],
        status: m.status === 'answered' ? 'recorded' : 'requested',
        prompt: m.prompt || undefined,
        expected: m.expected,
        source: m.source ?? 'agent',
        at: m.answeredAt ?? m.requestedAt ?? Date.now(),
      };
      // Keep the most recent if a net already got one.
      if (!net.measurement || (net.measurement.at ?? 0) < next.at) net.measurement = next;
    } else {
      // Part/pin/unknown-net or unsupported kind → preserve as a relay message.
      (w.messages ??= []).push({
        id: `mig_${m.id}`, role: 'agent',
        text: `Measurement (${m.kind}) on ${m.target}: ${m.value ? `${m.value} ${m.unit ?? ''}`.trim() : m.prompt}`,
        at: m.requestedAt ?? Date.now(),
      });
    }
  }
  delete (w as { measurements?: unknown }).measurements;
  if (w.updatedAt == null) w.updatedAt = w.createdAt ?? Date.now();
}
```
Add `MIGRATE_PROBE`. In the hydrate loop (where `netEntries` is back-filled, ~line 207), after the per-worklist netEntries back-fill, call `this.migrateLegacyMeasurements(s, board);` for each worklist `s`. Stamp `value.schemaVersion = 1` on the loaded `BoardWorklistes` if absent.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/frontend && npx playwright test tests/worklist-measurements.spec.ts -g "migration" --reporter=line`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/store/worklist-store.ts src/frontend/tests/worklist-measurements.spec.ts
git commit -m "feat(worklist): hydrate-time migration of legacy measurements onto net rows"
```

---

### Task 3: Store API — net-measurement methods; remove flat-array methods; aiSnapshot

**Files:**
- Modify: `src/frontend/src/store/worklist-store.ts` (the AI methods block ~lines 689–760; `aiSnapshot`)
- Test: `src/frontend/tests/worklist-measurements.spec.ts`

**Interfaces:**
- Produces (all operate on the active worklist's net entries; auto-add the net if absent via existing `pushNets`):
  ```ts
  setNetMeasurement(worklistId: string, netName: string, kind: NetMeasurement['kind'], value: string, unit?: string): boolean
  requestNetMeasurement(netName: string, opts: { kind: NetMeasurement['kind']; prompt?: string; expected?: string }): boolean
  recordNetMeasurement(netName: string, value: string, unit?: string): boolean
  clearNetMeasurement(worklistId: string, netName: string): void
  ```
- Removes: `aiRequestMeasurement`, `answerMeasurement(id,…)`, `skipMeasurement(id)`.
- Changes: `aiSnapshot()` returns each net entry with its `measurement` inline; drops the top-level `measurements` array. Shape consumed by `mcp-bridge.ts` (Task 6).

- [ ] **Step 1: Write the failing test**

Append:
```ts
test('store: user records a net measurement; agent requests one; clear removes it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
  const out = await page.evaluate(() => {
    // @ts-expect-error DEV global
    const ws = window.__worklistStore;
    const id = ws.TEST_NEW_WORKLIST('case');     // helper below
    ws.setNetMeasurement(id, 'PP3V3', 'resistance', '47', 'Ω');
    ws.requestNetMeasurement('PPBUS', { kind: 'voltage', prompt: 'main rail?' });
    const snap = ws.aiSnapshot();
    ws.clearNetMeasurement(id, 'PP3V3');
    const after = ws.aiSnapshot();
    return { snap, afterHasPP3V3Meas: !!after.netEntries.find((n: any) => n.netName === 'PP3V3')?.measurement };
  });
  const pp3v3 = out.snap.netEntries.find((n: any) => n.netName === 'PP3V3');
  const ppbus = out.snap.netEntries.find((n: any) => n.netName === 'PPBUS');
  expect(pp3v3.measurement).toMatchObject({ kind: 'resistance', value: '47', unit: 'Ω', status: 'recorded', source: 'user' });
  expect(ppbus.measurement).toMatchObject({ kind: 'voltage', status: 'requested', source: 'agent' });
  expect('measurements' in out.snap).toBe(false);
  expect(out.afterHasPP3V3Meas).toBe(false);
});
```
Add a test helper (DEV only is fine — guard not required since it's harmless):
```ts
TEST_NEW_WORKLIST(name: string): string {
  const cur = this.getOrInit(); if (!cur) throw new Error('no board');
  const w = this.createWorklist(name); return w!.id;
}
```
(Requires a board loaded; if `getOrInit` returns null because no board, the test must load a board first — but these store tests run without a board. So `TEST_NEW_WORKLIST` should fall back to an in-memory board container: if `getOrInit` is null, create a throwaway `BoardWorklistes` keyed `test:` and set it active. Implement that fallback inside `TEST_NEW_WORKLIST` so store tests don't need a board.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/frontend && npx playwright test tests/worklist-measurements.spec.ts -g "user records a net measurement" --reporter=line`
Expected: FAIL (methods undefined).

- [ ] **Step 3: Implement the four methods + aiSnapshot change**

```ts
setNetMeasurement(worklistId: string, netName: string, kind: NetMeasurement['kind'], value: string, unit?: string): boolean {
  const cur = this.current; if (!cur) return false;
  const s = cur.worklistes.find(x => x.id === worklistId); if (!s) return false;
  if (!s.netEntries.some(n => n.netName === netName)) this.pushNets(worklistId, [netName]);
  const e = s.netEntries.find(n => n.netName === netName); if (!e) return false;
  e.measurement = { kind, value, unit: unit ?? NET_MEASUREMENT_UNITS[kind], status: 'recorded', source: 'user', at: Date.now() };
  s.updatedAt = Date.now();
  this.save(cur); return true;
}
requestNetMeasurement(netName: string, opts: { kind: NetMeasurement['kind']; prompt?: string; expected?: string }): boolean {
  const t = this.aiTarget(); if (!t) return false;        // existing helper returning {w, cur} for the active worklist
  if (!t.w.netEntries.some(n => n.netName === netName)) this.pushNets(t.w.id, [netName]);
  const e = t.w.netEntries.find(n => n.netName === netName); if (!e) return false;
  e.measurement = { kind: opts.kind, status: 'requested', prompt: opts.prompt, expected: opts.expected,
    unit: NET_MEASUREMENT_UNITS[opts.kind], source: 'agent', at: Date.now() };
  (t.w.aiOrigin ??= {})[`n:${netName}`] = true;
  t.w.updatedAt = Date.now();
  this.save(t.cur); return true;
}
recordNetMeasurement(netName: string, value: string, unit?: string): boolean {
  const t = this.aiTarget(); if (!t) return false;
  const e = t.w.netEntries.find(n => n.netName === netName); if (!e || !e.measurement) return false;
  e.measurement = { ...e.measurement, value, unit: unit ?? e.measurement.unit, status: 'recorded', at: Date.now() };
  t.w.updatedAt = Date.now();
  this.save(t.cur); return true;
}
clearNetMeasurement(worklistId: string, netName: string): void {
  const cur = this.current; if (!cur) return;
  const s = cur.worklistes.find(x => x.id === worklistId); if (!s) return;
  const e = s.netEntries.find(n => n.netName === netName); if (!e || !e.measurement) return;
  delete e.measurement; s.updatedAt = Date.now(); this.save(cur);
}
```
(If `aiTarget()` doesn't already exist, reuse whatever helper the removed `aiRequestMeasurement` used — the existing AI methods resolve the active worklist as `t.w`. Match that pattern exactly.)

Remove `aiRequestMeasurement`, `answerMeasurement`, `skipMeasurement`. In `aiSnapshot()`, drop the `measurements` field and ensure each `netEntries[]` item includes its `measurement`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/frontend && npx playwright test tests/worklist-measurements.spec.ts -g "user records a net measurement" --reporter=line`
Expected: PASS. Then `npx tsc --noEmit` — this WILL now fail in `WorklistPanel.tsx` and `mcp-bridge.ts` (they call the removed methods). That is expected; Tasks 4–6 fix those. Note the errors and proceed.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/store/worklist-store.ts src/frontend/tests/worklist-measurements.spec.ts
git commit -m "feat(worklist): net-measurement store methods; drop flat-array AI methods"
```

---

### Task 4: Net-row UI — measurement strip on `WorklistNetRow`

**Files:**
- Modify: `src/frontend/src/panels/WorklistPanel.tsx` (`WorklistNetRow`, ~line 720+; styles block)
- Test: `src/frontend/tests/worklist-measurements.spec.ts`

**Interfaces:**
- Consumes: `setNetMeasurement`, `recordNetMeasurement`, `clearNetMeasurement`, `NET_MEASUREMENT_UNITS`, `NetMeasurement` (Tasks 1, 3).

- [ ] **Step 1: Write the failing geometry test** (needs a board fixture)

```ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const BRD = path.resolve(__dirname2, '../../../samples/820-02935-05 Kopie.brd');
const haveBrd = fs.existsSync(BRD);

test('net row: record an Ω value inline; renders on the row, not a separate list', async ({ page }) => {
  test.skip(!haveBrd, 'sample brd missing');
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BRD);
  await expect(page.locator('.dv-tab', { hasText: '.brd' }).first()).toBeVisible({ timeout: 15000 });
  // Seed a net entry via the store, open the worklist tab.
  await page.evaluate(() => {
    // @ts-expect-error DEV global
    const ws = window.__worklistStore;
    const r = ws.pushNetToActive('GND');   // existing API; auto-creates worklist
    return r;
  });
  await page.locator('.board-sidebar-toggle').first().click();
  await page.locator('.board-sidebar-tab', { hasText: 'Worklist' }).click();
  const netRow = page.locator('[data-testid="worklist-net-row"]', { hasText: 'GND' }).first();
  await expect(netRow).toBeVisible();
  await netRow.locator('[data-testid="net-meas-chip-resistance"]').click();
  const input = netRow.locator('[data-testid="net-meas-value"]');
  await input.fill('47');
  await input.press('Enter');
  // recorded text shows on the row
  await expect(netRow.getByText('47', { exact: false })).toBeVisible();
  const rowBox = await netRow.boundingBox();
  const recBox = await netRow.locator('[data-testid="net-meas-recorded"]').boundingBox();
  expect(recBox!.y).toBeGreaterThanOrEqual(rowBox!.y - 1);
  expect(recBox!.y + recBox!.height).toBeLessThanOrEqual(rowBox!.y + rowBox!.height + 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/frontend && npx playwright test tests/worklist-measurements.spec.ts -g "record an Ω value" --reporter=line`
Expected: FAIL (chips/inputs/test-ids don't exist).

- [ ] **Step 3: Implement the measurement strip**

In `WorklistNetRow`, add `data-testid="worklist-net-row"` to the row container. Below the row header add a `<NetMeasurementStrip worklistId={worklistId} entry={entry} />` component:
```tsx
function NetMeasurementStrip({ worklistId, entry }: { worklistId: string; entry: NetWorklistEntry }) {
  const m = entry.measurement;
  const [draftKind, setDraftKind] = useState<NetMeasurement['kind'] | null>(m && m.status === 'requested' ? m.kind : null);
  const [val, setVal] = useState(m?.value ?? '');
  const kind = m?.kind ?? draftKind;
  const commit = () => {
    if (!kind || !val.trim()) return;
    if (m && m.status === 'requested') worklistStore.recordNetMeasurement(entry.netName, val.trim());
    else worklistStore.setNetMeasurement(worklistId, entry.netName, kind, val.trim());
    setDraftKind(null);
  };
  if (m && m.status === 'recorded') {
    return (
      <div style={netMeasRecordedStyle} data-testid="net-meas-recorded">
        <span>{labelFor(m.kind)}: <b>{m.value}</b> {m.unit}</span>
        <button style={miniBtnStyle} title="Edit" onClick={() => { setDraftKind(m.kind); setVal(m.value ?? ''); worklistStore.clearNetMeasurement(worklistId, entry.netName); }}>✎</button>
        <button style={miniBtnStyle} title="Clear" onClick={() => worklistStore.clearNetMeasurement(worklistId, entry.netName)}>✕</button>
      </div>
    );
  }
  const requested = m && m.status === 'requested';
  return (
    <div style={netMeasStripStyle} data-testid="net-meas-strip">
      {(['voltage','diode','resistance'] as const).map(k => (
        <button key={k}
          data-testid={`net-meas-chip-${k}`}
          style={kind === k ? netMeasChipActiveStyle : netMeasChipStyle}
          title={requested ? 'Agent requested this measurement' : `Record ${labelFor(k)}`}
          onClick={() => setDraftKind(k)}>{labelFor(k)}</button>
      ))}
      {kind && (
        <input data-testid="net-meas-value" value={val} placeholder={requested ? (m?.expected ? `exp ${m.expected}` : 'value') : 'value'}
          onChange={e => setVal(e.target.value)} onKeyDown={e => e.key === 'Enter' && commit()} onBlur={commit}
          style={measureInputStyle} />
      )}
      {requested && m?.prompt && <span style={{ fontSize: 10, opacity: 0.7 }} title={m.prompt}>· {m.prompt.slice(0, 24)}</span>}
    </div>
  );
}
function labelFor(k: NetMeasurement['kind']) { return k === 'voltage' ? 'V' : k === 'diode' ? 'Diode' : 'Ω'; }
```
Add the styles (`netMeasStripStyle`, `netMeasChipStyle`, `netMeasChipActiveStyle`, `netMeasRecordedStyle`) near the other style consts — flex row, small chips, `flexWrap: 'wrap'`. Import `NetMeasurement`, `NET_MEASUREMENT_UNITS` from the store.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/frontend && npx playwright test tests/worklist-measurements.spec.ts -g "record an Ω value" --reporter=line` (start the Go backend on :1336 first if not running, per local-dev).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/panels/WorklistPanel.tsx src/frontend/tests/worklist-measurements.spec.ts
git commit -m "feat(worklist): inline V/Diode/Ω measurement strip on net rows"
```

---

### Task 5: Relay-only AI section — strip the measurement block

**Files:**
- Modify: `src/frontend/src/panels/WorklistPanel.tsx` (`AiWorklistSection` ~line 403–450, `MeasurementRow` ~452–484, styles)
- Test: existing specs (regression — section still renders relay)

**Interfaces:** none new. Removes `MeasurementRow` and the `measurements` block; keeps transcript + `AiPromptBox`.

- [ ] **Step 1: Remove the measurement block + `MeasurementRow`**

In `AiWorklistSection`: delete the `pending`/`measurements` derivations and the `{measurements.length > 0 && (...)}` block. Keep `messages`, the transcript, and `AiPromptBox`. Update the visibility gate to `if (!connected && messages.length === 0) return null;`. Delete the `MeasurementRow` function and `measurementRowStyle`/`measureInputStyle` only if now unused (note: `measureInputStyle` is reused by Task 4's strip — keep it; remove `measurementRowStyle`, `aiPendingBadge` if unused). Rename `AiWorklistSection` → keep the name to minimise churn, but update the heading text/comment to "AI relay".

- [ ] **Step 2: Verify build + no dead refs**

Run: `cd src/frontend && npx tsc --noEmit` — must be clean now for `WorklistPanel.tsx` (the removed-method calls in this file are gone). `mcp-bridge.ts` may still error (Task 6).
Run: `npx playwright test tests/worklist-measurements.spec.ts -g "record an Ω value" --reporter=line` → still PASS.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/panels/WorklistPanel.tsx
git commit -m "feat(worklist): AI section is relay-only (measurements now on net rows)"
```

---

### Task 6: MCP tools — net-vs-part/pin routing; source-agnostic `get_measurements`

**Files:**
- Modify: `src/frontend/src/store/mcp-bridge.ts` (`request_measurement`, `get_measurements`, `worklist_get` handlers)
- Modify: `src/backend/mcpserver/tools_live.go` (tool descriptions for `request_measurement` / `get_measurements`)
- Test: `src/backend/mcpserver/mcpserver_test.go`; frontend spec

**Interfaces:**
- Consumes: `requestNetMeasurement`, `aiSnapshot` (Task 3).
- Net detection: a target is a net iff `boardStore.board?.nets.has(target)` (canonical). Else part/pin → relay via existing `addMessage`/`post_message` path.

- [ ] **Step 1: Write the failing backend test**

In `mcpserver_test.go`, add a test asserting the `request_measurement` tool description mentions part/pin asks landing in the relay, and that the `get_measurements` tool is registered with a `source` filter arg. (Backend tools are thin proxies; the routing logic is frontend. Assert the registered tool schema/description strings.)
```go
func TestRequestMeasurementDescription(t *testing.T) {
  // build the server as existing tests do, enumerate tools, find request_measurement,
  // assert strings.Contains(desc, "relay") and get_measurements has a "source" arg.
}
```

- [ ] **Step 2: Run it / verify fail**

Run: `cd src/backend && go test ./mcpserver/ -run TestRequestMeasurement -v`
Expected: FAIL (description not updated yet).

- [ ] **Step 3: Update bridge handlers (frontend) + tool descriptions (backend)**

In `mcp-bridge.ts`:
- `request_measurement`: if `boardStore.board?.nets.has(args.target)` → `worklistStore.requestNetMeasurement(args.target, { kind: clampKind(args.kind), prompt: args.prompt, expected: args.expected })`; else `worklistStore.addMessage('agent', \`Measure ${args.kind} on ${args.target}: ${args.prompt}\`)` (relay). `clampKind` maps anything not in `voltage|diode|resistance` → relay path (so for a net target with continuity/other, also fall to relay).
- `get_measurements`: read `worklistStore.aiSnapshot().netEntries`, emit `{ netName, ...measurement }` for entries that have a `measurement`; honour optional `status` (`requested|recorded`) and `source` filters. Return `{ measurements: [...] }`.
- `worklist_get`: its measurement section reads the same inline net measurements.

In `tools_live.go`, update the `request_measurement` description to: "…target=net → inline net field; target=part/pin → posted to the relay. kind=voltage|diode|resistance for nets." Update `get_measurements` to add an optional `source` arg and describe it returns user- and agent-origin net readings.

- [ ] **Step 4: Run tests**

Run: `cd src/backend && go test ./mcpserver/ -v` → PASS.
Run: `cd src/frontend && npx tsc --noEmit` → clean.

- [ ] **Step 5: Frontend bidirectional spec**

Append to `worklist-measurements.spec.ts`:
```ts
test('bidirectional: user reading is visible via aiSnapshot with source user', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
  const found = await page.evaluate(() => {
    // @ts-expect-error DEV global
    const ws = window.__worklistStore;
    const id = ws.TEST_NEW_WORKLIST('c');
    ws.setNetMeasurement(id, 'PP1V8', 'voltage', '1.79');
    const snap = ws.aiSnapshot();
    const n = snap.netEntries.find((x: any) => x.netName === 'PP1V8');
    return n?.measurement?.source;
  });
  expect(found).toBe('user');
});
```
Run: `npx playwright test tests/worklist-measurements.spec.ts -g "bidirectional" --reporter=line` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/store/mcp-bridge.ts src/backend/mcpserver/tools_live.go src/backend/mcpserver/mcpserver_test.go src/frontend/tests/worklist-measurements.spec.ts
git commit -m "feat(mcp): route measurement asks (net→row, part/pin→relay); source-agnostic get_measurements"
```

---

### Task 7: Highlight re-evaluation — one off-by-default toggle

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts` (`redrawMultiHighlight` ~4902; shared-net glow path ~3360)
- Modify: `src/frontend/src/panels/WorklistPanel.tsx` (header button ~334; `onToggleConnections` ~287)
- Test: `src/frontend/tests/worklist-measurements.spec.ts`

**Interfaces:**
- `connectionHighlight` (boardStore) becomes the single worklist-highlight toggle. Default unchanged (false). The shared-net glow no longer requires the cyan `selectionSetStore`.

- [ ] **Step 1: Gate worklist outlines on the toggle, keep mark colours**

In `redrawMultiHighlight`, wrap the active-worklist outline loop in `if (boardStore.connectionHighlight) { … }` — so worklist parts are outlined (in `MARK_COLOR_HEX[e.mark]`) ONLY when the toggle is on. The ephemeral `selectionSetStore` cyan loop stays unconditional (non-worklist multi-select).

- [ ] **Step 2: Shared-net glow without the cyan override**

In the glow path (~3360), `computeSharedSelectionNets()` currently reads the cyan selection set. Change it (or add a sibling) to compute shared nets from the **active worklist's parts** when `connectionHighlight` is on, so the parts no longer need to be in `selectionSetStore` (which is what flattened them to cyan). Then `onToggleConnections` no longer calls `selectionSetStore.replaceWith(...)` — it just flips `connectionHighlight`.

In `onToggleConnections` (WorklistPanel): remove the `selectionSetStore.replaceWith/clear` calls; just `boardStore.setConnectionHighlight(!boardStore.connectionHighlight)`. Relabel the button "Highlight" and update the tooltip to "Show this worklist on the board (mark colours) and glow shared nets."

- [ ] **Step 3: Write the test**

```ts
test('highlight: worklist outlines only when toggle on; button relabeled', async ({ page }) => {
  test.skip(!haveBrd, 'sample brd missing');
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BRD);
  await expect(page.locator('.dv-tab', { hasText: '.brd' }).first()).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => { /* @ts-expect-error */ window.__worklistStore.pushRefdesToActive('C1'); });
  await page.locator('.board-sidebar-toggle').first().click();
  await page.locator('.board-sidebar-tab', { hasText: 'Worklist' }).click();
  const btn = page.getByRole('button', { name: 'Highlight' });
  await expect(btn).toBeVisible();
  const on = await page.evaluate(() => { /* @ts-expect-error */ return window.__boardStore.connectionHighlight; });
  expect(on).toBe(false); // off by default
  await btn.click();
  const on2 = await page.evaluate(() => { /* @ts-expect-error */ return window.__boardStore.connectionHighlight; });
  expect(on2).toBe(true);
});
```

- [ ] **Step 4: Run + verify**

Run: `cd src/frontend && npx playwright test tests/worklist-measurements.spec.ts -g "highlight" --reporter=line` → PASS. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts src/frontend/src/panels/WorklistPanel.tsx src/frontend/tests/worklist-measurements.spec.ts
git commit -m "feat(worklist): single off-by-default Highlight toggle (mark colours + shared-net glow)"
```

---

### Task 8: SKILL.md playbook + final verification

**Files:**
- Modify: `.claude/skills/boardripper-repair-helper/SKILL.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update the playbook**

In the worklist-loop section: measurements are requested/read **per net** (`request_measurement` target=net → inline field; `get_measurements` returns user- and agent-origin readings). Part/pin asks land in the relay. The "Highlight" button shows the worklist on the board.

- [ ] **Step 2: Full gate**

Run, all from repo root unless noted:
```bash
cd src/frontend && npx tsc --noEmit && npm run build
cd ../backend && go build ./... && go test ./mcpserver/
# backend on :1336, then:
cd ../frontend && npx playwright test tests/worklist-measurements.spec.ts tests/ci-smoke.spec.ts --reporter=line
```
Expected: all PASS / clean.

- [ ] **Step 3: CHANGELOG + commit**

Add a `## v0.31.25` entry (worklist v2 Phase 1: per-net measurements, relay-only AI section, single Highlight toggle, migration). Commit:
```bash
git add .claude/skills/boardripper-repair-helper/SKILL.md CHANGELOG.md
git commit -m "docs: repair-helper worklist playbook + v0.31.25 changelog (worklist v2 phase 1)"
```

- [ ] **Step 4: Deploy to dev + manual check**

`./NASdeploy-dev.sh`, hard-refresh `rd-nas:1234`: record a measurement on a net row, confirm the to-measure list is gone, toggle Highlight on/off, drive an agent `request_measurement` if MCP is set up. Then release via the `release` skill once satisfied.

---

## Self-Review

- **Spec coverage:** per-net measurement model (T1), migration (T2), store API + source-agnostic snapshot (T3), net-row UI (T4), relay-only section (T5), MCP routing + `get_measurements` source (T6), highlight re-evaluation (T7), SKILL.md + export-readiness `schemaVersion`/`updatedAt` (T1/T8). Device binding + export pipeline are **Phase 2** (separate plan) — correctly out of this plan.
- **Placeholder scan:** none — every step has code or an exact command.
- **Type consistency:** `NetMeasurement`/`NET_MEASUREMENT_UNITS` defined in T1 and used verbatim in T2–T7; method names (`setNetMeasurement`/`requestNetMeasurement`/`recordNetMeasurement`/`clearNetMeasurement`) consistent across T3/T4/T6.
- **Resolved:** the active-worklist helper is `private aiTarget(): { cur: BoardWorklistes; w: Worklist } | null` (worklist-store.ts:659) — T3's code uses `t.cur` / `t.w` exactly as it returns. No new helper needed.
