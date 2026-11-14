/**
 * Generated 3D models for estimated parts. Every model is built from a
 * `PartEstimate` (family, L × W × H in mm, family parameters) — no mesh files.
 *
 * Local frame: X = the body's X axis, Y up from the board surface, local −Z =
 * the board's +y in the part's own frame. The estimator's conventions follow
 * it: a SOT-23's two-pin row and a connector's signal row sit at local +Z, a
 * USB-C opening at local +Z, a pin-1 dot at (−x, −z).
 *
 * Geometry is cached by dimensions and materials are shared, so the renderer
 * can merge everything per material afterwards.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { PartEstimate } from '../store/package-estimate';

const std = (color: number, roughness: number, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
export const MAT = {
  tin: std(0xd9dde2, 0.28, 1),
  gold: std(0xe3b95c, 0.3, 1),
  ceramic: std(0xeeeee6, 0.7),
  resTop: std(0x141414, 0.55),
  mlcc: std(0x9c7f5c, 0.75),
  dark: std(0x2b2b2d, 0.6),
  epoxy: std(0x1d1d20, 0.45),
  steel: std(0xc8ccd2, 0.3, 0.95),
  lid: std(0xc9ccd1, 0.38, 0.9),
  ledBody: std(0xf4f4ee, 0.55),
  band: std(0xb8bcc2, 0.5),
  dot: std(0x55565a, 0.4),
  nylon: std(0xe8dfc8, 0.65),
  slot: std(0x0b0b0c, 0.9),
  polymer: std(0x17171a, 0.5),
  ferrite: std(0x5b5d61, 0.7, 0.2),
  subst: std(0x2f3d2a, 0.6),
  print: std(0xd9d9d2, 0.6),
  lens: std(0xf2f2e8, 0.15),
  ghost: new THREE.MeshStandardMaterial({ color: 0x8a9099, roughness: 0.8, transparent: true, opacity: 0.55 }),
};

const cache = new Map<string, THREE.BufferGeometry>();
const geo = (key: string, make: () => THREE.BufferGeometry) => { let g = cache.get(key); if (!g) { g = make(); cache.set(key, g); } return g; };
const k3 = (...v: number[]) => v.map(n => n.toFixed(3)).join(',');
function mesh(g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); return o; }
const box = (w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) => mesh(geo('b' + k3(w, h, d), () => new THREE.BoxGeometry(w, h, d)), m, x, y, z);
// rounded edges only where they can show: a sub-0.6 mm box is drawn plain (2 k of the M1 board's parts)
const rbox = (w: number, h: number, d: number, r: number, m: THREE.Material, x = 0, y = 0, z = 0) => Math.min(w, h, d) < 0.6 ? box(w, h, d, m, x, y, z) :
  mesh(geo('r' + k3(w, h, d, r), () => new RoundedBoxGeometry(w, h, d, 2, Math.max(0.001, Math.min(r, w / 2, h / 2, d / 2) * 0.99))), m, x, y, z);
const cyl = (r: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 24) => mesh(geo('c' + k3(r, h) + seg, () => new THREE.CylinderGeometry(r, r, h, seg)), m, x, y, z);

/** Gull-wing lead: out from the body side at height `hy`. axis 'z' = leads on ±Z sides. */
function gull(g: THREE.Group, x: number, side: number, half: number, out: number, hy: number, w: number, axis: 'x' | 'z' = 'z') {
  const t = 0.13, k1 = out * 0.35, k2 = out * 0.55;
  for (const [a, b, c, off, y] of [[k1, t, w, half + k1 / 2, hy], [t, hy, w, half + k1, hy / 2], [k2, t, w, half + k1 + k2 / 2, t / 2]] as const)
    g.add(axis === 'z' ? box(c, b, a, MAT.tin, x, y, side * off) : box(a, b, c, MAT.tin, side * off, y, x));
}

/** The model for one estimate, or null when the family draws nothing in 3D
 *  (test points, fiducials, mounting holes — those are on the board face). */
export function buildPartModel(e: PartEstimate): THREE.Group | null {
  const g = new THREE.Group(); const { L, W, H, p } = e;
  switch (e.family) {
    case 'chip': {
      const k = e.kind;
      if (k === 'R') { g.add(box(L * 0.96, H * 0.82, W, MAT.ceramic, 0, H * 0.41)); g.add(box(L * 0.62, H * 0.12, W * 0.92, MAT.resTop, 0, H * 0.88)); for (const s of [-1, 1]) g.add(box(L * 0.2, H, W * 1.02, MAT.tin, s * (L / 2 - L * 0.1), H / 2)); }
      else if (k === 'LED') { g.add(box(L * 0.96, H * 0.55, W, MAT.ledBody, 0, H * 0.275)); g.add(box(L * 0.7, H * 0.45, W * 0.8, MAT.lens, 0, H * 0.775)); for (const s of [-1, 1]) g.add(box(L * 0.16, H * 0.55, W * 1.02, MAT.tin, s * (L / 2 - L * 0.08), H * 0.275)); }
      else { const m = k === 'C' ? MAT.mlcc : k === 'L' || k === 'FB' ? MAT.dark : k === 'D' ? MAT.epoxy : MAT.dot; const r = Math.min(W, H) * 0.12; g.add(rbox(L * 0.98, H, W, r, m, 0, H / 2)); for (const s of [-1, 1]) g.add(rbox(L * 0.24, H * 1.02, W * 1.02, r, MAT.tin, s * (L / 2 - L * 0.12), H / 2)); if (k === 'D') g.add(box(L * 0.12, 0.01, W, MAT.band, -L * 0.28, H + 0.005)); }
      break;
    }
    case 'chip3t': { const r = Math.min(W, H) * 0.12; g.add(rbox(L * 0.98, H, W, r, MAT.mlcc, 0, H / 2)); for (const s of [-1, 1]) g.add(rbox(L * 0.2, H * 1.02, W * 1.02, r, MAT.tin, s * (L / 2 - L * 0.1), H / 2)); g.add(box(L * 0.22, H * 1.02, W * 1.04, MAT.tin, 0, H / 2)); break; }
    case 'molded-cap': g.add(rbox(L * 0.86, H, W, 0.18, MAT.polymer, 0, H / 2)); for (const s of [-1, 1]) g.add(box(L * 0.1, H * 0.45, W * 0.55, MAT.tin, s * (L / 2 - L * 0.05), H * 0.225)); g.add(box(L * 0.12, 0.02, W * 0.9, MAT.print, -L * 0.3, H + 0.005)); break;
    // molded power inductors have nearly square edges: a small radius, not a pillow
    case 'inductor': g.add(rbox(L, H, W, Math.min(0.2, Math.min(L, W) * 0.04), MAT.ferrite, 0, H / 2)); for (const s of [-1, 1]) g.add(box(L * 0.16, 0.1, W * 0.6, MAT.tin, s * (L / 2 - L * 0.08), 0.05)); break;
    case 'sod123': case 'sod323': g.add(rbox(L, H - 0.05, W, 0.08, MAT.epoxy, 0, 0.05 + (H - 0.05) / 2)); g.add(box(L * 0.14, 0.02, W * 0.98, MAT.band, -L * 0.33, H + 0.005)); for (const s of [-1, 1]) gull(g, 0, s, L / 2, 0.7, H * 0.4, W * 0.45, 'x'); break;
    case 'sot23': case 'sot23-5': {
      g.add(rbox(L, H - 0.1, W, 0.06, MAT.epoxy, 0, 0.1 + (H - 0.1) / 2));
      const five = e.family === 'sot23-5', lo = five ? [-0.95, 0, 0.95] : [-0.95, 0.95], hi = five ? [0.95, -0.95] : [0];
      lo.forEach(x => gull(g, x, 1, W / 2, 0.55, 0.5, 0.4)); hi.forEach(x => gull(g, x, -1, W / 2, 0.55, 0.5, 0.4)); break;
    }
    case 'son': case 'qfn': {
      g.add(rbox(L, H, W, 0.05, MAT.epoxy, 0, H / 2));
      const s = Math.min(L, W); g.add(cyl(s * 0.05, 0.02, MAT.dot, -L / 2 + s * 0.12, H + 0.005, -W / 2 + s * 0.12, 12));
      const pitch = p.pitch || 0.5, per = Math.min(p.perSide || 4, 60), o = -(per - 1) * pitch / 2;
      const sides = e.family === 'qfn' ? [[0, -1], [0, 1], [-1, 0], [1, 0]] : [[0, -1], [0, 1]];
      for (const [sx, sz] of sides) for (let i = 0; i < per; i++) { const t = o + i * pitch; const x = sx ? sx * (L / 2 - 0.15) : t, z = sz ? sz * (W / 2 - 0.15) : t; g.add(box(sx ? 0.32 : pitch * 0.5, 0.18, sx ? pitch * 0.5 : 0.32, MAT.tin, x + sx * 0.01, 0.09, z + sz * 0.01)); }
      break;
    }
    case 'soic': {
      g.add(rbox(L, H - 0.1, W, 0.08, MAT.epoxy, 0, 0.1 + (H - 0.1) / 2));
      const per = Math.min(p.perSide || 4, 40), pitch = p.pitch || 1.27, out = Math.max(0.5, ((p.span || W + 1.6) - W) / 2), o = -(per - 1) * pitch / 2;
      for (let i = 0; i < per; i++) { gull(g, o + i * pitch, 1, W / 2, out, H * 0.45, pitch * 0.33); gull(g, o + i * pitch, -1, W / 2, out, H * 0.45, pitch * 0.33); }
      break;
    }
    case 'bga': {
      // substrate on collapsed balls: 0.1 mm off the board, not floating
      g.add(box(L, 0.36, W, MAT.subst, 0, 0.28));
      // Apple M-series: SoC under a lid with two memory dies along the long edge. Only for that kind of
      // package — ≥ 2,000 balls at ≤ 0.55 mm pitch and ≥ 400 mm²; Intel CPUs, Tegra, GPUs are plain moulded boxes
      // substrate top at 0.46; the lid is the highest point (as on the real M1), the memory dies lower beside it
      if (L * W > 400 && (p.balls ?? 0) >= 2000 && (p.pitch ?? 1) <= 0.55) {
        g.add(box(L * 0.84, 0.06, W * 0.66, MAT.epoxy, 0, 0.49, -W * 0.13)); // sealant rim under the lid
        g.add(rbox(L * 0.8, 0.62, W * 0.62, 0.35, MAT.lid, 0, 0.46 + 0.31, -W * 0.13));
        for (const sx of [-1, 1]) g.add(rbox(L * 0.42, 0.42, W * 0.25, 0.08, MAT.epoxy, sx * L * 0.22, 0.46 + 0.21, W * 0.34));
      }
      else g.add(rbox(L - 0.6, 0.6, W - 0.6, 0.1, MAT.epoxy, 0, 0.76));
      break;
    }
    case 'crystal': g.add(box(L, 0.3, W, MAT.ceramic, 0, 0.15)); g.add(rbox(L * 0.92, H - 0.3, W * 0.9, 0.1, MAT.steel, 0, 0.3 + (H - 0.3) / 2)); break;
    case 'button': { g.add(box(L, 0.55, W, MAT.dark, 0, 0.275)); g.add(rbox(L * 0.97, 0.3, W * 0.95, 0.06, MAT.steel, 0, 0.7)); g.add(cyl(Math.min(L, W) * 0.3, 0.3, MAT.dot, 0, 0.95, 0)); break; }
    case 'button-ra': g.add(rbox(L, H, W, 0.15, MAT.steel, 0, H / 2)); g.add(box(1.6, 1.2, 1.4, MAT.epoxy, 0, H * 0.55, W / 2 + 0.5)); break;
    case 'led3535': g.add(box(L, H * 0.75, W, MAT.ledBody, 0, H * 0.375)); g.add(cyl(L * 0.36, H * 0.3, MAT.lens, 0, H * 0.87, 0, 28)); break;
    case 'coax': g.add(box(L, 0.3, W, MAT.lid, 0, 0.15)); g.add(cyl(Math.min(L, W) * 0.38, H - 0.3, MAT.lid, 0, 0.3 + (H - 0.3) / 2, 0, 28)); break;
    case 'standoff': { const r = Math.min(L, W) * 0.42; g.add(cyl(r, H, MAT.lid, 0, H / 2, 0, 6)); g.add(cyl(r * 0.45, 0.02, MAT.slot, 0, H + 0.01, 0, 16)); break; }
    case 'b2b': g.add(rbox(L, H, W, 0.08, MAT.epoxy, 0, H / 2)); g.add(box(L - 1.2, 0.02, W * 0.45, MAT.slot, 0, H + 0.005)); for (const s of [-1, 1]) g.add(box(0.3, H * 0.9, W * 0.9, MAT.lid, s * (L / 2 - 0.1), H * 0.45)); break;
    case 'conn': {
      const n = Math.min(p.n || 2, 80), pitch = p.pitch || 1, housing = /JST/.test(e.size ?? '') ? MAT.nylon : MAT.epoxy;
      g.add(rbox(L, H, W, 0.12, housing, 0, H / 2)); g.add(box(L - 1.4, Math.max(0.2, H - 0.8), 0.05, MAT.slot, 0, H / 2 + 0.1, -W / 2 - 0.01));
      for (let i = 0; i < n; i++) g.add(box(pitch * 0.32, 0.1, 0.9, MAT.tin, -(n - 1) * pitch / 2 + i * pitch, 0.05, W / 2 + 0.35));
      break;
    }
    case 'usb-c': {
      const st = (w: number, h: number) => { const sh = new THREE.Shape(), r = h / 2; sh.absarc(w / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2, false); sh.absarc(-w / 2 + r, 0, r, Math.PI / 2, Math.PI * 1.5, false); return sh; };
      const shell = geo('usbc' + k3(L, H, W), () => { const s = st(L, H); s.holes.push(st(L - 0.5, H - 0.5)); const g2 = new THREE.ExtrudeGeometry(s, { depth: W, bevelEnabled: false, curveSegments: 12 }); g2.translate(0, H / 2, -W / 2); return g2; });
      g.add(new THREE.Mesh(shell, MAT.steel));
      const back = new THREE.Mesh(geo('usbcb' + k3(L, H), () => new THREE.ShapeGeometry(st(L, H), 12)), MAT.steel); back.position.set(0, H / 2, -W / 2); back.rotation.y = Math.PI; g.add(back);
      g.add(box(L - 3.2, 0.7, W - 1.6, MAT.epoxy, 0, H / 2, 0.4));
      break;
    }
    case 'header': {
      const pitch = p.pitch || 2.54, cols = Math.min(p.cols || 1, 60), rows = Math.min(p.rows || 1, 4);
      g.add(box(cols * pitch, 2.5, rows * pitch, MAT.epoxy, 0, 1.25));
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) g.add(box(0.64, 8.5, 0.64, MAT.gold, -(cols - 1) * pitch / 2 + i * pitch, 2.6, -(rows - 1) * pitch / 2 + j * pitch));
      break;
    }
    case 'box': g.add(box(L, H, W, MAT.ghost, 0, H / 2)); break;
    default: return null;
  }
  return g;
}
