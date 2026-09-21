"""MaskForge core: raster I/O, drawing tools, class configs, scene discovery,
session persistence, contours, QA workflow, and shadow generation.

This package has no FastAPI/HTTP dependency — it is pure logic, usable
standalone or embedded in the ``api`` package's HTTP server.
"""

from __future__ import annotations

__all__ = [
    "raster_io",
    "tools",
    "class_config",
    "scene_discovery",
    "session",
    "contours",
    "qa_workflow",
    "shadow_gen",
]
