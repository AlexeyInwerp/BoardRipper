# Format Maintenance — Memory

## Consistency Matrix Snapshot (2026-04-11)

### Field Population by Format

| Field | BVR1 | BVR3 | BRD | BDV | FZ | CAD | XZZ | TVW | Allegro |
|-------|------|------|-----|-----|-----|-----|-----|-----|---------|
| outline | file | file | file | file | synthetic | synthetic | ? | per-layer | synthetic |
| parts[].side | inverted | inverted | heuristic | direct | direct | direct | ? | direct | ? |
| parts[].type | hardcoded smd | from file | hardcoded smd | hardcoded smd | hardcoded smd | from file | ? | hardcoded smd | ? |
| parts[].origin | computed | file+fallback | computed | file | computed | computed | ? | file | ? |
| parts[].bounds | computed | computed | computed | file∪computed | computed | computed | ? | file | ? |
| pins[].side | inverted | inverted | from part | special side=0 | from part | overridden | ? | from layer | ? |
| pins[].net | yes | yes | yes | yes | yes | yes | ? | yes | yes |
| nails | yes | empty | yes | yes | yes | empty | ? | yes | ? |
| nets | buildNets | buildNets | buildNets | buildNets | buildNets | buildNets | ? | buildNets | buildNets |
| traces | — | — | — | — | — | — | ? | yes | partial |
| vias | — | — | — | — | — | — | ? | yes | ? |
| layerNames | — | — | — | — | — | — | ? | yes | ? |
| flipY | false | false | descriptor | per-file | descriptor | descriptor | descriptor | descriptor | descriptor |

### Key Decisions to Make

1. Should side inversion be standardized to descriptor flag only, or is parser-level inversion acceptable?
2. Should all parsers attempt mount type detection, or document why they can't?
3. Should origin always be computed from pins (consistent) or preserve file values (accurate)?
4. XZZ and Allegro need full audit to fill the "?" cells

### Interface Contract (current de facto)

```typescript
// FormatDescriptor.parse signature
parse: (buffer: ArrayBuffer) => BoardData | Promise<BoardData>

// BoardData must always have:
format: string          // format ID from descriptor
outline: Point[]        // board polygon (explicit or synthetic)
parts: Part[]          // components with nested pins
nails: Nail[]          // test points (empty array if format lacks them)
nets: Map<string, Net> // built via buildNets(parts)
bounds: BBox           // overall bounding box

// BoardData optional:
traces?: Trace[]       // only TVW, Allegro
vias?: Via[]           // only TVW, Allegro
layerNames?: string[]  // only TVW, Allegro
butterflyFoldAxis?: 'x' | 'y'  // only TVW
flipY?: boolean        // only BDV (per-file override)
```
