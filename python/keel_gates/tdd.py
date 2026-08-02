"""Python test-file analysis for the four TDD gates.

Usage::

    echo '{"path": "test_x.py", "source": "..."}' | python -m keel_gates.tdd

Produces the same shape as ``analyseTypeScriptTests`` in
``src/tdd/analysis.ts`` so the gates themselves are language-agnostic.
"""

from __future__ import annotations

import ast
from typing import Any

from .model import read_request, write_response

#: Decorators that switch a test off.
SKIP_DECORATORS = frozenset({"skip", "skipif", "xfail", "skipUnless", "skipIf"})

#: Calls that mock a module or attribute by dotted string.
MOCK_CALLS = frozenset({"patch", "setattr", "setitem", "patch_object"})


def _decorator_names(node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef) -> list[str]:
    names: list[str] = []
    for decorator in node.decorator_list:
        target = decorator.func if isinstance(decorator, ast.Call) else decorator
        if isinstance(target, ast.Attribute):
            names.append(target.attr)
        elif isinstance(target, ast.Name):
            names.append(target.id)
    return names


def _is_test_function(name: str) -> bool:
    return name.startswith("test_") or name == "test"


def _call_name(node: ast.Call) -> str:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


def _matcher_for(node: ast.Call) -> str | None:
    """Matcher name for an assertion-shaped call, or None."""
    name = _call_name(node)
    if name.startswith("assert") and name != "assert":
        return name
    if name == "raises":
        # pytest.raises(...) asserts that something raises.
        return "assertRaises"
    return None


def _collect_mocks(tree: ast.Module) -> list[str]:
    """Module/attribute targets passed to a mocking call as a literal string."""
    mocked: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if _call_name(node) not in MOCK_CALLS:
            continue
        if not node.args:
            continue
        first = node.args[0]
        if isinstance(first, ast.Constant) and isinstance(first.value, str):
            mocked.append(first.value)
    # `@patch("a.b.c")` used as a decorator is already covered: decorators are
    # Call nodes and ast.walk reaches them.
    return mocked


def _analyse_test(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    class_skipped: bool,
) -> dict[str, Any]:
    assertions = 0
    matchers: list[str] = []

    for child in ast.walk(node):
        if isinstance(child, ast.Assert):
            assertions += 1
            matchers.append("assert")
        elif isinstance(child, ast.Call):
            matcher = _matcher_for(child)
            if matcher is not None:
                assertions += 1
                matchers.append(matcher)

    decorators = _decorator_names(node)
    return {
        "name": node.name,
        "line": node.lineno,
        "assertions": assertions,
        "matchers": matchers,
        "skipped": class_skipped or any(d in SKIP_DECORATORS for d in decorators),
        # pytest has no `.only`; `-k` is a runtime flag, not a source marker.
        "focused": False,
    }


def analyse(source: str) -> dict[str, Any]:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {
            "tests": [],
            "total_assertions": 0,
            "mocked_modules": [],
            "matchers": [],
            "unparsed": True,
        }

    tests: list[dict[str, Any]] = []

    def walk_body(body: list[ast.stmt], class_skipped: bool) -> None:
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if _is_test_function(node.name):
                    tests.append(_analyse_test(node, class_skipped))
            elif isinstance(node, ast.ClassDef):
                skipped = class_skipped or any(
                    d in SKIP_DECORATORS for d in _decorator_names(node)
                )
                walk_body(node.body, skipped)

    walk_body(tree.body, class_skipped=False)

    all_matchers: list[str] = []
    for test in tests:
        all_matchers.extend(test["matchers"])

    return {
        "tests": tests,
        "total_assertions": sum(int(t["assertions"]) for t in tests),
        "mocked_modules": _collect_mocks(tree),
        "matchers": all_matchers,
        "unparsed": False,
    }


def main() -> None:
    request = read_request()
    source = request.get("source", "")
    if not isinstance(source, str):
        write_response(analyse(""))
        return
    write_response(analyse(source))


if __name__ == "__main__":
    main()
