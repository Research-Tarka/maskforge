from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from maskforge_core.plugins.zarr_reader import parse_composite_path
from maskforge_core.scene_discovery import DiscoveryConfig, ScanRule, discover_scenes


def _touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x00")


@pytest.fixture
def scene_tree(tmp_path: Path) -> Path:
    root = tmp_path / "scenes"
    _touch(root / "glacierA" / "2020" / "sceneA1" / "raw_image.tif")
    _touch(root / "glacierA" / "2020" / "sceneA1" / "shadow_image.tif")
    _touch(root / "glacierA" / "2021" / "sceneA2" / "raw_image.tif")
    _touch(root / "glacierA" / "2021" / "sceneA2" / "mask_image.tif")
    _touch(root / "glacierB" / "2020" / "sceneB1" / "raw_image.tif")
    _touch(root / "excluded_dir" / "raw_image.tif")
    # a directory with no matching files at all
    (root / "empty_dir").mkdir(parents=True, exist_ok=True)
    return root


def _default_rule() -> ScanRule:
    return ScanRule(
        name="generic",
        raw_patterns=["raw*"],
        shadow_patterns=["shadow*"],
        mask_patterns=["mask*"],
        max_depth=6,
        file_extensions=[".tif"],
    )


class TestDiscoverScenes:
    def test_finds_all_scene_dirs(self, scene_tree: Path):
        cfg = DiscoveryConfig(source_root=str(scene_tree), scan_rule=_default_rule())
        entries = discover_scenes(cfg)
        ids = {e.id for e in entries}
        assert "sceneA1" in ids
        assert "sceneA2" in ids
        assert "sceneB1" in ids

    def test_detects_raw_shadow_mask_paths(self, scene_tree: Path):
        cfg = DiscoveryConfig(source_root=str(scene_tree), scan_rule=_default_rule())
        entries = {e.id: e for e in discover_scenes(cfg)}

        a1 = entries["sceneA1"]
        assert a1.raw_path is not None and "raw_image" in a1.raw_path
        assert a1.shadow_path is not None and "shadow_image" in a1.shadow_path
        assert a1.mask_path is None
        assert a1.mode == "annotate"

        a2 = entries["sceneA2"]
        assert a2.mask_path is not None
        assert a2.mode == "review"

    def test_exclude_globs(self, scene_tree: Path):
        cfg = DiscoveryConfig(
            source_root=str(scene_tree),
            scan_rule=_default_rule(),
            exclude_globs=["*excluded_dir*"],
        )
        entries = discover_scenes(cfg)
        ids = {e.id for e in entries}
        assert "excluded_dir" not in ids

    def test_empty_dirs_ignored(self, scene_tree: Path):
        cfg = DiscoveryConfig(source_root=str(scene_tree), scan_rule=_default_rule())
        entries = discover_scenes(cfg)
        ids = {e.id for e in entries}
        assert "empty_dir" not in ids

    def test_nonexistent_root_returns_empty(self, tmp_path: Path):
        cfg = DiscoveryConfig(source_root=str(tmp_path / "nope"), scan_rule=_default_rule())
        assert discover_scenes(cfg) == []

    def test_max_depth_limits_scan(self, scene_tree: Path):
        rule = _default_rule()
        rule.max_depth = 1  # root -> glacierA/glacierB only, won't reach scene dirs
        cfg = DiscoveryConfig(source_root=str(scene_tree), scan_rule=rule)
        entries = discover_scenes(cfg)
        ids = {e.id for e in entries}
        assert "sceneA1" not in ids

    def test_configurable_patterns_not_hardcoded(self, tmp_path: Path):
        # A totally different naming convention than raw/shadow/mask should
        # still work purely via configured glob patterns.
        root = tmp_path / "custom"
        _touch(root / "sceneX" / "input_band.tif")
        _touch(root / "sceneX" / "label_annotation.tif")
        rule = ScanRule(
            name="custom",
            raw_patterns=["input_*"],
            shadow_patterns=[],
            mask_patterns=["label_*"],
            max_depth=3,
            file_extensions=[".tif"],
        )
        cfg = DiscoveryConfig(source_root=str(root), scan_rule=rule)
        entries = {e.id: e for e in discover_scenes(cfg)}
        assert "sceneX" in entries
        assert entries["sceneX"].raw_path is not None
        assert entries["sceneX"].mask_path is not None

    def test_scan_rule_round_trip_dict(self):
        rule = _default_rule()
        d = rule.to_dict()
        back = ScanRule.from_dict(d)
        assert back.name == rule.name
        assert back.raw_patterns == rule.raw_patterns

    def test_discovery_config_round_trip_dict(self, scene_tree: Path):
        cfg = DiscoveryConfig(source_root=str(scene_tree), scan_rule=_default_rule())
        d = cfg.to_dict()
        back = DiscoveryConfig.from_dict(d)
        assert back.source_root == cfg.source_root
        assert back.scan_rule.name == cfg.scan_rule.name


class TestScanRuleAcceptsZarrStores:
    def test_default_rule_does_not_opt_in(self):
        assert _default_rule().accepts_zarr_stores() is False

    def test_zarr_extension_opts_in(self):
        rule = _default_rule()
        rule.file_extensions = [*rule.file_extensions, ".zarr"]
        assert rule.accepts_zarr_stores() is True


@pytest.fixture
def zarr_tile_store(tmp_path: Path):
    zarr = pytest.importorskip("zarr")
    root = tmp_path / "tiles"
    store_path = root / "T001.zarr"

    height, width = 8, 6
    scene_ids = ["LC08_001_20200101", "LC08_001_20200201"]
    band_names = ["B2", "B3", "B4"]
    rng = np.random.default_rng(0)

    store = zarr.open_group(str(store_path), mode="a")
    grp = store.require_group("l8")
    grp.create_dataset(
        "toa",
        data=rng.integers(0, 10000, size=(2, 3, height, width), dtype=np.uint16),
        chunks=(1, 3, height, width),
    )
    grp.create_dataset(
        "rgb_raw",
        data=rng.integers(0, 255, size=(2, 3, height, width), dtype=np.uint8),
        chunks=(1, 3, height, width),
    )
    grp.create_dataset(
        "rgb_shadow",
        data=rng.integers(0, 255, size=(2, 3, height, width), dtype=np.uint8),
        chunks=(1, 3, height, width),
    )
    grp.attrs["scene_ids"] = scene_ids
    grp.attrs["band_names"] = band_names
    grp.attrs["crs_wkt"] = 'PROJCS["WGS 84 / UTM zone 11N",...]'
    grp.attrs["transform"] = [30.0, 0.0, 500000.0, 0.0, -30.0, 6200000.0]
    return root, store_path, scene_ids


class TestDiscoverScenesWithZarrStores:
    def _zarr_rule(self) -> ScanRule:
        rule = _default_rule()
        rule.file_extensions = [*rule.file_extensions, ".zarr"]
        return rule

    def test_zarr_store_not_scanned_unless_rule_opts_in(self, zarr_tile_store):
        root, _store_path, _scene_ids = zarr_tile_store
        cfg = DiscoveryConfig(source_root=str(root), scan_rule=_default_rule())
        entries = discover_scenes(cfg)
        assert entries == []

    def test_zarr_store_expands_to_one_scene_per_sensor_scene_pair(self, zarr_tile_store):
        root, _store_path, scene_ids = zarr_tile_store
        cfg = DiscoveryConfig(source_root=str(root), scan_rule=self._zarr_rule())
        entries = discover_scenes(cfg)

        assert len(entries) == len(scene_ids)
        ids = {e.id for e in entries}
        for scene_id in scene_ids:
            assert f"T001_l8_{scene_id}" in ids

    def test_zarr_scene_entry_composite_paths_are_addressable(self, zarr_tile_store):
        root, store_path, scene_ids = zarr_tile_store
        cfg = DiscoveryConfig(source_root=str(root), scan_rule=self._zarr_rule())
        entries = {e.id: e for e in discover_scenes(cfg)}

        entry = entries[f"T001_l8_{scene_ids[0]}"]
        assert entry.raw_path is not None
        assert entry.shadow_path is not None
        assert entry.mask_path is None
        assert entry.mode == "annotate"

        parsed_store, sensor, scene_ref, view = parse_composite_path(entry.raw_path)
        assert parsed_store == store_path
        assert sensor == "l8"
        assert scene_ref == scene_ids[0]
        assert view == "rgb_raw"

    def test_zarr_store_not_recursed_into(self, zarr_tile_store):
        # The internal .zarr/l8/toa/... chunk directories must never be
        # misidentified as their own scene directories.
        root, _store_path, scene_ids = zarr_tile_store
        cfg = DiscoveryConfig(source_root=str(root), scan_rule=self._zarr_rule())
        entries = discover_scenes(cfg)
        ids = {e.id for e in entries}
        assert "toa" not in ids
        assert "l8" not in ids

    def test_zarr_detected_resolution_from_transform(self, zarr_tile_store):
        root, _store_path, scene_ids = zarr_tile_store
        cfg = DiscoveryConfig(source_root=str(root), scan_rule=self._zarr_rule())
        entries = {e.id: e for e in discover_scenes(cfg)}
        entry = entries[f"T001_l8_{scene_ids[0]}"]
        assert entry.detected_resolution == pytest.approx((30.0, 30.0))
        assert entry.detected_crs is not None and entry.detected_crs.startswith("PROJCS")
