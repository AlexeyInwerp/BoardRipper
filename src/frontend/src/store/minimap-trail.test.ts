import { describe, it, expect } from 'vitest';
import { minimapTrail } from './minimap-trail';
import type { NavEntry } from './nav-history';

let id = 0;
const e = (over: Partial<NavEntry> & { part?: string; tabId?: number; cam?: number }): NavEntry => ({
  id: ++id, cause: 'click', at: 1000 + id, label: '',
  place: { kind: 'board', tabId: over.tabId ?? 1, fileKey: 'k', fileName: 'b.kicad_pcb', part: over.part,
    camera: over.cam !== undefined ? { x: over.cam, y: 0, scaleX: 1, scaleY: 1 } : undefined },
  ...over,
} as NavEntry);

describe('minimapTrail', () => {
  it('newest first, this tab, distinct parts, limited', () => {
    const list = [e({ part: 'U1' }), e({ part: 'C2' }), e({ part: 'U1' }), e({ part: 'R5', tabId: 2 }), e({ part: 'Q3' })];
    const t = minimapTrail(list, list.length - 1, 1, { since: 0 });
    expect(t.map(x => x.part)).toEqual(['Q3', 'U1', 'C2']);
    expect(t.map(x => x.rank)).toEqual([0, 1, 2]);
    expect(minimapTrail(list, 4, 1, { since: 0, limit: 2 }).map(x => x.part)).toEqual(['Q3', 'U1']);
  });
  it('skips entries from before the session and other places', () => {
    const list = [e({ part: 'U1', at: 5 }), { ...e({}), place: { kind: 'pdf', fileName: 'x.pdf', page: 1 } } as NavEntry, e({ part: 'C2', at: 200 })];
    expect(minimapTrail(list, 2, 1, { since: 100 }).map(x => x.part)).toEqual(['C2']);
  });
  it('visits without a part are not marked; the cursor entry is', () => {
    const list = [e({ cam: 0 }), e({ part: 'U1' }), e({ cam: 400 }), e({ part: 'C2' }), e({ part: 'U1' })];
    const t = minimapTrail(list, 1, 1, { since: 0 });
    expect(t.map(x => x.part)).toEqual(['U1', 'C2']);
    expect(t.filter(x => x.current).map(x => x.part)).toEqual(['U1']);
  });
  it('no tab, no trail', () => {
    expect(minimapTrail([e({ part: 'U1' })], 0, null, { since: 0 })).toEqual([]);
  });
});
