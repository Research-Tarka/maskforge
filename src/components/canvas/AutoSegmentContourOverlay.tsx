/**
 * Draws thin, non-dilated boundaries between auto-segment preview clusters
 * -- the same "line exactly on the pixel boundary" technique as
 * ContourOverlay, but computed from the preview PNG instead of the real
 * mask, and split into two colors: one for clusters still unassigned
 * ("skip"), one for clusters the user has picked a class for (not yet
 * applied). Rendered on every panel (raw/shadow/mask), same as the manual
 * contour, so the draft is visible against the source imagery too.
 *
 * The preview PNG already carries alpha=0 over pixels MaskForge considers
 * already painted (see masks.py's auto_segment_preview) -- Apply never
 * overwrites those, so a boundary never gets traced there, and the manual
 * contour is what shows in that area instead. This keeps what's drawn
 * always matching what Apply would actually do.
 */

import { useEffect, useRef, useState } from "react";
import { Layer, Shape } from "react-konva";
import type Konva from "konva";

interface AutoSegmentContourOverlayProps {
  previewPngBase64: string | null;
  /** cluster_id -> its swatch color from AutoSegmentClusterInfo, used to
   * identify which cluster a decoded pixel belongs to. */
  clusterColors: Record<number, [number, number, number]>;
  /** cluster_id -> true once assigned to a class (but not yet applied). */
  assignedClusterIds: Set<number>;
  width: number;
  height: number;
  scale: number;
  skipColor?: string;
  assignedColor?: string;
  alpha?: number;
}

interface TracedSegments {
  key: string;
  skip: number[][];
  assigned: number[][];
}

const cache = new Map<string, TracedSegments>();
const CACHE_LIMIT = 12;

function decodeToImageData(base64: string, width: number, height: number): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("2D canvas context unavailable for auto-segment contour tracing"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(ctx.getImageData(0, 0, width, height));
    };
    img.onerror = () => reject(new Error("Failed to decode auto-segment preview PNG"));
    img.src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
  });
}

function traceClusterContours(
  imageData: ImageData,
  assignedColorKeys: Set<string>,
): { skip: number[][]; assigned: number[][] } {
  const { width, height, data } = imageData;
  const skip: number[][] = [];
  const assigned: number[][] = [];

  // Each boundary pixel belongs to exactly one cluster color (or is
  // transparent/excluded) -- a segment is drawn in whichever bucket the
  // *painted* side of the boundary belongs to, so a transparent-vs-cluster
  // edge (the outer rim of a cluster against already-annotated ground)
  // still traces correctly using the one real side.
  const keyAt = (x: number, y: number): string | null => {
    const idx = (y * width + x) * 4;
    if (data[idx + 3] === 0) return null;
    return `${data[idx]},${data[idx + 1]},${data[idx + 2]}`;
  };
  const bucketFor = (key: string): number[][] => (assignedColorKeys.has(key) ? assigned : skip);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const a = keyAt(x, y);
      const b = keyAt(x + 1, y);
      if (a !== b) {
        const side = a ?? b;
        if (side) bucketFor(side).push([x + 1, y, x + 1, y + 1]);
      }
    }
  }
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width; x++) {
      const a = keyAt(x, y);
      const b = keyAt(x, y + 1);
      if (a !== b) {
        const side = a ?? b;
        if (side) bucketFor(side).push([x, y + 1, x + 1, y + 1]);
      }
    }
  }

  return { skip, assigned };
}

export default function AutoSegmentContourOverlay({
  previewPngBase64,
  clusterColors,
  assignedClusterIds,
  width,
  height,
  scale,
  skipColor = "#4dd0e1",
  assignedColor = "#e91e8c",
  alpha = 0.9,
}: AutoSegmentContourOverlayProps) {
  const [segments, setSegments] = useState<{ skip: number[][]; assigned: number[][] }>({
    skip: [],
    assigned: [],
  });
  const requestId = useRef(0);

  useEffect(() => {
    if (!previewPngBase64 || width <= 0 || height <= 0) {
      setSegments({ skip: [], assigned: [] });
      return;
    }

    const assignedColorKeys = new Set(
      Array.from(assignedClusterIds)
        .map((id) => clusterColors[id])
        .filter((c): c is [number, number, number] => !!c)
        .map((c) => c.join(",")),
    );

    const cacheKey = `${previewPngBase64}|${Array.from(assignedColorKeys).sort().join(";")}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      setSegments(cached);
      return;
    }

    const currentRequest = ++requestId.current;
    decodeToImageData(previewPngBase64, width, height)
      .then((imageData) => {
        if (requestId.current !== currentRequest) return;
        const traced = traceClusterContours(imageData, assignedColorKeys);
        cache.set(cacheKey, { key: cacheKey, ...traced });
        if (cache.size > CACHE_LIMIT) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey !== undefined) cache.delete(oldestKey);
        }
        setSegments(traced);
      })
      .catch(() => {
        if (requestId.current === currentRequest) setSegments({ skip: [], assigned: [] });
      });
  }, [previewPngBase64, width, height, clusterColors, assignedClusterIds]);

  if (segments.skip.length === 0 && segments.assigned.length === 0) return null;

  const SCREEN_PX_WIDTH = 0.6;
  const strokeWidth = SCREEN_PX_WIDTH / Math.max(scale, 0.001);

  const makeSceneFunc = (lines: number[][]) => (ctx: Konva.Context, shape: Konva.Shape) => {
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of lines) {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.strokeShape(shape);
  };

  return (
    <Layer listening={false} opacity={alpha}>
      {segments.skip.length > 0 && (
        <Shape sceneFunc={makeSceneFunc(segments.skip)} stroke={skipColor} strokeWidth={strokeWidth} perfectDrawEnabled={false} />
      )}
      {segments.assigned.length > 0 && (
        <Shape
          sceneFunc={makeSceneFunc(segments.assigned)}
          stroke={assignedColor}
          strokeWidth={strokeWidth}
          perfectDrawEnabled={false}
        />
      )}
    </Layer>
  );
}
