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
  // ── 攻防バフ（ポジティブ） ──
  // 持続中はプレイヤーの atk / def を加算倍率で底上げする。statuses[] に乗せて
  // tickStatuses でターンごとに残りターンを減らす（既存のデバフと同じ仕組み）。
  // 表示色は warm gold 系（バフ）/ cool blue 系（防御）にして、デバフと混同しない。
  atkUp: {
    label: '攻撃力アップ', emoji: '💪', color: '#ffb74d',
    desc: '攻撃力 +30%（戦闘の与ダメージが伸びる）。',
    overlay: 'rgba(255,183,77,0.10)',
    isBlock: false, isMod: false, isDot: false, isBuff: true,
    atkAdd: 0.30,
  },
  atkUpHigh: {
    label: '攻撃力アップ・強', emoji: '🔥', color: '#ff7043',
    desc: '攻撃力 +60%（強化版・短時間で大火力）。',
    overlay: 'rgba(255,112,67,0.12)',
    isBlock: false, isMod: false, isDot: false, isBuff: true,
    atkAdd: 0.60,
  },
  defUp: {
    label: '防御力アップ', emoji: '🛡️', color: '#64b5f6',
    desc: '防御力 +30%（被ダメージが減る）。',
    overlay: 'rgba(100,181,246,0.10)',
    isBlock: false, isMod: false, isDot: false, isBuff: true,
    defAdd: 0.30,
  },
  defUpHigh: {
    label: '防御力アップ・強', emoji: '🏰', color: '#1e88e5',
    desc: '防御力 +60%（強化版・短時間で固くなる）。',
    overlay: 'rgba(30,136,229,0.12)',
    isBlock: false, isMod: false, isDot: false, isBuff: true,
    defAdd: 0.60,
  },
  agility: {
    label: '瞬発力アップ', emoji: '💨', color: '#80deea',
    desc: '1 ターンに 2 回行動できる（移動・技・通常攻撃いずれも）。',
    overlay: 'rgba(128,222,234,0.10)',
    isBlock: false, isMod: false, isDot: false, isBuff: true,
    extraActions: 1,           // 1 ターンの中で +1 回（合計 2 回行動）
  },
  agilityHigh: {
    label: '瞬発力アップ・強', emoji: '⚡', color: '#26c6da',
    desc: '1 ターンに 3 回行動できる（強化版・短時間の超機動）。',
    overlay: 'rgba(38,198,218,0.12)',
    isBlock: false, isMod: false, isDot: false, isBuff: true,
    extraActions: 2,           // 合計 3 回行動
  },

  // ── デバフ（ネガティブ） ──
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
// バフ（atkUp / defUp 等）はオーバーレイには使わない（重ねがけ前提なので、
// 「いま何かが起きている」より「個別の chip 表示」の方が読みやすい）。
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

// ── バフ累積倍率 ──
// statuses[] にぶら下がっている atkUp / defUp 系を集計し、加算倍率
// （atkAdd / defAdd の合計を 1 + Σ で返す）を返す。同種の重ねがけは
// applyStatus 側で turns 上書き + stacks 加算されるため、原則 1 個ずつ。
// 異なる強度（atkUp + atkUpHigh）が同時にぶら下がった時は両方加算するので
// 1.0 + 0.30 + 0.60 = 1.90 になる（仕様上は撃つ側がそうしたいなら可）。
export function attackBuffMult(target) {
  let mult = 1;
  for (const s of target?.statuses ?? []) {
    if ((s.turns ?? 0) <= 0) continue;
    const def = STATUS_DEFS[s.kind];
    if (def?.atkAdd) mult += def.atkAdd;
  }
  return mult;
}

export function defenseBuffMult(target) {
  let mult = 1;
  for (const s of target?.statuses ?? []) {
    if ((s.turns ?? 0) <= 0) continue;
    const def = STATUS_DEFS[s.kind];
    if (def?.defAdd) mult += def.defAdd;
  }
  return mult;
}

// 1 ターンに何回行動できるかを返す（base 1 + agility 系の extraActions の最大）。
//   agility (+1) と agilityHigh (+2) が両方付いていれば最大値を採用（重複加算しない）。
export function actionsPerTurn(target) {
  let extra = 0;
  for (const s of target?.statuses ?? []) {
    if ((s.turns ?? 0) <= 0) continue;
    const def = STATUS_DEFS[s.kind];
    if (def?.extraActions) extra = Math.max(extra, def.extraActions);
  }
  return 1 + extra;
}

// 表示用: いま付いているバフ（statuses[].isBuff=true なエントリ）の一覧
export function activeBuffs(target) {
  const out = [];
  for (const s of target?.statuses ?? []) {
    if ((s.turns ?? 0) <= 0) continue;
    const def = STATUS_DEFS[s.kind];
    if (def?.isBuff) out.push({ kind: s.kind, turns: s.turns, def });
  }
  return out;
}
