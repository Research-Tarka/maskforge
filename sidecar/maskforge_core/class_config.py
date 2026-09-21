"""Class definitions and palettes, persisted under ``~/.maskforge/class_palettes/``.

Generalizes the reference tool's hardcoded 4-class dict
(``MaskEditorConfig.classes`` / ``class_values``) into user-defined,
persisted, arbitrary-size palettes (plan section 3).
"""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

MASKFORGE_HOME = Path.home() / ".maskforge"
PALETTES_DIR = MASKFORGE_HOME / "class_palettes"
PALETTES_INDEX = PALETTES_DIR / "palettes_index.json"


def _ensure_dirs() -> None:
    PALETTES_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class ClassDef:
    id: str
    name: str
    color: tuple[int, int, int]
    value: int
    active_by_default: bool = True

    @staticmethod
    def new(name: str, color: tuple[int, int, int], value: int, active_by_default: bool = True) -> "ClassDef":
        return ClassDef(id=str(uuid.uuid4()), name=name, color=color, value=value, active_by_default=active_by_default)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "color": list(self.color),
            "value": self.value,
            "active_by_default": self.active_by_default,
        }

    @staticmethod
    def from_dict(d: dict) -> "ClassDef":
        return ClassDef(
            id=d["id"],
            name=d["name"],
            color=tuple(d["color"]),
            value=d["value"],
            active_by_default=d.get("active_by_default", True),
        )


@dataclass
class ClassPalette:
    id: str
    name: str
    classes: list[ClassDef] = field(default_factory=list)

    @staticmethod
    def new(name: str, classes: list[ClassDef] | None = None) -> "ClassPalette":
        return ClassPalette(id=str(uuid.uuid4()), name=name, classes=classes or [])

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "classes": [c.to_dict() for c in self.classes]}

    @staticmethod
    def from_dict(d: dict) -> "ClassPalette":
        return ClassPalette(id=d["id"], name=d["name"], classes=[ClassDef.from_dict(c) for c in d.get("classes", [])])

    def color_map(self) -> dict[str, tuple[int, int, int]]:
        return {c.name: c.color for c in self.classes}

    def value_map(self) -> dict[str, int]:
        return {c.name: c.value for c in self.classes}


class PaletteStore:
    """Persistence layer for class palettes under ``~/.maskforge/class_palettes/``."""

    def __init__(self, base_dir: Path | None = None):
        self.dir = base_dir or PALETTES_DIR
        self.index_path = self.dir / "palettes_index.json"
        self.dir.mkdir(parents=True, exist_ok=True)

    def _palette_path(self, palette_id: str) -> Path:
        return self.dir / f"{palette_id}.json"

    def _read_index(self) -> list[str]:
        if not self.index_path.exists():
            return []
        try:
            return json.loads(self.index_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []

    def _write_index(self, ids: list[str]) -> None:
        self.index_path.write_text(json.dumps(ids, indent=2), encoding="utf-8")

    def list_all(self) -> list[ClassPalette]:
        out: list[ClassPalette] = []
        for palette_id in self._read_index():
            p = self.get(palette_id)
            if p is not None:
                out.append(p)
        return out

    def get(self, palette_id: str) -> ClassPalette | None:
        path = self._palette_path(palette_id)
        if not path.exists():
            return None
        try:
            return ClassPalette.from_dict(json.loads(path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError, KeyError):
            return None

    def save(self, palette: ClassPalette) -> ClassPalette:
        path = self._palette_path(palette.id)
        path.write_text(json.dumps(palette.to_dict(), indent=2), encoding="utf-8")
        ids = self._read_index()
        if palette.id not in ids:
            ids.append(palette.id)
            self._write_index(ids)
        return palette

    def delete(self, palette_id: str) -> bool:
        path = self._palette_path(palette_id)
        existed = path.exists()
        if existed:
            path.unlink()
        ids = [i for i in self._read_index() if i != palette_id]
        self._write_index(ids)
        return existed


def default_palette() -> ClassPalette:
    """Default palette: landscape-change-detection-pipeline land-cover classes.

    Mirrors ``configs/classes.yaml`` from the landscape-change-detection-pipeline
    repo (single source of truth there). Keep in sync when that file changes;
    ``value`` matches the pipeline's stable ``id`` since those ids are burned
    into annotation rasters and must never be renumbered.
    """
    return ClassPalette.new(
        name="Default",
        classes=[
            ClassDef.new("forest", (34, 94, 42), 0, active_by_default=True),
            ClassDef.new("bare_ground", (200, 170, 130), 1, active_by_default=True),
            ClassDef.new("grassland_herbaceous", (140, 200, 90), 2, active_by_default=True),
            ClassDef.new("cultivated_agriculture", (230, 182, 92), 3, active_by_default=True),
            ClassDef.new("wetland_marsh", (66, 168, 154), 4, active_by_default=True),
            ClassDef.new("open_water", (40, 96, 191), 5, active_by_default=True),
            ClassDef.new("cutblock_harvest", (176, 124, 60), 6, active_by_default=True),
            ClassDef.new("burned_disturbed", (140, 60, 40), 7, active_by_default=True),
            ClassDef.new("snow_cover", (235, 245, 255), 8, active_by_default=True),
            ClassDef.new("ice_cover", (180, 220, 235), 9, active_by_default=True),
            ClassDef.new("rock_alpine_bare", (153, 153, 153), 10, active_by_default=True),
            ClassDef.new("built_up_infrastructure", (200, 30, 30), 13, active_by_default=True),
            ClassDef.new("cloud", (225, 225, 230), 14, active_by_default=True),
            ClassDef.new("shadow", (40, 40, 40), 15, active_by_default=True),
        ],
    )
