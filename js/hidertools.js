'use strict';

let _hiderSelectedLayer = null;
let _hiderRefPoint = null; // {lat, lng}
let _hiderMarker = null;
let _hiderZoneLayer = null;
let _hiderZoneOutlineLayer = null; // dotted boundary shown while the occlusion is hidden
let _hiderZoneData = null; // { lat, lng, radiusKm, stationName, occluded } — auto-saved
let _hiderStations = []; // [{ idx, name }] sorted alphabetically
let _hiderSelectedIdx = null; // index into layerDataCache.stations.elements
let _hiderHighlight = -1; // keyboard-highlighted row in the dropdown
let _hiderShowAll = true; // ignore the typed query (used when opening the list)

const HIDER_POI_MAX_RESULTS = 200;

function hiderUpdateLayerList() {
    const select = document.getElementById('hider-layer-select');
    if (!select) return;

    const available = Object.keys(layerDataCache);
    const options = available.map(id => {
        const def = LAYER_DEFS[id];
        const label = def ? t(def.label) : id;
        return `<option value="${id}">${label}</option>`;
    }).join('');

    const currentVal = select.value;
    select.innerHTML = `<option value="">-- Select Layer --</option>${options}`;
    select.value = currentVal;

    // Also ensure the station list is updated if the stations layer is cached
    hiderUpdatePoiList();
}

function hiderUpdatePoiList() {
    const poiInput = document.getElementById('hider-poi-search');
    if (!poiInput) return;

    // Cache the station list (sorted alphabetically) so the combobox can filter
    // it without re-scanning the layer every keystroke. `idx` keeps the original
    // position in layerDataCache.stations.elements, which hiderCreateZone() uses.
    // Cached elements are normalised: { type, name, lat, lng } with no OSM tags.
    _hiderStations = [];

    const layerId = 'stations';
    const data = layerDataCache[layerId];
    if (data && data.elements) {
        data.elements.forEach((el, idx) => {
            const center = getElementCenter(el);
            if (!center) return;
            const name = el.name || 'Unnamed Station';
            _hiderStations.push({ idx, name });
        });
        _hiderStations.sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
        );
    }

    // The layer data changed, so any previous pick is no longer reliable
    _hiderSelectedIdx = null;
    document.getElementById('hider-poi-select').value = '';
    poiInput.value = '';
    hiderClosePoiList();
}

// Stations matching the current query, plus the (lowercased) query itself
function hiderPoiMatches() {
    const query = _hiderShowAll
        ? ''
        : (document.getElementById('hider-poi-search')?.value ?? '').trim().toLowerCase();
    const matches = query
        ? _hiderStations.filter(s => s.name.toLowerCase().includes(query))
        : _hiderStations;
    return { query, matches };
}

function hiderRenderPoiList() {
    const panel = document.getElementById('hider-poi-list');
    if (!panel) return;

    const { query, matches } = hiderPoiMatches();
    panel.innerHTML = '';

    if (matches.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'hider-poi-empty';
        empty.textContent = _hiderStations.length === 0
            ? 'No stations loaded — enable the Stations layer first'
            : 'No matching stations';
        panel.appendChild(empty);
        return;
    }

    const shown = matches.slice(0, HIDER_POI_MAX_RESULTS);
    shown.forEach((s, i) => {
        const item = document.createElement('div');
        item.className = 'hider-poi-item' + (i === _hiderHighlight ? ' active' : '');
        item.textContent = s.name;
        item.setAttribute('role', 'option');
        item.onmousedown = (e) => {
            // Keep focus so the input's blur handler does not close the panel first
            e.preventDefault();
            hiderSelectPoi(s.idx);
        };
        panel.appendChild(item);
    });

    if (matches.length > shown.length) {
        const more = document.createElement('div');
        more.className = 'hider-poi-more';
        more.textContent = `… ${matches.length - shown.length} more — keep typing to narrow it down`;
        panel.appendChild(more);
    }
}

function hiderOpenPoiList() {
    const panel = document.getElementById('hider-poi-list');
    const poiInput = document.getElementById('hider-poi-search');
    if (!panel || !poiInput) return;

    // Re-opening after a pick shows every station again so another one can be chosen
    _hiderShowAll = _hiderSelectedIdx !== null || poiInput.value.trim() === '';
    _hiderHighlight = -1;
    hiderRenderPoiList();
    panel.hidden = false;
    poiInput.setAttribute('aria-expanded', 'true');
}

function hiderClosePoiList() {
    const panel = document.getElementById('hider-poi-list');
    const poiInput = document.getElementById('hider-poi-search');
    if (!panel) return;
    panel.hidden = true;
    _hiderHighlight = -1;
    poiInput?.setAttribute('aria-expanded', 'false');
}

function hiderFilterPoiList() {
    const panel = document.getElementById('hider-poi-list');
    if (!panel) return;

    _hiderShowAll = false;
    _hiderHighlight = -1;
    // Typing invalidates the current pick until an entry is chosen again
    _hiderSelectedIdx = null;
    document.getElementById('hider-poi-select').value = '';

    hiderRenderPoiList();
    panel.hidden = false;
    document.getElementById('hider-poi-search')?.setAttribute('aria-expanded', 'true');
}

function hiderSelectPoi(idx) {
    const station = _hiderStations.find(s => s.idx === Number(idx));
    if (!station) return;

    _hiderSelectedIdx = station.idx;
    document.getElementById('hider-poi-select').value = String(station.idx);
    document.getElementById('hider-poi-search').value = station.name;
    hiderClosePoiList();
}

function hiderPoiKeydown(e) {
    const panel = document.getElementById('hider-poi-list');
    if (!panel) return;

    const { matches } = hiderPoiMatches();
    const max = Math.min(matches.length, HIDER_POI_MAX_RESULTS);

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (panel.hidden) {
            hiderOpenPoiList();
            return;
        }
        if (max === 0) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        _hiderHighlight = (_hiderHighlight + step + max) % max;
        hiderRenderPoiList();
        document.querySelector('#hider-poi-list .hider-poi-item.active')
            ?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
        if (!panel.hidden && _hiderHighlight >= 0 && _hiderHighlight < max) {
            e.preventDefault();
            hiderSelectPoi(matches[_hiderHighlight].idx);
        }
    } else if (e.key === 'Escape') {
        hiderClosePoiList();
    }
}

function hiderSetPoint(lat, lng) {
    _hiderRefPoint = { lat, lng };

    if (_hiderMarker) map.removeLayer(_hiderMarker);
    _hiderMarker = L.circleMarker([lat, lng], {
        radius: 6,
        color: '#f59e0b',
        fillColor: '#f59e0b',
        fillOpacity: 1,
        weight: 2,
        interactive: false
    }).addTo(map);

    hiderCalculateNearest();
}

function hiderStartPick() {
    setStatus('Pick a location on the map', 'loading');
    closeSidebarForPick();

    // Temporary hook for picking hider location
    const hook = (e) => {
        hiderSetPoint(e.latlng.lat, e.latlng.lng);
        removeMapClickHook(hook);
        setStatus('Location set', 'ok');
        return true;
    };
    addMapClickHook(hook);
}

function hiderUseGeo() {
    if (!geoMarker) {
        setStatus('Geolocation not available', 'error');
        return;
    }
    const c = geoMarker.getLatLng();
    hiderSetPoint(c.lat, c.lng);
    setStatus('Used current location', 'ok');
}

function hiderCalculateNearest() {
    const layerId = document.getElementById('hider-layer-select')?.value;
    if (!layerId) {
        document.getElementById('hider-result').innerHTML = 'Please select a layer';
        return;
    }
    if (!_hiderRefPoint) {
        document.getElementById('hider-result').innerHTML = 'Please pick a location';
        return;
    }

    const data = layerDataCache[layerId];
    if (!data || !data.elements || data.elements.length === 0) {
        document.getElementById('hider-result').innerHTML = 'No POIs in this layer';
        return;
    }

    let nearest = null;
    let minDist = Infinity;

    data.elements.forEach(el => {
        const c = getElementCenter(el);
        if (!c) return;
        const d = haversineKm(_hiderRefPoint, c);
        if (d < minDist) {
            minDist = d;
            nearest = el;
        }
    });

    if (nearest) {
        const name = nearest.name || 'Unnamed POI';
        document.getElementById('hider-result').innerHTML =
            `Nearest: <strong>${esc(name)}</strong><br>${fmtDist(minDist)} away`;
    } else {
        document.getElementById('hider-result').innerHTML = 'No valid POIs found';
    }
}

function hiderCreateZone() {
    const poiIdx = document.getElementById('hider-poi-select')?.value;
    const radiusKm = parseFloat(document.getElementById('hider-zone-radius')?.value);

    if (poiIdx === '' || isNaN(radiusKm) || radiusKm <= 0) {
        setStatus('Please select a station and valid radius', 'error');
        return;
    }

    const layerId = 'stations';
    const data = layerDataCache[layerId];
    if (!data || !data.elements || !data.elements[poiIdx]) {
        setStatus('Station data not cached. Please load the stations layer first.', 'error');
        return;
    }

    const el = data.elements[poiIdx];
    const center = getElementCenter(el);
    if (!center) {
        setStatus('Station has no valid coordinates', 'error');
        return;
    }

    const stationName = el.name || 'Station';
    if (hiderDrawZone(center.lat, center.lng, radiusKm, true, stationName)) {
        setStatus(`Hiding zone created around ${stationName}`, 'ok');
    } else {
        setStatus('Failed to create hiding zone', 'error');
    }
}

// Draws the inverted "hiding zone" mask around a point. `fit` zooms to the
// zone; restoring a saved zone leaves the restored map view alone.
function hiderDrawZone(lat, lng, radiusKm, fit, stationName = '', occluded = true) {
    if (_hiderZoneLayer) {
        map.removeLayer(_hiderZoneLayer);
        _hiderZoneLayer = null;
    }
    if (_hiderZoneOutlineLayer) {
        map.removeLayer(_hiderZoneOutlineLayer);
        _hiderZoneOutlineLayer = null;
    }

    // Turf.js uses [lng, lat] for points
    const geometry = turf.circle([lng, lat], radiusKm, { units: 'kilometers' });

    // "block out everything BUT the hiding zone" means invert = true
    const occlusionLayer = createOcclusionLayer(geometry, { invert: true });
    if (!occlusionLayer) return false;

    _hiderZoneLayer = occlusionLayer;
    _hiderZoneData = {
        lat,
        lng,
        radiusKm,
        stationName: stationName || '',
        occluded: !!occluded,
    };

    if (_hiderZoneData.occluded) {
        _hiderZoneLayer.addTo(map);
    } else {
        _hiderZoneOutlineLayer = _hiderCreateZoneOutline(lat, lng, radiusKm).addTo(map);
    }

    if (fit) {
        // Zoom to the zone itself — the inverted mask's own bounds cover the world
        const [minLng, minLat, maxLng, maxLat] = turf.bbox(geometry);
        map.fitBounds(
            L.latLngBounds([[minLat, minLng], [maxLat, maxLng]]).pad(0.15),
            { maxZoom: 17 }
        );
    }

    hiderRenderZoneCard();
    return true;
}

// Replace the creation form with a compact station/radius card once a zone exists.
function hiderRenderZoneCard() {
    const form = document.getElementById('hider-zone-form');
    const card = document.getElementById('hider-zone-summary');
    if (!form || !card) return;

    const zone = _hiderZoneData;
    form.hidden = !!zone;
    card.hidden = !zone;
    if (!zone) {
        card.innerHTML = '';
        return;
    }

    const station = zone.stationName || 'Hiding station';
    const action = zone.occluded
        ? 'Hide hiding zone occlusion'
        : 'Show hiding zone occlusion';
    card.innerHTML = `
        <div class="hider-zone-card-text">
            <div class="hider-zone-station">${esc(station)}</div>
            <div class="hider-zone-distance">${fmtDist(zone.radiusKm)}</div>
        </div>
        <button
            type="button"
            class="layer-eye hider-zone-eye"
            title="${action}"
            aria-label="${action}"
            aria-pressed="${!zone.occluded}"
            onclick="hiderToggleZoneOcclusion()"
        >${zone.occluded ? LAYER_EYE_ICON : LAYER_EYE_OFF_ICON}</button>
    `;
}

// Dotted circle that keeps the hiding zone visible while its occlusion is off.
function _hiderCreateZoneOutline(lat, lng, radiusKm) {
    return L.circle([lat, lng], {
        radius: radiusKm * 1000,
        color: '#f59e0b',
        weight: 2.5,
        opacity: 0.95,
        fill: false,
        dashArray: '6 8',
        interactive: false,
    });
}

function hiderSetZoneOccluded(occluded) {
    if (!_hiderZoneData || !_hiderZoneLayer) return false;
    _hiderZoneData.occluded = !!occluded;

    if (_hiderZoneData.occluded) {
        if (_hiderZoneOutlineLayer) {
            map.removeLayer(_hiderZoneOutlineLayer);
            _hiderZoneOutlineLayer = null;
        }
        if (!map.hasLayer(_hiderZoneLayer)) _hiderZoneLayer.addTo(map);
    } else {
        if (map.hasLayer(_hiderZoneLayer)) map.removeLayer(_hiderZoneLayer);
        if (!_hiderZoneOutlineLayer) {
            _hiderZoneOutlineLayer = _hiderCreateZoneOutline(
                _hiderZoneData.lat,
                _hiderZoneData.lng,
                _hiderZoneData.radiusKm
            ).addTo(map);
        }
    }

    hiderRenderZoneCard();
    return _hiderZoneData.occluded;
}

function hiderToggleZoneOcclusion() {
    if (!_hiderZoneData) return;
    const occluded = hiderSetZoneOccluded(!_hiderZoneData.occluded);
    setStatus(
        occluded ? 'Hiding zone occlusion shown' : 'Hiding zone outline shown',
        'ok'
    );
}

function hiderClearZone() {
    const hadZone = !!_hiderZoneData;
    if (_hiderZoneLayer) {
        map.removeLayer(_hiderZoneLayer);
        _hiderZoneLayer = null;
    }
    if (_hiderZoneOutlineLayer) {
        map.removeLayer(_hiderZoneOutlineLayer);
        _hiderZoneOutlineLayer = null;
    }
    _hiderZoneData = null;
    hiderRenderZoneCard();
    if (hadZone) {
        setStatus('Hiding zone removed', 'ok');
    } else {
        setStatus('No hiding zone to remove', 'error');
    }
}

// ── Answer a question taken from the clipboard ───────────────────────────────
// The seekers' "Ask question" button copies a text such as
// "Radar - Are you within 5 km of (151.20930, -33.86880)?". The hider reads it
// here, marks their own position (current location or a map click) and gets the
// yes/no answer that fits that position.
let _hiderAnswerQuestion = null; // parsed question: { type, text, km, lat, lng }
let _hiderAnswerPoint = null; // { lat, lng } the hider answered for
let _hiderAnswerResult = null; // { dKm, yes }
let _hiderAnswerMarker = null;
let _hiderAnswerPickHook = null;

// "5 km" / "1.86 mi" / "300 m" → kilometers.
function _hiderDistanceKm(amount, unit) {
    const v = parseFloat(String(amount).replace(',', '.'));
    const u = String(unit).toLowerCase();
    return u === 'mi' ? v * KM_PER_MILE : u === 'm' ? v / 1000 : v;
}

// Reads the question type from the first word, then the numbers that type
// needs. The type is followed by " - "; the old ":" separator is still read.
function hiderParseQuestion(text) {
    const str = String(text || '').trim();
    const head = str.match(/^([^\s:]+)\s*[-:]\s*(.*)$/s);
    if (!head) return null;

    const type = head[1].toLowerCase();
    const body = head[2];

    if (type === 'radar') {
        // "Are you within 5 km of (151.20930, -33.86880)?"
        const m = body.match(/([\d.,]+)\s*(km|mi|m)\b[\s\S]*?\(\s*(-?[\d.,]+)\s*,\s*(-?[\d.,]+)\s*\)/i);
        if (!m) return null;

        const amount = parseFloat(m[1].replace(',', '.'));
        const unit = m[2].toLowerCase();
        const km = unit === 'mi' ? amount * KM_PER_MILE : unit === 'm' ? amount / 1000 : amount;
        const lng = parseFloat(m[3].replace(',', '.'));
        const lat = parseFloat(m[4].replace(',', '.'));

        if (!Number.isFinite(km) || km <= 0) return null;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

        return { type, text: str, km, lat, lng };
    }

    if (type === 'matching') {
        // "Is your closest Zoo the Koala Park?" (see mq_question)
        const m = body.match(
            /^(?:Is your closest|Ist dein[e]? nächste[r]?)\s+(.+?)\s+(?:the|der|die|das)\s+(.+?)\s*\??$/i,
        );
        if (!m) return null;
        const layerLabel = m[1].trim();
        const poiName = m[2].trim();
        if (!layerLabel || !poiName) return null;
        return {
            type,
            text: str,
            layerLabel,
            layerId: layerIdFromQuestionLabel(layerLabel),
            poiName,
        };
    }

    if (type === 'measuring') {
        // "Are you closer or further than 5 km from a Zoo?" (see meas_question)
        // The German wording ends in "entfernt", which is not part of the layer.
        const clean = body.replace(/\s+entfernt\s*\?*\s*$/i, '');
        const m = clean.match(
            /^(?:Are you closer or further than|Bist du näher oder weiter als)\s+([\d.,]+)\s*(km|mi|m)\s+(?:from an?|von einem)\s+(.+?)\s*\??$/i,
        );
        if (!m) return null;
        const km = _hiderDistanceKm(m[1], m[2]);
        const layerLabel = m[3].trim();
        if (!Number.isFinite(km) || km <= 0 || !layerLabel) return null;
        return { type, text: str, km, layerLabel, layerId: layerIdFromQuestionLabel(layerLabel) };
    }

    if (type === 'thermometer') {
        // "After travelling from (lng, lat) to (lng, lat) are we hotter or colder?"
        // Both coordinate pairs are read positionally, so the wording around them
        // does not matter.
        const pairs = [...body.matchAll(/\(\s*(-?[\d.,]+)\s*,\s*(-?[\d.,]+)\s*\)/g)];
        if (pairs.length !== 2) return null;

        const [lngA, latA, lngB, latB] = pairs.flatMap((m) => [
            parseFloat(m[1].replace(',', '.')),
            parseFloat(m[2].replace(',', '.')),
        ]);
        if (![latA, lngA, latB, lngB].every(Number.isFinite)) return null;
        if (Math.abs(latA) > 90 || Math.abs(latB) > 90) return null;
        if (Math.abs(lngA) > 180 || Math.abs(lngB) > 180) return null;
        if (haversineKm({ lat: latA, lng: lngA }, { lat: latB, lng: lngB }) < 0.001) return null;

        return { type, text: str, latA, lngA, latB, lngB };
    }

    if (type === 'tentacles') {
        // "Within 2 km of (lng, lat), which Zoo are you closest to?"
        // (German: "Innerhalb von 2 km um (lng, lat) – welchem Zoo bist du am nächsten?")
        const dist = body.match(/([\d.,]+)\s*(km|mi|m)\b/i);
        const point = body.match(/\(\s*(-?[\d.,]+)\s*,\s*(-?[\d.,]+)\s*\)/);
        const layer = body.match(
            /(?:which|welchem)\s+(.+?)\s+(?:are you closest to|bist du am nächsten)/i,
        );
        if (!dist || !point || !layer) return null;

        const km = _hiderDistanceKm(dist[1], dist[2]);
        const lng = parseFloat(point[1].replace(',', '.'));
        const lat = parseFloat(point[2].replace(',', '.'));
        const layerLabel = layer[1].trim();

        if (!Number.isFinite(km) || km <= 0 || !layerLabel) return null;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

        return {
            type,
            text: str,
            km,
            lat,
            lng,
            layerLabel,
            layerId: layerIdFromQuestionLabel(layerLabel),
        };
    }
    return null;
}

function hiderAnswerQuestion() {
    if (!navigator.clipboard?.readText) {
        setStatus('Clipboard not available in this browser', 'error');
        return;
    }
    navigator.clipboard
        .readText()
        .then((text) => {
            const q = hiderParseQuestion(text);
            if (!q) {
                setStatus('Clipboard does not contain a question I can read', 'error');
                return;
            }
            hiderAnswerCancel();
            _hiderAnswerQuestion = q;
            _hiderAnswerPoint = null;
            _hiderAnswerResult = null;
            hiderRenderAnswerPanel();
            setStatus('Question loaded – choose your location', 'ok');
        })
        .catch(() => setStatus('Could not read the clipboard – allow clipboard access and try again', 'error'));
}

function hiderAnswerUseGeo() {
    if (!_hiderAnswerQuestion) return;
    if (!geoMarker) {
        setStatus('Location not active – enable the 🎯 button first', 'error');
        return;
    }
    const c = geoMarker.getLatLng();
    hiderAnswerAt(c.lat, c.lng);
}

function hiderAnswerStartPick() {
    if (!_hiderAnswerQuestion) return;
    if (_hiderAnswerPickHook) removeMapClickHook(_hiderAnswerPickHook);
    setStatus('Click the map to mark your location', 'loading');
    closeSidebarForPick();

    _hiderAnswerPickHook = (e) => {
        removeMapClickHook(_hiderAnswerPickHook);
        _hiderAnswerPickHook = null;
        hiderAnswerAt(e.latlng.lat, e.latlng.lng);
        return true;
    };
    addMapClickHook(_hiderAnswerPickHook);
}

// Colour of the answer marker / box: green for yes, red for no, blue for
// closer/further answers.
function _hiderToneColor(tone) {
    return tone === 'yes' ? '#3fb950' : tone === 'no' ? '#f85149' : '#58a6ff';
}

// Nearest POI of a cached layer to a point, used by matching questions.
function hiderNearestPoi(layerId, lat, lng) {
    const data = layerId ? layerDataCache[layerId] : null;
    if (!data || !data.elements) return null;

    let best = null;
    let minKm = Infinity;
    data.elements.forEach((el) => {
        const c = getElementCenter(el);
        if (!c) return;
        const d = haversineKm({ lat, lng }, c);
        if (d < minKm) {
            minKm = d;
            best = { name: el.name || 'Unnamed POI', dKm: d };
        }
    });
    return best;
}

function hiderAnswerAt(lat, lng) {
    const q = _hiderAnswerQuestion;
    if (!q) return;

    let result;
    if (q.type === 'matching') {
        if (!q.layerId) {
            setStatus(`Layer not found: ${q.layerLabel}`, 'error');
            return;
        }
        const nearest = hiderNearestPoi(q.layerId, lat, lng);
        if (!nearest) {
            setStatus('No POIs in that layer – load the layer first', 'error');
            return;
        }
        const same = nearest.name.trim().toLowerCase() === q.poiName.trim().toLowerCase();
        result = {
            kind: 'matching',
            answer: same ? 'YES' : 'NO',
            tone: same ? 'yes' : 'no',
            nearestName: nearest.name,
        };
    } else if (q.type === 'measuring') {
        if (!q.layerId) {
            setStatus(`Layer not found: ${q.layerLabel}`, 'error');
            return;
        }
        const nearest = hiderNearestPoi(q.layerId, lat, lng);
        if (!nearest) {
            setStatus('No POIs in that layer – load the layer first', 'error');
            return;
        }
        result = {
            kind: 'measuring',
            answer: nearest.dKm < q.km ? 'CLOSER' : 'FURTHER',
            tone: 'info',
            nearestName: nearest.name,
            dKm: nearest.dKm,
        };
    } else if (q.type === 'thermometer') {
        const dA = haversineKm({ lat, lng }, { lat: q.latA, lng: q.lngA });
        const dB = haversineKm({ lat, lng }, { lat: q.latB, lng: q.lngB });
        result = {
            kind: 'thermometer',
            answer: dB < dA ? 'HOTTER' : 'COLDER',
            tone: 'info',
            dA,
            dB,
        };
    } else if (q.type === 'tentacles') {
        const dKm = haversineKm({ lat, lng }, { lat: q.lat, lng: q.lng });
        if (dKm > q.km) {
            // Too far from the point: the answer is "none" whatever the layer holds.
            result = { kind: 'tentacles', answer: 'NONE', tone: 'info', dKm };
        } else {
            if (!q.layerId) {
                setStatus(`Layer not found: ${q.layerLabel}`, 'error');
                return;
            }
            const nearest = hiderNearestPoi(q.layerId, lat, lng);
            if (!nearest) {
                setStatus('No POIs in that layer – load the layer first', 'error');
                return;
            }
            result = {
                kind: 'tentacles',
                answer: nearest.name,
                tone: 'info',
                dKm,
                poiKm: nearest.dKm,
            };
        }
    } else {
        const dKm = haversineKm({ lat, lng }, { lat: q.lat, lng: q.lng });
        const within = dKm <= q.km;
        result = { kind: 'radar', answer: within ? 'YES' : 'NO', tone: within ? 'yes' : 'no', dKm };
    }

    _hiderAnswerPoint = { lat, lng };
    _hiderAnswerResult = result;

    if (_hiderAnswerMarker) map.removeLayer(_hiderAnswerMarker);
    const color = _hiderToneColor(_hiderAnswerResult.tone);
    _hiderAnswerMarker = createDraggableMarker([lat, lng], color).addTo(map);
    _hiderAnswerMarker.on('dragend', (e) => {
        const p = getMarkerPosition(e.target);
        hiderAnswerAt(p.lat, p.lng);
    });

    hiderRenderAnswerPanel();
    setStatus(`Answer: ${_hiderAnswerResult.answer}`, 'ok');
}

function hiderAnswerCancel() {
    if (_hiderAnswerPickHook) {
        removeMapClickHook(_hiderAnswerPickHook);
        _hiderAnswerPickHook = null;
    }
    if (_hiderAnswerMarker) {
        map.removeLayer(_hiderAnswerMarker);
        _hiderAnswerMarker = null;
    }
    _hiderAnswerQuestion = null;
    _hiderAnswerPoint = null;
    _hiderAnswerResult = null;
    hiderRenderAnswerPanel();
    setStatus('');
}

function hiderClearCurrentAnswer() {
    hiderAnswerCancel();
    setStatus('Question cleared', 'ok');
}

// Add the answered question to the corresponding seeker tool as a confirmed
// question, so it appears in that tool's list and affects its map overlay.
async function hiderAddAnsweredQuestion() {
    const q = _hiderAnswerQuestion;
    const point = _hiderAnswerPoint;
    const result = _hiderAnswerResult;
    if (!q || !point || !result) {
        setStatus('Choose your location first', 'error');
        return;
    }

    let id = null;
    try {
        if (q.type === 'radar') {
            id = rqAddAnsweredQuestion({
                km: q.km,
                lat: q.lat,
                lng: q.lng,
                answer: result.answer,
            });
        } else if (q.type === 'matching') {
            id = await mqAddAnsweredQuestion({
                layerId: q.layerId,
                lat: point.lat,
                lng: point.lng,
                answerYes: result.answer === 'YES',
            });
        } else if (q.type === 'measuring') {
            id = await measAddAnsweredQuestion({
                layerId: q.layerId,
                km: q.km,
                answer: result.answer,
            });
        } else if (q.type === 'thermometer') {
            id = thermAddAnsweredQuestion({
                lat: q.latA,
                lng: q.lngA,
                latB: q.latB,
                lngB: q.lngB,
                answer: result.answer,
            });
        } else if (q.type === 'tentacles') {
            id = await tentAddAnsweredQuestion({
                layerId: q.layerId,
                radiusKm: q.km,
                centerLat: q.lat,
                centerLng: q.lng,
                answer: result.answer,
            });
        }
    } catch (err) {
        console.error('Could not add answered question', err);
        id = null;
    }

    if (!id) {
        setStatus('Could not add this question', 'error');
        return;
    }

    const answer = result.answer;
    hiderAnswerCancel();
    setStatus(`Question added: ${answer}`, 'ok');
    scheduleAutosave();
}

function _hiderAnswerDetail(q, r) {
    let detail = '';
    if (r.kind === 'matching') {
        detail = `Your closest ${esc(q.layerLabel)} is ${esc(r.nearestName)}${
            r.answer === 'YES' ? '.' : `, not ${esc(q.poiName)}.`
        }`;
    } else if (r.kind === 'measuring') {
        detail = `Your closest ${esc(q.layerLabel)} is ${esc(r.nearestName)} (${fmtDist(
            r.dKm,
        )} away). The question distance is ${fmtDist(q.km)}.`;
    } else if (r.kind === 'thermometer') {
        detail = `You are ${fmtDist(r.dA)} from the start point and ${fmtDist(r.dB)} from the end point.`;
    } else if (r.kind === 'tentacles') {
        detail =
            r.answer === 'NONE'
                ? `You are ${fmtDist(r.dKm)} from the point – outside the ${fmtDist(q.km)} radius.`
                : `Your closest ${esc(q.layerLabel)} is ${esc(r.answer)} (${fmtDist(
                      r.poiKm,
                  )} away), within the ${fmtDist(q.km)} radius.`;
    } else {
        detail = `You are ${fmtDist(r.dKm)} from the radar centre, the radar radius is ${fmtDist(q.km)}.`;
    }
    return detail;
}

function hiderRenderAnswerPanel() {
    const panel = document.getElementById('hider-answer-panel');
    if (!panel) return;

    const q = _hiderAnswerQuestion;
    if (!q) {
        panel.hidden = true;
        panel.innerHTML = '';
        return;
    }

    const r = _hiderAnswerResult;
    const detail = r ? _hiderAnswerDetail(q, r) : '';
    const toneColor = r ? _hiderToneColor(r.tone) : '';
    const toneBg = r?.tone === 'yes' ? '#0f2a17' : r?.tone === 'no' ? '#2a0f0f' : '#0d2238';
    const resultBox = r
        ? `<div style="padding:8px; border-radius:4px; font-size:12px; line-height:1.5; background:${toneBg}; border:1px solid ${toneColor}; color:#c9d1d9">
            <strong style="color:${toneColor}">Answer: ${esc(r.answer)}</strong><br>
            ${detail}
        </div>`
        : '';

    panel.hidden = false;
    panel.innerHTML = `
        <div style="padding:8px; margin-bottom:8px; background:#0d1117; border:1px solid #30363d; border-radius:4px; font-size:12px; color:#c9d1d9">
            ${esc(q.text)}
        </div>
        <div class="row" style="gap:6px; margin-bottom:8px">
            <button class="tent-pick-btn" style="flex:1; margin-bottom:0" onclick="hiderAnswerUseGeo()">🎯 Current Loc</button>
            <button class="tent-pick-btn" style="flex:1; margin-bottom:0" onclick="hiderAnswerStartPick()">📍 Pick Location</button>
        </div>
        ${resultBox}
        <div class="row" style="gap:6px; margin-top:8px">
            <button class="tent-pick-btn" style="flex:1; margin-bottom:0" onclick="hiderAddAnsweredQuestion()" ${r ? '' : 'disabled'}>Add question</button>
            <button class="ghost" style="flex:1" onclick="hiderClearCurrentAnswer()">Clear</button>
        </div>
    `;
}

// ── Hider tool state for the local auto-save ────────────────────────────────
// Only the zone's centre/radius (not the station index) is stored, so it can be
// redrawn even if the stations layer is not cached. The nearest-POI check keeps
// its picked layer and reference point; its result is recomputed on restore.
function hiderExportState() {
    const radiusInput = document.getElementById('hider-zone-radius');
    return {
        radiusKm: radiusInput ? parseFloat(radiusInput.value) : null,
        zone: _hiderZoneData ? { ..._hiderZoneData } : null,
        nearest: {
            layerId: document.getElementById('hider-layer-select')?.value || '',
            refPoint: _hiderRefPoint ? { lat: _hiderRefPoint.lat, lng: _hiderRefPoint.lng } : null,
        },
    };
}

function hiderImportState(state) {
    if (!state) return;

    const radiusInput = document.getElementById('hider-zone-radius');
    if (radiusInput && Number.isFinite(state.radiusKm)) {
        radiusInput.value = String(state.radiusKm);
    }

    const zone = state.zone;
    if (zone && Number.isFinite(zone.lat) && Number.isFinite(zone.lng) && zone.radiusKm > 0) {
        hiderDrawZone(
            zone.lat,
            zone.lng,
            zone.radiusKm,
            false,
            zone.stationName || '',
            zone.occluded !== false
        );
    }

    const select = document.getElementById('hider-layer-select');
    const nearest = state.nearest ?? {};
    if (select && nearest.layerId) {
        // The option only exists when the layer data was restored from the cache
        const known = [...select.options].some(o => o.value === nearest.layerId);
        if (known) select.value = nearest.layerId;
    }

    const p = nearest.refPoint;
    if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
        hiderSetPoint(p.lat, p.lng);
    }
}

// Initialize list when layers change
const originalToggleSetupPoiLayer = toggleSetupPoiLayer;
toggleSetupPoiLayer = async function(id, enabled) {
    await originalToggleSetupPoiLayer(id, enabled);
    hiderUpdateLayerList();
    if (id === 'stations') {
        hiderUpdatePoiList();
    }
};
