import { createRNG, hashString } from './rng.js';
import { RARITIES, ELEMENTS, rarityFromDigit, generateItemFromBarcode } from './items.js';

// ── モンスタープール ──
const MONSTER_POOL = [
  { base: 'スライム',     emoji: '🟢' },
  { base: 'ゴブリン',     emoji: '👺' },
  { base: 'コウモリ',     emoji: '🦇' },
  { base: 'スケルトン',   emoji: '💀' },
  { base: 'フェニックス', emoji: '🔥' },
  { base: 'アイスウルフ', emoji: '🐺' },
  { base: 'サンゴリラ',   emoji: '🦍' },
  { base: 'ウィスプ',     emoji: '✨' },
  { base: 'ゾンビ',       emoji: '🧟' },
  { base: 'ドラゴン',     emoji: '🐉' },
];

// ── 属性スキル ──
export const SKILLS = {
  火: { name: '炎の息',   mult: 2.0, healSelf: 0,    poison: false },
  水: { name: '水流',     mult: 1.5, healSelf: 0,    poison: false },
  地: { name: '岩石投げ', mult: 2.5, healSelf: 0,    poison: false },
  風: { name: '竜巻',     mult: 1.8, healSelf: 0,    poison: false },
  光: { name: '聖光',     mult: 0,   healSelf: 0.25, poison: false },
  闇: { name: '呪い',     mult: 1.2, healSelf: 0,    poison: true  },
};

// ── ダンジョン設定 ──
const DUNGEON_THEMES = [
  { name: '古代遺跡',   wallColor: '#6b3a2a', floorColor: '#2a1a0e' },
  { name: '氷の洞窟',   wallColor: '#2a4a6b', floorColor: '#0e1a2a' },
  { name: '溶岩洞',     wallColor: '#6b1a0a', floorColor: '#200800' },
  { name: '魔法図書館', wallColor: '#3a1a6b', floorColor: '#120820' },
  { name: '毒の沼地',   wallColor: '#1a4a1a', floorColor: '#061406' },
];

// ── バーコード + GPS → ダンジョンデータ ──
export function generateDungeonData(barcode, lat, lng) {
  const locSeed = hashString(`${Math.floor(lat * 50)}:${Math.floor(lng * 50)}`);
  const barSeed = hashString(barcode);
  const seed    = (locSeed ^ barSeed) >>> 0;
  const rng     = createRNG(seed);

  const floors     = 3 + Math.floor(rng() * 3);
  const difficulty = 1 + Math.floor(rng() * 3);
  const theme      = DUNGEON_THEMES[Math.floor(rng() * DUNGEON_THEMES.length)];

  // バーコード先頭2桁 → モンスター族
  const monsterTypeIdx = parseInt(barcode.slice(0, 2), 10) % MONSTER_POOL.length;
  // 5〜6桁 → 属性
  const elementIdx     = parseInt(barcode.slice(5, 7), 10) % ELEMENTS.length;
  // 末尾桁 → ダンジョンレアリティ（出現モンスター/アイテムの品質ベース）
  const rarityBase     = rarityFromDigit(parseInt(barcode.slice(-1), 10));

  return {
    seed, barcode, lat, lng,
    name: theme.name + 'ダンジョン',
    theme, floors, difficulty,
    monsterTypeIdx,
    elementIdx,
    element: ELEMENTS[elementIdx],
    rarityBase,
  };
}

// ── バーコード → モンスター生成（強化版） ──
export function generateMonster(dungeonData, floor, isBoss = false) {
  const key  = `${dungeonData.barcode}:${floor}:${isBoss}`;
  const rng  = createRNG(hashString(key));

  const base        = MONSTER_POOL[dungeonData.monsterTypeIdx];
  const element     = dungeonData.element;
  const skill       = SKILLS[element];
  const floorMult   = 1 + (floor - 1) * 0.35;
  const bossMult    = isBoss ? 2.8 : 1;

  // レアリティ（ボスは1段階上）
  const baseRarityIdx = RARITIES.indexOf(dungeonData.rarityBase);
  const rarityIdx     = isBoss
    ? Math.min(RARITIES.length - 1, baseRarityIdx + 1)
    : baseRarityIdx;
  const rarity        = RARITIES[rarityIdx];

  // バーコード各桁をステータスベースに使う + 乱数ブレ
  const digits = dungeonData.barcode.padStart(13, '0');
  const rawHp  = 15 + (parseInt(digits.slice(2, 5), 10) % 40);
  const rawAtk = 4  + (parseInt(digits.slice(5, 7), 10) % 12);
  const rawDef = 1  + (parseInt(digits.slice(7, 9), 10) % 8);

  const hp  = Math.floor((rawHp  + rng() * 10) * floorMult * bossMult * rarity.mult);
  const atk = Math.floor((rawAtk + rng() * 4)  * floorMult * bossMult * rarity.mult);
  const def = Math.floor((rawDef + rng() * 3)  * floorMult);

  const displayName = isBoss ? `👑 ${base.base}王` : base.base;

  return {
    base: base.base, emoji: base.emoji,
    isBoss,
    name: displayName,
    rarity: rarity.name, rarityColor: rarity.color,
    element, skill,
    skillCharge: 0,   // 3ターンたまったらスキル発動
    hp, maxHp: hp, atk, def, floor,
  };
}

// ── フロアのアイテム生成 ──
// rooms: ダンジョン内の部屋リスト
export function generateFloorItems(dungeonData, floor, rooms) {
  const rng   = createRNG(hashString(`floor-items:${dungeonData.seed}:${floor}`));
  const items = [];

  // 最初と最後の部屋以外に配置
  rooms.slice(1, -1).forEach((room, idx) => {
    if (rng() > 0.5) return; // 50%でアイテムあり

    // 部屋ごとの決定論的サブシード → バーコード生成
    const subHash  = hashString(`${dungeonData.barcode}:${floor}:room${idx}`);
    const subCode  = subHash.toString().padStart(13, '0').slice(0, 13);
    const item     = generateItemFromBarcode(subCode);

    // 部屋内のランダム位置
    const x = room.x + 1 + Math.floor(rng() * Math.max(1, room.w - 2));
    const y = room.y + 1 + Math.floor(rng() * Math.max(1, room.h - 2));
    item.x = x;
    item.y = y;
    items.push(item);
  });

  return items;
}

export function createPlayer() {
  return {
    hp: 35, maxHp: 35,
    atkBase: 9, defBase: 3,
    atk: 9, def: 3,
    weapon: null, armor: null,
    inventory: [],          // 最大8個
  };
}
