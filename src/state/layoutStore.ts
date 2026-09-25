/**
 * Which canvas layers (RGB composite views + mask) are visible, and in what
 * left-to-right order across the canvas slots. Available layers are derived
 * per-scene from SceneEntry.rgb_composites (a scene may have anywhere from
 * 0 to 4+ RGB views), not a fixed set, so visibility/order is keyed by view
 * name rather than a closed enum. Persisted to localStorage like uiStore's
 * panelVisibility -- a per-machine display preference, not session state.
 */

import { create } from "zustand";
import type { SceneEntry } from "@/types/api";

const MASK_KEY = "mask";

/** Every RGB composite view key for a scene, falling back to raw_path/
 * shadow_path under their conventional view names when rgb_composites is
 * empty (a plain-file scene, or a scene discovered by a sidecar process
 * still running pre-rgb_composites code). Centralized here so the canvas
 * grid (App.tsx), the layout panel, and the auto-segment source picker all
 * agree on what's available for a scene -- a mismatch previously left the
 * layout panel seeing only ["mask"] while the canvas itself expected more,
 * tripping the "always keep one visible" guard and making every layout
 * control look permanently disabled. */
export function rgbKeysForScene(scene: SceneEntry | null): string[] {
  if (!scene) return [];
  const composites = Object.keys(scene.rgb_composites ?? {});
  if (composites.length > 0) return composites;
  const fallback: string[] = [];
  if (scene.raw_path) fallback.push("rgb_true_color");
  if (scene.shadow_path) fallback.push("rgb_true_color_shadow");
  return fallback;
}

/** Preferred order for the views the pipeline currently produces; any other
 * ("rgb*") view name sorts after these, alphabetically. Mirrors
 * zarr_reader.KNOWN_RGB_COMPOSITES on the backend. */
const KNOWN_ORDER = ["rgb_true_color", "rgb_true_color_shadow", "rgb_natural_color", "rgb_color_infrared"];

const HUMAN_LABELS: Record<string, string> = {
  rgb_true_color: "True color",
  rgb_true_color_shadow: "True color (shadow)",
  rgb_natural_color: "Natural color",
  rgb_color_infrared: "Color infrared",
  mask: "Mask",
};

/** A readable label for a layer key -- falls back to a light humanization of
 * an unrecognized "rgb_*" view name (e.g. "rgb_swir_blend" -> "Swir blend"). */
export function layerLabel(key: string): string {
  if (HUMAN_LABELS[key]) return HUMAN_LABELS[key];
  const stripped = key.replace(/^rgb_/, "").replace(/_/g, " ");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function defaultOrder(keys: string[]): string[] {
  const rgbKeys = keys.filter((k) => k !== MASK_KEY);
  rgbKeys.sort((a, b) => {
    const ai = KNOWN_ORDER.indexOf(a);
    const bi = KNOWN_ORDER.indexOf(b);
    const aRank = ai === -1 ? KNOWN_ORDER.length : ai;
    const bRank = bi === -1 ? KNOWN_ORDER.length : bi;
    if (aRank !== bRank) return aRank - bRank;
    return a.localeCompare(b);
  });
  return keys.includes(MASK_KEY) ? [...rgbKeys, MASK_KEY] : rgbKeys;
}

/** Pure function version of the store's orderedKeys, taking the order map
 * as a plain argument instead of reading it via get(). Exists so a
 * component can select the reactive `order` map itself (which Zustand can
 * actually diff and re-render on) and compute the ordering locally, rather
 * than selecting the store's orderedKeys *function* -- a function's
 * identity never changes, so a component selecting it never re-renders when
 * the underlying order map it closes over changes. */
export function orderLayerKeys(availableKeys: string[], order: Record<string, number>): string[] {
  const fallback = defaultOrder(availableKeys);
  const rank = (key: string) => order[key] ?? fallback.indexOf(key);
  return [...availableKeys].sort((a, b) => rank(a) - rank(b));
}

/** Pure function version of the store's visibleOrderedKeys -- see
 * orderLayerKeys's doc for why this takes visibility/order as plain
 * arguments instead of being read off the store as a function. */
export function visibleOrderedLayerKeys(
  availableKeys: string[],
  visibility: Record<string, boolean>,
  order: Record<string, number>,
): string[] {
  return orderLayerKeys(availableKeys, order).filter((key) => visibility[key] ?? true);
}

const VISIBILITY_STORAGE_KEY = "maskforge.layout.visibility";
const ORDER_STORAGE_KEY = "maskforge.layout.order";

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
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

interface LayoutState {
  /** Visibility per layer key, persisted across scenes/sessions. A key
   * absent from this map defaults to visible (so a newly-seen RGB view
   * shows up rather than being silently hidden). */
  visibility: Record<string, boolean>;
  /** Manual left-to-right order overrides, persisted across scenes/sessions,
   * keyed by layer key. Any key not in here falls back to defaultOrder's
   * position for that key. */
  order: Record<string, number>;

  isVisible: (key: string) => boolean;
  /** No-ops if `key` is currently the only visible layer among
   * `availableKeys` -- at least one layer must always stay on screen. */
  toggleVisible: (key: string, availableKeys: string[]) => void;
  moveUp: (key: string, availableKeys: string[]) => void;
  moveDown: (key: string, availableKeys: string[]) => void;
  /** Ordered list of every available key (visible or not), for the layout
   * panel's full list. */
  orderedKeys: (availableKeys: string[]) => string[];
  /** Ordered list of only the visible keys, for the canvas slots. */
  visibleOrderedKeys: (availableKeys: string[]) => string[];
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  visibility: readStorage(VISIBILITY_STORAGE_KEY, {} as Record<string, boolean>),
  order: readStorage(ORDER_STORAGE_KEY, {} as Record<string, number>),

  isVisible: (key) => get().visibility[key] ?? true,

  toggleVisible: (key, availableKeys) => {
    const isCurrentlyVisible = get().isVisible(key);
    if (isCurrentlyVisible) {
      const otherVisible = availableKeys.some((k) => k !== key && get().isVisible(k));
      if (!otherVisible) return; // refuse to hide the last visible layer
    }
    const next = { ...get().visibility, [key]: !isCurrentlyVisible };
    writeStorage(VISIBILITY_STORAGE_KEY, next);
    set({ visibility: next });
  },

  orderedKeys: (availableKeys) => orderLayerKeys(availableKeys, get().order),

  visibleOrderedKeys: (availableKeys) => visibleOrderedLayerKeys(availableKeys, get().visibility, get().order),

  moveUp: (key, availableKeys) => {
    const ordered = get().orderedKeys(availableKeys);
    const idx = ordered.indexOf(key);
    if (idx <= 0) return;
    [ordered[idx - 1], ordered[idx]] = [ordered[idx], ordered[idx - 1]];
    const next: Record<string, number> = {};
    ordered.forEach((k, i) => {
      next[k] = i;
    });
    writeStorage(ORDER_STORAGE_KEY, next);
    set({ order: next });
  },

  moveDown: (key, availableKeys) => {
    const ordered = get().orderedKeys(availableKeys);
    const idx = ordered.indexOf(key);
    if (idx === -1 || idx >= ordered.length - 1) return;
    [ordered[idx + 1], ordered[idx]] = [ordered[idx], ordered[idx + 1]];
    const next: Record<string, number> = {};
    ordered.forEach((k, i) => {
      next[k] = i;
    });
    writeStorage(ORDER_STORAGE_KEY, next);
    set({ order: next });
  },
}));

export { MASK_KEY };
