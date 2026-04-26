import L from 'leaflet';

let map = null;
let playerMarker = null;

export function initMap() {
  map = L.map('map', { zoomControl: false })
    .setView([35.6762, 139.6503], 16);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  L.control.zoom({ position: 'topright' }).addTo(map);

  // GPS追従
  if (navigator.geolocation) {
    navigator.geolocation.watchPosition(pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      _setPlayer(lat, lng);
    }, null, { enableHighAccuracy: true });
  }
}

function _setPlayer(lat, lng) {
  if (!map) return;
  if (playerMarker) {
    playerMarker.setLatLng([lat, lng]);
  } else {
    const icon = L.divIcon({
      html: '<div style="font-size:26px;line-height:1">🧙</div>',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      className: 'player-marker-icon',
    });
    playerMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map);
    map.setView([lat, lng], 16);
  }
}

export function addDungeonPin(lat, lng, dungeonData, cleared, onEnter) {
  if (!map) return;
  const icon = L.divIcon({
    html: `<div class="dungeon-map-icon${cleared ? ' cleared' : ''}">${dungeonData.theme.name[0]}</div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    className: '',
  });

  L.marker([lat, lng], { icon })
    .addTo(map)
    .bindPopup(
      `<b>${dungeonData.name}</b><br>` +
      `難易度: ${'⭐'.repeat(dungeonData.difficulty)}<br>` +
      `${cleared ? '✅ 攻略済み' : `<button onclick="window._mapEnter()">入場する</button>`}`,
    )
    .on('click', () => {
      if (!cleared) {
        window._mapEnter = () => onEnter(dungeonData);
      }
    });
}
