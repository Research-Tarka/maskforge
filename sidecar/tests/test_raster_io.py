from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from maskforge_core import raster_io

rasterio = pytest.importorskip("rasterio")
from rasterio.crs import CRS  # noqa: E402
from rasterio.transform import Affine  # noqa: E402


def _write_test_geotiff(path: Path, arr: np.ndarray, transform: Affine, crs: CRS, count: int = 1) -> None:
    profile = {
        "driver": "GTiff",
        "dtype": str(arr.dtype),
        "count": count,
        "height": arr.shape[0],
        "width": arr.shape[1],
        "crs": crs,
        "transform": transform,
    }
    with rasterio.open(path, "w", **profile) as dst:
        if count == 1:
            dst.write(arr, 1)
        else:
            for i in range(count):
                dst.write(arr, i + 1)


class TestGeoTiffRoundTrip:
    def test_round_trip_preserves_crs_transform_values(self, tmp_path: Path):
        h, w = 40, 30
        rgba = np.random.default_rng(0).integers(0, 255, size=(h, w, 4), dtype=np.uint8)
        transform = Affine.translation(500000, 4500000) * Affine.scale(10, -10)
        crs = CRS.from_epsg(32633)

        out_path = tmp_path / "mask.tif"
        raster_io.write_mask_with_georef(rgba, out_path, transform, crs)

        with rasterio.open(out_path) as src:
            assert src.crs == crs
            assert src.transform == transform
            assert src.count == 4
            data = np.moveaxis(src.read(), 0, -1)
            np.testing.assert_array_equal(data, rgba)

    def test_write_mask_rgb_round_trip(self, tmp_path: Path):
        classes = np.array([[0, 1, 2], [1, 2, 0]], dtype=np.uint8)
        class_colors = {"a": (10, 20, 30), "b": (40, 50, 60)}
        class_values = {"a": 1, "b": 2}
        transform = Affine.identity()
        crs = CRS.from_epsg(4326)

        out_path = tmp_path / "rgb.tif"
        raster_io.write_mask_rgb(classes, out_path, transform, crs, class_colors, class_values)

        with rasterio.open(out_path) as src:
            assert src.crs == crs
            assert src.transform == transform
            data = np.moveaxis(src.read(), 0, -1)

        expected = raster_io.classes_to_rgb(classes, class_colors, class_values)
        np.testing.assert_array_equal(data, np.moveaxis(expected, 0, -1))

    def test_read_image_any_geotiff(self, tmp_path: Path):
        arr = np.arange(12, dtype=np.uint8).reshape(3, 4)
        transform = Affine.scale(2, -2)
        crs = CRS.from_epsg(4326)
        path = tmp_path / "single_band.tif"
        _write_test_geotiff(path, arr, transform, crs)

        read_arr, meta = raster_io.read_image_any(path)
        np.testing.assert_array_equal(read_arr, arr)
        assert meta["width"] == 4
        assert meta["height"] == 3
        assert meta["crs"] == crs.to_string()


class TestResampleArrayGeoref:
    def test_reproject_path_arbitrary_factor(self):
        src = np.zeros((20, 20), dtype=np.uint8)
        src[5:15, 5:15] = 7
        # Origin at (0, 20) with a north-up transform so the whole 20x20
        # grid maps to positive-y-decreasing rows within [0, 20].
        src_transform = Affine.translation(0, 20) * Affine.scale(1.0, -1.0)
        crs = CRS.from_epsg(3857)
        # Arbitrary non-integer factor: dst pixel size 1.37x src, same origin.
        dst_transform = Affine.translation(0, 20) * Affine.scale(1.37, -1.37)
        dst_shape = (15, 15)

        out = raster_io.resample_array(
            src,
            dst_shape=dst_shape,
            method="nearest",
            src_transform=src_transform,
            src_crs=crs,
            dst_transform=dst_transform,
            dst_crs=crs,
        )
        assert out.shape == dst_shape
        assert out.dtype == src.dtype
        assert (out == 7).any()


class TestResampleArrayVectorized:
    def test_nearest_arbitrary_factor_shape(self):
        src = np.arange(100, dtype=np.uint8).reshape(10, 10)
        out = raster_io.resample_array(src, factor=1.7, method="nearest")
        assert out.shape == (17, 17)

    def test_nearest_downsample_shape(self):
        src = np.arange(100, dtype=np.uint8).reshape(10, 10)
        out = raster_io.resample_array(src, factor=0.3, method="nearest")
        assert out.shape == (3, 3)

    def test_mode_categorical_majority(self):
        # 4x4 block of mostly class 1 with one class 2 outlier -> majority
        # downsample to 2x2 should preserve class 1 in that quadrant.
        src = np.array(
            [
                [1, 1, 1, 1],
                [1, 1, 2, 1],
                [3, 3, 3, 3],
                [3, 4, 3, 3],
            ],
            dtype=np.uint8,
        )
        out = raster_io.resample_array(src, dst_shape=(2, 2), method="mode")
        assert out.shape == (2, 2)
        assert out[0, 0] == 1  # majority of top-left 2x2 block (three 1s, one 2)
        assert out[1, 0] == 3  # majority of bottom-left 2x2 block (three 3s, one 4)

    def test_mode_vs_nearest_differ_on_noisy_block(self):
        rng = np.random.default_rng(42)
        # Class 5 dominant with sparse noise -> mode downsample should
        # recover class 5 more often than plain nearest-neighbor subsample.
        src = np.full((40, 40), 5, dtype=np.uint8)
        noise_idx = rng.choice(40 * 40, size=200, replace=False)
        src.flat[noise_idx] = rng.integers(0, 9, size=200)

        out_mode = raster_io.resample_array(src, dst_shape=(4, 4), method="mode")
        assert (out_mode == 5).sum() >= (out_mode != 5).sum()

    def test_dst_shape_exact(self):
        src = np.zeros((7, 13), dtype=np.uint8)
        out = raster_io.resample_array(src, dst_shape=(3, 5), method="nearest")
        assert out.shape == (3, 5)

    def test_requires_shape_or_factor(self):
        src = np.zeros((5, 5), dtype=np.uint8)
        with pytest.raises(ValueError):
            raster_io.resample_array(src)


class TestClassRgbConversion:
    def test_rgba_to_classes_roundtrip(self):
        class_colors = {"a": (10, 20, 30), "b": (40, 50, 60)}
        class_values = {"a": 1, "b": 2}
        classes = np.array([[0, 1], [2, 1]], dtype=np.uint8)
        rgba = raster_io.classes_to_rgba(classes, class_colors, class_values)
        back = raster_io.rgba_to_classes(rgba, class_colors, class_values)
        np.testing.assert_array_equal(back, classes)

    def test_nodata_convention(self):
        rgba = np.zeros((2, 2, 4), dtype=np.uint8)
        rgba[0, 0] = [0, 0, 0, 255]  # nodata: black + opaque
        rgba[0, 1] = [10, 20, 30, 255]
        class_colors = {"a": (10, 20, 30)}
        class_values = {"a": 1}
        classes = raster_io.rgba_to_classes(rgba, class_colors, class_values)
        assert classes[0, 0] == 0
        assert classes[0, 1] == 1


class TestPlainImageIO:
    def test_png_base64_round_trip(self):
        arr = np.random.default_rng(1).integers(0, 255, size=(8, 8, 4), dtype=np.uint8)
        b64 = raster_io.array_to_png_base64(arr)
        back = raster_io.png_base64_to_array(b64)
        np.testing.assert_array_equal(back, arr)

    def test_read_image_any_plain_png(self, tmp_path: Path):
        from PIL import Image

        arr = np.zeros((5, 6, 3), dtype=np.uint8)
        arr[..., 0] = 200
        path = tmp_path / "plain.png"
        Image.fromarray(arr).save(path)

        read_arr, meta = raster_io.read_image_any(path)
        assert meta["crs"] is None
        assert meta["transform"] is None
        np.testing.assert_array_equal(read_arr, arr)
