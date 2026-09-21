/**
 * Per-class pixel stats table for the active scene, plus a CSV/Parquet
 * export trigger across the full scene queue (or a filtered subset).
 */

import { useEffect, useState } from "react";
import { useSessionStore } from "@/state/sessionStore";
import { useClassStore } from "@/state/classStore";
import { exportStats, getStats } from "@/api/client";
import type { ClassPixelStat, StatsExportFormat } from "@/types/api";

export default function StatsPanel() {
  const activeScene = useSessionStore((s) => s.activeScene());
  const scenes = useSessionStore((s) => s.scenes);
  const sceneRefreshToken = useSessionStore((s) => s.sceneRefreshToken);
  const statsRefreshToken = useSessionStore((s) => s.statsRefreshToken);
  const palette = useClassStore((s) => s.activePalette());

  const [stats, setStats] = useState<ClassPixelStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<StatsExportFormat>("csv");
  const [exportScope, setExportScope] = useState<"active" | "all">("all");
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!activeScene) {
      setStats([]);
      return;
    }
    setLoading(true);
    setError(null);
    getStats(activeScene.id)
      .then((res) => setStats(res.classes))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
    // Two separate tokens cover every mask-changing path: statsRefreshToken
    // bumps on a normal paint stroke (handleMaskUpdated in App.tsx, which
    // deliberately does NOT also bump sceneRefreshToken -- see its comment),
    // sceneRefreshToken bumps on undo/redo/auto-segment-apply/fill-all
    // (paths that don't already fetch their own updated layers the way a
    // paint stroke does). Without both in the deps, this table would miss
    // updates from whichever path only bumps the other one.
  }, [activeScene, sceneRefreshToken, statsRefreshToken]);

  const totalPixels = stats.reduce((sum, s) => sum + s.pixel_count, 0);

  const classNameFor = (classValue: number): string =>
    palette?.classes.find((c) => c.value === classValue)?.name ?? `Class ${classValue}`;

  const handleExport = async () => {
    setExporting(true);
    setExportResult(null);
    setError(null);
    try {
      const sceneIds = exportScope === "active" && activeScene ? [activeScene.id] : scenes.map((s) => s.id);
      const res = await exportStats({ scene_ids: sceneIds, format: exportFormat });
      setExportResult(`Exported to ${res.path}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="panel stats-panel" aria-label="Statistics panel">
      <h3 className="panel__title">Statistics</h3>

      {loading && <p className="panel__hint">Loading stats…</p>}

      {!loading && activeScene && (
        <table className="stats-panel__table">
          <thead>
            <tr>
              <th>Class</th>
              <th>Pixels</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((row) => (
              <tr key={row.class_value}>
                <td>{classNameFor(row.class_value)}</td>
                <td>{row.pixel_count.toLocaleString()}</td>
                <td>{totalPixels > 0 ? `${((row.pixel_count / totalPixels) * 100).toFixed(1)}%` : "—"}</td>
              </tr>
            ))}
            {stats.length === 0 && (
              <tr>
                <td colSpan={3} className="stats-panel__empty">
                  No painted pixels on this scene yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {!activeScene && <p className="panel__hint">Load a scene to see its class distribution.</p>}

      <div className="stats-panel__export">
        <h4>Export</h4>
        <div className="panel__field-row">
          <label className="panel__inline-field">
            Scope
            <select value={exportScope} onChange={(e) => setExportScope(e.target.value as "active" | "all")}>
              <option value="active">Active scene</option>
              <option value="all">All discovered scenes ({scenes.length})</option>
            </select>
          </label>
          <label className="panel__inline-field">
            Format
            <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as StatsExportFormat)}>
              <option value="csv">CSV</option>
              <option value="parquet">Parquet</option>
            </select>
          </label>
        </div>
        <button type="button" onClick={() => void handleExport()} disabled={exporting || scenes.length === 0}>
          {exporting ? "Exporting…" : "Export stats"}
        </button>
        {exportResult && <p className="panel__success">{exportResult}</p>}
      </div>

      {error && <p className="panel__error">{error}</p>}
    </section>
  );
}
