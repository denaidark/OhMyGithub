#!/usr/bin/env python3
"""Run focused GitHub repository searches for new browser games."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import subprocess
import sys
from pathlib import Path


DEFAULT_QUERIES = [
    "three.js game in:description",
    "threejs game in:description",
    '"React Three Fiber" game in:description',
    "webgpu game in:description",
    '"GPT-6 Astra" in:description',
    '"GPT-Astra" in:description',
]


def run_search(query: str, date: str, limit: int, qualifier: str) -> tuple[list[dict], str]:
    command = [
        "gh",
        "search",
        "repos",
        query,
        f"--{qualifier}",
        date,
        "--limit",
        str(limit),
        "--json",
        "fullName,createdAt,pushedAt,description,url,language,size",
    ]
    try:
        completed = subprocess.run(command, text=True, capture_output=True, check=False, timeout=30)
    except subprocess.TimeoutExpired:
        return [], "gh search timed out after 30 seconds"
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        return [], detail
    try:
        values = json.loads(completed.stdout or "[]")
    except json.JSONDecodeError as error:
        return [], f"invalid gh JSON: {error}"
    for value in values:
        value["matched_query"] = query
        value["matched_by"] = qualifier
    return values, ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", default=dt.datetime.now(dt.timezone.utc).date().isoformat())
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--pushed", action="store_true", help="Also search older repositories pushed on the date")
    parser.add_argument("--query", action="append", dest="queries", help="Replace defaults; repeat this option")
    parser.add_argument("--output", type=Path, help="Write a JSON array to this file")
    args = parser.parse_args()

    if shutil.which("gh") is None:
        print("gh CLI is not installed or is not on PATH", file=sys.stderr)
        return 2

    queries = args.queries or DEFAULT_QUERIES
    qualifiers = ["created"] + (["pushed"] if args.pushed else [])
    results: dict[str, dict] = {}
    failures = 0

    for qualifier in qualifiers:
        for query in queries:
            values, error = run_search(query, args.date, args.limit, qualifier)
            if error:
                failures += 1
                print(f"search failed ({qualifier}, {query}): {error}", file=sys.stderr)
                continue
            for value in values:
                key = value.get("fullName") or value.get("url")
                if not key:
                    continue
                existing = results.get(key)
                if existing is None:
                    results[key] = value
                else:
                    matches = existing.setdefault("matches", [])
                    matches.append({"query": value["matched_query"], "by": value["matched_by"]})

    output = sorted(results.values(), key=lambda value: (value.get("createdAt") or "", value.get("fullName") or ""))
    rendered = json.dumps(output, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)

    return 0 if output or failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
