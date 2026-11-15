/**
 * Reference designators printed on the parts: one glyph atlas, one merged mesh,
 * one draw call for every name on the board. Each label lies on its part's top
 * face (bottom face for bottom parts), along the body's long axis, turned so it
 * reads left-to-right from the side it is seen from.
 *
 * Level of detail is in the shader: a label fades in between 5 and 9 px of
 * on-screen height and is not drawn below that, so a zoomed-out board is not a
 * carpet of grey specks and zooming in reveals names as they become readable.
 */
import * as THREE from 'three';

const CELL = 96, COLS = 16, ADV = 0.62, SPREAD = 12; // glyph cell (px), atlas columns, advance as a fraction of the height, SDF range (px)

/** Signed-distance atlas: each glyph is rasterised once, then its alpha mask is turned into a
 *  distance field (two 1-D passes, Felzenszwalb), so the shader thresholds it and the text is as
 *  sharp at 3 mm from a part as at a metre — a plain bitmap atlas blurred past its own resolution. */
function atlas(chars: string[]): { tex: THREE.DataTexture; uv: Map<string, [number, number, number, number]> } {
  const rows = Math.max(1, Math.ceil(chars.length / COLS)), W = CELL * COLS, H = CELL * rows;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d')!;
  c.font = `700 ${CELL * 0.62}px ui-monospace, Menlo, Consolas, monospace`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff';
  const uv = new Map<string, [number, number, number, number]>();
  chars.forEach((ch, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    c.fillText(ch, col * CELL + CELL / 2, row * CELL + CELL / 2 + CELL * 0.03);
    const pad = (1 - ADV) / 2; // a glyph uses the middle ADV of its cell's width
    uv.set(ch, [(col + pad) / COLS, 1 - (row + 1) / rows, (col + 1 - pad) / COLS, 1 - row / rows]);
  });
  const alpha = c.getImageData(0, 0, W, H).data;
  const inside = new Float64Array(W * H), outside = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) { const on = alpha[i * 4 + 3] > 127; inside[i] = on ? 0 : Infinity; outside[i] = on ? Infinity : 0; }
  edt2d(inside, W, H); edt2d(outside, W, H);
  // 0.5 = the edge; +SPREAD px inside → 1, −SPREAD px outside → 0. Row 0 is the top in canvas space
  // and the bottom in texture space: flip so the uv rows above stay right.
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x, d = Math.sqrt(outside[i]) - Math.sqrt(inside[i]); data[(H - 1 - y) * W + x] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + d / (2 * SPREAD)))); }
  const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat); tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
  return { tex, uv };
}
/** Squared Euclidean distance transform in place (Felzenszwalb & Huttenlocher), rows then columns. */
function edt2d(f: Float64Array, W: number, H: number): void {
  const n = Math.max(W, H), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1), g = new Float64Array(n);
  const pass = (len: number, get: (i: number) => number, set: (i: number, x: number) => void) => {
    for (let i = 0; i < len; i++) g[i] = get(i);
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      if (!Number.isFinite(g[q])) continue;
      let s2 = 0;
      for (;;) { const p = v[k]; s2 = Number.isFinite(g[p]) ? ((g[q] + q * q) - (g[p] + p * p)) / (2 * q - 2 * p) : -Infinity; if (s2 <= z[k] && k > 0) k--; else break; }
      if (!Number.isFinite(g[v[k]])) { v[k] = q; z[k] = -Infinity; z[k + 1] = Infinity; continue; }
      k++; v[k] = q; z[k] = s2; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = Number.isFinite(g[p]) ? (q - p) * (q - p) + g[p] : Infinity; }
    for (let i = 0; i < len; i++) set(i, d[i]);
  };
  for (let y = 0; y < H; y++) pass(W, x => f[y * W + x], (x, val) => { f[y * W + x] = val; });
  for (let x = 0; x < W; x++) pass(H, y => f[y * W + x], (y, val) => { f[y * W + x] = val; });
}

export interface LabelSpec {
  text: string;
  /** Tint, 0xRRGGBB; white when absent. */
  colour?: number;
  /** Screen height (px) at which the label is fully in; it starts fading in at half that. 9 when absent. */
  showAtPx?: number;
  /** Centre on the face, scene mm. */
  x: number; y: number; z: number;
  /** Text height and the longest it may run, mm. */
  height: number; maxLength: number;
  /** Body long-axis angle in the board frame (deg, CCW from +x seen from the top). */
  angleDeg: number;
  side: 'top' | 'bottom';
}

export function buildLabelMesh(specs: LabelSpec[]): THREE.Mesh | null {
  if (!specs.length) return null;
  const chars = [...new Set(specs.flatMap(s => [...s.text]))].sort();
  const { tex, uv } = atlas(chars);
  const pos: number[] = [], uvs: number[] = [], hs: number[] = [], cols: number[] = [], shows: number[] = [], idx: number[] = [];
  for (const s of specs) {
    const n = s.text.length; if (!n) continue;
    const h = Math.min(s.height, s.maxLength / (n * ADV)); if (h < 0.05) continue;
    // seen from below, the board's x runs right-to-left: write in the viewer's frame, then map back
    const viewerAngle = s.side === 'top' ? s.angleDeg : 180 - s.angleDeg;
    let a = ((viewerAngle % 360) + 360) % 360; if (a > 90 && a <= 270) a -= 180; // keep it reading left-to-right
    const r = a * Math.PI / 180, vx = s.side === 'top' ? 1 : -1;
    const right = new THREE.Vector3(vx * Math.cos(r), 0, -Math.sin(r)), up = new THREE.Vector3(-vx * Math.sin(r), 0, -Math.cos(r));
    const w = h * ADV, x0 = -n * w / 2, col = new THREE.Color(s.colour ?? 0xffffff), show = s.showAtPx ?? 9;
    [...s.text].forEach((ch, i) => {
      const [u0, v0, u1, v1] = uv.get(ch)!, base = pos.length / 3, cx = x0 + (i + 0.5) * w;
      for (const [dx, dy, u, v] of [[-w / 2, -h / 2, u0, v0], [w / 2, -h / 2, u1, v0], [w / 2, h / 2, u1, v1], [-w / 2, h / 2, u0, v1]] as const) {
        const p = new THREE.Vector3(s.x, s.y, s.z).addScaledVector(right, cx + dx).addScaledVector(up, dy);
        pos.push(p.x, p.y, p.z); uvs.push(u, v); hs.push(h); cols.push(col.r, col.g, col.b); shows.push(show);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aH', new THREE.Float32BufferAttribute(hs, 1));
  geo.setAttribute('aCol', new THREE.Float32BufferAttribute(cols, 3));
  geo.setAttribute('aShow', new THREE.Float32BufferAttribute(shows, 1));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, viewportH: { value: 1000 }, dim: { value: 1 } },
    vertexShader: `
      attribute float aH; attribute vec3 aCol; attribute float aShow; uniform float viewportH; varying vec2 vUv; varying float vA; varying vec3 vCol;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float px = aH * projectionMatrix[1][1] * 0.5 * viewportH / max(-mv.z, 1e-3); // label height on screen
        vA = smoothstep(aShow * 0.55, aShow, px); vUv = uv; vCol = aCol;
        if (vA <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // too small to read: outside the clip volume, so nothing is rasterised
      }`,
    fragmentShader: `
      uniform sampler2D map; uniform float dim; varying vec2 vUv; varying float vA; varying vec3 vCol;
      void main() {
        // signed distance: 0.5 is the glyph edge; the band width follows the on-screen derivative, so the
        // edge is one pixel soft at every zoom. A dark halo sits just outside the edge for contrast.
        float d = texture2D(map, vUv).r, w = max(fwidth(d), 0.004);
        float ink = smoothstep(0.5 - w, 0.5 + w, d), halo = smoothstep(0.34 - w, 0.42 + w, d);
        float a = max(ink, halo * 0.85) * vA; if (a < 0.03) discard;
        gl_FragColor = vec4(mix(vec3(0.0), vCol * dim, ink / max(a / vA, 1e-4)), a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = 3; mesh.frustumCulled = false;
  return mesh;
}
