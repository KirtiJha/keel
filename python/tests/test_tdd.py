"""Python test-file analysis for the four TDD gates."""

from __future__ import annotations

from typing import Any

from keel_gates.tdd import analyse


def test_counts_tests_and_bare_asserts() -> None:
    result = analyse(
        "def test_adds():\n"
        "    assert add(1, 2) == 3\n"
        "\n"
        "\n"
        "def test_subtracts():\n"
        "    assert sub(3, 1) == 2\n"
        "    assert sub(0, 0) == 0\n"
    )

    assert len(result["tests"]) == 2
    assert result["total_assertions"] == 3
    assert result["unparsed"] is False


def test_counts_unittest_matchers() -> None:
    result = analyse(
        "class TestThing:\n"
        "    def test_equal(self):\n"
        "        self.assertEqual(add(1, 2), 3)\n"
    )
    assert "assertEqual" in result["matchers"]
    assert result["tests"][0]["assertions"] == 1


def test_pytest_raises_counts_as_an_assertion() -> None:
    result = analyse(
        "import pytest\n"
        "\n"
        "\n"
        "def test_raises():\n"
        "    with pytest.raises(ValueError):\n"
        "        boom()\n"
    )
    assert "assertRaises" in result["matchers"]


def test_only_test_functions_are_counted() -> None:
    result = analyse(
        "def helper():\n"
        "    assert True\n"
        "\n"
        "\n"
        "def test_real():\n"
        "    assert add(1, 1) == 2\n"
    )
    names = [t["name"] for t in result["tests"]]
    assert names == ["test_real"]


def test_detects_skip_decorators() -> None:
    result = analyse(
        "import pytest\n"
        "\n"
        "\n"
        "@pytest.mark.skip\n"
        "def test_off():\n"
        "    assert True\n"
    )
    assert result["tests"][0]["skipped"] is True


def test_detects_xfail_and_skipif() -> None:
    for decorator in ("@pytest.mark.xfail", "@pytest.mark.skipif(True, reason='x')"):
        result = analyse(f"import pytest\n\n\n{decorator}\ndef test_off():\n    assert True\n")
        assert result["tests"][0]["skipped"] is True, decorator


def test_class_level_skip_applies_to_its_methods() -> None:
    result = analyse(
        "import pytest\n"
        "\n"
        "\n"
        "@pytest.mark.skip\n"
        "class TestGroup:\n"
        "    def test_a(self):\n"
        "        assert True\n"
    )
    assert result["tests"][0]["skipped"] is True


def test_records_patched_targets() -> None:
    result = analyse(
        "from unittest.mock import patch\n"
        "\n"
        "\n"
        "def test_x():\n"
        "    with patch('app.service.charge'):\n"
        "        assert True\n"
    )
    assert "app.service.charge" in result["mocked_modules"]


def test_records_decorator_patches() -> None:
    result = analyse(
        "from unittest.mock import patch\n"
        "\n"
        "\n"
        "@patch('app.gateway.send')\n"
        "def test_x(mock_send):\n"
        "    assert True\n"
    )
    assert "app.gateway.send" in result["mocked_modules"]


def test_records_monkeypatch_setattr() -> None:
    result = analyse(
        "def test_x(monkeypatch):\n"
        "    monkeypatch.setattr('app.clock.now', lambda: 0)\n"
        "    assert True\n"
    )
    assert "app.clock.now" in result["mocked_modules"]


def test_assertion_free_test_is_visible_to_gate_four() -> None:
    result = analyse("def test_nothing():\n    add(1, 2)\n")
    assert result["tests"][0]["assertions"] == 0


def test_syntax_error_marks_the_file_unparsed() -> None:
    result: dict[str, Any] = analyse("def test_x( ->\n")
    assert result["unparsed"] is True
    assert result["tests"] == []


def test_async_tests_are_counted() -> None:
    result = analyse("async def test_fetch():\n    assert await fetch() == 1\n")
    assert len(result["tests"]) == 1
