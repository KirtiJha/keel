"""Python mutant generation."""

from __future__ import annotations

from typing import Any

from keel_gates.mutate import generate

ALL = frozenset(range(1, 200))


def _ops(source: str, changed: frozenset[int] = ALL) -> set[str]:
    return {m["operator"] for m in generate("m.py", source, changed)}


def _by_op(source: str, operator: str) -> list[dict[str, Any]]:
    return [m for m in generate("m.py", source, ALL) if m["operator"] == operator]


def test_mutates_comparison_boundaries() -> None:
    mutants = _by_op("def f(a, b):\n    return a > b\n", "conditional-boundary")
    assert mutants
    assert mutants[0]["original"] == ">"
    assert mutants[0]["replacement"] == ">="


def test_mutates_equality() -> None:
    mutants = _by_op("def f(a):\n    return a == 1\n", "negate-conditional")
    assert mutants
    assert mutants[0]["replacement"] == "!="


def test_mutates_arithmetic() -> None:
    mutants = _by_op("def f(a, b):\n    return a + b\n", "arithmetic")
    assert mutants
    assert mutants[0]["original"] == "+"
    assert mutants[0]["replacement"] == "-"


def test_mutates_and_or() -> None:
    mutants = _by_op("def f(a, b):\n    return a and b\n", "logical")
    assert mutants
    assert mutants[0]["original"] == "and"
    assert mutants[0]["replacement"] == "or"


def test_mutates_boolean_literals() -> None:
    mutants = _by_op("X = True\n", "boolean-literal")
    assert mutants
    assert mutants[0]["replacement"] == "False"


def test_mutates_non_empty_strings() -> None:
    mutants = _by_op('X = "hello"\n', "string-literal")
    assert mutants
    assert mutants[0]["replacement"] == '""'


def test_does_not_mutate_empty_strings() -> None:
    assert not _by_op('X = ""\n', "string-literal")


def test_nulls_return_values() -> None:
    mutants = _by_op("def f(a):\n    return a * 2\n", "return-value")
    assert mutants
    assert mutants[0]["replacement"] == "None"


def test_does_not_mutate_a_bare_return_none() -> None:
    assert not _by_op("def f():\n    return None\n", "return-value")


def test_offsets_point_at_the_real_token() -> None:
    source = "def f(a, b):\n    return a + b\n"
    mutants = _by_op(source, "arithmetic")
    start, end = mutants[0]["start"], mutants[0]["end"]
    assert source[start:end] == "+"


def test_applying_a_mutant_produces_valid_python() -> None:
    import ast

    source = "def f(a, b):\n    return a + b\n"
    mutant = _by_op(source, "arithmetic")[0]
    mutated = source[: mutant["start"]] + mutant["replacement"] + source[mutant["end"] :]
    assert mutated != source
    ast.parse(mutated)


def test_is_diff_only() -> None:
    source = "def f(a):\n    return a > 1\n\n\ndef g(a):\n    return a > 2\n"
    mutants = generate("m.py", source, frozenset({6}))
    assert mutants
    assert all(m["line"] == 6 for m in mutants)


def test_no_changed_lines_means_no_mutants() -> None:
    assert generate("m.py", "def f(a):\n    return a > 1\n", frozenset()) == []


def test_does_not_mutate_inside_comments() -> None:
    source = "# a > b and a + b\nX = 1\n"
    assert not [m for m in generate("m.py", source, ALL) if m["line"] == 1]


def test_syntax_error_yields_no_mutants() -> None:
    assert generate("m.py", "def f( ->\n", ALL) == []


def test_chained_comparison_mutates_each_operator() -> None:
    mutants = _by_op("def f(a, b, c):\n    return a < b < c\n", "conditional-boundary")
    assert len(mutants) == 2


def test_covers_the_expected_operator_set() -> None:
    source = (
        "def f(a, b):\n"
        "    if a > b and a == 1:\n"
        '        return "yes"\n'
        "    return a + b\n"
    )
    assert _ops(source) >= {
        "conditional-boundary",
        "negate-conditional",
        "logical",
        "arithmetic",
        "return-value",
        "string-literal",
    }


def test_mutants_are_unique() -> None:
    source = "def f(a, b):\n    return a + b\n"
    mutants = generate("m.py", source, ALL)
    keys = {(m["start"], m["end"], m["replacement"]) for m in mutants}
    assert len(keys) == len(mutants)
