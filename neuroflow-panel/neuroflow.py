"""Sampling core for the Neuroflow control panel.

Contents
--------
Config          panel settings (threshold, rate, refractory, source)
SpikeDetector   upward threshold crossing + hysteresis + refractory period
SimulatorSource physiologically-plausible synthetic EEG stream (demo mode)
DeviceSource    HTTP adapter for a Neuroflow stream endpoint
Recorder        thread-safe recording state, spike log, CSV persistence
Sampler         background thread pulling samples and detecting spikes

Voltages are in microvolts (uV), sample indices are global and 0-based.
"""

from __future__ import annotations

import csv
import json
import math
import os
import random
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass, asdict
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

@dataclass
class Config:
    threshold_uv: float = 50.0     # spike trigger level
    rate_hz: int = 128             # samples per second requested from source
    refractory: int = 4            # min samples between two spikes
    source: str = "sim"            # "sim" | "device"
    device_url: str = "http://127.0.0.1:8080/sample"
    activity: float = 0.45         # simulator firing density 0..1
    noise_uv: float = 5.5          # simulator baseline noise sigma

    def public(self) -> dict:
        return asdict(self)


CONFIG_BOUNDS = {
    "threshold_uv": (1.0, 5000.0),
    "rate_hz": (1, 2000),
    "refractory": (0, 500),
    "activity": (0.0, 1.0),
    "noise_uv": (0.0, 200.0),
}


# --------------------------------------------------------------------------- #
# Spike detection
# --------------------------------------------------------------------------- #

class SpikeDetector:
    """Records a spike when the signal crosses the threshold going upward.

    Only the upward crossing triggers, and a refractory window stops one
    intracellular spike from being counted several times while its waveform
    wobbles around the threshold.
    """

    def __init__(self, threshold_uv: float = 50.0, refractory: int = 4):
        self.threshold_uv = threshold_uv
        self.refractory = refractory
        self.prev = 0.0
        self.last_index = -(10 ** 9)

    def reset(self) -> None:
        self.prev = 0.0
        self.last_index = -(10 ** 9)

    def check(self, value: float, index: int) -> bool:
        th = self.threshold_uv
        crossed = value >= th and self.prev < th
        if crossed and (index - self.last_index) >= max(1, self.refractory):
            self.prev = value
            self.last_index = index
            return True
        self.prev = value
        return False


# --------------------------------------------------------------------------- #
# Sources
# --------------------------------------------------------------------------- #

class SimulatorSource:
    """Synthetic single-channel signal: drift + alpha/beta rhythm + spikes."""

    kind = "sim"

    # depolarisation shape, scaled to the spike peak (uV)
    TEMPLATE = (8.0, 42.0, 78.0, 48.0, 22.0, 9.0, 3.0, 0.0)
    TAIL = 8

    def __init__(self, seed: int | None = None):
        self.rng = random.Random(seed)
        self.t = 0.0
        self.phases = [self.rng.uniform(0, 2 * math.pi) for _ in range(3)]
        self.tail = [0.0] * self.TAIL
        self.firings = 0
        self.connected = True
        self.status = "simulator"

    def reset(self) -> None:
        self.t = 0.0
        self.tail = [0.0] * self.TAIL
        self.phases = [self.rng.uniform(0, 2 * math.pi) for _ in range(3)]

    def set_url(self, url: str) -> None:  # parity with DeviceSource
        pass

    def _fire(self, peak: float) -> None:
        scale = peak / self.TEMPLATE[2]
        for k, amp in enumerate(self.TEMPLATE):
            self.tail[k] += amp * scale

    def read(self, count: int, dt: float, activity: float, noise_uv: float) -> list[float]:
        out = []
        rng = self.rng
        spike_hz = 0.4 + 22.0 * (activity ** 1.7)
        p_fire = min(0.5, spike_hz * dt)
        p_burst = p_fire * 0.18

        for _ in range(count):
            self.t += dt
            t = self.t
            v = (
                9.0 * math.sin(2 * math.pi * 0.11 * t + self.phases[0])          # drift
                + 13.0 * math.sin(2 * math.pi * 9.8 * t + self.phases[1])        # alpha
                + 4.5 * math.sin(2 * math.pi * 21.5 * t + self.phases[2])        # beta
                + rng.gauss(0.0, max(0.05, noise_uv))
                - 14.0                                                          # resting offset
            )

            if rng.random() < p_fire:
                peak = min(320.0, max(52.0, rng.gauss(125.0, 34.0)))
                self._fire(peak)
                self.firings += 1
                if rng.random() < p_burst:
                    self._fire(peak * rng.uniform(0.55, 0.9))

            v += self.tail[0]
            self.tail.pop(0)
            self.tail.append(0.0)
            out.append(v)
        return out


class DeviceSource:
    """Polls an HTTP endpoint for Neuroflow samples.

    Accepted response shapes (JSON):
      * [12.4, 88.1, ...]                      -> list of voltages
      * {"samples": [..]} | {"data": [..]}     -> list of voltages
      * {"voltage": 12.4}                      -> single sample
        also accepted keys: value, uv, microvolts, ch1, channel_1
      * {"channels": {"ch1": 12.4, ...}}       -> first numeric channel
    """

    kind = "device"

    def __init__(self, url: str):
        self.url = url
        self.buffer: deque[float] = deque(maxlen=50_000)
        self.connected = False
        self.status = "waiting for device"
        self.last_error: str | None = None
        self.last_poll = 0.0

    def reset(self) -> None:
        self.buffer.clear()
        self.connected = False
        self.status = "waiting for device"

    def set_url(self, url: str) -> None:
        if url != self.url:
            self.url = url
            self.reset()
            self.last_error = None

    # -- parsing ----------------------------------------------------------- #
    @staticmethod
    def _coerce(value) -> float | None:
        try:
            v = float(value)
        except (TypeError, ValueError):
            return None
        return v if math.isfinite(v) else None

    def _parse(self, data) -> list[float]:
        vals: list[float] = []

        if isinstance(data, list):
            for item in data:
                v = self._coerce(item)
                if v is not None:
                    vals.append(v)
            return vals
        if not isinstance(data, dict):
            return vals

        for key in ("samples", "data", "values", "voltages"):
            seq = data.get(key)
            if isinstance(seq, list):
                for item in seq:
                    if isinstance(item, dict):
                        for k in ("voltage", "value", "uv"):
                            if k in item:
                                v = self._coerce(item[k])
                                if v is not None:
                                    vals.append(v)
                                break
                    else:
                        v = self._coerce(item)
                        if v is not None:
                            vals.append(v)
                if vals:
                    return vals

        for key in ("voltage", "value", "uv", "microvolts", "ch1", "channel_1"):
            if key in data:
                v = self._coerce(data[key])
                if v is not None:
                    return [v]

        channels = data.get("channels")
        if isinstance(channels, dict):
            for item in channels.values():
                v = self._coerce(item)
                if v is not None:
                    return [v]
        return vals

    def poll(self) -> int:
        request = urllib.request.Request(
            self.url,
            headers={"Accept": "application/json", "User-Agent": "neuroflow-panel/1.0"},
        )
        with urllib.request.urlopen(request, timeout=1.2) as response:
            body = response.read(65536)
        vals = self._parse(json.loads(body.decode("utf-8", "replace")))
        if vals:
            self.buffer.extend(vals)
            if not self.connected:
                self.status = "connected"
            self.connected = True
            self.last_error = None
        return len(vals)

    def _poll_guarded(self) -> None:
        now = time.monotonic()
        if now - self.last_poll < 0.02:
            return
        self.last_poll = now
        try:
            self.poll()
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as exc:
            self.connected = False
            self.last_error = f"{type(exc).__name__}: {exc}"
            self.status = "unreachable"

    def read(self, count: int, dt: float, activity: float, noise_uv: float) -> list[float]:
        # One poll per call; the sampler paces calls to the configured rate.
        self._poll_guarded()
        if not self.buffer:
            return []
        return [self.buffer.popleft() for _ in range(min(count, len(self.buffer)))]


# --------------------------------------------------------------------------- #
# Recorder
# --------------------------------------------------------------------------- #

def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


class Recorder:
    def __init__(self, max_samples: int = 400_000, max_spikes: int = 100_000):
        self.lock = threading.RLock()
        self.samples: deque[float] = deque(maxlen=max_samples)
        self.max_samples = max_samples
        self.n = 0
        self.spikes: deque[dict] = deque(maxlen=max_spikes)
        self.config = Config()
        self.detector = SpikeDetector(self.config.threshold_uv, self.config.refractory)
        self.source: SimulatorSource | DeviceSource = SimulatorSource()
        self.running = False
        self.elapsed = 0.0
        self._resume: float | None = None
        self.session_id: str | None = None
        self.session_dir: str | None = None
        self._csv_file = None
        self._csv = None
        self._closed = False

    # -- lifecycle --------------------------------------------------------- #
    def _open_session(self) -> None:
        if self._csv_file is not None:
            return
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        self.session_id = f"S-{stamp}"
        self.session_dir = os.path.join(DATA_DIR, f"session-{stamp}")
        os.makedirs(self.session_dir, exist_ok=True)
        self._csv_file = open(
            os.path.join(self.session_dir, "spikes.csv"), "w", newline="", buffering=1
        )
        self._csv = csv.writer(self._csv_file)
        self._csv.writerow(["sample_index", "voltage_uv", "elapsed_s"])

    def _close_session(self) -> None:
        if self._csv_file is not None:
            try:
                self._csv_file.flush()
                self._csv_file.close()
            except Exception:
                pass
        self._csv_file = None
        self._csv = None

    def start(self) -> dict:
        with self.lock:
            if self.running:
                return self.snapshot_locked()
            if self._closed:
                raise RuntimeError("recorder is shut down")
            self._open_session()
            self.running = True
            self._resume = time.monotonic()
            return self.snapshot_locked()

    def stop(self) -> dict:
        with self.lock:
            if self.running and self._resume is not None:
                self.elapsed += time.monotonic() - self._resume
            self._resume = None
            self.running = False
            if self._csv_file is not None:
                try:
                    self._csv_file.flush()
                except Exception:
                    pass
            return self.snapshot_locked()

    def reset(self) -> dict:
        with self.lock:
            self.stop()
            self.samples.clear()
            self.n = 0
            self.spikes.clear()
            self.detector.reset()
            self.source.reset()
            self.elapsed = 0.0
            self._close_session()
            self.session_id = None
            self.session_dir = None
            return self.snapshot_locked()

    def shutdown(self) -> None:
        with self.lock:
            self._closed = True
            self.stop()
            self._close_session()

    # -- sampling ---------------------------------------------------------- #
    def append(self, values: list[float]) -> list[dict]:
        if not values:
            return []
        found: list[dict] = []
        with self.lock:
            if not self.running:
                return []
            cfg = self.config
            det = self.detector
            det.threshold_uv = cfg.threshold_uv
            det.refractory = cfg.refractory
            elapsed = self.elapsed_s_locked()
            for value in values:
                index = self.n
                self.samples.append(float(value))
                self.n += 1
                if det.check(value, index):
                    event = {
                        "i": index,
                        "v": round(float(value), 2),
                        "t": round(elapsed, 3),
                    }
                    self.spikes.append(event)
                    found.append(event)
                    if self._csv is not None:
                        self._csv.writerow([index, f"{value:.3f}", f"{elapsed:.3f}"])
            return found

    # -- config ------------------------------------------------------------ #
    def apply_config(self, patch: dict) -> dict:
        with self.lock:
            cfg = self.config
            try:
                if "threshold_uv" in patch:
                    cfg.threshold_uv = _clamp(float(patch["threshold_uv"]), *CONFIG_BOUNDS["threshold_uv"])
                if "rate_hz" in patch:
                    cfg.rate_hz = int(_clamp(int(float(patch["rate_hz"])), *CONFIG_BOUNDS["rate_hz"]))
                if "refractory" in patch:
                    cfg.refractory = int(_clamp(int(float(patch["refractory"])), *CONFIG_BOUNDS["refractory"]))
                if "activity" in patch:
                    cfg.activity = _clamp(float(patch["activity"]), *CONFIG_BOUNDS["activity"])
                if "noise_uv" in patch:
                    cfg.noise_uv = _clamp(float(patch["noise_uv"]), *CONFIG_BOUNDS["noise_uv"])
                if "device_url" in patch:
                    url = str(patch["device_url"]).strip()[:300]
                    if url and not url.startswith(("http://", "https://")):
                        raise ValueError("device_url must start with http:// or https://")
                    cfg.device_url = url or cfg.device_url
                if "source" in patch:
                    source = str(patch["source"])
                    if source not in ("sim", "device"):
                        raise ValueError("source must be 'sim' or 'device'")
                    if source != cfg.source:
                        cfg.source = source
                        if source == "device":
                            self.source = DeviceSource(cfg.device_url)
                        else:
                            self.source = SimulatorSource()
            except (TypeError, ValueError) as exc:
                raise ValueError(str(exc)) from exc

            if isinstance(self.source, DeviceSource):
                self.source.set_url(cfg.device_url)
            return self.snapshot_locked()

    # -- views ------------------------------------------------------------- #
    def elapsed_s_locked(self) -> float:
        elapsed = self.elapsed
        if self.running and self._resume is not None:
            elapsed += time.monotonic() - self._resume
        return elapsed

    def snapshot_locked(self) -> dict:
        with self.lock:
            return {
                "n": self.n,
                "spikes_total": len(self.spikes),
                "running": self.running,
                "elapsed_s": round(self.elapsed_s_locked(), 2),
                "samples_held": len(self.samples),
                "session_id": self.session_id,
                "config": self.config.public(),
                "source_status": self.source.status,
                "source_connected": bool(getattr(self.source, "connected", False)),
                "source_error": getattr(self.source, "last_error", None),
                "max_samples": self.max_samples,
            }

    def snapshot(self) -> dict:
        with self.lock:
            return self.snapshot_locked()

    def history(self) -> dict:
        with self.lock:
            base = self.n - len(self.samples)
            samples = [round(v, 2) for v in self.samples]
            spikes = [dict(s) for s in self.spikes]
            payload = self.snapshot_locked()
        payload.update({"base": base, "samples": samples, "spikes": spikes})
        return payload

    def export_samples(self):
        with self.lock:
            base = self.n - len(self.samples)
            samples = list(self.samples)
            rate = self.config.rate_hz
        def rows():
            yield "sample_index,voltage_uv,elapsed_s\n"
            for k, value in enumerate(samples):
                yield f"{base + k},{value:.3f},{k / rate:.4f}\n"
        return rows()

    def export_spikes(self):
        with self.lock:
            spikes = [dict(s) for s in self.spikes]
        def rows():
            yield "sample_index,voltage_uv,elapsed_s\n"
            for spike in spikes:
                yield f"{spike['i']},{spike['v']:.3f},{spike['t']:.4f}\n"
        return rows()


# --------------------------------------------------------------------------- #
# Sampler thread
# --------------------------------------------------------------------------- #

class Sampler(threading.Thread):
    def __init__(self, recorder: Recorder, emit):
        super().__init__(name="neuroflow-sampler", daemon=True)
        self.rec = recorder
        self.emit = emit
        self._stop = threading.Event()
        self.chunk_seconds = 0.06

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        deadline = time.monotonic()
        while not self._stop.is_set():
            rec = self.rec
            if not rec.running:
                time.sleep(0.04)
                deadline = time.monotonic()
                continue

            cfg = rec.config
            count = max(1, min(4096, int(round(cfg.rate_hz * self.chunk_seconds))))
            start_n = rec.n
            try:
                values = rec.source.read(count, 1.0 / cfg.rate_hz, cfg.activity, cfg.noise_uv)
            except Exception:  # a source must never kill the sampler
                time.sleep(0.05)
                continue

            if values:
                spikes = rec.append(values)
                payload = {
                    "type": "chunk",
                    "start": start_n,
                    "samples": [round(v, 2) for v in values],
                    "spikes": spikes,
                    "n": rec.n,
                    "spikes_total": len(rec.spikes),
                    "elapsed_s": round(rec.elapsed_s_locked(), 2),
                }
                try:
                    self.emit(payload)
                except Exception:
                    pass

            # Pace every source so the panel records at the configured rate.
            deadline += self.chunk_seconds
            sleep_for = deadline - time.monotonic()
            if sleep_for > 0:
                time.sleep(sleep_for)
            elif sleep_for < -1.5:
                deadline = time.monotonic()
