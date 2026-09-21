"""Border contour computation with incremental bounding-box caching.

Ported/generalized from the reference tool's
``_draw_analytical_contours`` (``Utils/mask_editor_ui_components.py``): the
reference implementation drew antialiased contour lines with a per-pixel
Python double loop over class transitions, once per frame (on a 2x
supersampled PIL canvas). Here contour computation is:

- Backend-side, vectorized (no per-pixel Python loop): boundary pixels are
  found via shifted-array comparisons (``classes[:, :-1] != classes[:, 1:]``
  etc.), matching the reference's "true class transition" definition of a
  border rather than a dilated mask ("ultra-thin, non-dilated" per plan
  section 6).
- Computed once per mask change (not once per render frame) and cached,
  with incremental recomputation restricted to the bounding box of the
  changed region when a ``change_bbox`` is supplied.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

BBox = tuple[int, int, int, int]  # (y0, x0, y1, x1), half-open


def compute_contour_mask(classes: np.ndarray) -> np.ndarray:
    """Vectorized ultra-thin (non-dilated) border mask: True where the pixel
    differs from its right or bottom neighbor (matches the reference tool's
    "true class transition" definition)."""
    h, w = classes.shape
    contour = np.zeros((h, w), dtype=bool)

    if w > 1:
        diff_h = classes[:, :-1] != classes[:, 1:]
        contour[:, :-1] |= diff_h
        contour[:, 1:] |= diff_h

    if h > 1:
        diff_v = classes[:-1, :] != classes[1:, :]
        contour[:-1, :] |= diff_v
        contour[1:, :] |= diff_v

    return contour


def _expand_bbox(bbox: BBox, shape: tuple[int, int], margin: int = 1) -> BBox:
    h, w = shape
    y0, x0, y1, x1 = bbox
    return (
        max(0, y0 - margin),
        max(0, x0 - margin),
        min(h, y1 + margin),
        min(w, x1 + margin),
    )


def bbox_from_change_mask(change_mask: np.ndarray) -> BBox | None:
    """Compute the tight bounding box of True values in a boolean mask."""
    rows = np.any(change_mask, axis=1)
    if not rows.any():
        return None
    cols = np.any(change_mask, axis=0)
    y0, y1 = np.where(rows)[0][[0, -1]]
    x0, x1 = np.where(cols)[0][[0, -1]]
    return (int(y0), int(x0), int(y1) + 1, int(x1) + 1)


@dataclass
class ContourCache:
    """Caches a full-frame contour mask and updates it incrementally by
    recomputing only within the bounding box of changed regions (expanded
    by 1px margin so transitions at the bbox edge are recomputed
    correctly)."""

    shape: tuple[int, int] | None = None
    contour_mask: np.ndarray | None = None

    def invalidate(self) -> None:
        self.shape = None
        self.contour_mask = None

    def get_or_compute(self, classes: np.ndarray) -> np.ndarray:
        """Return the full contour mask, computing from scratch if the cache
        is empty or shape-mismatched."""
        if self.contour_mask is None or self.shape != classes.shape:
            self.contour_mask = compute_contour_mask(classes)
            self.shape = classes.shape
        return self.contour_mask

    def update(self, classes: np.ndarray, change_bbox: BBox | None) -> np.ndarray:
        """Incrementally update the cached contour mask given the bbox of a
        recent mask edit. Falls back to a full recompute if there is no
        cache yet or the shape changed."""
        if self.contour_mask is None or self.shape != classes.shape:
            return self.get_or_compute(classes)

        if change_bbox is None:
            return self.contour_mask

        y0, x0, y1, x1 = _expand_bbox(change_bbox, classes.shape, margin=1)
        if y0 >= y1 or x0 >= x1:
            return self.contour_mask

        sub_classes = classes[y0:y1, x0:x1]
        sub_contour = compute_contour_mask(sub_classes)
        self.contour_mask[y0:y1, x0:x1] = sub_contour
        return self.contour_mask


def render_contour_overlay(
    img_rgb: np.ndarray,
    contour_mask: np.ndarray,
    color: tuple[int, int, int] = (255, 0, 0),
    alpha: float = 0.5,
) -> np.ndarray:
    """Alpha-blend a contour mask onto an RGB image (vectorized)."""
    if img_rgb.shape[:2] != contour_mask.shape:
        raise ValueError("img_rgb and contour_mask shape mismatch")

    out = img_rgb.astype(np.float32).copy()
    color_arr = np.array(color, dtype=np.float32)
    out[contour_mask] = out[contour_mask] * (1 - alpha) + color_arr * alpha
    return np.clip(out, 0, 255).astype(np.uint8)
