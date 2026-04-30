// ─────────────────────────────────────────────
// バーコードスキャンのレート制限とプラチナ結晶通貨
//
//   仕様:
//   - 1 アカウントあたり 1 日 5 回まで無料でスキャンできる
//   - 上限を超えた場合、プラチナ結晶 1 個を消費して +1 回スキャン可能
//   - プラチナ結晶は課金専用通貨（ダンジョン報酬・ドロップでは入手不可）
//   - 日次リセットはローカル時刻の日付境界（YYYY-MM-DD）
//
//   状態は player.scanBudget / player.platinum に保持し、Firestore セーブと
//   一緒に永続化する。クラウドに残るので別端末でも上限引き継ぎ。
// ─────────────────────────────────────────────

export const DAILY_FREE_SCANS = 5;

// ローカルタイムゾーンでの YYYY-MM-DD 文字列。日次リセットの境界判定に使う
function _todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// player の scanBudget / platinum を整合化（旧セーブ互換 + 日次リセット）
export function ensureScanBudget(player) {
  if (typeof player.platinum !== 'number') player.platinum = 0;
  if (!player.scanBudget || typeof player.scanBudget !== 'object') {
    player.scanBudget = { dailyUsed: 0, lastResetDay: _todayKey() };
  }
  if (typeof player.scanBudget.dailyUsed !== 'number') player.scanBudget.dailyUsed = 0;
  if (typeof player.scanBudget.lastResetDay !== 'string') player.scanBudget.lastResetDay = _todayKey();

  // 日付が変わっていたら回数を 0 に戻す
  const today = _todayKey();
  if (player.scanBudget.lastResetDay !== today) {
    player.scanBudget.dailyUsed   = 0;
    player.scanBudget.lastResetDay = today;
  }
  return player.scanBudget;
}

export function getScanStatus(player) {
  ensureScanBudget(player);
  const used  = player.scanBudget.dailyUsed;
  const free  = Math.max(0, DAILY_FREE_SCANS - used);
  return {
    used,
    freeRemaining: free,
    platinum:      player.platinum,
    dailyMax:      DAILY_FREE_SCANS,
  };
}

// スキャンを 1 回消費する。無料枠 → 結晶 → なし、の順で試す
//   戻り値: { ok: true, source: 'free' | 'platinum' } もしくは { ok: false, reason: 'no-platinum' }
export function tryConsumeScan(player) {
  const status = getScanStatus(player);
  if (status.freeRemaining > 0) {
    player.scanBudget.dailyUsed += 1;
    return { ok: true, source: 'free' };
  }
  if ((player.platinum ?? 0) > 0) {
    player.platinum            -= 1;
    player.scanBudget.dailyUsed += 1;
    return { ok: true, source: 'platinum' };
  }
  return { ok: false, reason: 'no-platinum' };
}

export function addPlatinum(player, n) {
  player.platinum = (player.platinum ?? 0) + Math.max(0, n | 0);
}

// デバッグ用：今日のスキャン使用回数を 0 に戻す
export function debugResetDailyScans(player) {
  ensureScanBudget(player);
  player.scanBudget.dailyUsed   = 0;
  player.scanBudget.lastResetDay = _todayKey();
}

// プラチナ結晶の課金購入スタブ。
// TODO: 本番では Stripe / Apple IAP / Google Play Billing 等に置換。
// 現状はテストビルド用に「ボタン押下で N 個付与」する placeholder。
export const PLATINUM_STUB_GRANT = 10;
