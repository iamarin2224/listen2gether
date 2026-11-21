#!/usr/bin/env bash

# Resolve project root
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

# Ensure environment files exist
if [ ! -f "$BACKEND_DIR/.env" ] && [ -f "$BACKEND_DIR/.env.example" ]; then
    echo "Creating backend/.env from .env.example..."
    cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
fi

if [ ! -f "$FRONTEND_DIR/.env.local" ] && [ -f "$FRONTEND_DIR/.env.example" ]; then
    echo "Creating frontend/.env.local from .env.example..."
    cp "$FRONTEND_DIR/.env.example" "$FRONTEND_DIR/.env.local"
fi

# Detect Python virtualenv executable
PYTHON_BIN="python3"
UVICORN_BIN="uvicorn"

if [ -f "$BACKEND_DIR/venv/bin/uvicorn" ]; then
    UVICORN_BIN="$BACKEND_DIR/venv/bin/uvicorn"
elif [ -f "$BACKEND_DIR/.venv/bin/uvicorn" ]; then
    UVICORN_BIN="$BACKEND_DIR/.venv/bin/uvicorn"
fi

echo "=========================================================="
echo " Starting SyncWave (Backend + Frontend)"
echo " Backend:  http://localhost:8000"
echo " Frontend: http://localhost:3000"
echo " Press Ctrl+C to stop both processes cleanly"
echo "=========================================================="

cleanup() {
    echo ""
    echo "Stopping SyncWave servers..."
    kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
    wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
    echo "All processes stopped."
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# Start backend
(cd "$BACKEND_DIR" && "$UVICORN_BIN" main:app --reload --host 0.0.0.0 --port 8000) &
BACKEND_PID=$!

# Start frontend
(cd "$FRONTEND_DIR" && npm run dev) &
FRONTEND_PID=$!

# Wait for both processes
wait
