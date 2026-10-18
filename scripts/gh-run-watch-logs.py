#!/usr/bin/env python3
"""Watch a GitHub Actions run and print logs while jobs are still running.

This uses the same internal HTTP endpoints as github.com's Actions job page.
Those endpoints are unsupported and may change without notice.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any


GITHUB = "https://github.com"
API = "https://api.github.com"
TERMINAL = {"completed"}


class WatchError(RuntimeError):
    pass


def gh_output(*args: str) -> str:
    result = subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True
    )
    return result.stdout.strip()


def get_token() -> str:
    try:
        return gh_output("auth", "token")
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        raise WatchError("gh authentication is required; run `gh auth login`") from exc


def get_repo(explicit: str | None) -> str:
    if explicit:
        return explicit
    try:
        return gh_output("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner")
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        raise WatchError("could not infer repository; pass --repo OWNER/REPO") from exc


def parse_fetch_nonce(html: str) -> str:
    patterns = (
        r'<meta[^>]+name=["\']fetch-nonce["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']fetch-nonce["\']',
    )
    for pattern in patterns:
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            return match.group(1)
    raise WatchError("GitHub job page did not contain a fetch nonce")


@dataclass
class JobState:
    api_id: int
    name: str
    html_url: str
    internal_id: str | None = None
    nonce: str | None = None
    printed_line_ids: dict[str, set[str]] = field(default_factory=dict)
    announced_steps: set[str] = field(default_factory=set)


class GitHubClient:
    def __init__(self, token: str, repo: str, run_id: int):
        self.token = token
        self.repo = repo
        self.run_id = run_id
        self.jar = http.cookiejar.CookieJar()
        self.web = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar)
        )
        self.plain = urllib.request.build_opener()

    @property
    def auth_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "User-Agent": "aiplay-gh-run-watch-logs/1",
        }

    def _read(self, opener, request: urllib.request.Request) -> tuple[int, Any, bytes]:
        try:
            with opener.open(request, timeout=30) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as exc:
            body = exc.read()
            if exc.code in {301, 302, 303, 307, 308}:
                return exc.code, exc.headers, body
            detail = body.decode("utf-8", "replace")[:300].strip()
            raise WatchError(f"GitHub returned HTTP {exc.code}: {detail}") from exc

    def api_json(self, path: str) -> Any:
        request = urllib.request.Request(
            API + path,
            headers={
                **self.auth_headers,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        _, _, body = self._read(self.plain, request)
        return json.loads(body)

    def run(self) -> dict[str, Any]:
        return self.api_json(f"/repos/{self.repo}/actions/runs/{self.run_id}")

    def jobs(self) -> list[dict[str, Any]]:
        data = self.api_json(
            f"/repos/{self.repo}/actions/runs/{self.run_id}/jobs?per_page=100"
        )
        return data["jobs"]

    def prepare_job(self, job: JobState) -> None:
        request = urllib.request.Request(job.html_url, headers=self.auth_headers)
        _, _, body = self._read(self.web, request)
        html = body.decode("utf-8", "replace")
        job.nonce = parse_fetch_nonce(html)
        if not job.internal_id:
            pattern = rf"/actions/runs/{self.run_id}/jobs/(\d+)/steps"
            match = re.search(pattern, html)
            if not match:
                raise WatchError(
                    f"GitHub did not expose its internal ID for job {job.api_id}; "
                    "pass --internal-job-id from the job page's data-job-steps-url"
                )
            job.internal_id = match.group(1)

    def steps(self, job: JobState) -> list[dict[str, Any]]:
        if not job.internal_id or not job.nonce:
            self.prepare_job(job)
        path = (
            f"/{self.repo}/actions/runs/{self.run_id}/jobs/"
            f"{job.internal_id}/steps?change_id=0"
        )
        request = urllib.request.Request(
            GITHUB + path,
            headers={
                **self.auth_headers,
                "Accept": "application/json",
                "Referer": job.html_url,
                "X-Fetch-Nonce": job.nonce or "",
                "X-Requested-With": "XMLHttpRequest",
            },
        )
        try:
            _, _, body = self._read(self.web, request)
        except WatchError:
            # Nonces and the short-lived web session can expire during long runs.
            job.internal_id = None
            job.nonce = None
            self.prepare_job(job)
            return self.steps(job)
        return json.loads(body)

    def backscroll(self, job: JobState, step_id: str) -> list[dict[str, str]]:
        if not job.internal_id or not job.nonce:
            self.prepare_job(job)
        url = (
            f"{GITHUB}/{self.repo}/actions/runs/{self.run_id}/jobs/"
            f"{job.internal_id}/steps/{step_id}/backscroll"
        )
        request = urllib.request.Request(
            url,
            headers={
                **self.auth_headers,
                "Accept": "application/json",
                "Referer": job.html_url,
                "X-Fetch-Nonce": job.nonce or "",
                "X-Requested-With": "XMLHttpRequest",
            },
        )
        _, _, body = self._read(self.web, request)
        data = json.loads(body)
        return data.get("lines", [])


def print_new_lines(
    job: JobState, step: dict[str, Any], lines: list[dict[str, str]]
) -> None:
    step_id = str(step["id"])
    seen = job.printed_line_ids.setdefault(step_id, set())
    additions = [line for line in lines if str(line.get("id")) not in seen]
    for line in lines:
        seen.add(str(line.get("id")))
    if not additions:
        return
    if step_id not in job.announced_steps:
        print(f"\n==> {job.name} / {step['name']}", flush=True)
        job.announced_steps.add(step_id)
    for item in additions:
        text = item.get("line", "")
        print(text, end="" if text.endswith("\n") else "\n", flush=True)


def watch(args: argparse.Namespace) -> int:
    repo = get_repo(args.repo)
    client = GitHubClient(get_token(), repo, args.run_id)
    states: dict[int, JobState] = {}
    last_run_check = 0.0
    run_data: dict[str, Any] = {}

    print(f"Watching {repo} Actions run {args.run_id}", flush=True)
    while True:
        now = time.monotonic()
        if now - last_run_check >= args.status_interval or not run_data:
            run_data = client.run()
            last_run_check = now
            for item in client.jobs():
                api_id = int(item["id"])
                if args.job and api_id != args.job:
                    continue
                states.setdefault(
                    api_id,
                    JobState(api_id, item["name"], item["html_url"]),
                )
            if args.internal_job_id:
                if len(states) != 1:
                    raise WatchError(
                        "--internal-job-id requires --job when the run has multiple jobs"
                    )
                next(iter(states.values())).internal_id = str(args.internal_job_id)

        for job in list(states.values()):
            try:
                for step in client.steps(job):
                    if step.get("status") == "in_progress":
                        print_new_lines(job, step, client.backscroll(job, str(step["id"])))
            except WatchError as exc:
                print(f"warning: {job.name}: {exc}", file=sys.stderr, flush=True)

        if run_data.get("status") in TERMINAL:
            conclusion = run_data.get("conclusion") or "unknown"
            print(f"\nRun completed: {conclusion}", flush=True)
            return 1 if args.exit_status and conclusion != "success" else 0
        if args.once:
            return 0
        time.sleep(args.interval)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Watch a GitHub Actions run with live per-step logs"
    )
    result.add_argument("run_id", type=int)
    result.add_argument("-R", "--repo", metavar="OWNER/REPO")
    result.add_argument("-j", "--job", type=int, help="only show one Actions job ID")
    result.add_argument(
        "--internal-job-id",
        type=int,
        help="internal ID from the job page's data-job-steps-url",
    )
    result.add_argument("-i", "--interval", type=float, default=3.0)
    result.add_argument(
        "--status-interval",
        type=float,
        default=15.0,
        help="seconds between official API status checks (default: 15)",
    )
    result.add_argument("--exit-status", action="store_true")
    result.add_argument("--once", action="store_true", help="fetch one live snapshot and exit")
    return result


def main() -> int:
    args = parser().parse_args()
    if args.interval <= 0 or args.status_interval <= 0:
        raise WatchError("intervals must be positive")
    return watch(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nStopped", file=sys.stderr)
        raise SystemExit(130)
    except (WatchError, json.JSONDecodeError, urllib.error.URLError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2)
