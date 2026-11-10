import { describe, it, expect } from 'vitest';
import { mergeDocs, newDoc, normalizeDoc, docsFromLegacy, defaultBoardName, type WorklistDoc } from './worklist-doc';

const base = (): WorklistDoc => ({
  ...newDoc('No power', '820-02016', undefined, 1000),
  id: 'wl-1', rev: 3,
  entries: [{ refdes: 'U7700', mark: 'none', note: '', at: 1000 }],
  netEntries: [{ netName: 'PPBUS_G3H', mark: 'none', note: '', at: 1000 }],
});

describe('mergeDocs', () => {
  it('keeps the newer change per row, from either side', () => {
    const local = base(); const server = base();
    local.entries[0] = { ...local.entries[0], mark: 'replaced', at: 2000 };          // local edit
    server.netEntries[0] = { ...server.netEntries[0], note: 'short to GND', at: 3000 }; // other bench
    server.rev = 4;
    const m = mergeDocs(local, server);
    expect(m.entries[0].mark).toBe('replaced');
    expect(m.netEntries[0].note).toBe('short to GND');
    expect(m.rev).toBe(4);                         // ready to put against the server's rev
  });

  it('a removal wins over an older edit and is not brought back', () => {
    const local = base(); const server = base();
    local.entries[0] = { ...local.entries[0], removed: 2500, at: 1000 };
    server.entries[0] = { ...server.entries[0], note: 'older note', at: 2000 };
    expect(mergeDocs(local, server).entries[0].removed).toBe(2500);
  });

  it('adds rows only one side has', () => {
    const local = base(); const server = base();
    local.entries.push({ refdes: 'C7710', mark: 'none', note: '', at: 2000 });
    server.entries.push({ refdes: 'R7701', mark: 'none', note: '', at: 2000 });
    expect(mergeDocs(local, server).entries.map(e => e.refdes).sort()).toEqual(['C7710', 'R7701', 'U7700']);
  });

  it('matches rows without case', () => {
    const local = base(); const server = base();
    local.entries[0] = { ...local.entries[0], refdes: 'u7700', mark: 'cleaned', at: 5000 };
    const m = mergeDocs(local, server);
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0].mark).toBe('cleaned');
  });

  it('merges readings per kind', () => {
    const local = base(); const server = base();
    local.netEntries[0] = { ...local.netEntries[0], at: 2000, measurements: { diode: { kind: 'diode', value: '0.412', status: 'recorded', source: 'user', at: 2000 } } };
    server.netEntries[0] = { ...server.netEntries[0], at: 3000, measurements: { voltage: { kind: 'voltage', value: '12.6', status: 'recorded', source: 'user', at: 3000 } } };
    const m = mergeDocs(local, server).netEntries[0].measurements!;
    expect(m.diode?.value).toBe('0.412');
    expect(m.voltage?.value).toBe('12.6');
  });

  it('name, board, tags and note come from the side that changed them last', () => {
    const local = base(); const server = base();
    local.board = 'A2337'; local.tags = ['water']; local.metaAt = 4000;
    server.name = 'renamed elsewhere'; server.metaAt = 3000;
    const m = mergeDocs(local, server);
    expect([m.board, m.tags, m.name]).toEqual(['A2337', ['water'], 'No power']);
  });

  it('messages are a union, and one read on either side stays read', () => {
    const local = base(); const server = base();
    local.messages = [{ id: 'm1', role: 'user', text: 'hi', at: 1 }];
    server.messages = [{ id: 'm1', role: 'user', text: 'hi', at: 1, unread: true }, { id: 'm2', role: 'agent', text: 'ok', at: 2 }];
    const m = mergeDocs(local, server);
    expect(m.messages!.map(x => x.id)).toEqual(['m1', 'm2']);
    expect(m.messages![0].unread).toBeUndefined();
  });
});

describe('normalizeDoc', () => {
  it('fills what an older or foreign writer left out, and refuses junk', () => {
    const d = normalizeDoc({ id: 'x', entries: [{ refdes: 'R1', mark: 'none', note: '' }] })!;
    expect(d.tags).toEqual([]);
    expect(d.netEntries).toEqual([]);
    expect(d.entries[0].at).toBe(0);
    expect(normalizeDoc(null)).toBeNull();
    expect(normalizeDoc({ name: 'no id' })).toBeNull();
  });
});

describe('docsFromLegacy', () => {
  it('turns a per-file record into documents that keep their ids', () => {
    const docs = docsFromLegacy({
      key: '820-02016.bvr:123:456', fileName: '820-02016.bvr', activeWorklistId: 'st-a',
      worklistes: [{
        id: 'st-a', name: 'Ticket', createdAt: 10, updatedAt: 20, note: 'customer says',
        entries: [{ refdes: 'U1', mark: 'replaced', note: 'n', waterdamage: true }],
        netEntries: [{ netName: 'PP3V3', mark: 'short', note: '', measurement: { kind: 'diode', value: '0.01', status: 'recorded', source: 'user', at: 15 } } as never],
      }],
    }, f => defaultBoardName(f, null));
    expect(docs).toHaveLength(1);
    const d = docs[0];
    expect([d.id, d.name, d.board, d.note]).toEqual(['st-a', 'Ticket', '820-02016', 'customer says']);
    expect(d.entries[0]).toMatchObject({ refdes: 'U1', mark: 'replaced', waterdamage: true });
    expect(d.netEntries[0].measurements?.diode?.value).toBe('0.01');
    expect(d.origin).toEqual({ fileName: '820-02016.bvr' });
    expect(d.rev).toBe(0);
  });
});

describe('defaultBoardName', () => {
  it('prefers the board number, else the file name without extension', () => {
    expect(defaultBoardName('whatever.pcb', '820-02016')).toBe('820-02016');
    expect(defaultBoardName('A2337 820-02016-07.pcb', null)).toBe('A2337 820-02016-07');
  });
});
