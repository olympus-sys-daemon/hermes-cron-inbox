"""Hermes Inbox backend.

An inbox view over the cron run documents Hermes already writes. Nothing here
enqueues, delivers, or mutates cron state: the only inputs are
``cron/output/<job_id>/<YYYY-MM-DD_HH-MM-SS>.md`` files and ``cron/jobs.json``,
and the only writes are this plugin's own read/mute state.

Two document shapes exist on disk and they are NOT interchangeable:

* script runs (``**Mode:** no_agent (script)``) — a short header, then
  ``---``, then raw stdout. A silent run carries a ``**Status:** silent …``
  line in the header; a run with real output carries no status line at all.
* agent runs — a length-framed archive: the whole prompt is embedded, then
  ``**Response Characters:** N`` + ``## Response``. The prompt is routinely
  100x the response, so rendering the file verbatim is useless. Only the
  framed response is the inbox's content.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

# ---- run-document frames (mirrors cron/scheduler_prompt.py; see _extract_response) ----
_PROMPT_FRAME = "**Prompt Characters:** "
_PROMPT_HEADING = "## Prompt\n\n"
_RESPONSE_FRAME = "**Response Characters:** "
_RESPONSE_HEADING = "## Response\n\n"
_PROMPT_FRAME_RE = re.compile(
    rf"(?m)^{re.escape(_PROMPT_FRAME)}(\d+)\n{re.escape(_PROMPT_HEADING)}")
_RESPONSE_FRAME_RE = re.compile(
    rf"(?m)^{re.escape(_RESPONSE_FRAME)}(\d+)\n{re.escape(_RESPONSE_HEADING)}")

_HEADER_KEY_RE = re.compile(r"^\*\*(?P<key>[A-Za-z ]+):\*\*\s*(?P<value>.*)$")
_STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$")

# A run which did not need to wake anyone. Kept as a prefix test against the
# status line only — never against the body, where a job may quote these words.
_SILENT_PREFIXES = ("silent", "no_change")
# A run banner such as "PortWatch VI · 2026-11-25 16:03 UTC" - a date inside a
# short line that is not a list item. Card headers already carry the job name and
# time, so this is furniture there.
# A banner reads `label · timestamp`. The separator is the discriminator: prose
# rarely contains one, so requiring it cannot swallow a real first line.
_BANNER_SEPARATORS = ("·", "—", "–", "|", "•")
# The timestamp sits at the END of a banner ("Name · 2026-11-25 16:03 UTC").
_BANNER_TAIL_DATE = re.compile(r"(\d{4}-\d{2}-\d{2}|\b\d{1,2}:\d{2}\b)[^:;]*$")
_ERROR_PREFIXES = ("script failed", "blocked", "error", "failed")
_SILENCE_TOKENS = ("[silent]", "silent", "no_reply", "no reply")

MAX_BODY_CHARS = 2 * 1024 * 1024

# --------------------------------------------------------------------------- #
# Paths — resolved late and profiled, so a multiplexed gateway can serve every
# profile's documents through one route.
# --------------------------------------------------------------------------- #


def _hermes_root() -> Path:
    """The Hermes root home (the one whose ``profiles/`` holds the others)."""
    try:
        from hermes_constants import get_hermes_home

        home = Path(get_hermes_home())
    except Exception:  # pragma: no cover - older/newer core layout
        home = Path.home() / ".hermes"
    # ``<root>/profiles/<name>`` -> ``<root>``
    if home.parent.name == "profiles":
        return home.parent.parent
    return home


def _state_dir() -> Path:
    path = _hermes_root() / "plugin-data" / "hermes-cron-inbox"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _cron_homes() -> list[tuple[str, Path]]:
    """``(profile, cron_dir)`` for the default profile and every named one."""
    root = _hermes_root()
    homes: list[tuple[str, Path]] = []
    default_cron = root / "cron"
    if default_cron.is_dir():
        homes.append(("default", default_cron))
    profiles_dir = root / "profiles"
    if profiles_dir.is_dir():
        for child in sorted(profiles_dir.iterdir()):
            cron_dir = child / "cron"
            if child.is_dir() and cron_dir.is_dir():
                homes.append((child.name, cron_dir))
    return homes


def _load_jobs(cron_dir: Path) -> dict[str, dict]:
    """``job_id -> job record`` from one profile's jobs.json; ``{}`` when unreadable."""
    try:
        raw = json.loads((cron_dir / "jobs.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    jobs = raw.get("jobs") if isinstance(raw, dict) else raw
    if not isinstance(jobs, list):
        return {}
    return {str(j["id"]): j for j in jobs if isinstance(j, dict) and j.get("id")}


# --------------------------------------------------------------------------- #
# Document parsing
# --------------------------------------------------------------------------- #


def _split_header(text: str) -> tuple[dict[str, str], str]:
    """``(header fields, rest)``.

    The header is the leading ``# Cron Job: <name>`` line plus the ``**Key:** value``
    block under it. ``rest`` is everything after, framing untouched.
    """
    fields: dict[str, str] = {}
    lines = text.split("\n")
    index = 0
    if lines and lines[0].startswith("# Cron Job:"):
        fields["title"] = lines[0][len("# Cron Job:"):].strip()
        index = 1
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            index += 1
            continue
        match = _HEADER_KEY_RE.match(line)
        if not match:
            break
        fields[match.group("key").strip().lower().replace(" ", "_")] = match.group("value").strip()
        index += 1
    return fields, "\n".join(lines[index:])


def _extract_response(rest: str) -> Optional[str]:
    """The agent-mode response body, or ``None`` when there is no usable one.

    Prefers the writer's own length frame, which cannot be forged by a prompt or
    a response that happens to quote ``## Response``. A truncated write fails the
    length check and falls through to ``None`` rather than returning prompt noise.
    Legacy unframed archives split on the LAST ``## Response`` for the same reason.
    """
    prompt_frame = _PROMPT_FRAME_RE.search(rest)
    if prompt_frame is not None:
        response_start = prompt_frame.end() + int(prompt_frame.group(1)) + len("\n\n")
        frame = _RESPONSE_FRAME_RE.match(rest, response_start)
        if frame is not None:
            body_start = frame.end()
            expected = int(frame.group(1))
            body = rest[body_start:body_start + expected]
            if len(body) == expected:
                return body
        # Framed prompt but unusable response frame: treat as no answer rather
        # than guessing at a boundary inside the prompt.
        return None
    if _RESPONSE_HEADING.strip() not in rest:
        return None
    answer = rest.rpartition(_RESPONSE_HEADING.strip())[2].strip()
    return answer or None


def _is_silent_text(text: str) -> bool:
    stripped = (text or "").strip().lower()
    if not stripped:
        return True
    lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    if not lines:
        return True
    return lines[0] in _SILENCE_TOKENS or lines[-1] in _SILENCE_TOKENS


def _script_body(rest: str) -> str:
    """Script docs put raw stdout after a ``---`` rule."""
    body = rest.lstrip("\n")
    if body.startswith("---"):
        body = body[3:].lstrip("\n")
    return body.strip("\n")


def parse_document(text: str) -> dict[str, Any]:
    """Turn one run document into inbox fields. Pure: no paths, no clock."""
    text = text.lstrip("\ufeff")
    fields, rest = _split_header(text)
    mode = fields.get("mode", "")
    status = fields.get("status", "")
    is_script = "no_agent" in mode or "script" in mode

    status_lower = status.strip().lower()
    silent = any(status_lower.startswith(prefix) for prefix in _SILENT_PREFIXES)
    errored = any(status_lower.startswith(prefix) for prefix in _ERROR_PREFIXES)

    if is_script:
        body = _script_body(rest)
        if "status" not in fields and not body:
            silent = True
        if body.strip().startswith("#") and "error" in body[:200].lower():
            errored = True
    else:
        body = _extract_response(rest) or ""
        errored = errored or body.lstrip().startswith("[CRON_FAILURE]")
        # An agent run whose response was a silence token is silent, whatever
        # the header says (agent docs carry no Status line at all).
        if not errored and _is_silent_text(body):
            silent = True

    return {
        "title": fields.get("title", ""),
        "job_id": fields.get("job_id", ""),
        "run_time": fields.get("run_time", ""),
        "schedule": fields.get("schedule", ""),
        "mode": mode,
        "status": status,
        "is_script": is_script,
        "silent": silent,
        "error": errored,
        "body": body[:MAX_BODY_CHARS],
    }


# --------------------------------------------------------------------------- #
# Scan + cache
# --------------------------------------------------------------------------- #

_CACHE: dict[str, tuple[float, int, dict[str, Any]]] = {}
_CACHE_LOCK = threading.Lock()


def _read_parsed(path: Path) -> Optional[dict[str, Any]]:
    """Parsed document, memoised on (mtime, size) so a 170 KB archive is parsed once."""
    try:
        stat = path.stat()
    except OSError:
        return None
    key = str(path)
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
    if cached and cached[0] == stat.st_mtime and cached[1] == stat.st_size:
        return cached[2]
    try:
        text = path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return None
    parsed = parse_document(text)
    with _CACHE_LOCK:
        if len(_CACHE) > 4000:  # bounded; a prune is cheaper than unbounded growth
            _CACHE.clear()
        _CACHE[key] = (stat.st_mtime, stat.st_size, parsed)
    return parsed


def _item_id(profile: str, job_id: str, stamp: str) -> str:
    return f"{profile}|{job_id}|{stamp}"


def _split_item_id(item_id: str) -> tuple[str, str, str]:
    parts = item_id.split("|")
    if len(parts) != 3 or not all(parts):
        raise HTTPException(status_code=400, detail="malformed item id")
    profile, job_id, stamp = parts
    if not _STAMP_RE.match(stamp):
        raise HTTPException(status_code=400, detail="malformed item id")
    if not all(c in "0123456789abcdef" for c in job_id):
        raise HTTPException(status_code=400, detail="malformed item id")
    return profile, job_id, stamp


class _State:
    """Read/mute state. Keyed by item id, so cron's own retention prunes it naturally."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._conn: Optional[sqlite3.Connection] = None

    def _db(self) -> sqlite3.Connection:
        if self._conn is None:
            conn = sqlite3.connect(_state_dir() / "inbox.db", check_same_thread=False)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS items ("
                " id TEXT PRIMARY KEY,"
                " read_at REAL,"
                " muted INTEGER NOT NULL DEFAULT 0)")
            conn.commit()
            self._conn = conn
        return self._conn

    def snapshot(self) -> dict[str, tuple[Optional[float], bool]]:
        with self._lock:
            rows = self._db().execute("SELECT id, read_at, muted FROM items").fetchall()
        return {row[0]: (row[1], bool(row[2])) for row in rows}

    def set_read(self, item_id: str, read: bool) -> None:
        with self._lock:
            conn = self._db()
            conn.execute(
                "INSERT INTO items (id, read_at) VALUES (?, ?) "
                "ON CONFLICT(id) DO UPDATE SET read_at=excluded.read_at",
                (item_id, time.time() if read else None))
            conn.commit()

    def set_muted(self, item_id: str, muted: bool) -> None:
        with self._lock:
            conn = self._db()
            conn.execute(
                "INSERT INTO items (id, muted) VALUES (?, ?) "
                "ON CONFLICT(id) DO UPDATE SET muted=excluded.muted",
                (item_id, 1 if muted else 0))
            conn.commit()

    def prune(self, live: set[str]) -> int:
        """Drop state for documents cron has already deleted."""
        with self._lock:
            conn = self._db()
            rows = [row[0] for row in conn.execute("SELECT id FROM items").fetchall()]
            stale = [(entry,) for entry in rows if entry not in live]
            if stale:
                conn.executemany("DELETE FROM items WHERE id=?", stale)
                conn.commit()
        return len(stale)


_STATE = _State()


def _scan(include_silent: bool) -> list[dict[str, Any]]:
    """Every run document across every profile, newest first."""
    items: list[dict[str, Any]] = []
    live_ids: set[str] = set()

    for profile, cron_dir in _cron_homes():
        jobs = _load_jobs(cron_dir)
        output_root = cron_dir / "output"
        try:
            job_dirs = sorted(p for p in output_root.iterdir() if p.is_dir())
        except OSError:
            continue
        for job_dir in job_dirs:
            job_id = job_dir.name
            if not all(c in "0123456789abcdef" for c in job_id):
                continue
            job = jobs.get(job_id) or {}
            try:
                docs = sorted(
                    (p for p in job_dir.glob("*.md") if p.is_file() and _STAMP_RE.match(p.stem)),
                    key=lambda p: p.stem, reverse=True)
            except OSError:
                continue
            for path in docs:
                stamp = path.stem
                item_id = _item_id(profile, job_id, stamp)
                live_ids.add(item_id)
                parsed = _read_parsed(path)
                if parsed is None:
                    continue
                if parsed["silent"] and not include_silent:
                    continue
                items.append({
                    "id": item_id,
                    "profile": profile,
                    "job_id": job_id,
                    # A deleted job keeps its documents; the header's own title is
                    # then the only name left, so fall back to it.
                    "job_name": job.get("name") or parsed["title"] or job_id,
                    "orphan": not job,
                    "title": parsed["title"],
                    "run_time": parsed["run_time"],
                    "stamp": stamp,
                    "schedule": job.get("schedule_display") or parsed["schedule"],
                    "mode": parsed["mode"],
                    "status": parsed["status"],
                    "is_script": parsed["is_script"],
                    "silent": parsed["silent"],
                    "error": parsed["error"],
                    "deliver": job.get("deliver"),
                    "job_enabled": job.get("enabled"),
                    "preview": _preview(parsed["body"]),
                    "chars": len(parsed["body"]),
                })

    items.sort(key=lambda item: (item["stamp"], item["profile"]), reverse=True)
    _STATE.prune(live_ids)
    return items


def _clean_body(body: str, job_name: str = "") -> str:
    """A run body with its banner furniture removed for card display.

    Script reports often open with a 48-character box-drawing rule and a title
    banner that merely repeats the job name. In a card those cost two lines to
    say nothing the header has not already said. Only LEADING decoration is
    removed - rules later in the text are usually section separators, and cutting
    them would join unrelated paragraphs.
    """
    lines = [line.rstrip() for line in (body or "").splitlines()]
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if not stripped:
            i += 1
            continue
        is_rule = set(stripped) <= set("─━═-=_*#~·. ") and len(stripped) >= 3
        is_dup_name = bool(job_name) and stripped.strip("#  ").casefold() == job_name.casefold()
        # A banner line repeats what the card header already shows. The old test
        # - "short line containing a date" - swallowed real opening lines such as
        # "Backup finished 2026-11-25", silently deleting the report's first line.
        # A banner's actual shape is `label · timestamp`: a separator character
        # plus a date. Requiring the separator is what distinguishes decoration
        # from content, and prose almost never uses one.
        is_banner = (
            len(stripped) <= 60
            and not stripped.startswith(("•", "-", "*", ">", "|"))
            and len(stripped.split()) <= 8
            and any(sep in stripped for sep in _BANNER_SEPARATORS)
            and _BANNER_TAIL_DATE.search(stripped) is not None
        )
        if is_rule or is_dup_name or is_banner:
            i += 1
            continue
        break
    return "\n".join(lines[i:]).strip()


def _preview(body: str, limit: int = 220) -> str:
    """One-line preview of a run body.

    Leading rules and banner lines are stripped first: a report that opens with
    a 48-character box-drawing rule would otherwise spend both preview lines on
    decoration and never show the reader what the run says.
    """
    lines = [line.strip() for line in (body or "").splitlines()]
    meaningful = [
        line for line in lines
        if line and not set(line) <= set("─━═-=_*#~·. ") and not line.startswith("```")
    ]
    flat = re.sub(r"\s+", " ", " ".join(meaningful)).strip()
    if len(flat) <= limit:
        return flat
    return flat[: limit - 1].rstrip() + "…"


def _decorate(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    state = _STATE.snapshot()
    for item in items:
        read_at, muted = state.get(item["id"], (None, False))
        item["read"] = read_at is not None
        item["read_at"] = read_at
        item["muted"] = muted
        item["unread"] = not item["read"]
    return items


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #


@router.get("/health")
async def health() -> dict[str, Any]:
    homes = _cron_homes()
    return {
        "ok": True,
        "hermes_root": str(_hermes_root()),
        "profiles": [name for name, _ in homes],
        "cron_homes": len(homes),
    }


def _settings() -> dict[str, Any]:
    """This plugin's own ``plugins.entries.hermes-cron-inbox.settings`` values.

    The desktop half cannot call ``ctx.get_config`` (that is an agent-side
    facade), so it reads them here. Defaults are declared in ``plugin.yaml``'s
    ``config_schema``; a missing or unparseable config yields those defaults
    rather than an error, because a settings read must never break the page.
    """
    defaults = {"include_silent_by_default": False, "poll_seconds": 60, "body_limit": 1200}
    try:
        from hermes_cli.config import load_config_readonly

        config = load_config_readonly() or {}
    except Exception:
        return defaults
    try:
        entry = ((config.get("plugins") or {}).get("entries") or {}).get("hermes-cron-inbox") or {}
        settings = entry.get("settings") or {}
    except AttributeError:
        return defaults
    if not isinstance(settings, dict):
        return defaults

    silent = settings.get("include_silent_by_default", defaults["include_silent_by_default"])
    try:
        poll = int(settings.get("poll_seconds", defaults["poll_seconds"]))
    except (TypeError, ValueError):
        poll = defaults["poll_seconds"]
    try:
        body_limit = int(settings.get("body_limit", defaults["body_limit"]))
    except (TypeError, ValueError):
        body_limit = defaults["body_limit"]
    return {
        "include_silent_by_default": bool(silent),
        "poll_seconds": max(10, min(poll, 3600)),
        # Ragged on purpose: a 400-char card is a teaser nobody asked for, and
        # 8000 already exceeds what anyone reads in a card.
        "body_limit": max(400, min(body_limit, 8000)),
    }


@router.get("/config")
async def get_config() -> dict[str, Any]:
    """The client's view of this plugin's settings."""
    return _settings()


@router.get("/items")
async def list_items(
    limit: int = 100,
    offset: int = 0,
    unread_only: bool = False,
    include_silent: bool = False,
    include_muted: bool = False,
    errors_only: bool = False,
    profile: str = "",
    job_id: str = "",
    q: str = "",
) -> dict[str, Any]:
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    items = _decorate(_scan(include_silent=True))
    total_unfiltered = len(items)
    # The badge means "reports you have not read". A silent run is never shown,
    # so it must not inflate the count the chip displays.
    unread_total = sum(
        1 for item in items if item["unread"] and not item["muted"] and not item["silent"]
    )

    if not include_silent:
        items = [item for item in items if not item["silent"]]
    if not include_muted:
        items = [item for item in items if not item["muted"]]
    if unread_only:
        items = [item for item in items if item["unread"]]
    if errors_only:
        items = [item for item in items if item["error"]]
    if profile:
        items = [item for item in items if item["profile"] == profile]
    if job_id:
        items = [item for item in items if item["job_id"] == job_id]
    if q:
        needle = q.strip().lower()
        items = [
            item for item in items
            if needle in item["job_name"].lower()
            or needle in item["preview"].lower()
            or needle in item["title"].lower()
        ]

    return {
        "items": items[offset: offset + limit],
        "total": len(items),
        "offset": offset,
        "limit": limit,
        "unread": unread_total,
        "all_docs": total_unfiltered,
    }


@router.get("/feed")
async def feed(
    limit: int = 40,
    include_silent: bool = False,
    include_muted: bool = False,
    errors_only: bool = False,
    unread_only: bool = False,
    muted_only: bool = False,
    q: str = "",
    body_limit: int = 1200,
) -> dict[str, Any]:
    """Job-grouped view: one card per job carrying its LATEST run's text.

    The list endpoint answers "what ran, newest first" — one row per document.
    That is the right shape for a log and the wrong shape for reading: the thing
    a person actually wants is "what does each watcher say right now", which is
    one answer per job, not fifty rows in time order. Grouping here also means
    the newest MESSAGE per job is visible without opening anything.

    `body_limit` is a truncation budget per card, not per page: the bodies run
    from a few hundred bytes to ~250 KB, so shipping them whole would be tens of
    megabytes over the plugin host's 60 s budget. The full text stays one click
    away via `/items/<id>`.
    """
    limit = max(1, min(limit, 120))
    body_limit = max(200, min(body_limit, 8000))

    items = _decorate(_scan(include_silent=True))

    # Group by (profile, job_id) preserving each job's newest run.
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in items:
        groups.setdefault((item["profile"], item["job_id"]), []).append(item)

    cards: list[dict[str, Any]] = []
    for (profile, job_id), runs in groups.items():
        # `_scan` already sorts newest-first globally, so runs[0] is this job's
        # latest.
        latest = runs[0]
        live = [r for r in runs if not r["silent"] and not r["muted"]]

        if muted_only:
            # The Muted tab is the way back: without it, muting removes a job
            # from the page with no route to undo it. Checked BEFORE the
            # silent/live filter below, because muting excludes every run from
            # `live` - so a fully-muted job would be dropped for having nothing
            # live to show, and the tab would always be empty.
            if not any(r["muted"] for r in runs):
                continue
        elif not include_muted and latest["muted"]:
            continue
        elif not include_silent and not live:
            # Every run of this job was silent: there is nothing to read.
            continue
        if errors_only and not any(r["error"] for r in runs[:50]):
            continue
        if unread_only and not any(r["unread"] for r in live):
            continue

        # When every run is muted, `live` is empty by construction: fall back to
        # the newest run so a Muted card still has a name and a body.
        head = live[0] if live else next((r for r in runs if not r["silent"]), latest)

        if q:
            needle = q.strip().lower()
            haystack = " ".join(
                [head["job_name"], head["title"], head["preview"], profile]
            ).lower()
            if needle not in haystack:
                continue

        # The newest REPORTED run carries the text; a silent latest run should
        # not blank a card that has something real underneath it.
        shown = head if not head["silent"] else latest

        try:
            path = _document_path(profile, job_id, shown["stamp"])
            parsed = _read_parsed(path) if path else None
        except Exception:  # noqa: BLE001 - a vanished file must not kill the feed
            parsed = None

        body = _clean_body((parsed or {}).get("body", "") or "", head["job_name"])

        cards.append({
            "profile": profile,
            "job_id": job_id,
            "job_name": head["job_name"],
            "orphan": head["orphan"],
            "job_enabled": head["job_enabled"],
            "schedule": head["schedule"],
            "deliver": head["deliver"],
            "mode": shown["mode"],
            "is_script": shown["is_script"],
            "stamp": shown["stamp"],
            "run_time": shown["run_time"],
            "status": shown["status"],
            "silent": shown["silent"],
            "error": shown["error"],
            # Both counters must use the SAME population or the card contradicts
            # itself: `unread` counted reported+muted runs while `unread_runs`
            # counted reported runs including muted ones, so a muted-but-unread
            # run could make the flag true and the footer say 1 when the true
            # visible count was 0. Reported = not silent; that is what the page
            # shows.
            "unread": any(r["unread"] for r in runs if not r["silent"]),
            "muted": latest["muted"],
            "latest_id": shown["id"],
            # Counters the card header shows without another call.
            "runs": len(runs),
            "unread_runs": sum(1 for r in runs if r["unread"] and not r["silent"]),
            # Silence/error ordering uses the same population as `unread`.
            "error_runs": sum(1 for r in runs[:50] if r["error"]),
            "body": body[:body_limit],
            "truncated": len(body) > body_limit,
            "chars": len(body),
            # `latest_id` MUST be in here. The body above comes from `shown`,
            # which for a mostly-silent watcher is far older than the newest six
            # runs - so a plain `runs[:6]` produced a card whose text no entry in
            # `recent` matched, and the body click fell back to the newest run of
            # ANY kind (silent), i.e. the empty-reader bug again. Newest six plus
            # the shown run, de-duplicated, keeps the click target resolvable.
            "recent": [
                {
                    "id": r["id"],
                    "stamp": r["stamp"],
                    "unread": r["unread"],
                    "error": r["error"],
                    "silent": r["silent"],
                    "muted": r["muted"],
                    "preview": r["preview"][:160],
                }
                for r in ([shown] + [r for r in runs[:6] if r["id"] != shown["id"]])
            ],
        })

    # Errors first, then unread, then newest — a dashboard should lead with what
    # needs attention, not with what happens to be most recent.
    cards.sort(
        key=lambda c: (
            0 if c["error"] and c["unread"] else 1 if c["error"] else 2 if c["unread"] else 3,
            -_stamp_sort_key(c["stamp"]),
        )
    )

    total_unread = sum(1 for i in items if i["unread"] and not i["muted"] and not i["silent"])

    return {
        "cards": cards[:limit],
        "jobs": len(cards),
        "total_jobs": len(groups),
        "unread": total_unread,
        "errors": sum(1 for i in items if i["error"] and i["unread"] and not i["silent"]),
        "silent": sum(1 for i in items if i["silent"]),
        "all_docs": len(items),
    }


def _stamp_sort_key(stamp: str) -> int:
    """Sort key for a `YYYY-MM-DD_HH-MM-SS` stamp. Unparseable sorts oldest."""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})", stamp or "")
    if not m:
        return 0
    y, mo, d, h, mi, s = (int(g) for g in m.groups())
    return ((((y * 13 + mo) * 32 + d) * 24 + h) * 60 + mi) * 60 + s


def _document_path(profile: str, job_id: str, stamp: str) -> Optional[Path]:
    """Path of one run document, or None when the profile is not ours."""
    for name, cron_dir in _cron_homes():
        if name != profile:
            continue
        candidate = cron_dir / "output" / job_id / f"{stamp}.md"
        return candidate if candidate.is_file() else None
    return None


@router.get("/summary")
async def summary() -> dict[str, Any]:
    """Cheap counters for the statusbar chip and the sidebar."""
    items = _decorate(_scan(include_silent=True))
    visible = [item for item in items if not item["silent"] and not item["muted"]]
    return {
        "unread": sum(1 for item in visible if item["unread"]),
        "errors": sum(1 for item in visible if item["error"] and item["unread"]),
        "visible": len(visible),
        "silent": sum(1 for item in items if item["silent"]),
        "all_docs": len(items),
    }


def _find_item(item_id: str) -> tuple[dict[str, Any], Path]:
    profile, job_id, stamp = _split_item_id(item_id)
    for name, cron_dir in _cron_homes():
        if name != profile:
            continue
        path = cron_dir / "output" / job_id / f"{stamp}.md"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="run document no longer exists")
        parsed = _read_parsed(path)
        if parsed is None:
            raise HTTPException(status_code=500, detail="run document could not be read")
        jobs = _load_jobs(cron_dir)
        job = jobs.get(job_id) or {}
        # COPY before decorating. `parsed` comes from the shared parse cache and
        # is the SAME dict on every read, so mutating it here leaked these
        # request-scoped keys (path, read, read_at) into every later `_scan`: the
        # cache grew a per-request tail that nothing prunes.
        result = dict(parsed)
        result.update({
            "id": item_id,
            "profile": profile,
            "job_id": job_id,
            "job_name": job.get("name") or parsed["title"] or job_id,
            "orphan": not job,
            "stamp": stamp,
            "schedule": job.get("schedule_display") or parsed["schedule"],
            "deliver": job.get("deliver"),
            "job_enabled": job.get("enabled"),
            "chars": len(parsed["body"]),
        })
        return result, path
    raise HTTPException(status_code=404, detail="unknown profile")


@router.get("/items/{item_id:path}")
async def get_item(item_id: str) -> dict[str, Any]:
    parsed, path = _find_item(item_id)
    read_at, muted = _STATE.snapshot().get(item_id, (None, False))
    # `_find_item` already returned a copy, so decorating here is safe. `path` is
    # part of this endpoint's documented contract ("full body and source path"):
    # a client that wants to reveal the file needs it.
    parsed.update({"read": read_at is not None, "read_at": read_at, "muted": muted})
    parsed["path"] = str(path)
    return parsed


class ReadBody(BaseModel):
    read: bool = True


class MuteBody(BaseModel):
    muted: bool = True


@router.post("/items/{item_id:path}/read")
async def mark_read(item_id: str, body: ReadBody) -> dict[str, Any]:
    _find_item(item_id)  # 404s a stale id instead of storing state for a ghost
    _STATE.set_read(item_id, body.read)
    return {"ok": True, "id": item_id, "read": body.read}


@router.post("/jobs/{profile}/{job_id}/read")
async def mark_job_read(profile: str, job_id: str, body: ReadBody) -> dict[str, Any]:
    """Mark (or unmark) EVERY unread run of one job as read.

    The desktop half cannot do this itself: its card carries only `recent` (the
    newest six runs), so iterating that left older unread runs untouched while
    reporting success. A job-level action needs a job-level query.
    """
    if not profile or not job_id:
        raise HTTPException(status_code=400, detail="profile and job_id are required")

    marked = 0
    for item in _decorate(_scan(include_silent=False)):
        if item["profile"] != profile or item["job_id"] != job_id:
            continue
        if body.read and not item["unread"]:
            continue
        _STATE.set_read(item["id"], body.read)
        marked += 1

    return {"read": body.read, "runs": marked}


@router.post("/jobs/{profile}/{job_id}/mute")
async def mute_job(profile: str, job_id: str, body: MuteBody) -> dict[str, Any]:
    """Mute or unmute EVERY run of one job.

    Mute lives per run in the state database, so muting a single "latest" run
    would leave a job that reappears the moment an older run becomes newest.
    The card is a job-level projection, so its mute must be job-level too -
    otherwise the toggle is a one-way trip that looks like data loss.
    """
    if not profile or not job_id:
        raise HTTPException(status_code=400, detail="profile and job_id are required")

    affected = 0
    for item in _scan(include_silent=True):
        if item["profile"] != profile or item["job_id"] != job_id:
            continue
        _STATE.set_muted(item["id"], body.muted)
        affected += 1

    return {"muted": body.muted, "runs": affected}


@router.post("/items/{item_id:path}/mute")
async def mark_muted(item_id: str, body: MuteBody) -> dict[str, Any]:
    _find_item(item_id)
    _STATE.set_muted(item_id, body.muted)
    return {"ok": True, "id": item_id, "muted": body.muted}


class MarkAllBody(BaseModel):
    profile: str = ""
    include_silent: bool = True


@router.post("/mark-all-read")
async def mark_all_read(body: MarkAllBody) -> dict[str, Any]:
    items = _decorate(_scan(include_silent=body.include_silent))
    if body.profile:
        items = [item for item in items if item["profile"] == body.profile]
    marked = 0
    for item in items:
        if item["unread"]:
            _STATE.set_read(item["id"], True)
            marked += 1
    return {"ok": True, "marked": marked}


@router.get("/jobs")
async def list_jobs() -> dict[str, Any]:
    """Every job that has documents, with a per-job unread count."""
    items = _decorate(_scan(include_silent=True))
    jobs: dict[str, dict[str, Any]] = {}
    for item in items:
        key = item["id"].split("|", 2)[0] + "|" + item["job_id"]
        row = jobs.setdefault(key, {
            "profile": item["profile"],
            "job_id": item["job_id"],
            "job_name": item["job_name"],
            "orphan": item["orphan"],
            "schedule": item["schedule"],
            "deliver": item["deliver"],
            "enabled": item["job_enabled"],
            "docs": 0,
            "unread": 0,
            "errors": 0,
            "silent": 0,
            "last_run": item["stamp"],
        })
        row["docs"] += 1
        if item["silent"]:
            row["silent"] += 1
        elif item["unread"]:
            row["unread"] += 1
        if item["error"] and not item["silent"]:
            row["errors"] += 1
    ordered = sorted(jobs.values(), key=lambda r: r["last_run"], reverse=True)
    return {"jobs": ordered}
