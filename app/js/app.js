// Under Toronto. What is under the streets, drawn where it is and as deep as it is.
// Data: app/data/, written by build/build.py from City of Toronto Open Data and the Ontario
// Ministry of Transportation's foundation report index. Nothing is fetched from anyone else
// while it runs, except the basemap.
// The old shoreline layer was taken out on 2026-10-12 (Blair: "it just looks like a mess of
// yellow lines"); its data is still built (data/shore.json) and the code is in git at 6609df8.
//
// The first app written on the map kit's parts (mapkit/): the map defaults, load-then-show,
// the opening move and the back button come from boot.js; the underground drawing is
// packed.js. This file is what a recipe would say: which data, how it is drawn, the camera.
import { createMap, styleReady, drawn, opening, backButton, selectOnFocus } from '../mapkit/boot.js?v=2';
import { PackedLayer } from '../mapkit/packed.js?v=3';
import { restyleMap, STYLE_URL } from './mapstyle.js?v=1';
import { createGlassLayer } from '../kit/glass/host-maplibre.js?v=1.0.2';

const EXAG = 8;                 // pipes are drawn this many times deeper than they are, so depth can be seen
const WATER_DEPTH = 1.8;        // watermains carry no depth in the city's data; this is the usual frost cover
const BORE_DEPTH = 25;          // a schematic shaft for a borehole report (the reports hold the real logs)
const HOME = { center: [-79.3771, 43.6462], zoom: 15.6, pitch: 66, bearing: -17 };   // Front and Yonge
const $ = (id) => document.getElementById(id);
const n = (x) => x.toLocaleString('en-CA');
const status = $('status'), ui = $('ui');

const bin = async (name) => new Uint8Array(await (await fetch(`data/${name}`)).arrayBuffer());
const json = async (name) => (await fetch(`data/${name}`)).json();

async function boot() {
  selectOnFocus();
  backButton($('topleft'));   // under the title pane, never over it
  if (window.EmberUI) window.EmberUI.init(ui);
  const meta = await json('meta.json');
  const open = opening(HOME);
  const map = createMap(maplibregl, {
    container: 'map', style: STYLE_URL.dark, ...open.start, minZoom: 8.5, maxZoom: 18.5, maxPitch: 80,
    maxBounds: [[meta.bbox[0] - 1.2, meta.bbox[1] - 0.9], [meta.bbox[2] + 1.2, meta.bbox[3] + 0.9]],
    credit: 'Pipes and breaks: <a href="https://open.toronto.ca/">City of Toronto Open Data</a>. Boreholes: <a href="https://www.ontario.ca/page/foundation-library">Ontario MTO</a>. Under Toronto by <a href="https://blairz.ca" rel="author">Blair Zasitko</a>',
  });
  window.__under = { map, meta };
  await styleReady(map);
  restyleMap(map, 'dark');

  const bores = await json('bores.json');

  // Everything below the street.
  const mpu = 1 / (40075016.686 * Math.cos((43.7 * Math.PI) / 180));    // mercator units per metre here
  const under = new PackedLayer({ id: 'under', box: meta.merc, metresPerUnit: mpu });
  under.exag = EXAG;
  map.addLayer(under);
  const [sewers, drops] = await Promise.all([bin('sewers.bin'), bin('drops.bin')]);
  under.add({ name: 'sewers', data: sewers, mode: 0, primitive: 'lines', alpha: 0.5, width: 1.6 });
  under.add({ name: 'drops', data: drops, mode: 0, primitive: 'lines', alpha: 0.14, width: 0.7, halo: 2, minZoom: 12.5 });   // too faint to see from farther out
  // The slower files arrive after the app is on screen; their switches start off.
  const later = Promise.all([bin('water.bin'), bin('breaks.bin')]).then(([water, breaks]) => {
    under.add({ name: 'water', data: water, mode: 1, primitive: 'lines', alpha: 0.5, width: 1.3, depth: WATER_DEPTH, years: [meta.water.oldest, 2025], on: false });
    under.add({ name: 'breaks', data: breaks, mode: 2, primitive: 'points', alpha: 0.8, size: 3.2, depth: WATER_DEPTH, years: [meta.breaks.from, meta.breaks.to], oldC: [1, 0.25, 0.2], newC: [1, 0.25, 0.2], on: false });
  });
  // Borehole reports: a shaft down from each site, and a dot on the street to tap.
  const shaft = new DataView(new ArrayBuffer(bores.features.length * 16));
  const [bx0, by0, bx1, by1] = meta.merc;
  bores.features.forEach((f, i) => {
    const c = maplibregl.MercatorCoordinate.fromLngLat(f.geometry.coordinates);
    const x = Math.round(((c.x - bx0) / (bx1 - bx0)) * 65535), y = Math.round(((c.y - by0) / (by1 - by0)) * 65535);
    for (const [k, d] of [[0, 0], [1, BORE_DEPTH * 10]]) { const o = i * 16 + k * 8; shaft.setUint16(o, x, true); shaft.setUint16(o + 2, y, true); shaft.setUint16(o + 4, d, true); shaft.setUint8(o + 6, 4); shaft.setUint8(o + 7, f.properties.kz ? 1 : 0); }
  });
  under.add({ name: 'bores', data: new Uint8Array(shaft.buffer), mode: 0, primitive: 'lines', alpha: 0.55, width: 2 });
  map.addSource('bores', { type: 'geojson', data: bores });
  map.addLayer({ id: 'bores-glow', type: 'circle', source: 'bores', paint: { 'circle-radius': ['case', ['==', ['get', 'kz'], 1], 16, 9], 'circle-blur': 1, 'circle-color': ['case', ['==', ['get', 'kz'], 1], '#ffd24a', '#ffffff'], 'circle-opacity': 0.35 } });
  map.addLayer({ id: 'bores', type: 'circle', source: 'bores', paint: { 'circle-radius': ['case', ['==', ['get', 'kz'], 1], 5, 3], 'circle-color': ['case', ['==', ['get', 'kz'], 1], '#ffd24a', '#ffffff'], 'circle-stroke-width': 1, 'circle-stroke-color': '#000' } });

  try { map.addLayer(createGlassLayer({ backdrop: 0.05 })); } catch (e) { console.log('glass unavailable: ' + e.message); }

  // The switches. Each line of the key belongs to a switch that is on.
  const FACT = {
    sewers: `${n(meta.sewers.pipes)} sewers. ${n(meta.sewers.measured)} sit at their measured depth, drawn ${EXAG} times deeper so it shows.`,
    water: `${n(meta.water.mains)} watermains by the year they were laid. ${n(meta.water.before_1900)} are from before 1900; the oldest is from ${meta.water.oldest}.`,
    breaks: `${n(meta.breaks.count)} watermain breaks, ${meta.breaks.from} to ${meta.breaks.to}. The worst year was ${meta.breaks.worst_year[0]}, with ${n(meta.breaks.worst_year[1])}.`,
    bores: `${n(meta.bores.count)} foundation reports from the ministry that built the highways. Tap one to read it.`,
  };
  const KEY = {
    sewers: '<span><i style="background:#3d8bff"></i>Storm</span><span><i style="background:#9e6bff"></i>Sanitary</span><span><i style="background:#ff47b8"></i>Combined</span>',
    water: `<span><i class="ramp" style="background:linear-gradient(90deg,#fff28c,#00b899)"></i>${meta.water.oldest} to today</span>`,
    breaks: '<span><i class="dot" style="background:#ff4033"></i>A break</span>',
    bores: '<span><i class="dot" style="background:#fff"></i>Borehole report</span>',
  };
  const buttons = [...document.querySelectorAll('#layers button')];
  const apply = (last) => {
    const on = Object.fromEntries(buttons.map((b) => [b.value, b.getAttribute('aria-pressed') === 'true']));
    under.set('sewers', on.sewers); under.set('drops', on.sewers); under.set('water', on.water); under.set('breaks', on.breaks); under.set('bores', on.bores);
    for (const id of ['bores', 'bores-glow']) map.setLayoutProperty(id, 'visibility', on.bores ? 'visible' : 'none');
    for (const b of buttons) { if (on[b.value]) b.setAttribute('data-tint', b.dataset.stain); else b.removeAttribute('data-tint'); }
    $('key').innerHTML = buttons.filter((b) => on[b.value]).map((b) => KEY[b.value]).join('');
    const show = last && on[last] ? last : buttons.map((b) => b.value).find((v) => on[v]);
    $('fact').textContent = show ? FACT[show] : '';
    map.triggerRepaint();
  };
  for (const b of buttons) b.addEventListener('click', async () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    if (on && (b.value === 'water' || b.value === 'breaks')) await later;
    if (window.EmberUI && window.EmberUI.sync) window.EmberUI.sync(b);
    apply(b.value);
  });
  apply('sewers');

  // A borehole report: its title and the ministry's own page for it.
  const sheet = $('sheet'), close = () => { sheet.hidden = true; $('bottom').hidden = false; map.triggerRepaint(); };
  $('close').addEventListener('click', close);
  map.on('click', (e) => {
    const pad = 14, hit = map.queryRenderedFeatures([[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]], { layers: ['bores'] })[0];
    if (!hit) { if (!sheet.hidden) close(); return; }
    const p = hit.properties, body = $('sheet-body');
    body.textContent = '';
    const h = document.createElement('h2'); h.textContent = p.title || p.id;
    const t = document.createElement('p'); t.textContent = `Foundation report ${p.id}, Ontario Ministry of Transportation.` + (p.kz ? ' My father worked on this one.' : '');
    body.append(h, t);
    if (/^https:\/\/foundation\.mto\.gov\.on\.ca\//.test(p.url)) { const a = document.createElement('a'); a.className = 'e-btn'; a.href = p.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open the report'; body.append(a); }
    $('bottom').hidden = true; sheet.hidden = false; map.triggerRepaint();
  });

  await drawn(map);
  status.classList.add('gone');
  ui.classList.add('ready');
  open.play(map);
}
boot().catch((e) => { status.textContent = 'failed: ' + e.message; console.error(e); });
