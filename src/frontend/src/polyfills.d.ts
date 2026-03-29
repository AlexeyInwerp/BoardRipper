// Type declarations for ES2025+ APIs polyfilled in pdf-store.ts
interface Uint8Array {
  toHex(): string;
}

interface Map<K, V> {
  getOrInsertComputed(key: K, cb: (key: K) => V): V;
}
