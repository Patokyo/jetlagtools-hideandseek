'use strict';

// Thermometer questions: "After traveling [distance], am I hotter or colder?"
// Seeker moves from Point A to Point B.
// "Hotter" means the hider is closer to B than to A.
// "Colder" means the hider is closer to A than to B.
// The boundary is the perpendicular bisector of segment AB.

let _thermQuestions = [];
let _thermNextId = 1;
let _thermPickingId = null;
let _thermPickingStage = 'A'; // 'A' or 'B'

// ── Helpers ───────────────────────────────────────────────────────────────────

function _thermRemoveGuideLayers(q, opts = {}) {
    // opts.preserveCircle: if true, do not remove L.Circle guide layers (the radius circle)
    const preserveCircle = !!opts.preserveCircle;

    // Iterate over map layers and remove those marked as thermometer guides
    map.eachLayer((layer) => {
        try {
            if (!layer || !layer._isThermGuide) return;
            if (preserveCircle && layer instanceof L.Circle) return;
            map.removeLayer(layer);
        } catch (e) {
            // ignore
        }
    });

    // Also purge them from q.layers if present; keep circle entries when preserving
    if (q && Array.isArray(q.layers)) {
        q.layers = q.layers.filter((l) => {
            if (!(l && l._isThermGuide)) return true;
            if (preserveCircle && l instanceof L.Circle) return true;
            return false;
        });
    }
}

// ── Bisector geometry ─────────────────────────────────────────────────────────
// The hider answers by comparing haversine distances, so the boundary has to be
// the true spherical bisector: the great circle of points equidistant from A
// and B. Building it in lat/lng degrees tilts the line (a degree of longitude
// is shorter than a degree of latitude), which puts points near the line on
// the wrong side. Line and mask are sampled from this same curve.
const _THERM_R_KM = 6371.0088;
const _THERM_DEG = Math.PI / 180;

function _thermV3(lat, lng) {
    const phi = lat * _THERM_DEG;
    const lambda = lng * _THERM_DEG;
    return {
        x: Math.cos(phi) * Math.cos(lambda),
        y: Math.cos(phi) * Math.sin(lambda),
        z: Math.sin(phi),
    };
}

function _thermVecToLatLng(v) {
    return {
        lat: Math.asin(Math.max(-1, Math.min(1, v.z))) / _THERM_DEG,
        lng: Math.atan2(v.y, v.x) / _THERM_DEG,
    };
}

// Same longitude but unwrapped near refLng, so long polylines do not jump
// across the antimeridian.
function _thermVecToLatLngNear(v, refLng) {
    const p = _thermVecToLatLng(v);
    p.lng = refLng + ((((p.lng - refLng) % 360) + 540) % 360) - 180;
    return p;
}

// n: unit normal pointing to the B side; m: unit vector of the midpoint;
// u: unit tangent along the bisector at the midpoint. Every point
// m*cos(t) + u*sin(t) is exactly equidistant from A and B.
function _thermBisector(q) {
    if (q.lat === null || q.lng === null || q.latB === null || q.lngB === null) return null;

    const a = _thermV3(q.lat, q.lng);
    const b = _thermV3(q.latB, q.lngB);

    let nx = b.x - a.x;
    let ny = b.y - a.y;
    let nz = b.z - a.z;
    const nLen = Math.hypot(nx, ny, nz);
    if (!Number.isFinite(nLen) || nLen < 1e-12) return null;
    nx /= nLen;
    ny /= nLen;
    nz /= nLen;

    let mx = a.x + b.x;
    let my = a.y + b.y;
    let mz = a.z + b.z;
    const mLen = Math.hypot(mx, my, mz);
    if (!Number.isFinite(mLen) || mLen < 1e-12) return null;
    mx /= mLen;
    my /= mLen;
    mz /= mLen;

    let ux = ny * mz - nz * my;
    let uy = nz * mx - nx * mz;
    let uz = nx * my - ny * mx;
    const uLen = Math.hypot(ux, uy, uz);
    if (!Number.isFinite(uLen) || uLen < 1e-12) return null;
    ux /= uLen;
    uy /= uLen;
    uz /= uLen;

    const mid = _thermVecToLatLng({ x: mx, y: my, z: mz });
    return {
        midLat: mid.lat,
        midLng: mid.lng,
        n: { x: nx, y: ny, z: nz },
        m: { x: mx, y: my, z: mz },
        u: { x: ux, y: uy, z: uz },
    };
}

function _thermBisectorVec(bis, t) {
    const c = Math.cos(t);
    const s = Math.sin(t);
    return {
        x: bis.m.x * c + bis.u.x * s,
        y: bis.m.y * c + bis.u.y * s,
        z: bis.m.z * c + bis.u.z * s,
    };
}

// Distance in km from the midpoint that comfortably covers the game zone or,
// without a zone, the current view.
function _thermCoverageSpanKm(midLat, midLng) {
    let maxKm = 0;
    const consider = (lat, lng) => {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        maxKm = Math.max(maxKm, haversineKm({ lat: midLat, lng: midLng }, { lat, lng }));
    };

    try {
        if (gameZoneActive() && typeof gzItems !== 'undefined') {
            const feats = Object.values(gzItems)
                .map((i) => i.feature)
                .filter(Boolean);
            if (feats.length) {
                const [minLng, minLat, maxLng, maxLat] = turf.bbox(turf.featureCollection(feats));
                consider(minLat, minLng);
                consider(minLat, maxLng);
                consider(maxLat, minLng);
                consider(maxLat, maxLng);
            }
        }
    } catch (e) {
        // Fall back to the visible map bounds.
    }

    if (maxKm === 0) {
        const b = map.getBounds();
        consider(b.getNorth(), b.getWest());
        consider(b.getNorth(), b.getEast());
        consider(b.getSouth(), b.getWest());
        consider(b.getSouth(), b.getEast());
    }

    return Math.max(maxKm * 2, 50);
}

// Half-length of the drawn bisector, as an angle on the sphere.
function _thermBisectorSpan(bis) {
    const km = _thermCoverageSpanKm(bis.midLat, bis.midLng);
    return Math.min(km / _THERM_R_KM, (85 * Math.PI) / 180);
}

function _thermBisectorSampleCount(tMax) {
    return Math.min(256, Math.max(64, Math.ceil((2 * tMax) / (0.25 * _THERM_DEG))));
}

function _thermBisectorLine(bis, tMax) {
    const count = _thermBisectorSampleCount(tMax);
    const pts = [];
    for (let i = 0; i <= count; i++) {
        const t = -tMax + (2 * tMax * i) / count;
        const p = _thermVecToLatLngNear(_thermBisectorVec(bis, t), bis.midLng);
        pts.push([p.lat, p.lng]);
    }
    return pts;
}

// Polygon on the B side of the bisector. Its long edge is exactly the sampled
// bisector, so the shaded boundary matches the dashed line.
function _thermMaskRing(bis, tMax) {
    const ring = _thermBisectorLine(bis, tMax).map(([lat, lng]) => [lng, lat]);
    const c = Math.cos(tMax);
    const s = Math.sin(tMax);
    const farEnd = (t) => {
        const p = _thermBisectorVec(bis, t);
        const v = {
            x: p.x * c + bis.n.x * s,
            y: p.y * c + bis.n.y * s,
            z: p.z * c + bis.n.z * s,
        };
        const ll = _thermVecToLatLngNear(v, bis.midLng);
        return [ll.lng, ll.lat];
    };
    ring.push(farEnd(tMax));
    ring.push(farEnd(-tMax));
    ring.push(ring[0]);
    return ring;
}

// Initial bearing from a to b, in radians.
function _thermBearing(a, b) {
    const phi1 = a.lat * _THERM_DEG;
    const phi2 = b.lat * _THERM_DEG;
    const dLng = (b.lng - a.lng) * _THERM_DEG;
    const y = Math.sin(dLng) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
    return Math.atan2(y, x);
}

function _thermDestination(a, bearing, km) {
    const delta = km / _THERM_R_KM;
    const phi1 = a.lat * _THERM_DEG;
    const lambda1 = a.lng * _THERM_DEG;
    const sinPhi2 =
        Math.sin(phi1) * Math.cos(delta) +
        Math.cos(phi1) * Math.sin(delta) * Math.cos(bearing);
    const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));
    const lambda2 =
        lambda1 +
        Math.atan2(
            Math.sin(bearing) * Math.sin(delta) * Math.cos(phi1),
            Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
        );
    return { lat: phi2 / _THERM_DEG, lng: lambda2 / _THERM_DEG };
}

// Place B exactly q.dist km from A along the bearing A -> clicked point.
function _thermSetPointB(q, lat, lng) {
    if (q.lat === null || q.lng === null) return;
    const a = { lat: q.lat, lng: q.lng };
    const target = { lat, lng };
    if (haversineKm(a, target) < 1e-6) return;
    const b = _thermDestination(a, _thermBearing(a, target), q.dist);
    q.latB = b.lat;
    q.lngB = b.lng;
}

// ── Redraw the guide (Circle + Bisector) ──────────────────────────────────────
function _thermDrawGuide(id) {
    const q = _thermQuestions.find((x) => x.id === id);
    if (!q || q.lat === null) return;

    // Remove any previously created thermometer guide layers (safety)
    // If dragging, preserve the circle so it doesn't flicker; otherwise remove all
    _thermRemoveGuideLayers(q, { preserveCircle: !!q && !!q._thermIsDragging });

    // Clear only the transient guide layers tracked on this question, not the markers
    q.layers.forEach((l) => {
        if (!(l instanceof L.Marker || l instanceof L.CircleMarker)) {
            try { map.removeLayer(l); } catch (e) {}
        }
    });
    q.layers = q.layers.filter(l => l instanceof L.Marker || l instanceof L.CircleMarker);

    // Point A marker (draggable)
    if (!q.markerA) {
        q.markerA = createDraggableMarker([q.lat, q.lng]).addTo(map);
        q.layers.push(q.markerA);

        q.markerA.on('drag', (e) => {                const pos = getMarkerPosition(e.target);

            // Keep B on the circle around the moved A, at the same bearing.
            const bearing =
                q.latB !== null
                    ? _thermBearing(
                          { lat: q.lat, lng: q.lng },
                          { lat: q.latB, lng: q.lngB },
                      )
                    : Math.PI / 4;

            q.lat = pos.lat;
            q.lng = pos.lng;

            const movedB = _thermDestination({ lat: q.lat, lng: q.lng }, bearing, q.dist);
            q.latB = movedB.lat;
            q.lngB = movedB.lng;
            if (q.markerB) q.markerB.setLatLng([q.latB, q.lngB]);

                _thermUpdateGuideElements(id);
                _thermDrawOcclusion(id);
        });

            q.markerA.on('dragstart', () => {
                q._thermIsDragging = true;
                // redraw so the line/dot are hidden while dragging
                _thermUpdateGuideElements(id);
            });

            q.markerA.on('dragend', () => {
                q._thermIsDragging = false;
                // redraw complete guide (circle + line) after drop
                _thermUpdateGuideElements(id);
                _thermDrawOcclusion(id);
                _thermRenderCards();
            });
    }

    if (q.latB !== null) {
        const pointB = L.latLng(q.latB, q.lngB);

        // Point B marker - made bigger and distinct
        if (!q.markerB) {
            q.markerB = createDraggableMarker(pointB).addTo(map);
            q.layers.push(q.markerB);

            q.markerB.on('drag', (e) => {
                const pos = getMarkerPosition(e.target);
                const centerPos = L.latLng(q.lat, q.lng);

                const dist = centerPos.distanceTo(pos);
                const targetDist = q.dist * 1000;
                const ratio = targetDist / dist;

                const newLat = centerPos.lat + (pos.lat - centerPos.lat) * ratio;
                const newLng = centerPos.lng + (pos.lng - centerPos.lng) * ratio;

                q.latB = newLat;
                q.lngB = newLng;

                q.markerB.setLatLng([newLat, newLng]);

                _thermUpdateGuideElements(id);
                _thermDrawOcclusion(id);
            });

            q.markerB.on('dragend', () => {
                _thermRenderCards();
            });
        } else {
            q.markerB.setLatLng(pointB);
        }

        _thermUpdateGuideElements(id);
    }
}

function _thermUpdateGuideElements(id) {
    const q = _thermQuestions.find((x) => x.id === id);
    if (!q || q.lat === null || q.latB === null) return;

    // Clear existing guide layers (circles and polylines)
        // Remove any previous guides marked as thermometer guides
        // If dragging, preserve the circle so the radius remains visible
        _thermRemoveGuideLayers(q, { preserveCircle: !!q && !!q._thermIsDragging });

    const center = L.latLng(q.lat, q.lng);
    // If a guide circle already exists (and was preserved during drag), update it
    let existingCircle = null;
    if (Array.isArray(q.layers)) {
        for (let i = 0; i < q.layers.length; i++) {
            const l = q.layers[i];
            if (l && l instanceof L.Circle && l._isThermGuide) {
                existingCircle = l;
                break;
            }
        }
    }

    if (existingCircle) {
        existingCircle.setLatLng(center);
        existingCircle.setRadius(q.dist * 1000);
    } else {
        const circle = L.circle(center, {
            radius: q.dist * 1000,
            color: '#8b949e',
            weight: 2,
            dashArray: '8 4',
            fill: false,
            interactive: false,
        }).addTo(map);
        circle._isThermGuide = true;
        q.layers.push(circle);
    }

    const bis = _thermBisector(q);
    if (!bis) return;
    const tMax = _thermBisectorSpan(bis);

    // Only draw the bisector line when not actively dragging
    if (!q._thermIsDragging) {
        const line = L.polyline(_thermBisectorLine(bis, tMax), {
            color: '#8b949e',
            weight: 2,
            dashArray: '4 4',
            interactive: false,
        }).addTo(map);
        line._isThermGuide = true;
        q.layers.push(line);
    }
}

function _thermClearLayers(q) {
    q.layers.forEach((l) => map.removeLayer(l));
    q.layers = [];
    q.markerA = null;
    q.markerB = null;
}


// ── Occlusion Logic ────────────────────────────────────────────────────────────

function _thermDrawOcclusion(id) {
    const q = _thermQuestions.find((x) => x.id === id);
    if (!q || q.lat === null || q.latB === null || !q.answer) return;

    if (q.maskLayer) {
        map.removeLayer(q.maskLayer);
        q.maskLayer = null;
    }

    const bis = _thermBisector(q);
    if (!bis) return;
    let wedgeB = turf.polygon([_thermMaskRing(bis, _thermBisectorSpan(bis))]);

    // Clip to Game Area if active to ensure we only shade the playable region
    if (gameZoneActive()) {
        const gzFeatures = Object.values(gzItems).map(i => i.feature);
        if (gzFeatures.length > 0) {
            let gameZoneGeom = gzFeatures[0];
            for (let i = 1; i < gzFeatures.length; i++) {
                gameZoneGeom = turf.union(gameZoneGeom, gzFeatures[i]);
            }
            wedgeB = turf.intersect(wedgeB, gameZoneGeom);
        }
    }

    if (!wedgeB) return;

    if (q.answer === 'hotter') {
        // Hotter: hider is closer to B. Keep B visible, shade A.
        q.maskLayer = createOcclusionLayer(wedgeB, { invert: true }).addTo(map);
    } else {
        // Colder: hider is closer to A. Keep A visible, shade B.
        q.maskLayer = createOcclusionLayer(wedgeB).addTo(map);
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

function thermConfirm(id) {
    const q = _thermQuestions.find((x) => x.id === id);
    if (!q) return;

    // Remove markers
    if (q.markerA) map.removeLayer(q.markerA);
    if (q.markerB) map.removeLayer(q.markerB);

    // Remove guide circles and lines
    q.layers.forEach((l) => map.removeLayer(l));
    q.layers = [];

    // Mark as confirmed to hide editing controls in render
    q.confirmed = true;

    _thermRenderCards();
    setStatus(`Thermometer ${id} confirmed`, 'ok');
}

// ── Public API ────────────────────────────────────────────────────────────────

function addThermometerQuestion() {
    const id = _thermNextId++;
    _thermQuestions.push({
        id,
        dist: 1,
        lat: null,
        lng: null,
        latB: null,
        lngB: null,
        answer: null,
        layers: [],
        maskLayer: null
    });
    _thermRenderCards();
}

function removeThermometerQuestion(id) {
    const idx = _thermQuestions.findIndex((x) => x.id === id);
    if (idx === -1) return;
    _thermClearLayers(_thermQuestions[idx]);
    if (_thermQuestions[idx].maskLayer) map.removeLayer(_thermQuestions[idx].maskLayer);
    _thermQuestions.splice(idx, 1);
    _thermRenderCards();
}

function clearAllThermometerQuestions() {
    _thermQuestions.forEach((q) => {
        _thermClearLayers(q);
        if (q.maskLayer) map.removeLayer(q.maskLayer);
    });
    _thermQuestions.length = 0;
    _thermRenderCards();
}

function thermSetDist(id, val) {
    const q = _thermQuestions.find((x) => x.id === id);
    if (!q) return;
    q.dist = parseFloat(val) || 1;
    _thermDrawGuide(id);
    _thermDrawOcclusion(id);
}

function thermStartPickA(id) {
    _thermPickingId = id;
    _thermPickingStage = 'A';
    document.getElementById(`therm-pick-a-${id}`)?.classList.add('meas-active');
    setStatus(t('matching_pick'), 'loading');
    closeSidebarForPick();
}

function thermStartPickB(id) {
    const q = _thermQuestions.find((x) => x.id === id);
    if (!q || q.lat === null) {
        setStatus('Set point A first', 'error');
        return;
    }
    _thermPickingId = id;
    _thermPickingStage = 'B';
    document.getElementById(`therm-pick-b-${id}`)?.classList.add('meas-active');
    setStatus('Pick point B on the circle', 'loading');
    closeSidebarForPick();
}

function thermUseGeo(id) {
    const q = _thermQuestions.find((x) => x.id === id);
    if (!q) return;
    if (!geoMarker) {
        setStatus(t('status_rq_no_geo'), 'error');
        return;
    }
    const c = geoMarker.getLatLng();
    if (_thermPickingStage === 'A') {
        _thermSetPointA(q, c.lat, c.lng, id);
    } else {
        _thermSetPointB(q, c.lat, c.lng);
    }
    _thermRenderCards();
    _thermDrawGuide(id);
    _thermDrawOcclusion(id);
}

// Copy a plain-language version of the question, e.g.
// "Thermometer: After travelling from (13.40500, 52.52000) to (13.45000, 52.54000)
//  are we hotter or colder?".
function thermAskQuestion(id) {
    const q = _thermQuestions.find((x) => x.id === id);
    if (!q) return;
    if (q.lat === null || q.lng === null) {
        setStatus('Set point A first', 'error');
        return;
    }
    if (q.latB === null || q.lngB === null) {
        setStatus('Set point B first', 'error');
        return;
    }
    const text = tf(
        'therm_question',
        q.lng.toFixed(5),
        q.lat.toFixed(5),
        q.lngB.toFixed(5),
        q.latB.toFixed(5),
    );
    copyText(text, (ok) =>
        setStatus(ok ? tf('status_ask_copied', text) : t('status_ask_copy_failed'), ok ? 'ok' : 'error'),
    );
}

function thermSetAnswer(id, ans) {
    const q = _thermQuestions.find((x) => x.id === id);
    if (!q) return;
    q.answer = ans;
    _thermRenderCards();
    _thermDrawOcclusion(id);
}

function _thermSetPointA(q, lat, lng, id) {
    q.lat = lat;
    q.lng = lng;

    // Automatically initialize Point B at a 45-degree angle from Point A.
    const b = _thermDestination({ lat, lng }, Math.PI / 4, q.dist);
    q.latB = b.lat;
    q.lngB = b.lng;

    _thermRenderCards();
    _thermDrawGuide(id);
    _thermDrawOcclusion(id);
}

// ── Map click hook ────────────────────────────────────────────────────────────
addMapClickHook((e) => {
    if (_thermPickingId === null) return false;
    const id = _thermPickingId;
    _thermPickingId = null;
    const q = _thermQuestions.find((x) => x.id === id);
    if (!q) return false;

    if (_thermPickingStage === 'A') {
        _thermSetPointA(q, e.latlng.lat, e.latlng.lng, id);
    } else {
        // Snap to the circle of radius q.dist, measured on the ground.
        _thermSetPointB(q, e.latlng.lat, e.latlng.lng);
    }

    _thermRenderCards();
    _thermDrawGuide(id);
    _thermDrawOcclusion(id);
    return true;
});

function _thermRenderCards() {
    const el = document.getElementById('thermCards');
    if (!el) return;

    el.innerHTML = _thermQuestions
        .map((q, i) => {
            if (q.confirmed) {
                return `<div class="tent-card" id="therm-${q.id}" style="opacity:0.8; background:#161b22">
                    <div class="tent-card-hdr">
                        <span class="tent-card-title">${tf('THERM_CARD_TITLE', i + 1)} (Confirmed)</span>
                        <button class="ghost tent-card-del" onclick="removeThermometerQuestion(${q.id})" title="Remove">✕</button>
                    </div>
                </div>`;
            }


            return `
<div class="tent-card" id="therm-${q.id}">
  <div class="tent-card-hdr">
    <span class="tent-card-title">${tf('THERM_CARD_TITLE', i + 1)}</span>
    <div style="display:flex; gap:4px">
        <button class="ghost tent-card-del" onclick="removeThermometerQuestion(${q.id})" title="Remove">✕</button>
        <button class="ghost" style="font-size:10px; padding: 2px 4px" onclick="thermConfirm(${q.id})">Confirm</button>
    </div>
  </div>
  <div class="row" style="margin-bottom:6px">
    <input type="number" value="${q.dist}" min="0.1" step="0.1" style="max-width:70px"
      onchange="thermSetDist(${q.id}, this.value)">
    <span style="color:#8b949e;font-size:12px">km distance</span>
  </div>
  <div class="row" style="margin-bottom:6px">
    <button id="therm-pick-a-${q.id}" class="tent-pick-btn" style="flex:1" onclick="thermStartPickA(${q.id})">${t('matching_pick')}</button>
    <button class="tent-pick-btn" style="flex:1" onclick="thermUseGeo(${q.id})" title="${t('rq_geo_title')}">🎯</button>
  </div>
  <div class="row" style="margin-bottom:6px">
    <button id="therm-pick-b-${q.id}" class="tent-pick-btn" style="width:100%" onclick="thermStartPickB(${q.id})">
      Set second point (exactly ${q.dist}km away)
    </button>
  </div>
  <div style="margin-bottom:6px">
    <button class="ghost" style="width:100%;font-size:11px" onclick="thermAskQuestion(${q.id})">${t('btn_ask_question')}</button>
  </div>
  <div style="display:flex; gap:6px">
    <button class="${q.answer === 'hotter' ? '' : 'ghost'}" style="flex:1; font-size:12px" onclick="thermSetAnswer(${q.id}, 'hotter')">Hotter</button>
    <button class="${q.answer === 'colder' ? '' : 'ghost'}" style="flex:1; font-size:12px" onclick="thermSetAnswer(${q.id}, 'colder')">Colder</button>
  </div>
</div>`;
        })
        .join('');
}

// ── Game-state export / restore ───────────────────────────────────────────────
// Distances are stored in km, like the rest of the app.
function thermExportState() {
    return _thermQuestions.map((q) => ({
        dist: q.dist,
        lat: q.lat,
        lng: q.lng,
        latB: q.latB,
        lngB: q.lngB,
        answer: q.answer,
        confirmed: q.confirmed,
    }));
}

function thermImportState(list) {
    if (!Array.isArray(list)) return;
    clearAllThermometerQuestions();

    for (const s of list) {
        const id = _thermNextId++;
        const num = (v) => (typeof v === 'number' ? v : null);
        const q = {
            id,
            dist: Number(s.dist) > 0 ? Number(s.dist) : 1,
            lat: num(s.lat),
            lng: num(s.lng),
            latB: num(s.latB),
            lngB: num(s.lngB),
            answer: s.answer === 'hotter' || s.answer === 'colder' ? s.answer : null,
            layers: [],
            maskLayer: null,
            markerA: null,
            markerB: null,
            confirmed: false,
        };
        _thermQuestions.push(q);
        _thermRenderCards();

        if (q.lat !== null && q.lng !== null) {
            _thermDrawGuide(id);
            if (q.latB !== null && q.lngB !== null) _thermDrawOcclusion(id);
        }
        if (s.confirmed) thermConfirm(id);
    }
    _thermRenderCards();
}
