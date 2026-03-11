import { useRef, useEffect } from 'react';
import type { RenderSettings } from '../store/render-settings';
import { getLabelFontSize, resolvePinColor, computePinRadius, computePartPadding } from '../store/render-settings';

/**
 * A small canvas that draws a fake board sample to preview settings changes.
 * Self-contained — no PixiJS, just Canvas 2D for fast, lag-free rendering.
 */

interface MockupPin {
  x: number; y: number;
  radius: number;
  net: string;
  side: 'top' | 'bottom';
}

interface MockupPart {
  name: string;
  side: 'top' | 'bottom';
  pins: MockupPin[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

// Static fake board data — a small representative sample
const OUTLINE = [
  { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 180 }, { x: 0, y: 180 },
];

const MOCK_PARTS: MockupPart[] = [
  // IC with many pins
  {
    name: 'U1', side: 'top',
    pins: [
      { x: 40, y: 40, radius: 5, net: 'VCC3V3', side: 'top' },
      { x: 55, y: 40, radius: 5, net: 'GND', side: 'top' },
      { x: 70, y: 40, radius: 5, net: 'SDA', side: 'top' },
      { x: 85, y: 40, radius: 5, net: 'SCL', side: 'top' },
      { x: 40, y: 55, radius: 5, net: 'VCC3V3', side: 'top' },
      { x: 55, y: 55, radius: 5, net: 'GND', side: 'top' },
      { x: 70, y: 55, radius: 5, net: 'GPIO0', side: 'top' },
      { x: 85, y: 55, radius: 5, net: 'GPIO1', side: 'top' },
      { x: 40, y: 70, radius: 5, net: 'RESET_N', side: 'top' },
      { x: 55, y: 70, radius: 5, net: 'CLK', side: 'top' },
      { x: 70, y: 70, radius: 5, net: 'MOSI', side: 'top' },
      { x: 85, y: 70, radius: 5, net: 'MISO', side: 'top' },
    ],
    bounds: { minX: 35, minY: 35, maxX: 90, maxY: 75 },
  },
  // Horizontal resistor (2-pin) — wide component like CR023 in the reference
  {
    name: 'R1', side: 'top',
    pins: [
      { x: 130, y: 45, radius: 4, net: 'VCC3V3', side: 'top' },
      { x: 155, y: 45, radius: 4, net: 'RESET_N', side: 'top' },
    ],
    bounds: { minX: 122, minY: 38, maxX: 163, maxY: 52 },
  },
  // Vertical capacitor (2-pin)
  {
    name: 'C1', side: 'top',
    pins: [
      { x: 130, y: 75, radius: 4, net: 'VCC3V3', side: 'top' },
      { x: 130, y: 100, radius: 4, net: 'GND', side: 'top' },
    ],
    bounds: { minX: 123, minY: 67, maxX: 137, maxY: 108 },
  },
  // Bottom-side IC
  {
    name: 'U2', side: 'bottom',
    pins: [
      { x: 190, y: 100, radius: 6, net: 'PP1V8', side: 'bottom' },
      { x: 205, y: 100, radius: 6, net: 'GND', side: 'bottom' },
      { x: 220, y: 100, radius: 6, net: 'SDA', side: 'bottom' },
      { x: 235, y: 100, radius: 6, net: 'SCL', side: 'bottom' },
      { x: 190, y: 115, radius: 6, net: 'MOSI', side: 'bottom' },
      { x: 205, y: 115, radius: 6, net: 'MISO', side: 'bottom' },
      { x: 220, y: 115, radius: 6, net: 'CLK', side: 'bottom' },
      { x: 235, y: 115, radius: 6, net: 'GPIO0', side: 'bottom' },
    ],
    bounds: { minX: 184, minY: 94, maxX: 241, maxY: 121 },
  },
  // Bottom-side horizontal resistor (2-pin)
  {
    name: 'R4', side: 'bottom',
    pins: [
      { x: 260, y: 105, radius: 4, net: 'GND', side: 'bottom' },
      { x: 282, y: 105, radius: 4, net: 'GPIO1', side: 'bottom' },
    ],
    bounds: { minX: 253, minY: 99, maxX: 289, maxY: 111 },
  },
];

function hexToRgba(hex: number, alpha: number): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Inflate flat bounds for 2-pin parts so outline and pads use the same dimensions.
 * Returns effective bounds {minX, minY, maxX, maxY}.
 */
function inflateTwoPinBounds(
  b: { minX: number; minY: number; maxX: number; maxY: number },
  p0: { x: number; y: number },
  p1: { x: number; y: number },
) {
  const horiz = Math.abs(p0.x - p1.x) >= Math.abs(p0.y - p1.y);
  const dist = Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2);
  const inflate = dist * 0.35;
  let { minX, minY, maxX, maxY } = b;
  if (horiz && maxY - minY < inflate) {
    const cy = (minY + maxY) / 2;
    minY = cy - inflate / 2; maxY = cy + inflate / 2;
  }
  if (!horiz && maxX - minX < inflate) {
    const cx = (minX + maxX) / 2;
    minX = cx - inflate / 2; maxX = cx + inflate / 2;
  }
  return { minX, minY, maxX, maxY, horiz };
}

/** Draw a 2-pin SMD pad at one end of the padded outline (flush with border) */
function drawTwoPinPad(
  ctx: CanvasRenderingContext2D,
  pin: MockupPin,
  otherPin: MockupPin,
  px: number, py: number,
  pw: number, ph: number,
  horiz: boolean,
) {
  if (horiz) {
    const depth = Math.min(ph, pw * 0.4);
    const left = pin.x < otherPin.x;
    if (left) {
      ctx.fillRect(px, py, depth, ph);
    } else {
      ctx.fillRect(px + pw - depth, py, depth, ph);
    }
  } else {
    const depth = Math.min(pw, ph * 0.4);
    const top = pin.y < otherPin.y;
    if (top) {
      ctx.fillRect(px, py, pw, depth);
    } else {
      ctx.fillRect(px, py + ph - depth, pw, depth);
    }
  }
}


function renderMockup(ctx: CanvasRenderingContext2D, w: number, h: number, s: RenderSettings) {
  const dpr = window.devicePixelRatio || 1;

  ctx.clearRect(0, 0, w * dpr, h * dpr);
  ctx.save();
  ctx.scale(dpr, dpr);

  // Background
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, w, h);

  // Scale to fit the 300x180 board into the canvas with padding
  const boardW = 300;
  const boardH = 180;
  const scaleX = (w - 20) / boardW;
  const scaleY = (h - 20) / boardH;
  const scale = Math.min(scaleX, scaleY);
  const ox = (w - boardW * scale) / 2;
  const oy = (h - boardH * scale) / 2;

  ctx.translate(ox, oy);
  ctx.scale(scale, scale);

  // Outline
  if (OUTLINE.length > 1) {
    ctx.beginPath();
    ctx.moveTo(OUTLINE[0].x, OUTLINE[0].y);
    for (let i = 1; i < OUTLINE.length; i++) {
      ctx.lineTo(OUTLINE[i].x, OUTLINE[i].y);
    }
    ctx.closePath();
    ctx.strokeStyle = hexToRgba(0x4a9eff, s.outlineAlpha);
    ctx.lineWidth = s.outlineWidth;
    ctx.stroke();
  }

  // Parts and pins
  for (const part of MOCK_PARTS) {
    const pad = computePartPadding();
    const isTwoPin = part.pins.length === 2;

    // Inflate flat bounds for 2-pin parts
    let eb = part.bounds;
    let tpHoriz = false;
    if (isTwoPin) {
      const inf = inflateTwoPinBounds(part.bounds, part.pins[0], part.pins[1]);
      eb = inf;
      tpHoriz = inf.horiz;
    }
    const bw = eb.maxX - eb.minX;
    const bh = eb.maxY - eb.minY;

    // Part bounds
    ctx.strokeStyle = hexToRgba(
      part.side === 'bottom' ? 0x663333 : 0x336633,
      s.partBorderAlpha
    );
    ctx.lineWidth = s.partBorderWidth;
    ctx.strokeRect(eb.minX - pad, eb.minY - pad, bw + pad * 2, bh + pad * 2);

    // Part label
    if (s.showPartLabels) {
      let fontSize: number;
      if (isTwoPin) {
        fontSize = getLabelFontSize(s);
      } else {
        const targetW = (bw + pad * 2) * 0.7;
        fontSize = targetW / (part.name.length * 0.6);
        fontSize = Math.max(2, Math.min(fontSize, bh * 0.8));
      }
      if (fontSize >= 1) {
        ctx.font = `${fontSize}px monospace`;
        ctx.fillStyle = 'rgba(204,204,204,0.9)';
        if (isTwoPin) {
          ctx.fillText(part.name, eb.minX, eb.minY - pad * 0.5 - 1);
        } else {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(part.name, (eb.minX + eb.maxX) / 2, (eb.minY + eb.maxY) / 2);
          ctx.textAlign = 'start';
          ctx.textBaseline = 'alphabetic';
        }
      }
    }

    // Pins — for 2-pin parts, pads fill the ends of the padded outline (flush with border)
    const px = eb.minX - pad;
    const py = eb.minY - pad;
    const pw = bw + pad * 2;
    const ph = bh + pad * 2;

    for (let i = 0; i < part.pins.length; i++) {
      const pin = part.pins[i];
      const color = resolvePinColor(s, pin.net, pin.side);
      ctx.fillStyle = hexToRgba(color, s.pinAlpha);

      if (isTwoPin) {
        const other = part.pins[1 - i];
        drawTwoPinPad(ctx, pin, other, px, py, pw, ph, tpHoriz);
      } else {
        const r = computePinRadius(s, pin.radius);
        ctx.beginPath();
        ctx.arc(pin.x, pin.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Selection mockup (highlight U1)
  {
    const part = MOCK_PARTS[0];
    const b = part.bounds;
    const selPad = s.selectionPadding;
    ctx.strokeStyle = hexToRgba(0xffaa00, 0.9);
    ctx.lineWidth = s.selectionWidth;
    ctx.strokeRect(b.minX - selPad, b.minY - selPad, b.maxX - b.minX + selPad * 2, b.maxY - b.minY + selPad * 2);

    // Net highlight mockup — highlight VCC3V3 pins
    const hlPad = computePartPadding();
    for (const mp of MOCK_PARTS) {
      const mpTwoPin = mp.pins.length === 2;
      let meb = mp.bounds;
      let mpHoriz = false;
      if (mpTwoPin) {
        const inf = inflateTwoPinBounds(mp.bounds, mp.pins[0], mp.pins[1]);
        meb = inf; mpHoriz = inf.horiz;
      }

      for (let i = 0; i < mp.pins.length; i++) {
        const pin = mp.pins[i];
        if (pin.net !== 'VCC3V3') continue;

        const grow = s.netHighlightGrow;
        ctx.fillStyle = hexToRgba(0xffff44, s.netHighlightAlpha);

        if (mpTwoPin) {
          const mebw = meb.maxX - meb.minX;
          const mebh = meb.maxY - meb.minY;
          // Normal pad rect at padded outline size
          const npx = meb.minX - hlPad;
          const npy = meb.minY - hlPad;
          const npw = mebw + hlPad * 2;
          const nph = mebh + hlPad * 2;
          const other = mp.pins[1 - i];
          // Compute pad rect, then grow outward
          let rx: number, ry: number, rw: number, rh: number;
          if (mpHoriz) {
            const depth = Math.min(nph, npw * 0.4);
            const left = pin.x < other.x;
            rx = left ? npx : npx + npw - depth;
            ry = npy; rw = depth; rh = nph;
          } else {
            const depth = Math.min(npw, nph * 0.4);
            const top = pin.y < other.y;
            rx = npx; ry = top ? npy : npy + nph - depth;
            rw = npw; rh = depth;
          }
          ctx.fillRect(rx - grow, ry - grow, rw + grow * 2, rh + grow * 2);
        } else {
          const r = computePinRadius(s, pin.radius) + grow;
          ctx.beginPath();
          ctx.arc(pin.x, pin.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  ctx.restore();
}

export function SettingsMockup({ settings }: { settings: RenderSettings }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    // Defer to next frame so the container has been laid out
    rafRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const container = canvas.parentElement!;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w < 1 || h < 1) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;

      renderMockup(ctx, w, h, settings);
    });
    return () => cancelAnimationFrame(rafRef.current);
  }, [settings]);

  return (
    <div className="settings-mockup">
      <canvas ref={canvasRef} />
    </div>
  );
}
