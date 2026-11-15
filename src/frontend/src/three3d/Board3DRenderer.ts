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
import { SEL_COLOURS, DEFAULT_VIEW3D_SETTINGS, QUALITY_PRESETS, type View3DSettings } from '../store/view3d-store';
import type { GhostMode, NetLineMode } from '../store/board-store';
import { renderSettingsStore, isGroundNet } from '../store/render-settings';

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
  // Two render targets, allocated once per size, both blitted to the canvas with one quad: while the
  // camera moves, a 1× target with no multisampling (a moving frame costs what 1× costs); when it
  // settles, a full-resolution 4× multisampled target, drawn once. The first cut switched the canvas's
  // own pixel ratio instead, and the buffer reallocation cost 40–70 ms at the start and end of every
  // drag — the stutter felt as "degraded after the resolution fix".
  private fullPr = 1;
  private movingUntil = 0;
  private lowRT: THREE.WebGLRenderTarget | null = null;
  private fullRT: THREE.WebGLRenderTarget | null = null;
  private blitScene = new THREE.Scene();
  private blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private blitMat = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false });
  private lowCfg = { samples: 4, half: false, scale: 1 };
  /** Measurement hook: the moving target's samples, format and scale (fraction of 1×); reallocates it. */
  private fullCfg = { samples: 4, half: false };
  setFullTarget(cfg: Partial<{ samples: number; half: boolean }>): void { this.fullCfg = { ...this.fullCfg, ...cfg }; this.fullRT?.dispose(); this.fullRT = null; this.resize(); this.warmLowPass(); }
  setLowTarget(cfg: Partial<{ samples: number; half: boolean; scale: number }>): void { this.lowCfg = { ...this.lowCfg, ...cfg }; this.lowRT?.dispose(); this.lowRT = null; this.resize(); this.warmLowPass(); }
  /** A measurement's pixel ratio: the loop leaves it alone until the measurement ends. */
  private benchPr: number | null = null;

  private settings: View3DSettings = DEFAULT_VIEW3D_SETTINGS;
  private netLineMode: NetLineMode = 'off';
  private ghostMode: GhostMode = 'off';
  /** The ribbon's dim button (shared with 2D): the lights go down while a net is lit unless it is off. */
  private dimMode: 'off' | 'dim' | 'darklight' = 'dim';
  setDimMode(mode: 'off' | 'dim' | 'darklight'): void { if (mode === this.dimMode) return; this.dimMode = mode; this.setSelection(this.sel.part, this.sel.net, this.sel.pin); }
  private sel: { part: number | null; net: string | null; pin: number | null } = { part: null, net: null, pin: null };
  private host: HTMLElement;
  constructor(host: HTMLElement) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'board-3d-canvas';
    host.appendChild(this.canvas);
    // No multisampling on the canvas: a multisampled canvas resolves the whole window every frame,
    // even for a one-quad blit — 8 ms at 2× on an M1, the fixed cost that made moving frames no
    // cheaper than settled ones. Antialiasing happens in the settled frame's own target instead.
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false });
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
    this.key = key; this.under = under; this.hemi = this.scene.children.find(o => o instanceof THREE.HemisphereLight) as THREE.HemisphereLight;
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
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMat); quad.frustumCulled = false; this.blitScene.add(quad);
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host);
    this.resize();
    const loop = () => { if (this.disposed) return; this.raf = requestAnimationFrame(loop); this.tick(); };
    this.raf = requestAnimationFrame(loop);
  }
  private key: THREE.DirectionalLight;
  private under: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;

  /** Visual settings (global, from view3dStore). Anything that changes the built scene rebuilds the
   *  part it touches; colours and sizes redraw the selection only. */
  applySettings(s: View3DSettings): void {
    const prev = this.settings; this.settings = s;
    this.labelRoot.visible = s.partNames || s.netNames;
    if (prev.quality !== s.quality) {
      const q = QUALITY_PRESETS[s.quality];
      this.fullPr = Math.min(devicePixelRatio, q.settledPr); this.renderer.setPixelRatio(this.fullPr);
      this.lowCfg = { samples: q.movingSamples, half: false, scale: q.movingScale }; this.fullCfg = { samples: q.settledSamples, half: false };
      this.lowRT?.dispose(); this.lowRT = null; this.fullRT?.dispose(); this.fullRT = null;
      this.resize(); if (this.model) this.warmLowPass();
    }
    const shadows = s.shadows && QUALITY_PRESETS[s.quality].shadows;
    if (this.model && (prev.partNames !== s.partNames || prev.netNames !== s.netNames)) this.buildLabels(this.model);
    if (shadows !== this.renderer.shadowMap.enabled) {
      // a shadow-map switch changes every receiving material's shader: ask them to recompile
      this.renderer.shadowMap.enabled = shadows; this.key.castShadow = shadows; this.renderer.shadowMap.needsUpdate = true;
      this.boardRoot.traverse(o => { if (o instanceof THREE.Mesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true; });
    }
    this.dirty = true; // updateXray runs before the next render and resets any fade when see-through is off
    this.setSelection(this.sel.part, this.sel.net, this.sel.pin);
  }
  /** The ribbon's net-lines mode (shared with 2D): off / star / chain / chain-adjacent. */
  setNetLineMode(mode: NetLineMode): void { if (mode === this.netLineMode) return; this.netLineMode = mode; this.setSelection(this.sel.part, this.sel.net, this.sel.pin); }
  /** The ribbon's hidden-side ghosts (shared with 2D): parts on the lit net on the face the camera does not see. */
  setGhostMode(mode: GhostMode): void { if (mode === this.ghostMode) return; this.ghostMode = mode; this.setSelection(this.sel.part, this.sel.net, this.sel.pin); }
  private colour(k: 'netColour' | 'pinColour' | 'partColour'): number { return SEL_COLOURS[this.settings[k]]; }

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
    this.applySettings(this.settings);
    this.warmLowPass();
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
    // solder mask is semi-matt: a broad, dull highlight, not a mirror — roughness 0.8 and a quarter of the room light
    const slab = new THREE.Mesh(slabGeo, [new THREE.MeshStandardMaterial({ color: 0x09130d, roughness: 0.8, envMapIntensity: 0.25 }), new THREE.MeshStandardMaterial({ color: 0x6e6448, roughness: 0.95, envMapIntensity: 0.1 })]);
    // the slab must not shadow its own face: that was the speckle (shadow acne) over the whole board
    slab.receiveShadow = true; this.boardRoot.add(slab);
    const faceGeo = new THREE.ShapeGeometry(shapes, 16); faceGeo.rotateX(-Math.PI / 2);
    for (const side of ['top', 'bottom'] as const) {
      const mat = new THREE.MeshStandardMaterial({ map: this.faceTexture(m, side), roughness: 0.8, envMapIntensity: 0.25, side: side === 'top' ? THREE.FrontSide : THREE.BackSide, polygonOffset: true, polygonOffsetFactor: -1 });
      const face = new THREE.Mesh(faceGeo, mat); face.position.y = side === 'top' ? TOP + 0.002 : -TOP - 0.002; face.receiveShadow = true; this.boardRoot.add(face);
      this.boardRoot.add(this.padMesh(m, side));
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
    for (const pt of m.parts) if (pt.est.family === 'hole') { const [x, z] = m.toScene({ x: pt.est.cx, y: pt.est.cy }); c.beginPath(); c.ellipse(U(x), V(z), pt.est.L * ppm / 2, pt.est.W * ppm / 2, 0, 0, Math.PI * 2); c.fill(); }
    c.strokeStyle = '#ecebe4'; c.lineWidth = Math.max(1, 0.14 * ppm); c.lineJoin = 'round';
    for (const s of m.silk) if (s.side === side) { c.beginPath(); s.pts.forEach(([x, z], i) => (i ? c.lineTo(U(x), V(z)) : c.moveTo(U(x), V(z)))); c.stroke(); }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy()); // 16× costs at grazing angles over a whole board face
    // ShapeGeometry UVs are the shape's (x, −z) in mm
    tex.repeat.set(1 / m.width, 1 / m.height); tex.offset.set(0.5, 0.5);
    return tex;
  }

  /** The lands as geometry, 8 µm off the face: a texture capped at 8192 px gives a 0.2 mm land eight
   *  pixels and it blurs close up; a quad or a 16-gon stays sharp at any zoom. One mesh per face. */
  private padMesh(m: Board3DModel, side: 'top' | 'bottom'): THREE.Mesh {
    const geos: THREE.BufferGeometry[] = [];
    for (const p of m.pads) {
      if (p.side !== side && p.side !== 'both') continue;
      const g = p.round || p.drill > 0 ? new THREE.CircleGeometry(Math.max(p.w, p.h) / 2, 16) : new THREE.PlaneGeometry(p.w, p.h);
      g.rotateX(side === 'top' ? -Math.PI / 2 : Math.PI / 2); g.rotateY(p.angle * Math.PI / 180); g.translate(p.x, side === 'top' ? TOP + 0.008 : -TOP - 0.008, p.z);
      geos.push(g.index ? g.toNonIndexed() : g);
    }
    const merged = geos.length ? mergeGeometries(geos) : new THREE.BufferGeometry(); geos.forEach(g => g.dispose());
    const mesh = new THREE.Mesh(merged, PAD_MAT); mesh.receiveShadow = true; return mesh;
  }

  /** Large bodies that stand over their own pins (BGAs, QFNs, connectors…) are kept as their own
   *  meshes with their own materials, so they can turn see-through when zoomed into or selected. */
  private static seeThrough(e: Board3DPart['est']): boolean {
    const area = e.L * e.W;
    return area >= 12 || (area >= 4 && ['bga', 'qfn', 'son', 'b2b', 'conn', 'usb-c', 'soic'].includes(e.family));
  }
  /** See-through parts share one mesh per material with everything else that fades; each part owns a
   *  vertex range whose `aOpacity` the shader multiplies in. Fading a part writes a few floats — the
   *  first cut gave every such part its own mesh and materials, which was 872 draw calls on a 6k-part board. */
  private xray: { index: number; ranges: { mesh: THREE.Mesh; start: number; count: number }[]; centre: THREE.Vector3; radius: number; opacity: number }[] = [];

  private buildParts(m: Board3DModel): void {
    const shared = new THREE.Group();
    const pickMat = new THREE.MeshBasicMaterial();
    this.xray = [];
    const fading: { index: number; holder: THREE.Group; centre: THREE.Vector3; radius: number }[] = [];
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
      if (Board3DRenderer.seeThrough(e)) fading.push({ index: part.index, holder, centre: bb.getCenter(new THREE.Vector3()), radius: size.length() / 2 });
      else shared.add(holder);
    }
    Board3DRenderer.mergeByMaterial([shared], this.partsRoot, mat => mat);
    this.buildFadingParts(fading);
    this.dirty = true;
  }
  /** The see-through parts: merged per material like the rest, but with an `aOpacity` vertex
   *  attribute and a material patched to multiply it in; each part keeps its vertex ranges. */
  private buildFadingParts(parts: { index: number; holder: THREE.Group; centre: THREE.Vector3; radius: number }[]): void {
    type Bucket = { mat: THREE.Material; indexed: boolean; geos: THREE.BufferGeometry[]; owners: { index: number; count: number }[] };
    const buckets = new Map<string, Bucket>();
    for (const p of parts) {
      p.holder.updateMatrixWorld(true);
      p.holder.traverse(o => {
        if (!(o instanceof THREE.Mesh)) return;
        const g = o.geometry.clone();
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
        g.applyMatrix4(o.matrixWorld);
        const mat = o.material as THREE.Material, key = mat.uuid + (g.index ? 'i' : 'f');
        let b = buckets.get(key); if (!b) buckets.set(key, (b = { mat, indexed: !!g.index, geos: [], owners: [] }));
        b.geos.push(g); b.owners.push({ index: p.index, count: g.attributes.position.count });
      });
    }
    const byIndex = new Map(parts.map(p => [p.index, { index: p.index, ranges: [] as { mesh: THREE.Mesh; start: number; count: number }[], centre: p.centre, radius: p.radius, opacity: 1 }]));
    for (const b of buckets.values()) {
      const merged = mergeGeometries(b.geos); b.geos.forEach(g => g.dispose()); if (!merged) continue;
      const n = merged.attributes.position.count, op = new THREE.Float32BufferAttribute(new Float32Array(n).fill(1), 1); op.setUsage(THREE.DynamicDrawUsage);
      merged.setAttribute('aOpacity', op);
      // alpha-to-coverage, not blending: the fade dithers through the MSAA samples and the bodies stay on the
      // opaque pipeline — blending them cost a third of the frame at 2× (they are the biggest surfaces on the board)
      const mat = (b.mat as THREE.MeshStandardMaterial).clone(); mat.alphaToCoverage = true;
      mat.onBeforeCompile = sh => {
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aOpacity; varying float vOpacity;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvOpacity = aOpacity;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vOpacity;').replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vOpacity;');
      };
      mat.customProgramCacheKey = () => 'fade';
      const mesh = new THREE.Mesh(merged, mat); mesh.castShadow = true; this.partsRoot.add(mesh);
      let start = 0; for (const o of b.owners) { byIndex.get(o.index)!.ranges.push({ mesh, start, count: o.count }); start += o.count; }
    }
    this.xray = [...byIndex.values()];
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
    const focal = 1 / Math.tan(this.camera.fov * Math.PI / 360), touched = new Set<THREE.Mesh>();
    for (const x of this.xray) {
      const dist = Math.max(0.1, this.camera.position.distanceTo(x.centre)), frac = x.radius / dist * focal; // share of the half-height
      // fades only when the camera comes closer than ~2× the part's own size (a big SoC must stay solid at a normal look)
      let op = this.settings.seeThrough ? 1 - 0.78 * THREE.MathUtils.smoothstep(frac, 1.6, 3.0) : 1;
      if (x.index === this.selectedPart && this.selectedPin !== null) op = Math.min(op, 0.35);
      if (Math.abs(op - x.opacity) < 0.01) continue;
      x.opacity = op;
      for (const r of x.ranges) { const a = r.mesh.geometry.attributes.aOpacity as THREE.BufferAttribute; (a.array as Float32Array).fill(op, r.start, r.start + r.count); touched.add(r.mesh); }
    }
    for (const mesh of touched) (mesh.geometry.attributes.aOpacity as THREE.BufferAttribute).needsUpdate = true;
  }
  private xrayOpacity(index: number): number { return this.xray.find(x => x.index === index)?.opacity ?? 1; }
  private selectedPin: number | null = null;

  /** Every drawn part's name on its outer face along its long axis, and — close up — every land's
   *  net name on the land, in the net's own tint. One atlas, one mesh, one draw call. */
  private buildLabels(m: Board3DModel): void {
    disposeTree(this.labelRoot); this.labelMat = null;
    const specs: LabelSpec[] = [];
    if (this.settings.partNames) for (const [, { part, box }] of this.partByIndex) {
      const e = part.est, bottom = part.side === 'bottom', c = box.getCenter(new THREE.Vector3());
      const long = Math.max(e.L, e.W), short = Math.min(e.L, e.W);
      // on the body's top, not on whatever sticks up from it (header pins)
      const topY = Math.min(bottom ? -box.min.y : box.max.y, TOP + e.H + 0.05) + 0.012;
      specs.push({ text: part.name, x: c.x, y: bottom ? -topY : topY, z: c.z, height: Math.min(short * 0.45, 1.0), maxLength: long * 0.85, angleDeg: e.L >= e.W ? e.rotDeg : e.rotDeg + 90, side: part.side });
    }
    if (this.settings.netNames) for (const pt of m.parts) {
      const pins = m.pinsOf(pt.index), pads = m.pinPads(pt.index);
      pins.forEach((q, i) => {
        const pad = pads[i]; if (!pad || !q.net) return;
        const long = Math.max(pad.w, pad.h), short = Math.min(pad.w, pad.h);
        if (short < 0.12) return;
        for (const side of pad.side === 'both' ? (['top', 'bottom'] as const) : [q.side]) {
          // along the land's long axis; `angle` is the land's own turn (CCW, board frame)
          specs.push({ text: q.net, x: pad.x, y: side === 'top' ? TOP + 0.02 : -TOP - 0.02, z: pad.z, height: Math.min(short * 0.7, 0.5), maxLength: long * 0.95, angleDeg: pad.w >= pad.h ? pad.angle : pad.angle + 90, side, colour: 0xbfe9ff, showAtPx: 12 });
        }
      });
    }
    const mesh = buildLabelMesh(specs); if (!mesh) return;
    this.labelMat = mesh.material as THREE.ShaderMaterial; this.labelMat.uniforms.viewportH.value = this.renderer.domElement.height;
    this.labelRoot.add(mesh);
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
   *   - the picked pin: its land in the pin colour, with a small ring of constant screen size that
   *     shows through any body above it — small, so it covers nothing and competes with no name;
   *   - the net: every land on it in the net colour, every part on it outlined; lands hidden under
   *     a body get a dot that shows through (not on huge nets like GND); net lines per the ribbon's mode;
   *   - the selected part: a thick outline and a faint veil; see-through once a pin of it is picked.
   *  With "dim the rest" on, the lights go down while a net is lit, and these (unlit) stay bright. */
  setSelection(partIndex: number | null, net: string | null, pinIndex: number | null = null): void {
    this.selectedPart = partIndex; this.selectedPin = pinIndex; this.sel = { part: partIndex, net, pin: pinIndex };
    disposeTree(this.hlRoot); this.lineMats = []; this.markers = [];
    const m = this.model; if (!m) return;
    const NET = this.colour('netColour'), PIN = this.colour('pinColour'), PART = this.colour('partColour'), px = this.settings.outlinePx;
    if (net) {
      this.hlRoot.add(this.netPads(m, net, partIndex, pinIndex, NET, PIN));
      for (const [index, { box }] of this.partByIndex) {
        if (index === partIndex || !m.pinsOf(index).some(q => q.net === net)) continue;
        this.hlRoot.add(this.thickBox(box, 0.12, NET, px));
      }
      this.hlRoot.add(this.netMarkers(m, net, partIndex, pinIndex, NET));
      this.hlRoot.add(this.netLines(m, net, partIndex, pinIndex, NET, px));
      this.hlRoot.add(this.ghosts(m, net, px));
    }
    if (partIndex !== null) {
      const e = this.partByIndex.get(partIndex);
      const box = e?.box ?? (() => { const pins = m.pinsOf(partIndex); if (!pins.length) return null; const b = new THREE.Box3(); for (const q of pins) b.expandByPoint(new THREE.Vector3(q.x, q.side === 'top' ? TOP : -TOP, q.z)); return b.expandByScalar(0.3); })();
      if (box) {
        this.hlRoot.add(this.thickBox(box, 0.25, PART, px + 1));
        if (pinIndex === null) { const sz = box.getSize(new THREE.Vector3()).addScalar(0.25), veil = new THREE.Mesh(new THREE.BoxGeometry(sz.x, Math.max(sz.y, 0.3), sz.z), new THREE.MeshBasicMaterial({ color: PART, transparent: true, opacity: 0.14, depthWrite: false })); veil.position.copy(box.getCenter(new THREE.Vector3())); veil.renderOrder = 5; this.hlRoot.add(veil); }
      }
      if (pinIndex !== null) { const pad = m.pinPads(partIndex)[pinIndex], q = m.pinsOf(partIndex)[pinIndex]; if (pad || q) this.hlRoot.add(this.pinRing(pad?.x ?? q.x, pad?.z ?? q.z, (pad?.side ?? q.side) === 'bottom', PIN)); }
    }
    // dim: lights down while a net is lit; the selection is unlit and keeps its colour
    const dim = net && this.dimMode !== 'off' ? 0.3 : 1;
    this.key.intensity = 1.3 * dim; this.under.intensity = 0.9 * dim; this.hemi.intensity = 0.45 * dim; this.scene.environmentIntensity = 0.4 * dim;
    if (this.labelMat) this.labelMat.uniforms.dim.value = dim === 1 ? 1 : 0.55;
    this.dirty = true;
  }

  /** Hidden-side ghosts: the lit net's parts on the face the camera does not see, drawn through the
   *  board as a translucent box and outline, so a net that crosses to the other side says where it goes
   *  without flipping the board. Ghost blue, as in 2D — never the net colour, so a ghost is never taken
   *  for a part on this face. Disco pulses them. Never on ground. */
  private ghostParts: THREE.Object3D[] = [];
  private ghosts(m: Board3DModel, net: string, px: number): THREE.Group {
    const colour = GHOST_BLUE;
    const g = new THREE.Group(); this.ghostParts = [];
    if (this.ghostMode === 'off' || isGround(net)) return g;
    for (const [index, { part, box }] of this.partByIndex) {
      if (!m.pinsOf(index).some(q => q.net === net)) continue;
      const sz = box.getSize(new THREE.Vector3()).addScalar(0.1), c = box.getCenter(new THREE.Vector3());
      const fill = new THREE.Mesh(new THREE.BoxGeometry(sz.x, Math.max(sz.y, 0.3), sz.z), new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false }));
      fill.position.copy(c); fill.renderOrder = 8;
      const lines = this.thickBox(box, 0.1, colour, Math.max(1, px - 1)); (lines.material as LineMaterial).depthTest = false; (lines.material as LineMaterial).transparent = true; (lines.material as LineMaterial).opacity = 0.7;
      const holder = new THREE.Group(); holder.add(fill, lines); holder.userData.face = part.side; g.add(holder); this.ghostParts.push(holder);
    }
    return g;
  }

  /** Net lines for the lit net, in the ribbon's mode: star from the picked pin (or the selected part)
   *  to every other land on the net, or a nearest-neighbour chain through them. Chain-adjacent lights
   *  the adjacent nets too in 2D; here it chains like chain (the adjacent nets are the store's). Lands
   *  are joined centre to centre, lifted off the face, through bodies. Skipped on huge nets (GND). */
  private netLines(m: Board3DModel, net: string, partIndex: number | null, pinIndex: number | null, colour: number, px: number): THREE.Object3D {
    const g = new THREE.Group(); if (this.netLineMode === 'off' || isGround(net)) return g;
    type L = { x: number; y: number; z: number; part: number; pin: number };
    const lands: L[] = [];
    for (const pt of m.parts) { const pads = m.pinPads(pt.index); m.pinsOf(pt.index).forEach((q, i) => { if (q.net !== net) return; const pad = pads[i]; const top = (pad?.side ?? q.side) !== 'bottom'; lands.push({ x: pad?.x ?? q.x, y: top ? TOP + 0.25 : -TOP - 0.25, z: pad?.z ?? q.z, part: pt.index, pin: i }); }); }
    if (lands.length < 2 || lands.length > 400) return g;
    const segs: number[] = [];
    const push = (a: L, b: L) => segs.push(a.x, a.y, a.z, b.x, b.y, b.z);
    const anchor = pinIndex !== null ? lands.find(l => l.part === partIndex && l.pin === pinIndex) : partIndex !== null ? lands.find(l => l.part === partIndex) : undefined;
    if (this.netLineMode === 'star' && anchor) { for (const l of lands) if (l !== anchor) push(anchor, l); }
    else { // nearest-neighbour chain (Prim), one land per part so a BGA's many balls make one stop
      const stops: L[] = []; const seen = new Set<number>(); for (const l of lands) if (!seen.has(l.part) || (l.part === partIndex && l.pin === pinIndex)) { seen.add(l.part); stops.push(l); }
      const inTree = anchor && stops.includes(anchor) ? [anchor] : [stops[0]], rest = new Set(stops.filter(l => l !== inTree[0]));
      while (rest.size) { let bi = inTree[0], bj: L | null = null, bd = Infinity; for (const a of inTree) for (const b of rest) { const d = (a.x - b.x) ** 2 + (a.z - b.z) ** 2; if (d < bd) { bd = d; bi = a; bj = b; } } if (!bj) break; rest.delete(bj); inTree.push(bj); push(bi, bj); }
    }
    if (!segs.length) return g;
    const geo = new LineSegmentsGeometry().setPositions(segs);
    const mat = new LineMaterial({ color: colour, linewidth: Math.max(1.5, px), worldUnits: false, transparent: true, opacity: 0.85, depthTest: false }); mat.resolution.set(this.renderer.domElement.width, this.renderer.domElement.height);
    this.lineMats.push(mat); const l = new LineSegments2(geo, mat); l.renderOrder = 9; g.add(l);
    return g;
  }

  /** The lands of every pin on `net`, lit on their face; the clicked pin's land brighter. */
  private netPads(m: Board3DModel, net: string, partIndex: number | null, pinIndex: number | null, netColour: number, pinColour: number): THREE.Group {
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
    for (const [list, color] of [[lit, netColour], [hot, pinColour]] as const) {
      if (!list.length) continue; const merged = mergeGeometries(list.map(x => x.index ? x.toNonIndexed() : x)); list.forEach(x => x.dispose()); if (!merged) continue;
      const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ color, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })); mesh.renderOrder = 4; g.add(mesh);
    }
    return g;
  }

  /** A small ring of constant screen size at the picked pin, drawn through whatever stands on it:
   *  findable from any distance, and small enough to cover nothing and compete with no name. */
  private pinRing(x: number, z: number, bottom: boolean, colour: number): THREE.Points {
    const pg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([x, bottom ? -TOP - 0.02 : TOP + 0.02, z], 3));
    const pts = new THREE.Points(pg, new THREE.PointsMaterial({ color: colour, size: this.settings.markerPx, sizeAttenuation: false, map: markerTexture('ring'), transparent: true, depthTest: false, alphaTest: 0.1 }));
    pts.renderOrder = 13; pts.userData.face = bottom ? 'bottom' : 'top'; this.markers.push(pts); return pts;
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
  private netMarkers(m: Board3DModel, net: string, partIndex: number | null, pinIndex: number | null, colour: number): THREE.Group {
    const g = new THREE.Group(), pts: { x: number; z: number; side: 'top' | 'bottom'; r: number }[] = [];
    for (const [index] of this.partByIndex) m.pinsOf(index).forEach((q, i) => { if (q.net === net && !(index === partIndex && i === pinIndex)) { const pad = m.pinPads(index)[i]; pts.push({ x: pad?.x ?? q.x, z: pad?.z ?? q.z, side: q.side, r: Math.max(0.12, Math.min(0.5, (pad ? Math.min(pad.w, pad.h) : q.r * 2) * 0.45)) }); } });
    if (!pts.length || pts.length > 300) return g;
    for (const side of ['top', 'bottom'] as const) {
      const on = pts.filter(p => p.side === side); if (!on.length) continue;
      const pg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(on.flatMap(p => [p.x, side === 'top' ? TOP + 0.03 : -TOP - 0.03, p.z]), 3));
      const mesh = new THREE.Points(pg, new THREE.PointsMaterial({ color: colour, size: Math.max(5, this.settings.markerPx * 0.55), sizeAttenuation: false, map: markerTexture('dot'), transparent: true, depthTest: false, alphaTest: 0.1 }));
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

  // ───────────── queries ─────────────
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
  /** What the selection drew, for tests: net-line segments, markers, outlines, lit lands. */
  selectionStats(): { netLineSegments: number; markers: number; outlines: number; litLands: number; ghosts: number; ghostsVisible: number } {
    let netLineSegments = 0, outlines = 0, litLands = 0;
    this.hlRoot.traverse(o => {
      if (o instanceof LineSegments2) { const n = (o.geometry.attributes.instanceStart?.count ?? 0); if (n === 12) outlines++; else netLineSegments += n; }
      else if (o instanceof THREE.Mesh && !(o instanceof LineSegments2) && o.renderOrder === 4) litLands += o.geometry.attributes.position.count / 6;
    });
    return { netLineSegments, markers: this.markers.length, outlines: outlines - this.ghostParts.length, litLands: Math.round(litLands), ghosts: this.ghostParts.length, ghostsVisible: this.ghostParts.filter(g => g.visible).length };
  }
  /** Camera distance and target, for tests. */
  cameraState(): { dist: number; target: [number, number, number]; pos: [number, number, number]; leftDrag: 'orbit' | 'pan'; roll: number } {
    const t = this.target, c = this.camera.position, right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    return { dist: c.distanceTo(t), target: [t.x, t.y, t.z], pos: [c.x, c.y, c.z], leftDrag: this.leftDrag, roll: right.y };
  }

  private lastScene = { calls: 0, triangles: 0 };
  /** Draw calls and triangles of the last scene pass (not the blit), buffers, and the build time. */
  stats() {
    const i = this.renderer.info;
    let verts = 0; this.partsRoot.traverse(o => { if (o instanceof THREE.Mesh) verts += o.geometry.attributes.position.count; });
    return { calls: this.lastScene.calls, triangles: this.lastScene.triangles, geometries: i.memory.geometries, textures: i.memory.textures, partVertices: verts, buildMs: this.buildMs };
  }
  /** Frames actually delivered during a continuous `ms`-long orbit, paced by
   *  requestAnimationFrame like real use (no read-back stalls). */
  fps(ms = 2000, pixelRatio?: number, viaLow = false): Promise<{ fps: number; worstMs: number }> {
    const prevPr = this.renderer.getPixelRatio(); if (pixelRatio) { this.benchPr = pixelRatio; this.renderer.setPixelRatio(pixelRatio); this.resize(); }
    const r = this.camera.position.length(), t0 = performance.now(); let n = 0, last = t0, worst = 0;
    return new Promise(res => {
      const step = () => {
        const now = performance.now(); worst = Math.max(worst, now - last); last = now;
        if (now - t0 > ms) { if (pixelRatio) { this.benchPr = null; this.renderer.setPixelRatio(prevPr); this.resize(); } this.dirty = true; res({ fps: Math.round(n * 1000 / (now - t0)), worstMs: Math.round(worst) }); return; }
        const a = (now - t0) / ms * Math.PI * 2; this.camera.position.set(Math.cos(a) * r * 0.8, r * 0.55, Math.sin(a) * r * 0.8); this.camera.lookAt(this.target);
        this.renderVia(viaLow && this.lowRT ? this.lowRT : this.fullRT);
        n++; requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }
  /** A real drag through the real loop: turns the camera a little every frame for `ms`, then lets it
   *  settle. Reports frame intervals during the drag and the longest interval around the stop (the
   *  full-resolution redraw plus whatever the switch costs). For measurement, not for the UI. */
  dragBench(ms = 2000): Promise<{ dragFps: number; dragWorstMs: number; settleMs: number; firstMoveMs: number }> {
    const t0 = performance.now(); let last = t0, worst = 0, n = 0, first = 0; const pivot = new THREE.Vector3();
    return new Promise(res => {
      const step = () => {
        const now = performance.now(); const dt = now - last; last = now;
        if (n === 1) first = dt; else if (n > 1) worst = Math.max(worst, dt);
        if (now - t0 > ms) {
          // stop: wait for the settle redraw, time the longest frame in the next 600 ms
          let sw = 0, sl = performance.now(); const t1 = sl;
          const tail = () => { const nw = performance.now(); sw = Math.max(sw, nw - sl); sl = nw; if (nw - t1 < 600) requestAnimationFrame(tail); else res({ dragFps: Math.round(n * 1000 / (now - t0)), dragWorstMs: Math.round(worst), settleMs: Math.round(sw), firstMoveMs: Math.round(first) }); };
          requestAnimationFrame(tail); return;
        }
        this.turnBy(3, 0, pivot); n++; requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }
  /** Orbit `frames` frames and time each one to completion (a 1-px read-back
   *  waits for the GPU). Median and p90 in ms. For measurement, not for the UI. */
  bench(frames = 60, pixelRatio?: number) {
    const prevPr = this.renderer.getPixelRatio(); if (pixelRatio) { this.benchPr = pixelRatio; this.renderer.setPixelRatio(pixelRatio); this.resize(); }
    const gl = this.renderer.getContext(), px = new Uint8Array(4), t: number[] = [];
    const r = this.camera.position.length(), base = Math.atan2(this.camera.position.z, this.camera.position.x);
    for (let k = 0; k < frames; k++) {
      const a = base + k * 2 * Math.PI / frames; this.camera.position.set(Math.cos(a) * r * 0.8, r * 0.55, Math.sin(a) * r * 0.8); this.camera.lookAt(this.target);
      const t0 = performance.now(); this.renderVia(this.fullRT); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); t.push(performance.now() - t0);
    }
    t.sort((x, y) => x - y); this.dirty = true;
    if (pixelRatio) { this.benchPr = null; this.renderer.setPixelRatio(prevPr); this.resize(); }
    return { median: +t[t.length >> 1].toFixed(2), p90: +t[Math.floor(t.length * 0.9)].toFixed(2), ...this.stats() };
  }

  // ───────────── loop ─────────────
  private resize(): void {
    // (also called on a resolution switch: setPixelRatio needs a setSize to take effect)
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.dirty = true;
    const lw = Math.max(1, Math.round(w * Math.min(1, this.fullPr) * this.lowCfg.scale)), lh = Math.max(1, Math.round(h * Math.min(1, this.fullPr) * this.lowCfg.scale));
    // a moving target only when it is smaller than the settled frame (a 1× display at scale 1 has no use for one)
    const wantLow = this.fullPr > 1.01 || this.lowCfg.scale < 0.99;
    if (!wantLow) { this.lowRT?.dispose(); this.lowRT = null; }
    else if (!this.lowRT || this.lowRT.width !== lw || this.lowRT.height !== lh) {
      this.lowRT?.dispose();
      this.lowRT = Board3DRenderer.target(lw, lh, this.lowCfg.samples, this.lowCfg.half);
    }
    const fw = this.renderer.domElement.width, fh = this.renderer.domElement.height;
    if (!this.fullRT || this.fullRT.width !== fw || this.fullRT.height !== fh) {
      this.fullRT?.dispose();
      this.fullRT = Board3DRenderer.target(fw, fh, this.fullCfg.samples, this.fullCfg.half);
    }
    this.setPixelUniforms(this.renderer.domElement.width, this.renderer.domElement.height);
  }
  /** Screen-pixel sizes the shaders need (label fade, line widths, marker sizes) for a given target size. */
  private pixelScale = 1;
  private setPixelUniforms(w: number, h: number): void {
    if (this.labelMat) this.labelMat.uniforms.viewportH.value = h;
    for (const lm of this.lineMats) lm.resolution.set(w, h);
    const scale = h / this.renderer.domElement.height; // 1 at full resolution, 0.5 in the moving target at 2×
    if (scale !== this.pixelScale) { for (const mk of this.markers) { const mat = (mk as THREE.Points).material as THREE.PointsMaterial; if (mat?.size !== undefined) mat.size = mat.size / this.pixelScale * scale; } this.pixelScale = scale; }
  }
  private tick(): void {
    if (this.anim) {
      const k = Math.min(1, (performance.now() - this.anim.t0) / 450), e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(this.anim.from, this.anim.to, e); this.target.lerpVectors(this.anim.tf, this.anim.tt, e);
      this.camera.up.lerpVectors(this.anim.uf, this.anim.ut, e).normalize(); this.camera.lookAt(this.target); this.camera.updateMatrixWorld();
      if (k >= 1) { this.anim = null; this.movingUntil = performance.now() + 180; } this.dirty = true;
    }
    const now = performance.now(), moving = this.benchPr === null && (this.anim !== null || now < this.movingUntil);
    // draw when something changed; and once more at full resolution when a move has ended
    if (!this.dirty && (moving || !this.settledLow)) return;
    this.dirty = false;
    this.updateXray();
    const fromAbove = this.camera.position.y >= this.target.y;
    for (const mk of this.markers) mk.visible = (mk.userData.face === 'top') === fromAbove;
    for (const gh of this.ghostParts) gh.visible = (gh.userData.face === 'top') !== fromAbove; // the face the camera does not see
    if (this.ghostMode === 'disco' && this.ghostParts.length) {
      const k = 0.55 + 0.45 * Math.sin(performance.now() / 180); // pulse
      for (const gh of this.ghostParts) gh.traverse(o => { const mat = (o as THREE.Mesh).material as THREE.Material | undefined; if (mat && 'opacity' in mat) mat.opacity = (o instanceof LineSegments2 ? 0.7 : 0.22) * k; });
      this.dirty = true;
    }
    if (moving && this.lowRT) { this.renderVia(this.lowRT); this.settledLow = true; }
    else { this.renderVia(this.fullRT); this.settledLow = false; }
  }
  /** An 8-bit target stores sRGB-encoded (SRGB8_ALPHA8: the GPU encodes on write and decodes on read),
   *  so the dark board does not band the way 8-bit linear would; half-float stays linear. 4× MSAA
   *  half-float at 6.4 MP was 30 ms a frame, 8-bit 21 ms, for the same picture. */
  private static target(w: number, h: number, samples: number, half: boolean): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(w, h, { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, samples, depthBuffer: true });
    if (!half) rt.texture.colorSpace = THREE.SRGBColorSpace;
    return rt;
  }
  /** One frame: the scene into `rt` (linear, no tone mapping — three applies those only on the
   *  canvas), then the target onto the canvas through one quad, which tone-maps and converts. */
  private renderVia(rt: THREE.WebGLRenderTarget | null): void {
    if (!rt) { this.setPixelUniforms(this.renderer.domElement.width, this.renderer.domElement.height); this.renderer.render(this.scene, this.camera); return; }
    this.setPixelUniforms(rt.width, rt.height);
    this.renderer.setRenderTarget(rt); this.renderer.render(this.scene, this.camera);
    this.lastScene = { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles }; // before the blit resets them
    this.renderer.setRenderTarget(null);
    if (this.blitMat.map !== rt.texture) { this.blitMat.map = rt.texture; this.blitMat.needsUpdate = true; }
    this.renderer.render(this.blitScene, this.blitCam);
  }
  /** Render the moving-resolution pass once now: it needs its own compiled shaders (no tone mapping,
   *  linear output into the target), and compiling them on the first drag was a 1.7 s stall. */
  private warmLowPass(): void {
    if (this.lowRT) this.renderVia(this.lowRT);
    this.renderVia(this.fullRT); this.dirty = true;
  }
  /** The last frame on screen is the moving-resolution one: redraw at full resolution once settled. */
  private settledLow = false;
  dispose(): void {
    this.disposed = true; cancelAnimationFrame(this.raf); this.canvas.removeEventListener('wheel', this.onWheel, { capture: true }); this.ro.disconnect();
    for (const [ev, fn] of [['pointerdown', this.onPointerDown], ['pointermove', this.onPointerMove], ['pointerup', this.onPointerUp], ['pointercancel', this.onPointerUp], ['contextmenu', this.onContextMenu]] as const) this.canvas.removeEventListener(ev, fn as EventListener);
    for (const root of [this.boardRoot, this.partsRoot, this.pickRoot, this.hlRoot, this.labelRoot]) disposeTree(root);
    this.lowRT?.dispose(); this.fullRT?.dispose(); this.blitMat.dispose();
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.canvas.remove();
  }
}

/** Round sprites for constant-size markers (a dot for net lands, a ring for the picked pin). Made
 *  once and shared: a selection is redrawn often, and a texture per redraw leaked. Never disposed. */
const MARKER_TEX: Partial<Record<'dot' | 'ring', THREE.CanvasTexture>> = {};
function markerTexture(kind: 'dot' | 'ring'): THREE.CanvasTexture {
  let t = MARKER_TEX[kind]; if (t) return t;
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d')!;
  g.fillStyle = g.strokeStyle = '#fff';
  if (kind === 'dot') { g.beginPath(); g.arc(32, 32, 22, 0, Math.PI * 2); g.fill(); }
  else { g.lineWidth = 7; g.beginPath(); g.arc(32, 32, 24, 0, Math.PI * 2); g.stroke(); }
  t = new THREE.CanvasTexture(c); MARKER_TEX[kind] = t; return t;
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse(o => {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Points) {
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        const map = (m as THREE.MeshStandardMaterial).map; if (map && !isMarkerTexture(map)) map.dispose();
        if (m instanceof THREE.ShaderMaterial) (m.uniforms.map?.value as THREE.Texture | undefined)?.dispose();
        if (!SHARED.has(m)) m.dispose();
      }
    }
  });
  root.clear();
}
// part-model materials are module-wide and shared between views: never dispose them
/** The 2D view's ghosts are 0x44ccff; a step deeper here, so they stay apart from a cyan net. */
const GHOST_BLUE = 0x3d9bff;

/** Ground, by the user's pin-group rules (the same test the 2D view's ghosts and net lines use), with GND as a floor. */
const isGround = (net: string) => isGroundNet(renderSettingsStore.settings, net) || /^(A|D|P)?GND/i.test(net);

/** ENIG lands: gold, matt — a bare pad on a real board is dull, not a mirror. */
const PAD_MAT = new THREE.MeshStandardMaterial({ color: 0xc99a3c, metalness: 0.75, roughness: 0.55, envMapIntensity: 0.5 });
const SHARED = new Set<THREE.Material>([...Object.values(MAT), PAD_MAT]);
const isMarkerTexture = (t: THREE.Texture) => Object.values(MARKER_TEX).includes(t as THREE.CanvasTexture);
