'use strict';

// ── Export / Import map state (JSON) ────────────────────────────────────────
function buildMapState() {
    const state = {
        version: 1,
        view: (() => {
            const c = map.getCenter();
            return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
        })(),
        layerDataCache: {},
        busRoutes: [],
        // Persist the city the player typed plus the resolved city object
        city: {},
        // Persist game zone areas (allowed/drawn areas)
        gameZone: [],
    };

    // Only export cached layer data, always in the type/name/location shape
    // (in case a cache entry came from somewhere other than loadLayer)
    Object.keys(layerDataCache).forEach((id) => {
        state.layerDataCache[id] = normalizeLayerData(id, layerDataCache[id]);
    });

    // Export bus routes in draw order, as type/name/colour plus their paths
    busRouteOrder.forEach((id) => {
        const item = busRouteItems[id];
        if (!item) return;
        state.busRoutes.push({
            ref: item.ref,
            name: item.name,
            type: item.type,
            color: item.color,
            parts: item.parts,
        });
    });

    // Export current city input and resolved city object (if any)
    try {
        state.city.input = document.getElementById('cityInput').value.trim();
    } catch (_) {}
    // Only the location fields of the resolved city, not the whole Nominatim
    // response (address parts, namedetails, …) that a restored old export may
    // still carry.
    if (typeof currentCity !== 'undefined' && currentCity) {
        const c = {};
        ['name', 'lat', 'lng', 'bbox', 'osm_type', 'osm_id'].forEach((k) => {
            if (currentCity[k] != null) c[k] = currentCity[k];
        });
        state.city.currentCity = c;
    }

    // Export game zone items (serialize geojson feature + metadata)
    try {
        Object.values(gzItems || {}).forEach((it) => {
            state.gameZone.push({ feature: it.feature, name: it.name, kind: it.kind, osmKey: it.osmKey });
        });
    } catch (_) {}

    return state;
}

function downloadStateFile(state, filename) {
    const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function exportMapState() {
    downloadStateFile(
        buildMapState(),
        `hideandseek-map-state-${new Date().toISOString().slice(0, 19)}.json`,
    );
}

// ── Game state (map + every open question) ─────────────────────────────────
// The question modules store only their inputs and lock state; geometry and
// masks are rebuilt from the restored layers, so the file stays small.
function buildGameState() {
    const state = buildMapState();
    state.questions = {
        matching: matchingExportState(),
        measuring: measuringExportState(),
        thermometer: thermExportState(),
        radar: rqExportState(),
        tentacles: tentExportState(),
    };
    return state;
}

function exportGameState() {
    downloadStateFile(
        buildGameState(),
        `hideandseek-game-state-${new Date().toISOString().slice(0, 19)}.json`,
    );
    setStatus(t('status_game_exported') || 'Game state exported', 'ok');
}

function triggerImportGameState() {
    document.getElementById('gameStateFileInput')?.click();
}

function handleImportGameStateFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
        try {
            await importGameState(JSON.parse(reader.result));
            saveStateNow();
        } catch (err) {
            showErrorPopup('Invalid state file');
        }
    };
    reader.readAsText(f);
    // reset input so selecting same file again triggers change
    e.target.value = '';
}

async function importGameState(state) {
    if (!state || state.version !== 1) {
        showErrorPopup('Unsupported state file');
        return;
    }

    // Restores city, view, cached layers, game zone and bus routes first, so
    // the questions can rebuild their masks from the cached layers.
    await importMapState(state);

    const q = state.questions ?? {};
    await matchingImportState(q.matching);
    await measuringImportState(q.measuring);
    thermImportState(q.thermometer);
    rqImportState(q.radar);
    await tentImportState(q.tentacles);

    setStatus(
        state.questions
            ? t('status_game_imported') || 'Game state imported'
            : t('status_state_imported') || 'State imported',
        'ok',
    );
}

function handleImportStateFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
        try {
            // Handles map-only files and game-state files (map + questions)
            await importGameState(JSON.parse(reader.result));
            saveStateNow();
        } catch (err) {
            showErrorPopup('Invalid state file');
        }
    };
    reader.readAsText(f);
    // reset input so selecting same file again triggers change
    e.target.value = '';
}

async function importMapState(state) {
    if (!state || state.version !== 1) {
        showErrorPopup('Unsupported state file');
        return;
    }

    // Clear current visible state (including any existing game zone)
    // Do this before restoring the city so `searchCity()` loads fresh
    // boundary layers for the imported city rather than merging with
    // whatever was previously displayed.
    clearAllBusRoutes();
    clearAllLayers();
    clearAllBoundaryLayers();
    try { clearGameZone(); } catch (_) {}

    // Restore city input and immediately search it when possible so the
    // canonical `currentCity` is populated via `searchCity()` (Nominatim).
    try {
        if (state.city?.input) {
            document.getElementById('cityInput').value = state.city.input;
            await searchCity();
        } else if (state.city?.currentCity) {
            // Fallback: if no input string was exported, restore the
            // resolved object directly so boundary loaders can use it.
            currentCity = state.city.currentCity;
            document.getElementById('cityHint').textContent = currentCity.name ?? '';
            try {
                if (currentCity.bbox && currentCity.bbox.length === 4) {
                    map.fitBounds([
                        [currentCity.bbox[0], currentCity.bbox[2]],
                        [currentCity.bbox[1], currentCity.bbox[3]],
                    ]);
                }
            } catch (_) {}
            try {
                reloadActiveBoundaryLayers();
            } catch (_) {}
        }
    } catch (_) {}

    // Restore map view
    if (state.view) map.setView([state.view.lat, state.view.lng], state.view.zoom);

    // Restore layers from cached Overpass results (no network requests)
    Object.entries(state.layerDataCache ?? {}).forEach(([id, data]) => {
        if (!LAYER_DEFS[id]) return;
        // Older exports still carry raw OSM tags; slim them on the way in
        const slim = normalizeLayerData(id, data);
        layerDataCache[id] = slim;
        setupPoiLayerSelection.add(id);
        const leafletLayers = LAYER_DEFS[id].render(id, slim, LAYER_DEFS[id]);
        activeLayers[id] = leafletLayers;
        leafletLayers.forEach((l) => l.addTo(map));
        const cb = document.getElementById('lyr-' + id);
        if (cb) cb.checked = true;
        const cntEl = document.getElementById('cnt-' + id);
        if (cntEl) cntEl.textContent = (slim.elements?.length ?? 0) > 0 ? `(${slim.elements.length})` : '';
    });
    renderSetupPoiLayerList();
    renderGamePoiLayerPanel();
    updateLayerDots();
    updateLayerFabBadge();

    if (typeof hiderUpdateLayerList === 'function') hiderUpdateLayerList();

    // Restore bus routes from included Overpass responses
    if (Array.isArray(state.busRoutes)) {
        // Stored topmost first, but adding prepends to the list
        for (const br of [...state.busRoutes].reverse()) {
            try {
                const id = ++busRouteCounter;
                const color = br.color ?? BUS_ROUTE_COLORS[(id - 1) % BUS_ROUTE_COLORS.length];
                // New exports carry slimmed paths; old ones carry the raw response
                const parts = br.parts ?? routePartsFromOverpass(br.data ?? {});
                const layers = renderBusRouteParts(parts, color);
                layers.forEach((l) => l.addTo(map));
                const routeName = br.name ?? br.ref;
                const routeType = br.type ?? parts[0]?.type ?? 'bus';
                busRouteItems[id] = { layers, color, name: routeName, ref: br.ref, type: routeType, parts, custom: false };
                busRouteRefs.add(br.ref);
                addBusRouteToList(id);
            } catch (_) {
                /* skip problematic entries */
            }
        }
    }

    // (city has already been restored above via searchCity() or currentCity)

    // Restore game zone areas (allowed/drawn areas)
    try {
        if (Array.isArray(state.gameZone)) {
            for (const gz of state.gameZone) {
                try {
                    const rawFeat = gz.feature;
                    const feature = rawFeat?.type === 'Feature' ? rawFeat : turf.feature(rawFeat);
                    const kind = gz.kind ?? 'boundary';
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
                    const name = gz.name ?? (`Imported area ${id}`);
                    const osmKey = gz.osmKey ?? ('import/' + id);
                    gzItems[id] = { feature, layers: [outline], name, kind, osmKey };
                    gzOsmKeys.add(osmKey);
                    gzAddListEntry(id, name, gz.name ?? name, kind, gz.radiusKm);

                    // Preserve drawn counter when importing drawn areas
                    if (kind === 'drawn' && typeof osmKey === 'string') {
                        const m = osmKey.match(/^drawn\/(\d+)$/);
                        if (m) gzDrawCounter = Math.max(gzDrawCounter, parseInt(m[1], 10));
                    }
                } catch (_) {
                    /* skip problematic entries */
                }
            }
            gzRedrawMask();
        }
    } catch (_) {}

    setStatus(t('status_state_imported') || 'State imported', 'ok');
}

// ── Local auto-save (this browser only) ──────────────────────────────────────
// A phone can discard the page while it sits in the background, so the current
// state is mirrored into IndexedDB and restored on the next load. Nothing is
// uploaded and nothing is shared between devices or browsers; "Reset
// everything" deletes the copy.
const AUTOSAVE_DB = 'hideandseek-map';
const AUTOSAVE_STORE = 'state';
const AUTOSAVE_KEY = 'last';
const AUTOSAVE_INTERVAL_MS = 60000;

let _autosaveTimer = null;
let _autosaveStarted = false;
let _autosaveSuppressed = false;

function _idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(AUTOSAVE_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(AUTOSAVE_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function _autosaveWrite(state) {
    const db = await _idbOpen();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(AUTOSAVE_STORE, 'readwrite');
            tx.objectStore(AUTOSAVE_STORE).put(state, AUTOSAVE_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

async function _autosaveRead() {
    const db = await _idbOpen();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(AUTOSAVE_STORE, 'readonly');
            const req = tx.objectStore(AUTOSAVE_STORE).get(AUTOSAVE_KEY);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

async function _autosaveDelete() {
    const db = await _idbOpen();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(AUTOSAVE_STORE, 'readwrite');
            tx.objectStore(AUTOSAVE_STORE).delete(AUTOSAVE_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

function _currentTileKey() {
    return document.querySelector('.style-opt.active')?.dataset.tile ?? null;
}

function buildAutoSaveState() {
    return {
        ...buildGameState(),
        mapSetupComplete: !!mapSetupComplete,
        prefs: { units, style: _currentTileKey() },
        savedAt: Date.now(),
    };
}

// Best-effort write: private browsing or a full quota must not break the app,
// the manual Export button remains the fallback there.
function saveStateNow() {
    if (_autosaveSuppressed || typeof indexedDB === 'undefined') return;
    let state;
    try {
        state = buildAutoSaveState();
    } catch (err) {
        return;
    }
    _autosaveWrite(state).catch(() => {});
}

function startAutosave() {
    if (_autosaveStarted) return;
    _autosaveStarted = true;

    _autosaveTimer = setInterval(() => {
        if (document.visibilityState === 'visible') saveStateNow();
    }, AUTOSAVE_INTERVAL_MS);

    // The page is about to be frozen or unloaded — the usual "user closed the
    // app on their phone" moment.
    window.addEventListener('pagehide', saveStateNow);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') saveStateNow();
    });

    // Any interaction after a reset re-enables saving.
    document.addEventListener(
        'pointerdown',
        () => {
            _autosaveSuppressed = false;
        },
        { passive: true },
    );
    document.addEventListener('keydown', () => {
        _autosaveSuppressed = false;
    });
}

function clearAutoSave() {
    _autosaveSuppressed = true;
    _autosaveDelete().catch(() => {});
}

function applySavedPrefs(prefs) {
    if (!prefs) return;
    if (prefs.units === 'metric' || prefs.units === 'imperial') setUnits(prefs.units);
    if (prefs.style && TILE_LAYERS[prefs.style]) {
        setTileLayer(prefs.style);
        document.querySelectorAll('.style-opt').forEach((b) => {
            b.classList.toggle('active', b.dataset.tile === prefs.style);
        });
    }
}

// Some webviews and private-browsing modes leave an IndexedDB request pending
// forever instead of failing, so never let the read block the map from loading.
function _autosaveReadWithTimeout(ms) {
    return Promise.race([
        _autosaveRead().catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
}

// Called once on page load (index.html initialisation).
async function restoreSavedState() {
    let saved = null;
    try {
        saved = await _autosaveReadWithTimeout(3000);
    } catch (_) {
        /* storage unavailable: behave like a fresh visit */
    }

    if (saved && saved.version === 1) {
        try {
            applySavedPrefs(saved.prefs);
            await importGameState(saved);

            // Put the player back into the mode they left (game vs setup)
            if (saved.mapSetupComplete) {
                mapSetupComplete = true;
                updateSetupMode();
                gamePoiLayerSelection.clear();
                [...setupPoiLayerSelection].forEach((id) => {
                    if (layerDataCache[id]) gamePoiLayerSelection.add(id);
                });
                renderGamePoiLayerPanel();
                updateLayerFabBadge();
            }

            setStatus(t('status_restored') || 'Session restored', 'ok');
            startAutosave();
            return;
        } catch (err) {
            console.error('Could not restore saved state', err);
        }
    }

    // Nothing saved: show the default city, as a fresh visit would
    try {
        await searchCity();
    } catch (_) {}
    startAutosave();
}
