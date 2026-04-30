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

// ── 属性（手描き / グラフィック系の奇抜な 6 属性） ──
//   従来の 火/水/地/風/光/闇 を「絵的なスタイル」属性に刷新。
//   棒人間 = もっとも素朴。落書き = 雑なエネルギー塊。影絵 = 影 + 毒。
//   ピクセル = 8bit 系。ホログラム = 光と幻。折り紙 = 紙の鋭利。
//
//   ELEMENTS の長さは 6 のまま（バーコード由来の `% ELEMENTS.length` を維持）。
//   旧セーブは ELEMENT_LEGACY_MAP で新表記にマッピングしてロード時に変換する。
export const ELEMENTS = ['棒人間', '落書き', '影絵', 'ピクセル', 'ホログラム', '折り紙'];

// 旧属性 → 新属性。同じ index 順を維持しているので、既存の
// 「digit % 6 → element」由来の決定論性も保たれる。
export const ELEMENT_LEGACY_MAP = {
  '火': '棒人間',
  '水': '落書き',
  '地': '折り紙',
  '風': 'ピクセル',
  '光': 'ホログラム',
  '闇': '影絵',
};

// 既存アイテム/モンスターの element 文字列が旧表記なら新表記に書き換える
export function migrateElement(element) {
  if (!element) return element;
  return ELEMENT_LEGACY_MAP[element] ?? element;
}

// 属性相性（攻撃側 → 防御側 = ダメージ倍率）。
// 6 属性のサークルマッチアップ：A → B が 1.5 倍なら逆 B → A は 0.7 倍。
//   棒人間 > ピクセル > ホログラム > 影絵 > 折り紙 > 落書き > 棒人間 …
const _STRONG_AGAINST = {
  '棒人間':     'ピクセル',
  'ピクセル':   'ホログラム',
  'ホログラム': '影絵',
  '影絵':       '折り紙',
  '折り紙':     '落書き',
  '落書き':     '棒人間',
};

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
  { base: '棒の巻物',     emoji: '🥢', dmg: 14, element: '棒人間' },
  { base: 'ペンの巻物',   emoji: '✏️', dmg: 22, element: '落書き' },
  { base: '影の巻物',     emoji: '👤', dmg: 18, element: '影絵' },
  { base: 'ドットの巻物', emoji: '🟦', dmg: 16, element: 'ピクセル' },
  { base: '虹の巻物',     emoji: '🌈', dmg: 20, element: 'ホログラム' },
  { base: '紙の巻物',     emoji: '📄', dmg: 17, element: '折り紙' },
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
};

export const SKILLS_LIBRARY = [
  // コモン
  { id: 'sweep',     name: '薙ぎ払い',   pattern: 'A', dmgMult: 1.0, mpCost: 6,  element: '棒人間',     rarity: 'コモン',     desc: '十字隣接 4 マスを薙ぐ' },
  { id: 'jab',       name: '小突き',     pattern: 'C', dmgMult: 0.8, mpCost: 5,  element: '棒人間',     rarity: 'コモン',     desc: '直線 2 マスを軽く突く' },
  // レア
  { id: 'whirl',     name: '回転斬り',   pattern: 'B', dmgMult: 1.2, mpCost: 10, element: '落書き',     rarity: 'レア',       desc: '周囲 8 マスを攻撃' },
  { id: 'pierce',    name: '貫通弾',     pattern: 'C', dmgMult: 1.5, mpCost: 12, element: 'ピクセル',   rarity: 'レア',       desc: '直線 2 マス先まで貫く' },
  // エピック
  { id: 'snipe',     name: '影狙撃',     pattern: 'C', dmgMult: 2.5, mpCost: 14, element: '影絵',       rarity: 'エピック',   desc: '4方向 2 マス先（高威力）' },
  { id: 'storm',     name: '虹嵐',       pattern: 'D', dmgMult: 1.4, mpCost: 18, element: 'ホログラム', rarity: 'エピック',   desc: '周囲 2 マス全範囲' },
  // レジェンド
  { id: 'doom',      name: '終末の折り', pattern: 'D', dmgMult: 2.5, mpCost: 28, element: '折り紙',     rarity: 'レジェンド', desc: '広範囲・高威力' },
  { id: 'overdrive', name: '神無双',     pattern: 'B', dmgMult: 3.0, mpCost: 22, element: '棒人間',     rarity: 'レジェンド', desc: '周囲 8 マスを必殺' },
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

// レアリティに応じた技の書をランダムに選ぶ
export function randomSkillBook(rng = Math.random, mobRarity = null) {
  const r = typeof rng === 'function' ? rng() : Math.random();
  const candidates = mobRarity
    ? SKILLS_LIBRARY.filter(s => s.rarity === mobRarity)
    : SKILLS_LIBRARY;
  const pool = candidates.length > 0 ? candidates : SKILLS_LIBRARY;
  return makeSkillBook(pool[Math.floor(r * pool.length)].id);
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
