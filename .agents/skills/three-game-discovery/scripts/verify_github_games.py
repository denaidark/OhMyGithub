#!/usr/bin/env python3
"""Verify GitHub candidates and persist accepted games in games.json."""

from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
from pathlib import Path

from registry import DEFAULT_REGISTRY, upsert


THREE_MARKERS = [
    ("THREE.", r"\bTHREE\."),
    ("THREE.WebGLRenderer", r"THREE\.WebGLRenderer"),
    ("from three", r"from\s+[\"']three(?:/|[\"'])"),
    ("three.module.js", r"three\.module\.js"),
    ("three.min.js", r"three\.min\.js"),
    ("React Three Fiber", r"@react-three/"),
]
GAME_MARKERS = [
    ("game", r"\bgame\b"),
    ("playable", r"playable"),
    ("player", r"player"),
    ("enemy", r"enemy"),
    ("shooter", r"shooter"),
    ("racer", r"racer"),
    ("racing", r"racing"),
    ("physics", r"physics"),
    ("level", r"level"),
    ("controls", r"controls"),
]
NON_GAME_MARKERS = [
    ("web platform", r"\bweb platform\b"),
    ("web application", r"\bweb application\b"),
    ("anatomy viewer", r"anatomy viewer"),
    ("catalog", r"\bcatalog\b"),
    ("registry", r"\bregistry\b"),
    ("dashboard", r"\bdashboard\b"),
    ("museum", r"\bmuseum\b"),
    ("showcase", r"\bshowcase\b"),
    ("explorer", r"\bexplorer\b"),
]
MODEL_MARKERS = [
    ("Astra", r"GPT[- ]?6?\s*Astra|GPT[- ]?Astra"),
    ("Opus", r"\bOpus\b"),
    ("Fable", r"\bFable\b"),
]


def gh_json(arguments: list[str]) -> object:
    try:
        completed = subprocess.run(
            ["gh", "api", *arguments],
            text=True,
            capture_output=True,
            check=False,
            timeout=20,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"gh api timed out after 20 seconds: {' '.join(arguments)}") from error
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout).strip())
    return json.loads(completed.stdout)


def read_file(owner_repo: str, path: str, reference: str) -> str:
    try:
        payload = gh_json([f"repos/{owner_repo}/contents/{path}?ref={reference}"])
        encoded = payload.get("content", "") if isinstance(payload, dict) else ""
        return base64.b64decode(encoded).decode("utf-8", errors="replace")[:250_000]
    except (RuntimeError, ValueError, KeyError):
        return ""


def matching_labels(text: str, markers: list[tuple[str, str]]) -> list[str]:
    return [label for label, marker in markers if re.search(marker, text, re.IGNORECASE)]


def snippets(text: str, labels: list[str], markers: list[tuple[str, str]]) -> dict[str, str]:
    output = {}
    for label in labels:
        pattern = dict(markers)[label]
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            output[label] = text[max(0, match.start() - 80):match.end() + 120].replace("\n", " ")
    return output


def verify(owner_repo: str) -> dict:
    result = {
        "fullName": owner_repo,
        "non_empty": False,
        "uses_three": False,
        "game_likelihood": False,
        "accepted": False,
    }
    try:
        metadata = gh_json([f"repos/{owner_repo}"])
        tree = gh_json([f"repos/{owner_repo}/git/trees/{metadata['default_branch']}?recursive=1"])
    except (RuntimeError, KeyError, TypeError, json.JSONDecodeError) as error:
        result["error"] = str(error)
        return result

    result.update(
        {
            "url": metadata.get("html_url"),
            "createdAt": metadata.get("created_at"),
            "pushedAt": metadata.get("pushed_at"),
            "description": metadata.get("description"),
            "size": metadata.get("size"),
            "programming_language": metadata.get("language"),
            "star_count": metadata.get("stargazers_count", 0),
        }
    )
    paths = [entry.get("path", "") for entry in tree.get("tree", []) if entry.get("type") == "blob"]
    result["non_empty"] = bool(paths)
    preferred = sorted(
        paths,
        key=lambda path: (
            0 if path.lower() in {"readme.md", "package.json", "index.html"} else 1,
            0 if any(part in path.lower() for part in ("src/", "game", "scene", "main", "index")) else 1,
            len(path),
        ),
    )[:12]
    pieces: list[tuple[str, str]] = []
    for path in preferred:
        if path.lower().endswith((".js", ".jsx", ".ts", ".tsx", ".html", ".json", ".md")):
            pieces.append((path, read_file(owner_repo, path, metadata["default_branch"])))
    sampled_text = "\n".join(content for _, content in pieces)
    description_and_readme = (metadata.get("description") or "") + "\n" + "\n".join(
        content for path, content in pieces if path.lower().endswith("readme.md")
    )
    result["sampled_text"] = sampled_text
    three_hits = matching_labels(sampled_text, THREE_MARKERS)
    game_text = (metadata.get("description") or "") + "\n" + sampled_text
    game_hits = matching_labels(game_text, GAME_MARKERS)
    non_game_hits = matching_labels(game_text, NON_GAME_MARKERS)
    explicit_game = bool(re.search(r"\b(game|gameplay|playable|racer|racing|shooter|platformer)\b", game_text, re.IGNORECASE))
    model_hits = matching_labels(description_and_readme, MODEL_MARKERS)
    result["uses_three"] = bool(three_hits)
    result["game_likelihood"] = bool(game_hits) and (not non_game_hits or explicit_game)
    result["created_with"] = model_hits
    result["created_with_evidence"] = snippets(description_and_readme, model_hits, MODEL_MARKERS)
    result["evidence"] = {
        "three": three_hits,
        "game": game_hits,
        "non_game": non_game_hits,
        "explicit_game_term": explicit_game,
        "created_with": model_hits,
        "created_with_snippets": result["created_with_evidence"],
        "sampled_paths": preferred,
    }
    result["accepted"] = result["non_empty"] and result["uses_three"] and result["game_likelihood"]
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="JSON produced by search_github_games.py")
    source.add_argument("--repo", action="append", help="OWNER/REPO; repeat this option")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--no-save", action="store_true", help="Do not update the persistent registry")
    args = parser.parse_args()

    if args.input:
        candidates = json.loads(args.input.read_text(encoding="utf-8"))
        repositories = [item["fullName"] for item in candidates if item.get("fullName")]
    else:
        repositories = args.repo

    results = [verify(repository) for repository in repositories]
    if not args.no_save:
        saved = upsert(results, args.registry)
        print(f"saved {saved} accepted record(s) to {args.registry}", file=sys.stderr)
    rendered = json.dumps(results, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
