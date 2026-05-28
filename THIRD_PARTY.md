# Third-Party Notices

BoardRipper is released under the **GNU Affero General Public License v3.0**
(see [LICENSE](LICENSE)).

It incorporates, links against, or was informed by the following third-party
works. Each entry lists the upstream project, its license, and how it is used
in BoardRipper.

---

## Code and Algorithm References

### KiCad — `pcbnew/pcb_io/allegro/`
- **License:** GNU General Public License v3.0 (GPL-3.0)
- **Upstream:** https://gitlab.com/kicad/code/kicad
- **Used in:** `src/frontend/src/parsers/allegro/` (allegro-types.ts, allegro-header.ts, allegro-blocks.ts, allegro-assembler.ts, allegro-db.ts)
- **Nature of use:** The Cadence Allegro BRD parser in BoardRipper is a TypeScript re-implementation derived from KiCad's C++ Allegro importer. Block-type definitions, version-detection logic, three-phase parsing architecture, and coordinate transforms are transliterated from KiCad. GPL-3.0 obligations propagate to BoardRipper, which is why BoardRipper as a whole is licensed under AGPL-3.0 (a GPL-3.0-compatible upgrade).
- **Spec:** [docs/formats/ALLEGRO_BRD_FORMAT.md](docs/formats/ALLEGRO_BRD_FORMAT.md)

### OpenBoardView
- **License:** MIT
- **Upstream:** https://github.com/OpenBoardView/OpenBoardView
- **Used in:** `src/frontend/src/parsers/` — BVR1, BVR3, BRD, BDV, BDV ASC, FZ, CAD, XZZ parsers
- **Nature of use:** OpenBoardView's C++ parsers (BVRFile.cpp, BVR3File.cpp, BRDFile.cpp, BDVFile.cpp, FZFile.cpp, GenCADFile.cpp, XZZPCBFile.cpp) were consulted as reference implementations to reverse-engineer format behavior. BoardRipper's TypeScript parsers are independent re-implementations written against the format specifications in `docs/formats/`; no verbatim OpenBoardView code is present. The FZ decryption key is **not** inherited from OpenBoardView — upstream OBV deliberately omits it (`FZFile::getBuiltinKey()` returns an empty array), and so does BoardRipper. See the *FZ decryption key — not bundled* entry below.
- **Specs:** `docs/formats/BVR_FORMAT.md`, `docs/formats/BRD_FORMAT.md`, `docs/formats/BDV_FORMAT.md`, `docs/formats/BDV_ASC_FORMAT.md`, `docs/formats/FZ_FORMAT.md`, `docs/formats/CAD_FORMAT.md`, `docs/formats/XZZ_FORMAT.md`

### piernov — Honhan BDV decoder gist
- **License:** Public gist (no explicit license; algorithm only)
- **Upstream:** https://gist.github.com/piernov/37849a3b92375e18515160b8a1efde18
- **Context:** https://github.com/OpenBoardView/OpenBoardView/issues/2
- **Used in:** `src/frontend/src/parsers/bdv-asc-decoder.ts`
- **Nature of use:** The gist identifies the `dd:1.3?,r?-=bb` signature and the line-key cipher shape (count-minus-byte, CRLF-advanced). BoardRipper's TypeScript decoder was written against OpenBoardView's canonical `decode_bdv` in `BDVFile.cpp` — the same algorithm, but the gist was how the format was first attributed to the Honhan / Tebo-ICT family.
- **Spec:** [docs/formats/BDV_ASC_FORMAT.md](docs/formats/BDV_ASC_FORMAT.md)

### Mentor Boardstation Neutral — original RE
- **License:** N/A (no third-party code or text incorporated)
- **Used in:** `src/frontend/src/parsers/mentor-neutral-parser.ts`, `src/frontend/src/parsers/mentor-neutral-format.ts`
- **Nature of use:** Mentor Graphics publishes no public spec for the Boardstation neutral file. The parser and accompanying format document ([docs/formats/MENTOR_NEUTRAL_FORMAT.md](docs/formats/MENTOR_NEUTRAL_FORMAT.md)) are original reverse-engineering work derived solely from inspecting real-world sample exports (Samsung RV415 / Quanta Brazos / Quanta Jinmao14-L). Generic format mentions consulted for context only — none contained record-level layout: PTC's [BoardStation EIF docs](https://support.ptc.com/help/creo/ced_modeling/r20.6.0.0/en/ced_modeling/OSDM_Modules/PCB_BoardStationCreate.html), Altair Pollex's [Mentor Graphics Interface](https://help.altair.com/Pollex/topics/pollex/modeler/pcb_mentor_graphics_interface_r.htm), and the [Internet Archive's Boardstation manuals](https://archive.org/details/1999-mentor-boardstation-da-qsim-accusim-win) (none consulted at code-level — kept as a future verification source).
- **Spec:** [docs/formats/MENTOR_NEUTRAL_FORMAT.md](docs/formats/MENTOR_NEUTRAL_FORMAT.md)

### eagleview — Pavel Kovalenko
- **License:** MIT
- **Upstream:** https://github.com/nitrocaster/eagleview
- **Used in:** `src/frontend/src/parsers/tvw-parser.ts`
- **Nature of use:** The Teboview (TVW) parser is a TypeScript port of eagleview's C++ reference implementation. A copy of the upstream MIT license is retained at [docs/formats/tvw-reference/eagleview-LICENSE](docs/formats/tvw-reference/eagleview-LICENSE).
- **Spec:** [docs/formats/TVW_FORMAT.md](docs/formats/TVW_FORMAT.md)

### brd_parser — Jeff Wheeler
- **License:** MIT
- **Upstream:** https://github.com/bernayigit/brd_parser
- **Used in:** cross-validation reference for `src/frontend/src/parsers/allegro/`
- **Nature of use:** Consulted alongside KiCad for secondary block-type hints and byte-layout validation during Allegro parser development.

### Cryptographic standards
- **RC6 stream cipher** (used in `src/frontend/src/parsers/fz-parser.ts`): RC6 algorithm by Rivest, Robshaw, Sidney, and Yin. Public algorithm, implementation written from the published design.

### FZ decryption key — *not bundled*
- **What is it:** 44 × uint32 constant required to decrypt ASUS-produced `.fz` boardview files via the RC6 cipher above.
- **Why it isn't here:** BoardRipper does not author, host, or redistribute this key. We make no claim to it and take no position on its legal provenance. Upstream OpenBoardView takes the same position (`FZFile::getBuiltinKey()` returns an empty array — see `src/openboardview/FileFormats/FZFile.cpp` upstream).
- **How users obtain it:** At first encounter with an encrypted `.fz`, BoardRipper opens an in-app dialog with two options — fetch from a public mirror (the cryptonek/illegal-numbers GitHub repo) or paste manually from any source the user trusts. The supplied bytes are validated against the 44-bit parity fingerprint that upstream OpenBoardView ships, then stored in the user's browser `localStorage`. See `docs/formats/FZ_FORMAT.md` § *Key sourcing* and `src/frontend/src/store/fz-key-store.ts`.
- **Effect:** This puts both the choice and the legal posture of obtaining the key entirely on the end user. Users in jurisdictions where retrieving the key is restricted can decline and continue using BoardRipper's other ten formats normally.
- **DES (FIPS PUB 46-3)** (used in `src/frontend/src/parsers/xzz-parser.ts`): standard FIPS lookup tables (IP, FP, S-boxes, P-box, expansion, PC-1, PC-2) are reproductions of the public specification; key schedule and round function written from the standard.
- **GenCAD 1.4 specification** (used in `src/frontend/src/parsers/cad-parser.ts`): public interchange format specification.

### Material Design Icons — `mdi:soldering-iron`
- **License:** Apache 2.0
- **Upstream:** https://github.com/Templarian/MaterialDesign (curated by Pictogrammers)
- **Used in:** `src/frontend/src/icons/IconSolderingIron.tsx`
- **Nature of use:** The iron silhouette in BoardRipper's `IconSolderingIron` (used as the Worklist "rework" mark) reuses two of the three SVG subpaths from `mdi:soldering-iron` — the handle/plug and the heating-element + tip. The third subpath (cord coil) was dropped and the remaining paths were mirrored horizontally + scaled to 0.92 for layout. Apache-2.0 is GPL-3.0-compatible, so no license-propagation issue.

### Game Icons — `game-icons:soldering-iron` (smoke wisp shape inspiration)
- **License:** CC BY 3.0
- **Upstream:** https://github.com/game-icons/icons (project license: https://creativecommons.org/licenses/by/3.0/)
- **Used in:** `src/frontend/src/icons/IconSolderingIron.tsx`
- **Nature of use:** The smoke-wisp idea above the iron was inspired by the smoke curl in `game-icons:soldering-iron`. No path data is copied verbatim — the wisp in BoardRipper is a hand-traced tapered shape redrawn from scratch with explicit pointy endpoints to fit the 24×24 viewBox. Attribution kept per CC BY 3.0's BY clause.

---

## Runtime Dependencies (npm, bundled at build time)

| Package | License | Role |
|---|---|---|
| react, react-dom | MIT | UI runtime |
| vite | MIT | Build tool, dev server |
| typescript | Apache-2.0 | Type system |
| pixi.js | MIT | WebGL rendering engine |
| pixi-viewport | MIT | Pan/zoom/culling viewport |
| dockview, dockview-react | MIT | Dockable panel system |
| pdfjs-dist | Apache-2.0 | PDF rendering and text extraction (Mozilla) |
| pdf-lib | MIT | PDF manipulation |
| opentype.js | MIT | Font glyph extraction |
| @tabler/icons-react | MIT | UI icon set |

A complete, version-pinned inventory is generated from `src/frontend/package.json`
and `src/frontend/package-lock.json`.

---

## Backend Dependencies (Go)

| Package | License | Role |
|---|---|---|
| Go standard library (net/http, crypto, encoding, …) | BSD-3-Clause | HTTP server, crypto, encoding primitives |
| modernc.org/sqlite | BSD-3-Clause | Pure-Go SQLite driver (board reference database, databank, FTS5 PDF index) |
| github.com/klippa-app/go-pdfium | MIT | PDF text extraction for the FTS5 index (embeds the `pdfium.wasm` blob in the scratch image) |
| github.com/tetratelabs/wazero | Apache-2.0 | Pure-Go WebAssembly runtime hosting `pdfium.wasm` |
| aead.dev/minisign | MIT | Ed25519 update-manifest signature verification (secure self-update) |
| golang.org/x/text | BSD-3-Clause | Unicode NFKC normalisation for watermark matching |

Version-pinned inventory: `src/backend/go.mod`, `src/backend/go.sum`.

---

## Desktop Wrapper Dependencies (Electron)

| Package | License | Role |
|---|---|---|
| electron | MIT | Desktop application shell |
| @electron/packager | MIT | Build pipeline |
| @electron/universal | MIT | macOS universal binary packaging |

Version-pinned inventory: `desktop/package.json`, `desktop/package-lock.json`.

---

## Sample Files

The files under [`samples/`](samples/) are real-world boardview and PDF files
from third-party hardware manufacturers (Apple, ASUS, Quanta, Lenovo, and
others), used as format-compatibility test fixtures. They are not authored by
the BoardRipper project and no copyright is claimed over them. They are
retained here because the corresponding file formats are proprietary and
difficult to reproduce synthetically.

If you are a rights holder and would like a sample file removed, please open
an issue on the BoardRipper GitHub repository and it will be deleted
promptly.

---

## Format Specifications

The documents under [`docs/formats/`](docs/formats/) are original technical
write-ups authored by the BoardRipper project. Where the understanding of a
format was informed by an external reference implementation, that reference
is cited in the document header (see individual format docs for details).

---

## Questions / Corrections

If you believe a source has been omitted, misattributed, or that any part of
BoardRipper violates an upstream license, please open an issue on GitHub.
Attribution corrections are welcomed and handled as priority fixes.
