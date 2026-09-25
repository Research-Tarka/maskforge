/**
 * Renders a single canvas panel (an RGB composite view, or the mask) as a
 * Konva Stage. Pan/zoom are driven entirely by viewportStore so every panel
 * in the MultiPanelCanvas stays in sync. The base image comes from
 * LayerData's png_base64; an optional contour overlay renders on top for
 * mask panels.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Rect } from "react-konva";
import type Konva from "konva";
import type { LayerData } from "@/types/api";
import { useViewportStore } from "@/state/viewportStore";
import ContourOverlay from "@/components/canvas/ContourOverlay";
import AutoSegmentContourOverlay from "@/components/canvas/AutoSegmentContourOverlay";
import { MASK_KEY } from "@/state/layoutStore";

/** A layer key: "mask", or any RGB composite view name (e.g.
 * "rgb_true_color") -- not a closed set, since a scene can have any number
 * of detected "rgb*" views. */
export type LayerKind = string;

interface LayerCanvasProps {
  kind: LayerKind;
  label: string;
  layerData: LayerData | null;
  width: number;
  height: number;
  showContours?: boolean;
  contourColor?: string;
  contourAlpha?: number;
  onStageReady?: (stage: Konva.Stage) => void;
  /** The mask layer to trace class-boundary contours from, drawn on top of
   * this panel's own layerData -- always the mask, even on the raw/shadow
   * panels, so annotators can compare the annotation against the source
   * imagery directly instead of only seeing contours on the mask panel. */
  contourSource?: LayerData | null;
  /** Auto-segment preview state, rendered as its own 2-color contour set
   * (unassigned "skip" clusters vs. assigned-but-not-yet-applied ones) on
   * every panel -- not just mask -- so the draft is visible against the
   * source imagery too. Distinct from the manual contour: this traces
   * cluster boundaries, not real class boundaries, and disappears once
   * Apply turns a cluster into a real (manually-styled) boundary. */
  autoSegmentPreviewPngBase64?: string | null;
  autoSegmentClusterColors?: Record<number, [number, number, number]>;
  autoSegmentAssignedClusterIds?: Set<number>;
  /** When set (the mask panel only), renders from this persistent canvas
   * instead of decoding layerData.png_base64 into a fresh <img> -- lets the
   * caller patch just a changed region in place (see maskCanvas.ts) without
   * a full image swap on every brush stamp. `redrawToken` must be bumped
   * after every direct mutation of the canvas so Konva re-renders it (Konva
   * caches the canvas by reference and won't notice in-place pixel
   * changes on its own). */
  maskCanvas?: HTMLCanvasElement | null;
  redrawToken?: number;
}

function useHtmlImage(base64: string | undefined): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!base64) {
      setImage(null);
      return;
    }
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
    return () => {
      img.onload = null;
    };
  }, [base64]);

  return image;
}

export default function LayerCanvas({
  kind,
  label,
  layerData,
  width,
  height,
  showContours = false,
  contourColor = "#f5c542",
  contourAlpha = 0.9,
  onStageReady,
  contourSource,
  autoSegmentPreviewPngBase64,
  autoSegmentClusterColors,
  autoSegmentAssignedClusterIds,
  maskCanvas,
  redrawToken,
}: LayerCanvasProps) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const imageRef = useRef<Konva.Image | null>(null);
  const scale = useViewportStore((s) => s.scale);
  const offsetX = useViewportStore((s) => s.offsetX);
  const offsetY = useViewportStore((s) => s.offsetY);

  // maskCanvas is the fast path (in-place patched, see maskCanvas.ts) --
  // decoding layerData.png_base64 into a brand new <img> is only needed for
  // panels without one (every RGB composite view, which never changes mid-
  // session) or as a fallback before the mask canvas has been initialized.
  const decodedImage = useHtmlImage(maskCanvas ? undefined : layerData?.png_base64);
  const image = maskCanvas ?? decodedImage;

  useEffect(() => {
    if (stageRef.current && onStageReady) onStageReady(stageRef.current);
  }, [onStageReady]);

  // Konva's Image caches its source by reference; an in-place canvas patch
  // (drawImage onto the same HTMLCanvasElement) doesn't change that
  // reference, so Konva has no way to know the pixels changed. Forcing a
  // manual redraw whenever the caller bumps redrawToken is what actually
  // makes a patch visible.
  useEffect(() => {
    imageRef.current?.getLayer()?.batchDraw();
  }, [redrawToken]);

  const emptyMessage = useMemo(() => {
    if (layerData) return null;
    if (kind === MASK_KEY) return "No mask yet — paint to create one";
    if (kind === "rgb_true_color_shadow") return "No shadow layer — generate one from the Shadow panel";
    return `No ${label.toLowerCase()} layer for this scene`;
  }, [kind, label, layerData]);

  return (
    <div className="layer-canvas" data-kind={kind}>
      <div className="layer-canvas__header">
        <span className="layer-canvas__label">{label}</span>
        {layerData && (
          <span className="layer-canvas__meta">
            {layerData.width} x {layerData.height}
            {layerData.crs ? ` · ${layerData.crs}` : ""}
          </span>
        )}
      </div>
      <div className="layer-canvas__stage-wrap">
        <Stage
          ref={stageRef}
          width={width}
          height={height}
          x={offsetX}
          y={offsetY}
          scaleX={scale}
          scaleY={scale}
          listening={false}
        >
          <Layer listening={false}>
            <Rect
              x={0}
              y={0}
              width={layerData?.width ?? 0}
              height={layerData?.height ?? 0}
              fill="var(--canvas-checker, #1c1f26)"
            />
            {image && (
              <KonvaImage
                ref={imageRef}
                image={image}
                width={layerData?.width ?? image.width}
                height={layerData?.height ?? image.height}
              />
            )}
          </Layer>
          {showContours && (contourSource ?? (kind === "mask" ? layerData : null)) && (
            <ContourOverlay
              layerData={(contourSource ?? layerData) as LayerData}
              color={contourColor}
              alpha={contourAlpha}
              scale={scale}
            />
          )}
          {autoSegmentPreviewPngBase64 && (
            <AutoSegmentContourOverlay
              previewPngBase64={autoSegmentPreviewPngBase64}
              clusterColors={autoSegmentClusterColors ?? {}}
              assignedClusterIds={autoSegmentAssignedClusterIds ?? new Set()}
              width={(contourSource ?? layerData)?.width ?? 0}
              height={(contourSource ?? layerData)?.height ?? 0}
              scale={scale}
            />
          )}
        </Stage>
        {emptyMessage && (
          <div className="layer-canvas__empty">
            <span>{emptyMessage}</span>
          </div>
        )}
      </div>
    </div>
  );
}
