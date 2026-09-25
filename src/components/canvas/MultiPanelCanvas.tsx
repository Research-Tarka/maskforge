/**
 * Arranges a variable number of LayerCanvas panels (RGB composite views plus
 * the mask, per the layout panel's visibility/order choices) in a
 * responsive grid, all sharing pan/zoom through viewportStore. A single
 * transparent interaction surface spans all panels: pointer events are
 * captured once, converted to world coordinates, and routed to the active
 * tool via applyTool — every panel then re-renders from the same
 * viewport, so pan/zoom is genuinely synchronized rather than mirrored
 * after the fact.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import LayerCanvas, { type LayerKind } from "@/components/canvas/LayerCanvas";
import ToolCursorPreview from "@/components/canvas/ToolCursorPreview";
import DiffOverlay from "@/components/canvas/DiffOverlay";
import AutoSegmentPreviewOverlay from "@/components/canvas/AutoSegmentPreviewOverlay";
import { Stage } from "react-konva";
import { useViewportStore } from "@/state/viewportStore";
import { useToolStore } from "@/state/toolStore";
import { useClassStore } from "@/state/classStore";
import { useSessionStore } from "@/state/sessionStore";
import { useAutoSegmentStore } from "@/state/autoSegmentStore";
import { MASK_KEY } from "@/state/layoutStore";
import { createMaskCanvas } from "@/components/canvas/maskCanvas";
import type { SceneLayers } from "@/types/api";
import { applyTool, applyAutoSegmentComponent } from "@/api/client";

interface PanelConfig {
  kind: LayerKind;
  label: string;
}

interface MultiPanelCanvasProps {
  sceneLayers: SceneLayers | null;
  panels: PanelConfig[];
  /** One width in px per panel, left to right, top to bottom (row-major). */
  panelWidths: number[];
  panelHeight: number;
  /** Number of columns in the grid -- panels wrap to a new row after this
   * many, forming a near-square matrix (e.g. 5 panels -> 3 cols x 2 rows)
   * instead of squeezing every panel into a single ever-thinner row. */
  columns: number;
  showContours: boolean;
  showDiff: boolean;
  /** Called after a one-off edit (bucket/polygon/autofill/component-assign)
   * or once at the end of a brush drag (not per stamp) -- re-fetches
   * sceneLayers from the server and resolves with the fresh value, so the
   * undo-diff snapshot below and stats can use it directly instead of
   * racing the async setState it triggers. */
  onStrokeEnd?: () => Promise<SceneLayers | null>;
}

const CURSOR_COLOR = "#f5c542";

export default function MultiPanelCanvas({
  sceneLayers,
  panels,
  panelWidths,
  panelHeight,
  columns,
  showContours,
  showDiff,
  onStrokeEnd,
}: MultiPanelCanvasProps) {
  const scale = useViewportStore((s) => s.scale);
  const offsetX = useViewportStore((s) => s.offsetX);
  const offsetY = useViewportStore((s) => s.offsetY);
  const panBy = useViewportStore((s) => s.panBy);
  const zoomAt = useViewportStore((s) => s.zoomAt);

  const activeTool = useToolStore((s) => s.activeTool);
  const brushSize = useToolStore((s) => s.brushSize);
  const tolerance = useToolStore((s) => s.tolerance);
  const pushDiff = useToolStore((s) => s.pushDiff);

  const selectedClass = useClassStore((s) => s.selectedClass());

  const activeScene = useSessionStore((s) => s.activeScene());

  const assignMode = useAutoSegmentStore((s) => s.assignMode);
  const assignClassValue = useAutoSegmentStore((s) => s.assignClassValue);
  const autoSegmentPreview = useAutoSegmentStore((s) => s.preview);
  const autoSegmentAssignments = useAutoSegmentStore((s) => s.assignments);

  const [cursorWorldPos, setCursorWorldPos] = useState<{ x: number; y: number } | null>(null);
  const [paintError, setPaintError] = useState<string | null>(null);
  const isPaintingRef = useRef(false);
  // Mirrors isPaintingRef as actual React state (a ref alone doesn't
  // trigger a re-render) so the auto-segment contour overlays can suspend
  // themselves while a stroke is in progress -- see isDrawing usage below.
  const [isDrawing, setIsDrawing] = useState(false);
  const lastMaskSnapshotRef = useRef<string | null>(null);
  // Polygon tool is click-to-add-vertex, not click-to-stamp like the other
  // tools -- vertices accumulate here until closed (double-click/Enter) or
  // cancelled (Escape/right-click), then a single /tool call rasterizes and
  // fills the whole polygon at once.
  const [polygonPoints, setPolygonPoints] = useState<{ x: number; y: number }[]>([]);

  // A persistent canvas holding the mask's current pixels, patched in place
  // by every /tool response's small bbox crop rather than replaced wholesale
  // -- see maskCanvas.ts. Kept in a ref (not React state) since it's mutated
  // very frequently (every stamp mid-drag) and mutating it must never itself
  // trigger a re-render; `maskRedrawToken` is the one piece of state bumped
  // after each mutation, purely to tell LayerCanvas's Konva layer to redraw.
  const maskCanvasHandleRef = useRef(createMaskCanvas());
  const [maskRedrawToken, setMaskRedrawToken] = useState(0);
  // The png_base64 the canvas was last fully loaded from -- lets the load
  // effect below skip re-decoding the whole layer again on a render where
  // sceneLayers.mask is a new object but its actual bytes are unchanged.
  const loadedMaskSourceRef = useRef<string | null>(null);

  // Full (re)load whenever the mask layer's actual bytes change for a reason
  // other than our own incremental patches (scene switch, undo/redo,
  // auto-segment apply/fill-all, or the very first load) -- those still go
  // through the ordinary getSceneLayers fetch in App.tsx and land here as a
  // new sceneLayers.mask.
  useEffect(() => {
    const mask = sceneLayers?.mask;
    if (!mask) {
      loadedMaskSourceRef.current = null;
      return;
    }
    if (loadedMaskSourceRef.current === mask.png_base64) return;
    let cancelled = false;
    maskCanvasHandleRef.current.loadFull(mask.png_base64, mask.width, mask.height).then(() => {
      if (cancelled) return;
      loadedMaskSourceRef.current = mask.png_base64;
      setMaskRedrawToken((t) => t + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [sceneLayers?.mask]);

  const toScreenToWorld = useCallback(
    (screenX: number, screenY: number) => ({
      x: (screenX - offsetX) / scale,
      y: (screenY - offsetY) / scale,
    }),
    [offsetX, offsetY, scale],
  );

  const handleWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const stage = e.target.getStage();
      const pointer = stage?.getPointerPosition();
      if (!pointer) return;
      const factor = e.evt.deltaY > 0 ? 0.9 : 1.1;
      zoomAt(pointer, factor);
    },
    [zoomAt],
  );

  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  // Draw a /tool response's small RGBA crop directly onto the persistent
  // mask canvas at its bbox, instead of round-tripping through
  // App.tsx's getSceneLayers (which re-fetches and re-decodes the *entire*
  // scene's mask layer). This is what makes a brush stroke feel instant --
  // the network response is already just the small changed region; the only
  // thing standing between that and a full-layer refetch was this function.
  const applyPatch = useCallback((pngBase64: string, bbox: [number, number, number, number]) => {
    void maskCanvasHandleRef.current.patchRegion(pngBase64, bbox).then(() => {
      setMaskRedrawToken((t) => t + 1);
    });
  }, []);

  const paintAt = useCallback(
    async (screenPos: { x: number; y: number }, continueStroke = false) => {
      if (!activeScene || !selectedClass) return;

      // Auto-fill targets every still-empty pixel in the whole scene, not
      // the clicked point -- no seed coordinates needed.
      if (activeTool === "autofill") {
        try {
          const result = await applyTool(activeScene.id, {
            tool: "autofill",
            params: {},
            class_value: selectedClass.value,
            continue_stroke: continueStroke,
          });
          setPaintError(null);
          applyPatch(result.png_base64, result.bbox);
          if (!continueStroke) void onStrokeEnd?.();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("applyTool failed:", err);
          setPaintError(message);
        }
        return;
      }

      const world = toScreenToWorld(screenPos.x, screenPos.y);

      const params: Record<string, unknown> =
        activeTool === "brush"
          ? { x: Math.round(world.x), y: Math.round(world.y), radius: brushSize / 2 }
          : activeTool === "bucket"
            ? { x: Math.round(world.x), y: Math.round(world.y), tolerance }
            : { x: Math.round(world.x), y: Math.round(world.y) };

      try {
        const result = await applyTool(activeScene.id, {
          tool: activeTool,
          params,
          class_value: selectedClass.value,
          continue_stroke: continueStroke,
        });
        setPaintError(null);
        applyPatch(result.png_base64, result.bbox);
        // Skip the network refresh (onStrokeEnd) for every brush stamp --
        // the canvas patch above already made the change visible instantly,
        // and handlePointerUp does the one refresh needed once the whole
        // drag ends. Without this, a brush stroke's first stamp (fired from
        // pointerDown, which always passes continueStroke=false) would pay
        // for a full getSceneLayers round trip immediately, then pointerUp
        // would pay for a second, redundant one right after -- for
        // bucket/polygon/autofill (single-stamp tools, no drag) this is the
        // only refresh they get, so they still need it here.
        if (!continueStroke && activeTool !== "brush") void onStrokeEnd?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("applyTool failed:", err);
        setPaintError(message);
      }
    },
    [activeScene, activeTool, brushSize, tolerance, selectedClass, toScreenToWorld, applyPatch, onStrokeEnd],
  );

  const fillPolygon = useCallback(
    async (points: { x: number; y: number }[]) => {
      if (!activeScene || !selectedClass || points.length < 3) return;
      try {
        const result = await applyTool(activeScene.id, {
          tool: "polygon",
          params: { points: points.map((p) => [Math.round(p.x), Math.round(p.y)]) },
          class_value: selectedClass.value,
        });
        setPaintError(null);
        applyPatch(result.png_base64, result.bbox);
        void onStrokeEnd?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("applyTool (polygon) failed:", err);
        setPaintError(message);
      }
    },
    [activeScene, selectedClass, applyPatch, onStrokeEnd],
  );

  const assignComponentAt = useCallback(
    async (screenPos: { x: number; y: number }) => {
      if (!activeScene || assignClassValue == null) return;
      const world = toScreenToWorld(screenPos.x, screenPos.y);
      try {
        const result = await applyAutoSegmentComponent(activeScene.id, {
          x: Math.round(world.x),
          y: Math.round(world.y),
          class_value: assignClassValue,
        });
        applyPatch(result.png_base64, result.bbox);
        void onStrokeEnd?.();
      } catch {
        // Surfaced via the auto-segment panel's own error state.
      }
    },
    [activeScene, assignClassValue, toScreenToWorld, applyPatch, onStrokeEnd],
  );

  const closePolygon = useCallback(() => {
    if (polygonPoints.length >= 3) void fillPolygon(polygonPoints);
    setPolygonPoints([]);
  }, [polygonPoints, fillPolygon]);

  const cancelPolygon = useCallback(() => setPolygonPoints([]), []);

  // Leaving the polygon tool (or the panel unmounting) mid-shape shouldn't
  // leave stray vertices behind with no visible way to finish or cancel.
  useEffect(() => {
    if (activeTool !== "polygon") setPolygonPoints([]);
  }, [activeTool]);

  useEffect(() => {
    if (activeTool !== "polygon") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") closePolygon();
      else if (e.key === "Escape") cancelPolygon();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTool, closePolygon, cancelPolygon]);

  const handlePointerDown = useCallback(
    (e: Konva.KonvaEventObject<PointerEvent>) => {
      const stage = e.target.getStage();
      const pointer = stage?.getPointerPosition();
      if (!pointer) return;

      // Middle-click or space-drag pans; left-click paints.
      if (e.evt.button === 1) {
        // Page-relative (clientX/Y), not stage-local getPointerPosition():
        // each panel has its own Stage with its own local origin, so if the
        // drag crosses from one panel into another mid-pan, a stage-local
        // delta would jump by that panel's own offset and fling the view.
        lastPointerRef.current = { x: e.evt.clientX, y: e.evt.clientY };
        return;
      }
      if (e.evt.button === 2) {
        if (activeTool === "polygon") cancelPolygon();
        return;
      }
      if (e.evt.button !== 0) return;

      if (assignMode) {
        void assignComponentAt(pointer);
        return;
      }

      if (!activeScene || !selectedClass) return;

      if (activeTool === "polygon") {
        // Click to add a vertex; double-click closes and fills (handled by
        // onDblClick below) rather than stamping paint on every click.
        const world = toScreenToWorld(pointer.x, pointer.y);
        setPolygonPoints((pts) => [...pts, world]);
        return;
      }

      isPaintingRef.current = true;
      setIsDrawing(true);
      lastMaskSnapshotRef.current = sceneLayers?.mask?.png_base64 ?? null;
      // First stamp of the drag pushes the undo snapshot; handlePointerMove
      // marks every subsequent stamp as continue_stroke so a whole dragged
      // brush stroke collapses into a single undo step.
      void paintAt(pointer, false);
    },
    [activeScene, activeTool, selectedClass, sceneLayers, paintAt, assignMode, assignComponentAt, cancelPolygon],
  );

  const handleDoubleClick = useCallback(() => {
    if (activeTool === "polygon") closePolygon();
  }, [activeTool, closePolygon]);

  const handlePointerMove = useCallback(
    (e: Konva.KonvaEventObject<PointerEvent>) => {
      const stage = e.target.getStage();
      const pointer = stage?.getPointerPosition();
      if (!pointer) return;

      if (lastPointerRef.current && e.evt.buttons === 4) {
        const client = { x: e.evt.clientX, y: e.evt.clientY };
        const dx = client.x - lastPointerRef.current.x;
        const dy = client.y - lastPointerRef.current.y;
        panBy(dx, dy);
        lastPointerRef.current = client;
        return;
      }

      setCursorWorldPos(toScreenToWorld(pointer.x, pointer.y));

      if (isPaintingRef.current && activeTool === "brush") {
        void paintAt(pointer, true);
      }
    },
    [panBy, toScreenToWorld, activeTool, paintAt],
  );

  const handlePointerUp = useCallback(
    (e: Konva.KonvaEventObject<PointerEvent>) => {
      if (e.evt.button === 1) {
        lastPointerRef.current = null;
        return;
      }
      if (isPaintingRef.current) {
        isPaintingRef.current = false;
        setIsDrawing(false);
        // Mid-drag stamps skip the network refresh (see paintAt) so the
        // stroke itself never waits on a round trip -- this is the one
        // point that resyncs sceneLayers.mask with the server, needed both
        // for the undo diff below and for the contour/diff overlays (which
        // read sceneLayers.mask, not the patched canvas). Only fires once
        // per whole stroke, not once per stamp. Awaits the fresh layers
        // directly (onStrokeEnd's return value) rather than reading
        // sceneLayers afterwards, which would still be the stale pre-fetch
        // value from this render's closure.
        const before = lastMaskSnapshotRef.current;
        void onStrokeEnd?.().then((freshLayers) => {
          const after = freshLayers?.mask?.png_base64 ?? null;
          if (before && after && before !== after && activeScene) {
            const enc = new TextEncoder();
            pushDiff({
              sceneId: activeScene.id,
              bbox: { x: 0, y: 0, width: freshLayers?.mask?.width ?? 0, height: freshLayers?.mask?.height ?? 0 },
              beforePixels: enc.encode(before),
              afterPixels: enc.encode(after),
              label: `${activeTool} on ${activeScene.id}`,
              timestamp: Date.now(),
            });
          }
        });
      }
    },
    [activeScene, activeTool, pushDiff, onStrokeEnd],
  );

  // Memoized so identity only changes when the preview's own clusters (or
  // assignments) actually change -- otherwise these were rebuilt as new
  // object/Set instances on every render, which re-triggered
  // AutoSegmentContourOverlay's pixel-processing effect (a full-image
  // decode + per-pixel boundary trace) on every pan/zoom pointermove,
  // visibly stuttering on a large scene (e.g. a full-resolution Sentinel-2
  // tile) even though nothing about the preview itself had changed. These
  // feed the contour overlay's skip/assigned coloring only -- the fill
  // overlay (AutoSegmentPreviewOverlay) no longer recolors by assignment,
  // per the "keep the proposed color until Apply" request.
  const autoSegmentClusterColors = useMemo(
    () =>
      Object.fromEntries((autoSegmentPreview?.clusters ?? []).map((c) => [c.cluster_id, c.preview_color])) as Record<
        number,
        [number, number, number]
      >,
    [autoSegmentPreview],
  );
  const autoSegmentAssignedIds = useMemo(
    () =>
      new Set(
        (autoSegmentPreview?.clusters ?? [])
          .filter((c) => autoSegmentAssignments[c.cluster_id])
          .map((c) => c.cluster_id),
      ),
    [autoSegmentPreview, autoSegmentAssignments],
  );

  return (
    <div className="multi-panel-canvas-wrap">
      {paintError && (
        <div className="multi-panel-canvas__paint-error">
          Paint failed: {paintError}
          <button type="button" onClick={() => setPaintError(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div
        className="multi-panel-canvas"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, columns)}, max-content)` }}
      >
        {panels.map((panel, i) => {
          const layerData =
            panel.kind === MASK_KEY ? sceneLayers?.mask ?? null : sceneLayers?.rgb[panel.kind] ?? null;

          const width = panelWidths[i] ?? 0;

          return (
            <div className="multi-panel-canvas__cell" key={panel.kind} style={{ width, height: panelHeight }}>
              <LayerCanvas
                kind={panel.kind}
                label={panel.label}
                layerData={layerData}
                width={width}
                height={panelHeight}
                showContours={showContours}
                contourSource={sceneLayers?.mask}
                // Suspended while a brush stroke is in progress: every
                // stamp mid-drag reloads the full scene layers (see
                // handleMaskUpdated in App.tsx), and retracing 2 extra
                // contour sets across 3 panels on every single pointermove
                // made freehand painting visibly stutter. The manual
                // contour (ContourOverlay) keeps updating normally --
                // only these auto-segment overlays pause, then resume
                // once the stroke ends.
                autoSegmentPreviewPngBase64={isDrawing ? null : autoSegmentPreview?.preview_png_base64 ?? null}
                autoSegmentClusterColors={autoSegmentClusterColors}
                autoSegmentAssignedClusterIds={autoSegmentAssignedIds}
                maskCanvas={panel.kind === MASK_KEY ? maskCanvasHandleRef.current.canvas : undefined}
                redrawToken={panel.kind === MASK_KEY ? maskRedrawToken : undefined}
              />
              <Stage
                className="multi-panel-canvas__interaction-surface"
                width={width}
                height={panelHeight}
                x={offsetX}
                y={offsetY}
                scaleX={scale}
                scaleY={scale}
                onWheel={handleWheel}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={() => setCursorWorldPos(null)}
                onDblClick={handleDoubleClick}
                onDblTap={handleDoubleClick}
                onContextMenu={(e) => e.evt.preventDefault()}
              >
                {panel.kind === MASK_KEY && showDiff && (
                  <DiffOverlay
                    beforeBase64={lastMaskSnapshotRef.current}
                    afterBase64={sceneLayers?.mask?.png_base64 ?? null}
                    width={sceneLayers?.mask?.width ?? 0}
                    height={sceneLayers?.mask?.height ?? 0}
                    visible={showDiff}
                  />
                )}
                {panel.kind === MASK_KEY && !isDrawing && autoSegmentPreview && (
                  <AutoSegmentPreviewOverlay
                    previewPngBase64={autoSegmentPreview.preview_png_base64}
                    width={sceneLayers?.mask?.width ?? 0}
                    height={sceneLayers?.mask?.height ?? 0}
                  />
                )}
                <ToolCursorPreview
                  tool={activeTool}
                  brushSize={brushSize}
                  scale={scale}
                  position={cursorWorldPos}
                  color={CURSOR_COLOR}
                  polygonPoints={activeTool === "polygon" ? polygonPoints : undefined}
                />
              </Stage>
            </div>
          );
        })}
      </div>
    </div>
  );
}
