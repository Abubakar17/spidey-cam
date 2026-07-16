// Finger Magic — comic filter frames stretched between your hands.
//
// SECURE CONTEXT REQUIRED: getUserMedia only resolves on http://localhost or
// HTTPS. Serve this directory (`npx serve .` / `python -m http.server`) — do not
// open index.html as a file:// URL.

import { FilesetResolver, HandLandmarker }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
import { VERT, VIDEO_FRAG, FILTERS } from './shaders.js';

// ===========================================================================
// Tuning — the magic numbers. See README "Tuning" for what each one feels like.
// ===========================================================================
const PINCH_ON       = 0.35;  // metric below this = pinched
const PINCH_RELEASE  = 0.50;  // metric above this re-arms the pinch (hysteresis)
const PINCH_WINDOW   = 5;     // frames one hand may wait for the other
const STAMP_DEBOUNCE = 400;   // ms between stamps
const SWIPE_SPEED    = 1.8;   // screen-widths/sec per hand
const SWIPE_FRAMES   = 3;     // consecutive tracking frames required
const VEL_TAU        = 0.045; // velocity EMA time constant, seconds
const CLEAR_COOLDOWN = 800;   // ms before another swipe can fire
const DISSOLVE_MS    = 250;   // blow-away animation length
const MAX_STAMPED    = 6;
const HAND_LOST_FRAMES = 10;  // frames without two hands before the live frame hides

// Landmark indices we care about.
const WRIST = 0, THUMB_TIP = 4, INDEX_MCP = 5, INDEX_TIP = 8,
      MIDDLE_TIP = 12, PINKY_MCP = 17, PINKY_TIP = 20;
const TRACKED = [WRIST, THUMB_TIP, INDEX_MCP, INDEX_TIP, MIDDLE_TIP, PINKY_MCP, PINKY_TIP];

// Three live bands stretched across both hands. Each spec names the two
// landmarks it takes from EACH hand, so the quad is
// [handA.a, handA.b, handB.b, handB.a] — a band spanning the gap between hands.
// Only the thumb↔index band is stampable; the other two ride along as decoration.
const FRAME_SPECS = [
  { key: 'main',   a: THUMB_TIP,  b: INDEX_TIP,  stampable: true  },
  { key: 'middle', a: INDEX_TIP,  b: MIDDLE_TIP, stampable: false },
  { key: 'lower',  a: MIDDLE_TIP, b: PINKY_TIP,  stampable: false },
];

// Canvas size tracks whatever the camera actually hands us — the 1280×720 here
// is only the request. Landmarks are normalized, so they line up either way;
// matching the real dimensions just avoids stretching the picture.
let W = 1280, H = 720;

// ===========================================================================
// One Euro filter — adaptive smoothing: heavy at rest, light when moving fast,
// so corners stop jittering without the frame lagging behind a quick gesture.
// ===========================================================================
const euroAlpha = (cutoff, dt) => 1 / (1 + (1 / (2 * Math.PI * cutoff)) / dt);

class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.35, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
  }
  filter(x, dt) {
    if (this.x === null) { this.x = x; return x; }
    const dxRaw = (x - this.x) / dt;
    this.dx += euroAlpha(this.dCutoff, dt) * (dxRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += euroAlpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

// One filter pair per (hand slot, landmark). Keyed so slot 0 and slot 1 never
// share smoothing state.
const smoothers = new Map();
function smooth(slot, lm, x, y, dt) {
  const key = slot * 100 + lm;
  let s = smoothers.get(key);
  if (!s) { s = { x: new OneEuro(), y: new OneEuro() }; smoothers.set(key, s); }
  return { x: s.x.filter(x, dt), y: s.y.filter(y, dt) };
}
const resetSmoothers = () => smoothers.clear();

// ===========================================================================
// WebGL plumbing
// ===========================================================================
const canvas = document.getElementById('gl');
const gl = canvas.getContext('webgl2', { alpha: false, antialias: true });
if (!gl) throw new Error('WebGL2 is not available in this browser.');

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile failed:\n' + gl.getShaderInfoLog(s));
  }
  return s;
}

function program(fragSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
  // Fixed attribute slots so a single VAO works with every program.
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.bindAttribLocation(p, 1, 'a_uvq');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program link failed:\n' + gl.getProgramInfoLog(p));
  }
  const u = {};
  for (const n of ['u_video', 'u_time', 'u_res', 'u_quadSize', 'u_quadBounds', 'u_alpha', 'u_flash']) {
    u[n] = gl.getUniformLocation(p, n);
  }
  return { p, u };
}

const videoProg = program(VIDEO_FRAG);
const filterProgs = FILTERS.map((f) => program(f.frag));

// Interleaved [x, y, u, v, q] × 4 vertices, re-uploaded per quad.
const vertexData = new Float32Array(4 * 5);
const vao = gl.createVertexArray();
const vbo = gl.createBuffer();
const ibo = gl.createBuffer();
gl.bindVertexArray(vao);
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.bufferData(gl.ARRAY_BUFFER, vertexData.byteLength, gl.DYNAMIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
gl.enableVertexAttribArray(1);
gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8);
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);

const videoTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, videoTex);
for (const [k, v] of [
  [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  [gl.TEXTURE_MIN_FILTER, gl.LINEAR],    [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
]) gl.texParameteri(gl.TEXTURE_2D, k, v);

gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

let texAllocated = false;

function resize(w, h) {
  W = w; H = h;
  canvas.width = w;
  canvas.height = h;
  canvas.parentElement.style.aspectRatio = `${w} / ${h}`;
  gl.viewport(0, 0, w, h);
  texAllocated = false;
}
resize(W, H);

// ===========================================================================
// Quad geometry
// ===========================================================================

// Corners arrive as pixel-space points tagged with which landmark produced them.
// Sorting by angle around the centroid guarantees a simple (non-self-crossing)
// polygon; rotating the result so the left-hand thumb lands at index 0 keeps the
// UV assignment stable frame to frame, so filter patterns don't spin.
function orderCorners(pts) {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  );
  const anchor = Math.max(0, sorted.findIndex((p) => p.anchor));
  return [0, 1, 2, 3].map((i) => sorted[(anchor + i) % 4]);
}

// Projective correction for an arbitrary quad: q_i = (d_i + d_i+2) / d_i+2,
// where d is the distance from corner i to the diagonal intersection. Passing
// (u*q, v*q, q) and dividing in the fragment shader makes the local UVs
// perspective-correct instead of splitting into two visibly-creased triangles.
function projectiveQ(p) {
  const ex = p[2].x - p[0].x, ey = p[2].y - p[0].y; // A→C
  const fx = p[3].x - p[1].x, fy = p[3].y - p[1].y; // B→D
  const gx = p[1].x - p[0].x, gy = p[1].y - p[0].y; // A→B
  const den = ex * fy - ey * fx;
  if (Math.abs(den) < 1e-6) return [1, 1, 1, 1];    // parallel diagonals
  const s = (gx * fy - fx * gy) / den;
  const t = (gx * ey - ex * gy) / den;
  // Diagonals crossing outside the quad means it is non-convex; affine is the
  // safe fallback (the formula would blow up).
  if (s <= 0.001 || s >= 0.999 || t <= 0.001 || t >= 0.999) return [1, 1, 1, 1];
  return [1 / (1 - s), 1 / (1 - t), 1 / s, 1 / t];
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function quadSize(p) {
  return [
    (dist(p[0], p[1]) + dist(p[3], p[2])) / 2,
    (dist(p[0], p[3]) + dist(p[1], p[2])) / 2,
  ];
}

// Scale + rotate a quad's corners about its own centroid (used by the stamp
// pulse and the blow-away dissolve).
function transformQuad(p, scale, rot) {
  const cx = (p[0].x + p[1].x + p[2].x + p[3].x) / 4;
  const cy = (p[0].y + p[1].y + p[2].y + p[3].y) / 4;
  const c = Math.cos(rot), s = Math.sin(rot);
  return p.map((v) => {
    const dx = (v.x - cx) * scale, dy = (v.y - cy) * scale;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  });
}

const UVS = [[0, 0], [1, 0], [1, 1], [0, 1]];

function drawQuad(corners, filterIndex, alpha, flash, time) {
  const q = projectiveQ(corners);
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (let i = 0; i < 4; i++) {
    const sx = corners[i].x / W, sy = corners[i].y / H;
    vertexData[i * 5 + 0] = sx * 2 - 1;   // clip x
    vertexData[i * 5 + 1] = 1 - sy * 2;   // clip y
    vertexData[i * 5 + 2] = UVS[i][0] * q[i];
    vertexData[i * 5 + 3] = UVS[i][1] * q[i];
    vertexData[i * 5 + 4] = q[i];
    minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
    minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
  }

  const { p, u } = filterProgs[filterIndex];
  const [qw, qh] = quadSize(corners);
  gl.useProgram(p);
  gl.uniform1i(u.u_video, 0);
  gl.uniform1f(u.u_time, time);
  gl.uniform2f(u.u_res, W, H);
  gl.uniform2f(u.u_quadSize, qw, qh);
  gl.uniform4f(u.u_quadBounds, minX, minY, maxX, maxY);
  gl.uniform1f(u.u_alpha, alpha);
  gl.uniform1f(u.u_flash, flash);

  gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertexData);
  gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
}

function drawVideo() {
  for (let i = 0; i < 4; i++) {
    vertexData[i * 5 + 0] = UVS[i][0] * 2 - 1;
    vertexData[i * 5 + 1] = 1 - UVS[i][1] * 2;
    vertexData[i * 5 + 2] = UVS[i][0];
    vertexData[i * 5 + 3] = UVS[i][1];
    vertexData[i * 5 + 4] = 1;
  }
  gl.useProgram(videoProg.p);
  gl.uniform1i(videoProg.u.u_video, 0);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertexData);
  gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
}

// ===========================================================================
// App state
// ===========================================================================
const state = {
  phase: 'LOADING',          // LOADING | ERROR | IDLE | TRACKING | CLEARING
  live: [],                  // one entry per FRAME_SPECS; [0] is the stampable one
  openCorners: null,         // last main-band framing with both hands open
  stamped: [],               // { corners, filter, stampTime }
  ghosts: [],                // { corners, filter, dieStart, mode }
  nextFilter: 0,
  lostFrames: 99,
  // Counts DETECTIONS, not rendered frames — the camera delivers ~30fps while we
  // render at 60, and the gesture windows are specified in tracking frames.
  frame: 0,
  lastHands: [],
  // Far in the past, so a fast page load can't read as a just-fired gesture.
  lastStamp: -1e9,
  lastClear: -1e9,
  swipeFrames: 0,
  handsSeen: 0,
  handLabel: null,           // 'Left' | 'Right' when exactly one hand is visible
  pinch: [
    { armed: false, downFrame: null, metric: 1 },
    { armed: false, downFrame: null, metric: 1 },
  ],
  vel: [null, null],         // EMA-smoothed wrist velocity, normalized units/sec
  prevWrist: [null, null],
};

// ===========================================================================
// UI
// ===========================================================================
const statusEl = document.getElementById('status');
const dashesEl = document.getElementById('dashes');
const fpsEl = document.getElementById('fps');
const veil = document.getElementById('veil');
const veilText = document.getElementById('veilText');
const retryBtn = document.getElementById('retry');

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];

function setStatus(text, tone = 'idle') {
  if (statusEl.textContent !== text) statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function updateStatus(now) {
  if (state.phase === 'LOADING' || state.phase === 'ERROR') return;

  if (now - state.lastClear < 900 && state.stamped.length === 0) {
    setStatus('Frames cleared', 'idle');
    return;
  }
  if (state.handsSeen === 0) { setStatus('Show both hands to start', 'idle'); return; }
  if (state.handsSeen === 1) {
    const other = state.handLabel === 'Left' ? 'right' : 'left';
    setStatus(
      state.handLabel
        ? `${state.handLabel} hand in view. Show your ${other} to open a frame.`
        : 'One hand in view. Show the other to open a frame.',
      'idle'
    );
    return;
  }
  const n = state.stamped.length;
  if (n === 0) { setStatus('Two hands locked. Pinch both hands to stamp the frame', 'live'); return; }
  setStatus(
    `Two hands locked. ${WORDS[n][0].toUpperCase() + WORDS[n].slice(1)} comic ` +
    `${n === 1 ? 'effect is' : 'effects are'} live.`,
    'live'
  );
}

function updateDashes() {
  const active = [...state.stamped.map((f) => f.filter), ...state.live.map((f) => f.filter)];
  if (dashesEl.childElementCount !== active.length) {
    dashesEl.replaceChildren(...active.map(() => {
      const d = document.createElement('div');
      d.className = 'dash';
      return d;
    }));
  }
  active.forEach((f, i) => { dashesEl.children[i].style.color = FILTERS[f].color; });
}

let showFps = false;
addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    showFps = !showFps;
    fpsEl.hidden = !showFps;
  }
});

function fail(message) {
  state.phase = 'ERROR';
  veil.hidden = false;
  veil.classList.add('error');
  veilText.textContent = message;
  retryBtn.hidden = false;
  setStatus(message, 'error');
}

// ===========================================================================
// Camera + landmarker
// ===========================================================================
const video = document.getElementById('cam');
let landmarker = null;
let lastVideoTime = -1;

async function initLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );
  const opts = {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
      delegate: 'GPU',
    },
    numHands: 2,
    runningMode: 'VIDEO',
  };
  try {
    return await HandLandmarker.createFromOptions(fileset, opts);
  } catch (err) {
    console.warn('GPU delegate unavailable, falling back to CPU:', err);
    opts.baseOptions.delegate = 'CPU';
    return await HandLandmarker.createFromOptions(fileset, opts);
  }
}

async function initCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    // 30fps matters: the swipe gesture needs several tracking frames inside the
    // ~200ms the motion lasts, so a 10-15fps stream makes it hard to trigger.
    video: {
      width: { ideal: W }, height: { ideal: H },
      frameRate: { ideal: 30, min: 15 },
      facingMode: 'user',
    },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  await new Promise((r) => {
    if (video.readyState >= 2) r();
    else video.addEventListener('loadeddata', r, { once: true });
  });
  resize(video.videoWidth || W, video.videoHeight || H);
}

async function start() {
  state.phase = 'LOADING';
  veil.hidden = false;
  veil.classList.remove('error');
  retryBtn.hidden = true;
  veilText.textContent = 'Loading hand tracking…';
  setStatus('Loading hand tracking…', 'idle');

  try {
    if (!landmarker) landmarker = await initLandmarker();
  } catch (err) {
    console.error(err);
    fail('Could not load the hand tracking model. Check your connection and retry.');
    return;
  }

  veilText.textContent = 'Waiting for camera permission…';
  try {
    await initCamera();
  } catch (err) {
    console.error(err);
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    fail(denied
      ? 'Camera permission denied. Allow camera access in your browser, then restart.'
      : 'No camera available. Plug one in or close the app that is using it, then restart.');
    return;
  }

  resetSmoothers();
  state.phase = 'IDLE';
  state.lostFrames = 99;
  veil.hidden = true;
}

retryBtn.addEventListener('click', start);

// ===========================================================================
// Gesture handling
// ===========================================================================

// MediaPipe reports x in raw camera space; the display is mirrored, so screen
// x is 1 - lm.x. Everything downstream (velocity signs, corner order) lives in
// this mirrored screen space.
const screenX = (lm) => 1 - lm.x;

function readHands(result, dt) {
  const out = [];
  const n = result.landmarks.length;
  for (let i = 0; i < n; i++) {
    const lms = result.landmarks[i];
    // MediaPipe's handedness assumes a mirrored image; we feed it the raw feed,
    // so its label is inverted relative to the user's actual hand.
    const raw = result.handedness?.[i]?.[0]?.categoryName;
    out.push({
      label: raw === 'Left' ? 'Right' : 'Left',
      wristX: screenX(lms[WRIST]),
      lms,
    });
  }
  // Slot by screen position, not by handedness: it survives label flips and is
  // all the quad ordering actually needs.
  out.sort((a, b) => a.wristX - b.wristX);

  return out.map((h, slot) => {
    const pts = {};   // smoothed, pixel space — quad corners
    const raw = {};   // unsmoothed, pixel space — gesture metrics
    for (const id of TRACKED) {
      const sx = screenX(h.lms[id]), sy = h.lms[id].y;
      const s = smooth(slot, id, sx, sy, dt);
      pts[id] = { x: s.x * W, y: s.y * H };
      raw[id] = { x: sx * W, y: sy * H };
    }
    return { slot, label: h.label, pts, raw, rawWristX: h.wristX, rawWristY: h.lms[WRIST].y };
  });
}

// Palm-width normalisation makes the pinch metric distance-invariant: the same
// gesture reads the same whether the hand is near the lens or far from it.
//
// Reads RAW landmarks on purpose. One Euro smoothing exists to stop the *corners*
// jittering; routing the pinch metric through it too costs ~150ms of lag on a
// fast pinch and swallows the gesture entirely on a quick one.
function pinchMetric(h) {
  const palm = dist(h.raw[INDEX_MCP], h.raw[PINKY_MCP]);
  if (palm < 1e-3) return 1;
  return dist(h.raw[THUMB_TIP], h.raw[INDEX_TIP]) / palm;
}

function updatePinch(hands, now) {
  for (const h of hands) {
    const p = state.pinch[h.slot];
    p.metric = pinchMetric(h);
    if (p.metric > PINCH_RELEASE) { p.armed = true; p.downFrame = null; }
    else if (p.armed && p.metric < PINCH_ON && p.downFrame === null) p.downFrame = state.frame;
  }

  // Two of the main band's corners ARE the thumb and index tips, so the act of
  // pinching collapses that quad to a sliver. Freezing corners at the moment the
  // gesture fires would stamp that sliver. Remember the last framing where both
  // hands were open and stamp *that* — the shot you were composing. (The other
  // two bands don't touch the thumb, so they're unaffected by the pinch.)
  const main = mainBand();
  if (main && state.pinch[0].metric > PINCH_RELEASE && state.pinch[1].metric > PINCH_RELEASE) {
    state.openCorners = main.corners.map((c) => ({ ...c }));
  }

  const [a, b] = state.pinch;
  const together = a.downFrame !== null && b.downFrame !== null &&
                   Math.abs(a.downFrame - b.downFrame) <= PINCH_WINDOW;
  if (together && now - state.lastStamp > STAMP_DEBOUNCE && main) {
    stamp(now);
    a.armed = b.armed = false;
    a.downFrame = b.downFrame = null;
  }
}

// Only the main (thumb↔index) band stamps; the middle and lower bands are live
// decoration and are never frozen.
function stamp(now) {
  state.lastStamp = now;
  const main = mainBand();
  const corners = state.openCorners ?? main.corners;
  state.stamped.push({
    corners: corners.map((c) => ({ ...c })),
    filter: main.filter,
    stampTime: now,
  });
  state.openCorners = null;
  state.nextFilter = (state.nextFilter + 1) % FILTERS.length;
  while (state.stamped.length > MAX_STAMPED) {
    const old = state.stamped.shift();
    state.ghosts.push({ ...old, dieStart: now, mode: 'fade' });
  }
}

function updateSwipe(hands, now) {
  if (hands.length < 2) { state.swipeFrames = 0; return; }

  let diverging = true;
  for (const h of hands) {
    const prev = state.prevWrist[h.slot];
    const cur = { x: h.rawWristX, y: h.rawWristY, t: now };
    state.prevWrist[h.slot] = cur;
    if (!prev) { state.vel[h.slot] = 0; diverging = false; continue; }
    const dt = Math.max((now - prev.t) / 1000, 1e-3);
    const vx = (cur.x - prev.x) / dt;                 // screen-widths / sec
    const prevV = state.vel[h.slot] ?? vx;
    // Time-based EMA rather than a fixed per-frame alpha: with a fixed alpha the
    // smoothing lag scales with frame rate, so SWIPE_SPEED would silently mean
    // something different on a 60fps machine than on a 20fps one.
    const a = 1 - Math.exp(-dt / VEL_TAU);
    state.vel[h.slot] = prevV + a * (vx - prevV);
  }

  // Slot 0 is the left of the screen: separating means it flies left (negative)
  // while slot 1 flies right (positive). Requiring the signs this way — rather
  // than merely "opposite" — keeps a fast clap from clearing the board.
  const v0 = state.vel[0], v1 = state.vel[1];
  diverging = diverging && v0 !== null && v1 !== null &&
              v0 < -SWIPE_SPEED && v1 > SWIPE_SPEED;

  state.swipeFrames = diverging ? state.swipeFrames + 1 : 0;

  if (state.swipeFrames >= SWIPE_FRAMES && now - state.lastClear > CLEAR_COOLDOWN) {
    clearAll(now);
    state.swipeFrames = 0;
  }
}

function clearAll(now) {
  state.lastClear = now;
  state.phase = 'CLEARING';
  const blown = [...state.stamped, ...state.live];
  for (const f of blown) {
    state.ghosts.push({
      corners: f.corners.map((c) => ({ ...c })),
      filter: f.filter,
      dieStart: now,
      mode: 'blow',
      spin: (Math.random() - 0.5) * 0.8,
    });
  }
  state.stamped.length = 0;
  state.live = [];
  state.openCorners = null;
}

// ===========================================================================
// Frame building
// ===========================================================================
function buildCorners(hands, spec) {
  const [a, b] = hands;
  return orderCorners([
    { ...a.pts[spec.a], anchor: true },   // stable UV origin
    { ...a.pts[spec.b] },
    { ...b.pts[spec.b] },
    { ...b.pts[spec.a] },
  ]);
}

const mainBand = () => state.live.find((f) => f.stampable) ?? null;

// Rebuilt every detection. Filters are derived from nextFilter rather than
// stored, so stamping (which advances nextFilter) shifts all three bands at once
// and they stay distinct from each other.
function buildLive(hands) {
  return FRAME_SPECS.map((spec, i) => ({
    corners: buildCorners(hands, spec),
    filter: (state.nextFilter + i) % FILTERS.length,
    stampable: spec.stampable,
  }));
}

// ===========================================================================
// Render loop
// ===========================================================================
let lastT = performance.now();
let lastDetectT = performance.now();
let fpsAccum = 0, fpsCount = 0;

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(Math.max((now - lastT) / 1000, 1e-3), 0.1);
  lastT = now;

  if (state.phase === 'LOADING' || state.phase === 'ERROR') return;

  // --- detect -------------------------------------------------------------
  let hands = [];
  let fresh = false;   // did the camera actually give us a new frame this tick?
  if (video.readyState >= 2) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    // Allocate once, then sub-upload: re-allocating every frame costs a driver
    // round-trip we don't need at 60fps.
    if (!texAllocated) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      texAllocated = true;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }

    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      try {
        // dt here is time since the last DETECTION, which is what One Euro needs.
        const ddt = Math.min(Math.max((now - lastDetectT) / 1000, 1e-3), 0.1);
        lastDetectT = now;
        const res = landmarker.detectForVideo(video, now);
        hands = readHands(res, ddt);
        state.lastHands = hands;
        state.frame++;
        fresh = true;
      } catch (err) {
        console.warn('detectForVideo failed', err);
      }
    } else {
      hands = state.lastHands ?? [];
    }
  }

  state.handsSeen = hands.length;
  state.handLabel = hands.length === 1 ? hands[0].label : null;

  // --- gestures + live frame ---------------------------------------------
  if (hands.length === 2) {
    state.lostFrames = 0;
    state.live = buildLive(hands);
    state.phase = 'TRACKING';
    // Only on real detections: a repeated camera frame would read as zero wrist
    // motion and drag the velocity EMA below the swipe threshold.
    if (fresh) {
      updatePinch(hands, now);
      updateSwipe(hands, now);
    }
  } else {
    state.lostFrames++;
    state.swipeFrames = 0;
    state.prevWrist = [null, null];
    state.vel = [null, null];
    if (state.lostFrames > HAND_LOST_FRAMES) {
      state.live = [];
      state.openCorners = null;
      if (state.phase !== 'CLEARING') state.phase = 'IDLE';
    }
    if (hands.length === 0) resetSmoothers();
  }

  state.ghosts = state.ghosts.filter((g) => now - g.dieStart < DISSOLVE_MS);
  if (state.phase === 'CLEARING' && state.ghosts.length === 0) {
    state.phase = state.live.length ? 'TRACKING' : 'IDLE';
  }

  // --- render -------------------------------------------------------------
  const t = now / 1000;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.clearColor(0.05, 0.05, 0.07, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  drawVideo();

  for (const f of state.stamped) {
    // Shutter pulse: a quick scale bump plus a white flash right after locking.
    const age = now - f.stampTime;
    const pulse = age < 220 ? 1 + 0.05 * Math.sin(Math.PI * (age / 220)) : 1;
    const flash = age < 180 ? 0.85 * (1 - age / 180) : 0;
    drawQuad(pulse === 1 ? f.corners : transformQuad(f.corners, pulse, 0), f.filter, 1, flash, t);
  }

  for (const g of state.ghosts) {
    const k = (now - g.dieStart) / DISSOLVE_MS;
    const scale = g.mode === 'blow' ? 1 + 0.9 * k : 1 + 0.1 * k;
    const rot = g.mode === 'blow' ? (g.spin ?? 0) * k : 0;
    drawQuad(transformQuad(g.corners, scale, rot), g.filter, 1 - k, 0, t);
  }

  // Main band first, narrow bands over it. The thumb↔index band is by far the
  // tallest and overlaps the other two, so drawing it last would bury them.
  for (const f of state.live) drawQuad(f.corners, f.filter, 1, 0, t);

  // --- ui -----------------------------------------------------------------
  updateStatus(now);
  updateDashes();

  fpsAccum += dt; fpsCount++;
  if (fpsAccum >= 0.5) {
    if (showFps) fpsEl.textContent = `${Math.round(fpsCount / fpsAccum)} fps`;
    fpsAccum = 0; fpsCount = 0;
  }
}

start();
loop();
