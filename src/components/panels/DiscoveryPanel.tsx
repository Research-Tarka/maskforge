/**
 * Configures DiscoveryConfig (source root, ScanRule filename patterns for
 * RGB/mask/inference, max depth, extensions), triggers scene discovery via
 * POST /scenes/discover, and shows the resulting SceneEntry list with QA
 * status badges and mode/status filtering.
 *
 * Patterns match against a bare filename within each scanned directory
 * (fnmatch-style: `*` and `?` wildcards, no `/` path segments — a scene's
 * RGB/mask files are expected to sit directly in its own directory, one
 * directory per scene, discovered up to max_depth levels below the source
 * root). E.g. "RGB.tif" or "*_rgb.tif", not "**\/rgb/*.tif". A zarr-store
 * scene doesn't use these RGB/mask patterns at all -- its RGB composites
 * are auto-detected from the store's own array names (any "rgb*"-prefixed
 * array), so for that setup only the inference patterns/root below apply.
 *
 * The source root picker uses the Tauri native folder dialog (the
 * `pick_folder` command) when running inside Tauri; in browser-fallback dev
 * mode it degrades to a plain text field since no native dialog is
 * available.
 */

import { useMemo, useState } from "react";
import { isSceneDone, useSessionStore } from "@/state/sessionStore";
import { discoverScenes, pickFolder } from "@/api/client";
import type { DiscoveryConfig, QaStatus, ScanRule, SceneMode } from "@/types/api";

const DEFAULT_SCAN_RULE: ScanRule = {
  name: "default",
  rgb_patterns: ["*rgb*.tif", "*RGB*.tif", "*rgb*.png"],
  mask_patterns: ["*mask*.tif", "*Mask*.tif", "*mask*.png"],
  inference_patterns: ["*class_map*", "*inference*"],
  max_depth: 5,
  file_extensions: [".tif", ".tiff", ".png", ".jpg", ".zarr"],
};

const QA_FILTERS: (QaStatus | "all")[] = ["all", "todo", "in_progress", "validated", "flagged"];
const MODE_FILTERS: (SceneMode | "all")[] = ["all", "annotate", "review"];

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export default function DiscoveryPanel() {
  const session = useSessionStore((s) => s.session);
  const updateSessionFields = useSessionStore((s) => s.updateSessionFields);
  const scenes = useSessionStore((s) => s.scenes);
  const setScenes = useSessionStore((s) => s.setScenes);
  const setActiveSceneIndex = useSessionStore((s) => s.setActiveSceneIndex);
  const selectedSceneIds = useSessionStore((s) => s.selectedSceneIds);
  const toggleSceneSelection = useSessionStore((s) => s.toggleSceneSelection);
  const selectAllScenes = useSessionStore((s) => s.selectAllScenes);
  const clearSceneSelection = useSessionStore((s) => s.clearSceneSelection);

  const [config, setConfig] = useState<DiscoveryConfig>(
    session?.discovery ?? {
      source_root: "",
      scan_rule: DEFAULT_SCAN_RULE,
      exclude_globs: [],
      inference_root: null,
    },
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qaFilter, setQaFilter] = useState<QaStatus | "all">("all");
  const [modeFilter, setModeFilter] = useState<SceneMode | "all">("all");

  const filteredScenes = useMemo(
    () =>
      scenes.filter(
        (s) => (qaFilter === "all" || s.qa_status === qaFilter) && (modeFilter === "all" || s.mode === modeFilter),
      ),
    [scenes, qaFilter, modeFilter],
  );

  const handlePickRoot = async () => {
    const dir = await pickFolder();
    if (dir) setConfig((c) => ({ ...c, source_root: dir }));
  };

  const handlePickInferenceRoot = async () => {
    const dir = await pickFolder();
    if (dir) setConfig((c) => ({ ...c, inference_root: dir }));
  };

  const handleRunDiscovery = async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await discoverScenes(config);
      // qa_status only ever lives in this frontend's memory (the sidecar
      // never persists it), so a fresh discovery response has every scene
      // back at "todo" -- carry over whatever qa_status the previous scene
      // list already had for each id, or a scene validated in the QA panel
      // this session would look untouched again and get re-proposed.
      const previousById = new Map(scenes.map((s) => [s.id, s]));
      const merged = result.map((s) => {
        const previous = previousById.get(s.id);
        return previous ? { ...s, qa_status: previous.qa_status } : s;
      });
      setScenes(merged);
      // Re-discovery reflects the real, current disk state -- never trust a
      // previously cached "done" status otherwise. Jump to the first scene
      // that's still unfinished (mode "annotate" AND not QA-validated)
      // rather than always index 0, so a scene already masked on disk or
      // already validated in QA (including ones finished in a past
      // session, or before scenes were deleted/moved) is not re-proposed.
      const firstUnfinished = merged.findIndex((s) => !isSceneDone(s));
      setActiveSceneIndex(firstUnfinished === -1 ? 0 : firstUnfinished);
      updateSessionFields({ discovery: config });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const updateScanRule = (partial: Partial<ScanRule>) => {
    setConfig((c) => ({ ...c, scan_rule: { ...c.scan_rule, ...partial } }));
  };

  return (
    <section className="panel discovery-panel" aria-label="Scene discovery panel">
      <h3 className="panel__title">Scene discovery</h3>

      <div className="panel__field">
        <label htmlFor="source-root">Source root</label>
        <div className="panel__field-row">
          <input
            id="source-root"
            type="text"
            value={config.source_root}
            onChange={(e) => setConfig((c) => ({ ...c, source_root: e.target.value }))}
            placeholder="D:\data\scenes"
          />
          <button type="button" onClick={() => void handlePickRoot()}>
            Browse…
          </button>
        </div>
      </div>

      <p className="panel__hint">
        Patterns match a filename within each scene directory (wildcards <code>*</code>/<code>?</code>,
        no path separators — one directory per scene). Be as specific as needed to avoid
        collisions: e.g. use <code>Mask.tif</code> rather than <code>*Mask*.tif</code> if a
        derived file like <code>Mask_Train.tif</code> sits alongside it, or it may be picked
        up instead.
      </p>

      <div className="panel__field">
        <label htmlFor="rgb-patterns">RGB filename patterns</label>
        <input
          id="rgb-patterns"
          type="text"
          value={config.scan_rule.rgb_patterns.join(", ")}
          onChange={(e) => updateScanRule({ rgb_patterns: parseList(e.target.value) })}
        />
      </div>

      <div className="panel__field">
        <label htmlFor="mask-patterns">Mask filename patterns</label>
        <input
          id="mask-patterns"
          type="text"
          value={config.scan_rule.mask_patterns.join(", ")}
          onChange={(e) => updateScanRule({ mask_patterns: parseList(e.target.value) })}
        />
      </div>

      <div className="panel__field">
        <label htmlFor="inference-patterns">Inference filename patterns</label>
        <input
          id="inference-patterns"
          type="text"
          value={config.scan_rule.inference_patterns.join(", ")}
          onChange={(e) => updateScanRule({ inference_patterns: parseList(e.target.value) })}
        />
        <p className="panel__hint">
          Matches an externally-produced inference class map (.npz or GeoTIFF) sitting alongside a
          plain-file scene. For a zarr-store scene, set the inference output root below instead.
        </p>
      </div>

      <div className="panel__field">
        <label htmlFor="inference-root">Inference output root</label>
        <div className="panel__field-row">
          <input
            id="inference-root"
            type="text"
            value={config.inference_root ?? ""}
            onChange={(e) => setConfig((c) => ({ ...c, inference_root: e.target.value || null }))}
            placeholder="D:\data\inference_output"
          />
          <button type="button" onClick={() => void handlePickInferenceRoot()}>
            Browse…
          </button>
        </div>
        <p className="panel__hint">
          Root of an ML pipeline's inference output (expects
          <code>&lt;tile_id&gt;/&lt;sensor&gt;/&lt;scene_id&gt;/class_map.npz</code>). Only used for
          zarr-store scenes. Leave empty if you have no inference to load.
        </p>
      </div>

      <div className="panel__field-row">
        <label className="panel__inline-field">
          Max depth
          <input
            type="number"
            min={1}
            max={32}
            value={config.scan_rule.max_depth}
            onChange={(e) => updateScanRule({ max_depth: Number(e.target.value) })}
          />
        </label>
        <label className="panel__inline-field">
          Extensions
          <input
            type="text"
            value={config.scan_rule.file_extensions.join(", ")}
            onChange={(e) => updateScanRule({ file_extensions: parseList(e.target.value) })}
          />
        </label>
      </div>

      <div className="panel__field">
        <label htmlFor="exclude-globs">Exclude globs</label>
        <input
          id="exclude-globs"
          type="text"
          value={config.exclude_globs.join(", ")}
          onChange={(e) => setConfig((c) => ({ ...c, exclude_globs: parseList(e.target.value) }))}
          placeholder="**/tmp/**, **/*_backup*"
        />
      </div>

      <button
        type="button"
        className="discovery-panel__run"
        onClick={() => void handleRunDiscovery()}
        disabled={running || !config.source_root}
      >
        {running ? "Scanning…" : "Discover scenes"}
      </button>
      {error && <p className="panel__error">{error}</p>}

      <div className="discovery-panel__results">
        <div className="discovery-panel__filters">
          <label>
            QA status
            <select value={qaFilter} onChange={(e) => setQaFilter(e.target.value as QaStatus | "all")}>
              {QA_FILTERS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label>
            Mode
            <select value={modeFilter} onChange={(e) => setModeFilter(e.target.value as SceneMode | "all")}>
              {MODE_FILTERS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="panel__hint">
          {filteredScenes.length} of {scenes.length} scenes shown · {selectedSceneIds.size} selected
        </p>

        <div className="panel__field-row">
          <button
            type="button"
            onClick={() => selectAllScenes(filteredScenes.map((s) => s.id))}
            disabled={filteredScenes.length === 0}
          >
            Select all shown
          </button>
          <button type="button" onClick={clearSceneSelection} disabled={selectedSceneIds.size === 0}>
            Clear selection
          </button>
        </div>

        <ul className="discovery-panel__list">
          {filteredScenes.map((scene) => (
            <li key={scene.id} className="discovery-panel__scene">
              <input
                type="checkbox"
                checked={selectedSceneIds.has(scene.id)}
                onChange={() => toggleSceneSelection(scene.id)}
                aria-label={`Select ${scene.id}`}
              />
              <span className="discovery-panel__scene-id">{scene.id}</span>
              <span className={`qa-badge qa-badge--${scene.qa_status}`}>{scene.qa_status}</span>
              <span className="discovery-panel__scene-mode">{scene.mode}</span>
            </li>
          ))}
          {filteredScenes.length === 0 && <li className="discovery-panel__empty">No scenes match the current filters</li>}
        </ul>
      </div>
    </section>
  );
}
