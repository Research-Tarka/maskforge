from __future__ import annotations

from fastapi import APIRouter, HTTPException

from maskforge_core.class_config import ClassDef as CoreClassDef
from maskforge_core.class_config import ClassPalette as CorePalette

from ..schemas import ClassPalette, DeletedResponse
from ..state import get_state

router = APIRouter(prefix="/classes", tags=["classes"])


def _to_core(p: ClassPalette) -> CorePalette:
    return CorePalette(
        id=p.id,
        name=p.name,
        classes=[
            CoreClassDef(id=c.id, name=c.name, color=c.color, value=c.value, active_by_default=c.active_by_default)
            for c in p.classes
        ],
    )


def _to_schema(p: CorePalette) -> ClassPalette:
    return ClassPalette.model_validate(p.to_dict())


@router.get("/palettes", response_model=list[ClassPalette])
def list_palettes() -> list[ClassPalette]:
    return [_to_schema(p) for p in get_state().palette_store.list_all()]


@router.post("/palettes", response_model=ClassPalette)
def create_palette(palette: ClassPalette) -> ClassPalette:
    saved = get_state().palette_store.save(_to_core(palette))
    return _to_schema(saved)


@router.put("/palettes/{palette_id}", response_model=ClassPalette)
def update_palette(palette_id: str, palette: ClassPalette) -> ClassPalette:
    if palette.id != palette_id:
        raise HTTPException(status_code=422, detail="Body id must match path id")
    saved = get_state().palette_store.save(_to_core(palette))
    return _to_schema(saved)


@router.delete("/palettes/{palette_id}", response_model=DeletedResponse)
def delete_palette(palette_id: str) -> DeletedResponse:
    existed = get_state().palette_store.delete(palette_id)
    if not existed:
        raise HTTPException(status_code=404, detail=f"Palette not found: {palette_id}")
    return DeletedResponse(deleted=True)
