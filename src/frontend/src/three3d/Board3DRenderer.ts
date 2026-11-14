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
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Board3DModel, Board3DPad, Board3DPart } from './board3d-model';
import { buildPartModel, MAT } from './part-models';
import { buildLabelMesh, type LabelSpec } from './part-labels';

export type View3DPreset = 'iso' | 'top' | 'bottom';
const T = 1.6, TOP = T / 2;

export class Board3DRenderer {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
  /** The point the camera looks at. Turning pivots about the selected part, else the board centre. */
  private target = new THREE.Vector3();
  private leftDrag: 'orbit' | 'pan' = 'orbit';
  private selectedPart: number | null = null;
  private boardRoot = new THREE.Group();
  private partsRoot = new THREE.Group();
  private pickRoot = new THREE.Group();
  private hlRoot = new THREE.Group();
  private labelRoot = new THREE.Group();
  private labelMat: THREE.ShaderMaterial | null = null;
  private model: Board3DModel | null = null;
  private pickBoxes: THREE.Mesh[] = [];
  private partByIndex = new Map<number, { part: Board3DPart; box: THREE.Box3 }>();
  private dirty = true;
  private raf = 0;
  private anim: { from: THREE.Vector3; to: THREE.Vector3; tf: THREE.Vector3; tt: THREE.Vector3; t0: number; uf: THREE.Vector3; ut: THREE.Vector3 } | null = null;
  private ro: ResizeObserver;
  private ray = new THREE.Raycaster();
  private disposed = false;
  // Dynamic resolution: the view is fill-bound (16 ms a frame at 2× on an M1, 8 ms at 1×), so it
  // draws at 1× while the camera moves and once at full resolution when it settles.
  private fullPr = 1;
  private movingUntil = 0;

  private host: HTMLElement;
  constructor(host: HTMLElement) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'board-3d-canvas';
    host.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.fullPr = Math.min(devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.fullPr);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap; // soft: the map is drawn once, only the board face samples it
    // the key light is fixed to the board and only the camera moves: draw the shadow map once per board
    this.renderer.shadowMap.autoUpdate = false;
    this.scene.background = new THREE.Color(0x16181c);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.4;
    const key = new THREE.DirectionalLight(0xffffff, 1.3); key.position.set(-0.4, 1, 0.5); key.castShadow = true; key.shadow.mapSize.set(4096, 4096); key.shadow.bias = -0.0002; key.shadow.normalBias = 0.03; key.shadow.radius = 3;
    const under = new THREE.DirectionalLight(0xffffff, 0.9); under.position.set(-0.3, -1, 0.4);
    this.scene.add(key, key.target, under, new THREE.HemisphereLight(0xffffff, 0x444448, 0.45));
    this.key = key;
    this.scene.add(this.boardRoot, this.partsRoot, this.pickRoot, this.hlRoot, this.labelRoot);
    // Our own drag handling, not OrbitControls / TrackballControls: turning is free in every
    // direction (an orbit control clamps at the poles and the board got stuck there), and it
    // pivots about a point we choose — the selected part, else the board centre.
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    // every wheel is ours: a scroll pans, a pinch or ⌘/Ctrl+scroll zooms at the pointer
    this.canvas.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host);
    this.resize();
    const loop = () => { if (this.disposed) return; this.raf = requestAnimationFrame(loop); this.tick(); };
    this.raf = requestAnimationFrame(loop);
  }
  private key: THREE.DirectionalLight;

  // ───────────── board ─────────────
  private buildMs = 0;
  setModel(model: Board3DModel): void {
    const t0 = performance.now();
    this.model = model;
    for (const root of [this.boardRoot, this.partsRoot, this.pickRoot, this.hlRoot, this.labelRoot]) disposeTree(root);
    this.pickBoxes = []; this.partByIndex.clear();
    this.buildBoard(model);
    this.buildParts(model);
    this.buildPickGrids(model);
    this.buildLabels(model);
    const span = Math.max(model.width, model.height);
    Object.assign(this.key.shadow.camera, { left: -span * 0.7, right: span * 0.7, top: span * 0.7, bottom: -span * 0.7, near: 1, far: span * 6 });
    this.key.position.set(-0.4 * span, span * 1.5, 0.5 * span); this.key.shadow.camera.updateProjectionMatrix();
    this.camera.far = span * 20; this.camera.updateProjectionMatrix();
    this.view('iso', false);
    this.renderer.shadowMap.needsUpdate = true;
    this.buildMs = Math.round(performance.now() - t0);
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
    const slab = new THREE.Mesh(slabGeo, [new THREE.MeshStandardMaterial({ color: 0x09130d, roughness: 0.45 }), new THREE.MeshStandardMaterial({ color: 0x8a7d5c, roughness: 0.85 })]);
    // the slab must not shadow its own face: that was the speckle (shadow acne) over the whole board
    slab.receiveShadow = true; this.boardRoot.add(slab);
    const faceGeo = new THREE.ShapeGeometry(shapes, 16); faceGeo.rotateX(-Math.PI / 2);
    for (const side of ['top', 'bottom'] as const) {
      const mat = new THREE.MeshStandardMaterial({ map: this.faceTexture(m, side), roughness: 0.42, side: side === 'top' ? THREE.FrontSide : THREE.BackSide, polygonOffset: true, polygonOffsetFactor: -1 });
      const face = new THREE.Mesh(faceGeo, mat); face.position.y = side === 'top' ? TOP + 0.002 : -TOP - 0.002; face.receiveShadow = true; this.boardRoot.add(face);
    }
  }

  /** Mask, copper under the mask, exposed pads (gold), mounting rings and silkscreen, baked into one texture. */
  private faceTexture(m: Board3DModel, side: 'top' | 'bottom'): THREE.CanvasTexture {
    const ppm = Math.min(40, 8192 / Math.max(m.width, m.height));
    const cv = document.createElement('canvas'); cv.width = Math.ceil(m.width * ppm); cv.height = Math.ceil(m.height * ppm);
    const c = cv.getContext('2d')!;
    const U = (x: number) => (x + m.width / 2) * ppm, V = (z: number) => (z + m.height / 2) * ppm;
    c.fillStyle = '#0a1710'; c.fillRect(0, 0, cv.width, cv.height); // darker mask: parts, lands and the lit net stand out
    c.strokeStyle = '#13281b'; c.lineCap = 'round';
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
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy()); // 16× costs at grazing angles over a whole board face
    // ShapeGeometry UVs are the shape's (x, −z) in mm
    tex.repeat.set(1 / m.width, 1 / m.height); tex.offset.set(0.5, 0.5);
    return tex;
  }

  /** Large bodies that stand over their own pins (BGAs, QFNs, connectors…) are kept as their own
   *  meshes with their own materials, so they can turn see-through when zoomed into or selected. */
  private static seeThrough(e: Board3DPart['est']): boolean {
    const area = e.L * e.W;
    return area >= 12 || (area >= 4 && ['bga', 'qfn', 'son', 'b2b', 'conn', 'usb-c', 'soic'].includes(e.family));
  }
  private xray: { index: number; group: THREE.Group; mats: THREE.MeshStandardMaterial[]; centre: THREE.Vector3; radius: number; opacity: number }[] = [];

  private buildParts(m: Board3DModel): void {
    const shared = new THREE.Group();
    const pickMat = new THREE.MeshBasicMaterial();
    this.xray = [];
    for (const part of m.parts) {
      const e = part.est; if (!e.populated) continue;
      const g = buildPartModel(e); if (!g) continue;
      const bottom = part.side === 'bottom';
      const [x, z] = m.toScene({ x: e.cx, y: e.cy });
      const holder = new THREE.Group(); holder.position.set(x, bottom ? -TOP : TOP, z);
      if (bottom) holder.rotation.x = Math.PI;
      g.rotation.y = (bottom ? -1 : 1) * e.rotDeg * Math.PI / 180;
      holder.add(g);
      holder.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(holder);
      if (bb.isEmpty()) continue;
      const size = bb.getSize(new THREE.Vector3()).max(new THREE.Vector3(0.2, 0.2, 0.2));
      const pb = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), pickMat);
      pb.position.copy(bb.getCenter(new THREE.Vector3())); pb.visible = false; pb.userData.index = part.index;
      this.pickRoot.add(pb); this.pickBoxes.push(pb); this.partByIndex.set(part.index, { part, box: bb });
      if (Board3DRenderer.seeThrough(e)) {
        const own = new THREE.Group(), clones = new Map<THREE.Material, THREE.MeshStandardMaterial>();
        Board3DRenderer.mergeByMaterial([holder], own, mat => { let c = clones.get(mat); if (!c) { c = (mat as THREE.MeshStandardMaterial).clone(); clones.set(mat, c); } return c; });
        this.partsRoot.add(own);
        this.xray.push({ index: part.index, group: own, mats: [...clones.values()], centre: bb.getCenter(new THREE.Vector3()), radius: size.length() / 2, opacity: 1 });
      } else shared.add(holder);
    }
    Board3DRenderer.mergeByMaterial([shared], this.partsRoot, mat => mat);
    this.dirty = true;
  }
  /** Merge every mesh under `roots` into one mesh per material (indices kept), into `into`. */
  private static mergeByMaterial(roots: THREE.Object3D[], into: THREE.Object3D, matFor: (m: THREE.Material) => THREE.Material): void {
    const groups = new Map<THREE.Material, THREE.BufferGeometry[]>(), flat = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const root of roots) {
      root.updateMatrixWorld(true);
      root.traverse(o => {
        if (!(o instanceof THREE.Mesh)) return;
        const g = o.geometry.clone();
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
        g.applyMatrix4(o.matrixWorld);
        // mergeGeometries needs all-indexed or all-non-indexed: one bucket each per material
        const key = o.material as THREE.Material, bucket = g.index ? groups : flat;
        let list = bucket.get(key); if (!list) bucket.set(key, (list = [])); list.push(g);
      });
    }
    for (const [mat, list] of [...groups, ...flat]) {
      const merged = mergeGeometries(list); list.forEach(g => g.dispose()); if (!merged) continue;
      // parts cast onto the board; they do not receive (a shadow lookup per part pixel for little to see)
      const mesh = new THREE.Mesh(merged, matFor(mat)); mesh.castShadow = true; into.add(mesh);
    }
  }

  /** See-through for large bodies: they fade as they fill the view (zooming into a BGA shows its
   *  lands and the lit net under it), and the selected part fades when one of its pins is picked. */
  private updateXray(): void {
    const focal = 1 / Math.tan(this.camera.fov * Math.PI / 360);
    for (const x of this.xray) {
      const dist = Math.max(0.1, this.camera.position.distanceTo(x.centre)), frac = x.radius / dist * focal; // share of the half-height
      // fades only when the camera comes closer than ~2× the part's own size (a big SoC must stay solid at a normal look)
      let op = 1 - 0.78 * THREE.MathUtils.smoothstep(frac, 1.6, 3.0);
      if (x.index === this.selectedPart && this.selectedPin !== null) op = Math.min(op, 0.35);
      if (Math.abs(op - x.opacity) < 0.01) continue;
      x.opacity = op;
      for (const m of x.mats) { m.transparent = op < 0.999; m.opacity = op; m.depthWrite = op >= 0.999; m.needsUpdate = true; }
      x.group.traverse(o => { if (o instanceof THREE.Mesh) o.castShadow = op > 0.9; });
    }
  }
  private xrayOpacity(index: number): number { return this.xray.find(x => x.index === index)?.opacity ?? 1; }
  private selectedPin: number | null = null;

  /** Every drawn part's name on its outer face, along its long axis. */
  private buildLabels(m: Board3DModel): void {
    const specs: LabelSpec[] = [];
    for (const [, { part, box }] of this.partByIndex) {
      const e = part.est, bottom = part.side === 'bottom', c = box.getCenter(new THREE.Vector3());
      const long = Math.max(e.L, e.W), short = Math.min(e.L, e.W);
      // on the body's top, not on whatever sticks up from it (header pins)
      const topY = Math.min(bottom ? -box.min.y : box.max.y, TOP + e.H + 0.05) + 0.012;
      specs.push({ text: part.name, x: c.x, y: bottom ? -topY : topY, z: c.z, height: Math.min(short * 0.45, 1.0), maxLength: long * 0.85, angleDeg: e.L >= e.W ? e.rotDeg : e.rotDeg + 90, side: part.side });
    }
    void m;
    const mesh = buildLabelMesh(specs); if (!mesh) return;
    this.labelMat = mesh.material as THREE.ShaderMaterial; this.labelMat.uniforms.viewportH.value = this.renderer.domElement.height;
    this.labelRoot.add(mesh);
  }
  setLabelsVisible(on: boolean): void { this.labelRoot.visible = on; this.dirty = true; }

  // ───────────── pick grids (pads by pin, traces), 1 mm cells ─────────────
  private padGrid = new Map<string, { part: number; pin: number; pad: Board3DPad }[]>();
  private traceGrid = new Map<string, number[]>();
  private static cellKey(x: number, z: number) { return `${Math.floor(x)},${Math.floor(z)}`; }
  private buildPickGrids(m: Board3DModel): void {
    this.padGrid.clear(); this.traceGrid.clear();
    for (const pt of m.parts) m.pinPads(pt.index).forEach((pad, pin) => {
      if (!pad) return; const r = Math.max(pad.w, pad.h) / 2;
      for (let x = Math.floor(pad.x - r); x <= Math.floor(pad.x + r); x++) for (let z = Math.floor(pad.z - r); z <= Math.floor(pad.z + r); z++) {
        const k = `${x},${z}`; let l = this.padGrid.get(k); if (!l) this.padGrid.set(k, (l = [])); l.push({ part: pt.index, pin, pad });
      }
    });
    m.traces.forEach((t, i) => {
      const n = Math.max(1, Math.ceil(Math.hypot(t.x2 - t.x1, t.z2 - t.z1)));
      let last = '';
      for (let k = 0; k <= n; k++) { const key = Board3DRenderer.cellKey(t.x1 + (t.x2 - t.x1) * k / n, t.z1 + (t.z2 - t.z1) * k / n); if (key === last) continue; last = key; let l = this.traceGrid.get(key); if (!l) this.traceGrid.set(key, (l = [])); l.push(i); }
    });
  }
  private static inPad(pad: Board3DPad, x: number, z: number, margin: number): boolean {
    const dx = x - pad.x, dz = z - pad.z;
    if (pad.round) return Math.hypot(dx, dz) <= Math.max(pad.w, pad.h) / 2 + margin;
    const a = pad.angle * Math.PI / 180, lx = dx * Math.cos(a) - dz * Math.sin(a), lz = dx * Math.sin(a) + dz * Math.cos(a); // scene z = −board y
    return Math.abs(lx) <= pad.w / 2 + margin && Math.abs(lz) <= pad.h / 2 + margin;
  }

  /** What is under a screen point: a part body, a pin (its land, or the part of a
   *  body standing on it — a chip's end cap), or a trace's net on the visible face. */
  pickAt(clientX: number, clientY: number): { part: number | null; pin: number | null; net: string | null } {
    const m = this.model; if (!m) return { part: null, pin: null, net: null };
    const r = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -(clientY - r.top) / r.height * 2 + 1), this.camera);
    const fromAbove = this.camera.position.y >= this.target.y;
    const side: 'top' | 'bottom' = fromAbove ? 'top' : 'bottom';
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), fromAbove ? -TOP : TOP), onFace = new THREE.Vector3();
    const faceHit = this.ray.ray.intersectPlane(plane, onFace);
    const hit = this.ray.intersectObjects(this.pickBoxes, false)[0];
    if (hit) {
      const index = hit.object.userData.index as number, pads = m.pinPads(index);
      const pinAt = (pt: THREE.Vector3) => (pads.filter(Boolean).length > 1 ? pads.findIndex(p => p && Board3DRenderer.inPad(p, pt.x, pt.z, 0.05)) : -1);
      // Drill down: a click on the part already selected, or on a body gone see-through, picks the
      // pin under the pointer (its land on the face below) — a BGA ball, a QFN pad.
      if (faceHit && (index === this.selectedPart || this.xrayOpacity(index) < 0.6)) { const pin = pinAt(onFace); if (pin >= 0) return { part: index, pin, net: null }; }
      // Otherwise only a terminal you can see picks a pin: the body's surface near the board, over a land (end caps, feet).
      const nearBoard = Math.abs(hit.point.y) < TOP + 0.4;
      if (nearBoard) { const pin = pinAt(hit.point); if (pin >= 0) return { part: index, pin, net: null }; }
      return { part: index, pin: null, net: null };
    }
    if (!faceHit) return { part: null, pin: null, net: null };
    // bare face: a land (test points, exposed pads), else copper under the mask
    for (const c of this.padGrid.get(Board3DRenderer.cellKey(onFace.x, onFace.z)) ?? [])
      if ((c.pad.side === side || c.pad.side === 'both') && Board3DRenderer.inPad(c.pad, onFace.x, onFace.z, 0.08)) return { part: c.part, pin: c.pin, net: null };
    let best: string | null = null, bd = Infinity;
    for (const i of this.traceGrid.get(Board3DRenderer.cellKey(onFace.x, onFace.z)) ?? []) {
      const t = m.traces[i]; if (t.side !== side || !t.net) continue;
      const ex = t.x2 - t.x1, ez = t.z2 - t.z1, L2 = ex * ex + ez * ez || 1, u = Math.max(0, Math.min(1, ((onFace.x - t.x1) * ex + (onFace.z - t.z1) * ez) / L2));
      const d = Math.hypot(onFace.x - t.x1 - ex * u, onFace.z - t.z1 - ez * u);
      if (d <= t.w / 2 + 0.08 && d < bd) { bd = d; best = t.net; }
    }
    return { part: null, pin: null, net: best };
  }

  // ───────────── selection ─────────────
  /** Three levels in colours nothing on a board has (green mask, gold lands, tan / black / grey
   *  bodies, white names), so the eye finds the one thing that was picked:
   *   - the picked pin: its land electric cyan, with a cyan ring drawn through any body above it;
   *   - the net: every land on it magenta, every part on it outlined magenta; lands hidden under a
   *     body get a small magenta marker that shows through it (not on huge nets like GND);
   *   - the selected part: a thick violet outline and a faint violet veil; see-through once a pin of it is picked. */
  setSelection(partIndex: number | null, net: string | null, pinIndex: number | null = null): void {
    this.selectedPart = partIndex; this.selectedPin = pinIndex;
    disposeTree(this.hlRoot); this.lineMats = []; this.markers = [];
    const m = this.model; if (!m) return;
    if (net) this.hlRoot.add(this.netPads(m, net, partIndex, pinIndex));
    if (net) for (const [index, { box }] of this.partByIndex) {
      if (index === partIndex || !m.pinsOf(index).some(q => q.net === net)) continue;
      this.hlRoot.add(this.thickBox(box, 0.12, SEL.net, 2.5));
    }
    if (net) this.hlRoot.add(this.netMarkers(m, net, partIndex, pinIndex));
    if (partIndex !== null) {
      const e = this.partByIndex.get(partIndex);
      const box = e?.box ?? (() => { const pins = m.pinsOf(partIndex); if (!pins.length) return null; const b = new THREE.Box3(); for (const q of pins) b.expandByPoint(new THREE.Vector3(q.x, q.side === 'top' ? TOP : -TOP, q.z)); return b.expandByScalar(0.3); })();
      if (box) {
        this.hlRoot.add(this.thickBox(box, 0.25, SEL.part, 3.5));
        if (pinIndex === null) { const sz = box.getSize(new THREE.Vector3()).addScalar(0.25), veil = new THREE.Mesh(new THREE.BoxGeometry(sz.x, Math.max(sz.y, 0.3), sz.z), new THREE.MeshBasicMaterial({ color: SEL.part, transparent: true, opacity: 0.14, depthWrite: false })); veil.position.copy(box.getCenter(new THREE.Vector3())); veil.renderOrder = 5; this.hlRoot.add(veil); }
      }
      if (pinIndex !== null) { const pad = m.pinPads(partIndex)[pinIndex], q = m.pinsOf(partIndex)[pinIndex]; if (pad || q) this.hlRoot.add(this.pinRing(pad?.x ?? q.x, pad?.z ?? q.z, (pad?.side ?? q.side) === 'bottom', pad ? Math.max(pad.w, pad.h) : q.r * 2)); }
    }
    this.dirty = true;
  }

  /** The lands of every pin on `net`, lit on their face; the clicked pin's land brighter. */
  private netPads(m: Board3DModel, net: string, partIndex: number | null, pinIndex: number | null): THREE.Group {
    const g = new THREE.Group(), lit: THREE.BufferGeometry[] = [], hot: THREE.BufferGeometry[] = [];
    for (const pt of m.parts) {
      const pins = m.pinsOf(pt.index), pads = m.pinPads(pt.index);
      pins.forEach((q, i) => {
        if (q.net !== net) return;
        const pad = pads[i] ?? { x: q.x, z: q.z, w: q.r * 2, h: q.r * 2, angle: 0, round: true, side: q.side, drill: 0 };
        const faces = pad.side === 'both' ? ['top', 'bottom'] : [q.side];
        for (const f of faces) {
          // facing out of its face (+y on top, −y below), then turned like the land: same footprint either side
          const c = pad.round ? new THREE.CircleGeometry(Math.max(pad.w, pad.h) / 2 + 0.03, 20) : new THREE.PlaneGeometry(pad.w + 0.06, pad.h + 0.06);
          c.rotateX(f === 'top' ? -Math.PI / 2 : Math.PI / 2); c.rotateY(pad.angle * Math.PI / 180);
          c.translate(pad.x, f === 'top' ? TOP + 0.012 : -TOP - 0.012, pad.z); (pt.index === partIndex && i === pinIndex ? hot : lit).push(c);
        }
      });
    }
    for (const [list, color] of [[lit, SEL.net], [hot, SEL.pin]] as const) {
      if (!list.length) continue; const merged = mergeGeometries(list.map(x => x.index ? x.toNonIndexed() : x)); list.forEach(x => x.dispose()); if (!merged) continue;
      const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ color, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })); mesh.renderOrder = 4; g.add(mesh);
    }
    return g;
  }

  /** A ring around the picked pin that stays visible through the body standing on it. */
  private pinRing(x: number, z: number, bottom: boolean, size: number): THREE.Mesh {
    const r = Math.max(size * 0.9, 0.35), geo = new THREE.RingGeometry(r, r + Math.max(0.12, r * 0.4), 40);
    geo.rotateX(bottom ? Math.PI / 2 : -Math.PI / 2);
    const ring = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: SEL.pin, depthTest: false, transparent: true, side: THREE.DoubleSide }));
    ring.position.set(x, bottom ? -TOP - 0.02 : TOP + 0.02, z); ring.renderOrder = 12; ring.userData.face = bottom ? 'bottom' : 'top'; this.markers.push(ring);
    // and a ring of constant screen size, so the picked pin is findable from any distance
    const pg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const pts = new THREE.Points(pg, new THREE.PointsMaterial({ color: SEL.pin, size: 26, sizeAttenuation: false, map: markerTexture('ring'), transparent: true, depthTest: false, alphaTest: 0.1 }));
    pts.renderOrder = 13; pts.userData.face = ring.userData.face; this.markers.push(pts); ring.add(pts);
    return ring;
  }

  /** A box outline in screen-pixel-wide lines (WebGL draws 1-px GL lines, too thin to see on a busy board). */
  private lineMats: LineMaterial[] = [];
  private thickBox(box: THREE.Box3, pad: number, color: number, px: number): LineSegments2 {
    const b = box.clone().expandByScalar(pad / 2), [a, c] = [b.min, b.max];
    const P = [[a.x, a.y, a.z], [c.x, a.y, a.z], [c.x, a.y, c.z], [a.x, a.y, c.z], [a.x, c.y, a.z], [c.x, c.y, a.z], [c.x, c.y, c.z], [a.x, c.y, c.z]];
    const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const g = new LineSegmentsGeometry().setPositions(E.flatMap(([i, j]) => [...P[i], ...P[j]]));
    const mat = new LineMaterial({ color, linewidth: px, worldUnits: false }); mat.resolution.set(this.renderer.domElement.width, this.renderer.domElement.height);
    this.lineMats.push(mat); const l = new LineSegments2(g, mat); l.renderOrder = 10; return l;
  }

  /** Lands of the lit net that sit under a body: small markers drawn through the body, on the face the
   *  camera is on (the other face's markers would show through the board). Skipped on huge nets. */
  private markers: THREE.Object3D[] = [];
  private netMarkers(m: Board3DModel, net: string, partIndex: number | null, pinIndex: number | null): THREE.Group {
    const g = new THREE.Group(), pts: { x: number; z: number; side: 'top' | 'bottom'; r: number }[] = [];
    for (const [index] of this.partByIndex) m.pinsOf(index).forEach((q, i) => { if (q.net === net && !(index === partIndex && i === pinIndex)) { const pad = m.pinPads(index)[i]; pts.push({ x: pad?.x ?? q.x, z: pad?.z ?? q.z, side: q.side, r: Math.max(0.12, Math.min(0.5, (pad ? Math.min(pad.w, pad.h) : q.r * 2) * 0.45)) }); } });
    if (!pts.length || pts.length > 300) return g;
    const tex = markerTexture('dot');
    for (const side of ['top', 'bottom'] as const) {
      const on = pts.filter(p => p.side === side); if (!on.length) continue;
      const pg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(on.flatMap(p => [p.x, side === 'top' ? TOP + 0.03 : -TOP - 0.03, p.z]), 3));
      const mesh = new THREE.Points(pg, new THREE.PointsMaterial({ color: SEL.net, size: 9, sizeAttenuation: false, map: tex, transparent: true, depthTest: false, alphaTest: 0.1 }));
      mesh.renderOrder = 11; mesh.userData.face = side; this.markers.push(mesh); g.add(mesh);
    }
    return g;
  }

  /** Centre the camera on a part without changing the viewing angle. */
  focusPart(partIndex: number): void {
    const e = this.partByIndex.get(partIndex); if (!e) return;
    const c = e.box.getCenter(new THREE.Vector3()), d = this.camera.position.clone().sub(this.target);
    const dist = Math.min(d.length(), Math.max(15, e.box.getSize(new THREE.Vector3()).length() * 6));
    this.animateTo(c.clone().add(d.setLength(dist)), c);
  }

  // ───────────── camera ─────────────
  /** Zoom towards (factor < 1) or away from the point under a screen position: it stays under the pointer. */
  zoomAt(clientX: number, clientY: number, factor: number): void {
    const r = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -(clientY - r.top) / r.height * 2 + 1), this.camera);
    const hit = this.ray.intersectObjects([...this.pickBoxes, ...this.boardRoot.children], false)[0];
    const p = hit?.point ?? this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3()) ?? this.target.clone();
    const dist = this.camera.position.distanceTo(p), m = this.model, max = m ? Math.max(m.width, m.height) * 8 : 2000;
    const f = Math.min(max / Math.max(dist, 1e-3), Math.max(1.5 / Math.max(dist, 1e-3), factor));
    this.camera.position.sub(p).multiplyScalar(f).add(p); this.target.sub(p).multiplyScalar(f).add(p);
    this.dirty = true; this.movingUntil = performance.now() + 180;
  }
  /** Move the camera towards (factor < 1) or away from (> 1) its target. */
  zoomBy(factor: number): void {
    const d = this.camera.position.clone().sub(this.target), len = d.length() * factor;
    const m = this.model, max = m ? Math.max(m.width, m.height) * 8 : 2000;
    this.animateTo(this.target.clone().add(d.setLength(Math.min(max, Math.max(2, len)))), this.target.clone());
  }
  /** Pan by screen pixels (+x right, +y down), the board following the pointer. */
  panBy(dx: number, dy: number, animate = false): void {
    const dist = this.camera.position.distanceTo(this.target);
    const perPx = 2 * dist * Math.tan(this.camera.fov * Math.PI / 360) / Math.max(1, this.canvas.clientHeight);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0), up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const move = right.multiplyScalar(-dx * perPx).add(up.multiplyScalar(dy * perPx));
    if (animate) this.animateTo(this.camera.position.clone().add(move), this.target.clone().add(move));
    else { this.camera.position.add(move); this.target.add(move); this.dirty = true; this.movingUntil = performance.now() + 180; }
  }
  /** Whole board in view, keeping the current viewing angle. */
  fit(): void {
    const m = this.model; if (!m) return;
    const dir = this.camera.position.clone().sub(this.target).normalize();
    const span = Math.max(m.height, m.width / this.camera.aspect) * 1.2, dist = span / (2 * Math.tan(this.camera.fov * Math.PI / 360));
    this.animateTo(dir.multiplyScalar(dist), new THREE.Vector3());
  }
  /** What a plain left-drag does: orbit (default) or pan. */
  setLeftDrag(mode: 'orbit' | 'pan'): void { this.leftDrag = mode; }

  // ───────────── drag: turn about a pivot, pan, pinch ─────────────
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { mode: 'turn' | 'pan'; pivot: THREE.Vector3 } | null = null;
  private pinch: { dist: number; mid: [number, number] } | null = null;
  private onContextMenu = (e: Event) => e.preventDefault();
  /** Where turning pivots: the point pressed — a part's surface, or the board face under the
   *  pointer — else the selected part's centre, else the board centre. */
  private pivotAt(clientX: number, clientY: number): THREE.Vector3 {
    const r = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -(clientY - r.top) / r.height * 2 + 1), this.camera);
    const hit = this.ray.intersectObjects([...this.pickBoxes, ...this.boardRoot.children], false)[0];
    if (hit) return hit.point.clone();
    const onBoard = this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (onBoard && this.model && Math.abs(onBoard.x) < this.model.width && Math.abs(onBoard.z) < this.model.height) return onBoard;
    const sel = this.selectedPart !== null ? this.partByIndex.get(this.selectedPart) : undefined;
    return sel ? sel.box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  }
  /** The last pivot a turn used — for tests. */
  lastPivot: [number, number, number] | null = null;
  private onPointerDown = (e: PointerEvent) => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    if (this.pointers.size === 2) { this.drag = null; this.pinch = this.pinchState(); return; }
    const panButton = e.button === 1 || (e.button === 2) === (this.leftDrag === 'orbit') || (e.button === 0 && e.shiftKey);
    const pivot = panButton ? new THREE.Vector3() : this.pivotAt(e.clientX, e.clientY);
    this.drag = { mode: panButton ? 'pan' : 'turn', pivot }; if (!panButton) this.lastPivot = [pivot.x, pivot.y, pivot.z];
    this.anim = null;
  };
  private pinchState() { const [a, b] = [...this.pointers.values()]; return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] as [number, number] }; }
  private onPointerMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId); if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y; prev.x = e.clientX; prev.y = e.clientY;
    if (this.pinch && this.pointers.size >= 2) {
      const now = this.pinchState();
      if (now.dist > 0 && this.pinch.dist > 0) this.zoomAt(now.mid[0], now.mid[1], this.pinch.dist / now.dist);
      this.panBy(now.mid[0] - this.pinch.mid[0], now.mid[1] - this.pinch.mid[1]);
      this.pinch = now; return;
    }
    if (!this.drag || (dx === 0 && dy === 0)) return;
    if (this.drag.mode === 'pan') this.panBy(dx, dy);
    else this.turnBy(dx, dy, this.drag.pivot);
  };
  private onPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) this.drag = null;
  };
  /** Turntable about `pivot`: a horizontal drag spins about the board's normal, a vertical drag
   *  tips about the screen's horizontal axis. Spinning about the camera's own axes (a trackball)
   *  builds up roll when the pointer moves in circles — the board tilted further and further.
   *  The tip is not clamped, so there is no pole to get stuck at; the whole camera frame turns
   *  about the pivot, so the pivot stays under the pointer. */
  turnBy(dx: number, dy: number, pivot: THREE.Vector3): void {
    const k = 0.006, upright = this.camera.up.y >= 0 ? 1 : -1; // past the pole the board is seen upside down: keep the spin following the pointer
    const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * k * upright);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).applyQuaternion(spin);
    right.y = 0; if (right.lengthSq() < 1e-8) right.set(1, 0, 0); right.normalize(); // keep the tip axis level, so no roll creeps in
    const q = new THREE.Quaternion().setFromAxisAngle(right, -dy * k).multiply(spin);
    this.camera.position.sub(pivot).applyQuaternion(q).add(pivot);
    this.target.sub(pivot).applyQuaternion(q).add(pivot);
    this.camera.up.applyQuaternion(q);
    this.camera.quaternion.premultiply(q); this.camera.updateMatrixWorld();
    this.dirty = true; this.movingUntil = performance.now() + 180;
  }
  /** In 3D a plain wheel / two-finger swipe pans and a pinch (ctrlKey) or ⌘/Ctrl+wheel zooms at the pointer; drag turns. */
  private onWheel = (e: WheelEvent) => {
    e.preventDefault(); e.stopImmediatePropagation();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.clientHeight : 1;
    if (e.ctrlKey || e.metaKey) { this.zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * k * 0.004)); return; }
    if (e.shiftKey && !e.deltaX) this.panBy(-e.deltaY * k, 0); else this.panBy(-e.deltaX * k, -e.deltaY * k);
  };

  view(preset: View3DPreset, animate = true): void {
    const m = this.model; if (!m) return;
    // fit the board's long side to the view: the vertical extent that has to fit is the larger of
    // the height and the width over the aspect; an angled view foreshortens, so it can sit closer
    const span = Math.max(m.height, m.width / this.camera.aspect) * (preset === 'iso' ? 1.2 : 1.08);
    const dist = span / (2 * Math.tan(this.camera.fov * Math.PI / 360));
    // the user's Top is the file's primary side
    const top = (preset === 'top') !== (m.primarySide === 'bottom') ? 1 : -1;
    const to = preset === 'iso' ? new THREE.Vector3(-0.35, 0.75 * (m.primarySide === 'bottom' ? -1 : 1), 0.75).setLength(dist) : new THREE.Vector3(0, top * dist, 0.001 * dist);
    const up = preset === 'iso' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1); // straight at a face: the board's +y is screen-up
    if (animate) this.animateTo(to, new THREE.Vector3(), up);
    else { this.camera.position.copy(to); this.camera.up.copy(up); this.target.set(0, 0, 0); this.camera.lookAt(0, 0, 0); this.camera.updateMatrixWorld(); this.dirty = true; }
  }
  private animateTo(to: THREE.Vector3, target: THREE.Vector3, up?: THREE.Vector3): void {
    this.anim = { from: this.camera.position.clone(), to, tf: this.target.clone(), tt: target, t0: performance.now(), uf: this.camera.up.clone(), ut: up ?? this.camera.up.clone() };
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
  /** For tests: a scene point's client position, and a part's centre. */
  project(p: [number, number, number]): [number, number] { const v = new THREE.Vector3(...p).project(this.camera), r = this.canvas.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; }
  partCentre(i: number): [number, number, number] | null { const e = this.partByIndex.get(i); if (!e) return null; const c = e.box.getCenter(new THREE.Vector3()); return [c.x, c.y, c.z]; }
  /** Screen position (client px) of a pin's land on its face — for tests. */
  screenOfPin(part: number, pin: number): [number, number] | null {
    const pad = this.model?.pinPads(part)[pin]; if (!pad) return null;
    const side = pad.side === 'bottom' ? -1 : 1, v = new THREE.Vector3(pad.x, side * (TOP + 0.01), pad.z).project(this.camera), r = this.canvas.getBoundingClientRect();
    return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
  }
  /** Camera distance and target, for tests. */
  cameraState(): { dist: number; target: [number, number, number]; pos: [number, number, number]; leftDrag: 'orbit' | 'pan'; roll: number } {
    const t = this.target, c = this.camera.position, right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    return { dist: c.distanceTo(t), target: [t.x, t.y, t.z], pos: [c.x, c.y, c.z], leftDrag: this.leftDrag, roll: right.y };
  }

  /** Draw calls, triangles and buffers of the last frame, and the build time. */
  stats() {
    const i = this.renderer.info;
    let verts = 0; this.partsRoot.traverse(o => { if (o instanceof THREE.Mesh) verts += o.geometry.attributes.position.count; });
    return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, partVertices: verts, buildMs: this.buildMs };
  }
  /** Frames actually delivered during a continuous `ms`-long orbit, paced by
   *  requestAnimationFrame like real use (no read-back stalls). */
  fps(ms = 2000, pixelRatio?: number): Promise<{ fps: number; worstMs: number }> {
    const prevPr = this.renderer.getPixelRatio(); if (pixelRatio) { this.renderer.setPixelRatio(pixelRatio); this.resize(); }
    const r = this.camera.position.length(), t0 = performance.now(); let n = 0, last = t0, worst = 0;
    return new Promise(res => {
      const step = () => {
        const now = performance.now(); worst = Math.max(worst, now - last); last = now;
        if (now - t0 > ms) { if (pixelRatio) { this.renderer.setPixelRatio(prevPr); this.resize(); } this.dirty = true; res({ fps: Math.round(n * 1000 / (now - t0)), worstMs: Math.round(worst) }); return; }
        const a = (now - t0) / ms * Math.PI * 2; this.camera.position.set(Math.cos(a) * r * 0.8, r * 0.55, Math.sin(a) * r * 0.8); this.camera.lookAt(this.target);
        this.renderer.render(this.scene, this.camera); n++; requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }
  /** Orbit `frames` frames and time each one to completion (a 1-px read-back
   *  waits for the GPU). Median and p90 in ms. For measurement, not for the UI. */
  bench(frames = 60, pixelRatio?: number) {
    const prevPr = this.renderer.getPixelRatio(); if (pixelRatio) { this.renderer.setPixelRatio(pixelRatio); this.resize(); }
    const gl = this.renderer.getContext(), px = new Uint8Array(4), t: number[] = [];
    const r = this.camera.position.length(), base = Math.atan2(this.camera.position.z, this.camera.position.x);
    for (let k = 0; k < frames; k++) {
      const a = base + k * 2 * Math.PI / frames; this.camera.position.set(Math.cos(a) * r * 0.8, r * 0.55, Math.sin(a) * r * 0.8); this.camera.lookAt(this.target);
      const t0 = performance.now(); this.renderer.render(this.scene, this.camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); t.push(performance.now() - t0);
    }
    t.sort((x, y) => x - y); this.dirty = true;
    if (pixelRatio) { this.renderer.setPixelRatio(prevPr); this.resize(); }
    return { median: +t[t.length >> 1].toFixed(2), p90: +t[Math.floor(t.length * 0.9)].toFixed(2), ...this.stats() };
  }

  // ───────────── loop ─────────────
  private resize(): void {
    // (also called on a resolution switch: setPixelRatio needs a setSize to take effect)
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.dirty = true;
    if (this.labelMat) this.labelMat.uniforms.viewportH.value = this.renderer.domElement.height;
    for (const lm of this.lineMats ?? []) lm.resolution.set(this.renderer.domElement.width, this.renderer.domElement.height);
  }
  private tick(): void {
    if (this.anim) {
      const k = Math.min(1, (performance.now() - this.anim.t0) / 450), e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(this.anim.from, this.anim.to, e); this.target.lerpVectors(this.anim.tf, this.anim.tt, e);
      this.camera.up.lerpVectors(this.anim.uf, this.anim.ut, e).normalize(); this.camera.lookAt(this.target); this.camera.updateMatrixWorld();
      if (k >= 1) { this.anim = null; this.movingUntil = performance.now() + 180; } this.dirty = true;
    }
    const now = performance.now(), moving = this.anim !== null || now < this.movingUntil;
    const pr = moving ? Math.min(1, this.fullPr) : this.fullPr;
    if (pr !== this.renderer.getPixelRatio()) { this.renderer.setPixelRatio(pr); this.resize(); }
    if (!this.dirty) return;
    this.dirty = false;
    this.updateXray();
    const fromAbove = this.camera.position.y >= this.target.y;
    for (const mk of this.markers) mk.visible = (mk.userData.face === 'top') === fromAbove;
    this.renderer.render(this.scene, this.camera);
  }
  dispose(): void {
    this.disposed = true; cancelAnimationFrame(this.raf); this.canvas.removeEventListener('wheel', this.onWheel, { capture: true }); this.ro.disconnect();
    for (const [ev, fn] of [['pointerdown', this.onPointerDown], ['pointermove', this.onPointerMove], ['pointerup', this.onPointerUp], ['pointercancel', this.onPointerUp], ['contextmenu', this.onContextMenu]] as const) this.canvas.removeEventListener(ev, fn as EventListener);
    for (const root of [this.boardRoot, this.partsRoot, this.pickRoot, this.hlRoot, this.labelRoot]) disposeTree(root);
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.canvas.remove();
  }
}

/** Round sprites for constant-size markers (a dot for net lands, a ring for the picked pin). */
function markerTexture(kind: 'dot' | 'ring'): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(0,0,0,0.85)'; g.fillStyle = '#fff';
  if (kind === 'dot') { g.beginPath(); g.arc(32, 32, 24, 0, Math.PI * 2); g.fill(); g.lineWidth = 6; g.stroke(); }
  else { g.lineWidth = 16; g.beginPath(); g.arc(32, 32, 22, 0, Math.PI * 2); g.stroke(); g.strokeStyle = '#fff'; g.lineWidth = 9; g.stroke(); }
  return new THREE.CanvasTexture(c);
}
/** Selection colours, chosen far from anything a board has. */
const SEL = { net: 0xff2bd6, pin: 0x00e5ff, part: 0xa66bff };

function disposeTree(root: THREE.Object3D): void {
  root.traverse(o => {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Points) {
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { (m as THREE.MeshStandardMaterial).map?.dispose(); if (m instanceof THREE.ShaderMaterial) (m.uniforms.map?.value as THREE.Texture | undefined)?.dispose(); if (!SHARED.has(m)) m.dispose(); }
    }
  });
  root.clear();
}
// part-model materials are module-wide and shared between views: never dispose them
const SHARED = new Set<THREE.Material>(Object.values(MAT));
