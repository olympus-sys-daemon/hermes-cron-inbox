"""Parser tests against the shapes actually on disk.

Runs two ways:

  * as a plain script with a Python that has fastapi/pydantic (the gateway venv):
        python tests/test_parse.py
  * under pytest in CI (the ``skipif`` decorators become real then).
"""
import importlib.util
import sys
from pathlib import Path

try:  # pytest is optional: this file must run as a plain script too.
    import pytest

    skipif = pytest.mark.skipif
except ImportError:  # pragma: no cover - script mode
    def skipif(condition, reason=""):
        def decorate(fn):
            fn._skipif = (bool(condition), reason)
            return fn

        return decorate

PLUGIN_API = Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py"


def _load():
    spec = importlib.util.spec_from_file_location("inbox_plugin_api", PLUGIN_API)
    module = importlib.util.module_from_spec(spec)
    sys.modules["inbox_plugin_api"] = module
    spec.loader.exec_module(module)
    return module


api = _load()


# ---- script-mode documents ------------------------------------------------- #

SILENT_SCRIPT = """# Cron Job: HY4 flash free-tier watcher

**Job ID:** 4cfdc1a12a0a
**Run Time:** 2026-11-25 13:41:19
**Mode:** no_agent (script)
**Status:** silent (empty output)
"""

WAKE_GATE_SCRIPT = """# Cron Job: watch-x

**Job ID:** 0123456789ab
**Run Time:** 2026-11-25 10:00:00
**Mode:** no_agent (script)
**Status:** silent (wakeAgent=false)
"""

FAILED_SCRIPT = """# Cron Job: PortWatch

**Job ID:** f6b6e7c0539f
**Run Time:** 2026-11-25 10:00:00
**Mode:** no_agent (script)
**Status:** script failed

Traceback (most recent call last): boom
"""

REAL_SCRIPT = """# Cron Job: PortWatch VI watcher (GTA VI on PC)

**Job ID:** f6b6e7c0539f
**Run Time:** 2026-11-25 13:59:19
**Mode:** no_agent (script)

---

PortWatch VI · 2026-11-25 11:59 UTC
Leader : Belobug · 77.4%
"""


def test_silent_script_is_silent():
    doc = api.parse_document(SILENT_SCRIPT)
    assert doc["is_script"] is True
    assert doc["silent"] is True
    assert doc["error"] is False
    assert doc["job_id"] == "4cfdc1a12a0a"
    assert doc["title"] == "HY4 flash free-tier watcher"


def test_wake_gate_script_is_silent():
    assert api.parse_document(WAKE_GATE_SCRIPT)["silent"] is True


def test_failed_script_is_error_not_silent():
    doc = api.parse_document(FAILED_SCRIPT)
    assert doc["silent"] is False
    assert doc["error"] is True


def test_real_script_output_is_visible():
    """A script run WITH output carries no Status line at all — a naive
    'contains silent' rule would hide it; the correct rule keeps it."""
    doc = api.parse_document(REAL_SCRIPT)
    assert doc["silent"] is False
    assert doc["error"] is False
    assert doc["body"].startswith("PortWatch VI")
    assert "Belobug" in doc["body"]


# ---- agent-mode documents -------------------------------------------------- #

PROMPT = "x" * 500
RESPONSE = "Found 3 new listings."
AGENT = (
    "# Cron Job: house hunter\n\n"
    "**Job ID:** aabbccddeeff\n"
    "**Run Time:** 2026-11-25 09:00:00\n"
    "**Schedule:** 0 9 * * *\n\n"
    "**Prompt Characters:** " + str(len(PROMPT)) + "\n"
    "## Prompt\n\n" + PROMPT + "\n\n"
    "**Response Characters:** " + str(len(RESPONSE)) + "\n"
    "## Response\n\n" + RESPONSE + "\n"
)


def test_agent_response_is_extracted_not_the_prompt():
    doc = api.parse_document(AGENT)
    assert doc["is_script"] is False
    assert doc["body"] == RESPONSE
    assert "xxxx" not in doc["body"]
    assert doc["schedule"] == "0 9 * * *"


def test_agent_silence_token_is_silent():
    silent = AGENT.replace("Found 3 new listings.", "[SILENT]")
    doc = api.parse_document(silent)
    assert doc["silent"] is True


def test_prompt_quoting_the_response_heading_cannot_forge_a_body():
    """The length frame wins: a prompt that itself contains '## Response' must
    not be mistaken for the boundary."""
    tricky_prompt = "ignore me\n## Response\n\nFAKE BODY"
    doc_text = (
        "# Cron Job: tricky\n\n"
        "**Job ID:** aabbccddeeff\n"
        "**Run Time:** 2026-11-25 09:00:00\n\n"
        "**Prompt Characters:** " + str(len(tricky_prompt)) + "\n"
        "## Prompt\n\n" + tricky_prompt + "\n\n"
        "**Response Characters:** 4\n"
        "## Response\n\nreal\n"
    )
    assert api.parse_document(doc_text)["body"] == "real"


def test_truncated_response_frame_yields_no_body_not_prompt_noise():
    truncated = AGENT.rsplit(RESPONSE + "\n", 1)[0]
    doc = api.parse_document(truncated)
    assert "xxxx" not in doc["body"]


def test_agent_failure_marker_is_error():
    body = "[CRON_FAILURE]\nchild died"
    doctext = (
        "# Cron Job: f\n\n**Job ID:** aabbccddeeff\n**Run Time:** 2026-11-25 09:00:00\n\n"
        "**Prompt Characters:** 1\n## Prompt\n\nx\n\n"
        "**Response Characters:** " + str(len(body)) + "\n## Response\n\n" + body + "\n"
    )
    doc = api.parse_document(doctext)
    assert doc["error"] is True
    assert doc["silent"] is False


def test_blocks_status_is_error():
    blocked = """# Cron Job: gates

**Job ID:** aabbccddeeff
**Run Time:** 2026-11-25 09:00:00
**Mode:** no_agent (script)
**Status:** BLOCKED

some reason
"""
    doc = api.parse_document(blocked)
    assert doc["error"] is True
    assert doc["silent"] is False


# ---- live corpus ----------------------------------------------------------- #

def _live_docs():
    root = Path.home() / ".hermes"
    docs = list((root / "cron" / "output").glob("*/*.md"))
    docs += list((root / "profiles").glob("*/cron/output/*/*.md"))
    return docs


def _vanishes_without_a_prompt(fn):
    """Shared body for the two live-corpus checks."""
    for path in _live_docs():
        doc = api.parse_document(path.read_text(encoding="utf-8-sig", errors="replace"))
        fn(doc, path)


@skipif(not _live_docs(), reason="no cron output on this host")
def test_every_live_document_parses():
    """No document may raise, and none may leak the prompt into the body."""

    def check(doc, path):
        assert isinstance(doc["body"], str), path
        if not doc["is_script"]:
            assert "**Prompt Characters:**" not in doc["body"], path

    _vanishes_without_a_prompt(check)


@skipif(not _live_docs(), reason="no cron output on this host")
def test_live_silent_scripts_are_detected():
    def check(doc, path):
        head = path.read_text(encoding="utf-8-sig", errors="replace")[:400]
        if "**Status:** silent" in head:
            assert doc["silent"] is True, path

    _vanishes_without_a_prompt(check)


# ---- script-mode runner ---------------------------------------------------- #

# --------------------------------------------------------------------------- #
# Regression: card-body cleaning must not eat a report's first line
# --------------------------------------------------------------------------- #


def test_clean_body_strips_a_banner_but_keeps_prose():
    """A banner is `label · timestamp`. Prose that merely mentions a date is not.

    The first version tested "short line containing a date" and silently deleted
    real opening lines such as "Backup finished 2026-11-25".
    """
    _clean_body = api._clean_body

    # Stripped: the shape a script report actually uses.
    assert _clean_body("PortWatch VI · 2026-11-25 16:03 UTC\nLeader : x", "PortWatch") \
        == "Leader : x"
    assert _clean_body("──────────\nDigest — 2026-11-25 09:00\n──────────\nbody", "Digest") \
        == "body"

    # Kept: every one of these is content, not furniture.
    for body in (
        "Backup finished 2026-11-25\nAll 42 files copied",
        "Disk at 91% as of 2026-11-25\nmore",
        "Ran at 09:30\nNothing changed",
        "Error 2026-11-25: quota exceeded\nretry later",
        "2026-11-25 report\ncontents",
    ):
        out = _clean_body(body, "Some Job")
        assert out.startswith(body.splitlines()[0]), (
            f"_clean_body ate a real first line: {body.splitlines()[0]!r} -> {out[:60]!r}"
        )


def test_clean_body_strips_a_leading_repeat_of_the_job_name():
    _clean_body = api._clean_body
    assert _clean_body("Nightly curator\nsome body", "Nightly curator") == "some body"
    # But a longer line that merely starts with the name is content.
    kept = _clean_body("Nightly curator finished in 4s\nok", "Nightly curator")
    assert kept.startswith("Nightly curator finished")


if __name__ == "__main__":
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith("test_")]
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
        except Exception as exc:  # noqa: BLE001 - a crash is a failure
            failures += 1
            print(f"ERROR {name}: {type(exc).__name__}: {exc}")
        else:
            print(f"ok   {name}")
    print(f"\n{len(tests) - failures - skipped} passed, {failures} failed, {skipped} skipped")
    raise SystemExit(1 if failures else 0)
