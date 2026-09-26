/**
 * Brush/bucket/polygon/autofill selector, brush size + tolerance sliders,
 * and undo/redo controls with a clickable visual history list.
 */

import { useEffect, useRef, useState } from "react";
import { useUiStore } from "@/state/uiStore";
import { useToolStore } from "@/state/toolStore";
import { useSessionStore } from "@/state/sessionStore";
import { useClassStore } from "@/state/classStore";
import { applyTool, undoMask, redoMask, swapClass, copyInferenceToMask } from "@/api/client";
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
  const fillAllRequestToken = useToolStore((s) => s.fillAllRequestToken);

  const setLastUsedTool = useUiStore((s) => s.setLastUsedTool);

  const activeScene = useSessionStore((s) => s.activeScene());
  const bumpSceneRefreshToken = useSessionStore((s) => s.bumpSceneRefreshToken);
  const updateScene = useSessionStore((s) => s.updateScene);
  const selectedClass = useClassStore((s) => s.selectedClass());
  const activeClasses = useClassStore((s) => s.activeClasses());

  const [filling, setFilling] = useState(false);
  const [fillError, setFillError] = useState<string | null>(null);
  const [confirmFillOpen, setConfirmFillOpen] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [autoFilling, setAutoFilling] = useState(false);
  const [autoFillError, setAutoFillError] = useState<string | null>(null);

  // Swap class: "every pixel currently class A becomes class B" -- a bulk
  // fix for a mistaken assignment, distinct from /remap's color-based match
  // (which can't safely target the reserved Nodata pseudo-class, always
  // rendered white regardless of any real class that also happens to be
  // white). See swap_class in sidecar/api/routers/masks.py.
  const [swapFromValue, setSwapFromValue] = useState<number | "">("");
  const [swapToValue, setSwapToValue] = useState<number | "">("");
  const [swapping, setSwapping] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [swapDryRunCount, setSwapDryRunCount] = useState<number | null>(null);
  const [confirmSwapOpen, setConfirmSwapOpen] = useState(false);

  const [copyingInference, setCopyingInference] = useState(false);
  const [copyInferenceError, setCopyInferenceError] = useState<string | null>(null);

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

  // The "Fill entire scene" keyboard shortcut (App.tsx) bumps
  // fillAllRequestToken rather than calling a handler directly -- it has no
  // reach into this component's local confirm-dialog state, so it goes
  // through the shared store instead.
  //
  // ToolPanel mounts/unmounts every time the Tools panel is toggled (see
  // App.tsx's `{panelVisibility.tools && <ToolPanel />}`), and the token
  // itself lives in the persistent toolStore and never resets -- so this
  // must ignore whatever value the token already had *when this instance
  // mounted*, not just "the first change it happens to observe" (a
  // mount-scoped "skip once" ref falls apart under React StrictMode's
  // deliberate double-invoke-effects-in-dev behavior, and doesn't
  // generalize to a remount anyway). lastSeenFillAllToken is initialized
  // lazily from the store's *current* value, so only a token bump that
  // happens after this specific mount is treated as a real request.
  const lastSeenFillAllToken = useRef(fillAllRequestToken);
  useEffect(() => {
    if (fillAllRequestToken === lastSeenFillAllToken.current) return;
    lastSeenFillAllToken.current = fillAllRequestToken;
    handleFillAllClick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillAllRequestToken]);

  const handleConfirmFillAll = async () => {
    if (!activeScene || !selectedClass) return;
    setConfirmFillOpen(false);
    setFilling(true);
    setFillError(null);
    try {
      const result = await applyTool(activeScene.id, { tool: "fill_all", params: {}, class_value: selectedClass.value });
      updateScene(activeScene.id, { qa_status: result.qa_status });
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
      const result = await applyTool(activeScene.id, { tool: "autofill", params: {}, class_value: selectedClass.value });
      updateScene(activeScene.id, { qa_status: result.qa_status });
      bumpSceneRefreshToken();
    } catch (err) {
      setAutoFillError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutoFilling(false);
    }
  };

  const handleSwapClick = async () => {
    if (!activeScene || swapFromValue === "" || swapToValue === "" || swapFromValue === swapToValue) return;
    setSwapError(null);
    try {
      const dryRun = await swapClass(activeScene.id, {
        old_value: swapFromValue,
        new_value: swapToValue,
        dry_run: true,
      });
      setSwapDryRunCount(dryRun.affected_pixels);
      setConfirmSwapOpen(true);
    } catch (err) {
      setSwapError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfirmSwap = async () => {
    if (!activeScene || swapFromValue === "" || swapToValue === "") return;
    setConfirmSwapOpen(false);
    setSwapping(true);
    setSwapError(null);
    try {
      const result = await swapClass(activeScene.id, { old_value: swapFromValue, new_value: swapToValue, dry_run: false });
      updateScene(activeScene.id, { qa_status: result.qa_status });
      bumpSceneRefreshToken();
    } catch (err) {
      setSwapError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwapping(false);
      setSwapDryRunCount(null);
    }
  };

  const swapFromClass = activeClasses.find((c) => c.value === swapFromValue);
  const swapToClass = activeClasses.find((c) => c.value === swapToValue);

  const handleCopyInference = async () => {
    if (!activeScene?.inference_path) return;
    setCopyingInference(true);
    setCopyInferenceError(null);
    try {
      const result = await copyInferenceToMask(activeScene.id);
      updateScene(activeScene.id, { qa_status: result.qa_status });
      bumpSceneRefreshToken();
    } catch (err) {
      setCopyInferenceError(err instanceof Error ? err.message : String(err));
    } finally {
      setCopyingInference(false);
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

      <div className="panel__field tool-panel__swap-class">
        <span className="panel__label">Swap class (fix a mistake)</span>
        <p className="panel__hint">Reassign every pixel currently one class to another, across the whole scene.</p>
        <div className="panel__field-row">
          <select
            aria-label="From class"
            value={swapFromValue}
            onChange={(e) => setSwapFromValue(e.target.value === "" ? "" : Number(e.target.value))}
          >
            <option value="">From…</option>
            {activeClasses.map((cls) => (
              <option key={cls.id} value={cls.value}>
                {cls.name}
              </option>
            ))}
          </select>
          <span>&rarr;</span>
          <select
            aria-label="To class"
            value={swapToValue}
            onChange={(e) => setSwapToValue(e.target.value === "" ? "" : Number(e.target.value))}
          >
            <option value="">To…</option>
            {activeClasses.map((cls) => (
              <option key={cls.id} value={cls.value}>
                {cls.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => void handleSwapClick()}
          disabled={
            swapping || !activeScene || swapFromValue === "" || swapToValue === "" || swapFromValue === swapToValue
          }
        >
          {swapping ? "Swapping…" : "Swap"}
        </button>
        {swapError && <p className="panel__error">{swapError}</p>}
      </div>

      <Dialog
        open={confirmSwapOpen}
        title="Swap class"
        onClose={() => setConfirmSwapOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setConfirmSwapOpen(false)}>
              Cancel
            </button>
            <button type="button" className="dialog__confirm" onClick={() => void handleConfirmSwap()}>
              Swap {swapDryRunCount?.toLocaleString()} pixels
            </button>
          </>
        }
      >
        <p>
          Reassign <strong>{swapDryRunCount?.toLocaleString()}</strong> pixel(s) currently &quot;
          {swapFromClass?.name}&quot; to &quot;{swapToClass?.name}&quot; on the active scene?
        </p>
      </Dialog>

      <button
        type="button"
        className="tool-panel__fill-all"
        onClick={() => void handleCopyInference()}
        disabled={copyingInference || !activeScene?.inference_path}
        title={
          activeScene?.inference_path
            ? "Fill still-empty pixels from this scene's inference class map"
            : "No inference available for this scene"
        }
      >
        {copyingInference ? "Copying…" : "Copy inference to mask"}
      </button>
      {copyInferenceError && <p className="panel__error">{copyInferenceError}</p>}

      <div className="panel__field">
        <label htmlFor="brush-size">Brush size</label>
        <div className="panel__field-row">
          <input
            id="brush-size"
            type="range"
            min={1}
            max={50}
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
