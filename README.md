# 🎵 SyncWave

**Real-time synchronized music listening for groups.** Share a room code, everyone hears the same track at the same moment — including on iOS Safari in the background.

---

## Features

- 🎧 **True sync** — sub-second clock alignment across all listeners using an anchor-time model
- 📱 **iOS background audio** — native `<audio>` element + `navigator.audioSession` keeps music playing when the screen locks
- 🔍 **YouTube search** — search and stream any track without leaving the app (no iframes, no ads)
- 🗂 **Shared queue** — anyone in the room can add or skip tracks
- 🔗 **Instant rooms** — create a 6-character room slug or join by URL/code
- 👥 **Live listener count** — see who's in the room in real time
- 📤 **Share sheet** — native `navigator.share` or copy-link fallback
- 🐳 **Docker-ready backend** — single `docker build` for Render deployment

---

## Project Structure

```
SyncWave/
├── README.md
├── backend/
│   ├── Dockerfile
│   ├── main.py              # FastAPI + python-socketio app
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    ├── app/
    │   ├── layout.tsx       # Root layout (no manifest, no standalone PWA)
    │   ├── page.tsx         # Home: create / join room
    │   ├── globals.css
    │   └── room/
    │       └── [roomId]/
    │           └── page.tsx # Full room view: audio, queue, sync logic
    ├── lib/                 # Shared utilities
    ├── next.config.ts
    ├── tailwind.config.ts
    ├── postcss.config.js
    ├── tsconfig.json
    ├── package.json
    └── .env.example
```

---

## Local Development

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 18+ |
| Python | 3.11+ |
| pip | latest |
| yt-dlp | latest (`pip install yt-dlp`) |

### Backend

```bash
cd backend
cp .env.example .env
# Edit .env — set FRONTEND_URL=http://localhost:3000
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

The API will be available at `http://localhost:8000`. Verify with:

```bash
curl http://localhost:8000/health
# {"status":"ok"}
```

### Frontend

```bash
cd frontend
cp .env.example .env.local
# Edit .env.local — set NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
npm install
npm run dev
```

Open `http://localhost:3000` in your browser.

---

## Production Deployment

### Backend → Render (Docker Web Service)

1. Push the repo to GitHub.
2. In the [Render dashboard](https://dashboard.render.com), click **New → Web Service**.
3. Connect your repo; set **Root Directory** to `backend`.
4. Render auto-detects the `Dockerfile` — no build command needed.
5. Set environment variables:

   | Key | Value |
   |-----|-------|
   | `FRONTEND_URL` | Comma-separated allowed origins, e.g. `https://syncwave.vercel.app,https://www.syncwave.vercel.app` |
   | `PORT` | `8000` |
   | `YTDLP_COOKIES_B64` | *(optional)* Base64-encoded Netscape cookies file for age-restricted videos |

6. Deploy. Note the service URL (e.g. `https://syncwave-api.onrender.com`).

> [!NOTE]
> Free-tier Render services spin down after ~15 minutes of inactivity. The first request after a cold start may take 30–60 seconds. Upgrade to a paid instance or use a cron ping service to keep it warm.

### Frontend → Vercel

1. In the [Vercel dashboard](https://vercel.com/new), import your GitHub repo.
2. Set **Root Directory** to `frontend`.
3. Set environment variables:

   | Key | Value |
   |-----|-------|
   | `NEXT_PUBLIC_BACKEND_URL` | Your Render service URL, e.g. `https://syncwave-api.onrender.com` |
   | `NEXT_PUBLIC_APP_URL` | Your Vercel URL, e.g. `https://syncwave.vercel.app` |

4. Deploy. Vercel handles build (`npm run build`) and serving automatically.

---

## iOS Background Audio

Keeping audio alive on iOS Safari when the screen locks requires a specific architecture. SyncWave implements all necessary pieces:

### 1 — Native `<audio>` element, never an iframe

YouTube iframes are killed by iOS when the page loses focus. SyncWave proxies audio through the backend and feeds it directly into a native `<audio>` element, which iOS treats as a first-class media source.

### 2 — HTTP 206 range proxy (`/api/stream/:videoId`)

The backend fetches the direct `googlevideo.com` audio URL via `yt-dlp`, caches it for 30 minutes, and re-serves it with proper `Accept-Ranges: bytes` and `Content-Range` headers. iOS Safari requires range-request support to seek and to maintain buffer locks during background playback.

### 3 — `navigator.audioSession.type = "playback"`

Set before the first `audio.play()` call. This signals to iOS that the app intends long-form audio playback, granting the same background privileges as Apple Music or Spotify.

### 4 — `navigator.mediaSession` metadata and action handlers

Populates the iOS lock-screen media card (title, artist, artwork) and wires up hardware controls (play/pause, skip). iOS will terminate background audio for any session that doesn't respond to remote-control events.

### 5 — "Tap to Join Audio Session" overlay

iOS requires a user gesture to unlock the audio context. On first load a full-screen overlay intercepts the gesture, calls `audio.play()`, then hides itself. This is the only reliable way to prime the audio session before sync begins.

### 6 — No `visibilitychange` or `pagehide` pause listeners

Many audio players pause on tab switch or screen lock via `document.addEventListener('visibilitychange', ...)`. SyncWave deliberately omits these handlers so the audio context is never interrupted by iOS lifecycle events.

---

## Environment Variables Reference

### `backend/.env.example`

| Variable | Default | Description |
|----------|---------|-------------|
| `FRONTEND_URL` | `http://localhost:3000` | Comma-separated list of allowed CORS origins |
| `PORT` | `8000` | Port the Uvicorn server listens on |
| `YTDLP_COOKIES_B64` | *(empty)* | Base64-encoded Netscape-format cookies; enables age-restricted / sign-in-required videos |

### `frontend/.env.example`

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_BACKEND_URL` | `http://localhost:8000` | Full URL of the FastAPI backend (used for Socket.IO and stream proxy) |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | Public URL of this Next.js app (used for share links) |

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns `{"status":"ok"}` |
| `GET` | `/api/search?q=<query>` | yt-dlp `ytsearch8` — returns list of `{videoId, title, artist, duration, thumbnail}` |
| `GET` | `/api/stream/<videoId>` | HTTP 206 range proxy to `googlevideo.com` audio stream |

### Socket.IO Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `join_room` | client → server | `{roomId, displayName}` |
| `play_pause` | client → server | `{roomId, isPlaying, anchorTime, anchorTimestamp}` |
| `seek` | client → server | `{roomId, anchorTime, anchorTimestamp}` |
| `add_to_queue` | client → server | `{roomId, track}` |
| `skip_track` | client → server | `{roomId}` |
| `track_ended` | client → server | `{roomId}` |
| `leave_room` | client → server | `{roomId}` |
| `room_state` | server → client | Full room state object |
| `disconnect` | built-in | Triggers room cleanup |

---

## License

MIT
