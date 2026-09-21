/**
 * Current SessionState, the active scene queue/index, and a dirty flag
 * driving a 500ms-debounced autosave to the backend via updateSession.
 */

import { create } from "zustand";
import type { SceneEntry, SessionState } from "@/types/api";
import { updateSession } from "@/api/client";

const AUTOSAVE_DEBOUNCE_MS = 500;

/** A scene counts as "done" if either signal says so: `mode === "review"`
 * (a mask now exists on disk) or `qa_status === "validated"` (reviewed and
 * accepted in the QA workflow) -- the two are set independently (mode by
 * save/discovery, qa_status by the QA panel), so checking only one lets a
 * scene validated in QA but not yet re-discovered keep being proposed. */
export function isSceneDone(scene: SceneEntry): boolean {
  return scene.mode === "review" || scene.qa_status === "validated";
}

export type SidecarConnectionStatus = "connecting" | "connected" | "disconnected";

interface SessionStoreState {
  session: SessionState | null;
  scenes: SceneEntry[];
  activeSceneIndex: number;
  /** Scenes checked in the Discovery panel for a batch action (e.g. export/
   * process a subset) -- purely a local UI preference, not part of the
   * SessionState schema synced with the sidecar. */
  selectedSceneIds: Set<string>;
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  lastError: string | null;
  connectionStatus: SidecarConnectionStatus;
  /** Bumped to force App.tsx's layer-loading effect to re-fetch the active
   * scene's layers from the sidecar — used after an operation (undo/redo,
   * auto-segment apply, fill-all) that rewrites the mask wholesale without
   * already having a fresh copy of the layers on hand, unlike a normal
   * paint stroke (see MultiPanelCanvas's onMaskUpdated/App.tsx's
   * handleMaskUpdated, which fetch the updated layers directly). */
  sceneRefreshToken: number;
  /** Bumped after every mask-changing action, including ones that already
   * fetch their own updated layers -- StatsPanel's per-class pixel counts
   * key off this alone, deliberately separate from sceneRefreshToken so a
   * plain paint stroke doesn't also trigger App.tsx's layer-loading effect
   * a second, redundant time on top of the fetch handleMaskUpdated already
   * does itself (that double round trip was the main source of per-stroke
   * paint latency). */
  statsRefreshToken: number;

  loadSession: (session: SessionState) => void;
  clearSession: () => void;
  updateSessionFields: (partial: Partial<SessionState>) => void;
  updateUiState: (partial: Record<string, unknown>) => void;
  updateQaState: (partial: Record<string, unknown>) => void;
  setScenes: (scenes: SceneEntry[]) => void;
  updateScene: (sceneId: string, partial: Partial<SceneEntry>) => void;
  toggleSceneSelection: (sceneId: string) => void;
  selectAllScenes: (sceneIds: string[]) => void;
  clearSceneSelection: () => void;
  setActiveSceneIndex: (index: number) => void;
  goToNextScene: () => void;
  goToNextUnfinishedScene: () => void;
  goToPreviousScene: () => void;
  setConnectionStatus: (status: SidecarConnectionStatus) => void;
  activeScene: () => SceneEntry | null;
  flushAutosave: () => Promise<void>;
  bumpSceneRefreshToken: () => void;
  bumpStatsRefreshToken: () => void;
}

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAutosave(get: () => SessionStoreState, set: (partial: Partial<SessionStoreState>) => void): void {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void runAutosave(get, set);
  }, AUTOSAVE_DEBOUNCE_MS);
}

async function runAutosave(
  get: () => SessionStoreState,
  set: (partial: Partial<SessionStoreState>) => void,
): Promise<void> {
  const { session, dirty } = get();
  if (!session || !dirty) return;

  set({ saving: true, lastError: null });
  try {
    const saved = await updateSession(session.id, session);
    set({
      session: saved,
      dirty: false,
      saving: false,
      lastSavedAt: Date.now(),
      connectionStatus: "connected",
    });
  } catch (err) {
    set({
      saving: false,
      lastError: err instanceof Error ? err.message : String(err),
      connectionStatus: "disconnected",
    });
  }
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  session: null,
  scenes: [],
  activeSceneIndex: 0,
  selectedSceneIds: new Set<string>(),
  dirty: false,
  saving: false,
  lastSavedAt: null,
  lastError: null,
  connectionStatus: "connecting",
  sceneRefreshToken: 0,
  statsRefreshToken: 0,

  loadSession: (session) => set({ session, dirty: false, activeSceneIndex: 0 }),

  clearSession: () =>
    set({ session: null, scenes: [], activeSceneIndex: 0, dirty: false, selectedSceneIds: new Set<string>() }),

  updateSessionFields: (partial) => {
    const current = get().session;
    if (!current) return;
    set({ session: { ...current, ...partial }, dirty: true });
    scheduleAutosave(get, set);
  },

  updateUiState: (partial) => {
    const current = get().session;
    if (!current) return;
    set({
      session: { ...current, ui_state: { ...current.ui_state, ...partial } },
      dirty: true,
    });
    scheduleAutosave(get, set);
  },

  updateQaState: (partial) => {
    const current = get().session;
    if (!current) return;
    set({
      session: { ...current, qa_state: { ...current.qa_state, ...partial } },
      dirty: true,
    });
    scheduleAutosave(get, set);
  },

  setScenes: (scenes) => set({ scenes, selectedSceneIds: new Set<string>() }),

  updateScene: (sceneId, partial) =>
    set((state) => ({
      scenes: state.scenes.map((s) => (s.id === sceneId ? { ...s, ...partial } : s)),
    })),

  toggleSceneSelection: (sceneId) =>
    set((state) => {
      const next = new Set(state.selectedSceneIds);
      if (next.has(sceneId)) next.delete(sceneId);
      else next.add(sceneId);
      return { selectedSceneIds: next };
    }),

  selectAllScenes: (sceneIds) => set({ selectedSceneIds: new Set(sceneIds) }),

  clearSceneSelection: () => set({ selectedSceneIds: new Set<string>() }),

  setActiveSceneIndex: (index) =>
    set((state) => ({
      activeSceneIndex: Math.min(Math.max(0, index), Math.max(0, state.scenes.length - 1)),
    })),

  goToNextScene: () =>
    set((state) => ({
      activeSceneIndex: Math.min(state.activeSceneIndex + 1, Math.max(0, state.scenes.length - 1)),
    })),

  goToNextUnfinishedScene: () =>
    set((state) => {
      const { scenes, activeSceneIndex } = state;
      if (scenes.length === 0) return {};
      // Search forward from just after the current scene, wrapping around,
      // so a scene already done -- either saved (mode "review") or
      // validated in the QA workflow (qa_status "validated") -- is skipped
      // in favor of the next one still needing work. Falls back to just
      // moving forward by one if every remaining scene is already done.
      for (let offset = 1; offset <= scenes.length; offset++) {
        const idx = (activeSceneIndex + offset) % scenes.length;
        if (!isSceneDone(scenes[idx])) {
          return { activeSceneIndex: idx };
        }
      }
      return { activeSceneIndex: Math.min(activeSceneIndex + 1, scenes.length - 1) };
    }),

  goToPreviousScene: () =>
    set((state) => ({
      activeSceneIndex: Math.max(state.activeSceneIndex - 1, 0),
    })),

  setConnectionStatus: (status) => set({ connectionStatus: status }),

  activeScene: () => {
    const { scenes, activeSceneIndex } = get();
    return scenes[activeSceneIndex] ?? null;
  },

  flushAutosave: async () => {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
    await runAutosave(get, set);
  },

  bumpSceneRefreshToken: () => set((state) => ({ sceneRefreshToken: state.sceneRefreshToken + 1 })),
  bumpStatsRefreshToken: () => set((state) => ({ statsRefreshToken: state.statsRefreshToken + 1 })),
}));
