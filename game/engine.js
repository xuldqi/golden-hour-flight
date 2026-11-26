/**
 * engine.js — a tiny hand-rolled WebGL engine for Golden Hour Flight.
 *
 * No dependencies. Provides:
 *  - minimal mat4 / vec3 math
 *  - flat-shaded primitive builders (box, cone, cylinder, torus, sphere)
 *  - a GeometryBatch that bakes many transformed primitives into one mesh
 *  - three shader programs: lit meshes (with fog), the sky dome, and
 *    soft round particles (gl.POINTS)
 */

// ---------------------------------------------------------------- math ---

export function mat4Identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

export function mat4Perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function mat4LookAt(eye, target, up) {
  const z = norm3(sub3(eye, target));
  const x = norm3(cross3(up, z));
  const y = cross3(z, x);
  const out = new Float32Array(16);
  out[0] = x[0]; out[1] = y[0]; out[2] = z[0];
  out[4] = x[1]; out[5] = y[1]; out[6] = z[1];
  out[8] = x[2]; out[9] = y[2]; out[10] = z[2];
  out[12] = -dot3(x, eye);
  out[13] = -dot3(y, eye);
  out[14] = -dot3(z, eye);
  out[15] = 1;
  return out;
}

/** Compose a model matrix from translation, Euler rotation (XYZ, radians) and scale. */
export function mat4Compose(px, py, pz, rx, ry, rz, sx, sy, sz) {
  const cx = Math.cos(rx), sxn = Math.sin(rx);
  const cy = Math.cos(ry), syn = Math.sin(ry);
  const cz = Math.cos(rz), szn = Math.sin(rz);
  // R = Rz * Ry * Rx applied to column vectors, stored column-major.
  const r00 = cz * cy, r01 = cz * syn * sxn - szn * cx, r02 = cz * syn * cx + szn * sxn;
  const r10 = szn * cy, r11 = szn * syn * sxn + cz * cx, r12 = szn * syn * cx - cz * sxn;
  const r20 = -syn, r21 = cy * sxn, r22 = cy * cx;
  const out = new Float32Array(16);
  out[0] = r00 * sx; out[1] = r10 * sx; out[2] = r20 * sx;
  out[4] = r01 * sy; out[5] = r11 * sy; out[6] = r21 * sy;
  out[8] = r02 * sz; out[9] = r12 * sz; out[10] = r22 * sz;
  out[12] = px; out[13] = py; out[14] = pz; out[15] = 1;
  return out;
}

/** Inverse-transpose of the upper 3x3, for correct normals under any scale. */
export function mat3NormalFromMat4(m) {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const inv = det === 0 ? 0 : 1 / det;
  // inverse, then transposed on write
  return new Float32Array([
    (e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    (f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    (d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ]);
}

export function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function norm3(a) {
  const len = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}
export function transformPoint(m, p) {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// ------------------------------------------------------- geometry data ---

/** A raw geometry: flat arrays, non-indexed triangles, flat shading. */
export class Geometry {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.colors = [];
  }
  get vertexCount() {
    return this.positions.length / 3;
  }
  /** Push one triangle with an explicit face normal. */
  tri(a, b, c, color) {
    const n = norm3(cross3(sub3(b, a), sub3(c, a)));
    for (const p of [a, b, c]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n[0], n[1], n[2]);
      this.colors.push(color[0], color[1], color[2]);
    }
  }
  /** Push a quad as two triangles (a-b-c, a-c-d, counter-clockwise). */
  quad(a, b, c, d, color) {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }
  /** Append another geometry transformed by a model matrix. */
  append(other, matrix) {
    const nm = mat3NormalFromMat4(matrix);
    const vc = other.vertexCount;
    for (let i = 0; i < vc; i++) {
      const p = transformPoint(matrix, [
        other.positions[i * 3], other.positions[i * 3 + 1], other.positions[i * 3 + 2],
      ]);
      this.positions.push(p[0], p[1], p[2]);
      const nx = other.normals[i * 3], ny = other.normals[i * 3 + 1], nz = other.normals[i * 3 + 2];
      const n = norm3([
        nm[0] * nx + nm[3] * ny + nm[6] * nz,
        nm[1] * nx + nm[4] * ny + nm[7] * nz,
        nm[2] * nx + nm[5] * ny + nm[8] * nz,
      ]);
      this.normals.push(n[0], n[1], n[2]);
      this.colors.push(other.colors[i * 3], other.colors[i * 3 + 1], other.colors[i * 3 + 2]);
    }
  }
}

export function boxGeometry(w, h, d, color) {
  const g = new Geometry();
  const x = w / 2, y = h / 2, z = d / 2;
  g.quad([-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], color);       // front
  g.quad([x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z], color); // back
  g.quad([x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z], color);     // right
  g.quad([-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z], color); // left
  g.quad([-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z], color);     // top
  g.quad([-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], color); // bottom
  return g;
}

export function coneGeometry(radius, height, segments, color) {
  const g = new Geometry();
  const apex = [0, height / 2, 0];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0 = [Math.cos(a0) * radius, -height / 2, Math.sin(a0) * radius];
    const p1 = [Math.cos(a1) * radius, -height / 2, Math.sin(a1) * radius];
    g.tri(p0, apex, p1, color);
    g.tri([0, -height / 2, 0], p0, p1, color); // base cap
  }
  return g;
}

export function cylinderGeometry(rTop, rBottom, height, segments, color) {
  const g = new Geometry();
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const b0 = [c0 * rBottom, -height / 2, s0 * rBottom];
    const b1 = [c1 * rBottom, -height / 2, s1 * rBottom];
    const t0 = [c0 * rTop, height / 2, s0 * rTop];
    const t1 = [c1 * rTop, height / 2, s1 * rTop];
    g.quad(b1, b0, t0, t1, color);
    g.tri([0, height / 2, 0], t1, t0, color);   // top cap
    g.tri([0, -height / 2, 0], b0, b1, color);  // bottom cap
  }
  return g;
}

export function sphereGeometry(radius, widthSegs, heightSegs, color) {
  const g = new Geometry();
  for (let iy = 0; iy < heightSegs; iy++) {
    const v0 = iy / heightSegs, v1 = (iy + 1) / heightSegs;
    const th0 = v0 * Math.PI, th1 = v1 * Math.PI;
    for (let ix = 0; ix < widthSegs; ix++) {
      const u0 = ix / widthSegs, u1 = (ix + 1) / widthSegs;
      const ph0 = u0 * Math.PI * 2, ph1 = u1 * Math.PI * 2;
      const pt = (th, ph) => [
        radius * Math.sin(th) * Math.cos(ph),
        radius * Math.cos(th),
        radius * Math.sin(th) * Math.sin(ph),
      ];
      const a = pt(th0, ph0), b = pt(th0, ph1), c = pt(th1, ph1), d = pt(th1, ph0);
      if (iy > 0) g.tri(a, b, c, color);
      if (iy < heightSegs - 1) g.tri(a, c, d, color);
    }
  }
  return g;
}

export function torusGeometry(radius, tube, radialSegs, tubularSegs, color) {
  const g = new Geometry();
  const pt = (u, v) => {
    const cu = Math.cos(u), su = Math.sin(u);
    const cv = Math.cos(v), sv = Math.sin(v);
    return [
      (radius + tube * cv) * cu,
      tube * sv,
      (radius + tube * cv) * su,
    ];
  };
  for (let i = 0; i < tubularSegs; i++) {
    const u0 = (i / tubularSegs) * Math.PI * 2;
    const u1 = ((i + 1) / tubularSegs) * Math.PI * 2;
    for (let j = 0; j < radialSegs; j++) {
      const v0 = (j / radialSegs) * Math.PI * 2;
      const v1 = ((j + 1) / radialSegs) * Math.PI * 2;
      g.quad(pt(u0, v0), pt(u0, v1), pt(u1, v1), pt(u1, v0), color);
    }
  }
  return g;
}

// ------------------------------------------------------------ renderer ---

const LIT_VERT = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec3 aColor;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormalMat;
uniform float uTime;
uniform float uWaveAmp;
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorldPos;
void main() {
  vec3 pos = aPosition;
  vec3 nrm = aNormal;
  if (uWaveAmp > 0.0) {
    float w1 = sin(pos.x * 0.055 + uTime * 1.15) * cos(pos.z * 0.047 + uTime * 0.9);
    float w2 = sin(pos.x * 0.013 - uTime * 0.55) * cos(pos.z * 0.017 + uTime * 0.7);
    pos.y += (w1 * 0.65 + w2 * 0.9) * uWaveAmp;
    float dx = (0.055 * cos(pos.x * 0.055 + uTime * 1.15) * cos(pos.z * 0.047 + uTime * 0.9) * 0.65
              + 0.013 * cos(pos.x * 0.013 - uTime * 0.55) * cos(pos.z * 0.017 + uTime * 0.7) * 0.9) * uWaveAmp;
    float dz = (-0.047 * sin(pos.x * 0.055 + uTime * 1.15) * sin(pos.z * 0.047 + uTime * 0.9) * 0.65
              - 0.017 * sin(pos.x * 0.013 - uTime * 0.55) * sin(pos.z * 0.017 + uTime * 0.7) * 0.9) * uWaveAmp;
    nrm = normalize(vec3(-dx, 1.0, -dz));
  }
  vec4 world = uModel * vec4(pos, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(uNormalMat * nrm);
  vColor = aColor;
  gl_Position = uProj * uView * world;
}`;

const LIT_FRAG = `
precision mediump float;
uniform vec3 uLightDir;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uEmissive;
uniform float uAlpha;
uniform float uSunAmount;
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorldPos;
void main() {
  vec3 n = normalize(vNormal);
  float diff = max(dot(n, uLightDir), 0.0);
  vec3 col = vColor * (0.38 + 0.75 * diff);
  if (uSunAmount > 0.0) {
    vec3 viewDir = normalize(uCamPos - vWorldPos);
    vec3 hv = normalize(viewDir + uLightDir);
    float spec = pow(max(dot(n, hv), 0.0), 90.0);
    col += vec3(1.0, 0.75, 0.45) * spec * uSunAmount;
  }
  col += vColor * uEmissive;
  float dist = length(uCamPos - vWorldPos);
  float fog = smoothstep(uFogNear, uFogFar, dist);
  col = mix(col, uFogColor, fog);
  gl_FragColor = vec4(col, uAlpha);
}`;

const SKY_VERT = `
attribute vec3 aPosition;
uniform mat4 uProj;
uniform mat4 uView;
varying vec3 vDir;
void main() {
  vDir = aPosition;
  vec4 pos = uProj * uView * vec4(aPosition, 1.0);
  gl_Position = pos.xyww;
}`;

const SKY_FRAG = `
precision mediump float;
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);
  vec3 zenith = vec3(0.16, 0.32, 0.58);
  vec3 mid = vec3(0.98, 0.55, 0.32);
  vec3 low = vec3(1.0, 0.72, 0.42);
  vec3 col = mix(low, mid, smoothstep(-0.02, 0.22, h));
  col = mix(col, zenith, smoothstep(0.12, 0.65, h));
  if (h < 0.0) col = mix(low, vec3(0.13, 0.28, 0.45), smoothstep(0.0, -0.4, h));
  float sunD = max(dot(d, uSunDir), 0.0);
  col += vec3(1.0, 0.62, 0.28) * pow(sunD, 18.0) * 0.55;
  col += vec3(1.0, 0.8, 0.5) * pow(sunD, 220.0) * 1.4;
  col += vec3(1.0, 0.95, 0.85) * smoothstep(0.9993, 0.9997, sunD) * 2.2;
  gl_FragColor = vec4(col, 1.0);
}`;

const PARTICLE_VERT = `
attribute vec3 aPosition;
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
uniform mat4 uProj;
uniform mat4 uView;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = uView * vec4(aPosition, 1.0);
  gl_Position = uProj * mv;
  float dist = max(1.0, -mv.z);
  gl_PointSize = aSize * 320.0 / dist;
  vColor = aColor;
  vAlpha = aAlpha;
}`;

const PARTICLE_FRAG = `
precision mediump float;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  float a = smoothstep(0.5, 0.05, d) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
}`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function makeProgram(gl, vertSource, fragSource) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

export class Mesh {
  constructor(gl, geometry) {
    this.gl = gl;
    this.count = geometry.vertexCount;
    this.posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geometry.positions), gl.STATIC_DRAW);
    this.nrmBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nrmBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geometry.normals), gl.STATIC_DRAW);
    this.colBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geometry.colors), gl.STATIC_DRAW);
  }
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL is not available in this browser.");
    this.gl = gl;
    this.canvas = canvas;
    this.lit = makeProgram(gl, LIT_VERT, LIT_FRAG);
    this.sky = makeProgram(gl, SKY_VERT, SKY_FRAG);
    this.particles = makeProgram(gl, PARTICLE_VERT, PARTICLE_FRAG);
    this.lightDir = norm3([-0.55, 0.38, -0.74]); // toward the low sun
    this.fogColor = [0.99, 0.62, 0.38];
    this.fogNear = 260;
    this.fogFar = 1500;
    this.time = 0;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(this.fogColor[0], this.fogColor[1], this.fogColor[2], 1);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
    return w / h;
  }

  begin(proj, view, camPos) {
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.proj = proj;
    this.view = view;
    this.camPos = camPos;
  }

  drawSky() {
    const gl = this.gl;
    gl.useProgram(this.sky);
    gl.depthMask(false);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.sky, "uProj"), false, this.proj);
    // Sky follows the camera: strip translation from the view matrix.
    const v = new Float32Array(this.view);
    v[12] = 0; v[13] = 0; v[14] = 0;
    gl.uniformMatrix4fv(gl.getUniformLocation(this.sky, "uView"), false, v);
    gl.uniform3fv(gl.getUniformLocation(this.sky, "uSunDir"), this.lightDir);
    if (!this.skyMesh) {
      this.skyMesh = new Mesh(gl, sphereGeometry(1, 24, 16, [1, 1, 1]));
    }
    this.bindMesh(this.sky, this.skyMesh, false);
    gl.drawArrays(gl.TRIANGLES, 0, this.skyMesh.count);
    gl.depthMask(true);
  }

  bindMesh(program, mesh, withNormal) {
    const gl = this.gl;
    const posLoc = gl.getAttribLocation(program, "aPosition");
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuf);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
    if (withNormal) {
      const nLoc = gl.getAttribLocation(program, "aNormal");
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nrmBuf);
      gl.enableVertexAttribArray(nLoc);
      gl.vertexAttribPointer(nLoc, 3, gl.FLOAT, false, 0, 0);
      const cLoc = gl.getAttribLocation(program, "aColor");
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.colBuf);
      gl.enableVertexAttribArray(cLoc);
      gl.vertexAttribPointer(cLoc, 3, gl.FLOAT, false, 0, 0);
    }
  }

  /**
   * Draw a lit mesh.
   * opts: { emissive, alpha, waveAmp, sunAmount }
   */
  draw(mesh, model, opts = {}) {
    const gl = this.gl;
    const p = this.lit;
    gl.useProgram(p);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, "uProj"), false, this.proj);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, "uView"), false, this.view);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, "uModel"), false, model);
    gl.uniformMatrix3fv(gl.getUniformLocation(p, "uNormalMat"), false, mat3NormalFromMat4(model));
    gl.uniform3fv(gl.getUniformLocation(p, "uLightDir"), this.lightDir);
    gl.uniform3fv(gl.getUniformLocation(p, "uCamPos"), this.camPos);
    gl.uniform3fv(gl.getUniformLocation(p, "uFogColor"), this.fogColor);
    gl.uniform1f(gl.getUniformLocation(p, "uFogNear"), this.fogNear);
    gl.uniform1f(gl.getUniformLocation(p, "uFogFar"), this.fogFar);
    gl.uniform1f(gl.getUniformLocation(p, "uTime"), this.time);
    gl.uniform1f(gl.getUniformLocation(p, "uEmissive"), opts.emissive || 0);
    gl.uniform1f(gl.getUniformLocation(p, "uSunAmount"), opts.sunAmount || 0);
    gl.uniform1f(gl.getUniformLocation(p, "uWaveAmp"), opts.waveAmp || 0);
    const alpha = opts.alpha === undefined ? 1 : opts.alpha;
    gl.uniform1f(gl.getUniformLocation(p, "uAlpha"), alpha);
    if (alpha < 1) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
    }
    this.bindMesh(p, mesh, true);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    if (alpha < 1) {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }
  }

  /** Draw a particle cloud. items: Float32Array of [x,y,z, r,g,b, size, alpha] * n */
  drawParticles(items, count) {
    if (count <= 0) return;
    const gl = this.gl;
    const p = this.particles;
    gl.useProgram(p);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    if (!this.particleBuf) this.particleBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuf);
    gl.bufferData(gl.ARRAY_BUFFER, items.subarray(0, count * 8), gl.DYNAMIC_DRAW);
    const stride = 8 * 4;
    const bind = (name, size, offset) => {
      const loc = gl.getAttribLocation(p, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
    };
    bind("aPosition", 3, 0);
    bind("aColor", 3, 3);
    bind("aSize", 1, 6);
    bind("aAlpha", 1, 7);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, "uProj"), false, this.proj);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, "uView"), false, this.view);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}
