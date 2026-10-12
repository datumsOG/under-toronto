// mapkit/packed.js: a MapLibre custom layer that draws packed lines and points in 3D,
// including BELOW the ground. The data is the 8-byte vertex the build step writes:
//   u16 x, u16 y   position inside a bounding box, in Web Mercator
//   u16 value      depth in decimetres, or a year
//   u8  kind       index into a small palette
//   u8  flags      bit 0 trunk/emphasis, bit 1 measured, bit 2 large
// Nothing here animates. The layer draws only when the map draws, so a still map is idle.
//
// Precision: the box-to-clip matrix is composed in 64-bit in JavaScript and handed to the
// shader whole. Doing "position + box origin" in the shader's 32-bit floats would wobble by
// about a metre at street zoom.

const VERT = `
attribute vec2 a_xy;
attribute float a_val;
attribute float a_kind;
attribute float a_flags;
uniform mat4 u_m;          // box (0..1, 0..1, metres down) -> clip
uniform float u_mode;      // 0: value is depth (dm)   1: value is a year, fixed depth   2: points, value is a year
uniform float u_depth;     // fixed depth in metres (modes 1, 2)
uniform float u_exag;
uniform float u_alpha;
uniform float u_size;
uniform vec2 u_years;      // year range for the ramp
uniform vec3 u_pal[5];
uniform vec3 u_old; uniform vec3 u_new;
varying vec4 v_col;
void main() {
  float depth = u_mode < 0.5 ? a_val * 0.1 : u_depth;
  gl_Position = u_m * vec4(a_xy, -depth * u_exag, 1.0);
  gl_PointSize = u_size;
  float big = mod(floor(a_flags / 4.0), 2.0), strong = mod(a_flags, 2.0);
  vec3 c; float a = u_alpha;
  if (u_mode < 0.5) {
    int k = int(a_kind + 0.5);
    c = k == 0 ? u_pal[0] : k == 1 ? u_pal[1] : k == 2 ? u_pal[2] : k == 3 ? u_pal[3] : u_pal[4];
    a *= 1.0 + 1.6 * max(big, strong);
  } else {
    float t = a_val < 1.0 ? 0.6 : clamp((a_val - u_years.x) / (u_years.y - u_years.x), 0.0, 1.0);
    c = mix(u_old, u_new, t);
    a *= (a_val < 1.0 ? 0.35 : 1.0 + 1.4 * (1.0 - t)) * (1.0 + 0.8 * big);
  }
  v_col = vec4(c * a, a);
}`;
const FRAG = `
precision mediump float;
uniform float u_round;
varying vec4 v_col;
void main() {
  if (u_round > 0.5) { vec2 d = gl_PointCoord - 0.5; float r = dot(d, d); if (r > 0.25) discard; gl_FragColor = v_col * (1.0 - r * 3.0); }
  else gl_FragColor = v_col;
}`;

export class PackedLayer {
  constructor({ id, box, metresPerUnit }) {
    this.id = id; this.type = 'custom'; this.renderingMode = '3d';
    this.box = box;                      // [x0, y0, x1, y1] in mercator
    this.mpu = metresPerUnit;            // mercator units per metre, at the city's latitude
    this.sets = [];                      // { name, data, mode, primitive, on, ... }
    this.exag = 8;
    this.palette = [[0.24, 0.55, 1.0], [0.62, 0.42, 1.0], [1.0, 0.28, 0.72], [0.6, 0.6, 0.65], [1.0, 1.0, 1.0]];
  }
  add(set) { this.sets.push({ on: true, alpha: 1, size: 3, depth: 0, mode: 0, years: [1870, 2025], oldC: [1, 0.95, 0.55], newC: [0, 0.72, 0.6], round: 0, ...set }); if (this.gl) this._upload(this.sets[this.sets.length - 1]); if (this.map) this.map.triggerRepaint(); }
  set(name, on) { const s = this.sets.find((x) => x.name === name); if (s) { s.on = on; if (this.map) this.map.triggerRepaint(); } }
  _upload(s) {
    const gl = this.gl;
    s.buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, s.buf);
    gl.bufferData(gl.ARRAY_BUFFER, s.data, gl.STATIC_DRAW);
    s.count = s.data.byteLength / 8; s.data = null;
  }
  onAdd(map, gl) {
    this.map = map; this.gl = gl;
    const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = this.prog = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.A = {}; for (const n of ['a_xy', 'a_val', 'a_kind', 'a_flags']) this.A[n] = gl.getAttribLocation(p, n);
    this.U = {}; for (const n of ['u_m', 'u_mode', 'u_depth', 'u_exag', 'u_alpha', 'u_size', 'u_years', 'u_pal', 'u_old', 'u_new', 'u_round']) this.U[n] = gl.getUniformLocation(p, n);
    for (const s of this.sets) if (s.data) this._upload(s);
  }
  render(gl, matrix) {
    const m = matrix, [x0, y0, x1, y1] = this.box, sx = x1 - x0, sy = y1 - y0, sz = this.mpu;
    // matrix * translate(x0, y0, 0) * scale(sx, sy, sz), in doubles
    const o = new Float32Array(16);
    for (let r = 0; r < 4; r++) {
      o[r] = m[r] * sx; o[4 + r] = m[4 + r] * sy; o[8 + r] = m[8 + r] * sz;
      o[12 + r] = m[r] * x0 + m[4 + r] * y0 + m[12 + r];
    }
    const A = this.A, U = this.U;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(U.u_m, false, o);
    gl.uniform1f(U.u_exag, this.exag);
    gl.uniform3fv(U.u_pal, new Float32Array(this.palette.flat()));
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);       // light adds up where pipes cross
    const zoom = this.map.getZoom(), dpr = gl.drawingBufferWidth / (gl.canvas.clientWidth || 1);
    for (const s of this.sets) {
      if (!s.on || !s.buf || !s.count) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, s.buf);
      gl.enableVertexAttribArray(A.a_xy); gl.vertexAttribPointer(A.a_xy, 2, gl.UNSIGNED_SHORT, true, 8, 0);
      gl.enableVertexAttribArray(A.a_val); gl.vertexAttribPointer(A.a_val, 1, gl.UNSIGNED_SHORT, false, 8, 4);
      gl.enableVertexAttribArray(A.a_kind); gl.vertexAttribPointer(A.a_kind, 1, gl.UNSIGNED_BYTE, false, 8, 6);
      gl.enableVertexAttribArray(A.a_flags); gl.vertexAttribPointer(A.a_flags, 1, gl.UNSIGNED_BYTE, false, 8, 7);
      // Dense at city scale, so it is dimmed there and brought up as the camera closes in.
      const k = Math.max(0, Math.min(1, (zoom - 11) / 4.5));
      gl.uniform1f(U.u_alpha, s.alpha * (0.16 + 0.84 * k * k));
      gl.uniform1f(U.u_mode, s.mode); gl.uniform1f(U.u_depth, s.depth);
      gl.uniform1f(U.u_size, s.size * dpr * (0.6 + 1.2 * k)); gl.uniform1f(U.u_round, s.primitive === 'points' ? 1 : 0);
      gl.uniform2f(U.u_years, s.years[0], s.years[1]);
      gl.uniform3fv(U.u_old, s.oldC); gl.uniform3fv(U.u_new, s.newC);
      gl.drawArrays(s.primitive === 'points' ? gl.POINTS : gl.LINES, 0, s.count);
    }
    gl.depthMask(true);
  }
}
