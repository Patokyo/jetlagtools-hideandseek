'use strict';

let mapSetupComplete = false;

function updateSetupMode() {
    const inSetup = !mapSetupComplete;
    document.body.classList.toggle('setup-mode', inSetup);
    const setupBtn = document.getElementById('setupMenuBtn');
    if (setupBtn) {
        setupBtn.classList.toggle('active', inSetup);
        setupBtn.textContent = inSetup ? 'Start Game' : 'Setup Map';
    }
}

function completeMapSetup() {
    mapSetupComplete = true;
    gamePoiLayerSelection.clear();
    [...setupPoiLayerSelection].forEach((id) => {
        if (layerDataCache[id]) gamePoiLayerSelection.add(id);
    });
    Object.keys(activeLayers).forEach((id) => removeLayer(id));
    renderGamePoiLayerPanel();
    updateSetupMode();
    setStatus('Map setup complete', 'ok');

    if (typeof hiderUpdateLayerList === 'function') hiderUpdateLayerList();
}

function toggleSetupMode() {
    if (mapSetupComplete) {
        mapSetupComplete = false;
        updateSetupMode();
        // Re-show any cached POI layers on the map so the user can edit/setup them
        Object.keys(layerDataCache).forEach((id) => {
            try {
                if (activeLayers[id]) return;
                const data = layerDataCache[id];
                if (!data) return;
                const def = LAYER_DEFS[id];
                if (!def || typeof def.render !== 'function') return;
                const leafletLayers = def.render(id, data, def);
                activeLayers[id] = leafletLayers;
                leafletLayers.forEach((l) => l.addTo(map));
            } catch (e) {
                console.error('Error restoring cached layer', id, e);
            }
        });
        renderSetupPoiLayerList();
        updateLayerFabBadge();
        openSidebar();
    } else {
        completeMapSetup();
    }
}

// ── General helpers ───────────────────────────────────────────────────────────

// Update the status bar at the bottom of the sidebar.
// The message is mirrored into #statusToast, which is only visible on small
// screens where the sidebar (and its status bar) is hidden behind the drawer.
function setStatus(msg, type = '') {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = type;

    const toast = document.getElementById('statusToast');
    toast.textContent = msg;
    toast.className = msg ? `show ${type}` : '';
}

// Escape HTML special characters (for popup content)
function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Print ─────────────────────────────────────────────────────────────────────
function printMap() {
    closeSidebar();
    map.invalidateSize();
    setTimeout(() => window.print(), 100);
}

// ── Color mode (default / colorblind-safe) ────────────────────────────────────
function setColorMode(mode) {
    colorMode = mode;
    localStorage.setItem('colorMode', mode);
    PLZ_COLORS = COLOR_THEMES[mode].plz;
    INTERVAL_COLORS = COLOR_THEMES[mode].interval;
    BUS_ROUTE_COLORS = COLOR_THEMES[mode].busRoute;
    recolorActiveLayers();
    recolorBusRoutes();
    document.querySelectorAll('.color-mode-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.mode === mode);
    });
}

function initColorMode() {
    const theme = COLOR_THEMES[colorMode];
    Object.entries(theme.layers).forEach(([id, color]) => {
        if (LAYER_DEFS[id]) LAYER_DEFS[id].color = color;
    });
    updateLayerDots();
    document.querySelectorAll('.color-mode-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.mode === colorMode);
    });
}

// ── Global reset: clear every tool, drawn layer and marker ────────────────────
// Keeps preferences (language, units, map style, colour mode) and the city.
function clearAll() {
    clearMeasure();
    clearAdminCheck();
    clearNearestChecker();
    clearStationLength();
    clearGameZone();
    clearNearestPOI();
    clearAllTentacles();
    clearAllBusRoutes();
    clearAllRadii();
    clearAllRadiusQuestions();
    clearAllMatchingQuestions();
    clearAllLayers();
    clearAllBoundaryLayers();
    if (clickMarker) {
        map.removeLayer(clickMarker);
        clickMarker = null;
    }
    clickedPoint = null;
    document.getElementById('clickCoords').textContent = t('coord_hint');
    updatePermalink();
    setStatus(t('status_all_cleared'), 'ok');
}

// ── Map style popover ─────────────────────────────────────────────────────────
function positionStylePopover(trigger) {
    const pop = document.getElementById('stylePopover');
    if (!pop) return;
    const defaultTrigger = document.getElementById('styleFab') || document.getElementById('setupStyleBtn');
    const triggerEl = trigger instanceof HTMLElement ? trigger : defaultTrigger;
    const pad = 12;

    if (triggerEl) {
        const rect = triggerEl.getBoundingClientRect();
        const popWidth = pop.offsetWidth || 195;
        const popHeight = pop.offsetHeight || 260;
        const left = Math.min(
            Math.max(pad, rect.left + rect.width / 2 - popWidth / 2),
            window.innerWidth - popWidth - pad,
        );
        const top = Math.min(
            Math.max(pad, rect.top + rect.height + 10),
            window.innerHeight - popHeight - pad,
        );

        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
        pop.style.right = 'auto';
        pop.style.bottom = 'auto';
    } else {
        pop.style.left = '';
        pop.style.top = '';
        pop.style.right = '12px';
        pop.style.bottom = '300px';
    }
}

function toggleStylePopover(trigger = document.getElementById('styleFab') || document.getElementById('setupStyleBtn')) {
    const pop = document.getElementById('stylePopover');
    if (!pop) return;

    const shouldOpen = !pop.classList.contains('open');
    if (shouldOpen) {
        positionStylePopover(trigger);
    }
    pop.classList.toggle('open', shouldOpen);
}

function selectStyle(btn, key) {
    setTileLayer(key);
    document.querySelectorAll('.style-opt').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('stylePopover').classList.remove('open');
    updatePermalink();
}

registerPopoverClickOutside('stylePopover', ['styleFab', 'setupStyleBtn']);

// ── Layer panel ───────────────────────────────────────────────────────────────
function toggleLayerPanel() {
    document.getElementById('layerPanel').classList.toggle('open');
}

function updateLayerFabBadge() {
    const count = !mapSetupComplete
        ? 0
        : [...gamePoiLayerSelection].filter((id) => activeLayers[id]).length;
    const badge = document.getElementById('layerFabBadge');
    const fab = document.getElementById('layerFab');
    if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'flex';
        fab.classList.add('lp-active');
    } else {
        badge.style.display = 'none';
        fab.classList.remove('lp-active');
    }
}

registerPopoverClickOutside('layerPanel', 'layerFab');

// ── Mobile sidebar ────────────────────────────────────────────────────────────
function openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebarBackdrop').classList.add('open');
    document.getElementById('menuToggle').style.display = 'none';
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarBackdrop').classList.remove('open');
    document.getElementById('menuToggle').style.display = '';
}

// Close the drawer on small screens so the map is reachable for a pick action.
// No-op on desktop, where the sidebar and map are visible side by side.
function closeSidebarForPick() {
    if (window.matchMedia('(max-width: 700px)').matches) closeSidebar();
}

// ── Error popup ───────────────────────────────────────────────────────────────
function showErrorPopup(msg) {
    document.getElementById('errorText').textContent = msg;
    document.getElementById('errorCopyBtn').textContent = t('err_copy');
    document.getElementById('errorOverlay').style.display = 'flex';
}

function closeErrorPopup() {
    document.getElementById('errorOverlay').style.display = 'none';
}

function copyErrorText() {
    const text = document.getElementById('errorText').textContent;
    const btn = document.getElementById('errorCopyBtn');

    const confirm = () => {
        btn.textContent = t('err_copied');
        setTimeout(() => {
            btn.textContent = t('err_copy');
        }, 2000);
    };
    const fail = () => {
        btn.textContent = t('err_copy_fail');
        setTimeout(() => {
            btn.textContent = t('err_copy');
        }, 2000);
    };

    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(confirm).catch(fail);
        return;
    }
    // Fallback for older browsers
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? confirm() : fail();
    } catch (_) {
        fail();
    }
}

// Close error popup when clicking the backdrop
document.getElementById('errorOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('errorOverlay')) closeErrorPopup();
});

// Trigger search on Enter in the city field
document.getElementById('cityInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchCity();
});

// Trigger addBusRoute on Enter in the bus route input
document.getElementById('busRouteInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addBusRoute();
});
