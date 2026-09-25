/**
 * Top-level layout: toolbar, multi-panel canvas area, side panels, status
 * bar. On mount it bootstraps class palettes and the most recently used
 * session (falling back to an empty state when the sidecar has neither
 * yet, e.g. first run).
 */

import { useEffect, useRef, useState } from "react";
import Toolbar from "@/components/common/Toolbar";
import StatusBar from "@/components/common/StatusBar";
import ProgressToast from "@/components/common/ProgressToast";
import MultiPanelCanvas from "@/components/canvas/MultiPanelCanvas";
import ToolPanel from "@/components/panels/ToolPanel";
import ClassPalettePanel from "@/components/panels/ClassPalettePanel";
import ColorPickerPanel from "@/components/panels/ColorPickerPanel";
import DiscoveryPanel from "@/components/panels/DiscoveryPanel";
import SaveConfigPanel from "@/components/panels/SaveConfigPanel";
import ShadowGenPanel from "@/components/panels/ShadowGenPanel";
import SessionPanel from "@/components/panels/SessionPanel";
import QAPanel from "@/components/panels/QAPanel";
import StatsPanel from "@/components/panels/StatsPanel";
import KeybindingsPanel from "@/components/panels/KeybindingsPanel";
import AutoSegmentPanel from "@/components/panels/AutoSegmentPanel";
import LayoutPanel from "@/components/panels/LayoutPanel";
import { useUiStore } from "@/state/uiStore";
import { useSessionStore } from "@/state/sessionStore";
import { useClassStore } from "@/state/classStore";
import { useViewportStore } from "@/state/viewportStore";
import { useToolStore } from "@/state/toolStore";
import { useLayoutStore, layerLabel, rgbKeysForScene, visibleOrderedLayerKeys, MASK_KEY } from "@/state/layoutStore";
import { getPalettes, getScenes, getSceneLayers, getSessions, undoMask, redoMask } from "@/api/client";
import type { SceneLayers } from "@/types/api";
import "@/styles/app.css";

const CANVAS_GAP_PX = 8;
const MIN_PANEL_SIZE = 160;

export default function App() {
  const theme = useUiStore((s) => s.theme);
  const panelVisibility = useUiStore((s) => s.panelVisibility);
  const keybindings = useUiStore((s) => s.keybindings);

  const togglePanel = useUiStore((s) => s.togglePanel);

  const session = useSessionStore((s) => s.session);
  const loadSession = useSessionStore((s) => s.loadSession);
  const setScenes = useSessionStore((s) => s.setScenes);
  const activeScene = useSessionStore((s) => s.activeScene());
  const sceneRefreshToken = useSessionStore((s) => s.sceneRefreshToken);
  const bumpSceneRefreshToken = useSessionStore((s) => s.bumpSceneRefreshToken);
  const bumpStatsRefreshToken = useSessionStore((s) => s.bumpStatsRefreshToken);
  const flushAutosave = useSessionStore((s) => s.flushAutosave);
  const goToNextScene = useSessionStore((s) => s.goToNextScene);
  const goToPreviousScene = useSessionStore((s) => s.goToPreviousScene);

  const setPalettes = useClassStore((s) => s.setPalettes);
  const setActivePaletteId = useClassStore((s) => s.setActivePaletteId);

  const fitToSize = useViewportStore((s) => s.fitToSize);

  const setActiveTool = useToolStore((s) => s.setActiveTool);
  const setLastUsedTool = useUiStore((s) => s.setLastUsedTool);

  const [sceneLayers, setSceneLayers] = useState<SceneLayers | null>(null);
  const canvasAreaRef = useRef<HTMLDivElement | null>(null);
  const [canvasAreaSize, setCanvasAreaSize] = useState({ width: 0, height: 0 });

  const [showContours, setShowContours] = useState(true);
  const [showDiff, setShowDiff] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);

  // Select the raw visibility/order maps (not the store's visibleOrderedKeys
  // function) so this component actually re-renders when they change --
  // Zustand only re-renders on a changed *selected value*, and a function
  // reference pulled off the store never changes identity, so selecting the
  // function itself made toggling/reordering in the Layout panel silently
  // no-op here until some unrelated state change (e.g. a paint stroke) forced
  // a re-render for its own reasons and picked up the new layout as a side
  // effect.
  const layoutVisibility = useLayoutStore((s) => s.visibility);
  const layoutOrder = useLayoutStore((s) => s.order);
  const availableLayerKeys = activeScene ? [...rgbKeysForScene(activeScene), MASK_KEY] : [];
  const visibleLayerKeys = visibleOrderedLayerKeys(availableLayerKeys, layoutVisibility, layoutOrder);
  const panels = visibleLayerKeys.map((kind) => ({ kind, label: layerLabel(kind) }));

  // Panels are arranged in a near-square matrix rather than a single row --
  // a single row of 4-5 RGB+mask panels squeezed each one down to a sliver.
  // columns = ceil(sqrt(n)) keeps rows*cols close to n while favoring more
  // columns than rows for a typical wide canvas area (e.g. 5 -> 3x2 grid,
  // 4 -> 2x2, 3 -> 2x2 with one empty cell, 2 -> 2x1, 1 -> 1x1).
  const panelCount = Math.max(1, panels.length);
  const columns = Math.max(1, Math.ceil(Math.sqrt(panelCount)));
  const rows = Math.max(1, Math.ceil(panelCount / columns));

  const totalGapX = CANVAS_GAP_PX * (columns - 1);
  const totalGapY = CANVAS_GAP_PX * (rows - 1);
  const usableWidth = Math.max(0, canvasAreaSize.width - totalGapX);
  const usableHeight = Math.max(0, canvasAreaSize.height - totalGapY);
  const evenWidth = Math.max(MIN_PANEL_SIZE, Math.floor(usableWidth / columns));
  const evenHeight = Math.max(MIN_PANEL_SIZE, Math.floor(usableHeight / rows));
  const panelWidths = panels.map(() => evenWidth);
  const panelHeight = evenHeight;

  // Bootstrap: load palettes + most recent session (if any) on first mount.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const palettes = await getPalettes();
        if (cancelled) return;
        setPalettes(palettes);

        const sessions = await getSessions();
        if (cancelled) return;
        if (sessions.length > 0) {
          const mostRecent = sessions[sessions.length - 1];
          loadSession(mostRecent);
          if (mostRecent.active_palette_id) setActivePaletteId(mostRecent.active_palette_id);

          const scenes = await getScenes(mostRecent.id);
          if (cancelled) return;
          setScenes(scenes);
        }
      } catch (err) {
        if (!cancelled) {
          setBootError(
            err instanceof Error
              ? err.message
              : "Could not reach the sidecar. Configure a session and discover scenes once it is available.",
          );
        }
      } finally {
        if (!cancelled) setBooted(true);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply theme as a data attribute on <html> so CSS variables cascade globally.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Track the canvas area's real size so panel dimensions follow the
  // window/panel layout instead of a fixed constant -- a fixed size left
  // Konva's Stage larger than its container once shrunk, silently cropped
  // by the wrapper's overflow: hidden rather than scaling down.
  useEffect(() => {
    const el = canvasAreaRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setCanvasAreaSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Load layers whenever the active scene (or its visible RGB views) change.
  // Only the RGB views currently visible in a canvas slot are requested --
  // decoding/encoding a composite the layout panel has hidden would be
  // wasted work, and this is the endpoint hit on every brush stamp mid-drag,
  // so the saving compounds. A brief extra fetch when the user reveals a
  // previously-hidden view is an acceptable trade for not paying for it on
  // every single stroke while it stays hidden.
  const visibleRgbKeys = visibleLayerKeys.filter((k) => k !== MASK_KEY);
  const visibleRgbKeysKey = visibleRgbKeys.join(",");
  useEffect(() => {
    if (!activeScene) {
      setSceneLayers(null);
      return;
    }
    let cancelled = false;
    getSceneLayers(activeScene.id, visibleRgbKeys)
      .then((layers) => {
        if (!cancelled) setSceneLayers(layers);
      })
      .catch(() => {
        if (!cancelled) setSceneLayers(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScene, sceneRefreshToken, visibleRgbKeysKey]);

  // Fit the viewport to the loaded scene's real pixel size, once both the
  // image dimensions and the panel's measured on-screen size are known.
  // Without this, the viewport stays at scale 1 / offset 0 regardless of
  // the image's real size -- any part of the panel beyond the image's
  // pixel dimensions maps to world coordinates outside the mask buffer, so
  // clicks there hit BrushTool's `0 <= x < w` bounds check and silently
  // no-op (see _stamp in tools.py). Running this only once panelWidths[0]
  // is a real measured value (not the 0 it starts at before the
  // ResizeObserver's first callback) avoids fitting against a 0x0
  // viewport, which would collapse the scale to near-zero.
  //
  // Keyed on scene id + content dimensions (not the whole sceneLayers
  // object) -- sceneLayers gets a new object identity after every paint
  // stroke (handleMaskUpdated refetches it), and re-fitting on every one of
  // those reset the user's zoom/pan mid-annotation.
  const firstRgbLayer = visibleRgbKeys.length > 0 ? sceneLayers?.rgb[visibleRgbKeys[0]] : undefined;
  const contentWidth = firstRgbLayer?.width ?? sceneLayers?.mask?.width ?? 0;
  const contentHeight = firstRgbLayer?.height ?? sceneLayers?.mask?.height ?? 0;
  useEffect(() => {
    if (contentWidth <= 0 || contentHeight <= 0) return;
    if (panelWidths[0] <= 0 || panelHeight <= 0) return;
    fitToSize(contentWidth, contentHeight, panelWidths[0], panelHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScene?.id, contentWidth, contentHeight, panelWidths[0], panelHeight]);

  // Global keyboard shortcuts: view toggles (contours, diff) and panel
  // visibility toggles, mirroring the buttons in the Toolbar.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.shiftKey) parts.push("Shift");
      if (e.altKey) parts.push("Alt");
      let key = e.key;
      if (key.length === 1) key = key.toUpperCase();
      parts.push(key);
      const chord = parts.join("+");

      if (chord === keybindings["tool.brush"]) {
        setActiveTool("brush");
        setLastUsedTool("brush");
        return;
      }
      if (chord === keybindings["tool.bucket"]) {
        setActiveTool("bucket");
        setLastUsedTool("bucket");
        return;
      }
      if (chord === keybindings["tool.polygon"]) {
        setActiveTool("polygon");
        setLastUsedTool("polygon");
        return;
      }
      if (chord === keybindings["tool.autofill"]) {
        setActiveTool("autofill");
        setLastUsedTool("autofill");
        return;
      }

      if (chord === keybindings["view.toggleContours"]) return setShowContours((v) => !v);
      if (chord === keybindings["view.toggleDiff"]) return setShowDiff((v) => !v);
      if (chord === keybindings["panel.toggleTools"]) return togglePanel("tools");
      if (chord === keybindings["panel.toggleClasses"]) return togglePanel("classes");
      if (chord === keybindings["panel.toggleDiscovery"]) return togglePanel("discovery");
      if (chord === keybindings["panel.toggleSaveConfig"]) return togglePanel("saveConfig");
      if (chord === keybindings["panel.toggleShadowGen"]) return togglePanel("shadowGen");
      if (chord === keybindings["panel.toggleSession"]) return togglePanel("session");
      if (chord === keybindings["panel.toggleQa"]) return togglePanel("qa");
      if (chord === keybindings["panel.toggleStats"]) return togglePanel("stats");
      if (chord === keybindings["panel.toggleKeybindings"]) return togglePanel("keybindings");
      if (chord === keybindings["panel.toggleAutoSegment"]) return togglePanel("autoSegment");
      if (chord === keybindings["panel.toggleLayout"]) return togglePanel("layout");

      if (chord === keybindings["action.undo"]) {
        e.preventDefault();
        if (!activeScene) return;
        void undoMask(activeScene.id).then(bumpSceneRefreshToken);
        return;
      }
      if (chord === keybindings["action.redo"]) {
        e.preventDefault();
        if (!activeScene) return;
        void redoMask(activeScene.id).then(bumpSceneRefreshToken);
        return;
      }
      if (chord === keybindings["action.save"]) {
        // Ctrl+S defaults to the browser's "Save page" dialog -- always
        // preventDefault for this chord regardless of whether there's an
        // active session to flush.
        e.preventDefault();
        if (session) void flushAutosave();
        return;
      }
      if (chord === keybindings["scene.next"]) return goToNextScene();
      if (chord === keybindings["scene.previous"]) return goToPreviousScene();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    keybindings,
    togglePanel,
    activeScene,
    bumpSceneRefreshToken,
    session,
    flushAutosave,
    goToNextScene,
    goToPreviousScene,
    setActiveTool,
    setLastUsedTool,
  ]);

  // MultiPanelCanvas patches the mask canvas directly from each /tool
  // response's small bbox crop (see maskCanvas.ts) for instant visual
  // feedback -- this is only called once per one-off edit (bucket/polygon/
  // autofill/component-assign) or once at the end of a brush drag (not once
  // per stamp), to resync sceneLayers.mask with the server for the undo-diff
  // snapshot, contour/diff overlays, and stats, none of which read the
  // patched canvas directly.
  const handleStrokeEnd = async () => {
    if (!activeScene) return null;
    try {
      const layers = await getSceneLayers(activeScene.id, visibleRgbKeys);
      setSceneLayers(layers);
      bumpStatsRefreshToken();
      return layers;
    } catch {
      return null;
    }
  };

  return (
    <div className="app-shell">
      <Toolbar />

      <div className="app-shell__body">
        <div className="app-shell__canvas-area" ref={canvasAreaRef}>
          {!booted && <div className="app-shell__empty-state"><h2>Connecting…</h2></div>}

          {booted && !session && (
            <div className="app-shell__empty-state">
              <h2>No session loaded</h2>
              <p>
                {bootError ??
                  "Create a session from the Sessions panel, then configure scene discovery to get started."}
              </p>
            </div>
          )}

          {booted && session && !activeScene && (
            <div className="app-shell__empty-state">
              <h2>No scene loaded</h2>
              <p>Open the Discovery panel and run a scan to populate the scene queue.</p>
            </div>
          )}

          {booted && session && activeScene && (
            <MultiPanelCanvas
              sceneLayers={sceneLayers}
              panels={panels}
              panelWidths={panelWidths}
              panelHeight={panelHeight}
              columns={columns}
              showContours={showContours}
              showDiff={showDiff && activeScene.mode === "review"}
              onStrokeEnd={handleStrokeEnd}
            />
          )}
        </div>

        <aside className="app-shell__side-panels">
          {panelVisibility.tools && <ToolPanel />}
          {panelVisibility.classes && <ClassPalettePanel />}
          {panelVisibility.classes && <ColorPickerPanel />}
          {panelVisibility.discovery && <DiscoveryPanel />}
          {panelVisibility.saveConfig && <SaveConfigPanel />}
          {panelVisibility.shadowGen && <ShadowGenPanel />}
          {panelVisibility.session && <SessionPanel />}
          {panelVisibility.qa && <QAPanel />}
          {panelVisibility.stats && <StatsPanel />}
          {panelVisibility.keybindings && <KeybindingsPanel />}
          {panelVisibility.autoSegment && <AutoSegmentPanel />}
          {panelVisibility.layout && <LayoutPanel />}
        </aside>
      </div>

      <StatusBar
        fitTarget={
          contentWidth > 0 && contentHeight > 0 && panelWidths[0] > 0 && panelHeight > 0
            ? { contentWidth, contentHeight, viewportWidth: panelWidths[0], viewportHeight: panelHeight }
            : null
        }
      />
      <ProgressToast />
    </div>
  );
}
