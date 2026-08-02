"""Python-side analysis for Keel.

Two entry points, both driven over stdin/stdout JSON so the TypeScript layer
never has to care how Python is installed:

* ``python -m keel_gates.symbols`` -- exported-symbol extraction for the router
* ``python -m keel_gates.run``     -- diff-only gate runner for ``rule.py`` packs

Only the standard library is used. ``ast`` is enough for everything here, and a
third-party parser would be one more thing to pin, mirror and keep working.
"""

__version__ = "0.1.0"
