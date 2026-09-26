"""``RasterReader`` plugin for inference class-map rasters produced by an
external ML pipeline (e.g. a sliding-window inference script writing one
class map per scene).

Two on-disk formats are recognized:

- ``.npz`` written by that pipeline's own ``write_class_map()``: a
  ``class_map`` uint8 array plus ``transform`` (6 floats), ``crs_wkt``
  (string), and ``nodata`` (uint8) — see e.g.
  ``landscape_change_detection_pipeline.inference.engine.write_class_map``.
- A plain single-band GeoTIFF class raster (``.tif``/``.tiff``), for a
  pipeline that exports its inference output as a raster instead.

Either way, the array read back is class indices (uint8), not an RGB image
— callers rendering it for display must colorize it through the active
class palette (see ``_layer_from_path`` in ``api/routers/scenes.py``),
unlike a zarr RGB composite which is already display-ready.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

_NPZ_SUFFIXES = (".npz",)
_GEOTIFF_SUFFIXES = (".tif", ".tiff")

#: Filename must contain one of these (case-insensitive) to be recognized as
#: an inference class-map raster -- matches scene_discovery.ScanRule's
#: default inference_patterns ("*class_map*", "*inference*"). A bare suffix
#: check would be far too broad: .npz/.tif/.tiff are also used by ordinary
#: raw/mask/RGB-composite scene files, and this reader is tried by
#: find_reader() before raster_io.read_image_any's own GeoTIFF/plugin
#: fallback for *every* read_image_any call in the app -- an unqualified
#: match here would hijack every GeoTIFF read, not just inference ones.
_NAME_MARKERS = ("class_map", "inference")


def is_inference_path(path: str | Path) -> bool:
    """Whether ``path`` looks like an inference class-map file this reader
    handles: a recognized suffix AND a recognized filename marker -- see
    the ``_NAME_MARKERS`` note above for why the suffix alone isn't enough."""
    p = Path(path)
    suffix = p.suffix.lower()
    if suffix not in _NPZ_SUFFIXES and suffix not in _GEOTIFF_SUFFIXES:
        return False
    name = p.name.lower()
    return any(marker in name for marker in _NAME_MARKERS)


class InferenceRasterReader:
    """Reads an inference class-map raster (``.npz`` or GeoTIFF)."""

    def can_read(self, path: Path) -> bool:
        return is_inference_path(path)

    def read(self, path: Path) -> tuple[np.ndarray, dict[str, Any]]:
        suffix = path.suffix.lower()
        if suffix in _NPZ_SUFFIXES:
            return self._read_npz(path)
        return self._read_geotiff(path)

    @staticmethod
    def _read_npz(path: Path) -> tuple[np.ndarray, dict[str, Any]]:
        with np.load(path, allow_pickle=False) as data:
            class_map = np.asarray(data["class_map"]).astype(np.uint8)
            transform = tuple(float(v) for v in data["transform"]) if "transform" in data else None
            crs_wkt = str(data["crs_wkt"]) if "crs_wkt" in data else None
            nodata = int(data["nodata"]) if "nodata" in data else 255

        meta = {
            "crs": crs_wkt,
            "transform": transform,
            "width": class_map.shape[1],
            "height": class_map.shape[0],
            "nodata": nodata,
        }
        return class_map, meta

    @staticmethod
    def _read_geotiff(path: Path) -> tuple[np.ndarray, dict[str, Any]]:
        import rasterio

        with rasterio.open(path) as src:
            class_map = src.read(1).astype(np.uint8)
            nodata = int(src.nodata) if src.nodata is not None else 255
            meta = {
                "crs": src.crs.to_string() if src.crs else None,
                "transform": tuple(src.transform)[:6] if src.transform else None,
                "width": src.width,
                "height": src.height,
                "nodata": nodata,
            }
        return class_map, meta


_READER = InferenceRasterReader()


def register() -> None:
    """Register the inference reader with the plugin registry (idempotent)."""
    from maskforge_core.plugins import register_reader

    register_reader("inference", _READER)
