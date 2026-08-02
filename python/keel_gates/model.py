"""Shared value objects for the Python side.

These mirror the TypeScript interfaces in ``src/standards/types.ts`` field for
field. The JSON on the wire is the contract; keep both ends in step.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class Finding:
    """One rule violation, anchored to a line in the file being checked."""

    line: int
    message: str
    fix: str
    column: int = 1

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class GateContext:
    """Everything a ``rule.py`` gets. Deliberately narrow."""

    #: Repo-relative path, POSIX separators.
    path: str
    #: Full text of the file, so rules can read surrounding context.
    source: str
    #: 1-based line numbers that this change touched. Findings outside this set
    #: are dropped by the runner; see the diff-only rule in the build spec (M4).
    changed_lines: frozenset[int]
    #: Free-form config from the pack's ``standard.yaml``.
    config: dict[str, Any] = field(default_factory=dict)

    def is_changed(self, line: int) -> bool:
        return line in self.changed_lines


def read_request() -> dict[str, Any]:
    """Read one JSON request from stdin.

    Returns an empty mapping on malformed input rather than raising: the
    TypeScript caller treats a well-formed empty result as 'no findings', which
    is the correct fail-open behaviour for a crashed analyser.
    """
    try:
        raw = sys.stdin.read()
    except (OSError, UnicodeDecodeError):
        return {}
    if not raw.strip():
        return {}
    try:
        parsed: Any = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def write_response(payload: dict[str, Any]) -> None:
    """Emit one JSON response on stdout."""
    json.dump(payload, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
