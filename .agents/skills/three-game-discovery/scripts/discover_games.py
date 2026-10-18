#!/usr/bin/env python3
"""Discover, verify, and persist browser game repositories in one command."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from registry import DEFAULT_REGISTRY, upsert
from search_github_games import DEFAULT_QUERIES, run_search
from verify_github_games import verify


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", required=True, help="UTC repository creation date")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--pushed", action="store_true", help="Also inspect older repositories pushed on the date")
    parser.add_argument("--query", action="append", dest="queries", help="Replace defaults; repeat this option")
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--output", type=Path, help="Write verification results to this file")
    parser.add_argument("--no-save", action="store_true", help="Run verification without updating games.json")
    args = parser.parse_args()

    queries = args.queries or DEFAULT_QUERIES
    qualifiers = ["created"] + (["pushed"] if args.pushed else [])
    candidates: dict[str, dict] = {}
    failures = 0
    for qualifier in qualifiers:
        for query in queries:
            values, error = run_search(query, args.date, args.limit, qualifier)
            if error:
                failures += 1
                print(f"search failed ({qualifier}, {query}): {error}", file=sys.stderr)
                continue
            for value in values:
                candidates.setdefault(value.get("fullName"), value)

    results = [verify(repo) for repo in candidates if repo]
    if not args.no_save:
        saved = upsert(results, args.registry)
        print(f"saved {saved} accepted record(s) to {args.registry}", file=sys.stderr)
    rendered = json.dumps(results, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 0 if results or failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
