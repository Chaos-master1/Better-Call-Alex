"""Fetch the CourtListener bulk snapshot (CLAUDE.md §4, §7 canon command).

Downloads the ~6 GB of bulk files the ETL consumes into data/bulk/, plus
the snapshot schema. Files already present are skipped (pass --force to
re-fetch). The 350 GB opinions + clusters CSVs live in data/raw/ and are
NOT fetched here — copy them out of band (they exceed any reasonable
single download step and you almost certainly already have them if you
are rebuilding).

Manifest = exactly what build_corpus.py consumes. courthouses-*.csv.bz2
exists upstream but no stage reads it, so it is deliberately not fetched.
"""
import argparse
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import BULK, RAW  # noqa: E402

BASE = "https://storage.courtlistener.com/bulk-data/"
SNAPSHOT = "2026-06-30"

# (filename, target dir, advisory bytes; 0 = unknown/small, no enforcement —
# upstream does not publish hashes, so size is informational only)
FILES = [
    ("dockets-2026-06-30.csv.bz2", BULK, 4_700_000_000),
    ("citation-map-2026-06-30.csv.bz2", BULK, 502_000_000),
    ("citations-2026-06-30.csv.bz2", BULK, 121_000_000),
    ("parentheticals-2026-06-30.csv.bz2", BULK, 275_000_000),
    ("courts-2026-06-30.csv.bz2", BULK, 50_000),
    ("people-db-people-2026-06-30.csv.bz2", BULK, 2_000_000),
    ("schema-2026-06-30.sql", BULK, 470_000),
    ("opinion-clusters-2026-06-30.csv", RAW, 12_050_000_000),
]


def fetch_one(name: str, dest_dir: Path) -> Path:
    dest = dest_dir / name
    url = BASE + name
    req = urllib.request.Request(
        url, headers={"User-Agent": "better-call-alex-etl/1.0"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=300) as resp:
        if resp.status != 200:
            raise SystemExit(f"{url}: HTTP {resp.status}")
        total = int(resp.headers.get("Content-Length") or 0)
        got = 0
        last_log = t0
        with open(dest, "wb") as f:
            while True:
                chunk = resp.read(4 * 1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                now = time.time()
                if now - last_log >= 30:
                    pct = f"{got / total * 100:.1f}%" if total else f"{got:,} B"
                    print(f"  {name}: {pct} ({got / max(now - t0, 1e-9) / 1e6:.1f} MB/s)",
                          flush=True)
                    last_log = now
    dt = time.time() - t0
    print(f"[download] {name}: {got:,} B in {dt:.0f}s", flush=True)
    return dest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true",
                    help="re-fetch even when the file exists")
    ap.add_argument("--only", help="fetch a single manifest file")
    ap.add_argument("--list", action="store_true",
                    help="print the manifest and exit")
    args = ap.parse_args()

    names = [(n, d) for n, d, _ in FILES]
    if args.list:
        for n, d, size in FILES:
            have = (d / n).exists()
            print(f"  {'have' if have else 'need'}  {d.name}/{n}  (~{size:,} B)")
        return
    if args.only:
        if args.only not in [n for n, _, _ in FILES]:
            raise SystemExit(f"not in manifest: {args.only}")
        names = [(n, d) for n, d, _ in FILES if n == args.only]

    for _, d in names:
        d.mkdir(parents=True, exist_ok=True)
    missing = [(n, d) for n, d in names if not (d / n).exists()]
    if args.force:
        missing = list(names)
    if not missing:
        print("[download] all manifest files present")
        return
    print(f"[download] fetching {len(missing)} file(s)")
    for n, d in missing:
        fetch_one(n, d)
    print("[download] complete — verify against data-pipeline.md, then run the ETL")


if __name__ == "__main__":
    main()
