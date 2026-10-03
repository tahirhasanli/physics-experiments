const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Render at the screen's real pixel density so the sim stays crisp on
// high-DPI/large displays instead of the browser stretching a low-res
// bitmap. Everything below still lays out in the original design pixels
// (LOGICAL_WIDTH/LOGICAL_HEIGHT) — ctx.scale() maps that onto the sharper
// backing store transparently.
const LOGICAL_WIDTH = parseInt(canvas.getAttribute('width'), 10);
const LOGICAL_HEIGHT = parseInt(canvas.getAttribute('height'), 10);
const DPR = window.devicePixelRatio || 1;
canvas.width = LOGICAL_WIDTH * DPR;
canvas.height = LOGICAL_HEIGHT * DPR;
canvas.style.width = LOGICAL_WIDTH + 'px';
canvas.style.height = LOGICAL_HEIGHT + 'px';
ctx.scale(DPR, DPR);

// ---- CONFIG: change these to adjust the setup ----
const CONFIG = {
  source: { x: 60, y: LOGICAL_HEIGHT / 2 },
  lens: { x: 220, y: LOGICAL_HEIGHT / 2 },
  partialMirror: { x: 300, y: LOGICAL_HEIGHT / 2 },
  eyepiece: { x: 300, y: LOGICAL_HEIGHT / 2 + 130 },
  wheel: { x: 400, y: LOGICAL_HEIGHT / 2, radius: 45, teeth: 8, rotationRateHz: 0.4 },
  distanceL: 700,                      // px, SIMULATED wheel-to-mirror distance (drives timing only)
  cSim: 300,                           // px/s, simulated speed of light
  drawMirrorX: LOGICAL_WIDTH - 90,      // fixed screen x for the mirror — drawing only, not physics
  kmReference: { px: 700, km: 8.6 },   // used only to label a realistic-looking distance
  running: true
};

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

// ---- time / wheel state ----
let simTime = 0;
let lastTimestamp = null;
let wasOpen = false;
const pulses = []; // { launchTime, resolved, blocked, flashUntil }

// Angle (deg, 0-360) of the wheel at time t.
function wheelAngleAt(t) {
  const deg = CONFIG.wheel.rotationRateHz * t * 360;
  return ((deg % 360) + 360) % 360;
}

// Is a gap (not a tooth) sitting in the beam path at time t?
function wheelOpenAt(t) {
  const sectorCount = CONFIG.wheel.teeth * 2; // teeth + gaps alternating
  const sectorAngle = 360 / sectorCount;
  const angle = wheelAngleAt(t);
  const sectorIndex = Math.floor(angle / sectorAngle);
  return sectorIndex % 2 === 0; // even sectors = gaps, odd = teeth
}

function travelTime() {
  return (2 * CONFIG.distanceL) / CONFIG.cSim; // round trip, seconds
}

// Flavor-only: maps the simulated distance slider onto a realistic km figure
// (Fizeau's actual apparatus used roughly 8.6 km). Does not affect physics.
function equivalentKm() {
  return (CONFIG.distanceL / CONFIG.kmReference.px) * CONFIG.kmReference.km;
}

// ---- physics/state update ----
function update(t) {
  const isOpen = wheelOpenAt(t);

  // Spawn a new pulse every time a gap starts passing the beam (rising edge).
  if (isOpen && !wasOpen) {
    pulses.push({ launchTime: t, resolved: false, blocked: false, flashUntil: null });
  }
  wasOpen = isOpen;

  const tTravel = travelTime();
  for (const p of pulses) {
    if (!p.resolved && t - p.launchTime >= tTravel) {
      p.resolved = true;
      p.blocked = !wheelOpenAt(p.launchTime + tTravel); // wheel state at arrival
      p.flashUntil = t + 0.25; // brief flash to show the outcome
    }
  }

  // Drop pulses whose flash has finished (or that never got flashed because
  // they're extremely old, as a safety net).
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i];
    if (p.resolved && t > p.flashUntil) {
      pulses.splice(i, 1);
    }
  }
}

// ---- drawing helpers ----
function drawNearBeam(t) {
  const near = wheelOpenAt(t);
  const y = CONFIG.source.y;
  const wheelLeftEdgeX = CONFIG.wheel.x - CONFIG.wheel.radius;

  ctx.beginPath();
  ctx.moveTo(CONFIG.source.x, y);
  ctx.lineTo(wheelLeftEdgeX, y);
  ctx.strokeStyle = near ? 'rgba(255, 212, 94, 0.8)' : 'rgba(255, 212, 94, 0.25)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawSource() {
  ctx.beginPath();
  ctx.arc(CONFIG.source.x, CONFIG.source.y, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd45e';
  ctx.fill();
  ctx.fillStyle = '#888';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Source', CONFIG.source.x, CONFIG.source.y + 24);
}

function drawLens() {
  const { x, y } = CONFIG.lens;
  const halfHeight = 32;
  ctx.beginPath();
  ctx.moveTo(x, y - halfHeight);
  ctx.quadraticCurveTo(x + 10, y, x, y + halfHeight);
  ctx.quadraticCurveTo(x - 10, y, x, y - halfHeight);
  ctx.fillStyle = 'rgba(140, 200, 255, 0.35)';
  ctx.fill();
  ctx.strokeStyle = '#8cc8ff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#888';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Lens', x, y - halfHeight - 8);
}

function drawPartialMirror(visible) {
  const { x, y } = CONFIG.partialMirror;
  const half = 28;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(degToRad(-45));
  ctx.beginPath();
  ctx.moveTo(-half, 0);
  ctx.lineTo(half, 0);
  ctx.strokeStyle = 'rgba(200, 200, 255, 0.7)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#888';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Partial mirror', x, y - 40);

  // schematic path down to the eyepiece
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.moveTo(x, y);
  ctx.lineTo(CONFIG.eyepiece.x, CONFIG.eyepiece.y);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  drawEyepiece(visible);
}

function drawEyepiece(visible) {
  const { x, y } = CONFIG.eyepiece;
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fillStyle = visible ? 'rgba(120, 255, 140, 0.9)' : 'rgba(80, 80, 80, 0.9)';
  ctx.fill();
  ctx.strokeStyle = '#555';
  ctx.stroke();
  ctx.fillStyle = visible ? '#7dff8f' : '#888';
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(visible ? 'BRIGHT' : 'DARK', x, y + 26);
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#888';
  ctx.fillText('Eyepiece', x, y + 42);
}

function drawWheel(t) {
  const { x, y, radius, teeth } = CONFIG.wheel;
  const sectorCount = teeth * 2;
  const sectorAngle = 360 / sectorCount;
  const angle = wheelAngleAt(t);
  const open = wheelOpenAt(t);
  const innerRadius = radius * 0.55;
  const toothLength = radius - innerRadius;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(degToRad(angle));

  // base rim (hub), so the wheel still reads as a solid spinning body
  ctx.beginPath();
  ctx.arc(0, 0, innerRadius, 0, Math.PI * 2);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 2;
  ctx.stroke();

  // one plain rectangle per tooth, evenly spaced around the rim; gaps are
  // left empty so the beam's path past the rim is visually obvious
  for (let i = 0; i < sectorCount; i++) {
    const isTooth = i % 2 !== 0;
    if (!isTooth) continue;
    const midRad = degToRad(i * sectorAngle + sectorAngle / 2);
    const toothWidth = degToRad(sectorAngle) * innerRadius * 0.9;

    ctx.save();
    ctx.rotate(midRad);
    ctx.fillStyle = '#9a9a9a';
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 0.5;
    ctx.fillRect(innerRadius, -toothWidth / 2, toothLength, toothWidth);
    ctx.strokeRect(innerRadius, -toothWidth / 2, toothLength, toothWidth);
    ctx.restore();
  }
  ctx.restore();

  // faint guide circle showing the outer sweep of the teeth
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // mark exactly where the beam threads through the rim, on both sides
  drawBeamGate(x - radius, y);
  drawBeamGate(x + radius, y);

  ctx.fillStyle = open ? '#7dff8f' : '#ff8f7d';
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(open ? 'OPEN' : 'BLOCKED', x, y - radius - 14);
  ctx.fillStyle = '#888';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('Toothed wheel', x, y + radius + 20);
}

function drawBeamGate(gx, gy) {
  ctx.beginPath();
  ctx.arc(gx, gy, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#ffe08a';
  ctx.fill();
}

function drawLongPathAndMirror() {
  const wheelEdgeX = CONFIG.wheel.x + CONFIG.wheel.radius;
  const mirrorX = CONFIG.drawMirrorX; // fixed screen position, independent of distanceL
  const y = CONFIG.wheel.y;
  const breakX = wheelEdgeX + (mirrorX - wheelEdgeX) * 0.35;

  ctx.beginPath();
  ctx.setLineDash([6, 6]);
  ctx.moveTo(wheelEdgeX, y);
  ctx.lineTo(breakX - 12, y);
  ctx.moveTo(breakX + 12, y);
  ctx.lineTo(mirrorX, y);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  // zigzag "not to scale" break mark
  ctx.beginPath();
  ctx.moveTo(breakX - 12, y - 10);
  ctx.lineTo(breakX - 4, y + 10);
  ctx.lineTo(breakX + 4, y - 10);
  ctx.lineTo(breakX + 12, y + 10);
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(mirrorX, y - 60);
  ctx.lineTo(mirrorX, y + 60);
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = '#888';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Distant mirror', mirrorX, y - 74);

  ctx.fillStyle = '#666';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(
    'L = ' + CONFIG.distanceL + ' px (sim) ≈ ' + equivalentKm().toFixed(1) +
      ' km scaled — Fizeau used ~8.6 km',
    (wheelEdgeX + mirrorX) / 2,
    y + 90
  );
  ctx.fillText('compressed, not to scale', breakX, y + 22);
}

function drawPulses(t) {
  const tTravel = travelTime();
  const wheelEdgeX = CONFIG.wheel.x + CONFIG.wheel.radius;
  const mirrorX = CONFIG.drawMirrorX;
  const y = CONFIG.wheel.y;

  pulses.forEach((p) => {
    if (!p.resolved) {
      const elapsed = t - p.launchTime;
      const half = tTravel / 2;
      let headX, tailX;
      if (elapsed <= half) {
        headX = wheelEdgeX + (elapsed / half) * (mirrorX - wheelEdgeX);
        tailX = wheelEdgeX;
      } else {
        headX = mirrorX - ((elapsed - half) / half) * (mirrorX - wheelEdgeX);
        tailX = mirrorX;
      }
      // the beam is drawn as a line that grows from its point of origin
      // up to its current position, instead of a single traveling dot
      ctx.beginPath();
      ctx.moveTo(tailX, y);
      ctx.lineTo(headX, y);
      ctx.strokeStyle = 'rgba(255, 245, 157, 0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(headX, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#fff59d';
      ctx.fill();
    } else if (t <= p.flashUntil) {
      // brief flash at the point where the outcome was decided
      if (p.blocked) {
        ctx.beginPath();
        ctx.arc(CONFIG.wheel.x, CONFIG.wheel.y, 10, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 100, 100, 0.6)';
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(CONFIG.eyepiece.x, CONFIG.eyepiece.y, 16, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(120, 255, 140, 0.35)';
        ctx.fill();
      }
    }
  });
}

function drawReadout(t) {
  const tTravel = travelTime();
  const n = CONFIG.wheel.rotationRateHz;
  const N = CONFIG.wheel.teeth;
  const impliedC = 4 * CONFIG.distanceL * N * n;

  ctx.textAlign = 'left';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#999';
  const lines = [
    'Round-trip travel time: ' + tTravel.toFixed(2) + ' s',
    '4LNn (eclipse-condition formula): ' + impliedC.toFixed(1) + ' px/s',
    'Sim light speed (cSim): ' + CONFIG.cSim + ' px/s'
  ];
  lines.forEach((line, i) => {
    ctx.fillText(line, 16, LOGICAL_HEIGHT - 16 - (lines.length - 1 - i) * 16);
  });
}

// ---- render + loop ----
function render(t) {
  ctx.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

  const tTravel = travelTime();
  const visible = t >= tTravel && wheelOpenAt(t - tTravel) && wheelOpenAt(t);

  drawNearBeam(t);
  drawSource();
  drawLens();
  drawLongPathAndMirror();
  drawWheel(t);
  drawPulses(t);
  drawPartialMirror(visible);
  drawReadout(t);
}

function loop(now) {
  if (lastTimestamp !== null) {
    const dt = (now - lastTimestamp) / 1000;
    if (CONFIG.running) {
      simTime += dt;
      update(simTime);
    }
  }
  lastTimestamp = now;
  render(simTime);
  requestAnimationFrame(loop);
}

// ---- controls ----
const teethSlider = document.getElementById('teethSlider');
const teethValue = document.getElementById('teethValue');
teethSlider.addEventListener('input', () => {
  CONFIG.wheel.teeth = parseInt(teethSlider.value, 10);
  teethValue.textContent = CONFIG.wheel.teeth;
});

const rotationSlider = document.getElementById('rotationSlider');
const rotationValue = document.getElementById('rotationValue');
rotationSlider.addEventListener('input', () => {
  CONFIG.wheel.rotationRateHz = parseFloat(rotationSlider.value);
  rotationValue.textContent = CONFIG.wheel.rotationRateHz.toFixed(2);
});

const distanceSlider = document.getElementById('distanceSlider');
const distanceValue = document.getElementById('distanceValue');
distanceSlider.addEventListener('input', () => {
  CONFIG.distanceL = parseInt(distanceSlider.value, 10);
  distanceValue.textContent = CONFIG.distanceL;
});

const speedSlider = document.getElementById('speedSlider');
const speedValue = document.getElementById('speedValue');
speedSlider.addEventListener('input', () => {
  CONFIG.cSim = parseInt(speedSlider.value, 10);
  speedValue.textContent = CONFIG.cSim;
});

const playPauseBtn = document.getElementById('playPauseBtn');
playPauseBtn.addEventListener('click', () => {
  CONFIG.running = !CONFIG.running;
  playPauseBtn.textContent = CONFIG.running ? 'Pause' : 'Play';
});

requestAnimationFrame(loop);
