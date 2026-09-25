/**
 * A persistent off-DOM canvas holding the mask layer's current pixels,
 * updated incrementally by drawing small server-rendered patches onto it
 * instead of re-fetching and re-decoding the *entire* mask layer after
 * every brush stamp. Re-fetching the whole scene on every pointermove
 * during a drag was the main source of paint latency (a full network
 * round trip + full-image PNG decode per stamp, even though only a small
 * region actually changed) -- this keeps the round trip down to just the
 * small changed bbox, which /tool already returns.
 */

export interface MaskCanvasHandle {
  canvas: HTMLCanvasElement;
  /** Replace the whole canvas contents from a full-layer PNG (data URI or
   * bare base64). Used on scene load and after whole-buffer rewrites
   * (undo/redo, auto-segment apply, fill-all) where a full refresh is the
   * only correct option. Resolves once the image has actually been drawn. */
  loadFull: (pngBase64: string, width: number, height: number) => Promise<void>;
  /** Draw a small server-rendered RGBA PNG patch at its bbox -- the fast
   * path for a single tool stamp. `bbox` is `[y0, x0, y1, x1]`, matching the
   * sidecar's BBox convention (contours.py::bbox_from_change_mask), NOT
   * [x0, y0, x1, y1] -- passing it in the wrong order silently swaps the
   * patch's x/y placement, which only becomes visible as a diagonal-looking
   * offset while painting (corrected once the next full refresh reloads the
   * real layer). Resolves once drawn. */
  patchRegion: (pngBase64: string, bbox: [number, number, number, number]) => Promise<void>;
}

function toDataUri(base64: string): string {
  return base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
}

function decodeImage(dataUri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode PNG patch"));
    img.src = dataUri;
  });
}

export function createMaskCanvas(): MaskCanvasHandle {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  return {
    canvas,
    async loadFull(pngBase64, width, height) {
      const img = await decodeImage(toDataUri(pngBase64));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, width, height);
    },
    async patchRegion(pngBase64, bbox) {
      const [y0, x0, y1, x1] = bbox;
      const w = x1 - x0;
      const h = y1 - y0;
      if (w <= 0 || h <= 0) return;
      const img = await decodeImage(toDataUri(pngBase64));
      ctx.drawImage(img, x0, y0, w, h);
    },
  };
}
