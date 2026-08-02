"""Exported-symbol extraction for the router (Python side)."""

from __future__ import annotations

from keel_gates.symbols import extract_symbols


def _by_name(source: str) -> dict[str, dict[str, object]]:
    return {s["name"]: s for s in extract_symbols("m.py", source)}


def test_extracts_functions_classes_and_variables() -> None:
    symbols = _by_name(
        "def alpha(a: int) -> str:\n"
        "    return str(a)\n"
        "\n"
        "\n"
        "class Beta:\n"
        "    pass\n"
        "\n"
        "\n"
        "GAMMA = 1\n"
        "DELTA: int = 2\n"
    )

    assert symbols["alpha"]["kind"] == "function"
    assert symbols["Beta"]["kind"] == "class"
    assert symbols["GAMMA"]["kind"] == "variable"
    assert symbols["DELTA"]["kind"] == "variable"


def test_leading_underscore_means_private() -> None:
    symbols = _by_name("def public():\n    pass\n\n\ndef _private():\n    pass\n")
    assert symbols["public"]["exported"] is True
    assert symbols["_private"]["exported"] is False


def test_dunder_all_is_authoritative_when_present() -> None:
    symbols = _by_name(
        "__all__ = ['only_this']\n"
        "\n"
        "\n"
        "def only_this():\n"
        "    pass\n"
        "\n"
        "\n"
        "def not_this():\n"
        "    pass\n"
    )
    assert symbols["only_this"]["exported"] is True
    assert symbols["not_this"]["exported"] is False


def test_signature_excludes_the_body() -> None:
    before = _by_name("def f(a: int) -> str:\n    return 'a'\n")
    after = _by_name("def f(a: int) -> str:\n    return 'bbbb'\n")
    assert before["f"]["signature"] == after["f"]["signature"]


def test_signature_changes_when_parameters_change() -> None:
    before = _by_name("def f(a: int) -> str:\n    return 'a'\n")
    after = _by_name("def f(a: int, b: str) -> str:\n    return 'a'\n")
    assert before["f"]["signature"] != after["f"]["signature"]


def test_async_functions_are_distinguished() -> None:
    symbols = _by_name("async def fetch(url: str) -> bytes:\n    return b''\n")
    assert symbols["fetch"]["signature"].startswith("async def")  # type: ignore[union-attr]


def test_line_numbers_are_one_based() -> None:
    symbols = _by_name("\n\ndef f():\n    pass\n")
    assert symbols["f"]["line"] == 3


def test_nested_definitions_are_not_module_symbols() -> None:
    symbols = _by_name("def outer():\n    def inner():\n        pass\n    return inner\n")
    assert "inner" not in symbols


def test_syntax_error_yields_no_symbols_rather_than_raising() -> None:
    assert extract_symbols("m.py", "def f( ->\n") == []


def test_empty_source() -> None:
    assert extract_symbols("m.py", "") == []
