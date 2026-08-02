"""Python mutant generation."""

from __future__ import annotations

import ast
from typing import Any

from keel_gates.mutate import generate

ALL = frozenset(range(1, 200))


def _ops(source: str, changed: frozenset[int] = ALL) -> set[str]:
    return {m["operator"] for m in generate("m.py", source, changed)}


def _by_op(source: str, operator: str) -> list[dict[str, Any]]:
    return [m for m in generate("m.py", source, ALL) if m["operator"] == operator]


def _apply(source: str, mutant: dict[str, Any]) -> str:
    """Apply a mutant the way ``src/mutation/operators.ts`` does."""
    return source[: mutant["start"]] + mutant["replacement"] + source[mutant["end"] :]


def _parseable(source: str) -> bool:
    try:
        ast.parse(source)
    except (SyntaxError, ValueError):
        return False
    return True


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


# ---------------------------------------------------------------------------
# Non-ASCII source. ``ast`` reports columns as UTF-8 *byte* offsets; the wire
# format is *character* offsets. Every span after a multi-byte character on the
# same line is wrong unless the two are converted.
# ---------------------------------------------------------------------------


def test_accented_characters_do_not_shift_later_spans() -> None:
    source = 'def f(x):\n    return "café" if x else "dog"\n'
    mutants = _by_op(source, "string-literal")
    originals = [m["original"] for m in mutants]
    assert '"café"' in originals
    assert '"dog"' in originals
    for mutant in mutants:
        assert source[mutant["start"] : mutant["end"]] == mutant["original"]


def test_cjk_characters_do_not_shift_later_spans() -> None:
    source = 'def f(x):\n    return "日本語テスト" if x else "dog"\n'
    mutants = _by_op(source, "string-literal")
    assert '"dog"' in [m["original"] for m in mutants]
    for mutant in mutants:
        assert source[mutant["start"] : mutant["end"]] == mutant["original"]


def test_astral_plane_emoji_do_not_shift_later_spans() -> None:
    # A four-byte character: one UTF-8 codepoint, one Python character.
    source = 'def f(a, b):\n    return len("🎉🎉") + a\n'
    mutants = _by_op(source, "arithmetic")
    assert mutants
    assert mutants[0]["original"] == "+"
    assert source[mutants[0]["start"] : mutants[0]["end"]] == "+"


def test_non_ascii_earlier_in_the_file_does_not_shift_later_lines() -> None:
    source = 'X = "café"\n\n\ndef f(a, b):\n    return a > b\n'
    mutants = _by_op(source, "conditional-boundary")
    assert mutants
    assert mutants[0]["line"] == 5
    assert source[mutants[0]["start"] : mutants[0]["end"]] == ">"


def test_ascii_only_offsets_are_unchanged() -> None:
    # Regression guard: the byte/character conversion must be a no-op here.
    source = 'def f(a, b):\n    return "yes" if a > b else a + b\n'
    for mutant in generate("m.py", source, ALL):
        assert source[mutant["start"] : mutant["end"]] == mutant["original"]
    starts = {m["operator"]: m["start"] for m in generate("m.py", source, ALL)}
    assert source[starts["conditional-boundary"]] == ">"
    assert source[starts["arithmetic"]] == "+"


def test_multi_line_span_with_non_ascii_on_both_lines() -> None:
    source = 'def f(x):\n    return ("café"\n            + "naïve")\n'
    mutants = _by_op(source, "return-value")
    assert mutants
    # The span starts after a multi-byte character on line 2 and ends after one
    # on line 3; both ends have to be converted independently.
    assert mutants[0]["original"] == '"café"\n            + "naïve"'
    assert source[mutants[0]["start"] : mutants[0]["end"]] == mutants[0]["original"]


def test_a_unicode_line_separator_inside_a_string_is_not_a_line_break() -> None:
    # ``str.splitlines`` breaks on U+2028; Python's tokenizer does not, so a
    # naive split loses every line number after it.
    source = 'X = "a\u2028b"\n\n\ndef f(a, b):\n    return a + b\n'
    mutants = _by_op(source, "arithmetic")
    assert mutants
    assert mutants[0]["line"] == 5
    assert source[mutants[0]["start"] : mutants[0]["end"]] == "+"


# ---------------------------------------------------------------------------
# Defence in depth: a mutant that does not parse would fail the test command
# for the wrong reason, and the runner scores any failure as a kill.
# ---------------------------------------------------------------------------

_CORPUS = (
    'def f(x):\n    return "café" if x else "dog"\n',
    'def f(x):\n    return "日本語テスト" if x else "dog"\n',
    'def f(a, b):\n    return len("🎉") + a > b and a == 1\n',
    'X = "café"\nY = X + "naïve"\nZ = True\n',
    'def f(x):\n    return ("café"\n            + "naïve")\n',
    'x = f"café{y}dog"\n',
    "x = f\"{ 'in' }\"\n",
    'x = f"{v!r:{\'>\'}}"\n',
    'X = "a\u2028b"\nY = 1 + 2\n',
    "def f(a, b):\n    return a + b\n",
    # Nested and late in the file, so validation cannot rely on the mutation
    # sitting inside the first top-level statement.
    'X = 1\n\n\nclass C:\n    def g(self, a):\n        return f"{ \'in\' }" if a else "café"\n',
)


def test_every_generated_mutant_produces_parseable_source() -> None:
    for source in _CORPUS:
        for mutant in generate("m.py", source, ALL):
            mutated = _apply(source, mutant)
            assert mutated != source
            assert _parseable(mutated), f"unparseable mutant from {source!r}: {mutated!r}"


def test_validation_does_not_discard_legitimate_mutants() -> None:
    # The parse check must reject only what is genuinely broken. Non-ASCII, a
    # nested body and several top-level statements all have to survive it.
    source = (
        'HEADER = "café"\n'
        "\n"
        "\n"
        "class C:\n"
        "    def f(self, a, b):\n"
        "        if a > b and a == 1:\n"
        '            return "naïve"\n'
        "        return a + b\n"
    )
    assert _ops(source) == {
        "string-literal",
        "conditional-boundary",
        "negate-conditional",
        "logical",
        "arithmetic",
        "return-value",
    }
    for mutant in generate("m.py", source, ALL):
        assert source[mutant["start"] : mutant["end"]] == mutant["original"]
        assert _parseable(_apply(source, mutant))


#: ``(source, what an unguarded generator would produce)``. Which one is a
#: SyntaxError depends on the interpreter — PEP 701 changed both the spans
#: ``ast`` reports inside f-strings and what may legally nest in them — so both
#: are listed and the test requires at least one to bite.
_UNPARSEABLE_TRAPS = (
    ("x = f\"{ 'in' }\"\n", 'x = f"{ "" }"\n'),
    ('x = f"café{y}dog"\n', 'x = f"""{y}dog"\n'),
)


def test_a_mutant_that_would_not_parse_is_never_emitted() -> None:
    bitten = 0
    for source, unguarded in _UNPARSEABLE_TRAPS:
        if _parseable(unguarded):
            continue
        bitten += 1
        for mutant in generate("m.py", source, ALL):
            assert _apply(source, mutant) != unguarded
            assert _parseable(_apply(source, mutant))
    assert bitten, "no trap is a SyntaxError on this interpreter"
