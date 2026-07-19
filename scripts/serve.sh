#!/usr/bin/env bash
# Build the SPA and serve the WHOLE app (API + frontend) from one server bound to
# the LAN, so you can open it on your phone. Same Wi-Fi required.
#
#   ./scripts/serve.sh            # FSRS engine (self-contained)
#   DOPAMINE_SRS_ENGINE=anki DOPAMINE_ANKI_COLLECTION=/path/collection.anki2 ./scripts/serve.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8000}"

echo "==> Building frontend..."
( cd "$ROOT/frontend" && npm install --silent && npm run build )

# Best-effort LAN IP (macOS/Linux).
IP="$( (ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}') || true )"
echo
echo "==> Serving DopaMine (API + app) on all interfaces, port $PORT"
echo "    On THIS computer:  http://localhost:$PORT"
[ -n "${IP:-}" ] && echo "    On your PHONE:     http://$IP:$PORT   (same Wi-Fi)"
echo "    (Ctrl-C to stop)"
echo

cd "$ROOT/backend"
exec "$ROOT/.venv/bin/python" -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
