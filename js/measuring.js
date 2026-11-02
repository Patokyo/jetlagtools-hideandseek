'use strict';

// Measuring questions: "Compared to me, are you closer to or further from [POI layer]?"
// Seeker is at S. POI layer is set P.
// Seeker's distance to layer: d(S, P) = min_{p in P} dist(S, p).
// Hider is at H. Hider's distance to layer: d(H, P) = min_{p in P} dist(H, p).
// "Closer": d(H, P) < d(S, P). Possible region is union of circles of radius d(S, P) around all p in P.
// "Further": d(H, P) > d(S, P). Possible region is complement of that union.

let _measQuestions = [];
let _measNextId = 1;
let _measPickingId = null;

// Map click hook for measuring picker
addMapClickHook((e) => {
    if (_measPickingId === null) return false;
    const id = _measPickingId;
    _measPickingId = null;
    const q = _measQuestions.find((x) => x.id === id);
    if (!q) return false;

    if (q.confirmed) {
        setStatus(t('status_locked') || 'Question is confirmed', 'error');
        return false;
    }

    q.lat = e.latlng.lat;
    q.lng = e.latlng.lng;

    const coordEl = document.getElementById(`meas-coord-${id}`);
    if (coordEl) coordEl.textContent = `${q.lat.toFixed(5)}° N  ${q.lng.toFixed(5)}° E`;

    document.getElementById(`meas-pick-btn-${id}`)?.classList.remove('meas-active');
    setStatus('', '');

    // Create draggable marker immediately so users can refine the picked location
    _measCreateDraggableMarker(q, id);

    // Auto-run if we have a selected layer
    if (q.layerId) measRun(id);
    return true;
});

function _measClearLayers(q) {
    if (!q) return;
    if (q.maskLayer) {
        map.removeLayer(q.maskLayer);
        q.maskLayer = null;
    }
}

function _measCreateDraggableMarker(q, id) {
    if (!q) return;
    if (q.marker) {
        try { map.removeLayer(q.marker); } catch (e) {}
        q.marker = null;
    }

    q.marker = createDraggableMarker([q.lat, q.lng]).addTo(map);

    q.marker.on('drag', (e) => {
        const pos = getMarkerPosition(e.target);
        const coordEl = document.getElementById(`meas-coord-${id}`);
        if (coordEl) coordEl.textContent = `${pos.lat.toFixed(5)}° N  ${pos.lng.toFixed(5)}° E`;
    });
    q.marker.on('dragend', (e) => {
        const pos = getMarkerPosition(e.target);
        q.lat = pos.lat;
        q.lng = pos.lng;
        const coordEl = document.getElementById(`meas-coord-${id}`);
        if (coordEl) coordEl.textContent = `${q.lat.toFixed(5)}° N  ${q.lng.toFixed(5)}° E`;
        measRun(id);
    });
}

function addMeasuringQuestion() {
    const id = _measNextId++;
    _measQuestions.push({
        id,
        layerId: null,
        lat: null,
        lng: null,
        answer: null, // 'closer' or 'further'
        maskLayer: null,
        marker: null,
        confirmed: false
    });
    _measRenderCards();
}

function measRemoveQuestion(id) {
    const idx = _measQuestions.findIndex((x) => x.id === id);
    if (idx === -1) return;
    // remove mask and marker (marker not removed by _measClearLayers)
    const q = _measQuestions[idx];
    if (q.marker) {
        try { map.removeLayer(q.marker); } catch (e) {}
        q.marker = null;
    }
    _measClearLayers(q);
    _measQuestions.splice(idx, 1);
    _measRenderCards();
}

function clearAllMeasuringQuestions() {
    _measQuestions.forEach((q) => {
        if (q.marker) {
            try { map.removeLayer(q.marker); } catch (e) {}
            q.marker = null;
        }
        _measClearLayers(q);
    });
    _measQuestions.length = 0;
    _measRenderCards();
}

function measStartPick(id) {
    const q = _measQuestions.find((x) => x.id === id);
    if (!q || q.confirmed) return setStatus(t('status_locked') || 'Question is confirmed', 'error');
    _measPickingId = id;
    document.getElementById(`meas-pick-btn-${id}`)?.classList.add('meas-active');
    setStatus(t('matching_pick'), 'loading');
    closeSidebarForPick();
}

function measUseGeo(id) {
    const q = _measQuestions.find((x) => x.id === id);
    if (!q) return;
    if (q.confirmed) return setStatus(t('status_locked') || 'Question is confirmed', 'error');
    if (!geoMarker) {
        setStatus(t('status_rq_no_geo'), 'error');
        return;
    }
    const c = geoMarker.getLatLng();
    q.lat = c.lat;
    q.lng = c.lng;

    const coordEl = document.getElementById(`meas-coord-${id}`);
    if (coordEl) coordEl.textContent = `${q.lat.toFixed(5)}° N  ${q.lng.toFixed(5)}° E`;

    _measRenderCards();
    // Create draggable marker immediately so users can refine the picked location
    _measCreateDraggableMarker(q, id);
    measRun(id);
}

function measSetLayer(id, layerId) {
    const q = _measQuestions.find((x) => x.id === id);
    if (!q) return;
    if (q.confirmed) return;
    q.layerId = layerId || null;
    _measClearLayers(q);
    _measRenderCards();
    if (q.lat !== null) measRun(id);
}

function measSetAnswer(id, answer) {
    const q = _measQuestions.find((x) => x.id === id);
    if (!q) return;
    if (q.confirmed) return;
    q.answer = answer;
    _measRenderCards();
    measRun(id);
}

function measConfirm(id) {
    const q = _measQuestions.find((x) => x.id === id);
    if (!q) return;

    // Remove interactive marker
    if (q.marker) {
        try { map.removeLayer(q.marker); } catch (e) {}
        q.marker = null;
    }
    // Keep maskLayer but remove transient layers (none here)
    q.confirmed = true;
    _measRenderCards();
    setStatus(`Measuring ${id} confirmed`, 'ok');
}

function _measRenderCards() {
    const el = document.getElementById('measCards');
    if (!el) return;

    el.innerHTML = _measQuestions
        .map((q, i) => {
            if (q.confirmed) {
                return `<div class="tent-card" id="meas-${q.id}" style="opacity:0.8; background:#161b22">
                    <div class="tent-card-hdr">
                        <span class="tent-card-title">${tf('MEASURING_CARD_TITLE', i + 1)} (Confirmed)</span>
                        <button class="ghost tent-card-del" onclick="measRemoveQuestion(${q.id})" title="Remove">✕</button>
                    </div>
                </div>`;
            }
            const available = Object.keys(layerDataCache || {});
            const layerOpts = available
                .map((id) => {
                    const def = LAYER_DEFS[id];
                    const label = def ? t(def.label) : id;
                    return `<option value="${id}"${id === q.layerId ? ' selected' : ''}>${esc(label)}</option>`;
                })
                .join('');

            const coordTxt = q.lat !== null ? `${q.lat.toFixed(5)}° N  ${q.lng.toFixed(5)}° E` : t('matching_pick');

            return `
<div class="tent-card" id="meas-${q.id}">
  <div class="tent-card-hdr">
        <span class="tent-card-title">${tf('MEASURING_CARD_TITLE', i + 1)}</span>
        <div style="display:flex; gap:4px">
                <button class="ghost tent-card-del" onclick="measRemoveQuestion(${q.id})" title="Remove">✕</button>
                ${q.confirmed ? `<button class="ghost" style="font-size:10px; padding: 2px 4px" disabled>Confirmed</button>` : `<button class="ghost" style="font-size:10px; padding: 2px 4px" onclick="measConfirm(${q.id})">Confirm</button>`}
        </div>
  </div>
  <select onchange="measSetLayer(${q.id}, this.value)">
    <option value="">${t('matching_choose_layer')}</option>
    ${layerOpts}
  </select>
  <div class="row" style="margin-bottom:6px">
    <button id="meas-pick-btn-${q.id}" class="tent-pick-btn" style="margin-bottom:0" onclick="measStartPick(${q.id})">${t('matching_pick')}</button>
    <button class="tent-pick-btn" style="margin-bottom:0" onclick="measUseGeo(${q.id})" title="${t('rq_geo_title')}">🎯</button>
  </div>
  <div id="meas-coord-${q.id}" class="tent-coord">${esc(coordTxt)}</div>
  <div style="margin-top:6px; font-size:12px; color:#8b949e" id="meas-dist-${q.id}"></div>
  <div style="display:flex; gap:6px; margin-top:6px">
    <button id="meas-closer-${q.id}" class="${q.answer === 'closer' ? '' : 'ghost'}" style="flex:1; font-size:12px" onclick="measSetAnswer(${q.id}, 'closer')">Closer</button>
    <button id="meas-further-${q.id}" class="${q.answer === 'further' ? '' : 'ghost'}" style="flex:1; font-size:12px" onclick="measSetAnswer(${q.id}, 'further')">Further</button>
  </div>
</div>`;
        })
        .join('');
}

async function measRun(id) {
    const q = _measQuestions.find((x) => x.id === id);
    if (!q) return;
    if (q.confirmed) {
        setStatus(t('status_locked') || 'Question is confirmed', 'info');
        return;
    }
    _measClearLayers(q);
    if (!q.layerId) return;
    if (q.lat === null || q.lng === null) return;

    const data = layerDataCache[q.layerId];
    if (!data || !data.elements || data.elements.length === 0) {
        setStatus(t('matching_no_layers'), 'error');
        return;
    }

    const pois = data.elements
        .map((el) => {
            const c = getElementCenter(el);
            if (!c) return null;
            return { id: el.id, lat: c.lat, lng: c.lng };
        })
        .filter(Boolean);

    if (pois.length === 0) return;

    // Find distance to closest POI
    let minDist = Infinity;
    pois.forEach((p) => {
        const d = haversineKm({ lat: q.lat, lng: q.lng }, p);
        if (d < minDist) minDist = d;
    });

    const distEl = document.getElementById(`meas-dist-${id}`);
    if (distEl) {
        const v = units === 'imperial' ? minDist * 0.621371 : minDist;
        const unit = units === 'imperial' ? 'mi' : 'km';
        const layerLabel = LAYER_DEFS[q.layerId] ? t(LAYER_DEFS[q.layerId].label) : 'POI';
        distEl.textContent = `Closest ${layerLabel}: ${v.toFixed(2)} ${unit}`;
    }

    if (!q.answer) return;

    // Create union of circles of radius minDist
    let unionPoly = null;
    pois.forEach((p) => {
        const circle = turf.circle([p.lng, p.lat], minDist, { units: 'kilometers' });
        if (!unionPoly) {
            unionPoly = circle;
        } else {
            try {
                unionPoly = turf.union(unionPoly, circle);
            } catch (e) {
                console.error('Measuring: turf.union failed', e);
            }
        }
    });

    if (!unionPoly) return;

    if (q.answer === 'closer') {
        // Closer: Possible is inside the union. Shade everything else.
        q.maskLayer = createOcclusionLayer(unionPoly, { invert: true }).addTo(map);
    } else {
        // Further: Possible is outside the union. Shade the union.
        q.maskLayer = createOcclusionLayer(unionPoly).addTo(map);
    }

    setStatus(t('status_ready'), 'ok');
}
