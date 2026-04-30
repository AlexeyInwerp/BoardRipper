#!/usr/bin/env python3
"""Evaluate the local-LLM classifier against ground truth.

Picks a sample of already-classified boards (boards whose current brand
is NOT 'Unsorted'), drops them through the same search → LLM pipeline as
the real driver, and reports brand-level agreement.

Useful before unleashing the classifier on the residue: if it can't
recover the brand on a board it's already supposed to know, the prompt
or model needs work.

Outputs:
  - one-line summary: brand-agreement rate, per-brand precision
  - --dump-disagreements: writes a CSV of (board_number, expected,
    predicted, confidence, top_snippet_title) for inspection

This doesn't write to the DB. The eval is purely read-only.
"""

from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import board_search, board_llm  # type: ignore  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "Board Database/boards.db"


def sample_ground_truth(
    conn: sqlite3.Connection,
    n: int,
    brands: list[str] | None,
) -> list[tuple[str, str, str, str | None]]:
    """Return [(board_number, expected_brand, odm_family_name, sample_filename)].

    odm_family_name is the *family* row's name — for boards we promoted
    out of Unsorted, the ODM info is preserved as the family name under
    the new brand. This is best-effort context for the prompt.
    """
    sql = """
        SELECT b.board_number, br.name AS brand, f.name AS family, b.notes
        FROM boards b
        JOIN models m ON b.model_uuid = m.uuid
        JOIN families f ON m.family_uuid = f.uuid
        JOIN brands br ON f.brand_uuid = br.uuid
        WHERE br.name != 'Unsorted'
    """
    args: list = []
    if brands:
        placeholders = ",".join("?" * len(brands))
        sql += f" AND br.name IN ({placeholders})"
        args.extend(brands)
    sql += " ORDER BY random() LIMIT ?"
    args.append(n)
    rows = conn.execute(sql, args).fetchall()

    out = []
    for board_number, brand, family, notes in rows:
        sample = None
        if notes:
            import re
            m = re.search(r"sample:(.+?)(?:\s*;|\s*$)", notes)
            if m:
                sample = m.group(1).strip()
        # The "ODM" field we hand the LLM is best-guess — for self-
        # identifying brand families (MS-codes under MSI, etc.) we keep
        # the family name verbatim. For brands where family is already
        # consumer-facing (ThinkPad, Pavilion), fall back to a generic
        # marker.
        odm_hint = family if any(family.lower().startswith(o) for o in (
            "compal", "quanta", "lcfc", "foxconn", "msi", "asus", "apple",
            "(self-identified", "(researched"
        )) else "(brand-curated)"
        out.append((board_number, brand, odm_hint, sample))
    return out


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", type=Path, default=DEFAULT_DB)
    p.add_argument("--limit", type=int, default=100)
    p.add_argument("--brands", default="",
                   help="Comma-separated brand allow-list "
                        "(default: any brand).")
    p.add_argument("--throttle-s", type=float, default=1.5)
    p.add_argument("--search-backend", choices=("mojeek", "ddg", "bing"), default="mojeek")
    p.add_argument("--ollama-host", default="http://localhost:11434")
    p.add_argument("--ollama-model", default="qwen3:8b")
    p.add_argument("--no-llm", action="store_true",
                   help="Regex-on-snippets baseline.")
    p.add_argument("--dump-disagreements", type=Path,
                   help="CSV of board × expected × predicted on disagreement.")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    if not args.db.exists():
        print(f"FATAL: {args.db} not found", file=sys.stderr)
        return 1

    conn = sqlite3.connect(str(args.db))
    sample = sample_ground_truth(
        conn,
        n=args.limit,
        brands=[s.strip() for s in args.brands.split(",") if s.strip()] or None,
    )
    conn.close()
    print(f"eval set: {len(sample)} boards")
    if not sample:
        return 0

    correct = 0
    null_predictions = 0
    by_expected: Counter = Counter()
    correct_by_expected: Counter = Counter()
    confusion: dict[str, Counter] = defaultdict(Counter)
    disagreements: list[dict] = []

    for board_number, expected_brand, odm_hint, sample_filename in sample:
        by_expected[expected_brand] += 1

        try:
            results = board_search.search(
                f'"{board_number}" laptop motherboard',
                limit=8,
                backend=args.search_backend,
                throttle_s=args.throttle_s,
            )
        except Exception as e:
            results = []
            if args.verbose:
                print(f"  ! search error on {board_number}: {e}",
                      file=sys.stderr)

        if args.no_llm:
            # Inline the regex baseline so this script doesn't depend on
            # the dashed module name being importable.
            from importlib import util as _import_util
            spec = _import_util.spec_from_file_location(
                "llm_classify_unsorted",
                str(Path(__file__).parent / "llm-classify-unsorted.py"),
            )
            mod = _import_util.module_from_spec(spec)  # type: ignore[arg-type]
            spec.loader.exec_module(mod)  # type: ignore[union-attr]
            text = " ".join(f"{r.title} {r.snippet}" for r in results)
            predicted = mod.regex_brand_from_text(text)
            confidence = 1.0 if predicted else 0.0
        else:
            cls = board_llm.classify(
                board_number,
                sample_filename,
                odm_hint,
                results,
                model=args.ollama_model,
                host=args.ollama_host,
            )
            predicted = cls.brand
            confidence = cls.confidence

        if predicted is None:
            null_predictions += 1

        if predicted == expected_brand:
            correct += 1
            correct_by_expected[expected_brand] += 1
        else:
            confusion[expected_brand][predicted or "(null)"] += 1
            disagreements.append({
                "board_number": board_number,
                "expected": expected_brand,
                "predicted": predicted or "",
                "confidence": f"{confidence:.2f}",
                "top_snippet_title": (results[0].title if results else ""),
            })

        if args.verbose:
            mark = "✓" if predicted == expected_brand else "✗"
            print(f"  {mark} {board_number:<16} expected={expected_brand:<10} "
                  f"got={predicted or '(null)':<10} conf={confidence:.2f}")

    print()
    print("eval summary:")
    print(f"  total:               {len(sample)}")
    print(f"  agree:               {correct}  ({correct/len(sample):.1%})")
    print(f"  null predictions:    {null_predictions}")
    print()
    print("  per-brand recall (correctly identified / appearances):")
    for br, n in by_expected.most_common():
        rec = correct_by_expected[br] / n if n else 0.0
        print(f"    {br:<14} {correct_by_expected[br]:>3} / {n:<3}  "
              f"({rec:.0%})")
    if confusion and args.verbose:
        print()
        print("  top confusions:")
        for expected, mistakes in confusion.items():
            for predicted, c in mistakes.most_common(2):
                print(f"    {expected:<10} → {predicted:<14} {c}×")

    if args.dump_disagreements and disagreements:
        args.dump_disagreements.parent.mkdir(parents=True, exist_ok=True)
        with args.dump_disagreements.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(
                fh,
                fieldnames=[
                    "board_number", "expected", "predicted",
                    "confidence", "top_snippet_title",
                ],
            )
            w.writeheader()
            w.writerows(disagreements)
        print(f"  disagreements CSV: {args.dump_disagreements}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
