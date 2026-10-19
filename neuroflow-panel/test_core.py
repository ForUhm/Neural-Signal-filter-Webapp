"""Core checks for the Neuroflow sampling engine (no server needed).

Run: python3 test_core.py
"""

import os
import tempfile

import neuroflow as nf


def test_detector():
    det = nf.SpikeDetector(threshold_uv=50, refractory=4)
    values = [0, 60, 20, 0, 70, 0, 0, 0, 0, 0, 90]
    hits = [i for i, v in enumerate(values) if det.check(v, i)]
    # 70 at index 4 is inside the 4-sample refractory window of the spike at 1
    assert hits == [1, 10], hits
    print("detector: upward crossings only, refractory respected ->", hits)

    det = nf.SpikeDetector(threshold_uv=50, refractory=0)
    hits = [i for i, v in enumerate([0, 60, 70, 40, 80]) if det.check(v, i)]
    # 70 is not a new crossing (still above threshold), so only 1 and 4 count
    assert hits == [1, 4], hits
    print("detector: refractory 0, no double-count while above level ->", hits)


def test_simulator_and_recorder():
    rec = nf.Recorder()
    rec.start()
    cfg = rec.config
    cfg.threshold_uv = 50
    cfg.rate_hz = 128
    cfg.activity = 0.5
    source = rec.source
    generated = 0
    for _ in range(20):  # ~10 s at 128 Hz
        values = source.read(64, 1 / 128, cfg.activity, cfg.noise_uv)
        rec.append(values)
        generated += len(values)

    state = rec.snapshot()
    assert state["n"] == generated == 1280, state["n"]
    assert state["spikes_total"] > 5, state["spikes_total"]
    assert rec.session_dir and os.path.isdir(rec.session_dir)
    with open(os.path.join(rec.session_dir, "spikes.csv")) as fh:
        lines = fh.read().strip().splitlines()
    assert len(lines) == state["spikes_total"] + 1, (len(lines), state["spikes_total"])
    print(f"simulator: {state['n']} samples, {state['spikes_total']} spikes, CSV rows match")

    peak = max(rec.samples)
    assert peak > cfg.threshold_uv, peak
    print(f"peak voltage {peak:.1f} uV, mean {sum(rec.samples) / len(rec.samples):.1f} uV")

    sample_rows = sum(1 for _ in rec.export_samples()) - 1
    spike_rows = sum(1 for _ in rec.export_spikes()) - 1
    assert sample_rows == state["n"] and spike_rows == state["spikes_total"]
    print("export: samples.csv and spikes.csv row counts match the buffer")

    stopped = rec.stop()
    assert stopped["running"] is False
    reset = rec.reset()
    assert reset["n"] == 0 and reset["spikes_total"] == 0
    print("stop/reset: state cleared")
    rec.shutdown()


def test_config_guards():
    rec = nf.Recorder()
    rec.apply_config({"threshold_uv": 1e9, "rate_hz": 0, "refractory": -5, "activity": 5})
    assert rec.config.threshold_uv == 5000.0
    assert rec.config.rate_hz == 1
    assert rec.config.refractory == 0
    assert rec.config.activity == 1.0
    try:
        rec.apply_config({"source": "bluetooth"})
    except ValueError:
        pass
    else:
        raise AssertionError("invalid source accepted")
    try:
        rec.apply_config({"device_url": "ftp://brain"})
    except ValueError:
        pass
    else:
        raise AssertionError("invalid device url accepted")
    print("config: values clamped, invalid source/url rejected")


if __name__ == "__main__":
    test_detector()
    test_simulator_and_recorder()
    test_config_guards()
    print("\nall core checks passed")
