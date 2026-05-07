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
let onEnterCb         = null;
let isClearedCb       = null;
let difficultyCb      = null;
let recommendedLvCb   = null;
// ユーザーが手動でドラッグ／ピンチした最後の時刻。直後 N 秒は GPS 更新で
// 自動再センタリングしない（離れた場所のピンを見たい時用）。それ以外は
// 常にプレイヤーが地図の中心に来るよう追従する。
let _lastManualPanAt = 0;
const FOLLOW_PAUSE_MS = 6000;
// 表示しているピンの掃除半径（プレイヤーから N メートル超のピンは削除）。
// 電車などで長距離移動したあとに古いピンが地図に残ると、付近のダンジョンタップを
// 妨害したり、メモリも肥大化するため一定距離で破棄する。
const PIN_KEEP_RADIUS_M = 3000;

export function initMap({ onEnter, isCleared, difficulty, recommendedLv } = {}) {
  onEnterCb       = onEnter       ?? null;
  isClearedCb     = isCleared     ?? null;
  difficultyCb    = difficulty    ?? null;
  recommendedLvCb = recommendedLv ?? null;

  map = L.map('map', { zoomControl: false })
    .setView([35.6762, 139.6503], 16);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  L.control.zoom({ position: 'topright' }).addTo(map);

  // ドラッグ／ピンチで手動移動した直後は短時間だけ追従を一時停止する。
  // mousedown/touchstart は登録時点で即発火することがあるので dragstart を使う。
  map.on('dragstart',  () => { _lastManualPanAt = Date.now(); });
  map.on('zoomstart',  () => { _lastManualPanAt = Date.now(); });

  // 「現在地」ボタン：手動操作後にすぐ自分の位置に戻したい時用
  _addRecenterButton();

  // GPS追従＋追従に応じて固定湧きダンジョン更新
  // maximumAge を短めにして電車移動などでも追従する。watchPosition がエラーで
  // 抜けた場合は 30 秒後に再起動を試みる（電車のトンネルなどで一時的にロスト
  // しても自動復帰させる）。
  if (navigator.geolocation) {
    _startGeolocationWatch();
  } else {
    _refreshDungeons(35.6762, 139.6503);
  }
}

let _watchId = null;
function _startGeolocationWatch() {
  if (_watchId !== null) {
    try { navigator.geolocation.clearWatch(_watchId); } catch {}
  }
  _watchId = navigator.geolocation.watchPosition(
    pos => _setPlayer(pos.coords.latitude, pos.coords.longitude),
    err => {
      console.warn('geolocation watch error:', err?.message);
      // フォールバック：playerPos がまだ無ければ東京で湧きだけ描画。
      // ある場合は前回位置を保持しつつ 30 秒後に再起動を試みる。
      if (!playerPos) _refreshDungeons(35.6762, 139.6503);
      setTimeout(_startGeolocationWatch, 30000);
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
  );
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
  // GPS 更新ごとにプレイヤー位置を画面中央へ。歩きや電車での移動でも
  // 「自分が常に真ん中」になり、周囲のピンが自動で見える。
  // 直近で手動操作（ドラッグ/ズーム）があった場合のみ、しばらく追従を保留する。
  if (Date.now() - _lastManualPanAt > FOLLOW_PAUSE_MS) {
    map.setView([lat, lng], map.getZoom() ?? 16, { animate: true });
  }

  _refreshDungeons(lat, lng);
}

function _refreshDungeons(lat, lng) {
  const dungeons = getDungeonsNear(lat, lng, 1500);
  for (const d of dungeons) {
    if (renderedPins.has(d.seed)) continue;
    _addDungeonPin(d);
  }
  // プレイヤーから遠すぎる古いピンを掃除（電車等で長距離移動した後の残骸対策）
  for (const [seed, entry] of renderedPins) {
    const dist = distanceMeters(lat, lng, entry.dungeon.lat, entry.dungeon.lng);
    if (dist > PIN_KEEP_RADIUS_M) {
      try { entry.marker.remove(); } catch {}
      renderedPins.delete(seed);
    }
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

  const diff   = difficultyCb?.(dungeon);
  const recLv  = recommendedLvCb?.(dungeon);
  const diffLine = diff
    ? `<div style="margin-top:2px">評価: <b style="color:${diff.color}">${diff.label}</b>`
      + (recLv != null ? ` <span style="color:#888;font-size:11px">(推奨Lv${recLv})</span>` : '')
      + `</div>`
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

// 画面切替などで #map のサイズが変わった時に Leaflet 内部のサイズキャッシュを更新
export function invalidateMapSize() {
  if (map) map.invalidateSize();
}

// マップ画面復帰時に呼ぶ：現在の playerPos に強制再センタリング。
// ダンジョン入場〜離脱の間に GPS が大きく動いた場合、地図の中心が古い位置に
// 残っていると別のダンジョンが画面外で選べないので、必ず追従させる。
export function recenterOnPlayer() {
  if (!map || !playerPos) return false;
  _lastManualPanAt = 0;       // 強制復帰時は手動 pan の保留も解除する
  map.setView([playerPos.lat, playerPos.lng], map.getZoom() ?? 16, { animate: false });
  return true;
}

// ダンジョン→マップ復帰時に呼ぶ：watchPosition がブラウザのバックグラウンド
// スロットリングや error fallback の 30 秒待ちで止まっている可能性があるので、
// 必ず watch を貼り直して即時 getCurrentPosition も併用する。
// 「死んで戻った直後にマップをワンタップしないと現在地が更新されない」UX バグの根治。
export function resumeGeolocation() {
  if (!navigator.geolocation) return;
  _startGeolocationWatch();    // 旧 watch を clearWatch → 新 watch
  // 即時 1 回も叩いて UI を最新化（watchPosition の初回コールバックは
  // 端末によっては数秒〜数十秒遅延するため）
  try {
    navigator.geolocation.getCurrentPosition(
      pos => _setPlayer(pos.coords.latitude, pos.coords.longitude),
      err => { console.warn('resumeGeolocation getCurrentPosition error:', err?.message); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
    );
  } catch (e) { /* ignore */ }
}

// 右下に「現在地」ボタンを置く（leaflet コントロールとして実装）。
// 手動でマップを動かした後、すぐ自分の位置に戻したい時用。
function _addRecenterButton() {
  const Ctl = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd: () => {
      const btn = L.DomUtil.create('button', 'leaflet-bar map-recenter-btn');
      btn.type = 'button';
      btn.title = '現在地に戻る';
      btn.textContent = '🎯';
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, 'click', () => recenterOnPlayer());
      return btn;
    },
  });
  new Ctl().addTo(map);
}

// デバッグ用：プレイヤー位置を任意座標に強制設定（地図中心も移動）
export function setPlayerPosition(lat, lng) {
  _setPlayer(lat, lng);
  if (map) map.setView([lat, lng], 16);
}
