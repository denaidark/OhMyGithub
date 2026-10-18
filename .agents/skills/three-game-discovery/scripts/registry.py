"""Persistent registry helpers for verified game discoveries."""

from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path


DEFAULT_REGISTRY = Path(__file__).resolve().parents[1] / "games.json"


def now_utc() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def content_language(text: str) -> str:
    if not text.strip():
        return "Unknown"
    if re.search(r"[\u3400-\u4dbf\u4e00-\u9fff]", text):
        return "Chinese"
    if re.search(r"[A-Za-z]", text):
        return "English"
    return "Other"


def engine_for(result: dict) -> str:
    text = json.dumps(result.get("evidence", {}), ensure_ascii=False) + "\n" + (result.get("sampled_text") or "")
    checks = [
        ("Three.js", r"three|THREE|react-three|WebGLRenderer"),
        ("PlayCanvas", r"playcanvas"),
        ("Godot", r"godot|\.gd\b"),
        ("Unity", r"unity|unity3d|\.unity3d\b"),
        ("Unreal Engine", r"unreal engine|ue5|\.uproject\b"),
        ("Babylon.js", r"babylon(?:\.js)?"),
        ("Phaser", r"phaser"),
        ("PixiJS", r"pixi(?:\.js)?"),
    ]
    for name, pattern in checks:
        if re.search(pattern, text, re.IGNORECASE):
            return name
    return "Unknown"


def normalize(result: dict) -> dict:
    created_at = result.get("createdAt") or ""
    text = (result.get("description") or "") + "\n" + (result.get("sampled_text") or "")
    record = {
        "date": created_at[:10] or "Unknown",
        "repo": result.get("fullName"),
        "url": result.get("url"),
        "created_at": created_at,
        "star_count": result.get("star_count", 0),
        "language": content_language(text),
        "programming_language": result.get("programming_language") or "Unknown",
        "engine": result.get("engine") or engine_for(result),
        "created_with": result.get("created_with", []),
        "description": result.get("description"),
        "confidence": "high" if result.get("accepted") and result.get("uses_three") else "medium",
        "evidence": result.get("evidence", {}),
        "discovered_at": now_utc(),
    }
    if result.get("created_with_evidence"):
        record["created_with_evidence"] = result["created_with_evidence"]
    return record


def upsert(results: list[dict], registry_path: Path = DEFAULT_REGISTRY) -> int:
    existing = {item.get("repo"): item for item in _load(registry_path) if item.get("repo")}
    saved = 0
    for result in results:
        if not result.get("accepted") or not result.get("fullName"):
            continue
        existing[result["fullName"]] = normalize(result)
        saved += 1
    games = sorted(existing.values(), key=lambda item: (item.get("date", ""), item.get("repo", "")), reverse=True)
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    registry_path.write_text(
        json.dumps({"schema_version": 1, "updated_at": now_utc(), "games": games}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return saved


def _load(registry_path: Path) -> list[dict]:
    if not registry_path.exists():
        return []
    try:
        payload = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return payload.get("games", []) if isinstance(payload, dict) else []
