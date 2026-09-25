/**
 * Unsupervised clustering (K-Means/GMM) draft segmentation. Groups pixels
 * by color and local texture similarity — no notion of what any class
 * means, and no glacio-/geo-specific assumptions, so it applies to any
 * raster image. Explicitly a draft: preview the clusters, decide which
 * cluster maps to which of the session's active classes (skip the rest),
 * then apply on top of the mask and keep correcting with the normal tools.
 */

import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "@/state/sessionStore";
import { useClassStore } from "@/state/classStore";
import { useAutoSegmentStore } from "@/state/autoSegmentStore";
import { layerLabel, rgbKeysForScene } from "@/state/layoutStore";
import { previewAutoSegment, applyAutoSegment, discardAutoSegment } from "@/api/client";
import type { ClusterMethod } from "@/types/api";

const METHODS: { id: ClusterMethod; label: string }[] = [
  { id: "kmeans", label: "K-Means" },
  { id: "gmm", label: "Gaussian mixture" },
];

function rgbString(color: number[]): string {
  const [r, g, b] = color;
  return `rgb(${Math.round(r)}, ${Math.round(g ?? r)}, ${Math.round(b ?? r)})`;
}

export default function AutoSegmentPanel() {
  const activeScene = useSessionStore((s) => s.activeScene());
  const bumpSceneRefreshToken = useSessionStore((s) => s.bumpSceneRefreshToken);
  const activeClasses = useClassStore((s) => s.activeClasses());

  const assignMode = useAutoSegmentStore((s) => s.assignMode);
  const setAssignMode = useAutoSegmentStore((s) => s.setAssignMode);
  const assignClassValue = useAutoSegmentStore((s) => s.assignClassValue);
  const setAssignClassValue = useAutoSegmentStore((s) => s.setAssignClassValue);
  const preview = useAutoSegmentStore((s) => s.preview);
  const setPreview = useAutoSegmentStore((s) => s.setPreview);
  const assignments = useAutoSegmentStore((s) => s.assignments);
  const setAssignments = useAutoSegmentStore((s) => s.setAssignments);

  const maxClusters = Math.max(2, activeClasses.length || 2);

  // Every RGB composite view this scene has -- the checked subset is
  // stacked band-wise server-side before clustering (see
  // masks.py::_load_auto_segment_sources), so any combination is valid, not
  // just the old fixed raw/shadow/both choices.
  const availableSources = useMemo(() => rgbKeysForScene(activeScene), [activeScene]);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [nClusters, setNClusters] = useState(maxClusters);
  const [method, setMethod] = useState<ClusterMethod>("kmeans");
  const [useTexture, setUseTexture] = useState(true);

  // Default to every available source selected when the scene (and thus its
  // set of RGB views) changes, rather than leaving the picker empty.
  useEffect(() => {
    setSelectedSources(new Set(availableSources));
  }, [availableSources]);

  const toggleSource = (id: string) => {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Keep the cluster count within [2, number of active classes] as the
  // active palette changes — a cluster with nowhere to be assigned isn't
  // useful, so this is a hard cap rather than just a warning.
  useEffect(() => {
    setNClusters((n) => Math.min(n, maxClusters));
  }, [maxClusters]);

  // Leave assign-by-click mode if the panel is hidden/unmounted while
  // active — otherwise the canvas would silently stay in that mode with
  // no visible control left to exit it.
  useEffect(() => () => setAssignMode(false), [setAssignMode]);

  // A stale preview from the previous scene must not linger as an overlay
  // (or a pending-apply target) once the user switches scenes -- the
  // backend's own buf.pending_auto_segment is per-scene-buffer already, but
  // the frontend's preview/assignments state was not scoped to a scene.
  useEffect(() => {
    setPreview(null);
    setAssignments({});
  }, [activeScene?.id, setPreview, setAssignments]);

  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const handlePreview = async () => {
    if (!activeScene || selectedSources.size === 0) return;
    setPreviewing(true);
    setError(null);
    setResult(null);
    setPreview(null);
    setAssignMode(false);
    try {
      const res = await previewAutoSegment(activeScene.id, {
        sources: [...selectedSources],
        n_clusters: nClusters,
        method,
        use_texture: useTexture,
      });
      setPreview(res);
      setAssignments({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const handleApply = async () => {
    if (!activeScene || !preview) return;
    const clusterToClass: Record<number, number> = {};
    for (const cluster of preview.clusters) {
      const classId = assignments[cluster.cluster_id];
      if (!classId) continue;
      const cls = activeClasses.find((c) => c.id === classId);
      if (cls) clusterToClass[cluster.cluster_id] = cls.value;
    }
    if (Object.keys(clusterToClass).length === 0) {
      setError("Assign at least one cluster to a class before applying.");
      return;
    }

    setApplying(true);
    setError(null);
    try {
      const res = await applyAutoSegment(activeScene.id, { cluster_to_class: clusterToClass });
      setResult(`Applied to ${res.bbox[2] - res.bbox[0]}x${res.bbox[3] - res.bbox[1]} px region.`);
      setPreview(null);
      setAssignments({});
      setAssignMode(false);
      bumpSceneRefreshToken();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  const handleDiscard = async () => {
    if (!activeScene) return;
    // Clear locally right away so the overlay disappears immediately
    // rather than waiting on the round trip -- worst case the backend
    // call fails and a stale buf.pending_auto_segment lingers server-side,
    // but it's inert until another preview overwrites it or apply/
    // apply-component targets it (both already re-check scene/shape).
    setPreview(null);
    setAssignments({});
    setAssignMode(false);
    setResult(null);
    setError(null);
    try {
      await discardAutoSegment(activeScene.id);
    } catch {
      // Best-effort: the preview is already gone from the UI either way.
    }
  };

  return (
    <section className="panel auto-segment-panel" aria-label="Auto-segment panel">
      <h3 className="panel__title">Auto-segment (draft)</h3>
      <p className="panel__hint">
        Groups pixels by color/texture similarity into clusters &mdash; it does not know what
        any class is. Review the preview, assign clusters to classes (or skip clusters that
        aren&rsquo;t useful), apply, then keep correcting with the normal tools. Runs on CPU
        only and typically finishes in about a second on a scene this size.
      </p>

      <div className="panel__field">
        <span className="panel__label">Source image(s)</span>
        {availableSources.length === 0 && (
          <p className="panel__hint">This scene has no RGB views to segment.</p>
        )}
        {availableSources.map((id) => (
          <label key={id} className="panel__checkbox">
            <input type="checkbox" checked={selectedSources.has(id)} onChange={() => toggleSource(id)} />
            {layerLabel(id)}
          </label>
        ))}
        <p className="panel__hint">
          Check any combination of the detected RGB views &mdash; they&rsquo;re stacked together
          before clustering, giving it more information than any single view alone (e.g. an
          infrared view can separate colors that look identical in true color).
        </p>
      </div>

      <div className="panel__field">
        <label htmlFor="autoseg-method">Method</label>
        <select id="autoseg-method" value={method} onChange={(e) => setMethod(e.target.value as ClusterMethod)}>
          {METHODS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="panel__field">
        <label htmlFor="autoseg-clusters">Number of clusters (maximum)</label>
        <div className="panel__field-row">
          <input
            id="autoseg-clusters"
            type="range"
            min={2}
            max={maxClusters}
            value={nClusters}
            onChange={(e) => setNClusters(Number(e.target.value))}
          />
          <span className="panel__field-value">{nClusters}</span>
        </div>
        <p className="panel__hint">
          Capped at {maxClusters} (the number of active classes in the current palette) &mdash;
          a cluster with no class to assign it to isn&rsquo;t useful. This is a ceiling, not a
          target: if the image doesn&rsquo;t actually have this many visually distinct groups,
          fewer clusters come back in the preview.
        </p>
      </div>

      <label className="panel__checkbox">
        <input type="checkbox" checked={useTexture} onChange={(e) => setUseTexture(e.target.checked)} />
        Include local texture (helps separate smooth vs. rough areas of similar color)
      </label>

      <button
        type="button"
        onClick={() => void handlePreview()}
        disabled={previewing || !activeScene || selectedSources.size === 0}
      >
        {previewing ? "Clustering…" : "Preview"}
      </button>

      {preview && (
        <div className="auto-segment-panel__preview">
          <h4 className="panel__subtitle">Assign clusters to classes</h4>
          <ul className="auto-segment-panel__cluster-list">
            {preview.clusters.map((cluster) => (
              <li key={cluster.cluster_id} className="auto-segment-panel__cluster-row">
                <span
                  className="auto-segment-panel__swatch"
                  style={{ background: rgbString(cluster.preview_color) }}
                  title={`Mean color: ${cluster.mean_color.map((v) => v.toFixed(1)).join(", ")}`}
                />
                <span className="auto-segment-panel__cluster-label">Cluster {cluster.cluster_id}</span>
                <select
                  value={assignments[cluster.cluster_id] ?? ""}
                  onChange={(e) => setAssignments({ ...assignments, [cluster.cluster_id]: e.target.value })}
                >
                  <option value="">Skip</option>
                  {activeClasses.map((cls) => (
                    <option key={cls.id} value={cls.id}>
                      {cls.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
          <div className="panel__field-row">
            <button type="button" onClick={() => void handleApply()} disabled={applying}>
              {applying ? "Applying…" : "Apply all clusters to mask"}
            </button>
            <button
              type="button"
              onClick={() => void handleDiscard()}
              disabled={applying}
              title="Discard this preview without applying it — the overlay disappears and no changes are made"
            >
              Discard
            </button>
          </div>

          <div className="auto-segment-panel__component-assign">
            <h4 className="panel__subtitle">Or assign one region at a time</h4>
            <p className="panel__hint">
              If the same color cluster covers two separate areas that should be different
              classes (e.g. snow at the top and a cloud elsewhere), pick a class and click
              directly on the canvas &mdash; only the connected region you click is affected.
            </p>
            <div className="panel__field-row">
              <select
                value={assignClassValue ?? ""}
                onChange={(e) => setAssignClassValue(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Choose a class…</option>
                {activeClasses.map((cls) => (
                  <option key={cls.id} value={cls.value}>
                    {cls.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={assignMode ? "is-active" : undefined}
                disabled={assignClassValue == null}
                onClick={() => setAssignMode(!assignMode)}
              >
                {assignMode ? "Click canvas to assign… (click again to stop)" : "Start clicking to assign"}
              </button>
            </div>
          </div>
        </div>
      )}

      {result && <p className="panel__success">{result}</p>}
      {error && <p className="panel__error">{error}</p>}
    </section>
  );
}
