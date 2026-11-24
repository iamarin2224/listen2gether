"""
Listen2Gether (L2G) Backend — FastAPI + python-socketio
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
log = logging.getLogger("listen2gether")

FRONTEND_URL: str = os.getenv("FRONTEND_URL", "http://localhost:3000")

# Parse ALLOWED_ORIGINS: comma-separated, strip whitespace, strip trailing slash
ALLOWED_ORIGINS: list[str] = [
    origin.strip().rstrip("/")
    for origin in FRONTEND_URL.split(",")
    if origin.strip()
]

# When wildcard or development tunneling is needed, or if "*" is specified:
ALLOW_ALL_ORIGINS = "*" in ALLOWED_ORIGINS or os.getenv("ALLOW_ALL_CORS", "true").lower() in ("true", "1")

log.info("CORS allowed origins: %s (allow_all=%s)", ALLOWED_ORIGINS, ALLOW_ALL_ORIGINS)

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

# Coalesce in-flight extraction requests to prevent multiple yt-dlp processes spawning simultaneously
_in_flight_extractions: dict[str, asyncio.Task] = {}

# room_listeners[room_id] = set of socket session IDs
room_listeners: dict[str, set[str]] = {}

STREAM_CACHE_TTL = 15 * 60   # 15 minutes in seconds
ROOM_INACTIVE_TTL = 2 * 60 * 60  # 2 hours in seconds
CHUNK_SIZE = 64 * 1024        # 64 KB
ROOMS_PERSISTENCE_FILE = "/tmp/listen2gether_rooms.json"

# ---------------------------------------------------------------------------
# Room persistence across process reboots
# ---------------------------------------------------------------------------

def _save_rooms_to_disk() -> None:
    try:
        data = {
            rid: {
                "roomId": r["roomId"],
                "currentTrack": r.get("currentTrack"),
                "queue": r.get("queue", []),
                "history": r.get("history", []),
                "isPlaying": r.get("isPlaying", False),
                "anchorTime": r.get("anchorTime", 0.0),
                "anchorTimestamp": r.get("anchorTimestamp", int(time.time() * 1000)),
                "lastActivity": r.get("lastActivity", time.time()),
                "_started": r.get("_started", False),
            }
            for rid, r in room_state.items()
        }
        with open(ROOMS_PERSISTENCE_FILE, "w") as f:
            json.dump(data, f)
    except Exception as e:
        log.debug("Failed saving rooms to disk: %s", e)

def _load_rooms_from_disk() -> None:
    try:
        if os.path.exists(ROOMS_PERSISTENCE_FILE):
            with open(ROOMS_PERSISTENCE_FILE, "r") as f:
                data = json.load(f)
                now = time.time()
                for rid, r in data.items():
                    if (now - r.get("lastActivity", now)) < ROOM_INACTIVE_TTL:
                        room_state[rid] = r
            log.info("Restored %d active rooms from persistent storage", len(room_state))
    except Exception as e:
        log.debug("Failed loading rooms from disk: %s", e)

# Pre-load existing rooms immediately
_load_rooms_from_disk()

# ---------------------------------------------------------------------------
# Helper: room state factory
# ---------------------------------------------------------------------------

def _new_room(room_id: str) -> dict[str, Any]:
    return {
        "roomId": room_id,
        "currentTrack": None,
        "queue": [],
        "history": [],
        "isPlaying": False,
        "anchorTime": 0.0,
        "anchorTimestamp": int(time.time() * 1000),
        "lastActivity": time.time(),
        "_started": False,
    }


def _touch(room_id: str) -> None:
    if room_id in room_state:
        room_state[room_id]["lastActivity"] = time.time()
        _save_rooms_to_disk()


def _public_state(room_id: str) -> dict[str, Any]:
    """Return the room state augmented with current listener count."""
    state = dict(room_state[room_id])
    listeners_set = room_listeners.get(room_id, set())
    # Send both listener count and listeners array for compatibility
    state["listenerCount"] = len(listeners_set)
    state["listeners"] = list(listeners_set)
    return state


# ---------------------------------------------------------------------------
# Helper: advance to next track
# ---------------------------------------------------------------------------

async def advance_track(room_id: str) -> None:
    """Pop the first item from the queue and make it currentTrack, or clear."""
    state = room_state.get(room_id)
    if state is None:
        return

    # Push old track to history
    if state.get("currentTrack"):
        if "history" not in state:
            state["history"] = []
        state["history"].append(state["currentTrack"])
        if len(state["history"]) > 50:
            state["history"].pop(0)

    if state["queue"]:
        next_track = state["queue"].pop(0)
        vid = next_track.get("videoId")
        # Remove any remaining copies of next_track from queue
        state["queue"] = [q for q in state["queue"] if q.get("videoId") != vid]
        state["currentTrack"] = next_track
        state["isPlaying"] = True
        state["anchorTime"] = 0.0
        state["anchorTimestamp"] = int(time.time() * 1000)
        state["_started"] = False
        # Pre-extract next track in queue if available
        if state["queue"] and state["queue"][0].get("videoId"):
            asyncio.create_task(safe_pre_extract(state["queue"][0]["videoId"]))
    else:
        state["currentTrack"] = None
        state["isPlaying"] = False
        state["anchorTime"] = 0.0
        state["anchorTimestamp"] = int(time.time() * 1000)
        state["_started"] = False

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
    log.info("Listen2Gether backend started. Allowed origins: %s", ALLOWED_ORIGINS)
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    log.info("Listen2Gether backend shut down.")


# ---------------------------------------------------------------------------
# Socket.IO server
# ---------------------------------------------------------------------------

# Socket.IO server: handles CORS directly for /socket.io endpoints
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*" if ALLOW_ALL_ORIGINS else ALLOWED_ORIGINS,
    logger=False,
    engineio_logger=False,
)


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="Listen2Gether (L2G) API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if ALLOW_ALL_ORIGINS else ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)

# Mount Socket.IO ASGI app directly wrapping FastAPI or via mount
socket_app = socketio.ASGIApp(sio, other_asgi_app=app, socketio_path="socket.io")


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
@app.get("/api/health")
async def health() -> JSONResponse:
    return JSONResponse({
        "status": "ok",
        "service": "listen2gether",
        "activeRooms": len(room_state),
        "timestamp": int(time.time()),
    })


@app.get("/api/rooms/{room_id}")
async def check_room(room_id: str) -> JSONResponse:
    rid = room_id.strip().upper()
    exists = rid in room_state
    return JSONResponse({"exists": exists, "roomId": rid})


@app.post("/api/rooms")
async def create_room_api(data: dict) -> JSONResponse:
    room_id = data.get("roomId", "").strip().upper()
    if not room_id:
        room_id = os.urandom(3).hex().upper()
    if room_id not in room_state:
        room_state[room_id] = _new_room(room_id)
        log.info("Room created via API: %s", room_id)
    return JSONResponse({"roomId": room_id, "created": True})


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
        # Pre-extract top search result in background so playback starts instantly on click
        if results and results[0].get("videoId"):
            asyncio.create_task(safe_pre_extract(results[0]["videoId"]))
        return JSONResponse(results)

    except Exception as exc:
        log.exception("Search failed for query %r: %s", q, exc)
        raise HTTPException(status_code=500, detail=str(exc))


def _extract_url_sync(video_id: str) -> tuple[str, dict[str, str]]:
    """Synchronously extract playable stream URL using yt-dlp with multi-tier fallback."""
    # Strategy 1: Dedicated android/tv client without browser cookies.
    # Note: Web cookies force yt-dlp to use YouTube's WEB player client, which signs URLs with
    # SABR/pot tokens that return HTTP 403 Forbidden on direct proxying. Android/TV clients bypass this.
    primary_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "check_formats": False,
        "format": "bestaudio/best",
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "tv"]
            }
        },
    }

    try:
        with yt_dlp.YoutubeDL(primary_opts) as ydl:
            info = ydl.extract_info(
                f"https://www.youtube.com/watch?v={video_id}", download=False
            )
            if info and info.get("url"):
                return info["url"], info.get("http_headers", {})
    except Exception as e:
        log.warning("Primary yt-dlp extraction failed for %s (%s), trying fallback...", video_id, e)

    # Strategy 2: Default yt-dlp extraction with general formats
    fallback_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "check_formats": False,
        "format": "bestaudio/best",
    }
    if COOKIES_PATH:
        fallback_opts["cookiefile"] = COOKIES_PATH

    with yt_dlp.YoutubeDL(fallback_opts) as ydl:
        info = ydl.extract_info(
            f"https://www.youtube.com/watch?v={video_id}", download=False
        )
        if not info or not info.get("url"):
            raise ValueError(f"No playable stream URL found for {video_id}")
        return info["url"], info.get("http_headers", {})


async def get_or_extract_stream_url(video_id: str) -> tuple[str, dict[str, str]]:
    """Return cached stream URL or extract a fresh one, coalescing concurrent requests."""
    cached = stream_url_cache.get(video_id)
    now = time.time()
    if cached and (now - cached["ts"]) < STREAM_CACHE_TTL:
        log.debug("Cache hit for video_id=%s", video_id)
        return cached["url"], cached.get("extra_headers", {})

    # If extraction is already in progress, await the existing task
    if video_id in _in_flight_extractions:
        log.info("Awaiting existing in-flight extraction for video_id=%s", video_id)
        return await _in_flight_extractions[video_id]

    async def _do_extract() -> tuple[str, dict[str, str]]:
        log.info("Starting single-flight extraction for video_id=%s", video_id)
        loop = asyncio.get_event_loop()
        upstream_url, upstream_headers = await loop.run_in_executor(None, _extract_url_sync, video_id)
        stream_url_cache[video_id] = {
            "url": upstream_url,
            "extra_headers": upstream_headers,
            "ts": time.time(),
        }
        return upstream_url, upstream_headers

    task = asyncio.create_task(_do_extract())
    _in_flight_extractions[video_id] = task
    try:
        return await task
    finally:
        _in_flight_extractions.pop(video_id, None)


# Limit background pre-extractions to at most 1 at a time to prevent memory spikes on free tier
_pre_extract_sem = asyncio.Semaphore(1)


async def safe_pre_extract(video_id: str) -> None:
    """Pre-resolve a video stream URL in the background before the user taps play."""
    if not video_id:
        return
    cached = stream_url_cache.get(video_id)
    if cached and (time.time() - cached["ts"]) < STREAM_CACHE_TTL:
        return
    try:
        async with _pre_extract_sem:
            # Re-check cache after acquiring semaphore
            cached = stream_url_cache.get(video_id)
            if cached and (time.time() - cached["ts"]) < STREAM_CACHE_TTL:
                return
            log.info("Background pre-extracting stream URL for %s", video_id)
            await get_or_extract_stream_url(video_id)
            log.info("Background pre-extraction ready for %s", video_id)
    except Exception as e:
        log.debug("Pre-extraction skipped for %s: %s", video_id, e)


@app.get("/api/stream/{video_id}")
async def stream_audio(video_id: str, request: Request) -> StreamingResponse:
    """
    Proxy yt-dlp extracted audio URL to the client with HTTP 206 range support.
    Caches the upstream URL for 30 minutes to avoid repeated yt-dlp calls.
    """
    try:
        upstream_url, upstream_headers = await get_or_extract_stream_url(video_id)
    except Exception as exc:
        log.exception("yt-dlp extraction failed for video_id=%s: %s", video_id, exc)
        raise HTTPException(status_code=502, detail=f"yt-dlp error: {exc}")

    # --- Forward range request to upstream ---
    incoming_range = request.headers.get("range")

    req_headers: dict[str, str] = {
        "User-Agent": (
            upstream_headers.get("User-Agent")
            or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
        ),
    }
    if incoming_range:
        req_headers["Range"] = incoming_range

    # Propagate any additional headers yt-dlp provided (e.g. Origin, Referer)
    for key in ("Referer", "Origin"):
        if key in upstream_headers:
            req_headers[key] = upstream_headers[key]

    client = httpx.AsyncClient(follow_redirects=True, timeout=60.0)
    try:
        upstream_req = client.build_request("GET", upstream_url, headers=req_headers)
        upstream_resp = await client.send(upstream_req, stream=True)

        status_code = upstream_resp.status_code

        # If Google Video returned 403 Forbidden or 410 Gone, the cached stream URL is invalid/expired.
        # Evict cache, extract fresh stream URL, and retry immediately once!
        if status_code in (403, 410):
            log.warning("Upstream returned %d for %s. Evicting cache and re-extracting fresh URL...", status_code, video_id)
            await upstream_resp.aclose()
            stream_url_cache.pop(video_id, None)

            upstream_url, upstream_headers = await get_or_extract_stream_url(video_id)
            req_headers["User-Agent"] = (
                upstream_headers.get("User-Agent")
                or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
            )
            for key in ("Referer", "Origin"):
                if key in upstream_headers:
                    req_headers[key] = upstream_headers[key]

            upstream_req = client.build_request("GET", upstream_url, headers=req_headers)
            upstream_resp = await client.send(upstream_req, stream=True)
            status_code = upstream_resp.status_code
            log.info("Retry for %s returned status %d", video_id, status_code)

        if status_code in (403, 410):
            # Still failed after re-extraction; evict so next attempt starts clean
            stream_url_cache.pop(video_id, None)
            await upstream_resp.aclose()
            await client.aclose()
            raise HTTPException(status_code=502, detail=f"YouTube upstream stream returned {status_code}")

        raw_content_type = upstream_resp.headers.get("Content-Type", "audio/mp4")
        # Ensure browsers/iOS treat the stream as pure audio even if format 18 (mp4) container is returned
        content_type = "audio/mp4" if raw_content_type.startswith("video/") else raw_content_type

        response_headers: dict[str, str] = {
            "Accept-Ranges": "bytes",
            "Content-Type": content_type,
        }

        if "Content-Range" in upstream_resp.headers:
            response_headers["Content-Range"] = upstream_resp.headers["Content-Range"]
        if "Content-Length" in upstream_resp.headers:
            response_headers["Content-Length"] = upstream_resp.headers["Content-Length"]

        async def _stream_body():
            try:
                async for chunk in upstream_resp.aiter_bytes(chunk_size=CHUNK_SIZE):
                    yield chunk
            except (asyncio.CancelledError, GeneratorExit):
                pass
            except Exception as e:
                log.debug("Stream aborted by client for %s: %s", video_id, e)
            finally:
                await upstream_resp.aclose()
                await client.aclose()

        return StreamingResponse(
            _stream_body(),
            status_code=status_code,
            headers=response_headers,
        )

    except Exception as exc:
        await client.aclose()
        log.exception("Upstream request error for video_id=%s: %s", video_id, exc)
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
    data: { roomId: str, displayName: str, create?: bool }
    """
    room_id: str = data.get("roomId", "").strip().upper()
    display_name: str = data.get("displayName", "Guest").strip() or "Guest"
    is_create: bool = bool(data.get("create", False))

    if not room_id:
        await sio.emit("error", {"message": "roomId is required"}, to=sid)
        return

    # Check if room exists or auto-initialize
    if room_id not in room_state:
        room_state[room_id] = _new_room(room_id)
        log.info("Room auto-initialized: %s", room_id)

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
    data: { roomId: str, action?: str, isPlaying?: bool, anchorTime?: float, anchorTimestamp?: int }
    """
    room_id: str = data.get("roomId", "").strip().upper()
    state = room_state.get(room_id)
    if state is None:
        return

    if "action" in data:
        action = data.get("action")
        if action == "play":
            state["isPlaying"] = True
            state["anchorTimestamp"] = int(time.time() * 1000)
        elif action == "pause":
            # calculate elapsed
            if state["isPlaying"]:
                if state.get("_started"):
                    elapsed = (time.time() * 1000 - state["anchorTimestamp"]) / 1000.0
                    state["anchorTime"] += elapsed
                else:
                    state["anchorTime"] = 0.0
            state["isPlaying"] = False
            state["anchorTimestamp"] = int(time.time() * 1000)
        else:
            state["isPlaying"] = not state["isPlaying"]
            state["anchorTimestamp"] = int(time.time() * 1000)
    else:
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
    data: { roomId: str, time?: float, anchorTime?: float, anchorTimestamp?: int, isPlaying?: bool }
    """
    room_id: str = data.get("roomId", "").strip().upper()
    state = room_state.get(room_id)
    if state is None:
        return

    target_time = data.get("time")
    if target_time is None:
        target_time = data.get("anchorTime", state["anchorTime"])

    state["anchorTime"] = max(0.0, float(target_time))
    state["anchorTimestamp"] = int(time.time() * 1000)
    state["_started"] = True
    if "isPlaying" in data:
        state["isPlaying"] = bool(data["isPlaying"])
    _touch(room_id)

    log.info("room=%s seek anchorTime=%.2f", room_id, state["anchorTime"])
    await sio.emit("room_state", _public_state(room_id), room=room_id)


@sio.on("play_now")
async def on_play_now(sid: str, data: dict) -> None:
    """
    data: { roomId: str, track: { videoId, title, artist, duration, thumbnail }, queueIndex?: int }
    """
    room_id: str = data.get("roomId", "").strip().upper()
    state = room_state.get(room_id)
    if state is None:
        return

    track: dict[str, Any] | None = data.get("track")
    if not track or not track.get("videoId"):
        await sio.emit("error", {"message": "Invalid track"}, to=sid)
        return

    # If this track is in the queue, remove it by index or videoId
    queue_index = data.get("queueIndex")
    if queue_index is not None and isinstance(queue_index, int) and 0 <= queue_index < len(state["queue"]):
        state["queue"].pop(queue_index)
    else:
        vid = track.get("videoId")
        state["queue"] = [q for q in state["queue"] if q.get("videoId") != vid]

    # Push old track to history
    if state.get("currentTrack"):
        if "history" not in state:
            state["history"] = []
        state["history"].append(state["currentTrack"])
        if len(state["history"]) > 50:
            state["history"].pop(0)

    state["currentTrack"] = track
    state["isPlaying"] = True
    state["anchorTime"] = 0.0
    state["anchorTimestamp"] = int(time.time() * 1000)
    state["_started"] = False
    _touch(room_id)
    log.info("room=%s play_now track %s (remaining queue: %d)", room_id, track.get("videoId"), len(state["queue"]))
    await sio.emit("room_state", _public_state(room_id), room=room_id)

    # Pre-extract next track in queue if available
    if state["queue"] and state["queue"][0].get("videoId"):
        asyncio.create_task(safe_pre_extract(state["queue"][0]["videoId"]))


@sio.on("track_started")
async def on_track_started(sid: str, data: dict) -> None:
    """
    Fired when audio actually begins playing sound in a client's player,
    preventing stream extraction/buffering latency from skipping the song intro.
    """
    room_id: str = data.get("roomId", "").strip().upper()
    state = room_state.get(room_id)
    if state is None:
        return

    vid = data.get("videoId")
    current_vid = state.get("currentTrack", {}).get("videoId")
    if vid and current_vid != vid:
        return

    current_time = float(data.get("currentTime", 0.0))
    # Re-anchor once when playback actually begins on client
    if not state.get("_started") and current_time < 5.0:
        state["_started"] = True
        state["anchorTime"] = current_time
        state["anchorTimestamp"] = int(time.time() * 1000)
        _touch(room_id)
        log.info("room=%s track_started anchored to %.2f at %d", room_id, current_time, state["anchorTimestamp"])
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
        state["_started"] = False
        log.info("room=%s auto-playing track %s", room_id, track.get("videoId"))
    else:
        state["queue"].append(track)
        log.info(
            "room=%s queued track %s (queue len=%d)",
            room_id, track.get("videoId"), len(state["queue"]),
        )
        # Pre-extract next track up in queue if it's the only one waiting
        if len(state["queue"]) == 1:
            asyncio.create_task(safe_pre_extract(track["videoId"]))

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


@sio.on("previous_track")
async def on_previous_track(sid: str, data: dict) -> None:
    """
    data: { roomId: str }
    If track played > 4s, restart it. Otherwise, pop previous track from history.
    """
    room_id: str = data.get("roomId", "").strip().upper()
    state = room_state.get(room_id)
    if not state:
        return

    elapsed = 0.0
    if state["isPlaying"]:
        elapsed = (time.time() * 1000 - state["anchorTimestamp"]) / 1000.0
    current_pos = state["anchorTime"] + elapsed

    if current_pos > 4.0:
        state["anchorTime"] = 0.0
        state["anchorTimestamp"] = int(time.time() * 1000)
    elif state.get("history"):
        prev_track = state["history"].pop()
        if state["currentTrack"]:
            state["queue"].insert(0, state["currentTrack"])
        state["currentTrack"] = prev_track
        state["isPlaying"] = True
        state["anchorTime"] = 0.0
        state["anchorTimestamp"] = int(time.time() * 1000)
    else:
        state["anchorTime"] = 0.0
        state["anchorTimestamp"] = int(time.time() * 1000)

    _touch(room_id)
    log.info("room=%s previous_track", room_id)
    await sio.emit("room_state", _public_state(room_id), room=room_id)


@sio.on("remove_from_queue")
async def on_remove_from_queue(sid: str, data: dict) -> None:
    """
    data: { roomId: str, index: int }
    """
    room_id: str = data.get("roomId", "").strip().upper()
    index = data.get("index")
    state = room_state.get(room_id)
    if state and isinstance(index, int) and 0 <= index < len(state["queue"]):
        removed = state["queue"].pop(index)
        _touch(room_id)
        log.info("room=%s removed track %s from queue at index %d", room_id, removed.get("videoId"), index)
        await sio.emit("room_state", _public_state(room_id), room=room_id)


@sio.on("move_queue_item")
async def on_move_queue_item(sid: str, data: dict) -> None:
    """
    data: { roomId: str, fromIndex: int, toIndex: int }
    """
    room_id: str = data.get("roomId", "").strip().upper()
    from_idx = data.get("fromIndex")
    to_idx = data.get("toIndex")
    state = room_state.get(room_id)
    if state and isinstance(from_idx, int) and isinstance(to_idx, int):
        queue = state["queue"]
        if 0 <= from_idx < len(queue) and 0 <= to_idx < len(queue):
            item = queue.pop(from_idx)
            queue.insert(to_idx, item)
            _touch(room_id)
            log.info("room=%s reordered queue: %d -> %d", room_id, from_idx, to_idx)
            await sio.emit("room_state", _public_state(room_id), room=room_id)


@sio.on("track_ended")
async def on_track_ended(sid: str, data: dict) -> None:
    """
    Idempotent: only advance if the reported videoId matches currentTrack.
    Guards against premature track_ended events from browser buffer errors.
    """
    room_id: str = data.get("roomId", "").strip().upper()
    state = room_state.get(room_id)
    if state is None:
        return

    reported_id: str = data.get("videoId", "")
    current = state.get("currentTrack")

    if current is None:
        return

    if reported_id and current.get("videoId") != reported_id:
        log.info(
            "room=%s track_ended ignored: reported=%s current=%s",
            room_id, reported_id, current.get("videoId"),
        )
        return

    # Guard: ignore premature track_ended if track has played for less than 8s
    elapsed = (time.time() * 1000 - state.get("anchorTimestamp", 0)) / 1000.0
    duration = current.get("duration") or 60.0
    if elapsed < 8.0 and elapsed < (duration * 0.7):
        log.warning(
            "room=%s premature track_ended ignored: elapsed=%.1fs, duration=%s",
            room_id, elapsed, duration,
        )
        return

    log.info("room=%s track_ended for videoId=%s, advancing", room_id, reported_id)
    await advance_track(room_id)
