import { createRNG, hashString } from './rng.js';

// ── レアリティ ──
export const RARITIES = [
  { name: 'コモン',     color: '#9e9e9e', mult: 1.0 },
  { name: 'レア',       color: '#29b6f6', mult: 1.7 },
  { name: 'エピック',   color: '#ab47bc', mult: 2.6 },
  { name: 'レジェンド', color: '#ffc107', mult: 4.2 },
];

// バーコード末尾1桁でレアリティ決定
// 0-4: コモン, 5-7: レア, 8: エピック, 9: レジェンド
export function rarityFromDigit(d) {
  if (d === 9) return RARITIES[3];
  if (d === 8) return RARITIES[2];
  if (d >= 5)  return RARITIES[1];
  return RARITIES[0];
}

// レアリティを1段階上げる（フォーマットボーナス用、上限あり）
export function bumpRarity(rarity, steps = 1) {
  const idx = RARITIES.indexOf(rarity);
  if (idx === -1) return rarity;
  return RARITIES[Math.min(RARITIES.length - 1, idx + steps)];
}

// ── 属性（直感的な 6 属性） ──
//   火 / 水 / 草 / 雷 / 光 / 闇。相性は「自然サイクル」と「神秘サイクル」の
//   2 つの 3 元素ループ：
//     自然: 火 > 草 > 水 > 火（ ★ 燃やす / 吸う / 消火 ）
//     神秘: 光 > 闇 > 雷 > 光（ ★ 照らす / 呑む / 帯電 ）
//   別サイクル間は 1.0 倍（中立）なので、覚える相性はサイクルあたり 3 つ。
//
//   ELEMENTS の長さは 6 のまま（`% ELEMENTS.length` 由来の決定論性を維持）。
//   旧セーブは ELEMENT_LEGACY_MAP で新表記にマッピングしてロード時に変換する。
export const ELEMENTS = ['火', '水', '草', '雷', '光', '闇'];

// 旧属性（さらに前世代の手描き属性も含む）→ 新属性のマッピング。
// 過去にこのプロジェクトでは「火/水/地/風/光/闇」→「棒人間/落書き/折り紙/ピクセル/ホログラム/影絵」
// と 1 度移行したため、両方の旧表記を新表記に変換する必要がある。
export const ELEMENT_LEGACY_MAP = {
  // 第 1 世代（クラシック RPG 表記）→ 新表記
  '火': '火',
  '水': '水',
  '地': '草',
  '風': '雷',
  '光': '光',
  '闇': '闇',
  // 第 2 世代（手描きスタイル表記）→ 新表記
  '棒人間':     '火',
  '落書き':     '水',
  '影絵':       '闇',
  'ピクセル':   '雷',
  'ホログラム': '光',
  '折り紙':     '草',
};

// 既存アイテム/モンスターの element 文字列が旧表記なら新表記に書き換える
export function migrateElement(element) {
  if (!element) return element;
  return ELEMENT_LEGACY_MAP[element] ?? element;
}

// 属性相性（攻撃側 → 防御側 = ダメージ倍率）。
// 2 つの 3 元素サイクル：
//   自然: 火 → 草 → 水 → 火
//   神秘: 光 → 闇 → 雷 → 光
// 別サイクル間は 1.0 倍（中立）。同サイクル内は「天敵」「獲物」の関係。
const _STRONG_AGAINST = {
  '火': '草',
  '草': '水',
  '水': '火',
  '光': '闇',
  '闇': '雷',
  '雷': '光',
};

// UI 表示用：各属性の「強い相手」「弱い相手（自分を倒す者）」を返す
export function elementMatchupTable() {
  const out = [];
  for (const el of ELEMENTS) {
    const strongAgainst = _STRONG_AGAINST[el];
    const weakAgainst   = ELEMENTS.find(e => _STRONG_AGAINST[e] === el);
    out.push({ element: el, strongAgainst, weakAgainst });
  }
  return out;
}

export function elementMatchup(attacker, defender) {
  if (!attacker || !defender) return 1.0;
  if (_STRONG_AGAINST[attacker] === defender) return 1.5;
  if (_STRONG_AGAINST[defender] === attacker) return 0.7;
  return 1.0;
}

// 効果の言い回し（バトルログ表示用）
export function matchupLabel(mult) {
  if (mult >= 1.5) return '効果絶大！';
  if (mult <= 0.7) return '効果今ひとつ...';
  return '';
}

// ── ベース武器 / 防具 ──
const WEAPONS = [
  { base: '短剣',   emoji: '🗡️', atkBonus: 3 },
  { base: '剣',     emoji: '⚔️', atkBonus: 5 },
  { base: '斧',     emoji: '🪓', atkBonus: 7 },
  { base: '槍',     emoji: '🔱', atkBonus: 6 },
  { base: '魔法杖', emoji: '🪄', atkBonus: 9 },
];

const ARMORS = [
  { base: '盾',     emoji: '🛡️', defBonus: 3 },
  { base: '鎧',     emoji: '⚙️', defBonus: 5 },
  { base: 'マント', emoji: '🧥', defBonus: 4 },
];

const POTIONS = [
  { base: '小回復薬', emoji: '🧪', heal: 12 },
  { base: '回復薬',   emoji: '💊', heal: 28 },
  { base: '大回復薬', emoji: '💉', heal: 55 },
];

// MP 回復薬（青系）。potion 種別で digits[6] が偶数なら HP、奇数なら MP に分岐。
// HP/MP の決定論性を保つため、専用テーブルを用意する。
const MP_POTIONS = [
  { base: '小マナ薬', emoji: '🔵', mpHeal: 8  },
  { base: 'マナ薬',   emoji: '💎', mpHeal: 18 },
  { base: '大マナ薬', emoji: '🩵', mpHeal: 36 },
];

// 巻物は新属性に対応した 6 種類。それぞれ ELEMENTS 内の 1 属性とリンクする
const SCROLLS = [
  { base: '炎の巻物', emoji: '🔥', dmg: 18, element: '火' },
  { base: '水の巻物', emoji: '💧', dmg: 16, element: '水' },
  { base: '草の巻物', emoji: '🌿', dmg: 17, element: '草' },
  { base: '雷の巻物', emoji: '⚡', dmg: 20, element: '雷' },
  { base: '光の巻物', emoji: '✨', dmg: 22, element: '光' },
  { base: '闇の巻物', emoji: '🌑', dmg: 19, element: '闇' },
];

// ── 装備の名前接尾辞（レアリティ毎・武器/防具共通） ──
const NAME_SUFFIXES = {
  コモン:     ['', '', '', '・粗', '・古'],            // ほとんどは無印（同名のレア違いを成立させる）
  レア:       ['', '+1', 'の煌き', 'の輝き', '・改', '・銘'],
  エピック:   ['', '・烈', '・覇', 'の業', '・極', 'の威'],
  レジェンド: ['', '・神威', '・終焉', '・龍王', '・破滅', 'の天嗣'],
};

// ── レアリティ別プレフィックス（接頭詞） ──
//   稀に空文字（同名でもレア違いが出るように）
const NAME_PREFIXES = {
  コモン:     ['', '', '', '錆びた', '欠けた'],
  レア:       ['', '', '練磨の', '鍛えし', '銀の'],
  エピック:   ['', '貴き', '黄金の', '霊妙の', '英雄の'],
  レジェンド: ['', '神器・', '冥府の', '伝説の', '神話の'],
};

// ── 装備に付くスキル / 効果（レアリティ毎） ──
// effect.kind:
//   none      : スキルなし（コモン）
//   crit      : 攻撃時クリティカル率上昇
//   pierce    : 一定割合で防御無視
//   element   : 攻撃に属性追加ダメージ
//   reflect   : 被ダメ反射
//   regen     : 戦闘ターンごとに自動HP回復
//   guard     : 致死ダメージを1度だけ無効化
//   lifesteal : 与ダメの一部HP吸収
const WEAPON_SKILLS = {
  コモン: [
    { name: '', kind: 'none' },
  ],
  レア: [
    { name: '鋭刃',   kind: 'crit',    value: 0.15, desc: 'クリティカル率+15%' },
    { name: '鋼撃',   kind: 'pierce',  value: 0.20, desc: '20%で防御を貫通' },
  ],
  エピック: [
    { name: '烈火連斬', kind: 'element', value: 7,  element: '火', desc: '攻撃時+7火ダメージ' },
    { name: '吸血の刃', kind: 'lifesteal', value: 0.20,           desc: '与ダメの20%HP吸収' },
    { name: '雷光斬',   kind: 'crit',    value: 0.30,             desc: 'クリティカル率+30%' },
  ],
  レジェンド: [
    { name: '龍王の咆哮', kind: 'element',   value: 15, element: '火', desc: '攻撃時+15火ダメージ' },
    { name: '神器・万象', kind: 'pierce',    value: 0.50,              desc: '50%で防御を完全無視' },
    { name: '吸魂の理',   kind: 'lifesteal', value: 0.40,              desc: '与ダメの40%HP吸収' },
  ],
};

const ARMOR_SKILLS = {
  コモン: [
    { name: '', kind: 'none' },
  ],
  レア: [
    { name: '硬殻',   kind: 'reflect', value: 0.10, desc: '被ダメ10%を反射' },
    { name: '癒守',   kind: 'regen',   value: 2,    desc: '毎ターンHP+2回復' },
  ],
  エピック: [
    { name: '聖盾の加護', kind: 'reflect', value: 0.25, desc: '被ダメ25%を反射' },
    { name: '再生の鎧',   kind: 'regen',   value: 5,    desc: '毎ターンHP+5回復' },
  ],
  レジェンド: [
    { name: '不死身の守り', kind: 'guard',   value: 1,    desc: '致命傷を1度防ぐ' },
    { name: '神龍の鱗',     kind: 'reflect', value: 0.50, desc: '被ダメ50%を反射' },
  ],
};

// ── バーコード → アイテム生成 ──
// 全桁合計 % 4 でアイテム種別決定
// 0=武器  1=防具  2=回復薬  3=巻物
//
// rarityOverride: レアリティを上書き（モンスターのレアリティに合わせる時など）
// levelOverride : アイテムLv 1..100。指定時はステータスに level スケーリングが乗る
export function generateItemFromBarcode(barcode, rarityOverride = null, levelOverride = null) {
  const rng       = createRNG(hashString('item:' + barcode));
  const digits    = barcode.split('').map(Number);
  const digitSum  = digits.reduce((a, b) => a + b, 0);
  const typeIdx   = digitSum % 4;
  const rarity    = rarityOverride ?? rarityFromDigit(digits[digits.length - 1]);
  const elemIdx   = parseInt(barcode.slice(3, 5), 10) % ELEMENTS.length;
  const element   = ELEMENTS[elemIdx];
  const level     = Math.max(1, Math.min(100, levelOverride ?? 1));

  switch (typeIdx) {
    case 0: return _buildWeapon(barcode, rng, rarity, element, level);
    case 1: return _buildArmor(barcode, rng, rarity, element, level);
    case 2: {
      // 薬カテゴリ内で digits[6] により HP/MP を振り分け（決定論的）
      const isMp = (digits[6] % 2) === 1;
      return isMp
        ? _buildMpPotion(barcode, rng, rarity, level)
        : _buildPotion   (barcode, rng, rarity, level);
    }
    default: return _buildScroll(barcode, rng, rarity, element, level);
  }
}

// 装備のレベル係数。Lv1で1.0、Lv100で約 4.96 になる緩いカーブ
function _levelMult(level) {
  return 1 + (level - 1) * 0.04;
}

function _pickSuffix(rarity, rng) {
  const list = NAME_SUFFIXES[rarity.name] ?? [''];
  return list[Math.floor(rng() * list.length)];
}

function _pickPrefix(rarity, rng) {
  const list = NAME_PREFIXES[rarity.name] ?? [''];
  return list[Math.floor(rng() * list.length)];
}

function _pickSkill(table, rarity, rng) {
  const list = table[rarity.name] ?? [{ name: '', kind: 'none' }];
  return list[Math.floor(rng() * list.length)];
}

function _buildWeapon(barcode, rng, rarity, element, level) {
  const base   = WEAPONS[Math.floor(rng() * WEAPONS.length)];
  const bonus  = Math.max(1, Math.floor(
    base.atkBonus * rarity.mult * _levelMult(level) * (0.8 + rng() * 0.4),
  ));
  const skill  = _pickSkill(WEAPON_SKILLS, rarity, rng);
  const prefix = _pickPrefix(rarity, rng);
  const suffix = _pickSuffix(rarity, rng);
  const name   = `${prefix}${element}の${base.base}${suffix}`;
  const desc   = skill.kind === 'none'
    ? `ATK +${bonus}（${element}属性）`
    : `ATK +${bonus} / ${skill.name}: ${skill.desc}`;

  return {
    type: 'weapon', barcode,
    name, emoji: base.emoji,
    rarity: rarity.name, rarityColor: rarity.color, element, level,
    atkBonus: bonus, defBonus: 0,
    skill,
    desc,
  };
}

function _buildArmor(barcode, rng, rarity, element, level) {
  const base   = ARMORS[Math.floor(rng() * ARMORS.length)];
  const bonus  = Math.max(1, Math.floor(
    base.defBonus * rarity.mult * _levelMult(level) * (0.8 + rng() * 0.4),
  ));
  const skill  = _pickSkill(ARMOR_SKILLS, rarity, rng);
  const prefix = _pickPrefix(rarity, rng);
  const suffix = _pickSuffix(rarity, rng);
  const name   = `${prefix}${element}の${base.base}${suffix}`;
  const desc   = skill.kind === 'none'
    ? `DEF +${bonus}（${element}属性）`
    : `DEF +${bonus} / ${skill.name}: ${skill.desc}`;

  return {
    type: 'armor', barcode,
    name, emoji: base.emoji,
    rarity: rarity.name, rarityColor: rarity.color, element, level,
    atkBonus: 0, defBonus: bonus,
    skill,
    desc,
  };
}

function _buildPotion(barcode, rng, rarity, level) {
  const base = POTIONS[Math.floor(rng() * POTIONS.length)];
  const heal = Math.max(5, Math.floor(base.heal * rarity.mult * _levelMult(level)));
  const prefix = _pickPrefix(rarity, rng);
  return {
    type: 'potion', barcode,
    name: `${prefix}${rarity.name}の${base.base}`,
    emoji: base.emoji,
    rarity: rarity.name, rarityColor: rarity.color, element: null, level,
    atkBonus: 0, defBonus: 0, heal,
    skill: { kind: 'none', name: '' },
    desc: `HPを${heal}回復`,
  };
}

// MP 回復薬。type='mpPotion' で別タイプ扱い（バトルで MP を回復する）
function _buildMpPotion(barcode, rng, rarity, level) {
  const base   = MP_POTIONS[Math.floor(rng() * MP_POTIONS.length)];
  const mpHeal = Math.max(3, Math.floor(base.mpHeal * rarity.mult * _levelMult(level)));
  const prefix = _pickPrefix(rarity, rng);
  return {
    type: 'mpPotion', barcode,
    name: `${prefix}${rarity.name}の${base.base}`,
    emoji: base.emoji,
    rarity: rarity.name, rarityColor: rarity.color, element: null, level,
    atkBonus: 0, defBonus: 0, mpHeal,
    skill: { kind: 'none', name: '' },
    desc: `MPを${mpHeal}回復`,
  };
}

function _buildScroll(barcode, rng, rarity, element, level) {
  const match = SCROLLS.find(s => s.element === element) ?? SCROLLS[Math.floor(rng() * SCROLLS.length)];
  const dmg   = Math.max(5, Math.floor(match.dmg * rarity.mult * _levelMult(level)));
  const prefix = _pickPrefix(rarity, rng);
  return {
    type: 'scroll', barcode,
    name: `${prefix}${rarity.name}の${match.base}`,
    emoji: match.emoji,
    rarity: rarity.name, rarityColor: rarity.color, element: match.element, level,
    atkBonus: 0, defBonus: 0, dmg,
    skill: { kind: 'none', name: '' },
    desc: `敵に${dmg}の${match.element}ダメージ`,
  };
}

// ── スタック判定 ──
// 武器・防具は個体差があるので非スタック。それ以外（薬・MP薬・巻物・素材）は
// 同種・同名・同レア・同Lv なら 1 スロットに count としてまとめる。
export function isStackable(item) {
  if (!item) return false;
  return item.type === 'potion'
      || item.type === 'mpPotion'
      || item.type === 'scroll'
      || item.type === 'material';
}

export function stackKey(item) {
  return `${item.type}|${item.name}|${item.rarity}|${item.level ?? 1}`;
}

// ── 合成・ショップ等で使う素材アイテム ──
//   レア度ごとに 1 種類用意。スキャン由来ではなくモンスター撃破ドロップで入手。
//   合成レシピは feat/item-synthesis 側で定義。
export const MATERIALS = [
  { name: '鉄片',       emoji: '⛓️',  rarity: 'コモン',     desc: '合成の基本素材' },
  { name: '魔石',       emoji: '💠',  rarity: 'レア',       desc: '魔力を込めた小さな石' },
  { name: '神秘の塵',   emoji: '✨',  rarity: 'エピック',   desc: '稀に風に舞う幻の素材' },
  { name: '神龍の鱗',   emoji: '🐉',  rarity: 'レジェンド', desc: '伝説の竜から剥がれた一片' },
];

// 素材アイテムを生成（スタック可能）
export function makeMaterial(spec) {
  const rarity = RARITIES.find(r => r.name === spec.rarity) ?? RARITIES[0];
  return {
    type:        'material',
    name:        spec.name,
    emoji:       spec.emoji,
    rarity:      rarity.name,
    rarityColor: rarity.color,
    element:     null,
    level:       1,
    desc:        spec.desc,
    count:       1,
  };
}

// 指定レアリティに対応する素材を返す（無ければコモン）
export function materialForRarity(rarityName) {
  const m = MATERIALS.find(s => s.rarity === rarityName) ?? MATERIALS[0];
  return makeMaterial(m);
}

// ── 不思議のダンジョン系巻物 ──
// バトルでは使わず、ダンジョン探索中にメニューから使うフロア限定巻物。
// 効果は現フロア（dungeon インスタンス）の visibility フラグを書き換えるだけで、
// 階段やアイテム位置の表示・全マップ可視化など。新フロアで自動リセット。
export const MYSTERY_SCROLLS = [
  { effect: 'reveal-stairs',  name: '階段感知の巻物',     emoji: '🔍', rarity: 'コモン',
    desc: '今のフロアの階段位置がわかる' },
  { effect: 'reveal-enemies', name: '敵感知の巻物',       emoji: '👁',  rarity: 'レア',
    desc: '今のフロアの敵位置を表示' },
  { effect: 'reveal-items',   name: 'アイテム感知の巻物', emoji: '🎁', rarity: 'レア',
    desc: '今のフロアのアイテム位置を表示' },
  { effect: 'reveal-all',     name: '視界の巻物',         emoji: '🗺',  rarity: 'エピック',
    desc: '今のフロア全マップを照らす' },
];

export function makeMysteryScroll(spec) {
  const rarity = RARITIES.find(r => r.name === spec.rarity) ?? RARITIES[0];
  return {
    type:        'mysteryScroll',
    effect:      spec.effect,
    name:        spec.name,
    emoji:       spec.emoji,
    rarity:      rarity.name,
    rarityColor: rarity.color,
    element:     null, level: 1,
    desc:        spec.desc,
    count:       1,
  };
}

// 重み付きランダム抽選: コモン 50%, 感知系（レア）40%, 視界（エピック）10%
export function randomMysteryScroll(rng = Math.random) {
  const r = typeof rng === 'function' ? rng() : Math.random();
  if (r < 0.50) return makeMysteryScroll(MYSTERY_SCROLLS[0]);
  if (r < 0.70) return makeMysteryScroll(MYSTERY_SCROLLS[1]);
  if (r < 0.90) return makeMysteryScroll(MYSTERY_SCROLLS[2]);
  return                makeMysteryScroll(MYSTERY_SCROLLS[3]);
}

// ─────────────────────────────────────────────
// 技の書（スキルブック）と技ライブラリ
// ─────────────────────────────────────────────
//   使用すると永続的に技を習得（最大 4 スロット）。技は MP を消費して
//   攻撃パターン A/B/C/D の範囲ダメージを与える（バトルパネルではなく
//   ダンジョン探索中に発動。複数モンスターを巻き込める）。
//
//   pattern:
//     A = プレイヤーの周囲十字 4 マス（上下左右）
//     B = プレイヤーの周囲 8 マス（王将の移動範囲）
//     C = 4 方向に 2 マスまでの直線（飛び道具）
//     D = チェビシェフ距離 2 以内の全 24 マス（広範囲）
export const PATTERN_DESC = {
  A: 'A型: 上下左右の隣 4 マス',
  B: 'B型: 周囲 8 マス（王将）',
  C: 'C型: 4 方向 2 マス先まで（直線飛び道具）',
  D: 'D型: 周囲 2 マス全範囲',
  E: 'E型: 正面に最大 6 マスの長距離ビーム',
  F: 'F型: 部屋内の敵全員',
};

export const PATTERN_OFFSETS = {
  A: [[0,-1],[0,1],[-1,0],[1,0]],
  B: [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]],
  C: [[0,-1],[0,-2],[0,1],[0,2],[-1,0],[-2,0],[1,0],[2,0]],
  D: (() => {
    const out = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        out.push([dx, dy]);
      }
    }
    return out;
  })(),
  // E: 正面方向に 6 マスのビーム。基準は「下向き [0,1]」なので
  //    _facingRotatedOffsets が向きで回転させると常に正面方向になる。
  E: [[0,1],[0,2],[0,3],[0,4],[0,5],[0,6]],
  // F: 「部屋全体」は座標オフセットでは表現できないので _executeSkill 側で
  //    pattern==='F' を特別扱いし、PATTERN_OFFSETS は空配列にしておく。
  F: [],
};

export const SKILLS_LIBRARY = [
  // コモン
  { id: 'sweep',     name: '薙ぎ払い',   pattern: 'A', dmgMult: 1.0, mpCost: 6,  element: '火', rarity: 'コモン',     desc: '十字隣接 4 マスを薙ぐ' },
  { id: 'jab',       name: '小突き',     pattern: 'C', dmgMult: 0.8, mpCost: 5,  element: '火', rarity: 'コモン',     desc: '直線 2 マスを軽く突く' },
  { id: 'volley',    name: '軽矢',       pattern: 'E', dmgMult: 0.9, mpCost: 7,  element: '雷', rarity: 'コモン',     desc: '正面に 6 マスの矢を放つ' },
  // レア
  { id: 'whirl',     name: '水流斬',     pattern: 'B', dmgMult: 1.2, mpCost: 10, element: '水', rarity: 'レア',       desc: '周囲 8 マスを攻撃 + 1 マス突き飛ばし', knockback: 1 },
  { id: 'pierce',    name: '貫通弾',     pattern: 'C', dmgMult: 1.5, mpCost: 12, element: '雷', rarity: 'レア',       desc: '直線 2 マス先まで貫く' },
  { id: 'cannon',    name: '大砲',       pattern: 'E', dmgMult: 1.6, mpCost: 14, element: '火', rarity: 'レア',       desc: '正面 6 マスを貫き 1 マス吹き飛ばす', knockback: 1 },
  // エピック
  { id: 'snipe',     name: '影狙撃',     pattern: 'C', dmgMult: 2.5, mpCost: 14, element: '闇', rarity: 'エピック',   desc: '4方向 2 マス先（高威力）' },
  { id: 'storm',     name: '光の嵐',     pattern: 'D', dmgMult: 1.4, mpCost: 18, element: '光', rarity: 'エピック',   desc: '周囲 2 マス全範囲' },
  { id: 'tempest',   name: '部屋風嵐',   pattern: 'F', dmgMult: 1.3, mpCost: 22, element: '草', rarity: 'エピック',   desc: '部屋内の敵全員に 1 マス突風', knockback: 1 },
  // レジェンド
  { id: 'doom',      name: '草薙ぎ',     pattern: 'D', dmgMult: 2.5, mpCost: 28, element: '草', rarity: 'レジェンド', desc: '広範囲・高威力' },
  { id: 'overdrive', name: '神無双',     pattern: 'B', dmgMult: 3.0, mpCost: 22, element: '火', rarity: 'レジェンド', desc: '周囲 8 マスを必殺 + 2 マス吹き飛ばし', knockback: 2 },
  { id: 'meteor',    name: '隕石落とし', pattern: 'F', dmgMult: 2.0, mpCost: 32, element: '火', rarity: 'レジェンド', desc: '部屋全体に大隕石、敵を 2 マス吹き飛ばす', knockback: 2 },
  // 行動阻害技: ダメージは控えめだが命中した敵を行動不能/攻撃不能にする。
  //   stun = 移動も攻撃も不可（フラッシュ）/ seal = 移動可・攻撃不可（封じ込み）
  { id: 'flash',     name: 'フラッシュ', pattern: 'B', dmgMult: 0.4, mpCost: 12, element: '光', rarity: 'レア',       desc: '周囲 8 マスを目眩で 2 ターン気絶', status: { kind: 'stun', turns: 2 } },
  { id: 'seal',      name: '封じ込み',   pattern: 'A', dmgMult: 0.5, mpCost: 10, element: '闇', rarity: 'レア',       desc: '隣接 4 マスを 3 ターン攻撃封印',     status: { kind: 'seal', turns: 3 } },
  { id: 'roomFlash', name: '閃光弾',     pattern: 'F', dmgMult: 0.6, mpCost: 24, element: '光', rarity: 'エピック',   desc: '部屋全体を 2 ターン気絶させる',       status: { kind: 'stun', turns: 2 } },
  { id: 'silence',   name: '沈黙呪',     pattern: 'D', dmgMult: 0.7, mpCost: 20, element: '闇', rarity: 'エピック',   desc: '周囲 2 マスを 4 ターン攻撃封印',     status: { kind: 'seal', turns: 4 } },
];

export function findSkillById(id) {
  return SKILLS_LIBRARY.find(s => s.id === id) ?? null;
}

// 技の書アイテム（読むと技を習得）
export function makeSkillBook(skillId) {
  const skill = findSkillById(skillId);
  if (!skill) return null;
  const rarity = RARITIES.find(r => r.name === skill.rarity) ?? RARITIES[0];
  return {
    type:        'skillBook',
    skillId:     skill.id,
    name:        `${skill.name}の書`,
    emoji:       '📕',
    rarity:      rarity.name,
    rarityColor: rarity.color,
    element:     skill.element,
    level:       1,
    desc:        `${PATTERN_DESC[skill.pattern]} / 威力×${skill.dmgMult} / MP -${skill.mpCost}`,
    skillName:   skill.name,
    skillDesc:   skill.desc,
    count:       1,
  };
}

// 伝説の書（特殊ダンジョン入場アイテム）。
//   バーコードスキャン時に低確率で出現し、使用すると特定ミニオンの試練ダンジョンへ
//   通じる。試練ダンジョン最上階のボスを倒すとそのミニオンが仲間化される（Task #8）。
//
// minionId はミニオンテンプレート（minions.js）の id を指定。
//   表示名・属性などはこのファイルでは持たず、main.js 側で minions.js を引いて補う。
//   …が、UI 側で「何の試練か」を一目で分からせたいので、name に最低限の文字列を埋める。
export function makeLegendaryTome(minionId, fullName, element) {
  return {
    type:        'legendaryTome',
    minionId,
    name:        `${fullName} の伝説の書`,
    emoji:       '📖',
    rarity:      'レジェンド',
    rarityColor: '#ffc107',
    element,
    level:       1,
    desc:        `読むと「${fullName} の試練」へ通じる`,
    count:       1,
  };
}

// レアリティに応じた技の書をランダムに選ぶ
export function randomSkillBook(rng = Math.random, mobRarity = null) {
  const r = typeof rng === 'function' ? rng() : Math.random();
  const candidates = mobRarity
    ? SKILLS_LIBRARY.filter(s => s.rarity === mobRarity)
    : SKILLS_LIBRARY;
  const pool = candidates.length > 0 ? candidates : SKILLS_LIBRARY;
  return makeSkillBook(pool[Math.floor(r * pool.length)].id);
}

// ─────────────────────────────────────────────
// アイテム合成（武器強化 + 特定レアレシピ）
// ─────────────────────────────────────────────
//   ベース仕様: 武器を選び、対応するレアリティの素材を消費して atkBonus を強化、
//   名前に接尾辞をつける。素材種別はレアリティで決まり、素材数も固定。
//
//   特殊レシピ: 同名レジェンド武器 ×2 → 神話級武器
//   （atkBonus 1.8 倍 + 接尾辞「神話」を付与）

// 武器レアリティ → 必要素材
export const ENHANCE_RECIPES = {
  'コモン':     { matName: '鉄片',     matCount: 2, mult: 1.30, suffix: '+鉄',   keepRarity: true,  newRarityName: null },
  'レア':       { matName: '魔石',     matCount: 2, mult: 1.40, suffix: '+魔',   keepRarity: true,  newRarityName: null },
  'エピック':   { matName: '神秘の塵', matCount: 2, mult: 1.50, suffix: '+塵',   keepRarity: true,  newRarityName: null },
  'レジェンド': { matName: '神龍の鱗', matCount: 1, mult: 1.60, suffix: '+龍',   keepRarity: true,  newRarityName: null },
};

// 強化武器を生成（元武器 + レシピ）。新しいオブジェクトを返す（元は呼び出し側で消費）
export function applyEnhanceRecipe(weapon, recipe) {
  const newAtk = Math.max(weapon.atkBonus + 1, Math.floor(weapon.atkBonus * recipe.mult));
  const baseName = weapon.name.replace(/\+.*$/, ''); // 既存の +xxx を剥がしてから付け直す
  return {
    ...weapon,
    atkBonus: newAtk,
    name:     `${baseName}${recipe.suffix}`,
    desc:     weapon.skill?.kind === 'none' || !weapon.skill?.name
      ? `ATK +${newAtk}（${weapon.element}属性）`
      : `ATK +${newAtk} / ${weapon.skill.name}: ${weapon.skill.desc}`,
  };
}

// 同名レジェンド武器 ×2 → 神話級。新オブジェクトを返す
export function fuseLegendaries(weaponA, weaponB) {
  if (!weaponA || !weaponB) return null;
  if (weaponA.rarity !== 'レジェンド' || weaponB.rarity !== 'レジェンド') return null;
  const baseA = weaponA.name.replace(/\+.*$/, '').replace(/神話$/, '');
  const baseB = weaponB.name.replace(/\+.*$/, '').replace(/神話$/, '');
  if (baseA !== baseB) return null;
  const stronger = (weaponA.atkBonus >= weaponB.atkBonus) ? weaponA : weaponB;
  const newAtk = Math.floor(stronger.atkBonus * 1.8);
  return {
    ...stronger,
    atkBonus: newAtk,
    name:     `${baseA}・神話`,
    rarity:   'レジェンド',          // 表示はレジェンド扱い、内部接尾辞で識別
    rarityColor: '#ffe082',
    isMythic: true,
    desc:     stronger.skill?.kind === 'none' || !stronger.skill?.name
      ? `ATK +${newAtk}（${stronger.element}属性）/ 神話級`
      : `ATK +${newAtk} / ${stronger.skill.name}: ${stronger.skill.desc} / 神話級`,
  };
}

// ── ショップ価格 ──
// レアリティと種別から購入価格（ゴールド）を算出。ダンジョンレアリティで倍率がかかる
const _SHOP_BASE = {
  potion:        { コモン: 30,  レア: 80,  エピック: 200, レジェンド: 500 },
  mpPotion:      { コモン: 35,  レア: 90,  エピック: 220, レジェンド: 540 },
  scroll:        { コモン: 50,  レア: 130, エピック: 320, レジェンド: 800 },
  weapon:        { コモン: 80,  レア: 280, エピック: 900, レジェンド: 3000 },
  armor:         { コモン: 80,  レア: 280, エピック: 900, レジェンド: 3000 },
  material:      { コモン: 60,  レア: 220, エピック: 700, レジェンド: 2400 },
  skillBook:     { コモン: 200, レア: 600, エピック: 2000, レジェンド: 6000 },
  mysteryScroll: { コモン: 80,  レア: 200, エピック: 500, レジェンド: 1200 },
};

export function shopPriceFor(item, dungeonRarity = 'コモン') {
  const base = _SHOP_BASE[item.type]?.[item.rarity] ?? 100;
  // ダンジョンレアリティ倍率：高難度ダンジョンほど高い
  const dunMul =
    dungeonRarity === 'レジェンド' ? 2.5 :
    dungeonRarity === 'エピック'   ? 1.8 :
    dungeonRarity === 'レア'       ? 1.3 :
    1.0;
  return Math.max(5, Math.floor(base * dunMul));
}

// ── アイテム使用（バトル中） ──
// 戻り値: { msg, healAmt, dmgAmt, mpHealAmt, consumed }
export function applyItem(item, player, monster) {
  if (item.type === 'potion') {
    const actual = Math.min(item.heal, player.maxHp - player.hp);
    player.hp = Math.min(player.maxHp, player.hp + item.heal);
    return { msg: `🧪 ${item.name} 使用！ HPが${actual}回復した`, healAmt: actual, dmgAmt: 0, mpHealAmt: 0, consumed: true };
  }
  if (item.type === 'mpPotion') {
    const actual = Math.min(item.mpHeal, (player.maxMp ?? 0) - (player.mp ?? 0));
    player.mp = Math.min(player.maxMp ?? 0, (player.mp ?? 0) + item.mpHeal);
    return { msg: `🔵 ${item.name} 使用！ MPが${actual}回復した`, healAmt: 0, dmgAmt: 0, mpHealAmt: actual, consumed: true };
  }
  if (item.type === 'scroll') {
    monster.hp = Math.max(0, monster.hp - item.dmg);
    return { msg: `${item.emoji} ${item.name} 使用！ ${item.dmg}ダメージ！`, healAmt: 0, dmgAmt: item.dmg, mpHealAmt: 0, consumed: true };
  }
  return { msg: 'このアイテムはここでは使えない', healAmt: 0, dmgAmt: 0, mpHealAmt: 0, consumed: false };
}
