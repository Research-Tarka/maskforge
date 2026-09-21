/**
 * Configures SaveConfig (output format, output root, folder structure
 * template with token help text, copy raw/shadow toggles, georef
 * preservation, resolution mode + target resolution, compression) and
 * triggers a save of the active scene's mask via POST /masks/{id}/save.
 *
 * Two independent save actions are exposed, mirroring the reference
 * workflow's Mask.tif (real, native-resolution mask) + Mask_Train.tif (a
 * separately resampled copy for model training): the primary save below,
 * and a second "Training copy" section with its own output settings and
 * its own button. Each is a fully separate SaveConfig — saving one does
 * not affect or require the other.
 */

import { useState } from "react";
import { useSessionStore } from "@/state/sessionStore";
import { pickFolder, saveMask } from "@/api/client";
import type { OutputFormat, ResolutionMode, SaveConfig } from "@/types/api";

const OUTPUT_FORMATS: { id: OutputFormat; label: string }[] = [
  { id: "geotiff_rgba", label: "GeoTIFF (RGBA)" },
  { id: "geotiff_rgb", label: "GeoTIFF (RGB)" },
  { id: "png", label: "PNG" },
  { id: "png_indexed", label: "PNG (indexed)" },
];

const TOKEN_HELP = "{scene_id} {glacier_id} {year} {basename} {ext}";

const DEFAULT_SAVE_CONFIG: SaveConfig = {
  output_format: "geotiff_rgba",
  output_root: "",
  folder_structure_template: "{scene_id}/Mask.tif",
  copy_raw: false,
  copy_shadow: false,
  preserve_georef: true,
  resolution_mode: "native",
  target_resolution: null,
  compress: "deflate",
};

const DEFAULT_TRAINING_SAVE_CONFIG: SaveConfig = {
  output_format: "geotiff_rgb",
  output_root: "",
  folder_structure_template: "{scene_id}/Mask_Train.tif",
  copy_raw: false,
  copy_shadow: false,
  preserve_georef: true,
  resolution_mode: "custom",
  target_resolution: [30, 30],
  compress: "deflate",
};

interface SaveSectionProps {
  title: string;
  hint?: string;
  config: SaveConfig;
  onChange: (partial: Partial<SaveConfig>) => void;
  onSave: () => void;
  saving: boolean;
  disabled: boolean;
  result: string | null;
  error: string | null;
  idPrefix: string;
  detectedResolution: [number, number] | null;
}

function SaveSection({
  title,
  hint,
  config,
  onChange,
  onSave,
  saving,
  disabled,
  result,
  error,
  idPrefix,
  detectedResolution,
}: SaveSectionProps) {
  const handlePickOutputRoot = async () => {
    const dir = await pickFolder();
    if (dir) onChange({ output_root: dir });
  };

  return (
    <div className="save-config-panel__section">
      <h4 className="panel__subtitle">{title}</h4>
      {hint && <p className="panel__hint">{hint}</p>}

      <div className="panel__field">
        <label htmlFor={`${idPrefix}-output-format`}>Output format</label>
        <select
          id={`${idPrefix}-output-format`}
          value={config.output_format}
          onChange={(e) => onChange({ output_format: e.target.value as OutputFormat })}
        >
          {OUTPUT_FORMATS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <div className="panel__field">
        <label htmlFor={`${idPrefix}-output-root`}>Output root</label>
        <div className="panel__field-row">
          <input
            id={`${idPrefix}-output-root`}
            type="text"
            value={config.output_root}
            onChange={(e) => onChange({ output_root: e.target.value })}
            placeholder="D:\data\exports"
          />
          <button type="button" onClick={() => void handlePickOutputRoot()}>
            Browse…
          </button>
        </div>
      </div>

      <div className="panel__field">
        <label htmlFor={`${idPrefix}-folder-template`}>Folder structure template</label>
        <input
          id={`${idPrefix}-folder-template`}
          type="text"
          value={config.folder_structure_template}
          onChange={(e) => onChange({ folder_structure_template: e.target.value })}
        />
        <p className="panel__hint">Available tokens: {TOKEN_HELP}</p>
      </div>

      <div className="panel__field-row">
        <label className="panel__checkbox">
          <input
            type="checkbox"
            checked={config.copy_raw}
            onChange={(e) => onChange({ copy_raw: e.target.checked })}
          />
          Copy raw alongside mask
        </label>
        <label className="panel__checkbox">
          <input
            type="checkbox"
            checked={config.copy_shadow}
            onChange={(e) => onChange({ copy_shadow: e.target.checked })}
          />
          Copy shadow alongside mask
        </label>
      </div>

      <label className="panel__checkbox">
        <input
          type="checkbox"
          checked={config.preserve_georef}
          onChange={(e) => onChange({ preserve_georef: e.target.checked })}
        />
        Preserve georeferencing (CRS + transform)
      </label>

      <div className="panel__field">
        <label htmlFor={`${idPrefix}-resolution-mode`}>Pixel resolution</label>
        <select
          id={`${idPrefix}-resolution-mode`}
          value={config.resolution_mode}
          onChange={(e) => onChange({ resolution_mode: e.target.value as ResolutionMode })}
        >
          <option value="native">Native (source pixel size)</option>
          <option value="custom">Custom pixel size</option>
        </select>
        <p className="panel__hint">
          The ground size of one pixel in the scene&rsquo;s map units (e.g. 10 for Sentinel-2,
          30 for Landsat) &mdash; not the image&rsquo;s width/height in pixels. Requires a
          georeferenced mask; the mask is resampled to match on save.
        </p>
        <p className="panel__hint">
          Detected native resolution:{" "}
          {detectedResolution
            ? `${detectedResolution[0].toFixed(3)} x ${detectedResolution[1].toFixed(3)} map units/px`
            : "unavailable (scene not georeferenced, or none loaded)"}
        </p>
      </div>

      {config.resolution_mode === "custom" && (
        <>
          <div className="panel__field-row">
            <label className="panel__inline-field">
              X (map units/px)
              <input
                type="number"
                step="any"
                placeholder="e.g. 30"
                value={config.target_resolution?.[0] ?? ""}
                onChange={(e) =>
                  onChange({
                    target_resolution: [Number(e.target.value), config.target_resolution?.[1] ?? Number(e.target.value)],
                  })
                }
              />
            </label>
            <label className="panel__inline-field">
              Y (map units/px)
              <input
                type="number"
                step="any"
                placeholder="e.g. 30"
                value={config.target_resolution?.[1] ?? ""}
                onChange={(e) =>
                  onChange({
                    target_resolution: [config.target_resolution?.[0] ?? Number(e.target.value), Number(e.target.value)],
                  })
                }
              />
            </label>
          </div>
          {detectedResolution && (
            <button
              type="button"
              className="save-config-panel__use-detected"
              onClick={() => onChange({ target_resolution: [...detectedResolution] })}
            >
              Use detected ({detectedResolution[0].toFixed(3)})
            </button>
          )}
        </>
      )}

      <div className="panel__field">
        <label htmlFor={`${idPrefix}-compress`}>Compression</label>
        <select
          id={`${idPrefix}-compress`}
          value={config.compress ?? ""}
          onChange={(e) => onChange({ compress: e.target.value || null })}
        >
          <option value="">None</option>
          <option value="deflate">Deflate</option>
          <option value="lzw">LZW</option>
          <option value="zstd">Zstandard</option>
        </select>
      </div>

      <button type="button" onClick={onSave} disabled={saving || disabled}>
        {saving ? "Saving…" : "Save"}
      </button>

      {result && <p className="panel__success">{result}</p>}
      {error && <p className="panel__error">{error}</p>}
    </div>
  );
}

export default function SaveConfigPanel() {
  const session = useSessionStore((s) => s.session);
  const updateSessionFields = useSessionStore((s) => s.updateSessionFields);
  const activeScene = useSessionStore((s) => s.activeScene());
  const updateScene = useSessionStore((s) => s.updateScene);
  const goToNextUnfinishedScene = useSessionStore((s) => s.goToNextUnfinishedScene);

  const [config, setConfig] = useState<SaveConfig>(session?.save_config ?? DEFAULT_SAVE_CONFIG);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [trainingEnabled, setTrainingEnabled] = useState(session?.training_save_config != null);
  const [trainingConfig, setTrainingConfig] = useState<SaveConfig>(
    session?.training_save_config ?? DEFAULT_TRAINING_SAVE_CONFIG,
  );
  const [trainingSaving, setTrainingSaving] = useState(false);
  const [trainingResult, setTrainingResult] = useState<string | null>(null);
  const [trainingError, setTrainingError] = useState<string | null>(null);

  const commit = (partial: Partial<SaveConfig>) => {
    const next = { ...config, ...partial };
    setConfig(next);
    updateSessionFields({ save_config: next });
  };

  const commitTraining = (partial: Partial<SaveConfig>) => {
    const next = { ...trainingConfig, ...partial };
    setTrainingConfig(next);
    if (trainingEnabled) updateSessionFields({ training_save_config: next });
  };

  const handleToggleTraining = (enabled: boolean) => {
    setTrainingEnabled(enabled);
    updateSessionFields({ training_save_config: enabled ? trainingConfig : null });
  };

  const handleSave = async () => {
    if (!activeScene) return;
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const res = await saveMask(activeScene.id, config);
      setResult(`Saved ${res.bytes_written.toLocaleString()} bytes to ${res.path}`);
      // The primary mask save (not the training copy) is what marks a scene
      // "done": reflect that immediately in local state instead of waiting
      // for a manual re-discovery or a manual QA click, then move on to the
      // next scene that still needs annotation.
      updateScene(activeScene.id, { mode: "review", mask_path: res.path, qa_status: "validated" });
      goToNextUnfinishedScene();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTraining = async () => {
    if (!activeScene) return;
    setTrainingSaving(true);
    setTrainingError(null);
    setTrainingResult(null);
    try {
      const res = await saveMask(activeScene.id, trainingConfig);
      setTrainingResult(`Saved ${res.bytes_written.toLocaleString()} bytes to ${res.path}`);
    } catch (err) {
      setTrainingError(err instanceof Error ? err.message : String(err));
    } finally {
      setTrainingSaving(false);
    }
  };

  return (
    <section className="panel save-config-panel" aria-label="Save configuration panel">
      <h3 className="panel__title">Save configuration</h3>

      <SaveSection
        title="Mask"
        config={config}
        onChange={commit}
        onSave={() => void handleSave()}
        saving={saving}
        disabled={!activeScene}
        result={result}
        error={error}
        idPrefix="save"
        detectedResolution={activeScene?.detected_resolution ?? null}
      />

      <hr className="save-config-panel__divider" />

      <label className="panel__checkbox">
        <input
          type="checkbox"
          checked={trainingEnabled}
          onChange={(e) => handleToggleTraining(e.target.checked)}
        />
        Also save a resampled training copy
      </label>

      {trainingEnabled && (
        <SaveSection
          title="Training copy"
          hint="Saved as a completely separate file from the mask above — e.g. the native mask at 10m plus a 30m copy for training, matching the reference Mask.tif / Mask_Train.tif pair."
          config={trainingConfig}
          onChange={commitTraining}
          onSave={() => void handleSaveTraining()}
          saving={trainingSaving}
          disabled={!activeScene}
          result={trainingResult}
          error={trainingError}
          idPrefix="training"
          detectedResolution={activeScene?.detected_resolution ?? null}
        />
      )}
    </section>
  );
}
