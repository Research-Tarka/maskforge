"""QA status tracking: todo / in_progress / validated / flagged, filterable.

Generalizes the reference tool's ``SceneTracker`` (Parquet-based, 'processed'
only status) into a richer, filterable, in-memory + injectable-persistence
QA status tracker keyed by scene id.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

QaStatus = Literal["todo", "in_progress", "validated", "flagged"]
VALID_STATUSES: tuple[QaStatus, ...] = ("todo", "in_progress", "validated", "flagged")


@dataclass
class QaRecord:
    scene_id: str
    status: QaStatus = "todo"
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    note: str = ""

    def to_dict(self) -> dict:
        return {
            "scene_id": self.scene_id,
            "status": self.status,
            "updated_at": self.updated_at,
            "note": self.note,
        }

    @staticmethod
    def from_dict(d: dict) -> "QaRecord":
        return QaRecord(
            scene_id=d["scene_id"],
            status=d.get("status", "todo"),
            updated_at=d.get("updated_at", ""),
            note=d.get("note", ""),
        )


class QaWorkflow:
    """In-memory QA status tracker. Callers persist via ``to_dict``/
    ``from_dict`` (e.g. embedded in ``SessionState.qa_state``)."""

    def __init__(self) -> None:
        self._records: dict[str, QaRecord] = {}

    def set_status(self, scene_id: str, status: QaStatus, note: str = "") -> QaRecord:
        if status not in VALID_STATUSES:
            raise ValueError(f"Invalid QA status: {status!r}. Must be one of {VALID_STATUSES}")
        record = QaRecord(
            scene_id=scene_id,
            status=status,
            updated_at=datetime.now(timezone.utc).isoformat(),
            note=note,
        )
        self._records[scene_id] = record
        return record

    def get_status(self, scene_id: str) -> QaRecord:
        return self._records.get(scene_id, QaRecord(scene_id=scene_id, status="todo"))

    def filter_by_status(self, status: QaStatus | None = None) -> list[QaRecord]:
        records = list(self._records.values())
        if status is not None:
            records = [r for r in records if r.status == status]
        return sorted(records, key=lambda r: r.scene_id)

    def counts(self) -> dict[str, int]:
        out = {s: 0 for s in VALID_STATUSES}
        for r in self._records.values():
            out[r.status] += 1
        return out

    def to_dict(self) -> dict:
        return {"records": {sid: r.to_dict() for sid, r in self._records.items()}}

    @staticmethod
    def from_dict(d: dict) -> "QaWorkflow":
        wf = QaWorkflow()
        for sid, rd in d.get("records", {}).items():
            wf._records[sid] = QaRecord.from_dict(rd)
        return wf
