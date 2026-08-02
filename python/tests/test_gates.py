"""The Python gate runner: diff-only filtering and failure isolation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
PYTHON_DIR = REPO / "python"

RULE_EVERY_LINE = """
from keel_gates.model import Finding, GateContext


def rule(context: GateContext) -> list[Finding]:
    return [
        Finding(line=i + 1, message=f"line {i + 1}", fix="do something else")
        for i, _ in enumerate(context.source.split("\\n"))
    ]
"""

RULE_RAISES = """
def rule(context):
    raise RuntimeError("boom")
"""

RULE_NOT_CALLABLE = """
rule = 42
"""


def run_gates(request: dict[str, Any]) -> dict[str, Any]:
    result = subprocess.run(
        [sys.executable, "-m", "keel_gates.run"],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        cwd=PYTHON_DIR,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    parsed: dict[str, Any] = json.loads(result.stdout)
    return parsed


def write_rule(tmp_path: Path, name: str, body: str) -> str:
    path = tmp_path / f"{name}.py"
    path.write_text(body)
    return str(path)


def test_findings_outside_changed_lines_are_dropped(tmp_path: Path) -> None:
    rule_path = write_rule(tmp_path, "every_line", RULE_EVERY_LINE)
    response = run_gates(
        {
            "path": "a.py",
            "source": "a = 1\nb = 2\nc = 3\nd = 4",
            "changed_lines": [2],
            "packs": [{"name": "every-line", "rule_path": rule_path, "config": {}}],
        }
    )

    findings = response["results"][0]["findings"]
    assert [f["line"] for f in findings] == [2]


def test_no_changed_lines_means_no_findings(tmp_path: Path) -> None:
    rule_path = write_rule(tmp_path, "every_line", RULE_EVERY_LINE)
    response = run_gates(
        {
            "path": "a.py",
            "source": "a = 1\nb = 2",
            "changed_lines": [],
            "packs": [{"name": "every-line", "rule_path": rule_path, "config": {}}],
        }
    )
    assert response["results"][0]["findings"] == []


def test_a_rule_that_raises_reports_an_error_and_blocks_nothing(tmp_path: Path) -> None:
    rule_path = write_rule(tmp_path, "raiser", RULE_RAISES)
    response = run_gates(
        {
            "path": "a.py",
            "source": "a = 1",
            "changed_lines": [1],
            "packs": [{"name": "raiser", "rule_path": rule_path, "config": {}}],
        }
    )

    result = response["results"][0]
    assert result["findings"] == []
    assert "boom" in result["error"]


def test_a_rule_that_is_not_callable_is_reported(tmp_path: Path) -> None:
    rule_path = write_rule(tmp_path, "not_callable", RULE_NOT_CALLABLE)
    response = run_gates(
        {
            "path": "a.py",
            "source": "a = 1",
            "changed_lines": [1],
            "packs": [{"name": "not-callable", "rule_path": rule_path, "config": {}}],
        }
    )
    assert "callable" in response["results"][0]["error"]


def test_a_missing_rule_file_is_reported() -> None:
    response = run_gates(
        {
            "path": "a.py",
            "source": "a = 1",
            "changed_lines": [1],
            "packs": [{"name": "gone", "rule_path": "/nonexistent/rule.py", "config": {}}],
        }
    )
    assert "no rule file" in response["results"][0]["error"]


def test_one_broken_pack_does_not_stop_another(tmp_path: Path) -> None:
    good = write_rule(tmp_path, "good", RULE_EVERY_LINE)
    bad = write_rule(tmp_path, "bad", RULE_RAISES)

    response = run_gates(
        {
            "path": "a.py",
            "source": "a = 1",
            "changed_lines": [1],
            "packs": [
                {"name": "bad", "rule_path": bad, "config": {}},
                {"name": "good", "rule_path": good, "config": {}},
            ],
        }
    )

    by_name = {r["pack"]: r for r in response["results"]}
    assert "error" in by_name["bad"]
    assert len(by_name["good"]["findings"]) == 1


def test_malformed_stdin_yields_an_empty_result() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "keel_gates.run"],
        input="not json at all",
        capture_output=True,
        text=True,
        cwd=PYTHON_DIR,
        check=False,
    )
    assert result.returncode == 0
    assert json.loads(result.stdout) == {"results": []}


def test_empty_stdin_yields_an_empty_result() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "keel_gates.run"],
        input="",
        capture_output=True,
        text=True,
        cwd=PYTHON_DIR,
        check=False,
    )
    assert result.returncode == 0
    assert json.loads(result.stdout) == {"results": []}


def test_pack_config_reaches_the_rule(tmp_path: Path) -> None:
    rule_path = write_rule(
        tmp_path,
        "config_reader",
        "from keel_gates.model import Finding, GateContext\n"
        "\n"
        "\n"
        "def rule(context: GateContext) -> list[Finding]:\n"
        "    marker = context.config.get('marker', 'missing')\n"
        "    return [Finding(line=1, message=str(marker), fix='x')]\n",
    )

    response = run_gates(
        {
            "path": "a.py",
            "source": "a = 1",
            "changed_lines": [1],
            "packs": [{"name": "cfg", "rule_path": rule_path, "config": {"marker": "present"}}],
        }
    )
    assert response["results"][0]["findings"][0]["message"] == "present"
