// ─────────────────────────────────────────────
// 状態異常（マラディ）システム
// ─────────────────────────────────────────────
//   プレイヤーと敵が共通で罹患・付与できるバッドステータス群。
//   既存の stun/seal は m.status (単独) で管理されているのでそのまま温存し、
//   新しい 7 種類は target.statuses（配列）で管理する。
//
//   毒  poison   ターン経過で HP 減少。stacks が増えるほど減少量が大きく
//   熱傷 burn    ターン経過で HP 減少 + 使用 MP +1
//   錯乱 confuse 入力方向がランダム化（move/技 共通）
//   睡魔 sleep   行動できない（強制待機）
//   感電 shock   一定確率で待機させられる
//   骨折 fracture 行動するたび一定確率で自傷
//   痙攣 spasm   命中率がダウン
//
//   target.statuses[i] = { kind, turns, stacks?, potency? }
// ─────────────────────────────────────────────

export const STATUS_DEFS = {
  poison: {
    label: '毒', emoji: '☠', color: '#9c27b0',
    desc: '毎ターン HP が減少し、ターンを重ねるごとに減少量が増す。',
    overlay: 'rgba(156,39,176,0.18)',
    isBlock: false, isMod: false, isDot: true,
  },
  burn: {
    label: '熱傷', emoji: '🔥', color: '#ff7043',
    desc: '毎ターン HP が減少し、技の使用 MP が +1 される。',
    overlay: 'rgba(255,112,67,0.18)',
    isBlock: false, isMod: true, isDot: true,
  },
  confuse: {
    label: '錯乱', emoji: '😵', color: '#ffd54f',
    desc: '移動・技の方向がランダム化される。',
    overlay: 'rgba(255,213,79,0.16)',
    isBlock: false, isMod: true, isDot: false,
  },
  sleep: {
    label: '睡魔', emoji: '😴', color: '#90caf9',
    desc: '行動できない（強制的に待機）。攻撃を受けると確率で起きる。',
    overlay: 'rgba(144,202,249,0.18)',
    isBlock: true, isMod: false, isDot: false,
  },
  shock: {
    label: '感電', emoji: '⚡', color: '#fff176',
    desc: '入力したコマンドが一定確率で待機に置き換わる。',
    overlay: 'rgba(255,241,118,0.16)',
    isBlock: false, isMod: true, isDot: false,
  },
  fracture: {
    label: '骨折', emoji: '🦴', color: '#ef9a9a',
    desc: '行動するたび一定確率で自傷ダメージを受ける。',
    overlay: 'rgba(239,154,154,0.16)',
    isBlock: false, isMod: true, isDot: false,
  },
  spasm: {
    label: '痙攣', emoji: '💢', color: '#ce93d8',
    desc: '技の命中率がダウンする。',
    overlay: 'rgba(206,147,216,0.16)',
    isBlock: false, isMod: true, isDot: false,
  },
};

// 状態異常を付与（既存の同種があれば turns を上書き、stacks を加算）。
//   target は player or monster。target.statuses が無ければ初期化する。
//   opts: { turns, stacks }
export function applyStatus(target, kind, opts = {}) {
  if (!target) return false;
  if (!STATUS_DEFS[kind]) return false;
  if (!Array.isArray(target.statuses)) target.statuses = [];
  const turns  = Math.max(1, opts.turns | 0 || 4);
  const stacks = Math.max(1, opts.stacks | 0 || 1);
  const ex = target.statuses.find(s => s.kind === kind);
  if (ex) {
    ex.turns  = Math.max(ex.turns ?? 0, turns);
    ex.stacks = (ex.stacks ?? 1) + stacks;
    return true;
  }
  target.statuses.push({ kind, turns, stacks });
  return true;
}

export function hasStatus(target, kind) {
  if (!target?.statuses) return false;
  return target.statuses.some(s => s.kind === kind && (s.turns ?? 0) > 0);
}

export function removeStatus(target, kind) {
  if (!target?.statuses) return;
  target.statuses = target.statuses.filter(s => s.kind !== kind);
}

// ターン経過: turns を 1 減らし、0 以下になったエントリを除去。
// poison / burn の DoT も計算してダメージ値を返す（呼び出し側が apply）。
//   戻り値: { dotDamage, mpExtra, expired: [{ kind }], cleared: bool }
export function tickStatuses(target) {
  let dotDamage = 0;
  let mpExtra   = 0;
  const expired = [];
  if (!Array.isArray(target?.statuses) || target.statuses.length === 0) {
    return { dotDamage, mpExtra, expired, cleared: false };
  }
  for (const s of target.statuses) {
    if (s.kind === 'poison') {
      // stacks が大きいほど痛む。基礎 2 + stacks
      dotDamage += 2 + (s.stacks ?? 1);
    } else if (s.kind === 'burn') {
      dotDamage += 3;
      mpExtra   += 1;   // 技を撃つたびに +1 されるのは別所で参照
    }
    s.turns -= 1;
  }
  // 期限切れを取り除く
  const remaining = [];
  for (const s of target.statuses) {
    if ((s.turns ?? 0) <= 0) {
      expired.push({ kind: s.kind });
    } else {
      remaining.push(s);
    }
  }
  target.statuses = remaining;
  return { dotDamage, mpExtra, expired, cleared: remaining.length === 0 };
}

// 命中率ダウン（痙攣中）の補正係数を返す。
//   スタック数で更にダウン（最大 -50%）。
export function accuracyMultiplier(target) {
  if (!hasStatus(target, 'spasm')) return 1;
  const s = target.statuses.find(x => x.kind === 'spasm');
  const stacks = s?.stacks ?? 1;
  return Math.max(0.5, 1 - 0.15 * stacks);
}

// 感電中に行動が待機に置き換わる確率
export function shockSkipChance(target) {
  if (!hasStatus(target, 'shock')) return 0;
  const s = target.statuses.find(x => x.kind === 'shock');
  const stacks = s?.stacks ?? 1;
  return Math.min(0.5, 0.20 + 0.08 * (stacks - 1));
}

// 骨折中に自傷を起こす確率
export function fractureSelfHurtChance(target) {
  if (!hasStatus(target, 'fracture')) return 0;
  const s = target.statuses.find(x => x.kind === 'fracture');
  const stacks = s?.stacks ?? 1;
  return Math.min(0.45, 0.18 + 0.08 * (stacks - 1));
}

// 罹患中の最も派手な status を 1 個返す（オーバーレイ色決定用）。
export function dominantStatus(target) {
  if (!Array.isArray(target?.statuses) || target.statuses.length === 0) return null;
  // 優先度: sleep > confuse > shock > burn > poison > fracture > spasm
  const order = ['sleep','confuse','shock','burn','poison','fracture','spasm'];
  for (const k of order) {
    const s = target.statuses.find(x => x.kind === k && (x.turns ?? 0) > 0);
    if (s) return s;
  }
  return null;
}
