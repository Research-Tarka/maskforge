from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

zarr = pytest.importorskip("zarr")

from maskforge_core import raster_io  # noqa: E402
from maskforge_core.plugins import find_reader, list_readers  # noqa: E402
from maskforge_core.plugins.zarr_reader import (  # noqa: E402
    ZarrAddressError,
    ZarrRasterReader,
    is_zarr_composite_path,
    make_composite_path,
    parse_composite_path,
    register,
    store_path_for,
)


def _write_synthetic_store(
    store_path: Path,
    sensor: str = "l8",
    scene_ids: list[str] | None = None,
    band_names: list[str] | None = None,
    height: int = 12,
    width: int = 10,
) -> None:
    """Build a tiny store matching moose_habitat_pipeline.scenes.zarr_store's
    schema: <tile>.zarr/<sensor>/{toa, rgb_raw, rgb_shadow} + attrs."""
    scene_ids = scene_ids or ["LC08_001_20200101", "LC08_001_20200201"]
    band_names = band_names or ["B2", "B3", "B4", "B5"]
    n_scenes = len(scene_ids)
    n_bands = len(band_names)

    rng = np.random.default_rng(42)
    toa = rng.integers(0, 10000, size=(n_scenes, n_bands, height, width), dtype=np.uint16)
    rgb_raw = rng.integers(0, 255, size=(n_scenes, 3, height, width), dtype=np.uint8)
    rgb_shadow = rng.integers(0, 255, size=(n_scenes, 3, height, width), dtype=np.uint8)

    store = zarr.open_group(str(store_path), mode="a")
    grp = store.require_group(sensor)
    grp.create_dataset("toa", data=toa, chunks=(1, n_bands, height, width))
    grp.create_dataset("rgb_raw", data=rgb_raw, chunks=(1, 3, height, width))
    grp.create_dataset("rgb_shadow", data=rgb_shadow, chunks=(1, 3, height, width))
    grp.attrs["scene_ids"] = scene_ids
    grp.attrs["band_names"] = band_names
    grp.attrs["crs_wkt"] = 'PROJCS["WGS 84 / UTM zone 11N",...]'
    grp.attrs["transform"] = [30.0, 0.0, 500000.0, 0.0, -30.0, 6200000.0]
    grp.attrs["nodata_value"] = 65535
    grp.attrs["scale_factor"] = 10000.0


@pytest.fixture
def synthetic_store(tmp_path: Path) -> Path:
    store_path = tmp_path / "T001.zarr"
    _write_synthetic_store(store_path)
    return store_path


class TestCompositePathAddressing:
    def test_make_and_parse_round_trip(self, tmp_path: Path):
        store = tmp_path / "T001.zarr"
        composite = make_composite_path(store, "l8", "LC08_001_20200101", "rgb_raw")
        parsed_store, sensor, scene_ref, view = parse_composite_path(composite)
        assert parsed_store == store
        assert sensor == "l8"
        assert scene_ref == "LC08_001_20200101"
        assert view == "rgb_raw"

    def test_make_and_parse_round_trip_with_index(self, tmp_path: Path):
        store = tmp_path / "T001.zarr"
        composite = make_composite_path(store, "l8", 0, "toa:B4,B3,B2")
        parsed_store, sensor, scene_ref, view = parse_composite_path(composite)
        assert scene_ref == "0"
        assert view == "toa:B4,B3,B2"

    def test_is_zarr_composite_path(self, tmp_path: Path):
        store = tmp_path / "T001.zarr"
        assert is_zarr_composite_path(make_composite_path(store, "l8", 0, "rgb_raw"))
        assert not is_zarr_composite_path(str(tmp_path / "scene" / "raw.tif"))
        assert not is_zarr_composite_path(str(store))  # bare store path, no '!' fragment

    def test_store_path_for_strips_fragment(self, tmp_path: Path):
        store = tmp_path / "T001.zarr"
        composite = make_composite_path(store, "l8", 0, "rgb_raw")
        assert store_path_for(composite) == store
        assert store_path_for(str(store)) == store

    def test_parse_rejects_malformed_path(self):
        with pytest.raises(ValueError):
            parse_composite_path("not_a_zarr_path.tif")
        with pytest.raises(ValueError):
            parse_composite_path("store.zarr!only_sensor")


class TestZarrRasterReaderCanRead:
    def test_can_read_composite_path(self, tmp_path: Path):
        reader = ZarrRasterReader()
        path = make_composite_path(tmp_path / "T001.zarr", "l8", 0, "rgb_raw")
        assert reader.can_read(Path(path)) is True

    def test_cannot_read_plain_tif(self):
        reader = ZarrRasterReader()
        assert reader.can_read(Path("scene/raw_image.tif")) is False


class TestZarrRasterReaderRead:
    def test_read_rgb_raw_by_index(self, synthetic_store: Path):
        reader = ZarrRasterReader()
        path = make_composite_path(synthetic_store, "l8", 0, "rgb_raw")
        arr, meta = reader.read(Path(path))

        assert arr.shape == (12, 10, 3)
        assert arr.dtype == np.uint8
        assert meta["width"] == 10
        assert meta["height"] == 12
        assert meta["sensor"] == "l8"
        assert meta["scene_id"] == "LC08_001_20200101"
        assert meta["scene_index"] == 0
        assert meta["crs"].startswith("PROJCS")
        assert meta["transform"] == (30.0, 0.0, 500000.0, 0.0, -30.0, 6200000.0)

    def test_read_rgb_shadow_by_scene_id(self, synthetic_store: Path):
        reader = ZarrRasterReader()
        path = make_composite_path(synthetic_store, "l8", "LC08_001_20200201", "rgb_shadow")
        arr, meta = reader.read(Path(path))

        assert arr.shape == (12, 10, 3)
        assert meta["scene_index"] == 1
        assert meta["scene_id"] == "LC08_001_20200201"

    def test_read_toa_band_combination_reorders_channels(self, synthetic_store: Path):
        reader = ZarrRasterReader()
        # band_names = [B2, B3, B4, B5]; request B4,B3,B2 (a false-color combo)
        # to confirm channel order follows the request, not storage order.
        path = make_composite_path(synthetic_store, "l8", 0, "toa:B4,B3,B2")
        arr, meta = reader.read(Path(path))

        assert arr.shape == (12, 10, 3)
        assert arr.dtype == np.uint16

        store = zarr.open_group(str(synthetic_store), mode="r")
        toa = np.asarray(store["l8"]["toa"][0])  # (4, H, W): B2,B3,B4,B5
        expected = np.stack([toa[2], toa[1], toa[0]], axis=-1)  # B4,B3,B2
        np.testing.assert_array_equal(arr, expected)

    def test_read_unknown_band_raises(self, synthetic_store: Path):
        reader = ZarrRasterReader()
        path = make_composite_path(synthetic_store, "l8", 0, "toa:B99")
        with pytest.raises(KeyError):
            reader.read(Path(path))

    def test_read_unknown_composite_raises(self, synthetic_store: Path):
        reader = ZarrRasterReader()
        path = make_composite_path(synthetic_store, "l8", 0, "not_a_real_view")
        with pytest.raises(ZarrAddressError):
            reader.read(Path(path))

    def test_read_unknown_sensor_raises(self, synthetic_store: Path):
        reader = ZarrRasterReader()
        path = make_composite_path(synthetic_store, "s2", 0, "rgb_raw")
        with pytest.raises(KeyError):
            reader.read(Path(path))

    def test_read_missing_store_raises(self, tmp_path: Path):
        reader = ZarrRasterReader()
        path = make_composite_path(tmp_path / "nope.zarr", "l8", 0, "rgb_raw")
        with pytest.raises(FileNotFoundError):
            reader.read(Path(path))

    def test_read_bad_scene_ref_raises(self, synthetic_store: Path):
        reader = ZarrRasterReader()
        path = make_composite_path(synthetic_store, "l8", "not_a_known_id", "rgb_raw")
        with pytest.raises(ZarrAddressError):
            reader.read(Path(path))


class TestPluginRegistryWiring:
    def test_register_adds_to_registry(self):
        register()
        assert "zarr" in list_readers()

    def test_find_reader_matches_composite_path(self, tmp_path: Path):
        register()
        path = make_composite_path(tmp_path / "T001.zarr", "l8", 0, "rgb_raw")
        reader = find_reader(Path(path))
        assert isinstance(reader, ZarrRasterReader)

    def test_find_reader_does_not_match_plain_tif(self):
        register()
        assert find_reader(Path("scene/raw_image.tif")) is None


class TestReadImageAnyDispatchesToPlugin:
    def test_read_image_any_reads_zarr_composite_path(self, synthetic_store: Path):
        register()
        path = make_composite_path(synthetic_store, "l8", 0, "rgb_raw")
        arr, meta = raster_io.read_image_any(path)
        assert arr.shape == (12, 10, 3)
        assert meta["sensor"] == "l8"

    def test_image_path_exists_true_for_existing_store(self, synthetic_store: Path):
        path = make_composite_path(synthetic_store, "l8", 0, "rgb_raw")
        assert raster_io.image_path_exists(path) is True

    def test_image_path_exists_false_for_missing_store(self, tmp_path: Path):
        path = make_composite_path(tmp_path / "nope.zarr", "l8", 0, "rgb_raw")
        assert raster_io.image_path_exists(path) is False

    def test_image_path_exists_still_works_for_plain_files(self, tmp_path: Path):
        real_file = tmp_path / "raw.tif"
        real_file.write_bytes(b"\x00")
        assert raster_io.image_path_exists(str(real_file)) is True
        assert raster_io.image_path_exists(str(tmp_path / "missing.tif")) is False
