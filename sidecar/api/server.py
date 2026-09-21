"""FastAPI application entrypoint for the MaskForge sidecar.

Binds to 127.0.0.1:<port>, where <port> is the OS-assigned free port unless
the MASKFORGE_PORT env var is set (in which case that port is used). Prints
`MASKFORGE_PORT=<port>` as the FIRST stdout line, flushed immediately, so
the Tauri shell can read the port from the child process's stdout before
doing anything else — this must happen before uvicorn's own startup logging.

Auth: the sidecar has full filesystem read/write access on behalf of the
desktop user and binds to 127.0.0.1, which is reachable by ANY local
process or browser tab (CORS only restricts what a browser script can
*read back*, not what it can send — a malicious page can still issue a
same-origin-policy-exempt "simple" request, and our JSON POSTs are
preflighted but the preflight itself doesn't require any secret to pass).
Knowing the dynamic port is not a real barrier (it can be scanned/leaked).
So every request (other than the liveness probe) must present a per-launch
random token, generated fresh at startup and handed to the Tauri shell the
same way the port is (a stdout line), which in turn is the only party that
can pass it on to the frontend via a Tauri IPC command — a page that merely
knows the port cannot forge it.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import socket
import sys
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from maskforge_core.plugins.zarr_reader import register as _register_zarr_reader

from .routers import classes, masks, qa, scenes, sessions, tools
from .schemas import IPC_CONTRACT_VERSION, HealthResponse

# Built-in format plugins, registered once at process import time (before any
# request can reach raster_io.read_image_any's find_reader() dispatch).
_register_zarr_reader()

API_PREFIX = "/api/v1"
AUTH_TOKEN = os.environ.get("MASKFORGE_TOKEN") or secrets.token_urlsafe(32)
AUTH_HEADER = "X-MaskForge-Token"

app = FastAPI(title="MaskForge Sidecar", version=IPC_CONTRACT_VERSION)

app.add_middleware(
    CORSMiddleware,
    # "tauri://localhost" is the webview origin on macOS/Linux; Windows
    # serves the bundled frontend from "http://tauri.localhost" instead
    # (Tauri's custom-protocol scheme differs per platform) — both must be
    # allowed for the packaged app's fetch() calls to pass CORS preflight.
    allow_origins=[
        "tauri://localhost",
        "http://tauri.localhost",
        "http://localhost",
        "http://127.0.0.1",
    ],
    allow_origin_regex=r"http://localhost:\d+|http://127\.0\.0\.1:\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_auth_token(request: Request, call_next):
    # The liveness probe is intentionally unauthenticated (no filesystem
    # access, no data disclosure) so the shell can detect "sidecar is up"
    # before it has wired the token through. Everything else — including
    # the WebSocket upgrade route, handled separately below — requires it.
    if request.url.path == f"{API_PREFIX}/health":
        return await call_next(request)
    # Browser CORS preflight (OPTIONS) never carries the custom auth header
    # — it's sent by the browser itself, not our JS. Rejecting it with 401
    # here would short-circuit CORSMiddleware before it adds the
    # Access-Control-Allow-* headers, making the browser block the real
    # request that follows with a generic "Failed to fetch".
    if request.method == "OPTIONS":
        return await call_next(request)
    presented = request.headers.get(AUTH_HEADER)
    if not presented or not secrets.compare_digest(presented, AUTH_TOKEN):
        return JSONResponse(status_code=401, content={"detail": "Missing or invalid auth token."})
    return await call_next(request)


app.include_router(scenes.router, prefix=API_PREFIX)
app.include_router(masks.router, prefix=API_PREFIX)
app.include_router(classes.router, prefix=API_PREFIX)
app.include_router(sessions.router, prefix=API_PREFIX)
app.include_router(tools.router, prefix=API_PREFIX)
app.include_router(qa.router, prefix=API_PREFIX)


@app.get(f"{API_PREFIX}/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=IPC_CONTRACT_VERSION)


# ===========================================================================
# WebSocket progress channel
# ===========================================================================


class ProgressBroker:
    """Simple pub/sub broker for job progress messages, broadcast to all
    connected /ws/progress clients."""

    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._connections.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(ws)

    async def broadcast(self, message: dict[str, Any]) -> None:
        async with self._lock:
            targets = list(self._connections)
        for ws in targets:
            try:
                await ws.send_json(message)
            except Exception:
                await self.disconnect(ws)


progress_broker = ProgressBroker()


@app.websocket(f"{API_PREFIX}/ws/progress")
async def ws_progress(websocket: WebSocket) -> None:
    # Starlette's HTTP middleware (require_auth_token above) does not run
    # for WebSocket connections — the upgrade handshake needs its own check,
    # via a query param since browsers' WebSocket API can't set headers.
    if websocket.query_params.get("token") != AUTH_TOKEN:
        await websocket.close(code=4401)
        return

    await progress_broker.connect(websocket)
    try:
        while True:
            # Clients don't need to send anything; keep the connection
            # alive and drain any pings/messages they do send.
            await websocket.receive_text()
    except WebSocketDisconnect:
        await progress_broker.disconnect(websocket)


# ===========================================================================
# Standalone run (used by PyInstaller entrypoint / `python -m api.server`)
# ===========================================================================


def _pick_port(requested: int) -> int:
    """Bind to `requested` (0 = OS-assigned) on 127.0.0.1, return the
    actual bound port, then release the socket so uvicorn can bind it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", requested))
        return s.getsockname()[1]


def main() -> None:
    import uvicorn

    requested_port = int(os.environ.get("MASKFORGE_PORT", "0"))
    port = _pick_port(requested_port)

    # Print the port and auth token as the very first stdout lines, flushed
    # immediately, before uvicorn's own logging kicks in. Both are read by
    # the Tauri shell's stdout parser (see src-tauri/src/sidecar.rs) and
    # handed to the frontend via the get_sidecar_port/get_sidecar_token
    # commands — never logged anywhere else, never sent to the frontend by
    # any other channel.
    print(f"MASKFORGE_PORT={port}", flush=True)
    print(f"MASKFORGE_TOKEN={AUTH_TOKEN}", flush=True)
    sys.stdout.flush()

    # access_log=False: uvicorn's access logger fails to flush on this
    # process's stdout once Tauri has it open as a piped, line-read handle
    # (OSError: [Errno 22] Invalid argument on Windows) -- harmless, but it
    # spams the dev console with a full traceback per request. The
    # MASKFORGE_PORT/TOKEN lines above use plain print(), which is
    # unaffected.
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
