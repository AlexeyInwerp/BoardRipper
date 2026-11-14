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

const CELL = 64, COLS = 16, ADV = 0.62; // glyph cell (px), atlas columns, advance as a fraction of the height

function atlas(chars: string[]): { tex: THREE.CanvasTexture; uv: Map<string, [number, number, number, number]> } {
  const rows = Math.ceil(chars.length / COLS), cv = document.createElement('canvas');
  cv.width = CELL * COLS; cv.height = CELL * Math.max(1, rows);
  const c = cv.getContext('2d')!;
  c.font = `700 ${CELL * 0.78}px ui-monospace, Menlo, Consolas, monospace`; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.lineJoin = 'round'; c.lineWidth = CELL * 0.16; c.strokeStyle = 'rgba(0,0,0,0.9)'; c.fillStyle = '#ffffff';
  const uv = new Map<string, [number, number, number, number]>();
  chars.forEach((ch, i) => {
    const col = i % COLS, row = Math.floor(i / COLS), x = col * CELL + CELL / 2, y = row * CELL + CELL / 2 + CELL * 0.03;
    c.strokeText(ch, x, y); c.fillText(ch, x, y);
    const pad = (1 - ADV) / 2; // a glyph uses the middle ADV of its cell's width
    uv.set(ch, [(col + pad) / COLS, 1 - (row + 1) / Math.max(1, rows), (col + 1 - pad) / COLS, 1 - row / Math.max(1, rows)]);
  });
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tex, uv };
}

export interface LabelSpec {
  text: string;
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
  const pos: number[] = [], uvs: number[] = [], hs: number[] = [], idx: number[] = [];
  for (const s of specs) {
    const n = s.text.length; if (!n) continue;
    const h = Math.min(s.height, s.maxLength / (n * ADV)); if (h < 0.05) continue;
    // seen from below, the board's x runs right-to-left: write in the viewer's frame, then map back
    const viewerAngle = s.side === 'top' ? s.angleDeg : 180 - s.angleDeg;
    let a = ((viewerAngle % 360) + 360) % 360; if (a > 90 && a <= 270) a -= 180; // keep it reading left-to-right
    const r = a * Math.PI / 180, vx = s.side === 'top' ? 1 : -1;
    const right = new THREE.Vector3(vx * Math.cos(r), 0, -Math.sin(r)), up = new THREE.Vector3(-vx * Math.sin(r), 0, -Math.cos(r));
    const w = h * ADV, x0 = -n * w / 2;
    [...s.text].forEach((ch, i) => {
      const [u0, v0, u1, v1] = uv.get(ch)!, base = pos.length / 3, cx = x0 + (i + 0.5) * w;
      for (const [dx, dy, u, v] of [[-w / 2, -h / 2, u0, v0], [w / 2, -h / 2, u1, v0], [w / 2, h / 2, u1, v1], [-w / 2, h / 2, u0, v1]] as const) {
        const p = new THREE.Vector3(s.x, s.y, s.z).addScaledVector(right, cx + dx).addScaledVector(up, dy);
        pos.push(p.x, p.y, p.z); uvs.push(u, v); hs.push(h);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aH', new THREE.Float32BufferAttribute(hs, 1));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, viewportH: { value: 1000 } },
    vertexShader: `
      attribute float aH; uniform float viewportH; varying vec2 vUv; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float px = aH * projectionMatrix[1][1] * 0.5 * viewportH / max(-mv.z, 1e-3); // label height on screen
        vA = smoothstep(5.0, 9.0, px); vUv = uv;
      }`,
    fragmentShader: `
      uniform sampler2D map; varying vec2 vUv; varying float vA;
      void main() {
        vec4 t = texture2D(map, vUv); float a = t.a * vA; if (a < 0.04) discard;
        gl_FragColor = vec4(t.rgb, a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = 3; mesh.frustumCulled = false;
  return mesh;
}
