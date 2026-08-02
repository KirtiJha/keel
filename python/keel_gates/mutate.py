"""Mutant generation for Python, driven by the stdlib ``ast``.

Usage::

    echo '{"path": "m.py", "source": "...", "changed_lines": [1,2]}' \
        | python -m keel_gates.mutate

Emits ``(start, end, replacement)`` character offsets so the TypeScript runner
can apply and revert mutants without knowing anything about Python.

AST-driven rather than regex-driven: a regex would mutate the ``+`` inside a
string, a comment, or a version number, producing mutants no test can kill and
a score that means nothing.
"""

from __future__ import annotations

import ast
from typing import Any

from .model import read_request, write_response

#: Comparison operators and what they become.
_COMPARE: dict[type[ast.cmpop], tuple[str, str, str]] = {
    ast.Lt: ("<", "<=", "conditional-boundary"),
    ast.LtE: ("<=", "<", "conditional-boundary"),
    ast.Gt: (">", ">=", "conditional-boundary"),
    ast.GtE: (">=", ">", "conditional-boundary"),
    ast.Eq: ("==", "!=", "negate-conditional"),
    ast.NotEq: ("!=", "==", "negate-conditional"),
}

#: Arithmetic operators.
_BINOP: dict[type[ast.operator], tuple[str, str, str]] = {
    ast.Add: ("+", "-", "arithmetic"),
    ast.Sub: ("-", "+", "arithmetic"),
    ast.Mult: ("*", "/", "arithmetic"),
    ast.Div: ("/", "*", "arithmetic"),
    ast.Mod: ("%", "*", "arithmetic"),
}


class _Offsets:
    """Translate (lineno, col_offset) into absolute character offsets."""

    def __init__(self, source: str) -> None:
        self._starts: list[int] = []
        offset = 0
        for line in source.splitlines(keepends=True):
            self._starts.append(offset)
            offset += len(line)
        self._source = source

    def at(self, lineno: int, col: int) -> int:
        if lineno < 1 or lineno > len(self._starts):
            return -1
        return self._starts[lineno - 1] + col

    def span(self, node: ast.AST) -> tuple[int, int]:
        lineno = getattr(node, "lineno", 0)
        col = getattr(node, "col_offset", 0)
        end_lineno = getattr(node, "end_lineno", None)
        end_col = getattr(node, "end_col_offset", None)
        if end_lineno is None or end_col is None:
            return (-1, -1)
        return (self.at(lineno, col), self.at(end_lineno, end_col))


def _find_operator(source: str, start: int, end: int, token: str) -> tuple[int, int] | None:
    """Locate ``token`` between two operand spans, skipping strings and comments.

    Python's ``ast`` gives spans for operands but not for the operator itself,
    so the operator is found in the gap between them.
    """
    if start < 0 or end < 0 or start >= end:
        return None
    gap = source[start:end]
    index = gap.find(token)
    if index < 0:
        return None
    # Reject a match inside a comment; strings cannot appear in an operator gap.
    if "#" in gap[:index]:
        return None
    return (start + index, start + index + len(token))


def generate(path: str, source: str, changed: frozenset[int]) -> list[dict[str, Any]]:
    """Mutants confined to ``changed`` lines."""
    del path  # Present for symmetry with the TypeScript side.
    if not changed:
        return []

    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []

    offsets = _Offsets(source)
    mutants: list[dict[str, Any]] = []
    seen: set[tuple[int, int, str]] = set()

    def emit(start: int, end: int, replacement: str, operator: str) -> None:
        if start < 0 or end < 0 or start >= end:
            return
        line = source.count("\n", 0, start) + 1
        if line not in changed:
            return
        original = source[start:end]
        if original == replacement:
            return
        key = (start, end, replacement)
        if key in seen:
            return
        seen.add(key)
        mutants.append(
            {
                "line": line,
                "operator": operator,
                "start": start,
                "end": end,
                "replacement": replacement,
                "original": original,
            }
        )

    for node in ast.walk(tree):
        # ---- comparisons ----
        if isinstance(node, ast.Compare) and node.ops and node.comparators:
            left_span = offsets.span(node.left)
            for op, comparator in zip(node.ops, node.comparators, strict=False):
                entry = _COMPARE.get(type(op))
                right_span = offsets.span(comparator)
                if entry is not None:
                    token, replacement, operator = entry
                    found = _find_operator(source, left_span[1], right_span[0], token)
                    if found is not None:
                        emit(found[0], found[1], replacement, operator)
                left_span = right_span

        # ---- arithmetic ----
        elif isinstance(node, ast.BinOp):
            entry = _BINOP.get(type(node.op))
            if entry is not None:
                token, replacement, operator = entry
                left_span = offsets.span(node.left)
                right_span = offsets.span(node.right)
                found = _find_operator(source, left_span[1], right_span[0], token)
                if found is not None:
                    emit(found[0], found[1], replacement, operator)

        # ---- and / or ----
        elif isinstance(node, ast.BoolOp) and len(node.values) >= 2:
            token = "and" if isinstance(node.op, ast.And) else "or"
            replacement = "or" if token == "and" else "and"
            for left, right in zip(node.values, node.values[1:], strict=False):
                found = _find_operator(source, offsets.span(left)[1], offsets.span(right)[0], token)
                if found is not None:
                    emit(found[0], found[1], replacement, "logical")

        # ---- literals ----
        elif isinstance(node, ast.Constant):
            start, end = offsets.span(node)
            if isinstance(node.value, bool):
                emit(start, end, "False" if node.value else "True", "boolean-literal")
            elif isinstance(node.value, str) and node.value:
                emit(start, end, '""', "string-literal")

        # ---- return values ----
        elif isinstance(node, ast.Return) and node.value is not None:
            start, end = offsets.span(node.value)
            text = source[start:end] if start >= 0 and end >= 0 else ""
            if text not in {"None", "True", "False", ""}:
                emit(start, end, "None", "return-value")

    return mutants


def main() -> None:
    request = read_request()
    path = request.get("path", "")
    source = request.get("source", "")
    raw_lines = request.get("changed_lines", [])

    if not isinstance(path, str) or not isinstance(source, str):
        write_response({"mutants": []})
        return

    changed = frozenset(int(n) for n in raw_lines if isinstance(n, int))
    write_response({"mutants": generate(path, source, changed)})


if __name__ == "__main__":
    main()
