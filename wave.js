const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Render at the screen's real pixel density so the sim stays crisp on
// high-DPI/large displays instead of the browser stretching a low-res
// bitmap. Everything below still lays out in the original design pixels
// (LOGICAL_WIDTH/LOGICAL_HEIGHT) — ctx.scale() maps that onto the sharper
// backing store transparently. This is separate from offCanvas below,
// which is an intentionally coarse compute buffer and must stay at its
// low GRID_W x GRID_H resolution.
const LOGICAL_WIDTH = parseInt(canvas.getAttribute('width'), 10);
const LOGICAL_HEIGHT = parseInt(canvas.getAttribute('height'), 10);
const DPR = window.devicePixelRatio || 1;
canvas.width = LOGICAL_WIDTH * DPR;
canvas.height = LOGICAL_HEIGHT * DPR;
canvas.style.width = LOGICAL_WIDTH + 'px';
canvas.style.height = LOGICAL_HEIGHT + 'px';
ctx.scale(DPR, DPR);

// The wave field is computed on a coarse grid (fast) and then stretched
// onto the full canvas, rather than evaluated per display pixel.
const GRID_W = 280;
const GRID_H = 140;
// Slit sample count adapts each frame to keep the spacing between sample
// points well under a quarter wavelength (a rough anti-aliasing margin),
// so a wide slit or a short wavelength gets more points automatically
// instead of being under-resolved at a fixed count. See subSourcesForSlit().
const MIN_SUB_SOURCES = 5;
const MAX_SUB_SOURCES = 41; // caps cost — this many points per slit, twice that for double-slit
const AMPLITUDE_DISPLAY_SCALE = 0.2; // tune this if the pattern looks too dim/bright
const BARRIER_X = LOGICAL_WIDTH * 0.32;

// ---- CONFIG: change these to adjust the setup ----
const CONFIG = {
  slitMode: 'double',      // 'single' | 'double'
  wavefrontType: 'flat',   // 'flat' | 'spherical'
  wavelength: 20,          // px
  waveSpeed: 150,          // px/s (fixed)
  slitWidth: 55,           // px
  slitSeparation: 90,      // px, used only in double-slit mode
  pointSourceOffset: 220,  // px, how far left of the barrier the point source sits
  graphLogScale: false,    // linear vs. dB scale on the intensity graph
  running: true
};

const offCanvas = document.createElement('canvas');
offCanvas.width = GRID_W;
offCanvas.height = GRID_H;
const offCtx = offCanvas.getContext('2d');
const imageData = offCtx.createImageData(GRID_W, GRID_H);

// Intensity monitor: a toggleable side panel that graphs time-averaged
// intensity along a vertical "screen" line at screenX — draggable (see the
// pointer handlers below) so you can pull it in close to the barrier to see
// near-field structure (side lobes, troughs) that's compressed out of view
// once the screen is far away.
let screenX = LOGICAL_WIDTH - 80;
const graphCanvas = document.getElementById('graphCanvas');
const graphCtx = graphCanvas.getContext('2d');
const LOGICAL_GRAPH_WIDTH = parseInt(graphCanvas.getAttribute('width'), 10);
const LOGICAL_GRAPH_HEIGHT = parseInt(graphCanvas.getAttribute('height'), 10);
graphCanvas.width = LOGICAL_GRAPH_WIDTH * DPR;
graphCanvas.height = LOGICAL_GRAPH_HEIGHT * DPR;
graphCanvas.style.width = LOGICAL_GRAPH_WIDTH + 'px';
graphCanvas.style.height = LOGICAL_GRAPH_HEIGHT + 'px';
graphCtx.scale(DPR, DPR);
let graphVisible = false;
let draggingScreen = false;

function isNearScreenLine(x) {
  return Math.abs(x - screenX) < 8;
}

function canvasXFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  return (e.clientX - rect.left) * (LOGICAL_WIDTH / rect.width);
}

canvas.addEventListener('pointerdown', (e) => {
  if (!graphVisible) return;
  const x = canvasXFromEvent(e);
  if (isNearScreenLine(x)) {
    draggingScreen = true;
    canvas.setPointerCapture(e.pointerId);
  }
});

canvas.addEventListener('pointermove', (e) => {
  const x = canvasXFromEvent(e);
  if (draggingScreen) {
    screenX = Math.max(BARRIER_X + 20, Math.min(LOGICAL_WIDTH - 10, x));
  } else if (graphVisible && isNearScreenLine(x)) {
    canvas.style.cursor = 'ew-resize';
  } else {
    canvas.style.cursor = 'default';
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (draggingScreen) {
    draggingScreen = false;
    canvas.releasePointerCapture(e.pointerId);
  }
});

// ---- physics ----
// Each open slit is modeled as several point sources spread across its
// width (Huygens' principle) — this is what produces both the two-slit
// interference fringes AND the single-slit diffraction spreading, since a
// lone point source alone wouldn't show either.
// Spacing = slitWidth / (n - 1); solving spacing < wavelength/4 for n gives
// n > 4*slitWidth/wavelength + 1 — so a wider slit or shorter wavelength
// raises n, and a narrow slit or long wavelength (already easy to resolve)
// lowers it, down to the floor.
function subSourcesForSlit() {
  const raw = Math.round((4 * CONFIG.slitWidth) / CONFIG.wavelength) + 1;
  return Math.max(MIN_SUB_SOURCES, Math.min(MAX_SUB_SOURCES, raw));
}

function getSubSources() {
  const n = subSourcesForSlit();
  const centers = CONFIG.slitMode === 'double'
    ? [LOGICAL_HEIGHT / 2 - CONFIG.slitSeparation / 2, LOGICAL_HEIGHT / 2 + CONFIG.slitSeparation / 2]
    : [LOGICAL_HEIGHT / 2];
  const sources = [];
  centers.forEach((cy) => {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      sources.push({ x: BARRIER_X, y: cy - CONFIG.slitWidth / 2 + t * CONFIG.slitWidth });
    }
  });
  return sources;
}

// Distance (and amplitude falloff) from the original source to a point
// (x, y), before the barrier — flat wavefronts don't attenuate, a point
// source's spherical wavefronts fall off as 1/sqrt(distance) in 2D.
function incidentGeometry(x, y) {
  if (CONFIG.wavefrontType === 'flat') {
    return { distance: x, amp: 1 };
  }
  const sx = BARRIER_X - CONFIG.pointSourceOffset;
  const sy = LOGICAL_HEIGHT / 2;
  const d = Math.max(Math.hypot(x - sx, y - sy), 4);
  return { distance: d, amp: 1 / Math.sqrt(d) };
}

// Left of the barrier: the raw incident wave. Right of the barrier: the
// sum of Huygens wavelets re-emitted from every open point on the slit(s),
// each carrying the phase the incident wave had when it reached that point.
function fieldAmplitude(x, y, t, subSources, k, omega) {
  if (x < BARRIER_X) {
    const g = incidentGeometry(x, y);
    return g.amp * Math.sin(k * g.distance - omega * t);
  }
  let sum = 0;
  for (let i = 0; i < subSources.length; i++) {
    const s = subSources[i];
    const gIncident = incidentGeometry(s.x, s.y);
    const r = Math.max(Math.hypot(x - s.x, y - s.y), 4);
    const amp = gIncident.amp / Math.sqrt(r);
    sum += amp * Math.sin(k * (gIncident.distance + r) - omega * t);
  }
  return sum / subSources.length; // average contribution — keeps brightness stable regardless of sample count
}

// Time-averaged intensity at a point, computed directly from the phasor
// sum rather than by sampling many instants — a sum of coherent sinusoids
// amp_i*sin(phase_i - wt) has oscillation amplitude sqrt(avgCos^2 + avgSin^2)
// (with avgCos/avgSin the phase-weighted average over sources), and the
// intensity is the square of that peak swing. This gives a stable curve
// that doesn't flicker with the animation.
function computeIntensity(y, screenX, subSources, k) {
  const refAmp = CONFIG.wavefrontType === 'flat' ? 1 : 1 / Math.sqrt(CONFIG.pointSourceOffset);
  let sumCos = 0;
  let sumSin = 0;
  for (let i = 0; i < subSources.length; i++) {
    const s = subSources[i];
    const gIncident = incidentGeometry(s.x, s.y);
    const excitation = gIncident.amp / refAmp;
    const r = Math.max(Math.hypot(screenX - s.x, y - s.y), 4);
    const amp = excitation / Math.sqrt(r);
    const phase = k * (gIncident.distance + r);
    sumCos += amp * Math.cos(phase);
    sumSin += amp * Math.sin(phase);
  }
  const avgCos = sumCos / subSources.length;
  const avgSin = sumSin / subSources.length;
  return avgCos * avgCos + avgSin * avgSin;
}

function amplitudeToColor(a) {
  const t = Math.max(-1, Math.min(1, a));
  if (t >= 0) {
    const v = Math.round(t * 255);
    return [v, v, Math.round(v * 0.35)]; // black -> yellow (crest)
  }
  const v = Math.round(-t * 255);
  return [Math.round(v * 0.15), Math.round(v * 0.45), v]; // black -> blue (trough)
}

// ---- drawing ----
function renderWaveField(t) {
  const subSources = getSubSources();
  const k = (2 * Math.PI) / CONFIG.wavelength;
  const omega = k * CONFIG.waveSpeed;
  const data = imageData.data;
  let idx = 0;

  for (let gy = 0; gy < GRID_H; gy++) {
    const y = (gy + 0.5) * (LOGICAL_HEIGHT / GRID_H);
    for (let gx = 0; gx < GRID_W; gx++) {
      const x = (gx + 0.5) * (LOGICAL_WIDTH / GRID_W);
      const a = fieldAmplitude(x, y, t, subSources, k, omega) / AMPLITUDE_DISPLAY_SCALE;
      const [r, g, b] = amplitudeToColor(a);
      data[idx++] = r;
      data[idx++] = g;
      data[idx++] = b;
      data[idx++] = 255;
    }
  }

  offCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(offCanvas, 0, 0, GRID_W, GRID_H, 0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
}

function drawBarrier() {
  const centers = CONFIG.slitMode === 'double'
    ? [LOGICAL_HEIGHT / 2 - CONFIG.slitSeparation / 2, LOGICAL_HEIGHT / 2 + CONFIG.slitSeparation / 2]
    : [LOGICAL_HEIGHT / 2];
  const gaps = centers
    .map((c) => [c - CONFIG.slitWidth / 2, c + CONFIG.slitWidth / 2])
    .sort((a, b) => a[0] - b[0]);

  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 6;
  ctx.beginPath();
  let y = 0;
  gaps.forEach(([gapStart, gapEnd]) => {
    ctx.moveTo(BARRIER_X, y);
    ctx.lineTo(BARRIER_X, Math.max(y, gapStart));
    y = gapEnd;
  });
  ctx.moveTo(BARRIER_X, y);
  ctx.lineTo(BARRIER_X, LOGICAL_HEIGHT);
  ctx.stroke();
}

function drawSourceMarker() {
  if (CONFIG.wavefrontType !== 'spherical') return;
  const sx = BARRIER_X - CONFIG.pointSourceOffset;
  const sy = LOGICAL_HEIGHT / 2;
  ctx.beginPath();
  ctx.arc(sx, sy, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd45e';
  ctx.fill();
  ctx.fillStyle = '#888';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Point source', sx, sy + 22);
}

function drawScreenMarker() {
  if (!graphVisible) return;
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.moveTo(screenX, 0);
  ctx.lineTo(screenX, LOGICAL_HEIGHT);
  ctx.strokeStyle = draggingScreen ? 'rgba(255, 255, 255, 0.7)' : 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#aaa';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('screen (drag me)', screenX, 14);
}

function drawIntensityGraph(k) {
  const subSources = getSubSources();
  const N_SAMPLES = 150;
  const points = [];
  let maxVal = 1e-9;
  for (let i = 0; i <= N_SAMPLES; i++) {
    const y = (i / N_SAMPLES) * LOGICAL_HEIGHT;
    const val = computeIntensity(y, screenX, subSources, k);
    points.push({ y, val });
    if (val > maxVal) maxVal = val;
  }

  graphCtx.fillStyle = '#000';
  graphCtx.fillRect(0, 0, LOGICAL_GRAPH_WIDTH, LOGICAL_GRAPH_HEIGHT);

  const plotWidth = LOGICAL_GRAPH_WIDTH - 24;
  const DB_FLOOR = -40; // dB below the peak treated as zero — keeps faint side lobes visible

  graphCtx.beginPath();
  graphCtx.moveTo(0, 0);
  points.forEach((p) => {
    const gy = (p.y / LOGICAL_HEIGHT) * LOGICAL_GRAPH_HEIGHT;
    let frac;
    if (CONFIG.graphLogScale) {
      const db = 10 * Math.log10(Math.max(p.val, 1e-12) / maxVal);
      frac = Math.max(0, (db - DB_FLOOR) / -DB_FLOOR);
    } else {
      frac = p.val / maxVal;
    }
    const gx = frac * plotWidth;
    graphCtx.lineTo(gx, gy);
  });
  graphCtx.lineTo(0, LOGICAL_GRAPH_HEIGHT);
  graphCtx.closePath();
  graphCtx.fillStyle = 'rgba(255, 212, 94, 0.55)';
  graphCtx.fill();
  graphCtx.strokeStyle = '#ffd45e';
  graphCtx.lineWidth = 1.5;
  graphCtx.stroke();

  graphCtx.strokeStyle = '#444';
  graphCtx.beginPath();
  graphCtx.moveTo(0, 0);
  graphCtx.lineTo(0, LOGICAL_GRAPH_HEIGHT);
  graphCtx.stroke();

  graphCtx.fillStyle = '#999';
  graphCtx.font = '11px system-ui, sans-serif';
  graphCtx.textAlign = 'left';
  graphCtx.fillText(
    CONFIG.graphLogScale ? 'Intensity at screen (dB)' : 'Intensity at screen',
    6,
    14
  );
}

function drawReadout() {
  const freq = CONFIG.waveSpeed / CONFIG.wavelength;
  ctx.textAlign = 'left';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#999';
  const lines = [
    'Wavelength: ' + CONFIG.wavelength + ' px',
    'Frequency: ' + freq.toFixed(2) + ' cycles/s (sim units)',
    'Wave speed: ' + CONFIG.waveSpeed + ' px/s'
  ];
  lines.forEach((line, i) => {
    ctx.fillText(line, 16, LOGICAL_HEIGHT - 16 - (lines.length - 1 - i) * 16);
  });
}

// ---- render + loop ----
function render(t) {
  renderWaveField(t);
  drawBarrier();
  drawSourceMarker();
  drawScreenMarker();
  drawReadout();
}

let simTime = 0;
let lastTimestamp = null;
function loop(now) {
  if (lastTimestamp !== null && CONFIG.running) {
    simTime += (now - lastTimestamp) / 1000;
  }
  lastTimestamp = now;
  render(simTime);
  if (graphVisible) {
    const k = (2 * Math.PI) / CONFIG.wavelength;
    drawIntensityGraph(k);
  }
  requestAnimationFrame(loop);
}

// ---- controls ----
document.getElementById('slitModeSelect').addEventListener('change', (e) => {
  CONFIG.slitMode = e.target.value;
  document.getElementById('separationRow').style.display = CONFIG.slitMode === 'double' ? '' : 'none';
});

document.getElementById('wavefrontSelect').addEventListener('change', (e) => {
  CONFIG.wavefrontType = e.target.value;
});

const wavelengthSlider = document.getElementById('wavelengthSlider');
const wavelengthValue = document.getElementById('wavelengthValue');
wavelengthSlider.addEventListener('input', () => {
  CONFIG.wavelength = parseFloat(wavelengthSlider.value);
  wavelengthValue.textContent = CONFIG.wavelength;
});

const slitWidthSlider = document.getElementById('slitWidthSlider');
const slitWidthValue = document.getElementById('slitWidthValue');
slitWidthSlider.addEventListener('input', () => {
  CONFIG.slitWidth = parseFloat(slitWidthSlider.value);
  slitWidthValue.textContent = CONFIG.slitWidth;
});

const separationSlider = document.getElementById('separationSlider');
const separationValue = document.getElementById('separationValue');
separationSlider.addEventListener('input', () => {
  CONFIG.slitSeparation = parseFloat(separationSlider.value);
  separationValue.textContent = CONFIG.slitSeparation;
});

const pauseBtn = document.getElementById('pauseBtn');
pauseBtn.addEventListener('click', () => {
  CONFIG.running = !CONFIG.running;
  pauseBtn.textContent = CONFIG.running ? 'Pause' : 'Resume';
});

const toggleGraphBtn = document.getElementById('toggleGraphBtn');
const graphPanel = document.getElementById('graphPanel');
toggleGraphBtn.addEventListener('click', () => {
  graphVisible = !graphVisible;
  graphPanel.style.display = graphVisible ? 'block' : 'none';
  toggleGraphBtn.textContent = graphVisible ? 'Hide intensity graph' : 'Show intensity graph';
});

document.getElementById('logScaleCheckbox').addEventListener('change', (e) => {
  CONFIG.graphLogScale = e.target.checked;
});

requestAnimationFrame(loop);
