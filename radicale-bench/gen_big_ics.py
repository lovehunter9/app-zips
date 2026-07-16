"""Generate large but valid RFC-5545 ICS files for stress-testing Radicale on Olares.

Outputs four files in the same directory:
  - radicale-bench-small.ics    (~5,000 events, ~1.5 MB)   - light user (1 year)
  - radicale-bench-realmax.ics  (~15,000 events, ~5 MB)    - heavy user real upper bound
  - radicale-bench-medium.ics   (~20,000 events, ~6 MB)    - stress test, near 300s limit
  - radicale-bench-large.ics    (~50,000 events, ~15 MB)   - extreme synthetic load

Upload one of these via the Radicale Web UI to trigger the Envoy 15s timeout.
Start with the small file; if upload completes in under 15s, try medium, then large.
"""
from __future__ import annotations

import datetime as dt
import os
import string
import random
from pathlib import Path

random.seed(20260522)
OUT_DIR = Path(__file__).resolve().parent

VCAL_HEAD = (
    "BEGIN:VCALENDAR\r\n"
    "VERSION:2.0\r\n"
    "PRODID:-//Olares//Radicale Bench//EN\r\n"
    "CALSCALE:GREGORIAN\r\n"
)
VCAL_TAIL = "END:VCALENDAR\r\n"


def make_event(idx: int, base: dt.datetime) -> str:
    start = base + dt.timedelta(minutes=idx * 7)
    end = start + dt.timedelta(minutes=30)
    fmt = lambda d: d.strftime("%Y%m%dT%H%M%SZ")
    blurb = "".join(random.choices(string.ascii_letters + string.digits, k=180))
    return (
        "BEGIN:VEVENT\r\n"
        f"UID:bench-{idx}-{random.randint(1, 9_999_999)}@radicale.test\r\n"
        f"DTSTAMP:{fmt(base)}\r\n"
        f"DTSTART:{fmt(start)}\r\n"
        f"DTEND:{fmt(end)}\r\n"
        f"SUMMARY:Bench event #{idx}\r\n"
        f"DESCRIPTION:{blurb}\r\n"
        "STATUS:CONFIRMED\r\n"
        "TRANSP:OPAQUE\r\n"
        "END:VEVENT\r\n"
    )


def build(name: str, count: int) -> Path:
    base = dt.datetime(2026, 1, 1, 9, 0, 0)
    path = OUT_DIR / name
    with path.open("w", encoding="utf-8", newline="") as fh:
        fh.write(VCAL_HEAD)
        for i in range(1, count + 1):
            fh.write(make_event(i, base))
        fh.write(VCAL_TAIL)
    size_mb = path.stat().st_size / (1024 * 1024)
    print(f"  {path.name:32s} {count:>7d} events   {size_mb:>6.2f} MB")
    return path


def main() -> None:
    print("Generating Radicale stress-test ICS files in:", OUT_DIR)
    build("radicale-bench-small.ics", 5_000)
    build("radicale-bench-realmax.ics", 15_000)
    build("radicale-bench-medium.ics", 20_000)
    build("radicale-bench-large.ics", 50_000)
    print("\nUpload via the Radicale Web UI (Bench calendar → Upload).")


if __name__ == "__main__":
    main()
