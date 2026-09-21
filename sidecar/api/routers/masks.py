from __future__ import annotations

import math
import shutil
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException
from scipy import ndimage as ndi

from maskforge_core import raster_io
from maskforge_core.auto_segment import auto_segment
from maskforge_core.contours import bbox_from_change_mask
from maskforge_core.tools import get_tool

from ..schemas import (
    ApplyAutoSegmentComponentRequest,
    ApplyAutoSegmentRequest,
    AutoSegmentClusterInfo,
    AutoSegmentRequest,
    AutoSegmentResponse,
    DeletedResponse,
    RemapRequest,
    RemapResponse,
    SaveConfig,
    SaveResponse,
    ToolRequest,
    ToolResponse,
    UndoRedoResponse,
)
from ..state import MaskBuffer, get_state

router = APIRouter(prefix="/masks", tags=["masks"])


def _ensure_buffer(scene_id: str) -> MaskBuffer:
    state = get_state()
    buf = state.get_mask_buffer(scene_id)
    if buf is not None:
        return buf

    scene = state.get_scene(scene_id)
    transform = None
    crs = None

    mask_path_str = scene.mask_path if scene is not None else None
    if not mask_path_str:
        # Discovery only ever finds a mask sitting inside the scanned
        # source_root -- a mask previously saved to a separate output_root
        # (the normal case: raw imagery and exported masks usually live in
        # different trees) is invisible to it, so SceneEntry.mask_path stays
        # None even though the file is really on disk. Re-derive the same
        # path save_mask would have written to and check there too, or a
        # scene already annotated in a past session reopens with a blank
        # canvas instead of the mask that was actually saved for it.
        save_config = state.get_active_save_config()
        if save_config is not None and save_config.output_root:
            try:
                rel = save_config.folder_structure_template.format(scene_id=scene_id)
                candidate = _resolve_contained_path(Path(save_config.output_root), rel)
                if raster_io.image_path_exists(candidate):
                    mask_path_str = str(candidate)
            except HTTPException:
                pass

    if mask_path_str and raster_io.image_path_exists(mask_path_str):
        if scene is not None and scene.mask_path != mask_path_str:
            # Found via the output_root fallback above, not discovery -- keep
            # the cached SceneEntry in sync so /scenes and the QA/Discovery
            # panels also stop treating this scene as unannotated.
            scene.mask_path = mask_path_str
            scene.mode = "review"
            state.register_scene(scene)
        mask_path = Path(mask_path_str)
        if mask_path.suffix.lower() in (".tif", ".tiff") and raster_io.RASTERIO_AVAILABLE:
            import rasterio

            with rasterio.open(mask_path) as src:
                rgba = np.moveaxis(src.read(), 0, -1)
                transform = src.transform
                crs = src.crs
        else:
            rgba, _ = raster_io.read_image_any(mask_path)
        if rgba.ndim == 3 and rgba.shape[-1] == 4:
            classes = raster_io.rgba_to_classes(rgba, {}, {})
        elif rgba.ndim == 2:
            classes = rgba.astype(np.uint8)
        else:
            classes = np.full(rgba.shape[:2], raster_io.NODATA_VALUE, dtype=np.uint8)
    elif scene is not None and scene.raw_path and raster_io.image_path_exists(scene.raw_path):
        arr, meta = raster_io.read_image_any(scene.raw_path)
        classes = np.full(arr.shape[:2], raster_io.NODATA_VALUE, dtype=np.uint8)
        if meta.get("transform") and raster_io.RASTERIO_AVAILABLE:
            from rasterio.transform import Affine

            transform = Affine(*meta["transform"])
            crs = meta.get("crs")
    else:
        # No scene registered / no backing file yet: start with a small
        # blank buffer that grows on first real use via explicit shape.
        classes = np.full((256, 256), raster_io.NODATA_VALUE, dtype=np.uint8)

    buf = MaskBuffer(classes=classes, transform=transform, crs=crs)
    state.set_mask_buffer(scene_id, buf)
    return buf


@router.post("/{scene_id}/tool", response_model=ToolResponse)
def apply_tool(scene_id: str, req: ToolRequest) -> ToolResponse:
    buf = _ensure_buffer(scene_id)
    classes = buf.classes
    # A dragged brush stroke sends one /tool call per stamp (every
    # pointermove), so pushing a snapshot on every call made a single
    # gesture undo one tiny stamp at a time. continue_stroke (set by the
    # frontend for every stamp after the drag's first) skips the snapshot,
    # collapsing the whole stroke into one undo step.
    if not req.continue_stroke:
        buf.push_undo_snapshot()

    if req.tool == "fill_all":
        # Set every pixel in the scene to one class in a single action —
        # useful as a starting point (e.g. "everything is background",
        # then paint the details on top) rather than relying on bucket
        # fill's connectivity to happen to cover the whole frame.
        change_mask = classes != req.class_value
        classes[change_mask] = req.class_value
        if not change_mask.any() and not req.continue_stroke:
            buf.undo_stack.pop()
        return _tool_response_from_change(buf, change_mask)

    tool = get_tool(req.tool)
    params = dict(req.params)

    if req.tool == "brush":
        radius = params.pop("radius", None)
        if radius is not None and hasattr(tool, "set_size"):
            # Frontend sends a radius (px); BrushTool's internal `size` is
            # a diameter -- without this, every stroke used the class
            # default of size=1 (a single pixel) regardless of the UI's
            # brush size slider.
            tool.set_size(round(float(radius) * 2))
        points = params.get("points")
        if points is None and "x" in params and "y" in params:
            points = [(params["x"], params["y"])]
            params["points"] = points
    elif req.tool == "bucket":
        if "x" not in params or "y" not in params:
            raise HTTPException(status_code=422, detail="bucket tool requires params.x and params.y")
    elif req.tool == "polygon":
        if "points" not in params:
            raise HTTPException(status_code=422, detail="polygon tool requires params.points")
    elif req.tool == "autofill":
        # Auto-fill targets every still-unpainted pixel in the whole scene
        # in one shot, not a seed-based flood fill — no x/y or source image
        # needed.
        params.setdefault("nodata_value", raster_io.NODATA_VALUE)

    try:
        result = tool.apply(classes, req.class_value, **params)
    except (KeyError, ValueError) as exc:
        if not req.continue_stroke:
            buf.undo_stack.pop()
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if result is None:
        if not req.continue_stroke:
            buf.undo_stack.pop()
        return _tool_response_from_change(buf, np.zeros(classes.shape, dtype=bool))

    change_mask, _prev_values = result
    return _tool_response_from_change(buf, change_mask)


@router.post("/{scene_id}/undo", response_model=UndoRedoResponse)
def undo_mask(scene_id: str) -> UndoRedoResponse:
    buf = get_state().get_mask_buffer(scene_id)
    if buf is None:
        raise HTTPException(status_code=404, detail=f"No mask buffer for scene: {scene_id}")
    return UndoRedoResponse(applied=buf.undo())


@router.post("/{scene_id}/redo", response_model=UndoRedoResponse)
def redo_mask(scene_id: str) -> UndoRedoResponse:
    buf = get_state().get_mask_buffer(scene_id)
    if buf is None:
        raise HTTPException(status_code=404, detail=f"No mask buffer for scene: {scene_id}")
    return UndoRedoResponse(applied=buf.redo())


# A fixed, high-contrast palette used only to render the auto-segment
# preview (cluster identity, not a class assignment) — distinct from
# whatever class palette is active, so the preview reads clearly regardless
# of what colors the user's real classes use.
_PREVIEW_COLORS = [
    (60, 60, 60), (230, 60, 60), (60, 160, 230), (60, 200, 100),
    (230, 190, 60), (170, 90, 220), (230, 130, 60), (60, 220, 200),
]


def _load_scene_image(path_str: str | None, expected_shape: tuple[int, int], label: str) -> np.ndarray:
    if not path_str or not raster_io.image_path_exists(path_str):
        raise HTTPException(status_code=422, detail=f"Scene has no {label} image to segment.")
    image, _meta = raster_io.read_image_any(path_str)
    if image.shape[:2] != expected_shape:
        raise HTTPException(
            status_code=422,
            detail=f"{label} image size {image.shape[:2]} does not match mask size {expected_shape}.",
        )
    return image


def _load_auto_segment_source(scene, source: str, mask_shape: tuple[int, int]) -> np.ndarray:
    if source == "raw":
        return _load_scene_image(scene.raw_path, mask_shape, "raw")
    if source == "shadow":
        return _load_scene_image(scene.shadow_path, mask_shape, "shadow")
    # "both": stack raw and shadow bands together so clustering sees
    # information from both — e.g. shadow's contrast/gamma processing can
    # separate colors that look identical in the raw image alone.
    raw = _load_scene_image(scene.raw_path, mask_shape, "raw")
    shadow = _load_scene_image(scene.shadow_path, mask_shape, "shadow")
    raw = raw if raw.ndim == 3 else raw[..., np.newaxis]
    shadow = shadow if shadow.ndim == 3 else shadow[..., np.newaxis]
    return np.concatenate([raw, shadow], axis=-1)


@router.post("/{scene_id}/auto-segment", response_model=AutoSegmentResponse)
def auto_segment_preview(scene_id: str, req: AutoSegmentRequest) -> AutoSegmentResponse:
    """Unsupervised clustering (K-Means/GMM) on the scene's raw or shadow
    image, producing a *draft* multi-class label map for the user to review
    and, if useful, apply on top of the mask via the /apply endpoint below.

    This is a rough starting point, not a classifier: it groups pixels by
    color/texture similarity only, with no notion of what any class means.
    Runs entirely on CPU (these clustering methods gain essentially nothing
    from a GPU at this image scale) and completes in roughly a second on a
    typical scene — cheap enough that no consumption warning is needed, but
    the frontend still surfaces this as a "draft to correct", not a result.
    """
    state = get_state()
    buf = _ensure_buffer(scene_id)
    scene = state.get_scene(scene_id)
    if scene is None:
        raise HTTPException(status_code=404, detail=f"Scene not found: {scene_id}")

    image = _load_auto_segment_source(scene, req.source, buf.classes.shape)

    # Re-running auto-segment should only re-cluster pixels not yet painted
    # (by hand or from a previously-applied cluster) -- otherwise every call
    # recomputes clusters over the whole image and just re-proposes the same
    # groups for regions the user already accepted.
    unpainted = buf.classes == raster_io.NODATA_VALUE

    try:
        result = auto_segment(
            image,
            n_clusters=req.n_clusters,
            method=req.method,
            use_texture=req.use_texture,
            pixel_mask=unpainted,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    buf.pending_auto_segment = result.labels

    # Applying a cluster never overwrites a pixel already painted by hand
    # (see /apply below) -- the preview mirrors that here by leaving already
    # -annotated pixels transparent, so what's highlighted always matches
    # what Apply would actually change.
    preview_rgb = np.zeros((*result.labels.shape, 3), dtype=np.uint8)
    for cid in range(result.n_clusters):
        color = _PREVIEW_COLORS[cid % len(_PREVIEW_COLORS)]
        preview_rgb[result.labels == cid] = color
    preview_alpha = np.where(unpainted, 255, 0).astype(np.uint8)
    preview_rgba = np.concatenate([preview_rgb, preview_alpha[..., np.newaxis]], axis=-1)

    return AutoSegmentResponse(
        preview_png_base64=raster_io.array_to_png_base64(preview_rgba),
        clusters=[
            AutoSegmentClusterInfo(
                cluster_id=i,
                mean_color=result.cluster_means[i],
                preview_color=_PREVIEW_COLORS[i % len(_PREVIEW_COLORS)],
            )
            for i in range(result.n_clusters)
        ],
    )


def _tool_response_from_change(buf: MaskBuffer, change_mask: np.ndarray) -> ToolResponse:
    """Shared response-building for any operation that rewrites part of the
    mask via a boolean change_mask: updates the contour cache and encodes
    just the affected bounding box as the response, matching /tool's shape."""
    if not change_mask.any():
        empty = np.zeros(buf.classes.shape, dtype=np.uint8)
        rgba = np.stack([empty, empty, empty, empty], axis=-1)
        return ToolResponse(png_base64=raster_io.array_to_png_base64(rgba), bbox=(0, 0, 0, 0), changed_pixels=0)

    bbox = bbox_from_change_mask(change_mask) or (0, 0, 0, 0)
    buf.contour_cache.update(buf.classes, bbox)

    y0, x0, y1, x1 = bbox
    region = buf.classes[y0:y1, x0:x1]
    region_rgba = np.zeros((*region.shape, 4), dtype=np.uint8)
    region_rgba[..., 0] = region
    region_rgba[..., 3] = np.where(region == raster_io.NODATA_VALUE, 0, 255)

    return ToolResponse(
        png_base64=raster_io.array_to_png_base64(region_rgba),
        bbox=bbox,
        changed_pixels=int(change_mask.sum()),
    )


@router.post("/{scene_id}/auto-segment/apply", response_model=ToolResponse)
def auto_segment_apply(scene_id: str, req: ApplyAutoSegmentRequest) -> ToolResponse:
    """Apply a previously previewed auto-segmentation to the real mask
    buffer, mapping each chosen cluster to a class value. Clusters not
    present in cluster_to_class are left untouched (e.g. the user only
    wants to accept the cluster that clearly captured one class)."""
    buf = _ensure_buffer(scene_id)
    if buf.pending_auto_segment is None:
        raise HTTPException(
            status_code=409, detail="No pending auto-segment result for this scene — run /auto-segment first."
        )
    if buf.pending_auto_segment.shape != buf.classes.shape:
        raise HTTPException(status_code=409, detail="Pending auto-segment result no longer matches the mask size.")

    labels = buf.pending_auto_segment
    change_mask = np.zeros(buf.classes.shape, dtype=bool)
    # Never overwrite a pixel the annotator already painted by hand (or via
    # an earlier auto-segment apply) -- clustering has no idea a manual
    # correction exists, so applying a cluster must only fill in still-blank
    # (nodata) ground, the same way "Fill entire scene" is a distinct,
    # explicit action from painting over existing work.
    unpainted = buf.classes == raster_io.NODATA_VALUE

    buf.push_undo_snapshot()
    for cluster_id, class_value in req.cluster_to_class.items():
        cluster_mask = (labels == cluster_id) & unpainted
        change_mask |= cluster_mask
        buf.classes[cluster_mask] = class_value
    if not change_mask.any():
        buf.undo_stack.pop()

    buf.pending_auto_segment = None
    return _tool_response_from_change(buf, change_mask)


@router.post("/{scene_id}/auto-segment/discard", response_model=DeletedResponse)
def auto_segment_discard(scene_id: str) -> DeletedResponse:
    """Discard the pending auto-segment preview without applying it --
    lets the user back out of a draft they don't like (e.g. bad clustering
    parameters) without it lingering as a stale target for
    apply/apply-component. A no-op (not an error) if there is nothing
    pending, so the frontend can call this unconditionally when leaving the
    auto-segment flow."""
    buf = _ensure_buffer(scene_id)
    had_pending = buf.pending_auto_segment is not None
    buf.pending_auto_segment = None
    return DeletedResponse(deleted=had_pending)


@router.post("/{scene_id}/auto-segment/apply-component", response_model=ToolResponse)
def auto_segment_apply_component(scene_id: str, req: ApplyAutoSegmentComponentRequest) -> ToolResponse:
    """Apply only the connected component of the pending auto-segment
    result touching (x, y) to the given class — not every pixel sharing
    that cluster elsewhere in the frame. Lets the user split apart two
    same-colored but spatially separate regions the clustering lumped
    into one cluster (e.g. snow at the top and a cloud on the right).

    Unlike /apply, this does NOT consume the pending result — the user can
    click multiple components one at a time before moving on."""
    buf = _ensure_buffer(scene_id)
    if buf.pending_auto_segment is None:
        raise HTTPException(
            status_code=409, detail="No pending auto-segment result for this scene — run /auto-segment first."
        )
    labels = buf.pending_auto_segment
    if labels.shape != buf.classes.shape:
        raise HTTPException(status_code=409, detail="Pending auto-segment result no longer matches the mask size.")

    h, w = labels.shape
    if not (0 <= req.x < w and 0 <= req.y < h):
        raise HTTPException(status_code=422, detail="(x, y) is outside the mask bounds.")

    seed_cluster = int(labels[req.y, req.x])
    cluster_mask = labels == seed_cluster
    structure = ndi.generate_binary_structure(2, 1)
    labeled_components, _ = ndi.label(cluster_mask, structure=structure)
    component_id = labeled_components[req.y, req.x]
    if component_id == 0:
        raise HTTPException(status_code=422, detail="No cluster pixels at the given point.")

    # Same rule as /apply: never overwrite a pixel already painted by hand
    # (or an earlier auto-segment apply) -- assigning a cluster/component
    # only fills in still-blank ground.
    change_mask = (labeled_components == component_id) & (buf.classes == raster_io.NODATA_VALUE)
    buf.push_undo_snapshot()
    buf.classes[change_mask] = req.class_value
    if not change_mask.any():
        buf.undo_stack.pop()

    return _tool_response_from_change(buf, change_mask)


def _resolve_contained_path(root: Path, rel: str) -> Path:
    """Join root/rel and verify the result stays inside root — rejects
    absolute paths in `rel` (pathlib silently discards the left operand of
    `/` when the right one is absolute, so `Path("safe") / "C:/Windows/x"`
    resolves to `C:/Windows/x`, not `safe/C:/Windows/x`) and `..` traversal
    that would otherwise let a crafted folder_structure_template write
    anywhere the desktop user has file access, regardless of output_root."""
    root_resolved = root.resolve()
    candidate = (root / rel).resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail="folder_structure_template must stay within output_root (no absolute paths or '..' segments).",
        ) from None
    return candidate


@router.post("/{scene_id}/save", response_model=SaveResponse)
def save_mask(scene_id: str, cfg: SaveConfig) -> SaveResponse:
    state = get_state()
    buf = state.get_mask_buffer(scene_id)
    if buf is None:
        raise HTTPException(status_code=404, detail=f"No mask buffer for scene: {scene_id}")

    scene = state.get_scene(scene_id)
    palette = state.get_active_palette() if scene is not None else None

    if palette is not None:
        class_colors = palette.color_map()
        class_values = palette.value_map()
    else:
        class_colors, class_values = {}, {}

    out_root = Path(cfg.output_root) if cfg.output_root else Path.cwd()
    rel = cfg.folder_structure_template.format(scene_id=scene_id)
    out_path = _resolve_contained_path(out_root, rel)

    classes = buf.classes
    transform = buf.transform
    crs = buf.crs

    # Pixel-size resampling: cfg.target_resolution is (x_res, y_res) in the
    # scene's map units (e.g. metres/pixel — 10 for Sentinel-2, 30 for
    # Landsat), not output image dimensions. Only meaningful when the mask
    # is georeferenced, since we need a native pixel size (from the affine
    # transform) to compute a scale factor against.
    if cfg.resolution_mode == "custom" and cfg.target_resolution is not None:
        if transform is None:
            raise HTTPException(
                status_code=422,
                detail="Cannot resample to a target pixel resolution: this mask has no georeference "
                "(no native pixel size to resample from). Use resolution_mode=\"native\" instead.",
            )
        # Ground pixel size accounting for rotation/skew (not all rasters
        # are north-up — transform.b/d can be non-zero, e.g. for
        # polar-projection scenes), not just abs(a)/abs(e).
        native_x_res = math.hypot(transform.a, transform.b)
        native_y_res = math.hypot(transform.d, transform.e)
        target_x_res, target_y_res = cfg.target_resolution
        if target_x_res <= 0 or target_y_res <= 0:
            raise HTTPException(status_code=422, detail="target_resolution must be positive.")

        factor_x = native_x_res / target_x_res
        factor_y = native_y_res / target_y_res
        src_h, src_w = classes.shape[:2]
        dst_h = max(1, round(src_h * factor_y))
        dst_w = max(1, round(src_w * factor_x))
        dst_shape = (dst_h, dst_w)

        if dst_shape != classes.shape[:2]:
            classes = raster_io.resample_array(classes, dst_shape=dst_shape, method="mode")
            if crs is not None:
                from rasterio.transform import Affine

                # Scale by the *actual* (rounded) pixel-count ratio, not the
                # theoretical target_resolution — the geotransform must
                # describe the real extent/pixel-count relationship of the
                # written raster, or the file's stated resolution and its
                # true ground footprint would disagree.
                transform = transform * Affine.scale(src_w / dst_w, src_h / dst_h)

    if cfg.output_format in ("geotiff_rgba", "geotiff_rgb"):
        if not raster_io.RASTERIO_AVAILABLE:
            raise HTTPException(
                status_code=503,
                detail="rasterio/GDAL not available: cannot write GeoTIFF output in this environment.",
            )
        if transform is None or crs is None:
            from rasterio.transform import Affine

            transform = Affine.identity()
            crs = None

        if cfg.output_format == "geotiff_rgba":
            rgba = raster_io.classes_to_rgba(classes, class_colors, class_values)
            bytes_written = raster_io.write_mask_with_georef(rgba, out_path, transform, crs, compress=cfg.compress)
        else:
            bytes_written = raster_io.write_mask_rgb(
                classes, out_path, transform, crs, class_colors, class_values, compress=cfg.compress
            )
    elif cfg.output_format == "png":
        rgba = raster_io.classes_to_rgba(classes, class_colors, class_values)
        bytes_written = raster_io.write_mask_png(rgba, out_path)
    elif cfg.output_format == "png_indexed":
        palette_list = [class_colors.get(name, (0, 0, 0)) for name in sorted(class_values, key=class_values.get)]
        if not palette_list:
            palette_list = [(0, 0, 0)]
        rgba = raster_io.classes_to_rgba(classes, class_colors, class_values)
        bytes_written = raster_io.write_mask_png(
            rgba, out_path, indexed=True, classes=classes, palette=palette_list
        )
    else:
        raise HTTPException(status_code=422, detail=f"Unknown output_format: {cfg.output_format}")

    if cfg.copy_raw and scene is not None and scene.raw_path:
        _copy_alongside(Path(scene.raw_path), out_path)
    if cfg.copy_shadow and scene is not None and scene.shadow_path:
        _copy_alongside(Path(scene.shadow_path), out_path)

    return SaveResponse(path=str(out_path), bytes_written=bytes_written)


def _copy_alongside(src: Path, mask_out_path: Path) -> None:
    """Copy src into mask_out_path's directory, keeping src's own filename
    (e.g. RGB_Raw.tif lands next to Mask.tif, not renamed to match it).

    A zarr composite path (see ``maskforge_core.plugins.zarr_reader``) is not
    a real file -- ``src.exists()`` is False for it, so this is deliberately
    a no-op for zarr-backed scenes rather than copying the whole shared
    per-tile store alongside every single mask save.
    """
    if not src.exists():
        return
    dest = mask_out_path.parent / src.name
    if dest.resolve() == src.resolve():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)


@router.post("/{scene_id}/remap", response_model=RemapResponse)
def remap_mask(scene_id: str, req: RemapRequest) -> RemapResponse:
    state = get_state()
    buf = state.get_mask_buffer(scene_id)
    if buf is None:
        raise HTTPException(status_code=404, detail=f"No mask buffer for scene: {scene_id}")

    # Remap operates on the RGB rendering of the mask (matches IPC contract:
    # old_color/new_color are RGB triples), so we need a color mapping. We
    # derive it from the currently active palette if available; otherwise
    # remap is a no-op on the class buffer directly using value equality
    # (old_color[0] treated as class value) as a degraded fallback.
    palette = state.get_active_palette()
    class_colors = palette.color_map() if palette is not None else {}
    class_values = palette.value_map() if palette is not None else {}

    rgb = raster_io.classes_to_rgb(buf.classes, class_colors, class_values)  # (3, H, W)
    rgb_hwc = np.moveaxis(rgb, 0, -1)

    old_color = np.array(req.old_color, dtype=np.uint8)
    affected_mask = np.all(rgb_hwc == old_color, axis=-1)
    affected_pixels = int(affected_mask.sum())

    applied = False
    if not req.dry_run and affected_pixels > 0:
        new_val = None
        for name, color in class_colors.items():
            if tuple(color) == tuple(req.new_color):
                new_val = class_values.get(name)
                break
        if new_val is None:
            # Fall back: no palette entry matches new_color; treat new_color's
            # first channel as a raw class value, consistent with the
            # degraded-fallback path above.
            new_val = int(req.new_color[0])

        buf.push_undo_snapshot()
        buf.classes[affected_mask] = new_val
        buf.contour_cache.invalidate()
        applied = True

    return RemapResponse(affected_pixels=affected_pixels, applied=applied)
