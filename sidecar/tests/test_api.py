from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

rasterio = pytest.importorskip("rasterio")
from rasterio.crs import CRS  # noqa: E402
from rasterio.transform import Affine  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

from api import state as api_state  # noqa: E402
from api.server import app  # noqa: E402

API = "/api/v1"


@pytest.fixture(autouse=True)
def isolated_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Point the app's global AppState at a temp ~/.maskforge dir so tests
    never touch the real user home directory, and reset between tests."""
    home = tmp_path / ".maskforge"
    api_state.reset_state(home)
    yield
    api_state.reset_state(home)


@pytest.fixture
def client() -> TestClient:
    # Every route but /health requires the sidecar's per-launch auth token
    # (see api/server.py's require_auth_token middleware) — tests act as
    # the trusted Tauri shell, which is the only party that legitimately
    # knows this value, so it's fine to reach into the app module for it.
    from api.server import AUTH_TOKEN

    return TestClient(app, headers={"X-MaskForge-Token": AUTH_TOKEN})


@pytest.fixture
def scene_dir(tmp_path: Path) -> Path:
    root = tmp_path / "source"
    scene = root / "sceneA"
    scene.mkdir(parents=True)

    h, w = 32, 32
    transform = Affine.translation(100000, 5000000) * Affine.scale(10, -10)
    crs = CRS.from_epsg(32633)

    raw = np.random.default_rng(0).integers(0, 255, size=(3, h, w), dtype=np.uint8)
    raw_path = scene / "raw_image.tif"
    with rasterio.open(
        raw_path, "w", driver="GTiff", dtype="uint8", count=3, height=h, width=w, crs=crs, transform=transform
    ) as dst:
        dst.write(raw)

    return root


class TestHealth:
    def test_health_ok(self, client: TestClient):
        resp = client.get(f"{API}/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert "version" in body


class TestAuth:
    """Regression tests for the auth-token middleware: 127.0.0.1 is
    reachable by any local process/browser tab, not just this app, so
    every route but /health must reject requests lacking the correct
    per-launch token — this is what stands between "knows the port" and
    "can read/write files through the API"."""

    def test_health_does_not_require_token(self):
        unauthenticated = TestClient(app)
        resp = unauthenticated.get(f"{API}/health")
        assert resp.status_code == 200

    def test_request_without_token_is_rejected(self):
        unauthenticated = TestClient(app)
        resp = unauthenticated.get(f"{API}/sessions")
        assert resp.status_code == 401

    def test_request_with_wrong_token_is_rejected(self):
        wrong_token = TestClient(app, headers={"X-MaskForge-Token": "not-the-real-token"})
        resp = wrong_token.get(f"{API}/sessions")
        assert resp.status_code == 401

    def test_request_with_correct_token_succeeds(self, client: TestClient):
        resp = client.get(f"{API}/sessions")
        assert resp.status_code == 200


class TestSceneDiscoveryEndToEnd:
    def test_discover_scenes(self, client: TestClient, scene_dir: Path):
        body = {
            "source_root": str(scene_dir),
            "scan_rule": {
                "name": "test",
                "raw_patterns": ["raw*"],
                "shadow_patterns": ["shadow*"],
                "mask_patterns": ["mask*"],
                "max_depth": 3,
                "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        resp = client.post(f"{API}/scenes/discover", json=body)
        assert resp.status_code == 200
        scenes = resp.json()
        assert len(scenes) == 1
        assert scenes[0]["id"] == "sceneA"
        assert scenes[0]["mode"] == "annotate"
        assert scenes[0]["raw_path"] is not None

    def test_get_layers(self, client: TestClient, scene_dir: Path):
        body = {
            "source_root": str(scene_dir),
            "scan_rule": {
                "name": "test",
                "raw_patterns": ["raw*"],
                "shadow_patterns": [],
                "mask_patterns": [],
                "max_depth": 3,
                "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        resp = client.post(f"{API}/scenes/discover", json=body)
        scene_id = resp.json()[0]["id"]

        layers_resp = client.get(f"{API}/scenes/{scene_id}/layers")
        assert layers_resp.status_code == 200
        layers = layers_resp.json()
        assert layers["raw"] is not None
        assert layers["raw"]["width"] == 32
        assert layers["raw"]["height"] == 32
        assert layers["mask"] is None

    def test_layers_404_for_unknown_scene(self, client: TestClient):
        resp = client.get(f"{API}/scenes/does-not-exist/layers")
        assert resp.status_code == 404


class TestPaintSaveReload:
    def test_paint_via_tool_endpoint(self, client: TestClient, scene_dir: Path):
        discover_body = {
            "source_root": str(scene_dir),
            "scan_rule": {
                "name": "test",
                "raw_patterns": ["raw*"],
                "shadow_patterns": [],
                "mask_patterns": [],
                "max_depth": 3,
                "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        scene_id = scenes[0]["id"]

        tool_resp = client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "brush", "params": {"points": [[5, 5]], "size": 3}, "class_value": 2},
        )
        assert tool_resp.status_code == 200
        result = tool_resp.json()
        assert result["changed_pixels"] > 0
        assert result["bbox"] != [0, 0, 0, 0]

    def test_fill_all_sets_every_pixel(self, client: TestClient, scene_dir: Path):
        discover_body = {
            "source_root": str(scene_dir),
            "scan_rule": {
                "name": "test", "raw_patterns": ["raw*"], "shadow_patterns": [],
                "mask_patterns": [], "max_depth": 3, "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        scene_id = scenes[0]["id"]

        # Paint a small brush stroke first so fill_all has to overwrite
        # existing non-zero pixels too, not just the blank background.
        client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "brush", "params": {"points": [[5, 5]], "size": 3}, "class_value": 2},
        )

        resp = client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "fill_all", "params": {}, "class_value": 7},
        )
        assert resp.status_code == 200
        assert resp.json()["changed_pixels"] == 32 * 32

        stats = client.get(f"{API}/stats/{scene_id}").json()
        counts = {c["class_value"]: c["pixel_count"] for c in stats["classes"]}
        assert counts == {7: 32 * 32}

        # Calling it again with the same class is a no-op (nothing to change).
        resp2 = client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "fill_all", "params": {}, "class_value": 7},
        )
        assert resp2.json()["changed_pixels"] == 0

    def test_bucket_then_stats(self, client: TestClient, scene_dir: Path):
        discover_body = {
            "source_root": str(scene_dir),
            "scan_rule": {
                "name": "test",
                "raw_patterns": ["raw*"],
                "shadow_patterns": [],
                "mask_patterns": [],
                "max_depth": 3,
                "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        scene_id = scenes[0]["id"]

        # Bucket-fill whole (initially blank/class-0) buffer.
        bucket_resp = client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "bucket", "params": {"x": 0, "y": 0}, "class_value": 5},
        )
        assert bucket_resp.status_code == 200
        assert bucket_resp.json()["changed_pixels"] == 32 * 32

        stats_resp = client.get(f"{API}/stats/{scene_id}")
        assert stats_resp.status_code == 200
        stats = stats_resp.json()
        assert stats["total_pixels"] == 32 * 32
        assert any(c["class_value"] == 5 and c["pixel_count"] == 32 * 32 for c in stats["classes"])

    def test_save_and_reload_geotiff(self, client: TestClient, scene_dir: Path, tmp_path: Path):
        discover_body = {
            "source_root": str(scene_dir),
            "scan_rule": {
                "name": "test",
                "raw_patterns": ["raw*"],
                "shadow_patterns": [],
                "mask_patterns": [],
                "max_depth": 3,
                "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        scene_id = scenes[0]["id"]

        client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "bucket", "params": {"x": 0, "y": 0}, "class_value": 1},
        )

        out_root = tmp_path / "output"
        save_resp = client.post(
            f"{API}/masks/{scene_id}/save",
            json={
                "output_format": "geotiff_rgba",
                "output_root": str(out_root),
                "folder_structure_template": "{scene_id}/mask.tif",
                "copy_raw": False,
                "copy_shadow": False,
                "preserve_georef": True,
                "resolution_mode": "native",
                "target_resolution": None,
                "compress": "LZW",
            },
        )
        assert save_resp.status_code == 200
        result = save_resp.json()
        assert result["bytes_written"] > 0
        out_path = Path(result["path"])
        assert out_path.exists()

        with rasterio.open(out_path) as src:
            assert src.count == 4
            assert src.crs is not None

    def test_save_with_copy_raw_and_shadow(self, client: TestClient, tmp_path: Path):
        """copy_raw/copy_shadow must copy the scene's actual raw/shadow
        files alongside the saved mask, keeping their own filenames."""
        root = tmp_path / "source"
        scene = root / "sceneB"
        scene.mkdir(parents=True)

        h, w = 16, 16
        transform = Affine.translation(0, 0) * Affine.scale(10, -10)
        crs = CRS.from_epsg(32633)
        for name in ("raw_image.tif", "shadow_image.tif"):
            arr = np.zeros((3, h, w), dtype=np.uint8)
            with rasterio.open(
                scene / name, "w", driver="GTiff", dtype="uint8", count=3,
                height=h, width=w, crs=crs, transform=transform,
            ) as dst:
                dst.write(arr)

        discover_body = {
            "source_root": str(root),
            "scan_rule": {
                "name": "test", "raw_patterns": ["raw*"], "shadow_patterns": ["shadow*"],
                "mask_patterns": [], "max_depth": 3, "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        scene_id = scenes[0]["id"]
        assert scenes[0]["shadow_path"] is not None

        client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "bucket", "params": {"x": 0, "y": 0}, "class_value": 1},
        )

        out_root = tmp_path / "output_copy"
        save_resp = client.post(
            f"{API}/masks/{scene_id}/save",
            json={
                "output_format": "geotiff_rgba",
                "output_root": str(out_root),
                "folder_structure_template": "{scene_id}/Mask.tif",
                "copy_raw": True,
                "copy_shadow": True,
                "preserve_georef": True,
                "resolution_mode": "native",
                "target_resolution": None,
                "compress": None,
            },
        )
        assert save_resp.status_code == 200
        out_dir = Path(save_resp.json()["path"]).parent
        assert (out_dir / "raw_image.tif").exists()
        assert (out_dir / "shadow_image.tif").exists()

    def test_save_resamples_to_custom_pixel_resolution(
        self, client: TestClient, scene_dir: Path, tmp_path: Path
    ):
        """scene_dir's native pixel size is 10m (Sentinel-2-like). Saving
        with target_resolution=(30, 30) (Landsat-like) must resample the
        mask by a factor of 10/30, not treat 30 as an output image size."""
        discover_body = {
            "source_root": str(scene_dir),
            "scan_rule": {
                "name": "test",
                "raw_patterns": ["raw*"],
                "shadow_patterns": [],
                "mask_patterns": [],
                "max_depth": 3,
                "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        scene_id = scenes[0]["id"]

        client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "bucket", "params": {"x": 0, "y": 0}, "class_value": 1},
        )

        out_root = tmp_path / "output_30m"
        save_resp = client.post(
            f"{API}/masks/{scene_id}/save",
            json={
                "output_format": "geotiff_rgba",
                "output_root": str(out_root),
                "folder_structure_template": "{scene_id}/mask.tif",
                "copy_raw": False,
                "copy_shadow": False,
                "preserve_georef": True,
                "resolution_mode": "custom",
                "target_resolution": [30, 30],
                "compress": None,
            },
        )
        assert save_resp.status_code == 200
        out_path = Path(save_resp.json()["path"])

        # Native fixture is 32x32 @ 10m; at 30m that's round(32 * 10/30) = 11px.
        # The written geotransform must reflect the *effective* resolution
        # implied by that rounded pixel count (32*10/11 ≈ 29.09), not the
        # requested 30 exactly — otherwise the file's stated resolution and
        # its real ground footprint (32*10 = 320 map units wide) disagree.
        with rasterio.open(out_path) as src:
            assert src.width == 11
            assert src.height == 11
            expected_res = 32 * 10 / 11
            assert abs(src.transform.a - expected_res) < 1e-6
            assert abs(src.transform.e + expected_res) < 1e-6

    def test_pixel_size_detection_accounts_for_rotation(self, client: TestClient, tmp_path: Path):
        """Regression test: a real Sentinel-2 mask reprojected to a polar
        stereographic CRS (EPSG:3413) has a rotated/skewed transform (b and d
        non-zero) even though its true pixel size is exactly 10m. Reading
        just abs(transform.a)/abs(transform.e) undercounts the true pixel
        size whenever there's rotation, which silently corrupts every
        downstream resampling factor. This is exactly the shape of transform
        rasterio.warp produces when reprojecting UTM Sentinel-2 tiles to
        EPSG:3413, as used by the reference glacier dataset."""
        root = tmp_path / "source"
        scene = root / "sceneRotated"
        scene.mkdir(parents=True)

        h, w = 40, 40
        # A transform with true pixel size 10m but rotated ~20 degrees, so
        # abs(a) and abs(e) alone read as ~9.4m (a real understatement) —
        # this mirrors the actual transform of a UTM->EPSG:3413 reprojected
        # Sentinel-2 scene.
        import math as _math

        angle = _math.radians(20)
        transform = Affine.translation(100000, 5000000) * Affine(
            10 * _math.cos(angle), -10 * _math.sin(angle), 0,
            -10 * _math.sin(angle), -10 * _math.cos(angle), 0,
        )
        crs = CRS.from_epsg(3413)
        raw = np.random.default_rng(1).integers(0, 255, size=(3, h, w), dtype=np.uint8)
        with rasterio.open(
            scene / "raw_image.tif", "w", driver="GTiff", dtype="uint8", count=3,
            height=h, width=w, crs=crs, transform=transform,
        ) as dst:
            dst.write(raw)

        discover_body = {
            "source_root": str(root),
            "scan_rule": {
                "name": "test", "raw_patterns": ["raw*"], "shadow_patterns": [], "mask_patterns": [],
                "max_depth": 3, "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        assert len(scenes) == 1
        detected = scenes[0]["detected_resolution"]
        assert abs(detected[0] - 10.0) < 1e-6
        assert abs(detected[1] - 10.0) < 1e-6

    def test_save_custom_resolution_without_georef_returns_422(
        self, client: TestClient, tmp_path: Path
    ):
        """A mask with no transform (never discovered from a georeferenced
        scene) has no native pixel size to resample from — this must be a
        clear error, not a silent no-op or a crash."""
        scene_id = "ungeoreferenced-scene"
        client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "bucket", "params": {"x": 0, "y": 0}, "class_value": 1},
        )

        save_resp = client.post(
            f"{API}/masks/{scene_id}/save",
            json={
                "output_format": "png",
                "output_root": str(tmp_path / "out"),
                "folder_structure_template": "{scene_id}/mask.png",
                "copy_raw": False,
                "copy_shadow": False,
                "preserve_georef": False,
                "resolution_mode": "custom",
                "target_resolution": [30, 30],
                "compress": None,
            },
        )
        assert save_resp.status_code == 422

    def test_save_rejects_path_traversal_in_template(self, client: TestClient, scene_dir: Path, tmp_path: Path):
        """folder_structure_template must not be able to escape output_root
        via '..' segments or an absolute path override (pathlib silently
        discards the left operand of / when the right one is absolute)."""
        discover_body = {
            "source_root": str(scene_dir),
            "scan_rule": {
                "name": "test", "raw_patterns": ["raw*"], "shadow_patterns": [],
                "mask_patterns": [], "max_depth": 3, "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        scene_id = scenes[0]["id"]
        client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "bucket", "params": {"x": 0, "y": 0}, "class_value": 1},
        )

        out_root = tmp_path / "output_root"
        escape_target = tmp_path / "outside" / "evil.tif"

        for traversal_template in (
            "../outside/evil.tif",
            "..\\outside\\evil.tif",
            str(escape_target),  # absolute path override
        ):
            resp = client.post(
                f"{API}/masks/{scene_id}/save",
                json={
                    "output_format": "png",
                    "output_root": str(out_root),
                    "folder_structure_template": traversal_template,
                    "copy_raw": False,
                    "copy_shadow": False,
                    "preserve_georef": False,
                    "resolution_mode": "native",
                    "target_resolution": None,
                    "compress": None,
                },
            )
            assert resp.status_code == 422, f"template {traversal_template!r} should have been rejected"
            assert not escape_target.exists()

        # A legitimate relative path within output_root still works.
        ok_resp = client.post(
            f"{API}/masks/{scene_id}/save",
            json={
                "output_format": "png",
                "output_root": str(out_root),
                "folder_structure_template": "{scene_id}/mask.png",
                "copy_raw": False,
                "copy_shadow": False,
                "preserve_georef": False,
                "resolution_mode": "native",
                "target_resolution": None,
                "compress": None,
            },
        )
        assert ok_resp.status_code == 200
        assert Path(ok_resp.json()["path"]).exists()


class TestAutoFillFillsAllEmptyPixels:
    def test_autofill_fills_every_nodata_pixel_leaves_painted_alone(
        self, client: TestClient, tmp_path: Path,
    ):
        """Auto-fill is a one-shot "fill everything still blank" action: it
        must touch every NODATA pixel in the scene regardless of click
        position, and never overwrite pixels a prior tool already painted."""
        root = tmp_path / "source"
        scene = root / "sceneAutofill"
        scene.mkdir(parents=True)

        h, w = 32, 32
        transform = Affine.translation(0, 0) * Affine.scale(10, -10)
        crs = CRS.from_epsg(32633)
        raw = np.zeros((3, h, w), dtype=np.uint8)
        with rasterio.open(
            scene / "raw_image.tif", "w", driver="GTiff", dtype="uint8", count=3,
            height=h, width=w, crs=crs, transform=transform,
        ) as dst:
            dst.write(raw)

        discover_body = {
            "source_root": str(root),
            "scan_rule": {
                "name": "test", "raw_patterns": ["raw*"], "shadow_patterns": [],
                "mask_patterns": [], "max_depth": 3, "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        scene_id = scenes[0]["id"]

        # Paint a small region with bucket first -- autofill must leave it alone.
        bucket_resp = client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "bucket", "params": {"x": 5, "y": 5}, "class_value": 3},
        )
        assert bucket_resp.status_code == 200
        painted = bucket_resp.json()["changed_pixels"]
        assert painted == h * w  # uniform raw image -> bucket fills the whole frame

        # Reset: paint over a known sub-region with a distinct class via
        # polygon so autofill has real NODATA left to fill.
        undo_resp = client.post(f"{API}/masks/{scene_id}/undo")
        assert undo_resp.status_code == 200
        poly_resp = client.post(
            f"{API}/masks/{scene_id}/tool",
            json={
                "tool": "polygon",
                "params": {"points": [[0, 0], [16, 0], [16, 32], [0, 32]]},
                "class_value": 3,
            },
        )
        assert poly_resp.status_code == 200
        assert poly_resp.json()["changed_pixels"] == 16 * 32

        resp = client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "autofill", "params": {}, "class_value": 7},
        )
        assert resp.status_code == 200
        assert resp.json()["changed_pixels"] == 16 * 32  # the remaining empty half

        # A second autofill call finds nothing left to fill.
        resp2 = client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "autofill", "params": {}, "class_value": 9},
        )
        assert resp2.status_code == 200
        assert resp2.json()["changed_pixels"] == 0


#: A real Sentinel-2 tile store from the landscape-change-detection-pipeline
#: project, used by test_preview_then_apply to cluster an actual satellite
#: crop instead of synthetic noise/color blocks. Not part of this repo (it's
#: this user's own local pipeline data) -- the test skips itself if it's
#: absent, so cloning this repo elsewhere without that data still collects
#: cleanly rather than failing.
_REAL_S2_TILE = Path(r"D:\Stage-MacHydro\Script\data\tiles\tile_0000_0000.zarr")


class TestAutoSegmentEndpoints:
    def test_preview_then_apply(self, client: TestClient, tmp_path: Path):
        # A real Sentinel-2 crop (visually distinct real-world regions, real
        # sensor noise/texture) rather than pure random noise, which has no
        # genuine groups at all -- auto_segment's cluster-merging, added so
        # an over-large n_clusters request doesn't come back full of
        # near-duplicate splits, correctly collapses pure noise down to a
        # single cluster, which isn't what this test means to exercise.
        if not _REAL_S2_TILE.exists():
            pytest.skip(f"real S2 tile store not present on this machine: {_REAL_S2_TILE}")

        zarr = pytest.importorskip("zarr")
        store = zarr.open_group(str(_REAL_S2_TILE), mode="r")
        s2_group = store["S2"]
        crop = np.asarray(s2_group["rgb_raw"][0])[:, :200, :200]  # (3, H, W) uint8

        root = tmp_path / "source"
        scene = root / "sceneRealS2"
        scene.mkdir(parents=True)

        h, w = crop.shape[1:]
        transform = Affine.translation(100000, 5000000) * Affine.scale(10, -10)
        crs = CRS.from_epsg(32633)
        raw_path = scene / "raw_image.tif"
        with rasterio.open(
            raw_path, "w", driver="GTiff", dtype="uint8", count=3, height=h, width=w, crs=crs, transform=transform
        ) as dst:
            dst.write(crop)

        discover_body = {
            "source_root": str(root),
            "scan_rule": {
                "name": "test", "raw_patterns": ["raw*"], "shadow_patterns": [],
                "mask_patterns": [], "max_depth": 3, "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        scene_id = scenes[0]["id"]

        preview_resp = client.post(
            f"{API}/masks/{scene_id}/auto-segment",
            json={"source": "raw", "n_clusters": 3, "method": "kmeans", "use_texture": True},
        )
        assert preview_resp.status_code == 200
        body = preview_resp.json()
        # n_clusters is a ceiling, not a guarantee (see auto_segment's
        # cluster-merging) -- a real image can legitimately come back with
        # fewer groups than requested if it doesn't have that many visually
        # distinct ones. Just assert it's a sane count, not exactly 3.
        assert 1 <= len(body["clusters"]) <= 3
        assert body["preview_png_base64"]

        cluster_ids = [c["cluster_id"] for c in body["clusters"]]
        apply_resp = client.post(
            f"{API}/masks/{scene_id}/auto-segment/apply",
            json={"cluster_to_class": {str(cluster_ids[0]): 5}},
        )
        assert apply_resp.status_code == 200
        assert apply_resp.json()["changed_pixels"] > 0

        # A second apply without a new preview must be rejected (the
        # pending result is consumed on first apply).
        second_apply = client.post(
            f"{API}/masks/{scene_id}/auto-segment/apply",
            json={"cluster_to_class": {str(cluster_ids[-1]): 7}},
        )
        assert second_apply.status_code == 409

    def test_apply_component_splits_same_cluster_regions(self, client: TestClient, tmp_path: Path):
        """Two spatially separate regions with the same color land in the
        same cluster — apply-component must let each be assigned to a
        different class independently, without touching the other."""
        root = tmp_path / "source"
        scene = root / "sceneComponents"
        scene.mkdir(parents=True)

        h, w = 30, 30
        transform = Affine.translation(0, 0) * Affine.scale(10, -10)
        crs = CRS.from_epsg(32633)
        raw = np.full((3, h, w), 40, dtype=np.uint8)  # background: dark
        # Two bright squares, same color, opposite corners — not touching.
        raw[:, 2:8, 2:8] = 220
        raw[:, 22:28, 22:28] = 220
        with rasterio.open(
            scene / "raw_image.tif", "w", driver="GTiff", dtype="uint8", count=3,
            height=h, width=w, crs=crs, transform=transform,
        ) as dst:
            dst.write(raw)

        discover_body = {
            "source_root": str(root),
            "scan_rule": {
                "name": "test", "raw_patterns": ["raw*"], "shadow_patterns": [],
                "mask_patterns": [], "max_depth": 3, "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        scene_id = scenes[0]["id"]

        preview_resp = client.post(
            f"{API}/masks/{scene_id}/auto-segment",
            json={"source": "raw", "n_clusters": 2, "method": "kmeans", "use_texture": False},
        )
        assert preview_resp.status_code == 200

        # Assign only the top-left bright square to class 9.
        comp_resp = client.post(
            f"{API}/masks/{scene_id}/auto-segment/apply-component",
            json={"x": 5, "y": 5, "class_value": 9},
        )
        assert comp_resp.status_code == 200
        assert comp_resp.json()["changed_pixels"] == 36  # the 6x6 top-left square only

        # The bottom-right square (same cluster) must remain unassigned —
        # apply-component does not consume/clear the pending preview.
        second_comp_resp = client.post(
            f"{API}/masks/{scene_id}/auto-segment/apply-component",
            json={"x": 25, "y": 25, "class_value": 4},
        )
        assert second_comp_resp.status_code == 200
        assert second_comp_resp.json()["changed_pixels"] == 36

        # Verify the two squares actually ended up with different class
        # values in the mask, and the earlier assignment was not clobbered
        # by the second apply-component call.
        stats = client.get(f"{API}/stats/{scene_id}").json()
        counts = {c["class_value"]: c["pixel_count"] for c in stats["classes"]}
        assert counts.get(9) == 36
        assert counts.get(4) == 36

    def test_discard_clears_pending_preview(self, client: TestClient, tmp_path: Path):
        """The user backing out of an auto-segment draft (bad clustering
        params, wrong preview) must be able to discard it -- afterwards,
        apply/apply-component must behave exactly as if no preview had ever
        been run (409), not silently act on the discarded result."""
        root = tmp_path / "source"
        scene = root / "sceneDiscard"
        scene.mkdir(parents=True)

        h, w = 20, 20
        transform = Affine.translation(0, 0) * Affine.scale(10, -10)
        crs = CRS.from_epsg(32633)
        raw = np.zeros((3, h, w), dtype=np.uint8)
        raw[:, : h // 2, :] = 40
        raw[:, h // 2 :, :] = 220
        with rasterio.open(
            scene / "raw_image.tif", "w", driver="GTiff", dtype="uint8", count=3,
            height=h, width=w, crs=crs, transform=transform,
        ) as dst:
            dst.write(raw)

        discover_body = {
            "source_root": str(root),
            "scan_rule": {
                "name": "test", "raw_patterns": ["raw*"], "shadow_patterns": [],
                "mask_patterns": [], "max_depth": 3, "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scene_id = client.post(f"{API}/scenes/discover", json=discover_body).json()[0]["id"]

        preview_resp = client.post(
            f"{API}/masks/{scene_id}/auto-segment",
            json={"source": "raw", "n_clusters": 2, "method": "kmeans", "use_texture": False},
        )
        assert preview_resp.status_code == 200

        discard_resp = client.post(f"{API}/masks/{scene_id}/auto-segment/discard")
        assert discard_resp.status_code == 200
        assert discard_resp.json()["deleted"] is True

        # Discarding again (nothing pending) is a no-op, not an error.
        second_discard = client.post(f"{API}/masks/{scene_id}/auto-segment/discard")
        assert second_discard.status_code == 200
        assert second_discard.json()["deleted"] is False

        apply_resp = client.post(
            f"{API}/masks/{scene_id}/auto-segment/apply",
            json={"cluster_to_class": {"0": 5}},
        )
        assert apply_resp.status_code == 409

        comp_resp = client.post(
            f"{API}/masks/{scene_id}/auto-segment/apply-component",
            json={"x": 0, "y": 0, "class_value": 5},
        )
        assert comp_resp.status_code == 409

    def test_apply_without_preview_returns_409(self, client: TestClient):
        client.post(
            f"{API}/masks/some-scene/tool",
            json={"tool": "bucket", "params": {"x": 0, "y": 0}, "class_value": 1},
        )
        resp = client.post(
            f"{API}/masks/some-scene/auto-segment/apply",
            json={"cluster_to_class": {"0": 1}},
        )
        assert resp.status_code == 409

    def test_preview_missing_source_image_returns_422(self, client: TestClient, scene_dir: Path):
        discover_body = {
            "source_root": str(scene_dir),
            "scan_rule": {
                "name": "test", "raw_patterns": ["raw*"], "shadow_patterns": [],
                "mask_patterns": [], "max_depth": 3, "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        scene_id = scenes[0]["id"]

        resp = client.post(
            f"{API}/masks/{scene_id}/auto-segment",
            json={"source": "shadow", "n_clusters": 3, "method": "kmeans", "use_texture": True},
        )
        assert resp.status_code == 422


class TestClassesEndpoints:
    def test_crud_palette(self, client: TestClient):
        palette = {
            "id": "pal-1",
            "name": "Test Palette",
            "classes": [
                {"id": "c1", "name": "Background", "color": [0, 0, 0], "value": 0, "active_by_default": True},
                {"id": "c2", "name": "Foreground", "color": [255, 255, 255], "value": 1, "active_by_default": True},
            ],
        }
        create_resp = client.post(f"{API}/classes/palettes", json=palette)
        assert create_resp.status_code == 200

        list_resp = client.get(f"{API}/classes/palettes")
        assert any(p["id"] == "pal-1" for p in list_resp.json())

        palette["name"] = "Renamed"
        update_resp = client.put(f"{API}/classes/palettes/pal-1", json=palette)
        assert update_resp.status_code == 200
        assert update_resp.json()["name"] == "Renamed"

        delete_resp = client.delete(f"{API}/classes/palettes/pal-1")
        assert delete_resp.status_code == 200
        assert delete_resp.json()["deleted"] is True

        delete_again = client.delete(f"{API}/classes/palettes/pal-1")
        assert delete_again.status_code == 404


class TestSessionsEndpoints:
    def _sample_session(self, session_id: str = "sess-1") -> dict:
        return {
            "schema_version": 1,
            "id": session_id,
            "name": "My Session",
            "discovery": {
                "source_root": "C:/data",
                "scan_rule": {
                    "name": "default",
                    "raw_patterns": ["raw*"],
                    "shadow_patterns": ["shadow*"],
                    "mask_patterns": ["mask*"],
                    "max_depth": 5,
                    "file_extensions": [".tif"],
                },
                "exclude_globs": [],
            },
            "active_palette_id": "",
            "active_class_ids": [],
            "save_config": {
                "output_format": "geotiff_rgba",
                "output_root": "",
                "folder_structure_template": "{scene_id}/mask.tif",
                "copy_raw": False,
                "copy_shadow": False,
                "preserve_georef": True,
                "resolution_mode": "native",
                "target_resolution": None,
                "compress": "LZW",
            },
            "ui_state": {},
            "qa_state": {},
            "recent_sessions": [],
        }

    def test_create_get_update_session(self, client: TestClient):
        session = self._sample_session()
        create_resp = client.post(f"{API}/sessions", json=session)
        assert create_resp.status_code == 200

        get_resp = client.get(f"{API}/sessions/sess-1")
        assert get_resp.status_code == 200
        assert get_resp.json()["name"] == "My Session"

        session["name"] = "Updated Name"
        put_resp = client.put(f"{API}/sessions/sess-1", json=session)
        assert put_resp.status_code == 200
        assert put_resp.json()["name"] == "Updated Name"

        list_resp = client.get(f"{API}/sessions")
        assert any(s["id"] == "sess-1" for s in list_resp.json())

    def test_get_missing_session_404(self, client: TestClient):
        resp = client.get(f"{API}/sessions/does-not-exist")
        assert resp.status_code == 404


class TestRemapEndpoint:
    def test_remap_dry_run_then_apply(self, client: TestClient, scene_dir: Path):
        discover_body = {
            "source_root": str(scene_dir),
            "scan_rule": {
                "name": "test",
                "raw_patterns": ["raw*"],
                "shadow_patterns": [],
                "mask_patterns": [],
                "max_depth": 3,
                "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        scene_id = scenes[0]["id"]

        # Paint whole buffer to class 0 (background/black) via bucket so the
        # rendered RGB is a known solid color (0,0,0) with no palette set.
        client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "bucket", "params": {"x": 0, "y": 0}, "class_value": 0},
        )

        dry_resp = client.post(
            f"{API}/masks/{scene_id}/remap",
            json={"old_color": [0, 0, 0], "new_color": [9, 9, 9], "dry_run": True},
        )
        assert dry_resp.status_code == 200
        dry_result = dry_resp.json()
        assert dry_result["applied"] is False
        assert dry_result["affected_pixels"] == 32 * 32

        apply_resp = client.post(
            f"{API}/masks/{scene_id}/remap",
            json={"old_color": [0, 0, 0], "new_color": [9, 9, 9], "dry_run": False},
        )
        assert apply_resp.status_code == 200
        assert apply_resp.json()["applied"] is True


class TestShadowEndpoints:
    def test_list_presets_includes_builtin(self, client: TestClient):
        resp = client.get(f"{API}/shadow/presets")
        assert resp.status_code == 200
        names = {p["name"] for p in resp.json()}
        assert "Shadow" in names
        assert "Brut" in names

    def test_generate_shadow_for_scene(self, client: TestClient, scene_dir: Path):
        discover_body = {
            "source_root": str(scene_dir),
            "scan_rule": {
                "name": "test",
                "raw_patterns": ["raw*"],
                "shadow_patterns": [],
                "mask_patterns": [],
                "max_depth": 3,
                "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        scene_id = scenes[0]["id"]

        gen_resp = client.post(
            f"{API}/shadow/generate",
            json={"scene_id": scene_id, "method": "percentile_arcsinh_gamma_balance", "params": {"preset": "Shadow"}},
        )
        assert gen_resp.status_code == 200
        layer = gen_resp.json()
        assert layer["width"] == 32
        assert layer["height"] == 32
        assert layer["png_base64"]

    def test_create_custom_preset(self, client: TestClient):
        preset = {"name": "MyPreset", "method": "clahe", "params": {"clip_limit": 0.02}}
        resp = client.post(f"{API}/shadow/presets", json=preset)
        assert resp.status_code == 200

        list_resp = client.get(f"{API}/shadow/presets")
        names = {p["name"] for p in list_resp.json()}
        assert "MyPreset" in names


class TestQaEndpoints:
    def test_set_and_get_status(self, client: TestClient):
        resp = client.post(f"{API}/qa/status/scene-1", json={"status": "validated", "note": "looks good"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "validated"

        get_resp = client.get(f"{API}/qa/status/scene-1")
        assert get_resp.json()["status"] == "validated"

    def test_invalid_status_rejected(self, client: TestClient):
        resp = client.post(f"{API}/qa/status/scene-1", json={"status": "not_a_status"})
        assert resp.status_code == 422

    def test_filter_by_status(self, client: TestClient):
        client.post(f"{API}/qa/status/scene-a", json={"status": "todo"})
        client.post(f"{API}/qa/status/scene-b", json={"status": "flagged"})

        flagged = client.get(f"{API}/qa/list", params={"status": "flagged"}).json()
        assert any(r["scene_id"] == "scene-b" for r in flagged)
        assert not any(r["scene_id"] == "scene-a" for r in flagged)


class TestToolsListing:
    def test_lists_all_four_tools(self, client: TestClient):
        resp = client.get(f"{API}/tools")
        assert resp.status_code == 200
        names = {t["name"] for t in resp.json()}
        assert names == {"brush", "bucket", "polygon", "autofill"}


class TestStatsExport:
    def test_export_csv(self, client: TestClient, scene_dir: Path, tmp_path: Path):
        discover_body = {
            "source_root": str(scene_dir),
            "scan_rule": {
                "name": "test",
                "raw_patterns": ["raw*"],
                "shadow_patterns": [],
                "mask_patterns": [],
                "max_depth": 3,
                "file_extensions": [".tif"],
            },
            "exclude_globs": [],
        }
        scenes = client.post(f"{API}/scenes/discover", json=discover_body).json()
        scene_id = scenes[0]["id"]
        client.post(
            f"{API}/masks/{scene_id}/tool",
            json={"tool": "bucket", "params": {"x": 0, "y": 0}, "class_value": 3},
        )

        export_resp = client.post(f"{API}/stats/export", json={"scene_ids": [scene_id], "format": "csv"})
        assert export_resp.status_code == 200
        path = Path(export_resp.json()["path"])
        assert path.exists()
        content = path.read_text(encoding="utf-8")
        assert "scene_id" in content
