// mapkit/packed.js: a MapLibre custom layer that draws packed lines and points in 3D,
// including BELOW the ground. The data is the 8-byte vertex the build step writes:
//   u16 x, u16 y   position inside a bounding box, in Web Mercator
//   u16 value      depth in decimetres, or a year
//   u8  kind       index into a small palette
//   u8  flags      bit 0 trunk/emphasis, bit 1 measured, bit 2 large
// Lines are ribbons, not hairlines: each segment is one instanced quad whose width is a real
// width on the ground (metres), so it thickens as the camera closes in and with perspective,
// never thinner than about a pixel, with a soft halo of its own light around it.
// Nothing here animates. The layer draws only when the map draws, so a still map is idle.
//
// Precision: the box-to-clip matrix is composed in 64-bit in JavaScript and handed to the
// shader whole. Doing "position + box origin" in the shader's 32-bit floats would wobble by
// about a metre at street zoom.

const COLOUR = `
uniform float u_mode;      // 0: value is depth (dm)   1: value is a year, fixed depth   2: points, value is a year
uniform float u_alpha;
uniform vec2 u_years;      // year range for the ramp
uniform vec3 u_pal[5];
uniform vec3 u_old; uniform vec3 u_new;
vec4 colour(float val, float kind, float flags) {
  float big = mod(floor(flags / 4.0), 2.0), strong = mod(flags, 2.0);
  vec3 c; float a = u_alpha;
  if (u_mode < 0.5) {
    int k = int(kind + 0.5);
    c = k == 0 ? u_pal[0] : k == 1 ? u_pal[1] : k == 2 ? u_pal[2] : k == 3 ? u_pal[3] : u_pal[4];
    a *= 1.0 + 0.7 * max(big, strong);
  } else {
    float t = val < 1.0 ? 0.6 : clamp((val - u_years.x) / (u_years.y - u_years.x), 0.0, 1.0);
    c = mix(u_old, u_new, t);
    a *= (val < 1.0 ? 0.35 : 1.0 + 1.4 * (1.0 - t)) * (1.0 + 0.4 * big);
  }
  return vec4(c * a, a);
}`;
// A ribbon: the four corners of one quad per segment (instanced). a_c = (0 or 1 along the
// segment, -1 or +1 across it). The two ends are projected, then the corner is pushed
// sideways on the screen by half the ribbon's width in pixels.
const LINE_VERT = `
attribute vec2 a_c;
attribute vec2 a_xy0; attribute float a_val0; attribute float a_kind; attribute float a_flags;
attribute vec2 a_xy1; attribute float a_val1;
uniform mat4 u_m;          // box (0..1, 0..1, metres down) -> clip
uniform float u_depth;     // fixed depth in metres (mode 1)
uniform float u_exag;
uniform vec2 u_view;       // drawing buffer, px
uniform float u_wpx;       // the ribbon's width in px where the camera is looking
uniform float u_c2c;       // clip w where the camera is looking: width scales by u_c2c / w
uniform float u_minpx;
uniform float u_far;       // 0 at street zoom, 1 with the whole city in view
uniform float u_halo;      // halo reach, in ribbon widths
${COLOUR}
varying vec4 v_col;
varying vec3 v_edge;       // px from the centre line, half the core width in px, the halo's reach in px
void main() {
  float d0 = u_mode < 0.5 ? a_val0 * 0.1 : u_depth, d1 = u_mode < 0.5 ? a_val1 * 0.1 : u_depth;
  vec4 p0 = u_m * vec4(a_xy0, -d0 * u_exag, 1.0), p1 = u_m * vec4(a_xy1, -d1 * u_exag, 1.0);
  float near = u_c2c * 0.02;
  if (p0.w < near && p1.w < near) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (p0.w < near) p0 = mix(p0, p1, (near - p0.w) / (p1.w - p0.w));
  if (p1.w < near) p1 = mix(p1, p0, (near - p1.w) / (p0.w - p1.w));
  vec2 s0 = p0.xy / p0.w * u_view * 0.5, s1 = p1.xy / p1.w * u_view * 0.5, dir = s1 - s0;
  float len = length(dir);
  vec2 nrm = len > 1e-4 ? vec2(-dir.y, dir.x) / len : vec2(1.0, 0.0);
  vec4 p = mix(p0, p1, a_c.x);
  float big = mod(floor(a_flags / 4.0), 2.0), strong = mod(a_flags, 2.0);
  float trunk = max(big, strong);
  float w = u_wpx * (u_c2c / p.w) * (1.0 + 1.2 * trunk);
  // Far out a real width is a small fraction of a pixel. Dimming by that fraction made the
  // whole network vanish, so the floor works like a road map's: the width a line is held
  // at grows as the camera pulls back, more for trunks than for local pipes, and the dimming
  // follows the square root of the shortfall and stops at a level that can still be seen.
  float minpx = u_minpx * (1.0 + u_far * (0.25 + 0.85 * trunk));
  float fade = max(sqrt(min(1.0, w / minpx)), u_far * (0.16 + 0.44 * trunk));
  // The halo grows in as the ribbon gets wider than the floor. Far away, where the whole city
  // is hairlines, there is none: it would be millions of pixels of overdraw for no light.
  float halo = mix(1.0, u_halo, clamp((w / minpx - 1.0) * 0.5, 0.0, 1.0));
  w = max(w, minpx);
  float reach = w * 0.5 * halo + 1.0;
  p.xy += nrm * a_c.y * reach / (u_view * 0.5) * p.w;
  gl_Position = p;
  v_edge = vec3(a_c.y * reach, w * 0.5, reach);
  v_col = colour(a_val0, a_kind, a_flags) * fade;
}`;
const LINE_FRAG = `
precision mediump float;
varying vec4 v_col;
varying vec3 v_edge;
void main() {
  float d = abs(v_edge.x), h = v_edge.y;
  float core = clamp(h + 0.5 - d, 0.0, 1.0);
  float g = clamp(1.0 - d / v_edge.z, 0.0, 1.0);
  gl_FragColor = v_col * (core + 0.45 * g * g * (1.0 - core));
}`;
const POINT_VERT = `
attribute vec2 a_xy;
attribute float a_val;
attribute float a_kind;
attribute float a_flags;
uniform mat4 u_m;
uniform float u_depth;
uniform float u_exag;
uniform float u_size;
${COLOUR}
varying vec4 v_col;
void main() {
  gl_Position = u_m * vec4(a_xy, -u_depth * u_exag, 1.0);
  gl_PointSize = u_size;
  v_col = colour(a_val, a_kind, a_flags);
}`;
const POINT_FRAG = `
precision mediump float;
varying vec4 v_col;
void main() { vec2 d = gl_PointCoord - 0.5; float r = dot(d, d); if (r > 0.25) discard; gl_FragColor = v_col * (1.0 - r * 3.0); }`;

const UNIFORMS = ['u_m', 'u_mode', 'u_depth', 'u_exag', 'u_alpha', 'u_size', 'u_years', 'u_pal', 'u_old', 'u_new', 'u_view', 'u_wpx', 'u_c2c', 'u_minpx', 'u_far', 'u_halo'];

export class PackedLayer {
  constructor({ id, box, metresPerUnit }) {
    this.id = id; this.type = 'custom'; this.renderingMode = '3d';
    this.box = box;                      // [x0, y0, x1, y1] in mercator
    this.mpu = metresPerUnit;            // mercator units per metre, at the city's latitude
    this.sets = [];                      // { name, data, mode, primitive, on, ... }
    this.exag = 8;
    this.palette = [[0.24, 0.55, 1.0], [0.62, 0.42, 1.0], [1.0, 0.28, 0.72], [0.6, 0.6, 0.65], [1.0, 1.0, 1.0]];
  }
  // width: a line's width on the ground, in metres. halo: how far its glow reaches, in widths.
  // minZoom: not drawn when the camera is farther out than this.
  add(set) { this.sets.push({ on: true, alpha: 1, size: 3, depth: 0, mode: 0, width: 1.6, halo: 3, years: [1870, 2025], oldC: [1, 0.95, 0.55], newC: [0, 0.72, 0.6], ...set }); if (this.gl) this._upload(this.sets[this.sets.length - 1]); if (this.map) this.map.triggerRepaint(); }
  set(name, on) { const s = this.sets.find((x) => x.name === name); if (s) { s.on = on; if (this.map) this.map.triggerRepaint(); } }
  _upload(s) {
    const gl = this.gl;
    s.buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, s.buf);
    gl.bufferData(gl.ARRAY_BUFFER, s.data, gl.STATIC_DRAW);
    s.count = s.data.byteLength / (s.primitive === 'points' ? 8 : 16); s.data = null;   // points, or segments
  }
  _program(vert, frag, attribs) {
    const gl = this.gl;
    const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vert)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const A = {}, U = {};
    for (const n of attribs) A[n] = gl.getAttribLocation(p, n);
    for (const n of UNIFORMS) U[n] = gl.getUniformLocation(p, n);
    return { p, A, U };
  }
  onAdd(map, gl) {
    this.map = map; this.gl = gl;
    // Instancing: built into WebGL 2 (what MapLibre asks for), an extension in WebGL 1.
    const ext = gl.vertexAttribDivisor ? null : gl.getExtension('ANGLE_instanced_arrays');
    if (!gl.vertexAttribDivisor && !ext) throw new Error('instanced drawing is not available');
    this.divisor = (loc, n) => (ext ? ext.vertexAttribDivisorANGLE(loc, n) : gl.vertexAttribDivisor(loc, n));
    this.drawInstanced = (count) => (ext ? ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, count) : gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count));
    this.line = this._program(LINE_VERT, LINE_FRAG, ['a_c', 'a_xy0', 'a_val0', 'a_kind', 'a_flags', 'a_xy1', 'a_val1']);
    this.point = this._program(POINT_VERT, POINT_FRAG, ['a_xy', 'a_val', 'a_kind', 'a_flags']);
    this.corners = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
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
    const map = this.map, zoom = map.getZoom(), dpr = gl.drawingBufferWidth / (gl.canvas.clientWidth || 1);
    // Clip w where the camera is looking, and the px one metre covers there.
    const c = map.getCenter(), cm = this._mc || (this._mc = (lng, lat) => [(lng + 180) / 360, 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI)]);
    const [cx, cy] = cm(c.lng, c.lat), c2c = m[3] * cx + m[7] * cy + m[15];
    const pxPerMetre = (512 * 2 ** zoom * this.mpu) * dpr;
    const pal = new Float32Array(this.palette.flat());
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);       // light adds up where pipes cross
    // Dense at city scale, so it is dimmed there and brought up as the camera closes in.
    const k = Math.max(0, Math.min(1, (zoom - 10) / 5));
    const used = new Set();
    const attr = (loc, size, type, norm, stride, off, div) => { if (loc < 0) return; gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, norm, stride, off); this.divisor(loc, div); used.add(loc); };
    for (const s of this.sets) {
      if (!s.on || !s.buf || !s.count || zoom < (s.minZoom || 0)) continue;
      const points = s.primitive === 'points', { p, A, U } = points ? this.point : this.line;
      gl.useProgram(p);
      gl.uniformMatrix4fv(U.u_m, false, o);
      gl.uniform1f(U.u_exag, this.exag);
      gl.uniform3fv(U.u_pal, pal);
      gl.uniform1f(U.u_alpha, s.alpha * (0.34 + 0.66 * k * k));
      gl.uniform1f(U.u_mode, s.mode); gl.uniform1f(U.u_depth, s.depth);
      gl.uniform2f(U.u_years, s.years[0], s.years[1]);
      gl.uniform3fv(U.u_old, s.oldC); gl.uniform3fv(U.u_new, s.newC);
      if (points) {
        gl.bindBuffer(gl.ARRAY_BUFFER, s.buf);
        attr(A.a_xy, 2, gl.UNSIGNED_SHORT, true, 8, 0, 0); attr(A.a_val, 1, gl.UNSIGNED_SHORT, false, 8, 4, 0);
        attr(A.a_kind, 1, gl.UNSIGNED_BYTE, false, 8, 6, 0); attr(A.a_flags, 1, gl.UNSIGNED_BYTE, false, 8, 7, 0);
        gl.uniform1f(U.u_size, s.size * dpr * (0.6 + 1.2 * k));
        gl.drawArrays(gl.POINTS, 0, s.count);
        continue;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
      attr(A.a_c, 2, gl.FLOAT, false, 8, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.buf);               // two 8-byte ends per segment
      attr(A.a_xy0, 2, gl.UNSIGNED_SHORT, true, 16, 0, 1); attr(A.a_val0, 1, gl.UNSIGNED_SHORT, false, 16, 4, 1);
      attr(A.a_kind, 1, gl.UNSIGNED_BYTE, false, 16, 6, 1); attr(A.a_flags, 1, gl.UNSIGNED_BYTE, false, 16, 7, 1);
      attr(A.a_xy1, 2, gl.UNSIGNED_SHORT, true, 16, 8, 1); attr(A.a_val1, 1, gl.UNSIGNED_SHORT, false, 16, 12, 1);
      gl.uniform2f(U.u_view, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(U.u_wpx, s.width * pxPerMetre); gl.uniform1f(U.u_c2c, c2c);
      gl.uniform1f(U.u_minpx, 1.1 * dpr); gl.uniform1f(U.u_far, 1 - k); gl.uniform1f(U.u_halo, s.halo);
      this.drawInstanced(s.count);
    }
    for (const loc of used) this.divisor(loc, 0);            // leave the context as MapLibre expects it
    gl.depthMask(true);
  }
}
