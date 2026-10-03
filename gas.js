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
// MODEL
//
// A 2D box of equal-mass point-ish particles ("molecules") that bounce
// elastically off the walls and off each other. Everything here is in
// abstract simulation units (mass = 1, Boltzmann constant = 1) rather than
// SI — the point of this sim is the *relationships* between temperature,
// volume, particle count, and pressure (the ideal gas law, PV = NkT),
// which fall directly out of the collision physics rather than being
// hard-coded anywhere.
//
// Temperature is defined the way kinetic theory defines it: the average
// kinetic energy per particle. Moving the temperature slider rescales
// every particle's velocity so the average KE instantly matches the new
// target; after that, elastic collisions conserve total kinetic energy on
// their own, so the gas just stays at that temperature until you change
// the slider again.
//
// Pressure is measured the way a real gauge would "feel" it: every time a
// particle bounces off a wall, the momentum it transfers is added to a
// running total, and pressure is that momentum-transfer rate divided by
// the box's perimeter (the 2D analog of force/area). Compressing the
// piston increases the collision rate on the walls, and that alone is
// what raises the reading -- nothing about "pressure increasing when
// compressed" is scripted separately.
// =====================================================================

const BOX_LEFT = 110;
const BOX_TOP = 90;
const BOX_BOTTOM = 580;
const BOX_HEIGHT = BOX_BOTTOM - BOX_TOP;
const PISTON_MIN_X = BOX_LEFT + 160;
const PISTON_MAX_X = 900;

const PARTICLE_R = 4.5;
const MASS = 1;

// The temperature slider is a friendly small number (0.2-6) for the UI, but
// actual kinetic energy needs to be large enough that particles cross a
// ~500-800px box in a couple of seconds rather than crawling — this scales
// slider-space temperature into the actual energy units used everywhere in
// the physics (velocities, pressure, the ideal-gas-law check).
const KE_SCALE = 20000;
function internalT() { return temperature * KE_SCALE; }

let piston = { x: 620 };
let temperature = 1.5;
let targetCount = 60;
let particles = [];

function randn() {
  // Box-Muller transform for a standard normal sample.
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// A fresh particle with velocity components drawn from a normal
// distribution of variance = temperature, so E[0.5*m*(vx^2+vy^2)] equals
// the target temperature exactly (in these k_B=1 units) — this gives the
// same Maxwell–Boltzmann-shaped speed distribution real gas kinetic theory
// predicts, rather than every particle moving at an identical speed.
function newParticle(x, y) {
  const std = Math.sqrt(internalT() / MASS);
  return { x, y, vx: randn() * std, vy: randn() * std };
}

function randomPointInBox() {
  const x = BOX_LEFT + PARTICLE_R + Math.random() * (piston.x - BOX_LEFT - 2 * PARTICLE_R);
  const y = BOX_TOP + PARTICLE_R + Math.random() * (BOX_HEIGHT - 2 * PARTICLE_R);
  return { x, y };
}

function resetGas() {
  particles = [];
  for (let i = 0; i < targetCount; i++) {
    const pt = randomPointInBox();
    particles.push(newParticle(pt.x, pt.y));
  }
  pressureEMA = 0;
}

// Adds or removes particles to reach targetCount without disturbing the
// ones that already exist, so dragging the count slider doesn't restart
// the whole gas from scratch.
function adjustParticleCount() {
  while (particles.length < targetCount) {
    const pt = randomPointInBox();
    particles.push(newParticle(pt.x, pt.y));
  }
  while (particles.length > targetCount) {
    particles.pop();
  }
}

// Rescales every particle's velocity so the measured average kinetic
// energy instantly matches the new temperature target. Elastic collisions
// conserve that total energy afterward, so the gas holds this temperature
// until the slider changes again.
function rescaleToTemperature() {
  if (particles.length === 0) return;
  let sumKE = 0;
  for (const p of particles) sumKE += 0.5 * MASS * (p.vx * p.vx + p.vy * p.vy);
  const avgKE = sumKE / particles.length;
  const target = internalT();
  if (avgKE < 1e-9) {
    // Degenerate (everything at rest) — just reseed velocities fresh.
    const std = Math.sqrt(target / MASS);
    for (const p of particles) { p.vx = randn() * std; p.vy = randn() * std; }
    return;
  }
  const scale = Math.sqrt(target / avgKE);
  for (const p of particles) { p.vx *= scale; p.vy *= scale; }
}

// Average kinetic energy per particle, in the same internal energy units
// as internalT() — compare against internalT(), not the raw slider value.
function measuredTemperature() {
  if (particles.length === 0) return 0;
  let sumKE = 0;
  for (const p of particles) sumKE += 0.5 * MASS * (p.vx * p.vx + p.vy * p.vy);
  return sumKE / particles.length;
}

// =====================================================================
// PHYSICS STEP
// =====================================================================

let pressureEMA = 0;
const PRESSURE_EMA_ALPHA = 0.06;
// Sub-stepping keeps a fast particle's per-step displacement well under its
// own diameter, so simple discrete overlap checks don't miss (tunnel
// through) collisions between two particles passing close together.
const SUBSTEPS = 4;

function step(dt) {
  let totalImpulse = 0;
  const subDt = dt / SUBSTEPS;
  for (let s = 0; s < SUBSTEPS; s++) totalImpulse += physicsSubstep(subDt);

  const boxWidth = piston.x - BOX_LEFT;
  const perimeter = 2 * (boxWidth + BOX_HEIGHT);
  const instantaneousPressure = dt > 0 ? (totalImpulse / dt) / perimeter : 0;
  pressureEMA += PRESSURE_EMA_ALPHA * (instantaneousPressure - pressureEMA);
}

// Advances the gas by one small sub-step and returns the momentum
// transferred to the walls during it.
function physicsSubstep(dt) {
  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }

  let frameImpulse = 0; // total |momentum transferred to walls| this frame

  for (const p of particles) {
    if (p.x - PARTICLE_R < BOX_LEFT) {
      frameImpulse += 2 * MASS * Math.abs(p.vx);
      p.x = BOX_LEFT + PARTICLE_R;
      p.vx = Math.abs(p.vx);
    }
    if (p.x + PARTICLE_R > piston.x) {
      frameImpulse += 2 * MASS * Math.abs(p.vx);
      p.x = piston.x - PARTICLE_R;
      p.vx = -Math.abs(p.vx);
    }
    if (p.y - PARTICLE_R < BOX_TOP) {
      frameImpulse += 2 * MASS * Math.abs(p.vy);
      p.y = BOX_TOP + PARTICLE_R;
      p.vy = Math.abs(p.vy);
    }
    if (p.y + PARTICLE_R > BOX_BOTTOM) {
      frameImpulse += 2 * MASS * Math.abs(p.vy);
      p.y = BOX_BOTTOM - PARTICLE_R;
      p.vy = -Math.abs(p.vy);
    }
  }

  // Particle-particle elastic collisions (equal mass -> swap the velocity
  // component along the line connecting centers, leave the tangential
  // component untouched).
  const n = particles.length;
  for (let i = 0; i < n; i++) {
    const pi = particles[i];
    for (let j = i + 1; j < n; j++) {
      const pj = particles[j];
      const dx = pj.x - pi.x, dy = pj.y - pi.y;
      const dist = Math.hypot(dx, dy);
      const minDist = 2 * PARTICLE_R;
      if (dist > 0 && dist < minDist) {
        const nx = dx / dist, ny = dy / dist;
        const overlap = minDist - dist;
        pi.x -= (nx * overlap) / 2; pi.y -= (ny * overlap) / 2;
        pj.x += (nx * overlap) / 2; pj.y += (ny * overlap) / 2;

        const rvx = pj.vx - pi.vx, rvy = pj.vy - pi.vy;
        const velAlongNormal = rvx * nx + rvy * ny;
        if (velAlongNormal < 0) {
          pi.vx += velAlongNormal * nx; pi.vy += velAlongNormal * ny;
          pj.vx -= velAlongNormal * nx; pj.vy -= velAlongNormal * ny;
        }
      }
    }
  }

  return frameImpulse;
}

// =====================================================================
// INTERACTION — drag the piston
// =====================================================================

function canvasPointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (LOGICAL_WIDTH / rect.width),
    y: (e.clientY - rect.top) * (LOGICAL_HEIGHT / rect.height)
  };
}

function nearPiston(pt) {
  return Math.abs(pt.x - piston.x) <= 10 && pt.y >= BOX_TOP - 10 && pt.y <= BOX_BOTTOM + 10;
}

let draggingPiston = false;

canvas.addEventListener('pointerdown', (e) => {
  const pt = canvasPointFromEvent(e);
  if (nearPiston(pt)) {
    draggingPiston = true;
    canvas.setPointerCapture(e.pointerId);
  }
});
canvas.addEventListener('pointermove', (e) => {
  const pt = canvasPointFromEvent(e);
  if (draggingPiston) {
    piston.x = Math.min(PISTON_MAX_X, Math.max(PISTON_MIN_X, pt.x));
    canvas.style.cursor = 'ew-resize';
    return;
  }
  canvas.style.cursor = nearPiston(pt) ? 'ew-resize' : 'default';
});
canvas.addEventListener('pointerup', (e) => {
  draggingPiston = false;
  canvas.releasePointerCapture(e.pointerId);
});

// =====================================================================
// CONTROLS
// =====================================================================

const tempSlider = document.getElementById('tempSlider');
const tempValue = document.getElementById('tempValue');
const countSlider = document.getElementById('countSlider');
const countValue = document.getElementById('countValue');
const readout = document.getElementById('readout');

tempSlider.addEventListener('input', () => {
  temperature = parseFloat(tempSlider.value);
  tempValue.textContent = temperature.toFixed(1);
  rescaleToTemperature();
});
countSlider.addEventListener('input', () => {
  targetCount = parseInt(countSlider.value, 10);
  countValue.textContent = targetCount;
  adjustParticleCount();
});
document.getElementById('resetBtn').addEventListener('click', resetGas);

function updateReadout() {
  const boxWidth = piston.x - BOX_LEFT;
  const area = boxWidth * BOX_HEIGHT;
  const N = particles.length;
  const avgSpeed = N ? particles.reduce((s, p) => s + Math.hypot(p.vx, p.vy), 0) / N : 0;
  const idealCheck = N > 0 && temperature > 0 ? (pressureEMA * area) / (N * internalT()) : 0;
  readout.innerHTML =
    'Pressure <b>P &asymp; ' + pressureEMA.toFixed(3) + '</b><br>' +
    'Area (2D volume) <b>A = ' + area.toFixed(0) + '</b><br>' +
    'Particles <b>N = ' + N + '</b><br>' +
    'Avg. speed <b>&#772;v = ' + avgSpeed.toFixed(2) + '</b><br>' +
    '<span class="check">PA / NT &asymp; ' + idealCheck.toFixed(2) + '</span>';
}

// =====================================================================
// RENDERING
// =====================================================================

// Fixed regardless of the current temperature setting (calibrated once from
// the sim's default temperature), so raising the slider actually shifts the
// population's color toward red and lowering it shifts toward blue. If this
// were recomputed from the *current* temperature instead, every rescale
// would renormalize speed right back to the same color spread and changing
// the slider would never visibly change anyone's color.
const COLOR_REF_SPEED = Math.sqrt((2 * 1.5 * KE_SCALE) / MASS);

function speedColor(speed) {
  const t = Math.max(0, Math.min(1.6, speed / COLOR_REF_SPEED)) / 1.6;
  const hue = 220 - 220 * t; // blue (slow) -> red (fast)
  return `hsl(${hue}, 80%, 50%)`;
}

function drawBox() {
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(BOX_LEFT, BOX_TOP);
  ctx.lineTo(BOX_LEFT, BOX_BOTTOM);
  ctx.lineTo(piston.x, BOX_BOTTOM);
  ctx.moveTo(BOX_LEFT, BOX_TOP);
  ctx.lineTo(piston.x, BOX_TOP);
  ctx.stroke();
}

function drawPiston() {
  ctx.fillStyle = '#5a4a3a';
  ctx.fillRect(piston.x - 5, BOX_TOP - 6, 10, BOX_HEIGHT + 12);
  // grip hatching to signal it's draggable
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  for (let y = BOX_TOP + 14; y < BOX_BOTTOM - 10; y += 16) {
    ctx.beginPath();
    ctx.moveTo(piston.x - 3, y);
    ctx.lineTo(piston.x + 3, y + 6);
    ctx.stroke();
  }
}

function drawParticles() {
  for (const p of particles) {
    const speed = Math.hypot(p.vx, p.vy);
    ctx.beginPath();
    ctx.arc(p.x, p.y, PARTICLE_R, 0, Math.PI * 2);
    ctx.fillStyle = speedColor(speed);
    ctx.fill();
  }
}

let lastT = null;
function render(t) {
  if (lastT == null) lastT = t;
  let dt = (t - lastT) / 1000;
  lastT = t;
  dt = Math.min(dt, 1 / 30); // clamp so a stalled tab doesn't cause a huge jump

  step(dt);

  ctx.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
  drawBox();
  drawPiston();
  drawParticles();
  updateReadout();

  requestAnimationFrame(render);
}

resetGas();
requestAnimationFrame(render);