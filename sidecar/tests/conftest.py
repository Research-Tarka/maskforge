from __future__ import annotations

import sys
from pathlib import Path

# Make `maskforge_core` and `api` importable when running pytest from the
# `sidecar/` directory without an editable install.
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))
