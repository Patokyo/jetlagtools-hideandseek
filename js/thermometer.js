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

function _thermGetWorldRect() {
    // A large enough rectangle to cover the playable map area
    return turf.polygon([[
        [-180, -89.9],
        [180, -89.9],
        [180, 89.9],
        [-180, 89.9],
        [-180, -89.9]
    ]]);
}

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

/**
 * Creates a half-plane polygon.
 * A and B are [lng, lat].
 * If invert=false, returns polygon containing B (closer to B).
 * If invert=true, returns polygon containing A (closer to A).
 */
function _thermCreateHalfPlane(A, B, invert = false) {
    const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];

    // Perpendicular vector
    const px = -dy;
    const py = dx;

    // We create a very large polygon that acts as a half-plane.
    // Start at midpoint, go far along perpendicular, then far along the line, then far back.
    const scale = 1000; // degrees
    const p1 = [mid[0] + px * scale, mid[1] + py * scale];
    const p2 = [mid[0] + px * scale + dx * scale, mid[1] + py * scale + dy * scale];
    const p3 = [mid[0] + dx * scale, mid[1] + dy * scale];
    const p4 = [mid[0] - px * scale - dx * scale, mid[1] - py * scale - dy * scale];
    const p5 = [mid[0] - px * scale, mid[1] - py * scale];

    // This is complex. Easier way:
    // Use the world rect and turf.intersect with a massive polygon that approximates the half-plane.
    const world = _thermGetWorldRect();

    // Construct a polygon that covers the side of the line.
    // We use the points A and B to define the line.
    // A half plane can be defined by 3 points: Mid, Mid + Perp, Mid + Perp + (B-A)*Large
    const halfPlane = turf.polygon([[
        mid,
        [mid[0] + px * scale, mid[1] + py * scale],
        [mid[0] + px * scale + dx * scale, mid[1] + py * scale + dy * scale],
        [B[0] + dx * scale, B[1] + dy * scale],
        [mid[0] + dx * scale, mid[1] + dy * scale],
        [mid[0] - px * scale, mid[1] - py * scale],
        mid
    ]]);
    // This is still a bit shaky. Let's use a simpler approach:
    // Since we only need it for occlusion, we can use a very large polygon
    // that definitely covers the intended side.
}

// Corrected half-plane:
function _thermCreateHalfPlaneFixed(A, B, invert = false) {
    const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const px = -dy;
    const py = dx;
    const scale = 1000;

    // Points for the half-plane containing B
    const points = [
        [mid[0], mid[1]],
        [mid[0] + px * scale, mid[1] + py * scale],
        [mid[0] + px * scale + dx * scale, mid[1] + py * scale + dy * scale],
        [mid[0] + dx * scale, mid[1] + dy * scale],
        [mid[0] - px * scale, mid[1] - py * scale],
        [mid[0], mid[1]]
    ];

    // This is still not quite a half-plane.
    // a real half-plane is just a polygon with 3 points at infinity.
    // Let's use the world rectangle and turf.intersect with a huge polygon.
    const bigPoly = turf.polygon([[
        [mid[0] - px * scale, mid[1] - py * scale],
        [mid[0] + px * scale, mid[1] + py * scale],
        [mid[0] + px * scale + dx * scale, mid[1] + py * scale + dy * scale],
        [mid[0] - px * scale + dx * scale, mid[1] - py * scale + dy * scale],
        [mid[0] - px * scale, mid[1] - py * scale]
    ]]);
    // Wait, if we just want to shade one side of the line, we can use L.polygon
    // with a very large area.
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

        q.markerA.on('drag', (e) => {
            const pos = getMarkerPosition(e.target);

            // If B exists, preserve its bearing relative to the old center and keep distance = q.dist
            if (q.latB !== null) {
                const oldLat = q.lat;
                const oldLng = q.lng;
                const angle = Math.atan2(q.latB - oldLat, q.lngB - oldLng);
                const distDeg = q.dist / 111;

                q.lat = pos.lat;
                q.lng = pos.lng;

                q.latB = q.lat + distDeg * Math.cos(angle);
                q.lngB = q.lng + (distDeg * Math.sin(angle)) / Math.cos(q.lat * Math.PI / 180);

                if (q.markerB) q.markerB.setLatLng([q.latB, q.lngB]);
            } else {
                // No B yet: just move A and initialize B at 45° as before
                q.lat = pos.lat;
                q.lng = pos.lng;
                const distDeg = q.dist / 111;
                const angle = Math.PI / 4;
                q.latB = q.lat + distDeg * Math.cos(angle);
                q.lngB = q.lng + (distDeg * Math.sin(angle)) / Math.cos(q.lat * Math.PI / 180);
                if (q.markerB) q.markerB.setLatLng([q.latB, q.lngB]);
            }

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
                updatePermalink();
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
                updatePermalink();
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

    // Mirror logic from _thermDrawOcclusion exactly
    const lngA = q.lng;
    const latA = q.lat;
    const lngB = q.lngB;
    const latB = q.latB;

    const midLng = (lngA + lngB) / 2;
    const midLat = (latA + latB) / 2;

    const dx = lngB - lngA;
    const dy = latB - latA;
    const px = -dy;
    const py = dx;

    const len = Math.sqrt(px * px + py * py);
    const uPx = len !== 0 ? px / len : 0;
    const uPy = len !== 0 ? py / len : 0;

    const scale = 0.5; // Sufficient to cover game zone without projection artifacts

    const p1 = [midLat + uPy * scale, midLng + uPx * scale];
    const p2 = [midLat - uPy * scale, midLng - uPx * scale];

    // Only draw the bisector line when not actively dragging
    if (!q._thermIsDragging) {
        const line = L.polyline([p1, p2], {
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

    // Use a robust planar approximation for the occlusion wedge.
    // Since this is clipped to the Game Zone (which is local), the planar
    // approximation is visually identical to the spherical one and avoids
    // the GeoJSON "world-wrap" glitches caused by sampling great circles.
    const A = [q.lng, q.lat];
    const B = [q.lngB, q.latB];
    const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];

    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const px = -dy;
    const py = dx;

    // Scale large enough to cover any reasonable game zone,
    // but not so large that it causes floating point issues.
    const scale = 1000;

    // Create a huge rectangle that covers the B-side of the bisector.
    // Points are ordered to ensure a consistent counter-clockwise winding.
    const polygonPts = [
        [mid[0] + px * scale, mid[1] + py * scale],                      // P1: on bisector
        [mid[0] + px * scale + dx * scale * 10, mid[1] + py * scale + dy * scale * 10], // P2: far B-side
        [mid[0] - px * scale + dx * scale * 10, mid[1] - py * scale + dy * scale * 10], // P3: far B-side
        [mid[0] - px * scale, mid[1] - py * scale],                      // P4: on bisector
        [mid[0] + px * scale, mid[1] + py * scale]                       // Close
    ];

    let wedgeB = turf.polygon([polygonPts]);

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
        // Snap to circle
        const dist = haversineKm([c.lat, c.lng], [q.lat, q.lng]);
        const angle = Math.atan2(c.lng - q.lng, c.lat - q.lat);
        // This is a rough approximation for snapping
        q.latB = c.lat;
        q.lngB = c.lng;
    }
    _thermRenderCards();
    _thermDrawGuide(id);
    _thermDrawOcclusion(id);
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

    // Automatically initialize Point B at a 45-degree angle from Point A
    const distDeg = q.dist / 111;
    const angle = Math.PI / 4; // 45 degrees
    q.latB = lat + distDeg * Math.cos(angle);
    q.lngB = lng + (distDeg * Math.sin(angle)) / Math.cos(lat * Math.PI / 180);

    _thermRenderCards();
    _thermDrawGuide(id);
    _thermDrawOcclusion(id);
    updatePermalink();
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
        // Snap to circle of radius q.dist
        const center = [q.lng, q.lat];
        const clicked = [e.latlng.lng, e.latlng.lat];
        const dx = clicked[0] - center[0];
        const dy = clicked[1] - center[1];
        const currentDist = Math.sqrt(dx * dx + dy * dy);

        // Roughly convert q.dist (km) to degrees (1 deg approx 111km)
        const targetDistDeg = q.dist / 111;
        const scale = targetDistDeg / currentDist;

        q.lngB = center[0] + dx * scale;
        q.latB = center[1] + dy * scale;
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

            const coordA = q.lat !== null ? `${q.lat.toFixed(5)}° N  ${q.lng.toFixed(5)}° E` : t('matching_pick');
            const coordB = q.latB !== null ? `${q.latB.toFixed(5)}° N  ${q.lngB.toFixed(5)}° E` : '– pick point B –';

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
  <div class="tent-coord" style="margin-bottom:4px">${esc(coordA)}</div>
  <div class="row" style="margin-bottom:6px">
    <button id="therm-pick-b-${q.id}" class="tent-pick-btn" style="width:100%" onclick="thermStartPickB(${q.id})">
      Set second point (exactly ${q.dist}km away)
    </button>
  </div>
  <div class="tent-coord" style="margin-bottom:8px">${esc(coordB)}</div>
  <div style="display:flex; gap:6px">
    <button class="${q.answer === 'hotter' ? '' : 'ghost'}" style="flex:1; font-size:12px" onclick="thermSetAnswer(${q.id}, 'hotter')">Hotter</button>
    <button class="${q.answer === 'colder' ? '' : 'ghost'}" style="flex:1; font-size:12px" onclick="thermSetAnswer(${q.id}, 'colder')">Colder</button>
  </div>
</div>`;
        })
        .join('');
}
