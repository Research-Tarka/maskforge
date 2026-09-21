from __future__ import annotations

import numpy as np

from maskforge_core.contours import (
    ContourCache,
    bbox_from_change_mask,
    compute_contour_mask,
    render_contour_overlay,
)


class TestComputeContourMask:
    def test_uniform_array_has_no_contour(self):
        classes = np.zeros((10, 10), dtype=np.uint8)
        contour = compute_contour_mask(classes)
        assert not contour.any()

    def test_vertical_split_produces_thin_border(self):
        classes = np.zeros((5, 6), dtype=np.uint8)
        classes[:, 3:] = 1
        contour = compute_contour_mask(classes)
        # Border should be at columns 2 and 3 (one pixel each side of the
        # transition), non-dilated (ultra-thin).
        assert contour[:, 2].all()
        assert contour[:, 3].all()
        assert not contour[:, 0].any()
        assert not contour[:, 5].any()

    def test_single_pixel_class_produces_ring(self):
        classes = np.zeros((7, 7), dtype=np.uint8)
        classes[3, 3] = 9
        contour = compute_contour_mask(classes)
        assert contour[3, 3]
        assert contour[2, 3]
        assert contour[4, 3]
        assert contour[3, 2]
        assert contour[3, 4]
        assert not contour[0, 0]


class TestBboxFromChangeMask:
    def test_returns_tight_bbox(self):
        mask = np.zeros((10, 10), dtype=bool)
        mask[2:5, 3:7] = True
        bbox = bbox_from_change_mask(mask)
        assert bbox == (2, 3, 5, 7)

    def test_empty_mask_returns_none(self):
        mask = np.zeros((10, 10), dtype=bool)
        assert bbox_from_change_mask(mask) is None


class TestContourCache:
    def test_get_or_compute_matches_full_recompute(self):
        classes = np.zeros((10, 10), dtype=np.uint8)
        classes[:, 5:] = 1
        cache = ContourCache()
        cached = cache.get_or_compute(classes)
        full = compute_contour_mask(classes)
        np.testing.assert_array_equal(cached, full)

    def test_incremental_update_matches_full_recompute(self):
        classes = np.zeros((20, 20), dtype=np.uint8)
        classes[:, 10:] = 1
        cache = ContourCache()
        cache.get_or_compute(classes)

        # Edit a small region and update incrementally.
        classes[2:5, 2:5] = 2
        bbox = (2, 2, 5, 5)
        updated = cache.update(classes, bbox)

        full = compute_contour_mask(classes)
        np.testing.assert_array_equal(updated, full)

    def test_update_without_bbox_returns_cached_untouched(self):
        classes = np.zeros((10, 10), dtype=np.uint8)
        cache = ContourCache()
        cache.get_or_compute(classes)
        result = cache.update(classes, None)
        np.testing.assert_array_equal(result, cache.contour_mask)

    def test_invalidate_forces_recompute(self):
        classes = np.zeros((10, 10), dtype=np.uint8)
        cache = ContourCache()
        cache.get_or_compute(classes)
        cache.invalidate()
        assert cache.contour_mask is None

    def test_shape_change_triggers_full_recompute(self):
        cache = ContourCache()
        cache.get_or_compute(np.zeros((5, 5), dtype=np.uint8))
        new_classes = np.zeros((8, 8), dtype=np.uint8)
        new_classes[:, 4:] = 1
        result = cache.get_or_compute(new_classes)
        assert result.shape == (8, 8)


class TestRenderContourOverlay:
    def test_blends_color_at_contour_pixels(self):
        img = np.full((4, 4, 3), 100, dtype=np.uint8)
        contour = np.zeros((4, 4), dtype=bool)
        contour[1, 1] = True
        out = render_contour_overlay(img, contour, color=(255, 0, 0), alpha=1.0)
        np.testing.assert_array_equal(out[1, 1], [255, 0, 0])
        np.testing.assert_array_equal(out[0, 0], [100, 100, 100])

    def test_shape_mismatch_raises(self):
        img = np.zeros((4, 4, 3), dtype=np.uint8)
        contour = np.zeros((3, 3), dtype=bool)
        try:
            render_contour_overlay(img, contour)
            assert False, "expected ValueError"
        except ValueError:
            pass
