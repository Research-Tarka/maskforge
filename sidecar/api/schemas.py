"""Pydantic v2 schemas mirroring docs/IPC_CONTRACT.md field-for-field.

IPC_CONTRACT_VERSION must stay in sync with the same constant in
src/types/api.ts (checked in CI per the contract doc).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

IPC_CONTRACT_VERSION = "1.1.0"


# ===========================================================================
# Data model
# ===========================================================================


class ClassDef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    color: tuple[int, int, int]
    value: int
    active_by_default: bool = True


class ClassPalette(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    classes: list[ClassDef] = Field(default_factory=list)


class SceneEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    raw_path: str | None = None
    shadow_path: str | None = None
    mask_path: str | None = None
    detected_resolution: tuple[float, float] | None = None
    detected_crs: str | None = None
    mode: Literal["annotate", "review"] = "annotate"
    qa_status: Literal["todo", "in_progress", "validated", "flagged"] = "todo"
    # Every RGB composite view this scene has, {view_name: composite_path} --
    # see maskforge_core.scene_discovery.SceneEntry.rgb_composites. Only ever
    # populated for a zarr-store scene; empty for a plain-file scene (where
    # raw_path/shadow_path are the only two views that can ever exist).
    rgb_composites: dict[str, str] = Field(default_factory=dict)


class ScanRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    raw_patterns: list[str] = Field(default_factory=list)
    shadow_patterns: list[str] = Field(default_factory=list)
    mask_patterns: list[str] = Field(default_factory=list)
    max_depth: int = 5
    file_extensions: list[str] = Field(default_factory=list)


class DiscoveryConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_root: str
    scan_rule: ScanRule
    exclude_globs: list[str] = Field(default_factory=list)


class SaveConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    output_format: Literal["geotiff_rgba", "geotiff_rgb", "png", "png_indexed"] = "geotiff_rgba"
    output_root: str = ""
    folder_structure_template: str = "{scene_id}/mask.tif"
    copy_raw: bool = False
    copy_shadow: bool = False
    preserve_georef: bool = True
    resolution_mode: Literal["native", "custom"] = "native"
    target_resolution: tuple[float, float] | None = None
    compress: str | None = "LZW"


class SessionState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = 1
    id: str
    name: str
    discovery: DiscoveryConfig
    active_palette_id: str = ""
    active_class_ids: list[str] = Field(default_factory=list)
    save_config: SaveConfig = Field(default_factory=SaveConfig)
    # A second, independent save configuration for a resampled "training"
    # copy (e.g. native 10m Sentinel-2 mask alongside a 30m Landsat-scale
    # copy for model training) — saved via a separate action/button from
    # save_config, matching the reference workflow's Mask.tif + Mask_Train.tif.
    training_save_config: SaveConfig | None = None
    ui_state: dict[str, Any] = Field(default_factory=dict)
    qa_state: dict[str, Any] = Field(default_factory=dict)
    recent_sessions: list[str] = Field(default_factory=list)


# ===========================================================================
# Endpoint request/response bodies
# ===========================================================================


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    version: str = IPC_CONTRACT_VERSION


class LayerData(BaseModel):
    width: int
    height: int
    crs: str | None = None
    transform: tuple[float, float, float, float, float, float] | None = None
    png_base64: str


class LayersResponse(BaseModel):
    # Every RGB composite view currently rendered for this scene, keyed by
    # view name (e.g. "rgb_true_color") -- replaces the old fixed raw/shadow
    # pair now that a scene can have up to 4 (or more) RGB visuals. Only the
    # views requested via GET /scenes/{id}/layers?views=... are populated
    # (see scenes.py:get_layers) to avoid decoding/encoding every composite
    # on every call when only some are actually shown on screen.
    rgb: dict[str, LayerData] = Field(default_factory=dict)
    mask: LayerData | None = None


class ToolRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool: Literal["brush", "bucket", "polygon", "autofill", "fill_all"]
    params: dict[str, Any] = Field(default_factory=dict)
    class_value: int
    # True for every brush stamp after the first one in a single drag
    # (pointerdown -> pointerup) -- skips pushing a new undo snapshot so
    # the whole stroke undoes in one step instead of one step per stamp.
    continue_stroke: bool = False


class ToolResponse(BaseModel):
    png_base64: str
    bbox: tuple[int, int, int, int]
    changed_pixels: int


class AutoSegmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Which RGB composite view(s) to cluster on, by name (e.g.
    # ["rgb_true_color", "rgb_color_infrared"]) -- checked in the frontend's
    # auto-segment panel. Multiple sources are stacked band-wise before
    # clustering (see masks.py::_load_auto_segment_sources), giving the
    # clustering more information than any single view alone.
    sources: list[str] = Field(min_length=1)
    n_clusters: int = 4
    method: Literal["kmeans", "gmm"] = "kmeans"
    use_texture: bool = True


class AutoSegmentClusterInfo(BaseModel):
    cluster_id: int
    mean_color: tuple[float, ...]
    # The exact RGB this cluster is rendered as in preview_png_base64 (see
    # masks.py's _PREVIEW_COLORS) -- the frontend overlay needs this to
    # recolor an assigned cluster distinctly without re-deriving or
    # duplicating that palette client-side.
    preview_color: tuple[int, int, int]


class AutoSegmentResponse(BaseModel):
    # Preview PNG: each cluster rendered as its own mean color, so the user
    # can visually judge cluster quality before assigning classes to them.
    preview_png_base64: str
    clusters: list[AutoSegmentClusterInfo]


class ApplyAutoSegmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Maps cluster_id -> class_value for every cluster the user wants to
    # keep; clusters omitted here are left untouched in the mask.
    cluster_to_class: dict[int, int]


class ApplyAutoSegmentComponentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # A point identifying which connected component of the pending
    # auto-segment result to apply — only the connected region of matching
    # cluster pixels touching (x, y) is affected, not every pixel sharing
    # that cluster elsewhere in the frame. Lets the user assign two
    # same-colored but spatially separate regions (e.g. snow at the top,
    # a cloud on the right, both landing in the same color cluster) to
    # different classes one click at a time.
    x: int
    y: int
    class_value: int


class SaveResponse(BaseModel):
    path: str
    bytes_written: int


class RemapRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    old_color: tuple[int, int, int]
    new_color: tuple[int, int, int]
    dry_run: bool = False


class RemapResponse(BaseModel):
    affected_pixels: int
    applied: bool


class UndoRedoResponse(BaseModel):
    applied: bool


class DeletedResponse(BaseModel):
    deleted: bool = True


class ShadowGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scene_id: str
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


class ShadowPreset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


class ClassStats(BaseModel):
    class_value: int
    pixel_count: int


class StatsResponse(BaseModel):
    scene_id: str
    total_pixels: int
    classes: list[ClassStats]


class StatsExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scene_ids: list[str]
    format: Literal["csv", "parquet"] = "csv"


class StatsExportResponse(BaseModel):
    path: str


class ProgressMessage(BaseModel):
    job_id: str
    phase: str
    progress: float
    message: str = ""
