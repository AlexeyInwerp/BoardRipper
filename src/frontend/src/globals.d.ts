/// <reference types="vite-plugin-pwa/react" />
// Project-wide ambient declarations (no imports/exports → file is a global
// script, so all interfaces below merge into the global scope automatically).
//
// - Uint8Array / Map: ES2025 method polyfills shimmed in src/polyfills.ts.
// - GestureEvent: WebKit-only Safari trackpad-pinch event, missing from
//   lib.dom.d.ts. Required by the gesture* handlers in PdfViewerPanel
//   and BoardRenderer.

interface Window {
  /** Set by the boot gate in index.html: the engine features this browser
   *  lacks. When present, main.tsx does not mount the app. */
  __brUnsupported?: string[];
}

interface Uint8Array {
  toHex(): string;
}

interface Map<K, V> {
  getOrInsertComputed(key: K, cb: (key: K) => V): V;
}

interface GestureEvent extends UIEvent {
  readonly scale: number;
  readonly rotation: number;
  readonly clientX: number;
  readonly clientY: number;
}
