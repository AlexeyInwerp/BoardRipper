/**
 * The 3D board view: one WebGL context per open 3D panel, its own canvas —
 * never shared with the Pixi renderer. Draws a `Board3DModel`: the board as a
 * slab with its outline and holes, mask / copper / pads / silkscreen baked into
 * one texture per face, and every part as a generated model, merged per
 * material (a few dozen draw calls for thousands of parts). Renders on demand.
 *
 * Teardown releases the context explicitly (`forceContextLoss`): browsers cap
 * live WebGL contexts and every board tab already holds one.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Board3DModel, Board3DPart } from './board3d-model';
import { buildPartModel, MAT } from './part-models';

export type View3DPreset = 'iso' | 'top' | 'bottom';
const T = 1.6, TOP = T / 2;

export class Board3DRenderer {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
  private controls: OrbitControls;
  private boardRoot = new THREE.Group();
  private partsRoot = new THREE.Group();
  private pickRoot = new THREE.Group();
  private hlRoot = new THREE.Group();
  private model: Board3DModel | null = null;
  private pickBoxes: THREE.Mesh[] = [];
  private partByIndex = new Map<number, { part: Board3DPart; box: THREE.Box3 }>();
  private dirty = true;
  private raf = 0;
  private anim: { from: THREE.Vector3; to: THREE.Vector3; tf: THREE.Vector3; tt: THREE.Vector3; t0: number } | null = null;
  private ro: ResizeObserver;
  private ray = new THREE.Raycaster();
  private disposed = false;

  constructor(private host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'board-3d-canvas';
    host.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color(0x16181c);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.4;
    const key = new THREE.DirectionalLight(0xffffff, 1.3); key.position.set(-0.4, 1, 0.5); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004;
    const under = new THREE.DirectionalLight(0xffffff, 0.9); under.position.set(-0.3, -1, 0.4);
    this.scene.add(key, key.target, under, new THREE.HemisphereLight(0xffffff, 0x444448, 0.45));
    this.key = key;
    this.scene.add(this.boardRoot, this.partsRoot, this.pickRoot, this.hlRoot);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true; this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host);
    this.resize();
    const loop = () => { if (this.disposed) return; this.raf = requestAnimationFrame(loop); this.tick(); };
    this.raf = requestAnimationFrame(loop);
  }
  private key: THREE.DirectionalLight;

  // ───────────── board ─────────────
  setModel(model: Board3DModel): void {
    this.model = model;
    for (const root of [this.boardRoot, this.partsRoot, this.pickRoot, this.hlRoot]) disposeTree(root);
    this.pickBoxes = []; this.partByIndex.clear();
    this.buildBoard(model);
    this.buildParts(model);
    const span = Math.max(model.width, model.height);
    Object.assign(this.key.shadow.camera, { left: -span * 0.7, right: span * 0.7, top: span * 0.7, bottom: -span * 0.7, near: 1, far: span * 6 });
    this.key.position.set(-0.4 * span, span * 1.5, 0.5 * span); this.key.shadow.camera.updateProjectionMatrix();
    this.camera.far = span * 20; this.camera.updateProjectionMatrix();
    this.view('iso', false);
  }

  private buildBoard(m: Board3DModel): void {
    const shape = new THREE.Shape();
    const outer = m.outlines.slice().sort((a, b) => b.length - a.length)[0];
    outer.forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
    const shapes = [shape];
    for (const o of m.outlines) if (o !== outer) { const s = new THREE.Shape(); o.forEach(([x, z], i) => (i ? s.lineTo(x, -z) : s.moveTo(x, -z))); shapes.push(s); }
    for (const c of m.cutouts) { const h = new THREE.Path(); c.forEach(([x, z], i) => (i ? h.lineTo(x, -z) : h.moveTo(x, -z))); shape.holes.push(h); }
    for (const h of m.holes) { const p = new THREE.Path(); p.absellipse(h.x, -h.z, h.rx, h.rz, 0, Math.PI * 2, true); shape.holes.push(p); }
    const slabGeo = new THREE.ExtrudeGeometry(shapes, { depth: T, bevelEnabled: false, curveSegments: 16 });
    slabGeo.rotateX(-Math.PI / 2); slabGeo.translate(0, -TOP, 0);
    const slab = new THREE.Mesh(slabGeo, [new THREE.MeshStandardMaterial({ color: 0x0f1a13, roughness: 0.45 }), new THREE.MeshStandardMaterial({ color: 0x8a7d5c, roughness: 0.85 })]);
    slab.castShadow = slab.receiveShadow = true; this.boardRoot.add(slab);
    const faceGeo = new THREE.ShapeGeometry(shapes, 16); faceGeo.rotateX(-Math.PI / 2);
    for (const side of ['top', 'bottom'] as const) {
      const mat = new THREE.MeshPhysicalMaterial({ map: this.faceTexture(m, side), roughness: 0.45, clearcoat: 0.35, clearcoatRoughness: 0.45, side: side === 'top' ? THREE.FrontSide : THREE.BackSide, polygonOffset: true, polygonOffsetFactor: -1 });
      const face = new THREE.Mesh(faceGeo, mat); face.position.y = side === 'top' ? TOP + 0.002 : -TOP - 0.002; face.receiveShadow = true; this.boardRoot.add(face);
    }
  }

  /** Mask, copper under the mask, exposed pads (gold), mounting rings and silkscreen, baked into one texture. */
  private faceTexture(m: Board3DModel, side: 'top' | 'bottom'): THREE.CanvasTexture {
    const ppm = Math.min(40, 8192 / Math.max(m.width, m.height));
    const cv = document.createElement('canvas'); cv.width = Math.ceil(m.width * ppm); cv.height = Math.ceil(m.height * ppm);
    const c = cv.getContext('2d')!;
    const U = (x: number) => (x + m.width / 2) * ppm, V = (z: number) => (z + m.height / 2) * ppm;
    c.fillStyle = '#12261a'; c.fillRect(0, 0, cv.width, cv.height);
    c.strokeStyle = '#1d3a28'; c.lineCap = 'round';
    for (const t of m.traces) if (t.side === side) { c.lineWidth = Math.max(1, t.w * ppm); c.beginPath(); c.moveTo(U(t.x1), V(t.z1)); c.lineTo(U(t.x2), V(t.z2)); c.stroke(); }
    c.fillStyle = '#c99a3c';
    for (const p of m.pads) {
      if (p.side !== side && p.side !== 'both') continue;
      c.save(); c.translate(U(p.x), V(p.z));
      if (p.round || p.drill > 0) { c.beginPath(); c.arc(0, 0, Math.max(p.w, p.h) * ppm / 2, 0, Math.PI * 2); c.fill(); }
      else { c.rotate(-p.angle * Math.PI / 180); c.fillRect(-p.w * ppm / 2, -p.h * ppm / 2, p.w * ppm, p.h * ppm); }
      c.restore();
    }
    for (const pt of m.parts) if (pt.est.family === 'hole') { const [x, z] = m.toScene({ x: pt.est.cx, y: pt.est.cy }); c.beginPath(); c.ellipse(U(x), V(z), pt.est.L * ppm / 2, pt.est.W * ppm / 2, 0, 0, Math.PI * 2); c.fill(); }
    c.strokeStyle = '#ecebe4'; c.lineWidth = Math.max(1, 0.14 * ppm); c.lineJoin = 'round';
    for (const s of m.silk) if (s.side === side) { c.beginPath(); s.pts.forEach(([x, z], i) => (i ? c.lineTo(U(x), V(z)) : c.moveTo(U(x), V(z)))); c.stroke(); }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    // ShapeGeometry UVs are the shape's (x, −z) in mm
    tex.repeat.set(1 / m.width, 1 / m.height); tex.offset.set(0.5, 0.5);
    return tex;
  }

  private buildParts(m: Board3DModel): void {
    const tmp = new THREE.Group();
    const pickMat = new THREE.MeshBasicMaterial();
    for (const part of m.parts) {
      const e = part.est; if (!e.populated) continue;
      const g = buildPartModel(e); if (!g) continue;
      const bottom = part.side === 'bottom';
      const [x, z] = m.toScene({ x: e.cx, y: e.cy });
      const holder = new THREE.Group(); holder.position.set(x, bottom ? -TOP : TOP, z);
      if (bottom) holder.rotation.x = Math.PI;
      g.rotation.y = (bottom ? -1 : 1) * e.rotDeg * Math.PI / 180;
      holder.add(g); tmp.add(holder);
      holder.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(holder);
      if (bb.isEmpty()) continue;
      const size = bb.getSize(new THREE.Vector3()).max(new THREE.Vector3(0.2, 0.2, 0.2));
      const pb = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), pickMat);
      pb.position.copy(bb.getCenter(new THREE.Vector3())); pb.visible = false; pb.userData.index = part.index;
      this.pickRoot.add(pb); this.pickBoxes.push(pb); this.partByIndex.set(part.index, { part, box: bb });
    }
    // one mesh per material
    tmp.updateMatrixWorld(true);
    const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
    tmp.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return;
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      g.applyMatrix4(o.matrixWorld);
      const mat = o.material as THREE.Material; let list = groups.get(mat); if (!list) groups.set(mat, (list = [])); list.push(g);
    });
    for (const [mat, list] of groups) {
      const merged = mergeGeometries(list); list.forEach(g => g.dispose()); if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat); mesh.castShadow = mesh.receiveShadow = true; this.partsRoot.add(mesh);
    }
    this.dirty = true;
  }

  // ───────────── selection ─────────────
  setSelection(partIndex: number | null, net: string | null): void {
    disposeTree(this.hlRoot);
    const m = this.model; if (!m) return;
    if (net) {
      const lit = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.45, depthWrite: false });
      const dot = new THREE.MeshBasicMaterial({ color: 0xfff27a });
      for (const [index, { box }] of this.partByIndex) {
        const pins = m.pinsOf(index).filter(q => q.net === net); if (!pins.length) continue;
        const s = box.getSize(new THREE.Vector3()).addScalar(0.15), b = new THREE.Mesh(new THREE.BoxGeometry(s.x, s.y, s.z), lit); b.position.copy(box.getCenter(new THREE.Vector3())); b.renderOrder = 5; this.hlRoot.add(b);
      }
      // pins on the net with no body drawn over them (test points, pads)
      for (const pt of m.parts) for (const q of m.pinsOf(pt.index)) if (q.net === net && !this.partByIndex.has(pt.index)) {
        const d = new THREE.Mesh(new THREE.CylinderGeometry(q.r, q.r, 0.05, 16), dot); d.position.set(q.x, q.side === 'top' ? TOP + 0.04 : -TOP - 0.04, q.z); this.hlRoot.add(d);
      }
    }
    if (partIndex !== null) {
      const e = this.partByIndex.get(partIndex);
      const box = e?.box ?? (() => { const pins = m.pinsOf(partIndex); if (!pins.length) return null; const b = new THREE.Box3(); for (const q of pins) b.expandByPoint(new THREE.Vector3(q.x, q.side === 'top' ? TOP : -TOP, q.z)); return b.expandByScalar(0.3); })();
      if (box) {
        const s = box.getSize(new THREE.Vector3()).addScalar(0.4);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(s.x, Math.max(s.y, 0.3), s.z)), new THREE.LineBasicMaterial({ color: 0xffff44, depthTest: false }));
        edges.position.copy(box.getCenter(new THREE.Vector3())); edges.renderOrder = 10; this.hlRoot.add(edges);
      }
    }
    this.dirty = true;
  }

  /** Centre the camera on a part without changing the viewing angle. */
  focusPart(partIndex: number): void {
    const e = this.partByIndex.get(partIndex); if (!e) return;
    const c = e.box.getCenter(new THREE.Vector3()), d = this.camera.position.clone().sub(this.controls.target);
    const dist = Math.min(d.length(), Math.max(15, e.box.getSize(new THREE.Vector3()).length() * 6));
    this.animateTo(c.clone().add(d.setLength(dist)), c);
  }

  // ───────────── camera ─────────────
  view(preset: View3DPreset, animate = true): void {
    const m = this.model; if (!m) return;
    // fit the board's long side to the view: the vertical extent that has to fit is the larger of
    // the height and the width over the aspect; an angled view foreshortens, so it can sit closer
    const span = Math.max(m.height, m.width / this.camera.aspect) * (preset === 'iso' ? 0.9 : 1.08);
    const dist = span / (2 * Math.tan(this.camera.fov * Math.PI / 360));
    // the user's Top is the file's primary side
    const top = (preset === 'top') !== (m.primarySide === 'bottom') ? 1 : -1;
    const to = preset === 'iso' ? new THREE.Vector3(-0.35, 0.75 * (m.primarySide === 'bottom' ? -1 : 1), 0.75).setLength(dist) : new THREE.Vector3(0, top * dist, 0.001 * dist);
    if (animate) this.animateTo(to, new THREE.Vector3()); else { this.camera.position.copy(to); this.controls.target.set(0, 0, 0); this.controls.update(); this.dirty = true; }
  }
  private animateTo(to: THREE.Vector3, target: THREE.Vector3): void {
    this.anim = { from: this.camera.position.clone(), to, tf: this.controls.target.clone(), tt: target, t0: performance.now() };
  }

  // ───────────── picking ─────────────
  pick(clientX: number, clientY: number): number | null {
    const r = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -(clientY - r.top) / r.height * 2 + 1);
    this.ray.setFromCamera(v, this.camera);
    const hit = this.ray.intersectObjects(this.pickBoxes, false)[0];
    return hit ? (hit.object.userData.index as number) : null;
  }
  part(index: number): Board3DPart | undefined { return this.partByIndex.get(index)?.part; }
  /** Screen position (client px) of a part's centre — for tests and labels. */
  screenOf(index: number): [number, number] | null {
    const e = this.partByIndex.get(index); if (!e) return null;
    const v = e.box.getCenter(new THREE.Vector3()).project(this.camera), r = this.canvas.getBoundingClientRect();
    return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
  }
  get drawnParts(): number { return this.partByIndex.size; }

  // ───────────── loop ─────────────
  private resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.dirty = true;
  }
  private tick(): void {
    if (this.anim) {
      const k = Math.min(1, (performance.now() - this.anim.t0) / 450), e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(this.anim.from, this.anim.to, e); this.controls.target.lerpVectors(this.anim.tf, this.anim.tt, e);
      if (k >= 1) this.anim = null; this.dirty = true;
    }
    this.controls.update();
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  }
  dispose(): void {
    this.disposed = true; cancelAnimationFrame(this.raf); this.ro.disconnect(); this.controls.dispose();
    for (const root of [this.boardRoot, this.partsRoot, this.pickRoot, this.hlRoot]) disposeTree(root);
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.canvas.remove();
  }
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse(o => {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { (m as THREE.MeshStandardMaterial).map?.dispose(); if (!SHARED.has(m)) m.dispose(); }
    }
  });
  root.clear();
}
// part-model materials are module-wide and shared between views: never dispose them
const SHARED = new Set<THREE.Material>(Object.values(MAT));
