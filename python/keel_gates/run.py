"""Diff-only gate runner for ``rule.py`` packs.

Usage::

    python -m keel_gates.run   # request JSON on stdin, response JSON on stdout

Request::

    {"path": "...", "source": "...", "changed_lines": [1, 2],
     "packs": [{"name": "...", "rule_path": "...", "config": {}}]}

Response::

    {"results": [{"pack": "...", "findings": [...], "error": "..."}]}

The runner also filters findings to ``changed_lines``. The TypeScript side does
the same on the way back, so the constraint holds even if one layer is bypassed
-- it is cheap, and diff-only is the property that makes these gates usable on
a legacy codebase.
"""

from __future__ import annotations

import importlib.util
import sys
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

from .model import Finding, GateContext, read_request, write_response

Rule = Callable[[GateContext], list[Finding]]


def _load_rule(name: str, rule_path: str) -> Rule:
    """Import ``rule_path`` as a module and return its ``rule`` callable."""
    path = Path(rule_path)
    if not path.is_file():
        msg = f"no rule file at {rule_path}"
        raise FileNotFoundError(msg)

    # A unique module name per pack keeps two packs from colliding in
    # sys.modules when both happen to define `rule`.
    spec = importlib.util.spec_from_file_location(f"keel_pack_{name.replace('-', '_')}", path)
    if spec is None or spec.loader is None:
        msg = f"cannot load {rule_path}"
        raise ImportError(msg)

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    candidate = getattr(module, "rule", None)
    if not callable(candidate):
        msg = f"{rule_path} defines no callable named `rule`"
        raise AttributeError(msg)
    return cast(Rule, candidate)


def _run_pack(pack: dict[str, Any], context: GateContext) -> dict[str, Any]:
    name = str(pack.get("name", "unknown"))
    rule_path = pack.get("rule_path")
    if not isinstance(rule_path, str):
        return {"pack": name, "findings": [], "error": "pack has no rule_path"}

    try:
        rule = _load_rule(name, rule_path)
    except Exception as exc:  # noqa: BLE001 - a broken pack must not block the edit
        return {"pack": name, "findings": [], "error": f"{type(exc).__name__}: {exc}"}

    try:
        findings = rule(context)
    except Exception as exc:  # noqa: BLE001 - see above
        detail = traceback.format_exception_only(type(exc), exc)[-1].strip()
        return {"pack": name, "findings": [], "error": detail}

    kept = [
        finding.to_dict()
        for finding in findings
        if isinstance(finding, Finding) and context.is_changed(finding.line)
    ]
    return {"pack": name, "findings": kept}


def main() -> None:
    request = read_request()
    path = request.get("path", "")
    source = request.get("source", "")
    raw_lines = request.get("changed_lines", [])
    packs = request.get("packs", [])

    if not isinstance(path, str) or not isinstance(source, str) or not isinstance(packs, list):
        write_response({"results": []})
        return

    changed = frozenset(int(n) for n in raw_lines if isinstance(n, int))

    results: list[dict[str, Any]] = []
    for pack in packs:
        if not isinstance(pack, dict):
            continue
        config = pack.get("config")
        context = GateContext(
            path=path,
            source=source,
            changed_lines=changed,
            config=config if isinstance(config, dict) else {},
        )
        results.append(_run_pack(pack, context))

    write_response({"results": results})


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - never let a crash reach the developer
        sys.stderr.write(traceback.format_exc())
        write_response({"results": []})
