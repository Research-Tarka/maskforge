/**
 * UI-level preferences: theme, keybindings, panel visibility, last-used
 * tool. Persisted to localStorage as an interim store — session ui_state
 * on the backend (SessionState.ui_state) is the longer-term home for
 * anything that should roam with a session, but keybindings and theme are
 * genuinely per-machine preferences so localStorage is the right place.
 *
 * Keybindings are matched by KeyboardEvent.key (the character actually
 * produced), not .code (physical key position) -- .key already reflects
 * the OS's active *software* keyboard layout regardless of what physical
 * hardware is plugged in (e.g. a physically QWERTY keyboard remapped to
 * type AZERTY at the OS level correctly produces "&" for key 1, no extra
 * detection needed), which is what actually matters here: the shortcut
 * should fire for the character the user is used to typing, not a fixed
 * physical position that stays "&" even if they switch their OS layout to
 * QWERTY.
 */

import { create } from "zustand";
import type { ToolKind } from "@/types/api";

export type Theme = "light" | "dark";

export type KeybindingAction =
  | "tool.brush"
  | "tool.bucket"
  | "tool.polygon"
  | "tool.autofill"
  | "tool.fillAll"
  | "action.undo"
  | "action.redo"
  | "action.save"
  | "action.flagScene"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.resetZoom"
  | "view.toggleContours"
  | "view.toggleDiff"
  | "view.panLeft"
  | "view.panRight"
  | "view.panUp"
  | "view.panDown"
  | "scene.next"
  | "scene.previous"
  | "panel.toggleTools"
  | "panel.toggleClasses"
  | "panel.toggleDiscovery"
  | "panel.toggleSaveConfig"
  | "panel.toggleSession"
  | "panel.toggleQa"
  | "panel.toggleStats"
  | "panel.toggleKeybindings"
  | "panel.toggleAutoSegment"
  | "panel.toggleLayout";

// AZERTY defaults (this app's primary userbase) -- tools on the shifted
// number-row punctuation ("&é"'(" == Shift+1..5 on a French keyboard,
// produced as bare characters without needing an explicit Shift chord),
// panels on the numeric keypad, a separate key cluster from the tool
// shortcuts so the two groups never collide.
export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, string> = {
  "tool.brush": "&",
  "tool.bucket": "É",
  "tool.polygon": "\"",
  "tool.autofill": "'",
  "tool.fillAll": "(",
  "action.undo": "Ctrl+Z",
  "action.redo": "Ctrl+E",
  "action.save": "Ctrl+S",
  "action.flagScene": "Ctrl+F",
  "view.zoomIn": "Ctrl+=",
  "view.zoomOut": "Ctrl+-",
  "view.resetZoom": "Ctrl+*",
  "view.toggleContours": "W",
  "view.toggleDiff": "X",
  "view.panLeft": "ArrowLeft",
  "view.panRight": "ArrowRight",
  "view.panUp": "ArrowUp",
  "view.panDown": "ArrowDown",
  "scene.next": "Ctrl+D",
  "scene.previous": "Ctrl+A",
  "panel.toggleTools": "1",
  "panel.toggleClasses": "2",
  "panel.toggleDiscovery": "3",
  "panel.toggleSaveConfig": "4",
  "panel.toggleSession": "5",
  "panel.toggleQa": "6",
  "panel.toggleStats": "7",
  "panel.toggleKeybindings": "8",
  "panel.toggleAutoSegment": "9",
  "panel.toggleLayout": "L",
};

export const KEYBINDING_LABELS: Record<KeybindingAction, string> = {
  "tool.brush": "Brush tool",
  "tool.bucket": "Bucket tool",
  "tool.polygon": "Polygon tool",
  "tool.autofill": "Auto-fill tool",
  "tool.fillAll": "Fill entire scene",
  "action.undo": "Undo",
  "action.redo": "Redo",
  "action.save": "Save mask",
  "action.flagScene": "Flag scene (skip)",
  "view.zoomIn": "Zoom in",
  "view.zoomOut": "Zoom out",
  "view.resetZoom": "Reset zoom",
  "view.toggleContours": "Toggle contours",
  "view.toggleDiff": "Toggle diff overlay",
  "view.panLeft": "Pan left",
  "view.panRight": "Pan right",
  "view.panUp": "Pan up",
  "view.panDown": "Pan down",
  "scene.next": "Next scene",
  "scene.previous": "Previous scene",
  "panel.toggleTools": "Toggle tool panel",
  "panel.toggleClasses": "Toggle class palette panel",
  "panel.toggleDiscovery": "Toggle discovery panel",
  "panel.toggleSaveConfig": "Toggle save panel",
  "panel.toggleSession": "Toggle sessions panel",
  "panel.toggleQa": "Toggle QA panel",
  "panel.toggleStats": "Toggle stats panel",
  "panel.toggleKeybindings": "Toggle keybindings panel",
  "panel.toggleAutoSegment": "Toggle auto-segment panel",
  "panel.toggleLayout": "Toggle layout panel",
};

export type PanelId =
  | "tools"
  | "classes"
  | "discovery"
  | "saveConfig"
  | "session"
  | "qa"
  | "stats"
  | "keybindings"
  | "autoSegment"
  | "layout";

const DEFAULT_PANEL_VISIBILITY: Record<PanelId, boolean> = {
  tools: true,
  classes: true,
  discovery: false,
  saveConfig: false,
  session: false,
  qa: true,
  stats: false,
  keybindings: false,
  autoSegment: false,
  layout: false,
};

const THEME_STORAGE_KEY = "maskforge.theme";
const KEYBINDINGS_STORAGE_KEY = "maskforge.keybindings.v3";
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
