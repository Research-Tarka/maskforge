/**
 * Cross-cutting state for the auto-segment feature: the "assign by
 * clicking" mode (clicks on the canvas call /auto-segment/apply-component
 * instead of the normal paint tools) plus the current preview result and
 * its cluster-to-class assignments-in-progress. Kept separate from
 * toolStore (whose activeTool is strictly the four real DrawingTool kinds)
 * since none of this is a paint tool — it's state shared between
 * AutoSegmentPanel (which drives it) and MultiPanelCanvas (which renders
 * the preview overlay and listens for assign-mode clicks).
 */

import { create } from "zustand";
import type { AutoSegmentResult } from "@/types/api";

interface AutoSegmentStoreState {
  /** True while the user is expected to click canvas regions to assign
   * pending auto-segment clusters to classes one component at a time. */
  assignMode: boolean;
  /** Class value clicks should currently assign — set by AutoSegmentPanel
   * before/while assignMode is active. */
  assignClassValue: number | null;
  /** The most recent preview result, or null once applied/cleared --
   * MultiPanelCanvas renders this as an overlay on the mask panel. */
  preview: AutoSegmentResult | null;
  /** cluster_id -> class id chosen so far, before Apply. Drives which
   * clusters the preview overlay highlights as "assigned". */
  assignments: Record<number, string>;

  setAssignMode: (active: boolean) => void;
  setAssignClassValue: (value: number | null) => void;
  setPreview: (preview: AutoSegmentResult | null) => void;
  setAssignments: (assignments: Record<number, string>) => void;
}

export const useAutoSegmentStore = create<AutoSegmentStoreState>((set) => ({
  assignMode: false,
  assignClassValue: null,
  preview: null,
  assignments: {},

  setAssignMode: (active) => set({ assignMode: active }),
  setAssignClassValue: (value) => set({ assignClassValue: value }),
  setPreview: (preview) => set({ preview }),
  setAssignments: (assignments) => set({ assignments }),
}));
