"""PyInstaller entrypoint.

api/server.py uses relative imports (``from .routers import ...``), which
only work when it's imported as a submodule of the ``api`` package -- not
when PyInstaller runs it directly as the top-level script (no ``__package__``
context, so the import raises ``ImportError: attempted relative import with
no known parent package``). This wrapper is the actual Analysis entry point
instead, so ``api.server`` is reached via a normal package import.
"""

from api.server import main

if __name__ == "__main__":
    main()
