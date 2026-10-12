#!/usr/bin/env python3
"""build — reduce the city's files in data/raw/ to the small binaries the app draws.

    (internal path) (internal path)

Out (app/data/):
  sewers.bin   line segments: every gravity sewer, with its depth below the street
  water.bin    line segments: every watermain, with the year it was laid
  drops.bin    one vertical per sewer: from the street down to the pipe (the maintenance hole)
  breaks.bin   one point per watermain break, 1990 to 2016, with its year
  shore.json   the lake's edge on old maps, 1818 to 1910
  bores.json   Ontario Ministry of Transportation foundation reports (borehole sites)
  meta.json    the bounding box the coordinates are packed into, counts, and the facts the app states

Depth is real where the city publishes it: the top of the upstream maintenance hole (its
"Top Elevation") minus the pipe's upstream invert elevation. Where either is missing the
pipe gets the median depth of its kind and is flagged, so the app can say how many are measured.

Vertex layout, little-endian, 8 bytes: u16 x, u16 y (position in BBOX in Web Mercator),
u16 value (sewers, drops: depth in decimetres; water, breaks: year), u8 kind, u8 flags.
"""
import csv, io, json, math, struct, sys, zipfile, statistics, collections
from pathlib import Path
import shapefile

ROOT = Path(__file__).resolve().parent.parent
RAW, OUT = ROOT / 'data/raw', ROOT / 'app/data'
OUT.mkdir(parents=True, exist_ok=True)
BBOX = (-79.66, 43.56, -79.10, 43.87)          # lon0, lat0, lon1, lat1: the city with a margin
csv.field_size_limit(10**9)


def merc(lon, lat):
    return (lon + 180) / 360, (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2

X0, Y1 = merc(BBOX[0], BBOX[1]); X1, Y0 = merc(BBOX[2], BBOX[3])      # y grows south


def q(lon, lat):
    x, y = merc(lon, lat)
    u, v = (x - X0) / (X1 - X0), (y - Y0) / (Y1 - Y0)
    if not (0 <= u <= 1 and 0 <= v <= 1):
        return None
    return round(u * 65535), round(v * 65535)


def thin(pts, tol=6):
    """Drop points that sit within `tol` packed units (~4 m) of the line between their neighbours."""
    if len(pts) <= 2:
        return pts
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        (ax, ay), (bx, by), (cx, cy) = out[-1], pts[i], pts[i + 1]
        dx, dy = cx - ax, cy - ay
        L = math.hypot(dx, dy)
        d = abs(dx * (ay - by) - (ax - bx) * dy) / L if L else math.hypot(bx - ax, by - ay)
        if d > tol:
            out.append(pts[i])
    out.append(pts[-1])
    return out


def features(path):
    """Stream a one-feature-per-line GeoJSON file (how the city writes them) without loading it."""
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip().rstrip(',')
            if line.startswith('{ "type": "Feature"') or line.startswith('{"type": "Feature"'):
                yield json.loads(line)


def lines_of(geom):
    if geom['type'] == 'LineString':
        yield geom['coordinates']
    elif geom['type'] == 'MultiLineString':
        yield from geom['coordinates']


def num(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None

# ---------------------------------------------------------------- maintenance holes: id -> top elevation
top = {}
with open(RAW / 'manholes.csv', encoding='utf-8') as f:
    for r in csv.DictReader(f):
        v = num(r['Top Elevation information'])
        if v:
            top[r['Asset Identification']] = v
print('maintenance holes with a top elevation:', len(top))

# ---------------------------------------------------------------- sewers
KIND = {'Storm': 0, 'SAN': 1, 'Combined': 2}            # anything else (overflows, drains): 3
rows, depths = [], collections.defaultdict(list)
for name, P in (('sewer-gravity.geojson', 'Sewer Gravity '), ('sewer-trunk.geojson', 'Trunk Sewer ')):
    for ft in features(RAW / name):
        p = ft['properties']
        if name.startswith('sewer-gravity') and p.get('Sewer Gravity Trunk Sewer') == 'Yes':
            continue                                     # trunks come from their own file
        flow = p.get(P + 'Flow Type') or {'SAN': 'SAN', 'STM': 'Storm', 'CMB': 'Combined', 'COM': 'Combined'}.get(p.get(P + 'Water Type'), '')
        kind = KIND.get(flow, 3)
        trunk = name.startswith('sewer-trunk')
        up, mh = num(p.get('Upstream Elevation')), top.get(p.get(P + 'Upstream Maintenance Hole'))
        depth = mh - up if (up and mh and 0.4 < mh - up < 60) else None
        if depth:
            depths[(kind, trunk)].append(depth)
        year = (p.get(P + 'Install Date') or '')[:4]
        rows.append((kind, trunk, depth, num(p.get(P + 'Diameter')) or 0, int(year) if year.isdigit() else 0, ft['geometry']))
med = {k: statistics.median(v) for k, v in depths.items()}
fallback = statistics.median([d for v in depths.values() for d in v])
sew, drops, n_meas, n_all, deepest, km = bytearray(), bytearray(), 0, 0, (0, None), 0.0
for kind, trunk, depth, diam, year, geom in rows:
    measured = depth is not None
    d = depth if measured else med.get((kind, trunk), fallback)
    dm = min(65535, round(d * 10))
    flags = (1 if trunk else 0) | (2 if measured else 0) | (4 if diam >= 900 else 0)
    first = None
    for ln in lines_of(geom):
        pts = [q(x, y) for x, y, *_ in ln]
        if None in pts:
            continue
        pts = thin(pts)
        first = first or pts[0]
        for a, b in zip(pts, pts[1:]):
            sew += struct.pack('<HHHBB', a[0], a[1], dm, kind, flags) + struct.pack('<HHHBB', b[0], b[1], dm, kind, flags)
    if first:
        n_all += 1; n_meas += measured
        drops += struct.pack('<HHHBB', first[0], first[1], 0, kind, flags) + struct.pack('<HHHBB', first[0], first[1], dm, kind, flags)
        if measured and d > deepest[0]:
            deepest = (d, kind)
(OUT / 'sewers.bin').write_bytes(sew); (OUT / 'drops.bin').write_bytes(drops)
print(f'sewers: {n_all} pipes, {n_meas} with a measured depth, {len(sew) // 16} segments, {len(sew) / 1e6:.1f} MB; median depths', {k: round(v, 1) for k, v in med.items()})

# ---------------------------------------------------------------- watermains
wat, n_w, years = bytearray(), 0, []
for name, kind in (('water-distribution.geojson', 0), ('water-transmission.geojson', 1)):
    for ft in features(RAW / name):
        p = ft['properties']
        y = int(num(p.get('Watermain Construction Year')) or 0)
        if not 1850 <= y <= 2030:
            y = 0
        flags = 4 if (num(p.get('Watermain Diameter')) or 0) >= 600 else 0
        ok = False
        for ln in lines_of(ft['geometry']):
            pts = [q(x, yy) for x, yy, *_ in ln]
            if None in pts:
                continue
            pts = thin(pts); ok = True
            for a, b in zip(pts, pts[1:]):
                wat += struct.pack('<HHHBB', a[0], a[1], y, kind, flags) + struct.pack('<HHHBB', b[0], b[1], y, kind, flags)
        if ok:
            n_w += 1
            if y:
                years.append(y)
(OUT / 'water.bin').write_bytes(wat)
print(f'watermains: {n_w}, {len(wat) // 16} segments, {len(wat) / 1e6:.1f} MB, oldest {min(years)}, median {statistics.median(years)}')


def shp(zname, stem):
    zf = zipfile.ZipFile(RAW / zname)
    base = next(n for n in zf.namelist() if n.lower().endswith('.shp') and stem in n)[:-4]
    return shapefile.Reader(shp=io.BytesIO(zf.read(base + '.shp')), dbf=io.BytesIO(zf.read(base + '.dbf')), shx=io.BytesIO(zf.read(base + '.shx')))

# ---------------------------------------------------------------- breaks
brk, n_b, by_year = bytearray(), 0, collections.Counter()
for sr in shp('breaks.zip', 'Breaks').iterShapeRecords():
    r = sr.record.as_dict()
    p = q(r['POINT_X'], r['POINT_Y']) if r.get('POINT_X') else None
    if p and r.get('BREAK_YEAR'):
        brk += struct.pack('<HHHBB', p[0], p[1], int(r['BREAK_YEAR']), 0, 0); n_b += 1; by_year[int(r['BREAK_YEAR'])] += 1
(OUT / 'breaks.bin').write_bytes(brk)
print('breaks:', n_b, 'worst year', by_year.most_common(1))

# ---------------------------------------------------------------- old shorelines
shore, layers = [], collections.Counter()
for sr in shp('shoreline.zip', 'LINE').iterShapeRecords():
    layer = sr.record.as_dict()['LAYER']
    digits = ''.join(c for c in layer if c.isdigit())[-4:]
    if len(digits) != 4:
        continue
    parts = list(sr.shape.parts) + [len(sr.shape.points)]
    for i in range(len(parts) - 1):
        pts = [[round(x, 6), round(y, 6)] for x, y in sr.shape.points[parts[i]:parts[i + 1]]]
        if len(pts) > 1:
            shore.append({'type': 'Feature', 'properties': {'year': int(digits), 'map': layer.rsplit('_', 1)[0].replace('_', ' ').title()}, 'geometry': {'type': 'LineString', 'coordinates': pts}})
            layers[int(digits)] += 1
(OUT / 'shore.json').write_text(json.dumps({'type': 'FeatureCollection', 'features': shore}, separators=(',', ':')))
print('shoreline maps:', dict(sorted(layers.items())))

# ---------------------------------------------------------------- borehole reports
mine = set()
hits = Path('(internal path)')
if hits.exists():
    for line in hits.read_text(errors='replace').split('\n'):
        if line.startswith('===== HIT '):
            mine.add(line.split()[2])
bores = []
src = json.load(open('(internal path)', encoding='latin-1'))
for ft in src['features']:
    lon, lat = ft['geometry']['coordinates'][:2]
    p = ft['properties']
    if BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]:
        bores.append({'type': 'Feature', 'properties': {'id': p['GeocresNumber'], 'title': (p.get('Location') or '').strip().title(), 'url': p.get('DocumentLink') or '', 'kz': 1 if p['GeocresNumber'] in mine else 0},
                      'geometry': {'type': 'Point', 'coordinates': [round(lon, 5), round(lat, 5)]}})
(OUT / 'bores.json').write_text(json.dumps({'type': 'FeatureCollection', 'features': bores}, separators=(',', ':')))
print('borehole reports in the box:', len(bores), 'highlighted:', sum(b['properties']['kz'] for b in bores), 'of', len(mine))

meta = {'bbox': BBOX, 'merc': [X0, Y0, X1, Y1],
        'sewers': {'pipes': n_all, 'measured': n_meas, 'median_depth_m': {'storm': round(med.get((0, False), 0), 1), 'sanitary': round(med.get((1, False), 0), 1), 'combined': round(med.get((2, False), 0), 1), 'all': round(fallback, 1)}, 'deepest_m': round(deepest[0], 1)},
        'water': {'mains': n_w, 'oldest': min(years), 'median_year': int(statistics.median(years)), 'before_1900': sum(1 for y in years if y < 1900)},
        'breaks': {'count': n_b, 'from': min(by_year), 'to': max(by_year), 'worst_year': by_year.most_common(1)[0]},
        'shore': {'years': sorted(layers)}, 'bores': {'count': len(bores), 'highlighted': sum(b['properties']['kz'] for b in bores)}}
(OUT / 'meta.json').write_text(json.dumps(meta, indent=1))
print(json.dumps(meta)[:900])
