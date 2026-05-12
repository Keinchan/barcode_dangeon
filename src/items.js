import { createRNG, hashString } from './rng.js';
import { WIZARD_SKILL_LIBRARY, findWizardSkillById, wizardSkillsLearnableAt } from './wizard-skills.js';

// re-export so main.js can import from one place
export { WIZARD_SKILL_LIBRARY, wizardSkillsLearnableAt };

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

// 巻物は新属性に対応した 6 種類。それぞれ ELEMENTS 内の 1 属性とリンクする。
// 旧基準は 16-22 で「弱すぎる」というユーザーフィードバックのため、
// ベースを大幅に引き上げ（×2.5 程度）+ 属性別の状態異常を付与する。
//   火 → burn / 雷 → shock / 水 → sleep / 草 → poison / 闇 → confuse / 光 → 純高火力
const SCROLLS = [
  { base: '炎の巻物', emoji: '🔥', dmg: 48, element: '火', status: { kind: 'burn',    turns: 4, stacks: 1 } },
  { base: '水の巻物', emoji: '💧', dmg: 42, element: '水', status: { kind: 'sleep',   turns: 2, stacks: 1 } },
  { base: '草の巻物', emoji: '🌿', dmg: 44, element: '草', status: { kind: 'poison',  turns: 5, stacks: 2 } },
  { base: '雷の巻物', emoji: '⚡', dmg: 52, element: '雷', status: { kind: 'shock',   turns: 4, stacks: 1 } },
  { base: '光の巻物', emoji: '✨', dmg: 60, element: '光', status: null /* 高火力一撃 */ },
  { base: '闇の巻物', emoji: '🌑', dmg: 46, element: '闇', status: { kind: 'confuse', turns: 4, stacks: 1 } },
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
//
// 特殊ルート:
//   digits[8] % 8 === 0（12.5%）: ダンジョン入口（dungeonPortal アイテム）。
//   持ち物に格納し、メニューから「突入する」で一回限りの仮想ダンジョンへ。
//   モンスター・素材・ボス込みのダンジョンが直接生成される。
export function generateItemFromBarcode(barcode, rarityOverride = null, levelOverride = null) {
  const rng       = createRNG(hashString('item:' + barcode));
  const digits    = barcode.split('').map(Number);
  const digitSum  = digits.reduce((a, b) => a + b, 0);
  const typeIdx   = digitSum % 4;
  const rarity    = rarityOverride ?? rarityFromDigit(digits[digits.length - 1]);
  const elemIdx   = parseInt(barcode.slice(3, 5), 10) % ELEMENTS.length;
  const element   = ELEMENTS[elemIdx];
  const level     = Math.max(1, Math.min(100, levelOverride ?? 1));

  // ダンジョンポータル抽選（rarityOverride 指定時はモンスター/ショップドロップ
  // 経路なのでスキップ — スキャン経由のみ portal を出す）。
  if (!rarityOverride && (digits[8] % 8) === 0) {
    return makeBarcodeDungeonPortal(barcode);
  }

  switch (typeIdx) {
    case 0: return _buildWeapon(barcode, rng, rarity, element, level);
    case 1: return _buildArmor(barcode, rng, rarity, element, level);
    case 2: {
      // 薬カテゴリ内で digits[6] により振り分け（決定論的）
      //   %3 === 0: 状態異常回復薬（statusCure）
      //   %3 === 1: MP 回復薬
      //   その他   : HP 回復薬
      const cureBucket = digits[6] % 3;
      if (cureBucket === 0) return buildStatusCurePotion(barcode, rarity, level);
      if (cureBucket === 1) return _buildMpPotion(barcode, rng, rarity, level);
      return _buildPotion(barcode, rng, rarity, level);
    }
    default: {
      // 巻物（type=scroll）は一時的にドロップ無効化。データ・コード（_buildScroll /
      // SCROLLS / 状態異常付与ロジック）は保持し、決定論的バーコード抽選で 3 が
      // 出た時だけ別アイテムに振り替える。
      // digits[7] % 4 == 0（25%）: 鍵（宝箱を開けるキー）
      // それ以外（75%）: 薬（HP/MP は digits[6] 偶奇で決定）
      // 鍵バーコードを「商品ごとに固定」にするため digits[7] を分岐に使う。
      const keyBucket = digits[7] % 4;
      if (keyBucket === 0) return makeKey();
      const cureBucket = digits[6] % 3;
      if (cureBucket === 0) return buildStatusCurePotion(barcode, rarity, level);
      if (cureBucket === 1) return _buildMpPotion(barcode, rng, rarity, level);
      return _buildPotion(barcode, rng, rarity, level);
    }
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

// 状態異常回復薬。type='statusCure' で使用時に player.statuses からデバフ全消し。
// HP/MP は回復しない。バフ（atkUp/defUp/agility 系）は失わない。
export function buildStatusCurePotion(barcode, rarity, level) {
  const rarityObj = (typeof rarity === 'object') ? rarity : (RARITIES.find(r => r.name === rarity) ?? RARITIES[0]);
  const lv = Math.max(1, Math.min(100, level ?? 1));
  return {
    type: 'statusCure', barcode: barcode ?? 'cure_synth',
    name: `${rarityObj.name}の浄化薬`,
    emoji: '⚕️',
    rarity: rarityObj.name, rarityColor: rarityObj.color, element: null, level: lv,
    atkBonus: 0, defBonus: 0,
    skill: { kind: 'none', name: '' },
    desc: '使用すると毒・熱傷・睡眠など状態異常を解除する（バフは残る）',
  };
}

function _buildScroll(barcode, rng, rarity, element, level) {
  const match = SCROLLS.find(s => s.element === element) ?? SCROLLS[Math.floor(rng() * SCROLLS.length)];
  const dmg   = Math.max(5, Math.floor(match.dmg * rarity.mult * _levelMult(level)));
  const prefix = _pickPrefix(rarity, rng);
  // status は base から引き継ぐ（火→burn 等）。レアリティが高いほど turns 延長する。
  let status = null;
  if (match.status) {
    const turnBonus = rarity.name === 'レジェンド' ? 3 : rarity.name === 'エピック' ? 2 : rarity.name === 'レア' ? 1 : 0;
    status = { kind: match.status.kind, turns: match.status.turns + turnBonus, stacks: match.status.stacks ?? 1 };
  }
  const statusLabel = status
    ? ` + ${{ burn:'熱傷', sleep:'睡魔', poison:'毒', shock:'感電', confuse:'錯乱' }[status.kind] ?? status.kind}${status.turns}T`
    : '';
  return {
    type: 'scroll', barcode,
    name: `${prefix}${rarity.name}の${match.base}`,
    emoji: match.emoji,
    rarity: rarity.name, rarityColor: rarity.color, element: match.element, level,
    atkBonus: 0, defBonus: 0, dmg,
    status,
    skill: { kind: 'none', name: '' },
    desc: `敵に${dmg}の${match.element}ダメージ${statusLabel}`,
  };
}

// ── スタック判定 ──
// 武器・防具は個体差があるので非スタック。それ以外（薬・MP薬・巻物・素材・鍵）は
// 同種・同名・同レア・同Lv なら 1 スロットに count としてまとめる。
// 宝箱（chest）は中身が個別なので非スタック。
export function isStackable(item) {
  if (!item) return false;
  return item.type === 'potion'
      || item.type === 'mpPotion'
      || item.type === 'statusCure'
      || item.type === 'scroll'
      || item.type === 'material'
      || item.type === 'key';
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

// ── 鍵（宝箱を開けるキー）──
// 宝箱は床から拾うとインベントリに入り、鍵を 1 本消費して中身を取り出せる。
// 仕様簡素化のため鍵にはレア度マッチング無し: コモンの鍵でレジェンド宝箱も開く。
// 元素や色は将来「同色の鍵で同色の宝箱」と紐付ける拡張余地のために持たせる。
export function makeKey() {
  return {
    type:        'key',
    name:        '鍵',
    emoji:       '🗝️',
    rarity:      'コモン',
    rarityColor: '#a0a0a0',
    element:     null,
    level:       1,
    desc:        '宝箱（🎁）を 1 つ開けられる',
    count:       1,
  };
}

// ─────────────────────────────────────────────
// 不思議のダンジョン系巻物（5 カテゴリ／1 回使い切り）
// ─────────────────────────────────────────────
//   設計書 scroll_skill_system.md 準拠で巻物を 5 カテゴリに拡張。
//   実効果は main.js の _useMysteryScrollFromInventory のディスパッチで実装。
//
//   category:
//     scout    - 索敵系（フロア構造・敵・アイテムの可視化）
//     move     - 移動系（瞬間移動・部屋ワープ・階段直行）
//     status   - HP/MP 全回復・状態異常解除・経験値ブースト・所持金倍化
//     terrain  - 壁破壊・通路生成・フロアの地形操作
//     combat   - 部屋全敵 / フロア全敵への直接ダメージ
//     forbidden- 諸刃の剣。圧倒的な効果と引き換えにデメリット
//
//   rarity は既存 4 段階（コモン / レア / エピック / レジェンド）を流用。
//   設計書の C/B/A/S/SS は コモン / レア / エピック / レジェンド / レジェンド+isCursed に対応。
export const MYSTERY_SCROLLS = [
  // ── 索敵系（既存） ──
  { effect: 'reveal-stairs',  name: '階段感知の巻物',     emoji: '🔍', rarity: 'コモン',     category: 'scout',
    desc: '今のフロアの階段位置がわかる' },
  { effect: 'reveal-enemies', name: '敵感知の巻物',       emoji: '👁',  rarity: 'レア',       category: 'scout',
    desc: '今のフロアの敵位置を表示' },
  { effect: 'reveal-items',   name: 'アイテム感知の巻物', emoji: '🎁', rarity: 'レア',       category: 'scout',
    desc: '今のフロアのアイテム位置を表示' },
  { effect: 'reveal-all',     name: '視界の巻物',         emoji: '🗺',  rarity: 'エピック',   category: 'scout',
    desc: '今のフロア全マップを照らす' },

  // ── 移動系 ──
  { effect: 'blink',          name: 'ブリンクの巻物',     emoji: '✨', rarity: 'レア',       category: 'move',
    desc: '同じ部屋内のランダム位置に瞬間移動する' },
  { effect: 'warp',           name: 'ワープの巻物',       emoji: '🌀', rarity: 'エピック',   category: 'move',
    desc: 'フロア内のランダムな部屋に移動する' },
  { effect: 'stairway',       name: 'ステアウェイの巻物', emoji: '⤵',  rarity: 'レジェンド', category: 'move',
    desc: '階段の位置に瞬間移動する' },

  // ── 状態回復・支援系 ──
  { effect: 'cure-all',       name: 'キュアオールの巻物', emoji: '💖', rarity: 'レア',       category: 'status',
    desc: 'HP / MP を完全回復、状態異常も解除' },
  { effect: 'power-up',       name: 'パワーアップの巻物', emoji: '⬆',  rarity: 'エピック',   category: 'status',
    desc: '次のレベルアップに必要な経験値を即時獲得' },
  { effect: 'silver-jewel',   name: 'シルバージュエルの巻物', emoji: '💎', rarity: 'レジェンド', category: 'status',
    desc: '所持金を 1.5 倍にする' },

  // ── 地形操作系 ──
  { effect: 'wall-crush',     name: 'ウォールクラッシュの巻物', emoji: '🪨', rarity: 'レア',     category: 'terrain',
    desc: '隣接 4 方向の壁を破壊する' },
  { effect: 'passage',        name: 'パッセージの巻物',   emoji: '🛤', rarity: 'エピック',   category: 'terrain',
    desc: '自分から階段まで通路を生成する' },

  // ── 戦闘 AoE ──
  { effect: 'room-damage',    name: '室内雷撃の巻物',     emoji: '⚡', rarity: 'エピック',   category: 'combat',
    desc: '部屋内の全敵に大ダメージ' },
  { effect: 'floor-damage',   name: '裁きの巻物',         emoji: '🔥', rarity: 'レジェンド', category: 'combat',
    desc: 'フロア内の全敵にダメージ' },
  // ── 単体超火力 ──
  { effect: 'mega-bolt',      name: '天罰の巻物',         emoji: '🌩', rarity: 'レジェンド', category: 'combat',
    desc: '正面方向の敵に 500 ダメージ（壁・属性相性無視）' },
  // ── 自己バフ ──
  { effect: 'attack-up',      name: '気力の巻物',         emoji: '💪', rarity: 'エピック',   category: 'status',
    desc: 'ATK +30% を 8 ターン付与（持続中は HUD が金色）' },

  // ── 禁忌系（諸刃の剣） ──
  { effect: 'apocalypse',     name: 'アポカリプスの巻物', emoji: '☠',  rarity: 'レジェンド', category: 'forbidden', isCursed: true,
    desc: 'フロア全敵を消し炭に。代償として自分の HP も 50% 失う' },
  { effect: 'berserk',        name: 'ベルセルクの巻物',   emoji: '😈', rarity: 'レジェンド', category: 'forbidden', isCursed: true,
    desc: '自分の HP を半分削って ATK +30%（フロア中持続）の必殺気力を解放' },
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
    category:    spec.category ?? 'scout',
    isCursed:    !!spec.isCursed,
    element:     null, level: 1,
    desc:        spec.desc,
    count:       1,
  };
}

// レアリティ別ドロップ重み（高レアほど稀）。同一レアリティ内では均等抽選する。
const _SCROLL_RARITY_WEIGHT = { 'コモン': 55, 'レア': 28, 'エピック': 13, 'レジェンド': 4 };

// 重み付きランダム抽選。レアリティで大きく分けてから、同レア内で均等に選ぶ。
// 旧仕様（4 種固定の累積確率）から拡張: 巻物種類が増えても自動で適切な分布になる。
export function randomMysteryScroll(rng = Math.random) {
  const rand = typeof rng === 'function' ? rng : Math.random;
  // レアリティ抽選
  const total = Object.values(_SCROLL_RARITY_WEIGHT).reduce((a, b) => a + b, 0);
  let pick = rand() * total;
  let chosenRarity = 'コモン';
  for (const [r, w] of Object.entries(_SCROLL_RARITY_WEIGHT)) {
    pick -= w;
    if (pick <= 0) { chosenRarity = r; break; }
  }
  // 同レア内で均等抽選
  const pool = MYSTERY_SCROLLS.filter(s => s.rarity === chosenRarity);
  const target = pool.length > 0
    ? pool[Math.floor(rand() * pool.length)]
    : MYSTERY_SCROLLS[0];
  return makeMysteryScroll(target);
}

// ─────────────────────────────────────────────
// 技の書（スキルブック）と技ライブラリ
// ─────────────────────────────────────────────
//   使用すると永続的に技を習得（最大 4 スロット）。技は MP を消費して
//   範囲タイプに応じた攻撃を放つ。範囲タイプは設計書 range_type_definitions.md
//   準拠の 19 種類で、ローグライク的なマス目戦闘を表現する。
//
//   範囲タイプの分類:
//     単体・近接系: SELF / MELEE / ADJ / CROSS / DIAG
//     直線・距離系: LINE3 / LINE5 / LINE_INF / PIERCE / RANGED
//     部屋・全体系: ROOM / ROOM_ALL / FLOOR / FLOOR_ALL
//     地形・特殊系: TERRAIN_3X3 / TERRAIN_5X5 / CONE3 / AROUND_TARGET / TRAP
//
//   各範囲タイプは offsets（向き [0,1] 基準のローカル座標差分）か special
//   （室内全敵など座標で表現できないもの）を持つ。`_executeSkill` 側で向き
//   回転とフォールバックを行う。
export const RANGE_TYPES = {
  // ── 単体・近接系 ──
  SELF:        { id: 'SELF',        label: 'じぶん',        desc: '自分自身に効果',           kind: 'self' },
  MELEE:       { id: 'MELEE',       label: 'せっしょく',    desc: '正面 1 マス',              kind: 'offsets',  offsets: [[0, 1]],                                                                                                                                                                                                                  rotatable: true  },
  ADJ:         { id: 'ADJ',         label: 'となり',        desc: '隣接 8 マス',              kind: 'offsets',  offsets: [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]],                                                                                                                                                                rotatable: false },
  CROSS:       { id: 'CROSS',       label: 'じゅうじ',      desc: '上下左右 4 マス',          kind: 'offsets',  offsets: [[0,-1],[0,1],[-1,0],[1,0]],                                                                                                                                                                                            rotatable: false },
  DIAG:        { id: 'DIAG',        label: 'ななめ',        desc: '斜め 4 マス',              kind: 'offsets',  offsets: [[-1,-1],[1,-1],[-1,1],[1,1]],                                                                                                                                                                                          rotatable: false },

  // ── 直線・距離系（向きに合わせて回転） ──
  LINE3:       { id: 'LINE3',       label: 'みじかいいっせん', desc: '正面 3 マス',              kind: 'offsets',  offsets: [[0,1],[0,2],[0,3]],                                                                                                                                                                                                rotatable: true  },
  LINE5:       { id: 'LINE5',       label: 'ちゅういっせん',  desc: '正面 5 マス',              kind: 'offsets',  offsets: [[0,1],[0,2],[0,3],[0,4],[0,5]],                                                                                                                                                                                    rotatable: true  },
  LINE_INF:    { id: 'LINE_INF',    label: 'ながいいっせん',  desc: '正面方向に壁まで貫通',     kind: 'line_inf', maxRange: 12,                                                                                                                                                                                                                rotatable: true  },
  PIERCE:      { id: 'PIERCE',      label: 'つらぬき',      desc: '正面方向の敵を貫通（壁で停止）', kind: 'pierce',   maxRange: 12,                                                                                                                                                                                                            rotatable: true  },
  RANGED:      { id: 'RANGED',      label: 'きょりしてい',  desc: '正面 3 マス先の 1 点',     kind: 'ranged',   distance: 3,                                                                                                                                                                                                                  rotatable: true  },

  // ── 部屋・全体系（座標オフセットで表現できない＝ special） ──
  ROOM:        { id: 'ROOM',        label: 'ぜんしつ',      desc: '同じ部屋の敵全員',         kind: 'room' },
  ROOM_ALL:    { id: 'ROOM_ALL',    label: 'しつないぜんいん', desc: '同じ部屋の味方含む全員', kind: 'room_all' },
  FLOOR:       { id: 'FLOOR',       label: 'ぜんかい',      desc: 'フロア全敵',               kind: 'floor' },
  FLOOR_ALL:   { id: 'FLOOR_ALL',   label: 'かいぜんいん',  desc: 'フロア全員（味方含む）',   kind: 'floor_all' },

  // ── 地形・特殊系 ──
  TERRAIN_3X3: { id: 'TERRAIN_3X3', label: 'せいほうけい3', desc: '自分中心 3×3（自分含む）', kind: 'offsets',  offsets: (() => {
    const out = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push([dx, dy]);
    return out;
  })(), includeSelf: true, rotatable: false },
  TERRAIN_5X5: { id: 'TERRAIN_5X5', label: 'せいほうけい5', desc: '自分中心 5×5 全範囲',      kind: 'offsets',  offsets: (() => {
    const out = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dy === 0) continue;
      out.push([dx, dy]);
    }
    return out;
  })(), rotatable: false },
  CONE3:       { id: 'CONE3',       label: 'おうぎがた',    desc: '正面扇形 3 マス幅',        kind: 'offsets',  offsets: [[0,1],[-1,1],[1,1],[0,2],[-1,2],[1,2],[0,3]],                                                                                                                                                                          rotatable: true  },
  AROUND_TARGET: { id: 'AROUND_TARGET', label: 'てきしゅうい', desc: '正面方向最寄り敵 + 周囲 8 マス', kind: 'around_target', maxRange: 5,                                                                                                                                                                                              rotatable: true  },
  TRAP:        { id: 'TRAP',        label: 'せっち',        desc: '足元に罠を設置',           kind: 'trap' },
};

// 範囲タイプの ID 列（ループ・検索用）
export const RANGE_TYPE_IDS = Object.keys(RANGE_TYPES);

// 旧 A/B/C/D/E/F → 新範囲タイプ。古いセーブの skill.pattern を読み込む時の互換用。
//   A: 上下左右 4 マス      → CROSS
//   B: 周囲 8 マス          → ADJ
//   C: 4 方向 2 マス先      → LINE3 相当（過去は十字飛び道具だったため近いものを選択）
//   D: 周囲 2 マス全範囲    → TERRAIN_5X5
//   E: 正面 6 マスビーム    → LINE_INF（最寄り壁まで）
//   F: 部屋全敵             → ROOM
export const LEGACY_PATTERN_MAP = {
  A: 'CROSS', B: 'ADJ', C: 'LINE3', D: 'TERRAIN_5X5', E: 'LINE_INF', F: 'ROOM',
};

// 任意の入力（旧パターン or 新名称）を新範囲タイプ ID に正規化。
// 不明な値は CROSS にフォールバック（保守的・最も狭い既存範囲）。
export function normalizeRangeType(input) {
  if (!input) return 'CROSS';
  if (RANGE_TYPES[input]) return input;
  const mapped = LEGACY_PATTERN_MAP[input];
  if (mapped && RANGE_TYPES[mapped]) return mapped;
  return 'CROSS';
}

// 範囲タイプの説明（UI 用）。「正面 3 マス」のような短い文字列。
export const PATTERN_DESC = Object.fromEntries(
  Object.entries(RANGE_TYPES).map(([id, r]) => [id, `${r.label}: ${r.desc}`]),
);

// 互換: 旧 PATTERN_OFFSETS は固定オフセット系のみ抽出（旧コードが触る場合の保険）。
// 新コードは RANGE_TYPES[id].offsets を直接見るのが推奨。
export const PATTERN_OFFSETS = Object.fromEntries(
  Object.entries(RANGE_TYPES)
    .filter(([, r]) => r.kind === 'offsets')
    .map(([id, r]) => [id, r.offsets]),
);

// 既存技を新範囲タイプにマッピングし直したライブラリ。
//   pattern フィールドは旧コードとの互換のため残し、新範囲タイプ ID を入れる。
//   _executeSkill は normalizeRangeType を通すので旧 A〜F でも動くが、定義は新名称で。
export const SKILLS_LIBRARY = [
  // コモン
  { id: 'sweep',     name: '薙ぎ払い',   pattern: 'CROSS',       dmgMult: 1.0, mpCost: 6,  element: '火', rarity: 'コモン',     desc: '十字隣接 4 マスを薙ぐ' },
  { id: 'jab',       name: '小突き',     pattern: 'LINE3',       dmgMult: 0.8, mpCost: 5,  element: '火', rarity: 'コモン',     desc: '正面 3 マスを軽く突く' },
  { id: 'volley',    name: '軽矢',       pattern: 'LINE_INF',    dmgMult: 0.9, mpCost: 7,  element: '雷', rarity: 'コモン',     desc: '正面に壁まで矢を放つ' },
  // レア
  { id: 'whirl',     name: '水流斬',     pattern: 'ADJ',         dmgMult: 1.2, mpCost: 10, element: '水', rarity: 'レア',       desc: '周囲 8 マスを攻撃 + 1 マス突き飛ばし', knockback: 1 },
  { id: 'pierce',    name: '貫通弾',     pattern: 'PIERCE',      dmgMult: 1.5, mpCost: 12, element: '雷', rarity: 'レア',       desc: '正面方向の敵を貫通する弾' },
  { id: 'cannon',    name: '大砲',       pattern: 'LINE_INF',    dmgMult: 1.6, mpCost: 14, element: '火', rarity: 'レア',       desc: '正面に壁まで届く砲撃 + 吹き飛ばし', knockback: 1 },
  // エピック
  { id: 'snipe',     name: '影狙撃',     pattern: 'RANGED',      dmgMult: 2.5, mpCost: 14, element: '闇', rarity: 'エピック',   desc: '正面 3 マス先の 1 点を高威力で撃つ' },
  { id: 'storm',     name: '光の嵐',     pattern: 'TERRAIN_5X5', dmgMult: 1.4, mpCost: 18, element: '光', rarity: 'エピック',   desc: '周囲 2 マス全範囲' },
  { id: 'tempest',   name: '部屋風嵐',   pattern: 'ROOM',        dmgMult: 1.3, mpCost: 22, element: '草', rarity: 'エピック',   desc: '部屋内の敵全員に 1 マス突風', knockback: 1 },
  // レジェンド
  { id: 'doom',      name: '草薙ぎ',     pattern: 'TERRAIN_5X5', dmgMult: 2.5, mpCost: 28, element: '草', rarity: 'レジェンド', desc: '広範囲・高威力' },
  { id: 'overdrive', name: '神無双',     pattern: 'ADJ',         dmgMult: 3.0, mpCost: 22, element: '火', rarity: 'レジェンド', desc: '周囲 8 マスを必殺 + 2 マス吹き飛ばし', knockback: 2 },
  { id: 'meteor',    name: '隕石落とし', pattern: 'ROOM',        dmgMult: 2.0, mpCost: 32, element: '火', rarity: 'レジェンド', desc: '部屋全体に大隕石、敵を 2 マス吹き飛ばす', knockback: 2 },
  // 行動阻害技: ダメージは控えめだが命中した敵を行動不能/攻撃不能にする。
  //   stun = 移動も攻撃も不可（フラッシュ）/ seal = 移動可・攻撃不可（封じ込み）
  { id: 'flash',     name: 'フラッシュ', pattern: 'ADJ',         dmgMult: 0.4, mpCost: 12, element: '光', rarity: 'レア',       desc: '周囲 8 マスを目眩で 2 ターン気絶', status: { kind: 'stun', turns: 2 } },
  { id: 'seal',      name: '封じ込み',   pattern: 'CROSS',       dmgMult: 0.5, mpCost: 10, element: '闇', rarity: 'レア',       desc: '隣接 4 マスを 3 ターン攻撃封印',     status: { kind: 'seal', turns: 3 } },
  { id: 'roomFlash', name: '閃光弾',     pattern: 'ROOM',        dmgMult: 0.6, mpCost: 24, element: '光', rarity: 'エピック',   desc: '部屋全体を 2 ターン気絶させる',       status: { kind: 'stun', turns: 2 } },
  { id: 'silence',   name: '沈黙呪',     pattern: 'TERRAIN_5X5', dmgMult: 0.7, mpCost: 20, element: '闇', rarity: 'エピック',   desc: '周囲 2 マスを 4 ターン攻撃封印',     status: { kind: 'seal', turns: 4 } },
];

// 技 ID から技定義を取り出す。SKILLS_LIBRARY（巻物で覚える汎用技）と
// WIZARD_SKILL_LIBRARY（タイプ別レベル習得技）の両方を横断検索する。
export function findSkillById(id) {
  return SKILLS_LIBRARY.find(s => s.id === id)
      ?? findWizardSkillById(id)
      ?? null;
}

// 技解放レベル（レア度ごと）。プレイヤー / ミニオンの level がこの値以上の時だけ
// スロットにセットして発動できる。学習自体は level 不問（巻物を読めば覚える）。
//   ウィザード技は skill.learnedAt（タイプ自動習得レベル）をそのまま要件にする：
//   レベル 23 で覚えた技はレベル 23 以上ならスロットにセット可能。
export const SKILL_LEVEL_REQ = {
  'コモン':     1,
  'レア':       5,
  'エピック':   15,
  'レジェンド': 30,
};
export function skillLevelReq(skill) {
  if (skill && typeof skill.learnedAt === 'number') return skill.learnedAt;
  return SKILL_LEVEL_REQ[skill?.rarity] ?? 1;
}

// ─────────────────────────────────────────────
// プレイヤータイプ（自分のクラス）と適性
//   タイプは 6 属性とそれぞれリンクし、覚えられる技の属性が決まる。
//   primary（主属性） + secondary（副属性）の 2 種類が「適性あり」。
//   未設定の場合は冒険者扱いで全属性 1.0 倍に対応。
// ─────────────────────────────────────────────
export const PLAYER_TYPES = [
  { id: 'flame',   name: '炎舞士',     emoji: '🔥', primary: '火', secondary: '雷',
    desc: '火と雷の技に適性。攻めの型。' },
  { id: 'tide',    name: '水霊術士',   emoji: '💧', primary: '水', secondary: '草',
    desc: '水と草の技に適性。守りと回復寄り。' },
  { id: 'leaf',    name: '森の狩人',   emoji: '🌿', primary: '草', secondary: '闇',
    desc: '草と闇の技に適性。状態異常が得意。' },
  { id: 'spark',   name: '雷光剣士',   emoji: '⚡', primary: '雷', secondary: '光',
    desc: '雷と光の技に適性。手数で攻める。' },
  { id: 'radiant', name: '神聖騎士',   emoji: '✨', primary: '光', secondary: '火',
    desc: '光と火の技に適性。聖騎士の型。' },
  { id: 'umbra',   name: '冥府使い',   emoji: '🌑', primary: '闇', secondary: '水',
    desc: '闇と水の技に適性。封じが得意。' },
];

export function findPlayerType(id) {
  return PLAYER_TYPES.find(t => t.id === id) ?? null;
}

// プレイヤーの適性属性のリストを返す。タイプ未設定時は空配列（＝何も覚えられない）
// ではなく、コモン技だけは覚えられるよう「すべての属性」を返す簡易救済を入れる。
export function aptitudeElementsForPlayer(player) {
  const t = findPlayerType(player?.type);
  if (!t) return ELEMENTS.slice();   // 未設定: コモン技のみ覚えられる救済（後段で rarity 制限）
  return [t.primary, t.secondary];
}

// ミニオンの適性属性: 自身の element + テンプレ定義の aptitudeElements
export function aptitudeElementsForMinion(minion) {
  const out = new Set();
  if (minion?.element) out.add(minion.element);
  if (Array.isArray(minion?.aptitudeElements)) {
    for (const e of minion.aptitudeElements) out.add(e);
  }
  return [...out];
}

// 適性チェック。タイプ未設定のプレイヤーはコモン技に限り学習可（救済）
export function canLearnSkillForPlayer(skill, player) {
  if (!skill) return false;
  if (!player?.type && skill.rarity !== 'コモン') return false;
  const aps = aptitudeElementsForPlayer(player);
  return aps.includes(skill.element);
}

export function canLearnSkillForMinion(skill, minion) {
  if (!skill || !minion) return false;
  const aps = aptitudeElementsForMinion(minion);
  return aps.includes(skill.element);
}

// 属性 → 絵文字（書籍タイトルや説明での視覚タグ）。アイコン色とは別物。
const _ELEMENT_BADGE = {
  '火': '🔥', '水': '💧', '草': '🌿', '雷': '⚡', '光': '✨', '闇': '🌑',
};

// 指定属性をプライマリ or セカンダリに持つプレイヤータイプ名を「、」連結で返す。
// 「その書を読める職業」を skillBook 説明に明記して、適性外でしまい込んでしまう
// 事故を減らす。
function _typeNamesForElement(element) {
  return PLAYER_TYPES
    .filter(t => t.primary === element || t.secondary === element)
    .map(t => t.name)
    .join('、') || '冒険者';
}

// 技の書アイテム（読むと技を習得）
export function makeSkillBook(skillId) {
  const skill = findSkillById(skillId);
  if (!skill) return null;
  const rarity = RARITIES.find(r => r.name === skill.rarity) ?? RARITIES[0];
  const badge  = _ELEMENT_BADGE[skill.element] ?? '';
  const types  = _typeNamesForElement(skill.element);
  return {
    type:        'skillBook',
    skillId:     skill.id,
    // 名前先頭に属性絵文字を入れる: アイコン一覧でも一目で属性が見分けられる。
    // 例) 🔥火 火炎の書 / 💧水 タイダル波の書
    name:        `${badge}${skill.element} ${skill.name}の書`,
    emoji:       '📕',
    rarity:      rarity.name,
    rarityColor: rarity.color,
    element:     skill.element,
    level:       1,
    // 説明文は「適性属性 ⇒ 覚えられる職業」を最前列に出して、入手画面でも
    // 「これ自分覚えられるんだっけ？」と迷わない様にする。
    desc:        `${badge}${skill.element}属性 適性: ${types} / ${PATTERN_DESC[skill.pattern]} / 威力×${skill.dmgMult} / MP -${skill.mpCost}`,
    skillName:   skill.name,
    skillDesc:   skill.desc,
    count:       1,
  };
}

// ─────────────────────────────────────────────
// バーコード由来のダンジョン入口（dungeonPortal）
// ─────────────────────────────────────────────
//   スキャンしたバーコードから「短くて即興っぽい」一回限りのダンジョンを生成。
//   伝説の書(legendaryTome)と同じく持ち物アイテムとして扱い、メニューから
//   「突入する」で enterDungeon。使用すると消費される。
//
//   テーマ・属性・レアリティ・階層数はバーコード桁から決定論的に決まるので、
//   同じ商品を何度スキャンしても同じダンジョンが出る（場所の代わりにバーコードが
//   ID になる）。一度クリア / 撃破すれば持ち物から消えるので「再挑戦したいなら
//   もう一度スキャンする」運用。
const _PORTAL_THEMES = [
  { name: '幻影の回廊',     wallColor: '#5a3a8b', floorColor: '#1a0e26', tag: '🌀' },
  { name: '記憶の地下層',   wallColor: '#3a3a5b', floorColor: '#0e0e1a', tag: '🌌' },
  { name: '商品の墓場',     wallColor: '#6b5a2a', floorColor: '#2a1f0e', tag: '📦' },
  { name: '電脳のダンジョン', wallColor: '#1a4a6b', floorColor: '#06141a', tag: '⚙' },
  { name: '夢のはざま',     wallColor: '#6b3a5a', floorColor: '#1a0e1a', tag: '✨' },
];

export function makeBarcodeDungeonPortal(barcode) {
  // ダンジョンデータをバーコードから決定論的に組み立てる
  const seed = hashString('barcode-dungeon:' + barcode);
  const rng  = createRNG(seed);
  const digits = barcode.split('').map(Number);
  const digitSum = digits.reduce((a, b) => a + b, 0);

  // レアリティ（コモン55 / レア30 / エピック12 / レジェンド3 で重み付け）
  const r = rng();
  const rarityIdx = r < 0.55 ? 0 : r < 0.85 ? 1 : r < 0.97 ? 2 : 3;
  const rarity    = RARITIES[rarityIdx];

  // テーマ（バーコード由来の数値で決定的に）
  const theme = _PORTAL_THEMES[digitSum % _PORTAL_THEMES.length];

  // 階層数: 短い（2〜4）。レア度が高いほど少しだけ深い
  const floorBase = 2 + Math.floor(rng() * 2);  // 2 or 3
  const floors = floorBase + (rarityIdx >= 2 ? 1 : 0);

  // 属性（バーコード桁由来）
  const elementIdx = parseInt(barcode.slice(3, 5), 10) % ELEMENTS.length;
  const element    = ELEMENTS[elementIdx];

  // モンスター職業
  const fakeBarcode = String(seed).padStart(13, '0').slice(0, 13);
  // jobForBarcode は items.js 側で import 済（generator → items の依存関係を避けるため
  // ここでは jobId だけ算出。実際のジョブ参照は generator.generateMonster で行う）。

  const dungeonData = {
    seed: 'portal:' + seed,
    barcode: fakeBarcode,
    name: `${theme.tag} ${theme.name}`,
    theme,
    floors,
    difficulty: rarityIdx + 1,
    monsterTypeIdx: digitSum % 10,
    elementIdx,
    element,
    rarityBase: rarity,
    isBarcodePortal: true,           // ダンジョンクリア時の判定用
  };

  return {
    type:        'dungeonPortal',
    name:        `🌀 ${theme.name}（${rarity.name}）`,
    emoji:       theme.tag,
    rarity:      rarity.name,
    rarityColor: rarity.color,
    element,
    level:       1,
    desc:        `読むと ${theme.name} へ通じる。${rarity.name}・B${floors}F`,
    dungeonData,                     // 突入時にそのまま enterDungeon へ渡す
    barcodeOrigin: barcode,
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
  key:           { コモン: 120, レア: 120, エピック: 120, レジェンド: 120 },
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
// 回復は「少しでも欠けていればフル加算」方式：max 未満なら item.heal を素直に加え、
// max を超えても overcap として保持する（次に被弾すれば自然に max 以下に戻る）。
export function applyItem(item, player, monster) {
  if (item.type === 'potion') {
    const actual = item.heal;
    player.hp = player.hp + item.heal;
    return { msg: `🧪 ${item.name} 使用！ HPが${actual}回復した`, healAmt: actual, dmgAmt: 0, mpHealAmt: 0, consumed: true };
  }
  if (item.type === 'mpPotion') {
    const actual = item.mpHeal;
    player.mp = (player.mp ?? 0) + item.mpHeal;
    return { msg: `🔵 ${item.name} 使用！ MPが${actual}回復した`, healAmt: 0, dmgAmt: 0, mpHealAmt: actual, consumed: true };
  }
  if (item.type === 'scroll') {
    monster.hp = Math.max(0, monster.hp - item.dmg);
    return { msg: `${item.emoji} ${item.name} 使用！ ${item.dmg}ダメージ！`, healAmt: 0, dmgAmt: item.dmg, mpHealAmt: 0, consumed: true };
  }
  return { msg: 'このアイテムはここでは使えない', healAmt: 0, dmgAmt: 0, mpHealAmt: 0, consumed: false };
}
