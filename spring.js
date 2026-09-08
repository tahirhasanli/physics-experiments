const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const ANCHOR_X = canvas.width / 2;
const ANCHOR_Y_PX = 90;
const TABLE_Y = canvas.height - 110; // px, top edge of the tabletop the stand sits on

// The space between the anchor and the tabletop represents about this many
// meters of the real world — sized like a benchtop kit, not a multi-meter
// rig, so a realistic spring (tens of cm) and its coil-bound minimum (a
// few mm) both land at a sane, visible pixel size instead of a sliver.
const WORLD_HEIGHT_M = 1.0;
const BASE_PX_PER_METER = (TABLE_Y - ANCHOR_Y_PX) / WORLD_HEIGHT_M;

const PHYSICS_DT = 0.001;
const MAX_SUBSTEPS_PER_FRAME = 2000;
const SPRING_COILS = 10;       // number of turns in the coiled spring

// ---- the spring's wire gets thicker (and heavier) as k goes up ----
// Modeled as a uniform stainless-steel helical coil with a fixed number of
// turns and coil diameter sized like a real small "harmonic motion" spring
// (the ~3.5 cm OD stainless demo spring sold by Eisco/Geyer). Wire diameter
// is solved from the standard coil-spring rate formula k = G d^4/(8 D^3 N),
// so a stiffer spring is a physically thicker (and heavier) one, exactly
// like a real spring set where the high-k spring in the box is the one
// wound from noticeably thicker wire.
const SPRING_MATERIAL_DENSITY = 7900; // kg/m^3 — stainless steel (302/304) spring wire
const SPRING_SHEAR_MODULUS = 70e9;    // Pa — stainless steel spring wire
const SPRING_COIL_DIAMETER_M = 0.032; // m — mean coil diameter, ~3.5 cm OD

function springWireDiameter(k) {
  // k = G d^4 / (8 D^3 N)  =>  d = (8 k D^3 N / G) ^ (1/4)
  const D = SPRING_COIL_DIAMETER_M;
  return Math.pow((8 * k * D * D * D * SPRING_COILS) / SPRING_SHEAR_MODULUS, 0.25);
}

function springMassFromK(k) {
  const d = springWireDiameter(k);
  const wireLength = SPRING_COILS * Math.PI * SPRING_COIL_DIAMETER_M;
  const crossSectionArea = Math.PI * (d / 2) * (d / 2);
  return SPRING_MATERIAL_DENSITY * wireLength * crossSectionArea;
}

// Fully coil-bound (turns stacked flush) — also grows with k, since the
// wire itself is thicker.
function minSpringLength(k) {
  return SPRING_COILS * springWireDiameter(k);
}

// No camera zoom: k and mass are expected to stay in ranges whose max
// stretch always fits within WORLD_HEIGHT_M, so the scale below is fixed.

const CONFIG = {
  restLength: 0.1,   // m — a small benchtop spring, ~10 cm
  k: 25,             // N/m
  mass: 0,           // kg — starts with nothing hung on the spring
  springMass: springMassFromK(25), // kg — derived from k; kept in sync by the k slider
  damping: 0.4,      // N*s/m
  gravity: 9.8,       // m/s^2
  showEquilibrium: true,
  showNaturalLength: true,
  showVelocityVector: true,
  showEnergyGraph: false,
  running: true
};

// state.y = distance from anchor to mass, in meters (i.e. current spring length)
const state = {
  y: equilibriumLength(),
  v: 0
};

let peakEnergy = 1e-6;
let dragging = false;

// ---- spare weights on the table (draggable onto the spring) ----
const TABLE_WEIGHTS = [
  { id: 'w50', grams: 50, homeX: 55 },
  { id: 'w100', grams: 100, homeX: 102 },
  { id: 'w200', grams: 200, homeX: 158 }
];
let springWeightId = null;    // which TABLE_WEIGHTS entry (if any) is currently hanging
let draggingWeightId = null;  // which weight is being carried by the pointer right now
let dragPointer = { x: 0, y: 0 };

// ---- laser + light sensor (free-standing, draggable anywhere on the canvas) ----
const LASER_W = 34, LASER_H = 20;
const SENSOR_W = 26, SENSOR_H = 22;
const OPTICS_DOCK_W = 110;
const OPTICS_DOCK_H = 46;
const OPTICS_DOCK_X = canvas.width - 280;   // a small crate on the table, clear of the weights and the energy panel
const OPTICS_DOCK_TOP = TABLE_Y - OPTICS_DOCK_H - 2;
const OPTICS_DOCK_CY = OPTICS_DOCK_TOP + OPTICS_DOCK_H / 2;

// x/y are the housing's center, in canvas px. Both start tucked in the dock
// and can be dragged anywhere; there's no snap-back — wherever they're
// dropped is where they stay.
const laserItem = { x: OPTICS_DOCK_X - 26, y: OPTICS_DOCK_CY };
const sensorItem = { x: OPTICS_DOCK_X + 26, y: OPTICS_DOCK_CY };

// ---- 60 cm ruler, tucked to the side, draggable anywhere on the canvas ----
const RULER_LENGTH_M = 0.6;
const RULER_LENGTH_PX = metersToPx(RULER_LENGTH_M);
const RULER_WIDTH_PX = 20;
const RULER_HOME_X = 235;     // tucked between the stopwatch panel and the anchor pole
const RULER_HOME_TOP_Y = 140;

// x/y is the ruler's top-center point; it only translates (no rotation), so
// it's always drawn vertically, RULER_LENGTH_PX tall.
const rulerItem = { x: RULER_HOME_X, y: RULER_HOME_TOP_Y };

let draggingOptic = null; // 'laser' | 'sensor' | 'ruler' | null
let opticDragOffset = { x: 0, y: 0 };

function opticItemFor(kind) {
  if (kind === 'laser') return laserItem;
  if (kind === 'sensor') return sensorItem;
  if (kind === 'ruler') return rulerItem;
  return null;
}

function equilibriumLength() {
  return CONFIG.restLength + (CONFIG.mass * CONFIG.gravity) / CONFIG.k;
}

// A real spring's own mass resists acceleration too. Treating it as a chain
// of small masses with velocity increasing linearly from the fixed end (0)
// to the hanging end (v) and integrating its kinetic energy shows it behaves
// like an extra 1/3 of the spring's mass sitting at the hanging end —
// Rayleigh's classic result. This only changes the system's inertia (and so
// its oscillation frequency); it doesn't shift the equilibrium point, which
// still balances against the attached mass alone.
function effectiveMass() {
  return CONFIG.mass + CONFIG.springMass / 3;
}

function metersToPx(m) { return m * BASE_PX_PER_METER; }
function pxToMeters(px) { return px / BASE_PX_PER_METER; }
function massPxY() { return ANCHOR_Y_PX + metersToPx(state.y); } // where the hook meets the spring

function massRadiusPx() {
  return Math.min(55, Math.max(14, 14 + CONFIG.mass * 24));
}

// Size of the hooked mass (hook + cylinder), independent of its position —
// used both to draw it and to keep it from being dragged into the table.
// With nothing hung on the spring yet, there's no cylinder at all — just
// the bare hook — so its footprint collapses to the hook alone.
function massSizePx() {
  const r = massRadiusPx();
  const hookH = 15;
  const cylH = CONFIG.mass > 0 ? r * 1.05 : 0;
  return { r, hookH, cylH, totalH: hookH + cylH };
}

// Hooked masses have a fixed-ish look regardless of size: a short wire hook
// on top of a squat cylinder. Returns the full vertical layout in px.
function massLayout() {
  const { r, hookH, cylH } = massSizePx();
  const hookTopY = massPxY();          // spring's last coil meets here
  const cylTopY = hookTopY + hookH;    // cylinder cap starts here
  const cylBottomY = cylTopY + cylH;
  return { r, hookH, cylH, hookTopY, cylTopY, cylBottomY };
}

function computeAcceleration(y, v) {
  const stretch = y - CONFIG.restLength;
  const springForce = -CONFIG.k * stretch;
  const gravityForce = CONFIG.mass * CONFIG.gravity;
  const dampingForce = -CONFIG.damping * v;
  const netForce = gravityForce + springForce + dampingForce;
  return netForce / effectiveMass();
}

function stepPhysics(dt) {
  const a = computeAcceleration(state.y, state.v);
  state.v += a * dt;
  state.y += state.v * dt;
  const minLength = minSpringLength(CONFIG.k);
  if (state.y < minLength) {
    state.y = minLength;
    if (state.v < 0) state.v = 0;
  }
}

// ---- pointer interaction (drag the mass) ----

function canvasYFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  return (e.clientY - rect.top) * (canvas.height / rect.height);
}

function canvasPointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height)
  };
}

function isNearMass(py) {
  const { hookTopY, cylBottomY } = massLayout();
  return py >= hookTopY - 14 && py <= cylBottomY + 12;
}

function updateDragPosition(py) {
  const minPy = ANCHOR_Y_PX + metersToPx(minSpringLength(CONFIG.k));
  const { totalH } = massSizePx();
  const maxPy = TABLE_Y - 15 - totalH; // keep the whole cylinder clear of the tabletop
  const clampedPy = Math.min(maxPy, Math.max(minPy, py));
  state.y = pxToMeters(clampedPy - ANCHOR_Y_PX);
  state.v = 0;
}

function isPointInRect(pt, cx, cy, w, h) {
  return pt.x >= cx - w / 2 && pt.x <= cx + w / 2 && pt.y >= cy - h / 2 && pt.y <= cy + h / 2;
}

// Hit-test the laser and sensor with a little extra margin, so they're easy
// to grab even though the housings themselves are small.
function hitTestOptics(pt) {
  if (isPointInRect(pt, laserItem.x, laserItem.y, LASER_W + 12, LASER_H + 12)) return 'laser';
  if (isPointInRect(pt, sensorItem.x, sensorItem.y, SENSOR_W + 12, SENSOR_H + 12)) return 'sensor';
  if (isPointInRect(pt, rulerItem.x, rulerItem.y + RULER_LENGTH_PX / 2, RULER_WIDTH_PX + 10, RULER_LENGTH_PX + 10)) return 'ruler';
  return null;
}

// Finds a table weight (not already hanging) whose resting position is
// under the given point, so it can be picked up.
function findDraggableWeightAt(pt) {
  for (const w of TABLE_WEIGHTS) {
    if (w.id === springWeightId) continue; // already on the spring
    const r = tableWeightRadius(w.grams);
    const bottomY = TABLE_Y - 2;
    const cy = bottomY - (r * 0.35) / 2;
    if (Math.hypot(pt.x - w.homeX, pt.y - cy) <= r + 10) return w;
  }
  return null;
}

// The column above the table, roughly where the spring/mass hangs — drop a
// carried weight here to attach it.
function isSpringDropZone(pt) {
  return pt.x > ANCHOR_X - 70 && pt.x < ANCHOR_X + 70 &&
    pt.y > ANCHOR_Y_PX - 20 && pt.y < TABLE_Y - 50;
}

// Hangs the given weight on the spring. Whatever was hanging before (if
// anything) simply becomes eligible to be drawn on the table again, since
// each weight always renders at its own home slot when it isn't the one
// on the spring or being dragged.
function attachWeightToSpring(weightId) {
  const weight = TABLE_WEIGHTS.find((w) => w.id === weightId);
  if (!weight) return;
  springWeightId = weightId;
  CONFIG.mass = weight.grams / 1000;
  massSlider.value = CONFIG.mass;
  massValue.textContent = CONFIG.mass.toFixed(2);
}

canvas.addEventListener('pointerdown', (e) => {
  const pt = canvasPointFromEvent(e);
  const opticHit = hitTestOptics(pt);
  const hitWeight = findDraggableWeightAt(pt);
  if (opticHit) {
    draggingOptic = opticHit;
    const item = opticItemFor(opticHit);
    opticDragOffset.x = pt.x - item.x;
    opticDragOffset.y = pt.y - item.y;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  } else if (hitWeight) {
    draggingWeightId = hitWeight.id;
    dragPointer = pt;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  } else if (isNearMass(pt.y)) {
    dragging = true;
    peakEnergy = 1e-6;
    canvas.setPointerCapture(e.pointerId);
    updateDragPosition(pt.y);
    canvas.style.cursor = 'grabbing';
  }
});

canvas.addEventListener('pointermove', (e) => {
  const pt = canvasPointFromEvent(e);
  if (draggingOptic) {
    const item = opticItemFor(draggingOptic);
    const maxY = draggingOptic === 'ruler' ? canvas.height - 8 - RULER_LENGTH_PX : canvas.height - 8;
    const minX = draggingOptic === 'ruler' ? 8 + RULER_WIDTH_PX / 2 : 8;
    const maxX = draggingOptic === 'ruler' ? canvas.width - 8 - RULER_WIDTH_PX / 2 : canvas.width - 8;
    item.x = Math.min(maxX, Math.max(minX, pt.x - opticDragOffset.x));
    item.y = Math.min(maxY, Math.max(8, pt.y - opticDragOffset.y));
  } else if (draggingWeightId) {
    dragPointer = pt;
  } else if (dragging) {
    updateDragPosition(pt.y);
  } else {
    canvas.style.cursor = (hitTestOptics(pt) || findDraggableWeightAt(pt) || isNearMass(pt.y)) ? 'grab' : 'default';
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (draggingOptic) {
    draggingOptic = null;
    canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = 'default';
  } else if (draggingWeightId) {
    const pt = canvasPointFromEvent(e);
    if (isSpringDropZone(pt)) {
      attachWeightToSpring(draggingWeightId);
    }
    draggingWeightId = null;
    canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = 'default';
  } else if (dragging) {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
    const py = canvasYFromEvent(e);
    canvas.style.cursor = isNearMass(py) ? 'grab' : 'default';
  }
});

// ---- drawing ----

function drawTable() {
  const grad = ctx.createLinearGradient(0, TABLE_Y, 0, canvas.height);
  grad.addColorStop(0, '#c68a4e');
  grad.addColorStop(1, '#8a5a2e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, TABLE_Y, canvas.width, canvas.height - TABLE_Y);

  // faint wood-grain streaks, deterministic so they don't jitter every frame
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 1;
  for (let x = 6; x < canvas.width; x += 27) {
    const dy = (x * 13) % 9;
    ctx.beginPath();
    ctx.moveTo(x, TABLE_Y + 6 + dy);
    ctx.lineTo(x + 16, canvas.height - 6);
    ctx.stroke();
  }

  ctx.strokeStyle = '#6b4423';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, TABLE_Y);
  ctx.lineTo(canvas.width, TABLE_Y);
  ctx.stroke();
}

function tableWeightRadius(grams) {
  return 10 + (grams / 200) * 14; // 50g ≈ 13.5px, 100g ≈ 17px, 200g ≈ 24px
}

// A spare hooked weight — same black-cylinder look as the hanging mass,
// just squat and viewed from the side, with a small loop standing in for
// its hook. Used both resting on the table and while being carried, with
// bottomY being wherever it currently sits (table height, or the pointer).
function drawWeightAt(x, bottomY, grams) {
  const r = tableWeightRadius(grams);
  const h = r * 0.35;
  const topY = bottomY - h;

  // contact shadow
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  ctx.beginPath();
  ctx.ellipse(x, bottomY + 2, r * 1.05, r * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();

  // body
  ctx.fillStyle = '#1c1c1c';
  ctx.fillRect(x - r, topY, r * 2, h);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - r, topY);
  ctx.lineTo(x - r, bottomY);
  ctx.moveTo(x + r, topY);
  ctx.lineTo(x + r, bottomY);
  ctx.stroke();

  // bottom + top caps
  ctx.fillStyle = '#141414';
  ctx.beginPath();
  ctx.ellipse(x, bottomY, r, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2b2b2b';
  ctx.beginPath();
  ctx.ellipse(x, topY, r, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.stroke();

  // small hook loop
  ctx.strokeStyle = '#767676';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, topY - r * 0.3, r * 0.22, 0, Math.PI * 2);
  ctx.stroke();

  // gram label, above the weight so it stays readable at small sizes
  ctx.fillStyle = '#fff3d9';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(grams + ' g', x, topY - r * 0.6 - 6);
}

function drawTableWeights() {
  TABLE_WEIGHTS.forEach((w) => {
    if (w.id === springWeightId || w.id === draggingWeightId) return; // drawn elsewhere
    drawWeightAt(w.homeX, TABLE_Y - 2, w.grams);
  });
}

// The weight currently in hand, drawn last so it always appears on top of
// the stand and spring while being carried toward (or away from) the hook.
function drawDraggedWeight() {
  if (!draggingWeightId) return;
  const w = TABLE_WEIGHTS.find((x) => x.id === draggingWeightId);
  if (!w) return;
  drawWeightAt(dragPointer.x, dragPointer.y, w.grams);
}

function drawDropZoneHint() {
  if (!draggingWeightId) return;
  const x0 = ANCHOR_X - 70;
  const y0 = ANCHOR_Y_PX - 20;
  ctx.save();
  ctx.strokeStyle = 'rgba(26,115,199,0.5)';
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 2;
  ctx.strokeRect(x0, y0, 140, TABLE_Y - 50 - y0);
  ctx.restore();
  ctx.fillStyle = 'rgba(26,115,199,0.8)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('drop on the spring to hang it', ANCHOR_X, y0 - 8);
}

// Small open crate on the table where the laser and sensor sit when not
// placed elsewhere — purely decorative, doesn't constrain where they can go.
function drawOpticsDock() {
  const x0 = OPTICS_DOCK_X - OPTICS_DOCK_W / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.06)';
  ctx.fillRect(x0, OPTICS_DOCK_TOP, OPTICS_DOCK_W, OPTICS_DOCK_H);
  ctx.strokeStyle = '#8a5a2e';
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x0, OPTICS_DOCK_TOP, OPTICS_DOCK_W, OPTICS_DOCK_H);
  ctx.setLineDash([]);
  ctx.fillStyle = '#6b4423';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('spare optics', OPTICS_DOCK_X, OPTICS_DOCK_TOP - 6);
}

// The laser always shoots a beam rightward from its aperture at a fixed
// height. It's blocked by the hanging mass if the mass sits in the way,
// and "detected" only if it reaches the sensor unobstructed.
function computeBeam() {
  const originX = laserItem.x + LASER_W / 2;
  const originY = laserItem.y;
  const tol = 6; // px — how closely the sensor's lens must line up with the beam

  const sensorAligned = (sensorItem.x - SENSOR_W / 2) > originX &&
    Math.abs(sensorItem.y - originY) <= tol;

  const { r, cylTopY, cylBottomY } = massLayout();
  // a bare hook is too thin to meaningfully block the beam — only a real
  // hanging mass does
  const massAtBeamHeight = CONFIG.mass > 0 &&
    originY >= cylTopY - 2 && originY <= cylBottomY + 2;
  const massLeft = ANCHOR_X - r, massRight = ANCHOR_X + r;
  const sensorLeftEdge = sensorItem.x - SENSOR_W / 2;
  const massInPath = massAtBeamHeight && massRight > originX &&
    (!sensorAligned || massLeft < sensorLeftEdge);

  let endX;
  if (massInPath) {
    endX = massLeft;
  } else if (sensorAligned) {
    endX = sensorLeftEdge;
  } else {
    endX = canvas.width - 4;
  }

  return { originX, originY, endX, detected: sensorAligned && !massInPath };
}

function drawBeam(beam) {
  if (beam.endX <= beam.originX) return;
  ctx.strokeStyle = beam.detected ? 'rgba(255,30,30,0.9)' : 'rgba(255,30,30,0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(beam.originX, beam.originY);
  ctx.lineTo(beam.endX, beam.originY);
  ctx.stroke();
}

// Small dark housing with a red aperture on its right face, matching a
// typical laser-diode module.
function drawLaserHousing(item, isDragging) {
  const w = LASER_W, h = LASER_H;
  const x0 = item.x - w / 2, y0 = item.y - h / 2;

  ctx.fillStyle = '#2b2b2e';
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, w, h);

  ctx.strokeStyle = '#555';
  ctx.beginPath();
  ctx.moveTo(x0 + w * 0.33, y0 + 3);
  ctx.lineTo(x0 + w * 0.33, y0 + h - 3);
  ctx.moveTo(x0 + w * 0.66, y0 + 3);
  ctx.lineTo(x0 + w * 0.66, y0 + h - 3);
  ctx.stroke();

  ctx.fillStyle = '#ff2d2d';
  ctx.beginPath();
  ctx.arc(x0 + w, item.y, 3.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#333';
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('LASER', item.x, y0 - 5);

  if (isDragging) {
    ctx.strokeStyle = 'rgba(26,115,199,0.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 - 3, y0 - 3, w + 6, h + 6);
  }
}

// Small housing with a light-receiving lens on its left face and a status
// LED that lights up green while it's catching the beam.
function drawSensorHousing(item, isDetecting, isDragging) {
  const w = SENSOR_W, h = SENSOR_H;
  const x0 = item.x - w / 2, y0 = item.y - h / 2;

  ctx.fillStyle = '#2b2b2e';
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, w, h);

  ctx.fillStyle = '#8fd3ff';
  ctx.beginPath();
  ctx.arc(x0, item.y, 3.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = isDetecting ? '#3ddc55' : '#5a1414';
  ctx.beginPath();
  ctx.arc(item.x, y0 + 4, 2.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#333';
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('SENSOR', item.x, y0 - 5);

  ctx.fillStyle = isDetecting ? '#1f9d55' : '#888';
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillText(isDetecting ? 'light detected' : 'no light', item.x, y0 + h + 12);

  if (isDragging) {
    ctx.strokeStyle = 'rgba(26,115,199,0.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 - 3, y0 - 3, w + 6, h + 6);
  }
}

// A 60 cm ruler — real-world scaled, so its printed cm marks line up with
// the spring's own meters-to-px scale. Vertical only (translates, doesn't
// rotate); item.x/y is its top-center point.
function drawRuler(item, isDragging) {
  const w = RULER_WIDTH_PX;
  const x0 = item.x - w / 2;
  const y0 = item.y;
  const y1 = item.y + RULER_LENGTH_PX;

  ctx.fillStyle = '#e8d9a0';
  ctx.fillRect(x0, y0, w, y1 - y0);
  ctx.strokeStyle = '#8a6d1f';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, w, y1 - y0);

  // tick marks: 1 cm minor, 10 cm major (with a printed number)
  ctx.strokeStyle = '#5c4a15';
  ctx.font = '8px system-ui, sans-serif';
  ctx.fillStyle = '#5c4a15';
  ctx.textAlign = 'left';
  for (let cm = 0; cm <= 60; cm++) {
    const y = y0 + metersToPx(cm / 100);
    const isMajor = cm % 10 === 0;
    const tickLen = isMajor ? w * 0.6 : w * 0.3;
    ctx.lineWidth = isMajor ? 1.4 : 0.8;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + tickLen, y);
    ctx.stroke();
    if (isMajor && cm > 0) {
      ctx.fillText(String(cm), x0 + tickLen + 2, y + 3);
    }
  }

  ctx.fillStyle = '#5c4a15';
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('0', item.x, y0 - 5);

  if (isDragging) {
    ctx.strokeStyle = 'rgba(26,115,199,0.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 - 3, y0 - 3, w + 6, y1 - y0 + 6);
  }
}

function drawAnchor() {
  const poleX = ANCHOR_X - 180;
  const poleTop = 10;
  const baseW = 150;
  const baseH = 16;
  const baseY = TABLE_Y - baseH;
  const rodEndX = ANCHOR_X + 15;

  // base plate, sitting on the table
  ctx.fillStyle = '#8f8f98';
  ctx.fillRect(poleX - baseW / 2, baseY, baseW, baseH);
  ctx.fillStyle = '#b0b0b8';
  ctx.fillRect(poleX - baseW / 2, baseY, baseW, baseH * 0.4);
  ctx.strokeStyle = '#4d4d54';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(poleX - baseW / 2, baseY, baseW, baseH);

  // vertical support pole, hatched like a retort stand
  ctx.strokeStyle = '#7d7d86';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(poleX, poleTop);
  ctx.lineTo(poleX, baseY);
  ctx.stroke();

  ctx.strokeStyle = '#4d4d54';
  ctx.lineWidth = 1.5;
  for (let y = poleTop + 8; y < baseY; y += 14) {
    ctx.beginPath();
    ctx.moveTo(poleX - 4, y);
    ctx.lineTo(poleX - 14, y + 11);
    ctx.stroke();
  }

  // horizontal rod the spring hangs from
  ctx.strokeStyle = '#7d7d86';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(poleX, ANCHOR_Y_PX);
  ctx.lineTo(rodEndX, ANCHOR_Y_PX);
  ctx.stroke();

  // small ring where the spring attaches
  ctx.strokeStyle = '#4d4d54';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(ANCHOR_X, ANCHOR_Y_PX, 5, 0, Math.PI * 2);
  ctx.stroke();
}

function drawSpring(x, yTop, yBottom) {
  const totalLength = Math.max(20, yBottom - yTop);
  const coilCount = SPRING_COILS;
  const leadIn = Math.min(14, totalLength * 0.08);
  const coiledLength = Math.max(10, totalLength - 2 * leadIn);
  const radius = 22; // fixed px — independent of zoom, so k/mass/etc. never affect the coil's width
  const samplesPerCoil = 14;
  const totalSamples = coilCount * samplesPerCoil;

  ctx.strokeStyle = '#4a6fa5';
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // one continuous wound-wire curve, not separate closed loops
  ctx.beginPath();
  ctx.moveTo(x, yTop);
  ctx.lineTo(x, yTop + leadIn);
  for (let i = 0; i <= totalSamples; i++) {
    const t = i / totalSamples;
    const py = yTop + leadIn + t * coiledLength;
    const px = x + radius * Math.sin(t * coilCount * Math.PI * 2);
    ctx.lineTo(px, py);
  }
  ctx.lineTo(x, yBottom - leadIn);
  ctx.lineTo(x, yBottom);
  ctx.stroke();
}

// Draws a hooked slotted-mass weight: a short wire hook feeding into a
// squat black cylinder, matching a typical lab hooked-mass set.
function drawMass() {
  const { r, hookH, cylTopY, cylBottomY, hookTopY } = massLayout();
  const capRy = r * 0.26;

  // hook: a short stem down to a small loop
  ctx.strokeStyle = '#767676';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  const loopCy = hookTopY + hookH - 5;
  ctx.beginPath();
  ctx.moveTo(ANCHOR_X, hookTopY);
  ctx.lineTo(ANCHOR_X, loopCy - 5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(ANCHOR_X, loopCy, 4.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineCap = 'butt';

  // nothing hung on the spring yet — just the empty hook, no cylinder
  if (CONFIG.mass <= 0) return;

  // cylinder body
  ctx.fillStyle = '#1c1c1c';
  ctx.fillRect(ANCHOR_X - r, cylTopY, r * 2, cylBottomY - cylTopY);

  // subtle highlight down the left side
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(ANCHOR_X - r, cylTopY, r * 0.5, cylBottomY - cylTopY);

  // side outline
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(ANCHOR_X - r, cylTopY);
  ctx.lineTo(ANCHOR_X - r, cylBottomY);
  ctx.moveTo(ANCHOR_X + r, cylTopY);
  ctx.lineTo(ANCHOR_X + r, cylBottomY);
  ctx.stroke();

  // bottom cap
  ctx.fillStyle = '#141414';
  ctx.beginPath();
  ctx.ellipse(ANCHOR_X, cylBottomY, r, capRy, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // top cap
  ctx.fillStyle = '#2b2b2b';
  ctx.beginPath();
  ctx.ellipse(ANCHOR_X, cylTopY, r, capRy, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // mass label — drawn above the cylinder (not inside it) so it doesn't
  // overflow a small 50g cylinder the way centered text would
  ctx.fillStyle = '#333';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(CONFIG.mass.toFixed(2) + ' kg', ANCHOR_X, cylTopY - capRy - 6);
}

function drawEquilibriumLine() {
  if (!CONFIG.showEquilibrium) return;
  const y = ANCHOR_Y_PX + metersToPx(equilibriumLength());
  ctx.strokeStyle = '#1f9d55';
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ANCHOR_X - 150, y);
  ctx.lineTo(ANCHOR_X + 150, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#1f9d55';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('equilibrium', ANCHOR_X + 155, y + 4);
}

function drawNaturalLengthLine() {
  if (!CONFIG.showNaturalLength) return;
  const y = ANCHOR_Y_PX + metersToPx(CONFIG.restLength);
  ctx.strokeStyle = '#c9960c';
  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ANCHOR_X - 150, y);
  ctx.lineTo(ANCHOR_X + 150, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#c9960c';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('natural length', ANCHOR_X + 155, y + 4);
}

function drawArrow(x1, y1, x2, y2, color) {
  const headLen = 8;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function drawVelocityVector() {
  if (!CONFIG.showVelocityVector) return;
  if (Math.abs(state.v) < 0.02) return;
  const { r, cylTopY, cylBottomY } = massLayout();
  const y = (cylTopY + cylBottomY) / 2;
  const scale = 12; // px per (m/s)
  const len = state.v * scale;
  const x = ANCHOR_X + r + 25;
  drawArrow(x, y, x, y + len, '#1a73c7');
  ctx.fillStyle = '#1a73c7';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('v = ' + state.v.toFixed(2) + ' m/s', x + 7, y - (len < 0 ? 8 : -14));
}

function drawReadout() {
  const s = state.y - equilibriumLength();
  const mEff = effectiveMass();
  const omega = Math.sqrt(CONFIG.k / mEff);
  const T = 2 * Math.PI / omega;
  const lines = [
    'displacement from equilibrium: ' + s.toFixed(3) + ' m',
    'velocity: ' + state.v.toFixed(3) + ' m/s',
    'm_eff = mass + spring mass/3 = ' + mEff.toFixed(3) + ' kg',
    'ω = √(k/m_eff) = ' + omega.toFixed(2) + ' rad/s',
    'T = 2π/ω = ' + T.toFixed(2) + ' s'
  ];
  ctx.fillStyle = '#333';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  lines.forEach((line, i) => ctx.fillText(line, 16, canvas.height - 70 + i * 16));
}

function drawEnergyGraph() {
  if (!CONFIG.showEnergyGraph) return;
  const s = state.y - equilibriumLength();
  const KE = 0.5 * effectiveMass() * state.v * state.v;
  const PE = 0.5 * CONFIG.k * s * s;
  const total = KE + PE;
  peakEnergy = Math.max(peakEnergy, total, 1e-6);

  const panelW = 170;
  const panelH = 170;
  const panelX = canvas.width - panelW - 20;
  const panelY = canvas.height - panelH - 20;
  const baseY = panelY + panelH - 24;
  const maxBarH = panelH - 44;

  ctx.fillStyle = 'rgba(0,0,0,0.04)';
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = '#999';
  ctx.strokeRect(panelX, panelY, panelW, panelH);
  ctx.fillStyle = '#333';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Energy (about equilibrium)', panelX + panelW / 2, panelY + 16);

  const bars = [
    { label: 'KE', value: KE, color: '#d9622f' },
    { label: 'PE', value: PE, color: '#1f9d55' },
    { label: 'Total', value: total, color: '#333333' }
  ];
  const barW = 34;
  const gap = 20;
  const startX = panelX + (panelW - (barW * 3 + gap * 2)) / 2;
  bars.forEach((b, i) => {
    const h = Math.max(1, (b.value / peakEnergy) * maxBarH);
    const x = startX + i * (barW + gap);
    ctx.fillStyle = b.color;
    ctx.fillRect(x, baseY - h, barW, h);
    ctx.strokeStyle = '#000';
    ctx.strokeRect(x, baseY - h, barW, h);
    ctx.fillStyle = '#333';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(b.label, x + barW / 2, baseY + 12);
  });
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawTable();
  drawTableWeights();
  drawOpticsDock();
  drawAnchor();
  drawNaturalLengthLine();
  drawEquilibriumLine();
  drawSpring(ANCHOR_X, ANCHOR_Y_PX, massPxY());
  const beam = computeBeam();
  drawBeam(beam);
  drawMass();
  drawVelocityVector();
  drawReadout();
  drawEnergyGraph();
  drawDropZoneHint();
  drawDraggedWeight();
  drawLaserHousing(laserItem, draggingOptic === 'laser');
  drawSensorWire(sensorItem);
  drawSensorHousing(sensorItem, beam.detected, draggingOptic === 'sensor');
  drawRuler(rulerItem, draggingOptic === 'ruler');
  checkAutoLap(beam);
}

// ---- main loop ----

let accumulator = 0;
let lastTimestamp = null;

function loop(now) {
  if (lastTimestamp === null) lastTimestamp = now;
  let frameDt = (now - lastTimestamp) / 1000;
  lastTimestamp = now;
  frameDt = Math.min(frameDt, 0.05);

  if (CONFIG.running && !dragging) {
    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= PHYSICS_DT && steps < MAX_SUBSTEPS_PER_FRAME) {
      stepPhysics(PHYSICS_DT);
      accumulator -= PHYSICS_DT;
      steps++;
    }
  }

  render();
  renderStopwatchTime();
  requestAnimationFrame(loop);
}

// ---- control wiring ----

const restLengthSlider = document.getElementById('restLengthSlider');
const restLengthValue = document.getElementById('restLengthValue');
restLengthSlider.addEventListener('input', () => {
  CONFIG.restLength = parseFloat(restLengthSlider.value);
  restLengthValue.textContent = CONFIG.restLength.toFixed(2);
});

const kSlider = document.getElementById('kSlider');
const kValue = document.getElementById('kValue');
const springMassValue = document.getElementById('springMassValue');
function updateSpringMassFromK() {
  CONFIG.springMass = springMassFromK(CONFIG.k);
  springMassValue.textContent = (CONFIG.springMass * 1000).toFixed(1); // show in grams
}
kSlider.addEventListener('input', () => {
  CONFIG.k = parseFloat(kSlider.value);
  kValue.textContent = CONFIG.k.toFixed(0);
  updateSpringMassFromK(); // thicker wire at higher k means more mass, not a free variable
});
updateSpringMassFromK(); // set the initial display to match CONFIG.k at load

const massSlider = document.getElementById('massSlider');
const massValue = document.getElementById('massValue');
massSlider.addEventListener('input', () => {
  CONFIG.mass = parseFloat(massSlider.value);
  massValue.textContent = CONFIG.mass.toFixed(2);
  // moving the slider away from the hanging weight's value takes it off
  // the spring, so it becomes eligible to draw on the table again
  if (springWeightId) {
    const w = TABLE_WEIGHTS.find((x) => x.id === springWeightId);
    if (!w || Math.abs(w.grams / 1000 - CONFIG.mass) > 1e-6) {
      springWeightId = null;
    }
  }
});

const dampingSlider = document.getElementById('dampingSlider');
const dampingValue = document.getElementById('dampingValue');
dampingSlider.addEventListener('input', () => {
  CONFIG.damping = parseFloat(dampingSlider.value);
  dampingValue.textContent = CONFIG.damping.toFixed(1);
});

document.getElementById('equilibriumCheckbox').addEventListener('change', (e) => {
  CONFIG.showEquilibrium = e.target.checked;
});
document.getElementById('naturalLengthCheckbox').addEventListener('change', (e) => {
  CONFIG.showNaturalLength = e.target.checked;
});
document.getElementById('vectorCheckbox').addEventListener('change', (e) => {
  CONFIG.showVelocityVector = e.target.checked;
});
document.getElementById('energyCheckbox').addEventListener('change', (e) => {
  CONFIG.showEnergyGraph = e.target.checked;
  peakEnergy = 1e-6;
});

const pauseBtn = document.getElementById('pauseBtn');
pauseBtn.addEventListener('click', () => {
  CONFIG.running = !CONFIG.running;
  pauseBtn.textContent = CONFIG.running ? 'Pause' : 'Resume';
});

document.getElementById('resetBtn').addEventListener('click', () => {
  state.y = equilibriumLength();
  state.v = 0;
  peakEnergy = 1e-6;
});

// ---- stopwatch ----

const MAX_LAPS = 5;
const stopwatch = {
  running: false,
  elapsedMs: 0,   // accumulated time from previous runs
  startTs: null,  // performance.now() at the start of the current run, or null
  laps: []        // lap times in ms, newest first, capped at MAX_LAPS
};

function stopwatchElapsedMs() {
  if (stopwatch.running && stopwatch.startTs !== null) {
    return stopwatch.elapsedMs + (performance.now() - stopwatch.startTs);
  }
  return stopwatch.elapsedMs;
}

function formatStopwatchTime(ms) {
  const cs = Math.floor(ms / 10);
  const centis = cs % 100;
  const totalSeconds = Math.floor(cs / 100);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return pad(minutes) + ':' + pad(seconds) + '.' + pad(centis);
}

function renderStopwatchTime() {
  swDisplay.textContent = formatStopwatchTime(stopwatchElapsedMs());
}

function renderStopwatchLaps() {
  swLaps.innerHTML = '';
  stopwatch.laps.forEach((lapMs, i) => {
    const li = document.createElement('li');
    li.textContent = 'Lap ' + (stopwatch.laps.length - i) + ' — ' + formatStopwatchTime(lapMs);
    swLaps.appendChild(li);
  });
}

const swDisplay = document.getElementById('swDisplay');
const swLaps = document.getElementById('swLaps');
const swStartStopBtn = document.getElementById('swStartStopBtn');
const swLapBtn = document.getElementById('swLapBtn');
const swResetBtn = document.getElementById('swResetBtn');

swStartStopBtn.addEventListener('click', () => {
  if (stopwatch.running) {
    stopwatch.elapsedMs = stopwatchElapsedMs();
    stopwatch.startTs = null;
    stopwatch.running = false;
    swStartStopBtn.textContent = 'Start';
  } else {
    stopwatch.startTs = performance.now();
    stopwatch.running = true;
    swStartStopBtn.textContent = 'Stop';
  }
});

// Shared by the Lap button and the sensor's auto-trigger wire below.
function recordLap() {
  if (!stopwatch.running) return;
  stopwatch.laps.unshift(stopwatchElapsedMs());
  if (stopwatch.laps.length > MAX_LAPS) stopwatch.laps.length = MAX_LAPS;
  renderStopwatchLaps();
}

swLapBtn.addEventListener('click', recordLap);

swResetBtn.addEventListener('click', () => {
  stopwatch.running = false;
  stopwatch.elapsedMs = 0;
  stopwatch.startTs = null;
  stopwatch.laps = [];
  swStartStopBtn.textContent = 'Start';
  renderStopwatchLaps();
  renderStopwatchTime();
});

// ---- make the stopwatch panel itself a draggable object ----
// It's an HTML overlay rather than a canvas shape, so dragging just repositions
// it in the page; the buttons stay clickable (drag only starts when the
// pointerdown didn't land on one of them).
(function makeStopwatchDraggable() {
  const panel = document.getElementById('stopwatch');
  let draggingPanel = false;
  let offsetX = 0, offsetY = 0;

  panel.addEventListener('pointerdown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    draggingPanel = true;
    const rect = panel.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    panel.style.cursor = 'grabbing';
    panel.setPointerCapture(e.pointerId);
  });

  panel.addEventListener('pointermove', (e) => {
    if (!draggingPanel) return;
    panel.style.left = Math.max(0, e.clientX - offsetX) + 'px';
    panel.style.top = Math.max(0, e.clientY - offsetY) + 'px';
  });

  panel.addEventListener('pointerup', (e) => {
    draggingPanel = false;
    panel.style.cursor = 'grab';
    panel.releasePointerCapture(e.pointerId);
  });
})();

// ---- wiring: the sensor is "connected" to the stopwatch, and blocking the
// beam fires a lap so the time between blocks can be read off as the period ----

// Where a cable coming out of the stopwatch panel would meet the canvas,
// converted from the panel's real on-screen position into canvas px.
function stopwatchWireAnchor() {
  const panelRect = document.getElementById('stopwatch').getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / canvasRect.width;
  const scaleY = canvas.height / canvasRect.height;
  return {
    x: (panelRect.right - 10 - canvasRect.left) * scaleX,
    y: (panelRect.top + 14 - canvasRect.top) * scaleY
  };
}

function drawSensorWire(item) {
  const anchor = stopwatchWireAnchor();
  const jackX = item.x;
  const jackY = item.y + SENSOR_H / 2;
  const midX = (jackX + anchor.x) / 2;
  const sag = 50;
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(jackX, jackY);
  ctx.quadraticCurveTo(midX, Math.max(jackY, anchor.y) + sag, anchor.x, anchor.y);
  ctx.stroke();
  ctx.fillStyle = '#333';
  ctx.fillRect(jackX - 3, jackY - 2, 6, 6);
}

// Fires exactly once at the moment the beam goes from clear to blocked —
// not while it stays blocked, and not on release.
let prevBeamDetected = null;
function checkAutoLap(beam) {
  if (prevBeamDetected === true && beam.detected === false) {
    recordLap();
  }
  prevBeamDetected = beam.detected;
}

requestAnimationFrame(loop);
