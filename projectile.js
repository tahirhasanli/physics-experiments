const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// ---- CONFIG: change these to adjust the setup ----
const CONFIG = {
  groundY: canvas.height - 50,
  launchX: 100,
  pxPerMeter: 6,
  vectorPxPerSpeed: 4, // px per (m/s), for drawing the vx/vy arrows

  gravity: 9.8,       // m/s^2
  airDensity: 1.225,  // kg/m^3
  gravityLabel: 'Earth',

  height: 20,   // m, launch height above the ground
  speed: 20,    // m/s, initial speed
  angleDeg: 45, // launch angle above horizontal
  radius: 0.11, // m
  mass: 0.43,   // kg
  dragEnabled: true,

  showVectors: true,
  showTrace: true,
  showSpeedValues: true,
  running: true
};

const DRAG_COEFFICIENT = 0.47; // smooth sphere
const PHYSICS_DT = 0.005;      // s, fixed physics substep (stability, not frame rate)
const MAX_SIM_TIME = 120;      // s, safety cap for the headless pre-run
const ZOOM_MARGIN_RIGHT = 60;  // px
const ZOOM_MARGIN_TOP = 60;    // px
const ZOOM_LERP_RATE = 2.5;    // higher = faster camera convergence

// ---- catapult (cart + throwing arm, braced by a shorter strut) ----
const CATAPULT_ANCHOR_LIFT = 4; // px the cart sits above the pillar cap
const CART_WIDTH = 62;
const CART_HEIGHT = 18;
const WHEEL_RADIUS = 10;
const POST_HEIGHT = 78;          // px, cart bed to pivot — tall enough that even a
                                  // straight-down idle dip clears the ground at height 0
const ARM_LENGTH = 85;           // px, pivot to cup
const ARM_JOINT_T = 0.42;        // fraction along the arm where the brace strut connects
const ARM_COCKED_OFFSET_DEG = 180; // idle arm rests this many degrees behind the release angle
const ARM_FOLLOWTHROUGH_DEG = 14;  // extra whip past the release angle before settling
const ARM_IDLE_LERP_RATE = 6;      // eases the loaded pose toward the angle slider
const ARM_WIND_DURATION = 0.22;    // s, cocked -> release (the throw itself)
const ARM_FOLLOW_DURATION = 0.10;  // s, release -> follow-through overshoot
const ARM_RETURN_DURATION = 0.30;  // s, follow-through -> back to loaded/cocked

const PLANETS = {
  earth: { label: 'Earth', gravity: 9.8, airDensity: 1.225 },
  moon: { label: 'Moon', gravity: 1.62, airDensity: 0 },
  mars: { label: 'Mars', gravity: 3.71, airDensity: 0.020 }
};

// ---- procedural background (sky + ground, no image files needed) ----
function drawCloud(cx, cy, scale) {
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  const puffs = [
    { dx: -18, dy: 0, r: 16 },
    { dx: 0, dy: -8, r: 20 },
    { dx: 18, dy: 0, r: 16 },
    { dx: 34, dy: 4, r: 12 },
    { dx: -32, dy: 4, r: 12 }
  ];
  puffs.forEach((p) => {
    ctx.beginPath();
    ctx.arc(cx + p.dx * scale, cy + p.dy * scale, p.r * scale, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawSky() {
  const grad = ctx.createLinearGradient(0, 0, 0, CONFIG.groundY);
  grad.addColorStop(0, '#0a1a3a');
  grad.addColorStop(0.6, '#1e4d7b');
  grad.addColorStop(1, '#4a90c2');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, CONFIG.groundY);

  ctx.beginPath();
  ctx.arc(canvas.width * 0.82, 90, 34, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 245, 200, 0.9)';
  ctx.fill();

  drawCloud(canvas.width * 0.18, 140, 1);
  drawCloud(canvas.width * 0.42, 90, 0.7);
  drawCloud(canvas.width * 0.63, 190, 0.85);
}

function drawGroundTexture() {
  const bandHeight = canvas.height - CONFIG.groundY;
  const grad = ctx.createLinearGradient(0, CONFIG.groundY, 0, canvas.height);
  grad.addColorStop(0, '#3a6b2e');
  grad.addColorStop(1, '#1f3d18');
  ctx.fillStyle = grad;
  ctx.fillRect(0, CONFIG.groundY, canvas.width, bandHeight);

  // deterministic (not Math.random) so the grass doesn't jitter every frame
  ctx.strokeStyle = 'rgba(120, 190, 90, 0.35)';
  ctx.lineWidth = 1;
  for (let x = 4; x < canvas.width; x += 9) {
    const h = 4 + ((x * 37) % 7);
    ctx.beginPath();
    ctx.moveTo(x, CONFIG.groundY);
    ctx.lineTo(x, CONFIG.groundY - h);
    ctx.stroke();
  }
}

function drawDustStreak(x, y, len) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(x + len * 0.5, y - 6, x + len, y);
  ctx.stroke();
}

function drawSkyMars() {
  const grad = ctx.createLinearGradient(0, 0, 0, CONFIG.groundY);
  grad.addColorStop(0, '#6b3a2a');
  grad.addColorStop(0.6, '#b5673a');
  grad.addColorStop(1, '#d9a066');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, CONFIG.groundY);

  // sun, smaller/dimmer than Earth's — Mars is farther out
  ctx.beginPath();
  ctx.arc(canvas.width * 0.82, 90, 22, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 235, 210, 0.85)';
  ctx.fill();

  // faint wind-blown dust streaks instead of clouds
  ctx.strokeStyle = 'rgba(200, 140, 90, 0.25)';
  ctx.lineWidth = 2;
  drawDustStreak(canvas.width * 0.2, 130, 90);
  drawDustStreak(canvas.width * 0.5, 170, 120);
  drawDustStreak(canvas.width * 0.68, 100, 70);
}

function drawGroundMars() {
  const bandHeight = canvas.height - CONFIG.groundY;
  const grad = ctx.createLinearGradient(0, CONFIG.groundY, 0, canvas.height);
  grad.addColorStop(0, '#8a4a2e');
  grad.addColorStop(1, '#4a2416');
  ctx.fillStyle = grad;
  ctx.fillRect(0, CONFIG.groundY, canvas.width, bandHeight);

  // scattered rust-colored rocks; deterministic (not Math.random) so they don't jitter
  ctx.fillStyle = 'rgba(60, 25, 12, 0.4)';
  for (let x = 6; x < canvas.width; x += 23) {
    const r = 2 + ((x * 13) % 5);
    const y = CONFIG.groundY + 4 + ((x * 7) % 10);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawEarthDisc(cx, cy, r) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#2b5fa8';
  ctx.fill();
  ctx.fillStyle = 'rgba(90, 160, 90, 0.8)';
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.3, cy - r * 0.2, r * 0.45, r * 0.3, 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx + r * 0.35, cy + r * 0.3, r * 0.35, r * 0.22, -0.3, 0, Math.PI * 2);
  ctx.fill();
}

function drawSkyMoon() {
  ctx.fillStyle = '#05050a';
  ctx.fillRect(0, 0, canvas.width, CONFIG.groundY);

  // stars, deterministic positions so they don't twinkle/jitter every frame
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  for (let x = 5; x < canvas.width; x += 17) {
    const y = (x * 53) % (CONFIG.groundY - 10);
    const r = x % 41 === 0 ? 1.6 : 1;
    ctx.beginPath();
    ctx.arc(x, y + 5, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // sun, sharp and bright — no atmosphere to soften it
  ctx.beginPath();
  ctx.arc(canvas.width * 0.82, 90, 28, 0, Math.PI * 2);
  ctx.fillStyle = '#fff8e0';
  ctx.fill();

  // Earth, hanging in the black sky
  drawEarthDisc(canvas.width * 0.22, 110, 24);
}

function drawGroundMoon() {
  const bandHeight = canvas.height - CONFIG.groundY;
  const grad = ctx.createLinearGradient(0, CONFIG.groundY, 0, canvas.height);
  grad.addColorStop(0, '#8a8a8f');
  grad.addColorStop(1, '#4a4a50');
  ctx.fillStyle = grad;
  ctx.fillRect(0, CONFIG.groundY, canvas.width, bandHeight);

  // craters, deterministic (not Math.random) so they don't jitter every frame
  ctx.strokeStyle = 'rgba(30,30,32,0.5)';
  ctx.lineWidth = 1.5;
  for (let x = 8; x < canvas.width; x += 31) {
    const r = 3 + ((x * 11) % 6);
    const y = CONFIG.groundY + 6 + ((x * 5) % 14);
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.4, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawBackground() {
  if (CONFIG.gravityLabel === 'Moon') {
    drawSkyMoon();
    drawGroundMoon();
  } else if (CONFIG.gravityLabel === 'Mars') {
    drawSkyMars();
    drawGroundMars();
  } else {
    drawSky();
    drawGroundTexture();
  }
}

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function toCanvas(xm, ym) {
  return {
    x: CONFIG.launchX + xm * currentScale,
    y: CONFIG.groundY - ym * currentScale
  };
}

// ---- physics ----
// Drag is quadratic: F = 0.5 * rho * Cd * A * v^2, opposing velocity.
// With drag in play there's no closed-form range/time formula anymore, so
// the flight is stepped forward numerically in small fixed increments.
function computeAcceleration(vx, vy) {
  let ax = 0;
  let ay = -CONFIG.gravity;
  if (CONFIG.dragEnabled && CONFIG.airDensity > 0) {
    const speed = Math.hypot(vx, vy);
    if (speed > 0) {
      const area = Math.PI * CONFIG.radius * CONFIG.radius;
      const k = (0.5 * CONFIG.airDensity * DRAG_COEFFICIENT * area) / CONFIG.mass;
      ax -= k * speed * vx;
      ay -= k * speed * vy;
    }
  }
  return { ax, ay };
}

function stepPhysics(state, dt) {
  const { ax, ay } = computeAcceleration(state.vx, state.vy);
  const vx = state.vx + ax * dt;
  const vy = state.vy + ay * dt;
  return {
    x: state.x + vx * dt,
    y: state.y + vy * dt,
    vx,
    vy
  };
}

// Runs an entire flight instantly, with no rendering, just to learn its
// range/peak height/duration. Used to size the camera and to preview a
// shot before it's fired — the real animated flight is a separate,
// incremental simulation driven by the render loop.
function simulateFullShot(height, speed, angleDeg) {
  const angleRad = degToRad(angleDeg);
  let state = { x: 0, y: height, vx: speed * Math.cos(angleRad), vy: speed * Math.sin(angleRad) };
  let t = 0;
  let maxHeightM = height;

  while (t < MAX_SIM_TIME) {
    const prev = state;
    state = stepPhysics(state, PHYSICS_DT);
    t += PHYSICS_DT;
    if (state.y > maxHeightM) maxHeightM = state.y;
    if (state.y <= 0) {
      const frac = prev.y / (prev.y - state.y);
      state = {
        x: prev.x + (state.x - prev.x) * frac,
        y: 0,
        vx: prev.vx + (state.vx - prev.vx) * frac,
        vy: prev.vy + (state.vy - prev.vy) * frac
      };
      t = t - PHYSICS_DT + PHYSICS_DT * frac;
      break;
    }
  }

  return { rangeM: state.x, maxHeightM, timeS: t, finalVx: state.vx, finalVy: state.vy };
}

function requiredScaleForBounds(rangeM, maxHeightM) {
  const scaleX = rangeM > 0 ? (canvas.width - CONFIG.launchX - ZOOM_MARGIN_RIGHT) / rangeM : CONFIG.pxPerMeter;
  const scaleY = maxHeightM > 0 ? (CONFIG.groundY - ZOOM_MARGIN_TOP) / maxHeightM : CONFIG.pxPerMeter;
  return Math.min(CONFIG.pxPerMeter, scaleX, scaleY);
}

// ---- animation state ----
let flying = false;
let landed = false;
let draggingPillar = false;
let armAngleDeg = 0;      // current visual arm angle (degrees); set from idleArmTarget() at init
let armPhase = 'idle';    // 'idle' | 'wind' | 'follow' | 'return'
let armPhaseElapsed = 0;
let armWindStart = 0;     // arm angle captured at the instant Launch is pressed
let liveState = null;     // { x, y, vx, vy }, updated incrementally while flying
let accumulator = 0;
let flightElapsed = 0;
let launchHeight = 0;
let maxHeightSoFar = 0;
let tracePoints = [];     // in meters; converted to canvas coords at draw time
let lastTimestamp = null;
let lastResult = null;    // { rangeM, timeS, maxHeightM }, set when a shot lands
let previewBounds = null; // { rangeM, maxHeightM }, recomputed whenever a slider changes
let flightBounds = null;  // same, captured at fire time for camera sizing
let currentScale = CONFIG.pxPerMeter;
let targetScale = CONFIG.pxPerMeter;

function refreshPreviewBounds() {
  previewBounds = simulateFullShot(CONFIG.height, CONFIG.speed, CONFIG.angleDeg);
}

// Winds the arm up from wherever it's currently resting to the release
// angle; the flight itself begins the instant the swing finishes (see
// updateArm), so the ball always leaves from exactly where the cup is drawn.
function fireCatapult() {
  if (flying || armPhase === 'wind') return;
  landed = false;
  lastResult = null;
  armWindStart = armAngleDeg;
  armPhase = 'wind';
  armPhaseElapsed = 0;
}

function beginFlight() {
  const angleRad = degToRad(CONFIG.angleDeg);

  // Start the flight exactly where the arm's cup releases the ball —
  // computed with the same catapultTip() used to draw it, so there's no
  // gap between the visual release point and the physics origin.
  const top = toCanvas(0, CONFIG.height);
  const anchor = catapultAnchor(CONFIG.height);
  const pivot = catapultPivot(anchor);
  const tip = catapultTip(pivot, CONFIG.angleDeg);
  const startX = (tip.x - top.x) / currentScale;
  const startY = CONFIG.height + (top.y - tip.y) / currentScale;

  liveState = {
    x: startX,
    y: startY,
    vx: CONFIG.speed * Math.cos(angleRad),
    vy: CONFIG.speed * Math.sin(angleRad)
  };
  launchHeight = CONFIG.height;
  maxHeightSoFar = startY;
  accumulator = 0;
  flightElapsed = 0;
  tracePoints = [];
  flying = true;

  flightBounds = simulateFullShot(CONFIG.height, CONFIG.speed, CONFIG.angleDeg);
}

function advancePhysics(dt) {
  accumulator += dt;
  while (accumulator >= PHYSICS_DT) {
    const prev = liveState;
    liveState = stepPhysics(liveState, PHYSICS_DT);
    accumulator -= PHYSICS_DT;
    flightElapsed += PHYSICS_DT;

    if (liveState.y > maxHeightSoFar) maxHeightSoFar = liveState.y;

    if (liveState.y <= 0) {
      const frac = prev.y / (prev.y - liveState.y);
      liveState = {
        x: prev.x + (liveState.x - prev.x) * frac,
        y: 0,
        vx: prev.vx + (liveState.vx - prev.vx) * frac,
        vy: prev.vy + (liveState.vy - prev.vy) * frac
      };
      flightElapsed = flightElapsed - PHYSICS_DT + PHYSICS_DT * frac;
      flying = false;
      landed = true;
      lastResult = {
        rangeM: liveState.x,
        timeS: flightElapsed,
        maxHeightM: maxHeightSoFar
      };
      accumulator = 0;
      break;
    }
  }
}

// ---- drawing ----
function ballPixelRadius() {
  return Math.max(3, CONFIG.radius * currentScale);
}

function pillarPixelRadius() {
  return Math.max(9, Math.min(26, 15 * (currentScale / CONFIG.pxPerMeter)));
}

function catapultAnchor(heightM) {
  const top = toCanvas(0, heightM);
  return { x: top.x, y: top.y - CATAPULT_ANCHOR_LIFT };
}

function catapultPivot(anchor) {
  return { x: anchor.x, y: anchor.y - CART_HEIGHT * 0.5 - POST_HEIGHT };
}

function catapultTip(pivot, armDeg) {
  const angleRad = degToRad(armDeg);
  return {
    x: pivot.x + ARM_LENGTH * Math.cos(angleRad),
    y: pivot.y - ARM_LENGTH * Math.sin(angleRad)
  };
}

// The loaded/idle arm angle isn't fixed — it sits pulled back on the far
// side of the pivot from wherever the angle slider is currently aiming, so
// dragging the slider visibly swings the loaded arm even before you launch.
function idleArmTarget() {
  return CONFIG.angleDeg - ARM_COCKED_OFFSET_DEG;
}

function drawGround() {
  ctx.beginPath();
  ctx.moveTo(0, CONFIG.groundY);
  ctx.lineTo(canvas.width, CONFIG.groundY);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#666';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Ground', 10, CONFIG.groundY + 18);
}

function drawPillar(heightM) {
  const base = toCanvas(0, 0);
  const top = toCanvas(0, heightM);
  const r = pillarPixelRadius();
  const capRy = r * 0.35;

  if (heightM > 0.02) {
    ctx.fillStyle = '#7d7d86';
    ctx.fillRect(top.x - r, top.y, r * 2, base.y - top.y);

    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(top.x + r * 0.3, top.y, r * 0.7, base.y - top.y);

    ctx.strokeStyle = '#4d4d54';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(top.x - r, top.y);
    ctx.lineTo(top.x - r, base.y);
    ctx.moveTo(top.x + r, top.y);
    ctx.lineTo(top.x + r, base.y);
    ctx.stroke();
  }

  ctx.fillStyle = '#96969e';
  ctx.beginPath();
  ctx.ellipse(top.x, top.y, r, capRy, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#4d4d54';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = '#888';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(heightM.toFixed(1) + ' m', top.x - r - 8, top.y + 4);
}

// Draws the wheeled cart, its post, the brace strut and the throwing arm
// at the given arm angle (degrees). Returns the tip/cup position, which
// doubles as the flight's true launch origin.
function drawCatapult(anchor, armDeg) {
  const bedY = anchor.y - CART_HEIGHT * 0.5;

  // wheels
  [-1, 1].forEach((side) => {
    const wx = anchor.x + side * CART_WIDTH * 0.28;
    const wy = anchor.y + CART_HEIGHT * 0.5;
    ctx.fillStyle = '#3a2c1e';
    ctx.beginPath();
    ctx.arc(wx, wy, WHEEL_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#caa06a';
    ctx.beginPath();
    ctx.arc(wx, wy, WHEEL_RADIUS * 0.4, 0, Math.PI * 2);
    ctx.fill();
  });

  // cart bed
  ctx.fillStyle = '#8a6a4a';
  ctx.fillRect(anchor.x - CART_WIDTH / 2, bedY, CART_WIDTH, CART_HEIGHT);
  ctx.fillStyle = '#a3703f';
  ctx.fillRect(anchor.x - CART_WIDTH / 2, bedY, CART_WIDTH, CART_HEIGHT * 0.35);

  // post
  const postFoot = { x: anchor.x, y: bedY };
  const pivot = catapultPivot(anchor);
  ctx.strokeStyle = '#6b4c30';
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(postFoot.x, postFoot.y);
  ctx.lineTo(pivot.x, pivot.y);
  ctx.stroke();

  const tip = catapultTip(pivot, armDeg);
  const angleRad = degToRad(armDeg);
  const joint = {
    x: pivot.x + ARM_LENGTH * ARM_JOINT_T * Math.cos(angleRad),
    y: pivot.y - ARM_LENGTH * ARM_JOINT_T * Math.sin(angleRad)
  };
  const strutFoot = { x: postFoot.x - CART_WIDTH * 0.3, y: postFoot.y - 3 };

  // brace strut — the shorter, darker second arm bracing the throwing arm
  ctx.strokeStyle = '#5a3f28';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(strutFoot.x, strutFoot.y);
  ctx.lineTo(joint.x, joint.y);
  ctx.stroke();

  // main throwing arm
  ctx.strokeStyle = '#c9a06a';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(pivot.x, pivot.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.lineCap = 'butt';

  // pivot + joint pins
  ctx.fillStyle = '#2e2115';
  ctx.beginPath();
  ctx.arc(pivot.x, pivot.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#eee';
  ctx.beginPath();
  ctx.arc(joint.x, joint.y, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#2e2115';
  ctx.lineWidth = 1;
  ctx.stroke();

  return tip;
}

function drawTrajectoryTrace() {
  if (!CONFIG.showTrace || tracePoints.length < 2) return;
  ctx.beginPath();
  ctx.setLineDash([5, 5]);
  tracePoints.forEach((pt, i) => {
    const c = toCanvas(pt.x, pt.y);
    if (i === 0) {
      ctx.moveTo(c.x, c.y);
    } else {
      ctx.lineTo(c.x, c.y);
    }
  });
  ctx.strokeStyle = 'rgba(120, 200, 255, 0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawProjectile(c) {
  ctx.beginPath();
  ctx.arc(c.x, c.y, ballPixelRadius(), 0, Math.PI * 2);
  ctx.fillStyle = '#ffd45e';
  ctx.fill();
}

function drawArrow(x0, y0, dx, dy, color, label) {
  if (Math.hypot(dx, dy) < 1) return; // skip drawing near-zero vectors
  const x1 = x0 + dx;
  const y1 = y0 + dy;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  const angle = Math.atan2(dy, dx);
  const headLen = 8;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - headLen * Math.cos(angle - Math.PI / 6), y1 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x1 - headLen * Math.cos(angle + Math.PI / 6), y1 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();

  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(label, x1 + 4, y1 + 4);
}

function drawVectors(c, p) {
  if (!CONFIG.showVectors) return;
  const s = CONFIG.vectorPxPerSpeed * (currentScale / CONFIG.pxPerMeter);
  drawArrow(c.x, c.y, p.vx * s, 0, '#5ec8ff', 'vx');
  drawArrow(c.x, c.y, 0, -p.vy * s, '#ff8a65', 'vy');
}

function drawSpeedValues(p) {
  if (!CONFIG.showSpeedValues) return;
  const speed = Math.hypot(p.vx, p.vy);
  ctx.textAlign = 'left';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#999';
  const lines = [
    'vx = ' + p.vx.toFixed(1) + ' m/s',
    'vy = ' + p.vy.toFixed(1) + ' m/s',
    '|v| = ' + speed.toFixed(1) + ' m/s'
  ];
  lines.forEach((line, i) => {
    ctx.fillText(line, 16, 24 + i * 16);
  });
}

function drawLastResult() {
  if (!lastResult) return;
  ctx.textAlign = 'left';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#7dff8f';
  const lines = [
    'Landed — range: ' + lastResult.rangeM.toFixed(1) + ' m',
    'Flight time: ' + lastResult.timeS.toFixed(2) + ' s',
    'Max height: ' + lastResult.maxHeightM.toFixed(1) + ' m'
  ];
  lines.forEach((line, i) => {
    ctx.fillText(line, 16, canvas.height - 16 - (lines.length - 1 - i) * 16);
  });
}

function drawGravityLabel() {
  ctx.textAlign = 'right';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#999';
  ctx.fillText(
    'g = ' + CONFIG.gravity.toFixed(2) + ' m/s² (' + CONFIG.gravityLabel + ')',
    canvas.width - 16,
    24
  );
}

function drawObjectLabel() {
  ctx.textAlign = 'right';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#999';
  const dragText = CONFIG.dragEnabled ? 'drag on' : 'drag off';
  ctx.fillText(
    'r = ' + CONFIG.radius.toFixed(2) + ' m, m = ' + CONFIG.mass.toFixed(2) + ' kg (' + dragText + ')',
    canvas.width - 16,
    40
  );
}

// ---- render + loop ----
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBackground();

  const pillarHeight = flying ? launchHeight : CONFIG.height;
  const anchor = catapultAnchor(pillarHeight);

  drawGround();
  drawPillar(pillarHeight);
  const tip = drawCatapult(anchor, armAngleDeg);

  if (flying) {
    const p = liveState;
    const c = toCanvas(p.x, p.y);
    drawTrajectoryTrace();
    drawProjectile(c);
    drawVectors(c, p);
    drawSpeedValues(p);
  } else {
    drawProjectile(tip); // next ball, loaded and ready — set angle/speed with the sliders
    const angleRad = degToRad(CONFIG.angleDeg);
    const p = { vx: CONFIG.speed * Math.cos(angleRad), vy: CONFIG.speed * Math.sin(angleRad) };
    drawVectors(tip, p);
    drawSpeedValues(p);

    if (landed) {
      // also show where the last shot came to rest, faded so it doesn't
      // get mistaken for the loaded ball
      const lp = liveState;
      const lc = toCanvas(lp.x, lp.y);
      lc.y = CONFIG.groundY - ballPixelRadius();
      ctx.save();
      ctx.globalAlpha = 0.55;
      drawProjectile(lc);
      ctx.restore();
    }
  }

  drawLastResult();
  drawGravityLabel();
  drawObjectLabel();
}

// Drives the arm through four states: idle (tracks the angle slider,
// pulled back on the far side of the pivot), wind (the throw itself,
// ending exactly when beginFlight() fires), follow (a quick whip past the
// release point) and return (easing back down to loaded).
function updateArm(dt) {
  if (armPhase === 'wind') {
    armPhaseElapsed += dt;
    const t = Math.min(1, armPhaseElapsed / ARM_WIND_DURATION);
    const eased = t * t; // slow start, fast whip through release
    armAngleDeg = armWindStart + (CONFIG.angleDeg - armWindStart) * eased;
    if (t >= 1) {
      armAngleDeg = CONFIG.angleDeg;
      beginFlight();
      armPhase = 'follow';
      armPhaseElapsed = 0;
    }
    return;
  }

  if (armPhase === 'follow') {
    armPhaseElapsed += dt;
    const t = Math.min(1, armPhaseElapsed / ARM_FOLLOW_DURATION);
    const eased = 1 - Math.pow(1 - t, 2);
    armAngleDeg = CONFIG.angleDeg + ARM_FOLLOWTHROUGH_DEG * eased;
    if (t >= 1) { armPhase = 'return'; armPhaseElapsed = 0; }
    return;
  }

  if (armPhase === 'return') {
    armPhaseElapsed += dt;
    const t = Math.min(1, armPhaseElapsed / ARM_RETURN_DURATION);
    const eased = 1 - Math.pow(1 - t, 3);
    const from = CONFIG.angleDeg + ARM_FOLLOWTHROUGH_DEG;
    const target = idleArmTarget();
    armAngleDeg = from + (target - from) * eased;
    if (t >= 1) { armPhase = 'idle'; }
    return;
  }

  // idle: keep the loaded arm smoothly tracking the angle slider
  const target = idleArmTarget();
  armAngleDeg += (target - armAngleDeg) * Math.min(1, ARM_IDLE_LERP_RATE * dt);
}

function loop(now) {
  const bounds = flying ? flightBounds : previewBounds;
  targetScale = requiredScaleForBounds(bounds.rangeM, bounds.maxHeightM);

  if (lastTimestamp !== null) {
    const dt = (now - lastTimestamp) / 1000;
    currentScale += (targetScale - currentScale) * Math.min(1, ZOOM_LERP_RATE * dt);
    updateArm(dt);

    if (flying && CONFIG.running) {
      advancePhysics(dt);
      tracePoints.push({ x: liveState.x, y: liveState.y });
    }
  }
  lastTimestamp = now;
  render();
  requestAnimationFrame(loop);
}

// ---- controls ----
const heightSlider = document.getElementById('heightSlider');
const heightValue = document.getElementById('heightValue');
heightSlider.addEventListener('input', () => {
  CONFIG.height = parseFloat(heightSlider.value);
  heightValue.textContent = CONFIG.height;
  refreshPreviewBounds();
});

const speedSlider = document.getElementById('speedSlider');
const speedValue = document.getElementById('speedValue');
speedSlider.addEventListener('input', () => {
  CONFIG.speed = parseFloat(speedSlider.value);
  speedValue.textContent = CONFIG.speed;
  refreshPreviewBounds();
});

const angleSlider = document.getElementById('angleSlider');
const angleValue = document.getElementById('angleValue');
angleSlider.addEventListener('input', () => {
  CONFIG.angleDeg = parseFloat(angleSlider.value);
  angleValue.textContent = CONFIG.angleDeg;
  refreshPreviewBounds();
});

const radiusSlider = document.getElementById('radiusSlider');
const radiusValue = document.getElementById('radiusValue');
radiusSlider.addEventListener('input', () => {
  CONFIG.radius = parseFloat(radiusSlider.value);
  radiusValue.textContent = CONFIG.radius.toFixed(2);
  refreshPreviewBounds();
});

const massSlider = document.getElementById('massSlider');
const massValue = document.getElementById('massValue');
massSlider.addEventListener('input', () => {
  CONFIG.mass = parseFloat(massSlider.value);
  massValue.textContent = CONFIG.mass.toFixed(2);
  refreshPreviewBounds();
});

const dragCheckbox = document.getElementById('dragCheckbox');
dragCheckbox.addEventListener('change', (e) => {
  CONFIG.dragEnabled = e.target.checked;
  refreshPreviewBounds();
});

const gravitySelect = document.getElementById('gravitySelect');
gravitySelect.addEventListener('change', () => {
  const planet = PLANETS[gravitySelect.value];
  CONFIG.gravity = planet.gravity;
  CONFIG.airDensity = planet.airDensity;
  CONFIG.gravityLabel = planet.label;
  refreshPreviewBounds();
});

document.getElementById('vectorsCheckbox').addEventListener('change', (e) => {
  CONFIG.showVectors = e.target.checked;
});
document.getElementById('traceCheckbox').addEventListener('change', (e) => {
  CONFIG.showTrace = e.target.checked;
});
document.getElementById('speedValuesCheckbox').addEventListener('change', (e) => {
  CONFIG.showSpeedValues = e.target.checked;
});

document.getElementById('launchBtn').addEventListener('click', () => {
  fireCatapult();
});

const pauseBtn = document.getElementById('pauseBtn');
pauseBtn.addEventListener('click', () => {
  CONFIG.running = !CONFIG.running;
  pauseBtn.textContent = CONFIG.running ? 'Pause' : 'Resume';
});

// ---- interaction: drag the pillar to resize it ----
function canvasPointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height)
  };
}

function isNearPillar(pt) {
  if (flying || armPhase !== 'idle') return false;
  const base = toCanvas(0, 0);
  const top = toCanvas(0, CONFIG.height);
  const r = pillarPixelRadius();
  return (
    pt.x >= top.x - r - 10 &&
    pt.x <= top.x + r + 10 &&
    pt.y >= top.y - 15 &&
    pt.y <= base.y + 5
  );
}

function updatePillarHeightFromPointer(pt) {
  const base = toCanvas(0, 0);
  const heightPx = Math.max(0, base.y - pt.y);
  let heightM = heightPx / currentScale;
  const min = parseFloat(heightSlider.min);
  const max = parseFloat(heightSlider.max);
  heightM = Math.min(max, Math.max(min, heightM));
  CONFIG.height = Math.round(heightM);
  heightSlider.value = CONFIG.height;
  heightValue.textContent = CONFIG.height;
  refreshPreviewBounds();
}

canvas.addEventListener('pointerdown', (e) => {
  const pt = canvasPointFromEvent(e);
  if (isNearPillar(pt)) {
    draggingPillar = true;
    canvas.setPointerCapture(e.pointerId);
    updatePillarHeightFromPointer(pt);
    canvas.style.cursor = 'ns-resize';
  }
});

canvas.addEventListener('pointermove', (e) => {
  const pt = canvasPointFromEvent(e);
  if (draggingPillar) {
    updatePillarHeightFromPointer(pt);
  } else {
    canvas.style.cursor = isNearPillar(pt) ? 'ns-resize' : 'default';
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (draggingPillar) {
    draggingPillar = false;
    canvas.releasePointerCapture(e.pointerId);
    const pt = canvasPointFromEvent(e);
    canvas.style.cursor = isNearPillar(pt) ? 'ns-resize' : 'default';
  }
});

armAngleDeg = idleArmTarget();
refreshPreviewBounds();
requestAnimationFrame(loop);
