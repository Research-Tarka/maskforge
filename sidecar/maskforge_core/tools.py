"""Vectorized drawing tools for mask editing.

Ported/generalized from the reference ``Utils/canvas_tools.py``
(``DrawingTool``, ``ZoneTool``, ``BrushTool``, ``BucketTool``). The
interface ``DrawingTool.apply(classes, target_val, **kwargs) -> (change_mask,
prev_values) | None`` is preserved so undo/redo bookkeeping is identical in
shape to the reference tool.

Hard requirement: no Python-level per-pixel loops for brush/bucket.
- ``BrushTool._stamp`` uses pure NumPy sub-array slicing + boolean masking
  (a disk boolean mask is computed once per stroke and applied via
  ``np.where``/direct assignment on a sliced view), replacing the reference
  implementation's per-pixel ``for idx in idxs`` loop.
- ``BucketTool`` uses ``scipy.ndimage.label`` connected-component labeling
  (4-connectivity) to flood-fill the connected region containing the seed
  pixel, replacing the reference's Python stack-based flood fill.
- ``AutoFillTool`` is new: fills every still-empty (NODATA) pixel in the
  scene in one action, independent of click position.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

import numpy as np
from scipy import ndimage as ndi

try:
    from rasterio.features import rasterize as _rio_rasterize
    from rasterio.transform import Affine as _RioAffine

    RASTERIZE_AVAILABLE = True
except ImportError:  # pragma: no cover
    _rio_rasterize = None
    _RioAffine = None
    RASTERIZE_AVAILABLE = False

from shapely.geometry import Polygon

ToolResult = tuple[np.ndarray, np.ndarray] | None


class DrawingTool(ABC):
    """Abstract base class for all drawing tools."""

    @abstractmethod
    def apply(self, classes: np.ndarray, target_val: int, **kwargs: Any) -> ToolResult:
        """Apply the tool and return undo info.

        Args:
            classes: 2D array of class indices to modify (mutated in place
                for brush/bucket for performance; callers relying on
                immutability should pass a copy).
            target_val: Target class value.
            **kwargs: Tool-specific parameters.

        Returns:
            ``(change_mask, prev_values)`` where ``change_mask`` is a 2D
            boolean array and ``prev_values`` is a 1D array of the values
            at ``classes[change_mask]`` *before* the change, or ``None`` if
            nothing changed.
        """
        raise NotImplementedError


def _disk_mask(radius: int) -> np.ndarray:
    """Boolean circular disk mask of given radius (odd square, (2r+1, 2r+1))."""
    yy, xx = np.ogrid[-radius : radius + 1, -radius : radius + 1]
    return (xx * xx + yy * yy) <= radius * radius


class BrushTool(DrawingTool):
    """Circular brush, configurable size. Vectorized stamp (no per-pixel loop)."""

    def __init__(self, size: int = 1, max_size: int = 200):
        self.size = size
        self.max_size = max_size
        self.stroke_change_mask: np.ndarray | None = None
        self.stroke_prev_vals: np.ndarray | None = None
        self._classes_shape: tuple[int, int] | None = None

    def set_size(self, size: int) -> None:
        self.size = max(1, min(size, self.max_size))

    def start_stroke(self, classes: np.ndarray) -> None:
        self._classes_shape = classes.shape
        self.stroke_change_mask = np.zeros(classes.shape, dtype=bool)
        self.stroke_prev_vals = classes.copy()

    def _stamp(self, x: int, y: int, classes: np.ndarray, target_val: int) -> None:
        """Vectorized single-point stamp: numpy slicing + boolean mask only."""
        h, w = classes.shape

        if self.size == 1:
            if 0 <= x < w and 0 <= y < h:
                if self.stroke_change_mask is not None and not self.stroke_change_mask[y, x]:
                    self.stroke_change_mask[y, x] = True
                classes[y, x] = target_val
            return

        radius = self.size // 2
        disk = _disk_mask(radius)

        y0 = max(0, y - radius)
        x0 = max(0, x - radius)
        y1 = min(h, y + radius + 1)
        x1 = min(w, x + radius + 1)
        if y0 >= y1 or x0 >= x1:
            return

        disk_sub = disk[(y0 - (y - radius)) : (y1 - (y - radius)), (x0 - (x - radius)) : (x1 - (x - radius))]
        if not disk_sub.any():
            return

        region = classes[y0:y1, x0:x1]
        region[disk_sub] = target_val
        classes[y0:y1, x0:x1] = region

        if self.stroke_change_mask is not None:
            sub_mask = self.stroke_change_mask[y0:y1, x0:x1]
            sub_mask |= disk_sub
            self.stroke_change_mask[y0:y1, x0:x1] = sub_mask

    def paint(self, x: int, y: int, classes: np.ndarray, target_val: int) -> None:
        """Stamp at (x, y). Line interpolation between successive points is
        the caller's responsibility (pass a ``points`` list to ``apply``)."""
        self._stamp(x, y, classes, target_val)

    def finalize_stroke(self, classes: np.ndarray) -> ToolResult:
        if self.stroke_change_mask is None or not self.stroke_change_mask.any():
            self.stroke_change_mask = None
            self.stroke_prev_vals = None
            return None
        change_mask = self.stroke_change_mask
        prev_values = self.stroke_prev_vals[change_mask].copy()  # type: ignore[index]
        self.stroke_change_mask = None
        self.stroke_prev_vals = None
        return change_mask, prev_values

    def apply(self, classes: np.ndarray, target_val: int, **kwargs: Any) -> ToolResult:
        """Apply a full stroke given a list of (x, y) points (vectorized
        stamping per point; consecutive points are linearly interpolated
        using vectorized coordinate generation, not a per-pixel Python
        paint loop)."""
        points: list[tuple[int, int]] = kwargs.get("points", [])
        if not points:
            return None

        self.start_stroke(classes)

        all_x: list[int] = []
        all_y: list[int] = []
        prev_point: tuple[int, int] | None = None
        for x, y in points:
            if prev_point is None:
                all_x.append(x)
                all_y.append(y)
            else:
                x0, y0 = prev_point
                dx, dy = x - x0, y - y0
                steps = max(abs(dx), abs(dy))
                if steps <= 0:
                    all_x.append(x)
                    all_y.append(y)
                else:
                    t = np.arange(1, steps + 1) / steps
                    xs = np.round(x0 + dx * t).astype(int)
                    ys = np.round(y0 + dy * t).astype(int)
                    all_x.extend(xs.tolist())
                    all_y.extend(ys.tolist())
            prev_point = (x, y)

        for xi, yi in zip(all_x, all_y):
            self._stamp(xi, yi, classes, target_val)

        return self.finalize_stroke(classes)


class BucketTool(DrawingTool):
    """4-connected flood fill via ``scipy.ndimage.label`` (vectorized
    connected-component labeling), replacing the reference stack-based
    flood fill."""

    def apply(self, classes: np.ndarray, target_val: int, **kwargs: Any) -> ToolResult:
        x: int = kwargs["x"]
        y: int = kwargs["y"]
        blocked_mask: np.ndarray | None = kwargs.get("blocked_mask")
        connectivity: int = kwargs.get("connectivity", 4)

        h, w = classes.shape
        if not (0 <= x < w and 0 <= y < h):
            return None
        if blocked_mask is not None and blocked_mask[y, x]:
            return None

        target = int(classes[y, x])
        if target == target_val:
            return None

        same_value = classes == target
        if blocked_mask is not None:
            fillable = same_value & ~blocked_mask
        else:
            fillable = same_value

        structure = (
            ndi.generate_binary_structure(2, 1)
            if connectivity == 4
            else ndi.generate_binary_structure(2, 2)
        )
        labeled, _ = ndi.label(fillable, structure=structure)
        seed_label = labeled[y, x]
        if seed_label == 0:
            return None

        change_mask = labeled == seed_label
        if not change_mask.any():
            return None

        prev_values = classes[change_mask].copy()
        classes[change_mask] = target_val
        return change_mask, prev_values


class PolygonTool(DrawingTool):
    """Polygon fill via Shapely + ``rasterio.features.rasterize`` (vectorized
    scanline rasterization, no manual point-in-polygon pixel loop)."""

    def __init__(self) -> None:
        self.points: list[tuple[float, float]] = []

    def add_point(self, x: float, y: float) -> None:
        self.points.append((x, y))

    def close_polygon(self) -> None:
        if len(self.points) >= 3 and self.points[-1] != self.points[0]:
            self.points.append(self.points[0])

    def clear(self) -> None:
        self.points.clear()

    def apply(self, classes: np.ndarray, target_val: int, **kwargs: Any) -> ToolResult:
        points = kwargs.get("points", self.points)
        source_vals = kwargs.get("source_vals")

        if len(points) < 3:
            return None

        try:
            poly = Polygon(points)
            if not poly.is_valid or poly.area == 0:
                return None
        except Exception:
            return None

        h, w = classes.shape

        if RASTERIZE_AVAILABLE:
            mask = _rio_rasterize(
                [(poly, 1)],
                out_shape=(h, w),
                transform=_RioAffine.identity(),
                fill=0,
                dtype=np.uint8,
            ).astype(bool)
        else:  # pragma: no cover - rasterio always available in this project
            mask = _rasterize_polygon_fallback(poly, (h, w))

        if source_vals is not None:
            change_mask = mask & np.isin(classes, list(source_vals))
        else:
            change_mask = mask

        if not change_mask.any():
            return None

        prev_values = classes[change_mask].copy()
        classes[change_mask] = target_val
        return change_mask, prev_values


def _rasterize_polygon_fallback(poly: Polygon, shape: tuple[int, int]) -> np.ndarray:
    """Vectorized polygon rasterization fallback (matplotlib-free, numpy-only
    point-in-polygon over the full grid) used only if rasterio is absent."""
    h, w = shape
    minx, miny, maxx, maxy = poly.bounds
    y0 = max(0, int(np.floor(miny)))
    y1 = min(h, int(np.ceil(maxy)) + 1)
    x0 = max(0, int(np.floor(minx)))
    x1 = min(w, int(np.ceil(maxx)) + 1)
    mask = np.zeros((h, w), dtype=bool)
    if y0 >= y1 or x0 >= x1:
        return mask

    yy, xx = np.mgrid[y0:y1, x0:x1]
    from shapely import vectorized

    sub = vectorized.contains(poly, xx.astype(float) + 0.5, yy.astype(float) + 0.5)
    mask[y0:y1, x0:x1] = sub
    return mask


class AutoFillTool(DrawingTool):
    """Fills every still-empty (NODATA) pixel in the scene with the target
    class in one action, regardless of click position — a one-shot "fill
    what's left blank" rather than a seed-based flood fill. This is
    deliberately unlike ``BucketTool``/the old color-guided flood fill: it
    never touches pixels that already carry a class, and it isn't limited to
    the region connected to a click point."""

    def apply(self, classes: np.ndarray, target_val: int, **kwargs: Any) -> ToolResult:
        nodata_value: int = kwargs.get("nodata_value", 255)

        change_mask = classes == nodata_value
        if not change_mask.any():
            return None

        prev_values = classes[change_mask].copy()
        classes[change_mask] = target_val
        return change_mask, prev_values


TOOL_REGISTRY: dict[str, type[DrawingTool]] = {
    "brush": BrushTool,
    "bucket": BucketTool,
    "polygon": PolygonTool,
    "autofill": AutoFillTool,
}


def get_tool(name: str) -> DrawingTool:
    cls = TOOL_REGISTRY.get(name)
    if cls is None:
        raise ValueError(f"Unknown tool: {name!r}. Available: {sorted(TOOL_REGISTRY)}")
    return cls()
