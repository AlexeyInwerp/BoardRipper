// Minisign signature verification for the desktop update feed.
//
// The feed (desktop.json) is signed with the same minisign key as the Docker
// manifest. Electron's crypto is BoringSSL, which verifies Ed25519 but has no
// BLAKE2b-512 — and minisign's default ("ED", prehashed) signs
// blake2b512(message) — so BLAKE2b is implemented here. It only ever hashes
// the feed, a few kilobytes, so BigInt arithmetic is fast enough.
//
// Formats (https://jedisct1.github.io/minisign/):
//   public key  base64( "Ed" | key id (8) | ed25519 key (32) )
//   .minisig    untrusted comment: …
//               base64( "ED" or "Ed" | key id (8) | signature (64) )
//               trusted comment: …
//               base64( global signature (64) )   — over signature | comment
'use strict';

const crypto = require('crypto');

// ── BLAKE2b-512 (RFC 7693), unkeyed ──

const MASK = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & MASK;

function compress(h, block, t, last) {
  const m = new Array(16);
  for (let i = 0; i < 16; i++) m[i] = block.readBigUInt64LE(i * 8);
  const v = [...h, ...IV];
  v[12] ^= t & MASK;
  v[13] ^= t >> 64n;
  if (last) v[14] ^= MASK;
  const G = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & MASK; v[d] = rotr(v[d] ^ v[a], 32);
    v[c] = (v[c] + v[d]) & MASK;     v[b] = rotr(v[b] ^ v[c], 24);
    v[a] = (v[a] + v[b] + y) & MASK; v[d] = rotr(v[d] ^ v[a], 16);
    v[c] = (v[c] + v[d]) & MASK;     v[b] = rotr(v[b] ^ v[c], 63);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    G(0, 4, 8, 12, m[s[0]], m[s[1]]);
    G(1, 5, 9, 13, m[s[2]], m[s[3]]);
    G(2, 6, 10, 14, m[s[4]], m[s[5]]);
    G(3, 7, 11, 15, m[s[6]], m[s[7]]);
    G(0, 5, 10, 15, m[s[8]], m[s[9]]);
    G(1, 6, 11, 12, m[s[10]], m[s[11]]);
    G(2, 7, 8, 13, m[s[12]], m[s[13]]);
    G(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

function blake2b512(data) {
  const buf = Buffer.from(data);
  const h = IV.slice();
  h[0] ^= 0x01010000n ^ 64n; // digest length 64, no key, fanout 1, depth 1
  const blocks = Math.max(1, Math.ceil(buf.length / 128));
  for (let i = 0; i < blocks; i++) {
    const last = i === blocks - 1;
    const block = Buffer.alloc(128);
    buf.copy(block, 0, i * 128, Math.min(buf.length, (i + 1) * 128));
    const t = last ? BigInt(buf.length) : BigInt((i + 1) * 128);
    compress(h, block, t, last);
  }
  const out = Buffer.alloc(64);
  for (let i = 0; i < 8; i++) out.writeBigUInt64LE(h[i], i * 8);
  return out;
}

// ── minisign ──

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32 key bytes follow.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Parse a minisign public key (the base64 line, or the whole .pub file). */
function parsePublicKey(text) {
  const line = String(text).split(/\r?\n/).map(s => s.trim())
    .find(s => s && !s.startsWith('untrusted comment:'));
  if (!line) throw new Error('empty public key');
  const raw = Buffer.from(line, 'base64');
  if (raw.length !== 42 || raw.toString('latin1', 0, 2) !== 'Ed') {
    throw new Error('not a minisign Ed25519 public key');
  }
  return {
    keyId: raw.subarray(2, 10),
    key: crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw.subarray(10)]),
      format: 'der',
      type: 'spki',
    }),
  };
}

/** Parse a .minisig file. */
function parseSignature(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines.length < 4 || !lines[0].startsWith('untrusted comment:')) {
    throw new Error('malformed signature file');
  }
  const raw = Buffer.from(lines[1].trim(), 'base64');
  if (raw.length !== 74) throw new Error('malformed signature');
  const algo = raw.toString('latin1', 0, 2);
  if (algo !== 'ED' && algo !== 'Ed') throw new Error(`unsupported signature algorithm ${algo}`);
  const prefix = 'trusted comment: ';
  if (!lines[2].startsWith(prefix)) throw new Error('missing trusted comment');
  const globalSig = Buffer.from(lines[3].trim(), 'base64');
  if (globalSig.length !== 64) throw new Error('malformed global signature');
  return {
    prehashed: algo === 'ED',
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10),
    trustedComment: lines[2].slice(prefix.length),
    globalSig,
  };
}

/** True when `sigText` is a valid minisign signature of `message` under the
 *  parsed public key. Checks the global signature over the trusted comment
 *  too, as minisign itself does. */
function verifyWith(pub, message, sig) {
  if (!pub.keyId.equals(sig.keyId)) return false;
  const signed = sig.prehashed ? blake2b512(message) : Buffer.from(message);
  if (!crypto.verify(null, signed, pub.key, sig.signature)) return false;
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]);
  return crypto.verify(null, global, pub.key, sig.globalSig);
}

/** Verify under any of the trusted keys (the rotation-window rule of the
 *  Go side's VerifyManifestAny). An empty key list fails closed. */
function verifyAny(message, sigText, pubKeyTexts) {
  if (!pubKeyTexts || pubKeyTexts.length === 0) {
    throw new Error('no trusted public keys configured');
  }
  const sig = parseSignature(sigText);
  for (const text of pubKeyTexts) {
    let pub;
    try { pub = parsePublicKey(text); } catch { continue; }
    if (verifyWith(pub, message, sig)) return true;
  }
  return false;
}

module.exports = { blake2b512, parsePublicKey, parseSignature, verifyAny };
