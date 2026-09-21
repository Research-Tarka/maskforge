"""Auto-generation of an RGB "Shadow" preview from RGB Raw imagery.

Implements plan section 12. Common interface:

    ShadowMethod.generate(raw: np.ndarray, params: dict) -> np.ndarray

Methods:
- ``PercentileArcsinhGammaBalance``: direct port of the reference pipeline
  in ``Utils/scene_download_block_sentinel2.py`` (``ToaGlacierMethod``
  dataclass + ``_toa_asinh_compress``, ``_toa_percentiles``,
  ``_toa_gray_balance``, ``_apply_desaturation``, ``_toa_gamma``,
  ``_render_toa_glacier``), generalized from a fixed TOA-glacier 3-band
  workflow to any RGB array, with the two reference presets ("Shadow" /
  "Brut") ported with identical parameter values.
- ``ClaheMethod``: CLAHE via ``skimage.exposure.equalize_adapthist``.
- ``HsvShadowIndexMethod``: HSV low-luminance/high-shadow thresholding
  with an optional multiband ratio.
- ``HillshadeMethod``: basic sun-angle hillshade from a DEM via numpy
  gradients (no rasterio DEM dependency required, works on a plain
  elevation array).
- ``CustomMethod``: plugin-style extension point — register any
  ``Callable[[np.ndarray, dict], np.ndarray]`` under a name.

The auto-apply-only-if-absent rule (never silently overwrite a manually
supplied Shadow file) is enforced by the caller (API layer / scene
discovery), not by this module — this module only ever *generates* an
array; it never touches the filesystem to decide "should I overwrite".
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np

try:
    from skimage.exposure import equalize_adapthist as _equalize_adapthist

    SKIMAGE_AVAILABLE = True
except ImportError:  # pragma: no cover
    _equalize_adapthist = None
    SKIMAGE_AVAILABLE = False


class ShadowMethod(ABC):
    """Common interface for all shadow/preview generation methods."""

    name: str

    @abstractmethod
    def generate(self, raw: np.ndarray, params: dict[str, Any]) -> np.ndarray:
        """Generate a preview array from a raw RGB (H, W, 3) array (uint8 or
        float). Returns a uint8 (H, W, 3) array."""
        raise NotImplementedError


def _to_unit_float(raw: np.ndarray) -> np.ndarray:
    """Normalize any numeric input array to float32 in [0, 1]."""
    arr = np.asarray(raw, dtype=np.float32)
    if arr.max(initial=0.0) > 1.0 + 1e-6:
        # Assume 8-bit-ish input; scale by observed max dtype range.
        if raw.dtype == np.uint8:
            arr = arr / 255.0
        elif raw.dtype == np.uint16:
            arr = arr / 65535.0
        else:
            m = float(arr.max()) or 1.0
            arr = arr / m
    return np.clip(arr, 0.0, 1.0, out=arr)


def _to_uint8(arr: np.ndarray) -> np.ndarray:
    return np.clip(arr * 255.0, 0, 255).astype(np.uint8)


# ===========================================================================
# Percentile / arcsinh / gamma / balance pipeline (ported from
# scene_download_block_sentinel2.py)
# ===========================================================================


def _apply_desaturation(image: np.ndarray, amount: float) -> np.ndarray:
    if amount <= 0:
        return image
    amount = np.clip(amount, 0.0, 1.0)
    gray = np.mean(image, axis=2, keepdims=True)
    mixed = image * (1.0 - amount) + gray * amount
    return np.clip(mixed, 0.0, 1.0, out=mixed)


def _toa_asinh_compress(image: np.ndarray, factor: float) -> np.ndarray:
    factor = float(factor)
    if factor <= 0:
        return image
    denom = np.arcsinh(factor)
    if not np.isfinite(denom) or denom <= 0:
        return image
    return np.arcsinh(image * factor) / denom


def _toa_percentiles(
    image: np.ndarray, low_pct: float, high_pct: float, mask: np.ndarray | None = None
) -> tuple[np.ndarray, np.ndarray]:
    n_bands = image.shape[2]
    lows = np.zeros(n_bands, dtype=np.float32)
    highs = np.ones(n_bands, dtype=np.float32)
    for idx in range(n_bands):
        band = image[..., idx]
        valid = np.isfinite(band)
        if mask is not None:
            valid = valid & mask
        data = band[valid]
        if data.size == 0:
            lows[idx] = 0.0
            highs[idx] = 1.0
            continue
        lows[idx] = float(np.nanpercentile(data, low_pct))
        highs[idx] = float(np.nanpercentile(data, high_pct))
        if highs[idx] - lows[idx] < 1e-6:
            highs[idx] = lows[idx] + 1e-6
    return lows, highs


def _toa_linear_stretch(image: np.ndarray, lows: np.ndarray, highs: np.ndarray) -> np.ndarray:
    range_ = np.maximum(highs - lows, 1e-6)
    stretched = (image - lows) / range_
    return np.clip(stretched, 0.0, 1.0, out=stretched)


def _toa_gray_balance(image: np.ndarray) -> np.ndarray:
    means = np.nanmean(image, axis=(0, 1))
    scale = np.ones(image.shape[2], dtype=np.float32)
    valid = np.isfinite(means) & (means > 0)
    target = float(np.nanmean(means[valid])) if valid.any() else 1.0
    for idx, mean in enumerate(means):
        if np.isfinite(mean) and mean > 0:
            scale[idx] = float(target / mean)
    balanced = image * scale
    return np.clip(balanced, 0.0, 1.0, out=balanced)


def _toa_gamma(image: np.ndarray, gamma_value: float | None) -> np.ndarray:
    if gamma_value is None or gamma_value <= 0:
        return image
    safe = np.maximum(image, 0.0)
    corrected = np.power(safe, gamma_value, dtype=np.float32)
    return np.clip(corrected, 0.0, 1.0, out=corrected)


@dataclass(frozen=True)
class PercentileArcsinhParams:
    asinh_k: float = 8.0
    low_pct: float = 0.5
    high_pct: float = 99.7
    desaturation: float = 0.05
    gamma: float | None = 1 / 2.2
    apply_balance: bool = True

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "PercentileArcsinhParams":
        return PercentileArcsinhParams(
            asinh_k=float(d.get("asinh_k", 8.0)),
            low_pct=float(d.get("low_pct", 0.5)),
            high_pct=float(d.get("high_pct", 99.7)),
            desaturation=float(d.get("desaturation", 0.05)),
            gamma=(None if d.get("gamma") in (None, "null") else float(d.get("gamma"))),
            apply_balance=bool(d.get("apply_balance", True)),
        )


# Presets ported exactly from TOA_GLACIER_METHODS in the reference module.
PRESET_SHADOW = PercentileArcsinhParams(
    asinh_k=8.0, low_pct=0.5, high_pct=99.7, desaturation=0.05, gamma=1 / 2.2, apply_balance=True
)
PRESET_BRUT = PercentileArcsinhParams(
    asinh_k=0.0, low_pct=0.1, high_pct=99.9, desaturation=0.0, gamma=None, apply_balance=False
)

BUILTIN_PRESETS: dict[str, PercentileArcsinhParams] = {
    "Shadow": PRESET_SHADOW,
    "Brut": PRESET_BRUT,
}


class PercentileArcsinhGammaBalanceMethod(ShadowMethod):
    """Chainable arcsinh-compress -> percentile-stretch -> gray-balance ->
    desaturate -> gamma pipeline. Steps are independently toggleable via
    params (an `asinh_k<=0` / `apply_balance=False` / `desaturation=0` /
    `gamma=None` skips that step), matching the reference's per-step
    behavior exactly."""

    name = "percentile_arcsinh_gamma_balance"

    def generate(self, raw: np.ndarray, params: dict[str, Any]) -> np.ndarray:
        preset_name = params.get("preset")
        if preset_name is not None:
            p = BUILTIN_PRESETS[preset_name]
        else:
            p = PercentileArcsinhParams.from_dict(params)

        work = _to_unit_float(raw)
        if work.ndim == 2:
            work = np.stack([work] * 3, axis=-1)

        mask_valid = None
        mask_high_pct = params.get("mask_high_pct")
        if mask_high_pct is not None:
            flat = work[np.isfinite(work)]
            if flat.size:
                threshold = float(np.nanpercentile(flat, mask_high_pct))
                mask_valid = np.all(work < threshold, axis=-1)

        work = _toa_asinh_compress(work, p.asinh_k)
        lows, highs = _toa_percentiles(work, p.low_pct, p.high_pct, mask_valid)
        work = _toa_linear_stretch(work, lows, highs)
        if p.apply_balance:
            work = _toa_gray_balance(work)
        work = _apply_desaturation(work, p.desaturation)
        work = _toa_gamma(work, p.gamma)
        work = np.clip(work, 0.0, 1.0, out=work)
        return _to_uint8(work)


# ===========================================================================
# CLAHE
# ===========================================================================


class ClaheMethod(ShadowMethod):
    """Contrast-limited adaptive histogram equalization via
    ``skimage.exposure.equalize_adapthist``."""

    name = "clahe"

    def generate(self, raw: np.ndarray, params: dict[str, Any]) -> np.ndarray:
        if not SKIMAGE_AVAILABLE:
            raise RuntimeError("scikit-image is required for CLAHE.")
        clip_limit = float(params.get("clip_limit", 0.01))
        kernel_size = params.get("kernel_size")

        work = _to_unit_float(raw)
        result = _equalize_adapthist(work, clip_limit=clip_limit, kernel_size=kernel_size)
        return _to_uint8(result)


# ===========================================================================
# HSV shadow-index thresholding
# ===========================================================================


def _rgb_to_hsv(rgb01: np.ndarray) -> np.ndarray:
    """Vectorized RGB (float, [0,1]) -> HSV (float, [0,1]) conversion."""
    from colorsys import rgb_to_hsv as _unused  # noqa: F401  (documents intent; not used, vectorized below)

    r, g, b = rgb01[..., 0], rgb01[..., 1], rgb01[..., 2]
    maxc = np.max(rgb01, axis=-1)
    minc = np.min(rgb01, axis=-1)
    v = maxc
    delta = maxc - minc
    s = np.where(maxc > 0, delta / np.where(maxc == 0, 1, maxc), 0.0)

    rc = np.where(delta != 0, (maxc - r) / np.where(delta == 0, 1, delta), 0.0)
    gc = np.where(delta != 0, (maxc - g) / np.where(delta == 0, 1, delta), 0.0)
    bc = np.where(delta != 0, (maxc - b) / np.where(delta == 0, 1, delta), 0.0)

    h = np.zeros_like(maxc)
    is_r = (maxc == r) & (delta != 0)
    is_g = (maxc == g) & (delta != 0) & ~is_r
    is_b = (maxc == b) & (delta != 0) & ~is_r & ~is_g

    h = np.where(is_r, bc - gc, h)
    h = np.where(is_g, 2.0 + rc - bc, h)
    h = np.where(is_b, 4.0 + gc - rc, h)
    h = (h / 6.0) % 1.0

    return np.stack([h, s, v], axis=-1)


class HsvShadowIndexMethod(ShadowMethod):
    """Shadow index via low value (luminance) + thresholded saturation in
    HSV space, with an optional band-ratio boost if the raw array has more
    than 3 bands (multiband ratio index)."""

    name = "hsv_shadow_index"

    def generate(self, raw: np.ndarray, params: dict[str, Any]) -> np.ndarray:
        value_threshold = float(params.get("value_threshold", 0.35))
        saturation_threshold = float(params.get("saturation_threshold", 0.15))
        boost = float(params.get("boost", 1.6))

        work = _to_unit_float(raw)
        if work.ndim == 2:
            work = np.stack([work] * 3, axis=-1)

        rgb = work[..., :3]
        hsv = _rgb_to_hsv(rgb)
        v = hsv[..., 2]
        s = hsv[..., 1]

        shadow_mask = (v < value_threshold) & (s < saturation_threshold)

        if work.shape[-1] > 3:
            extra = work[..., 3:]
            ratio = np.mean(extra, axis=-1) / np.maximum(v, 1e-6)
            shadow_mask = shadow_mask | (ratio > 1.0)

        out = rgb.copy()
        boosted = np.clip(rgb * boost, 0.0, 1.0)
        out[shadow_mask] = boosted[shadow_mask]

        return _to_uint8(out)


# ===========================================================================
# DEM hillshade
# ===========================================================================


class HillshadeMethod(ShadowMethod):
    """Basic sun-angle hillshade from a DEM array via numpy gradients (no
    rasterio dependency; works on a plain elevation array and an optional
    per-pixel size for correct gradient scaling). Applied only when a DEM
    is available/relevant, per plan section 12."""

    name = "hillshade"

    def generate(self, raw: np.ndarray, params: dict[str, Any]) -> np.ndarray:
        """``raw`` here is the DEM elevation array (H, W), not RGB — this
        method's caller (shadow-gen orchestration) must special-case
        supplying the DEM instead of the RGB raw when this method is
        selected."""
        dem = np.asarray(raw, dtype=np.float32)
        if dem.ndim == 3:
            dem = dem[..., 0]

        sun_azimuth = float(params.get("sun_azimuth", 315.0))
        sun_elevation = float(params.get("sun_elevation", 45.0))
        pixel_size = float(params.get("pixel_size", 1.0))
        z_factor = float(params.get("z_factor", 1.0))

        az_rad = np.deg2rad(sun_azimuth)
        alt_rad = np.deg2rad(sun_elevation)

        gy, gx = np.gradient(dem * z_factor, pixel_size)
        slope = np.arctan(np.hypot(gx, gy))
        aspect = np.arctan2(-gx, gy)

        hillshade = np.sin(alt_rad) * np.cos(slope) + np.cos(alt_rad) * np.sin(slope) * np.cos(
            az_rad - aspect
        )
        hillshade = np.clip(hillshade, 0.0, 1.0)

        rgb = np.stack([hillshade] * 3, axis=-1)
        return _to_uint8(rgb)


# ===========================================================================
# Custom method plugin registry
# ===========================================================================

CustomCallable = Callable[[np.ndarray, dict[str, Any]], np.ndarray]
_CUSTOM_REGISTRY: dict[str, CustomCallable] = {}


def register_custom_method(name: str, fn: CustomCallable) -> None:
    """Register a user-supplied callable under `name` for use via
    `CustomMethod` / the method registry (same plugin mechanism referenced
    for format plugins)."""
    _CUSTOM_REGISTRY[name] = fn


def unregister_custom_method(name: str) -> None:
    _CUSTOM_REGISTRY.pop(name, None)


class CustomMethod(ShadowMethod):
    """Extension point dispatching to a registered custom callable, keyed
    by ``params["custom_name"]``."""

    name = "custom"

    def generate(self, raw: np.ndarray, params: dict[str, Any]) -> np.ndarray:
        custom_name = params.get("custom_name")
        if custom_name is None or custom_name not in _CUSTOM_REGISTRY:
            raise ValueError(f"Unknown custom shadow method: {custom_name!r}")
        return _CUSTOM_REGISTRY[custom_name](raw, params)


# ===========================================================================
# Method registry
# ===========================================================================

METHOD_REGISTRY: dict[str, type[ShadowMethod]] = {
    "percentile_arcsinh_gamma_balance": PercentileArcsinhGammaBalanceMethod,
    "clahe": ClaheMethod,
    "hsv_shadow_index": HsvShadowIndexMethod,
    "hillshade": HillshadeMethod,
    "custom": CustomMethod,
}


def get_method(name: str) -> ShadowMethod:
    cls = METHOD_REGISTRY.get(name)
    if cls is None:
        raise ValueError(f"Unknown shadow method: {name!r}. Available: {sorted(METHOD_REGISTRY)}")
    return cls()


def generate_shadow(raw: np.ndarray, method: str, params: dict[str, Any] | None = None) -> np.ndarray:
    """Convenience entry point: dispatch to the named method."""
    return get_method(method).generate(raw, params or {})


def list_presets() -> dict[str, dict[str, Any]]:
    """Return built-in named presets (method + params), for the
    `/shadow/presets` endpoint's built-in seed list."""
    return {
        "Shadow": {
            "method": "percentile_arcsinh_gamma_balance",
            "params": {
                "asinh_k": PRESET_SHADOW.asinh_k,
                "low_pct": PRESET_SHADOW.low_pct,
                "high_pct": PRESET_SHADOW.high_pct,
                "desaturation": PRESET_SHADOW.desaturation,
                "gamma": PRESET_SHADOW.gamma,
                "apply_balance": PRESET_SHADOW.apply_balance,
            },
        },
        "Brut": {
            "method": "percentile_arcsinh_gamma_balance",
            "params": {
                "asinh_k": PRESET_BRUT.asinh_k,
                "low_pct": PRESET_BRUT.low_pct,
                "high_pct": PRESET_BRUT.high_pct,
                "desaturation": PRESET_BRUT.desaturation,
                "gamma": PRESET_BRUT.gamma,
                "apply_balance": PRESET_BRUT.apply_balance,
            },
        },
    }
