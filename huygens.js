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

// =====================================================================
// MODEL
//
// A "wavefront" is represented abstractly as a curve you can query at a
// single scalar parameter: frontPoint(param) gives a point on the curve,
// frontNormal(param) gives the unit direction the wave travels from that
// point. That's the only interface the rest of the sim needs, so the same
// ray/wavelet/envelope code works for both a circular point-source wave
// (param = angle) and a plane wave (param = distance along the front).
//
// Huygens' construction itself: every point on the current front becomes
// the center of a secondary "wavelet" — a little circle of radius
// r = v*dt (how far the wave travels in one time step). The new wavefront
// is the curve tangent to all of those wavelets. For a uniform-speed wave
// with no obstacles, that tangent point is exactly r along the normal
// from the original point — the same construction whether the front is
// circular or flat, which is the whole appeal of doing it this way.
// =====================================================================

let mode = 'circular';

const circ = { cx: 340, cy: 325, R: 70 };
// A point on the line is originX/Y + dir*s + norm*offset; norm is the
// fixed propagation direction, offset is how far the plane front has
// already traveled from its starting line.
const plane = { originX: 230, originY: 325, dirX: 0, dirY: 1, normX: 1, normY: 0, offset: 0 };

let waveSpeed = 100; // px/s, abstract units
let dtStep = 0.3;    // s

// A straight barrier with evenly-spaced gaps (slits). Position/orientation
// are set by dragging on the canvas; slit count/width come from the panel.
// This is the classic setup for using Huygens' construction to explain
// diffraction: the wall blocks the wavefront, rays, and their wavelets
// everywhere except through the openings.
const wall = { x: 560, y: 325, angle: Math.PI / 2, length: 420, slitCount: 2, slitWidth: 24, visible: true };

// The wall's solid/gap pieces as world-space segments, laid out along its
// own axis: n slits and (n+1) equal solid pieces, so the openings are
// always evenly spaced with equal barrier between them.
function wallSegments() {
  const cos = Math.cos(wall.angle), sin = Math.sin(wall.angle);
  const n = Math.max(0, Math.round(wall.slitCount));
  let w = wall.slitWidth;
  let totalGap = n * w;
  const maxGap = wall.length * 0.9; // keep at least some visible barrier material
  if (n > 0 && totalGap > maxGap) { w = maxGap / n; totalGap = maxGap; }
  const solidSeg = (wall.length - totalGap) / (n + 1);
  const pt = (t) => ({ x: wall.x + cos * t, y: wall.y + sin * t });
  const segs = [];
  let t = -wall.length / 2;
  for (let i = 0; i < n; i++) {
    segs.push({ type: 'solid', a: pt(t), b: pt(t + solidSeg) });
    t += solidSeg;
    segs.push({ type: 'gap', a: pt(t), b: pt(t + w) });
    t += w;
  }
  segs.push({ type: 'solid', a: pt(t), b: pt(t + solidSeg) });
  return segs;
}

function wallEndpoints() {
  const cos = Math.cos(wall.angle), sin = Math.sin(wall.angle);
  return {
    e1: { x: wall.x - cos * wall.length / 2, y: wall.y - sin * wall.length / 2 },
    e2: { x: wall.x + cos * wall.length / 2, y: wall.y + sin * wall.length / 2 }
  };
}

// Standard strict segment-crossing test (cross-product orientation test) —
// used to ask "does the wave's path from where it came from to this point
// pass through a solid part of the wall?"
function segmentsIntersect(p1, p2, p3, p4) {
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// A point is blocked if a solid wall segment lies between it and the exact
// point the wave disturbance there was born from — the point source for a
// circular wave, or that point's spot on the plane's starting line for a
// plane wave — traced backwards along its own propagation normal. Tracing
// back only that far (not some arbitrary long distance) matters: a longer
// trace would overshoot past the source and could clip a wall segment the
// wave never actually passed through on its real, shorter path.
function isBlocked(pt, normal, backDist) {
  if (!wall.visible) return false;
  const back = { x: pt.x - normal.x * backDist, y: pt.y - normal.y * backDist };
  for (const seg of wallSegments()) {
    if (seg.type === 'solid' && segmentsIntersect(back, pt, seg.a, seg.b)) return true;
  }
  return false;
}

// extra: how far along the normal beyond frontPoint(param) to test — 0 for
// the current front itself, waveletRadius() for the (offset) reference curve.
function isParamBlocked(param, extra) {
  const n = frontNormal(param);
  const p = frontPoint(param);
  const e = extra || 0;
  const testPt = e ? { x: p.x + n.x * e, y: p.y + n.y * e } : p;
  // How far this bit of the wave has actually traveled from where it was
  // born: R (+ extra) out from the point source for a circular wave, or
  // offset (+ extra) from the plane's starting line for a plane wave.
  const backDist = (mode === 'circular' ? circ.R : plane.offset) + e;
  return isBlocked(testPt, n, backDist);
}

function waveletRadius() { return waveSpeed * dtStep; }

function frontPoint(param) {
  if (mode === 'circular') {
    return { x: circ.cx + circ.R * Math.cos(param), y: circ.cy + circ.R * Math.sin(param) };
  }
  const s = param;
  return {
    x: plane.originX + plane.dirX * s + plane.normX * plane.offset,
    y: plane.originY + plane.dirY * s + plane.normY * plane.offset
  };
}

function frontNormal(param) {
  if (mode === 'circular') {
    return { x: Math.cos(param), y: Math.sin(param) };
  }
  return { x: plane.normX, y: plane.normY };
}

// Unit direction ALONG the front curve itself (perpendicular to its
// normal) — used only for orienting the edge-diffraction caps below.
function frontTangent(param) {
  if (mode === 'circular') {
    return { x: -Math.sin(param), y: Math.cos(param) };
  }
  return { x: plane.dirX, y: plane.dirY };
}

// Where a click/drag point maps to on the front's own parameter line.
function paramFromPoint(pt) {
  if (mode === 'circular') {
    // Normalized to [0, 2*PI) so it sorts consistently with the angles
    // addRaysEvenly() produces — mixing atan2's (-PI, PI] range in would
    // scramble the sort order the envelope's wraparound logic depends on.
    let a = Math.atan2(pt.y - circ.cy, pt.x - circ.cx);
    if (a < 0) a += Math.PI * 2;
    return a;
  }
  const dx = pt.x - plane.originX - plane.normX * plane.offset;
  const dy = pt.y - plane.originY - plane.normY * plane.offset;
  return dx * plane.dirX + dy * plane.dirY;
}

// Perpendicular distance from a point to the current front curve — used to
// decide whether a click landed "on" the wavefront (close enough to plant
// a ray) versus elsewhere on the canvas.
function distanceFromFront(pt) {
  if (mode === 'circular') {
    return Math.abs(Math.hypot(pt.x - circ.cx, pt.y - circ.cy) - circ.R);
  }
  const dx = pt.x - plane.originX - plane.normX * plane.offset;
  const dy = pt.y - plane.originY - plane.normY * plane.offset;
  return Math.abs(dx * plane.normX + dy * plane.normY);
}

// How far apart (in parameter space) two rays can be and still be treated
// as "adjacent" when tracing the constructed-wavefront polyline. Beyond
// this, the gap between wavelets is too wide to imply a connecting curve —
// which is itself part of the teaching point (sparse rays leave visible
// gaps; only many rays approximate the smooth true wavefront).
const CIRCULAR_CONNECT_GAP = Math.PI / 2.6; // ~69°
const PLANE_CONNECT_GAP = 240; // px

let rays = []; // { id, param }
let nextRayId = 1;
let selectedRayId = null;
let dragging = null; // { type: 'ray'|'source', id? }
let stepCount = 0;

function addRay(param) {
  const ray = { id: nextRayId++, param };
  rays.push(ray);
  selectedRayId = ray.id;
  return ray;
}

function addRaysEvenly(n) {
  if (mode === 'circular') {
    for (let i = 0; i < n; i++) {
      const param = (i / n) * Math.PI * 2;
      if (!isParamBlocked(param, 0)) addRay(param);
    }
  } else {
    // Spread evenly across the visible span of the line on screen.
    const span = 560;
    const start = -span / 2;
    for (let i = 0; i < n; i++) {
      const param = start + (n === 1 ? span / 2 : (i / (n - 1)) * span);
      if (!isParamBlocked(param, 0)) addRay(param);
    }
  }
  selectedRayId = null;
}

function clearRays() {
  rays = [];
  selectedRayId = null;
}

// Samples the front curve (optionally offset outward by `extra`, for the
// dashed reference curve) into fine steps and returns the runs of
// contiguous unblocked points — i.e. what's actually visible with the wall
// in the way. With no wall (or wall hidden) this is just one run covering
// the whole curve.
function curveRuns(extra) {
  const samples = [];
  if (mode === 'circular') {
    const N = 240;
    for (let i = 0; i <= N; i++) {
      const param = (i / N) * Math.PI * 2;
      samples.push({ param, blocked: isParamBlocked(param, extra) });
    }
  } else {
    const N = 250;
    for (let i = 0; i <= N; i++) {
      const param = -1000 + (i / N) * 2000;
      samples.push({ param, blocked: isParamBlocked(param, extra) });
    }
  }
  const runs = [];
  let current = [];
  for (const s of samples) {
    if (!s.blocked) {
      current.push(s.param);
    } else if (current.length) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);
  if (mode === 'circular' && runs.length > 1 && !samples[0].blocked && !samples[samples.length - 1].blocked) {
    const firstRun = runs[0], lastRun = runs[runs.length - 1];
    if (firstRun !== lastRun) {
      runs[0] = lastRun.concat(firstRun);
      runs.pop();
    }
  }
  return runs;
}

function advanceFront() {
  const r = waveletRadius();
  if (mode === 'circular') {
    circ.R += r;
  } else {
    plane.offset += r;
  }
  clearRays();
  stepCount++;
}

function resetSim() {
  if (mode === 'circular') {
    circ.cx = 340; circ.cy = 325; circ.R = 70;
  } else {
    plane.originX = 230; plane.originY = 325; plane.offset = 0;
  }
  clearRays();
  stepCount = 0;
}

// The constructed wavefront: for every ray, the point r along its normal
// (the point where its wavelet touches the new front) plus a short tangent
// segment there; consecutive rays (sorted along the front) are chained
// into polylines wherever they're close enough to imply a continuous curve.
function computeEnvelope() {
  const r = waveletRadius();
  const tangentPoints = rays.map((ray) => {
    const p = frontPoint(ray.param);
    const n = frontNormal(ray.param);
    return { id: ray.id, param: ray.param, x: p.x + n.x * r, y: p.y + n.y * r, nx: n.x, ny: n.y };
  });
  tangentPoints.sort((a, b) => a.param - b.param);

  const chains = [];
  let current = [];
  for (let i = 0; i < tangentPoints.length; i++) {
    const pt = tangentPoints[i];
    if (current.length === 0) {
      current.push(pt);
    } else {
      const prev = current[current.length - 1];
      const gap = pt.param - prev.param;
      const threshold = mode === 'circular' ? CIRCULAR_CONNECT_GAP : PLANE_CONNECT_GAP;
      if (gap <= threshold) {
        current.push(pt);
      } else {
        chains.push(current);
        current = [pt];
      }
    }
  }
  if (current.length) chains.push(current);

  // Circular fronts wrap around — stitch the last chain back to the first
  // if the wraparound gap is also small enough. chainClosed tracks, per
  // chain, whether it truly forms a closed loop with no open ends (only
  // the "one chain wraps all the way around on its own" case below) —
  // drawEnvelope() uses this to know which chains should get an
  // edge-diffraction cap and which are already seamless.
  let chainClosed = chains.map(() => false);
  if (mode === 'circular' && chains.length > 1 && tangentPoints.length > 1) {
    const first = tangentPoints[0], last = tangentPoints[tangentPoints.length - 1];
    const wrapGap = first.param + Math.PI * 2 - last.param;
    if (wrapGap <= CIRCULAR_CONNECT_GAP && chains[0] !== chains[chains.length - 1]) {
      const lastChain = chains.pop();
      chains[0] = lastChain.concat(chains[0]);
      chainClosed.pop();
    }
  } else if (mode === 'circular' && chains.length === 1 && tangentPoints.length > 2) {
    const first = tangentPoints[0], last = tangentPoints[tangentPoints.length - 1];
    const wrapGap = first.param + Math.PI * 2 - last.param;
    if (wrapGap <= CIRCULAR_CONNECT_GAP) {
      chains[0] = chains[0].concat([Object.assign({}, first)]);
      chainClosed[0] = true;
    }
  }

  return tangentPoints.length ? { tangentPoints, chains, chainClosed } : null;
}

// The classic Huygens argument for diffraction: at an open end of a ray
// chain — wherever the user's own manually-placed secondary sources stop,
// such as at the edge of a slit — the wavefront doesn't cut off flat. It
// curls around that last ray's own wavelet circle, starting from the point
// that matches the interior tangent direction and sweeping 90° toward
// whichever side has nothing else covering it. isLowEnd picks which of the
// two directions along the front ("towards lower param" or "towards higher
// param") counts as outward for this particular end.
const EDGE_CAP_STEPS = 10;
function edgeCapPoints(param, isLowEnd) {
  const p = frontPoint(param);
  const n = frontNormal(param);
  const t = frontTangent(param);
  const r = waveletRadius();
  const outward = isLowEnd ? { x: -t.x, y: -t.y } : { x: t.x, y: t.y };
  const theta0 = Math.atan2(n.y, n.x);
  const ccw = { x: -n.y, y: n.x };
  const cw = { x: n.y, y: -n.x };
  const sign = (ccw.x * outward.x + ccw.y * outward.y) >= (cw.x * outward.x + cw.y * outward.y) ? 1 : -1;
  const pts = [];
  for (let i = 0; i <= EDGE_CAP_STEPS; i++) {
    const theta = theta0 + sign * (Math.PI / 2) * (i / EDGE_CAP_STEPS);
    pts.push({ x: p.x + r * Math.cos(theta), y: p.y + r * Math.sin(theta) });
  }
  return pts;
}

// =====================================================================
// INTERACTION
// =====================================================================

const RAY_HIT_R = 10;
const FRONT_CLICK_TOLERANCE = 14;

function canvasPointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (LOGICAL_WIDTH / rect.width),
    y: (e.clientY - rect.top) * (LOGICAL_HEIGHT / rect.height)
  };
}

function hitTestRay(pt) {
  let best = null, bestDist = Infinity;
  for (const ray of rays) {
    const p = frontPoint(ray.param);
    const d = Math.hypot(pt.x - p.x, pt.y - p.y);
    if (d <= RAY_HIT_R && d < bestDist) { bestDist = d; best = ray; }
  }
  return best;
}

function hitTestSource(pt) {
  if (mode === 'circular') {
    return Math.hypot(pt.x - circ.cx, pt.y - circ.cy) <= 9;
  }
  return Math.hypot(pt.x - plane.originX, pt.y - plane.originY) <= 9;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function hitTestWallEnd(pt) {
  if (!wall.visible) return null;
  const { e1, e2 } = wallEndpoints();
  if (Math.hypot(pt.x - e1.x, pt.y - e1.y) <= 10) return 'e1';
  if (Math.hypot(pt.x - e2.x, pt.y - e2.y) <= 10) return 'e2';
  return null;
}

function hitTestWallBody(pt) {
  if (!wall.visible) return false;
  const { e1, e2 } = wallEndpoints();
  return distToSegment(pt, e1, e2) <= 10;
}

canvas.addEventListener('pointerdown', (e) => {
  const pt = canvasPointFromEvent(e);

  const ray = hitTestRay(pt);
  if (ray) {
    selectedRayId = ray.id;
    dragging = { type: 'ray', id: ray.id };
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  if (hitTestSource(pt)) {
    dragging = { type: 'source', startPt: pt, startCx: circ.cx, startCy: circ.cy, startOx: plane.originX, startOy: plane.originY };
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  const wallEnd = hitTestWallEnd(pt);
  if (wallEnd && (e.ctrlKey || e.metaKey)) {
    // Ctrl/Cmd + drag a wall end rotates it around its own center — same
    // gesture as rotating a part in the circuit-builder sim.
    dragging = { type: 'wallRotate', grabbedEnd: wallEnd };
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  if (hitTestWallBody(pt)) {
    dragging = { type: 'wall', startPt: pt, startX: wall.x, startY: wall.y };
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  if (distanceFromFront(pt) <= FRONT_CLICK_TOLERANCE && !isParamBlocked(paramFromPoint(pt), 0)) {
    addRay(paramFromPoint(pt));
    dragging = { type: 'ray', id: selectedRayId };
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  selectedRayId = null;
});

canvas.addEventListener('pointermove', (e) => {
  const pt = canvasPointFromEvent(e);
  if (!dragging) {
    const onFront = distanceFromFront(pt) <= FRONT_CLICK_TOLERANCE && !isParamBlocked(paramFromPoint(pt), 0);
    const hot = hitTestRay(pt) || hitTestSource(pt) || hitTestWallBody(pt) || onFront;
    canvas.style.cursor = hot ? 'pointer' : 'default';
    return;
  }
  if (dragging.type === 'ray') {
    const ray = rays.find((r) => r.id === dragging.id);
    if (ray) ray.param = paramFromPoint(pt);
  } else if (dragging.type === 'source') {
    if (mode === 'circular') {
      circ.cx = dragging.startCx + (pt.x - dragging.startPt.x);
      circ.cy = dragging.startCy + (pt.y - dragging.startPt.y);
    } else {
      plane.originX = dragging.startOx + (pt.x - dragging.startPt.x);
      plane.originY = dragging.startOy + (pt.y - dragging.startPt.y);
    }
  } else if (dragging.type === 'wall') {
    wall.x = dragging.startX + (pt.x - dragging.startPt.x);
    wall.y = dragging.startY + (pt.y - dragging.startPt.y);
  } else if (dragging.type === 'wallRotate') {
    let a = Math.atan2(pt.y - wall.y, pt.x - wall.x);
    if (dragging.grabbedEnd === 'e1') a -= Math.PI;
    const snap = Math.PI / 36; // 5°
    wall.angle = Math.round(a / snap) * snap;
  }
  canvas.style.cursor = 'grabbing';
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
  if (selectedRayId == null) return;
  rays = rays.filter((r) => r.id !== selectedRayId);
  selectedRayId = null;
  e.preventDefault();
});

// ---- controls ----
const modeSelect = document.getElementById('modeSelect');
const speedSlider = document.getElementById('speedSlider');
const speedValue = document.getElementById('speedValue');
const dtSlider = document.getElementById('dtSlider');
const dtValue = document.getElementById('dtValue');
const readout = document.getElementById('readout');
const rayCountInput = document.getElementById('rayCount');
const showRaysBox = document.getElementById('showRays');
const showWaveletsBox = document.getElementById('showWavelets');
const showNewFrontBox = document.getElementById('showNewFront');
const showReferenceBox = document.getElementById('showReference');
const showWallBox = document.getElementById('showWall');
const slitCountSlider = document.getElementById('slitCountSlider');
const slitCountValue = document.getElementById('slitCountValue');
const slitWidthSlider = document.getElementById('slitWidthSlider');
const slitWidthValue = document.getElementById('slitWidthValue');

modeSelect.addEventListener('change', () => {
  mode = modeSelect.value;
  resetSim();
});
speedSlider.addEventListener('input', () => {
  waveSpeed = parseFloat(speedSlider.value);
  speedValue.textContent = waveSpeed.toFixed(0);
  updateReadout();
});
dtSlider.addEventListener('input', () => {
  dtStep = parseFloat(dtSlider.value);
  dtValue.textContent = dtStep.toFixed(2) + ' s';
  updateReadout();
});
document.getElementById('addRaysBtn').addEventListener('click', () => {
  const n = Math.max(1, Math.min(72, parseInt(rayCountInput.value, 10) || 1));
  addRaysEvenly(n);
});
document.getElementById('clearRaysBtn').addEventListener('click', clearRays);
document.getElementById('advanceBtn').addEventListener('click', advanceFront);
document.getElementById('resetBtn').addEventListener('click', resetSim);

showWallBox.addEventListener('change', () => { wall.visible = showWallBox.checked; });
slitCountSlider.addEventListener('input', () => {
  wall.slitCount = parseInt(slitCountSlider.value, 10);
  slitCountValue.textContent = wall.slitCount;
});
slitWidthSlider.addEventListener('input', () => {
  wall.slitWidth = parseFloat(slitWidthSlider.value);
  slitWidthValue.textContent = wall.slitWidth.toFixed(0) + ' px';
});
document.getElementById('resetWallBtn').addEventListener('click', () => {
  wall.x = 560; wall.y = 325; wall.angle = Math.PI / 2;
});

function updateReadout() {
  const r = waveletRadius();
  const frontMeasure = mode === 'circular' ? 'Radius R = ' + circ.R.toFixed(0) + ' px' : 'Offset = ' + plane.offset.toFixed(0) + ' px';
  readout.innerHTML =
    'Wavelet radius <b>r = v&middot;&Delta;t = ' + r.toFixed(1) + ' px</b><br>' +
    frontMeasure + '<br>' +
    'Rays placed: <b>' + rays.length + '</b> &middot; Step: <b>' + stepCount + '</b>';
}

// =====================================================================
// RENDERING
// =====================================================================

function strokeRuns(runs, offset) {
  for (const run of runs) {
    if (run.length < 2) continue;
    ctx.beginPath();
    for (let i = 0; i < run.length; i++) {
      const p = frontPoint(run[i]);
      let x = p.x, y = p.y;
      if (offset) {
        const n = frontNormal(run[i]);
        x += n.x * offset;
        y += n.y * offset;
      }
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function drawCurrentFront() {
  ctx.strokeStyle = '#1a73c7';
  ctx.lineWidth = 2.5;
  strokeRuns(curveRuns(0), 0);
}

function drawSource() {
  ctx.fillStyle = '#1a73c7';
  ctx.strokeStyle = '#0d4a80';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (mode === 'circular') {
    ctx.arc(circ.cx, circ.cy, 5, 0, Math.PI * 2);
  } else {
    ctx.arc(plane.originX, plane.originY, 5, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
}

function drawRays() {
  const r = waveletRadius();
  for (const ray of rays) {
    const p = frontPoint(ray.param);
    const n = frontNormal(ray.param);
    const selected = ray.id === selectedRayId;
    ctx.strokeStyle = selected ? '#e0672a' : '#999';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + n.x * r * 1.25, p.y + n.y * r * 1.25);
    ctx.stroke();
    // small arrowhead
    const ang = Math.atan2(n.y, n.x);
    const ax = p.x + n.x * r * 1.25, ay = p.y + n.y * r * 1.25;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - 6 * Math.cos(ang - 0.4), ay - 6 * Math.sin(ang - 0.4));
    ctx.lineTo(ax - 6 * Math.cos(ang + 0.4), ay - 6 * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fillStyle = selected ? '#e0672a' : '#999';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, selected ? 5.5 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = selected ? '#e0672a' : '#1a73c7';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
  }
}

function drawWavelets() {
  const r = waveletRadius();
  ctx.strokeStyle = 'rgba(26,115,199,0.45)';
  ctx.lineWidth = 1;
  for (const ray of rays) {
    const p = frontPoint(ray.param);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawEnvelope() {
  const env = computeEnvelope();
  if (!env) return;
  const { tangentPoints, chains, chainClosed } = env;

  // the connecting curve(s) — an open chain (one that isn't already a
  // seamless closed loop) gets a 90° edge-diffraction cap at each end, so
  // manually stopping your rays at a slit's edge actually shows the wave
  // curling into the shadow instead of just cutting off flat.
  ctx.strokeStyle = '#2ecc71';
  ctx.lineWidth = 2.5;
  chains.forEach((chain, i) => {
    if (chain.length < 1) return;
    let pts = chain.map((p) => ({ x: p.x, y: p.y }));
    if (!chainClosed[i]) {
      const lowCap = edgeCapPoints(chain[0].param, true);
      const highCap = edgeCapPoints(chain[chain.length - 1].param, false);
      pts = lowCap.slice(1).reverse().concat(pts, highCap.slice(1));
    }
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.stroke();
  });

  // a short tangent line at each wavelet, showing it touches the new front
  const TAN_HALF = 11;
  ctx.strokeStyle = '#1c8a4d';
  ctx.lineWidth = 1.5;
  for (const pt of tangentPoints) {
    const tx = -pt.ny, ty = pt.nx; // perpendicular to the normal = tangent direction
    ctx.beginPath();
    ctx.moveTo(pt.x - tx * TAN_HALF, pt.y - ty * TAN_HALF);
    ctx.lineTo(pt.x + tx * TAN_HALF, pt.y + ty * TAN_HALF);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#2ecc71';
    ctx.fill();
  }
}

function drawReference() {
  ctx.save();
  ctx.strokeStyle = 'rgba(180,60,220,0.6)';
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  const r = waveletRadius();
  strokeRuns(curveRuns(r), r);
  ctx.restore();
}

function drawWall() {
  if (!wall.visible) return;
  for (const seg of wallSegments()) {
    if (seg.type !== 'solid') continue;
    ctx.strokeStyle = '#4a3f35';
    ctx.lineWidth = 9;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(seg.a.x, seg.a.y);
    ctx.lineTo(seg.b.x, seg.b.y);
    ctx.stroke();
  }
  const { e1, e2 } = wallEndpoints();
  ctx.fillStyle = '#4a3f35';
  for (const e of [e1, e2]) {
    ctx.beginPath();
    ctx.arc(e.x, e.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function render() {
  ctx.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

  if (showReferenceBox.checked) drawReference();
  drawCurrentFront();
  if (showWaveletsBox.checked) drawWavelets();
  if (showNewFrontBox.checked) drawEnvelope();
  if (showRaysBox.checked) drawRays();
  drawSource();
  drawWall();

  updateReadout();
}

function loop() {
  render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);