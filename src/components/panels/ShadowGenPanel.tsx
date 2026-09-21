/**
 * Shadow generation panel: method selector (percentile/arcsinh pipeline
 * with Shadow/Brut presets, CLAHE, HSV threshold, DEM hillshade, custom),
 * live parameter sliders, live preview image, and save-as-named-preset.
 *
 * The percentile/arcsinh pipeline is the primary method — it ports the
 * user's existing ToaGlacierMethod pipeline (arcsinh compression, percentile
 * stretch, gray balance, desaturation, gamma) with the "Shadow" and "Brut"
 * presets as starting points, chosen and tuned per scene rather than
 * imposed as a single default.
 */

import { useEffect, useState } from "react";
import { useSessionStore } from "@/state/sessionStore";
import { generateShadow, getShadowPresets, saveShadowPreset } from "@/api/client";
import type { ShadowMethodName, ShadowPreset } from "@/types/api";

interface PercentileArcsinhParams {
  asinh_k: number;
  low_pct: number;
  high_pct: number;
  desaturation: number;
  gamma: number | null;
  apply_balance: boolean;
}

const PERCENTILE_PRESETS: Record<"Shadow" | "Brut", PercentileArcsinhParams> = {
  Shadow: { asinh_k: 8.0, low_pct: 0.5, high_pct: 99.7, desaturation: 0.05, gamma: 1 / 2.2, apply_balance: true },
  Brut: { asinh_k: 0.0, low_pct: 0.1, high_pct: 99.9, desaturation: 0.0, gamma: null, apply_balance: false },
};

interface ClaheParams {
  clip_limit: number;
  kernel_size: number;
}

interface HsvThresholdParams {
  luminance_max: number;
  saturation_max: number;
}

interface DemHillshadeParams {
  sun_azimuth: number;
  sun_elevation: number;
}

const METHODS: { id: ShadowMethodName; label: string; description: string }[] = [
  { id: "percentile_arcsinh", label: "Percentile / Arcsinh", description: "Chainable arcsinh compression + percentile stretch + gray balance + gamma" },
  { id: "clahe", label: "CLAHE", description: "Contrast-limited adaptive histogram equalization" },
  { id: "hsv_threshold", label: "HSV threshold", description: "Low-luminance, low-saturation shadow index" },
  { id: "dem_hillshade", label: "DEM hillshade", description: "Physical shadow simulation from a co-located DEM" },
  { id: "custom", label: "Custom", description: "User-supplied plugin function" },
];

export default function ShadowGenPanel() {
  const activeScene = useSessionStore((s) => s.activeScene());

  const [method, setMethod] = useState<ShadowMethodName>("percentile_arcsinh");
  const [percentileParams, setPercentileParams] = useState<PercentileArcsinhParams>(PERCENTILE_PRESETS.Shadow);
  const [claheParams, setClaheParams] = useState<ClaheParams>({ clip_limit: 0.02, kernel_size: 64 });
  const [hsvParams, setHsvParams] = useState<HsvThresholdParams>({ luminance_max: 90, saturation_max: 40 });
  const [demParams, setDemParams] = useState<DemHillshadeParams>({ sun_azimuth: 315, sun_elevation: 35 });

  const [presets, setPresets] = useState<ShadowPreset[]>([]);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("");

  useEffect(() => {
    getShadowPresets()
      .then(setPresets)
      .catch(() => setPresets([]));
  }, []);

  const currentParams = (
    method === "percentile_arcsinh"
      ? percentileParams
      : method === "clahe"
        ? claheParams
        : method === "hsv_threshold"
          ? hsvParams
          : method === "dem_hillshade"
            ? demParams
            : {}
  ) as unknown as Record<string, unknown>;

  const handleGenerate = async () => {
    if (!activeScene) return;
    setGenerating(true);
    setError(null);
    try {
      const layer = await generateShadow({
        scene_id: activeScene.id,
        method,
        params: currentParams,
      });
      setPreviewSrc(
        layer.png_base64.startsWith("data:") ? layer.png_base64 : `data:image/png;base64,${layer.png_base64}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const handleSavePreset = async () => {
    if (!presetName.trim()) return;
    const preset: ShadowPreset = {
      id: crypto.randomUUID(),
      name: presetName.trim(),
      method,
      params: currentParams,
    };
    try {
      const saved = await saveShadowPreset(preset);
      setPresets((prev) => [...prev, saved]);
      setPresetName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleApplyPreset = (preset: ShadowPreset) => {
    setMethod(preset.method);
    if (preset.method === "percentile_arcsinh") setPercentileParams(preset.params as unknown as PercentileArcsinhParams);
    else if (preset.method === "clahe") setClaheParams(preset.params as unknown as ClaheParams);
    else if (preset.method === "hsv_threshold") setHsvParams(preset.params as unknown as HsvThresholdParams);
    else if (preset.method === "dem_hillshade") setDemParams(preset.params as unknown as DemHillshadeParams);
  };

  return (
    <section className="panel shadow-gen-panel" aria-label="Shadow generation panel">
      <h3 className="panel__title">Shadow generation</h3>

      <div className="panel__field">
        <label htmlFor="shadow-method">Method</label>
        <select id="shadow-method" value={method} onChange={(e) => setMethod(e.target.value as ShadowMethodName)}>
          {METHODS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <p className="panel__hint">{METHODS.find((m) => m.id === method)?.description}</p>
      </div>

      {method === "percentile_arcsinh" && (
        <>
          <div className="panel__field-row">
            <button type="button" onClick={() => setPercentileParams(PERCENTILE_PRESETS.Shadow)}>
              Shadow preset
            </button>
            <button type="button" onClick={() => setPercentileParams(PERCENTILE_PRESETS.Brut)}>
              Brut preset
            </button>
          </div>

          <SliderField
            label="Arcsinh k"
            value={percentileParams.asinh_k}
            min={0}
            max={20}
            step={0.1}
            onChange={(v) => setPercentileParams((p) => ({ ...p, asinh_k: v }))}
          />
          <SliderField
            label="Low percentile"
            value={percentileParams.low_pct}
            min={0}
            max={10}
            step={0.1}
            onChange={(v) => setPercentileParams((p) => ({ ...p, low_pct: v }))}
          />
          <SliderField
            label="High percentile"
            value={percentileParams.high_pct}
            min={90}
            max={100}
            step={0.1}
            onChange={(v) => setPercentileParams((p) => ({ ...p, high_pct: v }))}
          />
          <SliderField
            label="Desaturation"
            value={percentileParams.desaturation}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setPercentileParams((p) => ({ ...p, desaturation: v }))}
          />
          <SliderField
            label="Gamma"
            value={percentileParams.gamma ?? 1}
            min={0.1}
            max={3}
            step={0.05}
            onChange={(v) => setPercentileParams((p) => ({ ...p, gamma: v }))}
          />
          <label className="panel__checkbox">
            <input
              type="checkbox"
              checked={percentileParams.apply_balance}
              onChange={(e) => setPercentileParams((p) => ({ ...p, apply_balance: e.target.checked }))}
            />
            Apply gray balance
          </label>
        </>
      )}

      {method === "clahe" && (
        <>
          <SliderField
            label="Clip limit"
            value={claheParams.clip_limit}
            min={0.001}
            max={0.1}
            step={0.001}
            onChange={(v) => setClaheParams((p) => ({ ...p, clip_limit: v }))}
          />
          <SliderField
            label="Kernel size"
            value={claheParams.kernel_size}
            min={8}
            max={256}
            step={8}
            onChange={(v) => setClaheParams((p) => ({ ...p, kernel_size: v }))}
          />
        </>
      )}

      {method === "hsv_threshold" && (
        <>
          <SliderField
            label="Max luminance"
            value={hsvParams.luminance_max}
            min={0}
            max={255}
            step={1}
            onChange={(v) => setHsvParams((p) => ({ ...p, luminance_max: v }))}
          />
          <SliderField
            label="Max saturation"
            value={hsvParams.saturation_max}
            min={0}
            max={255}
            step={1}
            onChange={(v) => setHsvParams((p) => ({ ...p, saturation_max: v }))}
          />
        </>
      )}

      {method === "dem_hillshade" && (
        <>
          <SliderField
            label="Sun azimuth"
            value={demParams.sun_azimuth}
            min={0}
            max={360}
            step={1}
            onChange={(v) => setDemParams((p) => ({ ...p, sun_azimuth: v }))}
          />
          <SliderField
            label="Sun elevation"
            value={demParams.sun_elevation}
            min={0}
            max={90}
            step={1}
            onChange={(v) => setDemParams((p) => ({ ...p, sun_elevation: v }))}
          />
        </>
      )}

      {method === "custom" && <p className="panel__hint">Custom shadow generation is configured via a plugin module.</p>}

      <button type="button" onClick={() => void handleGenerate()} disabled={generating || !activeScene}>
        {generating ? "Generating…" : "Generate preview"}
      </button>
      {error && <p className="panel__error">{error}</p>}

      {previewSrc && (
        <div className="shadow-gen-panel__preview">
          <img src={previewSrc} alt="Shadow generation preview" />
        </div>
      )}

      <div className="panel__field-row">
        <input
          type="text"
          placeholder="Preset name"
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)}
        />
        <button type="button" onClick={() => void handleSavePreset()} disabled={!presetName.trim()}>
          Save preset
        </button>
      </div>

      {presets.length > 0 && (
        <ul className="shadow-gen-panel__presets">
          {presets.map((preset) => (
            <li key={preset.id}>
              <button type="button" onClick={() => handleApplyPreset(preset)}>
                {preset.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="panel__field">
      <label>{label}</label>
      <div className="panel__field-row">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="panel__field-value">{value}</span>
      </div>
    </div>
  );
}
