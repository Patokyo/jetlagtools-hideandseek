'use strict';

// Fingers are far less precise than a mouse cursor: on touch screens a dot that
// is only ~12px wide is nearly impossible to grab, so the drag turns into a map
// pan instead. Leaflet listens for drags on the icon element itself, therefore
// the icon is padded out to a finger-sized hit area (44px is the usual minimum
// touch target) with the visible dot centred inside it.
const MIN_TOUCH_HIT_SIZE = 44;

function _isTouchLike() {
    if (navigator.maxTouchPoints > 0) return true;
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}

function createDraggableMarker(location, colour = '#000', size = 12) {
    const baseSize = Math.max(1, Number(size) || 12);
    const touch = _isTouchLike();
    // Touch screens get a slightly bigger dot and a much bigger grab area.
    const dotSize = touch ? baseSize + 2 : baseSize;
    const hitSize = Math.max(dotSize, touch ? MIN_TOUCH_HIT_SIZE : dotSize + 8);

    return L.marker(location, {
        draggable: true,
        icon: L.divIcon({
            className: 'shared-draggable-marker',
            html:
                `<div class="shared-draggable-marker-hit" style="box-sizing:border-box;width:${hitSize}px;height:${hitSize}px;display:flex;align-items:center;justify-content:center">` +
                `<div style="box-sizing:border-box;background:${colour};width:${dotSize}px;height:${dotSize}px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,0.5)"></div>` +
                `</div>`,
            iconSize: [hitSize, hitSize],
            iconAnchor: [hitSize / 2, hitSize / 2],
        }),
        zIndexOffset: 500,
    });
}

function getMarkerPosition(marker) {
    return marker ? marker.getLatLng() : null;
}
