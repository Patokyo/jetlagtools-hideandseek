'use strict';

// ── Game zone ─────────────────────────────────────────────────────────────────
// Defines which places are allowed hiding areas at all (e.g. Oldenburg,
// Wahnbek and Metjendorf – everything else is off-limits by the house rules).
//
// Each entry is geocoded via Nominatim with polygon_geojson=1:
//   – if OSM has a boundary polygon for the place, that polygon is used
//   – small villages often have no boundary in OSM; they get a circle with
//     the radius from the sidebar input instead
// Everything outside the union of all areas is dimmed with a mask polygon.
// gameZoneContains() lets the checkers ignore POIs outside the zone.

let gzItems = {}; // id → { feature, layers, name, kind, osmKey }
let gzCounter = 0;
let gzMaskLayer = null;
let gzOsmKeys = new Set();

function gameZoneActive() {
    return Object.keys(gzItems).length > 0;
}

// True when the point is inside any allowed area – or when no zone is set,
// so tools behave as before until the player defines one.
function gameZoneContains(lat, lng) {
    if (!gameZoneActive()) return true;
    const pt = turf.point([lng, lat]);
    return Object.values(gzItems).some((item) => turf.booleanPointInPolygon(pt, item.feature));
}

// ── Mask: one world-sized polygon with every allowed area cut out ─────────────
function gzRedrawMask() {
    if (gzMaskLayer) {
        map.removeLayer(gzMaskLayer);
        gzMaskLayer = null;
    }
    const features = Object.values(gzItems).map((i) => i.feature);
    if (features.length === 0) return;

    // Merge overlapping areas first: under the even-odd fill rule two
    // overlapping holes cancel each other out and the intersection would be
    // dimmed although it is clearly allowed. Fall back to the raw features
    // if turf.union chokes on a degenerate geometry.
    let merged;
    try {
        merged = [features.reduce((acc, f) => turf.union(acc, f))];
    } catch (_) {
        merged = features;
    }

    const holes = [];
    for (const feature of merged) {
        const geom = feature.geometry;
        const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
        // Outer ring only – enclaves inside an allowed area stay allowed
        for (const rings of polys) holes.push(rings[0].map(([lng, lat]) => [lat, lng]));
    }
    if (holes.length === 0) return;

    const world = [
        [-89.9, -180],
        [-89.9, 180],
        [89.9, 180],
        [89.9, -180],
    ];
    gzMaskLayer = L.polygon([world, ...holes], {
        stroke: false,
        fillColor: '#0d1117',
        fillOpacity: 0.55,
        interactive: false,
    }).addTo(map);
}

function gzFitZone() {
    const group = L.featureGroup(Object.values(gzItems).flatMap((i) => i.layers));
    const bounds = group.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.05));
}

// ── Add an allowed area ───────────────────────────────────────────────────────
async function addGameZoneArea() {
    const input = document.getElementById('gzInput');
    const query = input.value.trim();
    if (!query) return;

    setStatus(t('status_searching'), 'loading');

    try {
        const params = {
            q: query,
            format: 'json',
            limit: 5,
            polygon_geojson: 1,
        };
        // Bias (not restrict) the search towards the current city, so
        // "Wahnbek" finds the village next to Oldenburg, not one elsewhere.
        if (currentCity) {
            const bb = currentCity.bbox;
            params.viewbox = `${bb[2]},${bb[1]},${bb[3]},${bb[0]}`;
        }
        const res = await fetch(
            'https://nominatim.openstreetmap.org/search?' + new URLSearchParams(params),
        );
        if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
        const data = await res.json();

        if (!Array.isArray(data) || data.length === 0) {
            setStatus(t('gz_not_found'), 'error');
            return;
        }

        const isPoly = (r) => ['Polygon', 'MultiPolygon'].includes(r.geojson?.type);
        const best = data.find(isPoly) ?? data[0];

        const osmKey = `${best.osm_type}/${best.osm_id}`;
        if (gzOsmKeys.has(osmKey)) {
            setStatus(t('gz_duplicate'), 'error');
            return;
        }

        let feature, kind, radiusKm;
        if (isPoly(best)) {
            feature = turf.feature(best.geojson);
            kind = 'boundary';
        } else {
            radiusKm = parseFloat(document.getElementById('gzRadius').value);
            if (!(radiusKm > 0)) radiusKm = 2;
            feature = turf.circle([parseFloat(best.lon), parseFloat(best.lat)], radiusKm, {
                steps: 64,
                units: 'kilometers',
            });
            kind = 'circle';
        }

        const name = best.display_name.split(',')[0].trim();
        const outline = L.geoJSON(feature, {
            style: {
                color: '#3fb950',
                weight: 3,
                opacity: 0.9,
                fillOpacity: 0,
                dashArray: kind === 'circle' ? '6 5' : null,
            },
            interactive: false,
        }).addTo(map);

        const id = ++gzCounter;
        gzItems[id] = { feature, layers: [outline], name, kind, osmKey };
        gzOsmKeys.add(osmKey);

        gzAddListEntry(id, name, best.display_name, kind, radiusKm);
        gzRedrawMask();
        filterCachedPoisByGameZone();
        gzFitZone();
        input.value = '';
        setStatus(tf('status_gz_added', name), 'ok');
    } catch (e) {
        setStatus(tf('status_err', e.message), 'error');
    }
}

function gzAddListEntry(id, name, fullName, kind, radiusKm) {
    const list = document.getElementById('gzList');
    const item = document.createElement('div');
    item.className = 'radius-item';
    item.id = 'gz-' + id;
    const kindLabel =
        kind === 'boundary'
            ? t('gz_boundary')
            : kind === 'drawn'
              ? t('gz_drawn')
              : tf('gz_circle', radiusKm);
    item.innerHTML = `
        <div class="dot" style="background:#3fb950;flex-shrink:0"></div>
        <div class="ri-info">
            <div>${esc(name)}</div>
            <div class="ri-lat" title="${esc(fullName)}">${kindLabel}</div>
        </div>
        <button class="danger" title="✕">✕</button>
    `;
    item.querySelector('button').addEventListener('click', () => removeGameZoneArea(id));
    list.appendChild(item);
}

// ── Remove ────────────────────────────────────────────────────────────────────
function removeGameZoneArea(id) {
    if (!gzItems[id]) return;
    gzItems[id].layers.forEach((l) => map.removeLayer(l));
    gzOsmKeys.delete(gzItems[id].osmKey);
    delete gzItems[id];
    document.getElementById('gz-' + id)?.remove();
    gzRedrawMask();
    filterCachedPoisByGameZone();
}

function clearGameZone() {
    if (gzDrawing) {
        gzDrawing = false;
        gzDrawPoints = [];
        gzClearDrawPreview();
        gzUpdateDrawButton();
    }
    Object.keys(gzItems).forEach((id) => removeGameZoneArea(Number(id)));
}

// ── Draw a custom area ────────────────────────────────────────────────────────
// Alternative to geocoded places: click at least three points on the map,
// then press the button again to close the polygon.
let gzDrawing = false;
let gzDrawPoints = [];
let gzDrawPreview = [];
let gzDrawCounter = 0;

function gzUpdateDrawButton() {
    const btn = document.getElementById('gzDrawBtn');
    if (gzDrawing) {
        btn.textContent = tf('btn_gz_finish', gzDrawPoints.length);
        btn.classList.add('meas-active');
    } else {
        btn.textContent = t('btn_gz_draw');
        btn.classList.remove('meas-active');
    }
}

function gzClearDrawPreview() {
    gzDrawPreview.forEach((l) => map.removeLayer(l));
    gzDrawPreview = [];
}

function toggleGzDraw() {
    if (!gzDrawing) {
        gzDrawing = true;
        gzDrawPoints = [];
        gzUpdateDrawButton();
        setStatus(t('status_gz_draw'), 'loading');
        closeSidebarForPick();
        return;
    }

    // Second press: finish with ≥3 points, cancel otherwise
    const points = gzDrawPoints;
    gzDrawing = false;
    gzDrawPoints = [];
    gzClearDrawPreview();
    gzUpdateDrawButton();

    if (points.length < 3) {
        setStatus(t('status_gz_draw_cancelled'), '');
        return;
    }

    const ring = points.map((p) => [p.lng, p.lat]);
    ring.push(ring[0]);
    const feature = turf.polygon([ring]);
    const name = tf('gz_drawn_name', ++gzDrawCounter);

    const outline = L.geoJSON(feature, {
        style: { color: '#3fb950', weight: 3, opacity: 0.9, fillOpacity: 0 },
        interactive: false,
    }).addTo(map);

    const id = ++gzCounter;
    gzItems[id] = { feature, layers: [outline], name, kind: 'drawn', osmKey: 'drawn/' + id };

    gzAddListEntry(id, name, name, 'drawn');
    gzRedrawMask();
    setStatus(tf('status_gz_added', name), 'ok');
}

function gzHandleClick(e) {
    if (!gzDrawing) return false;
    gzDrawPoints.push(e.latlng);

    const vertex = L.circleMarker(e.latlng, {
        radius: 5,
        color: '#fff',
        weight: 2,
        fillColor: '#3fb950',
        fillOpacity: 1,
    }).addTo(map);
    gzDrawPreview.push(vertex);

    if (gzDrawPoints.length > 1) {
        const line = L.polyline([gzDrawPoints.at(-2), gzDrawPoints.at(-1)], {
            color: '#3fb950',
            weight: 2.5,
            dashArray: '6 5',
        }).addTo(map);
        gzDrawPreview.push(line);
    }

    gzUpdateDrawButton();
    return true;
}
addMapClickHook(gzHandleClick);

// Trigger add on Enter in the place field
document.getElementById('gzInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addGameZoneArea();
});
