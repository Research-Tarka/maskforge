/**
 * Renders a single canvas panel (raw / shadow / mask) as a Konva Stage.
 * Pan/zoom are driven entirely by viewportStore so every panel in the
 * MultiPanelCanvas stays in sync. The base image comes from LayerData's
 * png_base64; an optional contour overlay renders on top for mask panels.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Rect } from "react-konva";
import type Konva from "konva";
import type { LayerData } from "@/types/api";
import { useViewportStore } from "@/state/viewportStore";
import ContourOverlay from "@/components/canvas/ContourOverlay";
import AutoSegmentContourOverlay from "@/components/canvas/AutoSegmentContourOverlay";

export type LayerKind = "raw" | "shadow" | "mask";

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
}: LayerCanvasProps) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const scale = useViewportStore((s) => s.scale);
  const offsetX = useViewportStore((s) => s.offsetX);
  const offsetY = useViewportStore((s) => s.offsetY);

  const image = useHtmlImage(layerData?.png_base64);

  useEffect(() => {
    if (stageRef.current && onStageReady) onStageReady(stageRef.current);
  }, [onStageReady]);

  const emptyMessage = useMemo(() => {
    if (layerData) return null;
    switch (kind) {
      case "raw":
        return "No raw layer for this scene";
      case "shadow":
        return "No shadow layer — generate one from the Shadow panel";
      case "mask":
        return "No mask yet — paint to create one";
      default:
        return "No data";
    }
  }, [kind, layerData]);

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
                image={image}
                width={layerData?.width}
                height={layerData?.height}
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
