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
| Extension | `.bdv` |
| Detection | First 14 bytes equal the ASCII string `dd:1.3?,r?-=bb` |
| Encoding | ASCII after applying the line-key cipher below |
| Coordinate unit | Inches (parser multiplies by 1000 to get mils) |
| Side encoding (pins) | `1` = top, `2` = bottom, `0` = through-hole |
| Side encoding (parts/nails) | `(T)` = top, `(B)` = bottom |

There is **no trace, via, or copper-routing data** in this format — it is
component-level only.

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

The three sections always appear in order `format` → `nails` → `pins` and are
separated only by `<<section.asc>>` markers; there is no length field.

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

---

## Parser Notes

- Coordinates are multiplied by `1000` to convert inches to mils (BoardRipper's
  internal unit).
- `flipY` is auto-detected from the outline winding order via the shoelace
  formula, matching the behaviour of the plain-text
  [BDV parser](../../src/frontend/src/parsers/bdv-parser.ts).
- File sizes are dominated by the pin section (typically ~90% of the decoded
  text). A 1.5 MB file is normal for a laptop mainboard with ~15 000 pins.
- Known samples ship from Compal LA-L laptop mainboards (e.g. LA-L031P,
  LA-L181P, LA-L191P) produced with "Tebo-ICT, license #jacky_ict".

---

## References

- OpenBoardView: [`BDVFile.cpp`](https://github.com/OpenBoardView/OpenBoardView/blob/master/src/openboardview/FileFormats/BDVFile.cpp)
- Piernov decoder gist: <https://gist.github.com/piernov/37849a3b92375e18515160b8a1efde18>
- OpenBoardView issue #2 — "Honhan BoardView" compatibility request: <https://github.com/OpenBoardView/OpenBoardView/issues/2>
