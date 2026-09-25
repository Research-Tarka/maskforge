from __future__ import annotations

import base64

import numpy as np
from fastapi import APIRouter, HTTPException

from maskforge_core import raster_io
from maskforge_core.scene_discovery import DiscoveryConfig as CoreDiscoveryConfig
from maskforge_core.scene_discovery import ScanRule as CoreScanRule
from maskforge_core.scene_discovery import SceneEntry as CoreSceneEntry
from maskforge_core.scene_discovery import discover_scenes

from ..schemas import DiscoveryConfig, LayerData, LayersResponse, SceneEntry
from ..state import MaskBuffer, get_state
from .masks import _ensure_buffer

router = APIRouter(prefix="/scenes", tags=["scenes"])


def _to_core_discovery(cfg: DiscoveryConfig) -> CoreDiscoveryConfig:
    return CoreDiscoveryConfig(
        source_root=cfg.source_root,
        scan_rule=CoreScanRule(
            name=cfg.scan_rule.name,
            raw_patterns=cfg.scan_rule.raw_patterns,
            shadow_patterns=cfg.scan_rule.shadow_patterns,
            mask_patterns=cfg.scan_rule.mask_patterns,
            max_depth=cfg.scan_rule.max_depth,
            file_extensions=cfg.scan_rule.file_extensions,
        ),
        exclude_globs=cfg.exclude_globs,
    )


def _to_schema_entry(e: CoreSceneEntry) -> SceneEntry:
    return SceneEntry(
        id=e.id,
        raw_path=e.raw_path,
        shadow_path=e.shadow_path,
        mask_path=e.mask_path,
        detected_resolution=e.detected_resolution,
        detected_crs=e.detected_crs,
        mode=e.mode,
        qa_status=e.qa_status,
        rgb_composites=e.rgb_composites,
    )


@router.get("", response_model=list[SceneEntry])
def list_scenes(session_id: str = "") -> list[SceneEntry]:
    """Runs discovery from the session's stored DiscoveryConfig if not yet
    cached for this session_id, otherwise returns the cached result."""
    state = get_state()
    cached = state.get_scenes(session_id) if session_id else []
    if cached:
        return [_to_schema_entry(e) for e in cached]

    if session_id:
        session = state.session_store.get(session_id)
        if session is not None and session.discovery:
            try:
                core_cfg = CoreDiscoveryConfig.from_dict(session.discovery)
            except (KeyError, TypeError):
                return []
            entries = discover_scenes(core_cfg)
            state.set_scenes(session_id, entries)
            return [_to_schema_entry(e) for e in entries]

    return []


@router.post("/discover", response_model=list[SceneEntry])
def discover(cfg: DiscoveryConfig, session_id: str = "") -> list[SceneEntry]:
    core_cfg = _to_core_discovery(cfg)
    entries = discover_scenes(core_cfg)
    if session_id:
        get_state().set_scenes(session_id, entries)
    else:
        for e in entries:
            get_state().register_scene(e)
    return [_to_schema_entry(e) for e in entries]


def _layer_from_path(path_str: str | None) -> LayerData | None:
    if not path_str:
        return None
    if not raster_io.image_path_exists(path_str):
        return None

    arr, meta = raster_io.read_image_any(path_str)
    png_b64 = raster_io.array_to_png_base64(arr)
    transform = meta.get("transform")
    return LayerData(
        width=meta["width"],
        height=meta["height"],
        crs=meta.get("crs"),
        transform=tuple(transform) if transform else None,
        png_base64=png_b64,
    )


def _cached_layer_from_path(path_str: str | None, cache: tuple[str, LayerData] | None) -> tuple[LayerData | None, tuple[str, LayerData] | None]:
    """Like _layer_from_path, but reuses `cache` when it was built from the
    same path -- RGB composite imagery never changes while a scene is being
    annotated (only the mask does), yet GET /layers is called on every
    single brush stamp mid-drag. Re-reading and re-PNG-encoding a
    zarr-backed scene (e.g. Sentinel-2, whose chunks are bigger to
    decompress than a plain GeoTIFF) on every one of those calls is what
    made painting laggy. Returns (layer, new_cache_to_store)."""
    if not path_str:
        return None, None
    if cache is not None and cache[0] == path_str:
        return cache[1], cache
    layer = _layer_from_path(path_str)
    if layer is None:
        return None, None
    return layer, (path_str, layer)


def _layer_from_mask_buffer(buf: MaskBuffer) -> LayerData:
    """Render the in-memory mask buffer as a live-editing layer -- used both
    for a scene with no mask.tif on disk yet (buffer freshly created by
    _ensure_buffer, entirely NODATA_VALUE) and for a scene already painted
    on but not yet saved to disk, so strokes are visible immediately
    without round-tripping through a save.

    Unlike classes_to_rgba (used for the *saved* GeoTIFF, where an
    unpainted pixel should mean "no pixel", alpha=0), unpainted pixels here
    render as opaque white: the user needs a visible, paintable canvas, not
    a transparent one that looks like an empty panel.
    """
    h, w = buf.classes.shape[:2]
    palette = get_state().get_active_palette()
    class_colors = palette.color_map() if palette is not None else {}
    class_values = palette.value_map() if palette is not None else {}

    rgb = raster_io.classes_to_rgb(buf.classes, class_colors, class_values)  # (3, H, W)
    rgba = np.full((h, w, 4), 255, dtype=np.uint8)
    rgba[..., :3] = np.moveaxis(rgb, 0, -1)
    unpainted = buf.classes == raster_io.NODATA_VALUE
    rgba[unpainted, :3] = 255  # white, not whatever value 0 (black) would render as

    png_b64 = raster_io.array_to_png_base64(rgba)
    transform = tuple(buf.transform)[:6] if buf.transform is not None else None
    crs = str(buf.crs) if buf.crs is not None else None
    return LayerData(width=w, height=h, crs=crs, transform=transform, png_base64=png_b64)


@router.get("/{scene_id}/layers", response_model=LayersResponse)
def get_layers(scene_id: str, views: str = "") -> LayersResponse:
    """``views`` is an optional comma-separated list of RGB composite view
    names (e.g. ``"rgb_true_color,rgb_natural_color"``) to decode -- when
    omitted, every view the scene has is decoded (the old behaviour). Only
    decoding what's actually visible in a canvas slot (see the frontend's
    layout panel) avoids paying for up to 4 composite decodes on every call
    when only 1-2 are ever shown on screen -- this endpoint is hit on every
    brush stamp mid-drag, not just once per scene open, so the saving is
    per-stroke, not just per scene load.
    """
    state = get_state()
    scene = state.get_scene(scene_id)
    if scene is None:
        raise HTTPException(status_code=404, detail=f"Scene not found: {scene_id}")

    # Populate the in-memory mask buffer as soon as a scene is opened (not
    # only on the first paint stroke), so a scene can be re-saved — e.g. at
    # a different pixel resolution for a training copy — without requiring
    # the user to touch a single pixel first.
    buf = _ensure_buffer(scene_id)

    # A scene with no mask.tif on disk yet (never annotated) still has that
    # freshly-created buffer -- render it instead of returning None, so the
    # mask panel shows a paintable blank canvas immediately rather than
    # "No mask yet" until the first stroke happens to succeed.
    mask_layer = _layer_from_path(scene.mask_path) or _layer_from_mask_buffer(buf)

    # A scene discovered outside the zarr path (plain raw/shadow files) has
    # no rgb_composites entries -- fall back to its raw_path/shadow_path
    # under their conventional view names so it still renders 1-2 panels.
    all_composites = dict(scene.rgb_composites)
    if not all_composites:
        if scene.raw_path:
            all_composites["rgb_true_color"] = scene.raw_path
        if scene.shadow_path:
            all_composites["rgb_true_color_shadow"] = scene.shadow_path

    requested = {v for v in views.split(",") if v} or set(all_composites)

    # Each view is cached on the buffer (see MaskBuffer.rgb_layer_cache) --
    # composite imagery never changes while this scene is open, only the
    # mask does, so this skips a full re-read + re-encode on every single
    # call for a view that was already decoded once.
    rgb_layers: dict[str, LayerData] = {}
    for view, path_str in all_composites.items():
        if view not in requested:
            continue
        layer, buf.rgb_layer_cache[view] = _cached_layer_from_path(path_str, buf.rgb_layer_cache.get(view))
        if layer is not None:
            rgb_layers[view] = layer

    return LayersResponse(
        rgb=rgb_layers,
        mask=mask_layer,
    )
