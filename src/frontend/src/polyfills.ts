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
