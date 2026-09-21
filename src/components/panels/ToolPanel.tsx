/**
 * Brush/bucket/polygon/autofill selector, brush size + tolerance sliders,
 * and undo/redo controls with a clickable visual history list.
 */

import { useState } from "react";
import { useUiStore } from "@/state/uiStore";
import { useToolStore } from "@/state/toolStore";
import { useSessionStore } from "@/state/sessionStore";
import { useClassStore } from "@/state/classStore";
import { applyTool, undoMask, redoMask } from "@/api/client";
import Dialog from "@/components/common/Dialog";
import type { ToolKind } from "@/types/api";

const TOOLS: { id: ToolKind; label: string; hint: string }[] = [
  { id: "brush", label: "Brush", hint: "Freehand paint with a fixed-radius stamp" },
  { id: "bucket", label: "Bucket", hint: "Flood-fill connected mask pixels" },
  { id: "polygon", label: "Polygon", hint: "Click to place vertices, close to fill" },
  { id: "autofill", label: "Auto-fill", hint: "Fill every still-empty pixel in the scene" },
];

export default function ToolPanel() {
  const activeTool = useToolStore((s) => s.activeTool);
  const setActiveTool = useToolStore((s) => s.setActiveTool);
  const brushSize = useToolStore((s) => s.brushSize);
  const setBrushSize = useToolStore((s) => s.setBrushSize);
  const tolerance = useToolStore((s) => s.tolerance);
  const setTolerance = useToolStore((s) => s.setTolerance);

  const setLastUsedTool = useUiStore((s) => s.setLastUsedTool);

  const activeScene = useSessionStore((s) => s.activeScene());
  const bumpSceneRefreshToken = useSessionStore((s) => s.bumpSceneRefreshToken);
  const selectedClass = useClassStore((s) => s.selectedClass());

  const [filling, setFilling] = useState(false);
  const [fillError, setFillError] = useState<string | null>(null);
  const [confirmFillOpen, setConfirmFillOpen] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [autoFilling, setAutoFilling] = useState(false);
  const [autoFillError, setAutoFillError] = useState<string | null>(null);

  // Undo/redo are server-side (the sidecar keeps whole-buffer snapshots per
  // scene, see MaskBuffer.push_undo_snapshot in api/state.py) -- this just
  // triggers the endpoint and refetches the scene's layers, rather than
  // trying to replay a client-side diff stack against a buffer it doesn't
  // own.
  const handleUndo = async () => {
    if (!activeScene) return;
    setUndoing(true);
    setUndoError(null);
    try {
      await undoMask(activeScene.id);
      bumpSceneRefreshToken();
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : String(err));
    } finally {
      setUndoing(false);
    }
  };

  const handleRedo = async () => {
    if (!activeScene) return;
    setUndoing(true);
    setUndoError(null);
    try {
      await redoMask(activeScene.id);
      bumpSceneRefreshToken();
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : String(err));
    } finally {
      setUndoing(false);
    }
  };

  const handleSelectTool = (tool: ToolKind) => {
    setActiveTool(tool);
    setLastUsedTool(tool);
  };

  // window.confirm is blocked by Tauri's webview (no native dialog host by
  // default) -- it throws "dialog.confirm not allowed", which aborted this
  // handler silently before ever reaching applyTool. Use the in-app Dialog
  // instead.
  const handleFillAllClick = () => {
    if (!activeScene || !selectedClass) return;
    setConfirmFillOpen(true);
  };

  const handleConfirmFillAll = async () => {
    if (!activeScene || !selectedClass) return;
    setConfirmFillOpen(false);
    setFilling(true);
    setFillError(null);
    try {
      await applyTool(activeScene.id, { tool: "fill_all", params: {}, class_value: selectedClass.value });
      bumpSceneRefreshToken();
    } catch (err) {
      setFillError(err instanceof Error ? err.message : String(err));
    } finally {
      setFilling(false);
    }
  };

  const handleAutoFill = async () => {
    if (!activeScene || !selectedClass) return;
    setAutoFilling(true);
    setAutoFillError(null);
    try {
      await applyTool(activeScene.id, { tool: "autofill", params: {}, class_value: selectedClass.value });
      bumpSceneRefreshToken();
    } catch (err) {
      setAutoFillError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutoFilling(false);
    }
  };

  return (
    <section className="panel tool-panel" aria-label="Tool panel">
      <h3 className="panel__title">Tools</h3>

      <div className="tool-panel__grid">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={`tool-panel__tool${activeTool === tool.id ? " is-active" : ""}`}
            onClick={() => handleSelectTool(tool.id)}
            title={tool.hint}
            aria-pressed={activeTool === tool.id}
          >
            {tool.label}
          </button>
        ))}
      </div>

      {activeTool === "autofill" && (
        <>
          <button
            type="button"
            className="tool-panel__fill-all"
            onClick={() => void handleAutoFill()}
            disabled={autoFilling || !activeScene || !selectedClass}
            title="Fill every still-empty pixel in the scene with the selected class"
          >
            {autoFilling ? "Filling…" : "Fill empty pixels"}
          </button>
          {autoFillError && <p className="panel__error">{autoFillError}</p>}
        </>
      )}

      <button
        type="button"
        className="tool-panel__fill-all"
        onClick={handleFillAllClick}
        disabled={filling || !activeScene || !selectedClass}
        title="Set every pixel in the scene to the selected class"
      >
        {filling ? "Filling…" : "Fill entire scene"}
      </button>
      {fillError && <p className="panel__error">{fillError}</p>}

      <Dialog
        open={confirmFillOpen}
        title="Fill entire scene"
        onClose={() => setConfirmFillOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setConfirmFillOpen(false)}>
              Cancel
            </button>
            <button type="button" onClick={() => void handleConfirmFillAll()}>
              Fill
            </button>
          </>
        }
      >
        <p>
          Fill the entire scene with &quot;{selectedClass?.name}&quot;? This overwrites every pixel currently on
          the mask.
        </p>
      </Dialog>

      <div className="panel__field">
        <label htmlFor="brush-size">Brush size</label>
        <div className="panel__field-row">
          <input
            id="brush-size"
            type="range"
            min={1}
            max={400}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
          />
          <span className="panel__field-value">{brushSize}px</span>
        </div>
      </div>

      <div className="panel__field">
        <label htmlFor="tolerance">Tolerance</label>
        <div className="panel__field-row">
          <input
            id="tolerance"
            type="range"
            min={0}
            max={255}
            value={tolerance}
            onChange={(e) => setTolerance(Number(e.target.value))}
          />
          <span className="panel__field-value">{tolerance}</span>
        </div>
        <p className="panel__hint">Applies to the bucket tool</p>
      </div>

      <div className="tool-panel__history">
        <div className="tool-panel__history-header">
          <h4>History</h4>
          <div className="tool-panel__history-actions">
            <button type="button" onClick={() => void handleUndo()} disabled={undoing || !activeScene}>
              Undo
            </button>
            <button type="button" onClick={() => void handleRedo()} disabled={undoing || !activeScene}>
              Redo
            </button>
          </div>
        </div>
        {undoError && <p className="panel__error">{undoError}</p>}
      </div>
    </section>
  );
}
