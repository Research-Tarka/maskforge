/**
 * Active class palette + which class ids are enabled for the current
 * session + the currently selected class for painting. Palettes
 * themselves are fetched/persisted through the API client; this store
 * holds the client-side "working" view.
 */

import { create } from "zustand";
import type { ClassDef, ClassPalette } from "@/types/api";

/** Synthetic pseudo-class exposed alongside every palette's real classes so
 * the user can explicitly paint a pixel back to NODATA_VALUE (255, the
 * sidecar's "never painted" sentinel — see raster_io.py) with the normal
 * tools, instead of it only ever being an implicit initial state. Never
 * persisted through the palette API: filtered out of every
 * createPalette/updatePalette payload, and resolved here rather than looked
 * up in activePalette().classes. White matches the existing render
 * convention for an unpainted/nodata pixel (see _layer_from_mask_buffer /
 * _tool_response_from_change in masks.py). */
export const NODATA_CLASS_ID = "__nodata__";
export const NODATA_VALUE = 255;
export const NODATA_CLASS: ClassDef = {
  id: NODATA_CLASS_ID,
  name: "Nodata",
  color: [255, 255, 255],
  value: NODATA_VALUE,
  active_by_default: true,
};

interface ClassState {
  palettes: ClassPalette[];
  activePaletteId: string | null;
  activeClassIds: string[];
  selectedClassId: string | null;

  setPalettes: (palettes: ClassPalette[]) => void;
  upsertPalette: (palette: ClassPalette) => void;
  removePalette: (id: string) => void;
  setActivePaletteId: (id: string | null) => void;
  setActiveClassIds: (ids: string[]) => void;
  toggleClassActive: (classId: string) => void;
  selectClass: (classId: string | null) => void;

  activePalette: () => ClassPalette | null;
  selectedClass: () => ClassDef | null;
  activeClasses: () => ClassDef[];
}

export const useClassStore = create<ClassState>((set, get) => ({
  palettes: [],
  activePaletteId: null,
  activeClassIds: [],
  selectedClassId: null,

  setPalettes: (palettes) => set({ palettes }),

  upsertPalette: (palette) =>
    set((state) => {
      const exists = state.palettes.some((p) => p.id === palette.id);
      return {
        palettes: exists
          ? state.palettes.map((p) => (p.id === palette.id ? palette : p))
          : [...state.palettes, palette],
      };
    }),

  removePalette: (id) =>
    set((state) => ({
      palettes: state.palettes.filter((p) => p.id !== id),
      activePaletteId: state.activePaletteId === id ? null : state.activePaletteId,
    })),

  setActivePaletteId: (id) => {
    const palette = get().palettes.find((p) => p.id === id) ?? null;
    set({
      activePaletteId: id,
      activeClassIds: palette
        ? palette.classes.filter((c) => c.active_by_default).map((c) => c.id)
        : [],
      selectedClassId: palette?.classes[0]?.id ?? null,
    });
  },

  setActiveClassIds: (ids) => set({ activeClassIds: ids }),

  toggleClassActive: (classId) =>
    set((state) => {
      const isActive = state.activeClassIds.includes(classId);
      return {
        activeClassIds: isActive
          ? state.activeClassIds.filter((id) => id !== classId)
          : [...state.activeClassIds, classId],
      };
    }),

  selectClass: (classId) => set({ selectedClassId: classId }),

  activePalette: () => {
    const { palettes, activePaletteId } = get();
    return palettes.find((p) => p.id === activePaletteId) ?? null;
  },

  selectedClass: () => {
    const { selectedClassId } = get();
    if (!selectedClassId) return null;
    if (selectedClassId === NODATA_CLASS_ID) return NODATA_CLASS;
    const palette = get().activePalette();
    if (!palette) return null;
    return palette.classes.find((c) => c.id === selectedClassId) ?? null;
  },

  activeClasses: () => {
    const palette = get().activePalette();
    const { activeClassIds } = get();
    if (!palette) return [];
    const real = palette.classes.filter((c) => activeClassIds.includes(c.id));
    return [...real, NODATA_CLASS];
  },
}));
