import { createRNG, hashString } from './rng.js';
import {
  RARITIES, ELEMENTS, rarityFromDigit, generateItemFromBarcode,
  randomMysteryScroll, randomSkillBook, materialForRarity, shopPriceFor,
} from './items.js';

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

// ── 属性スキル（モンスターが 3 ターンに 1 回発動）──
//   棒人間 = 物理パンチ。落書き = 高威力・乱雑。影絵 = 中威力 + 毒。
//   ピクセル = 連続ダメ。ホログラム = 自己回復。折り紙 = 鋭利な切り。
export const SKILLS = {
  '棒人間':     { name: 'スティック・パンチ', mult: 2.0, healSelf: 0,    poison: false },
  '落書き':     { name: 'グシャ書き',         mult: 2.4, healSelf: 0,    poison: false },
  '影絵':       { name: '影縫い',             mult: 1.5, healSelf: 0,    poison: true  },
  'ピクセル':   { name: 'ドット弾幕',         mult: 1.5, healSelf: 0,    poison: false },
  'ホログラム': { name: '偽光',               mult: 0,   healSelf: 0.25, poison: false },
  '折り紙':     { name: '折り鶴投げ',         mult: 2.0, healSelf: 0,    poison: false },
};

// ── ダンジョン設定 ──
const DUNGEON_THEMES = [
  { name: '古代遺跡',   wallColor: '#6b3a2a', floorColor: '#2a1a0e' },
  { name: '氷の洞窟',   wallColor: '#2a4a6b', floorColor: '#0e1a2a' },
  { name: '溶岩洞',     wallColor: '#6b1a0a', floorColor: '#200800' },
  { name: '魔法図書館', wallColor: '#3a1a6b', floorColor: '#120820' },
  { name: '毒の沼地',   wallColor: '#1a4a1a', floorColor: '#061406' },
];

// ── 位置ベース固定湧き設定 ──
export const GRID_STEP = 0.002;       // 約 200m
const SPAWN_PROBABILITY = 0.6;        // セルあたり60%でダンジョン出現
const ENTER_RADIUS_M    = 80;         // 入場可能距離（プレイヤー位置から）

// ──────────────────────────────────────────
// ダンジョンデータ共通ビルダー
// ──────────────────────────────────────────
function _buildDungeonFromSeed(seed, lat, lng) {
  const rng = createRNG(seed);
  const floors     = 3 + Math.floor(rng() * 3);
  const difficulty = 1 + Math.floor(rng() * 3);
  const theme      = DUNGEON_THEMES[Math.floor(rng() * DUNGEON_THEMES.length)];

  const monsterTypeIdx = Math.floor(rng() * MONSTER_POOL.length);
  const elementIdx     = Math.floor(rng() * ELEMENTS.length);

  // ダンジョン基準レアリティ：コモン45 / レア35 / エピック15 / レジェンド5
  const r = rng();
  let rarityIdx;
  if      (r < 0.45) rarityIdx = 0;
  else if (r < 0.80) rarityIdx = 1;
  else if (r < 0.95) rarityIdx = 2;
  else               rarityIdx = 3;

  // モンスターステータス算出用の合成「バーコード」
  // generateMonster 側で digits.slice(2,5) 等を使うため数字13桁にする
  const fakeBarcode = String(seed).padStart(13, '0').slice(0, 13);

  return {
    seed, barcode: fakeBarcode, lat, lng,
    name: theme.name + 'ダンジョン',
    theme, floors, difficulty,
    monsterTypeIdx,
    elementIdx,
    element: ELEMENTS[elementIdx],
    rarityBase: RARITIES[rarityIdx],
  };
}

// ──────────────────────────────────────────
// グリッド固定湧き
// ──────────────────────────────────────────
function _gridDungeon(gx, gy) {
  const seed = hashString(`grid:${gx}:${gy}`);
  const rng  = createRNG(seed);
  if (rng() > SPAWN_PROBABILITY) return null;

  // セル内のランダム位置（中央寄り 30〜70%）
  const lat = gy * GRID_STEP + GRID_STEP * (0.3 + rng() * 0.4);
  const lng = gx * GRID_STEP + GRID_STEP * (0.3 + rng() * 0.4);

  return _buildDungeonFromSeed(seed, lat, lng);
}

// プレイヤーの周囲 radiusMeters 以内のグリッドダンジョンを返す
export function getDungeonsNear(lat, lng, radiusMeters = 1500) {
  const radiusDeg  = radiusMeters / 100000; // 大雑把に 1° ≒ 100km
  const cellRadius = Math.ceil(radiusDeg / GRID_STEP);
  const baseGx = Math.floor(lng / GRID_STEP);
  const baseGy = Math.floor(lat / GRID_STEP);

  const result = [];
  for (let dy = -cellRadius; dy <= cellRadius; dy++) {
    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      const d = _gridDungeon(baseGx + dx, baseGy + dy);
      if (d) result.push(d);
    }
  }
  return result;
}

// プレイヤー位置からダンジョン入口までの距離（m）
export function distanceMeters(lat1, lng1, lat2, lng2) {
  // 簡易: 1° ≒ 111.32km、緯度補正なしで近距離なら十分
  const dLat = (lat1 - lat2) * 111320;
  const dLng = (lng1 - lng2) * 111320 * Math.cos(lat1 * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

export function isWithinEnterRadius(playerLat, playerLng, dungeon) {
  return distanceMeters(playerLat, playerLng, dungeon.lat, dungeon.lng) <= ENTER_RADIUS_M;
}

export const ENTER_RADIUS = ENTER_RADIUS_M;

// ──────────────────────────────────────────
// 敵レベル：レアリティベース＋フロア＋ボス補正
// プレイヤーと同レベル同士なら互角になる設計
// ──────────────────────────────────────────
const RARITY_LEVEL_BASE = {
  'コモン':     1,
  'レア':       8,
  'エピック':   25,
  'レジェンド': 50,
};
const LEVEL_PER_FLOOR  = 5;
const BOSS_LEVEL_BONUS = 5;

export function enemyLevel(dungeonData, floor, isBoss) {
  const base = RARITY_LEVEL_BASE[dungeonData.rarityBase.name] ?? 1;
  const lvl  = base + (floor - 1) * LEVEL_PER_FLOOR + (isBoss ? BOSS_LEVEL_BONUS : 0);
  return Math.max(1, Math.min(MAX_LEVEL, lvl));
}

// ──────────────────────────────────────────
// バーコード → モンスター（レベル制度ベース）
// ──────────────────────────────────────────
export function generateMonster(dungeonData, floor, isBoss = false) {
  const key  = `${dungeonData.barcode}:${floor}:${isBoss}`;
  const rng  = createRNG(hashString(key));

  const base    = MONSTER_POOL[dungeonData.monsterTypeIdx];
  const element = dungeonData.element;
  const skill   = SKILLS[element];

  // レベル算出 → プレイヤーと共通の statsForLevel を流用
  const lvl   = enemyLevel(dungeonData, floor, isBoss);
  const stats = statsForLevel(lvl);

  // 個体差ランダム化（85〜115%）。RNGはバーコード+フロア+ボスでseed済みで決定論的
  const hpRoll  = 0.85 + rng() * 0.3;
  const atkRoll = 0.85 + rng() * 0.3;
  const defRoll = 0.85 + rng() * 0.3;

  const hp  = Math.max(1, Math.floor(stats.maxHp   * hpRoll));
  const atk = Math.max(1, Math.floor(stats.atkBase * atkRoll));
  const def = Math.max(0, Math.floor(stats.defBase * defRoll));

  const baseRarityIdx = RARITIES.indexOf(dungeonData.rarityBase);
  const rarityIdx     = isBoss
    ? Math.min(RARITIES.length - 1, baseRarityIdx + 1)
    : baseRarityIdx;
  const rarity        = RARITIES[rarityIdx];

  const displayName = isBoss ? `👑 ${base.base}王` : base.base;

  return {
    base: base.base, emoji: base.emoji,
    isBoss,
    name: displayName,
    level: lvl,
    rarity: rarity.name, rarityColor: rarity.color,
    element, skill,
    skillCharge: 0,
    hp, maxHp: hp, atk, def, floor,
  };
}

// ── 商人 NPC（モンスターと同じ this.monsters に shopkeeper フラグ付きで配置）──
//   ダンジョンレベル + 30 の超強敵。普通に殴ると即死級なので、撃破できれば
//   超大量のゴールド + 在庫すべてを奪える。
//   walking-into = 購入モーダル。意図的に攻撃する場合はモーダル内ボタンから。
export function generateShopkeeperFor(dungeonData, floor) {
  const baseLvl = enemyLevel(dungeonData, floor, false);
  const lvl     = Math.min(MAX_LEVEL, baseLvl + 30);
  const stats   = statsForLevel(lvl);
  // ボス級ステータスを更にブースト（HP×1.5 ATK+30%）
  const hp  = Math.floor(stats.maxHp   * 1.5);
  const atk = Math.floor(stats.atkBase * 1.3);
  const def = Math.floor(stats.defBase * 1.3);

  return {
    base: '商人', emoji: '🧝',
    name: '商人',
    level: lvl,
    rarity: 'レジェンド', rarityColor: '#ffc107',
    element: '棒人間',                 // 物理メイン
    skill:   { name: '撃退一閃', mult: 3.0, healSelf: 0, poison: false },
    skillCharge: 0,
    isBoss: false,
    isShopkeeper: true,
    hp, maxHp: hp, atk, def, floor,
  };
}

// ショップ在庫を生成（4 アイテム）。ダンジョンの難易度に応じて構成が変わる
export function generateShopStock(dungeonData, floor) {
  const rng       = createRNG(hashString(`shop:${dungeonData.seed}:${floor}`));
  const itemLevel = enemyLevel(dungeonData, floor, false);
  const dunRarity = dungeonData.rarityBase.name;
  const stock     = [];

  // バーコード基盤の汎用アイテム 2 個（薬・巻物・武器・防具のいずれか）
  for (let i = 0; i < 2; i++) {
    const seed = hashString(`shop:${dungeonData.seed}:${floor}:slot${i}`);
    const code = String(seed).padStart(13, '0').slice(0, 13);
    const item = generateItemFromBarcode(code, null, itemLevel);
    stock.push({ item, price: shopPriceFor(item, dunRarity) });
  }
  // 素材（ダンジョンレアリティ準拠）
  const mat = materialForRarity(dunRarity);
  stock.push({ item: mat, price: shopPriceFor(mat, dunRarity) });
  // 技の書（ランダム）
  const book = randomSkillBook(rng, dunRarity);
  if (book) stock.push({ item: book, price: shopPriceFor(book, dunRarity) });

  return stock;
}

// ── フロアのアイテム生成 ──
//   そのフロアの雑魚相当のレベルを付けて、レベル相当のステータスにする。
//   各部屋に通常アイテムが落ちる確率と独立に、ゴールドの山も配置する。
export function generateFloorItems(dungeonData, floor, rooms) {
  const rng       = createRNG(hashString(`floor-items:${dungeonData.seed}:${floor}`));
  const items     = [];
  const itemLevel = enemyLevel(dungeonData, floor, false);

  // 不思議系巻物：このフロアに 1 個（25% 確率）配置
  if (rng() <= 0.25 && rooms.length > 2) {
    const room = rooms[1 + Math.floor(rng() * Math.max(1, rooms.length - 2))];
    const scroll = randomMysteryScroll(rng);
    scroll.x = room.x + 1 + Math.floor(rng() * Math.max(1, room.w - 2));
    scroll.y = room.y + 1 + Math.floor(rng() * Math.max(1, room.h - 2));
    items.push(scroll);
  }

  // 技の書：このフロアに 1 個（15% 確率）配置
  if (rng() <= 0.15 && rooms.length > 2) {
    const room = rooms[1 + Math.floor(rng() * Math.max(1, rooms.length - 2))];
    const book = randomSkillBook(rng, dungeonData.rarityBase.name);
    if (book) {
      book.x = room.x + 1 + Math.floor(rng() * Math.max(1, room.w - 2));
      book.y = room.y + 1 + Math.floor(rng() * Math.max(1, room.h - 2));
      items.push(book);
    }
  }

  rooms.slice(1, -1).forEach((room, idx) => {
    // 通常アイテム（出現率 50% → 70%）
    if (rng() <= 0.7) {
      const subHash  = hashString(`${dungeonData.barcode}:${floor}:room${idx}`);
      const subCode  = subHash.toString().padStart(13, '0').slice(0, 13);
      const item     = generateItemFromBarcode(subCode, null, itemLevel);
      const x = room.x + 1 + Math.floor(rng() * Math.max(1, room.w - 2));
      const y = room.y + 1 + Math.floor(rng() * Math.max(1, room.h - 2));
      item.x = x; item.y = y;
      items.push(item);
    }

    // ゴールドの山（部屋ごと 35% → 60% で出現）。アイテムスロットを消費しないため
    // 持ち物満杯でも拾える「即時加算アイテム」扱い
    if (rng() <= 0.6) {
      const amount = Math.max(8, Math.floor((20 + itemLevel * 4) * (0.7 + rng() * 0.8)));
      let gx = room.x + 1 + Math.floor(rng() * Math.max(1, room.w - 2));
      let gy = room.y + 1 + Math.floor(rng() * Math.max(1, room.h - 2));
      // 同じマスに通常アイテムが居れば 1 マス避ける（重なって描画されると見えない）
      const collide = items.find(it => it.x === gx && it.y === gy);
      if (collide) {
        gx = Math.min(room.x + room.w - 2, gx + 1);
      }
      items.push({
        type: 'gold',
        name: `${amount} ゴールド`,
        emoji: '🪙',
        amount,
        rarity: 'コモン',
        rarityColor: '#ffd54f',
        x: gx, y: gy,
      });
    }
  });

  return items;
}

// ── レベリング設定 ──
export const MAX_LEVEL      = 100;
export const HP_PER_LEVEL   = 15;
export const ATK_PER_LEVEL  = 2;
export const DEF_PER_LEVEL  = 1;
export const MP_PER_LEVEL   = 4;
export const SKILL_MP_COST  = 8;

// 指定レベルへの「次のレベル到達に必要なXP」
export function xpRequiredForLevel(level) {
  return level * 20;
}

// レベル基準のステータス算出
export function statsForLevel(level) {
  return {
    maxHp:   35 + (level - 1) * HP_PER_LEVEL,
    maxMp:   20 + (level - 1) * MP_PER_LEVEL,
    atkBase:  9 + (level - 1) * ATK_PER_LEVEL,
    defBase:  3 + (level - 1) * DEF_PER_LEVEL,
  };
}

// プレイヤーのステータスをレベル基準で再計算（装備のbonusを足し直す）
export function applyLevelStats(player) {
  const s = statsForLevel(player.level);
  player.maxHp   = s.maxHp;
  player.maxMp   = s.maxMp;
  player.atkBase = s.atkBase;
  player.defBase = s.defBase;
  player.atk     = player.atkBase + (player.weapon?.atkBonus ?? 0);
  player.def     = player.defBase + (player.armor?.defBonus  ?? 0);
}

export function createPlayer() {
  return {
    level: 1, xp: 0,
    hp: 35, maxHp: 35,
    mp: 20, maxMp: 20,
    atkBase: 9, defBase: 3,
    atk: 9, def: 3,
    weapon: null, armor: null,
    inventory: [],          // 最大8個（持ち物）
    storage:   [],          // 容量無制限のアイテムボックス
    gold:      0,           // 所持金（敵撃破・床落ちで増加。死亡しても持ち越し）
    skills:    [],          // 習得済み技 [{ id, name, pattern, dmgMult, mpCost, element, rarity, desc }]
  };
}

export const SKILL_SLOTS_MAX = 4;

// 敵撃破時のゴールド報酬（決定論的ではなくランダム要素を含む）
export function rollGoldDropFromMonster(mob) {
  const lvl  = mob.level ?? 1;
  const rar  = mob.rarity;
  const base = 12 + lvl * 4;            // 5+lvl*2 → 12+lvl*4 に増額
  const rarBonus =
    rar === 'レジェンド' ? 150 :
    rar === 'エピック'   ? 55  :
    rar === 'レア'       ? 22  :
    0;
  const bossMul = mob.isBoss ? 4 : 1;   // ボスはより多く
  const roll = 0.8 + Math.random() * 0.5;   // 0.8〜1.3 にブレ縮小（最低保証）
  return Math.max(2, Math.floor((base + rarBonus) * bossMul * roll));
}
