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

if [ -f "$BACKEND_DIR/venv/bin/python" ]; then
    PYTHON_BIN="$BACKEND_DIR/venv/bin/python"
elif [ -f "$BACKEND_DIR/.venv/bin/python" ]; then
    PYTHON_BIN="$BACKEND_DIR/.venv/bin/python"
fi

echo "=========================================================="
echo " Starting Listen2Gether (L2G) (Backend + Frontend + Unified Gateway)"
echo "   Gateway (Main URL / Tunnel): http://localhost:3000"
echo "   Next.js Internal:            http://localhost:3001"
echo "   FastAPI Backend Internal:    http://localhost:8000"
echo "   Single ngrok command:        ngrok http 3000"
echo " Press Ctrl+C to stop all processes cleanly"
echo "=========================================================="

cleanup() {
    echo ""
    echo "Stopping Listen2Gether (L2G) servers..."
    kill "$GATEWAY_PID" "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
    wait "$GATEWAY_PID" "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
    echo "All processes stopped."
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# Ensure fresh Next.js dev cache
rm -rf "$FRONTEND_DIR/.next" 2>/dev/null || true

# Start backend on port 8000 using virtualenv python directly
(cd "$BACKEND_DIR" && "$PYTHON_BIN" -m uvicorn main:socket_app --reload --host 0.0.0.0 --port 8000) &
BACKEND_PID=$!

# Start Next.js on port 3001
(cd "$FRONTEND_DIR" && npx next dev -p 3001) &
FRONTEND_PID=$!

# Start Unified Gateway on port 3000 (routes frontend + backend + WebSockets)
node "$ROOT_DIR/gateway.js" &
GATEWAY_PID=$!

# Wait for all processes
wait
