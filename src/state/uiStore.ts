/**
 * UI-level preferences: theme, keybindings, panel visibility, last-used
 * tool. Persisted to localStorage as an interim store — session ui_state
 * on the backend (SessionState.ui_state) is the longer-term home for
 * anything that should roam with a session, but keybindings and theme are
 * genuinely per-machine preferences so localStorage is the right place.
 */

import { create } from "zustand";
import type { ToolKind } from "@/types/api";

export type Theme = "light" | "dark";

export type KeybindingAction =
  | "tool.brush"
  | "tool.bucket"
  | "tool.polygon"
  | "tool.autofill"
  | "action.undo"
  | "action.redo"
  | "action.save"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.resetZoom"
  | "view.toggleContours"
  | "view.toggleDiff"
  | "scene.next"
  | "scene.previous"
  | "panel.toggleTools"
  | "panel.toggleClasses"
  | "panel.toggleDiscovery"
  | "panel.toggleSaveConfig"
  | "panel.toggleShadowGen"
  | "panel.toggleSession"
  | "panel.toggleQa"
  | "panel.toggleStats"
  | "panel.toggleKeybindings"
  | "panel.toggleAutoSegment";

export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, string> = {
  "tool.brush": "&",
  "tool.bucket": "É",
  "tool.polygon": "\"",
  "tool.autofill": "'",
  "action.undo": "Ctrl+Z",
  "action.redo": "Ctrl+Shift+Z",
  "action.save": "Ctrl+S",
  "view.zoomIn": "Ctrl+=",
  "view.zoomOut": "Ctrl+-",
  "view.resetZoom": "Ctrl+0",
  "view.toggleContours": "C",
  "view.toggleDiff": "D",
  "scene.next": "Ctrl+Right",
  "scene.previous": "Ctrl+Left",
  "panel.toggleTools": "1",
  "panel.toggleClasses": "2",
  "panel.toggleDiscovery": "3",
  "panel.toggleSaveConfig": "4",
  "panel.toggleShadowGen": "5",
  "panel.toggleSession": "6",
  "panel.toggleQa": "7",
  "panel.toggleStats": "8",
  "panel.toggleKeybindings": "9",
  "panel.toggleAutoSegment": "0",
};

export const KEYBINDING_LABELS: Record<KeybindingAction, string> = {
  "tool.brush": "Brush tool",
  "tool.bucket": "Bucket tool",
  "tool.polygon": "Polygon tool",
  "tool.autofill": "Auto-fill tool",
  "action.undo": "Undo",
  "action.redo": "Redo",
  "action.save": "Save mask",
  "view.zoomIn": "Zoom in",
  "view.zoomOut": "Zoom out",
  "view.resetZoom": "Reset zoom",
  "view.toggleContours": "Toggle contours",
  "view.toggleDiff": "Toggle diff overlay",
  "scene.next": "Next scene",
  "scene.previous": "Previous scene",
  "panel.toggleTools": "Toggle tool panel",
  "panel.toggleClasses": "Toggle class palette panel",
  "panel.toggleDiscovery": "Toggle discovery panel",
  "panel.toggleSaveConfig": "Toggle save panel",
  "panel.toggleShadowGen": "Toggle shadow generation panel",
  "panel.toggleSession": "Toggle sessions panel",
  "panel.toggleQa": "Toggle QA panel",
  "panel.toggleStats": "Toggle stats panel",
  "panel.toggleKeybindings": "Toggle keybindings panel",
  "panel.toggleAutoSegment": "Toggle auto-segment panel",
};

export type PanelId =
  | "tools"
  | "classes"
  | "discovery"
  | "saveConfig"
  | "shadowGen"
  | "session"
  | "qa"
  | "stats"
  | "keybindings"
  | "autoSegment";

const DEFAULT_PANEL_VISIBILITY: Record<PanelId, boolean> = {
  tools: true,
  classes: true,
  discovery: false,
  saveConfig: false,
  shadowGen: false,
  session: false,
  qa: true,
  stats: false,
  keybindings: false,
  autoSegment: false,
};

const THEME_STORAGE_KEY = "maskforge.theme";
const KEYBINDINGS_STORAGE_KEY = "maskforge.keybindings";
const PANELS_STORAGE_KEY = "maskforge.panelVisibility";
const LAST_TOOL_STORAGE_KEY = "maskforge.lastTool";

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) } as T;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage unavailable (private browsing, etc.) — degrade silently
  }
}

interface UiState {
  theme: Theme;
  keybindings: Record<KeybindingAction, string>;
  panelVisibility: Record<PanelId, boolean>;
  lastUsedTool: ToolKind;

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setKeybinding: (action: KeybindingAction, chord: string) => void;
  resetKeybindings: () => void;
  togglePanel: (panel: PanelId) => void;
  setPanelVisible: (panel: PanelId, visible: boolean) => void;
  setLastUsedTool: (tool: ToolKind) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: readStorage<{ value: Theme }>(THEME_STORAGE_KEY, { value: "dark" }).value,
  keybindings: readStorage(KEYBINDINGS_STORAGE_KEY, DEFAULT_KEYBINDINGS),
  panelVisibility: readStorage(PANELS_STORAGE_KEY, DEFAULT_PANEL_VISIBILITY),
  lastUsedTool: readStorage<{ value: ToolKind }>(LAST_TOOL_STORAGE_KEY, { value: "brush" }).value,

  setTheme: (theme) => {
    writeStorage(THEME_STORAGE_KEY, { value: theme });
    set({ theme });
  },

  toggleTheme: () => {
    const next: Theme = get().theme === "dark" ? "light" : "dark";
    writeStorage(THEME_STORAGE_KEY, { value: next });
    set({ theme: next });
  },

  setKeybinding: (action, chord) => {
    const next = { ...get().keybindings, [action]: chord };
    writeStorage(KEYBINDINGS_STORAGE_KEY, next);
    set({ keybindings: next });
  },

  resetKeybindings: () => {
    writeStorage(KEYBINDINGS_STORAGE_KEY, DEFAULT_KEYBINDINGS);
    set({ keybindings: { ...DEFAULT_KEYBINDINGS } });
  },

  togglePanel: (panel) => {
    const next = { ...get().panelVisibility, [panel]: !get().panelVisibility[panel] };
    writeStorage(PANELS_STORAGE_KEY, next);
    set({ panelVisibility: next });
  },

  setPanelVisible: (panel, visible) => {
    const next = { ...get().panelVisibility, [panel]: visible };
    writeStorage(PANELS_STORAGE_KEY, next);
    set({ panelVisibility: next });
  },

  setLastUsedTool: (tool) => {
    writeStorage(LAST_TOOL_STORAGE_KEY, { value: tool });
    set({ lastUsedTool: tool });
  },
}));
