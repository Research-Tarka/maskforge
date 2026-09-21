from __future__ import annotations

import time

import numpy as np
import pytest

from maskforge_core.tools import AutoFillTool, BrushTool, BucketTool, PolygonTool


def _naive_brush_stamp(classes: np.ndarray, x: int, y: int, size: int, target_val: int) -> None:
    """Reference (intentionally naive) per-pixel loop implementation, used
    only to verify the vectorized BrushTool produces identical results."""
    h, w = classes.shape
    if size == 1:
        if 0 <= x < w and 0 <= y < h:
            classes[y, x] = target_val
        return
    radius = size // 2
    for yy in range(max(0, y - radius), min(h, y + radius + 1)):
        for xx in range(max(0, x - radius), min(w, x + radius + 1)):
            if (xx - x) ** 2 + (yy - y) ** 2 <= radius * radius:
                classes[yy, xx] = target_val


class TestBrushTool:
    def test_single_pixel_stamp(self):
        classes = np.zeros((10, 10), dtype=np.uint8)
        brush = BrushTool(size=1)
        result = brush.apply(classes, target_val=5, points=[(3, 3)])
        assert result is not None
        change_mask, prev_values = result
        assert classes[3, 3] == 5
        assert change_mask.sum() == 1
        assert prev_values[0] == 0

    def test_disk_stamp_matches_naive_reference(self):
        rng = np.random.default_rng(0)
        for size in (3, 5, 8, 11):
            classes_vec = rng.integers(0, 3, size=(30, 30)).astype(np.uint8)
            classes_naive = classes_vec.copy()

            x, y = 15, 14
            brush = BrushTool(size=size)
            brush.apply(classes_vec, target_val=9, points=[(x, y)])
            _naive_brush_stamp(classes_naive, x, y, size, target_val=9)

            np.testing.assert_array_equal(classes_vec, classes_naive)

    def test_stroke_interpolation_no_gaps(self):
        classes = np.zeros((50, 50), dtype=np.uint8)
        brush = BrushTool(size=1)
        # A long diagonal stroke; every intermediate pixel should be painted
        # (no holes), proving interpolation works without a manual per-step
        # Python paint call from the caller.
        result = brush.apply(classes, target_val=1, points=[(0, 0), (40, 40)])
        assert result is not None
        diag_vals = [classes[i, i] for i in range(41)]
        assert all(v == 1 for v in diag_vals)

    def test_brush_clips_at_boundary(self):
        classes = np.zeros((10, 10), dtype=np.uint8)
        brush = BrushTool(size=7)
        result = brush.apply(classes, target_val=1, points=[(0, 0)])
        assert result is not None
        assert classes.shape == (10, 10)  # no out-of-bounds crash

    def test_large_brush_radius_50_performance(self):
        """Sanity proxy for vectorization: a brush radius of 50px (size=101)
        must complete well under a second. A naive Python double-loop over
        ~8000 pixels would still be fast in isolation, so we stress it
        further with a full-stroke path across a large canvas to make any
        per-pixel Python overhead show up clearly."""
        classes = np.zeros((2000, 2000), dtype=np.uint8)
        brush = BrushTool(size=101, max_size=200)  # radius 50

        start = time.perf_counter()
        result = brush.apply(classes, target_val=3, points=[(1000, 1000)])
        elapsed = time.perf_counter() - start

        assert result is not None
        assert elapsed < 1.0, f"Brush stamp took {elapsed:.3f}s, expected well under 1s"

    def test_large_brush_stroke_performance(self):
        """A dragged stroke (many stamps) with a large brush should still be
        fast — this exercises the per-point stamping loop at scale."""
        classes = np.zeros((1500, 1500), dtype=np.uint8)
        brush = BrushTool(size=61, max_size=200)  # radius 30
        points = [(x, x) for x in range(0, 1400, 5)]  # ~280 stamps

        start = time.perf_counter()
        result = brush.apply(classes, target_val=2, points=points)
        elapsed = time.perf_counter() - start

        assert result is not None
        assert elapsed < 1.5, f"Brush stroke took {elapsed:.3f}s, expected well under 1.5s"


class TestBucketTool:
    def test_flood_fill_connected_region(self):
        classes = np.zeros((10, 10), dtype=np.uint8)
        classes[2:8, 2:8] = 1
        bucket = BucketTool()
        result = bucket.apply(classes, target_val=9, x=4, y=4)
        assert result is not None
        change_mask, prev_values = result
        assert (classes[2:8, 2:8] == 9).all()
        assert change_mask.sum() == 36
        assert (prev_values == 1).all()

    def test_does_not_cross_different_value(self):
        classes = np.array(
            [
                [1, 1, 2],
                [1, 1, 2],
                [2, 2, 2],
            ],
            dtype=np.uint8,
        )
        bucket = BucketTool()
        result = bucket.apply(classes, target_val=5, x=0, y=0)
        assert result is not None
        change_mask, _ = result
        expected = np.array([[True, True, False], [True, True, False], [False, False, False]])
        np.testing.assert_array_equal(change_mask, expected)

    def test_no_op_when_already_target(self):
        classes = np.full((5, 5), 3, dtype=np.uint8)
        bucket = BucketTool()
        result = bucket.apply(classes, target_val=3, x=2, y=2)
        assert result is None

    def test_blocked_mask_stops_fill(self):
        classes = np.zeros((5, 5), dtype=np.uint8)
        blocked = np.zeros((5, 5), dtype=bool)
        blocked[:, 2] = True  # vertical wall
        bucket = BucketTool()
        result = bucket.apply(classes, target_val=1, x=0, y=0, blocked_mask=blocked)
        assert result is not None
        change_mask, _ = result
        assert not change_mask[:, 3:].any()  # fill did not cross the wall

    def test_out_of_bounds_seed_returns_none(self):
        classes = np.zeros((5, 5), dtype=np.uint8)
        bucket = BucketTool()
        assert bucket.apply(classes, target_val=1, x=99, y=99) is None

    def test_bucket_large_region_performance(self):
        classes = np.zeros((2000, 2000), dtype=np.uint8)
        bucket = BucketTool()
        start = time.perf_counter()
        result = bucket.apply(classes, target_val=1, x=1000, y=1000)
        elapsed = time.perf_counter() - start
        assert result is not None
        assert elapsed < 1.0


class TestPolygonTool:
    def test_fills_triangle(self):
        classes = np.zeros((20, 20), dtype=np.uint8)
        tool = PolygonTool()
        points = [(2, 2), (2, 10), (10, 2), (2, 2)]
        result = tool.apply(classes, target_val=4, points=points)
        assert result is not None
        change_mask, _ = result
        assert change_mask.sum() > 0
        assert (classes[change_mask] == 4).all()

    def test_too_few_points_returns_none(self):
        classes = np.zeros((10, 10), dtype=np.uint8)
        tool = PolygonTool()
        result = tool.apply(classes, target_val=1, points=[(1, 1), (2, 2)])
        assert result is None

    def test_source_vals_filter(self):
        classes = np.zeros((10, 10), dtype=np.uint8)
        classes[5, 5] = 7  # a pixel with a "protected" value
        tool = PolygonTool()
        points = [(0, 0), (0, 9), (9, 9), (9, 0), (0, 0)]
        result = tool.apply(classes, target_val=1, points=points, source_vals={0})
        assert result is not None
        assert classes[5, 5] == 7  # untouched, not in source_vals


class TestAutoFillTool:
    def test_fills_every_nodata_pixel(self):
        classes = np.full((10, 10), 255, dtype=np.uint8)
        classes[2:5, 2:5] = 3  # already painted -- must stay untouched

        tool = AutoFillTool()
        result = tool.apply(classes, target_val=6)
        assert result is not None
        change_mask, _ = result
        assert change_mask.sum() == 100 - 9
        assert not change_mask[2:5, 2:5].any()
        assert classes[0, 0] == 6
        assert (classes[2:5, 2:5] == 3).all()

    def test_no_nodata_pixels_returns_none(self):
        classes = np.zeros((10, 10), dtype=np.uint8)
        tool = AutoFillTool()
        assert tool.apply(classes, target_val=6) is None
