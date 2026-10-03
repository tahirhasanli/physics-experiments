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
// PHYSICS: every part (including wires) reduces to a plain two-terminal
// Norton stamp between two resolved circuit nodes — a conductance g plus
// an injected current Isrc, using the convention:
//   RHS[p] += Isrc;  RHS[n] -= Isrc;
//   G[p][p] += g; G[n][n] += g; G[p][n] -= g; G[n][p] -= g;
// That means the whole solve is just G*V = I with no extra unknowns for
// "ideal" sources — batteries, wires, and meters are all just very low or
// very high resistances. Capacitors and inductors use the standard
// backward-Euler companion models (unconditionally stable). AC sources use
// the same Norton-source trick with a time-varying Isrc. A switch is just a
// resistor whose g flips between "near zero" (open) and "near ideal wire"
// (closed). See the validation notes: the core solver was checked against
// the closed-form RC/RL charging curves before being wired into the UI.
// =====================================================================

const G_LEAK = 1e-9;          // tiny leak to ground on every node, keeps the matrix non-singular
const R_WIRE = 1e-3;          // Ω — near-ideal conductor
const R_AMMETER = 1e-3;       // Ω — near-ideal ammeter (in series)
const R_VOLTMETER = 1e7;      // Ω — near-ideal voltmeter (in parallel)
const BATTERY_R_INT = 0.5;    // Ω — a toy "internal resistance" so a dead short doesn't blow up to infinity
const HISTORY_WINDOW = 0.5;   // seconds of trace kept/shown on an oscilloscope screen
const LED_R_REVERSE = 1e6;    // Ω — near-open when biased backwards, like a real diode
const LED_BRIGHTNESS_REF = 0.05; // amps of forward current for "full brightness"

let simTime = 0; // total elapsed simulated seconds, advances every physics step — drives AC sources & scope traces

function stampFor(el, dt) {
  switch (el.kind) {
    case 'battery': return { g: 1 / BATTERY_R_INT, Isrc: el.value / BATTERY_R_INT }; // A end = "+"
    case 'acsource': {
      const e = el.value * Math.sin(2 * Math.PI * el.freq * simTime);
      return { g: 1 / BATTERY_R_INT, Isrc: e / BATTERY_R_INT };
    }
    case 'switch': return el.closed ? { g: 1 / R_WIRE, Isrc: 0 } : { g: G_LEAK, Isrc: 0 };
    case 'led': {
      // A one-step-lagged diode approximation (like the capacitor/inductor
      // companion models, which also react to last step's state): conducts
      // like a small resistor when last step's current ran A -> B
      // ("forward"), and is nearly open otherwise — so it only lights when
      // wired the "right way" around, same as a real LED.
      const forward = (el._lastCurrent || 0) >= -1e-6;
      return forward ? { g: 1 / Math.max(el.value, 1), Isrc: 0 } : { g: 1 / LED_R_REVERSE, Isrc: 0 };
    }
    case 'resistor': return { g: 1 / Math.max(el.value, 0.01), Isrc: 0 };
    case 'wire': return { g: 1 / R_WIRE, Isrc: 0 };
    case 'ammeter': return { g: 1 / R_AMMETER, Isrc: 0 };
    case 'voltmeter': return { g: 1 / R_VOLTMETER, Isrc: 0 };
    case 'oscilloscopeV': return { g: 1 / R_VOLTMETER, Isrc: 0 };
    case 'oscilloscopeI': return { g: 1 / R_AMMETER, Isrc: 0 };
    case 'capacitor': {
      const g = el.value / dt;
      return { g, Isrc: g * (el._capV || 0) };
    }
    case 'inductor': {
      const g = dt / el.value;
      return { g, Isrc: -(el._indI || 0) };
    }
  }
  return { g: 1 / R_WIRE, Isrc: 0 };
}

// Gaussian elimination with partial pivoting.
function solveLinear(G, I) {
  const n = G.length;
  const A = G.map((row, i) => row.concat([I[i]]));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    const tmp = A[col]; A[col] = A[pivot]; A[pivot] = tmp;
    if (Math.abs(A[col][col]) < 1e-14) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = A[r][col] / A[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) A[r][c] -= factor * A[col][c];
    }
  }
  return A.map((row, i) => row[n] / (Math.abs(row[i]) < 1e-14 ? 1 : row[i]));
}

// Simple union-find keyed by "elementId:end" strings — used to work out
// which terminals share an electrical node once every wire's attachments
// are taken into account.
class UnionFind {
  constructor() { this.parent = new Map(); }
  find(k) {
    if (!this.parent.has(k)) this.parent.set(k, k);
    let root = k;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = k;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function stepCircuit(dt) {
  simTime += dt;

  const uf = new UnionFind();
  for (const el of elements) {
    const keyA = el.id + ':A', keyB = el.id + ':B';
    uf.find(keyA);
    uf.find(keyB);
    if (el.kind === 'wire') {
      if (el.a.attach) uf.union(keyA, el.a.attach.targetId + ':' + el.a.attach.end);
      if (el.b.attach) uf.union(keyB, el.b.attach.targetId + ':' + el.b.attach.end);
    }
  }
  const rootToIndex = new Map();
  function nodeIndex(key) {
    const root = uf.find(key);
    if (!rootToIndex.has(root)) rootToIndex.set(root, rootToIndex.size);
    return rootToIndex.get(root);
  }
  const stamps = [];
  for (const el of elements) {
    const p = nodeIndex(el.id + ':A');
    const n = nodeIndex(el.id + ':B');
    const { g, Isrc } = stampFor(el, dt);
    stamps.push({ p, n, g, Isrc, el });
  }
  const numNodes = rootToIndex.size;
  if (numNodes === 0) return;
  const G = Array.from({ length: numNodes }, () => new Array(numNodes).fill(0));
  const I = new Array(numNodes).fill(0);
  for (let k = 0; k < numNodes; k++) G[k][k] += G_LEAK;
  for (const s of stamps) {
    G[s.p][s.p] += s.g;
    G[s.n][s.n] += s.g;
    G[s.p][s.n] -= s.g;
    G[s.n][s.p] -= s.g;
    I[s.p] += s.Isrc;
    I[s.n] -= s.Isrc;
  }
  const V = solveLinear(G, I);
  for (const s of stamps) {
    const Vp = V[s.p], Vn = V[s.n];
    const current = s.g * (Vp - Vn) - s.Isrc; // current flowing A -> B through this element
    s.el._lastCurrent = current;
    s.el._lastVoltage = Vp - Vn;
    if (s.el.kind === 'capacitor') s.el._capV = Vp - Vn;
    if (s.el.kind === 'inductor') s.el._indI = current;
    if (s.el.kind === 'oscilloscopeV' || s.el.kind === 'oscilloscopeI') {
      const hist = s.el._history || (s.el._history = []);
      const sample = s.el.kind === 'oscilloscopeV' ? (Vp - Vn) : current;
      hist.push({ t: simTime, v: sample });
      while (hist.length > 2 && simTime - hist[0].t > HISTORY_WINDOW + 0.05) hist.shift();
    }
  }
}

// =====================================================================
// DATA MODEL
// =====================================================================

let nextId = 1;
const elements = [];
const elementsById = new Map();

const DEVICE_HALF_LEN = 35;

// Per-kind extra fields a fresh device needs beyond {id,kind,x,y,value,angle}.
// A factory (not a shared literal) so kinds with their own array/object
// fields (like an oscilloscope's history buffer) get a new one each spawn.
function makeExtra(kind) {
  switch (kind) {
    case 'acsource': return { freq: 2 };
    case 'switch': return { closed: true };
    case 'oscilloscopeV':
    case 'oscilloscopeI': return { _history: [] };
    default: return {};
  }
}

function newDevice(kind, x, y, value, extra) {
  const el = Object.assign({
    id: nextId++, kind, x, y, value, angle: 0,
    _capV: 0, _indI: 0, _lastCurrent: 0, _lastVoltage: 0, _flow: 0
  }, extra || {});
  elements.push(el);
  elementsById.set(el.id, el);
  return el;
}

// Rotates a point given in the device's own local coordinates (origin at
// its center, +x pointing from terminal A to terminal B at angle 0) into
// world/canvas coordinates, accounting for el.angle.
function localToWorld(el, dx, dy) {
  const a = el.angle || 0;
  const cos = Math.cos(a), sin = Math.sin(a);
  return { x: el.x + dx * cos - dy * sin, y: el.y + dx * sin + dy * cos };
}

function newWire(x, y) {
  const el = {
    id: nextId++, kind: 'wire', elbow: 'h',
    a: { attach: null, x: x - 30, y },
    b: { attach: null, x: x + 30, y },
    _lastCurrent: 0, _flow: 0
  };
  elements.push(el);
  elementsById.set(el.id, el);
  return el;
}

// The corner point of a wire's right-angle route between its two resolved
// endpoints — 'h' goes horizontal-then-vertical (corner shares B's x and
// A's y... note: matches corner=(b.x,a.y)); 'v' goes vertical-then-horizontal.
// Clicking a wire's body (see pointerup) toggles which one it uses.
function wireCorner(a, b, elbow) {
  return elbow === 'v' ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
}

// Most devices' terminals sit at +/-DEVICE_HALF_LEN, but a device with a
// body wider than that (currently just the enlarged oscilloscope screen)
// needs its terminals pushed out past its own edge — otherwise the leads
// and connection dots render underneath/inside the body instead of
// outside it.
function terminalOffset(el) {
  if (el.kind === 'oscilloscopeV' || el.kind === 'oscilloscopeI') return 92;
  return DEVICE_HALF_LEN;
}

function resolveTerminal(id, end, depth) {
  depth = depth || 0;
  const el = elementsById.get(id);
  if (!el) return { x: 0, y: 0 };
  if (el.kind !== 'wire') {
    const off = terminalOffset(el);
    return end === 'A' ? localToWorld(el, -off, 0) : localToWorld(el, off, 0);
  }
  const t = end === 'A' ? el.a : el.b;
  if (!t.attach || depth > 25) return { x: t.x, y: t.y };
  return resolveTerminal(t.attach.targetId, t.attach.end, depth + 1);
}

// Keeps every attached wire endpoint's cached x/y current — used for
// rendering, hit-testing, and so a deleted target leaves the wire frozen
// at its last visible spot instead of snapping to the origin.
function syncWireCaches() {
  for (const el of elements) {
    if (el.kind !== 'wire') continue;
    if (el.a.attach) { const p = resolveTerminal(el.id, 'A'); el.a.x = p.x; el.a.y = p.y; }
    if (el.b.attach) { const p = resolveTerminal(el.id, 'B'); el.b.x = p.x; el.b.y = p.y; }
  }
}

function deleteElement(id) {
  syncWireCaches();
  elementsById.delete(id);
  const idx = elements.findIndex((e) => e.id === id);
  if (idx !== -1) elements.splice(idx, 1);
  for (const el of elements) {
    if (el.kind !== 'wire') continue;
    for (const key of ['a', 'b']) {
      const t = el[key];
      if (t.attach && t.attach.targetId === id) t.attach = null; // x/y already hold its last position
    }
  }
}

// =====================================================================
// INTERACTION
// =====================================================================

const TERMINAL_HIT_R = 16;
const BODY_HIT_HALF_W = DEVICE_HALF_LEN + 4;
const BODY_HIT_HALF_H = 20;
const CLICK_MOVE_TOLERANCE = 4; // px of travel below which a press+release counts as a "click", not a drag

// Oscilloscopes draw a bigger box (to fit their screen) than the plain
// resistor/capacitor/etc body, so hit-testing and the selection outline
// need a per-kind size instead of the one constant.
function bodyHalfSize(el) {
  if (el.kind === 'oscilloscopeV' || el.kind === 'oscilloscopeI') return { w: 92, h: 54 };
  return { w: BODY_HIT_HALF_W, h: BODY_HIT_HALF_H };
}

function canvasPointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (LOGICAL_WIDTH / rect.width),
    y: (e.clientY - rect.top) * (LOGICAL_HEIGHT / rect.height)
  };
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Nearest terminal (device lead or wire end) to pt, excluding one specific
// element/end (so a wire can't snap onto its own dangling end).
function hitTestTerminals(pt, exclude) {
  let best = null, bestDist = Infinity;
  for (const el of elements) {
    for (const end of ['A', 'B']) {
      if (exclude && exclude.id === el.id && exclude.end === end) continue;
      const p = resolveTerminal(el.id, end);
      const d = Math.hypot(pt.x - p.x, pt.y - p.y);
      if (d <= TERMINAL_HIT_R && d < bestDist) {
        bestDist = d;
        best = { id: el.id, end, isWire: el.kind === 'wire' };
      }
    }
  }
  return best;
}

function hitTestDeviceBody(pt) {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el.kind === 'wire') continue;
    // Inverse-rotate the point into the device's own local frame so the
    // box test still works when the device has been rotated.
    const a = el.angle || 0;
    const dx = pt.x - el.x, dy = pt.y - el.y;
    const cos = Math.cos(-a), sin = Math.sin(-a);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    const size = bodyHalfSize(el);
    if (Math.abs(lx) <= size.w && Math.abs(ly) <= size.h) return el;
  }
  return null;
}

function hitTestWireBody(pt) {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el.kind !== 'wire') continue;
    const a = resolveTerminal(el.id, 'A'), b = resolveTerminal(el.id, 'B');
    const corner = wireCorner(a, b, el.elbow || 'h');
    if (distToSegment(pt, a, corner) <= 8 || distToSegment(pt, corner, b) <= 8) return el;
  }
  return null;
}

let selectedId = null;
let dragging = null;

canvas.addEventListener('pointerdown', (e) => {
  const pt = canvasPointFromEvent(e);
  const term = hitTestTerminals(pt);
  if (term) {
    if (term.isWire) {
      const el = elementsById.get(term.id);
      const endObj = term.end === 'A' ? el.a : el.b;
      const resolved = resolveTerminal(el.id, term.end);
      endObj.attach = null;
      endObj.x = resolved.x;
      endObj.y = resolved.y;
      dragging = { type: 'wireEnd', id: term.id, end: term.end };
      selectElement(el.id);
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl (or Cmd) + click-drag on a device terminal rotates the part
      // in place instead of pulling out a wire.
      const el = elementsById.get(term.id);
      dragging = { type: 'rotate', id: term.id, grabbedEnd: term.end };
      selectElement(el.id);
    } else {
      // Dragging directly from a device lead pulls out a brand-new wire,
      // pre-attached at this end, so connecting two parts is a single drag.
      const w = newWire(pt.x, pt.y);
      w.a.attach = { targetId: term.id, end: term.end };
      w.b.attach = null;
      w.b.x = pt.x;
      w.b.y = pt.y;
      dragging = { type: 'wireEnd', id: w.id, end: 'B' };
      selectElement(w.id);
    }
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  const wireBody = hitTestWireBody(pt);
  if (wireBody) {
    selectElement(wireBody.id);
    dragging = {
      type: 'wireBody', id: wireBody.id, startPt: pt, downPt: pt,
      startA: resolveTerminal(wireBody.id, 'A'), startB: resolveTerminal(wireBody.id, 'B')
    };
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  const device = hitTestDeviceBody(pt);
  if (device) {
    dragging = { type: 'device', id: device.id, offsetX: pt.x - device.x, offsetY: pt.y - device.y, downPt: pt };
    selectElement(device.id);
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  selectElement(null);
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) {
    const pt = canvasPointFromEvent(e);
    const hot = hitTestTerminals(pt) || hitTestWireBody(pt) || hitTestDeviceBody(pt);
    canvas.style.cursor = hot ? 'grab' : 'default';
    return;
  }
  const pt = canvasPointFromEvent(e);
  if (dragging.type === 'device') {
    const el = elementsById.get(dragging.id);
    const size = bodyHalfSize(el);
    el.x = clamp(pt.x - dragging.offsetX, size.w + 10, LOGICAL_WIDTH - size.w - 10);
    el.y = clamp(pt.y - dragging.offsetY, size.h + 10, LOGICAL_HEIGHT - size.h - 10);
  } else if (dragging.type === 'wireEnd') {
    const el = elementsById.get(dragging.id);
    const endObj = dragging.end === 'A' ? el.a : el.b;
    endObj.attach = null;
    const rawX = clamp(pt.x, 4, LOGICAL_WIDTH - 4);
    const rawY = clamp(pt.y, 4, LOGICAL_HEIGHT - 4);
    // Snap the endpoint onto a nearby lead WHILE dragging (not just on
    // release) so what you see is exactly what you'll get — no more
    // "looks connected but isn't" drops that land just outside the radius.
    const target = hitTestTerminals({ x: rawX, y: rawY }, { id: el.id, end: dragging.end });
    if (target) {
      const p = resolveTerminal(target.id, target.end);
      endObj.x = p.x;
      endObj.y = p.y;
      dragging.snapTarget = target;
    } else {
      endObj.x = rawX;
      endObj.y = rawY;
      dragging.snapTarget = null;
    }
  } else if (dragging.type === 'rotate') {
    const el = elementsById.get(dragging.id);
    // The grabbed end should track the pointer, so when end A is being
    // dragged the device's forward direction is the opposite of the
    // pointer's bearing from the center.
    let dirAngle = Math.atan2(pt.y - el.y, pt.x - el.x);
    let angle = dragging.grabbedEnd === 'A' ? dirAngle - Math.PI : dirAngle;
    const snap = Math.PI / 12; // snap to 15° increments for clean layouts
    angle = Math.round(angle / snap) * snap;
    el.angle = angle;
  } else if (dragging.type === 'wireBody') {
    const el = elementsById.get(dragging.id);
    const dx = pt.x - dragging.startPt.x, dy = pt.y - dragging.startPt.y;
    if (!el.a.attach) { el.a.x = clamp(dragging.startA.x + dx, 4, LOGICAL_WIDTH - 4); el.a.y = clamp(dragging.startA.y + dy, 4, LOGICAL_HEIGHT - 4); }
    if (!el.b.attach) { el.b.x = clamp(dragging.startB.x + dx, 4, LOGICAL_WIDTH - 4); el.b.y = clamp(dragging.startB.y + dy, 4, LOGICAL_HEIGHT - 4); }
  }
  canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('pointerup', (e) => {
  const pt = canvasPointFromEvent(e);
  if (dragging && dragging.type === 'wireEnd') {
    const el = elementsById.get(dragging.id);
    const endObj = dragging.end === 'A' ? el.a : el.b;
    // Use the exact target already locked in during dragging (see the
    // snap-preview in pointermove) rather than re-testing the raw drop
    // point, so the connection always matches what was shown on screen.
    if (dragging.snapTarget) endObj.attach = { targetId: dragging.snapTarget.id, end: dragging.snapTarget.end };
  } else if (dragging && dragging.type === 'wireBody') {
    // A press+release with barely any movement is a click, not a drag —
    // use it to flip which way the wire's 90° bend goes.
    const moved = Math.hypot(pt.x - dragging.downPt.x, pt.y - dragging.downPt.y);
    if (moved < CLICK_MOVE_TOLERANCE) {
      const el = elementsById.get(dragging.id);
      if (el) el.elbow = el.elbow === 'v' ? 'h' : 'v';
    }
  } else if (dragging && dragging.type === 'device') {
    const moved = Math.hypot(pt.x - dragging.downPt.x, pt.y - dragging.downPt.y);
    if (moved < CLICK_MOVE_TOLERANCE) {
      const el = elementsById.get(dragging.id);
      if (el && el.kind === 'switch') el.closed = !el.closed;
    }
  }
  dragging = null;
  canvas.releasePointerCapture(e.pointerId);
  canvas.style.cursor = 'default';
});

// ---- palette: drag a part from the menu onto the board to place it ----
const DEFAULT_VALUE = { battery: 9, resistor: 100, capacitor: 2000e-6, inductor: 5, acsource: 5, led: 150 };

function spawnAtPoint(kind, x, y) {
  const isScope = kind === 'oscilloscopeV' || kind === 'oscilloscopeI';
  const marginX = (isScope ? 92 : DEVICE_HALF_LEN) + 10;
  const marginY = isScope ? 64 : 20;
  x = clamp(x, marginX, LOGICAL_WIDTH - marginX);
  y = clamp(y, marginY, LOGICAL_HEIGHT - marginY);
  const el = kind === 'wire' ? newWire(x, y) : newDevice(kind, x, y, DEFAULT_VALUE[kind], makeExtra(kind));
  selectElement(el.id);
}

let paletteDrag = null; // { kind, pointerId }
const dragGhost = document.getElementById('dragGhost');

document.querySelectorAll('#palette button[data-kind]').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    paletteDrag = { kind: btn.dataset.kind, pointerId: e.pointerId };
    btn.classList.add('dragSource');
    dragGhost.textContent = btn.textContent;
    dragGhost.style.left = e.clientX + 'px';
    dragGhost.style.top = e.clientY + 'px';
    dragGhost.style.display = 'block';
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
    // The palette floats over part of the canvas's own bounding box (the
    // canvas is wide and centered), so a plain bounding-rect containment
    // check would misfire near that overlap — ask which element is
    // actually topmost at the drop point instead.
    if (document.elementFromPoint(e.clientX, e.clientY) === canvas) {
      const pt = canvasPointFromEvent(e);
      spawnAtPoint(paletteDrag.kind, pt.x, pt.y);
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

// ---- inspector ----
// One entry per selectable kind: an array of adjustable fields (most parts
// have just one — "value" — but e.g. an AC source has amplitude+frequency).
// Kinds with no entry here (wire, switch, meters, scopes) just show the
// title and delete button.
const FIELDS_CONFIG = {
  battery: [{ prop: 'value', name: 'Voltage', unit: 'V', min: 1, max: 12, step: 0.5, decimals: 1 }],
  resistor: [{ prop: 'value', name: 'Resistance', unit: 'Ω', min: 1, max: 1000, step: 1, decimals: 0 }],
  capacitor: [{ prop: 'value', name: 'Capacitance', unit: 'µF', min: 100, max: 5000, step: 50, decimals: 0, toUI: (v) => v * 1e6, fromUI: (v) => v / 1e6 }],
  inductor: [{ prop: 'value', name: 'Inductance', unit: 'H', min: 0.5, max: 50, step: 0.5, decimals: 1 }],
  acsource: [
    { prop: 'value', name: 'Amplitude', unit: 'V', min: 1, max: 12, step: 0.5, decimals: 1 },
    { prop: 'freq', name: 'Frequency', unit: 'Hz', min: 0.2, max: 10, step: 0.1, decimals: 1 }
  ],
  led: [{ prop: 'value', name: 'Resistance (lit)', unit: 'Ω', min: 5, max: 500, step: 5, decimals: 0 }]
};
const TITLE = {
  battery: 'Battery', acsource: 'AC Source', resistor: 'Resistor', capacitor: 'Capacitor', inductor: 'Inductor',
  switch: 'Switch', led: 'LED Bulb', voltmeter: 'Voltmeter', ammeter: 'Ammeter',
  oscilloscopeV: 'Oscilloscope (V)', oscilloscopeI: 'Oscilloscope (I)', wire: 'Wire'
};

const inspector = document.getElementById('inspector');
const inspTitle = document.getElementById('inspTitle');
const inspFields = document.getElementById('inspFields');

function selectElement(id) {
  selectedId = id;
  const el = id != null ? elementsById.get(id) : null;
  if (!el) { inspector.style.display = 'none'; return; }
  inspector.style.display = 'block';
  inspTitle.textContent = TITLE[el.kind] || el.kind;
  inspFields.innerHTML = '';
  const fields = FIELDS_CONFIG[el.kind];
  if (!fields) return;
  for (const f of fields) {
    const toUI = f.toUI || ((v) => v);
    const fromUI = f.fromUI || ((v) => v);
    const uiVal = toUI(el[f.prop]);

    const row = document.createElement('div');
    row.className = 'row';
    const labelRow = document.createElement('div');
    labelRow.className = 'valueLabel';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = f.name;
    const numSpan = document.createElement('span');
    numSpan.textContent = uiVal.toFixed(f.decimals) + ' ' + f.unit;
    labelRow.appendChild(nameSpan);
    labelRow.appendChild(numSpan);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = f.min;
    slider.max = f.max;
    slider.step = f.step;
    slider.value = uiVal;
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      el[f.prop] = fromUI(v);
      numSpan.textContent = v.toFixed(f.decimals) + ' ' + f.unit;
    });

    row.appendChild(labelRow);
    row.appendChild(slider);
    inspFields.appendChild(row);
  }
}

document.getElementById('deleteBtn').addEventListener('click', () => {
  if (selectedId == null) return;
  deleteElement(selectedId);
  selectElement(null);
});

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
  if (selectedId == null) return;
  deleteElement(selectedId);
  selectElement(null);
  e.preventDefault();
});

// =====================================================================
// RENDERING
// =====================================================================

const TERMINAL_R = 4.5;
const FLOW_DOT_SPACING = 18;
const FLOW_SPEED_SCALE = 260; // px/s of dot motion per amp — tuned for readable pacing at typical circuit currents

function drawTerminal(p, connected) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, TERMINAL_R, 0, Math.PI * 2);
  ctx.fillStyle = connected ? '#333' : '#bbb';
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawLead(from, to) {
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

function drawValueLabel(el, text) {
  ctx.fillStyle = '#555';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, el.x, el.y - 34);
}

function formatCurrent(amps) {
  const a = Math.abs(amps);
  if (a < 1) return (amps * 1000).toFixed(1) + ' mA';
  return amps.toFixed(3) + ' A';
}
function formatVoltage(volts) {
  return volts.toFixed(2) + ' V';
}

// All the symbol geometry below is drawn under a translate+rotate canvas
// transform (in the device's local coordinates, +x from terminal A to
// terminal B), then restored before any text is drawn — so labels stay
// upright on screen no matter how the part is rotated. Terminal dots are
// also drawn after restoring, at their resolved world positions, since a
// circle looks identical either way.

function drawResistor(el, selected) {
  const a = localToWorld(el, -DEVICE_HALF_LEN, 0), b = localToWorld(el, DEVICE_HALF_LEN, 0);
  const zigStart = -20, zigEnd = 20, teeth = 6, amp = 9;
  ctx.save();
  ctx.translate(el.x, el.y);
  ctx.rotate(el.angle || 0);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-DEVICE_HALF_LEN, 0);
  ctx.lineTo(zigStart, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(zigEnd, 0);
  ctx.lineTo(DEVICE_HALF_LEN, 0);
  ctx.stroke();
  ctx.strokeStyle = selected ? '#1a73c7' : '#333';
  ctx.beginPath();
  ctx.moveTo(zigStart, 0);
  const step = (zigEnd - zigStart) / teeth;
  for (let i = 0; i < teeth; i++) {
    const x = zigStart + step * (i + 0.5);
    const y = (i % 2 === 0 ? -amp : amp);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(zigEnd, 0);
  ctx.stroke();
  ctx.restore();
  drawTerminal(a, true);
  drawTerminal(b, true);
  drawValueLabel(el, el.value.toFixed(0) + ' Ω');
}

function drawCapacitor(el, selected) {
  const a = localToWorld(el, -DEVICE_HALF_LEN, 0), b = localToWorld(el, DEVICE_HALF_LEN, 0);
  const gap = 10;
  ctx.save();
  ctx.translate(el.x, el.y);
  ctx.rotate(el.angle || 0);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-DEVICE_HALF_LEN, 0);
  ctx.lineTo(-gap, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(gap, 0);
  ctx.lineTo(DEVICE_HALF_LEN, 0);
  ctx.stroke();
  ctx.strokeStyle = selected ? '#1a73c7' : '#333';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-gap, -16);
  ctx.lineTo(-gap, 16);
  ctx.moveTo(gap, -16);
  ctx.lineTo(gap, 16);
  ctx.stroke();
  ctx.restore();
  drawTerminal(a, true);
  drawTerminal(b, true);
  drawValueLabel(el, (el.value * 1e6).toFixed(0) + ' µF');
}

function drawInductor(el, selected) {
  const a = localToWorld(el, -DEVICE_HALF_LEN, 0), b = localToWorld(el, DEVICE_HALF_LEN, 0);
  const coilStart = -20, coilEnd = 20, bumps = 4;
  ctx.save();
  ctx.translate(el.x, el.y);
  ctx.rotate(el.angle || 0);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-DEVICE_HALF_LEN, 0);
  ctx.lineTo(coilStart, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(coilEnd, 0);
  ctx.lineTo(DEVICE_HALF_LEN, 0);
  ctx.stroke();
  ctx.strokeStyle = selected ? '#1a73c7' : '#333';
  const bumpW = (coilEnd - coilStart) / bumps;
  for (let i = 0; i < bumps; i++) {
    const cx = coilStart + bumpW * (i + 0.5);
    ctx.beginPath();
    ctx.arc(cx, 0, bumpW / 2, Math.PI, 0, false);
    ctx.stroke();
  }
  ctx.restore();
  drawTerminal(a, true);
  drawTerminal(b, true);
  drawValueLabel(el, el.value.toFixed(1) + ' H');
}

function drawBattery(el, selected) {
  // A = "+", B = "-" (in the device's local frame)
  const a = localToWorld(el, -DEVICE_HALF_LEN, 0), b = localToWorld(el, DEVICE_HALF_LEN, 0);
  ctx.save();
  ctx.translate(el.x, el.y);
  ctx.rotate(el.angle || 0);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-DEVICE_HALF_LEN, 0);
  ctx.lineTo(-9, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(9, 0);
  ctx.lineTo(DEVICE_HALF_LEN, 0);
  ctx.stroke();
  ctx.strokeStyle = selected ? '#1a73c7' : '#333';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-9, -16); // tall "+" bar
  ctx.lineTo(-9, 16);
  ctx.stroke();
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(9, -9); // short thick "-" bar
  ctx.lineTo(9, 9);
  ctx.stroke();
  ctx.restore();
  const plusPos = localToWorld(el, -9, -19), minusPos = localToWorld(el, 9, -12);
  ctx.fillStyle = '#555';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('+', plusPos.x, plusPos.y);
  ctx.fillText('−', minusPos.x, minusPos.y);
  drawTerminal(a, true);
  drawTerminal(b, true);
  drawValueLabel(el, el.value.toFixed(1) + ' V');
}

function drawAcSource(el, selected) {
  const a = localToWorld(el, -DEVICE_HALF_LEN, 0), b = localToWorld(el, DEVICE_HALF_LEN, 0);
  const r = 15;
  ctx.save();
  ctx.translate(el.x, el.y);
  ctx.rotate(el.angle || 0);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-DEVICE_HALF_LEN, 0);
  ctx.lineTo(-r, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(DEVICE_HALF_LEN, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = selected ? '#1a73c7' : '#333';
  ctx.lineWidth = 2;
  ctx.stroke();
  // sine squiggle inside the circle, the standard AC-source symbol
  ctx.strokeStyle = '#c9960c';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const lx = -8 + (16 * i) / steps;
    const ly = -5 * Math.sin((i / steps) * Math.PI * 2);
    if (i === 0) ctx.moveTo(lx, ly); else ctx.lineTo(lx, ly);
  }
  ctx.stroke();
  ctx.restore();
  drawTerminal(a, true);
  drawTerminal(b, true);
  drawValueLabel(el, el.value.toFixed(1) + ' V, ' + el.freq.toFixed(1) + ' Hz');
}

function drawSwitch(el, selected) {
  const a = localToWorld(el, -DEVICE_HALF_LEN, 0), b = localToWorld(el, DEVICE_HALF_LEN, 0);
  const gap = 13;
  ctx.save();
  ctx.translate(el.x, el.y);
  ctx.rotate(el.angle || 0);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-DEVICE_HALF_LEN, 0);
  ctx.lineTo(-gap, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(gap, 0);
  ctx.lineTo(DEVICE_HALF_LEN, 0);
  ctx.stroke();
  ctx.strokeStyle = selected ? '#1a73c7' : (el.closed ? '#2e8b3d' : '#a33333');
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(-gap, 0);
  if (el.closed) {
    ctx.lineTo(gap, 0);
  } else {
    ctx.lineTo(gap - 4, -14); // lifted lever = open contact
  }
  ctx.stroke();
  ctx.fillStyle = '#333';
  ctx.beginPath(); ctx.arc(-gap, 0, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(gap, 0, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  drawTerminal(a, true);
  drawTerminal(b, true);
  drawValueLabel(el, el.closed ? 'Closed' : 'Open');
}

function drawLed(el, selected) {
  const a = localToWorld(el, -DEVICE_HALF_LEN, 0), b = localToWorld(el, DEVICE_HALF_LEN, 0);
  const r = 15;
  const current = el._lastCurrent || 0;
  const brightness = current > 1e-4 ? clamp(current / LED_BRIGHTNESS_REF, 0, 1) : 0;
  ctx.save();
  ctx.translate(el.x, el.y);
  ctx.rotate(el.angle || 0);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-DEVICE_HALF_LEN, 0);
  ctx.lineTo(-r, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(DEVICE_HALF_LEN, 0);
  ctx.stroke();

  if (brightness > 0.02) {
    // soft glow halo behind the bulb, growing with brightness
    const glowR = r + 6 + brightness * 10;
    const grad = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, glowR);
    grad.addColorStop(0, 'rgba(255,214,64,' + (0.55 * brightness).toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(255,214,64,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, glowR, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  // fades from a dim unlit tint to a bright yellow bulb as brightness rises
  const mix = (off, on) => Math.round(off + (on - off) * brightness);
  ctx.fillStyle = 'rgb(' + mix(60, 255) + ',' + mix(56, 214) + ',' + mix(40, 64) + ')';
  ctx.fill();
  ctx.strokeStyle = selected ? '#1a73c7' : '#333';
  ctx.lineWidth = 2;
  ctx.stroke();

  // small diode arrow marking the forward (lit) direction, A -> B
  ctx.fillStyle = '#333';
  ctx.beginPath();
  ctx.moveTo(-5, 6);
  ctx.lineTo(5, 0);
  ctx.lineTo(-5, -6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(5, -6);
  ctx.lineTo(5, 6);
  ctx.stroke();

  ctx.restore();
  drawTerminal(a, true);
  drawTerminal(b, true);
  drawValueLabel(el, el.value.toFixed(0) + ' Ω');
}

function drawMeter(el, selected, letter, reading) {
  const a = localToWorld(el, -DEVICE_HALF_LEN, 0), b = localToWorld(el, DEVICE_HALF_LEN, 0);
  const r = 15;
  ctx.save();
  ctx.translate(el.x, el.y);
  ctx.rotate(el.angle || 0);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-DEVICE_HALF_LEN, 0);
  ctx.lineTo(-r, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(DEVICE_HALF_LEN, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = selected ? '#1a73c7' : '#333';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#333';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, el.x, el.y + 1);
  ctx.textBaseline = 'alphabetic';
  drawTerminal(a, true);
  drawTerminal(b, true);
  ctx.fillStyle = '#1a73c7';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(reading, el.x, el.y + r + 16);
}

function axisFormatVoltage(v) { return v.toFixed(1) + 'V'; }
function axisFormatCurrent(v) {
  const a = Math.abs(v);
  if (a < 1) return (v * 1000).toFixed(0) + 'mA';
  return v.toFixed(2) + 'A';
}

// Shared oscilloscope rendering: a CRT-style screen with a scrolling trace
// of the element's own _history buffer (populated in stepCircuit). Rather
// than a floating "current reading" caption above the part, the value
// scale is drawn as gridline labels down the screen's left edge and the
// time scale as tick labels along its bottom edge — like a real scope.
function drawOscilloscope(el, selected, color, formatAxisValue) {
  const off = terminalOffset(el);
  const a = localToWorld(el, -off, 0), b = localToWorld(el, off, 0);
  const boxW = 160, boxH = 92;
  ctx.save();
  ctx.translate(el.x, el.y);
  ctx.rotate(el.angle || 0);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-off, 0);
  ctx.lineTo(-boxW / 2, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(boxW / 2, 0);
  ctx.lineTo(off, 0);
  ctx.stroke();

  ctx.fillStyle = '#0c1a12';
  ctx.fillRect(-boxW / 2, -boxH / 2, boxW, boxH);
  ctx.strokeStyle = selected ? '#1a73c7' : '#333';
  ctx.lineWidth = 2;
  ctx.strokeRect(-boxW / 2, -boxH / 2, boxW, boxH);

  // Reserve a margin inside the screen for the axis labels themselves.
  const padL = 34, padB = 14, padT = 8, padR = 5;
  const plotLeft = -boxW / 2 + padL, plotRight = boxW / 2 - padR;
  const plotTop = -boxH / 2 + padT, plotBottom = boxH / 2 - padB;
  const plotW = plotRight - plotLeft, plotH = plotBottom - plotTop;
  const midY = (plotTop + plotBottom) / 2;

  const hist = el._history || [];
  let maxAbs = 1e-6;
  for (const s of hist) maxAbs = Math.max(maxAbs, Math.abs(s.v));
  const scale = (plotH / 2 - 2) / maxAbs;

  // value axis: gridlines at +max/0/-max, labeled on the left
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of [maxAbs, 0, -maxAbs]) {
    const ly = midY - v * scale;
    ctx.beginPath();
    ctx.moveTo(plotLeft, ly);
    ctx.lineTo(plotRight, ly);
    ctx.stroke();
    ctx.fillText(formatAxisValue(v), plotLeft - 3, ly);
  }

  // time axis: ticks at -window/-window/2/now, labeled along the bottom
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const age of [-HISTORY_WINDOW, -HISTORY_WINDOW / 2, 0]) {
    const lx = plotRight + (age / HISTORY_WINDOW) * plotW;
    ctx.beginPath();
    ctx.moveTo(lx, plotBottom);
    ctx.lineTo(lx, plotBottom + 3);
    ctx.stroke();
    ctx.fillText(age.toFixed(2) + 's', lx, plotBottom + 3);
  }

  if (hist.length > 1) {
    const tNow = hist[hist.length - 1].t;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < hist.length; i++) {
      const s = hist[i];
      const ageAgo = tNow - s.t; // 0 = newest sample
      const lx = plotRight - (ageAgo / HISTORY_WINDOW) * plotW;
      if (lx < plotLeft) continue;
      const ly = midY - s.v * scale;
      if (!started) { ctx.moveTo(lx, ly); started = true; } else { ctx.lineTo(lx, ly); }
    }
    ctx.stroke();
  }
  ctx.restore();
  drawTerminal(a, true);
  drawTerminal(b, true);
}

function drawOscilloscopeV(el, selected) {
  drawOscilloscope(el, selected, '#3ad1ff', axisFormatVoltage);
}
function drawOscilloscopeI(el, selected) {
  drawOscilloscope(el, selected, '#ffb03a', axisFormatCurrent);
}

function drawWire(el, selected) {
  const a = resolveTerminal(el.id, 'A'), b = resolveTerminal(el.id, 'B');
  const corner = wireCorner(a, b, el.elbow || 'h');
  ctx.strokeStyle = selected ? '#1a73c7' : '#c9960c';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(corner.x, corner.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.lineCap = 'butt';
  drawTerminal(a, !!el.a.attach);
  drawTerminal(b, !!el.b.attach);

  // flow dots, walking the two-segment elbow path in order
  const current = el._lastCurrent || 0;
  if (Math.abs(current) > 0.0005) {
    const seg1 = Math.hypot(corner.x - a.x, corner.y - a.y);
    const seg2 = Math.hypot(b.x - corner.x, b.y - corner.y);
    const total = seg1 + seg2;
    if (total > 1) {
      let phase = el._flow % FLOW_DOT_SPACING;
      if (phase < 0) phase += FLOW_DOT_SPACING;
      ctx.fillStyle = '#3a8dde';
      for (let d = phase; d < total; d += FLOW_DOT_SPACING) {
        let x, y;
        if (d <= seg1) {
          const t = seg1 > 1e-6 ? d / seg1 : 0;
          x = a.x + (corner.x - a.x) * t;
          y = a.y + (corner.y - a.y) * t;
        } else {
          const t = seg2 > 1e-6 ? (d - seg1) / seg2 : 0;
          x = corner.x + (b.x - corner.x) * t;
          y = corner.y + (b.y - corner.y) * t;
        }
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function drawSelectionHighlight(el) {
  if (el.kind === 'wire') return; // wire already draws highlighted in its own color
  const size = bodyHalfSize(el);
  ctx.save();
  ctx.translate(el.x, el.y);
  ctx.rotate(el.angle || 0);
  ctx.strokeStyle = 'rgba(26,115,199,0.55)';
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-size.w, -size.h, size.w * 2, size.h * 2);
  ctx.restore();
}

function render(frameDt) {
  ctx.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
  syncWireCaches();

  // While dragging a wire end near a lead it'll snap onto, ring it so the
  // connection-to-be is obvious before you let go.
  if (dragging && dragging.type === 'wireEnd' && dragging.snapTarget) {
    const p = resolveTerminal(dragging.snapTarget.id, dragging.snapTarget.end);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.strokeStyle = '#2ecc71';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // wires under devices
  for (const el of elements) {
    if (el.kind !== 'wire') continue;
    el._flow += (el._lastCurrent || 0) * FLOW_SPEED_SCALE * frameDt;
    drawWire(el, el.id === selectedId);
  }

  for (const el of elements) {
    if (el.kind === 'wire') continue;
    const selected = el.id === selectedId;
    if (selected) drawSelectionHighlight(el);
    switch (el.kind) {
      case 'resistor': drawResistor(el, selected); break;
      case 'capacitor': drawCapacitor(el, selected); break;
      case 'inductor': drawInductor(el, selected); break;
      case 'battery': drawBattery(el, selected); break;
      case 'acsource': drawAcSource(el, selected); break;
      case 'switch': drawSwitch(el, selected); break;
      case 'led': drawLed(el, selected); break;
      case 'voltmeter': drawMeter(el, selected, 'V', formatVoltage(el._lastVoltage || 0)); break;
      case 'ammeter': drawMeter(el, selected, 'A', formatCurrent(el._lastCurrent || 0)); break;
      case 'oscilloscopeV': drawOscilloscopeV(el, selected); break;
      case 'oscilloscopeI': drawOscilloscopeI(el, selected); break;
    }
  }
}

// =====================================================================
// MAIN LOOP
// =====================================================================

const PHYSICS_DT = 0.002;
const MAX_SUBSTEPS_PER_FRAME = 250;
let accumulator = 0;
let lastTimestamp = null;

function loop(now) {
  if (lastTimestamp === null) lastTimestamp = now;
  let frameDt = (now - lastTimestamp) / 1000;
  lastTimestamp = now;
  frameDt = Math.min(frameDt, 0.05);

  accumulator += frameDt;
  let steps = 0;
  while (accumulator >= PHYSICS_DT && steps < MAX_SUBSTEPS_PER_FRAME) {
    stepCircuit(PHYSICS_DT);
    accumulator -= PHYSICS_DT;
    steps++;
  }

  render(frameDt);
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);