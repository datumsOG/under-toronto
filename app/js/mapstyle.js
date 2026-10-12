// mapstyle.js — the map under the spheres, in three looks (v12, 2026-09-22).
//
//   dark    OpenFreeMap "dark", untouched. The existing Pulse.
//   lifted  the same dark style with every colour except the black background
//           lifted toward white, water most of all. Blair: "the map elements
//           (everything but the black) lightened up a bit so it's not so dark
//           (make the water lighter too)."
//   google  OpenFreeMap "liberty" (a light OSM style) recoloured toward the Google
//           Maps default: pale land, sky-blue water, soft green parks, white streets,
//           yellow highways, grey labels.
//
// Recolouring is done after the style loads, layer by layer, rather than by shipping
// a forked style JSON: the upstream style keeps receiving fixes, and a fork would
// silently stop getting them.

export const STYLE_URL = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  lifted: 'https://tiles.openfreemap.org/styles/dark',
  google: 'https://tiles.openfreemap.org/styles/liberty',
};

// ── colour parsing: enough of CSS for what these two styles actually contain ──
function parse(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  let m;
  if ((m = s.match(/^#([0-9a-f]{3,8})$/))) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  if ((m = s.match(/^rgba?\(([^)]+)\)$/))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]];
  }
  if ((m = s.match(/^hsla?\(([^)]+)\)$/))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    const h = p[0] / 360, sat = p[1] / 100, l = p[2] / 100;
    const f = (n) => {
      const k = (n + h * 12) % 12, a = sat * Math.min(l, 1 - l);
      return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    };
    return [f(0), f(8), f(4), p[3] === undefined ? 1 : p[3]];
  }
  return null;
}
const fmt = ([r, g, b, a]) =>
  `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})`;

// Walk a paint value (a colour string, or an expression containing colour strings)
// and transform every colour in it. Non-colour strings ("linear", "zoom") survive.
function mapColours(v, fn) {
  if (typeof v === 'string') { const c = parse(v); return c ? fmt(fn(c)) : v; }
  if (Array.isArray(v)) return v.map((x) => mapColours(x, fn));
  return v;
}

// Move each channel a fraction k of the way to white; optionally cool it slightly.
const lift = (k, cool = 0) => ([r, g, b, a]) => [
  r + (255 - r) * k - cool * 6, g + (255 - g) * k, b + (255 - b) * k + cool * 10, a,
];

function forEachColour(map, cb) {
  for (const layer of map.getStyle().layers) {
    const paint = layer.paint || {};
    for (const prop of Object.keys(paint)) {
      if (!/color$/.test(prop)) continue;
      cb(layer, prop, map.getPaintProperty(layer.id, prop));
    }
  }
}

function lifted(map) {
  forEachColour(map, (layer, prop, value) => {
    if (layer.id === 'background') return;              // "everything but the black"
    if (prop === 'text-halo-color') return;             // dark halos keep labels legible
    let fn = lift(0.20);                                // roads, rail, boundaries
    if (/water/.test(layer.id)) fn = lift(0.30, 1);     // "make the water lighter too"
    else if (prop === 'text-color') fn = lift(0.34);
    else if (/building/.test(layer.id)) fn = lift(0.09);
    else if (/park|wood|landuse|landcover/.test(layer.id)) fn = lift(0.13);
    map.setPaintProperty(layer.id, prop, mapColours(value, fn));
  });
}

// Google-default-like palette. First matching rule wins for each layer.
const G = {
  land: '#f3f2ef', water: '#a3d2f5', waterText: '#3a6fb0', park: '#c6e7c1',
  street: '#ffffff', streetCase: '#dadce0', highway: '#fde293', highwayCase: '#ecc254',
  building: '#e7e5e1', buildingEdge: '#d9d6d1', rail: '#c7c9cc',
  label: '#5f6368', placeLabel: '#3c4043',
};
const GOOGLE_RULES = [
  [/^background$/, { 'background-color': G.land }],
  [/^water$/, { 'fill-color': G.water }],
  [/^waterway/, { 'line-color': G.water }],
  [/water_name|waterway_line_label/, { 'text-color': G.waterText }],
  [/^park$/, { 'fill-color': G.park, 'fill-outline-color': G.park }],
  [/^park_outline$/, { 'line-color': G.park }],
  [/landcover_(grass|wood)|landuse_(pitch|track|cemetery)/, { 'fill-color': G.park }],
  [/landuse_residential/, { 'fill-color': G.land }],
  [/landuse_hospital/, { 'fill-color': '#f9e2e2' }],
  [/landuse_school/, { 'fill-color': '#efeadb' }],
  [/aeroway_fill/, { 'fill-color': '#e8eaed' }],
  [/^building$/, { 'fill-color': G.building, 'fill-outline-color': G.buildingEdge }],
  [/motorway.*casing/, { 'line-color': G.highwayCase }],
  [/motorway/, { 'line-color': G.highway }],
  [/casing/, { 'line-color': G.streetCase }],
  [/(road|bridge|tunnel)_(minor|link|street|service_track|secondary_tertiary|trunk_primary|path_pedestrian)$/, { 'line-color': G.street }],
  [/rail/, { 'line-color': G.rail }],
  [/^label_(city|town|village|state|country)|^place/, { 'text-color': G.placeLabel }],
  [/name|label|poi|airport/, { 'text-color': G.label }],
];

const ALLOWED = {
  background: ['background-color'],
  fill: ['fill-color', 'fill-outline-color'],
  line: ['line-color'],
  symbol: ['text-color'],
};

function google(map) {
  for (const layer of map.getStyle().layers) {
    // Flat footprints only. 3D extrusions would stand between the camera and the
    // spheres, and this variant is about colour, not buildings.
    if (layer.type === 'fill-extrusion') { map.setLayoutProperty(layer.id, 'visibility', 'none'); continue; }
    const rule = GOOGLE_RULES.find(([re]) => re.test(layer.id));
    if (!rule) continue;
    const allowed = ALLOWED[layer.type] || [];
    for (const [prop, val] of Object.entries(rule[1])) {
      if (!allowed.includes(prop)) continue;       // e.g. a text-color rule on a line layer
      try { map.setPaintProperty(layer.id, prop, val); } catch (e) { /* leave upstream colour */ }
    }
  }
}

export function restyleMap(map, kind) {
  try {
    if (kind === 'lifted') lifted(map);
    else if (kind === 'google') google(map);
  } catch (e) {
    // A recolour failure must never take the spheres down with it.
    console.log('PULSE restyle failed: ' + e.message);
  }
}
