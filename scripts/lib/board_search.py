"""Tiny stdlib-only search-engine HTML scraper used by the board
classifier. Two backends:

  ddg  — POST to https://html.duckduckgo.com/html/  (no key, polite)
  bing — GET  to https://www.bing.com/search        (fallback)

Public surface is a single function:

  search(query, limit=8, backend="ddg", throttle_s=1.5) -> list[SearchResult]

A SearchResult is a small named tuple of (title, snippet, url). Both
backends are best-effort: HTML structure changes occasionally and the
parsers will silently return fewer results when that happens — the LLM
above can deal with thin context.

Hermetic test mode: set env BOARD_SEARCH_FIXTURE_DIR=/some/dir; the
scraper reads the cached HTML from <dir>/<sha1(backend:query)>.html
instead of hitting the network. Falls back to network when fixture is
missing. Useful for the eval harness and for re-running classification
without re-burning search budget.
"""

from __future__ import annotations

import gzip
import hashlib
import os
import random
import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional


@dataclass
class SearchResult:
    title: str
    snippet: str
    url: str


_USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/127.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, "
    "like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0",
]

_LAST_QUERY_T = 0.0  # module-level throttle


def _polite_sleep(throttle_s: float) -> None:
    global _LAST_QUERY_T
    if throttle_s <= 0:
        return
    elapsed = time.monotonic() - _LAST_QUERY_T
    if elapsed < throttle_s:
        time.sleep(throttle_s - elapsed)
    _LAST_QUERY_T = time.monotonic()


def _fixture_key(backend: str, query: str) -> str:
    return hashlib.sha1(f"{backend}:{query}".encode("utf-8")).hexdigest()


def _read_fixture(backend: str, query: str) -> Optional[str]:
    d = os.environ.get("BOARD_SEARCH_FIXTURE_DIR")
    if not d:
        return None
    path = Path(d) / f"{_fixture_key(backend, query)}.html"
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8", errors="replace")


def _write_fixture(backend: str, query: str, body: str) -> None:
    d = os.environ.get("BOARD_SEARCH_FIXTURE_DIR")
    if not d:
        return
    Path(d).mkdir(parents=True, exist_ok=True)
    Path(d, f"{_fixture_key(backend, query)}.html").write_text(
        body, encoding="utf-8"
    )


def _http(req: urllib.request.Request, timeout: float = 15.0) -> str:
    """One retry on 5xx / connection errors. Returns decoded body."""
    last_err: Optional[Exception] = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                charset = resp.headers.get_content_charset() or "utf-8"
                return raw.decode(charset, errors="replace")
        except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
            last_err = e
            if e.code < 500 or attempt > 0:
                raise
            time.sleep(2.0)
        except Exception as e:
            last_err = e
            if attempt > 0:
                raise
            time.sleep(1.0)
    raise RuntimeError(f"unreachable: {last_err}")


# ─── DuckDuckGo HTML ────────────────────────────────────────────────────


class _DdgParser(HTMLParser):
    """Walk the html.duckduckgo.com response. Result block looks like:

      <div class="result results_links results_links_deep web-result">
        <h2 class="result__title">
          <a class="result__a" href="...">TITLE</a>
        </h2>
        <a class="result__snippet" href="...">SNIPPET</a>
      </div>

    URLs are wrapped in /l/?uddg=... — we unwrap.
    """

    def __init__(self) -> None:
        super().__init__()
        self.results: list[SearchResult] = []
        self._mode: Optional[str] = None  # "title" | "snippet" | None
        self._cur_title = ""
        self._cur_snippet = ""
        self._cur_url = ""

    def _classes(self, attrs: list[tuple[str, Optional[str]]]) -> set[str]:
        for k, v in attrs:
            if k == "class" and v:
                return set(v.split())
        return set()

    def _href(self, attrs: list[tuple[str, Optional[str]]]) -> Optional[str]:
        for k, v in attrs:
            if k == "href":
                return v
        return None

    def handle_starttag(self, tag, attrs):
        cls = self._classes(attrs)
        if tag == "a" and "result__a" in cls:
            self._mode = "title"
            self._cur_title = ""
            href = self._href(attrs) or ""
            # Unwrap DDG redirect: /l/?uddg=<encoded>&rut=...
            m = re.search(r"uddg=([^&]+)", href)
            if m:
                self._cur_url = urllib.parse.unquote(m.group(1))
            else:
                self._cur_url = href
        elif tag == "a" and "result__snippet" in cls:
            self._mode = "snippet"
            self._cur_snippet = ""
        elif tag in ("div", "section") and ("result" in cls):
            # boundary — finalise prior block if both halves present
            self._maybe_emit()

    def handle_endtag(self, tag):
        if tag == "a" and self._mode == "title":
            self._mode = None
        elif tag == "a" and self._mode == "snippet":
            self._mode = None
            self._maybe_emit()

    def handle_data(self, data):
        if self._mode == "title":
            self._cur_title += data
        elif self._mode == "snippet":
            self._cur_snippet += data

    def _maybe_emit(self) -> None:
        title = self._cur_title.strip()
        snippet = self._cur_snippet.strip()
        url = self._cur_url.strip()
        if title and url:
            self.results.append(SearchResult(title=title, snippet=snippet, url=url))
        self._cur_title = self._cur_snippet = self._cur_url = ""


def _search_ddg(query: str, limit: int) -> list[SearchResult]:
    body = _read_fixture("ddg", query)
    if body is None:
        data = urllib.parse.urlencode({"q": query, "kl": "us-en"}).encode("utf-8")
        req = urllib.request.Request(
            "https://html.duckduckgo.com/html/",
            data=data,
            method="POST",
            headers={
                "User-Agent": random.choice(_USER_AGENTS),
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.5",
                "Accept-Encoding": "gzip",
                "Referer": "https://duckduckgo.com/",
            },
        )
        body = _http(req)
        _write_fixture("ddg", query, body)

    p = _DdgParser()
    try:
        p.feed(body)
        p.close()
    except Exception:
        pass  # html.parser is forgiving; partial output is fine
    out: list[SearchResult] = []
    seen_urls: set[str] = set()
    for r in p.results:
        if r.url in seen_urls or r.url.startswith("javascript:"):
            continue
        seen_urls.add(r.url)
        out.append(r)
        if len(out) >= limit:
            break
    return out


# ─── Bing HTML ─────────────────────────────────────────────────────────


_BING_LI_RE = re.compile(r'<li class="b_algo".*?</li>', re.DOTALL)
_BING_H2A_RE = re.compile(
    r'<h2[^>]*>.*?<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.DOTALL
)
# Two snippet shapes Bing has shipped over the past year:
#   <p class="b_lineclamp...">...</p>
#   <div class="b_caption"><p>...</p></div>
_BING_SNIPPET_RES = (
    re.compile(r'<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>(.*?)</p>', re.DOTALL),
    re.compile(r'<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>.*?<p[^>]*>(.*?)</p>',
               re.DOTALL),
)
_BING_REDIRECT_RE = re.compile(r"^https?://www\.bing\.com/ck/a\?", re.I)


def _strip_html(raw: str) -> str:
    txt = re.sub(r"<[^>]+>", " ", raw or "")
    txt = re.sub(r"&amp;", "&", txt)
    txt = re.sub(r"&nbsp;|&#0?160;", " ", txt)
    txt = re.sub(r"&#0?183;|&middot;", "·", txt)
    txt = re.sub(r"&#0?228;", "ä", txt)
    txt = re.sub(r"&quot;", '"', txt)
    txt = re.sub(r"&apos;|&#39;", "'", txt)
    txt = re.sub(r"&lt;", "<", txt)
    txt = re.sub(r"&gt;", ">", txt)
    txt = re.sub(r"\s+", " ", txt)
    return txt.strip()


def _unwrap_bing_url(href: str) -> str:
    """Bing wraps real URLs in /ck/a?u=... base64-ish encodes them. Best
    effort: pull the `u=` parameter and base64-decode if it starts with
    'a1' (Bing's tag) — otherwise return the passed href unchanged."""
    if not _BING_REDIRECT_RE.match(href):
        return href
    qs = urllib.parse.urlparse(href).query
    params = urllib.parse.parse_qs(qs)
    u = (params.get("u") or [""])[0]
    if not u.startswith("a1"):
        return href
    import base64

    raw = u[2:]
    raw += "=" * (-len(raw) % 4)
    try:
        return base64.urlsafe_b64decode(raw).decode("utf-8", errors="replace")
    except Exception:
        return href


def _search_bing(query: str, limit: int) -> list[SearchResult]:
    body = _read_fixture("bing", query)
    if body is None:
        # `mkt=en-US` + `setlang=en` defends against Bing serving in the
        # caller's geo-default language; we want consistent English snippets
        # for downstream prompt parsing.
        url = "https://www.bing.com/search?" + urllib.parse.urlencode(
            {"q": query, "form": "QBLH", "mkt": "en-US", "setlang": "en", "cc": "US"}
        )
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": random.choice(_USER_AGENTS),
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip",
            },
        )
        body = _http(req)
        _write_fixture("bing", query, body)

    out: list[SearchResult] = []
    for li_m in _BING_LI_RE.finditer(body):
        block = li_m.group(0)
        h2 = _BING_H2A_RE.search(block)
        if not h2:
            continue
        url = _unwrap_bing_url(h2.group(1).replace("&amp;", "&"))
        title = _strip_html(h2.group(2))
        snippet = ""
        for sr in _BING_SNIPPET_RES:
            m = sr.search(block)
            if m:
                snippet = _strip_html(m.group(1))
                break
        if title:
            out.append(SearchResult(title=title, snippet=snippet, url=url))
        if len(out) >= limit:
            break
    return out


# ─── public ────────────────────────────────────────────────────────────


_MOJEEK_LI_RE = re.compile(
    r'<a [^>]*class="(?:ob|title)[^"]*"[^>]*href="(https?://[^"]+)"[^>]*>'
    r'(.*?)</a>(.*?)<p class="s">(.*?)</p>',
    re.DOTALL,
)


def _search_mojeek(query: str, limit: int) -> list[SearchResult]:
    body = _read_fixture("mojeek", query)
    if body is None:
        url = "https://www.mojeek.com/search?" + urllib.parse.urlencode(
            {"q": query}
        )
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": random.choice(_USER_AGENTS),
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip",
            },
        )
        body = _http(req)
        _write_fixture("mojeek", query, body)

    out: list[SearchResult] = []
    seen_urls: set[str] = set()
    for m in _MOJEEK_LI_RE.finditer(body):
        url = m.group(1).replace("&amp;", "&")
        title = _strip_html(m.group(2))
        snippet = _strip_html(m.group(4))
        if not title or url in seen_urls:
            continue
        seen_urls.add(url)
        out.append(SearchResult(title=title, snippet=snippet, url=url))
        if len(out) >= limit:
            break
    return out


def search(
    query: str,
    limit: int = 8,
    backend: str = "mojeek",
    throttle_s: float = 1.5,
) -> list[SearchResult]:
    """Throttled HTML-scraping search. backend ∈ {mojeek, ddg, bing}.

    Default is Mojeek — the only public engine I've found in 2026 that
    doesn't aggressively CAPTCHA-wall scrapers AND returns relevant
    results for cryptic PCB codes (eBay/AliExpress listing snippets land
    in its index). DDG and Bing are kept as escape hatches: DDG
    CAPTCHAs after a burst, Bing has a habit of mis-tokenising codes
    like LA-9063P (Los Angeles fires in the first page of results).

    Empty result list is a valid outcome — the LLM upstream is responsible
    for deciding what to do with no signal.
    """
    if not query.strip():
        return []
    _polite_sleep(throttle_s)
    if backend == "mojeek":
        return _search_mojeek(query, limit)
    if backend == "ddg":
        return _search_ddg(query, limit)
    if backend == "bing":
        return _search_bing(query, limit)
    raise ValueError(f"unknown backend: {backend!r}")


if __name__ == "__main__":
    # Quick CLI for manual probing.
    import argparse
    import json as _json

    cli = argparse.ArgumentParser()
    cli.add_argument("query")
    cli.add_argument("--limit", type=int, default=8)
    cli.add_argument("--backend", choices=("ddg", "bing"), default="ddg")
    args = cli.parse_args()
    results = search(args.query, limit=args.limit, backend=args.backend)
    print(_json.dumps([r.__dict__ for r in results], indent=2))
