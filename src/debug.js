// URL クエリ ?debug=1 でデバッグモード ON
export const DEBUG = new URLSearchParams(location.search).has('debug');

const state = {
  mockGps: null,             // { lat, lng } セット中ならその座標を実GPSの代わりに使う
  bypassEnterRadius: false,  // ダンジョン入場の80m制限を無視
};

export function getDebugState() {
  return state;
}

export function setMockGps(lat, lng) {
  const lat0 = parseFloat(lat);
  const lng0 = parseFloat(lng);
  if (Number.isFinite(lat0) && Number.isFinite(lng0)) {
    state.mockGps = { lat: lat0, lng: lng0 };
    return true;
  }
  return false;
}

export function clearMockGps() {
  state.mockGps = null;
}

export function setBypassEnterRadius(v) {
  state.bypassEnterRadius = !!v;
}
