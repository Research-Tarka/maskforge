/**
 * Active tool + tool parameters, and the undo/redo history.
 *
 * Undo/redo is memory-limited rather than count-limited: each entry stores
 * the before/after pixel buffers for the affected bounding box plus a byte
 * estimate, and the oldest entries are evicted once the running total
 * exceeds a configurable cap (default 256 MB). This keeps large brush
 * strokes from blowing the history size while letting many small edits
 * accumulate.
 */

import { create } from "zustand";
import type { ToolKind } from "@/types/api";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MaskDiff {
  sceneId: string;
  bbox: BoundingBox;
  /** RGBA (or indexed) pixel bytes for the bbox region before the edit. */
  beforePixels: Uint8Array;
  /** RGBA (or indexed) pixel bytes for the bbox region after the edit. */
  afterPixels: Uint8Array;
  label: string;
  timestamp: number;
}

const DEFAULT_MEMORY_CAP_BYTES = 256 * 1024 * 1024; // 256 MB

function diffByteSize(diff: MaskDiff): number {
  return diff.beforePixels.byteLength + diff.afterPixels.byteLength;
}

interface ToolState {
  activeTool: ToolKind;
  brushSize: number;
  tolerance: number;

  undoStack: MaskDiff[];
  redoStack: MaskDiff[];
  memoryCapBytes: number;
  usedBytes: number;

  setActiveTool: (tool: ToolKind) => void;
  setBrushSize: (size: number) => void;
  setTolerance: (tolerance: number) => void;
  setMemoryCapBytes: (cap: number) => void;

  pushDiff: (diff: MaskDiff) => void;
  undo: () => MaskDiff | null;
  redo: () => MaskDiff | null;
  clearHistory: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

function evictToFit(stack: MaskDiff[], capBytes: number, incomingBytes: number): {
  stack: MaskDiff[];
  usedBytes: number;
} {
  let used = stack.reduce((sum, d) => sum + diffByteSize(d), 0) + incomingBytes;
  const trimmed = [...stack];
  while (used > capBytes && trimmed.length > 0) {
    const evicted = trimmed.shift()!;
    used -= diffByteSize(evicted);
  }
  return { stack: trimmed, usedBytes: used };
}

export const useToolStore = create<ToolState>((set, get) => ({
  activeTool: "brush",
  brushSize: 24,
  tolerance: 16,

  undoStack: [],
  redoStack: [],
  memoryCapBytes: DEFAULT_MEMORY_CAP_BYTES,
  usedBytes: 0,

  setActiveTool: (tool) => set({ activeTool: tool }),
  setBrushSize: (size) => set({ brushSize: Math.min(50, Math.max(1, Math.round(size))) }),
  setTolerance: (tolerance) => set({ tolerance: Math.min(255, Math.max(0, Math.round(tolerance))) }),
  setMemoryCapBytes: (cap) => {
    const { undoStack } = get();
    const { stack, usedBytes } = evictToFit(undoStack, cap, 0);
    set({ memoryCapBytes: cap, undoStack: stack, usedBytes });
  },

  pushDiff: (diff) => {
    const { undoStack, memoryCapBytes } = get();
    const incoming = diffByteSize(diff);
    const { stack, usedBytes } = evictToFit(undoStack, memoryCapBytes, incoming);
    set({ undoStack: [...stack, diff], redoStack: [], usedBytes });
  },

  undo: () => {
    const { undoStack, redoStack } = get();
    if (undoStack.length === 0) return null;
    const diff = undoStack[undoStack.length - 1];
    const nextUndo = undoStack.slice(0, -1);
    set({
      undoStack: nextUndo,
      redoStack: [...redoStack, diff],
      usedBytes: nextUndo.reduce((sum, d) => sum + diffByteSize(d), 0),
    });
    return diff;
  },

  redo: () => {
    const { undoStack, redoStack } = get();
    if (redoStack.length === 0) return null;
    const diff = redoStack[redoStack.length - 1];
    const nextRedo = redoStack.slice(0, -1);
    const nextUndo = [...undoStack, diff];
    set({
      undoStack: nextUndo,
      redoStack: nextRedo,
      usedBytes: nextUndo.reduce((sum, d) => sum + diffByteSize(d), 0),
    });
    return diff;
  },

  clearHistory: () => set({ undoStack: [], redoStack: [], usedBytes: 0 }),
  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,
}));
