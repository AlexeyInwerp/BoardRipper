import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Light scheme, "ink" selection style: every pin of the lit net is filled
// solid with the scheme's ink. Its pin number and net name were coloured at
// scene build against the pin's own colour — dark ink, on the light schemes —
// and vanished into that fill. The overlay must draw them in the colour chosen
// against the ink instead. Checked at the source: the colour each label is
// actually painted with on the overlay canvas (fillText's fillStyle).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(__dirname, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const haveBoard = fs.existsSync(BOARD);

test.use({
  viewport: { width: 1400, height: 900 },
  launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
});

function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}
function contrast(a: string, b: string): number {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

for (const style of ['ink', 'inkHighlighter'] as const) {
  test(`light scheme, ${style}: labels on inked pins read against the ink`, async ({ page }) => {
    test.skip(!haveBoard, 'samples/kicad/tomu-fpga.kicad_pcb not present');
    // The scheme is chosen through its stored id, not by importing the store:
    // after an HMR update the app holds a `themes.ts?t=…` instance that a
    // fresh import would not be.
    await page.addInitScript(() => localStorage.setItem('boardripper-theme', JSON.stringify({ activeId: 'light' })));
    await page.goto('/');
    await page.evaluate((style) => {
      const rs = (window as any).__renderSettings;
      rs.applyGlobal({ ...rs.globalSnapshot(), lightSelectionStyle: style, textFastMode: true, pinNetLabelBg: false, twoPinNetLabelBg: false });
    }, style);
    await page.getByTestId('file-input').setInputFiles(BOARD);
    await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });
    await page.waitForTimeout(1000);

    const res = await page.evaluate(async () => {
      const themes = await import('/src/store/themes.ts');
      const bs = (window as any).__boardStore, r = (window as any).__boardRenderer;
      const ink: string = themes.THEMES.light.board.selectedPart;
      const parts = bs.board.parts;
      // A multi-pin part's pin on a small signal net that has a label record.
      const model = r.activeScene.labelModel;
      const recs = [...model.top, ...model.bottom];
      let pi = -1, pni = -1;
      for (const rec of recs) {
        if (rec.kind !== 'circleNet' || rec.inkColor === undefined) continue;
        const pin = parts[rec.partIndex].pins[rec.pinIndex];
        const net = bs.board.nets.get(pin.net);
        if (!net || net.pinIndices.length < 2 || net.pinIndices.length > 12) continue;
        pi = rec.partIndex; pni = rec.pinIndex; break;
      }
      if (pi < 0) return { error: 'no candidate pin' };
      const pin = parts[pi].pins[pni];
      bs.selectPin(pi, pni);
      // Zoom onto the pin so its labels pass the overlay's LoD.
      const g = r.activeScene.root.toGlobal({ x: pin.position.x, y: pin.position.y });
      const w = r.viewport.toWorld(g.x, g.y);
      r.viewport.setZoom(r.viewport.scale.x * 40, true);
      r.viewport.moveCenter(w.x, w.y);
      await new Promise(res => setTimeout(res, 600));

      // Record what the overlay canvas paints, then force a full overlay draw.
      const overlayCanvas: HTMLCanvasElement = r.textFastMode.element;
      const calls: { text: string; fill: string }[] = [];
      const orig = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, mw?: number) {
        if (this.canvas === overlayCanvas) calls.push({ text, fill: String(this.fillStyle) });
        return mw === undefined ? orig.call(this, text, x, y) : orig.call(this, text, x, y, mw);
      };
      r.overlayDirty = true; r.overlayContentDirty = true; r.needsRender = true;
      await new Promise(res => setTimeout(res, 400));
      CanvasRenderingContext2D.prototype.fillText = orig;

      const inked = r.inkedPins?.get(pi)?.has(pni) ?? false;
      return { ink, net: pin.net, inked, fills: calls.filter(c => c.text === pin.net).map(c => c.fill) };
    });

    expect(res.error).toBeUndefined();
    expect(res.inked).toBe(true);
    expect(res.fills!.length).toBeGreaterThan(0);
    for (const fill of res.fills!) {
      expect(fill.toLowerCase()).not.toBe(res.ink!.toLowerCase());
      expect(contrast(fill, res.ink!)).toBeGreaterThanOrEqual(4.5);
    }
  });
}
