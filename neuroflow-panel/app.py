"""Neuroflow control panel - FastAPI backend.

Run:  python3 -m uvicorn app:app --host 127.0.0.1 --port 8765
"""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import neuroflow as nf

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

recorder = nf.Recorder()


class Hub:
    """Fan-out of sampler chunks to every connected browser (SSE)."""

    def __init__(self) -> None:
        self.queues: set[asyncio.Queue] = set()

    def attach(self, queue: asyncio.Queue) -> None:
        self.queues.add(queue)

    def detach(self, queue: asyncio.Queue) -> None:
        self.queues.discard(queue)

    def publish(self, payload: dict[str, Any]) -> None:
        for queue in list(self.queues):
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass


hub = Hub()
sampler: nf.Sampler | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global sampler
    loop = asyncio.get_running_loop()

    def emit(payload: dict[str, Any]) -> None:
        loop.call_soon_threadsafe(hub.publish, payload)

    sampler = nf.Sampler(recorder, emit)
    sampler.start()
    try:
        yield
    finally:
        sampler.stop()
        sampler.join(timeout=2.0)
        recorder.shutdown()


app = FastAPI(title="Neuroflow Control Panel", version="1.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# --------------------------------------------------------------------------- #
# Pages
# --------------------------------------------------------------------------- #

@app.get("/", include_in_schema=False)
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(os.path.join(STATIC_DIR, "favicon.svg"), media_type="image/svg+xml")


# --------------------------------------------------------------------------- #
# State / control
# --------------------------------------------------------------------------- #

@app.get("/api/state")
def get_state():
    return recorder.snapshot()


@app.get("/api/history")
def get_history():
    return recorder.history()


@app.get("/api/spikes")
def get_spikes(limit: int = 50):
    with recorder.lock:
        spikes = list(recorder.spikes)[-max(1, min(limit, 5000)):]
    return {"spikes": spikes, "spikes_total": recorder.snapshot()["spikes_total"]}


@app.post("/api/start")
def start():
    state = recorder.start()
    hub.publish({"type": "state", "state": state})
    return state


@app.post("/api/stop")
def stop():
    state = recorder.stop()
    hub.publish({"type": "state", "state": state})
    return state


@app.post("/api/reset")
def reset():
    state = recorder.reset()
    hub.publish({"type": "reset", "state": state})
    return state


@app.post("/api/config")
def set_config(patch: dict[str, Any] = Body(...)):
    try:
        state = recorder.apply_config(patch)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    hub.publish({"type": "state", "state": state})
    return state


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #

def _csv_response(rows, filename: str) -> StreamingResponse:
    return StreamingResponse(
        rows,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/export/samples.csv")
def export_samples():
    stamp = recorder.snapshot()["session_id"] or "unstarted"
    return _csv_response(recorder.export_samples(), f"neuroflow-samples-{stamp}.csv")


@app.get("/api/export/spikes.csv")
def export_spikes():
    stamp = recorder.snapshot()["session_id"] or "unstarted"
    return _csv_response(recorder.export_spikes(), f"neuroflow-spikes-{stamp}.csv")


# --------------------------------------------------------------------------- #
# Live stream
# --------------------------------------------------------------------------- #

@app.get("/api/stream")
async def stream(request: Request):
    queue: asyncio.Queue = asyncio.Queue(maxsize=400)
    hub.attach(queue)

    async def event_source():
        try:
            yield "retry: 1500\n\n"
            yield f"data: {json.dumps({'type': 'hello', 'state': recorder.snapshot()})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                yield "data: " + json.dumps(payload, separators=(",", ":")) + "\n\n"
        finally:
            hub.detach(queue)

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})
