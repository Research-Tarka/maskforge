"""Configurable, multithreaded scene discovery.

Generalizes the reference tool's hardcoded ``<glacier_id>/<year>/<entityid>``
folder convention (``Utils/create_data_core.py``, ``Utils/scene_scanner.py``)
into a declarative ``ScanRule``/``DiscoveryConfig`` system: configurable glob
patterns for raw/shadow/mask, scan depth, and file extensions, with a
recursive multithreaded scan (``ThreadPoolExecutor`` over ``os.scandir``,
I/O bound — mirrors the reference's ``os.walk`` scan but parallelized across
subdirectories).
"""

from __future__ import annotations

import fnmatch
import math
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from .plugins.zarr_reader import is_rgb_composite_name, make_composite_path

SceneMode = Literal["annotate", "review"]
QaStatus = Literal["todo", "in_progress", "validated", "flagged"]


@dataclass
class ScanRule:
    name: str
    #: Filenames matching any of these are recognized as an RGB source image
    #: for a plain-file scene -- replaces the old separate raw_patterns/
    #: shadow_patterns fields in the UI (a scene has one RGB source file,
    #: not a raw/shadow pair, in current usage). Internally still populates
    #: SceneEntry.raw_path (the first RGB source file found), so downstream
    #: code (composite fallback, SaveConfig.copy_raw, etc.) is unaffected.
    rgb_patterns: list[str] = field(default_factory=lambda: ["*rgb*", "*RGB*"])
    mask_patterns: list[str] = field(default_factory=lambda: ["*mask*", "*Mask*"])
    #: Filenames matching any of these (in a plain-file scan directory) are
    #: recognized as an inference class-map raster produced by an external
    #: ML pipeline -- see maskforge_core.plugins.inference_reader, which
    #: reads the matched file's actual content (.npz or GeoTIFF).
    inference_patterns: list[str] = field(default_factory=lambda: ["*class_map*", "*inference*"])
    max_depth: int = 5
    file_extensions: list[str] = field(default_factory=lambda: [".tif", ".tiff", ".png", ".jpg", ".jpeg"])

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "rgb_patterns": self.rgb_patterns,
            "mask_patterns": self.mask_patterns,
            "inference_patterns": self.inference_patterns,
            "max_depth": self.max_depth,
            "file_extensions": self.file_extensions,
        }

    @staticmethod
    def from_dict(d: dict) -> "ScanRule":
        # Back-compat: an older persisted session may still have
        # raw_patterns/shadow_patterns instead of rgb_patterns -- fold both
        # into rgb_patterns rather than silently losing a user's existing
        # customization on first load after the upgrade.
        rgb_patterns = d.get("rgb_patterns")
        if rgb_patterns is None:
            rgb_patterns = list(d.get("raw_patterns", [])) + list(d.get("shadow_patterns", []))
        return ScanRule(
            name=d["name"],
            rgb_patterns=list(rgb_patterns),
            mask_patterns=list(d.get("mask_patterns", [])),
            inference_patterns=list(d.get("inference_patterns", ["*class_map*", "*inference*"])),
            max_depth=d.get("max_depth", 5),
            file_extensions=list(d.get("file_extensions", [])),
        )

    def accepts_zarr_stores(self) -> bool:
        """Whether ``.zarr`` stores should be discovered as scene sources.

        A ``.zarr`` store is a *directory* (of internal group/chunk
        subdirectories), not a single file, so it can never satisfy a
        suffix check against a file listed by ``os.scandir`` the way
        ``.tif``/``.png`` do -- it needs this explicit opt-in instead of
        just adding ``".zarr"`` to ``file_extensions``.
        """
        return ".zarr" in [ext.lower() for ext in self.file_extensions]


@dataclass
class DiscoveryConfig:
    source_root: str
    scan_rule: ScanRule
    exclude_globs: list[str] = field(default_factory=list)
    #: Root directory of an external ML pipeline's inference output, if the
    #: user has one configured (e.g. the output_root a sliding-window
    #: inference script writes ``<tile_id>/<sensor>/<scene_id>/class_map.npz``
    #: under). Only meaningful for zarr-store scenes, whose inference output
    #: is never inside the zarr store itself (a separate pipeline run
    #: produces it) -- a plain-file scan finds its inference raster directly
    #: alongside the scene via ScanRule.inference_patterns instead. None (the
    #: default) means "no inference available" for every zarr scene.
    inference_root: str | None = None

    def to_dict(self) -> dict:
        return {
            "source_root": self.source_root,
            "scan_rule": self.scan_rule.to_dict(),
            "exclude_globs": self.exclude_globs,
            "inference_root": self.inference_root,
        }

    @staticmethod
    def from_dict(d: dict) -> "DiscoveryConfig":
        return DiscoveryConfig(
            source_root=d["source_root"],
            scan_rule=ScanRule.from_dict(d["scan_rule"]),
            exclude_globs=list(d.get("exclude_globs", [])),
            inference_root=d.get("inference_root"),
        )


@dataclass
class SceneEntry:
    id: str
    raw_path: str | None
    shadow_path: str | None
    mask_path: str | None
    detected_resolution: tuple[float, float] | None
    detected_crs: str | None
    mode: SceneMode
    qa_status: QaStatus = "todo"
    #: Path to an inference class-map raster produced by an external ML
    #: pipeline, if one was found alongside this scene (``.npz`` or GeoTIFF
    #: matching ``ScanRule.inference_patterns`` -- see
    #: ``plugins.inference_reader``). ``None`` means no inference is
    #: available for this scene; the frontend's "Copy inference to mask"
    #: action stays disabled in that case.
    inference_path: str | None = None
    #: Every RGB composite view this scene has, ``{view_name: composite_path}``
    #: (e.g. ``rgb_true_color``, ``rgb_natural_color``, ``rgb_color_infrared``,
    #: or any other ``rgb*`` array a store happens to have -- see
    #: ``plugins.zarr_reader.is_rgb_composite_name``). Only ever populated by
    #: a zarr-store scan (``_scan_zarr_store``); a plain-file scan rule only
    #: ever finds a single raw + a single shadow file, so it populates
    #: ``raw_path``/``shadow_path`` directly and leaves this dict empty.
    #: ``raw_path``/``shadow_path`` are kept as convenience aliases for the
    #: two most common views (``rgb_true_color``/``rgb_true_color_shadow``)
    #: so existing callers that only care about those two keep working.
    rgb_composites: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "raw_path": self.raw_path,
            "shadow_path": self.shadow_path,
            "mask_path": self.mask_path,
            "detected_resolution": list(self.detected_resolution) if self.detected_resolution else None,
            "detected_crs": self.detected_crs,
            "mode": self.mode,
            "qa_status": self.qa_status,
            "rgb_composites": self.rgb_composites,
            "inference_path": self.inference_path,
        }


def _matches_any(name: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(name, pat) for pat in patterns)


def _is_excluded(path: Path, exclude_globs: list[str]) -> bool:
    return any(fnmatch.fnmatch(str(path), pat) or fnmatch.fnmatch(path.name, pat) for pat in exclude_globs)


def _scan_directory(dir_path: Path, rule: ScanRule, exclude_globs: list[str]) -> SceneEntry | None:
    """Inspect a single directory (non-recursive) for RGB/mask files matching
    the scan rule. Returns a SceneEntry if an RGB or mask file is found, else
    None."""
    if _is_excluded(dir_path, exclude_globs):
        return None

    raw_path: str | None = None
    mask_path: str | None = None
    inference_path: str | None = None

    try:
        with os.scandir(dir_path) as it:
            entries = [e for e in it if e.is_file()]
    except OSError:
        return None

    # Inference rasters are matched by name regardless of file_extensions --
    # they're typically .npz (not a "normal" scene image format the rest of
    # ScanRule is tuned for) or a GeoTIFF, and matching purely by name marker
    # here (rather than requiring the user to add .npz to file_extensions,
    # which would also make discovery try to treat .npz files as RGB/mask
    # candidates) keeps inference detection independent of that setting.
    from .plugins.inference_reader import is_inference_path

    for entry in entries:
        p = Path(entry.path)
        if _is_excluded(p, exclude_globs):
            continue
        if inference_path is None and is_inference_path(p) and _matches_any(entry.name, rule.inference_patterns):
            inference_path = str(p)

        if p.suffix.lower() not in [ext.lower() for ext in rule.file_extensions]:
            continue
        name = entry.name
        if mask_path is None and _matches_any(name, rule.mask_patterns):
            mask_path = str(p)
        elif raw_path is None and _matches_any(name, rule.rgb_patterns):
            raw_path = str(p)

    if raw_path is None and mask_path is None:
        return None

    mode: SceneMode = "review" if mask_path is not None else "annotate"

    detected_resolution: tuple[float, float] | None = None
    detected_crs: str | None = None
    probe_path = raw_path or mask_path
    if probe_path and Path(probe_path).suffix.lower() in (".tif", ".tiff"):
        try:
            import rasterio

            with rasterio.open(probe_path) as src:
                # Ground pixel size accounting for rotation/skew (not all
                # rasters are north-up: transform.b/d are non-zero e.g. for
                # polar-projection scenes), not just abs(a)/abs(e).
                t = src.transform
                detected_resolution = (
                    math.hypot(t.a, t.b),
                    math.hypot(t.d, t.e),
                )
                detected_crs = src.crs.to_string() if src.crs else None
        except Exception:
            pass

    return SceneEntry(
        id=dir_path.name,
        raw_path=raw_path,
        shadow_path=None,
        mask_path=mask_path,
        detected_resolution=detected_resolution,
        detected_crs=detected_crs,
        mode=mode,
        inference_path=inference_path,
    )


def _resolve_inference_path(inference_root: str | None, tile_id: str, sensor: str, scene_id: str) -> str | None:
    """Conventional path for one scene's externally-produced inference class
    map, mirroring the pipeline's own ``scene_output_paths()`` layout
    (``<output_root>/<tile_id>/<sensor>/<scene_id>/class_map.npz``). Returns
    ``None`` (no inference available) when ``inference_root`` is unset, or
    when neither the ``.npz`` nor a GeoTIFF fallback exists on disk."""
    if not inference_root:
        return None
    scene_dir = Path(inference_root) / tile_id / sensor / scene_id
    npz_path = scene_dir / "class_map.npz"
    if npz_path.is_file():
        return str(npz_path)
    tif_path = scene_dir / "class_map.tif"
    if tif_path.is_file():
        return str(tif_path)
    return None


def _scan_zarr_store(
    store_path: Path, rule: ScanRule, exclude_globs: list[str], inference_root: str | None = None
) -> list[SceneEntry]:
    """Enumerate every (sensor, scene) pair inside one ``.zarr`` store as its
    own :class:`SceneEntry`, addressed via the composite path scheme from
    ``maskforge_core.plugins.zarr_reader`` (one physical store holds many
    scenes across sensors, unlike a standalone GeoTIFF/PNG scene directory
    where one directory is exactly one scene).

    ``SceneEntry.id`` is ``"{store_stem}_{sensor}_{scene_id}"`` -- this is
    the only identity string that flows through mask saving
    (``SaveConfig.folder_structure_template.format(scene_id=...)``), so it
    must fully capture the (tile, sensor, scene) triple to keep annotated
    masks unambiguously associated with their source scene.
    """
    if _is_excluded(store_path, exclude_globs):
        return []
    try:
        import zarr
    except ImportError:
        return []

    try:
        store = zarr.open_group(str(store_path), mode="r")
    except Exception:  # noqa: BLE001 -- a partially written/corrupt store must not crash discovery
        return []

    store_stem = store_path.stem  # "<tile_id>.zarr" -> "<tile_id>"
    entries: list[SceneEntry] = []

    for sensor in sorted(store.group_keys()) if hasattr(store, "group_keys") else sorted(store.keys()):
        try:
            grp = store[sensor]
            scene_ids = list(grp.attrs.get("scene_ids", []))
            crs_wkt = grp.attrs.get("crs_wkt")
            transform = grp.attrs.get("transform")
        except Exception:  # noqa: BLE001 -- one malformed group must not drop the rest of the store
            continue

        detected_resolution: tuple[float, float] | None = None
        if transform and len(transform) >= 6:
            detected_resolution = (math.hypot(transform[0], transform[1]), math.hypot(transform[3], transform[4]))

        # Every RGB composite array this sensor group actually has -- a store
        # only ever has the views that were enabled at scene-storage time
        # (see landscape_change_detection_pipeline's
        # config.py::RgbCompositesConfig), and may include names beyond the
        # pipeline's current four (is_rgb_composite_name is a prefix check,
        # not a closed list), so a future added view is picked up here too.
        all_arrays = set(grp.array_keys()) if hasattr(grp, "array_keys") else set(grp.keys())
        available_composites = {name for name in all_arrays if is_rgb_composite_name(name)}

        for scene_id in scene_ids:
            entry_id = f"{store_stem}_{sensor}_{scene_id}"
            if _is_excluded(Path(entry_id), exclude_globs):
                continue

            rgb_composites = {
                view: make_composite_path(store_path, sensor, scene_id, view) for view in available_composites
            }

            entries.append(
                SceneEntry(
                    id=entry_id,
                    raw_path=rgb_composites.get("rgb_true_color"),
                    shadow_path=rgb_composites.get("rgb_true_color_shadow"),
                    mask_path=None,
                    detected_resolution=detected_resolution,
                    detected_crs=crs_wkt,
                    mode="annotate",
                    rgb_composites=rgb_composites,
                    inference_path=_resolve_inference_path(inference_root, store_stem, sensor, scene_id),
                )
            )

    return entries


def _iter_dirs(root: Path, max_depth: int, exclude_globs: list[str]):
    """Yield directories up to max_depth (root = depth 0), skipping excluded
    ones. A ``.zarr`` directory is yielded but never recursed into -- its
    contents are zarr's own internal group/chunk layout, not scene
    subdirectories, so walking into one would misidentify chunk directories
    as scenes."""
    root = Path(root)
    yield root

    def _walk(current: Path, depth: int):
        if depth >= max_depth:
            return
        try:
            with os.scandir(current) as it:
                subdirs = [Path(e.path) for e in it if e.is_dir()]
        except OSError:
            return
        for sub in subdirs:
            if _is_excluded(sub, exclude_globs):
                continue
            yield sub
            if sub.suffix.lower() == ".zarr":
                continue
            yield from _walk(sub, depth + 1)

    yield from _walk(root, 0)


def _scan_item(
    dir_path: Path, rule: ScanRule, exclude_globs: list[str], inference_root: str | None = None
) -> list[SceneEntry]:
    """Dispatch one directory yielded by ``_iter_dirs`` to the right scanner:
    a ``.zarr`` store (when the rule opts in via ``accepts_zarr_stores``)
    expands to zero or more scenes; any other directory is a single-scene
    raw/shadow/mask directory as before."""
    if dir_path.suffix.lower() == ".zarr":
        if not rule.accepts_zarr_stores():
            return []
        return _scan_zarr_store(dir_path, rule, exclude_globs, inference_root)
    entry = _scan_directory(dir_path, rule, exclude_globs)
    return [entry] if entry is not None else []


def discover_scenes(config: DiscoveryConfig, max_workers: int = 8, progress_cb=None) -> list[SceneEntry]:
    """Recursively scan ``config.source_root`` for scene directories matching
    ``config.scan_rule``, using a thread pool (I/O bound directory listing)
    for concurrency across subdirectories.

    ``progress_cb(done, total)`` is called after each directory is processed,
    if provided. A single ``.zarr`` store directory can expand into many
    scenes (one per sensor group x scene index), unlike every other
    directory kind which contributes at most one.
    """
    root = Path(config.source_root)
    if not root.exists():
        return []

    dirs = list(_iter_dirs(root, config.scan_rule.max_depth, config.exclude_globs))
    total = len(dirs)
    results: list[SceneEntry] = []
    done = 0

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(_scan_item, d, config.scan_rule, config.exclude_globs, config.inference_root): d
            for d in dirs
        }
        for future in futures:
            entries = future.result()
            done += 1
            if progress_cb is not None:
                progress_cb(done, total)
            results.extend(entries)

    results.sort(key=lambda e: e.id)
    return results
