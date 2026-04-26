import L from 'leaflet';
import {
  getDungeonsNear,
  isWithinEnterRadius,
  distanceMeters,
  ENTER_RADIUS,
} from './generator.js';
import { getDebugState } from './debug.js';

let map          = null;
let playerMarker = null;
let playerPos    = null;                 // { lat, lng }
const renderedPins = new Map();          // seed -> { marker, dungeon }
let onEnterCb    = null;
let isClearedCb  = null;
let difficultyCb = null;

export function initMap({ onEnter, isCleared, difficulty } = {}) {
  onEnterCb    = onEnter    ?? null;
  isClearedCb  = isCleared  ?? null;
  difficultyCb = difficulty ?? null;

  map = L.map('map', { zoomControl: false })
    .setView([35.6762, 139.6503], 16);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  L.control.zoom({ position: 'topright' }).addTo(map);

  // GPS追従＋追従に応じて固定湧きダンジョン更新
  if (navigator.geolocation) {
    navigator.geolocation.watchPosition(
      pos => _setPlayer(pos.coords.latitude, pos.coords.longitude),
      err => {
        console.warn('geolocation watch error:', err?.message);
        // フォールバック：東京で湧きだけ描画
        _refreshDungeons(35.6762, 139.6503);
      },
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
  } else {
    _refreshDungeons(35.6762, 139.6503);
  }
}

function _setPlayer(lat, lng) {
  if (!map) return;
  playerPos = { lat, lng };

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

  _refreshDungeons(lat, lng);
}

function _refreshDungeons(lat, lng) {
  const dungeons = getDungeonsNear(lat, lng, 1500);
  for (const d of dungeons) {
    if (renderedPins.has(d.seed)) continue;
    _addDungeonPin(d);
  }
}

function _pinHtml(dungeon, cleared) {
  return `<div class="dungeon-map-icon${cleared ? ' cleared' : ''}" `
       + `style="background:${cleared ? '#555' : dungeon.rarityBase.color}">`
       + `${dungeon.theme.name[0]}</div>`;
}

function _buildPopupHtml(dungeon) {
  if (!playerPos) {
    return `<b>${dungeon.name}</b><br>位置情報を取得中...`;
  }
  const dbg        = getDebugState();
  const inRange    = dbg.bypassEnterRadius
                      || isWithinEnterRadius(playerPos.lat, playerPos.lng, dungeon);
  const dist       = Math.round(distanceMeters(playerPos.lat, playerPos.lng, dungeon.lat, dungeon.lng));
  const clearedNow = isClearedCb?.(dungeon.seed) ?? false;

  const diff = difficultyCb?.(dungeon);
  const diffLine = diff
    ? `<div style="margin-top:2px">推奨: <b style="color:${diff.color}">${diff.label}</b></div>`
    : '';

  return (
    `<div><b>${dungeon.name}</b></div>` +
    `<div>難易度: ${'⭐'.repeat(dungeon.difficulty)} / B${dungeon.floors}F</div>` +
    `<div style="color:${dungeon.rarityBase.color};font-weight:bold">${dungeon.rarityBase.name}</div>` +
    `<div style="font-size:11px;color:#888">${dungeon.element}属性</div>` +
    diffLine +
    (clearedNow ? '<div style="color:#4caf50;margin-top:4px">✅ 攻略済み（再戦可）</div>' : '') +
    (inRange
      ? `<button class="popup-enter-btn" data-seed="${dungeon.seed}" `
        + `style="margin-top:8px;padding:6px 14px;background:#7c4dff;color:#fff;`
        + `border:none;border-radius:6px;cursor:pointer;font-weight:bold">入場する</button>`
      : `<div style="margin-top:6px;color:#888">🚶 距離 ${dist}m`
        + `（${ENTER_RADIUS}m以内で入場可）</div>`)
  );
}

function _addDungeonPin(dungeon) {
  const cleared = isClearedCb?.(dungeon.seed) ?? false;
  const icon = L.divIcon({
    html: _pinHtml(dungeon, cleared),
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    className: '',
  });
  const marker = L.marker([dungeon.lat, dungeon.lng], { icon }).addTo(map);

  // Leafletの標準トグル動作を使う：クリック毎にコンテンツ関数で最新HTMLを生成
  marker.bindPopup(() => _buildPopupHtml(dungeon));

  // ポップアップが開かれた直後に「入場する」ボタンへハンドラを付ける
  marker.on('popupopen', () => {
    if (!onEnterCb) return;
    const btn = document.querySelector(
      `button.popup-enter-btn[data-seed="${dungeon.seed}"]`,
    );
    if (!btn) return;
    btn.addEventListener('click', () => {
      marker.closePopup();
      onEnterCb(dungeon);
    }, { once: true });
  });

  renderedPins.set(dungeon.seed, { marker, dungeon });
}

// 攻略状態の変化時にピンを再描画
export function refreshPin(seed) {
  const entry = renderedPins.get(seed);
  if (!entry) return;
  const { marker, dungeon } = entry;
  const cleared = isClearedCb?.(seed) ?? false;
  marker.setIcon(L.divIcon({
    html: _pinHtml(dungeon, cleared),
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    className: '',
  }));
}

export function getPlayerPos() {
  return playerPos;
}

// デバッグ用：プレイヤー位置を任意座標に強制設定（地図中心も移動）
export function setPlayerPosition(lat, lng) {
  _setPlayer(lat, lng);
  if (map) map.setView([lat, lng], 16);
}
