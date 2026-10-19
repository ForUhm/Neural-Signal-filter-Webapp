#!/usr/bin/env bash
# Start the Neuroflow control panel on http://127.0.0.1:8765
set -euo pipefail
cd "$(dirname "$0")"
exec python3 -m uvicorn app:app --host 127.0.0.1 --port "${PORT:-8765}"
