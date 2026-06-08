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
