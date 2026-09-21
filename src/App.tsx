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
import { useUiStore } from "@/state/uiStore";
import { useSessionStore } from "@/state/sessionStore";
import { useClassStore } from "@/state/classStore";
import { useViewportStore } from "@/state/viewportStore";
import { useToolStore } from "@/state/toolStore";
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

  const panelCount = 3; // Raw / Mask / Shadow
  const totalGap = CANVAS_GAP_PX * (panelCount - 1);
  const usableWidth = Math.max(0, canvasAreaSize.width - totalGap);
  const evenWidth = Math.max(MIN_PANEL_SIZE, Math.floor(usableWidth / panelCount));
  const panelWidths = [evenWidth, evenWidth, evenWidth];
  const panelHeight = Math.max(MIN_PANEL_SIZE, Math.floor(canvasAreaSize.height));

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

  // Load layers whenever the active scene changes.
  useEffect(() => {
    if (!activeScene) {
      setSceneLayers(null);
      return;
    }
    let cancelled = false;
    getSceneLayers(activeScene.id)
      .then((layers) => {
        if (!cancelled) setSceneLayers(layers);
      })
      .catch(() => {
        if (!cancelled) setSceneLayers(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeScene, sceneRefreshToken]);

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
  const contentWidth = sceneLayers?.raw?.width ?? sceneLayers?.mask?.width ?? 0;
  const contentHeight = sceneLayers?.raw?.height ?? sceneLayers?.mask?.height ?? 0;
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

  const handleMaskUpdated = (pngBase64: string, bbox: [number, number, number, number]) => {
    // /tool's response only carries the PNG for the changed bbox region
    // (a small crop, not the full-scene layer) -- it exists for a future
    // incremental-redraw optimization, but naively assigning it as the
    // whole mask's png_base64 would replace the entire layer image with
    // that tiny cropped stamp (rendered stretched to fill the panel,
    // looking like the mask turned solid black). Always refetch the full
    // layer set instead until partial redraw is actually implemented.
    void pngBase64;
    void bbox;
    if (!activeScene) return;
    getSceneLayers(activeScene.id)
      .then((layers) => setSceneLayers(layers))
      .catch(() => {});
    // Every paint/polygon/tool edit lands here, and already fetches its own
    // fresh layers above -- bump statsRefreshToken only (not
    // sceneRefreshToken, which would trigger a second, redundant
    // getSceneLayers call on every single paint stamp and was the main
    // source of per-stroke paint latency). StatsPanel's per-class pixel
    // counts key off statsRefreshToken so they still recompute here.
    bumpStatsRefreshToken();
  };

  const panels = [
    { kind: "raw" as const, label: "Raw" },
    { kind: "mask" as const, label: "Mask" },
    { kind: "shadow" as const, label: "Shadow" },
  ];

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
              showContours={showContours}
              showDiff={showDiff && activeScene.mode === "review"}
              onMaskUpdated={handleMaskUpdated}
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
