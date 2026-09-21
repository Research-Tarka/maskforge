/**
 * Top toolbar: session controls, theme toggle, panel visibility toggles.
 */

import { useUiStore, type PanelId } from "@/state/uiStore";
import { useSessionStore } from "@/state/sessionStore";

const PANEL_TOGGLES: { id: PanelId; label: string; disabled?: boolean }[] = [
  { id: "tools", label: "Tools" },
  { id: "classes", label: "Classes" },
  { id: "discovery", label: "Discovery" },
  { id: "saveConfig", label: "Save" },
  // Shadow generation and keyboard shortcuts are parked for now — greyed
  // out rather than removed so the panels/state stay intact for later.
  { id: "shadowGen", label: "Shadow", disabled: true },
  { id: "session", label: "Sessions" },
  { id: "qa", label: "QA" },
  { id: "stats", label: "Stats" },
  { id: "keybindings", label: "Shortcuts", disabled: true },
  { id: "autoSegment", label: "Auto-segment" },
];

export default function Toolbar() {
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const panelVisibility = useUiStore((s) => s.panelVisibility);
  const togglePanel = useUiStore((s) => s.togglePanel);

  const session = useSessionStore((s) => s.session);
  const dirty = useSessionStore((s) => s.dirty);
  const saving = useSessionStore((s) => s.saving);

  return (
    <header className="toolbar">
      <div className="toolbar__section toolbar__section--brand">
        <span className="toolbar__brand">MaskForge</span>
        {session && <span className="toolbar__session-name">{session.name}</span>}
        {(dirty || saving) && (
          <span className="toolbar__save-indicator" title="Autosaving session state">
            {saving ? "Saving…" : "Unsaved changes"}
          </span>
        )}
      </div>

      <nav className="toolbar__section toolbar__section--panels">
        {PANEL_TOGGLES.map((panel) => (
          <button
            key={panel.id}
            type="button"
            className={`toolbar__panel-toggle${panelVisibility[panel.id] ? " is-active" : ""}`}
            onClick={() => togglePanel(panel.id)}
            aria-pressed={panelVisibility[panel.id]}
            disabled={panel.disabled}
            title={panel.disabled ? "Not available this round" : undefined}
          >
            {panel.label}
          </button>
        ))}
      </nav>

      <div className="toolbar__section toolbar__section--actions">
        <button
          type="button"
          className="toolbar__theme-toggle"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </div>
    </header>
  );
}
