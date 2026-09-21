"""Raster I/O and array resampling utilities.

Ported/generalized from the reference Tkinter tool's
``Utils/mask_editor_core.py`` (``MaskEditorConfig``, ``resample_mask``,
``create_transparent_mask``, ``write_mask_with_georef``, ``rgba_to_classes``,
``classes_to_rgb``). The hardcoded 2x/3x sensor-based resampling and the
4-class hardcoded config are generalized here: arbitrary resample factors,
an arbitrary class dict, and a plain-image (PNG/JPEG, non-georeferenced)
fallback path are added.

GeoTIFF I/O requires ``rasterio``. If rasterio/GDAL is not importable in
this environment, georeferenced code paths raise a clear ``RuntimeError``
at call time (not at import time), so the rest of the package (tools,
class_config, scene_discovery, session, contours, qa_workflow) stays usable
without GDAL.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import numpy as np
from PIL import Image

try:
    import rasterio
    from rasterio.enums import ColorInterp, Resampling
    from rasterio.transform import Affine
    from rasterio.warp import reproject as _rio_reproject

    RASTERIO_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised only without GDAL
    rasterio = None  # type: ignore[assignment]
    ColorInterp = None  # type: ignore[assignment]
    Resampling = None  # type: ignore[assignment]
    Affine = None  # type: ignore[assignment]
    _rio_reproject = None  # type: ignore[assignment]
    RASTERIO_AVAILABLE = False


# Sentinel class-index for "no class painted here" (a fresh/unannotated
# pixel). Historically this was 0, but 0 is also a perfectly legitimate
# real class value in some palettes (e.g. this project's first class,
# "conifer_forest", is value 0) -- treating it as nodata made that class
# permanently invisible (always rendered fully transparent) and impossible
# to fill/export correctly. 255 is used instead since it sits outside the
# realistic range of hand-authored class values and still fits uint8.
NODATA_VALUE = 255


def _require_rasterio() -> None:
    if not RASTERIO_AVAILABLE:
        raise RuntimeError(
            "rasterio/GDAL is not available in this environment. "
            "Georeferenced raster I/O (GeoTIFF read/write, CRS-aware "
            "resampling) requires rasterio. Install it, or use the "
            "non-georeferenced PNG/JPEG code paths instead."
        )


ResampleMethod = Literal["nearest", "mode", "bilinear", "cubic"]


# ===========================================================================
# Configuration
# ===========================================================================


@dataclass
class MaskEditorConfig:
    """Centralized, generalized mask-editor configuration.

    Unlike the reference ``MaskEditorConfig`` (hardcoded 4-class glacier
    dict), classes are an arbitrary ``{name: (r, g, b)}`` / ``{name: value}``
    mapping supplied by the caller (typically derived from a
    :class:`~maskforge_core.class_config.ClassPalette`).
    """

    classes: dict[str, tuple[int, int, int]] = field(default_factory=dict)
    class_values: dict[str, int] = field(default_factory=dict)

    canvas_count: int = 4
    enable_blink: bool = True
    blink_frequency_ms: int = 800

    enable_contours: bool = True
    contour_thickness: int = 0
    contour_color: tuple[int, int, int] = (255, 0, 0)
    contour_alpha: float = 0.5
    contour_blink_frequency_ms: int = 500


# ===========================================================================
# Plain-image (non-georeferenced) I/O
# ===========================================================================


def image_path_exists(path: str | Path) -> bool:
    """``Path.exists()``, but aware that a registered reader's path may be a
    composite address rather than a real filesystem path -- e.g. a zarr
    composite path (``<store>.zarr!<sensor>/<scene>/<composite>``, see
    ``maskforge_core.plugins.zarr_reader``) is not itself a path
    ``Path(...).exists()`` can check; only the ``<store>.zarr`` prefix is a
    real directory. Callers gating a ``read_image_any`` call on "does this
    scene's image actually exist" should use this instead of a bare
    ``Path(path_str).exists()``.
    """
    p = Path(path)
    if p.exists():
        return True
    from .plugins.zarr_reader import is_zarr_composite_path, store_path_for

    if is_zarr_composite_path(p):
        return store_path_for(p).exists()
    return False


def read_image_any(path: str | Path) -> tuple[np.ndarray, dict[str, Any]]:
    """Read a raster from disk, GeoTIFF, plain PNG/JPEG, or a registered
    plugin format (e.g. a zarr composite path -- see
    ``maskforge_core.plugins.zarr_reader``).

    Returns ``(array, meta)`` where ``array`` is ``(H, W, C)`` or ``(H, W)``
    uint8/float and ``meta`` has keys ``crs``, ``transform``, ``width``,
    ``height`` (``crs``/``transform`` are ``None`` for non-georeferenced
    images).
    """
    from .plugins import find_reader

    reader = find_reader(Path(path))
    if reader is not None:
        return reader.read(Path(path))

    path = Path(path)
    suffix = path.suffix.lower()
    if suffix in (".tif", ".tiff") and RASTERIO_AVAILABLE:
        with rasterio.open(path) as src:
            arr = src.read()  # (bands, H, W)
            arr = np.moveaxis(arr, 0, -1)
            if arr.shape[-1] == 1:
                arr = arr[..., 0]
            meta = {
                "crs": src.crs.to_string() if src.crs else None,
                "transform": tuple(src.transform)[:6] if src.transform else None,
                "width": src.width,
                "height": src.height,
            }
            return arr, meta

    with Image.open(path) as img:
        arr = np.array(img)
    meta = {"crs": None, "transform": None, "width": arr.shape[1], "height": arr.shape[0]}
    return arr, meta


def array_to_png_base64(arr: np.ndarray) -> str:
    """Encode an (H, W) / (H, W, 3) / (H, W, 4) uint8 array as base64 PNG."""
    import base64

    if arr.dtype != np.uint8:
        arr = np.clip(arr, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def png_base64_to_array(data: str) -> np.ndarray:
    import base64

    raw = base64.b64decode(data)
    with Image.open(io.BytesIO(raw)) as img:
        return np.array(img)


# ===========================================================================
# Mask RGBA creation / georef I/O
# ===========================================================================


def create_transparent_mask(shape: tuple[int, int]) -> np.ndarray:
    """Create a fully transparent RGBA mask of the given ``(height, width)``.

    Generalized version of the reference ``create_transparent_mask``: the
    reference version derived drawable/protected zones from a
    glacier-specific ``valid_mask.tif`` + TOA nodata. That domain-specific
    behavior is not portable to a generic tool; callers that need a
    "protected zone" mask should compute a boolean array themselves (e.g.
    from source nodata) and pass it to :func:`apply_nodata_mask`.
    """
    h, w = shape
    mask_rgba = np.zeros((h, w, 4), dtype=np.uint8)
    mask_rgba[..., :3] = 255
    mask_rgba[..., 3] = 0
    return mask_rgba


def apply_nodata_mask(mask_rgba: np.ndarray, nodata_bool: np.ndarray) -> np.ndarray:
    """Mark ``nodata_bool`` pixels as opaque black (protected / non-drawable)."""
    out = mask_rgba.copy()
    out[nodata_bool, :3] = 0
    out[nodata_bool, 3] = 255
    return out


def write_mask_with_georef(
    mask_rgba: np.ndarray,
    out_path: str | Path,
    transform: Any,
    crs: Any,
    compress: str | None = "LZW",
) -> int:
    """Write an RGBA mask GeoTIFF with EXTRASAMPLES=UNASSALPHA-compatible
    color interpretation (red/green/blue/alpha), preserving CRS/transform.

    Returns bytes written.
    """
    _require_rasterio()
    out_path = Path(out_path)
    h, w = mask_rgba.shape[:2]

    profile = {
        "driver": "GTiff",
        "dtype": "uint8",
        "count": 4,
        "height": h,
        "width": w,
        "crs": crs,
        "transform": transform,
        "photometric": "RGB",
    }
    if compress:
        profile["compress"] = compress

    out_path.parent.mkdir(parents=True, exist_ok=True)

    with rasterio.open(out_path, "w", **profile) as dst:
        for i in range(4):
            dst.write(mask_rgba[:, :, i], i + 1)
        dst.colorinterp = (
            ColorInterp.red,
            ColorInterp.green,
            ColorInterp.blue,
            ColorInterp.alpha,
        )

    return out_path.stat().st_size


def write_mask_rgb(
    classes: np.ndarray,
    out_path: str | Path,
    transform: Any,
    crs: Any,
    class_colors: dict[str, tuple[int, int, int]],
    class_values: dict[str, int],
    compress: str | None = "LZW",
) -> int:
    """Write a 3-band RGB GeoTIFF from a class-index array."""
    _require_rasterio()
    out_path = Path(out_path)
    rgb = classes_to_rgb(classes, class_colors, class_values)  # (3, H, W)

    profile = {
        "driver": "GTiff",
        "dtype": "uint8",
        "count": 3,
        "height": classes.shape[0],
        "width": classes.shape[1],
        "crs": crs,
        "transform": transform,
        "photometric": "RGB",
    }
    if compress:
        profile["compress"] = compress

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(rgb)

    return out_path.stat().st_size


def write_mask_png(
    mask_rgba: np.ndarray,
    out_path: str | Path,
    indexed: bool = False,
    classes: np.ndarray | None = None,
    palette: list[tuple[int, int, int]] | None = None,
) -> int:
    """Write a mask as plain PNG (non-georeferenced fallback), optionally
    palette-indexed (``png_indexed`` output format)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if indexed:
        if classes is None or palette is None:
            raise ValueError("indexed PNG requires `classes` and `palette`")
        img = Image.fromarray(classes.astype(np.uint8), mode="P")
        flat_palette: list[int] = []
        for color in palette:
            flat_palette.extend(color)
        flat_palette.extend([0, 0, 0] * (256 - len(palette)))
        img.putpalette(flat_palette[:768])
        img.save(out_path, format="PNG")
    else:
        Image.fromarray(mask_rgba, mode="RGBA").save(out_path, format="PNG")

    return out_path.stat().st_size


# ===========================================================================
# Class <-> RGB conversion
# ===========================================================================


def rgba_to_classes(
    mask_rgba: np.ndarray,
    class_colors: dict[str, tuple[int, int, int]],
    class_values: dict[str, int],
) -> np.ndarray:
    """Vectorized RGBA -> class-index conversion.

    Nodata convention: alpha == 0 (transparent) maps to NODATA_VALUE, i.e.
    "no class painted here" -- independent of which class value happens to
    render as black, so a real class legitimately valued 0 round-trips
    correctly instead of being confused with an unpainted pixel.
    """
    h, w = mask_rgba.shape[:2]
    classes = np.full((h, w), NODATA_VALUE, dtype=np.uint8)

    nodata_mask = mask_rgba[:, :, 3] == 0
    classes[nodata_mask] = NODATA_VALUE

    for name, color in class_colors.items():
        val = class_values.get(name)
        if val is None:
            continue
        m = (
            (mask_rgba[:, :, 0] == color[0])
            & (mask_rgba[:, :, 1] == color[1])
            & (mask_rgba[:, :, 2] == color[2])
            & (mask_rgba[:, :, 3] == 255)
        )
        classes[m] = val

    return classes


def classes_to_rgb(
    classes: np.ndarray,
    class_colors: dict[str, tuple[int, int, int]],
    class_values: dict[str, int],
) -> np.ndarray:
    """Vectorized class-index -> RGB (3, H, W) conversion."""
    h, w = classes.shape
    rgb = np.zeros((3, h, w), dtype=np.uint8)

    val_to_color = {class_values[name]: color for name, color in class_colors.items() if name in class_values}

    for val, color in val_to_color.items():
        m = classes == val
        if m.any():
            rgb[0][m] = color[0]
            rgb[1][m] = color[1]
            rgb[2][m] = color[2]

    return rgb


def classes_to_rgba(
    classes: np.ndarray,
    class_colors: dict[str, tuple[int, int, int]],
    class_values: dict[str, int],
) -> np.ndarray:
    """Class-index -> RGBA (H, W, 4), alpha=255 except NODATA_VALUE (unpainted, alpha=0)."""
    rgb = classes_to_rgb(classes, class_colors, class_values)  # (3, H, W)
    h, w = classes.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., :3] = np.moveaxis(rgb, 0, -1)
    rgba[..., 3] = np.where(classes == NODATA_VALUE, 0, 255)
    return rgba


# ===========================================================================
# Resampling (arbitrary factor)
# ===========================================================================


def _resize_nearest(arr: np.ndarray, dst_shape: tuple[int, int]) -> np.ndarray:
    """Vectorized nearest-neighbor resize for a 2D array, arbitrary factor."""
    src_h, src_w = arr.shape[:2]
    dst_h, dst_w = dst_shape
    if (src_h, src_w) == (dst_h, dst_w):
        return arr.copy()
    if src_h <= 0 or src_w <= 0 or dst_h <= 0 or dst_w <= 0:
        raise ValueError("Source and destination shapes must be positive.")

    y_idx = np.minimum(((np.arange(dst_h) + 0.5) * src_h / dst_h).astype(np.int64), src_h - 1)
    x_idx = np.minimum(((np.arange(dst_w) + 0.5) * src_w / dst_w).astype(np.int64), src_w - 1)
    return arr[y_idx[:, None], x_idx[None, :], ...]


def _resize_mode(arr: np.ndarray, dst_shape: tuple[int, int]) -> np.ndarray:
    """Categorical block-majority ("mode") downsampling, vectorized.

    Only meaningful when downsampling (dst <= src on both axes); for
    non-integer factors, blocks are computed from per-axis nearest bin
    edges so this still works for arbitrary factors. Falls back to
    nearest-neighbor when upsampling (mode has no meaning for magnification).
    """
    src_h, src_w = arr.shape[:2]
    dst_h, dst_w = dst_shape
    if (src_h, src_w) == (dst_h, dst_w):
        return arr.copy()

    if dst_h >= src_h and dst_w >= src_w:
        # Upsampling: majority-of-one-pixel === nearest.
        return _resize_nearest(arr, dst_shape)

    # Bin edges along each axis (arbitrary factor supported).
    y_edges = np.floor(np.linspace(0, src_h, dst_h + 1)).astype(np.int64)
    x_edges = np.floor(np.linspace(0, src_w, dst_w + 1)).astype(np.int64)
    y_edges = np.clip(y_edges, 0, src_h)
    x_edges = np.clip(x_edges, 0, src_w)

    out = np.zeros((dst_h, dst_w), dtype=arr.dtype)
    # Block-wise majority vote via bincount per block; vectorized across
    # rows within a block-row using np.apply_along logic replaced by
    # manual loops over blocks only (dst_h * dst_w iterations, not
    # src_h * src_w pixel iterations -> still a large speedup vs naive
    # per-pixel Python loops, and dst grids are the "small" side).
    for by in range(dst_h):
        y0, y1 = y_edges[by], max(y_edges[by] + 1, y_edges[by + 1])
        y1 = min(y1, src_h)
        for bx in range(dst_w):
            x0, x1 = x_edges[bx], max(x_edges[bx] + 1, x_edges[bx + 1])
            x1 = min(x1, src_w)
            block = arr[y0:y1, x0:x1]
            if block.size == 0:
                out[by, bx] = arr[min(y0, src_h - 1), min(x0, src_w - 1)]
                continue
            vals, counts = np.unique(block, return_counts=True)
            out[by, bx] = vals[np.argmax(counts)]
    return out


def resample_array(
    arr: np.ndarray,
    dst_shape: tuple[int, int] | None = None,
    factor: float | None = None,
    method: ResampleMethod = "nearest",
    src_transform: Any = None,
    src_crs: Any = None,
    dst_transform: Any = None,
    dst_crs: Any = None,
) -> np.ndarray:
    """Resample a 2D (or (H,W,C)) array by an arbitrary factor or to an
    arbitrary destination shape.

    - If ``src_transform``/``src_crs``/``dst_transform``/``dst_crs`` are all
      provided, uses ``rasterio.warp.reproject`` (true CRS-aware resampling,
      arbitrary non-integer factor natively supported).
    - Otherwise uses a vectorized resize: ``method="nearest"`` (default) or
      ``method="mode"`` (categorical block-majority, better for class/label
      rasters than nearest alone).
    - Exactly one of ``dst_shape`` or ``factor`` must be given when not
      using the CRS-aware path (``factor`` scales both axes;
      ``dst_shape=(height, width)`` sets an explicit target size).

    Returns the resampled array with the same dtype as the input.
    """
    if dst_shape is None and factor is None and dst_transform is None:
        raise ValueError("Provide dst_shape, factor, or dst_transform.")

    use_georef = (
        src_transform is not None
        and src_crs is not None
        and dst_transform is not None
        and dst_crs is not None
    )

    if use_georef:
        _require_rasterio()
        if dst_shape is None:
            raise ValueError("dst_shape is required for the CRS-aware resampling path.")
        resampling = {
            "nearest": Resampling.nearest,
            "mode": Resampling.mode,
            "bilinear": Resampling.bilinear,
            "cubic": Resampling.cubic,
        }[method]
        dst = np.zeros(dst_shape, dtype=arr.dtype)
        _rio_reproject(
            arr,
            dst,
            src_transform=src_transform,
            src_crs=src_crs,
            dst_transform=dst_transform,
            dst_crs=dst_crs,
            resampling=resampling,
        )
        return dst

    src_h, src_w = arr.shape[:2]
    if dst_shape is None:
        dst_shape = (max(1, round(src_h * factor)), max(1, round(src_w * factor)))

    if method == "mode":
        return _resize_mode(arr, dst_shape)
    if method in ("nearest", "bilinear", "cubic"):
        if method != "nearest":
            # Non-categorical smooth resampling without a CRS: delegate to
            # PIL for a decent bilinear/cubic vectorized implementation.
            resample_filter = {
                "bilinear": Image.BILINEAR,
                "cubic": Image.BICUBIC,
            }[method]
            mode = "F" if arr.dtype.kind == "f" else None
            img = Image.fromarray(arr.astype(np.float32) if mode == "F" else arr)
            resized = img.resize((dst_shape[1], dst_shape[0]), resample_filter)
            return np.array(resized).astype(arr.dtype)
        return _resize_nearest(arr, dst_shape)

    raise ValueError(f"Unknown resample method: {method!r}")
