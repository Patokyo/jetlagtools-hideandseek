'use strict';

function createDraggableMarker(location, colour = '#000', size = 12) {
    const markerSize = Math.max(1, Number(size) || 12);

    return L.marker(location, {
        draggable: true,
        icon: L.divIcon({
            className: 'shared-draggable-marker',
            html: `<div style="box-sizing:border-box;background:${colour};width:${markerSize}px;height:${markerSize}px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,0.5)"></div>`,
            iconSize: [markerSize, markerSize],
            iconAnchor: [markerSize / 2, markerSize / 2],
        }),
        zIndexOffset: 500,
    });
}

function getMarkerPosition(marker) {
    return marker ? marker.getLatLng() : null;
}
