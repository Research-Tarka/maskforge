"""Tool metadata/listing endpoint (not part of the core IPC contract's
required set, but useful for the frontend to introspect available tools
without hardcoding names)."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from maskforge_core.tools import TOOL_REGISTRY

router = APIRouter(prefix="/tools", tags=["tools"])


class ToolInfo(BaseModel):
    name: str
    description: str


_DESCRIPTIONS = {
    "brush": "Circular brush stamp, vectorized disk stamping.",
    "bucket": "4/8-connected flood fill via scipy.ndimage.label.",
    "polygon": "Polygon fill via Shapely + rasterio.features.rasterize.",
    "autofill": "Source-image-guided flood fill via skimage.segmentation.flood.",
}


@router.get("", response_model=list[ToolInfo])
def list_tools() -> list[ToolInfo]:
    return [ToolInfo(name=name, description=_DESCRIPTIONS.get(name, "")) for name in sorted(TOOL_REGISTRY)]
