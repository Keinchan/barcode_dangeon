// ─────────────────────────────────────────────
// 戦闘テンポ設定（高速 / 低速）
// ─────────────────────────────────────────────
//   敵 / ミニオンの攻撃を時系列でどれくらいゆっくり見せるかを切り替える。
//   - fast: 既存の 280ms ステップ。テンポ良く進むが多人数戦は把握しづらい。
//   - slow: ステップ 700ms + 攻撃前テレグラフ（攻撃者のフラッシュ）。
//           誰がどの方向にどんな攻撃をしたかを順番に追えるようにする。
//
//   設定は localStorage に永続化する（端末ごとの好み）。
//   将来「中速」「超低速」を追加する想定で、enum 文字列で管理。
// ─────────────────────────────────────────────

const STORAGE_KEY = 'real_hide:combat-speed:v1';

const PROFILES = {
  fast: {
    label:    '高速',
    desc:     'テンポ重視（演出ほぼ無し）',
    stepMs:    280,    // 攻撃 1 件ごとの間隔
    preFlashMs:  0,    // 攻撃前テレグラフの待ち時間
    showTelegraph: false,
  },
  slow: {
    label:    '低速',
    desc:     '誰が何を攻撃しているか分かる速さ',
    stepMs:    720,
    preFlashMs: 360,
    showTelegraph: true,
  },
  vslow: {
    label:    '超低速',
    desc:     '技マークが出てからダメージ。誰が打ったかしっかり追える',
    stepMs:   1100,
    preFlashMs: 520,
    showTelegraph: true,
  },
  // ultra: 「もっと攻撃スピード攻撃演出のスピードを遅く」要望に対応する最遅プロファイル。
  // テレグラフ → 着弾までを 1 秒以上空け、複数敵の連撃が「順番に」見える速さにする。
  ultra: {
    label:    '極遅',
    desc:     '演出最重視。1 体ずつしっかり追えて何が起きたか必ず把握できる',
    stepMs:   1700,
    preFlashMs: 850,
    showTelegraph: true,
  },
};

let _current = 'fast';
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw && PROFILES[raw]) _current = raw;
} catch {}

export function getCombatSpeed() { return _current; }

export function setCombatSpeed(name) {
  if (!PROFILES[name]) return;
  _current = name;
  try { localStorage.setItem(STORAGE_KEY, name); } catch {}
}

export function combatProfile() {
  return PROFILES[_current] ?? PROFILES.fast;
}

// 攻撃 1 件ごとの間隔（ms）
export function combatStepMs() {
  return combatProfile().stepMs;
}

// 攻撃発動前のテレグラフ（攻撃者をフラッシュさせる時間）。
// 0 ならテレグラフ無し。
export function combatPreFlashMs() {
  return combatProfile().preFlashMs;
}

export function shouldShowTelegraph() {
  return combatProfile().showTelegraph;
}

export const COMBAT_SPEED_NAMES = Object.keys(PROFILES);
export function combatSpeedLabel(name) {
  return PROFILES[name]?.label ?? name;
}
export function combatSpeedDesc(name) {
  return PROFILES[name]?.desc ?? '';
}
