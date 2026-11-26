/**
 * game.js — Golden Hour Flight.
 *
 * A low-poly 3D flight game: race a little prop plane through a loop of
 * glowing rings over a sunset archipelago. Built on the hand-rolled WebGL
 * engine in engine.js; all sound is synthesized in audio.js.
 *
 * Controls
 *  - Mouse: move to steer (plane banks toward the pointer)
 *  - Arrow keys / WASD: steer, Shift or Space: boost, S: slow down
 *  - Touch: drag to steer, hold the BOOST button to boost
 *  - P or Esc: pause
 *
 * Fuel: the tank drains as you fly and faster under boost; each ring
 * passed tops it up, and an empty tank ends the run — throttle
 * discipline is a decision, not a detail.
 */

import {
  Geometry,
  Mesh,
  Renderer,
  boxGeometry,
  coneGeometry,
  cylinderGeometry,
  sphereGeometry,
  torusGeometry,
  mat4Compose,
  mat4Identity,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  norm3,
  transformPoint,
} from "./engine.js";
import { SoundBank } from "./audio.js";

// ------------------------------------------------------------ utilities ---

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
/** Frame-rate independent smoothing factor. */
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Build a matrix from a position and an orthonormal basis (ring frames). */
function mat4FromBasis(pos, xAxis, yAxis, zAxis) {
  const out = new Float32Array(16);
  out[0] = xAxis[0]; out[1] = xAxis[1]; out[2] = xAxis[2];
  out[4] = yAxis[0]; out[5] = yAxis[1]; out[6] = yAxis[2];
  out[8] = zAxis[0]; out[9] = zAxis[1]; out[10] = zAxis[2];
  out[12] = pos[0]; out[13] = pos[1]; out[14] = pos[2];
  out[15] = 1;
  return out;
}

// ------------------------------------------------------------------ DOM ---

const $ = (id) => document.getElementById(id);
const canvas = $("game-canvas");
const hudEl = $("hud");
const hudScore = $("hud-score");
const hudCombo = $("hud-combo");
const hudRings = $("hud-rings");
const hudTime = $("hud-time");
const hudSpeed = $("hud-speed");
const hudAlt = $("hud-alt");
const hudHdg = $("hud-hdg");
const fuelFill = $("fuel-fill");
const bannerEl = $("banner");
const toastEl = $("toast");
const navMarker = $("nav-marker");
const navDist = $("nav-dist");
const popupsEl = $("popups");
const menuEl = $("screen-menu");
const pauseEl = $("screen-pause");
const finishEl = $("screen-finish");
const menuBestEl = $("menu-best");
const finishStatsEl = $("finish-stats");

// -------------------------------------------------------------- palette ---

const COL = {
  sand: [0.93, 0.8, 0.55],
  grass: [0.32, 0.62, 0.34],
  grassDry: [0.55, 0.66, 0.3],
  rock: [0.5, 0.46, 0.44],
  trunk: [0.42, 0.29, 0.18],
  leaf: [0.16, 0.48, 0.26],
  leafLight: [0.3, 0.62, 0.3],
  ocean: [0.06, 0.34, 0.55],
  cloud: [1.0, 0.97, 0.92],
  ringGold: [1.0, 0.72, 0.2],
  ringNext: [1.0, 0.8, 0.25],
  ringTodo: [0.45, 0.9, 0.85],
  ringDone: [0.35, 0.95, 0.45],
  planeBody: [0.98, 0.9, 0.76],
  planeAccent: [0.92, 0.3, 0.22],
  planeDark: [0.12, 0.16, 0.24],
  lighthouseWhite: [0.96, 0.94, 0.9],
  lighthouseRed: [0.85, 0.22, 0.18],
};

// ---------------------------------------------------------------- world ---

const COURSE_SEED = 20261126;
const RING_COUNT = 16;
const RING_RADIUS = 15;
const WORLD_LIMIT = 2300;

const rng = mulberry32(COURSE_SEED);

/** Ring course: a big loop around the archipelago. */
const rings = [];
for (let i = 0; i < RING_COUNT; i++) {
  const t = i / RING_COUNT;
  const ang = -Math.PI / 2 + t * Math.PI * 2;
  const rad = 740 + Math.sin(t * Math.PI * 3) * 120 + (rng() - 0.5) * 90;
  rings.push({
    pos: [Math.cos(ang) * rad, 34 + rng() * 52, Math.sin(ang) * rad],
    normal: [0, 0, 1],
    state: "todo", // todo | next | done
  });
}
for (let i = 0; i < RING_COUNT; i++) {
  const cur = rings[i];
  const nxt = rings[(i + 1) % RING_COUNT];
  const d = norm3([
    nxt.pos[0] - cur.pos[0],
    (nxt.pos[1] - cur.pos[1]) * 0.6,
    nxt.pos[2] - cur.pos[2],
  ]);
  cur.normal = d;
}

/** Islands: { x, z, r, peak } — also used for collision. */
const islands = [];
function islandHeightAt(isle, dist) {
  if (dist >= isle.r) return -3;
  return isle.peak * (1 - dist / isle.r) - 2;
}
{
  // A heart island near the middle and a ring of islands around it.
  islands.push({ x: 0, z: 60, r: 210, peak: 62, trees: 16 });
  let placed = 0;
  let guard = 0;
  while (placed < 11 && guard < 300) {
    guard++;
    const ang = rng() * Math.PI * 2;
    const rad = 330 + rng() * 820;
    const cand = {
      x: Math.cos(ang) * rad,
      z: Math.sin(ang) * rad,
      r: 95 + rng() * 115,
      peak: 24 + rng() * 66,
      trees: 5 + Math.floor(rng() * 10),
    };
    // Keep the flight corridor around each ring reasonably clear.
    let ok = true;
    for (const ring of rings) {
      const d = Math.hypot(ring.pos[0] - cand.x, ring.pos[2] - cand.z);
      if (d < cand.r + 120) { ok = false; break; }
    }
    for (const other of islands) {
      const d = Math.hypot(other.x - cand.x, other.z - cand.z);
      if (d < (other.r + cand.r) * 0.72) { ok = false; break; }
    }
    if (ok) {
      islands.push(cand);
      placed++;
    }
  }
}

function buildTerrainGeometry() {
  const batch = new Geometry();
  for (const isle of islands) {
    // Sandy skirt, grassy cone, rocky cap on tall islands.
    batch.append(
      coneGeometry(isle.r * 1.12, isle.peak * 0.35 + 8, 11, COL.sand),
      mat4Compose(isle.x, (isle.peak * 0.35 + 8) / 2 - 4, isle.z, 0, rng() * 3, 0, 1, 1, 1),
    );
    batch.append(
      coneGeometry(isle.r, isle.peak + 4, 11, rng() > 0.5 ? COL.grass : COL.grassDry),
      mat4Compose(isle.x, (isle.peak + 4) / 2 - 2, isle.z, 0, rng() * 3, 0, 1, 1, 1),
    );
    if (isle.peak > 58) {
      batch.append(
        coneGeometry(isle.r * 0.34, isle.peak * 0.42, 8, COL.rock),
        mat4Compose(isle.x, isle.peak - isle.peak * 0.21 - 1, isle.z, 0, rng() * 3, 0, 1, 1, 1),
      );
    }
    // Trees scattered on the slopes.
    for (let i = 0; i < isle.trees; i++) {
      const ang = rng() * Math.PI * 2;
      const dist = isle.r * (0.25 + rng() * 0.55);
      const tx = isle.x + Math.cos(ang) * dist;
      const tz = isle.z + Math.sin(ang) * dist;
      const ty = islandHeightAt(isle, dist);
      if (ty < 2) continue;
      const s = 0.8 + rng() * 0.9;
      batch.append(
        cylinderGeometry(0.5, 0.7, 3.4, 5, COL.trunk),
        mat4Compose(tx, ty + 1.4, tz, 0, rng() * 3, 0, s, s, s),
      );
      batch.append(
        coneGeometry(2.6, 6.5, 7, rng() > 0.4 ? COL.leaf : COL.leafLight),
        mat4Compose(tx, ty + 3.4 + 2.6, tz, 0, rng() * 3, 0, s, s, s),
      );
      if (rng() > 0.5) {
        batch.append(
          coneGeometry(1.9, 4.6, 7, COL.leaf),
          mat4Compose(tx, ty + 3.4 + 5.4, tz, 0, rng() * 3, 0, s, s, s),
        );
      }
    }
    // A few rocks on the shore.
    const rockCount = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < rockCount; i++) {
      const ang = rng() * Math.PI * 2;
      const dist = isle.r * (0.86 + rng() * 0.2);
      const rx = isle.x + Math.cos(ang) * dist;
      const rz = isle.z + Math.sin(ang) * dist;
      const s = 1.5 + rng() * 3;
      batch.append(
        boxGeometry(s, s * 0.7, s * 0.85, COL.rock),
        mat4Compose(rx, Math.max(0.2, islandHeightAt(isle, dist)), rz, rng() * 0.6, rng() * 3, rng() * 0.6, 1, 1, 1),
      );
    }
  }
  // The lighthouse on the heart island.
  const lh = islands[0];
  const lx = lh.x + 42, lz = lh.z - 30;
  const ly = islandHeightAt(lh, Math.hypot(42, 30));
  batch.append(cylinderGeometry(4.2, 5.2, 7, 10, COL.lighthouseWhite), mat4Compose(lx, ly + 3.5, lz, 0, 0, 0, 1, 1, 1));
  batch.append(cylinderGeometry(3.4, 4.2, 7, 10, COL.lighthouseRed), mat4Compose(lx, ly + 10.5, lz, 0, 0, 0, 1, 1, 1));
  batch.append(cylinderGeometry(4.4, 4.4, 1.4, 10, COL.planeDark), mat4Compose(lx, ly + 14.6, lz, 0, 0, 0, 1, 1, 1));
  return { batch, lighthouseTop: [lx, ly + 15.6, lz] };
}

function buildOceanGeometry() {
  const g = new Geometry();
  const SIZE = 5600;
  const SEG = 100;
  const step = SIZE / SEG;
  const half = SIZE / 2;
  for (let iz = 0; iz < SEG; iz++) {
    for (let ix = 0; ix < SEG; ix++) {
      const x0 = -half + ix * step, x1 = x0 + step;
      const z0 = -half + iz * step, z1 = z0 + step;
      g.quad([x0, 0, z0], [x0, 0, z1], [x1, 0, z1], [x1, 0, z0], COL.ocean);
    }
  }
  return g;
}

function buildCloudGeometry(rngLocal) {
  const batch = new Geometry();
  const puffs = 3 + Math.floor(rngLocal() * 3);
  for (let i = 0; i < puffs; i++) {
    const r = 9 + rngLocal() * 13;
    batch.append(
      sphereGeometry(r, 8, 6, COL.cloud),
      mat4Compose((rngLocal() - 0.5) * 44, (rngLocal() - 0.5) * 5, (rngLocal() - 0.5) * 20, 0, rngLocal() * 3, 0, 1, 0.42, 1),
    );
  }
  return batch;
}

function buildPlaneGeometry() {
  const batch = new Geometry();
  const body = cylinderGeometry(0.55, 0.95, 7.2, 9, COL.planeBody);
  batch.append(body, mat4Compose(0, 0, 0, Math.PI / 2, 0, 0, 1, 1, 1)); // axis -> Z
  const nose = coneGeometry(0.55, 1.6, 9, COL.planeAccent);
  batch.append(nose, mat4Compose(0, 0, -4.3, -Math.PI / 2, 0, 0, 1, 1, 1)); // tip -> -Z
  batch.append(boxGeometry(9.6, 0.16, 1.9, COL.planeAccent), mat4Compose(0, -0.1, 0.2, 0, 0, 0, 1, 1, 1)); // main wing
  batch.append(boxGeometry(3.6, 0.14, 1.1, COL.planeAccent), mat4Compose(0, 0.25, 3.3, 0, 0, 0, 1, 1, 1)); // tail wing
  batch.append(boxGeometry(0.14, 1.7, 1.15, COL.planeAccent), mat4Compose(0, 0.8, 3.3, 0, 0, 0, 1, 1, 1)); // fin
  const cockpit = sphereGeometry(0.78, 8, 6, COL.planeDark);
  batch.append(cockpit, mat4Compose(0, 0.72, -0.7, 0, 0, 0, 1, 0.75, 1.5));
  batch.append(boxGeometry(0.5, 0.5, 0.5, COL.planeDark), mat4Compose(0, -0.3, -3.55, 0, 0, 0, 1, 1, 1)); // hub
  return batch;
}

function buildPropGeometry() {
  const batch = new Geometry();
  batch.append(boxGeometry(0.34, 3.6, 0.08, COL.planeDark), mat4Compose(0, 0, 0, 0, 0, 0, 1, 1, 1));
  batch.append(boxGeometry(3.6, 0.34, 0.08, COL.planeDark), mat4Compose(0, 0, 0, 0, 0, 0, 1, 1, 1));
  return batch;
}

// ------------------------------------------------------------- particles ---

const MAX_PARTICLES = 1000;
class ParticleSystem {
  constructor() {
    this.items = []; // {pos, vel, life, maxLife, color, size, gravity, drag}
    this.renderData = new Float32Array(MAX_PARTICLES * 8);
  }
  spawn(pos, vel, life, color, size, gravity = 0, drag = 0) {
    if (this.items.length >= MAX_PARTICLES) this.items.shift();
    this.items.push({
      pos: [pos[0], pos[1], pos[2]],
      vel: [vel[0], vel[1], vel[2]],
      life, maxLife: life, color, size, gravity, drag,
    });
  }
  burst(pos, count, color, speed, life, size, gravity = -6) {
    for (let i = 0; i < count; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(Math.random() * 2 - 1);
      const sp = speed * (0.35 + Math.random() * 0.75);
      this.spawn(
        pos,
        [Math.sin(ph) * Math.cos(th) * sp, Math.cos(ph) * sp, Math.sin(ph) * Math.sin(th) * sp],
        life * (0.6 + Math.random() * 0.7),
        color, size, gravity, 1.2,
      );
    }
  }
  update(dt) {
    const arr = this.items;
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      p.life -= dt;
      if (p.life <= 0) {
        arr.splice(i, 1);
        continue;
      }
      const dragF = Math.max(0, 1 - p.drag * dt);
      p.vel[0] *= dragF;
      p.vel[2] *= dragF;
      p.vel[1] = p.vel[1] * dragF + p.gravity * dt;
      p.pos[0] += p.vel[0] * dt;
      p.pos[1] += p.vel[1] * dt;
      p.pos[2] += p.vel[2] * dt;
    }
  }
  fillRenderData() {
    const data = this.renderData;
    let n = 0;
    for (const p of this.items) {
      const o = n * 8;
      data[o] = p.pos[0];
      data[o + 1] = p.pos[1];
      data[o + 2] = p.pos[2];
      data[o + 3] = p.color[0];
      data[o + 4] = p.color[1];
      data[o + 5] = p.color[2];
      data[o + 6] = p.size;
      data[o + 7] = clamp(p.life / p.maxLife, 0, 1);
      n++;
    }
    return n;
  }
}

// ------------------------------------------------------------ game state ---

const sound = new SoundBank();
const particles = new ParticleSystem();

let renderer = null;
let terrainMesh = null;
let oceanMesh = null;
let planeMesh = null;
let propMesh = null;
let lampMesh = null;
let beaconMesh = null;
let ringMeshes = null; // { next, todo, done }
let cloudList = [];
let lighthouseTop = [0, 80, 0];

const startDir = rings[0].normal;
const startPos = [
  rings[0].pos[0] - startDir[0] * 170,
  rings[0].pos[1] + 4,
  rings[0].pos[2] - startDir[2] * 170,
];

function yawPitchFromDir(d) {
  return {
    yaw: Math.atan2(-d[0], -d[2]),
    pitch: Math.asin(clamp(d[1], -1, 1)),
  };
}

// Staged views for the entry's screenshots (shots.json): ?shot=play opens
// mid-flight, ?shot=end on the finish screen, anything else on the menu.
const shotMode = typeof location !== "undefined"
  ? new URLSearchParams(location.search).get("shot")
  : null;

const S = {
  mode: "menu",
  pos: [...startPos],
  yaw: 0,
  pitch: 0,
  roll: 0,
  speed: 0,
  targetRing: 0,
  passed: 0,
  score: 0,
  combo: 0,
  bestCombo: 0,
  crashes: 0,
  elapsed: 0,
  segTime: 0,
  fuel: 100,
  timeBonus: 0,
  finishNote: "",
  countT: 0,
  lastCount: 4,
  crashT: 0,
  propAngle: 0,
  gt: 0,
  camPos: [startPos[0] + 60, startPos[1] + 30, startPos[2] + 120],
  toastAt: -9,
};
{
  const yp = yawPitchFromDir(startDir);
  S.yaw = yp.yaw;
  S.pitch = yp.pitch;
}

let best = null;
try {
  const raw = localStorage.getItem("golden-hour-flight-best");
  if (raw) best = JSON.parse(raw);
} catch {
  best = null;
}

// ---------------------------------------------------------------- input ---

const keys = {};
let pointer = { x: 0.5, y: 0.5, seen: false, touchDown: false };
let boostTouch = false;

window.addEventListener("keydown", (e) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(e.code)) {
    e.preventDefault();
  }
  keys[e.code] = true;
  if (e.code === "KeyP" || e.code === "Escape") {
    if (S.mode === "flying" || S.mode === "countdown") pauseGame();
    else if (S.mode === "paused") resumeGame();
  }
  if (e.code === "Enter" && S.mode === "menu") startGame();
});
window.addEventListener("keyup", (e) => {
  keys[e.code] = false;
});
window.addEventListener("blur", () => {
  for (const k of Object.keys(keys)) keys[k] = false;
  if (S.mode === "flying") pauseGame();
});

function updatePointer(e) {
  pointer.x = clamp(e.clientX / window.innerWidth, 0, 1);
  pointer.y = clamp(e.clientY / window.innerHeight, 0, 1);
  pointer.seen = true;
}
window.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch" && !pointer.touchDown) return;
  updatePointer(e);
});
window.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "touch") pointer.touchDown = true;
  updatePointer(e);
});
window.addEventListener("pointerup", (e) => {
  if (e.pointerType === "touch") pointer.touchDown = false;
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && S.mode === "flying") pauseGame();
});

// ------------------------------------------------------------- UI wiring ---

let bannerTimer = 0;
function showBanner(text, ms = 1400) {
  bannerEl.textContent = text;
  bannerEl.classList.add("show");
  window.clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => bannerEl.classList.remove("show"), ms);
}
function showToast(text, ms = 1800) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toastEl.classList.remove("show"), ms);
}

function projectToScreen(pos) {
  const vp = mat4Multiply(currentProj, currentView);
  const p = transformPoint(vp, pos);
  const w = currentClipW(vp, pos);
  if (w <= 0) return null;
  return {
    x: (p[0] / w) * 0.5 + 0.5,
    y: 0.5 - (p[1] / w) * 0.5,
    behind: false,
  };
}
// clip w for a world point under a view-projection matrix
function currentClipW(vp, pos) {
  return vp[3] * pos[0] + vp[7] * pos[1] + vp[11] * pos[2] + vp[15];
}
let currentProj = mat4Identity();
let currentView = mat4Identity();

function popupAt(worldPos, text) {
  const s = projectToScreen(worldPos);
  if (!s) return;
  const div = document.createElement("div");
  div.className = "pop";
  div.textContent = text;
  div.style.left = `${s.x * 100}%`;
  div.style.top = `${s.y * 100}%`;
  popupsEl.appendChild(div);
  window.setTimeout(() => div.remove(), 950);
}

function setScreen(name) {
  menuEl.classList.toggle("hidden", name !== "menu");
  pauseEl.classList.toggle("hidden", name !== "paused");
  finishEl.classList.toggle("hidden", name !== "finished");
  hudEl.classList.toggle("hidden", name === "menu");
  navMarker.classList.toggle("hidden", !(name === "flying" || name === "countdown"));
}

function refreshMenuBest() {
  menuBestEl.textContent = best
    ? `最佳成绩：${best.score} 分 · 用时 ${fmtTime(best.time)}`
    : "暂无记录 — 来创个纪录";
}

$("btn-start").addEventListener("click", () => {
  sound.unlock();
  sound.click();
  startGame();
});
$("btn-resume").addEventListener("click", () => {
  sound.click();
  resumeGame();
});
$("btn-restart").addEventListener("click", () => {
  sound.click();
  startGame();
});
$("btn-quit").addEventListener("click", () => {
  sound.click();
  toMenu();
});
$("btn-again").addEventListener("click", () => {
  sound.click();
  startGame();
});
$("btn-menu2").addEventListener("click", () => {
  sound.click();
  toMenu();
});
$("btn-pause").addEventListener("click", () => {
  if (S.mode === "flying" || S.mode === "countdown") pauseGame();
  else if (S.mode === "paused") resumeGame();
});
const soundBtn = $("btn-sound");
soundBtn.addEventListener("click", () => {
  sound.unlock();
  sound.setMuted(!sound.muted);
  soundBtn.textContent = sound.muted ? "🔇" : "🔊";
});
const boostBtn = $("btn-boost");
boostBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  boostTouch = true;
});
boostBtn.addEventListener("pointerup", () => { boostTouch = false; });
boostBtn.addEventListener("pointerleave", () => { boostTouch = false; });

// ------------------------------------------------------------ flow control ---

function resetRun() {
  S.pos = [...startPos];
  const yp = yawPitchFromDir(startDir);
  S.yaw = yp.yaw;
  S.pitch = yp.pitch;
  S.roll = 0;
  S.speed = 0;
  S.targetRing = 0;
  S.passed = 0;
  S.score = 0;
  S.combo = 0;
  S.bestCombo = 0;
  S.crashes = 0;
  S.elapsed = 0;
  S.segTime = 0;
  S.fuel = 100;
  S.timeBonus = 0;
  S.finishNote = "";
  for (const ring of rings) ring.state = "todo";
  rings[0].state = "next";
  particles.items.length = 0;
}

function startGame() {
  sound.unlock();
  resetRun();
  S.mode = "countdown";
  S.countT = 3.6;
  S.lastCount = 4;
  setScreen("flying");
  updateHud();
}

function pauseGame() {
  if (S.mode !== "flying" && S.mode !== "countdown") return;
  S.prevMode = S.mode;
  S.mode = "paused";
  setScreen("paused");
  sound.setEngine(0, false);
}

function resumeGame() {
  if (S.mode !== "paused") return;
  S.mode = S.prevMode || "flying";
  setScreen("flying");
}

function toMenu() {
  S.mode = "menu";
  resetRun();
  setScreen("menu");
  refreshMenuBest();
  sound.setEngine(0, false);
}

function finishRun(note = "") {
  S.mode = "finished";
  S.finishNote = note;
  const parTime = RING_COUNT * 19;
  S.timeBonus = Math.max(0, Math.round((parTime - S.elapsed) * 12));
  S.score += S.timeBonus;
  sound.finish();
  sound.setEngine(0, false);
  showFinish();
  showBanner(note ? "燃油耗尽！" : "完赛！", 1600);
}

function showFinish() {
  const isRecord = !best || S.score > best.score;
  if (isRecord) {
    best = { score: S.score, time: Math.round(S.elapsed) };
    if (!shotMode) {
      try {
        localStorage.setItem("golden-hour-flight-best", JSON.stringify(best));
      } catch {
        /* storage unavailable */
      }
    }
  }
  finishStatsEl.innerHTML =
    `<div class="stat"><span>总分</span><b>${S.score}</b></div>` +
    `<div class="stat"><span>用时</span><b>${fmtTime(S.elapsed)}</b></div>` +
    `<div class="stat"><span>时间奖励</span><b>+${S.timeBonus}</b></div>` +
    `<div class="stat"><span>最高连击</span><b>x${Math.max(1, S.bestCombo)}</b></div>` +
    `<div class="stat"><span>坠毁</span><b>${S.crashes} 次</b></div>` +
    `<div class="stat"><span>剩余燃油</span><b>${Math.round(S.fuel)}%</b></div>` +
    (S.finishNote ? `<div class="note">${S.finishNote}</div>` : "") +
    (isRecord ? `<div class="record">新纪录！</div>` : "");
  setScreen("finished");
}

// -------------------------------------------------------------- simulation ---

function forwardVec(yaw, pitch) {
  const m = mat4Multiply(
    mat4Compose(0, 0, 0, 0, yaw, 0, 1, 1, 1),
    mat4Compose(0, 0, 0, pitch, 0, 0, 1, 1, 1),
  );
  return transformPoint(m, [0, 0, -1]);
}

function planeMatrix() {
  const t = mat4Compose(S.pos[0], S.pos[1], S.pos[2], 0, 0, 0, 1, 1, 1);
  const ry = mat4Compose(0, 0, 0, 0, S.yaw, 0, 1, 1, 1);
  const rx = mat4Compose(0, 0, 0, S.pitch, 0, 0, 1, 1, 1);
  const rz = mat4Compose(0, 0, 0, 0, 0, -S.roll, 1, 1, 1);
  return mat4Multiply(mat4Multiply(mat4Multiply(t, ry), rx), rz);
}

function respawn() {
  const target = rings[S.targetRing];
  const anchor = S.targetRing === 0 ? startPos : rings[S.targetRing - 1].pos;
  const dir = norm3([
    target.pos[0] - anchor[0],
    target.pos[1] - anchor[1],
    target.pos[2] - anchor[2],
  ]);
  S.pos = [
    anchor[0] + dir[0] * 46,
    anchor[1] + dir[1] * 46 + 3,
    anchor[2] + dir[2] * 46,
  ];
  const yp = yawPitchFromDir(dir);
  S.yaw = yp.yaw;
  S.pitch = yp.pitch;
  S.roll = 0;
  S.speed = 47;
  S.mode = "flying";
}

function crash(kind) {
  S.mode = "crashed";
  S.crashT = 1.15;
  S.crashes++;
  S.combo = 0;
  S.score = Math.max(0, S.score - 150);
  if (kind === "water") {
    sound.splash();
    particles.burst(S.pos, 42, [0.75, 0.9, 1.0], 20, 0.9, 3.2, -3);
    showBanner("落水了！ -150", 1200);
  } else {
    sound.crash();
    particles.burst(S.pos, 42, [1.0, 0.52, 0.2], 24, 0.9, 3.4, -7);
    particles.burst(S.pos, 18, [0.35, 0.33, 0.32], 12, 1.3, 4.5, -2);
    showBanner("坠毁！ -150", 1200);
  }
  sound.setEngine(0, false);
}

function passRing(index, crossing) {
  const ring = rings[index];
  ring.state = "done";
  S.passed++;
  S.combo++;
  S.bestCombo = Math.max(S.bestCombo, S.combo);
  const comboBonus = Math.min(8, S.combo - 1) * 25;
  const segBonus = Math.max(0, Math.round((17 - S.segTime) * 6));
  const gained = 100 + comboBonus + segBonus;
  S.score += gained;
  S.fuel = Math.min(100, S.fuel + 9);
  S.segTime = 0;
  particles.burst(ring.pos, 30, COL.ringGold, 17, 0.8, 3.0, -2);
  popupAt(crossing, `+${gained}`);
  if (index === RING_COUNT - 1) {
    finishRun();
    return;
  }
  if (S.passed % 4 === 0) {
    sound.checkpoint();
    showToast(`检查点 ${S.passed}/${RING_COUNT}`);
  } else {
    sound.ringChime(S.combo);
  }
  S.targetRing++;
  rings[S.targetRing].state = "next";
}

function stepFlying(dt) {
  // --- steering input
  let steerX = 0;
  let steerY = 0;
  const keySteer =
    keys.ArrowLeft || keys.ArrowRight || keys.ArrowUp || keys.ArrowDown ||
    keys.KeyA || keys.KeyD || keys.KeyW || keys.KeyS;
  if (keys.ArrowLeft || keys.KeyA) steerX -= 1;
  if (keys.ArrowRight || keys.KeyD) steerX += 1;
  if (keys.ArrowUp || keys.KeyW) steerY += 1;
  if (keys.ArrowDown || keys.KeyS) steerY -= 1;
  if (!keySteer && pointer.seen) {
    steerX += clamp((pointer.x - 0.5) * 2.3, -1, 1);
    steerY += clamp((0.5 - pointer.y) * 2.1, -1, 1);
  }
  steerX = clamp(steerX, -1, 1);
  steerY = clamp(steerY, -1, 1);

  const targetRoll = steerX * 1.05;
  const targetPitch = steerY * 0.46;
  S.roll = lerp(S.roll, targetRoll, damp(6.5, dt));
  S.pitch = lerp(S.pitch, targetPitch, damp(4.5, dt));
  S.yaw += -S.roll * 1.35 * dt;

  const boosting = keys.ShiftLeft || keys.ShiftRight || keys.Space || boostTouch;
  const targetSpeed = boosting ? 82 : 47;
  S.speed = lerp(S.speed, targetSpeed, damp(1.7, dt));

  // --- move
  const prevPos = [...S.pos];
  const f = forwardVec(S.yaw, S.pitch);
  S.pos[0] += f[0] * S.speed * dt;
  S.pos[1] += f[1] * S.speed * dt;
  S.pos[2] += f[2] * S.speed * dt;
  S.pos[1] = Math.min(S.pos[1], 330);

  // soft world boundary: nudge back toward the archipelago
  const distC = Math.hypot(S.pos[0], S.pos[2]);
  if (distC > WORLD_LIMIT) {
    const inward = norm3([-S.pos[0], 0, -S.pos[2]]);
    S.pos[0] += inward[0] * 42 * dt;
    S.pos[2] += inward[2] * 42 * dt;
    if (S.gt - S.toastAt > 3) {
      S.toastAt = S.gt;
      showToast("已到边界，正在返航");
    }
  }

  S.elapsed += dt;
  S.segTime += dt;

  // --- fuel: cruising sips, boosting gulps, an empty tank ends the run
  S.fuel = Math.max(0, S.fuel - (boosting ? 1.05 : 0.55) * dt);
  if (S.fuel <= 0) {
    finishRun("燃油耗尽 — 下次省着点油");
    return;
  }

  // --- wingtip trails
  if (S.speed > 18) {
    const rot = mat4Multiply(
      mat4Compose(0, 0, 0, 0, S.yaw, 0, 1, 1, 1),
      mat4Compose(0, 0, 0, S.pitch, 0, 0, 1, 1, 1),
    );
    const right = transformPoint(rot, [1, 0, 0]);
    for (const side of [-4.8, 4.8]) {
      if (Math.random() < dt * 46) {
        particles.spawn(
          [S.pos[0] + right[0] * side, S.pos[1] + right[1] * side, S.pos[2] + right[2] * side],
          [-f[0] * 5, -f[1] * 5 + 0.4, -f[2] * 5],
          0.5, [1, 0.95, 0.85], 1.7, 0, 0.5,
        );
      }
    }
  }

  // --- ring pass detection
  const ring = rings[S.targetRing];
  const n = ring.normal;
  const relPrev = (prevPos[0] - ring.pos[0]) * n[0] + (prevPos[1] - ring.pos[1]) * n[1] + (prevPos[2] - ring.pos[2]) * n[2];
  const relNow = (S.pos[0] - ring.pos[0]) * n[0] + (S.pos[1] - ring.pos[1]) * n[1] + (S.pos[2] - ring.pos[2]) * n[2];
  if (relPrev < 0 && relNow >= 0) {
    const t = relPrev / (relPrev - relNow);
    const cross = [
      lerp(prevPos[0], S.pos[0], t),
      lerp(prevPos[1], S.pos[1], t),
      lerp(prevPos[2], S.pos[2], t),
    ];
    const d = Math.hypot(cross[0] - ring.pos[0], cross[1] - ring.pos[1], cross[2] - ring.pos[2]);
    if (d < RING_RADIUS + 1) {
      passRing(S.targetRing, cross);
      if (S.mode !== "flying") return;
    }
  }

  // --- collisions
  if (S.pos[1] < 1.4) {
    crash("water");
    return;
  }
  for (const isle of islands) {
    const d = Math.hypot(S.pos[0] - isle.x, S.pos[2] - isle.z);
    if (d < isle.r && S.pos[1] < islandHeightAt(isle, d) + 1.6) {
      crash("land");
      return;
    }
  }
}

/** Compass heading for the HUD: yaw 0 faces north (-Z), bearing grows clockwise. */
function headingText() {
  const deg = ((Math.round((-S.yaw * 180) / Math.PI) % 360) + 360) % 360;
  const dirs = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
  return `${deg}° ${dirs[Math.round(deg / 45) % 8]}`;
}

function updateHud() {
  hudScore.textContent = String(S.score);
  hudRings.textContent = `${S.passed}/${RING_COUNT}`;
  hudTime.textContent = fmtTime(S.elapsed);
  hudSpeed.textContent = String(Math.round(S.speed * 3.6));
  hudAlt.textContent = String(Math.max(0, Math.round(S.pos[1])));
  hudHdg.textContent = headingText();
  fuelFill.style.width = `${S.fuel}%`;
  fuelFill.classList.toggle("low", S.fuel < 25);
  hudCombo.textContent = S.combo >= 2 ? `连击 x${S.combo}` : "";
}

function updateNav() {
  if (S.mode !== "flying" && S.mode !== "countdown" && S.mode !== "photo") return;
  const ring = rings[S.targetRing];
  const s = projectToScreen(ring.pos);
  const dist = Math.round(Math.hypot(
    ring.pos[0] - S.pos[0], ring.pos[1] - S.pos[1], ring.pos[2] - S.pos[2],
  ));
  navDist.textContent = `${dist}m`;
  if (s && s.x > 0.03 && s.x < 0.97 && s.y > 0.03 && s.y < 0.97) {
    navMarker.style.left = `${s.x * 100}%`;
    navMarker.style.top = `${s.y * 100}%`;
    navMarker.style.setProperty("--arrow", "0deg");
    navMarker.classList.remove("edge");
  } else {
    // Clamp to an ellipse near the screen edge, arrow pointing outward.
    const vp = mat4Multiply(currentProj, currentView);
    const p = transformPoint(vp, ring.pos);
    let dx = p[0];
    let dy = -p[1];
    const w = currentClipW(vp, ring.pos);
    if (w < 0) {
      dx = -dx;
      dy = -dy;
    }
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const cx = 50 + dx * 42;
    const cy = 50 + dy * 40;
    navMarker.style.left = `${cx}%`;
    navMarker.style.top = `${cy}%`;
    navMarker.style.setProperty("--arrow", `${Math.atan2(dy, dx) + Math.PI / 2}rad`);
    navMarker.classList.add("edge");
  }
}

// ---------------------------------------------------------------- render ---

function render(dt) {
  const aspect = renderer.resize();
  const gt = S.gt;

  let camTarget;
  if (S.mode === "menu") {
    const t = gt * 0.045;
    S.camPos = [Math.sin(t) * 640, 165 + Math.sin(gt * 0.13) * 24, Math.cos(t) * 640];
    camTarget = [0, 26, 0];
    S.pos = [startPos[0], startPos[1] + Math.sin(gt * 1.25) * 0.9, startPos[2]];
  } else {
    const f = forwardVec(S.yaw, S.pitch);
    const desired = [
      S.pos[0] - f[0] * 13.5,
      S.pos[1] - f[1] * 13.5 + 5,
      S.pos[2] - f[2] * 13.5,
    ];
    const k = damp(S.mode === "countdown" ? 2.2 : 5.2, dt);
    S.camPos = [
      lerp(S.camPos[0], desired[0], k),
      lerp(S.camPos[1], desired[1], k),
      lerp(S.camPos[2], desired[2], k),
    ];
    camTarget = [S.pos[0] + f[0] * 26, S.pos[1] + f[1] * 26 + 1.4, S.pos[2] + f[2] * 26];
  }

  const speedNorm = clamp(S.speed / 82, 0, 1);
  const fov = (62 + speedNorm * 8) * (Math.PI / 180);
  currentProj = mat4Perspective(fov, aspect, 0.5, 4200);
  currentView = mat4LookAt(S.camPos, camTarget, [0, 1, 0]);

  renderer.time = gt;
  renderer.begin(currentProj, currentView, S.camPos);
  renderer.drawSky();
  renderer.draw(oceanMesh, mat4Identity(), { waveAmp: 1.0, sunAmount: 0.85 });
  renderer.draw(terrainMesh, mat4Identity(), {});

  // lighthouse lamp
  const lampPulse = 0.85 + 0.45 * Math.sin(gt * 2.2);
  renderer.draw(
    lampMesh,
    mat4Compose(lighthouseTop[0], lighthouseTop[1], lighthouseTop[2], 0, 0, 0, 1, 1, 1),
    { emissive: lampPulse },
  );

  // clouds
  for (const cloud of cloudList) {
    renderer.draw(cloud.mesh, mat4Compose(cloud.pos[0], cloud.pos[1], cloud.pos[2], 0, cloud.rot, 0, cloud.scale, 1, cloud.scale), {
      alpha: 0.82,
      emissive: 0.1,
    });
  }

  // rings
  for (let i = 0; i < RING_COUNT; i++) {
    const ring = rings[i];
    const zAxis = ring.normal;
    let xAxis = norm3([zAxis[2], 0, -zAxis[0]]);
    if (Math.hypot(xAxis[0], xAxis[2]) < 0.01) xAxis = [1, 0, 0];
    const yAxis = norm3([
      zAxis[1] * xAxis[2] - zAxis[2] * xAxis[1],
      zAxis[2] * xAxis[0] - zAxis[0] * xAxis[2],
      zAxis[0] * xAxis[1] - zAxis[1] * xAxis[0],
    ]);
    const m = mat4FromBasis(ring.pos, xAxis, yAxis, zAxis);
    if (ring.state === "next") {
      const s = 1 + 0.045 * Math.sin(gt * 4.2);
      const scaled = mat4Multiply(m, mat4Compose(0, 0, 0, 0, 0, 0, s, s, s));
      renderer.draw(ringMeshes.next, scaled, { emissive: 0.55 + 0.25 * Math.sin(gt * 4.2) });
    } else if (ring.state === "done") {
      renderer.draw(ringMeshes.done, m, { emissive: 0.06, alpha: 0.55 });
    } else {
      renderer.draw(ringMeshes.todo, m, { emissive: 0.14 });
    }
  }

  // beacon over the next ring
  if (S.mode === "flying" || S.mode === "countdown" || S.mode === "photo") {
    const ring = rings[S.targetRing];
    renderer.draw(
      beaconMesh,
      mat4Compose(ring.pos[0], ring.pos[1] + 130, ring.pos[2], 0, 0, 0, 1, 1, 1),
      { emissive: 0.7, alpha: 0.07 + 0.035 * Math.sin(gt * 3) },
    );
  }

  // plane + propeller
  const pm = planeMatrix();
  renderer.draw(planeMesh, pm, {});
  S.propAngle += dt * (5 + S.speed * 1.1);
  const propM = mat4Multiply(pm, mat4Compose(0, 0, -3.66, 0, 0, S.propAngle, 1, 1, 1));
  renderer.draw(propMesh, propM, {});

  // particles
  const count = particles.fillRenderData();
  renderer.drawParticles(particles.renderData, count);
}

// ------------------------------------------------------------------ loop ---

let lastNow = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.05, (now - lastNow) / 1000);
  lastNow = now;
  if (S.mode === "paused") dt = 0;
  if (dt > 0) {
    S.gt += dt;
    if (S.mode === "countdown") {
      S.countT -= dt;
      const c = Math.ceil(S.countT);
      if (c !== S.lastCount && c > 0) {
        S.lastCount = c;
        showBanner(String(c), 800);
        sound.countBeep(false);
      }
      if (S.countT <= 0) {
        S.mode = "flying";
        showBanner("出发！", 800);
        sound.countBeep(true);
      }
      S.speed = lerp(S.speed, 30, damp(1.5, dt));
      const f = forwardVec(S.yaw, S.pitch);
      S.pos[0] += f[0] * S.speed * dt;
      S.pos[1] += f[1] * S.speed * dt;
      S.pos[2] += f[2] * S.speed * dt;
    } else if (S.mode === "flying") {
      stepFlying(dt);
    } else if (S.mode === "crashed") {
      S.crashT -= dt;
      S.speed = lerp(S.speed, 0, damp(4, dt));
      if (S.crashT <= 0) respawn();
    } else if (S.mode === "finished") {
      S.speed = lerp(S.speed, 34, damp(0.8, dt));
      const f = forwardVec(S.yaw, S.pitch);
      S.pos[0] += f[0] * S.speed * dt;
      S.pos[1] += f[1] * S.speed * dt;
      S.pos[2] += f[2] * S.speed * dt;
    }
    for (const cloud of cloudList) {
      cloud.pos[0] += cloud.drift * dt;
      if (cloud.pos[0] > 1600) cloud.pos[0] = -1600;
    }
    particles.update(dt);
    if (S.mode === "flying" || S.mode === "countdown") {
      sound.setEngine(clamp(S.speed / 82, 0, 1.2), true);
    }
    updateHud();
  }
  render(dt);
  updateNav();
}

// -------------------------------------------------- screenshot staging ---
// The staged views behind shots.json, posed with the same state the game
// itself runs on: ?shot=play hovers mid-course with the next ring ahead,
// ?shot=end shows the finish screen over a cruising plane. A normal visit
// (no ?shot= parameter) never runs this.

function stageShot() {
  if (shotMode === "play") {
    resetRun();
    for (let i = 0; i < 3; i++) rings[i].state = "done";
    rings[3].state = "next";
    S.targetRing = 3;
    S.passed = 3;
    S.score = 340;
    S.combo = 3;
    S.bestCombo = 3;
    S.elapsed = 38;
    S.segTime = 5;
    S.fuel = 82;
    const a = rings[2].pos;
    const b = rings[3].pos;
    const dir = norm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const side = norm3([dir[2], 0, -dir[0]]);
    const t = 0.66;
    S.pos = [
      a[0] + (b[0] - a[0]) * t + side[0] * 9,
      a[1] + (b[1] - a[1]) * t + 3,
      a[2] + (b[2] - a[2]) * t + side[2] * 9,
    ];
    const yp = yawPitchFromDir(dir);
    S.yaw = yp.yaw;
    S.pitch = yp.pitch;
    S.roll = 0.38;
    S.speed = 58;
    S.camPos = [
      S.pos[0] - dir[0] * 13.5,
      S.pos[1] - dir[1] * 13.5 + 5,
      S.pos[2] - dir[2] * 13.5,
    ];
    S.mode = "photo"; // renders and chases like flying, but holds position
    setScreen("flying");
    updateHud();
  } else if (shotMode === "end") {
    resetRun();
    for (const ring of rings) ring.state = "done";
    S.passed = RING_COUNT;
    S.score = 2480;
    S.timeBonus = 310;
    S.elapsed = 231;
    S.bestCombo = 7;
    S.crashes = 1;
    S.fuel = 23;
    const dir = norm3([-140, -12, -560]);
    S.pos = [150, 96, 300];
    const yp = yawPitchFromDir(dir);
    S.yaw = yp.yaw;
    S.pitch = yp.pitch;
    S.speed = 34;
    S.camPos = [
      S.pos[0] - dir[0] * 13.5,
      S.pos[1] - dir[1] * 13.5 + 5,
      S.pos[2] - dir[2] * 13.5,
    ];
    S.mode = "finished"; // cruises on under the finish screen
    showFinish();
  }
}

// ------------------------------------------------------------------ boot ---

function init() {
  renderer = new Renderer(canvas);
  const gl = renderer.gl;
  const terrain = buildTerrainGeometry();
  terrainMesh = new Mesh(gl, terrain.batch);
  lighthouseTop = terrain.lighthouseTop;
  oceanMesh = new Mesh(gl, buildOceanGeometry());
  planeMesh = new Mesh(gl, buildPlaneGeometry());
  propMesh = new Mesh(gl, buildPropGeometry());
  lampMesh = new Mesh(gl, sphereGeometry(1.5, 8, 6, [1.0, 0.85, 0.45]));
  beaconMesh = new Mesh(gl, cylinderGeometry(2.6, 2.6, 340, 10, COL.ringGold));
  ringMeshes = {
    next: new Mesh(gl, torusGeometry(RING_RADIUS, 1.5, 10, 30, COL.ringNext)),
    todo: new Mesh(gl, torusGeometry(RING_RADIUS, 1.5, 10, 30, COL.ringTodo)),
    done: new Mesh(gl, torusGeometry(RING_RADIUS, 1.5, 10, 30, COL.ringDone)),
  };
  const cloudRng = mulberry32(COURSE_SEED + 7);
  for (let i = 0; i < 14; i++) {
    const ang = cloudRng() * Math.PI * 2;
    const rad = 380 + cloudRng() * 980;
    cloudList.push({
      mesh: new Mesh(gl, buildCloudGeometry(cloudRng)),
      pos: [Math.cos(ang) * rad, 148 + cloudRng() * 95, Math.sin(ang) * rad],
      drift: 1.6 + cloudRng() * 2.4,
      rot: cloudRng() * Math.PI,
      scale: 0.9 + cloudRng() * 1.5,
    });
  }
  setScreen("menu");
  refreshMenuBest();
  updateHud();
  stageShot();
  requestAnimationFrame(frame);
}

try {
  init();
} catch (err) {
  menuBestEl.textContent = `启动失败：${err.message}（请换用支持 WebGL 的现代浏览器）`;
  throw err;
}
