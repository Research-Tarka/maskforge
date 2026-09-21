/**
 * Review-mode before/after overlay: highlights pixels removed (red) vs
 * added (green) between two mask PNGs. Used when a scene's mode is
 * "review" to make corrections against an existing mask visually obvious.
 */

import { useEffect, useState } from "react";
import { Layer, Image as KonvaImage } from "react-konva";

interface DiffOverlayProps {
  beforeBase64: string | null;
  afterBase64: string | null;
  width: number;
  height: number;
  visible: boolean;
  removedColor?: [number, number, number];
  addedColor?: [number, number, number];
}

function loadImageData(base64: string, width: number, height: number): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("2D canvas context unavailable for diff computation"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(ctx.getImageData(0, 0, width, height));
    };
    img.onerror = () => reject(new Error("Failed to decode PNG for diff computation"));
    img.src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
  });
}

export default function DiffOverlay({
  beforeBase64,
  afterBase64,
  width,
  height,
  visible,
  removedColor = [214, 60, 60],
  addedColor = [60, 200, 110],
}: DiffOverlayProps) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!visible || !beforeBase64 || !afterBase64 || width <= 0 || height <= 0) {
      setCanvas(null);
      return;
    }

    let cancelled = false;
    Promise.all([
      loadImageData(beforeBase64, width, height),
      loadImageData(afterBase64, width, height),
    ]).then(([before, after]) => {
      if (cancelled) return;

      const out = document.createElement("canvas");
      out.width = width;
      out.height = height;
      const ctx = out.getContext("2d");
      if (!ctx) return;

      const result = ctx.createImageData(width, height);
      for (let i = 0; i < result.data.length; i += 4) {
        const beforeHasPaint = before.data[i + 3] > 0;
        const afterHasPaint = after.data[i + 3] > 0;
        const beforeIsSame =
          before.data[i] === after.data[i] &&
          before.data[i + 1] === after.data[i + 1] &&
          before.data[i + 2] === after.data[i + 2];

        if (beforeHasPaint && !afterHasPaint) {
          result.data[i] = removedColor[0];
          result.data[i + 1] = removedColor[1];
          result.data[i + 2] = removedColor[2];
          result.data[i + 3] = 220;
        } else if (!beforeHasPaint && afterHasPaint) {
          result.data[i] = addedColor[0];
          result.data[i + 1] = addedColor[1];
          result.data[i + 2] = addedColor[2];
          result.data[i + 3] = 220;
        } else if (beforeHasPaint && afterHasPaint && !beforeIsSame) {
          result.data[i] = addedColor[0];
          result.data[i + 1] = addedColor[1];
          result.data[i + 2] = addedColor[2];
          result.data[i + 3] = 160;
        } else {
          result.data[i + 3] = 0;
        }
      }
      ctx.putImageData(result, 0, 0);
      setCanvas(out);
    });

    return () => {
      cancelled = true;
    };
  }, [beforeBase64, afterBase64, width, height, visible, removedColor, addedColor]);

  if (!visible || !canvas) return null;

  return (
    <Layer listening={false}>
      <KonvaImage image={canvas} width={width} height={height} />
    </Layer>
  );
}
