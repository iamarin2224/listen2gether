#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

echo "=== Listen2Gether (L2G) Environment Setup ==="

# Backend setup
echo "[1/2] Setting up Backend..."
cd "$BACKEND_DIR"
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp .env.example .env
fi

if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

# Frontend setup
echo "[2/2] Setting up Frontend..."
cd "$FRONTEND_DIR"
if [ ! -f ".env.local" ] && [ -f ".env.example" ]; then
    cp .env.example .env.local
fi
npm install

echo "=== Setup complete! Run ./start.sh or npm run dev to launch ==="
