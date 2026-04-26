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

// ── 属性 ──
export const ELEMENTS = ['火', '水', '地', '風', '光', '闇'];

// ── アイテムプール ──
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

const SCROLLS = [
  { base: '炎の巻物', emoji: '📜', dmg: 15, element: '火' },
  { base: '氷の巻物', emoji: '📋', dmg: 13, element: '水' },
  { base: '雷の巻物', emoji: '⚡', dmg: 20, element: '風' },
  { base: '闇の巻物', emoji: '🌑', dmg: 28, element: '闇' },
  { base: '光の巻物', emoji: '✨', dmg: 18, element: '光' },
];

// ── バーコード → アイテム生成 ──
// 全桁合計 % 4 でアイテム種別決定
// 0=武器  1=防具  2=回復薬  3=巻物
export function generateItemFromBarcode(barcode) {
  const rng       = createRNG(hashString('item:' + barcode));
  const digits    = barcode.split('').map(Number);
  const digitSum  = digits.reduce((a, b) => a + b, 0);
  const typeIdx   = digitSum % 4;
  const rarity    = rarityFromDigit(digits[digits.length - 1]);
  const elemIdx   = parseInt(barcode.slice(3, 5), 10) % ELEMENTS.length;
  const element   = ELEMENTS[elemIdx];

  switch (typeIdx) {
    case 0: return _buildWeapon(barcode, rng, rarity, element);
    case 1: return _buildArmor(barcode, rng, rarity, element);
    case 2: return _buildPotion(barcode, rng, rarity);
    default: return _buildScroll(barcode, rng, rarity, element);
  }
}

function _buildWeapon(barcode, rng, rarity, element) {
  const base  = WEAPONS[Math.floor(rng() * WEAPONS.length)];
  const bonus = Math.max(1, Math.floor(base.atkBonus * rarity.mult * (0.8 + rng() * 0.4)));
  return {
    type: 'weapon', barcode,
    name: `${element}の${base.base}`,
    emoji: base.emoji,
    rarity: rarity.name, rarityColor: rarity.color, element,
    atkBonus: bonus, defBonus: 0,
    desc: `ATK +${bonus}（${element}属性）`,
  };
}

function _buildArmor(barcode, rng, rarity, element) {
  const base  = ARMORS[Math.floor(rng() * ARMORS.length)];
  const bonus = Math.max(1, Math.floor(base.defBonus * rarity.mult * (0.8 + rng() * 0.4)));
  return {
    type: 'armor', barcode,
    name: `${element}の${base.base}`,
    emoji: base.emoji,
    rarity: rarity.name, rarityColor: rarity.color, element,
    atkBonus: 0, defBonus: bonus,
    desc: `DEF +${bonus}（${element}属性）`,
  };
}

function _buildPotion(barcode, rng, rarity) {
  const base = POTIONS[Math.floor(rng() * POTIONS.length)];
  const heal = Math.max(5, Math.floor(base.heal * rarity.mult));
  return {
    type: 'potion', barcode,
    name: `${rarity.name}の${base.base}`,
    emoji: base.emoji,
    rarity: rarity.name, rarityColor: rarity.color, element: null,
    atkBonus: 0, defBonus: 0, heal,
    desc: `HPを${heal}回復`,
  };
}

function _buildScroll(barcode, rng, rarity, element) {
  const match = SCROLLS.find(s => s.element === element) ?? SCROLLS[Math.floor(rng() * SCROLLS.length)];
  const dmg   = Math.max(5, Math.floor(match.dmg * rarity.mult));
  return {
    type: 'scroll', barcode,
    name: `${rarity.name}の${match.base}`,
    emoji: match.emoji,
    rarity: rarity.name, rarityColor: rarity.color, element: match.element,
    atkBonus: 0, defBonus: 0, dmg,
    desc: `敵に${dmg}の${match.element}ダメージ`,
  };
}

// ── アイテム使用（バトル中） ──
// 戻り値: { msg, healAmt, dmgAmt, consumed }
export function applyItem(item, player, monster) {
  if (item.type === 'potion') {
    const actual = Math.min(item.heal, player.maxHp - player.hp);
    player.hp = Math.min(player.maxHp, player.hp + item.heal);
    return { msg: `🧪 ${item.name} 使用！ HPが${actual}回復した`, healAmt: actual, dmgAmt: 0, consumed: true };
  }
  if (item.type === 'scroll') {
    monster.hp = Math.max(0, monster.hp - item.dmg);
    return { msg: `${item.emoji} ${item.name} 使用！ ${item.dmg}ダメージ！`, healAmt: 0, dmgAmt: item.dmg, consumed: true };
  }
  return { msg: 'このアイテムはここでは使えない', healAmt: 0, dmgAmt: 0, consumed: false };
}
