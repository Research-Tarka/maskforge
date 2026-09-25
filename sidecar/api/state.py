"""Process-wide in-memory application state shared across routers.

Holds discovered scenes (cached per session), in-memory mask arrays being
edited (keyed by scene id), contour caches, palette/session stores, and the
QA workflow — all wired together here so routers stay thin.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from maskforge_core.class_config import PaletteStore
from maskforge_core.contours import ContourCache
from maskforge_core.qa_workflow import QaWorkflow
from maskforge_core.scene_discovery import SceneEntry
from maskforge_core.session import SessionStore


MAX_UNDO_DEPTH = 50


@dataclass
class MaskBuffer:
    """An in-memory class-index array for a scene currently being edited,
    plus its georeference (if any) and an incremental contour cache."""

    classes: np.ndarray
    transform: Any = None
    crs: Any = None
    contour_cache: ContourCache = field(default_factory=ContourCache)
    # Most recent auto-segmentation clustering result, held until the user
    # applies (or discards) it via /auto-segment/apply. Not persisted —
    # purely a hand-off between the preview and apply calls.
    pending_auto_segment: np.ndarray | None = None
    # Whole-buffer snapshots for undo/redo. A full-array copy per entry is
    # deliberately simple over a diff/patch scheme: at typical scene sizes
    # (a few hundred px per side, uint8) each snapshot is tens of KB, so
    # MAX_UNDO_DEPTH of them is a few MB at most -- not worth the
    # bookkeeping complexity of a bbox-diff history for that little memory.
    undo_stack: list[np.ndarray] = field(default_factory=list)
    redo_stack: list[np.ndarray] = field(default_factory=list)
    # Cached LayerData for each RGB composite view, keyed by view name (e.g.
    # "rgb_true_color") -> (source_path, LayerData) -- these never change
    # while a scene is being annotated (only the mask does), but GET
    # /scenes/{id}/layers used to re-read and re-PNG-encode them from
    # disk/zarr on every single call, including every brush stamp mid-drag.
    # On a zarr-backed scene (e.g. Sentinel-2, which decompresses a bigger
    # chunk than a plain GeoTIFF) that made painting visibly laggy. Cached
    # per-path (not unconditionally) so a view whose source path is later
    # reassigned still gets a fresh read rather than serving stale data
    # forever. A dict (not two fixed fields) since a scene can now have up
    # to 4 (or more) RGB views instead of a fixed raw/shadow pair.
    rgb_layer_cache: dict[str, tuple[str, Any]] = field(default_factory=dict)

    def push_undo_snapshot(self) -> None:
        """Call BEFORE mutating self.classes, to snapshot the pre-edit
        state. Clears the redo stack, matching standard undo/redo semantics
        (a new edit invalidates any previously-undone future)."""
        self.undo_stack.append(self.classes.copy())
        if len(self.undo_stack) > MAX_UNDO_DEPTH:
            self.undo_stack.pop(0)
        self.redo_stack.clear()

    def undo(self) -> bool:
        if not self.undo_stack:
            return False
        self.redo_stack.append(self.classes.copy())
        self.classes = self.undo_stack.pop()
        self.contour_cache.invalidate()
        return True

    def redo(self) -> bool:
        if not self.redo_stack:
            return False
        self.undo_stack.append(self.classes.copy())
        self.classes = self.redo_stack.pop()
        self.contour_cache.invalidate()
        return True


class AppState:
    def __init__(self, home: Path | None = None):
        home = home or (Path.home() / ".maskforge")
        self.home = home
        self.palette_store = PaletteStore(home / "class_palettes")
        self.session_store = SessionStore(home / "sessions")
        self.qa_workflow = QaWorkflow()

        self._lock = threading.RLock()
        self.scenes_by_session: dict[str, list[SceneEntry]] = {}
        self.scenes_by_id: dict[str, SceneEntry] = {}
        self.mask_buffers: dict[str, MaskBuffer] = {}
        self.shadow_presets: dict[str, dict[str, Any]] = {}

        from maskforge_core.shadow_gen import list_presets

        self.shadow_presets.update(list_presets())

    def set_scenes(self, session_id: str, scenes: list[SceneEntry]) -> None:
        with self._lock:
            self.scenes_by_session[session_id] = scenes
            for s in scenes:
                self.scenes_by_id[s.id] = s

    def get_scenes(self, session_id: str) -> list[SceneEntry]:
        with self._lock:
            return self.scenes_by_session.get(session_id, [])

    def get_scene(self, scene_id: str) -> SceneEntry | None:
        with self._lock:
            return self.scenes_by_id.get(scene_id)

    def register_scene(self, scene: SceneEntry) -> None:
        with self._lock:
            self.scenes_by_id[scene.id] = scene

    def get_mask_buffer(self, scene_id: str) -> MaskBuffer | None:
        with self._lock:
            return self.mask_buffers.get(scene_id)

    def set_mask_buffer(self, scene_id: str, buf: MaskBuffer) -> None:
        with self._lock:
            self.mask_buffers[scene_id] = buf

    def get_active_save_config(self):
        """Best-effort lookup of "the" active SaveConfig, mirroring
        get_active_palette's scan-every-open-session approach (there is no
        real per-scene session scoping yet). Used to locate a mask that was
        already saved to an output_root separate from the scene's own
        discovery source_root -- discovery never sees such a mask (it only
        scans source_root), so SceneEntry.mask_path stays None for it even
        though a file exists on disk.

        Returns a maskforge_core.session.SaveConfig (not the dict that
        SessionState.save_config actually stores it as -- session.py's
        SessionState keeps every nested field as a plain dict, unlike
        api.schemas' Pydantic model of a similar name)."""
        from maskforge_core.session import SaveConfig as CoreSaveConfig

        for sid in list(self.scenes_by_session.keys()):
            session = self.session_store.get(sid)
            if session is not None and session.save_config:
                return CoreSaveConfig.from_dict(session.save_config)
        return None

    def get_active_palette(self):
        """Best-effort lookup of "the" active class palette: scans every
        open session for one with an active_palette_id that still resolves.
        There is no real per-scene palette scoping yet (see save_mask's own
        note historically) -- this just centralizes the same lookup that
        used to be duplicated inline in save_mask and the live mask-layer
        renderer."""
        for sid in list(self.scenes_by_session.keys()):
            session = self.session_store.get(sid)
            if session is not None and session.active_palette_id:
                palette = self.palette_store.get(session.active_palette_id)
                if palette is not None:
                    return palette
        return None


_state: AppState | None = None


def get_state() -> AppState:
    global _state
    if _state is None:
        _state = AppState()
    return _state


def reset_state(home: Path | None = None) -> AppState:
    """Used by tests to get a clean, isolated state pointed at a temp home dir."""
    global _state
    _state = AppState(home)
    return _state
