/**
 * Renders the auto-segment preview on top of the mask panel: each cluster
 * shown in its own distinct color, unchanged regardless of whether it's
 * been assigned to a class yet -- only Apply actually recolors anything
 * (into the real class color, in the real mask). Which clusters are
 * assigned vs. still "skip" is instead shown via AutoSegmentContourOverlay's
 * two contour colors, not by recoloring this fill.
 *
 * The backend's preview PNG already carries alpha=0 over pixels that are
 * already painted by hand -- Apply never overwrites those, so nothing
 * highlights them here either.
 */

import { useEffect, useState } from "react";
import { Layer, Image as KonvaImage } from "react-konva";

interface AutoSegmentPreviewOverlayProps {
  previewPngBase64: string | null;
  width: number;
  height: number;
  alpha?: number;
}

function loadImage(base64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode auto-segment preview PNG"));
    img.src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
  });
}

export default function AutoSegmentPreviewOverlay({
  previewPngBase64,
  width,
  height,
  alpha = 0.55,
}: AutoSegmentPreviewOverlayProps) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!previewPngBase64 || width <= 0 || height <= 0) {
      setImage(null);
      return;
    }
    let cancelled = false;
    loadImage(previewPngBase64).then(
      (img) => {
        if (!cancelled) setImage(img);
      },
      () => {
        if (!cancelled) setImage(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [previewPngBase64, width, height]);

  if (!image) return null;

  return (
    <Layer listening={false} opacity={alpha}>
      <KonvaImage image={image} width={width} height={height} />
    </Layer>
  );
}
