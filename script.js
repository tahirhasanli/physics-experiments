// This is a plain .js file — no HTML tags allowed in here, only JavaScript.
// It only works because index.html loads it AFTER the <canvas> element exists
// on the page, so document.getElementById('canvas') has something to find.

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
  source: { x: 120, y: LOGICAL_HEIGHT / 2 }, // where the point source sits
  facingAngleDeg: 0,     // direction the source points (0 = straight right / +x)
  sourceType: 'point',   // 'point', 'collimated', or 'object' — set by the dropdown
  beamWidth: 260,        // width of the beam, for a collimated source (px)
  fieldAngleDeg: 360,    // total angular width of the ray fan
  numRays: 50,           // how many rays are drawn across the field
  rayLength: 1000,        // how far each ray is drawn if it never hits anything
  showMissedRays: true, // toggled by the button
  showGrid: true, // toggled by the grid button
  // An idealized thin lens: zero thickness, sitting on a vertical plane at
  // x = lens.x. lens.y is the optical axis (the lens's vertical center).
  // focalLength is in PIXELS for now — mapping pixels to real units (mm, cm)
  // is a coordinate-system building block we haven't added yet.
  lens: {
    x: 480,                // horizontal position of the lens plane
    y: LOGICAL_HEIGHT / 2,  // vertical center = the optical axis
    apertureHeight: 260,   // physical height of the lens; rays outside this miss it
    focalLength: 180       // positive = converging, negative = diverging
  },
  object: {
    height: 10 // mm, standing upright on the optical axis at the source's x position
  }

};

const PIXELS_PER_MM = 1;

function pxToMm(px) {
  return px / PIXELS_PER_MM;
}

function mmToPx(mm) {
  return mm * PIXELS_PER_MM;
}

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

// Returns an array of ray angles (in degrees) evenly spread across the field,
// centered on facingAngleDeg.
function getRayAngles(config) {
  const half = config.fieldAngleDeg / 2;
  const start = config.facingAngleDeg - half;
  const end = config.facingAngleDeg + half;
  const angles = [];

  for (let i = 0; i < config.numRays; i++) {
    const t = config.numRays === 1 ? 0.5 : i / (config.numRays - 1);
    angles.push(start + t * (end - start));
  }
  return angles;
}

// For a collimated source: one origin per ray, evenly spaced along a line
// perpendicular to the facing direction, all traveling the SAME direction —
// unlike a point source, where one origin fans out across many angles.
function getCollimatedRayOrigins(config) {
  const perpRad = degToRad(config.facingAngleDeg + 90);
  const half = config.beamWidth / 2;
  const origins = [];

  for (let i = 0; i < config.numRays; i++) {
    const t = config.numRays === 1 ? 0.5 : i / (config.numRays - 1);
    const offset = -half + t * config.beamWidth;
    origins.push({
      x: config.source.x + Math.cos(perpRad) * offset,
      y: config.source.y + Math.sin(perpRad) * offset
    });
  }
  return origins;
}

function getObjectTip(config) {
  return {
    x: config.source.x,
    y: config.lens.y - mmToPx(config.object.height)
  };
}

// Produces a unified list of { origin, angleRad } for either source type, so
// drawRays() doesn't need to know or care which kind of source it's tracing.
function getRays(config) {
  if (config.sourceType === 'collimated') {
    const angleRad = degToRad(config.facingAngleDeg);
    return getCollimatedRayOrigins(config).map((origin) => ({ origin, angleRad }));
  }

  if (config.sourceType === 'object') {
    const origin = getObjectTip(config);
    return getRayAngles(config).map((angleDeg) => ({
      origin,
      angleRad: degToRad(angleDeg)
    }));
  }

  return getRayAngles(config).map((angleDeg) => ({
    origin: config.source,
    angleRad: degToRad(angleDeg)
  }));
}

// Where a ray from `origin` traveling at `angleRad` crosses the vertical
// line x = lensX. Returns null if the ray never gets there (it's heading
// the other way, or travels exactly parallel to the lens plane).
function intersectLensPlane(origin, angleRad, lensX) {
  const dx = Math.cos(angleRad);
  if (Math.abs(dx) < 1e-9) return null;

  const t = (lensX - origin.x) / dx;
  if (t <= 0) return null;

  const y = origin.y + Math.sin(angleRad) * t;
  return { x: lensX, y, t };
}

// Where two rays (each given as a point + direction) cross, solving
// p1 + t1*d1 = p2 + t2*d2. Returns null if they're parallel (no crossing —
// this happens when the object sits at the focal plane, image at infinity).
function intersectRays(p1, d1, p2, d2) {
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-9) return null;

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const t1 = (dx * d2.y - dy * d2.x) / denom;

  return { x: p1.x + d1.x * t1, y: p1.y + d1.y * t1, t1 };
}

// Thin-lens ray transfer. For a zero-thickness lens, a ray's height where it
// crosses the lens plane doesn't change — only its angle does, by an amount
// proportional to that height and the lens's focal length. This is the same
// linear relation behind the classic "3 principal rays" lens diagrams, just
// applied to every ray instead of only 3 of them.
function refractThinLens(heightFromAxis, incomingAngleRad, focalLength) {
  const slopeIn = Math.tan(incomingAngleRad);
  const dirSign = Math.cos(incomingAngleRad) < 0 ? -1 : 1;

  // The height-dependent bending term has to flip sign when light travels
  // in the -x direction, because the base formula assumes propagation
  // toward +x. Without this, the lens converges from one side and
  // defocuses from the other — which isn't physically correct.
  const slopeOut = slopeIn - dirSign * (heightFromAxis / focalLength);

  return Math.atan2(slopeOut * dirSign, dirSign);
}

const GRID_SPACING = 50; // px between grid lines — raw pixels for now, not physical units yet

function drawGrid() {
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.font = '10px monospace';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';

  for (let x = 0; x <= LOGICAL_WIDTH; x += GRID_SPACING) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, LOGICAL_HEIGHT);
    ctx.stroke();
    ctx.fillText(String(pxToMm(x)), x + 2, 12);
  }

  for (let y = 0; y <= LOGICAL_HEIGHT; y += GRID_SPACING) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(LOGICAL_WIDTH, y);
    ctx.stroke();
    ctx.fillText(String(pxToMm(y)), 2, y + 10);
  }

  ctx.fillText('grid units: mm', 8, LOGICAL_HEIGHT - 8);
  ctx.restore();
}

function drawLens(lens) {
  const half = lens.apertureHeight / 2;
  const topY = lens.y - half;
  const bottomY = lens.y + half;
  const converging = lens.focalLength > 0;

  // Optical axis (dashed, faint) — purely a visual reference line
  ctx.save();
  ctx.setLineDash([4, 6]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, lens.y);
  ctx.lineTo(LOGICAL_WIDTH, lens.y);
  ctx.stroke();
  ctx.restore();

  // The lens itself, drawn as an actual biconvex/biconcave silhouette rather
  // than a schematic symbol. Two curved edges run from a top corner to a
  // bottom corner; how far each curve bulges relative to the corners is what
  // makes it read as convex (bulging out, thick middle) or concave (caving
  // in, thin middle).
  // "Optical power" scales inversely with focal length — a real lens does
  // this too: short focal length = strongly curved (fat) lens, long focal
  // length = nearly flat lens. Clamped so extreme slider values can't turn
  // it into a degenerate or self-intersecting shape.
  const CURVE_SCALE = 4000; // tuned so 180mm focal length matches the original look
  const power = Math.min(Math.max(CURVE_SCALE / Math.abs(lens.focalLength), 6), 60);
  const edgeHalfWidth = converging ? 0 : power * 0.36;
  const middleHalfWidth = converging ? power : power * 0.135;

  ctx.beginPath();
  ctx.moveTo(lens.x + edgeHalfWidth, topY);
  ctx.quadraticCurveTo(lens.x + middleHalfWidth, lens.y, lens.x + edgeHalfWidth, bottomY);
  ctx.lineTo(lens.x - edgeHalfWidth, bottomY);
  ctx.quadraticCurveTo(lens.x - middleHalfWidth, lens.y, lens.x - edgeHalfWidth, topY);
  ctx.closePath();

  ctx.fillStyle = 'rgba(127, 212, 255, 0.18)'; // faint "glass" fill
  ctx.fill();
  ctx.strokeStyle = '#7fd4ff';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Focal points, marked on the axis on both sides of the lens
  ctx.fillStyle = 'rgba(127, 212, 255, 0.85)';
  [lens.x - lens.focalLength, lens.x + lens.focalLength].forEach((fx) => {
    ctx.beginPath();
    ctx.arc(fx, lens.y, 3, 0, Math.PI * 2);
    ctx.fill();
  });
}


function drawSource(config) {
  if (config.sourceType === 'object') return; // the object arrow is the visual instead, drawn by drawObjectAndImage
  const source = config.source;

  if (config.sourceType === 'collimated') {
    // Draw the beam's aperture as a line perpendicular to the facing direction
    const perpRad = degToRad(config.facingAngleDeg + 90);
    const half = config.beamWidth / 2;

    ctx.strokeStyle = '#ffd45e';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(source.x + Math.cos(perpRad) * half, source.y + Math.sin(perpRad) * half);
    ctx.lineTo(source.x - Math.cos(perpRad) * half, source.y - Math.sin(perpRad) * half);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(source.x, source.y, 11, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 212, 94, 0.25)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(source.x, source.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd45e';
  ctx.fill();
}

function drawArrow(baseX, baseY, tipX, tipY, color, dashed) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  if (dashed) ctx.setLineDash([5, 5]);

  ctx.beginPath();
  ctx.moveTo(baseX, baseY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  const angle = Math.atan2(tipY - baseY, tipX - baseX);
  const headLen = 8;
  ctx.setLineDash([]); // arrowhead stays solid even when the shaft is dashed
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - headLen * Math.cos(angle - Math.PI / 6), tipY - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(tipX - headLen * Math.cos(angle + Math.PI / 6), tipY - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Only runs in "object" mode. Classic "2 principal ray" construction: a ray
// parallel to the axis, and a ray aimed straight at the lens center (which
// passes through undeviated). Where their refracted paths cross (or,
// extended backward, appear to cross) is the image.
function drawObjectAndImage(config) {
  if (config.sourceType !== 'object') return;

  const lens = config.lens;
  const objTip = getObjectTip(config);
  const objBaseY = lens.y;

  drawArrow(objTip.x, objBaseY, objTip.x, objTip.y, '#7CFC8A', false);

  // Small grab-handle at the base — this is the point dragging actually moves
  ctx.beginPath();
  ctx.arc(objTip.x, objBaseY, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#7CFC8A';
  ctx.fill();

  const towardLens = objTip.x < lens.x ? 0 : Math.PI;
  const angleB = Math.atan2(lens.y - objTip.y, lens.x - objTip.x);

  const hitA = intersectLensPlane(objTip, towardLens, lens.x);
  const hitB = intersectLensPlane(objTip, angleB, lens.x);
  if (!hitA || !hitB) return; // one construction ray never reaches the lens

  const outA = refractThinLens(hitA.y - lens.y, towardLens, lens.focalLength);
  const outB = refractThinLens(hitB.y - lens.y, angleB, lens.focalLength);
  const dirA = { x: Math.cos(outA), y: Math.sin(outA) };
  const dirB = { x: Math.cos(outB), y: Math.sin(outB) };

  const image = intersectRays({ x: hitA.x, y: hitA.y }, dirA, { x: hitB.x, y: hitB.y }, dirB);
  if (!image) return; // parallel outputs — object is at the focal plane, image at infinity

  const real = image.t1 > 0;

  ctx.save();
  ctx.strokeStyle = real ? 'rgba(255, 107, 107, 0.8)' : 'rgba(255, 107, 107, 0.5)';
  ctx.lineWidth = 1.5;
  if (!real) ctx.setLineDash([5, 5]); // virtual image: dashed backward extensions

  ctx.beginPath();
  ctx.moveTo(hitA.x, hitA.y);
  ctx.lineTo(image.x, image.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(hitB.x, hitB.y);
  ctx.lineTo(image.x, image.y);
  ctx.stroke();
  ctx.restore();

  drawArrow(image.x, lens.y, image.x, image.y, '#ff6b6b', !real);
}

function drawRays(config) {
  const rays = getRays(config);
  const lens = config.lens;

  ctx.strokeStyle = 'rgba(255, 212, 94, 0.55)';
  ctx.lineWidth = 1;

  rays.forEach(({ origin, angleRad }) => {
    const hit = intersectLensPlane(origin, angleRad, lens.x);
    const hitsLens = hit && Math.abs(hit.y - lens.y) <= lens.apertureHeight / 2;

    if (!hitsLens) {
      if (!config.showMissedRays) return;
      const dx = Math.cos(angleRad) * config.rayLength;
      const dy = Math.sin(angleRad) * config.rayLength;

      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(origin.x + dx, origin.y + dy);
      ctx.stroke();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(hit.x, hit.y);
    ctx.stroke();

    const heightFromAxis = hit.y - lens.y;
    const outAngleRad = refractThinLens(heightFromAxis, angleRad, lens.focalLength);
    const remaining = config.rayLength - hit.t;

    ctx.beginPath();
    ctx.moveTo(hit.x, hit.y);
    ctx.lineTo(hit.x + Math.cos(outAngleRad) * remaining, hit.y + Math.sin(outAngleRad) * remaining);
    ctx.stroke();
  });
}

function render() {
  ctx.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
  if (CONFIG.showGrid) drawGrid();
  drawLens(CONFIG.lens);
  drawRays(CONFIG);
  drawObjectAndImage(CONFIG);
  drawSource(CONFIG);
}

// ---- BUILDING BLOCK: dragging (source AND lens) ----
// Uses Pointer Events, which is the modern way to handle mouse, touch, and
// pen with the SAME code path instead of writing separate mouse/touch handlers.

const HIT_RADIUS = 14; // px — generous click/touch target around the source or lens
let draggedObject = null; // null, 'source', or 'lens'

function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function isOnSource(pos, source) {
  return distance(pos.x, pos.y, source.x, source.y) <= HIT_RADIUS;
}

// The lens is a tall vertical shape, not a point, so its hit test checks
// closeness to its x position AND that the pointer is within its aperture height.
function isOnLens(pos, lens) {
  const withinX = Math.abs(pos.x - lens.x) <= HIT_RADIUS;
  const withinY = Math.abs(pos.y - lens.y) <= lens.apertureHeight / 2;
  return withinX && withinY;
}

// Converts a pointer event's page coordinates into canvas-local coordinates.
function getPointerPos(evt) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: evt.clientX - rect.left,
    y: evt.clientY - rect.top
  };
}

canvas.addEventListener('pointerdown', (evt) => {
  const pos = getPointerPos(evt);

  if (isOnSource(pos, CONFIG.source)) {
    draggedObject = 'source';
  } else if (isOnLens(pos, CONFIG.lens)) {
    draggedObject = 'lens';
  } else {
    return;
  }

  canvas.setPointerCapture(evt.pointerId);
  canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('pointermove', (evt) => {
  const pos = getPointerPos(evt);

  if (draggedObject) {
    const target = draggedObject === 'source' ? CONFIG.source : CONFIG.lens;
    target.x = Math.min(Math.max(pos.x, 0), LOGICAL_WIDTH);
    target.y = Math.min(Math.max(pos.y, 0), LOGICAL_HEIGHT);

    // In "object" mode, the object always stands on the optical axis —
    // only its distance from the lens (x) is meaningful, not its height.
    if (draggedObject === 'source' && CONFIG.sourceType === 'object') {
      target.y = CONFIG.lens.y;
    }

    render();
  } else {
    const hovering = isOnSource(pos, CONFIG.source) || isOnLens(pos, CONFIG.lens);
    canvas.style.cursor = hovering ? 'grab' : 'default';
  }
});

canvas.addEventListener('pointerup', (evt) => {
  draggedObject = null;
  canvas.style.cursor = 'grab';
  canvas.releasePointerCapture(evt.pointerId);
});

// ---- BUTTONS ----
const toggleMissedRaysBtn = document.getElementById('toggleMissedRaysBtn');
toggleMissedRaysBtn.addEventListener('click', () => {
  CONFIG.showMissedRays = !CONFIG.showMissedRays;
  toggleMissedRaysBtn.textContent = CONFIG.showMissedRays ? 'Hide missed rays' : 'Show missed rays';
  render();
});

const toggleGridBtn = document.getElementById('toggleGridBtn');
toggleGridBtn.addEventListener('click', () => {
  CONFIG.showGrid = !CONFIG.showGrid;
  toggleGridBtn.textContent = CONFIG.showGrid ? 'Hide grid' : 'Show grid';
  render();
});

const sourceTypeSelect = document.getElementById('sourceTypeSelect');
sourceTypeSelect.addEventListener('change', (evt) => {
  CONFIG.sourceType = evt.target.value;
  if (CONFIG.sourceType === 'object') {
    CONFIG.source.y = CONFIG.lens.y; // snap onto the axis immediately when switching to object mode
  }
  render();
});

const focalLengthSlider = document.getElementById('focalLengthSlider');
const focalLengthValue = document.getElementById('focalLengthValue');

focalLengthSlider.addEventListener('input', (evt) => {
  let value = Number(evt.target.value);
  if (value === 0) value = 1; // f=0 isn't a physical lens anyway, and it'd divide by zero in refractThinLens
  CONFIG.lens.focalLength = value;
  focalLengthValue.textContent = pxToMm(value);
  render();
});
render();
