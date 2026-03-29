# How John Beard Reverse-Engineered the Cadence Allegro BRD Format

## Overview

John Beard wrote KiCad 10's Allegro BRD importer over 11 months (Apr 2025 – Mar 2026): ~460KB of C++ across 12 files, 164 commits, parsing a proprietary binary format spanning versions 16.0–18.0+. This document extracts his methodology as a reusable framework for binary format reverse engineering.

## The Nine Phases

### Phase 0: Prior Art Survey (before first commit)

**What he did:** Found an existing GPL implementation (likely OpenBoardView) and extracted its struct layouts into a Kaitai Struct format description file (.ksy). Established clean-room-adjacent IP provenance — explicitly documented: "no Allegro installation was used", "no non-free copyrighted information was used."

**Key insight:** Don't start from zero. Prior art gives you the byte-level scaffolding. The legal documentation matters — he wrote a WORKLOG establishing provenance from day one.

**Artifacts:** `allegro_brd.ksy` (2,015 lines), WORKLOG preamble with IP declarations.

---

### Phase 1: Format Exploration with Declarative Tooling (17 days)

**What he did:** Used the Kaitai Struct .ksy file for interactive exploration — Kaitai compiles format descriptions into parsers, visualizers, and hex-overlay tools. This let him map out magic numbers, the file header, string table structure, and block type tags without writing any C++ yet.

**Key insight:** Invest in exploration tooling before writing production code. A declarative format description (.ksy, 010 Editor templates, Wireshark dissectors) lets you iterate on understanding without compiling anything.

**Artifacts:** `.ksy` file, visual hex exploration.

---

### Phase 2: Dual-Tool Bootstrap (same period)

**What he did:** Built TWO tools in parallel:
- **Python CLI** (Kaitai-based): For rapid interactive exploration — dump linked lists, decode fields at specific offsets, cross-reference pointer chains. Disposable.
- **C++ parser**: The production implementation destined for KiCad.

**Key insight:** Use a scripting language for discovery, a compiled language for production. The Python tool was explicitly described as needed because "it's a little awkward to use the C++ version experimentally." Both tools were deleted before merge — they were scaffolding.

**Artifacts:** Python CLI (`allegro_cli/`), C++ CLI with block-count and key-lookup functions.

---

### Phase 3: Block-by-Block Skeleton — "The Blitz" (1 day, 22 commits)

**What he did:** In a single marathon session (03:00–14:00), he implemented all ~35 block types. Each commit adds exactly one block type: "implement 0x09", "implement 0x0D", "implement 0x32 placed pad". No semantic interpretation — just "can I read the correct number of bytes for each block type?"

**Key insight:** The first milestone is *structural completeness*: can you consume the entire file without the stream position going wrong? Since blocks have no length prefix, getting one wrong corrupts all subsequent reads. Progress was measured by file offset: "brings PreAmp to 0x276e0, next is 0x0C."

**Evidence of the pattern:**
- 20+ commits in 11 hours, each touching one block
- Commit messages are just hex type tags
- No business logic — pure byte-level field reads
- Unknown fields named `m_Unknown1`, `m_Unknown2`, etc. (preserved, not skipped)

---

### Phase 4: First Vertical Slice (10 days)

**What he did:** Got one real board file (BeagleBone AI) importing footprints into KiCad, however badly. Then progressively: layers, nets, tracks, vias. Each feature tested against 2–3 real boards (BeagleBone AI, Kinoma Create V164, CutiePi v2).

**Key insight:** Vertical slice over horizontal coverage. "Get footprints importing" teaches you more about the format than parsing 100 more fields. The commits reveal progressive understanding: "Figured out the cadence FP type", "0x15 is H line, 0x17 is V, and 0x16 is neither."

**Dual-tool synergy:** The Python CLI was used heavily here for decoding experiments, while the C++ code imported the results. Commits alternate between Python exploration and C++ implementation.

---

### Phase 5: Architectural Rework — The DB Object IR (3 months, sporadic)

**What he did:** After deeply understanding the format, he restructured from direct binary→KiCad conversion into a three-layer pipeline:

```
Binary bytes → Parse → Raw Block Structs → Object DB (with resolved refs) → KiCad Board
```

This mirrors how Allegro itself stores data: as a relational database of keyed objects with cross-references.

**Key insight:** The first architecture is always wrong. You can't design the right abstraction until you've decoded enough of the format to see its internal logic. The 4-month gap (May–Sep) between Phases 4 and 5 was deliberate — he needed distance to see the pattern.

**The three layers:**
1. **Binary parsing** (`allegro_parser.cpp`): Raw bytes → typed C++ structs. Each block's fields read explicitly, never bulk memcpy.
2. **Object database** (`allegro_db.cpp`): Structs → relational in-memory DB. Cross-references (uint32 keys) become resolved pointers in a single post-parse pass.
3. **Board construction** (`allegro_builder.cpp`): Resolved DB → KiCad objects. Coordinate scaling, layer mapping, zone fills.

**Innovation — version-conditional fields at the type level:**
```cpp
COND_GE<FMT_VER::V_172, uint32_t> m_Previous;   // Only in >= 17.2
COND_LT<FMT_VER::V_172, uint32_t> m_StrPtr16x;  // Only in < 17.2
```
This eliminates scattered `if (version >= X)` branches. The struct itself documents version dependencies.

---

### Phase 6: Cross-Validation Infrastructure

**What he did:** Wrote a PEGTL parser for Allegro's ASCII export format (.alg), then built 45+ automated tests comparing binary parse results against ASCII ground truth. Tracked warning counts as a quality metric: "BB 3909→40, EVK 4929→153."

**Key insight:** Find an independent source of truth. Allegro can export ASCII .alg files that describe the same data as the binary .brd. By parsing both and comparing, you get automated verification without needing Allegro itself.

---

### Phase 7: Hardening via Fuzzing (2 weeks)

**What he did:** Integrated the parser with AFL fuzzer. Immediately found 3 crash bugs. Then systematically: bounds-check every untrusted u32, guard against allocation bombs, add loop detection in linked list traversal, validate resolved pointer types.

**Key insight:** Correctness and robustness are separate phases. Get it correct first (Phases 3–6), then harden against adversarial input. Seth Hillbrand fixed 6 null-deref/overflow bugs in a single night (03:06–03:32 on 2026-02-17) — concentrated hardening is more effective than sprinkling guards during development.

**Specific hardening patterns:**
- Cap `reserve()` calls to prevent allocation bombs from corrupt headers
- Sentinel key sets for V18+ linked list terminators
- `std::set<uint32_t>` visited keys for loop detection
- Type validation after reference resolution (`CheckTypeIs`, `CheckTypeIsOneOf`)

---

### Phase 8: Multi-Developer Collaboration (6 weeks)

**What he did:** Seth Hillbrand (KiCad lead) joined and focused on production quality: coordinate accuracy, pad shapes, zone fills, layer mapping, netclass import, automated tests. Alex Shvartzkop contributed targeted fixes (zone fill detection, arc endpoints, MSVC build).

**Role separation:**
- **John Beard** = format archaeologist (understands the binary layout, names the unknowns)
- **Seth Hillbrand** = production engineer (makes coordinates precise, zones correct, tests comprehensive)
- **Alex Shvartzkop** = specialist contributor (targeted geometry fixes)

---

### Phase 9: Cleanup Before Merge

**What he did:** Removed ALL development scaffolding: WORKLOG, .ksy file, Python CLI, C++ CLI, dump scripts. What remained was the clean three-layer architecture plus FORMAT.md documentation.

**Key insight:** Scaffolding is not code. The .ksy file, Python CLI, and WORKLOG served their purpose during exploration and were deleted. The knowledge they contained was distilled into C++ struct comments, `COND_FIELD` annotations, and FORMAT.md.

---

## The Ten Principles

| # | Principle | Evidence |
|---|-----------|----------|
| 1 | **Explore before committing** | Kaitai + Python before C++. 17 days of exploration before production code. |
| 2 | **One block type per commit** | 22 commits on the blitz day. Atomic, reviewable, bisectable. |
| 3 | **Real files from day one** | BeagleBone AI, Kinoma, CutiePi — always parsing actual boards. |
| 4 | **Name the unknowns, never skip them** | `m_Unknown1`–`m_Unknown12` throughout. Preserve structure even without understanding. |
| 5 | **Measure progress by file offset** | "brings PreAmp to 0x276e0" — how far can I parse without corruption? |
| 6 | **Vertical slices over horizontal coverage** | "Get footprints importing" before parsing every field. |
| 7 | **The first architecture is wrong** | Direct conversion → three-layer pipeline (parse → DB → output) after 4 months. |
| 8 | **Version conditionals at the type level** | `COND_GE<V_172>` in structs, not `if` branches in parsers. |
| 9 | **Cross-validate against independent sources** | ASCII export (.alg) as ground truth, 45+ automated comparison tests. |
| 10 | **Scaffolding is disposable** | .ksy, Python CLI, WORKLOG all deleted before merge. |

---

## Timeline Summary

| Phase | Duration | Commits | Focus |
|-------|----------|---------|-------|
| 0. Prior Art | Pre-project | — | GPL source, legal provenance |
| 1. Exploration | 17 days | 7 | Kaitai .ksy, format mapping |
| 2. Dual-Tool | Concurrent | — | Python CLI + C++ parser |
| 3. Block Blitz | 1 day | 22 | All block types, byte-level |
| 4. Vertical Slice | 10 days | 31 | Footprints → nets → tracks |
| 5. Architecture | 3 months | 13 | DB object IR, three-layer pipeline |
| 6. Cross-Validation | Ongoing | 18 | ASCII ground truth, 45+ tests |
| 7. Hardening | 2 weeks | 22 | Fuzzing, bounds checks, loop detection |
| 8. Collaboration | 6 weeks | 40+ | Coordinates, zones, pads, polish |
| 9. Cleanup | Final | 9 | Remove scaffolding, FORMAT.md |

**Total: 164 commits, 11 months, 3 developers, ~460KB C++**
