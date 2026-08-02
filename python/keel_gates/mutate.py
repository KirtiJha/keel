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
import bisect
import re
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


#: What Python's tokenizer treats as a line break — and nothing else.
_LINE_END = re.compile(r"\r\n|\r|\n")


def _split_lines(source: str) -> list[str]:
    """Split ``source`` into lines the way Python's tokenizer does.

    ``str.splitlines`` also breaks on ``\\x0b``, ``\\x0c``, ``\\x1c``-``\\x1e``,
    ``\\x85``, ``\\u2028`` and ``\\u2029``. Python does not: one of those inside
    a string literal would shift every line number after it out of step with
    what ``ast`` reports.
    """
    lines: list[str] = []
    start = 0
    for match in _LINE_END.finditer(source):
        lines.append(source[start : match.end()])
        start = match.end()
    if start < len(source):
        lines.append(source[start:])
    return lines


def _byte_to_char(line: str) -> list[int] | None:
    """Character index for every byte offset in ``line``, or ``None`` if ASCII.

    An ASCII line needs no table: byte offset and character offset are equal,
    which is both the common case and the fast path.
    """
    if line.isascii():
        return None
    table: list[int] = []
    for index, char in enumerate(line):
        table.extend([index] * len(char.encode("utf-8")))
    # One past the end, so a span that reaches the end of the line maps cleanly.
    table.append(len(line))
    return table


class _Offsets:
    """Translate ast's ``(lineno, col_offset)`` into absolute character offsets.

    ``ast`` reports ``col_offset``/``end_col_offset`` as **UTF-8 byte** offsets
    into the line, while every offset on the wire — and every index into
    ``source`` — is a **character** offset. The two diverge the moment a line
    contains anything outside ASCII, so each line carries a byte-to-character
    table and both spaces are tracked separately.
    """

    def __init__(self, source: str) -> None:
        #: Character offset of the start of each line.
        self._starts: list[int] = []
        #: Length of each line, in characters.
        self._lengths: list[int] = []
        #: Byte-to-character table per line; ``None`` for ASCII-only lines.
        self._tables: list[list[int] | None] = []
        offset = 0
        for line in _split_lines(source):
            self._starts.append(offset)
            self._lengths.append(len(line))
            self._tables.append(_byte_to_char(line))
            offset += len(line)

    def at(self, lineno: int, col: int) -> int:
        """Absolute character offset of byte column ``col`` on line ``lineno``."""
        if lineno < 1 or lineno > len(self._starts) or col < 0:
            return -1
        index = lineno - 1
        table = self._tables[index]
        if table is None:
            column = min(col, self._lengths[index])
        elif col < len(table):
            column = table[col]
        else:
            column = self._lengths[index]
        return self._starts[index] + column

    def line_at(self, offset: int) -> int:
        """1-based line number containing character offset ``offset``.

        Counting ``\\n`` would disagree with :func:`_split_lines` on a file with
        old-style ``\\r`` line endings; this cannot.
        """
        return bisect.bisect_right(self._starts, offset)

    def span(self, node: ast.AST) -> tuple[int, int]:
        lineno = getattr(node, "lineno", 0)
        col = getattr(node, "col_offset", 0)
        end_lineno = getattr(node, "end_lineno", None)
        end_col = getattr(node, "end_col_offset", None)
        if end_lineno is None or end_col is None:
            return (-1, -1)
        return (self.at(lineno, col), self.at(end_lineno, end_col))


def _parses(source: str) -> bool:
    """Whether ``source`` is valid Python."""
    try:
        compile(source, "<mutant>", "exec", ast.PyCF_ONLY_AST)
    except (SyntaxError, ValueError):
        return False
    return True


class _Units:
    """Smallest self-contained parse unit around each offset.

    Every mutant is re-parsed before it is emitted. Re-parsing the whole file
    each time is O(file x mutants), which on a large new file overruns the 15 s
    the TypeScript side gives this process — and a timeout there means *no*
    mutants at all.

    A module-level statement is a self-contained parse unit: it starts at the
    beginning of a logical line, and it cannot contain an unbalanced bracket or
    quote (or it would have swallowed the statement after it). So if such a
    statement parses on its own, and still parses with a mutation applied inside
    it, the file containing it does too. Statements that do *not* parse in
    isolation are simply not registered, and those mutants fall back to
    re-parsing the whole source.
    """

    def __init__(self, tree: ast.Module, offsets: _Offsets, source: str) -> None:
        self._source = source
        self._spans: list[tuple[int, int]] = []
        for stmt in tree.body:
            start, end = offsets.span(stmt)
            if 0 <= start < end <= len(source) and _parses(source[start:end]):
                self._spans.append((start, end))
        self._starts = [start for start, _ in self._spans]

    def parses_with(self, start: int, end: int, replacement: str) -> bool:
        """Whether the file still parses with ``source[start:end]`` replaced."""
        index = bisect.bisect_right(self._starts, start) - 1
        if index >= 0:
            unit_start, unit_end = self._spans[index]
            if unit_start <= start and end <= unit_end:
                unit = self._source[unit_start:unit_end]
                mutated = unit[: start - unit_start] + replacement + unit[end - unit_start :]
                return _parses(mutated)
        return _parses(self._source[:start] + replacement + self._source[end:])


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
    units = _Units(tree, offsets, source)
    mutants: list[dict[str, Any]] = []
    seen: set[tuple[int, int, str]] = set()

    def emit(start: int, end: int, replacement: str, operator: str) -> None:
        if start < 0 or end < 0 or start >= end or end > len(source):
            return
        line = offsets.line_at(start)
        if line not in changed:
            return
        original = source[start:end]
        if original == replacement:
            return
        key = (start, end, replacement)
        if key in seen:
            return
        seen.add(key)
        # Defence in depth. A mutant that does not compile can never be
        # legitimately killed: the test command fails on the SyntaxError, the
        # runner reads any failure as a kill, and a mutant that was never
        # really applied inflates the score. Drop it instead.
        if not units.parses_with(start, end, replacement):
            return
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
