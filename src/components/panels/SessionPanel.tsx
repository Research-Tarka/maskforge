/**
 * Session name, recent sessions list, and save/load controls.
 */

import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/state/sessionStore";
import { useClassStore } from "@/state/classStore";
import { createSession, deleteSession, getScenes, getSession, getSessions, updateSession } from "@/api/client";
import Dialog from "@/components/common/Dialog";
import type { SessionState } from "@/types/api";

const SCHEMA_VERSION = 1;

function blankSession(name: string, palettes: { id: string }[]): SessionState {
  return {
    schema_version: SCHEMA_VERSION,
    id: crypto.randomUUID(),
    name,
    discovery: {
      source_root: "",
      scan_rule: {
        name: "default",
        raw_patterns: [],
        shadow_patterns: [],
        mask_patterns: [],
        max_depth: 4,
        file_extensions: [".tif", ".png", ".zarr"],
      },
      exclude_globs: [],
    },
    active_palette_id: palettes[0]?.id ?? "",
    active_class_ids: [],
    save_config: {
      output_format: "geotiff_rgba",
      output_root: "",
      folder_structure_template: "{scene_id}/mask.tif",
      copy_raw: false,
      copy_shadow: false,
      preserve_georef: true,
      resolution_mode: "native",
      target_resolution: null,
      compress: "deflate",
    },
    training_save_config: null,
    ui_state: {},
    qa_state: {},
    recent_sessions: [],
  };
}

export default function SessionPanel() {
  const session = useSessionStore((s) => s.session);
  const loadSession = useSessionStore((s) => s.loadSession);
  const clearSession = useSessionStore((s) => s.clearSession);
  const setScenes = useSessionStore((s) => s.setScenes);
  const flushAutosave = useSessionStore((s) => s.flushAutosave);
  const palettes = useClassStore((s) => s.palettes);
  const setActivePaletteId = useClassStore((s) => s.setActivePaletteId);

  const importInputRef = useRef<HTMLInputElement | null>(null);

  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [renameTarget, setRenameTarget] = useState<SessionState | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SessionState | null>(null);

  useEffect(() => {
    getSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const created = await createSession(blankSession(newName.trim(), palettes));
      setSessions((prev) => [...prev, created]);
      loadSession(created);
      if (created.active_palette_id) setActivePaletteId(created.active_palette_id);
      setNewName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleLoad = async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await getSession(id);
      loadSession(loaded);
      if (loaded.active_palette_id) setActivePaletteId(loaded.active_palette_id);
      // Loading a session must also load the scene queue it had discovered
      // — otherwise the canvas keeps showing whatever scenes (or none) were
      // left over from the previously active session.
      try {
        const scenes = await getScenes(loaded.id);
        setScenes(scenes);
      } catch {
        setScenes([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // window.prompt/window.confirm are blocked by Tauri's webview (see the
  // same note in ClassPalettePanel) -- use the in-app Dialog instead.
  const handleOpenRename = (s: SessionState) => {
    setRenameTarget(s);
    setRenameValue(s.name);
  };

  const handleConfirmRename = async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) return;
    setLoading(true);
    setError(null);
    try {
      const updated: SessionState = { ...renameTarget, name };
      const saved = await updateSession(updated.id, updated);
      setSessions((prev) => prev.map((s) => (s.id === saved.id ? saved : s)));
      // Renaming the currently loaded session must update the live session
      // in the store too, or the toolbar/panel would keep showing the old
      // name until the next reload.
      if (session?.id === saved.id) loadSession(saved);
      setRenameTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setLoading(true);
    setError(null);
    try {
      await deleteSession(deleteTarget.id);
      setSessions((prev) => prev.filter((s) => s.id !== deleteTarget.id));
      // Deleting the currently loaded session leaves nothing valid loaded
      // -- clear it rather than keep showing a session that no longer
      // exists on disk (autosave would otherwise recreate it on the next
      // edit).
      if (session?.id === deleteTarget.id) clearSession();
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleImportClick = () => {
    importInputRef.current?.click();
  };

  const handleExport = () => {
    if (!session) return;
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${session.name || "session"}.maskforge-session.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (file: File) => {
    setLoading(true);
    setError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as SessionState;
      if (!parsed.id || !parsed.discovery) {
        throw new Error("Not a valid MaskForge session file.");
      }
      // Re-create under a fresh id so importing a session file never
      // silently overwrites an existing session that happens to share the
      // same id (e.g. a file copied from another machine).
      const imported: SessionState = { ...parsed, id: crypto.randomUUID() };
      const created = await createSession(imported);
      setSessions((prev) => [...prev, created]);
      loadSession(created);
      if (created.active_palette_id) setActivePaletteId(created.active_palette_id);
      try {
        const scenes = await getScenes(created.id);
        setScenes(scenes);
      } catch {
        setScenes([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import session file.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel session-panel" aria-label="Session panel">
      <h3 className="panel__title">Sessions</h3>

      {session && (
        <div className="session-panel__current">
          <span className="panel__label">Current session</span>
          <span className="session-panel__current-name">{session.name}</span>
          <button type="button" onClick={() => void flushAutosave()}>
            Save now
          </button>
          <button type="button" onClick={handleExport}>
            Export…
          </button>
        </div>
      )}

      <div className="panel__field-row">
        <input
          type="text"
          placeholder="New session name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
          }}
        />
        <button type="button" onClick={() => void handleCreate()} disabled={loading || !newName.trim()}>
          Create
        </button>
        <button type="button" onClick={handleImportClick} disabled={loading}>
          Import…
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json"
          className="session-panel__import-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImportFile(file);
            e.target.value = "";
          }}
        />
      </div>

      <ul className="session-panel__list">
        {sessions.map((s) => (
          <li key={s.id} className={s.id === session?.id ? "is-active" : ""}>
            <button type="button" className="session-panel__name" onClick={() => void handleLoad(s.id)}>
              {s.name}
            </button>
            <button
              type="button"
              className="session-panel__rename"
              onClick={() => handleOpenRename(s)}
              aria-label={`Rename session ${s.name}`}
              title="Rename"
            >
              Rename
            </button>
            <button
              type="button"
              className="session-panel__delete"
              onClick={() => setDeleteTarget(s)}
              aria-label={`Delete session ${s.name}`}
              title="Delete"
            >
              Delete
            </button>
          </li>
        ))}
        {sessions.length === 0 && <li className="session-panel__empty">No saved sessions yet</li>}
      </ul>

      <Dialog
        open={renameTarget !== null}
        title="Rename session"
        onClose={() => setRenameTarget(null)}
        footer={
          <>
            <button type="button" onClick={() => setRenameTarget(null)}>
              Cancel
            </button>
            <button type="button" onClick={() => void handleConfirmRename()} disabled={!renameValue.trim()}>
              Rename
            </button>
          </>
        }
      >
        <input
          type="text"
          autoFocus
          placeholder="Session name"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleConfirmRename();
          }}
        />
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        title="Delete session"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <button type="button" onClick={() => setDeleteTarget(null)}>
              Cancel
            </button>
            <button type="button" onClick={() => void handleConfirmDelete()}>
              Delete
            </button>
          </>
        }
      >
        <p>Delete session &quot;{deleteTarget?.name}&quot;? This cannot be undone.</p>
      </Dialog>

      {error && <p className="panel__error">{error}</p>}
    </section>
  );
}
