/**
 * Open a split `.asc` boardview as one board.
 *
 * The Tebo-ICT / eM-Test toolchain ships a board as a folder of section files
 * (`Format.asc`, `Nails.asc`, `Pins.asc`, `Parts.asc`, `Nets.asc`). Clicking
 * one of them means "open this board", not "open a fifth of it", so every
 * entry point that can see the folder resolves the siblings before loading.
 *
 * The folder access differs per entry point — the databank index, a live
 * directory listing, Electron's local scan — so it is injected as a two-method
 * source and this module stays free of any of them.
 */
import { groupAscSiblings, ascSectionFromName } from '../parsers/asc-siblings';
import { boardStore } from './board-store';
import { log } from './log-store';

export interface AscFolderSource {
  /** Every file name sitting in the same folder as the clicked file. */
  siblingNames(): Promise<string[]>;
  /** Read one of those names into a File. */
  read(name: string): Promise<File>;
}

/**
 * The clicked file plus its sibling sections, ready for `loadFiles()`.
 *
 * Returns `[clicked]` unchanged when the file is not a section file, when no
 * sibling matches, or when the folder cannot be listed — the caller then does
 * exactly what it did before. A sibling that fails to read is skipped with a
 * log line rather than failing the open: four sections still beat none.
 */
export async function expandAscFile(clicked: File, src: AscFolderSource): Promise<File[]> {
  if (!ascSectionFromName(clicked.name)) return [clicked];
  let names: string[];
  try {
    names = await src.siblingNames();
  } catch (err) {
    log.parser.warn(`(asc) could not list the folder of "${clicked.name}":`, err);
    return [clicked];
  }
  const group = groupAscSiblings(clicked.name, names);
  if (group.length < 2) return [clicked];

  const files: File[] = [];
  for (const name of group) {
    if (name === clicked.name) { files.push(clicked); continue; }
    try {
      files.push(await src.read(name));
    } catch (err) {
      log.parser.warn(`(asc) sibling "${name}" could not be read, opening without it:`, err);
    }
  }
  if (files.length > 1) {
    log.parser.log(`(asc) "${clicked.name}" opened with its siblings: ${files.map(f => f.name).join(', ')}`);
  }
  return files;
}

/**
 * Load a board file, silently completing it from its folder when it is one
 * section of a split `.asc` delivery. The merge is announced — opening five
 * files after a click on one would otherwise look like a guess.
 */
export async function loadBoardWithAscSiblings(clicked: File, src: AscFolderSource): Promise<void> {
  const files = await expandAscFile(clicked, src);
  await boardStore.loadFiles(files);
  if (files.length > 1) {
    boardStore.addToast(
      `Opened ${files.length} .asc sections as one board: ${files.map(f => f.name).join(', ')}`,
      'info',
    );
  }
}
