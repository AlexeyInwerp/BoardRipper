# Laptop Board Number Database — Crawling & Data Specification

> **Purpose:** This document specifies how to build a comprehensive laptop motherboard database (Brand / Model / Board Number) by crawling publicly available sources. It is intended to be integrated as a module into an existing boardviewer application.
>
> **Use case:** Repair shops have chaotic folder structures containing schematics, boardviews, BIOS dumps, datasheets, photos, and repair notes with inconsistent naming. This database serves as the canonical reference to: (1) extract board numbers from messy filenames via regex, (2) map them to Brand/Model, and (3) enable reorganization into `Brand/Model/BoardNumber/` hierarchy.

---

## Table of Contents

1. [Data Model](#1-data-model)
2. [Board Number Formats & Regex Patterns](#2-board-number-formats--regex-patterns)
3. [Data Sources — Tier 1 (Structured, High Priority)](#3-data-sources--tier-1)
4. [Data Sources — Tier 2 (Semi-Structured, Medium Priority)](#4-data-sources--tier-2)
5. [Data Sources — Tier 3 (Supplemental)](#5-data-sources--tier-3)
6. [Data Normalization Strategy](#6-data-normalization-strategy)
7. [Crawling Architecture](#7-crawling-architecture)
8. [Filename Matching Engine](#8-filename-matching-engine)
9. [Folder Reorganization](#9-folder-reorganization)
10. [Implementation Recommendations](#10-implementation-recommendations)

---

## 1. Data Model

### Core Table: `boards`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `brand` | TEXT NOT NULL | Normalized brand name (e.g., "Lenovo", "Apple", "Dell") |
| `model` | TEXT | Laptop model name (e.g., "ThinkPad T450", "MacBook Pro 15\" Mid 2015") |
| `model_number` | TEXT | OEM model identifier (e.g., "A1398", "20BU", "5570") |
| `board_number` | TEXT NOT NULL | Primary board/PCB identifier (e.g., "NM-A251", "820-02016-A") |
| `board_name` | TEXT | Internal project/codename (e.g., "AIVL0", "J680G MLB") |
| `odm` | TEXT | Original Design Manufacturer (e.g., "Compal", "Quanta", "Wistron") |
| `board_number_type` | TEXT | Classification of the number format (see Section 2) |
| `source` | TEXT NOT NULL | Which crawler provided this entry |
| `source_url` | TEXT | Original URL where data was found |
| `created_at` | DATETIME | When the record was first created |
| `updated_at` | DATETIME | When the record was last updated |

### Alias Table: `board_aliases`

Many boards have multiple identifiers (OEM spare part number, ODM board code, FRU number). This table links them.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `board_id` | INTEGER FK | References `boards.id` |
| `alias_number` | TEXT NOT NULL | The alternate identifier |
| `alias_type` | TEXT | Type classification (e.g., "fru", "hp_spare", "apple_service", "intel_sspec") |

### Model Alias Table: `model_aliases`

One board often fits multiple laptop models (e.g., Dell Inspiron 7370/7373/7570/7573 all use board 16839-1).

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `board_id` | INTEGER FK | References `boards.id` |
| `model_name` | TEXT NOT NULL | Alternative model name this board fits |

### Indexes

```sql
CREATE UNIQUE INDEX idx_board_unique ON boards(board_number, brand);
CREATE INDEX idx_board_number ON boards(board_number);
CREATE INDEX idx_brand_model ON boards(brand, model);
CREATE INDEX idx_alias_number ON board_aliases(alias_number);
CREATE INDEX idx_model_alias ON model_aliases(model_name);
```

---

## 2. Board Number Formats & Regex Patterns

### By ODM / Manufacturer

#### Lenovo — LCFC/Compal: `NM-xxxx`
- **Pattern:** `NM-[A-Z]\d{3,4}`
- **Regex:** `\bNM-[A-Z]\d{3,4}\b`
- **Examples:** NM-A251, NM-B291, NM-C381, NM-D031, NM-E551
- **Notes:** Letter after NM- increments with generations (A=oldest, E=newest observed). This is the primary board identifier for most Lenovo laptops manufactured by LCFC.

#### Apple: `820-xxxxx`
- **Pattern:** `820-\d{4,5}(-[A-Z])?`
- **Regex:** `\b820-\d{4,5}(?:-[A-Z])?\b`
- **Examples:** 820-02016-A, 820-3115, 820-00840-A, 820-03681
- **Notes:** The `-A`, `-B` suffix indicates board revision. 4-digit numbers are older, 5-digit (with leading zero) are newer. This is THE identifier for Apple boards.

#### Apple Service Part: `661-xxxxx`
- **Pattern:** `661-\d{5}`
- **Regex:** `\b661-\d{5}\b`
- **Examples:** 661-07652, 661-02391
- **Notes:** This is Apple's service/replacement part number, NOT the board number. Maps 1:1 to a specific 820-xxxxx board + configuration.

#### Compal (Multi-brand): `LA-xxxxP`
- **Pattern:** `LA-[A-Z]?\d{3,4}[A-Z]?`
- **Regex:** `\bLA-[A-Z]?\d{3,4}[A-Z]?\b`
- **Examples:** LA-E541P, LA-H281P, LA-K371P, LA-4271P, LA-3151
- **Notes:** Used across Dell, HP, Lenovo, Acer, Toshiba. Older boards use numeric-only (LA-3151), newer use letter+digits (LA-K371P). The trailing letter (usually P) is the revision.

#### Quanta (Multi-brand): `DA0xxxxxxxxx`
- **Pattern:** `DA0[A-Z0-9]{5,9}`
- **Regex:** `\bDA0[A-Z0-9]{5,9}\b`
- **Examples:** DA0R09MB6H1, DA0PDIMB8G0, DA0U8CMB6B0, DA0X61MB6G0
- **Notes:** Heavily used by HP. The 3 characters after DA0 are the Quanta project code. Also used by Dell, Acer, Toshiba.

#### Wistron (Multi-brand): Numeric codes
- **Pattern:** Varies. Often `\d{4,5}-\d{1}`
- **Regex:** `\b\d{4,5}-\d\b`
- **Examples:** 16839-1, 15264-1, 18750-1
- **Notes:** Primarily seen on Dell boards. The format is less distinctive — may need context to distinguish from other numeric codes.

#### Wistron 448 Series: `448.xxxxx.xxxx`
- **Pattern:** `448\.\d{2}[A-Z]\d{2}\.\d{3,4}[A-Z]?`
- **Regex:** `\b448\.\d{2}[A-Z]\d{2}\.\d{3,4}[A-Z]?\b`
- **Examples:** 448.06R01.0011, 448.07N06.002N
- **Notes:** Used on some Lenovo boards manufactured by Wistron.

#### ASUS: `60NBxxxx-MBxxxx`
- **Pattern:** `60NB[A-Z0-9]{4}-MB[A-Z0-9]{4}`
- **Regex:** `\b60NB[A-Z0-9]{4}-MB[A-Z0-9]{4}\b`
- **Examples:** 60NB0C00-MB8000, 60NB0SL0-MB4000
- **Notes:** ASUS internal motherboard part numbers. The first part identifies the laptop chassis, the second the board revision.

#### HP Spare Part: `Lxxxxx-xxx` or `xxxxxx-xxx`
- **Pattern:** `[A-Z]?\d{5,6}-\d{3}`
- **Regex:** `\b[A-Z]?\d{5,6}-\d{3}\b`
- **Examples:** L65694-601, M05248-601, 828168-601, 830937-601
- **Notes:** HP's spare part numbering system. The -601 suffix is very common (indicates specific configuration). Often paired with a DA0/LA- board code.

#### Dell Part Number (DPN)
- **Pattern:** Short alphanumeric, 5-6 characters
- **Regex:** `\b[A-Z0-9]{5,6}\b` (too generic alone — use in context)
- **Examples:** Y1R4H, 3P5X2, K2TKF, 0G1548
- **Notes:** Dell's internal part numbers. Very short and generic — should only be matched when other context (like "Dell" in the filename) is present.

#### Lenovo FRU: `xxXxxxx`
- **Pattern:** `\d{2}X\d{4,5}` or `5B\d{2}[A-Z]\d{5}`
- **Regex:** `\b\d{2}X\d{4,5}\b|\b5B\d{2}[A-Z]\d{5}\b`
- **Examples:** 04X4781, 04X3897, 5B20G19198, 5B20S41745, 5B21H23640
- **Notes:** Lenovo Field Replaceable Unit numbers. Not the board number itself but maps to a specific board+config.

#### Inventec: `6050Axxxxxxx`
- **Pattern:** `6050A\d{7,10}`
- **Regex:** `\b6050A\d{7,10}\b`
- **Examples:** 6050A2655401
- **Notes:** Inventec ODM board numbers. Less common than Compal/Quanta.

#### Acer Part Number: `MB.xxxxx.xxx`
- **Pattern:** `MB\.[A-Z0-9]{5}\.\d{3}`
- **Regex:** `\bMB\.[A-Z0-9]{5}\.\d{3}\b`
- **Examples:** MB.AJ702.003
- **Notes:** Acer's internal motherboard part numbering.

### Regex Priority Order for Filename Matching

When scanning a filename, apply these patterns in order (most distinctive first):

1. `820-\d{4,5}(?:-[A-Z])?` — Apple board (very distinctive)
2. `661-\d{5}` — Apple service part
3. `NM-[A-Z]\d{3,4}` — Lenovo/LCFC
4. `LA-[A-Z]?\d{3,4}[A-Z]?` — Compal (multi-brand)
5. `DA0[A-Z0-9]{5,9}` — Quanta (multi-brand)
6. `60NB[A-Z0-9]{4}-MB[A-Z0-9]{4}` — ASUS
7. `448\.\d{2}[A-Z]\d{2}\.\d{3,4}` — Wistron 448-series
8. `6050A\d{7,10}` — Inventec
9. `MB\.[A-Z0-9]{5}\.\d{3}` — Acer
10. `5B\d{2}[A-Z]\d{5}` — Lenovo FRU (newer format)
11. `\d{2}X\d{4,5}` — Lenovo FRU (older format)
12. `[A-Z]?\d{5,6}-\d{3}` — HP spare part
13. `\d{4,5}-\d` — Wistron numeric (least distinctive, match last)

---

## 3. Data Sources — Tier 1

These are the highest-value sources: structured data, accessible, and rich in board mappings.

### 3.1 LogiWiki — Apple Board Numbers

| Property | Value |
|---|---|
| **URL** | `https://logi.wiki/index.php/Board_Number_by_A_Number` |
| **Coverage** | Apple only (MacBook, MacBook Pro, MacBook Air, iMac, Mac mini, Mac Pro) |
| **Scale** | ~159 unique 820-xxxxx board numbers, ~72 A-numbers |
| **Time span** | 2006 (A1150) through 2025 (A3241, board 820-03681) |
| **Data format** | MediaWiki HTML — two formats on same page |
| **Access method** | HTTP GET, parse HTML |
| **Rate limiting** | None observed (community wiki) |

#### Data Structures

**Format A — Wiki Tables (top of page):**
3 `<table class="wikitable">` elements with columns:
`Screen Size | EMC | Model N | Date | Model ID | Board Number | Board Number 2`

```
Example row: 13" | EMC 2326 | A1278 | Mid 2009 | MacBookPro5,5 | 820-2530 |
```

**Format B — Free-text sections (bulk of page):**
`<h3>` headings per A-number, followed by `<p>` with `<br/>`-separated lines:
```html
<h3>A1370 MacBook Air 11" MagSafe 1</h3>
<p>820-2796 2010 MacBook Air 11"<br/>
820-3024 2011 MacBook Air 11"</p>
```

#### Parsing Strategy
1. Fetch page HTML
2. Parse Format A tables with an HTML parser (cheerio, BeautifulSoup, etc.)
3. Parse Format B sections: iterate `<h3>` elements, extract A-number and model from heading text, then parse `<p>` children for `820-xxxxx` + year + model lines
4. Merge both formats, deduplicating on `820-xxxxx`

#### Secondary Page: Schematics Availability
- **URL:** `https://logi.wiki/index.php/Schematics_and_Boardviews_Availability`
- 4 wiki tables, ~173 unique board numbers
- Columns: `Board number | Schematics | Boardview | Comment`
- Useful for enriching records with schematic/boardview availability status

---

### 3.2 LaptopSchematic.com — Multi-Brand Catalog

| Property | Value |
|---|---|
| **URL** | `https://www.laptopschematic.com/list.txt` |
| **Coverage** | 23 brands: Acer, Apple, ASUS, BENQ, Clevo, Dell, Fujitsu, Gateway, Hasee, HP, Lenovo, Microsoft Surface, MSI, NEC, Optima, Packard Bell, Sony, Toshiba, Xiaomi, and more |
| **Scale** | 6,251 lines in list.txt; 72,000+ claimed resources; ~145 pages of WordPress posts |
| **Data format** | UTF-16LE plain text file (hierarchical tree), plus WordPress post pages |
| **Access method** | HTTP GET for list.txt (requires browser User-Agent); HTML scraping for post pages |
| **Rate limiting** | Blocks default `WebFetch` user-agent (403); accepts browser UA strings |

#### Primary Data: `list.txt`

The file is a hierarchical tree using `%` as indentation markers:

```
%%Acer
    %%notebook
        %%Acer Aspire 2930
            JAT10 LA-4271P MONTEVINA.pdf
        %%Acer Aspire 3100 5100 5110 / Extensa 5010 5410 / TravelMate 5210
            Compal LA-3151.pdf
```

**Parsing strategy:**
1. Download and decode UTF-16LE to UTF-8
2. Parse line-by-line: `%%` prefixed lines indicate hierarchy levels (brand → category → model)
3. Non-`%%` lines are filenames — extract board codes from filenames using regex patterns from Section 2
4. Associate extracted board code with the parent model heading

**Key insight:** The board codes are embedded in **filenames**, not cleanly separated. Examples:
- `JAT10 LA-4271P MONTEVINA.pdf` → board: `LA-4271P`
- `Compal LA-3151.pdf` → board: `LA-3151`
- `820-00840-A.pdf` → board: `820-00840-A`

#### Secondary Data: WordPress Posts

Post titles follow the pattern:
`{Brand} {Model(s)} Schematic & Boardview {Board Number} Motherboard`

- **URL pattern:** `https://www.laptopschematic.com/{brand}/page/{N}/`
- ~145 pages total across all brands
- Category RSS feeds available at `/{brand}/feed/`

**Parsing strategy:** Scrape paginated category pages or RSS feeds. Extract brand, model, and board number from post titles using regex.

---

### 3.3 eBay Browse API — Structured Marketplace Data

| Property | Value |
|---|---|
| **URL** | `https://api.ebay.com/buy/browse/v1/item_summary/search` |
| **Coverage** | All brands (global marketplace) |
| **Scale** | Thousands of active listings in category 175676 (Laptop Motherboards) |
| **Data format** | JSON REST API with structured item specifics |
| **Access method** | OAuth 2.0 Application token (free, client credentials grant) |
| **Rate limiting** | 5,000 calls/day on basic tier |

#### Why eBay Is Tier 1

eBay is the only source with **natively structured board data** — no regex parsing needed:

| Item Specific Field | Description |
|---|---|
| `Brand` | Board brand (e.g., "Dell", "HP") |
| `Compatible Brand` | Laptop brand it fits |
| `Compatible Model` | Laptop model it fits |
| `MPN` | Manufacturer Part Number — the board number |
| `Socket Type` | CPU socket |
| `Memory Type` | DDR3, DDR4, etc. |
| `Chipset` | Chipset model |

#### API Setup
1. Register at https://developer.ebay.com/
2. Create an application → get Client ID + Client Secret
3. Get Application token: `POST /identity/v1/oauth2/token` with `grant_type=client_credentials`
4. Search: `GET /buy/browse/v1/item_summary/search?category_ids=175676&q=laptop+motherboard+{brand}&fieldgroups=EXTENDED&limit=200`

#### Parsing Strategy
1. Iterate through brands: Lenovo, Dell, HP, Apple, ASUS, Acer, Toshiba, MSI, etc.
2. For each brand, paginate through search results (200 items per page)
3. Extract `itemSpecifics` → `Brand`, `Compatible Model`, `MPN`
4. Deduplicate on MPN + Compatible Brand
5. Run daily/weekly to catch new listings

---

## 4. Data Sources — Tier 2

### 4.1 BoardSchematic.com — WordPress Schematic Archive

| Property | Value |
|---|---|
| **URL** | `https://www.boardschematic.com/` |
| **Coverage** | 20 brands (Dell, Lenovo, HP, Acer, Toshiba, ASUS, Apple, Fujitsu, Sony, MSI, and more) |
| **Scale** | ~1,600-1,700 entries across 165 pages |
| **Data format** | WordPress posts with structured content |
| **Access method** | HTML scraping with predictable URL patterns |
| **Rate limiting** | None observed; be polite (1-2 req/sec) |

#### URL Patterns
- Brand pages: `https://www.boardschematic.com/{brand-slug}/`
- Pagination: `https://www.boardschematic.com/{brand-slug}/page/{N}/`
- Post slugs: `{brand}-{model}-schematic-boardview-{board-number}`

#### Brand Slug Mapping

| Brand | Slug | Est. Entries |
|---|---|---|
| Dell | `/dell/` | ~330 |
| Lenovo | `/ibm-lenovo/` | ~280 |
| Acer | `/acer/` | ~230 |
| HP | `/hp/` | ~230 |
| Toshiba | `/toshiba/` | ~170 |
| ASUS | `/asus/` | ~120 |
| Apple | `/apple/` | ~100 |
| Fujitsu | `/fujitsu/` | ~60 |
| Sony | `/sony/` | ~60 |
| Gateway | `/gateway-schematics/` | ~40 |
| MSI | `/msi/` | ~30 |
| Clevo | `/clevo/` | ~10+ |
| Microsoft | `/microsoft-surface/` | ~4 |
| Xiaomi | `/xiaomi-schematics/` | ~2 |

#### Data Fields Per Post

| Field | Availability | Example |
|---|---|---|
| Brand | Always | Dell |
| Model(s) | Always | Inspiron 7370, 7373, 7570, 7573 |
| Board Number | Always | 16839-1 |
| Board Name | Often | KYLOREN 13 |
| ODM Manufacturer | Sometimes | Wistron |
| OEM Part Number | Sometimes | Y5HR3 |
| CPU Platform | Often | Intel KabyLake-U R |
| EC/KBC Chip | Sometimes | MEC1416 |

#### Parsing Strategy
1. Iterate brand pages, paginate through all entries
2. For each post, extract title (contains brand + model + board number)
3. Optionally fetch individual post pages for richer metadata (ODM, EC chip, etc.)
4. Extract board numbers from post titles using regex

---

### 4.2 GotLaptopParts.com — Shopify Parts Store

| Property | Value |
|---|---|
| **URL** | `https://www.gotlaptopparts.com/collections/motherboards` |
| **Coverage** | Dell, HP, Lenovo, Apple, ASUS, Acer, Toshiba, Samsung, MSI, Sony, Razer, Microsoft |
| **Scale** | 5,487 motherboard products |
| **Data format** | Shopify storefront HTML (JSON API is disabled/404) |
| **Access method** | HTML scraping, 10 products per page (~549 pages) |
| **Rate limiting** | Standard Shopify; be polite |

#### Product Title Format

Titles are highly structured:
`{Brand} {Model Line} {Screen Size} {Model#} {CPU} {Clock} {RAM} {GPU} Motherboard {Board Part Number(s)}`

**Examples:**
- `HP EliteBook 850 G7 i5-10310U Motherboard M05248-601`
- `Dell Latitude 7420 i5-1145G7 Motherboard LA-K371P SRK03`
- `Lenovo Yoga 2 13 i5-4210U Motherboard LA-A921P 5B20G19198`
- `Apple MacBook Pro A1706 2017 i5-7267U Logic Board 661-07652`
- `Asus ZenBook UX325E i5-1135G7 Motherboard 60NB0SL0-MB4000`

#### Parsing Strategy
1. Scrape paginated collection pages (549 pages)
2. Extract product titles from HTML grid
3. Parse titles with regex: brand at start, board number(s) at end, model info in middle
4. Many titles contain TWO identifiers (e.g., `LA-K371P` + `SRK03`, or `LA-A921P` + `5B20G19198`)

---

## 5. Data Sources — Tier 3

### 5.1 AliExpress — Via Google Index

Direct scraping is blocked (heavy JS rendering, anti-bot). Use Google's cached index instead.

| Property | Value |
|---|---|
| **Access method** | Google search: `site:aliexpress.com "laptop motherboard" "{brand}"` |
| **Coverage** | All brands, highest volume of obscure/Chinese market boards |
| **Data quality** | Excellent title consistency from SEO-optimized listings |

#### Title Format
`{Seller Brand} {Board Number} {REV} For {OEM Brand} {Model} Laptop Motherboard {CPU} {GPU} {Memory}`

Common seller "brands" (marketing labels on salvaged boards): NOKOTION, KEFU, MLLSE, SHELI, SZWXZY.

#### Parsing Strategy
1. Google Custom Search API or manual search queries
2. Extract product titles from search results
3. Parse with regex: `For\s+(Lenovo|HP|Dell|Acer|Toshiba|ASUS|Sony|Samsung)\s+(.+?)\s+[Ll]aptop` for brand+model
4. Apply board number regex patterns from Section 2

**Note:** This is a supplemental source for filling gaps. eBay API is preferred for marketplace data.

### 5.2 HP PartSurfer

| Property | Value |
|---|---|
| **URL** | `https://partsurfer.hp.com/` |
| **Coverage** | All HP products (official) |
| **Access method** | Web search interface (query by serial/product/part number) |
| **Limitation** | Requires specific HP product numbers as input — cannot browse/list all boards |

Useful for enriching existing HP records rather than discovery.

### 5.3 Lenovo PSREF

| Property | Value |
|---|---|
| **URL** | `https://psref.lenovo.com/` |
| **Coverage** | All Lenovo products (official) |
| **Access method** | Web app with search |
| **Limitation** | Maps models to specs/configurations but does NOT expose NM-xxxx board codes directly. Has FRU numbers. |

Useful for model identification and cross-referencing FRU numbers to models.

### 5.4 iFixit

| Property | Value |
|---|---|
| **URL** | `https://www.ifixit.com/Parts/PC_Laptop/Motherboards` |
| **API** | `https://www.ifixit.com/api/2.0/` (public) |
| **Coverage** | Multi-brand, well-structured device taxonomy |

Useful for device identification and compatibility data. API may expose parts-to-device mappings.

### 5.5 Beetstech.com — Apple Specialist

| Property | Value |
|---|---|
| **URL** | `https://beetstech.com/` |
| **Coverage** | Apple MacBook only |
| **Data quality** | Very clean: A-number → 820-xxxxx mapping with full specs |

Good supplemental Apple source to cross-reference with LogiWiki.

---

## 6. Data Normalization Strategy

### Brand Normalization

| Raw Input Variants | Normalized Value |
|---|---|
| `IBM`, `IBM/Lenovo`, `IBM-Lenovo`, `ibm-lenovo` | `Lenovo` |
| `HP`, `Hewlett-Packard`, `Compaq`, `hp` | `HP` |
| `Apple`, `APPLE`, `Mac` | `Apple` |
| `Dell`, `DELL` | `Dell` |
| `Acer`, `ACER`, `Gateway`, `eMachines`, `Packard Bell` | `Acer` (note: Gateway/eMachines/PB are Acer subsidiaries) |
| `ASUS`, `Asus`, `asus` | `ASUS` |
| `Toshiba`, `TOSHIBA`, `Dynabook` | `Toshiba` |
| `Sony`, `SONY`, `VAIO` | `Sony` |
| `Samsung`, `SAMSUNG` | `Samsung` |
| `MSI`, `msi` | `MSI` |
| `Clevo`, `CLEVO` | `Clevo` |
| `Fujitsu`, `FUJITSU`, `Fujitsu Siemens` | `Fujitsu` |
| `Microsoft`, `MICROSOFT` | `Microsoft` |
| `Xiaomi`, `XIAOMI` | `Xiaomi` |
| `Hasee`, `HASEE` | `Hasee` |

### Board Number Normalization

1. **Uppercase everything:** `nm-a251` → `NM-A251`
2. **Strip whitespace around hyphens:** `820 - 02016` → `820-02016`
3. **Normalize Apple revisions:** `820-02016A` → `820-02016-A` (ensure hyphen before revision letter)
4. **Strip "REV:" prefixes from Compal/Quanta:** `DA0PDIMB8G0 REV:G` → board is `DA0PDIMB8G0`, revision is `G`
5. **Deduplicate:** Same board_number + brand = same record. Merge model info from multiple sources.

### Model Name Normalization

1. **Strip "Laptop"/"Notebook"/"Motherboard" suffixes**
2. **Normalize screen sizes:** `15.6"`, `15.6 inch`, `15.6-inch` → `15.6"`
3. **Expand abbreviations:** `ThinkPad` (not `TP`), `Inspiron` (not `Insp`)
4. **Year normalization:** `2019`, `Mid 2019`, `mid-2019` → `Mid 2019` (for Apple)

### Deduplication Strategy

When the same board appears from multiple sources:
1. Use `board_number + brand` as the unique key
2. Prefer the most specific model name (e.g., "ThinkPad T450s 20BX" over "ThinkPad T450")
3. Merge alias numbers from all sources into `board_aliases`
4. Merge compatible models from all sources into `model_aliases`
5. Track `source` for provenance

---

## 7. Crawling Architecture

### Source Adapter Pattern

Each data source gets an isolated adapter module implementing a common interface:

```
interface SourceAdapter {
    name: string                    // e.g., "logiwiki", "laptopschematic"
    crawl(): AsyncIterable<RawEntry>  // yields raw entries one at a time
}

interface RawEntry {
    brand: string          // raw brand string from source
    model: string          // raw model string from source
    board_number: string   // raw board number from source
    aliases: string[]      // any additional identifiers found
    board_name?: string    // codename if available
    odm?: string           // ODM if available
    source_url?: string    // where this entry came from
    raw_data?: object      // any extra fields for debugging
}
```

### Adapter List

| Adapter | Priority | Method | Est. Records |
|---|---|---|---|
| `logiwiki` | 1 | HTTP GET + HTML parse | ~200 |
| `laptopschematic-list` | 1 | HTTP GET list.txt + text parse | ~2,000+ |
| `ebay-api` | 1 | REST API (OAuth) | ~5,000+ |
| `boardschematic` | 2 | HTTP GET + HTML parse (paginated) | ~1,600 |
| `gotlaptopparts` | 2 | HTTP GET + HTML parse (paginated) | ~5,500 |
| `aliexpress-google` | 3 | Google search index | variable |

### Crawl Pipeline

```
Source Adapter → RawEntry → Normalizer → DB Upsert
                                ↓
                         Regex extractor (for board numbers in filenames/titles)
                                ↓
                         Brand normalizer
                                ↓
                         Deduplication check
                                ↓
                         INSERT or UPDATE + merge aliases
```

### Crawl Configuration

```json
{
    "crawl_delay_ms": 1000,
    "max_concurrent_requests": 2,
    "user_agent": "BoardDB/1.0 (laptop repair database)",
    "retry_attempts": 3,
    "retry_delay_ms": 5000,
    "ebay_api": {
        "client_id": "...",
        "client_secret": "...",
        "environment": "PRODUCTION"
    }
}
```

### Error Handling
- Log failed URLs, continue crawling
- Retry transient failures (429, 503) with exponential backoff
- Store partial results — a crashed crawl should not lose already-fetched data
- Each adapter tracks its own cursor/pagination state for resumability

---

## 8. Filename Matching Engine

This is the core utility for the boardviewer integration: given a messy filename, extract the board number and look it up in the database.

### Input Examples (Real-World Messy Filenames)

```
NM-A251 Rev 1.0 schematic.pdf
820-02016-A_MLB_Schematic.pdf
ThinkPad_T450_AIVL0_NM-A251_BoardView.brd
DELL_Inspiron_7370_Wistron_16839-1_Schematic.pdf
LA-E541P REV 0.3 compal.pdf
A1708_820-00840_logic_board.pdf
HP_ProBook_450_G6_DAX8JMB16E0_schematic.pdf
random junk NM-B291 more junk.bin
LENOVO-T580-NM-B463-01LW234.zip
```

### Matching Algorithm

```
function matchFilename(filename: string): MatchResult[] {
    1. Apply all regex patterns from Section 2 (priority order)
    2. For each match found:
       a. Normalize the board number
       b. Look up in `boards` table (exact match)
       c. If not found, look up in `board_aliases` table
       d. If found, return { board_number, brand, model, confidence }
    3. If multiple patterns match, return all (let caller decide)
    4. If no match, return empty array
}
```

### Confidence Scoring

| Scenario | Confidence |
|---|---|
| Board number found in `boards` table with exact match | HIGH |
| Board number found in `board_aliases` table | HIGH |
| Board number regex matches but not in DB | MEDIUM (valid format but unknown board) |
| Brand name also present in filename, matching DB record | +boost |
| Model name also present in filename, matching DB record | +boost |
| Multiple board numbers found in same filename | flag for review |

---

## 9. Folder Reorganization

### Target Structure

```
{root}/
  {Brand}/
    {Model}/
      {BoardNumber}/
        schematics/
          *.pdf
        boardviews/
          *.brd, *.bv, *.fz
        bios/
          *.bin, *.rom, *.fd
        datasheets/
          *.pdf
        photos/
          *.jpg, *.png
        other/
          (everything else)
```

### File Type Classification

| Extension(s) | Category |
|---|---|
| `.pdf` (with "schematic" in name or content) | `schematics/` |
| `.pdf` (with "datasheet" in name) | `datasheets/` |
| `.brd`, `.bv`, `.fz`, `.bvr`, `.cad` | `boardviews/` |
| `.bin`, `.rom`, `.fd`, `.cap` | `bios/` |
| `.jpg`, `.jpeg`, `.png`, `.bmp`, `.tiff` | `photos/` |
| everything else | `other/` |

### Reorganization Process

1. **Scan** — Walk the source directory tree, collect all files
2. **Match** — For each file, run the filename matching engine
3. **Plan** — Generate a move plan: `{source_path} → {target_path}`
4. **Review** — Present the plan to the user (dry run)
5. **Execute** — Move files (with `--dry-run` and `--execute` flags)
6. **Report** — Summary of moved, unmatched, and conflicting files

### Handling Unmatched Files
- Files with no board number match go to `_unmatched/` directory
- Files with board numbers not in the DB go to `_unknown_boards/{board_number}/`
- Both categories can be reviewed manually and fed back into the database

---

## 10. Implementation Recommendations

### Phase 1: Database Bootstrap (Immediate)
1. Implement `logiwiki` adapter — fastest to get working, clean data
2. Implement `laptopschematic-list` adapter — single file download, biggest cross-brand coverage
3. Implement `boardschematic` adapter — fills gaps
4. Build the regex matching engine and database schema
5. **Expected yield: ~4,000-5,000 unique board number records**

### Phase 2: Marketplace Enrichment
1. Implement `ebay-api` adapter — structured data, no scraping
2. Implement `gotlaptopparts` adapter — rich title data
3. Merge marketplace data to add model aliases and OEM part numbers
4. **Expected yield: 8,000-12,000+ records with rich alias data**

### Phase 3: Boardviewer Integration
1. Integrate the filename matching engine into the existing boardviewer
2. Add folder reorganization as a command/feature
3. Add "identify this board" lookup in the UI

### Phase 4: Maintenance
1. Schedule periodic re-crawls (weekly/monthly)
2. Add manual entry for boards not found in any source
3. Community contributions (users add mappings they discover)

### Technology Notes (Language-Agnostic)

- **Database:** SQLite — portable, no server, perfect for this use case
- **HTML parsing:** Any library that handles real-world HTML (cheerio/Node, BeautifulSoup/Python, etc.)
- **HTTP client:** Needs configurable User-Agent, retry logic, rate limiting
- **Regex engine:** Standard PCRE-compatible regex. All patterns in Section 2 are PCRE.
- **eBay API:** RESTful JSON over HTTPS, OAuth 2.0 client credentials flow

---

## Appendix A: ODM Manufacturer Reference

Most laptop motherboards are manufactured by a handful of ODMs. Knowing the ODM helps identify the board number format:

| ODM | Common Brands Served | Board Number Format |
|---|---|---|
| **Compal** | Dell, Lenovo, HP, Acer, Toshiba | `LA-xxxxP` |
| **Quanta** | HP, Dell, Acer, Toshiba, Apple (older) | `DA0xxxxMByyy` |
| **Wistron** | Dell, HP, Acer | Numeric (`16839-1`), `448.xxx.xxx` |
| **LCFC (Lenovo)** | Lenovo | `NM-xxxx` |
| **Inventec** | HP, Dell, Toshiba | `6050Axxxxxxxxx` |
| **Pegatron** | ASUS, Apple (older) | Various |
| **Foxconn** | Dell, HP, Sony | Various |
| **HuaQin** | Lenovo, Xiaomi | Various |

## Appendix B: Apple-Specific Reference

Apple uses a layered identification system:

| Identifier | Format | Example | Purpose |
|---|---|---|---|
| A-Number | `A\d{4}` | A1398 | Device model (chassis) |
| EMC Number | `EMC \d{4}` | EMC 2909 | Regulatory/FCC identifier |
| Model ID | `MacBookProX,Y` | MacBookPro11,4 | Hardware configuration |
| Board Number | `820-\d{4,5}-[A-Z]` | 820-3787-A | PCB identifier (what you need for repair) |
| Service Part | `661-\d{5}` | 661-07652 | Replacement part ordering |
| EEE Code | 3-4 chars | FC2 | Short encode of model+config |

**One A-number can map to multiple board numbers** (different years/configs use different boards).
**One board number typically maps to one A-number** (but may fit multiple sub-models of that A-number).

## Appendix C: Source URLs Quick Reference

| Source | Primary URL | Data Type |
|---|---|---|
| LogiWiki | `https://logi.wiki/index.php/Board_Number_by_A_Number` | Wiki tables + text |
| LogiWiki (schematics) | `https://logi.wiki/index.php/Schematics_and_Boardviews_Availability` | Wiki tables |
| LaptopSchematic.com | `https://www.laptopschematic.com/list.txt` | UTF-16LE text file |
| LaptopSchematic.com (posts) | `https://www.laptopschematic.com/{brand}/page/{N}/` | WordPress HTML |
| BoardSchematic.com | `https://www.boardschematic.com/{brand-slug}/page/{N}/` | WordPress HTML |
| GotLaptopParts.com | `https://www.gotlaptopparts.com/collections/motherboards` | Shopify HTML |
| eBay API | `https://api.ebay.com/buy/browse/v1/item_summary/search` | JSON REST API |
| HP PartSurfer | `https://partsurfer.hp.com/` | Web search |
| Lenovo PSREF | `https://psref.lenovo.com/` | Web app |
| iFixit API | `https://www.ifixit.com/api/2.0/` | JSON REST API |
| Beetstech | `https://beetstech.com/` | WooCommerce HTML |
