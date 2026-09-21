/**
 * Shared pan/zoom state for every LayerCanvas panel in the multi-panel
 * canvas. All panels read from this single store so that panning or
 * zooming one panel moves every other panel in lockstep.
 */

import { create } from "zustand";

const MIN_SCALE = 0.05;
const MAX_SCALE = 40;

interface ViewportState {
  scale: number;
  offsetX: number;
  offsetY: number;
  setViewport: (partial: Partial<Pick<ViewportState, "scale" | "offsetX" | "offsetY">>) => void;
  panBy: (dx: number, dy: number) => void;
  /** Zoom so that `focalPoint` (in stage/screen coordinates) stays fixed under the cursor. */
  zoomAt: (focalPoint: { x: number; y: number }, scaleFactor: number) => void;
  resetViewport: () => void;
  fitToSize: (contentWidth: number, contentHeight: number, viewportWidth: number, viewportHeight: number) => void;
}

export const useViewportStore = create<ViewportState>((set, get) => ({
  scale: 1,
  offsetX: 0,
  offsetY: 0,

  setViewport: (partial) => set(partial),

  panBy: (dx, dy) =>
    set((state) => ({ offsetX: state.offsetX + dx, offsetY: state.offsetY + dy })),

  zoomAt: (focalPoint, scaleFactor) => {
    const { scale, offsetX, offsetY } = get();
    const nextScale = clamp(scale * scaleFactor, MIN_SCALE, MAX_SCALE);
    const appliedFactor = nextScale / scale;

    // Keep the point under the cursor stationary: adjust offset so the
    // world point currently under focalPoint maps to the same screen point
    // after scaling.
    const nextOffsetX = focalPoint.x - (focalPoint.x - offsetX) * appliedFactor;
    const nextOffsetY = focalPoint.y - (focalPoint.y - offsetY) * appliedFactor;

    set({ scale: nextScale, offsetX: nextOffsetX, offsetY: nextOffsetY });
  },

  resetViewport: () => set({ scale: 1, offsetX: 0, offsetY: 0 }),

  fitToSize: (contentWidth, contentHeight, viewportWidth, viewportHeight) => {
    if (contentWidth <= 0 || contentHeight <= 0) return;
    const scale = clamp(
      Math.min(viewportWidth / contentWidth, viewportHeight / contentHeight),
      MIN_SCALE,
      MAX_SCALE,
    );
    const offsetX = (viewportWidth - contentWidth * scale) / 2;
    const offsetY = (viewportHeight - contentHeight * scale) / 2;
    set({ scale, offsetX, offsetY });
  },
}));

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
