// ── モンスター職業制（Phase 5）──
//   バーコード 3 桁目で 8 職業のいずれかが決定論的に選ばれる。
//   各職業は固有の戦闘スタイル（ステータス補正・好む範囲・固有 AI ヒント）と
//   属性 × 職業の動的な命名規則を持つ。
//
//   Dungeon.tickEnemies が aiHint を見て遠距離攻撃 / 範囲攻撃を切り替える。
//   範囲は items.js の RANGE_TYPES と整合（preferredRange は ID 文字列）。

// 命名コンポーネント: 属性プレフィックス（「フレイム」「シャドウ」等）。
// 職業ベース名（「ビースト」等）と組み合わせて完全名にする。
const ELEMENT_PREFIX = {
  '火': 'フレイム',
  '水': 'アクア',
  '草': 'ポイズン',
  '雷': 'サンダー',
  '光': 'シャイン',
  '闇': 'シャドウ',
};

// 職業ベース名 + 各属性ごとの絵文字（属性別バリアントを軽く表現）。
// emoji は属性なしの素の絵文字（fallback も兼ねる）。
//
// inflictOnHit: 攻撃命中時に確率でプレイヤーへ付与する状態異常。
//   { kind, chance, turns, stacks? }。chance は基礎確率（0.0〜1.0）で
//   遠距離技 (`_tryJobRangedAttack` 経由 magic) では確率を 1.5x に増幅する。
const _JOBS_RAW = [
  {
    id: 'beastking',
    label: '獣王',
    baseName: 'ビースト',
    emoji: '🦁',
    statMul:  { hp: 1.30, atk: 1.20, def: 1.00 },
    aiHint:   'rush',          // 隣接突進。素直な近接強敵
    preferredRange: 'ADJ',     // 周囲 8 マスをまとめて殴れる将来拡張用
    chargeBonus: 0,            // 特殊行動チャージ無し（普通の近接）
    inflictOnHit: { kind: 'fracture', chance: 0.10, turns: 4 },
    desc: '獰猛な近接型。HP・攻撃力ともに高い',
  },
  {
    id: 'martialist',
    label: '武道家',
    baseName: 'モンク',
    emoji: '🥋',
    statMul:  { hp: 1.00, atk: 1.15, def: 0.95 },
    aiHint:   'doublehit',     // 3 ターンに 1 度、隣接時に 2 連撃
    preferredRange: 'CROSS',
    chargeBonus: 1,
    inflictOnHit: { kind: 'fracture', chance: 0.15, turns: 4 },
    desc: '素早い拳。隣接時にたまに 2 連撃を放つ',
  },
  {
    id: 'horror',
    label: 'ホラーマン',
    baseName: 'ホラー',
    emoji: '👻',
    statMul:  { hp: 0.90, atk: 1.10, def: 0.80 },
    aiHint:   'phaseseal',     // 3 ターンに 1 度、隣接プレイヤーに seal を付与
    preferredRange: 'DIAG',
    chargeBonus: 0,
    inflictOnHit: { kind: 'confuse', chance: 0.18, turns: 4 },
    desc: '霊体の脅威。隣接時にときおり封印（技封じ）を放つ',
  },
  {
    id: 'bat',
    label: 'コウモリ',
    baseName: 'バット',
    emoji: '🦇',
    statMul:  { hp: 0.75, atk: 0.90, def: 0.75 },
    aiHint:   'line3',         // 直線 3 マスから飛び道具（LINE3）
    preferredRange: 'LINE3',
    chargeBonus: 1,
    inflictOnHit: { kind: 'spasm', chance: 0.20, turns: 4 },
    desc: '紙装甲だが直線 3 マス先まで超音波を飛ばす',
  },
  {
    id: 'skeleton',
    label: 'スケルトン',
    baseName: 'スケルトン',
    emoji: '💀',
    statMul:  { hp: 1.05, atk: 1.00, def: 1.20 },
    aiHint:   'rush',
    preferredRange: 'CROSS',
    chargeBonus: 0,
    inflictOnHit: { kind: 'fracture', chance: 0.12, turns: 4 },
    desc: '骨の鎧。防御力が高い純粋な近接',
  },
  {
    id: 'serpent',
    label: '蛇族',
    baseName: 'サーペント',
    emoji: '🐍',
    statMul:  { hp: 0.95, atk: 1.10, def: 0.90 },
    aiHint:   'pierce',        // 直線貫通（PIERCE 風）
    preferredRange: 'PIERCE',
    chargeBonus: 1,
    inflictOnHit: { kind: 'poison', chance: 0.25, turns: 5, stacks: 1 },
    desc: '一直線に貫く牙。同列・同行のプレイヤーに飛び込み攻撃',
  },
  {
    id: 'zombie',
    label: 'ゾンビ',
    baseName: 'ゾンビ',
    emoji: '🧟',
    statMul:  { hp: 1.40, atk: 0.95, def: 0.90 },
    aiHint:   'regen',         // 毎ターン少量回復
    preferredRange: 'MELEE',
    chargeBonus: 0,
    inflictOnHit: { kind: 'sleep', chance: 0.08, turns: 2 },
    desc: '腐肉の塊。HP がとても多く、ターンごとに少量回復する',
  },
  {
    id: 'dragon',
    label: 'ドラゴン',
    baseName: 'ドラゴン',
    emoji: '🐉',
    statMul:  { hp: 1.50, atk: 1.30, def: 1.20 },
    aiHint:   'breath',        // 5 ターンに 1 度、視線が通っていれば LINE5 ブレス
    preferredRange: 'LINE5',
    chargeBonus: 2,            // チャージはやや遅め（ロマン砲枠）
    inflictOnHit: { kind: 'burn', chance: 0.28, turns: 5, stacks: 1 },
    desc: '伝説級の強敵。まれに正面 5 マスのブレスを放つ',
  },
];

// 属性ベースのフォールバック付与（job.inflictOnHit が無い場合でも、
// 属性が一致する魔法攻撃で確率的に状態異常を狙う）。
// 主属性に合う状態異常を低確率で乗せて「敵から状態異常を貰う」UX を確保する。
const _ELEMENT_INFLICT = {
  '火': { kind: 'burn',    chance: 0.10, turns: 4, stacks: 1 },
  '水': { kind: 'sleep',   chance: 0.08, turns: 2 },
  '草': { kind: 'poison',  chance: 0.12, turns: 4, stacks: 1 },
  '雷': { kind: 'shock',   chance: 0.12, turns: 4 },
  '光': { kind: 'spasm',   chance: 0.10, turns: 4 },
  '闇': { kind: 'confuse', chance: 0.10, turns: 4 },
};

// 命中 1 発分の状態異常付与をロールする。
//   isRanged=true の場合は確率を 1.3x（飛び道具ほど刺さる）。
//   優先順: ジョブの inflictOnHit → 属性フォールバック。
// 戻り値: { kind, turns, stacks } もしくは null。
export function rollInflictOnHit(mob, opts = {}) {
  if (!mob) return null;
  const ranged = !!opts.ranged;
  const job    = mob.job;
  const inflict = job?.inflictOnHit ?? _ELEMENT_INFLICT[mob.element];
  if (!inflict) return null;
  const chance = Math.min(1, (inflict.chance ?? 0) * (ranged ? 1.3 : 1.0));
  if (Math.random() >= chance) return null;
  return {
    kind:   inflict.kind,
    turns:  inflict.turns  ?? 4,
    stacks: inflict.stacks ?? 1,
  };
}

// id → job の lookup
const _BY_ID = Object.fromEntries(_JOBS_RAW.map(j => [j.id, j]));

// 配列インデックス順（決定論的選択用）。
export const MONSTER_JOBS = _JOBS_RAW.slice();

// バーコード 3 桁目（0-indexed = 2）から職業を決める。
// digit が無いケースのフォールバックは beastking。
export function jobForBarcode(barcode) {
  const ch = barcode?.[2];
  const d  = Number(ch);
  if (!Number.isFinite(d)) return _BY_ID.beastking;
  return MONSTER_JOBS[d % MONSTER_JOBS.length];
}

// 旧データ（職業未設定）から id 文字列で復元したい時用
export function findJob(id) {
  return _BY_ID[id] ?? null;
}

// 属性 × 職業 → 「シャドウスケルトン」「フレイムビースト」のような完全名。
// 雷ドラゴン → サンダードラゴン、闇スケルトン → シャドウスケルトン 等。
export function monsterDisplayName(job, element) {
  const prefix = ELEMENT_PREFIX[element] ?? '';
  return `${prefix}${job.baseName}`;
}

// ボス用の冠付き名前。
export function monsterBossName(job, element) {
  return `👑 ${monsterDisplayName(job, element)}王`;
}

// 職業のステータス補正をベース stats に乗じて HP/ATK/DEF を返す。
// individualVariation は generator 側で 0.85〜1.15 の個体差を更に乗せる。
export function applyJobStats(baseStats, job) {
  const m = job.statMul;
  return {
    hp:  Math.max(1, Math.round(baseStats.maxHp   * m.hp)),
    atk: Math.max(1, Math.round(baseStats.atkBase * m.atk)),
    def: Math.max(0, Math.round(baseStats.defBase * m.def)),
  };
}
