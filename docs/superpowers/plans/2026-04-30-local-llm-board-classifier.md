# Local-LLM Board Classifier — Implementation Plan

**Goal:** Wire up a hybrid-RAG pipeline (DuckDuckGo HTML search → local Qwen 3 7B via Ollama → JSON `{brand, family, model, confidence}`) that drives `scripts/apply-research-findings.py` on the 1,159 Unsorted boards.

**Design:** see [`../specs/2026-04-30-local-llm-board-classifier-brainstorm.md`](../specs/2026-04-30-local-llm-board-classifier-brainstorm.md). Hybrid RAG, brand always, family + model when the LLM can extract them confidently from search snippets.

**Search source:** DuckDuckGo HTML endpoint (`https://html.duckduckgo.com/html/`) — no key, no rate-limit headers but polite throttle of 1.5 s/query keeps us under the radar. Bing HTML as fallback. **Optional upgrade path:** Brave Search API (2000 q/mo free tier) — drop-in `--search-backend brave` flag, only needs the API key in env.

**Stack:** Python stdlib only for the script (`urllib`, `json`, `sqlite3`, `re`, `html.parser`) so it has no install footprint. The user already has Ollama running on their Mac; the script just speaks to its HTTP API on `:11434`.

---

## File map

| File | Responsibility |
| --- | --- |
| `scripts/lib/__init__.py` | empty marker |
| `scripts/lib/board_search.py` | DuckDuckGo HTML / Bing HTML scrape; returns list of `{title, snippet, url}` per query |
| `scripts/lib/board_llm.py` | Ollama HTTP client, prompt template, JSON-schema enforcement, parsing |
| `scripts/llm-classify-unsorted.py` | the driver — reads boards.db residue, drives search + LLM, writes JSON output |
| `scripts/apply-research-findings.py` | already exists; extend to accept `{brand, family, model}` triples and place rows under `<Brand>/<Family>/<Model>` instead of the flat `(researched-<odm>)` placeholder |
| `scripts/eval-classifier.py` | sanity-check: pick 100 already-classified boards, run classifier, report brand-agreement % |

The `lib/` split keeps each concern small (~150-250 lines each) so I can iterate on the prompt without touching the search layer and vice versa.

---

## Task 1 — `lib/board_search.py`

DuckDuckGo HTML scraper. Pure stdlib. One public function:

```python
def search(query: str, limit: int = 8, backend: str = "ddg") -> list[SearchResult]
```

Returns `SearchResult(title, snippet, url)` ranked. Backends:
- `ddg`  → POST to `https://html.duckduckgo.com/html/` with `q=<query>`. Parse `<a class="result__a">` and `<a class="result__snippet">`. Decode the URL redirect (`/l/?uddg=…`).
- `bing` → GET `https://www.bing.com/search?q=<query>&form=QBLH`. Parse `<li class="b_algo">` (`<h2><a>`, `<div class="b_caption"><p>`).

Polite mode: `time.sleep(throttle_s)` between calls (default 1.5 s, configurable). Random User-Agent rotation (3 strings). Single retry on 5xx with exponential backoff.

Test-only: if env var `BOARD_SEARCH_FIXTURE_DIR` is set, read the response body from `<dir>/<sha1(query)>.html` instead of hitting the network — gives the eval/test path a hermetic loop.

## Task 2 — `lib/board_llm.py`

Ollama client, also stdlib only.

```python
def classify(board_number: str, sample_filename: str | None,
             odm: str, search_results: list[SearchResult],
             model: str = "qwen3:7b-instruct",
             host: str = "http://localhost:11434") -> Classification
```

`Classification(brand, family, model_number, confidence, reasoning)` — last field is freeform, kept only for log inspection, never written to the DB.

The prompt is the load-bearing piece. Skeleton:

```
You are a laptop motherboard classifier. Given a PCB code (Compal LA-XXX,
Quanta DA0XXX, LCFC NM-XXX, Foxconn 6050AXXX, ASUS 60NRXX, MSI MS-XXX,
Apple 820-XXX), the original sample filename, and a few web search
snippets, identify the consumer brand, product family, and model.

INPUT:
  board_number: <code>
  sample_filename: <filename or "none">
  odm: <Compal|Quanta|LCFC|Foxconn|...>
  search_results:
    1. <title>
       <snippet>
    2. ...

RULES:
- brand   ∈ {Lenovo, HP, Dell, Acer, Asus, Toshiba, Fujitsu, Apple, MSI,
            Samsung, LG, Sony, Razer, Huawei, Xiaomi, Microsoft, Gigabyte,
            Clevo, Medion, Panasonic, Mechrevo, Hasee, Tongfang, Haier,
            Founder, Eurocom, "Origin PC", System76, Avita, Vaio, null}
            Use null when snippets disagree or are too thin.
- family  is the consumer product line (ThinkPad, IdeaPad, Yoga, Legion,
            Pavilion, Envy, EliteBook, Aspire, Inspiron, Latitude, XPS,
            Zenbook, Vivobook, ROG, Satellite, MacBook Pro, MacBook Air,
            iMac, ...). null when not in snippets.
- model   is the specific machine identifier (T420, P52, "15-cw0xxx",
            "Z500", "A715", "MX350", "M1 Pro 14"" 2021"). null when not in
            snippets.
- confidence 0.0..1.0. < 0.5 → caller will treat as null brand.

Return STRICT JSON, no prose:
{ "brand": ..., "family": ..., "model": ..., "confidence": ..., "reasoning": "..." }
```

Ollama supports JSON-schema constraint via the `format` parameter (object form). Pass the schema, set `temperature=0.1` to keep the model honest. `num_predict=200` is plenty.

## Task 3 — `scripts/llm-classify-unsorted.py`

Driver with these flags:

```
--db <path>            (default Board Database/boards.db)
--limit N              (default 0 = all residue)
--odm Compal,Quanta    (filter)
--resume               (skip rows whose notes contain "researched:")
--throttle-s 1.5
--search-backend ddg|bing
--ollama-host http://localhost:11434
--ollama-model qwen3:7b-instruct
--out research-output.json   (the JSON apply-research-findings.py consumes)
--no-llm               (test mode: regex on snippets, ignores LLM)
--dry-run              (search + LLM only, do not write JSON)
--verbose
```

Loop:
1. Pull all Unsorted rows (filtered).
2. For each row:
   a. Build query: `"<board_number>" laptop motherboard`. If sample filename has trailing words (after the code), append the first non-stopword: `"LA-9063P" laptop motherboard Z500`.
   b. `search_results = board_search.search(query, limit=8, backend=...)`.
   c. `cls = board_llm.classify(board_number, sample, odm, search_results)`.
   d. If `cls.confidence < 0.5` or `cls.brand is None` → record `{board: null}`.
   e. Else → record `{board: {brand, family, model}}`.
3. Flush every 25 rows so a Ctrl-C still leaves a usable JSON.
4. Print running summary every 25 boards.

Resumability: the helper script (`apply-research-findings.py`) appends `researched:web-search ...` or `researched:no-match` to each touched row's notes. The driver's `--resume` mode skips rows whose notes already contain `researched:`.

## Task 4 — `scripts/apply-research-findings.py` extension

Currently writes to `<Brand>/<ODM>/(researched-<odm>)`. New JSON shape allows:

```json
{
  "LA-9063P": { "brand": "Lenovo", "family": "IdeaPad", "model": "Z500" },
  "DA0FF2MB6E1": null,
  "LA-7531P": { "brand": "Acer", "family": null, "model": null }
}
```

Placement rules:
- All three present → `<Brand> / <Family> / <Model>`
- Brand + family, no model → `<Brand> / <Family> / (researched — TODO: model)`
- Brand only → `<Brand> / (researched-<odm>) / (researched-<odm>)`  ← current behaviour
- `null` → keep in Unsorted, append `researched:no-match`

Backwards-compatible: a string value (current shape) still maps to brand-only.

## Task 5 — `scripts/eval-classifier.py`

Picks 100 non-Unsorted boards (the ground truth from earlier passes), runs the classifier, reports:

- brand-agreement rate
- per-brand precision / recall
- list of disagreements

Goal: ≥ 85 % brand agreement → ship the run on the residue.

## Task 6 — Runbook

Append a "Run the pipeline" section to the brainstorm doc covering:

1. `brew install ollama && ollama serve &` (or download installer).
2. `ollama pull qwen3:7b-instruct` (~4.5 GB).
3. `python3 scripts/eval-classifier.py --limit 100` — sanity gate.
4. `python3 scripts/llm-classify-unsorted.py --out /tmp/findings.json` — ~90 min.
5. `python3 scripts/apply-research-findings.py --json /tmp/findings.json`.
6. Inspect, commit `boards.db`, ship in next release.

---

## Order of work

I'll implement Tasks 1 → 2 → 4 → 3 → 5 → 6 in that order: search and LLM modules first (each independently testable), then the apply-script extension (so I can dry-run end-to-end), then the driver, then eval. Runbook last.

A 6-board smoke test (mix of Compal, Quanta, LCFC, Foxconn) at the end demonstrates the loop works when Ollama is running. If Ollama isn't installed yet, `--no-llm` falls back to regex-on-snippets so the search half is provable on its own.
