"""Zarr ``RasterReader`` plugin for per-tile scene stores.

Reads a per-tile scene store convention (one zarr group per sensor, each a
``(n_scenes, C, H, W)`` uint16/uint8 array plus ``crs_wkt``/``transform``/
``band_names``/``scene_ids`` attrs). A ``.zarr`` store is a *directory*, and
one store holds many scenes
across sensors, so it cannot be addressed by a bare file path the way a
GeoTIFF can -- ``can_read``/``read`` accept a composite path string of the
form::

    <store>.zarr!<sensor>/<scene_index_or_id>/<composite>

``composite`` selects what to display for that scene:

- Any pre-computed 3-band uint8 composite array name stored directly in the
  sensor group -- typically one of ``rgb_true_color`` / ``rgb_true_color_shadow``
  / ``rgb_natural_color`` / ``rgb_color_infrared`` (the pipeline's current
  names, see ``landscape_change_detection_pipeline/scenes/composites.py``),
  but any array name starting with ``rgb`` (case-insensitive) is recognized,
  and any other array name a store happens to have can still be read
  directly. Not every store has every composite -- see
  :func:`list_composites_for_sensor`.
- ``toa:<band1>,<band2>,<band3>`` -- an arbitrary band combination pulled out
  of the group's ``toa`` array, using the names in its ``band_names`` attr
  (order given is the output channel order, so e.g. ``toa:B4,B3,B2`` makes a
  false/true-color composite from Landsat bands regardless of their storage
  order).

``<scene_index_or_id>`` is either an integer index into the sensor group's
scene axis, or a literal scene id string (matched against the group's
``scene_ids`` attr) -- accepting both lets a composite path be built directly
from a ``scene_id`` without a separate index lookup.

The ``!`` separator is used (not ``:`` or the OS path separator) because it
cannot appear in a Windows drive-letter path or a normal filename, so
splitting on it unambiguously separates the real filesystem path (the part
``Path.exists()`` and directory listings need to work on) from the
in-store address.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np

_SEP = "!"

# Cache of opened zarr groups, keyed by store path -- re-running
# zarr.open_group() re-parses every group's .zattrs/.zarray metadata from
# disk on every call, which is wasted work when a scene's 1-4 RGB composite
# views are all read moments apart (once per GET /scenes/{id}/layers call,
# itself hit on every brush stamp mid-drag). A short TTL (rather than an
# unbounded cache) lets an external change to the store surface within a
# few seconds instead of requiring a sidecar restart.
_GROUP_CACHE_TTL_S = 5.0
_group_cache: dict[str, tuple[float, Any]] = {}


def _open_group_cached(store_path: Path):
    import zarr

    key = str(store_path)
    now = time.monotonic()
    cached = _group_cache.get(key)
    if cached is not None and (now - cached[0]) < _GROUP_CACHE_TTL_S:
        return cached[1]
    group = zarr.open_group(key, mode="r")
    _group_cache[key] = (now, group)
    return group


class ZarrAddressError(ValueError):
    """Raised when a composite zarr path string is malformed."""


def is_zarr_composite_path(path: str | Path) -> bool:
    """Whether ``path`` looks like ``<store>.zarr!<sensor>/<scene>/<composite>``."""
    text = str(path)
    if _SEP not in text:
        return False
    store_part = text.split(_SEP, 1)[0]
    return store_part.lower().endswith(".zarr")


def store_path_for(path: str | Path) -> Path:
    """The real filesystem path of the zarr store backing a composite path.

    Works for both a composite path (splits at ``!``) and a bare store path
    (returned as-is), so callers can pass either through ``Path.exists()``
    without special-casing zarr first.
    """
    text = str(path)
    if _SEP in text:
        text = text.split(_SEP, 1)[0]
    return Path(text)


def make_composite_path(store_path: str | Path, sensor: str, scene_ref: str | int, composite: str) -> str:
    """Build a composite path string addressing one sensor/scene/view triple."""
    return f"{Path(store_path)}{_SEP}{sensor}/{scene_ref}/{composite}"


def parse_composite_path(path: str | Path) -> tuple[Path, str, str, str]:
    """Split a composite path into ``(store_path, sensor, scene_ref, composite)``.

    The in-store portion (everything after ``!``) is always built and split
    on ``/`` (see ``make_composite_path``), but round-tripping the composite
    string through a ``Path`` -- as every call site here does, since
    ``RasterReader.read`` receives a ``Path`` -- normalizes those to ``\\``
    on Windows. Splitting on both keeps parsing independent of platform.
    """
    text = str(path)
    if _SEP not in text:
        raise ZarrAddressError(f"Not a zarr composite path (missing '{_SEP}'): {text!r}")
    store_text, rest = text.split(_SEP, 1)
    parts = rest.replace("\\", "/").split("/", 2)
    if len(parts) != 3:
        raise ZarrAddressError(
            f"Malformed zarr composite path {text!r}: expected "
            f"'<store>.zarr{_SEP}<sensor>/<scene>/<composite>'"
        )
    sensor, scene_ref, composite = parts
    if not sensor or not scene_ref or not composite:
        raise ZarrAddressError(f"Malformed zarr composite path {text!r}: empty component")
    return Path(store_text), sensor, scene_ref, composite


def _resolve_scene_index(scene_ref: str, scene_ids: list[str]) -> int:
    try:
        return int(scene_ref)
    except ValueError:
        pass
    try:
        return scene_ids.index(scene_ref)
    except ValueError:
        raise ZarrAddressError(
            f"Scene {scene_ref!r} is neither a valid index nor a known scene_id "
            f"(known: {scene_ids!r})"
        ) from None


#: Preferred display order for the composite names the pipeline currently
#: produces (see ``landscape_change_detection_pipeline/scenes/composites.py``'s
#: ``VIEW_BAND_LABELS`` keys). This is no longer the full set of recognized
#: names -- :func:`is_rgb_composite_name`/:func:`list_composites_for_sensor`
#: accept *any* ``rgb*`` array name a store happens to have, so a future
#: composite the pipeline adds shows up automatically without an edit here.
#: This tuple only controls the order familiar composites are listed in.
KNOWN_RGB_COMPOSITES: tuple[str, ...] = (
    "rgb_true_color",
    "rgb_true_color_shadow",
    "rgb_natural_color",
    "rgb_color_infrared",
)

_KNOWN_ORDER = {name: i for i, name in enumerate(KNOWN_RGB_COMPOSITES)}


def is_rgb_composite_name(name: str) -> bool:
    """Whether an array name looks like an RGB composite view.

    Deliberately a simple case-insensitive ``rgb*`` prefix check rather than
    a closed list -- the storage pipeline may add new composite views (e.g.
    a future ``rgb_swir_composite``) without this reader needing an update
    to recognize them.
    """
    return name.lower().startswith("rgb")


def list_composites_for_sensor(band_names: list[str], available: set[str] | None = None) -> list[str]:
    """The composite choices actually available for one sensor group, plus a
    natural-color band combo fallback if ``band_names`` is given.

    ``available`` (typically a zarr group's own array names) is filtered down
    to whatever looks like an RGB composite (:func:`is_rgb_composite_name`);
    when omitted, only the well-known names are offered (there being no store
    to inspect for extra ones). Known names sort first in their preferred
    order (see :data:`KNOWN_RGB_COMPOSITES`), any other ``rgb*`` name found in
    ``available`` is appended alphabetically after them. Convenience for
    callers building a UI selector; the reader itself accepts any array name
    present in the group, or any ``toa:<band>,<band>,...`` combination whose
    bands exist in ``band_names``, not only the ones this returns.
    """
    if available is None:
        composites = list(KNOWN_RGB_COMPOSITES)
    else:
        found = [name for name in available if is_rgb_composite_name(name)]
        composites = sorted(found, key=lambda n: (_KNOWN_ORDER.get(n, len(_KNOWN_ORDER)), n))
    if band_names:
        composites.append("toa:" + ",".join(band_names[: min(3, len(band_names))]))
    return composites


class ZarrRasterReader:
    """Reads scenes out of a per-tile zarr store."""

    def can_read(self, path: Path) -> bool:
        return is_zarr_composite_path(path)

    def read(self, path: Path) -> tuple[np.ndarray, dict[str, Any]]:
        store_path, sensor, scene_ref, composite = parse_composite_path(path)
        if not store_path.exists():
            raise FileNotFoundError(f"Zarr store not found: {store_path}")

        store = _open_group_cached(store_path)
        if sensor not in store:
            raise KeyError(f"No '{sensor}' group in {store_path}")
        grp = store[sensor]

        attrs = dict(grp.attrs)
        scene_ids = list(attrs.get("scene_ids", []))
        idx = _resolve_scene_index(scene_ref, scene_ids)

        if composite.startswith("toa:"):
            band_names = list(attrs.get("band_names", []))
            requested = [b for b in composite[len("toa:") :].split(",") if b]
            if not requested:
                raise ZarrAddressError(f"Empty band list in composite {composite!r}")
            missing = [b for b in requested if b not in band_names]
            if missing:
                raise KeyError(f"Band(s) {missing!r} not in this sensor group's band_names {band_names!r}")
            band_idx = [band_names.index(b) for b in requested]
            toa = grp["toa"][idx]  # (C, H, W) uint16
            arr = np.asarray(toa)[band_idx, ...]
        elif composite in grp:
            arr = np.asarray(grp[composite][idx])  # (3, H, W)
        else:
            raise ZarrAddressError(
                f"Unknown composite {composite!r}: not an array in this sensor group "
                f"(available: {sorted(set(grp.array_keys()) if hasattr(grp, 'array_keys') else set(grp.keys()))}) "
                "and not a 'toa:<bands>' combination."
            )

        arr = np.moveaxis(arr, 0, -1)  # (H, W, C)
        if arr.shape[-1] == 1:
            arr = arr[..., 0]

        transform = attrs.get("transform")
        meta = {
            "crs": attrs.get("crs_wkt"),
            "transform": tuple(transform) if transform else None,
            "width": arr.shape[1],
            "height": arr.shape[0],
            "sensor": sensor,
            "scene_id": scene_ids[idx] if idx < len(scene_ids) else scene_ref,
            "scene_index": idx,
        }
        return arr, meta


_READER = ZarrRasterReader()


def register() -> None:
    """Register the zarr reader with the plugin registry (idempotent)."""
    from maskforge_core.plugins import register_reader

    register_reader("zarr", _READER)
