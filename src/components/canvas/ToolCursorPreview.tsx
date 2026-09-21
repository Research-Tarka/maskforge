/**
 * Brush-size circle (or crosshair for point-based tools) following the
 * pointer, rendered in world coordinates so it scales correctly with zoom.
 * For the polygon tool, also draws the in-progress vertex chain (placed
 * points plus a rubber-band line to the current pointer position).
 */

import { Layer, Circle, Line, Rect } from "react-konva";
import type { ToolKind } from "@/types/api";

interface ToolCursorPreviewProps {
  tool: ToolKind;
  brushSize: number;
  scale: number;
  position: { x: number; y: number } | null;
  color: string;
  /** Vertices placed so far for an in-progress polygon (world coords). */
  polygonPoints?: { x: number; y: number }[];
}

export default function ToolCursorPreview({
  tool,
  brushSize,
  scale,
  position,
  color,
  polygonPoints,
}: ToolCursorPreviewProps) {
  if (tool === "polygon" && polygonPoints && polygonPoints.length > 0) {
    const chain = polygonPoints.flatMap((p) => [p.x, p.y]);
    const rubberBand = position ? [...chain, position.x, position.y] : chain;
    return (
      <Layer listening={false}>
        <Line points={rubberBand} stroke={color} strokeWidth={1.5 / scale} dash={[6 / scale, 4 / scale]} />
        <Line points={chain} stroke={color} strokeWidth={2 / scale} closed={false} />
        {polygonPoints.map((p, i) => (
          <Rect
            key={i}
            x={p.x - 3 / scale}
            y={p.y - 3 / scale}
            width={6 / scale}
            height={6 / scale}
            fill={i === 0 ? color : "rgba(255,255,255,0.9)"}
            stroke={color}
            strokeWidth={1 / scale}
          />
        ))}
      </Layer>
    );
  }

  if (!position) return null;

  if (tool === "brush") {
    return (
      <Layer listening={false}>
        <Circle
          x={position.x}
          y={position.y}
          radius={brushSize / 2}
          stroke={color}
          strokeWidth={1 / scale}
          fill="rgba(255, 255, 255, 0.08)"
        />
      </Layer>
    );
  }

  // Bucket / polygon / autofill: a lightweight crosshair, since brush size
  // does not apply to those tools.
  const armLength = 6 / scale;
  return (
    <Layer listening={false}>
      <Line
        points={[
          position.x - armLength,
          position.y,
          position.x + armLength,
          position.y,
        ]}
        stroke={color}
        strokeWidth={1 / scale}
      />
      <Line
        points={[
          position.x,
          position.y - armLength,
          position.x,
          position.y + armLength,
        ]}
        stroke={color}
        strokeWidth={1 / scale}
      />
    </Layer>
  );
}
