/**
 * react-colorful based HSV/RGB/HEX picker for the selected class's color.
 * Changing a color that already has painted pixels triggers a remap
 * confirmation dialog showing a dry-run affected-pixel count before the
 * change is committed.
 */

import { useEffect, useState } from "react";
import { HexColorPicker, HexColorInput } from "react-colorful";
import { useClassStore } from "@/state/classStore";
import { useSessionStore } from "@/state/sessionStore";
import { updatePalette, remapColor } from "@/api/client";
import Dialog from "@/components/common/Dialog";
import type { ClassPalette } from "@/types/api";

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [r, g, b];
}

type PickerMode = "hex" | "rgb";

export default function ColorPickerPanel() {
  const selectedClass = useClassStore((s) => s.selectedClass());
  const activePalette = useClassStore((s) => s.activePalette());
  const upsertPalette = useClassStore((s) => s.upsertPalette);
  const activeScene = useSessionStore((s) => s.activeScene());

  const [draftColor, setDraftColor] = useState<[number, number, number] | null>(null);
  const [mode, setMode] = useState<PickerMode>("hex");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dryRunCount, setDryRunCount] = useState<number | null>(null);
  const [checkingDryRun, setCheckingDryRun] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraftColor(selectedClass?.color ?? null);
    setConfirmOpen(false);
    setDryRunCount(null);
    // Intentionally keyed on the class id only: this resets the picker
    // when the *selection* changes. Re-running it on every color byte
    // change would fight the in-progress drag state in the picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClass?.id]);

  if (!selectedClass || !activePalette) {
    return (
      <section className="panel color-picker-panel" aria-label="Color picker panel">
        <h3 className="panel__title">Color</h3>
        <p className="panel__hint">Select a class to edit its color.</p>
      </section>
    );
  }

  const currentColor = draftColor ?? selectedClass.color;
  const hex = rgbToHex(currentColor);

  const commitColor = async (color: [number, number, number]) => {
    const updated: ClassPalette = {
      ...activePalette,
      classes: activePalette.classes.map((c) =>
        c.id === selectedClass.id ? { ...c, color } : c,
      ),
    };
    try {
      const saved = await updatePalette(updated.id, updated);
      upsertPalette(saved);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleColorChangeEnd = async (color: [number, number, number]) => {
    setDraftColor(color);
    if (!activeScene) {
      await commitColor(color);
      return;
    }

    setCheckingDryRun(true);
    try {
      const dryRun = await remapColor(activeScene.id, {
        old_color: selectedClass.color,
        new_color: color,
        dry_run: true,
      });
      setCheckingDryRun(false);
      if (dryRun.affected_pixels > 0) {
        setDryRunCount(dryRun.affected_pixels);
        setConfirmOpen(true);
      } else {
        await commitColor(color);
      }
    } catch (err) {
      setCheckingDryRun(false);
      // Sidecar might not have this scene's mask loaded yet; fall back to
      // committing the palette color change without a remap.
      setError(err instanceof Error ? err.message : String(err));
      await commitColor(color);
    }
  };

  const handleConfirmRemap = async () => {
    if (!activeScene) return;
    try {
      await remapColor(activeScene.id, {
        old_color: selectedClass.color,
        new_color: currentColor,
        dry_run: false,
      });
      await commitColor(currentColor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirmOpen(false);
      setDryRunCount(null);
    }
  };

  const handleCancelRemap = () => {
    setDraftColor(selectedClass.color);
    setConfirmOpen(false);
    setDryRunCount(null);
  };

  return (
    <section className="panel color-picker-panel" aria-label="Color picker panel">
      <h3 className="panel__title">Color — {selectedClass.name}</h3>

      <HexColorPicker
        color={hex}
        onChange={(next) => setDraftColor(hexToRgb(next))}
        onMouseUp={() => void handleColorChangeEnd(currentColor)}
        onTouchEnd={() => void handleColorChangeEnd(currentColor)}
      />

      <div className="color-picker-panel__mode-toggle">
        <button type="button" className={mode === "hex" ? "is-active" : ""} onClick={() => setMode("hex")}>
          Hex
        </button>
        <button type="button" className={mode === "rgb" ? "is-active" : ""} onClick={() => setMode("rgb")}>
          RGB
        </button>
      </div>

      {mode === "hex" ? (
        <div className="panel__field-row">
          <span>#</span>
          <HexColorInput
            color={hex}
            onChange={(next) => setDraftColor(hexToRgb(next))}
            onBlur={() => void handleColorChangeEnd(currentColor)}
          />
        </div>
      ) : (
        <div className="color-picker-panel__rgb-inputs">
          {(["R", "G", "B"] as const).map((channel, idx) => (
            <label key={channel}>
              {channel}
              <input
                type="number"
                min={0}
                max={255}
                value={currentColor[idx]}
                onChange={(e) => {
                  const next: [number, number, number] = [...currentColor];
                  next[idx] = Math.min(255, Math.max(0, Number(e.target.value)));
                  setDraftColor(next);
                }}
                onBlur={() => void handleColorChangeEnd(currentColor)}
              />
            </label>
          ))}
        </div>
      )}

      {checkingDryRun && <p className="panel__hint">Checking affected pixels…</p>}
      {error && <p className="panel__error">{error}</p>}

      <Dialog
        open={confirmOpen}
        title="Confirm color remap"
        onClose={handleCancelRemap}
        footer={
          <>
            <button type="button" onClick={handleCancelRemap}>
              Cancel
            </button>
            <button type="button" className="dialog__confirm" onClick={() => void handleConfirmRemap()}>
              Remap {dryRunCount?.toLocaleString()} pixels
            </button>
          </>
        }
      >
        <p>
          Class <strong>{selectedClass.name}</strong> already has painted pixels using its
          current color on this scene.
        </p>
        <p>
          Changing its color will remap <strong>{dryRunCount?.toLocaleString()}</strong> existing
          pixels from {rgbToHex(selectedClass.color)} to {hex} on the active scene.
        </p>
      </Dialog>
    </section>
  );
}
