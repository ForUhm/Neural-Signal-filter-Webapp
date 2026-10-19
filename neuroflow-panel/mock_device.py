"""Minimal Neuroflow-compatible sample server, for testing the device adapter.

    python3 mock_device.py --port 8087 --rate 128

Endpoints
---------
GET /sample   -> {"channel": "ch1", "rate_hz": 128, "unit": "uV",
                  "samples": [..], "voltage": <last>}
GET /single   -> {"voltage": <one sample>}
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import neuroflow as nf


class Stream:
    def __init__(self, rate: int, activity: float):
        self.rate = rate
        self.activity = activity
        self.source = nf.SimulatorSource(seed=7)
        self.last = time.monotonic()
        self.lock = threading.Lock()

    def take(self, max_seconds: float = 2.0) -> list[float]:
        with self.lock:
            now = time.monotonic()
            elapsed = min(max_seconds, max(0.0, now - self.last))
            self.last = now
            count = int(round(elapsed * self.rate))
            if count <= 0:
                return []
            return self.source.read(count, 1.0 / self.rate, self.activity, 5.5)


def make_handler(stream: Stream):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path == "/sample":
                values = stream.take()
                self._send({
                    "channel": "ch1",
                    "rate_hz": stream.rate,
                    "unit": "uV",
                    "samples": [round(v, 3) for v in values],
                    "voltage": round(values[-1], 3) if values else None,
                })
            elif path == "/single":
                values = stream.take(max_seconds=0.05)
                self._send({"voltage": round(values[-1], 3) if values else 0.0})
            elif path == "/health":
                self._send({"ok": True, "rate_hz": stream.rate})
            else:
                self.send_error(404)

        def log_message(self, *args) -> None:  # keep the console quiet
            pass

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8087)
    parser.add_argument("--rate", type=int, default=128, help="samples per second")
    parser.add_argument("--activity", type=float, default=0.5)
    args = parser.parse_args()

    stream = Stream(args.rate, args.activity)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(stream))
    print(f"mock Neuroflow source on http://127.0.0.1:{args.port}/sample "
          f"({args.rate} Hz) — Ctrl-C to stop", flush=True)
    try:
        server.serve_forever()

    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
