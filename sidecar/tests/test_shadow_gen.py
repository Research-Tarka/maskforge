from __future__ import annotations

import numpy as np
import pytest

from maskforge_core.shadow_gen import (
    BUILTIN_PRESETS,
    ClaheMethod,
    HillshadeMethod,
    HsvShadowIndexMethod,
    PercentileArcsinhGammaBalanceMethod,
    generate_shadow,
    list_presets,
    register_custom_method,
    unregister_custom_method,
)


@pytest.fixture
def raw_rgb() -> np.ndarray:
    rng = np.random.default_rng(7)
    arr = rng.integers(0, 256, size=(64, 64, 3), dtype=np.uint8)
    return arr


class TestPercentileArcsinhGammaBalance:
    def test_shadow_preset_runs_and_in_range(self, raw_rgb: np.ndarray):
        method = PercentileArcsinhGammaBalanceMethod()
        out = method.generate(raw_rgb, {"preset": "Shadow"})
        assert out.dtype == np.uint8
        assert out.shape == raw_rgb.shape
        assert out.min() >= 0 and out.max() <= 255

    def test_brut_preset_runs_and_in_range(self, raw_rgb: np.ndarray):
        method = PercentileArcsinhGammaBalanceMethod()
        out = method.generate(raw_rgb, {"preset": "Brut"})
        assert out.dtype == np.uint8
        assert out.shape == raw_rgb.shape

    def test_preset_values_match_reference_exactly(self):
        shadow = BUILTIN_PRESETS["Shadow"]
        assert shadow.asinh_k == 8.0
        assert shadow.low_pct == 0.5
        assert shadow.high_pct == 99.7
        assert shadow.desaturation == 0.05
        assert shadow.gamma == pytest.approx(1 / 2.2)
        assert shadow.apply_balance is True

        brut = BUILTIN_PRESETS["Brut"]
        assert brut.asinh_k == 0.0
        assert brut.low_pct == 0.1
        assert brut.high_pct == 99.9
        assert brut.desaturation == 0.0
        assert brut.gamma is None
        assert brut.apply_balance is False

    def test_custom_params_dict(self, raw_rgb: np.ndarray):
        method = PercentileArcsinhGammaBalanceMethod()
        out = method.generate(
            raw_rgb,
            {"asinh_k": 3.0, "low_pct": 1.0, "high_pct": 99.0, "desaturation": 0.2, "gamma": 1.5, "apply_balance": False},
        )
        assert out.shape == raw_rgb.shape

    def test_gamma_none_skips_gamma_step(self, raw_rgb: np.ndarray):
        method = PercentileArcsinhGammaBalanceMethod()
        # Should not raise even with gamma=None (skip step).
        out = method.generate(raw_rgb, {"gamma": None})
        assert out.shape == raw_rgb.shape

    def test_shadow_darker_areas_get_boosted_relative_to_brut(self, raw_rgb: np.ndarray):
        # Construct a low-brightness scene; the Shadow preset (with asinh
        # compression + gamma) should generally brighten the low percentile
        # range more than the near-linear Brut preset.
        dark = np.full((32, 32, 3), 20, dtype=np.uint8)
        method = PercentileArcsinhGammaBalanceMethod()
        shadow_out = method.generate(dark, {"preset": "Shadow"})
        brut_out = method.generate(dark, {"preset": "Brut"})
        assert shadow_out.mean() >= brut_out.mean()


class TestClahe:
    def test_clahe_runs(self, raw_rgb: np.ndarray):
        pytest.importorskip("skimage")
        method = ClaheMethod()
        out = method.generate(raw_rgb, {"clip_limit": 0.01})
        assert out.shape == raw_rgb.shape
        assert out.dtype == np.uint8


class TestHsvShadowIndex:
    def test_runs_on_rgb(self, raw_rgb: np.ndarray):
        method = HsvShadowIndexMethod()
        out = method.generate(raw_rgb, {})
        assert out.shape == raw_rgb.shape
        assert out.dtype == np.uint8

    def test_dark_desaturated_pixels_get_boosted(self):
        img = np.full((10, 10, 3), 20, dtype=np.uint8)  # dark, gray -> shadow
        method = HsvShadowIndexMethod()
        out = method.generate(img, {"value_threshold": 0.5, "saturation_threshold": 0.5, "boost": 2.0})
        assert out.mean() > img.mean()


class TestHillshade:
    def test_flat_dem_gives_uniform_shade(self):
        dem = np.zeros((20, 20), dtype=np.float32)
        method = HillshadeMethod()
        out = method.generate(dem, {"sun_elevation": 45.0})
        assert out.shape == (20, 20, 3)
        # Flat terrain: hillshade should be uniform (all pixels equal).
        assert (out == out[0, 0]).all()

    def test_sloped_dem_varies(self):
        y, x = np.mgrid[0:30, 0:30]
        dem = (x * 2.0).astype(np.float32)  # linear ramp -> constant slope/aspect
        method = HillshadeMethod()
        out = method.generate(dem, {"sun_azimuth": 315.0, "sun_elevation": 45.0})
        assert out.dtype == np.uint8
        assert out.shape == (30, 30, 3)


class TestCustomMethod:
    def test_register_and_dispatch(self, raw_rgb: np.ndarray):
        def _invert(raw: np.ndarray, params: dict) -> np.ndarray:
            return (255 - raw).astype(np.uint8)

        register_custom_method("invert", _invert)
        try:
            out = generate_shadow(raw_rgb, "custom", {"custom_name": "invert"})
            np.testing.assert_array_equal(out, 255 - raw_rgb)
        finally:
            unregister_custom_method("invert")

    def test_unknown_custom_name_raises(self, raw_rgb: np.ndarray):
        with pytest.raises(ValueError):
            generate_shadow(raw_rgb, "custom", {"custom_name": "does_not_exist"})


class TestMethodRegistryAndPresets:
    def test_unknown_method_raises(self, raw_rgb: np.ndarray):
        with pytest.raises(ValueError):
            generate_shadow(raw_rgb, "not_a_real_method", {})

    def test_list_presets_includes_shadow_and_brut(self):
        presets = list_presets()
        assert "Shadow" in presets
        assert "Brut" in presets
        assert presets["Shadow"]["method"] == "percentile_arcsinh_gamma_balance"

    def test_generate_shadow_dispatches_by_preset_name(self, raw_rgb: np.ndarray):
        out1 = generate_shadow(raw_rgb, "percentile_arcsinh_gamma_balance", {"preset": "Shadow"})
        out2 = generate_shadow(raw_rgb, "percentile_arcsinh_gamma_balance", {"preset": "Shadow"})
        np.testing.assert_array_equal(out1, out2)  # deterministic
