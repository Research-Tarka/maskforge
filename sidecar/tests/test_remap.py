from __future__ import annotations

import numpy as np

from maskforge_core.raster_io import classes_to_rgb


def _remap_rgb(rgb_hwc: np.ndarray, old_color, new_color, dry_run: bool):
    """Mirrors the vectorized remap logic used by
    api/routers/masks.py::remap_mask, isolated here for a pure unit test
    independent of the HTTP layer."""
    old = np.array(old_color, dtype=np.uint8)
    new = np.array(new_color, dtype=np.uint8)
    affected_mask = np.all(rgb_hwc == old, axis=-1)
    affected_pixels = int(affected_mask.sum())
    applied = False
    if not dry_run and affected_pixels > 0:
        out = rgb_hwc.copy()
        out[affected_mask] = new
        applied = True
        return out, affected_pixels, applied
    return rgb_hwc, affected_pixels, applied


class TestRemapDryRun:
    def test_dry_run_counts_without_applying(self):
        classes = np.array([[0, 1, 1], [1, 2, 0]], dtype=np.uint8)
        class_colors = {"a": (10, 20, 30), "b": (40, 50, 60)}
        class_values = {"a": 1, "b": 2}
        rgb = np.moveaxis(classes_to_rgb(classes, class_colors, class_values), 0, -1)

        out, affected, applied = _remap_rgb(rgb, (10, 20, 30), (99, 99, 99), dry_run=True)
        assert affected == 3  # three pixels with class 'a' color
        assert applied is False
        np.testing.assert_array_equal(out, rgb)  # unchanged

    def test_apply_changes_exactly_affected_pixels(self):
        classes = np.array([[0, 1, 1], [1, 2, 0]], dtype=np.uint8)
        class_colors = {"a": (10, 20, 30), "b": (40, 50, 60)}
        class_values = {"a": 1, "b": 2}
        rgb = np.moveaxis(classes_to_rgb(classes, class_colors, class_values), 0, -1)

        out, affected, applied = _remap_rgb(rgb, (10, 20, 30), (99, 99, 99), dry_run=False)
        assert affected == 3
        assert applied is True

        changed_mask = np.all(rgb == np.array((10, 20, 30)), axis=-1)
        assert (out[changed_mask] == np.array((99, 99, 99))).all()
        # Pixels not matching old_color remain untouched.
        untouched_mask = ~changed_mask
        np.testing.assert_array_equal(out[untouched_mask], rgb[untouched_mask])

    def test_no_matching_pixels(self):
        rgb = np.zeros((5, 5, 3), dtype=np.uint8)
        out, affected, applied = _remap_rgb(rgb, (200, 200, 200), (1, 1, 1), dry_run=False)
        assert affected == 0
        assert applied is False

    def test_vectorized_matches_naive_loop(self):
        rng = np.random.default_rng(3)
        rgb = rng.integers(0, 4, size=(20, 20, 3)).astype(np.uint8) * 50
        old_color = (0, 0, 0)

        # Naive reference count.
        naive_count = 0
        for y in range(rgb.shape[0]):
            for x in range(rgb.shape[1]):
                if tuple(rgb[y, x]) == old_color:
                    naive_count += 1

        _, affected, _ = _remap_rgb(rgb, old_color, (255, 255, 255), dry_run=True)
        assert affected == naive_count
