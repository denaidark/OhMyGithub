#!/usr/bin/env python3
"""Find likely new game repositories in one GH Archive hourly file."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import re
import sys
import urllib.error
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", required=True, help="UTC date in YYYY-MM-DD format")
    parser.add_argument("--hour", type=int, required=True, choices=range(24), help="One archive hour; use one hour at a time")
    parser.add_argument("--pattern", default=r"(three|threejs|webgl|game|r3f|astra)")
    args = parser.parse_args()

    date = dt.date.fromisoformat(args.date)
    url = f"https://data.gharchive.org/{date:%Y-%m-%d}-{args.hour:02d}.json.gz"
    matcher = re.compile(args.pattern, re.IGNORECASE)
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            with gzip.GzipFile(fileobj=response) as compressed:
                for line in compressed:
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if event.get("type") != "CreateEvent":
                        continue
                    payload = event.get("payload") or {}
                    if payload.get("ref_type") != "repository":
                        continue
                    repo = event.get("repo") or {}
                    name = repo.get("name", "")
                    if matcher.search(name):
                        print(json.dumps({"name": name, "createdAt": event.get("created_at"), "url": f"https://github.com/{name}"}))
    except (OSError, ValueError, urllib.error.URLError) as error:
        print(f"could not read {url}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
