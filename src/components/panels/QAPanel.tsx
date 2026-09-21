/**
 * Per-scene QA status (todo/in_progress/validated/flagged) with filters,
 * batch queue navigation, and a global progress bar across the scene
 * queue.
 */

import { useMemo, useState } from "react";
import { useSessionStore } from "@/state/sessionStore";
import type { QaStatus } from "@/types/api";
import { parseSceneEntryId, MONTH_LABELS } from "@/utils/sceneKey";

const STATUSES: QaStatus[] = ["todo", "in_progress", "validated", "flagged"];

const STATUS_LABELS: Record<QaStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  validated: "Validated",
  flagged: "Flagged",
};

/** Sorted, de-duplicated option list for a filter select — "All" plus every
 * value actually present in the current scene queue (not a fixed catalog),
 * so the filter always matches what's really loaded. */
function useOptions<T extends string | number>(values: (T | null)[]): T[] {
  return useMemo(() => {
    const unique = Array.from(new Set(values.filter((v): v is T => v !== null)));
    unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return unique;
  }, [values]);
}

export default function QAPanel() {
  const scenes = useSessionStore((s) => s.scenes);
  const activeSceneIndex = useSessionStore((s) => s.activeSceneIndex);
  const setActiveSceneIndex = useSessionStore((s) => s.setActiveSceneIndex);
  const updateScene = useSessionStore((s) => s.updateScene);
  const goToNextScene = useSessionStore((s) => s.goToNextScene);
  const goToPreviousScene = useSessionStore((s) => s.goToPreviousScene);
  const activeScene = useSessionStore((s) => s.activeScene());

  const [filter, setFilter] = useState<QaStatus | "all">("all");
  const [tileFilter, setTileFilter] = useState<string | "all">("all");
  const [sensorFilter, setSensorFilter] = useState<string | "all">("all");
  const [yearFilter, setYearFilter] = useState<number | "all">("all");
  const [monthFilter, setMonthFilter] = useState<number | "all">("all");

  // Parsed once per scene list (not per filter change) -- SceneEntry.id
  // encodes "{tile_id}_{sensor}_{scene_id}" (see
  // maskforge_core/scene_discovery.py's _scan_zarr_store), and scene_id
  // itself carries the acquisition date; a scene discovered outside the
  // zarr path may not match that shape, in which case meta is null and the
  // scene is simply excluded from the tile/satellite/year/month filters
  // (it still shows up under "all").
  const sceneMeta = useMemo(
    () => new Map(scenes.map((s) => [s.id, parseSceneEntryId(s.id)])),
    [scenes],
  );

  const tileOptions = useOptions(scenes.map((s) => sceneMeta.get(s.id)?.tileId ?? null));
  const sensorOptions = useOptions(scenes.map((s) => sceneMeta.get(s.id)?.sensor ?? null));
  const yearOptions = useOptions(scenes.map((s) => sceneMeta.get(s.id)?.year ?? null));
  const monthOptions = useOptions(scenes.map((s) => sceneMeta.get(s.id)?.month ?? null));

  const filteredScenes = useMemo(
    () =>
      scenes.filter((s) => {
        if (filter !== "all" && s.qa_status !== filter) return false;
        const meta = sceneMeta.get(s.id);
        if (tileFilter !== "all" && meta?.tileId !== tileFilter) return false;
        if (sensorFilter !== "all" && meta?.sensor !== sensorFilter) return false;
        if (yearFilter !== "all" && meta?.year !== yearFilter) return false;
        if (monthFilter !== "all" && meta?.month !== monthFilter) return false;
        return true;
      }),
    [scenes, filter, tileFilter, sensorFilter, yearFilter, monthFilter, sceneMeta],
  );

  const counts = useMemo(() => {
    const base: Record<QaStatus, number> = { todo: 0, in_progress: 0, validated: 0, flagged: 0 };
    scenes.forEach((s) => {
      base[s.qa_status] += 1;
    });
    return base;
  }, [scenes]);

  const validatedPercent = scenes.length > 0 ? (counts.validated / scenes.length) * 100 : 0;

  const handleSetStatus = (status: QaStatus) => {
    if (!activeScene) return;
    updateScene(activeScene.id, { qa_status: status });
  };

  const handleSkip = () => {
    if (!activeScene) return;
    updateScene(activeScene.id, { qa_status: "flagged" });
    goToNextScene();
  };

  return (
    <section className="panel qa-panel" aria-label="QA workflow panel">
      <h3 className="panel__title">QA workflow</h3>

      <div className="qa-panel__progress">
        <div className="qa-panel__progress-track">
          <div className="qa-panel__progress-fill" style={{ width: `${validatedPercent}%` }} />
        </div>
        <p className="panel__hint">
          {counts.validated} / {scenes.length} scenes validated ({Math.round(validatedPercent)}%)
        </p>
      </div>

      {activeScene && (
        <div className="qa-panel__current">
          <span className="panel__label">Current scene status</span>
          <div className="qa-panel__status-buttons">
            {STATUSES.map((status) => (
              <button
                key={status}
                type="button"
                className={`qa-badge qa-badge--${status}${activeScene.qa_status === status ? " is-selected" : ""}`}
                onClick={() => handleSetStatus(status)}
              >
                {STATUS_LABELS[status]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="qa-panel__navigation">
        <button type="button" onClick={goToPreviousScene} disabled={activeSceneIndex === 0}>
          Previous
        </button>
        <span>
          {scenes.length > 0 ? `${activeSceneIndex + 1} / ${scenes.length}` : "0 / 0"}
        </span>
        <button type="button" onClick={goToNextScene} disabled={activeSceneIndex >= scenes.length - 1}>
          Next
        </button>
      </div>

      <button
        type="button"
        className="qa-panel__skip"
        onClick={handleSkip}
        disabled={!activeScene || activeSceneIndex >= scenes.length - 1}
        title="Flag this scene and move to the next one, without changing the mask"
      >
        Skip this scene
      </button>

      <div className="panel__field">
        <label htmlFor="qa-filter">Status</label>
        <select id="qa-filter" value={filter} onChange={(e) => setFilter(e.target.value as QaStatus | "all")}>
          <option value="all">All ({scenes.length})</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]} ({counts[status]})
            </option>
          ))}
        </select>
      </div>

      <div className="panel__field-row">
        <label className="panel__inline-field">
          Tile
          <select value={tileFilter} onChange={(e) => setTileFilter(e.target.value)}>
            <option value="all">All</option>
            {tileOptions.map((tile) => (
              <option key={tile} value={tile}>
                {tile}
              </option>
            ))}
          </select>
        </label>
        <label className="panel__inline-field">
          Satellite
          <select value={sensorFilter} onChange={(e) => setSensorFilter(e.target.value)}>
            <option value="all">All</option>
            {sensorOptions.map((sensor) => (
              <option key={sensor} value={sensor}>
                {sensor.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="panel__field-row">
        <label className="panel__inline-field">
          Year
          <select
            value={yearFilter}
            onChange={(e) => setYearFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
          >
            <option value="all">All</option>
            {yearOptions.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </label>
        <label className="panel__inline-field">
          Month
          <select
            value={monthFilter}
            onChange={(e) => setMonthFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
          >
            <option value="all">All</option>
            {monthOptions.map((month) => (
              <option key={month} value={month}>
                {MONTH_LABELS[month - 1]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ul className="qa-panel__queue">
        {filteredScenes.map((scene) => {
          const sceneIndex = scenes.findIndex((s) => s.id === scene.id);
          const meta = sceneMeta.get(scene.id);
          return (
            <li key={scene.id} className={sceneIndex === activeSceneIndex ? "is-active" : ""}>
              <button type="button" onClick={() => setActiveSceneIndex(sceneIndex)}>
                <span className="qa-panel__scene-id">{scene.id}</span>
                {meta && (
                  <span className="qa-panel__scene-meta">
                    {meta.tileId} · {meta.sensor.toUpperCase()} · {meta.year ?? "?"}
                    {meta.month ? `-${MONTH_LABELS[meta.month - 1]}` : ""}
                  </span>
                )}
                <span className={`qa-badge qa-badge--${scene.qa_status}`}>{scene.qa_status}</span>
              </button>
            </li>
          );
        })}
        {filteredScenes.length === 0 && <li className="qa-panel__empty">No scenes match this filter</li>}
      </ul>
    </section>
  );
}
