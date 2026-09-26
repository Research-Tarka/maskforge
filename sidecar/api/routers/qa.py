from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from maskforge_core import raster_io
from maskforge_core.qa_workflow import VALID_STATUSES

from ..schemas import (
    ClassStats,
    StatsExportRequest,
    StatsExportResponse,
    StatsResponse,
)
from ..state import get_state

router = APIRouter(tags=["qa"])


# ===========================================================================
# QA status
# ===========================================================================


class QaStatusUpdate(BaseModel):
    status: str
    note: str = ""


@router.get("/qa/status/{scene_id}")
def get_qa_status(scene_id: str) -> dict[str, Any]:
    record = get_state().qa_workflow.get_status(scene_id)
    return record.to_dict()


@router.post("/qa/status/{scene_id}")
def set_qa_status(scene_id: str, body: QaStatusUpdate) -> dict[str, Any]:
    if body.status not in VALID_STATUSES:
        raise HTTPException(status_code=422, detail=f"Invalid status. Must be one of {VALID_STATUSES}")
    record = get_state().qa_workflow.set_status(scene_id, body.status, body.note)  # type: ignore[arg-type]
    scene = get_state().get_scene(scene_id)
    if scene is not None:
        scene.qa_status = body.status  # type: ignore[assignment]
    return record.to_dict()


@router.get("/qa/list")
def list_qa(status: str | None = None) -> list[dict[str, Any]]:
    if status is not None and status not in VALID_STATUSES:
        raise HTTPException(status_code=422, detail=f"Invalid status filter. Must be one of {VALID_STATUSES}")
    records = get_state().qa_workflow.filter_by_status(status)  # type: ignore[arg-type]
    return [r.to_dict() for r in records]


# ===========================================================================
# Stats
# ===========================================================================


@router.get("/stats/{scene_id}", response_model=StatsResponse)
def get_stats(scene_id: str) -> StatsResponse:
    buf = get_state().get_mask_buffer(scene_id)
    if buf is None:
        raise HTTPException(status_code=404, detail=f"No mask buffer for scene: {scene_id}")

    counts = np.bincount(buf.classes.ravel())
    classes = [
        ClassStats(class_value=int(v), pixel_count=int(c))
        for v, c in enumerate(counts)
        if c > 0 and v != raster_io.NODATA_VALUE
    ]
    return StatsResponse(scene_id=scene_id, total_pixels=int(buf.classes.size), classes=classes)


@router.post("/stats/export", response_model=StatsExportResponse)
def export_stats(req: StatsExportRequest) -> StatsExportResponse:
    state = get_state()
    rows: list[dict[str, Any]] = []
    for scene_id in req.scene_ids:
        buf = state.get_mask_buffer(scene_id)
        if buf is None:
            continue
        counts = np.bincount(buf.classes.ravel())
        for value, count in enumerate(counts):
            if count > 0:
                rows.append({"scene_id": scene_id, "class_value": int(value), "pixel_count": int(count)})

    df = pd.DataFrame(rows, columns=["scene_id", "class_value", "pixel_count"])

    export_dir = state.home / "exports"
    export_dir.mkdir(parents=True, exist_ok=True)

    if req.format == "csv":
        out_path = export_dir / "stats_export.csv"
        df.to_csv(out_path, index=False)
    else:
        out_path = export_dir / "stats_export.parquet"
        try:
            df.to_parquet(out_path, index=False)
        except ImportError as exc:
            raise HTTPException(
                status_code=503, detail="pyarrow/fastparquet not installed: cannot export parquet."
            ) from exc

    return StatsExportResponse(path=str(out_path))
