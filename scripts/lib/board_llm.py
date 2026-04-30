"""Ollama HTTP client — talks to a locally-running Ollama daemon to
classify a single board into {brand, family, model_number, confidence}
given a board code, optional sample filename, ODM hint, and a handful of
search-result snippets pulled by board_search.

Stdlib only (urllib + json). Default endpoint is http://localhost:11434
(Ollama's default). The model is qwen3:8b unless overridden;
swap to phi-4:14b or llama3.3:70b-instruct for higher recall.

Public surface:

    classify(board_number, sample_filename, odm, search_results,
             model="qwen3:8b",
             host="http://localhost:11434",
             timeout=60.0) -> Classification

The function never raises on a malformed model response — it returns
Classification(brand=None, ..., reasoning=<error string>) so the driver
can log and move on. Out-of-vocabulary brands are coerced to None as
well; the upstream apply step expects only the canonical brand list.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Iterable, Optional

# Mirrors the consumer-brand vocabulary in
# scripts/classify-unsorted-boards.py. Keep these two in sync.
ALLOWED_BRANDS: tuple[str, ...] = (
    "Lenovo", "HP", "Dell", "Acer", "ASUS", "Toshiba", "Fujitsu",
    "Apple", "MSI", "Samsung", "LG", "Sony", "Razer", "Huawei", "Xiaomi",
    "Microsoft", "Gigabyte", "Clevo", "Medion", "Panasonic", "Mechrevo",
    "Hasee", "Tongfang", "Haier", "Founder", "Eurocom", "Origin PC",
    "System76", "Avita", "Vaio",
    # Older / regional consumer brands seen in the residue:
    "BenQ", "Gateway", "NEC", "Packard Bell", "Compaq", "Sharp",
    "Sager", "Schenker", "Tuxedo", "Honor", "DEXP", "Chuwi",
    "Teclast", "Jumper", "Realme", "Olivetti", "Mio",
)


@dataclass
class Classification:
    brand: Optional[str]
    family: Optional[str]
    model_number: Optional[str]
    confidence: float
    reasoning: str  # log-only; never persisted to DB


_SYSTEM_PROMPT = """You classify laptop motherboard PCB codes.

Given:
  - a board code (Compal LA-XXX, Quanta DA0XXX, LCFC NM-XXX, Foxconn
    6050AXXX, ASUS 60NRXX, MSI MS-XXX, Apple 820-XXX, …)
  - the sample filename it was first observed in (often contains brand
    info in English or Chinese)
  - the ODM family (manufacturer hint)
  - up to 8 web-search snippets harvested from eBay, Amazon, Aliexpress,
    repair forums, etc.

Decide which consumer-brand laptop this PCB belongs to, and — when the
snippets clearly say so — its product family and specific model.

Rules, in priority order:
  1. brand MUST come from this list (or be null): {brands}.
  2. Use null for brand when the snippets disagree, are too generic, or
     don't actually reference this exact code. Don't guess from the ODM
     alone — Compal/Quanta/Foxconn each build for many brands.
  3. family is the consumer product line — ThinkPad, IdeaPad, Yoga,
     Legion, Pavilion, EliteBook, ProBook, Aspire, Inspiron, Latitude,
     XPS, Zenbook, Vivobook, ROG, Satellite, Tecra, MacBook Pro, MacBook
     Air, iMac, Mac mini, etc. null when not in snippets.
  4. model_number is the specific machine — T420, P52, Z500, X1 Carbon,
     "15-cw0xxx", "A715-72G", "MX350", "A2779". Use whatever the seller
     listing actually says. null when not in snippets.
  5. confidence ∈ [0,1]. ≥ 0.8 = multiple snippets agree explicitly.
     0.5–0.8 = one strong snippet. < 0.5 = guess; the caller will treat
     this as null.
  6. Be brief. reasoning is one short sentence describing the strongest
     snippet evidence.

Output STRICT JSON, no prose, schema:
  {{
    "brand": <string|null>,
    "family": <string|null>,
    "model_number": <string|null>,
    "confidence": <number>,
    "reasoning": <string>
  }}"""


_USER_TMPL = """board_number: {board_number}
sample_filename: {sample_filename}
odm: {odm}
search_results:
{snippets}"""


_JSON_SCHEMA = {
    "type": "object",
    "required": ["brand", "family", "model_number", "confidence", "reasoning"],
    "properties": {
        "brand":         {"type": ["string", "null"]},
        "family":        {"type": ["string", "null"]},
        "model_number":  {"type": ["string", "null"]},
        "confidence":    {"type": "number", "minimum": 0.0, "maximum": 1.0},
        "reasoning":     {"type": "string", "maxLength": 280},
    },
}


def _format_snippets(results: Iterable) -> str:
    lines: list[str] = []
    for i, r in enumerate(results, start=1):
        title = (getattr(r, "title", "") or "").strip()
        snippet = (getattr(r, "snippet", "") or "").strip()
        # Trim each result so a single noisy page doesn't blow context.
        if len(snippet) > 320:
            snippet = snippet[:320] + "…"
        lines.append(f"  {i}. {title}\n     {snippet}")
    if not lines:
        return "  (no search results)"
    return "\n".join(lines)


def _coerce_brand(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    norm = raw.strip()
    if not norm:
        return None
    # Case-fold compare against allow-list. Accept canonical forms only.
    norm_lc = norm.lower()
    for canonical in ALLOWED_BRANDS:
        if canonical.lower() == norm_lc:
            return canonical
    # Common aliases
    aliases = {
        "asustek": "ASUS", "asus tek": "ASUS",
        "hewlett-packard": "HP", "hewlett packard": "HP",
        "lenovo group": "Lenovo",
        "dell technologies": "Dell", "dell inc": "Dell", "dell inc.": "Dell",
    }
    return aliases.get(norm_lc)


def classify(
    board_number: str,
    sample_filename: Optional[str],
    odm: str,
    search_results: Iterable,
    model: str = "qwen3:8b",
    host: str = "http://localhost:11434",
    timeout: float = 60.0,
) -> Classification:
    sys_prompt = _SYSTEM_PROMPT.format(brands=", ".join(ALLOWED_BRANDS))
    user_msg = _USER_TMPL.format(
        board_number=board_number,
        sample_filename=sample_filename or "(none)",
        odm=odm or "(unknown)",
        snippets=_format_snippets(search_results),
    )

    payload = {
        "model": model,
        "stream": False,
        "format": _JSON_SCHEMA,
        # Qwen 3 emits a chain-of-thought "thinking" block by default,
        # which burns the per-call token budget before any JSON appears.
        # Disable it for this structured-output use case.
        "think": False,
        "options": {
            "temperature": 0.1,
            "top_p": 0.9,
            "num_predict": 256,
        },
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user",   "content": user_msg + "\n/no_think"},
        ],
    }

    req = urllib.request.Request(
        host.rstrip("/") + "/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        return Classification(None, None, None, 0.0, f"ollama unreachable: {e}")
    except Exception as e:
        return Classification(None, None, None, 0.0, f"ollama error: {e}")

    raw = (body.get("message") or {}).get("content") or ""
    # qwen3 occasionally prefixes thinking tags; strip everything before the
    # first '{'.
    m = re.search(r"\{.*\}", raw, flags=re.DOTALL)
    if not m:
        return Classification(None, None, None, 0.0, f"no JSON in response: {raw[:120]!r}")
    try:
        parsed = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        return Classification(None, None, None, 0.0, f"invalid JSON: {e}")

    return Classification(
        brand=_coerce_brand(parsed.get("brand")),
        family=(parsed.get("family") or None) or None,
        model_number=(parsed.get("model_number") or None) or None,
        confidence=float(parsed.get("confidence") or 0.0),
        reasoning=(parsed.get("reasoning") or "")[:280],
    )


if __name__ == "__main__":
    # Minimal CLI for manual probing — pass JSON via stdin or use defaults.
    import argparse
    import sys

    cli = argparse.ArgumentParser()
    cli.add_argument("board_number")
    cli.add_argument("--sample", default=None)
    cli.add_argument("--odm", default="Compal")
    cli.add_argument("--model", default="qwen3:8b")
    cli.add_argument("--host", default="http://localhost:11434")
    cli.add_argument(
        "--snippets-stdin",
        action="store_true",
        help="Read JSON list of {title,snippet,url} from stdin.",
    )
    args = cli.parse_args()

    if args.snippets_stdin:
        items = json.load(sys.stdin)
        # build duck-typed objects
        class _SR:
            def __init__(self, d):
                self.title = d.get("title", "")
                self.snippet = d.get("snippet", "")
                self.url = d.get("url", "")
        results = [_SR(i) for i in items]
    else:
        results = []

    cls = classify(
        args.board_number,
        args.sample,
        args.odm,
        results,
        model=args.model,
        host=args.host,
    )
    print(json.dumps(cls.__dict__, indent=2))
