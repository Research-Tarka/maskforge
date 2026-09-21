/**
 * Renders thin, non-dilated class-boundary contours on top of the mask
 * layer. The IPC contract does not expose a dedicated contour endpoint —
 * the mask tile itself (LayerData.png_base64) is the single source of
 * truth — so contours are derived client-side from the decoded mask
 * pixels: a boundary pixel is any pixel whose 4-neighbour differs in
 * color, giving a 1px-wide, non-dilated outline. Results are memoized per
 * png_base64 payload so panning/zooming never recomputes them.
 */

import { useEffect, useRef, useState } from "react";
import { Layer, Shape } from "react-konva";
import type Konva from "konva";
import type { LayerData } from "@/types/api";

interface ContourOverlayProps {
  layerData: LayerData;
  color: string;
  alpha: number;
  /** Current viewport scale (world units per screen pixel multiplier) --
   * used to keep the stroke a constant width on screen. Without this, a
   * strokeWidth in world units gets multiplied by the Stage's own
   * scaleX/scaleY, so at high zoom a "thin" 1-world-unit line balloons to
   * cover a whole source pixel on screen. */
  scale: number;
}

interface ContourCacheEntry {
  key: string;
  segments: number[][];
}

const cache = new Map<string, ContourCacheEntry>();
const CACHE_LIMIT = 12;

function traceContours(imageData: ImageData): number[][] {
  const { width, height, data } = imageData;
  const segments: number[][] = [];

  const colorAt = (x: number, y: number): number => {
    const idx = (y * width + x) * 4;
    // Pack RGBA into a single comparable integer; alpha=0 (transparent) is
    // treated as "no class" so mask edges against transparency also draw.
    return (data[idx] << 24) | (data[idx + 1] << 16) | (data[idx + 2] << 8) | data[idx + 3];
  };

  // Horizontal boundaries (vertical edges between horizontally adjacent pixels)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      if (colorAt(x, y) !== colorAt(x + 1, y)) {
        segments.push([x + 1, y, x + 1, y + 1]);
      }
    }
  }
  // Vertical boundaries (horizontal edges between vertically adjacent pixels)
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width; x++) {
      if (colorAt(x, y) !== colorAt(x, y + 1)) {
        segments.push([x, y + 1, x + 1, y + 1]);
      }
    }
  }

  return segments;
}

function decodeToImageData(base64: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("2D canvas context unavailable for contour tracing"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, img.width, img.height));
    };
    img.onerror = () => reject(new Error("Failed to decode mask PNG for contour tracing"));
    img.src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
  });
}

export default function ContourOverlay({ layerData, color, alpha, scale }: ContourOverlayProps) {
  const [segments, setSegments] = useState<number[][]>([]);
  const requestId = useRef(0);

  useEffect(() => {
    const key = layerData.png_base64;
    const cached = cache.get(key);
    if (cached) {
      setSegments(cached.segments);
      return;
    }

    const currentRequest = ++requestId.current;
    decodeToImageData(key)
      .then((imageData) => {
        if (requestId.current !== currentRequest) return;
        const traced = traceContours(imageData);
        cache.set(key, { key, segments: traced });
        if (cache.size > CACHE_LIMIT) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey !== undefined) cache.delete(oldestKey);
        }
        setSegments(traced);
      })
      .catch(() => {
        if (requestId.current === currentRequest) setSegments([]);
      });
  }, [layerData.png_base64]);

  if (segments.length === 0) return null;

  // A single Shape with one custom sceneFunc draws every segment as one
  // canvas path — far cheaper than instantiating a Konva.Line node per
  // segment, which matters once a mask has tens of thousands of boundary
  // pixels.
  const sceneFunc = (ctx: Konva.Context, shape: Konva.Shape) => {
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of segments) {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.strokeShape(shape);
  };

  // The Stage this Layer sits in applies scaleX/scaleY = viewport scale, so
  // any strokeWidth given here in world units gets multiplied by that scale
  // on screen -- a "thin" 1-world-unit line balloons to a whole source
  // pixel wide at high zoom. Dividing by scale keeps it a constant width on
  // screen. The reference tool got its ultra-thin antialiased look from
  // drawing at 2x supersampling then downsampling with Lanczos; Konva has
  // no equivalent supersample step, so instead this targets a sub-1px
  // screen width directly (0.6px) with anti-aliasing left to the canvas's
  // own stroke rendering, which is thin enough to no longer read as "a
  // whole pixel" the way strokeWidth=1 (a full source pixel at scale=1) did.
  const SCREEN_PX_WIDTH = 0.6;
  const strokeWidth = SCREEN_PX_WIDTH / Math.max(scale, 0.001);

  return (
    <Layer listening={false} opacity={alpha}>
      <Shape sceneFunc={sceneFunc} stroke={color} strokeWidth={strokeWidth} perfectDrawEnabled={false} />
    </Layer>
  );
}
