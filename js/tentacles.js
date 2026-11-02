'use strict';

// ── Module state ──────────────────────────────────────────────────────────────
let _tentQuestions = [];
let _tentNextId = 1;
let _tentPickingId = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function _tentKm(q) {
    return q.unit === 'mi' ? q.radius * 1.60934 : q.radius;
}

// ── Map click hook for center-point picking ───────────────────────────────────
addMapClickHook((e) => {
    if (_tentPickingId === null) return false;
    const id = _tentPickingId;
    _tentPickingId = null;
    const q = _tentQuestions.find((x) => x.id === id);
    if (!q) return false;
    if (q.confirmed) return setStatus(t('status_locked') || 'Question is confirmed', 'error');
    q.centerLat = e.latlng.lat;
    q.centerLng = e.latlng.lng;

    const coordEl = document.getElementById(`tent-coord-${id}`);
    if (coordEl) coordEl.textContent = `${q.centerLat.toFixed(5)}° N  ${q.centerLng.toFixed(5)}° E`;

    document.getElementById(`tent-pick-btn-${id}`)?.classList.remove('meas-active');
    setStatus('', '');
    _tentFetchPOIs(id);
    // create draggable marker immediately so user can fine-tune
    _tentCreateDraggableMarker(q, id);
    return true;
});

// ── Fetch POIs from cache ──────────────────────────────────────────────────
async function _tentFetchPOIs(id) {
    const q = _tentQuestions.find((x) => x.id === id);
    if (!q || q.centerLat === null || !q.poiLayerId) return;

    const radiusKm = _tentKm(q);
    const data = layerDataCache[q.poiLayerId];

    const sel = document.getElementById(`tent-poi-select-${id}`);
    if (sel) {
        sel.innerHTML = `<option>${t('tent_loading')}</option>`;
        sel.disabled = true;
    }

    const label = LAYER_DEFS[q.poiLayerId]?.label;
    setStatus(tf('tent_status_loading', t(label)), 'loading');

    if (!data || !data.elements) {
        if (sel) {
            sel.innerHTML = `<option value="">${t('tent_error')}</option>`;
            sel.disabled = false;
        }
        setStatus('Layer not cached', 'error');
        return;
    }

    try {
        const raw = data.elements
            .map((el) => {
                const c = getElementCenter(el);
                if (!c) return null;
                return { name: el.tags?.name ?? '?', lat: c.lat, lng: c.lng, id: el.id };
            })
            .filter(Boolean)
            .filter((p) => haversineKm({ lat: q.centerLat, lng: q.centerLng }, p) <= radiusKm);

        // Deduplicate by name (keep first occurrence, sorted alphabetically)
        const seen = new Set();
        q.fetchedPOIs = raw
            .filter((p) => {
                if (seen.has(p.name)) return false;
                seen.add(p.name);
                return true;
            })
            .sort((a, b) => a.name.localeCompare(b.name));

        // Keep the previous selection when it is still in range; otherwise use
        // the first in-range POI so the Voronoi and marker remain available.
        const previousPOIId = q.selectedPOI?.id;
        q.selectedPOI =
            q.fetchedPOIs.find((p) => p.id === previousPOIId) ?? q.fetchedPOIs[0] ?? null;

        if (sel) {
            sel.innerHTML =
                `<option value="">${t('tent_select_poi')}</option>` +
                q.fetchedPOIs
                    .map(
                        (p) =>
                            `<option value="${p.id}"${q.selectedPOI?.id === p.id ? ' selected' : ''}>${esc(p.name)}</option>`,
                    )
                    .join('');
            sel.disabled = false;
        }

        if (q.selectedPOI) _tentDraw(id);
        else _tentClearLayers(q, { preserveMarker: true });

        setStatus(
            tf('tent_status_found', q.fetchedPOIs.length, t(label)),
            'ok',
        );
        updatePermalink();
    } catch (err) {
        if (sel) {
            sel.innerHTML = `<option value="">${t('tent_error')}</option>`;
            sel.disabled = false;
        }
        showErrorPopup(err.message);
        setStatus('Error processing POIs', 'error');
    }
}

// Update the coordinate label in the tentacle card
function updateTentCoordLabel(id, latlng) {
    const el = document.querySelector('#tent-' + id + ' .tent-coord');
    if (el) el.textContent = `${latlng.lat.toFixed(5)}° N  ${latlng.lng.toFixed(5)}° E`;
}

// Create a draggable marker for a tentacle question (or replace existing)
function _tentCreateDraggableMarker(q, id) {
    if (!q) return;
    if (q.marker) {
        try { map.removeLayer(q.marker); } catch (e) {}
        q.marker = null;
    }
    q.marker = createDraggableMarker([q.centerLat, q.centerLng]).addTo(map);
    q.marker.on('drag', (e) => {
        const p = getMarkerPosition(e.target);
        updateTentCoordLabel(id, p);
    });
    q.marker.on('dragend', (e) => {
        const p = getMarkerPosition(e.target);
        q.centerLat = p.lat;
        q.centerLng = p.lng;
        _tentDraw(id);
        _tentFetchPOIs(id);
        updatePermalink();
    });
}

// ── Geodesically-correct Voronoi via equirectangular projection ───────────────
function _tentProjectedVoronoi(pois, centerLat, centerLng, radiusKm) {
    const KM_PER_DEG = 111;
    const cosLat = Math.cos((centerLat * Math.PI) / 180);

    // Project each POI to local km plane centered on (centerLat, centerLng)
    const proj = pois.map((p) => ({
        id: p.id,
        px: (p.lng - centerLng) * cosLat * KM_PER_DEG,
        py: (p.lat - centerLat) * KM_PER_DEG,
    }));

    const turfPts = turf.featureCollection(proj.map((p) => turf.point([p.px, p.py], { id: p.id })));

    const ext = radiusKm * 2.5;
    const voronoi = turf.voronoi(turfPts, { bbox: [-ext, -ext, ext, ext] });
    if (!voronoi?.features) return null;

    // Reproject polygon vertices back to lat/lng
    return turf.featureCollection(
        voronoi.features
            .map((f) => {
                if (!f?.geometry?.coordinates) return null;
                return turf.polygon(
                    f.geometry.coordinates.map((ring) =>
                        ring.map(([px, py]) => [
                            centerLng + px / (cosLat * KM_PER_DEG),
                            centerLat + py / KM_PER_DEG,
                        ]),
                    ),
                    f.properties,
                );
            })
            .filter(Boolean),
    );
}

// ── Compute Voronoi and draw tentacle polygon ─────────────────────────────────
async function _tentDraw(id) {
    const q = _tentQuestions.find((x) => x.id === id);
    if (!q || !q.selectedPOI || q.fetchedPOIs.length === 0) return;

    _tentClearLayers(q, { preserveMarker: true });

    const radiusKm = _tentKm(q);
    const circle = turf.circle([q.centerLng, q.centerLat], radiusKm, {
        units: 'kilometers',
        steps: 128,
    });

    if (q.confirmed) {
        // Confirmed: Shade everything except the selected cell
        const voronoi = _tentProjectedVoronoi(q.fetchedPOIs, q.centerLat, q.centerLng, radiusKm);
        if (voronoi?.features?.length) {
            const selIdx = q.fetchedPOIs.findIndex((p) => p.id === q.selectedPOI.id);
            const selectedCell = voronoi.features[selIdx];
            if (selectedCell) {
                const clipped = turf.intersect(selectedCell, circle);
                if (clipped) {
                    q.layers.push(createOcclusionLayer(clipped, { invert: true }).addTo(map));
                }
            }
        }
    } else if (q.fetchedPOIs.length === 1) {
        // Only one POI in radius → the entire circle belongs to it
        q.layers.push(
            L.geoJSON(circle, {
                style: { color: '#3b82f6', weight: 2.5, fillColor: '#3b82f6', fillOpacity: 0.18 },
            }).addTo(map),
        );
    } else {
        const voronoi = _tentProjectedVoronoi(q.fetchedPOIs, q.centerLat, q.centerLng, radiusKm);
        if (!voronoi?.features?.length) return;

        const selIdx = q.fetchedPOIs.findIndex((p) => p.id === q.selectedPOI.id);

        voronoi.features.forEach((cell, i) => {
            if (!cell) return;
            let clipped = null;
            try {
                clipped = turf.intersect(cell, circle);
            } catch {
                return;
            }
            if (!clipped) return;

            const isSel = i === selIdx;
            q.layers.push(
                L.geoJSON(clipped, {
                    style: {
                        color: isSel ? '#3b82f6' : '#ef4444',
                        weight: isSel ? 2.5 : 1.5,
                        fillColor: isSel ? '#3b82f6' : '#ef4444',
                        fillOpacity: isSel ? 0.18 : 0.12,
                        dashArray: isSel ? undefined : '6 4',
                    },
                }).addTo(map),
            );
        });
    }

    // Keep a draggable center marker above the Voronoi and POI layers.
    if (!q.confirmed) {
        if (!q.marker && q.centerLat !== null) _tentCreateDraggableMarker(q, id);
        q.marker?.setZIndexOffset(1000);

        // POI markers
        const def = LAYER_DEFS[q.poiLayerId];
        const icon = def?.icon ?? '📍';
        q.fetchedPOIs.forEach((p) => {
            const isSel = p.id === q.selectedPOI?.id;
            q.layers.push(
                L.circleMarker([p.lat, p.lng], {
                    radius: isSel ? 8 : 5,
                    color: '#fff',
                    fillColor: isSel ? '#3b82f6' : '#6b7280',
                    fillOpacity: 0.9,
                    weight: 2,
                })
                    .bindPopup(`<div class="popup-name">${icon} ${esc(p.name)}</div>`)
                    .addTo(map),
            );
        });
    }
}

// ── Clear all map layers for a question ───────────────────────────────────────
function _tentClearLayers(q, { preserveMarker = false } = {}) {
    q.layers.forEach((l) => map.removeLayer(l));
    q.layers = [];
    if (q.marker && !preserveMarker) {
        try { map.removeLayer(q.marker); } catch (e) {}
        q.marker = null;
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

function addTentacleQuestion() {
    const id = _tentNextId++;
    _tentQuestions.push({
        id,
        radius: 15,
        unit: 'km',
        poiLayerId: null,
        centerLat: null,
        centerLng: null,
        selectedPOI: null,
        fetchedPOIs: [],
        layers: [],
        marker: null,
        confirmed: false,
    });
    _tentRenderCards();
}

function removeTentacleQuestion(id) {
    const idx = _tentQuestions.findIndex((x) => x.id === id);
    if (idx === -1) return;
    _tentClearLayers(_tentQuestions[idx]);
    _tentQuestions.splice(idx, 1);
    _tentRenderCards();
    updatePermalink();
}

function clearAllTentacles() {
    _tentQuestions.forEach(_tentClearLayers);
    _tentQuestions.length = 0;
    _tentRenderCards();
    updatePermalink();
}

function tentSetRadius(id, val) {
    const q = _tentQuestions.find((x) => x.id === id);
    if (!q) return;
    q.radius = parseFloat(val) || 15;
    q.confirmed = false;
    if (q.centerLat !== null) _tentFetchPOIs(id);
}

function tentSetUnit(id, unit) {
    const q = _tentQuestions.find((x) => x.id === id);
    if (!q) return;
    q.unit = unit;
    q.confirmed = false;
    if (q.centerLat !== null) _tentFetchPOIs(id);
}

function tentSetLayer(id, layerId) {
    const q = _tentQuestions.find((x) => x.id === id);
    if (!q) return;
    q.poiLayerId = layerId || null;
    q.selectedPOI = null;
    q.fetchedPOIs = [];
    q.confirmed = false;
    _tentClearLayers(q, { preserveMarker: true });
    const sel = document.getElementById(`tent-poi-select-${id}`);
    if (sel) sel.innerHTML = `<option value="">${t('tent_select_poi')}</option>`;
    if (q.centerLat !== null) _tentFetchPOIs(id);
}

function tentConfirm(id) {
    const q = _tentQuestions.find((x) => x.id === id);
    if (!q) return;
    q.confirmed = !q.confirmed;
    // when confirming, remove draggable marker so only overlay remains
    if (q.confirmed && q.marker) {
        try { map.removeLayer(q.marker); } catch (e) {}
        q.marker = null;
    }
    _tentDraw(id);
    _tentRenderCards();
    updatePermalink();
}

function _tentSetCenter(q, lat, lng, id) {
    q.centerLat = lat;
    q.centerLng = lng;
    _tentRenderCards();
    _tentDraw(id);
    _tentFetchPOIs(id);
    updatePermalink();
}

function tentStartPick(id) {

    _tentPickingId = id;
    document.getElementById(`tent-pick-btn-${id}`)?.classList.add('meas-active');
    setStatus(t('tent_status_pick'), 'loading');
    closeSidebarForPick();
}

function tentUseGeo(id) {
    const q = _tentQuestions.find((x) => x.id === id);
    if (!q) return;
    if (!geoMarker) {
        setStatus(t('status_rq_no_geo'), 'error');
        return;
    }
    const c = geoMarker.getLatLng();
    _tentSetCenter(q, c.lat, c.lng, id);
}

function tentSelectPOI(id, val) {

    const q = _tentQuestions.find((x) => x.id === id);
    if (!q) return;
    q.selectedPOI = q.fetchedPOIs.find((p) => String(p.id) === String(val)) ?? null;
    if (q.selectedPOI) _tentDraw(id);
    else _tentClearLayers(q);
    updatePermalink();
}

// ── Permalink serialisation / restore ────────────────────────────────────────
function tentSerialise() {
    return _tentQuestions
        .filter((q) => q.centerLat !== null)
        .map((q) =>
            [
                q.poiLayerId,
                q.radius,
                q.unit,
                q.centerLat.toFixed(5),
                q.centerLng.toFixed(5),
                q.selectedPOI?.id ?? 0,
                q.confirmed ? '1' : '0',
            ].join(','),
        );
}

async function tentRestoreFromPermalink(params) {
    for (const s of params) {
        const parts = s.split(',');
        if (parts.length < 7) continue;
        const [poiLayerId, radiusStr, unit, latStr, lngStr, poiIdStr, confStr] = parts;
        if (!LAYER_DEFS[poiLayerId]) continue;
        const lat = parseFloat(latStr);
        const lng = parseFloat(lngStr);
        const radius = parseFloat(radiusStr);
        if (isNaN(lat) || isNaN(lng) || isNaN(radius)) continue;

        const id = _tentNextId++;
        _tentQuestions.push({
            id,
            radius,
            unit: unit === 'mi' ? 'mi' : 'km',
            poiLayerId,
            centerLat: lat,
            centerLng: lng,
            selectedPOI: null,
            fetchedPOIs: [],
            layers: [],
            confirmed: confStr === '1',
        });
        _tentRenderCards();
        await _tentFetchPOIs(id);

        const poiId = poiIdStr && poiIdStr !== '0' ? poiIdStr : null;
        if (poiId) tentSelectPOI(id, poiId);
    }
}

// ── Render question cards ─────────────────────────────────────────────────────
function _tentRenderCards() {
    const el = document.getElementById('tentacleCards');
    if (!el) return;

    el.innerHTML = _tentQuestions
        .map((q, i) => {
            const available = Object.keys(layerDataCache || {});
            const layerOpts = available
                .map((id) => {
                    const def = LAYER_DEFS[id];
                    const label = def ? t(def.label) : id;
                    return `<option value="${id}"${id === q.poiLayerId ? ' selected' : ''}>${esc(label)}</option>`;
                })
                .join('');

            const poiOpts = q.fetchedPOIs.length
                ? `<option value="">${t('tent_select')}</option>` +
                  q.fetchedPOIs
                      .map(
                          (p) =>
                              `<option value="${p.id}"${q.selectedPOI?.id === p.id ? ' selected' : ''}>${esc(p.name)}</option>`,
                      )
                      .join('')
                : `<option value="">${t('tent_select_poi')}</option>`;

                        const coordTxt =
                                q.centerLat !== null
                                        ? `${q.centerLat.toFixed(5)}° N  ${q.centerLng.toFixed(5)}° E`
                                        : t('tent_set_center');

                        if (q.confirmed) {
                                return `<div class="tent-card" id="tent-${q.id}" style="opacity:0.8; background:#161b22">
    <div class="tent-card-hdr">
        <span class="tent-card-title">${tf('tent_card_title', i + 1)}</span>
        <button class="ghost tent-card-del" onclick="removeTentacleQuestion(${q.id})" title="Remove">✕</button>
    </div>
</div>`;
                        }

                        return `
<div class="tent-card" id="tent-${q.id}">
        <div class="tent-card-hdr">
                <span class="tent-card-title">${tf('tent_card_title', i + 1)}</span>
                <div style="display:flex; gap:4px">
                                <button class="ghost tent-card-del" onclick="removeTentacleQuestion(${q.id})" title="Remove">✕</button>
                                <button class="ghost" style="font-size:10px; padding:2px 4px" onclick="tentConfirm(${q.id})">Confirm</button>
                </div>
        </div>
    <div class="row" style="margin-bottom:6px">
        <input type="number" value="${q.radius}" min="1" max="9999" step="1" style="max-width:70px"
            onchange="tentSetRadius(${q.id}, this.value)">
        <select style="flex:1" onchange="tentSetUnit(${q.id}, this.value)">
            <option value="km"${q.unit === 'km' ? ' selected' : ''}>${t('tent_kilometers')}</option>
            <option value="mi"${q.unit === 'mi' ? ' selected' : ''}>${t('tent_miles')}</option>
        </select>
    </div>
    <select style="margin-bottom:6px" onchange="tentSetLayer(${q.id}, this.value)">
        <option value="">${t('matching_choose_layer') || 'Choose layer...'}</option>
        ${layerOpts}
    </select>
        <div class="row" style="margin-bottom:6px">
                <button id="tent-pick-btn-${q.id}" class="tent-pick-btn" style="flex:1" onclick="tentStartPick(${q.id})">
                        ${t('tent_location_btn')}
                </button>
                <button class="tent-pick-btn" style="flex:1" onclick="tentUseGeo(${q.id})" title="${t('rq_geo_title')}">🎯</button>
        </div>
        <select id="tent-poi-select-${q.id}" onchange="tentSelectPOI(${q.id}, this.value)">
                ${poiOpts}
        </select>
</div>`;
        })
        .join('');
}
