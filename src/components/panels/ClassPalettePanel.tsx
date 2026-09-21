/**
 * Lists classes in the active palette with color swatches, per-session
 * active/inactive toggles, and add/remove class actions. Palette edits
 * are persisted through the API client (createPalette/updatePalette).
 */

import { useState } from "react";
import { useClassStore } from "@/state/classStore";
import { createPalette, updatePalette, deletePalette } from "@/api/client";
import Dialog from "@/components/common/Dialog";
import type { ClassDef, ClassPalette } from "@/types/api";

function randomClassColor(): [number, number, number] {
  // Deterministic-ish spread rather than fully random, so successive new
  // classes are visually distinguishable from one another.
  const hue = Math.floor(Math.random() * 360);
  const [r, g, b] = hslToRgb(hue, 65, 55);
  return [r, g, b];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function nextClassValue(classes: ClassDef[]): number {
  return classes.reduce((max, c) => Math.max(max, c.value), 0) + 1;
}

export default function ClassPalettePanel() {
  const palettes = useClassStore((s) => s.palettes);
  const activePaletteId = useClassStore((s) => s.activePaletteId);
  const activeClassIds = useClassStore((s) => s.activeClassIds);
  const selectedClassId = useClassStore((s) => s.selectedClassId);
  const setActivePaletteId = useClassStore((s) => s.setActivePaletteId);
  const toggleClassActive = useClassStore((s) => s.toggleClassActive);
  const selectClass = useClassStore((s) => s.selectClass);
  const upsertPalette = useClassStore((s) => s.upsertPalette);
  const removePaletteFromStore = useClassStore((s) => s.removePalette);
  const activePalette = useClassStore((s) => s.activePalette());

  const [newClassName, setNewClassName] = useState("");
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [newPaletteDialogOpen, setNewPaletteDialogOpen] = useState(false);
  const [newPaletteName, setNewPaletteName] = useState("");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const handleAddClass = async () => {
    if (!activePalette || !newClassName.trim()) return;
    const newClass: ClassDef = {
      id: crypto.randomUUID(),
      name: newClassName.trim(),
      color: randomClassColor(),
      value: nextClassValue(activePalette.classes),
      active_by_default: true,
    };
    const updated: ClassPalette = {
      ...activePalette,
      classes: [...activePalette.classes, newClass],
    };
    try {
      const saved = await updatePalette(updated.id, updated);
      upsertPalette(saved);
      setNewClassName("");
      setPendingError(null);
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemoveClass = async (classId: string) => {
    if (!activePalette) return;
    const updated: ClassPalette = {
      ...activePalette,
      classes: activePalette.classes.filter((c) => c.id !== classId),
    };
    try {
      const saved = await updatePalette(updated.id, updated);
      upsertPalette(saved);
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  };

  // window.prompt/window.confirm are blocked by Tauri's webview ("dialog.*
  // not allowed"), which aborted these handlers silently before reaching
  // the API call. Use the in-app Dialog instead.
  const handleOpenCreatePalette = () => {
    setNewPaletteName("");
    setNewPaletteDialogOpen(true);
  };

  const handleConfirmCreatePalette = async () => {
    const name = newPaletteName.trim();
    if (!name) return;
    setNewPaletteDialogOpen(false);
    const palette: ClassPalette = { id: crypto.randomUUID(), name, classes: [] };
    try {
      const saved = await createPalette(palette);
      upsertPalette(saved);
      setActivePaletteId(saved.id);
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfirmDeletePalette = async () => {
    if (!activePalette) return;
    setDeleteConfirmOpen(false);
    try {
      await deletePalette(activePalette.id);
      removePaletteFromStore(activePalette.id);
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="panel class-palette-panel" aria-label="Class palette panel">
      <h3 className="panel__title">Classes</h3>

      <div className="panel__field">
        <label htmlFor="palette-select">Active palette</label>
        <div className="panel__field-row">
          <select
            id="palette-select"
            value={activePaletteId ?? ""}
            onChange={(e) => setActivePaletteId(e.target.value || null)}
          >
            <option value="" disabled>
              Select a palette
            </option>
            {palettes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={handleOpenCreatePalette} title="Create new palette">
            New
          </button>
        </div>
      </div>

      {activePalette && (
        <>
          <ul className="class-palette-panel__list">
            {activePalette.classes.map((cls) => (
              <li
                key={cls.id}
                className={`class-palette-panel__item${selectedClassId === cls.id ? " is-selected" : ""}`}
              >
                <button
                  type="button"
                  className="class-palette-panel__swatch"
                  style={{ backgroundColor: `rgb(${cls.color[0]}, ${cls.color[1]}, ${cls.color[2]})` }}
                  onClick={() => selectClass(cls.id)}
                  aria-label={`Select class ${cls.name}`}
                />
                <button
                  type="button"
                  className="class-palette-panel__name"
                  onClick={() => selectClass(cls.id)}
                >
                  {cls.name}
                  <span className="class-palette-panel__value">#{cls.value}</span>
                </button>
                <label className="class-palette-panel__active-toggle">
                  <input
                    type="checkbox"
                    checked={activeClassIds.includes(cls.id)}
                    onChange={() => toggleClassActive(cls.id)}
                  />
                  <span>Active</span>
                </label>
                <button
                  type="button"
                  className="class-palette-panel__remove"
                  onClick={() => void handleRemoveClass(cls.id)}
                  aria-label={`Remove class ${cls.name}`}
                >
                  &times;
                </button>
              </li>
            ))}
            {activePalette.classes.length === 0 && (
              <li className="class-palette-panel__empty">No classes in this palette yet</li>
            )}
          </ul>

          <div className="panel__field-row">
            <input
              type="text"
              placeholder="New class name"
              value={newClassName}
              onChange={(e) => setNewClassName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAddClass();
              }}
            />
            <button type="button" onClick={() => void handleAddClass()} disabled={!newClassName.trim()}>
              Add
            </button>
          </div>

          <button
            type="button"
            className="class-palette-panel__delete-palette"
            onClick={() => setDeleteConfirmOpen(true)}
          >
            Delete palette
          </button>
        </>
      )}

      {!activePalette && <p className="panel__hint">No active palette. Create or select one above.</p>}
      {pendingError && <p className="panel__error">{pendingError}</p>}

      <Dialog
        open={newPaletteDialogOpen}
        title="New palette"
        onClose={() => setNewPaletteDialogOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setNewPaletteDialogOpen(false)}>
              Cancel
            </button>
            <button type="button" onClick={() => void handleConfirmCreatePalette()} disabled={!newPaletteName.trim()}>
              Create
            </button>
          </>
        }
      >
        <input
          type="text"
          autoFocus
          placeholder="Palette name"
          value={newPaletteName}
          onChange={(e) => setNewPaletteName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleConfirmCreatePalette();
          }}
        />
      </Dialog>

      <Dialog
        open={deleteConfirmOpen}
        title="Delete palette"
        onClose={() => setDeleteConfirmOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setDeleteConfirmOpen(false)}>
              Cancel
            </button>
            <button type="button" onClick={() => void handleConfirmDeletePalette()}>
              Delete
            </button>
          </>
        }
      >
        <p>Delete palette &quot;{activePalette?.name}&quot;? This cannot be undone.</p>
      </Dialog>
    </section>
  );
}
