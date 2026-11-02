'use strict';

// ── Colour palette for route lines (kept in sync with COLOR_THEMES) ───────────
let BUS_ROUTE_COLORS = COLOR_THEMES[colorMode].busRoute;

// ── State ─────────────────────────────────────────────────────────────────────
let busRouteItems = {}; // id → { layers, color, name, ref }
let busRouteOrder = []; // ids, top entry = drawn on top of the others
let busRouteRefs = new Set();
let busRouteCounter = 0;

// ── Route types we draw, with their popup icons ───────────────────────────────
// Doubles as a guard against same-ref relations of other kinds (cycle routes,
// motorways, …), e.g. Sydney has a cycle route "T1" and a motorway "M1".
const TRANSIT_ROUTE_ICONS = {
    bus: '🚌',
    trolleybus: '🚌',
    tram: '🚋',
    light_rail: '🚊',
    subway: '🚇',
    train: '🚆',
    monorail: '🚝',
    ferry: '⛴️',
};
const TRANSIT_ROUTE_REGEX = `^(${Object.keys(TRANSIT_ROUTE_ICONS).join('|')})$`;

// ── Render route geometry from Overpass result ────────────────────────────────
function renderBusRoute(data, color) {
    const layers = [];
    (data.elements ?? []).forEach((el) => {
        if (el.type !== 'relation') return;
        const name = el.tags?.name ?? el.tags?.ref ?? '';
        const icon = TRANSIT_ROUTE_ICONS[el.tags?.route] ?? '🚌';
        (el.members ?? []).forEach((m) => {
            if (m.type !== 'way' || !m.geometry?.length) return;
            const line = L.polyline(
                m.geometry.map((p) => [p.lat, p.lon]),
                { color, weight: 5, opacity: 0.85 },
            );
            line.bindPopup(`<div class="popup-name">${icon} ${esc(name)}</div>`);
            layers.push(line);
        });
    });
    return layers;
}

// ── Sidebar list (the top entry is drawn above the ones below it) ────────────
function createBusRouteListEntry(id) {
    const entry = busRouteItems[id];
    const item = document.createElement('div');
    item.className = 'radius-item';
    item.id = 'br-' + id;
    item.dataset.routeId = String(id);
    item.innerHTML = `
        <span class="ri-drag" draggable="true" title="Drag to reorder (top = drawn on top)">⠿</span>
        <div class="dot" style="background:${entry.color};flex-shrink:0"></div>
        <input type="color" class="br-color" value="${entry.color}" title="${t('lbl_change_color') || 'Change color'}" style="margin-left:6px" />
        <div class="ri-info">
            <div>${t('lbl_line')} ${esc(entry.ref)}</div>
            <div class="ri-lat">${esc(entry.name)}</div>
        </div>
        <button class="danger" title="✕">✕</button>
    `;

    // Remove button
    item.querySelector('button').addEventListener('click', () => removeBusRoute(id));

    // Color picker handler
    const colorInput = item.querySelector('.br-color');
    colorInput.addEventListener('input', (e) => {
        const newColor = e.target.value;
        const route = busRouteItems[id];
        if (!route) return;
        route.color = newColor;
        route.custom = true; // remember that user customized this route
        route.layers.forEach((l) => l.setStyle?.({ color: newColor }));
        const dot = item.querySelector('.dot');
        if (dot) dot.style.background = newColor;
        updatePermalink();
    });

    return item;
}

function renderBusRouteList() {
    const list = document.getElementById('busRouteList');
    if (!list) return;
    initBusRouteDragAndDrop();
    list.innerHTML = '';
    busRouteOrder.forEach((id) => {
        if (busRouteItems[id]) list.appendChild(createBusRouteListEntry(id));
    });
}

// New lines go to the top of the list, i.e. they are drawn above older ones
function addBusRouteToList(id) {
    busRouteOrder = busRouteOrder.filter((x) => x !== id);
    busRouteOrder.unshift(id);
    renderBusRouteList();
}

// Stack the map lines so that the list order is the draw order
function applyBusRouteZOrder() {
    for (let i = busRouteOrder.length - 1; i >= 0; i--) {
        const entry = busRouteItems[busRouteOrder[i]];
        if (!entry) continue;
        entry.layers.forEach((l) => l.bringToFront?.());
    }
}

function applyBusRouteOrderFromDom() {
    const list = document.getElementById('busRouteList');
    if (!list) return;
    busRouteOrder = [...list.querySelectorAll('[data-route-id]')].map((el) => Number(el.dataset.routeId));
    applyBusRouteZOrder();
    updatePermalink();
}

// Drag the ⠿ handle to change which line is drawn on top
function initBusRouteDragAndDrop() {
    const list = document.getElementById('busRouteList');
    if (!list || list.dataset.dndReady) return;
    list.dataset.dndReady = '1';

    list.addEventListener('dragstart', (e) => {
        const item = e.target.closest?.('.ri-drag')?.closest('[data-route-id]');
        if (!item) {
            e.preventDefault();
            return;
        }
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.dataset.routeId);
        e.dataTransfer.setDragImage?.(item, 16, 16);
    });

    list.addEventListener('dragover', (e) => {
        const dragging = list.querySelector('.dragging');
        const target = e.target.closest?.('[data-route-id]');
        if (!dragging || !target || target === dragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = target.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        list.insertBefore(dragging, after ? target.nextSibling : target);
    });

    list.addEventListener('drop', (e) => e.preventDefault());

    list.addEventListener('dragend', () => {
        list.querySelector('.dragging')?.classList.remove('dragging');
        applyBusRouteOrderFromDom();
    });
}

// ── Load and draw a bus route ─────────────────────────────────────────────────
async function addBusRoute() {
    const input = document.getElementById('busRouteInput');
    const ref = input.value.trim();
    if (!ref) return;

    if (busRouteRefs.has(ref)) {
        setStatus(tf('status_route_duplicate', ref), 'error');
        return;
    }

    const id = ++busRouteCounter;
    const color = BUS_ROUTE_COLORS[(id - 1) % BUS_ROUTE_COLORS.length];

    setStatus(tf('status_loading_route', ref), 'loading');

    try {
        const bb = currentCity?.bbox;
        // Search within city bbox so "305" in Oldenburg doesn't match a city elsewhere.
        // Fall back to global search when no city is selected.
        const query = bb
            ? `[out:json][timeout:90];
relation(${bb[0]},${bb[2]},${bb[1]},${bb[3]})["route"~"${TRANSIT_ROUTE_REGEX}"]["ref"="${ref}"];
out geom;`
            : `[out:json][timeout:90];
relation["route"~"${TRANSIT_ROUTE_REGEX}"]["ref"="${ref}"];
out geom;`;

        const data = await overpassFetch(query);

        if (!data.elements?.length) {
            setStatus(tf('status_route_not_found', ref), 'error');
            busRouteCounter--;
            return;
        }

        const layers = renderBusRoute(data, color);
        if (!layers.length) {
            setStatus(tf('status_route_no_geom', ref), 'error');
            busRouteCounter--;
            return;
        }

        layers.forEach((l) => l.addTo(map));

        const routeName = data.elements[0]?.tags?.name ?? ref;
        busRouteItems[id] = { layers, color, name: routeName, ref, custom: false };
        busRouteItems[id].data = data; // Store the original Overpass response
        busRouteRefs.add(ref);

        addBusRouteToList(id);
        setStatus(tf('status_route_loaded', ref, data.elements.length), 'ok');
        input.value = '';
        updatePermalink();
    } catch (e) {
        setStatus(t('status_err_popup'), 'error');
        showErrorPopup(tf('err_busroute', ref, e.message));
        busRouteCounter--;
    }
}

// ── Remove a single bus route ─────────────────────────────────────────────────
function removeBusRoute(id) {
    if (!busRouteItems[id]) return;
    busRouteRefs.delete(busRouteItems[id].ref);
    busRouteItems[id].layers.forEach((l) => map.removeLayer(l));
    delete busRouteItems[id];
    busRouteOrder = busRouteOrder.filter((routeId) => routeId !== id);
    document.getElementById('br-' + id)?.remove();
    updatePermalink();
}

// ── Remove all bus routes ─────────────────────────────────────────────────────
function clearAllBusRoutes() {
    Object.keys(busRouteItems).forEach((id) => removeBusRoute(Number(id)));
}

// ── Enable drag-to-reorder once the sidebar list exists ──────────────────────
initBusRouteDragAndDrop();

// ── Re-colour existing routes after a theme change ───────────────────────────
function recolorBusRoutes() {
    const palette = COLOR_THEMES[colorMode].busRoute;
    Object.entries(busRouteItems).forEach(([id, item]) => {
        // Respect user-chosen custom colors
        if (item.custom) return;
        const newColor = palette[(parseInt(id) - 1) % palette.length];
        item.layers.forEach((l) => l.setStyle?.({ color: newColor }));
        item.color = newColor;
        const dot = document.querySelector('#br-' + id + ' .dot');
        if (dot) dot.style.background = newColor;
        const colorInput = document.querySelector('#br-' + id + ' .br-color');
        if (colorInput) colorInput.value = newColor;
    });
}
