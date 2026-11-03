'use strict';

let _hiderSelectedLayer = null;
let _hiderRefPoint = null; // {lat, lng}
let _hiderMarker = null;
let _hiderZoneLayer = null;
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
            `Nearest: <strong>${esc(name)}</strong><br>${minDist.toFixed(3)} km away`;
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

    // Remove existing zone if present
    if (_hiderZoneLayer) {
        map.removeLayer(_hiderZoneLayer);
    }

    // Turf.js uses [lng, lat] for points
    const geometry = turf.circle([center.lng, center.lat], radiusKm, { units: 'kilometers' });

    // "block out everything BUT the hiding zone" means invert = true
    const occlusionLayer = createOcclusionLayer(geometry, { invert: true });

    if (occlusionLayer) {
        _hiderZoneLayer = occlusionLayer;
        _hiderZoneLayer.addTo(map);

        // Zoom to the zone itself — the inverted mask's own bounds cover the world
        const [minLng, minLat, maxLng, maxLat] = turf.bbox(geometry);
        map.fitBounds(
            L.latLngBounds([[minLat, minLng], [maxLat, maxLng]]).pad(0.15),
            { maxZoom: 17 }
        );

        setStatus(`Hiding zone created around ${esc(el.name || 'Station')}`, 'ok');
    } else {
        setStatus('Failed to create hiding zone', 'error');
    }
}

function hiderClearZone() {
    if (_hiderZoneLayer) {
        map.removeLayer(_hiderZoneLayer);
        _hiderZoneLayer = null;
        setStatus('Hiding zone removed', 'ok');
    } else {
        setStatus('No hiding zone to remove', 'error');
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
