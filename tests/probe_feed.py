"""Emit the real /feed payload as JSON, for the render test to consume.

Lives beside the tests so the render test does not have to embed Python in a
shell string (that quoting is how newlines became literal backslash-n).
"""
import asyncio
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "plugin_api", HERE.parent / "dashboard" / "plugin_api.py"
)
m = importlib.util.module_from_spec(spec)
sys.modules["plugin_api"] = m
spec.loader.exec_module(m)

print(json.dumps(asyncio.run(m.feed())))
