// Runtime shims for engines that ship with Boardripper users but lag
// behind the features pdfjs-dist@5 calls directly. pdf.js is shipped
// pre-compiled, so Vite/esbuild can't down-level it from our build target.

// Promise.withResolvers — ES2024, Firefox 121+ / Chrome 119+ / Safari 17.4+.
// Some Win7 forks (R3dfox / Mypal etc.) advertise modern version numbers
// without exposing this. Without the shim, pdfjs's loadFile throws
// "Promise.withResolvers is not a function" before any PDF byte is read.
if (typeof (Promise as { withResolvers?: unknown }).withResolvers !== 'function') {
  (Promise as unknown as {
    withResolvers: <T>() => { promise: Promise<T>; resolve: (v: T | PromiseLike<T>) => void; reject: (r?: unknown) => void };
  }).withResolvers = function <T>() {
    let resolve!: (v: T | PromiseLike<T>) => void;
    let reject!: (r?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

// Promise.try — ES2025, Chrome 128+ / V8 12.8+ / Safari 18.4+.
// pdfjs-dist@5 worker uses Promise.try(handler, data) in its message-channel
// dispatch (RESOLVE / STREAM / PULL / CANCEL). On older Chromium baselines
// (pre-128 Electron, Win7 forks), the first message after worker boot throws
// "Promise.try is not a function" and the PDF panel dies on open.
if (typeof (Promise as { try?: unknown }).try !== 'function') {
  (Promise as unknown as {
    try: <T>(fn: (...a: unknown[]) => T | PromiseLike<T>, ...args: unknown[]) => Promise<T>;
  }).try = function <T>(fn: (...a: unknown[]) => T | PromiseLike<T>, ...args: unknown[]) {
    return new Promise<T>((resolve) => resolve(fn(...args)));
  };
}

// URL.parse — ES2024, Chrome 120+ / V8 12.0+ / Safari 17.4+ / Firefox 126+.
// pdfjs uses it in URL resolution (Annotation links, font fetch base, etc.).
// Spec: return URL or null on failure (vs `new URL` which throws).
if (typeof (URL as { parse?: unknown }).parse !== 'function') {
  (URL as unknown as { parse: (url: string, base?: string | URL) => URL | null }).parse =
    function (url: string, base?: string | URL) {
      try { return new URL(url, base); } catch { return null; }
    };
}

// ArrayBuffer.prototype.transferToFixedLength — Chrome 129+ / V8 12.9+.
// pdfjs uses it to right-size font-substitution write buffers. We can't
// replicate the detachment semantics in pure JS — we copy instead. Functional
// equivalence is preserved; the only cost is the source buffer staying live
// until GC instead of being detached. pdfjs immediately drops the source ref
// either way, so peak memory is unchanged in practice.
if (typeof (ArrayBuffer.prototype as { transferToFixedLength?: unknown }).transferToFixedLength !== 'function') {
  (ArrayBuffer.prototype as unknown as { transferToFixedLength: (newLen?: number) => ArrayBuffer }).transferToFixedLength =
    function (this: ArrayBuffer, newLength?: number) {
      const targetLen = newLength === undefined ? this.byteLength : newLength;
      const out = new ArrayBuffer(targetLen);
      const copyLen = Math.min(this.byteLength, targetLen);
      new Uint8Array(out).set(new Uint8Array(this, 0, copyLen));
      return out;
    };
}

// Uint8Array.prototype.toBase64 / Uint8Array.fromBase64 — Chrome 140+ / V8 14.0+.
// pdfjs uses toBase64 to encode embedded image streams into data: URLs and
// fromBase64 to decode XFA $content payloads. Chunked encode avoids the
// `apply()` argv-length crash on large buffers (≈ 64 KiB max on most engines).
if (typeof (Uint8Array.prototype as { toBase64?: unknown }).toBase64 !== 'function') {
  (Uint8Array.prototype as unknown as { toBase64: () => string }).toBase64 = function (this: Uint8Array) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < this.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(this.subarray(i, i + chunk)));
    }
    return btoa(binary);
  };
}
if (typeof (Uint8Array as { fromBase64?: unknown }).fromBase64 !== 'function') {
  (Uint8Array as unknown as { fromBase64: (str: string) => Uint8Array }).fromBase64 = function (str: string) {
    const bin = atob(str);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  };
}
