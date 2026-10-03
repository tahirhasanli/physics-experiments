const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Render at the screen's real pixel density (see huygens.js/circuit.js for
// the same pattern) so the sim stays crisp on high-DPI displays.
const LOGICAL_WIDTH = parseInt(canvas.getAttribute('width'), 10);
const LOGICAL_HEIGHT = parseInt(canvas.getAttribute('height'), 10);
const DPR = window.devicePixelRatio || 1;
canvas.width = LOGICAL_WIDTH * DPR;
canvas.height = LOGICAL_HEIGHT * DPR;
canvas.style.width = LOGICAL_WIDTH + 'px';
canvas.style.height = LOGICAL_HEIGHT + 'px';
ctx.scale(DPR, DPR);

// =====================================================================
// PHYSICAL SCALE AND CONSTANTS
//
// The board is a real 20cm-tall sheet; its width just follows whatever
// pixel aspect ratio the canvas already has, so the physical board is
// never distorted relative to what's drawn. Charge is entered in whole
// multiples of the elementary charge e, and the field is computed with
// the real Coulomb constant, so every number the probe reports is a real
// (if often very small — that's physically correct!) N/C value.
// =====================================================================

const BOARD_HEIGHT_CM = 20;
const CM_PER_PX = BOARD_HEIGHT_CM / LOGICAL_HEIGHT;
const M_PER_PX = CM_PER_PX / 100;
const BOARD_WIDTH_CM = LOGICAL_WIDTH * CM_PER_PX;

const E_CHARGE = 1.602176634e-19; // C — elementary charge
const COULOMB_K = 8.9875517923e9; // N·m^2/C^2

// =====================================================================
// FORMATTING — scientific notation with a real superscript, used for both
// charge counts (in e) and field readings (in N/C).
// =====================================================================

const SUPERSCRIPT_MAP = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
function superscript(n) {
  return String(n).split('').map((ch) => SUPERSCRIPT_MAP[ch] || ch).join('');
}
function formatSci(value, sig) {
  sig = sig == null ? 2 : sig;
  if (!isFinite(value) || value === 0) return '0';
  const neg = value < 0;
  value = Math.abs(value);
  let exp = Math.floor(Math.log10(value));
  let coef = value / Math.pow(10, exp);
  coef = parseFloat(coef.toFixed(sig));
  if (coef >= 10) { coef /= 10; exp += 1; }
  return (neg ? '-' : '') + coef.toFixed(sig) + '×10' + superscript(exp);
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// =====================================================================
// MODEL
//
// This is a pure electrostatic field MAP, not an N-body simulation: charges
// never move on their own, they only sit where you drop them or drag them
// to. Charge strength is stored as an exponent (mag_e = 10^exp elementary
// charges) rather than a raw count, since realistic charge amounts span an
// enormous range — from a single electron up past a trillion — which only
// a log scale can dial in comfortably on a slider.
// =====================================================================

let charges = [
  { id: 1, x: 350, y: 325, sign: 1, exp: 9 },
  { id: 2, x: 650, y: 325, sign: -1, exp: 9 }
];
let nextChargeId = 3;

let probes = [
  { id: 1, x: 500, y: 200 }
];
let nextProbeId = 2;

function chargeCountE(c) { return Math.pow(10, c.exp); }
function chargeCoulombs(c) { return c.sign * chargeCountE(c) * E_CHARGE; }
// Fixed regardless of charge amount — the ball is just a marker for "a
// charge sits here," not a size encoding of how strong it is (that's what
// the field arrows and the probe are for).
const CHARGE_RADIUS = 14;
function chargeRadius(c) { return CHARGE_RADIUS; }

function spawnCharge(sign, x, y) {
  const c = { id: nextChargeId++, x, y, sign, exp: 9 };
  charges.push(c);
  selectEntity('charge', c.id);
  return c;
}
function spawnProbe(x, y) {
  const p = { id: nextProbeId++, x, y };
  probes.push(p);
  selectEntity('probe', p.id);
  return p;
}

// Net field at a canvas point, in real N/C — the vector sum of every
// charge's Coulomb contribution. Direction always uses the true (unclamped)
// direction to the charge; only the 1/r^2 magnitude is clamped near a
// charge's own radius, so the field doesn't blow up to infinity right at
// its surface.
function fieldAt(xPx, yPx) {
  let ex = 0, ey = 0;
  for (const c of charges) {
    const dxPx = xPx - c.x, dyPx = yPx - c.y;
    const rPx = Math.hypot(dxPx, dyPx);
    if (rPx < 1e-6) continue;
    const rMinPx = Math.max(8, chargeRadius(c) * 0.8);
    const rM = Math.max(rPx, rMinPx) * M_PER_PX;
    const strength = (COULOMB_K * chargeCoulombs(c)) / (rM * rM); // N/C
    ex += (strength * dxPx) / rPx;
    ey += (strength * dyPx) / rPx;
  }
  return { x: ex, y: ey };
}

// =====================================================================
// FIELD-ARROW DISPLAY SCALING
//
// Coulomb's law spans many orders of magnitude between right next to a
// charge and the far corner of the board. A plain linear saturation curve
// on the raw magnitude leaves almost the whole board looking blank, so the
// magnitude is compressed through a fractional power first (like a dB
// scale) before mapping it to an arrow length/opacity.
// =====================================================================

let arrowSpacing = 45;
let sensitivity = 1;
const ARROW_MIN = 3;
const ARROW_MAX = 24;
const COMPRESS_GAMMA = 0.3;
const HALF_SAT_C = 3; // compressed-magnitude value that maps to half of ARROW_MAX

function compressedFrac(mag) {
  const c = Math.pow(mag * sensitivity, COMPRESS_GAMMA);
  return c / (c + HALF_SAT_C);
}
function arrowLenFor(mag) { return ARROW_MIN + (ARROW_MAX - ARROW_MIN) * compressedFrac(mag); }
function arrowAlphaFor(mag) { return 0.2 + 0.7 * compressedFrac(mag); }

// =====================================================================
// INTERACTION — charges and probes share one selection/drag lifecycle.
// =====================================================================

function canvasPointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (LOGICAL_WIDTH / rect.width),
    y: (e.clientY - rect.top) * (LOGICAL_HEIGHT / rect.height)
  };
}

const PROBE_BODY_W = 104, PROBE_BODY_H = 40, PROBE_GAP = 10;

function hitTestAny(pt) {
  let best = null, bestKind = null, bestDist = Infinity;
  for (const c of charges) {
    const d = Math.hypot(pt.x - c.x, pt.y - c.y);
    if (d <= chargeRadius(c) + 4 && d < bestDist) { bestDist = d; best = c; bestKind = 'charge'; }
  }
  for (const p of probes) {
    const bodyX = p.x - PROBE_BODY_W / 2, bodyY = p.y - PROBE_GAP - PROBE_BODY_H;
    const inBody = pt.x >= bodyX && pt.x <= bodyX + PROBE_BODY_W && pt.y >= bodyY && pt.y <= bodyY + PROBE_BODY_H;
    const d = Math.hypot(pt.x - p.x, pt.y - p.y);
    const hit = inBody || d <= 14;
    const effDist = inBody ? 0 : d;
    if (hit && effDist < bestDist) { bestDist = effDist; best = p; bestKind = 'probe'; }
  }
  return best ? { kind: bestKind, obj: best } : null;
}

let dragging = null; // { kind, id, dx, dy }

canvas.addEventListener('pointerdown', (e) => {
  const pt = canvasPointFromEvent(e);
  const hit = hitTestAny(pt);
  if (hit) {
    selectEntity(hit.kind, hit.obj.id);
    dragging = { kind: hit.kind, id: hit.obj.id, dx: pt.x - hit.obj.x, dy: pt.y - hit.obj.y };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  selectEntity(null, null);
});

canvas.addEventListener('pointermove', (e) => {
  const pt = canvasPointFromEvent(e);
  if (dragging) {
    const arr = dragging.kind === 'charge' ? charges : probes;
    const obj = arr.find((o) => o.id === dragging.id);
    if (obj) {
      obj.x = clamp(pt.x - dragging.dx, 10, LOGICAL_WIDTH - 10);
      obj.y = clamp(pt.y - dragging.dy, 10, LOGICAL_HEIGHT - 10);
    }
    canvas.style.cursor = 'grabbing';
    return;
  }
  canvas.style.cursor = hitTestAny(pt) ? 'pointer' : 'default';
});

canvas.addEventListener('pointerup', (e) => {
  dragging = null;
  canvas.releasePointerCapture(e.pointerId);
  canvas.style.cursor = 'default';
});

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
  if (!selected) return;
  if (selected.kind === 'charge') charges = charges.filter((c) => c.id !== selected.id);
  else probes = probes.filter((p) => p.id !== selected.id);
  selectEntity(null, null);
  e.preventDefault();
});

// ---- palette: drag a "+"/"-" charge or a probe from the panel onto the board ----
// Same pointer-based drag-and-ghost pattern as circuit.js's part palette.
let paletteDrag = null; // { kind: 'charge'|'probe', sign?, pointerId }
const dragGhost = document.getElementById('dragGhost');

document.querySelectorAll('#panel button[data-drag]').forEach((btn) => {
  const kind = btn.dataset.drag === 'probe' ? 'probe' : 'charge';
  const sign = kind === 'charge' ? parseInt(btn.dataset.sign, 10) : null;
  btn.addEventListener('pointerdown', (e) => {
    paletteDrag = { kind, sign, pointerId: e.pointerId };
    btn.classList.add('dragSource');
    dragGhost.textContent = kind === 'probe' ? '⏚' : (sign > 0 ? '+' : '−');
    dragGhost.style.background = kind === 'probe' ? '#3a3f4a' : (sign > 0 ? '#d64545' : '#3a72c4');
    dragGhost.style.borderRadius = kind === 'probe' ? '5px' : '50%';
    dragGhost.style.left = e.clientX + 'px';
    dragGhost.style.top = e.clientY + 'px';
    dragGhost.style.display = 'flex';
    btn.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  btn.addEventListener('pointermove', (e) => {
    if (!paletteDrag || paletteDrag.pointerId !== e.pointerId) return;
    dragGhost.style.left = e.clientX + 'px';
    dragGhost.style.top = e.clientY + 'px';
  });
  btn.addEventListener('pointerup', (e) => {
    if (!paletteDrag || paletteDrag.pointerId !== e.pointerId) return;
    btn.classList.remove('dragSource');
    dragGhost.style.display = 'none';
    if (document.elementFromPoint(e.clientX, e.clientY) === canvas) {
      const pt = canvasPointFromEvent(e);
      if (paletteDrag.kind === 'probe') spawnProbe(pt.x, pt.y);
      else spawnCharge(paletteDrag.sign, pt.x, pt.y);
    }
    paletteDrag = null;
    btn.releasePointerCapture(e.pointerId);
  });
  btn.addEventListener('pointercancel', () => {
    paletteDrag = null;
    btn.classList.remove('dragSource');
    dragGhost.style.display = 'none';
  });
});

document.getElementById('clearBoardBtn').addEventListener('click', () => {
  charges = [];
  probes = [];
  selectEntity(null, null);
});

// ---- field display controls ----
const showArrowsBox = document.getElementById('showArrows');
const spacingSlider = document.getElementById('spacingSlider');
const spacingValue = document.getElementById('spacingValue');
const sensitivitySlider = document.getElementById('sensitivitySlider');
const sensitivityValue = document.getElementById('sensitivityValue');

spacingSlider.addEventListener('input', () => {
  arrowSpacing = parseFloat(spacingSlider.value);
  spacingValue.textContent = arrowSpacing.toFixed(0) + ' px';
});
sensitivitySlider.addEventListener('input', () => {
  sensitivity = parseFloat(sensitivitySlider.value);
  sensitivityValue.textContent = sensitivity.toFixed(1) + '×';
});

document.getElementById('boardInfo').textContent =
  'Board: ' + BOARD_WIDTH_CM.toFixed(1) + ' cm × ' + BOARD_HEIGHT_CM.toFixed(1) + ' cm';

// ---- inspector ----
let selected = null; // { kind: 'charge'|'probe', id }
const inspector = document.getElementById('inspector');
const inspTitle = document.getElementById('inspTitle');
const inspFields = document.getElementById('inspFields');

function selectEntity(kind, id) {
  selected = kind && id != null ? { kind, id } : null;
  if (!selected) { inspector.style.display = 'none'; return; }

  if (kind === 'charge') {
    const c = charges.find((c) => c.id === id);
    if (!c) { selected = null; inspector.style.display = 'none'; return; }
    inspector.style.display = 'block';
    inspTitle.textContent = (c.sign > 0 ? 'Positive' : 'Negative') + ' charge';
    inspFields.innerHTML = '';

    const row = document.createElement('div');
    row.className = 'row';
    const labelRow = document.createElement('div');
    labelRow.className = 'valueLabel';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = 'Charge';
    const numSpan = document.createElement('span');
    numSpan.textContent = formatSci(chargeCountE(c)) + ' e';
    labelRow.appendChild(nameSpan);
    labelRow.appendChild(numSpan);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0; slider.max = 13; slider.step = 0.1;
    slider.value = c.exp;

    const coulombLine = document.createElement('div');
    coulombLine.style.cssText = 'font-size:10px;color:#888;margin-top:4px;';
    coulombLine.textContent = '= ' + formatSci(chargeCountE(c) * E_CHARGE) + ' C';

    slider.addEventListener('input', () => {
      c.exp = parseFloat(slider.value);
      numSpan.textContent = formatSci(chargeCountE(c)) + ' e';
      coulombLine.textContent = '= ' + formatSci(chargeCountE(c) * E_CHARGE) + ' C';
    });

    row.appendChild(labelRow);
    row.appendChild(slider);
    row.appendChild(coulombLine);
    inspFields.appendChild(row);
  } else {
    const p = probes.find((p) => p.id === id);
    if (!p) { selected = null; inspector.style.display = 'none'; return; }
    inspector.style.display = 'block';
    inspTitle.textContent = 'Field probe';
    inspFields.innerHTML = '<div style="font-size:11px;color:#999;margin-bottom:4px;">Drag it anywhere on the board — its reading updates live.</div>';
  }
}

document.getElementById('deleteSelectedBtn').addEventListener('click', () => {
  if (!selected) return;
  if (selected.kind === 'charge') charges = charges.filter((c) => c.id !== selected.id);
  else probes = probes.filter((p) => p.id !== selected.id);
  selectEntity(null, null);
});

// =====================================================================
// RENDERING
// =====================================================================

function drawArrow(x1, y1, x2, y2, alpha) {
  ctx.strokeStyle = `rgba(58, 74, 99, ${alpha})`;
  ctx.fillStyle = `rgba(58, 74, 99, ${alpha})`;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  const ang = Math.atan2(y2 - y1, x2 - x1);
  const headLen = 5;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(ang - 0.45), y2 - headLen * Math.sin(ang - 0.45));
  ctx.lineTo(x2 - headLen * Math.cos(ang + 0.45), y2 - headLen * Math.sin(ang + 0.45));
  ctx.closePath();
  ctx.fill();
}

function drawFieldArrows() {
  if (charges.length === 0) return;
  const spacing = arrowSpacing;
  const startX = ((LOGICAL_WIDTH % spacing) / 2) || spacing / 2;
  const startY = ((LOGICAL_HEIGHT % spacing) / 2) || spacing / 2;
  for (let gx = startX; gx < LOGICAL_WIDTH; gx += spacing) {
    for (let gy = startY; gy < LOGICAL_HEIGHT; gy += spacing) {
      let insideCharge = false;
      for (const c of charges) {
        if (Math.hypot(gx - c.x, gy - c.y) < chargeRadius(c) + 6) { insideCharge = true; break; }
      }
      if (insideCharge) continue;

      const E = fieldAt(gx, gy);
      const mag = Math.hypot(E.x, E.y);
      if (mag < 1e-12) continue;
      const len = arrowLenFor(mag);
      const alpha = arrowAlphaFor(mag);
      const ux = E.x / mag, uy = E.y / mag;
      const hx = (ux * len) / 2, hy = (uy * len) / 2;
      drawArrow(gx - hx, gy - hy, gx + hx, gy + hy, alpha);
    }
  }
}

function drawCharges() {
  for (const c of charges) {
    const r = chargeRadius(c);
    const isSel = selected && selected.kind === 'charge' && selected.id === c.id;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fillStyle = c.sign > 0 ? '#d64545' : '#3a72c4';
    ctx.fill();
    ctx.strokeStyle = isSel ? '#f5a623' : (c.sign > 0 ? '#7a1f1f' : '#1f3f7a');
    ctx.lineWidth = isSel ? 3 : 1.5;
    ctx.stroke();

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c.x - r * 0.45, c.y);
    ctx.lineTo(c.x + r * 0.45, c.y);
    if (c.sign > 0) {
      ctx.moveTo(c.x, c.y - r * 0.45);
      ctx.lineTo(c.x, c.y + r * 0.45);
    }
    ctx.stroke();
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawProbes() {
  for (const p of probes) {
    const isSel = selected && selected.kind === 'probe' && selected.id === p.id;
    const bodyX = p.x - PROBE_BODY_W / 2, bodyY = p.y - PROBE_GAP - PROBE_BODY_H;

    // connector triangle from body down to the exact sensing point
    ctx.fillStyle = '#2b2f38';
    ctx.beginPath();
    ctx.moveTo(p.x - 6, bodyY + PROBE_BODY_H);
    ctx.lineTo(p.x + 6, bodyY + PROBE_BODY_H);
    ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.fill();

    // body
    roundRect(bodyX, bodyY, PROBE_BODY_W, PROBE_BODY_H, 6);
    ctx.fillStyle = '#2b2f38';
    ctx.fill();
    ctx.strokeStyle = isSel ? '#f5a623' : '#555';
    ctx.lineWidth = isSel ? 2.5 : 1.5;
    ctx.stroke();

    // screen
    const pad = 4;
    roundRect(bodyX + pad, bodyY + pad, PROBE_BODY_W - 2 * pad, PROBE_BODY_H - 2 * pad, 3);
    ctx.fillStyle = '#cdf2d8';
    ctx.fill();

    const E = fieldAt(p.x, p.y);
    const mag = Math.hypot(E.x, E.y);
    ctx.fillStyle = '#0a3d1f';
    ctx.font = '9px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('E=' + formatSci(mag) + 'N/C', p.x, bodyY + PROBE_BODY_H / 2 + 3);
    ctx.textAlign = 'left';

    // exact sensing point
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = isSel ? '#f5a623' : '#333';
    ctx.fill();
  }
}

function render() {
  ctx.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
  if (showArrowsBox.checked) drawFieldArrows();
  drawCharges();
  drawProbes();
}

function loop() {
  render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);