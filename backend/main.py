"""
SyncWave Backend — FastAPI + python-socketio
Real-time synchronised music listening via yt-dlp audio proxy.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

import httpx
import socketio
import yt_dlp
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("syncwave")

FRONTEND_URL: str = os.getenv("FRONTEND_URL", "http://localhost:3000")

# Parse ALLOWED_ORIGINS: comma-separated, strip whitespace, strip trailing slash
ALLOWED_ORIGINS: list[str] = [
    origin.strip().rstrip("/")
    for origin in FRONTEND_URL.split(",")
    if origin.strip()
]

log.info("CORS allowed origins: %s", ALLOWED_ORIGINS)

# Optional cookies for yt-dlp (base64-encoded Netscape cookie file)
YTDLP_COOKIES_B64: str = os.getenv("YTDLP_COOKIES_B64", "")
COOKIES_PATH: str | None = None

if YTDLP_COOKIES_B64:
    try:
        cookie_bytes = base64.b64decode(YTDLP_COOKIES_B64)
        COOKIES_PATH = "/tmp/cookies.txt"
        with open(COOKIES_PATH, "wb") as f:
            f.write(cookie_bytes)
        log.info("yt-dlp cookies written to %s", COOKIES_PATH)
    except Exception as exc:
        log.warning("Failed to decode YTDLP_COOKIES_B64: %s", exc)
        COOKIES_PATH = None

# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------

# room_state[room_id] = {
#   "roomId": str,
#   "currentTrack": dict | None,
#   "queue": list[dict],
#   "isPlaying": bool,
#   "anchorTime": float,       # seconds into track
#   "anchorTimestamp": int,    # Unix ms when anchor was set
#   "lastActivity": float,     # time.time()
# }
room_state: dict[str, dict[str, Any]] = {}

# stream_url_cache[video_id] = {"url": str, "headers": dict, "ts": float}
stream_url_cache: dict[str, dict[str, Any]] = {}

# room_listeners[room_id] = set of socket session IDs
room_listeners: dict[str, set[str]] = {}

STREAM_CACHE_TTL = 30 * 60   # 30 minutes in seconds
ROOM_INACTIVE_TTL = 2 * 60 * 60  # 2 hours in seconds
CHUNK_SIZE = 64 * 1024        # 64 KB

# ---------------------------------------------------------------------------
# Helper: room state factory
# ---------------------------------------------------------------------------

def _new_room(room_id: str) -> dict[str, Any]:
    return {
        "roomId": room_id,
        "currentTrack": None,
        "queue": [],
        "isPlaying": False,
        "anchorTime": 0.0,
        "anchorTimestamp": int(time.time() * 1000),
        "lastActivity": time.time(),
    }


def _touch(room_id: str) -> None:
    if room_id in room_state:
        room_state[room_id]["lastActivity"] = time.time()


def _public_state(room_id: str) -> dict[str, Any]:
    """Return the room state augmented with current listener count."""
    state = dict(room_state[room_id])
    state["listeners"] = len(room_listeners.get(room_id, set()))
    return state


# ---------------------------------------------------------------------------
# Helper: advance to next track
# ---------------------------------------------------------------------------

async def advance_track(room_id: str) -> None:
    """Pop the first item from the queue and make it currentTrack, or clear."""
    state = room_state.get(room_id)
    if state is None:
        return

    if state["queue"]:
        next_track = state["queue"].pop(0)
        state["currentTrack"] = next_track
        state["isPlaying"] = True
        state["anchorTime"] = 0.0
        state["anchorTimestamp"] = int(time.time() * 1000)
    else:
        state["currentTrack"] = None
        state["isPlaying"] = False
        state["anchorTime"] = 0.0
        state["anchorTimestamp"] = int(time.time() * 1000)

    _touch(room_id)
    await sio.emit("room_state", _public_state(room_id), room=room_id)


# ---------------------------------------------------------------------------
# Background task: clean inactive rooms
# ---------------------------------------------------------------------------

async def _cleanup_rooms() -> None:
    while True:
        await asyncio.sleep(10 * 60)  # every 10 minutes
        now = time.time()
        stale = [
            rid
            for rid, state in room_state.items()
            if now - state.get("lastActivity", now) > ROOM_INACTIVE_TTL
        ]
        for rid in stale:
            room_state.pop(rid, None)
            room_listeners.pop(rid, None)
            log.info("Cleaned up inactive room: %s", rid)


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_cleanup_rooms())
    log.info("SyncWave backend started. Allowed origins: %s", ALLOWED_ORIGINS)
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    log.info("SyncWave backend shut down.")


# ---------------------------------------------------------------------------
# Socket.IO server
# ---------------------------------------------------------------------------

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=ALLOWED_ORIGINS,
    logger=False,
    engineio_logger=False,
)


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="SyncWave API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)

# Mount Socket.IO ASGI app
app.mount("/socket.io", socketio.ASGIApp(sio))


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


@app.get("/api/search")
async def search(q: str = Query(..., min_length=1)) -> JSONResponse:
    """Search YouTube using yt-dlp and return up to 8 results."""
    ydl_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "default_search": "ytsearch8",
    }
    if COOKIES_PATH:
        ydl_opts["cookiefile"] = COOKIES_PATH

    try:
        loop = asyncio.get_event_loop()

        def _extract() -> list[dict[str, Any]]:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(f"ytsearch8:{q}", download=False)
                entries = info.get("entries", []) if info else []
                results: list[dict[str, Any]] = []
                for entry in entries:
                    if not entry:
                        continue
                    video_id = entry.get("id") or entry.get("url", "")
                    # For flat extraction the url field sometimes IS the video id
                    if video_id.startswith("http"):
                        video_id = entry.get("id", video_id)
                    results.append(
                        {
                            "videoId": video_id,
                            "title": entry.get("title", "Unknown"),
                            "artist": entry.get("uploader") or entry.get("channel") or "Unknown",
                            "duration": entry.get("duration"),
                            "thumbnail": (
                                entry.get("thumbnail")
                                or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
                            ),
                        }
                    )
                return results

        results = await loop.run_in_executor(None, _extract)
        return JSONResponse(results)

    except Exception as exc:
        log.exception("Search failed for query %r: %s", q, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/stream/{video_id}")
async def stream_audio(video_id: str, request: Request) -> StreamingResponse:
    """
    Proxy yt-dlp extracted audio URL to the client with HTTP 206 range support.
    Caches the upstream URL for 30 minutes to avoid repeated yt-dlp calls.
    """
    # --- Resolve upstream URL (with cache) ---
    cached = stream_url_cache.get(video_id)
    now = time.time()

    if cached and (now - cached["ts"]) < STREAM_CACHE_TTL:
        upstream_url: str = cached["url"]
        upstream_headers: dict[str, str] = cached.get("extra_headers", {})
        log.debug("Cache hit for video_id=%s", video_id)
    else:
        log.info("Extracting stream URL for video_id=%s", video_id)
        ydl_opts: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "skip_download": True,
            "format": "bestaudio[ext=m4a]/bestaudio",
        }
        if COOKIES_PATH:
            ydl_opts["cookiefile"] = COOKIES_PATH

        try:
            loop = asyncio.get_event_loop()

            def _get_url() -> tuple[str, dict[str, str]]:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(
                        f"https://www.youtube.com/watch?v={video_id}", download=False
                    )
                    if not info:
                        raise ValueError("No info returned by yt-dlp")
                    url: str = info["url"]
                    extra: dict[str, str] = info.get("http_headers", {})
                    return url, extra

            upstream_url, upstream_headers = await loop.run_in_executor(None, _get_url)
        except Exception as exc:
            log.exception("yt-dlp extraction failed for video_id=%s: %s", video_id, exc)
            raise HTTPException(status_code=502, detail=f"yt-dlp error: {exc}")

        stream_url_cache[video_id] = {
            "url": upstream_url,
            "extra_headers": upstream_headers,
            "ts": now,
        }

    # --- Forward range request to upstream ---
    incoming_range = request.headers.get("range")

    req_headers: dict[str, str] = {
        "User-Agent": (
            upstream_headers.get("User-Agent")
            or "Mozilla/5.0 (compatible; SyncWave/1.0)"
        ),
    }
    if incoming_range:
        req_headers["Range"] = incoming_range

    # Propagate any additional headers yt-dlp provided (e.g. Origin, Referer)
    for key in ("Referer", "Origin"):
        if key in upstream_headers:
            req_headers[key] = upstream_headers[key]

    async def _generate():
        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
            async with client.stream("GET", upstream_url, headers=req_headers) as resp:
                async for chunk in resp.aiter_bytes(chunk_size=CHUNK_SIZE):
                    yield chunk

    # We need to probe upstream first (HEAD or partial GET) to get Content-Range
    # We do a tiny GET to read the response headers, then stream the body.
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as probe_client:
            probe_headers = dict(req_headers)
            probe_req = probe_client.build_request("GET", upstream_url, headers=probe_headers)
            probe_resp = await probe_client.send(probe_req, stream=True)

            status_code = 206 if incoming_range else 200
            response_headers: dict[str, str] = {
                "Accept-Ranges": "bytes",
                "Content-Type": "audio/mp4",
            }

            upstream_content_range = probe_resp.headers.get("Content-Range")
            upstream_content_length = probe_resp.headers.get("Content-Length")
            upstream_content_type = probe_resp.headers.get("Content-Type", "audio/mp4")

            if upstream_content_range:
                response_headers["Content-Range"] = upstream_content_range
            if upstream_content_length:
                response_headers["Content-Length"] = upstream_content_length
            if "audio" in upstream_content_type or "octet" in upstream_content_type:
                response_headers["Content-Type"] = upstream_content_type

            # Determine actual status from upstream
            if probe_resp.status_code == 206:
                status_code = 206
            elif probe_resp.status_code == 200 and not incoming_range:
                status_code = 200

            async def _stream_body():
                async for chunk in probe_resp.aiter_bytes(chunk_size=CHUNK_SIZE):
                    yield chunk
                await probe_resp.aclose()

            return StreamingResponse(
                _stream_body(),
                status_code=status_code,
                headers=response_headers,
            )

    except httpx.RequestError as exc:
        log.exception("Upstream request error for video_id=%s: %s", video_id, exc)
        # Invalidate cache on network error
        stream_url_cache.pop(video_id, None)
        raise HTTPException(status_code=502, detail=f"Upstream error: {exc}")


# ---------------------------------------------------------------------------
# Socket.IO event handlers
# ---------------------------------------------------------------------------

@sio.event
async def connect(sid: str, environ: dict, auth: dict | None = None) -> None:
    log.info("Client connected: sid=%s", sid)


@sio.event
async def disconnect(sid: str) -> None:
    log.info("Client disconnected: sid=%s", sid)
    # Remove sid from all rooms it was in and broadcast updated state
    for room_id, listeners in list(room_listeners.items()):
        if sid in listeners:
            listeners.discard(sid)
            await sio.leave_room(sid, room_id)
            if room_id in room_state:
                _touch(room_id)
                await sio.emit("room_state", _public_state(room_id), room=room_id)
            if not listeners:
                room_listeners.pop(room_id, None)


@sio.on("join_room")
async def on_join_room(sid: str, data: dict) -> None:
    """
    data: { roomId: str, displayName: str }
    """
    room_id: str = data.get("roomId", "").strip().upper()
    display_name: str = data.get("displayName", "Guest").strip() or "Guest"

    if not room_id:
        await sio.emit("error", {"message": "roomId is required"}, to=sid)
        return

    # Create room if it doesn't exist
    if room_id not in room_state:
        room_state[room_id] = _new_room(room_id)
        log.info("Room created: %s", room_id)

    await sio.enter_room(sid, room_id)
    room_listeners.setdefault(room_id, set()).add(sid)
    _touch(room_id)

    log.info("sid=%s (%s) joined room %s", sid, display_name, room_id)

    # Send current room state to the joining client
    await sio.emit("room_state", _public_state(room_id), to=sid)
    # Broadcast updated listener count to everyone in the room
    await sio.emit("room_state", _public_state(room_id), room=room_id)


@sio.on("leave_room")
async def on_leave_room(sid: str, data: dict) -> None:
    """
    data: { roomId: str }
    """
    room_id: str = data.get("roomId", "").strip().upper()
    if not room_id:
        return

    await sio.leave_room(sid, room_id)
    if room_id in room_listeners:
        room_listeners[room_id].discard(sid)
        if not room_listeners[room_id]:
            room_listeners.pop(room_id, None)

    if room_id in room_state:
        _touch(room_id)
        await sio.emit("room_state", _public_state(room_id), room=room_id)

    log.info("sid=%s left room %s", sid, room_id)


@sio.on("play_pause")
async def on_play_pause(sid: str, data: dict) -> None:
    """
    data: { roomId: str, isPlaying: bool, anchorTime: float, anchorTimestamp: int }
    """
    room_id: str = data.get("roomId", "").strip().upper()
    state = room_state.get(room_id)
    if state is None:
        return

    state["isPlaying"] = bool(data.get("isPlaying", False))
    state["anchorTime"] = float(data.get("anchorTime", state["anchorTime"]))
    state["anchorTimestamp"] = int(data.get("anchorTimestamp", int(time.time() * 1000)))
    _touch(room_id)

    log.info(
        "room=%s play_pause isPlaying=%s anchorTime=%.2f",
        room_id, state["isPlaying"], state["anchorTime"],
    )
    await sio.emit("room_state", _public_state(room_id), room=room_id)


@sio.on("seek")
async def on_seek(sid: str, data: dict) -> None:
    """
    data: { roomId: str, anchorTime: float, anchorTimestamp: int, isPlaying: bool }
    """
    room_id: str = data.get("roomId", "").strip().upper()
    state = room_state.get(room_id)
    if state is None:
        return

    state["anchorTime"] = float(data.get("anchorTime", state["anchorTime"]))
    state["anchorTimestamp"] = int(data.get("anchorTimestamp", int(time.time() * 1000)))
    if "isPlaying" in data:
        state["isPlaying"] = bool(data["isPlaying"])
    _touch(room_id)

    log.info("room=%s seek anchorTime=%.2f", room_id, state["anchorTime"])
    await sio.emit("room_state", _public_state(room_id), room=room_id)


@sio.on("add_to_queue")
async def on_add_to_queue(sid: str, data: dict) -> None:
    """
    data: { roomId: str, track: { videoId, title, artist, duration, thumbnail } }
    """
    room_id: str = data.get("roomId", "").strip().upper()
    state = room_state.get(room_id)
    if state is None:
        return

    track: dict[str, Any] | None = data.get("track")
    if not track or not track.get("videoId"):
        await sio.emit("error", {"message": "Invalid track"}, to=sid)
        return

    if state["currentTrack"] is None:
        # Nothing playing — start this track immediately
        state["currentTrack"] = track
        state["isPlaying"] = True
        state["anchorTime"] = 0.0
        state["anchorTimestamp"] = int(time.time() * 1000)
        log.info("room=%s auto-playing track %s", room_id, track.get("videoId"))
    else:
        state["queue"].append(track)
        log.info(
            "room=%s queued track %s (queue len=%d)",
            room_id, track.get("videoId"), len(state["queue"]),
        )

    _touch(room_id)
    await sio.emit("room_state", _public_state(room_id), room=room_id)


@sio.on("skip_track")
async def on_skip_track(sid: str, data: dict) -> None:
    """
    data: { roomId: str }
    """
    room_id: str = data.get("roomId", "").strip().upper()
    if room_id not in room_state:
        return

    log.info("room=%s skip_track", room_id)
    await advance_track(room_id)


@sio.on("track_ended")
async def on_track_ended(sid: str, data: dict) -> None:
    """
    Idempotent: only advance if the reported videoId matches currentTrack.
    data: { roomId: str, videoId: str }
    """
    room_id: str = data.get("roomId", "").strip().upper()
    state = room_state.get(room_id)
    if state is None:
        return

    reported_id: str = data.get("videoId", "")
    current = state.get("currentTrack")

    if current is None:
        # Already no track — nothing to do
        return

    if current.get("videoId") != reported_id:
        # A different track is playing now (race condition / duplicate event) — ignore
        log.info(
            "room=%s track_ended ignored: reported=%s current=%s",
            room_id, reported_id, current.get("videoId"),
        )
        return

    log.info("room=%s track_ended for videoId=%s, advancing", room_id, reported_id)
    await advance_track(room_id)
