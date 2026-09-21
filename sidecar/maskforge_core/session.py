"""Session state persistence under ``~/.maskforge/sessions/``.

Implements plan section 9: a single versioned JSON schema
(``schema_version``, ``discovery``, ``active_palette_id``,
``active_class_ids``, ``save_config``, ``ui_state``, ``qa_state``,
``recent_sessions``), stored at ``~/.maskforge/sessions/<id>.json`` plus a
``last_session_pointer.json``. ``save()`` is synchronous and cheap; the
500ms debounce is an API-layer concern (the API layer calls ``save()`` from
a debounced handler). A separate ``.autosave`` file is supported via
``save_autosave()`` / ``load_autosave()`` / ``discard_autosave()``.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MASKFORGE_HOME = Path.home() / ".maskforge"
SESSIONS_DIR = MASKFORGE_HOME / "sessions"
LAST_SESSION_POINTER = SESSIONS_DIR / "last_session_pointer.json"

SCHEMA_VERSION = 1


@dataclass
class SaveConfig:
    output_format: str = "geotiff_rgba"
    output_root: str = ""
    folder_structure_template: str = "{scene_id}/mask.tif"
    copy_raw: bool = False
    copy_shadow: bool = False
    preserve_georef: bool = True
    resolution_mode: str = "native"
    target_resolution: tuple[float, float] | None = None
    compress: str | None = "LZW"

    def to_dict(self) -> dict:
        return {
            "output_format": self.output_format,
            "output_root": self.output_root,
            "folder_structure_template": self.folder_structure_template,
            "copy_raw": self.copy_raw,
            "copy_shadow": self.copy_shadow,
            "preserve_georef": self.preserve_georef,
            "resolution_mode": self.resolution_mode,
            "target_resolution": list(self.target_resolution) if self.target_resolution else None,
            "compress": self.compress,
        }

    @staticmethod
    def from_dict(d: dict) -> "SaveConfig":
        tr = d.get("target_resolution")
        return SaveConfig(
            output_format=d.get("output_format", "geotiff_rgba"),
            output_root=d.get("output_root", ""),
            folder_structure_template=d.get("folder_structure_template", "{scene_id}/mask.tif"),
            copy_raw=d.get("copy_raw", False),
            copy_shadow=d.get("copy_shadow", False),
            preserve_georef=d.get("preserve_georef", True),
            resolution_mode=d.get("resolution_mode", "native"),
            target_resolution=tuple(tr) if tr else None,
            compress=d.get("compress", "LZW"),
        )


@dataclass
class SessionState:
    id: str
    name: str
    discovery: dict[str, Any]
    active_palette_id: str = ""
    active_class_ids: list[str] = field(default_factory=list)
    save_config: dict[str, Any] = field(default_factory=lambda: SaveConfig().to_dict())
    # Independent save configuration for a resampled "training" copy (e.g.
    # native-resolution Mask.tif alongside a resampled Mask_Train.tif),
    # saved via a separate action from save_config. None if unused.
    training_save_config: dict[str, Any] | None = None
    ui_state: dict[str, Any] = field(default_factory=dict)
    qa_state: dict[str, Any] = field(default_factory=dict)
    recent_sessions: list[str] = field(default_factory=list)
    schema_version: int = SCHEMA_VERSION

    @staticmethod
    def new(name: str, discovery: dict[str, Any]) -> "SessionState":
        return SessionState(id=str(uuid.uuid4()), name=name, discovery=discovery)

    def to_dict(self) -> dict:
        return {
            "schema_version": self.schema_version,
            "id": self.id,
            "name": self.name,
            "discovery": self.discovery,
            "active_palette_id": self.active_palette_id,
            "active_class_ids": self.active_class_ids,
            "save_config": self.save_config,
            "training_save_config": self.training_save_config,
            "ui_state": self.ui_state,
            "qa_state": self.qa_state,
            "recent_sessions": self.recent_sessions,
        }

    @staticmethod
    def from_dict(d: dict) -> "SessionState":
        return SessionState(
            schema_version=d.get("schema_version", SCHEMA_VERSION),
            id=d["id"],
            name=d.get("name", ""),
            discovery=d.get("discovery", {}),
            active_palette_id=d.get("active_palette_id", ""),
            active_class_ids=list(d.get("active_class_ids", [])),
            save_config=d.get("save_config", SaveConfig().to_dict()),
            training_save_config=d.get("training_save_config"),
            ui_state=d.get("ui_state", {}),
            qa_state=d.get("qa_state", {}),
            recent_sessions=list(d.get("recent_sessions", [])),
        )


class SessionStore:
    """Persistence layer for session state, including debounce-friendly
    ``save()`` (cheap synchronous write; caller decides cadence) and a
    separate ``.autosave`` sidecar file."""

    def __init__(self, base_dir: Path | None = None):
        self.dir = base_dir or SESSIONS_DIR
        self.dir.mkdir(parents=True, exist_ok=True)
        self.pointer_path = self.dir / "last_session_pointer.json"

    def _session_path(self, session_id: str) -> Path:
        return self.dir / f"{session_id}.json"

    def _autosave_path(self, session_id: str) -> Path:
        return self.dir / f"{session_id}.autosave"

    def list_all(self) -> list[SessionState]:
        out: list[SessionState] = []
        for path in sorted(self.dir.glob("*.json")):
            if path.name == "last_session_pointer.json":
                continue
            try:
                out.append(SessionState.from_dict(json.loads(path.read_text(encoding="utf-8"))))
            except (json.JSONDecodeError, OSError, KeyError):
                continue
        return out

    def get(self, session_id: str) -> SessionState | None:
        path = self._session_path(session_id)
        if not path.exists():
            return None
        try:
            return SessionState.from_dict(json.loads(path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError, KeyError):
            return None

    def save(self, session: SessionState) -> SessionState:
        path = self._session_path(session.id)
        path.write_text(json.dumps(session.to_dict(), indent=2), encoding="utf-8")
        self._set_last_session_pointer(session.id)
        return session

    def delete(self, session_id: str) -> bool:
        path = self._session_path(session_id)
        existed = path.exists()
        if existed:
            path.unlink()
        autosave = self._autosave_path(session_id)
        if autosave.exists():
            autosave.unlink()
        return existed

    def _set_last_session_pointer(self, session_id: str) -> None:
        self.pointer_path.write_text(json.dumps({"last_session_id": session_id}), encoding="utf-8")

    def get_last_session_id(self) -> str | None:
        if not self.pointer_path.exists():
            return None
        try:
            data = json.loads(self.pointer_path.read_text(encoding="utf-8"))
            return data.get("last_session_id")
        except (json.JSONDecodeError, OSError):
            return None

    def save_autosave(self, session: SessionState) -> None:
        path = self._autosave_path(session.id)
        payload = session.to_dict()
        payload["_autosaved_at"] = time.time()
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def load_autosave(self, session_id: str) -> SessionState | None:
        path = self._autosave_path(session_id)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            data.pop("_autosaved_at", None)
            return SessionState.from_dict(data)
        except (json.JSONDecodeError, OSError, KeyError):
            return None

    def discard_autosave(self, session_id: str) -> None:
        path = self._autosave_path(session_id)
        if path.exists():
            path.unlink()
