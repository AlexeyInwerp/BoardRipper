# Local-LLM Board Classifier — Brainstorm

**Date:** 2026-04-30
**Context:** Slot the residue (~1,159 still-Unsorted boards in `Board Database/boards.db`) into proper consumer brands using a local LLM, replacing the manual "WebSearch + read result" loop.

## Task shape

- **Input per board:** `board_number` (e.g., `LA-9063P`), `notes.sample` (filename, e.g., `lenovo Z500 LA-9063P.zip`), and the ODM-family already known (Compal / Quanta / LCFC / Foxconn).
- **Output:** JSON `{brand: string|null, family: string|null, model: string|null, confidence: 0..1}`.
  - `brand` is the consumer brand (Lenovo, HP, Dell, Acer, Toshiba, …). The 30-name vocabulary is tightly bounded; we already have it in `scripts/classify-unsorted-boards.py`.
  - `null` brand = couldn't decide; leave board in Unsorted, mark as "tried".
- **Quality bar:** "1 attempt then move on" (per user). False positives hurt more than misses, so the model must be willing to say "I don't know".

## Manual-method success rate (sample n=4)

| code            | search hit                              | classified |
| --------------- | --------------------------------------- | ---------- |
| `LA-9063P`      | eBay/Newegg listings: Lenovo Z500/P500  | yes        |
| `NM-A125`       | sibling NM-Cxxx all Lenovo IdeaPad      | yes (pattern) |
| `LA-7531P`      | only generic Compal collection pages    | no         |
| `DA0FF2MB6E1`   | only sibling DA0XXX (HP, Acer)          | no         |

Extrapolated: a single web search resolves **roughly half** of the residue. The other half needs deeper signal (multiple searches, eBay/Aliexpress drill-down, Chinese forums) or just stays unresolved.

## Why local LLM at all

What the LLM gives that pure regex / keyword classifier doesn't:

1. **Multilingual snippet parsing.** Many sample filenames (and search results) carry brand info in Chinese (`戴尔`=Dell, `联想`=Lenovo, `惠普`=HP, `宏碁`=Acer, `华硕`=Asus). My current regex table covers the most common; an LLM handles ad-hoc transliterations and spelling variations like `"fujistu"`, `"asus tek"`, `"hp laser jet"` (which is actually a printer, not a laptop — a regex would false-positive).
2. **Reading messy listings.** eBay titles concatenate brand + model + chip + condition (`"NEW Lenovo Z500 Motherboard LA-9063P GT740M Tested OK"`); the LLM lifts the brand out cleanly without us writing a parser per source.
3. **Refusal.** A regex hit is a yes/no; an LLM with a calibrated prompt can output `null` when the snippets are too thin or contradictory.
4. **Pattern abstraction.** When the code is unique (`NM-A125`) but its prefix is a known brand pattern, an LLM that has seen many `NM-XXX` codes in training can confidently say "Lenovo, IdeaPad/ThinkPad family".

What the LLM *doesn't* give: ground truth. Hallucinations are the real risk — especially for rare codes the model invents an answer for. Mitigation = always pair the LLM with a fresh web search and feed the LLM the search snippets, never just the raw code.

## Architecture options

### Option A — Pure-knowledge LLM (no web)

Prompt the LLM with `(board_number, sample_filename)` only, ask it to classify based on training data.

- Pros: simple loop, no rate limits, runs entirely offline.
- Cons: limited to whatever the model memorised. For frequently-listed boards (Lenovo Z500, MacBook A1502) it works; for rare codes it'll hallucinate.
- Best for: board codes whose sample filename already leaks brand info but our regex missed (e.g., Chinese transliterations, mis-spellings).

### Option B — RAG: WebSearch snippets + LLM extraction (recommended)

Pipeline per board:
1. WebSearch `"<board_number>" laptop motherboard` (one call).
2. Take top 5 result `{title, snippet}` blobs (~1.5 KB total).
3. Prompt the LLM: "Here are eBay/Newegg/forum search snippets for this board code. Extract `{brand, family, model, confidence}`. If the snippets don't agree, return `null`."
4. Parse JSON, hand to `apply-research-findings.py`.

- Pros: matches the manual method that just validated. Hallucination floor is the search results, not the model's memory.
- Cons: needs a search API (Brave / DuckDuckGo HTML / SerpAPI / Google CSE). Rate limit = real budget concern. ~1,100 searches over ~hour.
- Best for: the residue I'm staring at right now.

### Option C — Hybrid (best practical)

Run B against each board, *but* skip the WebSearch when the manual classifier already produced a confident answer (currently: ~57% of the originals, none of the residue). For the residue, default to B.

For special-case ODMs where one search per code is wasteful (LCFC NM-XXX is ~always Lenovo), short-circuit with a prior: "if pattern matches, classify with confidence 0.7 unless overridden by snippets".

This is the design I'd ship.

## Model recommendation

| Model | Size | RAM @ Q4_K_M | Strengths | Notes |
|-------|------|---------------|-----------|-------|
| **Qwen 3 7B Instruct** | 7B | ~4.5 GB | Strong CJK + English, native JSON output, fast on M-series Macs | **Pick this.** Multilingual handles the Chinese filenames and Chinese repair-forum snippets we'll inevitably see. |
| Phi-4 14B | 14B | ~9 GB | Microsoft, punches above weight on reasoning | Backup if Qwen 3 7B is too noisy. English-focused, weaker on CJK. |
| Llama 3.3 70B Q4 | 70B | ~40 GB | Best general knowledge | Overkill for a 30-class task; only useful if running on a workstation with ≥48 GB unified RAM. |
| Gemma 4 7B | 7B | ~5 GB | Native function calling | Comparable to Qwen 3 7B on this task; pick whichever has cleaner Ollama integration. |

Quantization: Q4_K_M is the standard starting point (good accuracy/footprint trade); bump to Q5_K_M only if we see brand-mis-classifications in eval.

Hardware fit: anything M2 Pro / M3 / M4 with ≥16 GB unified memory hosts a 7B-Q4 comfortably with ~40 t/s. The NAS itself is CPU-only Synology — don't run inference there; run on the Mac and write results to `boards.db` over SSH.

Sources for current state-of-the-art rankings: [Best Open Source LLM 2026 Ranking + Ollama Guide](https://whatllm.org/best-open-source-llm), [Best Small AI Models to Run with Ollama (2026)](https://localaimaster.com/blog/small-language-models-guide-2026), [Best Ollama Models in 2026](https://whatllm.org/best-ollama-models).

## Inference stack

- **Ollama** for the runtime — single binary, exposes a stable HTTP API on `:11434`, handles model downloads / GPU detection.
- **Structured output:** Ollama supports JSON schema constraints natively as of late 2025. Define the schema once, the model can't return malformed output.
- **Python client:** `ollama-python` package, or just `requests`. ~20 lines of glue.

## Token / time budget (estimate)

- 7B model on Apple Silicon: ~40-60 t/s decode, ~200-400 t/s prefill.
- Prompt size per board: ~1-2 KB (snippets + instructions) ≈ ~500 tokens prefill.
- Output size: ~50 tokens (the JSON).
- Per board: ~2-3s compute + ~3s for the WebSearch + DB write.
- 1,100 boards × 5s = ~90 minutes wall-clock for full residue.

## Validation plan before unleashing on full residue

1. Pick 100 already-classified boards from Pass 1 (filename-keyword classifier ground truth) — feed only the `board_number` to the LLM (no filename), measure how often it agrees.
2. If brand-agreement ≥ 85% on this baseline → ship. If 70-85% → tighten prompt or upgrade to 14B. If < 70% → augment with WebSearch (Option B/C).
3. Spot-check 30 LLM-classified boards from the residue manually before committing the DB.

## Concrete next steps (proposed, not yet executed)

```
1. Install Ollama + pull qwen3:7b-instruct (one-time).
2. Write scripts/llm-classify-unsorted.py — drives Ollama, optionally WebSearch,
   emits the same JSON map shape that scripts/apply-research-findings.py
   already consumes.
3. Eval on the 100-board ground-truth slice → pick prompt + temperature.
4. Run on residue, review summary, commit boards.db, ship in v0.16.x.
```

## Open questions (to confirm before building the pipeline)

- Which Mac is doing inference? (Affects model-size headroom.)
- Is a search API key available (Brave, SerpAPI, Google CSE), or stick to scraping DuckDuckGo HTML?
- Should the LLM also try to nail down the *family* (ThinkPad vs IdeaPad vs Yoga) and *model* (T420, P52), or is brand-only good enough for v1? Brand-only is much higher precision; family/model is its own slice.

---

## Decisions taken (2026-04-30)

- **Family + model when possible** (user direction).
- **No external search API** — DuckDuckGo HTML scrape primary, Bing HTML
  fallback. Brave Search API ready as a flag the day a key exists.
- Inference host: user's Mac. Script speaks to local Ollama on
  `:11434`; no NAS-side inference.

## Pipeline shipped

| File | Role |
| --- | --- |
| [`scripts/lib/board_search.py`](../../../scripts/lib/board_search.py) | DDG/Bing HTML scraper, polite throttle, fixture cache |
| [`scripts/lib/board_llm.py`](../../../scripts/lib/board_llm.py) | Ollama HTTP client + JSON-schema-constrained prompt |
| [`scripts/llm-classify-unsorted.py`](../../../scripts/llm-classify-unsorted.py) | the driver — residue → JSON output |
| [`scripts/apply-research-findings.py`](../../../scripts/apply-research-findings.py) | applies the JSON, places rows under `<Brand>/<Family>/<Model>` |
| [`scripts/eval-classifier.py`](../../../scripts/eval-classifier.py) | sanity-check vs ground-truth before a real run |

## Runbook

Setup (once):

```bash
# 1. Ollama daemon
brew install ollama         # or download from https://ollama.com
ollama serve &              # binds :11434

# 2. Model (≈4.5 GB, multilingual, Q4_K_M default)
ollama pull qwen3:7b-instruct

# 3. Sanity-check the daemon
curl -s http://localhost:11434/api/tags | jq '.models[].name'
```

Eval gate (recommended before unleashing on the residue):

```bash
python3 scripts/eval-classifier.py --limit 100 --verbose
# look at "agree:" line — ship if ≥85% on brand-agreement
```

Full run (the residue, ~1,159 boards, ~90 min wall-clock):

```bash
python3 scripts/llm-classify-unsorted.py \
  --out /tmp/findings.json \
  --resume \
  --verbose
```

Apply + commit:

```bash
python3 scripts/apply-research-findings.py --json /tmp/findings.json

# spot-check a few promoted rows in the Database Editor, then…
git add "Board Database/boards.db" "Board Database/boards.db-shm" "Board Database/boards.db-wal"
git commit -m "build(boarddb): LLM-classified residue (N rows promoted)"
```

Useful flags:

| Flag | Effect |
| --- | --- |
| `--no-llm` | regex-on-snippets baseline; brand-only output, no Ollama needed |
| `--limit N` | cap to N boards (testing) |
| `--odm Compal,Quanta` | only one or two ODM families |
| `--search-backend bing` | switch when DDG starts blocking |
| `--throttle-s 2.5` | slower, less likely to hit rate-limit |
| `--confidence-floor 0.7` | tighter — fewer matches but higher precision |
| `--ollama-model phi-4:14b` | upgrade if Qwen 3 7B keeps under-recalling |

Smoke test result (proves search + driver + apply work end-to-end on
this codebase, `--no-llm`, 6 boards): `1 matched, 5 null, 0 errors`.

## Future improvements

- **Family+model recall.** First pass uses snippet text only; some hard cases need the LLM to actually read the eBay/Amazon listing page. WebFetch on the top 1-2 results of low-confidence boards (< 0.7) would lift recall meaningfully at a per-board WebFetch cost (~5 s).
- **Brave Search API.** 2000 q/mo free tier covers ~2× full-residue runs. Drop-in via env `BRAVE_API_KEY`; `board_search.py` would gain a `brave` backend in ~30 lines.
- **Vision pass.** A handful of boards have only Chinese characters in the filename and a Chinese forum post as the only hit. Qwen 3 7B handles CJK well; if recall drops on those, swap to qwen3-vl-7b which can also read embedded images of the PCB silkscreen, where the board's full marking (manufacturer + revision) often lives.
- **Eval-driven prompt tuning.** Run `eval-classifier.py` against a fixed seed of 200 ground-truth boards, capture confusions, refine the prompt's "Rules" block, repeat. The fixture-cache mode in `board_search.py` keeps these runs hermetic.

