/**
 * Editable shortcut list. Clicking "Rebind" captures the next keydown
 * event as the new chord for that action; Escape cancels capture.
 */

import { useEffect, useState } from "react";
import { useUiStore, DEFAULT_KEYBINDINGS, KEYBINDING_LABELS, type KeybindingAction } from "@/state/uiStore";

function chordFromEvent(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Meta");

  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);

  return parts.join("+");
}

export default function KeybindingsPanel() {
  const keybindings = useUiStore((s) => s.keybindings);
  const setKeybinding = useUiStore((s) => s.setKeybinding);
  const resetKeybindings = useUiStore((s) => s.resetKeybindings);

  const [capturing, setCapturing] = useState<KeybindingAction | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    if (!capturing) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return;

      const conflictingAction = (Object.entries(keybindings) as [KeybindingAction, string][]).find(
        ([action, existingChord]) => existingChord === chord && action !== capturing,
      );

      if (conflictingAction) {
        setConflict(`"${chord}" is already bound to "${KEYBINDING_LABELS[conflictingAction[0]]}"`);
      } else {
        setKeybinding(capturing, chord);
        setConflict(null);
      }
      setCapturing(null);
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [capturing, keybindings, setKeybinding]);

  const actions = Object.keys(DEFAULT_KEYBINDINGS) as KeybindingAction[];

  return (
    <section className="panel keybindings-panel" aria-label="Keybindings panel">
      <h3 className="panel__title">Keyboard shortcuts</h3>

      {conflict && <p className="panel__error">{conflict}</p>}

      <table className="keybindings-panel__table">
        <thead>
          <tr>
            <th>Action</th>
            <th>Shortcut</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {actions.map((action) => (
            <tr key={action}>
              <td>{KEYBINDING_LABELS[action]}</td>
              <td>
                <kbd className={capturing === action ? "is-capturing" : ""}>
                  {capturing === action ? "Press a key…" : keybindings[action]}
                </kbd>
              </td>
              <td>
                <button type="button" onClick={() => setCapturing(action)} disabled={capturing !== null}>
                  Rebind
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button type="button" className="keybindings-panel__reset" onClick={resetKeybindings}>
        Reset to defaults
      </button>
    </section>
  );
}
