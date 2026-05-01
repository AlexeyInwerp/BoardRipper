#!/usr/bin/env python3
"""Driver for the local-LLM board classifier.

Pulls Unsorted rows from Board Database/boards.db, queries DuckDuckGo (or
Bing) HTML for each, feeds the snippets to a local Ollama daemon running
qwen3:8b (configurable), and writes a JSON file in the format
scripts/apply-research-findings.py consumes:

  {
    "<board_number>": {"brand": "...", "family": "...", "model": "..."},
    "<board_number>": null,
    ...
  }

The classifier never asks for confirmation — the user wanted full
autonomy. Defaults are tuned to be polite + cheap:
  - 1.5 s throttle between web searches
  - confidence gate: anything < 0.5 is recorded as null
  - resumable: rows already tagged `researched:` in their notes are
    skipped on subsequent runs

When Ollama is unavailable, --no-llm runs a regex fallback against the
search snippets — same brand vocabulary, no family/model. Useful for
proving the search half works on a machine without local inference.

CLI:
  python3 scripts/llm-classify-unsorted.py [flags]

Typical run on full residue:
  python3 scripts/llm-classify-unsorted.py --out /tmp/findings.json
  python3 scripts/apply-research-findings.py --json /tmp/findings.json
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
import urllib.error
from collections import Counter
from pathlib import Path

# Make `lib` importable when run from repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import board_search, board_llm  # type: ignore  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "Board Database/boards.db"


# ─── Regex fallback (for --no-llm) ──────────────────────────────────────


# Reuse the same brand keyword table the offline classifier uses.
BRAND_KW: list[tuple[str, list[str]]] = [
    ("Lenovo",    ["lenovo", "thinkpad", "ideapad", "yoga", "legion",
                   "thinkbook", "thinkcentre", "lenog", "联想"]),
    ("HP",        ["hewlett-packard", "hewlett packard", "hp pavilion",
                   "hp envy", "hp probook", "hp elitebook", "hp omen",
                   "hp compaq", "hp spectre", "hp stream", "hp zbook",
                   "elitebook", "probook", "spectre", "zbook",
                   "pavilion", "compaq", "惠普"]),
    ("Acer",      ["acer", "aspire", "extensa", "travelmate", "predator",
                   "nitro", "swift", "spin", "ferrari", "宏碁", "宏基"]),
    ("Dell",      ["dell ", "inspiron", "latitude", "vostro", "precision",
                   "alienware", "studio xps", "戴尔"]),
    ("ASUS",      ["asus", "zenbook", "vivobook", "rog ", "tuf gaming",
                   "expertbook", "chromebook", "华硕"]),
    ("Toshiba",   ["toshiba", "satellite", "tecra", "qosmio", "portege",
                   "dynabook", "东芝"]),
    ("Fujitsu",   ["fujitsu", "fujistu", "lifebook", "stylistic",
                   "esprimo", "celsius", "富士通"]),
    ("Samsung",   ["samsung", "三星"]),
    ("Sony",      ["sony", "vaio"]),
    ("Apple",     ["macbook", "imac", "mac mini", "iphone", "ipad",
                   "苹果"]),
]


def regex_brand_from_text(text: str) -> str | None:
    fl = text.lower()
    best, best_len = None, 0
    for brand, kws in BRAND_KW:
        for k in kws:
            if k in fl and len(k) > best_len:
                best, best_len = brand, len(k)
    return best


# ─── Filename-list mode helpers ─────────────────────────────────────────


# Map regex pattern name → ODM/source label fed to the LLM. Mirrors
# scan-board-filenames.py's `owner` field but normalized to ODMs where
# applicable (some patterns name a brand, others an ODM; for the LLM
# hint we want the manufacturer of the bare PCB).
_PATTERN_ODM = {
    "apple_820":      "Apple",
    "compal_la":      "Compal",
    "lcfc_nm":        "LCFC",
    "quanta_da0":     "Quanta",
    "msi_ms":         "MSI",
    "asus_60nr":      "ASUS",
    "oem_6050":       "Foxconn",
    "apple_a_number": "Apple",
}


def _load_scan_module():
    """Import scan-board-filenames.py (hyphenated, not directly importable)
    so we can reuse its compiled regex patterns."""
    from importlib import util as _u
    p = Path(__file__).resolve().parent / "scan-board-filenames.py"
    spec = _u.spec_from_file_location("scan_board_filenames", str(p))
    mod = _u.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def rows_from_filename_list(
    path: Path, limit: int = 0,
) -> list[tuple[str, str | None, str]]:
    """Returns [(board_number, sample_filename, odm)] extracted from an
    arbitrary filename list. Accepts either:

      - plain text: one filename per line
      - JSON list of objects: e.g. /api/databank/files output, where
        each entry has at least `filename` and optionally `path`,
        `extension`, `resolution_status`. Already-resolved entries
        (resolution_status == 'resolved') are skipped.
    """
    raw = path.read_text(encoding="utf-8", errors="replace")
    # Each entry: (board_number_or_None, filename, odm_or_None) — the
    # latter two come straight from the NAS API when available, since
    # the backend's regex set is broader than ours (e.g. Wistron
    # XXXXX-N codes are extracted server-side but not by the Python
    # patterns).
    typed_entries: list[tuple[str | None, str, str | None]] = []

    raw_stripped = raw.lstrip()
    if raw_stripped.startswith("[") or raw_stripped.startswith("{"):
        # JSON. Could be a list, or an object with a `files` key (some
        # API wrappers do that).
        data = json.loads(raw)
        if isinstance(data, dict):
            data = data.get("files") or data.get("items") or []
        if not isinstance(data, list):
            print("FATAL: --filenames-from JSON must be a list (or "
                  "{files: [...]} wrapper)", file=sys.stderr)
            sys.exit(1)
        for entry in data:
            if isinstance(entry, str):
                typed_entries.append((None, entry, None))
                continue
            if not isinstance(entry, dict):
                continue
            # Skip already-resolved files.
            if entry.get("resolution_status") == "resolved":
                continue
            name = entry.get("filename") or entry.get("path") or entry.get("name")
            if not name:
                continue
            typed_entries.append((
                (entry.get("board_number") or None),
                name,
                (entry.get("board_manufacturer") or entry.get("manufacturer") or None),
            ))
    else:
        for line in raw.splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                typed_entries.append((None, line, None))

    scan_mod = _load_scan_module()
    rows: list[tuple[str, str | None, str]] = []
    seen: set[str] = set()  # dedupe by board_number
    for bn_hint, fname, odm_hint in typed_entries:
        basename = fname.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        board_number: str | None = (bn_hint or "").strip() or None
        odm: str | None = odm_hint
        if not board_number:
            # Fall back to local regex extraction.
            matches = scan_mod.extract_matches(basename)
            if not matches:
                continue
            for pat in scan_mod.PATTERNS:
                key = pat[0]
                if key in matches and matches[key]:
                    board_number = sorted(matches[key])[0]
                    odm = odm or _PATTERN_ODM.get(key, "Unknown")
                    break
        if not board_number or board_number in seen:
            continue
        seen.add(board_number)
        rows.append((board_number, basename, odm or "Unknown"))
        if limit and len(rows) >= limit:
            break
    return rows


# ─── DB helpers ─────────────────────────────────────────────────────────


def list_unsorted_rows(
    conn: sqlite3.Connection,
    odm_filter: list[str] | None,
    skip_already_tried: bool,
    limit: int,
) -> list[tuple[str, str | None, str]]:
    """Returns list of (board_number, sample_filename, odm)."""
    sql = """
        SELECT b.board_number, b.notes, f.name AS odm
        FROM boards b
        JOIN models m ON b.model_uuid = m.uuid
        JOIN families f ON m.family_uuid = f.uuid
        JOIN brands br ON f.brand_uuid = br.uuid
        WHERE br.name = 'Unsorted'
    """
    args: list = []
    if odm_filter:
        placeholders = ",".join("?" * len(odm_filter))
        sql += f" AND f.name IN ({placeholders})"
        args.extend(odm_filter)
    sql += " ORDER BY f.name, b.board_number"
    if limit > 0:
        sql += " LIMIT ?"
        args.append(limit)

    rows = conn.execute(sql, args).fetchall()

    out: list[tuple[str, str | None, str]] = []
    for board_number, notes, odm in rows:
        if skip_already_tried and notes and "researched:" in notes:
            continue
        sample = None
        if notes:
            m = re.search(r"sample:(.+?)(?:\s*;|\s*$)", notes)
            if m:
                sample = m.group(1).strip()
        out.append((board_number, sample, odm))
    return out


# ─── Per-board pipeline ─────────────────────────────────────────────────


def build_query(board_number: str, sample_filename: str | None) -> str:
    """Add a hint token from the sample filename if it looks model-y."""
    base = f'"{board_number}" laptop motherboard'
    if not sample_filename:
        return base
    # Strip extension and the board code itself, then take the first
    # non-numeric token of length ≥ 3 as a hint.
    stem = re.sub(r"\.[a-zA-Z0-9]{2,5}$", "", sample_filename)
    stem = stem.replace(board_number, " ")
    tokens = re.split(r"[\s_\-+,()\[\]]+", stem)
    for tok in tokens:
        if len(tok) >= 3 and not tok.isdigit() and not re.match(r"\d", tok):
            return f"{base} {tok}"
    return base


def classify_one(
    board_number: str,
    sample_filename: str | None,
    odm: str,
    *,
    backend: str,
    throttle_s: float,
    use_llm: bool,
    no_search: bool,
    ollama_host: str,
    ollama_model: str,
    confidence_floor: float,
    verbose: bool,
) -> dict | None:
    if no_search:
        # Filename-only classification — local Ollama gets just the
        # board code, the sample filename, and the ODM hint. Useful when
        # the search backend is exhausted/unavailable, or when the
        # filename itself is rich enough (brand + model spelled out) to
        # not need web evidence.
        results = []
    else:
        query = build_query(board_number, sample_filename)
        try:
            results = board_search.search(
                query, limit=8, backend=backend, throttle_s=throttle_s
            )
        except urllib.error.HTTPError as e:
            if verbose:
                print(f"  ! search HTTPError on {board_number}: {e}", file=sys.stderr)
            return None
        except Exception as e:
            if verbose:
                print(f"  ! search error on {board_number}: {e}", file=sys.stderr)
            return None

    if not use_llm:
        text = " ".join(
            f"{r.title} {r.snippet}" for r in results
        )
        b = regex_brand_from_text(text)
        if not b:
            return None
        return {"brand": b, "family": None, "model": None}

    cls = board_llm.classify(
        board_number,
        sample_filename,
        odm,
        results,
        model=ollama_model,
        host=ollama_host,
    )
    if verbose:
        print(
            f"  ◦ {board_number} [{odm}] → "
            f"brand={cls.brand!r} family={cls.family!r} "
            f"model={cls.model_number!r} conf={cls.confidence:.2f} "
            f"({cls.reasoning[:80]})"
        )
    if cls.brand is None or cls.confidence < confidence_floor:
        return None
    return {
        "brand": cls.brand,
        "family": cls.family,
        "model": cls.model_number,
    }


# ─── Driver ─────────────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", type=Path, default=DEFAULT_DB)
    p.add_argument("--out", type=Path, default=Path("research-output.json"))
    p.add_argument("--limit", type=int, default=0,
                   help="0 = all (default).")
    p.add_argument("--odm", default="",
                   help="Comma-separated ODM names (e.g. Compal,Quanta).")
    p.add_argument("--resume", action="store_true",
                   help="Skip rows whose notes already contain 'researched:'.")
    p.add_argument("--throttle-s", type=float, default=1.5)
    p.add_argument("--search-backend", choices=("tavily", "mojeek", "ddg", "bing"), default="tavily")
    p.add_argument("--ollama-host", default="http://localhost:11434")
    p.add_argument("--ollama-model", default="qwen3:8b")
    p.add_argument("--confidence-floor", type=float, default=0.5)
    p.add_argument("--no-llm", action="store_true",
                   help="Regex on snippets only; brand-only output.")
    p.add_argument("--no-search", action="store_true",
                   help="Skip the web-search step. The local LLM gets just the "
                        "board code, sample filename, and ODM hint — no snippets. "
                        "Use when the search backend is exhausted.")
    p.add_argument("--filenames-from", type=Path,
                   help="Bypass the boards.db Unsorted query and instead extract "
                        "board codes from an arbitrary list of filenames. Accepts "
                        "either plain text (one filename per line) or a JSON list "
                        "of objects (e.g. /api/databank/files output) — board codes "
                        "are extracted via the same regex set scan-board-filenames "
                        "uses. Output JSON is keyed by extracted board code; pair "
                        "with apply-research-findings.py --insert-missing to write "
                        "fresh board records into boards.db.")
    p.add_argument("--dry-run", action="store_true",
                   help="Search + classify but do not write the JSON.")
    p.add_argument("--verbose", action="store_true")
    p.add_argument("--flush-every", type=int, default=25,
                   help="Persist intermediate JSON every N boards.")
    args = p.parse_args()

    if not args.filenames_from and not args.db.exists():
        print(f"FATAL: {args.db} not found", file=sys.stderr)
        return 1

    if args.filenames_from:
        rows = rows_from_filename_list(args.filenames_from, limit=args.limit)
        print(f"filenames in scope: {len(rows)}")
    else:
        conn = sqlite3.connect(str(args.db))
        rows = list_unsorted_rows(
            conn,
            odm_filter=[s.strip() for s in args.odm.split(",") if s.strip()] or None,
            skip_already_tried=args.resume,
            limit=args.limit,
        )
        conn.close()
        print(f"residue rows in scope: {len(rows)}")
    if not rows:
        return 0

    findings: dict[str, dict | None] = {}
    by_brand: Counter = Counter()
    null_count = 0
    started = time.monotonic()

    def _flush() -> None:
        if args.dry_run:
            return
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(findings, indent=2, ensure_ascii=False))

    try:
        for i, (board_number, sample, odm) in enumerate(rows, start=1):
            res = classify_one(
                board_number,
                sample,
                odm,
                backend=args.search_backend,
                throttle_s=args.throttle_s,
                use_llm=not args.no_llm,
                no_search=args.no_search,
                ollama_host=args.ollama_host,
                ollama_model=args.ollama_model,
                confidence_floor=args.confidence_floor,
                verbose=args.verbose,
            )
            findings[board_number] = res
            if res is None:
                null_count += 1
            else:
                by_brand[res["brand"]] += 1

            if i % args.flush_every == 0:
                _flush()
                rate = i / max(time.monotonic() - started, 0.001)
                print(
                    f"  [{i}/{len(rows)}]  matched={sum(by_brand.values())} "
                    f"null={null_count}  {rate:.2f} boards/s"
                )
        _flush()
    except KeyboardInterrupt:
        print("\ninterrupted — flushing partial findings…", file=sys.stderr)
        _flush()
        return 130

    print()
    print("classify summary:")
    print(f"  total boards:           {len(rows)}")
    print(f"  matched (brand found):  {sum(by_brand.values())}")
    print(f"  null  (no match):       {null_count}")
    if by_brand:
        print()
        print("  by brand:")
        for b, n in by_brand.most_common():
            print(f"    {b:<14} {n:>5}")
    if not args.dry_run:
        print()
        print(f"  output JSON: {args.out}")
        print(
            "  next:  python3 scripts/apply-research-findings.py --json "
            f"{args.out}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
