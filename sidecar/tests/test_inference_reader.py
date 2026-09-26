from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from maskforge_core.plugins import find_reader
from maskforge_core.plugins.inference_reader import (
    InferenceRasterReader,
    is_inference_path,
    register,
)


class TestIsInferencePath:
    def test_recognizes_class_map_npz(self):
        assert is_inference_path("some/dir/class_map.npz")

    def test_recognizes_inference_named_tif(self):
        assert is_inference_path("some/dir/inference_output.tif")

    def test_rejects_plain_npz_without_marker(self):
        assert not is_inference_path("some/dir/features.npz")

    def test_rejects_ordinary_geotiff(self):
        # Must not hijack ordinary raw/mask/RGB-composite GeoTIFF reads --
        # only a recognized filename marker plus a recognized suffix counts.
        assert not is_inference_path("some/dir/raw_image.tif")
        assert not is_inference_path("some/dir/mask.tif")

    def test_case_insensitive(self):
        assert is_inference_path("some/dir/CLASS_MAP.NPZ")


class TestInferenceRasterReaderNpz:
    def test_read_npz_round_trip(self, tmp_path: Path):
        class_map = np.array([[0, 1, 2], [1, 1, 255]], dtype=np.uint8)
        transform = (30.0, 0.0, 500000.0, 0.0, -30.0, 6200000.0)
        crs_wkt = 'PROJCS["WGS 84 / UTM zone 11N",...]'
        out_path = tmp_path / "class_map.npz"
        np.savez_compressed(
            out_path,
            class_map=class_map,
            transform=np.array(transform, dtype=np.float64),
            crs_wkt=np.array(crs_wkt),
            nodata=np.array(255, dtype=np.uint8),
        )

        reader = InferenceRasterReader()
        assert reader.can_read(out_path)
        arr, meta = reader.read(out_path)

        np.testing.assert_array_equal(arr, class_map)
        assert arr.dtype == np.uint8
        assert meta["width"] == 3
        assert meta["height"] == 2
        assert meta["nodata"] == 255
        assert meta["crs"] == crs_wkt
        assert meta["transform"] == transform

    def test_registered_via_find_reader(self, tmp_path: Path):
        register()
        class_map = np.zeros((2, 2), dtype=np.uint8)
        out_path = tmp_path / "class_map.npz"
        np.savez_compressed(
            out_path,
            class_map=class_map,
            transform=np.zeros(6, dtype=np.float64),
            crs_wkt=np.array(""),
            nodata=np.array(255, dtype=np.uint8),
        )
        found = find_reader(out_path)
        assert found is not None
        assert isinstance(found, InferenceRasterReader)


class TestInferenceRasterReaderGeoTiff:
    def test_read_geotiff(self, tmp_path: Path):
        rasterio = pytest.importorskip("rasterio")
        from rasterio.transform import Affine

        class_map = np.array([[0, 1], [2, 3]], dtype=np.uint8)
        out_path = tmp_path / "inference_class_map.tif"
        transform = Affine(30.0, 0.0, 500000.0, 0.0, -30.0, 6200000.0)
        with rasterio.open(
            out_path,
            "w",
            driver="GTiff",
            height=2,
            width=2,
            count=1,
            dtype="uint8",
            transform=transform,
            nodata=255,
        ) as dst:
            dst.write(class_map, 1)

        reader = InferenceRasterReader()
        assert reader.can_read(out_path)
        arr, meta = reader.read(out_path)

        np.testing.assert_array_equal(arr, class_map)
        assert meta["width"] == 2
        assert meta["height"] == 2
        assert meta["nodata"] == 255
