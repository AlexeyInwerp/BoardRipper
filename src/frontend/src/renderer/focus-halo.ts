/** Shared focus-target geometry for the two halos that mark the selected part:
 *  the dark spotlight sprite in the Pixi scene (`BoardRenderer.updateHalo`) and
 *  the HDR glow on the DOM overlay (`HdrGlowOverlay`). Both consume this so
 *  they cannot drift apart.
 *
 *  Growth is ADDITIVE, not multiplicative: the floor keeps the halo imposing on
 *  0402-class passives, and the fixed padding stops a large BGA from scaling the
 *  halo out into the next county. All units are mils. */
export interface HaloBounds { minX: number; maxX: number; minY: number; maxY: number }

const MIN_DIAMETER = 1500; // mils — ~38 mm
const PART_PADDING = 800;  // mils added to the part's longest dimension

export function focusHaloGeometry(b: HaloBounds): { x: number; y: number; size: number } {
  const partMaxDim = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1);
  return {
    x: (b.minX + b.maxX) / 2,
    y: (b.minY + b.maxY) / 2,
    size: Math.max(MIN_DIAMETER, partMaxDim + PART_PADDING),
  };
}
