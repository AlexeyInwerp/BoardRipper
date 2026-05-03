#!/usr/bin/env node
/**
 * Allegro BRD structure dumper — reverse-engineering tool for Cadence Allegro v15.x support.
 * NOT shipped with the app; used only during Allegro format reverse-engineering.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/allegro-dump.mjs <path-to-brd>');
  process.exit(1);
}

const filePath = resolve(args[0]);
let buffer;
try {
  const fileBuffer = readFileSync(filePath);
  // Convert Node.js Buffer to ArrayBuffer
  buffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
} catch (e) {
  console.error(`Error reading file: ${e.message}`);
  process.exit(1);
}

const view = new DataView(buffer);

// Helper to read u32 LE at offset
function readU32LE(offset) {
  if (offset + 4 > buffer.byteLength) return null;
  return view.getUint32(offset, true);
}

// Helper to read u8 at offset
function readU8(offset) {
  if (offset >= buffer.byteLength) return null;
  return view.getUint8(offset);
}

// Helper to read string and sanitize non-printables
function readStringAt(offset, length) {
  if (offset + length > buffer.byteLength) return null;
  const bytes = new Uint8Array(buffer, offset, length);
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) break; // NUL terminator
    if (b >= 0x20 && b <= 0x7e) {
      str += String.fromCharCode(b);
    } else {
      str += '·';
    }
  }
  return str;
}

// Helper to format hex with padding
function hex(val, width = 8) {
  return '0x' + val.toString(16).padStart(width, '0');
}

// ── Section 1: Magic & family decoding ────────────────────────────────────────

const magic = readU32LE(0x00);
// The "family" is the high 16 bits of the u32 magic — Cadence encodes the
// Allegro major version line there: 0x0012 = v15, 0x0013 = v16, 0x0014 = v17,
// 0x0015 = v18. The low 16 bits are a minor/build code (e.g. 0x0a06 in
// COMPAL LA-7321P). Matches the same shift in
// src/frontend/src/parsers/allegro/allegro-header.ts:formatFromMagic.
const family = (magic >>> 16) & 0xFFFF;
const discriminator = readU32LE(0x08);

let familyLabel = 'unknown';
if (family === 0x0012) familyLabel = 'v15.x';
else if (family === 0x0013) familyLabel = 'v16.x';
else if (family === 0x0014) familyLabel = 'v17.x';
else if (family === 0x0015) familyLabel = 'v18.x';

console.log(`magic = ${hex(magic)}`);
console.log(`family = ${hex(family, 4)} (${familyLabel})`);
console.log(`bytes[8..11] = ${hex(discriminator)} (Allegro discriminator: must be 1)`);
console.log('');

// ── Section 2: Version string (at 0xF8 for pre-v18, 0x124 for v18) ────────

const versionF8 = readStringAt(0xF8, 60);
console.log(`version @ 0xF8 = "${versionF8}"`);

const version124 = readStringAt(0x124, 60);
console.log(`version @ 0x124 = "${version124}"`);
console.log('');

// ── Section 3: Annotated u32 dump 0x00..0x100 ──────────────────────────────────

const annotations = {
  0x00: 'magic',
  0x04: 'm_Unknown1a',
  0x08: 'm_FileRole (discriminator)',
  0x0C: 'm_Unknown1b',
  0x10: 'm_WriterProgram',
  0x14: 'objectCount (claimed)',
  0x18: 'stringsCount (claimed)',
};

console.log('=== u32 dump 0x00..0x100 ===');
for (let offset = 0; offset < 0x100; offset += 4) {
  const val = readU32LE(offset);
  if (val === null) break;
  const ann = annotations[offset] || '';
  const decStr = val.toString().padStart(10);
  console.log(`${hex(offset, 4)}  ${hex(val)}  (decimal: ${decStr})  ${ann}`);
}
console.log('');

// ── Section 4: Candidate string scanner 0x200..min(len, 64KB) ──────────────────

console.log('=== Candidate strings (0x200..64KB) ===');
const scanStart = 0x200;
const scanEnd = Math.min(buffer.byteLength, 0x10000);
const strings = [];

let i = scanStart;
while (i < scanEnd) {
  const b = readU8(i);
  if (b === null) break;

  // Check if this byte starts a run of printables
  if (b >= 0x20 && b <= 0x7e) {
    let str = '';
    let startOffset = i;
    while (i < scanEnd) {
      const c = readU8(i);
      if (c === null) break;
      if (c === 0 || c < 0x20 || c > 0x7e) {
        // End of run
        break;
      }
      str += String.fromCharCode(c);
      i++;
    }

    // Collect if >= 6 chars
    if (str.length >= 6) {
      strings.push({ offset: startOffset, str });
    }
  } else {
    i++;
  }
}

// Print first 30
for (let j = 0; j < Math.min(30, strings.length); j++) {
  const { offset, str } = strings[j];
  console.log(`${hex(offset)}  "${str}"`);
}
if (strings.length > 30) {
  console.log(`(... ${strings.length - 30} more strings)`);
}
console.log('');

// ── Section 5: Linked-list pair dump 0x20..0x100 ────────────────────────────────

console.log('=== LL pairs 0x20..0x100 ===');
for (let offset = 0x20; offset < 0x100; offset += 8) {
  const w1 = readU32LE(offset);
  const w2 = readU32LE(offset + 4);
  if (w1 === null || w2 === null) break;

  let flag = '';
  // Both words look like keys: small u32, both > 0, both < buffer.length
  if (w1 > 0 && w2 > 0 && w1 < buffer.length && w2 < buffer.length && w1 < 100000 && w2 < 100000) {
    flag = ' [possibly LL pair]';
  }

  console.log(`${hex(offset, 4)}  pair (W1=${hex(w1)}, W2=${hex(w2)})${flag}`);
}
