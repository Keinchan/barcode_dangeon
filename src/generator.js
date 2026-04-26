import { createRNG, hashString } from './rng.js';

const MONSTER_POOL = [
  { base: 'スライム',     emoji: '🟢', element: '水' },
  { base: 'ゴブリン',     emoji: '👺', element: '地' },
  { base: 'コウモリ',     emoji: '🦇', element: '闇' },
  { base: 'スケルトン',   emoji: '💀', element: '闇' },
  { base: 'フェニックス', emoji: '🔥', element: '火' },
  { base: 'アイスウルフ', emoji: '🐺', element: '氷' },
  { base: 'サンゴリラ',   emoji: '🦍', element: '地' },
  { base: 'ウィスプ',     emoji: '✨', element: '光' },
  { base: 'ゾンビ',       emoji: '🧟', element: '闇' },
  { base: 'ドラゴン',     emoji: '🐉', element: '火' },
];

const DUNGEON_THEMES = [
  { name: '古代遺跡',   wallColor: '#6b3a2a', floorColor: '#3a2a1a' },
  { name: '氷の洞窟',   wallColor: '#2a4a6b', floorColor: '#1a2a3a' },
  { name: '溶岩洞',     wallColor: '#6b1a0a', floorColor: '#2a0a00' },
  { name: '魔法図書館', wallColor: '#3a1a6b', floorColor: '#1a0a2a' },
  { name: '毒の沼地',   wallColor: '#1a4a1a', floorColor: '#0a2a0a' },
];

// バーコード + GPS → ダンジョンデータ生成
export function generateDungeonData(barcode, lat, lng) {
  const locSeed = hashString(`${Math.floor(lat * 50)}:${Math.floor(lng * 50)}`);
  const barSeed = hashString(barcode);
  const seed    = (locSeed ^ barSeed) >>> 0;
  const rng     = createRNG(seed);

  const floors    = 3 + Math.floor(rng() * 3);   // 3〜5F
  const difficulty = 1 + Math.floor(rng() * 3);  // 難易度1〜3
  const theme     = DUNGEON_THEMES[Math.floor(rng() * DUNGEON_THEMES.length)];
  const monsterTypeIdx = parseInt(barcode.slice(0, 2), 10) % MONSTER_POOL.length;

  return {
    seed, barcode, lat, lng,
    name: theme.name + 'ダンジョン',
    theme, floors, difficulty,
    monsterTypeIdx,
  };
}

// バーコード + フロア + ボスフラグ → モンスターステータス
export function generateMonster(dungeonData, floor, isBoss = false) {
  const key  = `${dungeonData.barcode}:${floor}:${isBoss}`;
  const rng  = createRNG(hashString(key));

  const base = MONSTER_POOL[dungeonData.monsterTypeIdx];
  const floorBonus = 1 + (floor - 1) * 0.35;
  const bossMult   = isBoss ? 2.8 : 1;

  // バーコードの各桁をステータスのベースに使う
  const digits = dungeonData.barcode.padStart(13, '0');
  const rawHp  = 15 + (parseInt(digits.slice(2, 5), 10) % 40);
  const rawAtk = 4  + (parseInt(digits.slice(5, 7), 10) % 12);
  const rawDef = 1  + (parseInt(digits.slice(7, 9), 10) % 8);

  // 乱数でブレを加える（同じバーコードでも毎回完全一致にはならない）
  const hp  = Math.floor((rawHp  + rng() * 10) * floorBonus * bossMult);
  const atk = Math.floor((rawAtk + rng() * 4)  * floorBonus * bossMult);
  const def = Math.floor((rawDef + rng() * 3)  * floorBonus);

  return {
    ...base,
    isBoss,
    name: isBoss ? `👑 ${base.base}王` : base.base,
    hp, maxHp: hp, atk, def,
    floor,
  };
}

export function createPlayer() {
  return { hp: 35, maxHp: 35, atk: 9, def: 3 };
}
