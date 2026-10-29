# Field evidence: PDF index stalls (read-only, 2026-10-14)

## A) Local dev container (boardripper-dev-boardripper-dev-1, :1234)
- Boots: 1 ("pdfium engine ready in 1.919s", 2026-09-28 06:25), RestartCount 0. Only 15 log lines in 16 days; the --since 336h grep matched 0 lines (boot is older than 336h). No FAIL/get-instance/watchdog/locked lines at all.
- Memory: limit 2 GiB, GOMEMLIMIT 1843 MiB, RSS 44 MiB now (idle).
- Files (.devdata): pdfindex.db 40,960 B (dated Sep 4, empty), pdfindex.db-wal 0, -shm 32 KB, databank.db 294,912 B, databank.db-wal 8,272 B.
- DB copy: pdf_index_status 0 rows, pdf_pages 0 rows. No status distribution, no failures, no stuck rows. Search timings: not meaningful (empty index; not run).
- API: /api/pdfindex/stats = {"indexed":0,...,"pages":0} 200; /progress = running:false,total:0,workers:2; /api/health ok.
- Summary: the dev index has never been populated (library has no indexed PDFs), so it says nothing about stalls.

## B) Production NAS (rd-nas, Synology, 4 cores, 5.8 GB RAM)
Containers on the box: `boardripper` (:1336, live) and `boardripper-dev` (:1234, started 2026-10-13 23:20, 2 GiB limit, swap 4 GiB, RestartCount 0, same log pattern as live). Many other containers (2 CRM + postgres x2, snipe-it + mariadb, portainer, schem-sync) share the box.

Live `boardripper`:
- Started 2026-10-11 20:46:28, RestartCount 0, OOMKilled false, **HostConfig.Memory = 0 (no cgroup limit, so no GOMEMLIMIT line)**. docker stats: 69 MiB RSS of 5.65 GiB (idle, AFTER the incident). Data volume: /volume1/docker/boardripper/data -> /data. Library mounts: /volume1/AL ZEUG/{XZZ, DESKTOP/BOARDS STUFF, New Boards, LogiCloud/...}.
- Boots in the last 720h of logs: 1 (logs only go back to the 10-11 recreate).
- Files: pdfindex.db **15,020,761,088 B (15 GB)**, pdfindex.db-wal 9.2 MB, -shm 32 KB; databank.db 50 MB, databank.db-wal 1.3 MB.
- Status distribution (immutable read; may miss un-checkpointed WAL, 9 MB): indexed 64,282; empty 5,779; failed 92; pending 7; duplicate 3; indexing 1. pdf_pages 1,902,700 rows. Source: pdfium 70,151, pdfjs 3, dedup 3.
- Failed causes (92): ~86 open errors (`open (size N bytes): 3: incorrect format` = mostly xzz/Computers MSI / graphics-card PDFs; `4: invalid password`), and 6 timeouts:
  - `extract: timed out after 2m0s while extracting page 408 / 409 (input size 1941352 bytes)`
  - `... page 1153 (27,068,367 B)`, `page 1078 (21,695,220 B)`, `page 803 (19,957,486 B)`, `page 1131 (20,817,337 B)`
- **Stuck 'indexing' row:** file_id 110420, source pdfium, attempted_at 2026-10-11 20:55:04 -> ~2.1 days old, 15 pages stored; process never restarted since, no log line after 20:53:41. The 7 pending rows (96609, 97725, 100083, 101440, 105003, 105093, 105260) have 0 pages. /api/pdfindex/progress: running:false, total 102, done 102, errors 84, active_workers 0, current_file "...SM-A236E_QCOM_Common_Service_Schematic_Full.pdf". So the worker pool is idle while one row stays 'indexing' and 7 stay 'pending' (nothing re-picks them without a restart/run).
- Log (5,407 matching lines; 5,315 are the same message):
  - `20:49:39 pdfindex: page 408/504 GetPageText failed: module closed with exit_code(0)` then pages 409..504 `GetPageText failed: instance is closed` (one line per remaining page, same second)
  - `20:50:16 ... page 1153/1637 ... module closed with exit_code(0)`; `20:51:40 page 1078/1780 same`; `20:52:17 page 803/2504 ... module closed with context canceled`; `20:53:41 page 1131/3463 ... context canceled`, then 3463 "instance is closed" lines.
  - Pattern: a 2-minute per-file deadline closes the wazero module mid-file; the loop keeps calling GetPageText on the dead instance for every remaining page (5,315 wasted calls / log lines) instead of aborting. Five such events within ~4 minutes of boot, all on large (20-27 MB / 500-3,400 page) PDFs.
  - No "get instance", "watchdog", "database is locked", "SQLITE_BUSY", "requeue", panic or OOM lines. FAIL extract lines: 84 (incorrect format, invalid password, 6 timeouts).
- Search API (GET /api/databank/search, cold-ish, run from this Mac over Tailscale; sqlite3 on the NAS has no FTS5 module, DB is 15 GB so not copied; SQL timings by CLI not possible):
  | query | result |
  |---|---|
  | `10UF 25V` | 200, **96.1 s**, 382 KB |
  | `PP3V3` | 200, **29.2 s**, 710 KB |
  | `C` | no answer in 120 s (curl timeout) |
  | `1` | no answer in 120 s |
  | `U` | no answer in 120 s |
  | /api/pdfindex/stats | no answer in 60 s (curl exit 28; progress and health answer instantly) |
  Caveat: my queries ran back-to-back and later ones overlapped earlier still-running server work (the server may keep executing after the client gave up), so absolute times are inflated; load average went 0.4 -> 6.0 on 4 cores during/after. /api/health stayed 200 in 39 ms.
- System: nproc 4; free -m before: 5786 total, 3693 used, 444 free, 1648 cache, **swap 5519/5519 MB used (fully)**; after my searches: 4018 used, 151 free, swap still full. Load avg before 0.42/0.38/0.36. cgroup memory.max not readable (no `cat` in the scratch image; container has no limit anyway).

## Summary
1. Real stall mechanism visible on the live NAS: after the 2-min per-file extraction deadline the wazero module is closed, the page loop does not abort (5,315 "instance is closed" lines), and one row (file 110420) has been left in 'indexing' for 2+ days with the pool idle and 7 'pending' rows never picked up.
2. 6 of 92 failures are deadline kills on 20-27 MB / 500-3,400-page PDFs; the rest are unreadable/encrypted PDFs (incorrect format / invalid password) that fail fast and are fine.
3. Search is the bigger user-visible stall: on a 15 GB / 1.9 M-page index, multi-term search takes 30-96 s, single-letter/digit terms exceed 120 s, and /api/pdfindex/stats (likely COUNT scans) times out, while health is instant. Pure FTS/COUNT cost, not locking (no "database is locked" anywhere).
4. Host is memory-starved: swap fully used, live container has no memory limit (GOMEMLIMIT not set), shared with ~10 other containers; no OOM kill and no restart occurred though.
5. The dev container has an empty index, so nothing there; only the NAS reproduces the problem. Sqlite3 on the NAS lacks FTS5, so search SQL could not be timed in isolation.
