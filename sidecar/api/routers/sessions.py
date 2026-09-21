from __future__ import annotations

from fastapi import APIRouter, HTTPException

from maskforge_core.session import SessionState as CoreSessionState

from ..schemas import DeletedResponse, SessionState
from ..state import get_state

router = APIRouter(prefix="/sessions", tags=["sessions"])


def _to_core(s: SessionState) -> CoreSessionState:
    return CoreSessionState(
        schema_version=s.schema_version,
        id=s.id,
        name=s.name,
        discovery=s.discovery.model_dump(),
        active_palette_id=s.active_palette_id,
        active_class_ids=s.active_class_ids,
        save_config=s.save_config.model_dump(),
        training_save_config=s.training_save_config.model_dump() if s.training_save_config else None,
        ui_state=s.ui_state,
        qa_state=s.qa_state,
        recent_sessions=s.recent_sessions,
    )


def _to_schema(s: CoreSessionState) -> SessionState:
    return SessionState.model_validate(s.to_dict())


@router.get("", response_model=list[SessionState])
def list_sessions() -> list[SessionState]:
    return [_to_schema(s) for s in get_state().session_store.list_all()]


@router.get("/{session_id}", response_model=SessionState)
def get_session(session_id: str) -> SessionState:
    s = get_state().session_store.get(session_id)
    if s is None:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    return _to_schema(s)


@router.post("", response_model=SessionState)
def create_session(session: SessionState) -> SessionState:
    saved = get_state().session_store.save(_to_core(session))
    return _to_schema(saved)


@router.put("/{session_id}", response_model=SessionState)
def update_session(session_id: str, session: SessionState) -> SessionState:
    if session.id != session_id:
        raise HTTPException(status_code=422, detail="Body id must match path id")
    saved = get_state().session_store.save(_to_core(session))
    return _to_schema(saved)


@router.delete("/{session_id}", response_model=DeletedResponse)
def delete_session(session_id: str) -> DeletedResponse:
    existed = get_state().session_store.delete(session_id)
    if not existed:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    return DeletedResponse(deleted=True)
