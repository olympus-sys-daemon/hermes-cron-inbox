"""End-to-end route tests: mount the real router and call every endpoint.

Runs as a plain script (``python tests/test_routes.py``) and under pytest.

Uses a temporary plugin-data dir so the test never writes read-state into the
real inbox, and points the scan at the live cron corpus read-only.
"""
import importlib.util
import os
import sys
import tempfile
from pathlib import Path

try:
    import pytest

    skipif = pytest.mark.skipif
except ImportError:  # pragma: no cover - script mode
    def skipif(condition, reason=""):
        def decorate(fn):
            fn._skipif = (bool(condition), reason)
            return fn

        return decorate

from fastapi import FastAPI
from fastapi.testclient import TestClient

PLUGIN_API = Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py"

# Sandbox the state database before the module resolves its paths.
_TMP = tempfile.mkdtemp(prefix="inbox-test-")
_FAKE_ROOT = Path(_TMP)
(_FAKE_ROOT / "plugin-data").mkdir(parents=True, exist_ok=True)
(_FAKE_ROOT / "cron").mkdir(parents=True, exist_ok=True)

os.environ["HERMES_HOME"] = str(_FAKE_ROOT)


def _load():
    spec = importlib.util.spec_from_file_location("inbox_routes", PLUGIN_API)
    module = importlib.util.module_from_spec(spec)
    sys.modules["inbox_routes"] = module
    spec.loader.exec_module(module)
    module._hermes_root = lambda: _FAKE_ROOT
    return module


api = _load()
app = FastAPI()
app.include_router(api.router, prefix="/api/plugins/hermes-cron-inbox")
client = TestClient(app)

SILENT = """# Cron Job: quiet watcher

**Job ID:** 4cfdc1a12a0a
**Run Time:** 2026-11-25 13:41:19
**Mode:** no_agent (script)
**Status:** silent (empty output)
"""

VISIBLE = """# Cron Job: loud watcher

**Job ID:** f6b6e7c0539f
**Run Time:** 2026-11-25 13:59:19
**Mode:** no_agent (script)

────────────────────────────────────────────────
loud watcher · 2026-11-25 13:59 UTC
────────────────────────────────────────────────
Found a match: 77.4%
"""

PROMPT = "p" * 400
RESPONSE = "Heartbeat: all quiet, 2 items tracked."

AGENT = (
    "# Cron Job: house hunter\n\n"
    "**Job ID:** a439e20c6992\n"
    "**Run Time:** 2026-11-25 09:00:00\n"
    "**Schedule:** 0 9 * * *\n\n"
    "**Prompt Characters:** " + str(len(PROMPT)) + "\n"
    "## Prompt\n\n" + PROMPT + "\n\n"
    "**Response Characters:** " + str(len(RESPONSE)) + "\n"
    "## Response\n\n" + RESPONSE + "\n"
)


def _seed():
    """Two profiles: default with three docs, one named profile with one."""
    default_out = _FAKE_ROOT / "cron" / "output"
    (default_out / "4cfdc1a12a0a").mkdir(parents=True, exist_ok=True)
    (default_out / "f6b6e7c0539f").mkdir(parents=True, exist_ok=True)
    (default_out / "a439e20c6992").mkdir(parents=True, exist_ok=True)
    (default_out / "4cfdc1a12a0a" / "2026-11-25_13-41-19.md").write_text(SILENT)
    (default_out / "f6b6e7c0539f" / "2026-11-25_13-59-19.md").write_text(VISIBLE)
    (default_out / "a439e20c6992" / "2026-11-25_09-00-00.md").write_text(AGENT)

    import json

    (_FAKE_ROOT / "cron" / "jobs.json").write_text(json.dumps({"jobs": [
        {"id": "4cfdc1a12a0a", "name": "quiet watcher", "deliver": "discord",
         "enabled": True, "schedule_display": "*/30 * * * *"},
        {"id": "f6b6e7c0539f", "name": "loud watcher", "deliver": "discord",
         "enabled": True, "schedule_display": "0 * * * *"},
        {"id": "a439e20c6992", "name": "house hunter", "deliver": "local",
         "enabled": True, "schedule_display": "0 9 * * *"},
    ]}))

    other = _FAKE_ROOT / "profiles" / "planner" / "cron" / "output" / "112233445566"
    other.mkdir(parents=True, exist_ok=True)
    (other / "2026-11-25_08-00-00.md").write_text(
        VISIBLE.replace("loud watcher", "planner digest")
    )


_seed()


def test_health_reports_both_profiles():
    body = client.get("/api/plugins/hermes-cron-inbox/health").json()
    assert body["ok"] is True
    assert "default" in body["profiles"]
    assert "planner" in body["profiles"]


def test_default_list_hides_silent_runs():
    body = client.get("/api/plugins/hermes-cron-inbox/items").json()
    names = {item["job_name"] for item in body["items"]}
    assert "loud watcher" in names
    assert "quiet watcher" not in names
    assert "planner digest" in names


def test_everything_scope_includes_silent_runs():
    body = client.get("/api/plugins/hermes-cron-inbox/items?include_silent=true").json()
    names = {item["job_name"] for item in body["items"]}
    assert "quiet watcher" in names
    assert body["all_docs"] == 4


def test_agent_documents_expose_the_response_not_the_prompt():
    body = client.get("/api/plugins/hermes-cron-inbox/items").json()
    agent = next(item for item in body["items"] if item["job_name"] == "house hunter")
    assert agent["is_script"] is False
    assert "p" * 20 not in agent["preview"]
    detail = client.get(f"/api/plugins/hermes-cron-inbox/items/{agent['id']}").json()
    assert detail["body"] == RESPONSE


def test_item_detail_carries_job_metadata():
    body = client.get("/api/plugins/hermes-cron-inbox/items").json()
    item = next(i for i in body["items"] if i["job_name"] == "loud watcher")
    detail = client.get(f"/api/plugins/hermes-cron-inbox/items/{item['id']}").json()
    assert detail["deliver"] == "discord"
    assert detail["schedule"] == "0 * * * *"
    assert detail["profile"] == "default"
    assert Path(detail["path"]).is_file()


def test_read_state_round_trips_and_drives_the_counters():
    body = client.get("/api/plugins/hermes-cron-inbox/items").json()
    item = next(i for i in body["items"] if i["job_name"] == "loud watcher")
    assert item["unread"] is True

    before = client.get("/api/plugins/hermes-cron-inbox/summary").json()["unread"]
    assert client.post(
        f"/api/plugins/hermes-cron-inbox/items/{item['id']}/read", json={"read": True}
    ).json()["read"] is True

    after = client.get("/api/plugins/hermes-cron-inbox/summary").json()["unread"]
    assert after == before - 1

    listed = client.get("/api/plugins/hermes-cron-inbox/items").json()["items"]
    refreshed = next(i for i in listed if i["id"] == item["id"])
    assert refreshed["read"] is True and refreshed["unread"] is False

    client.post(f"/api/plugins/hermes-cron-inbox/items/{item['id']}/read", json={"read": False})
    assert client.get("/api/plugins/hermes-cron-inbox/summary").json()["unread"] == before


def test_unread_only_filter():
    client.post("/api/plugins/hermes-cron-inbox/mark-all-read", json={"include_silent": False})
    body = client.get("/api/plugins/hermes-cron-inbox/items?unread_only=true").json()
    assert body["items"] == []
    assert body["unread"] == 0


def test_mute_removes_an_item_from_the_default_feed():
    body = client.get("/api/plugins/hermes-cron-inbox/items").json()
    item = next(i for i in body["items"] if i["job_name"] == "planner digest")
    client.post(f"/api/plugins/hermes-cron-inbox/items/{item['id']}/mute", json={"muted": True})

    names = {i["job_name"] for i in client.get("/api/plugins/hermes-cron-inbox/items").json()["items"]}
    assert "planner digest" not in names

    scope = client.get("/api/plugins/hermes-cron-inbox/items?include_muted=true").json()
    assert "planner digest" in {i["job_name"] for i in scope["items"]}

    client.post(f"/api/plugins/hermes-cron-inbox/items/{item['id']}/mute", json={"muted": False})


def test_jobs_route_aggregates_per_job():
    body = client.get("/api/plugins/hermes-cron-inbox/jobs").json()
    jobs = {row["job_name"]: row for row in body["jobs"]}
    assert jobs["quiet watcher"]["silent"] == 1
    assert jobs["loud watcher"]["docs"] == 1
    assert jobs["house hunter"]["enabled"] is True


def test_search_matches_job_name():
    body = client.get("/api/plugins/hermes-cron-inbox/items?q=planner").json()
    assert [i["job_name"] for i in body["items"]] == ["planner digest"]


def test_the_exact_path_the_desktop_half_requests():
    """Regression: the page once handed its params OBJECT to ctx.rest, so it
    requested /api/plugins/hermes-cron-inbox/[object Object]. This is the URL the
    fixed page builds (see the harness in the repo's history); it must serve."""
    assert client.get("/api/plugins/hermes-cron-inbox/items?limit=300").status_code == 200
    # And the full filter set the page sends.
    full = ("/api/plugins/hermes-cron-inbox/items?limit=300&unread_only=false"
            "&errors_only=false&include_silent=false&include_muted=false")
    body = client.get(full).json()
    assert "items" in body and "total" in body


def test_config_route_returns_declared_defaults():
    body = client.get("/api/plugins/hermes-cron-inbox/config").json()
    assert body["include_silent_by_default"] is False
    assert body["poll_seconds"] == 60


def test_config_route_clamps_and_coerces():
    """A hand-edited config must not break the page: bad values fall back."""
    assert api._settings()["poll_seconds"] >= 10
    assert isinstance(api._settings()["include_silent_by_default"], bool)


# --------------------------------------------------------------------------- #
# /feed - the dashboard shape
# --------------------------------------------------------------------------- #


def test_feed_groups_runs_into_one_card_per_job():
    body = client.get("/api/plugins/hermes-cron-inbox/feed").json()
    assert body["cards"], "feed returned no cards"
    keys = [(c["profile"], c["job_id"]) for c in body["cards"]]
    assert len(keys) == len(set(keys)), "a job appeared twice: grouping is per run, not per job"
    # The loud watcher has several runs; the card still appears once.
    loud = [c for c in body["cards"] if c["job_name"] == "loud watcher"]
    assert len(loud) == 1
    assert loud[0]["runs"] >= 1


def test_feed_ships_the_latest_body_so_no_click_is_needed():
    body = client.get("/api/plugins/hermes-cron-inbox/feed").json()
    card = next(c for c in body["cards"] if c["job_name"] == "loud watcher")
    # The substance of the report is IN the card, not behind an id.
    assert "77.4%" in card["body"], f"card body missing the report text: {card['body'][:120]!r}"
    assert card["latest_id"]
    assert "recent" in card and card["recent"]


def test_feed_body_is_cleaned_of_banner_furniture():
    body = client.get("/api/plugins/hermes-cron-inbox/feed").json()
    card = next(c for c in body["cards"] if c["job_name"] == "loud watcher")
    first = card["body"].splitlines()[0].strip()
    # A leading rule or a bare repeat of the job name would waste the first line
    # of every card saying nothing the header has not already said.
    assert not set(first) <= set("─━═-=_*#~·. "), f"banner rule survived: {first!r}"
    assert first.casefold() != "loud watcher"


def test_feed_unread_ignores_silent_runs():
    # A silent run is never displayed, so it must not make a card claim "New".
    for card in client.get("/api/plugins/hermes-cron-inbox/feed?include_silent=true").json()["cards"]:
        if card["unread"]:
            assert card["unread_runs"] > 0, (
                f"{card['job_name']} says unread but its own footer counts 0 unread"
            )


def test_muting_a_job_hides_it_but_the_muted_tab_finds_it():
    """Muting must be reversible: a job that disappears with no way back is data loss.

    Restores state in a finally block - this suite shares one state DB, and a
    leaked mute makes later tests fail for an unrelated reason.
    """
    path = "/api/plugins/hermes-cron-inbox"
    job = "loud watcher"

    try:
        muted = client.post(f"{path}/jobs/default/f6b6e7c0539f/mute", json={"muted": True})
        assert muted.status_code == 200
        assert muted.json()["runs"] >= 1, "muting affected no runs"

        # Gone from the default feed...
        names = {c["job_name"] for c in client.get(f"{path}/feed").json()["cards"]}
        assert job not in names

        # ...but present in the Muted tab, which is the way back.
        muted_tab = client.get(f"{path}/feed?muted_only=true").json()["cards"]
        assert job in {c["job_name"] for c in muted_tab}
    finally:
        client.post(f"{path}/jobs/default/f6b6e7c0539f/mute", json={"muted": False})

    names = {c["job_name"] for c in client.get(f"{path}/feed").json()["cards"]}
    assert job in names, "unmuting did not bring the job back"


def test_feed_hides_jobs_whose_runs_were_all_silent():
    body = client.get("/api/plugins/hermes-cron-inbox/feed").json()
    names = {c["job_name"] for c in body["cards"]}
    assert "quiet watcher" not in names
    # ...but Everything shows it.
    everything = client.get(
        "/api/plugins/hermes-cron-inbox/feed?include_silent=true"
    ).json()
    assert "quiet watcher" in {c["job_name"] for c in everything["cards"]}


def test_feed_body_limit_is_a_per_card_budget():
    tiny = client.get("/api/plugins/hermes-cron-inbox/feed?body_limit=200").json()
    assert tiny["cards"], "feed returned no cards"
    for card in tiny["cards"]:
        assert len(card["body"]) <= 200, f"{card['job_name']} exceeded the body budget"
        if card["truncated"]:
            assert card["chars"] > 200


def test_feed_search_matches_job_name():
    body = client.get("/api/plugins/hermes-cron-inbox/feed?q=loud").json()
    assert [c["job_name"] for c in body["cards"]] == ["loud watcher"]

    none = client.get("/api/plugins/hermes-cron-inbox/feed?q=zzzznomatch").json()
    assert none["cards"] == []


def test_feed_leads_with_what_needs_attention():
    # Errors first, then unread, then the rest - a dashboard's job is to order by
    # attention, not by timestamp.
    cards = client.get("/api/plugins/hermes-cron-inbox/feed?include_silent=true").json()["cards"]
    rank = [
        0 if c["error"] and c["unread"] else 1 if c["error"] else 2 if c["unread"] else 3
        for c in cards
    ]
    assert rank == sorted(rank), f"cards are not ordered by attention: {rank}"


def test_unknown_item_404s():
    assert client.get("/api/plugins/hermes-cron-inbox/items/default|deadbeefdead|2026-01-01_00-00-00").status_code == 404


def test_malformed_item_id_is_rejected():
    assert client.get("/api/plugins/hermes-cron-inbox/items/nonsense").status_code in (400, 404)


def test_path_traversal_is_refused():
    resp = client.get(
        "/api/plugins/hermes-cron-inbox/items/default|f6b6e7c0539f|..%2F..%2F..%2Fetc%2Fpasswd"
    )
    assert resp.status_code in (400, 404)


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_")]
    failures = skipped = 0
    for name, fn in tests:
        skip, reason = getattr(fn, "_skipif", (False, ""))
        if skip:
            skipped += 1
            print(f"SKIP {name} ({reason})")
            continue
        try:
            fn()
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {name}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"ERROR {name}: {type(exc).__name__}: {exc}")
        else:
            print(f"ok   {name}")
    print(f"\n{len(tests) - failures - skipped} passed, {failures} failed, {skipped} skipped")
    raise SystemExit(1 if failures else 0)
