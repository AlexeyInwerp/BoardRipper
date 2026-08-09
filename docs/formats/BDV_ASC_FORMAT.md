# BDV ASC (Honhan / Tebo-ICT) File Format Specification

> Reverse-engineered from sample files (Compal LA-L031P / LA-L181P / LA-L191P)
> and the [OpenBoardView](https://github.com/OpenBoardView/OpenBoardView)
> `BDVFile.cpp` decoder.

---

## Overview

BDV ASC is a **single-file, obfuscated** container produced by the Honhan /
Tebo-ICT / eM-Test Expert boardview toolchain. It shares the `.bdv` extension
with the plain-text [BDV](BDV_FORMAT.md) format but is otherwise unrelated —
different detection signature, different cipher, different section structure.
Historically it is the consolidated single-file version of the multi-file ASC
export (hence the embedded `<<format.asc>>`, `<<nails.asc>>`, `<<pins.asc>>`
markers).

| Property | Value |
|----------|-------|
| Extension | `.bdv` (obfuscated bundle) · `.asc` (plain section files) |
| Detection | First 14 bytes equal the ASCII string `dd:1.3?,r?-=bb`, **or** plain text carrying one of the section header titles below |
| Encoding | ASCII after applying the line-key cipher below |
| Coordinate unit | Inches (parser multiplies by 1000 to get mils) |
| Side encoding (pins) | `1` = top, `2` = bottom, `0` = through-hole |
| Side encoding (parts/nails) | `(T)` = top, `(B)` = bottom |

There is **no trace, via, or copper-routing data** in this format — it is
component-level only.

---

## Plain (unencoded) delivery — `.asc`

The same toolchain also ships the document **unobfuscated, split back into the
files the markers are named after** (issue #26). Nothing about the content
changes: `<<pins.asc>>`'s body and a standalone `pins.asc` are the same bytes,
so one parser reads both. Only two things differ at the entry point:

1. **No cipher.** `parseBDVAsc` decodes only when the `dd:1.3?,r?-=bb`
   signature is present; otherwise the bytes are read as ASCII directly.
2. **No markers.** A standalone file has no `<<name>>` of its own, so the
   section is identified from the vendor header title the tool prints at the
   top of each file:

   | Title line | Section |
   |---|---|
   | `Board Outline Contour` | `format.asc` |
   | `Test Fixture Nails` | `nails.asc` |
   | `Part Pins List` | `pins.asc` |
   | `Parts List` | `parts.asc` |
   | `Net Listing` | `nets.asc` |

   `Part Pins List` is tested before `Parts List` — the pins title also starts
   with "Part". With the header stripped there is a shape fallback: a
   `Part <name> (T)` line means pins, a `$<id>` row means nails, a row ending
   in the quoted `'device', 'outline'` pair means the placement list, a
   `#<n> (S) <name>` header means the net listing, and bare numeric triples
   mean an outline contour.

A single file opens on its own — a lone `pins.asc` gives parts, pins and nets
with no outline. Selecting several at once merges them into **one** board
rather than one tab each: `bundleAscFiles` re-wraps each file under its own
`<<name>>` marker and hands the result to the same code path the `.bdv` uses,
so the two deliveries cannot drift apart. The merged tab is named after the
files' common stem, falling back to the board name the vendor prints in every
section header (`X555LD R36`) when the files are bare `Pins.asc` /
`Nails.asc` with no stem in common.

**Five sections, not three.** Older deliveries ship two files the `.bdv`
bundle has never carried — `Parts.asc` (the placement list) and `Nets.asc`
(the net listing). Both are documented below. Before they were read, clicking
either one failed with "no recognisable section".

### Opening a split delivery

Clicking one section file means "open this board", so every entry point that
can see the folder resolves the rest and merges them:

| Entry point | How the siblings are found |
|---|---|
| Library (indexed) | databank index by folder, plus the backend directory listing |
| Library (Live browse) | the directory listing already on screen |
| MCP `open_file` | same as the indexed Library |
| OS file picker / drag-drop | **not possible** — a sandboxed `File` has no folder |

The grouping rule (`parsers/asc-siblings.ts`) strips the section keyword and
its adjacent separators from the stem to get a *base* — `LA-L031P_pins.asc` →
`la-l031p`, a bare `Pins.asc` → `""` — and takes same-folder `.asc` files with
an equal base, at most one per section. A name carrying no section keyword
never groups, which is what keeps a PADS job's `PART.ASC` / `CONN.ASC` out and
two boards exported into one folder apart.

For the picker and drag-drop, where the folder is unreachable, the lone
section still opens and a toast names the missing sections with an **"Add
sections…"** button that takes them and replaces the partial tab.

**Extension collision.** `.asc` is also PADS Layout's ASCII export extension
(`PART.ASC` / `CONN.ASC` beside a PADS job). Those start with `*PADS-PCB*` and
are rejected by name — the same courtesy the XZZ parser extends to PADS binary
`.pcb` files.

---

## Obfuscation cipher

The file is transformed byte-by-byte with a running key that increments at
each CRLF:

```c
int count = 0xA0;
for (size_t i = 0; i < buffer_size; i++) {
    if (buf[i] == '\r' && buf[i + 1] == '\n') count++;
    char x = buf[i];
    if (!(x == '\r' || x == '\n' || !x)) x = count - x;
    if (count > 285) count = 159;
    buf[i] = x;
}
```

- Starting key: `0xA0` (= 160).
- Key increments on every `\r\n` pair.
- Non-control bytes are replaced by `(count - byte) & 0xFF`.
- `\r`, `\n`, and NUL are preserved.
- When the key crosses `285`, it wraps to `159`.

Under the initial key the 14-byte signature `dd:1.3?,r?-=bb` decodes to the
first section marker `<<format.asc>>`.

---

## File Structure (post-decode)

```
<<format.asc>>
<header lines>
   X        Y        Radius
  -5.638   -1.520    0.000
  ...

<<nails.asc>>
<header lines>
$<id>  X  Y  <typeInt>  <grid>  (<T|B>)  #<netnum> <netname> ... <viaType> .
$1     -11.5145  -0.9121  1  J1  (T)  #2365 GNDA  VIA .
...

<<pins.asc>>
<header lines>
Part <name>    (<T|B>)

   <num>  <pinName>  <X>  <Y>  <layer>  <netName>  [<nailId>]
   1      1          -5.9717  -0.8208  2  +5VS_BL  564
   ...

Part <next>    (<T|B>)
   ...
```

The bundle's three sections always appear in order `format` → `nails` → `pins`
and are separated only by `<<section.asc>>` markers; there is no length field.
The plain delivery adds `parts.asc` and `nets.asc` beside them.

---

## Section details

### `<<format.asc>>` — board outline

One closed polygon as a list of vertices. Column header:

```
      X           Y         Radius
```

Each data line has three whitespace-separated floats. Radius is non-zero only
for arcs (the parser currently approximates arcs as straight segments, same as
OpenBoardView). Coordinates are in inches.

### `<<nails.asc>>` — test nails / via probes

Each nail line starts with `$` and a numeric id:

| Field | Description |
|-------|-------------|
| `$<id>` | Nail identifier |
| `X Y` | Position in inches |
| `<typeInt>` | Probe type code (1 = top-side probe, 2 = bottom-side probe) |
| `<grid>` | Fixture grid cell label (e.g. `J1`, `H4`) |
| `(T)` / `(B)` | Which side of the fixture the nail is on |
| `#<netnum>` | Internal net number |
| `<netname>` | Net name (matches names used in `pins.asc`) |
| `VIA` / other | Nail type suffix |
| `.` | End-of-record marker |

Nails can repeat across revisions; the parser dedupes by `(X, Y, side, net)`.

### `<<pins.asc>>` — parts and pins

Parts are introduced by a header line:

```
Part <name>     (<T|B>)
```

Followed by pin lines (the leading whitespace is load-bearing and used to tell
pin lines apart from headers):

| Field | Description |
|-------|-------------|
| `<num>` | 1-based pin number within the part |
| `<pinName>` | Pin label (often identical to `<num>`) |
| `X Y` | Position in inches |
| `<layer>` | `1` = top, `2` = bottom, `0` = through-hole |
| `<netName>` | `(NC)` means unconnected |
| `<nailId>` | Optional — id of the test nail probing this pin |

`(NC)` net names are mapped to an empty string (same convention as
`BoardData.nets`). Layer `0` pins — mounting holes and other through-hole
fixtures — inherit the part's own side (`(T)` or `(B)`), which is always
consistent with the pin coordinates.

**Net names may contain spaces** — `3D VISION` is real (X555LD R36) — so the
name is not simply the token after the layer. It runs to the end of the row
minus the trailing all-numeric nail-id column. The nail rows have the same
problem and end their net name at the `T` / `PIN` / `VIA` / `.` column that
always follows it.

### `<<parts.asc>>` — placement list

Only ever seen in the plain-file delivery. One row per part:

```
Part             X         Y     Rot  Grid  T/B  'Device', 'Outline'

PR6001        4.3967   -1.1283  270.0  C3   (T)  'NBS_R0402_H16_000S_B', 'NBS_R0402_H16_000S_B'
```

| Field | Description |
|-------|-------------|
| `<name>` | Reference designator — the same key `pins.asc` uses |
| `X Y` | Placement origin in inches |
| `<rot>` | Rotation in degrees; mostly multiples of 90 |
| `<grid>` | Fixture grid cell label |
| `(T)` / `(B)` | Side |
| `'<device>', '<outline>'` | Package names; identical in every row of the samples seen |

This is the only section carrying rotation and package, so the parser applies
them (`Part.angleDeg`, `meta.package`) on top of the pin-derived parts.
Geometry stays pin-derived — the placement origin and the pin-bounds centre
differ slightly, and every consumer is built around the latter. A part listed
here but absent from `pins.asc` is emitted at its printed origin with no pins.

### `<<nets.asc>>` — net listing

Also plain-delivery only. A `#<num>  (S)  <name>` header per net followed by
its `PART.PIN` members:

```
#1    (S)  DVDD33
 C4529.1
 U4501.8
```

On a complete delivery this is redundant — on X555LD R36 its 8319 members are
exactly the 8319 pins of `pins.asc`. The parser reads it so the file is never
an error, and uses it only to fill nets the pin pass produced none of (a pin
whose net column was blank adopts the listed net). Listed nets that resolve to
no pin at all — the vendor's `NC_*` placeholders — are dropped rather than
padding the net list with entries that highlight nothing. A `nets.asc` opened
alone holds no geometry and says so.

---

## Parser Notes

- Coordinates are multiplied by `1000` to convert inches to mils (BoardRipper's
  internal unit).
- `flipY` is auto-detected from the outline winding order via the shoelace
  formula, matching the behaviour of the plain-text
  [BDV parser](../../src/frontend/src/parsers/bdv-parser.ts).
- File sizes are dominated by the pin section (typically ~90% of the decoded
  text). A 1.5 MB file is normal for a laptop mainboard with ~15 000 pins.
- A section that holds no geometry at all still needs an extent: a lone
  `nails.asc` or `parts.asc` falls back to its nail positions / part origins,
  or the board opens as an empty screen with a degenerate 0×0 bounding box.
- Known samples ship from Compal LA-L laptop mainboards (e.g. LA-L031P,
  LA-L181P, LA-L191P) produced with "Tebo-ICT, license #jacky_ict", and from
  an ASUS X555LD R36 five-file plain delivery dated 2015 ("Tebo-ICT,
  license #Style" / "eM-Test Expert (R)").

---

## References

- OpenBoardView: [`BDVFile.cpp`](https://github.com/OpenBoardView/OpenBoardView/blob/master/src/openboardview/FileFormats/BDVFile.cpp)
- Piernov decoder gist: <https://gist.github.com/piernov/37849a3b92375e18515160b8a1efde18>
- OpenBoardView issue #2 — "Honhan BoardView" compatibility request: <https://github.com/OpenBoardView/OpenBoardView/issues/2>
