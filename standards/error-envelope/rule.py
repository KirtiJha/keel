"""Python half of the `error-envelope` standard.

Shares `standard.yaml` with `rule.ts`, so the envelope's shape is configured
once and both languages agree. Flags error payloads built as bare dict literals
instead of through the shared factory.
"""

from __future__ import annotations

import ast
from typing import Any

from keel_gates.model import Finding, GateContext


def _config_list(config: dict[str, Any], key: str) -> list[str]:
    value = config.get(key)
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _config_str(config: dict[str, Any], key: str, fallback: str) -> str:
    value = config.get(key)
    return value if isinstance(value, str) else fallback


def _dict_keys(node: ast.Dict) -> set[str]:
    keys: set[str] = set()
    for key in node.keys:
        if isinstance(key, ast.Constant) and isinstance(key.value, str):
            keys.add(key.value.lower())
    return keys


def _spreads_factory(node: ast.Dict, factory: str) -> bool:
    """``{**error_response(exc), "trace_id": t}`` is an extension, not a bypass."""
    for key, value in zip(node.keys, node.values, strict=True):
        if key is not None:
            continue
        # key is None for `**expr` entries.
        if isinstance(value, ast.Call) and _call_name(value) == factory:
            return True
    return False


def _call_name(node: ast.Call) -> str:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


def rule(context: GateContext) -> list[Finding]:
    try:
        tree = ast.parse(context.source)
    except SyntaxError:
        # Mid-edit files do not parse. No findings is the right answer.
        return []

    config = context.config
    factory = _config_str(config, "python_envelope_factory", "error_response")
    envelope_type = _config_str(config, "envelope_type", "ErrorResponse")
    error_keys = {k.lower() for k in _config_list(config, "error_keys")}
    senders = set(_config_list(config, "response_senders"))

    findings: list[Finding] = []
    seen: set[int] = set()

    def report(node: ast.AST, what: str) -> None:
        line = getattr(node, "lineno", 0)
        if line in seen or line == 0:
            return
        seen.add(line)
        findings.append(
            Finding(
                line=line,
                column=getattr(node, "col_offset", 0) + 1,
                message=f"{what} builds an error payload as a bare dict literal",
                fix=(
                    f"return `{factory}(...)` so the response matches the shared "
                    f"`{envelope_type}` envelope"
                ),
            )
        )

    def check(node: ast.AST, what: str) -> None:
        if not isinstance(node, ast.Dict):
            return
        if not (_dict_keys(node) & error_keys):
            return
        if _spreads_factory(node, factory):
            return
        report(node, what)

    for node in ast.walk(tree):
        if isinstance(node, ast.Return) and node.value is not None:
            check(node.value, "return statement")
        elif isinstance(node, ast.Call):
            name = _call_name(node)
            if name in senders and node.args:
                check(node.args[0], f"`{name}()`")

    return findings
