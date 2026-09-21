# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onefile spec for the MaskForge sidecar.

Best-effort: this bundles the FastAPI/uvicorn server plus rasterio/GDAL,
numpy, shapely, PIL, pandas, scipy, scikit-image into a single executable
that Tauri spawns as an "external binary". Not run/tested as part of this
task (per task instructions) — kept correct and ready to invoke via:

    pyinstaller build_sidecar.spec

Rasterio/GDAL bundling is notoriously finicky on Windows: GDAL's data files
(gdal_data, proj_data) and DLLs must be collected explicitly, since
PyInstaller's static analysis cannot see them (they're loaded by GDAL's C
runtime, not Python imports).
"""

from __future__ import annotations

import os
import sys

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
)

block_cipher = None

# ---------------------------------------------------------------------------
# Hidden imports: modules only reachable dynamically (FastAPI/uvicorn/
# rasterio plugin-style loading, pydantic validators, etc.)
# ---------------------------------------------------------------------------

hiddenimports = []
hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("rasterio")
hiddenimports += collect_submodules("fiona")  # optional, harmless if unused
hiddenimports += collect_submodules("pydantic")
hiddenimports += collect_submodules("scipy")
hiddenimports += collect_submodules("skimage")
hiddenimports += [
    "maskforge_core",
    "maskforge_core.raster_io",
    "maskforge_core.tools",
    "maskforge_core.class_config",
    "maskforge_core.scene_discovery",
    "maskforge_core.session",
    "maskforge_core.contours",
    "maskforge_core.qa_workflow",
    "maskforge_core.shadow_gen",
    "maskforge_core.plugins",
    "api",
    "api.server",
    "api.schemas",
    "api.state",
    "api.routers.scenes",
    "api.routers.masks",
    "api.routers.classes",
    "api.routers.sessions",
    "api.routers.tools",
    "api.routers.qa",
]

# ---------------------------------------------------------------------------
# Data files: rasterio/GDAL/PROJ data directories, required at runtime for
# CRS transforms and raster driver registration.
# ---------------------------------------------------------------------------

datas = []
datas += collect_data_files("rasterio")
datas += collect_data_files("pyproj", include_py_files=False)

# Binary DLLs: GDAL's own shared libraries + rasterio's compiled extensions'
# transitive DLL dependencies (PROJ, GEOS, libtiff, etc. via the rasterio
# wheel's bundled `rasterio.libs` / `rasterio/gdal_data`).
binaries = []
binaries += collect_dynamic_libs("rasterio")

# GDAL_DATA / PROJ_DATA env vars must be set at runtime relative to the
# onefile extraction dir (sys._MEIPASS); see api/server.py's `main()` or a
# dedicated bootstrap wrapper for the runtime-side of this — this spec only
# ensures the data files are physically bundled.
gdal_data_dir = os.path.join(os.path.dirname(sys.modules["rasterio"].__file__), "gdal_data") if "rasterio" in sys.modules else None

a = Analysis(
    ["bootstrap.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "torch", "tensorflow"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="maskforge-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
