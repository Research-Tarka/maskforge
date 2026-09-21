"""Plugin extension points for custom raster formats.

Plan section: "Système de plugins pour formats de fichiers custom (Protocol
`RasterReader`/`RasterWriter`)". This module defines the interface only —
no concrete extra formats are implemented in V1. A plugin implements
``RasterReader`` and/or ``RasterWriter`` and registers itself via
``register_reader`` / ``register_writer`` keyed by a format name or file
extension, mirroring the same registry pattern used by
``maskforge_core.shadow_gen`` for custom shadow methods.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol, runtime_checkable

import numpy as np


@runtime_checkable
class RasterReader(Protocol):
    """A custom-format raster reader plugin."""

    def can_read(self, path: Path) -> bool:
        """Return True if this reader can handle the given file."""
        ...

    def read(self, path: Path) -> tuple[np.ndarray, dict[str, Any]]:
        """Read the file, returning ``(array, meta)``.

        ``array`` is ``(H, W)`` or ``(H, W, C)``. ``meta`` should include at
        least ``width``, ``height``, and, if applicable, ``crs`` and
        ``transform`` (as a 6-tuple / GDAL-style affine coefficients).
        """
        ...


@runtime_checkable
class RasterWriter(Protocol):
    """A custom-format raster writer plugin."""

    def can_write(self, path: Path) -> bool:
        """Return True if this writer can handle the given output path."""
        ...

    def write(self, array: np.ndarray, path: Path, meta: dict[str, Any]) -> int:
        """Write ``array`` to ``path`` using ``meta`` (see `RasterReader.read`
        for shape). Returns the number of bytes written."""
        ...


_READERS: dict[str, RasterReader] = {}
_WRITERS: dict[str, RasterWriter] = {}


def register_reader(name: str, reader: RasterReader) -> None:
    _READERS[name] = reader


def register_writer(name: str, writer: RasterWriter) -> None:
    _WRITERS[name] = writer


def unregister_reader(name: str) -> None:
    _READERS.pop(name, None)


def unregister_writer(name: str) -> None:
    _WRITERS.pop(name, None)


def find_reader(path: Path) -> RasterReader | None:
    for reader in _READERS.values():
        if reader.can_read(path):
            return reader
    return None


def find_writer(path: Path) -> RasterWriter | None:
    for writer in _WRITERS.values():
        if writer.can_write(path):
            return writer
    return None


def list_readers() -> list[str]:
    return sorted(_READERS)


def list_writers() -> list[str]:
    return sorted(_WRITERS)
