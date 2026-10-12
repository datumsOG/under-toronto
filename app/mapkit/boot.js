// mapkit/boot.js: the parts every map app here repeats, in one place. This is the first
// piece of the map app kit (plan: MAP-APP-KIT-PLAN-2026-10-12), written for Under Toronto
// and meant to be lifted out as it is. Each function is one of the kit's rules.

// The settled map defaults: multisampled, never more than 2 device px per CSS px (?dpr=3 and
// ?aa=0 to compare), credits collapsed to the (i).
export function createMap(maplibregl, options) {
  const q = location.search;
  const map = new maplibregl.Map({
    attributionControl: false,
    antialias: !/[?&]aa=0\b/.test(q),
    pixelRatio: Math.min(devicePixelRatio || 1, +((/[?&]dpr=([\d.]+)/.exec(q) || [])[1]) || 2),
    ...options,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: options.credit || '' }), 'top-right');
  const collapse = () => document.querySelectorAll('.maplibregl-ctrl-attrib.maplibregl-compact-show').forEach((el) => el.classList.remove('maplibregl-compact-show'));
  collapse(); setTimeout(collapse, 400); setTimeout(collapse, 1500);
  return map;
}

// The style is ready, or six seconds have passed: MapLibre's own 'load' also waits for
// tiles, and a slow network must not leave the app on its loading screen.
export function styleReady(map) {
  return new Promise((res) => {
    let done = false;
    const go = () => { if (!done) { done = true; res(); } };
    if (map.isStyleLoaded()) go();
    map.once('load', go);
    map.once('styledata', () => setTimeout(go, 250));
    setTimeout(go, 6000);
  });
}

// Load, then show: resolve once the view's tiles are in and one frame has been drawn with
// them. Never waits past `cap` ms.
export function drawn(map, cap = 6000) {
  return new Promise((res) => {
    const t0 = performance.now();
    const check = () => {
      if (map.areTilesLoaded() || performance.now() - t0 > cap) { map.once('render', () => requestAnimationFrame(res)); map.triggerRepaint(); }
      else setTimeout(check, 80);
    };
    check();
  });
}

// The opening move: the app opens a little wide, flat and turned behind the loading screen
// and eases to `home`. Any touch stops it. Not for anyone who asked for less motion.
export function opening(home) {
  const calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = calm ? home : { ...home, zoom: home.zoom - 0.3, pitch: Math.max(0, home.pitch - 12), bearing: home.bearing - 16 };
  const play = (map) => { if (!calm) setTimeout(() => map.easeTo({ ...home, duration: 2800, essential: true, easing: (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2) }), 600); };
  return { start, play };
}

// Reached from the home page inside its home-screen icon there is no browser bar, so the app
// shows a way back. Only then. Returns the element, so the app can lay out around it.
export function backButton(parent) {
  const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  let fromSite = false;
  try { const r = new URL(document.referrer); fromSite = r.origin === location.origin && !r.pathname.startsWith(new URL('.', location.href).pathname); } catch (e) {}
  if (!(standalone && fromSite) && !/[?&]standalone=1\b/.test(location.search)) return null;
  const a = document.createElement('a');
  a.id = 'site-back'; a.className = 'e-btn e-btn--icon'; a.href = '/'; a.setAttribute('aria-label', 'Back to blairz.ca');
  a.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.5 4.5L7 10l5.5 5.5"/></svg>';
  parent.appendChild(a);
  document.body.classList.add('has-site-back');
  return a;
}

// Tapping a number box selects the number.
export function selectOnFocus() {
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('input[type="number"], input[inputmode="numeric"], input[inputmode="decimal"]')) setTimeout(() => { try { t.select(); } catch (err) {} }, 0);
  });
}
