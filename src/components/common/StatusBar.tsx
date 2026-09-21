/**
 * Bottom status bar: current scene id, zoom %, active class, sidecar
 * connection status.
 */

import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "@/state/sessionStore";
import { useViewportStore } from "@/state/viewportStore";
import { useClassStore } from "@/state/classStore";
import { getHealth } from "@/api/client";
import { parseSceneEntryId, MONTH_LABELS } from "@/utils/sceneKey";
import AboutDialog from "./AboutDialog";

const HEALTH_POLL_MS = 10000;

interface StatusBarProps {
  /** Current scene's raw/mask layer dimensions and the canvas area's
   * measured on-screen size -- needed to reset the view to the same
   * fit-to-panel state used when a scene first loads, rather than a
   * generic scale=1/offset=0 that ignores the image's real size. */
  fitTarget?: {
    contentWidth: number;
    contentHeight: number;
    viewportWidth: number;
    viewportHeight: number;
  } | null;
}

export default function StatusBar({ fitTarget }: StatusBarProps) {
  const activeScene = useSessionStore((s) => s.activeScene());
  const scenes = useSessionStore((s) => s.scenes);
  const activeSceneIndex = useSessionStore((s) => s.activeSceneIndex);
  const connectionStatus = useSessionStore((s) => s.connectionStatus);
  const setConnectionStatus = useSessionStore((s) => s.setConnectionStatus);
  const scale = useViewportStore((s) => s.scale);
  const fitToSize = useViewportStore((s) => s.fitToSize);
  const selectedClass = useClassStore((s) => s.selectedClass());
  const [aboutOpen, setAboutOpen] = useState(false);

  const sceneMeta = useMemo(() => (activeScene ? parseSceneEntryId(activeScene.id) : null), [activeScene]);

  const handleResetView = () => {
    if (!fitTarget) return;
    fitToSize(fitTarget.contentWidth, fitTarget.contentHeight, fitTarget.viewportWidth, fitTarget.viewportHeight);
  };

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        await getHealth();
        if (!cancelled) setConnectionStatus("connected");
      } catch {
        if (!cancelled) setConnectionStatus("disconnected");
      }
    };

    void poll();
    const interval = setInterval(poll, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [setConnectionStatus]);

  return (
    <footer className="status-bar">
      <div className="status-bar__section">
        <span className="status-bar__label">Scene</span>
        <span className="status-bar__value">
          {activeScene ? `${activeScene.id} (${activeSceneIndex + 1}/${scenes.length})` : "No scene loaded"}
        </span>
      </div>

      <div className="status-bar__section">
        <span className="status-bar__label">Zoom</span>
        <span className="status-bar__value">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={handleResetView} disabled={!fitTarget} title="Reset pan/zoom to fit the scene">
          Reset view
        </button>
      </div>

      <div className="status-bar__section">
        <span className="status-bar__label">Class</span>
        <span className="status-bar__value">
          {selectedClass ? (
            <>
              <span
                className="status-bar__swatch"
                style={{
                  backgroundColor: `rgb(${selectedClass.color[0]}, ${selectedClass.color[1]}, ${selectedClass.color[2]})`,
                }}
              />
              {selectedClass.name}
            </>
          ) : (
            "None selected"
          )}
        </span>
      </div>

      <div className="status-bar__section">
        <span className="status-bar__label">Tile - Satellite - Year - Month</span>
        <span className="status-bar__value">
          {sceneMeta
            ? `${sceneMeta.tileId} - ${sceneMeta.sensor.toUpperCase()} - ${sceneMeta.year ?? "?"} - ${
                sceneMeta.month ? MONTH_LABELS[sceneMeta.month - 1] : "?"
              }`
            : "—"}
        </span>
      </div>

      <div className="status-bar__section status-bar__section--connection">
        <span className={`status-bar__connection-dot status-bar__connection-dot--${connectionStatus}`} />
        <span className="status-bar__value">
          {connectionStatus === "connected"
            ? "Sidecar connected"
            : connectionStatus === "connecting"
              ? "Connecting to sidecar…"
              : "Sidecar unreachable"}
        </span>
      </div>

      <div className="status-bar__section">
        <button type="button" onClick={() => setAboutOpen(true)} title="License and copyright information">
          About
        </button>
      </div>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </footer>
  );
}
