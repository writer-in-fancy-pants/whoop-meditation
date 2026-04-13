'use strict';
/* ================================================================
   HRV Training Dashboard — app.js
   Connects to WHOOP via Web Bluetooth (BLE Heart Rate service) OR
   via Python bridge WebSocket (fallback for Firefox / Safari).
   Computes live RMSSD, pNN50, coherence index from RR intervals.
   ================================================================ */

/* ── BLE constants (Bluetooth GATT) ───────────────────────────── */
const HR_SERVICE         = 0x180D;
const HR_MEASUREMENT     = 0x2A37;

/* ── Config ────────────────────────────────────────────────────── */
const RR_WINDOW          = 30;     // beats for rolling RMSSD
const BASELINE_BEATS     = 120;    // ~2 min at 60 bpm
const COHERENCE_WINDOW   = 60;     // beats for coherence estimate
const MAX_CHART_POINTS   = 300;    // rolling chart length
const RMSSD_UPDATE_HZ    = 1;      // chart refresh rate (s)

/* ── State ─────────────────────────────────────────────────────── */
let bleDevice     = null;
let bleChar       = null;
let ws            = null;

let rrBuffer      = [];            // all RR intervals (ms) this session
let baselineRMSSD = null;
let baselinePhase = false;
let sessionActive = false;
let sessionDurSec = 0;
let elapsedSec    = 0;
let timerInterval = null;
let beepTimer     = null;
let breathTimer   = null;
let lastCoherence = false;         // was HRV in high-coherence last tick

// Chart rolling arrays
const hist = { labels:[], hr:[], rr:[], rmssd:[], time:0 };

/* ── HRV math ──────────────────────────────────────────────────── */

/** Root Mean Square of Successive Differences */
function rmssd(rr) {
  if (rr.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < rr.length; i++) {
    const d = rr[i] - rr[i-1];
    sum += d * d;
  }
  return Math.sqrt(sum / (rr.length - 1));
}

/** Proportion of successive RR diffs > 50 ms */
function pnn50(rr) {
  if (rr.length < 2) return null;
  let count = 0;
  for (let i = 1; i < rr.length; i++) {
    if (Math.abs(rr[i] - rr[i-1]) > 50) count++;
  }
  return (count / (rr.length - 1)) * 100;
}

/**
 * Simple coherence index: ratio of power in 0.04–0.15 Hz (LF) band
 * of the RR tachogram vs total, using a DFT on the last COHERENCE_WINDOW beats.
 * Returns 0–1; higher = more coherent (resonant frequency breathing).
 */
function coherenceIndex(rr) {
  const n = rr.length;
  if (n < 20) return 0;
  const seg = rr.slice(-Math.min(n, COHERENCE_WINDOW));
  // Approximate mean RR to get sampling interval
  const meanRR = seg.reduce((a,b) => a+b, 0) / seg.length / 1000; // seconds
  const fs = 1 / meanRR; // effective sample rate

  // DFT
  const N = seg.length;
  let totalPow = 0, lfPow = 0;
  for (let k = 0; k < N/2; k++) {
    let re = 0, im = 0;
    for (let n2 = 0; n2 < N; n2++) {
      const a = -2 * Math.PI * k * n2 / N;
      re += seg[n2] * Math.cos(a);
      im += seg[n2] * Math.sin(a);
    }
    const pow = (re*re + im*im) / N;
    const freq = k * fs / N;
    totalPow += pow;
    if (freq >= 0.04 && freq <= 0.15) lfPow += pow;
  }
  return totalPow > 0 ? Math.min(lfPow / totalPow, 1) : 0;
}

/** Parse the Heart Rate Measurement GATT characteristic (0x2A37) */
function parseHRMeasurement(dataView) {
  const flags  = dataView.getUint8(0);
  const hrFormat = flags & 0x01;          // 0=uint8, 1=uint16
  const rrPresent = !!(flags & 0x10);

  let offset = 1;
  const bpm = hrFormat
    ? dataView.getUint16(offset, true)
    : dataView.getUint8(offset);
  offset += hrFormat ? 2 : 1;

  // Skip energy expended if present
  if (flags & 0x08) offset += 2;

  const rrIntervals = [];
  if (rrPresent) {
    while (offset + 1 < dataView.byteLength) {
      // WHOOP sends RR in ms directly (not Polar's 1/1024 s units)
      const raw = dataView.getUint16(offset, true);
      offset += 2;
      // Sanity: plausible RR range 300–2000 ms
      if (raw >= 300 && raw <= 2000) rrIntervals.push(raw);
    }
  }
  return { bpm, rrIntervals };
}

/* ── BLE connection ────────────────────────────────────────────── */

async function connectBLE() {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth is not supported in this browser.\nUse Chrome or Edge, or use the Python bridge.');
    return;
  }
  updateBleStatus('connecting');
  try {
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HR_SERVICE] }],
      optionalServices: [HR_SERVICE],
    });
    bleDevice.addEventListener('gattserverdisconnected', onBleDisconnect);

    const server  = await bleDevice.gatt.connect();
    const service = await server.getPrimaryService(HR_SERVICE);
    bleChar        = await service.getCharacteristic(HR_MEASUREMENT);

    bleChar.addEventListener('characteristicvaluechanged', e => {
      const { bpm, rrIntervals } = parseHRMeasurement(e.target.value);
      onHRData(bpm, rrIntervals);
    });
    await bleChar.startNotifications();

    updateBleStatus('connected', bleDevice.name || 'WHOOP');
    document.getElementById('connectBanner').style.display = 'none';
  } catch (err) {
    console.warn('BLE error:', err);
    updateBleStatus('disconnected');
    if (!err.message.includes('cancelled')) alert('BLE connection failed: ' + err.message);
  }
}

function onBleDisconnect() {
  updateBleStatus('disconnected');
  bleDevice = null; bleChar = null;
}

/* ── WebSocket bridge (fallback) ───────────────────────────────── */

function connectWS(url) {
  if (ws) { ws.close(); ws = null; }
  updateBleStatus('connecting');
  ws = new WebSocket(url);
  ws.onopen  = () => {
    updateBleStatus('connected', 'bridge');
    document.getElementById('connectBanner').style.display = 'none';
  };
  ws.onmessage = e => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    // Expected: { bpm: number, rr_ms: number[] }
    if (d.bpm !== undefined) onHRData(d.bpm, d.rr_ms || []);
  };
  ws.onerror = ws.onclose = () => {
    updateBleStatus('disconnected');
    ws = null;
  };
}

/* ── Data handler ──────────────────────────────────────────────── */

function onHRData(bpm, rrIntervals) {
  // Append new RR intervals
  rrBuffer.push(...rrIntervals);

  // Baseline collection
  if (baselinePhase) {
    const pct = Math.min(rrBuffer.length / BASELINE_BEATS, 1);
    document.getElementById('statStatus').textContent =
      `Calibrating… ${Math.round(pct * 100)}%`;
    if (rrBuffer.length >= BASELINE_BEATS) finishBaseline();
    return;
  }

  // Rolling window
  const window = rrBuffer.slice(-RR_WINDOW);
  const rv = rmssd(window);
  const pv = pnn50(window);
  const ci = coherenceIndex(rrBuffer);

  // Update stats
  document.getElementById('statHR').innerHTML    = `${Math.round(bpm)}<span class="stat-unit">bpm</span>`;
  document.getElementById('statRMSSD').innerHTML  = rv !== null ? `${rv.toFixed(1)}<span class="stat-unit">ms</span>` : '—';
  document.getElementById('statPNN50').innerHTML  = pv !== null ? `${pv.toFixed(1)}<span class="stat-unit">%</span>` : '—';

  // Chart push
  const sec = (elapsedSec).toFixed(0);
  const pushRoll = (arr, v) => { arr.push(v); if (arr.length > MAX_CHART_POINTS) arr.shift(); };
  pushRoll(hist.labels, sec);
  pushRoll(hist.hr,     bpm);
  pushRoll(hist.rr,     rrIntervals.length ? rrIntervals[0] : null);
  pushRoll(hist.rmssd,  rv);
  updateCharts(rv);

  // Gauge
  drawGauge(ci, rv);

  // Coherence chime
  const highCoherence = rv !== null && baselineRMSSD !== null && rv > baselineRMSSD;
  if (highCoherence && !lastCoherence && document.getElementById('fbCoherence').checked && sessionActive) {
    coherenceChime();
  }
  lastCoherence = highCoherence;

  // Adaptive volume
  if (sessionActive && document.getElementById('fbVolume').checked && rv !== null) {
    applyAdaptiveVolume(rv);
  }
}

/* ── Baseline ──────────────────────────────────────────────────── */

function startBaseline() {
  baselinePhase = true;
  rrBuffer      = [];
  document.getElementById('statStatus').textContent = 'Calibrating…';
  document.getElementById('startBtn').disabled      = true;
}

function finishBaseline() {
  baselinePhase = false;
  const rv = rmssd(rrBuffer);
  baselineRMSSD = rv;
  document.getElementById('statBaseline').textContent = rv ? rv.toFixed(1) + ' ms' : '—';
  document.getElementById('statStatus').textContent   = 'Baseline done';
  document.getElementById('startBtn').disabled        = false;
  rrBuffer = []; // reset for session
}

/* ── Session ───────────────────────────────────────────────────── */

function startSession() {
  sessionActive  = true;
  elapsedSec     = 0;
  sessionDurSec  = (+document.getElementById('sessionDur').value || 20) * 60;
  document.getElementById('statStatus').textContent   = 'Training';
  document.getElementById('startBtn').disabled        = true;
  document.getElementById('stopBtn').disabled         = false;
  document.getElementById('baselineBtn').disabled     = true;
  document.getElementById('statRemaining').textContent = fmtTime(sessionDurSec);

  // Audio
  const soundVal = [...document.querySelectorAll('input[name="sound"]')].find(r => r.checked)?.value || 'none';
  if (soundVal !== 'none') startSound(soundVal);

  // Beep
  if (document.getElementById('fbBeep').checked) scheduleBeep(+document.getElementById('beepInterval').value);

  // Breathing pacer
  if (document.getElementById('breathingPacer').checked) startBreathPacer();

  // Clock
  timerInterval = setInterval(() => {
    elapsedSec++;
    document.getElementById('statElapsed').textContent   = fmtTime(elapsedSec);
    const rem = Math.max(sessionDurSec - elapsedSec, 0);
    document.getElementById('statRemaining').textContent = fmtTime(rem);
    if (rem === 0) endSession();
  }, 1000);
}

function endSession() {
  if (!sessionActive) return;
  sessionActive = false;
  clearInterval(timerInterval);
  clearInterval(beepTimer);
  clearInterval(breathTimer);
  stopSound();
  stopBreathPacer();

  document.getElementById('statStatus').textContent   = 'Complete';
  document.getElementById('stopBtn').disabled         = true;
  document.getElementById('startBtn').disabled        = false;
  document.getElementById('baselineBtn').disabled     = false;

  // Gentle end alarm
  if (document.getElementById('fbEndAlarm').checked) playEndAlarm();

  // Show summary overlay
  showSummary();
}

function stopSession() {
  endSession();
}

function showSummary() {
  const rrAll   = rrBuffer.slice(-Math.min(rrBuffer.length, 300));
  const rv      = rmssd(rrAll);
  const pv      = pnn50(rrAll);
  const ci      = coherenceIndex(rrAll);
  const avgHR   = hist.hr.length ? (hist.hr.reduce((a,b)=>a+(b||0),0)/hist.hr.filter(Boolean).length).toFixed(0) : '—';
  const row = (l,v) => `<div class="end-stat-row"><span class="end-stat-label">${l}</span><span class="end-stat-value">${v}</span></div>`;
  document.getElementById('endStats').innerHTML =
    row('Duration',           fmtTime(elapsedSec)) +
    row('Avg heart rate',     avgHR + ' bpm') +
    row('RMSSD (session)',     rv ? rv.toFixed(1) + ' ms' : '—') +
    row('pNN50',               pv ? pv.toFixed(1) + ' %' : '—') +
    row('Coherence index',     ci.toFixed(3)) +
    (baselineRMSSD ? row('vs baseline RMSSD', rv ? ((rv - baselineRMSSD) >= 0 ? '+' : '') + (rv - baselineRMSSD).toFixed(1) + ' ms' : '—') : '');
  document.getElementById('endOverlay').style.display = 'flex';
}

function fmtTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(1,'0');
  const s = String(sec % 60).padStart(2,'0');
  return `${m}:${s}`;
}

/* ── Charts ─────────────────────────────────────────────────────── */

let hrChart = null, rrChart = null, rmssdChart = null;

function chartColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    grid:  s.getPropertyValue('--chart-grid').trim()  || 'rgba(255,255,255,0.06)',
    tick:  s.getPropertyValue('--chart-tick').trim()  || '#666',
    title: s.getPropertyValue('--chart-title').trim() || '#888',
  };
}

function makeDS(label, color, data, yID = 'y') {
  return {
    label, data,
    borderColor: color, backgroundColor: color + '18',
    borderWidth: 1.5, pointRadius: 0, tension: 0.35,
    fill: false, spanGaps: true, yAxisID: yID,
  };
}

function scaleX(cc) {
  return {
    ticks:  { font: { size: 10 }, color: cc.tick, maxTicksLimit: 8 },
    grid:   { color: cc.grid },
    title:  { display: true, text: 'Time (s)', font: { size: 10 }, color: cc.title },
  };
}
function scaleY(cc, label) {
  return {
    ticks:  { font: { size: 10 }, color: cc.tick, callback: v => Math.round(v) },
    grid:   { color: cc.grid },
    title:  { display: true, text: label, font: { size: 10 }, color: cc.title },
  };
}

function initCharts() {
  const cc = chartColors();
  const empty = () => new Array(MAX_CHART_POINTS).fill(null);

  hrChart = new Chart(document.getElementById('hrChart'), {
    type: 'line',
    data: { labels: empty(), datasets: [ makeDS('HR', '#e07050', empty()) ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales:  { x: scaleX(cc), y: scaleY(cc, 'BPM') },
    },
  });

  rrChart = new Chart(document.getElementById('rrChart'), {
    type: 'line',
    data: { labels: empty(), datasets: [ makeDS('RR', '#7c75e0', empty()) ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales:  { x: scaleX(cc), y: scaleY(cc, 'ms') },
    },
  });

  rmssdChart = new Chart(document.getElementById('rmssdChart'), {
    type: 'line',
    data: {
      labels: empty(),
      datasets: [
        makeDS('RMSSD', '#2db891', empty()),
        {
          label: 'Baseline',
          data:  empty(),
          borderColor:     'rgba(255,140,60,0.55)',
          borderWidth:     1.5,
          borderDash:      [5, 4],
          pointRadius:     0,
          fill:            false,
          spanGaps:        false,
          yAxisID:         'y',
          backgroundColor: 'transparent',
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales:  { x: scaleX(cc), y: scaleY(cc, 'RMSSD (ms)') },
    },
  });
}

function updateCharts(currentRMSSD) {
  const L = hist.labels;
  hrChart.data.labels             = [...L];
  hrChart.data.datasets[0].data   = [...hist.hr];
  hrChart.update('none');

  rrChart.data.labels             = [...L];
  rrChart.data.datasets[0].data   = [...hist.rr];
  rrChart.update('none');

  rmssdChart.data.labels          = [...L];
  rmssdChart.data.datasets[0].data = [...hist.rmssd];
  rmssdChart.data.datasets[1].data = new Array(L.length).fill(baselineRMSSD);
  rmssdChart.update('none');
}

/* ── Gauge canvas ──────────────────────────────────────────────── */

function drawGauge(coherence, rv) {
  const canvas = document.getElementById('gaugeCanvas');
  const ctx    = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w/2, cy = h/2 + 10, r = 70;

  ctx.clearRect(0,0,w,h);

  // Background arc
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 0);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border-default').trim() || 'rgba(255,255,255,0.1)';
  ctx.lineWidth   = 12;
  ctx.lineCap     = 'round';
  ctx.stroke();

  // Value arc
  const angle  = Math.PI + coherence * Math.PI;
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const arcColor = coherence > 0.55 ? (isDark ? '#2db891' : '#1a9e75')
                 : coherence > 0.3  ? (isDark ? '#d0901a' : '#b07010')
                 :                    (isDark ? '#e05050' : '#c03030');

  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, angle);
  ctx.strokeStyle = arcColor;
  ctx.lineWidth   = 12;
  ctx.lineCap     = 'round';
  ctx.stroke();

  // Needle
  const needleAngle = Math.PI + coherence * Math.PI;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + (r - 8) * Math.cos(needleAngle), cy + (r - 8) * Math.sin(needleAngle));
  ctx.strokeStyle = isDark ? '#e8eaf0' : '#111827';
  ctx.lineWidth = 2;
  ctx.lineCap   = 'round';
  ctx.stroke();

  // Centre dot
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI*2);
  ctx.fillStyle = isDark ? '#e8eaf0' : '#111827';
  ctx.fill();

  // Labels
  ctx.font      = '10px monospace';
  ctx.fillStyle = isDark ? '#555d78' : '#9ca3af';
  ctx.textAlign = 'left';  ctx.fillText('low',  cx - r - 2, cy + 18);
  ctx.textAlign = 'right'; ctx.fillText('high', cx + r + 2, cy + 18);

  // Centre value
  ctx.textAlign = 'center';
  ctx.font      = '13px monospace';
  ctx.fillStyle = isDark ? '#e8eaf0' : '#111827';
  ctx.fillText((coherence * 100).toFixed(0) + '%', cx, cy - r + 18);

  // Update text labels
  const pv = pnn50(rrBuffer.slice(-RR_WINDOW));
  document.getElementById('gaugePnn').textContent       = `pNN50: ${pv !== null ? pv.toFixed(1) + '%' : '—'}`;
  document.getElementById('gaugeCoherence').textContent = `Coherence: ${(coherence*100).toFixed(0)}%`;

  // State badge
  const badge = document.getElementById('hrvStateBadge');
  if (rv !== null && baselineRMSSD !== null) {
    if (rv >= baselineRMSSD * 1.1) {
      badge.textContent = 'High coherence ↑';
      badge.className   = 'hrv-state-badge good';
    } else if (rv < baselineRMSSD * 0.85) {
      badge.textContent = 'Below baseline ↓';
      badge.className   = 'hrv-state-badge low';
    } else {
      badge.textContent = 'Near baseline →';
      badge.className   = 'hrv-state-badge';
    }
  }
}

/* ── Audio ─────────────────────────────────────────────────────── */

let audioCtx       = null;
let masterGain     = null;
let currentSource  = null;
let generativeStop = null;
let uploadedBuffer = null;
let targetVolume   = 0.5;
let adaptedVolume  = 0.5;

function ensureAudioCtx() {
  if (audioCtx) return;
  audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0;
  masterGain.connect(audioCtx.destination);
}

function setMasterVolume(v, rampMs = 1200) {
  if (!masterGain) return;
  masterGain.gain.setTargetAtTime(v, audioCtx.currentTime, rampMs / 1000);
}

function applyAdaptiveVolume(rv) {
  // Lower volume as RMSSD rises above baseline (deeper parasympathetic state)
  if (!baselineRMSSD) { setMasterVolume(adaptedVolume, 2000); return; }
  const ratio = rv / baselineRMSSD;
  const reduction = Math.min(Math.max((ratio - 1) * 0.3, 0), 0.35);
  adaptedVolume = targetVolume * (1 - reduction);
  setMasterVolume(adaptedVolume, 2500);
}

function playTone(hz, durMs = 200, gain = 0.07) {
  ensureAudioCtx();
  audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const g   = audioCtx.createGain();
  osc.type  = 'sine';
  osc.frequency.value = hz;
  const now = audioCtx.currentTime;
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(gain, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, now + durMs / 1000);
  osc.connect(g); g.connect(audioCtx.destination);
  osc.start(now); osc.stop(now + durMs / 1000 + 0.05);
}

function coherenceChime() {
  playTone(528, 350, 0.06);
  setTimeout(() => playTone(660, 280, 0.04), 200);
}

function performanceTone(rv) {
  const hz = rv !== null && baselineRMSSD !== null && rv >= baselineRMSSD ? 660 : 330;
  playTone(hz, 220, 0.06);
}

function playEndAlarm() {
  // Gentle ascending 3-note chime — non-jarring return signal
  const notes = [440, 528, 660];
  notes.forEach((hz, i) => {
    setTimeout(() => playTone(hz, 600, 0.08), i * 500);
  });
  setTimeout(() => {
    notes.forEach((hz, i) => {
      setTimeout(() => playTone(hz, 400, 0.05), i * 300);
    });
  }, 2000);
}

function scheduleBeep(intervalSec) {
  clearInterval(beepTimer);
  if (intervalSec <= 0) return;
  beepTimer = setInterval(() => {
    if (!sessionActive) return;
    const recent = rrBuffer.slice(-RR_WINDOW);
    performanceTone(rmssd(recent));
  }, intervalSec * 1000);
}

// ── Procedural audio generators (same as neurofeedback tool) ─────

function startWaves() {
  ensureAudioCtx();
  const ctx = audioCtx, nodes = [];
  const bufSize = 4 * ctx.sampleRate;
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for (let i = 0; i < bufSize; i++) {
    const w=Math.random()*2-1;
    b0=0.99886*b0+w*0.0555179;b1=0.99332*b1+w*0.0750759;
    b2=0.96900*b2+w*0.1538520;b3=0.86650*b3+w*0.3104856;
    b4=0.55000*b4+w*0.5329522;b5=-0.7616*b5-w*0.0168980;
    d[i]=(b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11; b6=w*0.115926;
  }
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
  const lpf = ctx.createBiquadFilter(); lpf.type='lowpass'; lpf.frequency.value=400; lpf.Q.value=0.7;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.08;
  const lfoG = ctx.createGain(); lfoG.gain.value = 0.35;
  const swellG = ctx.createGain(); swellG.gain.value = 0.65;
  lfo.connect(lfoG); lfoG.connect(swellG.gain);
  src.connect(lpf); lpf.connect(swellG); swellG.connect(masterGain);
  src.start(); lfo.start();
  nodes.push(src, lfo);
  return () => nodes.forEach(n => { try { n.stop(); } catch(e){} });
}

function startBrook() {
  ensureAudioCtx();
  const ctx = audioCtx;
  const bufSize = 2 * ctx.sampleRate;
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
  const hpf = ctx.createBiquadFilter(); hpf.type='highpass'; hpf.frequency.value=600; hpf.Q.value=0.5;
  const bpf = ctx.createBiquadFilter(); bpf.type='bandpass'; bpf.frequency.value=1200; bpf.Q.value=2;
  const g = ctx.createGain(); g.gain.value = 0.12;
  src.connect(hpf); hpf.connect(bpf); bpf.connect(g); g.connect(masterGain);
  src.start();
  return () => { try { src.stop(); } catch(e){} };
}

function startGong() {
  ensureAudioCtx();
  const ctx = audioCtx;
  let running = true;
  function strike() {
    if (!running) return;
    const osc1 = ctx.createOscillator(); osc1.type='sine'; osc1.frequency.value=220;
    const osc2 = ctx.createOscillator(); osc2.type='sine'; osc2.frequency.value=440.7;
    const osc3 = ctx.createOscillator(); osc3.type='sine'; osc3.frequency.value=880.3;
    const env = ctx.createGain(); const now = ctx.currentTime;
    env.gain.setValueAtTime(0,now);
    env.gain.linearRampToValueAtTime(0.3, now+0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, now+8);
    [osc1,osc2,osc3].forEach(o=>{ o.connect(env); o.start(now); o.stop(now+9); });
    env.connect(masterGain);
    setTimeout(strike, 12000 + Math.random()*6000);
  }
  strike();
  return () => { running = false; };
}

function startGenerative() {
  ensureAudioCtx();
  const ctx = audioCtx, out = masterGain, nodes = [];
  const pads = [
    { freq: 432, detune: 0,  lfoRate: 0.07, lfoDepth: 0.25 },
    { freq: 528, detune: 3,  lfoRate: 0.11, lfoDepth: 0.18 },
    { freq: 324, detune: -2, lfoRate: 0.05, lfoDepth: 0.20 },
  ];
  const padGain = ctx.createGain(); padGain.gain.value = 0.18; padGain.connect(out);
  pads.forEach(p => {
    const osc = ctx.createOscillator(); osc.type='sine'; osc.frequency.value=p.freq; osc.detune.value=p.detune;
    const lfo = ctx.createOscillator(); lfo.frequency.value=p.lfoRate;
    const lfoGain = ctx.createGain(); lfoGain.gain.value=p.lfoDepth;
    lfo.connect(lfoGain);
    const envGain = ctx.createGain(); envGain.gain.value=1.0;
    lfoGain.connect(envGain.gain);
    osc.connect(envGain); envGain.connect(padGain);
    osc.start(); lfo.start();
    nodes.push(osc, lfo);
  });
  return () => nodes.forEach(n => { try { n.stop(); } catch(e){} });
}

function startUpload() {
  if (!uploadedBuffer) return null;
  ensureAudioCtx();
  const src = audioCtx.createBufferSource();
  src.buffer = uploadedBuffer; src.loop = true;
  src.connect(masterGain); src.start();
  return () => { try { src.stop(); } catch(e){} };
}

function stopSound() {
  if (currentSource)  { currentSource();  currentSource = null; }
  if (generativeStop) { generativeStop(); generativeStop = null; }
}

function startSound(type) {
  stopSound();
  ensureAudioCtx();
  audioCtx.resume();
  setMasterVolume(0, 0);
  switch (type) {
    case 'waves':      currentSource = startWaves();      break;
    case 'brook':      currentSource = startBrook();      break;
    case 'gong':       currentSource = startGong();       break;
    case 'generative': generativeStop= startGenerative(); break;
    case 'upload':     currentSource = startUpload();     break;
    default: return;
  }
  setMasterVolume(adaptedVolume, 1500);
}

/* ── Breathing pacer ───────────────────────────────────────────── */

let breathPhase  = 'in'; // 'in' | 'out'
let breathOffset = 0;
let breathDurIn  = 0;
let breathDurOut = 0;
let breathStart  = 0;

function startBreathPacer() {
  const rate  = +document.getElementById('breathRate').value;       // breaths/min
  const ratio = +document.getElementById('breathRatio').value;      // in fraction
  const cycleSec = 60 / rate;
  breathDurIn    = cycleSec * ratio;
  breathDurOut   = cycleSec * (1 - ratio);
  breathPhase    = 'in';
  breathStart    = Date.now();
  document.getElementById('breathVis').style.display = 'flex';

  // Cue tones
  function cueTone(phase) {
    playTone(phase === 'in' ? 440 : 330, 100, 0.04);
  }
  cueTone('in');

  breathTimer = setInterval(() => {
    const elapsed = (Date.now() - breathStart) / 1000;
    let bar, label;
    if (breathPhase === 'in') {
      const p = Math.min(elapsed / breathDurIn, 1);
      bar = p;
      label = `Inhale (${(breathDurIn - elapsed).toFixed(1)}s)`;
      if (elapsed >= breathDurIn) {
        breathPhase = 'out'; breathStart = Date.now();
        cueTone('out');
      }
    } else {
      const p = Math.min(elapsed / breathDurOut, 1);
      bar = 1 - p;
      label = `Exhale (${(breathDurOut - elapsed).toFixed(1)}s)`;
      if (elapsed >= breathDurOut) {
        breathPhase = 'in'; breathStart = Date.now();
        cueTone('in');
      }
    }
    const barEl = document.getElementById('breathBar');
    const lblEl = document.getElementById('breathLabel');
    barEl.style.setProperty('--bp', bar.toFixed(3));
    barEl.style.transition = `transform ${breathPhase === 'in' ? breathDurIn : breathDurOut}s linear`;
    if (lblEl) lblEl.textContent = label;
  }, 80);
}

function stopBreathPacer() {
  clearInterval(breathTimer);
  document.getElementById('breathVis').style.display = 'none';
}

/* ── UI status helpers ─────────────────────────────────────────── */

function updateBleStatus(state, name) {
  const dot   = document.getElementById('bleDot');
  const label = document.getElementById('bleLabel');
  dot.className = 'ble-dot';
  switch (state) {
    case 'connected':   dot.classList.add('on');          label.textContent = name || 'Connected'; break;
    case 'connecting':  dot.classList.add('connecting');  label.textContent = 'Connecting…'; break;
    default:            label.textContent = 'Not connected';
  }
}

/* ── Theme ─────────────────────────────────────────────────────── */

(function initTheme() {
  const saved = localStorage.getItem('hrv-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
})();

document.getElementById('themeBtn').addEventListener('click', () => {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('hrv-theme', next);
  if (hrChart)    hrChart.destroy();
  if (rrChart)    rrChart.destroy();
  if (rmssdChart) rmssdChart.destroy();
  initCharts();
});

/* ── Event wiring ──────────────────────────────────────────────── */

document.getElementById('connectBleBtn').addEventListener('click', connectBLE);
document.getElementById('doBleConnect').addEventListener('click', connectBLE);
document.getElementById('connectWsBtn').addEventListener('click', () => {
  document.getElementById('connectBanner').style.display = 'block';
});
document.getElementById('doWsConnect').addEventListener('click', () => {
  connectWS(document.getElementById('wsUrlInput').value.trim());
});
document.getElementById('wsUrlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') connectWS(document.getElementById('wsUrlInput').value.trim());
});

document.getElementById('baselineBtn').addEventListener('click', () => {
  const connected = (bleChar !== null) || (ws && ws.readyState === WebSocket.OPEN);
  if (!connected) { alert('Connect to WHOOP first.'); return; }
  startBaseline();
});
document.getElementById('startBtn').addEventListener('click', startSession);
document.getElementById('stopBtn').addEventListener('click', stopSession);
document.getElementById('endClose').addEventListener('click', () => {
  document.getElementById('endOverlay').style.display = 'none';
});

document.getElementById('masterVolume').addEventListener('input', e => {
  targetVolume  = +e.target.value;
  adaptedVolume = targetVolume;
  document.getElementById('volVal').textContent = Math.round(targetVolume * 100) + '%';
  if (masterGain && !document.getElementById('fbVolume').checked) setMasterVolume(targetVolume, 300);
});

document.querySelectorAll('input[name="sound"]').forEach(r => {
  r.addEventListener('change', () => {
    document.getElementById('uploadRow').style.display = r.value === 'upload' ? 'flex' : 'none';
    if (sessionActive) { stopSound(); if (r.value !== 'none') startSound(r.value); }
  });
});

document.getElementById('audioUploadBtn').addEventListener('click', () => document.getElementById('audioUpload').click());
document.getElementById('audioUpload').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('uploadName').textContent = file.name;
  ensureAudioCtx();
  uploadedBuffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
});

document.getElementById('beepInterval').addEventListener('input', e => {
  document.getElementById('beepIntervalVal').textContent = +e.target.value + ' s';
  if (sessionActive && document.getElementById('fbBeep').checked) scheduleBeep(+e.target.value);
});
document.getElementById('fbBeep').addEventListener('change', () => {
  if (sessionActive) {
    document.getElementById('fbBeep').checked
      ? scheduleBeep(+document.getElementById('beepInterval').value)
      : clearInterval(beepTimer);
  }
});

document.getElementById('breathRate').addEventListener('input', e => {
  document.getElementById('breathRateVal').textContent = (+e.target.value).toFixed(1) + ' /min';
});
document.getElementById('breathRatio').addEventListener('input', e => {
  const v = +e.target.value;
  document.getElementById('breathRatioVal').textContent = Math.round(v*100) + ' : ' + Math.round((1-v)*100);
});
document.getElementById('breathingPacer').addEventListener('change', () => {
  if (sessionActive) {
    document.getElementById('breathingPacer').checked ? startBreathPacer() : stopBreathPacer();
  }
});

/* ── Init ──────────────────────────────────────────────────────── */

initCharts();
