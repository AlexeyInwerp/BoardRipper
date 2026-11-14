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
import type { Board3DModel, Board3DPad, Board3DPart } from './board3d-model';
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
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // the key light is fixed to the board and only the camera moves: draw the shadow map once per board
    this.renderer.shadowMap.autoUpdate = false;
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
    this.controls.zoomToCursor = true; // the wheel zooms towards the point under the pointer, as in 2D
    this.controls.addEventListener('change', () => { this.dirty = true; this.movingUntil = performance.now() + 180; });
    // capture phase, ahead of OrbitControls' own wheel listener on the canvas
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
    for (const root of [this.boardRoot, this.partsRoot, this.pickRoot, this.hlRoot]) disposeTree(root);
    this.pickBoxes = []; this.partByIndex.clear();
    this.buildBoard(model);
    this.buildParts(model);
    this.buildPickGrids(model);
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
    const slab = new THREE.Mesh(slabGeo, [new THREE.MeshStandardMaterial({ color: 0x0f1a13, roughness: 0.45 }), new THREE.MeshStandardMaterial({ color: 0x8a7d5c, roughness: 0.85 })]);
    slab.castShadow = slab.receiveShadow = true; this.boardRoot.add(slab);
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
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy()); // 16× costs at grazing angles over a whole board face
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
    const groups = new Map<THREE.Material, THREE.BufferGeometry[]>(), flat = new Map<THREE.Material, THREE.BufferGeometry[]>();
    tmp.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return;
      const g = o.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      g.applyMatrix4(o.matrixWorld);
      // mergeGeometries needs all-indexed or all-non-indexed: one bucket each per material
      const key = o.material as THREE.Material; const bucket = g.index ? groups : flat;
      let list = bucket.get(key); if (!list) bucket.set(key, (list = [])); list.push(g);
    });
    for (const [mat, list] of [...groups, ...flat]) {
      const merged = mergeGeometries(list); list.forEach(g => g.dispose()); if (!merged) continue;
      // parts cast onto the board; they do not receive (a shadow lookup per part pixel for little to see)
      const mesh = new THREE.Mesh(merged, mat); mesh.castShadow = true; this.partsRoot.add(mesh);
    }
    this.dirty = true;
  }

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
    const fromAbove = this.camera.position.y >= this.controls.target.y;
    const side: 'top' | 'bottom' = fromAbove ? 'top' : 'bottom';
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), fromAbove ? -TOP : TOP), onFace = new THREE.Vector3();
    const faceHit = this.ray.ray.intersectPlane(plane, onFace);
    const hit = this.ray.intersectObjects(this.pickBoxes, false)[0];
    if (hit) {
      // a click on the body over one of the part's own lands picks that pin (end caps, gull-wing feet)
      const index = hit.object.userData.index as number, pads = m.pinPads(index);
      for (const pt of [hit.point, faceHit ? onFace : null]) {
        if (!pt) continue;
        const pin = pads.findIndex(p => p && Board3DRenderer.inPad(p, pt.x, pt.z, 0.05));
        if (pin >= 0 && pads.filter(Boolean).length > 1) return { part: index, pin, net: null };
      }
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
  setSelection(partIndex: number | null, net: string | null, pinIndex: number | null = null): void {
    disposeTree(this.hlRoot);
    const m = this.model; if (!m) return;
    if (net) this.hlRoot.add(this.netPads(m, net, partIndex, pinIndex));
    if (net) {
      const lit = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.45, depthWrite: false });
      for (const [index, { box }] of this.partByIndex) {
        const pins = m.pinsOf(index).filter(q => q.net === net); if (!pins.length) continue;
        const s = box.getSize(new THREE.Vector3()).addScalar(0.15), b = new THREE.Mesh(new THREE.BoxGeometry(s.x, s.y, s.z), lit); b.position.copy(box.getCenter(new THREE.Vector3())); b.renderOrder = 5; this.hlRoot.add(b);
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
    for (const [list, color] of [[lit, 0xffd23f], [hot, 0xffffff]] as const) {
      if (!list.length) continue; const merged = mergeGeometries(list.map(x => x.index ? x.toNonIndexed() : x)); list.forEach(x => x.dispose()); if (!merged) continue;
      const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ color, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })); mesh.renderOrder = 4; g.add(mesh);
    }
    return g;
  }

  /** Centre the camera on a part without changing the viewing angle. */
  focusPart(partIndex: number): void {
    const e = this.partByIndex.get(partIndex); if (!e) return;
    const c = e.box.getCenter(new THREE.Vector3()), d = this.camera.position.clone().sub(this.controls.target);
    const dist = Math.min(d.length(), Math.max(15, e.box.getSize(new THREE.Vector3()).length() * 6));
    this.animateTo(c.clone().add(d.setLength(dist)), c);
  }

  // ───────────── camera ─────────────
  /** Move the camera towards (factor < 1) or away from (> 1) its target. */
  zoomBy(factor: number): void {
    const d = this.camera.position.clone().sub(this.controls.target), len = d.length() * factor;
    const m = this.model, max = m ? Math.max(m.width, m.height) * 8 : 2000;
    this.animateTo(this.controls.target.clone().add(d.setLength(Math.min(max, Math.max(2, len)))), this.controls.target.clone());
  }
  /** Pan by screen pixels (+x right, +y down), the board following the pointer. */
  panBy(dx: number, dy: number, animate = false): void {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const perPx = 2 * dist * Math.tan(this.camera.fov * Math.PI / 360) / Math.max(1, this.canvas.clientHeight);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0), up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const move = right.multiplyScalar(-dx * perPx).add(up.multiplyScalar(dy * perPx));
    if (animate) this.animateTo(this.camera.position.clone().add(move), this.controls.target.clone().add(move));
    else { this.camera.position.add(move); this.controls.target.add(move); this.dirty = true; this.movingUntil = performance.now() + 180; }
  }
  /** Whole board in view, keeping the current viewing angle. */
  fit(): void {
    const m = this.model; if (!m) return;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const span = Math.max(m.height, m.width / this.camera.aspect) * 1.2, dist = span / (2 * Math.tan(this.camera.fov * Math.PI / 360));
    this.animateTo(dir.multiplyScalar(dist), new THREE.Vector3());
  }
  /** What a plain left-drag does: orbit (default) or pan. */
  setLeftDrag(mode: 'orbit' | 'pan'): void {
    this.controls.mouseButtons.LEFT = mode === 'pan' ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    this.controls.mouseButtons.RIGHT = mode === 'pan' ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    this.controls.touches.ONE = mode === 'pan' ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
  }
  /** Bare wheel / two-finger scroll pans when the app's scroll binding says pan; pinch (ctrlKey) always zooms. */
  setWheelPans(pan: boolean): void { this.wheelPans = pan; }
  private wheelPans = false;
  private onWheel = (e: WheelEvent) => {
    if (!this.wheelPans || e.ctrlKey || e.metaKey) return; // OrbitControls zooms
    e.preventDefault(); e.stopImmediatePropagation();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.clientHeight : 1;
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
  /** Screen position (client px) of a pin's land on its face — for tests. */
  screenOfPin(part: number, pin: number): [number, number] | null {
    const pad = this.model?.pinPads(part)[pin]; if (!pad) return null;
    const side = pad.side === 'bottom' ? -1 : 1, v = new THREE.Vector3(pad.x, side * (TOP + 0.01), pad.z).project(this.camera), r = this.canvas.getBoundingClientRect();
    return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
  }
  /** Camera distance and target, for tests. */
  cameraState(): { dist: number; target: [number, number, number]; leftDrag: 'orbit' | 'pan' } {
    const t = this.controls.target; return { dist: this.camera.position.distanceTo(t), target: [t.x, t.y, t.z], leftDrag: this.controls.mouseButtons.LEFT === THREE.MOUSE.PAN ? 'pan' : 'orbit' };
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
        const a = (now - t0) / ms * Math.PI * 2; this.camera.position.set(Math.cos(a) * r * 0.8, r * 0.55, Math.sin(a) * r * 0.8); this.camera.lookAt(this.controls.target);
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
      const a = base + k * 2 * Math.PI / frames; this.camera.position.set(Math.cos(a) * r * 0.8, r * 0.55, Math.sin(a) * r * 0.8); this.camera.lookAt(this.controls.target);
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
  }
  private tick(): void {
    if (this.anim) {
      const k = Math.min(1, (performance.now() - this.anim.t0) / 450), e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(this.anim.from, this.anim.to, e); this.controls.target.lerpVectors(this.anim.tf, this.anim.tt, e);
      if (k >= 1) { this.anim = null; this.movingUntil = performance.now() + 180; } this.dirty = true;
    }
    this.controls.update();
    const now = performance.now(), moving = this.anim !== null || now < this.movingUntil;
    const pr = moving ? Math.min(1, this.fullPr) : this.fullPr;
    if (pr !== this.renderer.getPixelRatio()) { this.renderer.setPixelRatio(pr); this.resize(); }
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  }
  dispose(): void {
    this.disposed = true; cancelAnimationFrame(this.raf); this.canvas.removeEventListener('wheel', this.onWheel, { capture: true }); this.ro.disconnect(); this.controls.dispose();
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
