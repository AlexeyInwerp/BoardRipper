import { describe, it, expect, beforeAll } from 'vitest';
import { registerFormat } from '../parsers/registry';
import {
  folderLibrary,
  buildFolderTreeForTest as buildTree,
  makeFolderRowForTest as makeRow,
  allocFolderIdForTest as allocId,
} from './folder-library';
import type { DatabankFile, FolderNode } from './databank-store';

// The registry is global and normally filled by parsers/index.ts; registering
// one stub keeps this test off the whole parser tree.
beforeAll(() => {
  registerFormat({
    id: 'bvr1',
    name: 'BVR1',
    extensions: ['.bvr'],
    detect: () => false,
    parse: () => { throw new Error('not used'); },
  } as unknown as Parameters<typeof registerFormat>[0]);
});

/** A `File` as the scan reads it — only these four fields are touched. */
function fakeFile(relPath: string, size = 1234): File {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  return { name, size, lastModified: 1_700_000_000_000, webkitRelativePath: relPath } as unknown as File;
}

describe('row building', () => {
  it('classifies by extension and lifts the board number out of the name', () => {
    const row = makeRow(7, 'macbook/820-00281-A.bvr', '820-00281-A.bvr', 4096, 1_700_000_000_000, 'board');
    expect(row).toMatchObject({
      id: 7,
      path: 'macbook/820-00281-A.bvr',
      extension: '.bvr',
      file_type: 'board',
      board_number: '820-00281',
      format_id: 'bvr1',
      size: 4096,
    });
    // mod_time is seconds, like every other producer's rows.
    expect(row.mod_time).toBe(1_700_000_000);
  });

  it('leaves PDFs without a board number or format', () => {
    const row = makeRow(1, 'x/820-00281 schematic.pdf', '820-00281 schematic.pdf', 10, 0, 'pdf');
    expect(row.board_number).toBe('');
    expect(row.format_id).toBe('');
  });
});

describe('file ids', () => {
  it('are a function of the path, not of scan order', () => {
    // The whole point: recent files, worklists and session restore persist
    // these. Adding a file in front must not renumber the ones behind it.
    const first = allocId('b/two.bvr', new Set([allocId('a/one.bvr', new Set())]));
    const afterInsert = allocId('b/two.bvr', new Set([
      allocId('a/one.bvr', new Set()),
      allocId('a/inserted.bvr', new Set()),
    ]));
    expect(afterInsert).toBe(first);
  });

  it('never collides inside one scan', () => {
    const used = new Set<number>();
    const ids = Array.from({ length: 5000 }, (_, i) => allocId(`dir${i % 37}/file-${i}.bvr`, used));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => id > 0)).toBe(true);
  });
});

describe('folder tree', () => {
  const rows: DatabankFile[] = [
    makeRow(1, 'iphone/x/board.bvr', 'board.bvr', 1, 0, 'board'),
    makeRow(2, 'iphone/a.pdf', 'a.pdf', 1, 0, 'pdf'),
    makeRow(3, 'root.bvr', 'root.bvr', 1, 0, 'board'),
  ];

  it('nests by path segment and keeps root files at the root', () => {
    const tree = buildTree(rows, 'Boards');
    expect(tree.name).toBe('Boards');
    expect(tree.files?.map(f => f.filename)).toEqual(['root.bvr']);
    const iphone = tree.children?.find((c: FolderNode) => c.name === 'iphone');
    expect(iphone?.files?.map(f => f.filename)).toEqual(['a.pdf']);
    expect(iphone?.children?.[0].path).toBe('iphone/x');
    expect(iphone?.children?.[0].files?.map(f => f.filename)).toEqual(['board.bvr']);
  });
});

describe('adopting a webkitdirectory FileList', () => {
  it('keeps only boards and PDFs, pathed relative to the picked folder', async () => {
    const scan = await folderLibrary.adoptFileList([
      fakeFile('MyBoards/macbook/820-00281.bvr'),
      fakeFile('MyBoards/macbook/820-00281.pdf'),
      fakeFile('MyBoards/notes.txt'),
      fakeFile('MyBoards/.hidden/secret.bvr'),
    ]);
    expect(scan).not.toBeNull();
    expect(scan!.rootName).toBe('MyBoards');
    expect(scan!.files.map(f => f.path)).toEqual([
      'macbook/820-00281.bvr',
      'macbook/820-00281.pdf',
    ]);
    expect(folderLibrary.state).toEqual({ kind: 'active', rootName: 'MyBoards', mode: 'input' });
  });

  it('reads back the File a row came from', async () => {
    const board = fakeFile('L/one.bvr');
    const scan = await folderLibrary.adoptFileList([board]);
    await expect(folderLibrary.getFile(scan!.files[0])).resolves.toBe(board);
  });

  it('refuses a row it has no bytes for, and says why', async () => {
    const scan = await folderLibrary.adoptFileList([fakeFile('L/one.bvr')]);
    const stranger = { ...scan!.files[0], id: scan!.files[0].id + 1, filename: 'other.bvr' };
    await expect(folderLibrary.getFile(stranger)).rejects.toThrow(/not in the local folder index/);
  });
});
