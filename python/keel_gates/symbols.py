"""Exported-symbol extraction for the router.

Usage::

    echo '{"path": "m.py", "source": "def f(): ..."}' | python -m keel_gates.symbols

Mirrors ``extractSymbols`` in ``src/shared/ast/ts.ts``: module-level
declarations only, a normalised signature that excludes the body, and an
``exported`` flag.
"""

from __future__ import annotations

import ast
from typing import Any

from .model import read_request, write_response


def _normalise(text: str) -> str:
    return " ".join(text.split())


def _explicit_exports(tree: ast.Module) -> frozenset[str] | None:
    """Names in ``__all__``, or None when the module does not define one."""
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        targets = [t for t in node.targets if isinstance(t, ast.Name) and t.id == "__all__"]
        if not targets:
            continue
        if isinstance(node.value, (ast.List, ast.Tuple)):
            names = {
                element.value
                for element in node.value.elts
                if isinstance(element, ast.Constant) and isinstance(element.value, str)
            }
            return frozenset(names)
    return None


def _signature(node: ast.AST) -> str:
    """Declaration header without the body."""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
        args = ast.unparse(node.args)
        returns = f" -> {ast.unparse(node.returns)}" if node.returns is not None else ""
        return _normalise(f"{prefix} {node.name}({args}){returns}")
    if isinstance(node, ast.ClassDef):
        bases = ", ".join(ast.unparse(b) for b in node.bases)
        return _normalise(f"class {node.name}({bases})")
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        return _normalise(f"{node.target.id}: {ast.unparse(node.annotation)}")
    return _normalise(ast.unparse(node))


def extract_symbols(path: str, source: str) -> list[dict[str, Any]]:
    """Module-level symbols, each flagged exported or not.

    Without ``__all__``, Python's convention is the rule: a leading underscore
    means private. With ``__all__``, that list is authoritative.
    """
    del path  # Present for symmetry with the TypeScript side; not needed here.
    try:
        tree = ast.parse(source)
    except SyntaxError:
        # A file mid-edit does not parse. No symbols is the right answer, and a
        # crash here would take the router down with it.
        return []

    declared = _explicit_exports(tree)
    symbols: list[dict[str, Any]] = []

    def is_exported(name: str) -> bool:
        if declared is not None:
            return name in declared
        return not name.startswith("_")

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            symbols.append(
                {
                    "name": node.name,
                    "kind": "function",
                    "line": node.lineno,
                    "exported": is_exported(node.name),
                    "signature": _signature(node),
                }
            )
        elif isinstance(node, ast.ClassDef):
            symbols.append(
                {
                    "name": node.name,
                    "kind": "class",
                    "line": node.lineno,
                    "exported": is_exported(node.name),
                    "signature": _signature(node),
                }
            )
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id != "__all__":
                    symbols.append(
                        {
                            "name": target.id,
                            "kind": "variable",
                            "line": node.lineno,
                            "exported": is_exported(target.id),
                            "signature": _normalise(f"{target.id} = ..."),
                        }
                    )
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            symbols.append(
                {
                    "name": node.target.id,
                    "kind": "variable",
                    "line": node.lineno,
                    "exported": is_exported(node.target.id),
                    "signature": _signature(node),
                }
            )

    return symbols


def main() -> None:
    request = read_request()
    path = request.get("path", "")
    source = request.get("source", "")
    if not isinstance(path, str) or not isinstance(source, str):
        write_response({"symbols": []})
        return
    write_response({"symbols": extract_symbols(path, source)})


if __name__ == "__main__":
    main()
