'use strict';

/* Neuroflow spike console — client
   Server owns the recording; this page mirrors it and renders two charts:
   1. voltage vs sample number
   2. spike counts per sample window + cumulative count vs sample number  */

const $ = (id) => document.getElementById(id);
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const S = {
  n: 0,
  base: 0,
  samples: [],
  spikes: [],
  spikesTotal: 0,
  vmin: Infinity,
  vmax: -Infinity,
  running: false,
  elapsed: 0,
  elapsedStamp: performance.now(),
  cfg: {
    threshold_uv: 50,
    rate_hz: 128,
    refractory: 4,
    source: 'sim',
    device_url: 'http://127.0.0.1:8080/sample',
    activity: 0.45,
    noise_uv: 5.5,
  },
  sessionId: null,
  sourceStatus: 'simulator',
  sourceError: null,
  connected: true,
  dirty: true,
  lastDraw: 0,
  geoV: null,
  geoSp: null,
  hover: { v: null, sp: null },
  resyncing: false,
  note: { text: '', kind: 'ok' },
};

/* ------------------------------------------------------------------ utils */

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

function fmtAxis(n) {
  const v = Math.abs(n);
  if (v >= 1e6) return (n / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
  if (v >= 1e4) return (n / 1e3).toFixed(v >= 1e5 ? 0 : 1) + 'k';
  if (v >= 1000) return (n / 1e3).toFixed(2) + 'k';
  return String(Math.round(n));
}

function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function niceStep(raw) {
  if (!isFinite(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = raw / Math.pow(10, exp);
  const mult = base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10;
  return mult * Math.pow(10, exp);
}

async function api(path, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.status + ' ' + res.statusText;
    try {
      const body = await res.json();
      if (body && body.detail) detail = body.detail;
    } catch (_) { /* non-JSON error body */ }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

function setNotice(text, kind = 'ok') {
  S.note = { text, kind };
  const node = $('notice');
  if (!text) { node.hidden = true; return; }
  node.hidden = false;
  node.textContent = text;
  node.classList.toggle('ok', kind === 'ok');
}

/* --------------------------------------------------------------- drawing */

function frame(canvas) {
  const wrap = canvas.parentElement;
  const w = Math.max(40, wrap.clientWidth);
  const h = Math.max(40, wrap.clientHeight);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas._w !== w || canvas._h !== h || canvas._dpr !== dpr) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas._w = w;
    canvas._h = h;
    canvas._dpr = dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function plotBox(w, h, left, right, top, bottom) {
  return { x0: left, x1: w - right, y0: top, y1: h - bottom, pw: w - left - right, ph: h - top - bottom };
}

function gridAndAxes(ctx, box, yTicks, xTicks, opts = {}) {
  const { x0, x1, y0, y1, pw, ph } = box;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.font = `10px ${MONO}`;
  ctx.fillStyle = 'rgba(139,155,177,0.72)';
  ctx.textBaseline = 'middle';

  for (const t of yTicks) {
    const y = Math.round(opts.yOf(t)) + 0.5;
    if (y < y0 - 1 || y > y1 + 1) continue;
    ctx.strokeStyle = 'rgba(148,163,184,0.075)';
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(opts.fmtY ? opts.fmtY(t) : fmtAxis(t), x0 - 9, y);
  }

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  for (const t of xTicks) {
    const x = Math.round(opts.xOf(t)) + 0.5;
    if (x < x0 - 1 || x > x1 + 1) continue;
    ctx.strokeStyle = 'rgba(148,163,184,0.05)';
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
    ctx.fillStyle = 'rgba(139,155,177,0.62)';
    ctx.fillText(fmtAxis(t), x, y1 + 15);
  }

  ctx.strokeStyle = 'rgba(148,163,184,0.12)';
  ctx.beginPath();
  ctx.moveTo(x0, Math.round(y1) + 0.5);
  ctx.lineTo(x1, Math.round(y1) + 0.5);
  ctx.stroke();
  ctx.restore();
}

function emptyState(ctx, box, title, sub) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = box.x0 + box.pw / 2;
  const cy = box.y0 + box.ph / 2;
  ctx.fillStyle = 'rgba(139,155,177,0.55)';
  ctx.font = `500 12.5px ${'system-ui, sans-serif'}`;
  ctx.fillText(title, cx, cy - 9);
  ctx.fillStyle = 'rgba(93,109,130,0.7)';
  ctx.font = `11px system-ui, sans-serif`;
  ctx.fillText(sub, cx, cy + 12);
  ctx.restore();
}

/* ----------------------------------------------------------- voltage chart */

function drawVoltage() {
  const canvas = $('voltChart');
  const { ctx, w, h } = frame(canvas);
  const box = plotBox(w, h, 48, 22, 16, 28);
  const { x0, x1, y0, y1, pw, ph } = box;

  let lo = S.vmin;
  let hi = S.vmax;
  if (!isFinite(lo) || !isFinite(hi)) { lo = -40; hi = 140; }
  if (hi - lo < 2) { hi = lo + 2; }
  const rawSpan = hi - lo;
  lo -= rawSpan * 0.14;
  hi += rawSpan * 0.14;

  const th = S.cfg.threshold_uv;
  let thVisible = th > lo - rawSpan * 0.65 && th < hi + rawSpan * 0.65;
  if (thVisible) {
    lo = Math.min(lo, th - rawSpan * 0.06);
    hi = Math.max(hi, th + rawSpan * 0.08);
  }

  const first = S.base;
  const lastIdx = S.base + Math.max(0, S.samples.length - 1);
  const spanN = Math.max(1, lastIdx - first);
  const X = (i) => x0 + ((i - first) / spanN) * pw;
  const Y = (v) => y1 - ((v - lo) / (hi - lo)) * ph;

  S.geoV = { x0, x1, y0, y1, first, last: lastIdx, X, Y };

  const stepY = niceStep((hi - lo) / 5);
  const yTicks = [];
  for (let t = Math.ceil(lo / stepY) * stepY; t <= hi + 1e-9; t += stepY) yTicks.push(t);

  const stepX = Math.max(1, Math.round(niceStep(spanN / 5)));
  const xTicks = [];
  for (let t = Math.ceil(first / stepX) * stepX; t <= lastIdx; t += stepX) xTicks.push(t);

  gridAndAxes(ctx, box, yTicks, xTicks, {
    xOf: X,
    yOf: Y,
    fmtY: (t) => (Math.abs(t) >= 1000 ? fmtAxis(t) : t.toFixed(Math.abs(stepY) < 1 ? 1 : 0)),
  });

  if (lo < 0 && hi > 0) {
    ctx.strokeStyle = 'rgba(148,163,184,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(Y(0)) + 0.5);
    ctx.lineTo(x1, Math.round(Y(0)) + 0.5);
    ctx.stroke();
  }

  if (!S.samples.length) {
    emptyState(ctx, box, 'No samples yet', 'Press Start sampling to stream voltage');
  } else {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, pw, ph);
    ctx.clip();

    const samples = S.samples;
    const cols = Math.max(1, Math.round(pw));
    // below ~3 samples per pixel a real polyline reads better than an envelope
    const dense = samples.length > cols * 3.2;

    if (dense) {
      const tops = new Float32Array(cols + 1);
      const bots = new Float32Array(cols + 1);
      let prevK = 0;
      for (let c = 0; c <= cols; c++) {
        const upto = Math.min(samples.length - 1, Math.round((c / cols) * (samples.length - 1)));
        let mn = Infinity;
        let mx = -Infinity;
        for (let k = prevK; k <= upto; k++) {
          const v = samples[k];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        if (!isFinite(mn)) { mn = mx = samples[samples.length - 1]; }
        prevK = upto + 1;
        tops[c] = mx;
        bots[c] = mn;
      }

      const band = ctx.createLinearGradient(0, y0, 0, y1);
      band.addColorStop(0, 'rgba(62,230,192,0.22)');
      band.addColorStop(0.55, 'rgba(62,230,192,0.10)');
      band.addColorStop(1, 'rgba(62,230,192,0.03)');
      ctx.beginPath();
      for (let c = 0; c <= cols; c++) {
        const px = x0 + c;
        const py = Y(tops[c]);
        if (c === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      for (let c = cols; c >= 0; c--) ctx.lineTo(x0 + c, Y(bots[c]));
      ctx.closePath();
      ctx.fillStyle = band;
      ctx.fill();

      ctx.strokeStyle = 'rgba(74,238,204,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 0; c <= cols; c++) {
        const px = Math.round(x0 + c) + 0.5;
        ctx.moveTo(px, Y(tops[c]));
        ctx.lineTo(px, Y(bots[c]));
      }
      ctx.stroke();
    } else {
      ctx.beginPath();
      for (let k = 0; k < samples.length; k++) {
        const px = X(first + k);
        const py = Y(samples[k]);
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = '#3ee6c0';
      ctx.lineWidth = 1.5;
      ctx.shadowColor = 'rgba(62,230,192,0.55)';
      ctx.shadowBlur = 7;
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.lineTo(X(first + samples.length - 1), y1);
      ctx.lineTo(X(first), y1);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, y0, 0, y1);
      fill.addColorStop(0, 'rgba(62,230,192,0.16)');
      fill.addColorStop(1, 'rgba(62,230,192,0.01)');
      ctx.fillStyle = fill;
      ctx.fill();
    }

    // detected spikes as amber dots
    const many = S.spikes.length > 420;
    for (const spike of S.spikes) {
      if (spike.i < first || spike.i > lastIdx) continue;
      const px = X(spike.i);
      const py = Y(spike.v);
      ctx.beginPath();
      ctx.arc(px, py, many ? 1.7 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffb454';
      if (!many) {
        ctx.shadowColor = 'rgba(255,180,84,0.8)';
        ctx.shadowBlur = 8;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // hover crosshair
    if (S.hover.v) {
      const hv = S.hover.v;
      ctx.strokeStyle = 'rgba(232,238,246,0.22)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(Math.round(hv.px) + 0.5, y0);
      ctx.lineTo(Math.round(hv.px) + 0.5, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      if (isFinite(hv.value)) {
        ctx.beginPath();
        ctx.arc(hv.px, Y(hv.value), 3.2, 0, Math.PI * 2);
        ctx.fillStyle = '#eafff9';
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // threshold line
  if (thVisible) {
    const ty = Math.round(Y(th)) + 0.5;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,180,84,0.62)';
    ctx.lineWidth = 1.1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(x0, ty);
    ctx.lineTo(x1, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = 'rgba(255,180,84,0.95)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${th.toFixed(0)} µV`, x1 - 2, ty - 4);
    ctx.restore();
  } else {
    ctx.save();
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = 'rgba(255,180,84,0.85)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`▲ threshold ${th.toFixed(0)} µV`, x1 - 2, y0 + 2);
    ctx.restore();
  }
}

/* ------------------------------------------------------------- spike chart */

function drawSpikeChart() {
  const canvas = $('spikeChart');
  const { ctx, w, h } = frame(canvas);
  const box = plotBox(w, h, 44, 46, 16, 28);
  const { x0, x1, y0, y1, pw, ph } = box;

  const first = S.base;
  const lastIdx = S.base + Math.max(0, S.samples.length - 1);
  const spanN = Math.max(1, lastIdx - first);
  const bins = Math.max(10, Math.min(84, Math.floor(pw / 10)));

  const counts = new Array(bins).fill(0);
  let total = 0;
  const binOf = (i) => Math.min(bins - 1, Math.max(0, Math.floor(((i - first) / spanN) * bins)));
  for (const spike of S.spikes) {
    if (spike.i < first || spike.i > lastIdx) continue;
    counts[binOf(spike.i)] += 1;
    total += 1;
  }
  const cums = [];
  let running = 0;
  for (let b = 0; b < bins; b++) { running += counts[b]; cums.push(running); }

  const maxCount = Math.max(1, ...counts);
  const countStep = maxCount <= 4 ? 1 : niceStep(maxCount / 3);
  const countTop = Math.max(countStep, Math.ceil(maxCount / countStep) * countStep);

  const Yc = (v) => y1 - (v / countTop) * ph;
  const Yr = (v) => y1 - (total > 0 ? v / total : 0) * ph;
  const binX = (b) => x0 + (b / bins) * pw;
  const X = (i) => x0 + ((i - first) / spanN) * pw;

  S.geoSp = { x0, x1, y0, y1, first, last: lastIdx, bins, counts, cums, total, pw, X, binX };

  const yTicks = [];
  for (let t = 0; t <= countTop + 1e-9; t += countStep) yTicks.push(t);

  const stepX = Math.max(1, Math.round(niceStep(spanN / 5)));
  const xTicks = [];
  for (let t = Math.ceil(first / stepX) * stepX; t <= lastIdx; t += stepX) xTicks.push(t);

  gridAndAxes(ctx, box, yTicks, xTicks, {
    xOf: X,
    yOf: Yc,
    fmtY: (t) => String(Math.round(t)),
  });

  // right axis for cumulative
  ctx.save();
  ctx.font = `10px ${MONO}`;
  ctx.fillStyle = 'rgba(154,140,255,0.7)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) {
    const v = (total * k) / 4;
    const y = Yr(v);
    if (y < y0 - 1 || y > y1 + 1) continue;
    ctx.fillText(fmtAxis(v), x1 + 9, y);
  }
  ctx.restore();

  if (!S.samples.length) {
    emptyState(ctx, box, 'No spikes to plot', 'Counts appear as samples are recorded');
  } else {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, pw, ph);
    ctx.clip();

    const gap = Math.min(3, Math.max(1.5, pw / bins * 0.18));
    const barW = Math.max(1.5, pw / bins - gap);
    const barGrad = ctx.createLinearGradient(0, y0, 0, y1);
    barGrad.addColorStop(0, 'rgba(255,180,84,0.92)');
    barGrad.addColorStop(1, 'rgba(255,180,84,0.22)');

    for (let b = 0; b < bins; b++) {
      const c = counts[b];
      if (!c) continue;
      const x = binX(b) + gap / 2;
      const top = Yc(c);
      const height = Math.max(1.5, y1 - top);
      ctx.fillStyle = barGrad;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, top, barW, height, [2, 2, 0, 0]);
        ctx.fill();
      } else {
        ctx.fillRect(x, top, barW, height);
      }
      if (S.hover.sp && S.hover.sp.bin === b) {
        ctx.fillStyle = 'rgba(255,205,140,0.35)';
        ctx.fillRect(x, top, barW, height);
      }
    }

    // cumulative line
    ctx.beginPath();
    ctx.moveTo(x0, Yr(0));
    for (let b = 0; b < bins; b++) {
      ctx.lineTo(binX(b) + barW / 2 + gap / 2, Yr(cums[b]));
    }
    ctx.strokeStyle = '#9a8cff';
    ctx.lineWidth = 1.6;
    ctx.shadowColor = 'rgba(154,140,255,0.55)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.lineTo(binX(bins - 1) + barW, y1);
    ctx.lineTo(x0, y1);
    ctx.closePath();
    const cumFill = ctx.createLinearGradient(0, y0, 0, y1);
    cumFill.addColorStop(0, 'rgba(154,140,255,0.13)');
    cumFill.addColorStop(1, 'rgba(154,140,255,0.01)');
    ctx.fillStyle = cumFill;
    ctx.fill();

    if (S.hover.sp) {
      const hb = S.hover.sp;
      ctx.strokeStyle = 'rgba(232,238,246,0.22)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(Math.round(hb.px) + 0.5, y0);
      ctx.lineTo(Math.round(hb.px) + 0.5, y1);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }
}

/* ------------------------------------------------------------- tooltips */

function showTooltip(kind, html, px, py) {
  const tip = kind === 'v' ? $('voltTip') : $('spikeTip');
  const wrap = kind === 'v' ? $('voltWrap') : $('spikeWrap');
  tip.innerHTML = html;
  tip.hidden = false;
  const maxLeft = wrap.clientWidth - 12;
  const left = Math.max(56, Math.min(maxLeft - 56, px));
  tip.style.left = left + 'px';
  tip.style.top = Math.max(34, Math.min(wrap.clientHeight - 6, py)) + 'px';
}

function hideTooltip(kind) {
  (kind === 'v' ? $('voltTip') : $('spikeTip')).hidden = true;
}

function attachHover(canvas, kind) {
  canvas.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    if (kind === 'v') {
      const g = S.geoV;
      if (!g || !S.samples.length || px < g.x0 - 2 || px > g.x1 + 2) return;
      const frac = Math.min(1, Math.max(0, (px - g.x0) / (g.x1 - g.x0)));
      const index = Math.round(g.first + frac * (g.last - g.first));
      const k = index - S.base;
      if (k < 0 || k >= S.samples.length) return;
      const value = S.samples[k];
      const nearSpike = S.spikes.find((s) => Math.abs(s.i - index) <= 1);
      S.hover.v = { px, index, value };
      const y = g.Y(value);
      showTooltip(
        'v',
        `<div><span class="tk">n</span> ${fmtInt(index)}` +
          (nearSpike ? ` <span class="ta">spike</span>` : '') +
          `</div><div><span class="tv">${value.toFixed(1)} µV</span></div>`,
        px,
        y
      );
      $('voltReadout').textContent = `n ${fmtInt(index)} · ${value.toFixed(1)} µV`;
      S.dirty = true;
    } else {
      const g = S.geoSp;
      if (!g || px < g.x0 || px > g.x1) return;
      const b = Math.min(g.bins - 1, Math.max(0, Math.floor(((px - g.x0) / g.pw) * g.bins)));
      const lo = Math.round(g.first + (b / g.bins) * (g.last - g.first));
      const hi = Math.round(g.first + ((b + 1) / g.bins) * (g.last - g.first));
      S.hover.sp = { px, bin: b };
      showTooltip(
        'sp',
        `<div><span class="tk">n</span> ${fmtInt(lo)}–${fmtInt(hi)}</div>` +
          `<div><span class="ta">${g.counts[b]} spike${g.counts[b] === 1 ? '' : 's'}</span>` +
          ` <span class="tk">·</span> <span class="tp">Σ ${fmtInt(g.cums[b])}</span></div>`,
        px,
        g.y1 - 40
      );
      $('spikeReadout').textContent = `bin ${g.counts[b]} · Σ ${fmtInt(g.cums[b])}`;
      S.dirty = true;
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (kind === 'v') S.hover.v = null; else S.hover.sp = null;
    hideTooltip(kind);
    S.dirty = true;
  });
}

/* ------------------------------------------------------------- stat tiles */

function updateStats() {
  $('statSamples').textContent = fmtInt(S.n);
  $('statSpikes').textContent = fmtInt(S.spikesTotal);
  $('statRate').textContent = S.n > 0 ? ((S.spikesTotal / S.n) * 1000).toFixed(1) : '0.0';
  $('statRateSub').textContent = S.running && S.elapsed > 0.5
    ? `≈ ${(S.spikesTotal / Math.max(S.elapsed, 0.5)).toFixed(1)} spikes / s`
    : 'per 1,000 samples';
  $('statPeak').textContent = isFinite(S.vmax) ? S.vmax.toFixed(1) + ' µV' : '—';
  $('statPeakSub').textContent = isFinite(S.vmin) ? `min ${S.vmin.toFixed(1)} µV` : 'µV this session';
  $('statSamplesSub').textContent = S.n > 400000
    ? `showing last ${fmtInt(400000)} of ${fmtInt(S.n)}`
    : 'n since reset';
  $('logCount').textContent = `${fmtInt(S.spikesTotal)} recorded`;

  if (!S.hover.v) {
    const latest = S.samples.length ? S.samples[S.samples.length - 1] : null;
    $('voltReadout').textContent = latest === null
      ? '—'
      : `now ${latest.toFixed(1)} µV · n ${fmtInt(S.n)}`;
  }
  if (!S.hover.sp) {
    $('spikeReadout').textContent = `${fmtInt(S.spikesTotal)} total`;
  }
}

/* ------------------------------------------------------------------ log */

function renderLog() {
  const body = $('logBody');
  const recent = S.spikes.slice(-10).reverse();
  if (!recent.length) {
    body.innerHTML = '<tr class="empty"><td colspan="4">No spikes yet — press Start sampling</td></tr>';
    return;
  }
  const total = S.spikes.length;
  body.innerHTML = recent
    .map((spike, idx) => {
      const ordinal = Math.max(1, total - idx);
      return `<tr class="${idx === 0 ? 'fresh' : ''}">
        <td>${ordinal}</td>
        <td>${fmtInt(spike.i)}</td>
        <td>${spike.v.toFixed(1)} µV</td>
        <td>${spike.t.toFixed(2)}s</td>
      </tr>`;
    })
    .join('');
}

/* ------------------------------------------------------------- rendering */

function drawAll() {
  drawVoltage();
  drawSpikeChart();
  updateStats();
}

function loop(ts) {
  if (S.dirty && ts - S.lastDraw >= 55) {
    drawAll();
    S.dirty = false;
    S.lastDraw = ts;
  }
  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------ data flow */

function clearLocal() {
  S.n = 0;
  S.base = 0;
  S.samples = [];
  S.spikes = [];
  S.spikesTotal = 0;
  S.vmin = Infinity;
  S.vmax = -Infinity;
  S.hover = { v: null, sp: null };
  S.dirty = true;
  renderLog();
}

function applyHistory(history) {
  S.n = history.n;
  S.base = history.base;
  S.samples = history.samples || [];
  S.spikes = history.spikes || [];
  S.spikesTotal = history.spikes_total;
  S.vmin = Infinity;
  S.vmax = -Infinity;
  for (const v of S.samples) {
    if (v < S.vmin) S.vmin = v;
    if (v > S.vmax) S.vmax = v;
  }
  S.dirty = true;
  renderLog();
}

async function resync() {
  if (S.resyncing) return;
  S.resyncing = true;
  try {
    const [state, history] = await Promise.all([api('/api/state'), api('/api/history')]);
    applyHistory(history);
    applyState(state, { skipResync: true });
  } catch (err) {
    setNotice('Lost sync with the sampler: ' + err.message, 'error');
  } finally {
    S.resyncing = false;
  }
}

function pushChunk(msg) {
  if (S.resyncing) return; // history fetch will cover these samples
  if (msg.start !== S.base + S.samples.length) {
    setTimeout(resync, 60);
    return;
  }
  S.n = msg.n;
  S.spikesTotal = msg.spikes_total ?? S.spikesTotal;
  S.elapsed = msg.elapsed_s ?? S.elapsed;
  S.elapsedStamp = performance.now();

  for (const v of msg.samples) {
    S.samples.push(v);
    if (v < S.vmin) S.vmin = v;
    if (v > S.vmax) S.vmax = v;
  }

  if (msg.spikes && msg.spikes.length) {
    for (const spike of msg.spikes) S.spikes.push(spike);
    renderLog();
    const tile = $('statSpikes').parentElement;
    tile.classList.remove('flash');
    void tile.offsetWidth;
    tile.classList.add('flash');
  }

  if (S.samples.length > 460000) {
    const drop = S.samples.length - 400000;
    S.samples.splice(0, drop);
    S.base += drop;
  }
  if (S.spikes.length > 100000) S.spikes.splice(0, S.spikes.length - 100000);

  S.dirty = true;
}

function connectStream() {
  const source = new EventSource('/api/stream');
  let openedBefore = false;

  source.onopen = () => {
    S.connected = true;
    $('connText').textContent = 'live';
    $('connText').classList.remove('amber');
    if (openedBefore) resync(); // chunks were missed while disconnected
    openedBefore = true;
  };

  source.onerror = () => {
    S.connected = false;
    $('connText').textContent = 'reconnecting';
    $('connText').classList.add('amber');
  };

  source.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }
    if (msg.type === 'chunk') {
      pushChunk(msg);
    } else if (msg.type === 'state') {
      applyState(msg.state);
    } else if (msg.type === 'reset') {
      clearLocal();
      applyState(msg.state, { skipResync: true });
    } else if (msg.type === 'hello') {
      applyState(msg.state);
    }
  };
}

/* ------------------------------------------------------------------ UI */

function syncControls() {
  const cfg = S.cfg;
  const active = document.activeElement;

  const setRange = (input, value, fillMax) => {
    if (active !== input) input.value = value;
    const pct = ((value / fillMax) * 100).toFixed(1) + '%';
    input.style.setProperty('--fill', pct);
  };

  setRange($('threshold'), cfg.threshold_uv, 300);
  $('thresholdOut').textContent = `${Number(cfg.threshold_uv).toFixed(0)} µV`;

  if (active !== $('rate')) $('rate').value = String(cfg.rate_hz);
  if (active !== $('refractory')) $('refractory').value = String(cfg.refractory);
  if (active !== $('source')) $('source').value = cfg.source;
  if (active !== $('deviceUrl')) $('deviceUrl').value = cfg.device_url;

  setRange($('activity'), cfg.activity * 100, 100);
  $('activityOut').textContent = `${Math.round(cfg.activity * 100)}%`;
  setRange($('noise'), cfg.noise_uv, 30);
  $('noiseOut').textContent = Number(cfg.noise_uv).toFixed(1);

  const device = cfg.source === 'device';
  $('urlWrap').hidden = !device;
  $('activityWrap').style.opacity = device ? 0.45 : 1;
  $('noiseWrap').style.opacity = device ? 0.45 : 1;
  $('activity').disabled = device;
  $('noise').disabled = device;
  $('sessionId').textContent = S.sessionId || 'not started';

  $('btnStart').disabled = S.running;
  $('btnStop').disabled = !S.running;

  $('recLed').classList.toggle('on', S.running);
  $('statusText').textContent = S.running ? 'Recording' : S.n > 0 ? 'Stopped' : 'Idle';

  const led = $('sourceLed');
  led.className = 'led';
  $('sourceLabel').textContent = device ? 'Neuroflow device' : 'Simulator';
  if (device) led.classList.add(S.sourceError ? 'amber' : 'mint');
  else led.classList.add('mint');

  if (device && S.sourceError) {
    setNotice(`Device unreachable — ${S.sourceError}`, 'error');
  } else if (device) {
    setNotice(`Polling ${cfg.device_url} · ${S.sourceStatus}`, 'ok');
  } else if (S.note.text.startsWith('Device unreachable') || S.note.text.startsWith('Polling ')) {
    setNotice('');
  }
}

function applyState(state, options = {}) {
  S.running = state.running;
  S.cfg = state.config;
  S.sessionId = state.session_id;
  S.sourceStatus = state.source_status;
  S.sourceError = state.source_error;
  S.spikesTotal = state.spikes_total;
  if (options.elapsed !== false) {
    S.elapsed = state.elapsed_s;
    S.elapsedStamp = performance.now();
  }
  if (!options.skipResync && S.n !== state.n) resync();
  syncControls();
  S.dirty = true;
}

/* ------------------------------------------------------------- controls */

let configTimer = null;
let pendingPatch = {};

function patchConfig(patch, delay = 120) {
  Object.assign(pendingPatch, patch);
  clearTimeout(configTimer);
  configTimer = setTimeout(async () => {
    const body = pendingPatch;
    pendingPatch = {};
    try {
      const state = await api('/api/config', { method: 'POST', body });
      S.cfg = state.config;
      S.sourceError = state.source_error;
      syncControls();
      S.dirty = true;
    } catch (err) {
      setNotice('Setting rejected: ' + err.message, 'error');
    }
  }, delay);
}

function fillTrack(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', pct.toFixed(1) + '%');
}

function bindControls() {
  $('btnStart').addEventListener('click', async () => {
    try {
      setNotice('');
      const state = await api('/api/start', { method: 'POST' });
      applyState(state);
    } catch (err) { setNotice('Could not start: ' + err.message, 'error'); }
  });

  $('btnStop').addEventListener('click', async () => {
    try {
      const state = await api('/api/stop', { method: 'POST' });
      applyState(state);
    } catch (err) { setNotice('Could not stop: ' + err.message, 'error'); }
  });

  $('btnReset').addEventListener('click', async () => {
    if (S.n > 0 && !window.confirm(`Discard this recording (${fmtInt(S.n)} samples, ${fmtInt(S.spikesTotal)} spikes)? Export first if you need it.`)) return;
    try {
      const state = await api('/api/reset', { method: 'POST' });
      clearLocal();
      applyState(state, { skipResync: true });
      setNotice('');
    } catch (err) { setNotice('Could not reset: ' + err.message, 'error'); }
  });

  const threshold = $('threshold');
  threshold.addEventListener('input', () => {
    const value = Number(threshold.value);
    $('thresholdOut').textContent = `${value.toFixed(0)} µV`;
    S.cfg.threshold_uv = value;
    fillTrack(threshold);
    S.dirty = true;
    patchConfig({ threshold_uv: value }, 200);
  });

  $('rate').addEventListener('change', (e) => {
    patchConfig({ rate_hz: Number(e.target.value) }, 0);
  });

  $('refractory').addEventListener('change', (e) => {
    patchConfig({ refractory: Number(e.target.value) }, 0);
  });

  const activity = $('activity');
  activity.addEventListener('input', () => {
    const pct = Number(activity.value);
    $('activityOut').textContent = `${pct}%`;
    S.cfg.activity = pct / 100;
    fillTrack(activity);
    patchConfig({ activity: pct / 100 }, 180);
  });

  const noise = $('noise');
  noise.addEventListener('input', () => {
    const value = Number(noise.value);
    $('noiseOut').textContent = value.toFixed(1);
    S.cfg.noise_uv = value;
    fillTrack(noise);
    patchConfig({ noise_uv: value }, 180);
  });

  $('source').addEventListener('change', (e) => {
    const source = e.target.value;
    const url = $('deviceUrl').value.trim() || S.cfg.device_url;
    setNotice(source === 'device'
      ? 'Polling the device endpoint — it must answer with JSON voltages in µV.'
      : '', 'ok');
    patchConfig({ source, device_url: url }, 0);
  });

  $('deviceUrl').addEventListener('change', (e) => {
    patchConfig({ device_url: e.target.value.trim() }, 0);
  });

  document.addEventListener('keydown', (event) => {
    const tag = (event.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (event.key === 's' || event.key === 'S') {
      event.preventDefault();
      $('btnStart').disabled ? $('btnStop').click() : $('btnStart').click();
    } else if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      $('btnReset').click();
    }
  });

  window.addEventListener('resize', () => { S.dirty = true; });
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  ['threshold', 'activity', 'noise'].forEach((id) => fillTrack($(id)));
  bindControls();
  attachHover($('voltChart'), 'v');
  attachHover($('spikeChart'), 'sp');

  try {
    const [state, history] = await Promise.all([api('/api/state'), api('/api/history')]);
    applyHistory(history);
    applyState(state, { skipResync: true });
  } catch (err) {
    setNotice('Backend not reachable: ' + err.message, 'error');
  }

  connectStream();
  requestAnimationFrame(loop);

  setInterval(() => {
    if (S.running) {
      const live = S.elapsed + (performance.now() - S.elapsedStamp) / 1000;
      $('elapsed').textContent = fmtClock(live);
    } else {
      $('elapsed').textContent = fmtClock(S.elapsed);
    }
  }, 250);

  setInterval(async () => {
    if (S.resyncing) return;
    try {
      const state = await api('/api/state');
      if (state.n !== S.n) { resync(); return; }
      applyState(state, { elapsed: false });
    } catch (_) { /* stream status already shown */ }
  }, 2500);
}

document.addEventListener('DOMContentLoaded', boot);
