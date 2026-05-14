import { createRNG, hashString } from './rng.js';
import {
  RARITIES, ELEMENTS, rarityFromDigit, generateItemFromBarcode,
  randomMysteryScroll, randomSkillBook, materialForRarity, shopPriceFor,
} from './items.js';
import {
  MONSTER_JOBS, jobForBarcode, findJob,
  monsterDisplayName, monsterBossName, applyJobStats,
} from './monster-jobs.js';

// ── モンスタープール（旧互換 / 一部の特殊ダンジョン用に残置）──
//   通常のグリッドダンジョンの命名は monster-jobs.js の属性×職業に置換済み。
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
//   各属性ごとに 1 つの代表スキル。
export const SKILLS = {
  '火': { name: '火炎放射',     mult: 2.0, healSelf: 0,    poison: false },
  '水': { name: 'ウォーターバ', mult: 1.8, healSelf: 0,    poison: false },
  '草': { name: '毒の蔓',       mult: 1.5, healSelf: 0,    poison: true  },
  '雷': { name: '雷撃',         mult: 2.4, healSelf: 0,    poison: false },
  '光': { name: '聖なる癒し',   mult: 0,   healSelf: 0.25, poison: false },
  '闇': { name: '影縫い',       mult: 2.0, healSelf: 0,    poison: true  },
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
// レアリティ別の階層数レンジ。難易度（rarityBase）が高いほど深いダンジョン
// になる：低レア＝サクッと回せる短編、レジェンド＝長丁場のフルダンジョン。
// 「階層が深いほど敵が強くなる」スケーリングは別途撤廃しているので、長さは
// 純粋にプレイ時間と探索量の指標になる。
const _FLOOR_RANGE_BY_RARITY = {
  'コモン':     [1, 3],
  'レア':       [2, 5],
  'エピック':   [4, 7],
  'レジェンド': [6, 10],
};

function _buildDungeonFromSeed(seed, lat, lng) {
  const rng = createRNG(seed);
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

  // 階層数: レアリティで決まるレンジから抽選。1F だけのコモンも、10F まで続く
  // レジェンドもありうる。難易度＝長さで、敵レベルは階層に依らない。
  const rarityName = RARITIES[rarityIdx].name;
  const [floorMin, floorMax] = _FLOOR_RANGE_BY_RARITY[rarityName] ?? [1, 3];
  const floors     = floorMin + Math.floor(rng() * (floorMax - floorMin + 1));
  // 旧 difficulty はレアリティと連動しているのでレアリティ index + 1 を使う
  const difficulty = rarityIdx + 1;

  // モンスターステータス算出用の合成「バーコード」
  // generateMonster 側で digits.slice(2,5) 等を使うため数字13桁にする
  const fakeBarcode = String(seed).padStart(13, '0').slice(0, 13);

  // バーコード 3 桁目 (index 2) で職業を決定論的に選ぶ。
  // 同じダンジョンなら全モンスターは同職業（属性ボスのみ「王」格上げ）。
  const job = jobForBarcode(fakeBarcode);

  return {
    seed, barcode: fakeBarcode, lat, lng,
    name: theme.name + 'ダンジョン',
    theme, floors, difficulty,
    monsterTypeIdx,
    elementIdx,
    element: ELEMENTS[elementIdx],
    rarityBase: RARITIES[rarityIdx],
    jobId: job.id,
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

// ──────────────────────────────────────────
// 地図エンカウント（ポケGO 風の道端遭遇）
// ──────────────────────────────────────────
//   ダンジョンとは独立に、地図の 100m グリッドから決定論的に出現する 4 種類:
//     monster  - 単体モンスター。タップで 1 ルーム戦闘ステージへ突入
//     strong   - 強敵イベント。レベル + 5〜+10 / プレイヤー任意で挑戦
//     chest    - 宝箱（地面に置いてある形）。歩み寄って収集→鍵で開ける
//     merchant - 商人。タップで商品リストモーダル（ダンジョン内商人と同じ仕様）
//
//   グリッドサイズはダンジョンの 200m より細かい 100m にして、2km 圏で
//   常に 10〜30 件のエンカウントが分布するようにする。出現確率は cell ごとに
//   抽選し、type ごとに重み付けで分配。座標は cell 内 jitter で重ならないよう散らす。
//
//   「消費した」エンカウント（拾った宝箱・倒したモンスター等）は別途
//   呼び出し側（main.js）の consumedSet で除外することを想定。
// ──────────────────────────────────────────
export const MAP_ENCOUNTER_GRID = 0.001;        // 約 100m
export const MAP_ENCOUNTER_RADIUS = 2000;       // 2 km
const _ENCOUNTER_WEIGHTS = [
  { kind: 'monster',  w: 0.30 },
  { kind: 'chest',    w: 0.08 },
  { kind: 'merchant', w: 0.04 },
  { kind: 'strong',   w: 0.03 },
  // 残り 55% は空セル
];

// 1 セル → 1 エンカウント（or null）。playerLevel に応じてスケーリング。
function _gridEncounter(gx, gy, playerLevel) {
  const seed = hashString(`map-enc:${gx}:${gy}`);
  const rng  = createRNG(seed);
  const r    = rng();
  let acc = 0;
  let kind = null;
  for (const { kind: k, w } of _ENCOUNTER_WEIGHTS) {
    acc += w;
    if (r < acc) { kind = k; break; }
  }
  if (!kind) return null;

  // セル内 jitter（縁を避けて 20〜80%）。lat/lng は決定論的（再描画してもズレない）。
  const lat = gy * MAP_ENCOUNTER_GRID + MAP_ENCOUNTER_GRID * (0.2 + rng() * 0.6);
  const lng = gx * MAP_ENCOUNTER_GRID + MAP_ENCOUNTER_GRID * (0.2 + rng() * 0.6);

  switch (kind) {
    case 'monster':  return _buildMapMonster (seed, lat, lng, playerLevel, rng);
    case 'strong':   return _buildMapStrong  (seed, lat, lng, playerLevel, rng);
    case 'chest':    return _buildMapChest   (seed, lat, lng, playerLevel, rng);
    case 'merchant': return _buildMapMerchant(seed, lat, lng, playerLevel, rng);
  }
  return null;
}

// プレイヤー周囲 radiusMeters のエンカウントを返す（重複しないように grid で dedupe）。
export function getMapEncountersNear(lat, lng, playerLevel = 1, radiusMeters = MAP_ENCOUNTER_RADIUS) {
  const radiusDeg  = radiusMeters / 100000;
  const cellRadius = Math.ceil(radiusDeg / MAP_ENCOUNTER_GRID);
  const baseGx = Math.floor(lng / MAP_ENCOUNTER_GRID);
  const baseGy = Math.floor(lat / MAP_ENCOUNTER_GRID);
  const out = [];
  for (let dy = -cellRadius; dy <= cellRadius; dy++) {
    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      const e = _gridEncounter(baseGx + dx, baseGy + dy, playerLevel);
      if (e) out.push(e);
    }
  }
  return out;
}

// レアリティを weight で抽選するヘルパ（monster / strong / chest 共通）
function _pickRarityByWeights(rng, weights) {
  const r = rng();
  let acc = 0;
  for (const [name, w] of weights) {
    acc += w;
    if (r < acc) return RARITIES.find(x => x.name === name) ?? RARITIES[0];
  }
  return RARITIES[0];
}

// 通常モンスター: 周囲レベルのコモン〜エピックを 1 体。プレイヤー Lv ± 2 で
// バトル感が常に丁度良いところを目指す（強すぎず弱すぎず）。
function _buildMapMonster(seed, lat, lng, playerLevel, rng) {
  const rarity = _pickRarityByWeights(rng, [
    ['コモン', 0.55], ['レア', 0.30], ['エピック', 0.13], ['レジェンド', 0.02],
  ]);
  const elementIdx = Math.floor(rng() * ELEMENTS.length);
  const element = ELEMENTS[elementIdx];
  const fakeBarcode = String(seed).padStart(13, '0').slice(0, 13);
  const job = jobForBarcode(fakeBarcode);
  // 直接的なレベル指定: プレイヤー Lv を中心に rng で揺らす
  const lvl = Math.max(1, Math.min(MAX_LEVEL, playerLevel + Math.floor(rng() * 5) - 2));
  return {
    kind: 'monster',
    seed,
    lat, lng,
    rarity, element,
    level: lvl,
    barcode: fakeBarcode,
    jobId: job.id,
    name: `${element}属性の${job.label}`,
    emoji: job.emoji,
  };
}

// 強敵: プレイヤー Lv +5〜+10 / レアリティ +1 段階。「挑戦は任意」UX 想定。
function _buildMapStrong(seed, lat, lng, playerLevel, rng) {
  const rarity = _pickRarityByWeights(rng, [
    ['レア', 0.40], ['エピック', 0.40], ['レジェンド', 0.20],
  ]);
  const elementIdx = Math.floor(rng() * ELEMENTS.length);
  const element = ELEMENTS[elementIdx];
  const fakeBarcode = String(seed).padStart(13, '0').slice(0, 13);
  const job = jobForBarcode(fakeBarcode);
  const lvl = Math.max(1, Math.min(MAX_LEVEL, playerLevel + 5 + Math.floor(rng() * 6)));
  return {
    kind: 'strong',
    seed,
    lat, lng,
    rarity, element,
    level: lvl,
    barcode: fakeBarcode,
    jobId: job.id,
    name: `強敵: ${element}の${job.label}`,
    emoji: job.emoji,
  };
}

// 宝箱: プレイヤー Lv に合わせた装備（武器 75% / 防具 25%）を中身として持つ。
// 鍵で開けるので、地図上では「拾う」だけ → インベントリに chest として入る。
function _buildMapChest(seed, lat, lng, playerLevel, rng) {
  const rarity = _pickRarityByWeights(rng, [
    ['コモン', 0.50], ['レア', 0.30], ['エピック', 0.15], ['レジェンド', 0.05],
  ]);
  const wantWeapon = rng() < 0.75;
  // バーコードを type 強制で組み立てる（chest 内中身は決定論的にしておく）
  const code = String(seed).padStart(13, '0').slice(0, 13);
  const adjusted = _forceTypeBarcode(code, wantWeapon ? 0 : 1);
  const inner = generateItemFromBarcode(adjusted, rarity, Math.max(1, playerLevel));
  return {
    kind: 'chest',
    seed,
    lat, lng,
    rarity,
    inner,
  };
}

// 商人: 4 商品の在庫を持つ（generateShopStock を流用）。
function _buildMapMerchant(seed, lat, lng, playerLevel, rng) {
  const rarity = _pickRarityByWeights(rng, [
    ['コモン', 0.55], ['レア', 0.30], ['エピック', 0.12], ['レジェンド', 0.03],
  ]);
  // generateShopStock は dungeonData を要求するので、最低限のフィールドを
  // 揃えた合成データを渡す。seed と floor=1 で stock を決定論的に。
  const fakeDungeon = {
    seed, barcode: String(seed).padStart(13, '0').slice(0, 13),
    rarityBase: rarity,
    element: ELEMENTS[Math.floor(rng() * ELEMENTS.length)],
  };
  const stock = generateShopStock(fakeDungeon, 1);
  // ステージ上の商人レベル（戦闘するなら格上）。playerLevel + 25 程度
  const level = Math.max(1, Math.min(MAX_LEVEL, playerLevel + 25));
  return {
    kind: 'merchant',
    seed,
    lat, lng,
    rarity,
    level,
    stock,
  };
}

// デバッグ用: 任意の場所・種別でエンカウントを 1 件作る。
// グリッド由来の決定論には載せない（seed に "debug:" プレフィックス + タイム
// スタンプ）ので、同じ場所に通常エンカウントが居ても重複表示で並べられる。
//   kind = 'monster' | 'strong' | 'chest' | 'merchant'
export function buildDebugEncounter(kind, lat, lng, playerLevel = 1) {
  const seed = `debug:${kind}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
  const rng  = createRNG(hashString(seed));
  switch (kind) {
    case 'monster':  return _buildMapMonster (seed, lat, lng, playerLevel, rng);
    case 'strong':   return _buildMapStrong  (seed, lat, lng, playerLevel, rng);
    case 'chest':    return _buildMapChest   (seed, lat, lng, playerLevel, rng);
    case 'merchant': return _buildMapMerchant(seed, lat, lng, playerLevel, rng);
  }
  return null;
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
// 階層を進んでも敵レベルは上がらない（旧 LEVEL_PER_FLOOR=5 を撤廃）。
// 「同じダンジョン内なら最初から最後まで同じ強さ」にして、深い階層への
// 怖さの圧迫感を軽減する。難易度はダンジョンのレアリティで完結し、
// 「行きたい強さのダンジョンを選ぶ」運用になる。
const LEVEL_PER_FLOOR  = 0;
const BOSS_LEVEL_BONUS = 5;

export function enemyLevel(dungeonData, floor, isBoss) {
  const base = RARITY_LEVEL_BASE[dungeonData.rarityBase.name] ?? 1;
  const lvl  = base + (floor - 1) * LEVEL_PER_FLOOR + (isBoss ? BOSS_LEVEL_BONUS : 0);
  return Math.max(1, Math.min(MAX_LEVEL, lvl));
}

// ──────────────────────────────────────────
// 伝説の書 → 特殊ダンジョン（ミニオンの試練）データ
//   通常のグリッドダンジョンと違い、バーコード/位置を持たない一回限りのダンジョン。
//   最上階に minionId に対応した「ミニオン王」が出現し、撃破で仲間化する。
//   tome は使った時点で消費される。再挑戦したい場合はもう一度書を入手する必要がある。
// ──────────────────────────────────────────
export function buildSpecialDungeonForTome(tome, minionTemplate) {
  const seed = `tome:${tome.minionId}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
  const themeIdx = Math.floor(Math.random() * DUNGEON_THEMES.length);
  return {
    seed,
    barcode:    String(hashString(seed)).padStart(13, '0').slice(0, 13),
    name:       `${minionTemplate.fullName} の試練`,
    theme:      DUNGEON_THEMES[themeIdx],
    floors:     3,                      // 短めの試練
    difficulty: 2,
    monsterTypeIdx: 0,                  // mooks は適当（最上階だけが本命）
    elementIdx: ELEMENTS.indexOf(minionTemplate.element),
    element:    minionTemplate.element,
    rarityBase: RARITIES[2],            // エピック相当
    isSpecial:  true,
    bossMinionId: tome.minionId,
  };
}

// ミニオン王（特殊ダンジョン最上階のボス）。
//   通常 generateMonster のレジェンド級ボス相当のステータスに、
//   元のミニオン名・絵文字・属性を流用する。recruitMinionId をぶら下げ、
//   撃破処理側で「これを倒したら仲間化する」と判定できるようにする。
export function generateMinionBoss(dungeonData, floor, minionTemplate) {
  const lvl   = enemyLevel(dungeonData, floor, true);
  const stats = statsForLevel(lvl);
  // 試練ボスは通常ボスより少し硬い（HP×1.3 / ATK+10%）
  const hp  = Math.floor(stats.maxHp   * 1.3);
  const atk = Math.floor(stats.atkBase * 1.1);
  const def = Math.floor(stats.defBase * 1.1);
  return {
    base:   minionTemplate.fullName,
    emoji:  minionTemplate.emoji,
    isBoss: true,
    name:   `👑 ${minionTemplate.fullName} 王`,
    level:  lvl,
    rarity: 'レジェンド',
    rarityColor: '#ffc107',
    element: minionTemplate.element,
    skill: SKILLS[minionTemplate.element] ?? null,
    skillCharge: 0,
    hp, maxHp: hp, atk, def, floor,
    recruitMinionId: minionTemplate.id,   // 倒したら仲間化対象（Task #8）
    // 試練ボスは素直な近接（rush）。tickEnemies からの参照に備えて空 job を持たせる。
    job: { id: 'minionboss', label: 'ミニオン王', aiHint: 'rush', preferredRange: 'ADJ', chargeBonus: 0 },
  };
}

// ──────────────────────────────────────────
// バーコード → モンスター（レベル制度ベース）
// ──────────────────────────────────────────
export function generateMonster(dungeonData, floor, isBoss = false) {
  const key  = `${dungeonData.barcode}:${floor}:${isBoss}`;
  const rng  = createRNG(hashString(key));

  const element = dungeonData.element;
  const skill   = SKILLS[element];

  // 職業（旧セーブ等で jobId が無い場合はバーコードから決定論的に再導出）
  const job = (dungeonData.jobId && findJob(dungeonData.jobId))
    ?? jobForBarcode(dungeonData.barcode);

  // レベル算出 → プレイヤーと共通の statsForLevel を流用
  const lvl   = enemyLevel(dungeonData, floor, isBoss);
  const stats = statsForLevel(lvl);

  // 職業によるステータス補正（HP/ATK/DEF）を適用してから個体差を乗せる
  const jobStats = applyJobStats(stats, job);
  const hpRoll  = 0.85 + rng() * 0.3;
  const atkRoll = 0.85 + rng() * 0.3;
  const defRoll = 0.85 + rng() * 0.3;
  const hp  = Math.max(1, Math.floor(jobStats.hp  * hpRoll));
  const atk = Math.max(1, Math.floor(jobStats.atk * atkRoll));
  const def = Math.max(0, Math.floor(jobStats.def * defRoll));

  const baseRarityIdx = RARITIES.indexOf(dungeonData.rarityBase);
  const rarityIdx     = isBoss
    ? Math.min(RARITIES.length - 1, baseRarityIdx + 1)
    : baseRarityIdx;
  const rarity        = RARITIES[rarityIdx];

  // 属性 × 職業の動的命名: 例) 火属性 + 獣王 → 「フレイムビースト」
  let displayName = isBoss
    ? monsterBossName(job, element)
    : monsterDisplayName(job, element);
  let bossEmoji = job.emoji;
  let bossBase  = job.baseName;

  // ボルダロスダンジョン用のボス上書き。最終フロアのボスだけ専用名・絵文字・
  // ステータス倍率を当てて「動かざる磐石」感を出す。雑魚は通常生成のまま。
  let hpFinal  = hp;
  let atkFinal = atk;
  let defFinal = def;
  if (isBoss && dungeonData.bossOverride) {
    const o = dungeonData.bossOverride;
    displayName = o.name ?? displayName;
    bossEmoji   = o.emoji ?? bossEmoji;
    bossBase    = o.base  ?? bossBase;
    hpFinal  = Math.max(1, Math.floor(hpFinal  * (o.hpMul  ?? 1)));
    atkFinal = Math.max(1, Math.floor(atkFinal * (o.atkMul ?? 1)));
    defFinal = Math.max(0, Math.floor(defFinal * (o.defMul ?? 1)));
  }

  return {
    base: bossBase, emoji: bossEmoji,
    isBoss,
    name: displayName,
    level: lvl,
    rarity: rarity.name, rarityColor: rarity.color,
    element, skill,
    skillCharge: 0,
    hp: hpFinal, maxHp: hpFinal, atk: atkFinal, def: defFinal, floor,
    // 職業情報。tickEnemies が aiHint / preferredRange を見て行動を分岐
    job: {
      id: job.id,
      label: job.label,
      aiHint: job.aiHint,
      preferredRange: job.preferredRange,
      chargeBonus: job.chargeBonus ?? 0,
    },
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
    element: '火',                       // 物理メイン
    skill:   { name: '撃退一閃', mult: 3.0, healSelf: 0, poison: false },
    skillCharge: 0,
    isBoss: false,
    isShopkeeper: true,
    hp, maxHp: hp, atk, def, floor,
    job: { id: 'shopkeeper', label: '商人', aiHint: 'rush', preferredRange: 'MELEE', chargeBonus: 0 },
  };
}

// ショップ在庫を生成（4 アイテム）。ダンジョンの難易度に応じて構成が変わる
export function generateShopStock(dungeonData, floor) {
  // ショップ在庫もダンジョン入場ごとに変える（runSalt があれば混ぜる）
  const _runSalt = dungeonData.runSalt ?? '';
  const rng       = createRNG(hashString(`shop:${dungeonData.seed}:${floor}:${_runSalt}`));
  const itemLevel = enemyLevel(dungeonData, floor, false);
  const dunRarity = dungeonData.rarityBase.name;
  const stock     = [];

  // バーコード基盤の汎用アイテム 2 個（薬・巻物・武器・防具のいずれか）
  for (let i = 0; i < 2; i++) {
    const seed = hashString(`shop:${dungeonData.seed}:${floor}:${_runSalt}:slot${i}`);
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
//   武器ドロップは「敵」からは出さず、フロアの宝箱（chest）かボスドロップに集約。
//   通常の床落ちは消耗品（薬・巻物）を中心にし、装備偏重を解消。
export function generateFloorItems(dungeonData, floor, rooms) {
  // 床アイテム配置も入場ごとに変える（巻物/技書/宝箱の位置がシャッフルする）
  const _runSalt2 = dungeonData.runSalt ?? '';
  const rng       = createRNG(hashString(`floor-items:${dungeonData.seed}:${floor}:${_runSalt2}`));
  const items     = [];
  const itemLevel = enemyLevel(dungeonData, floor, false);

  // 不思議系巻物（mysteryScroll）と通常巻物（type=scroll）は一時的にドロップ無効化。
  // 巻物のバランス調整（範囲ダメージ・状態異常・攻撃アップ等）が済むまで床落ち
  // させない。データ・効果ロジックは保持しているため、ここを true に戻すだけで復活する。
  const _SCROLL_DROPS_ENABLED = false;
  if (_SCROLL_DROPS_ENABLED && rng() <= 0.18 && rooms.length > 2) {
    const room = rooms[1 + Math.floor(rng() * Math.max(1, rooms.length - 2))];
    const scroll = randomMysteryScroll(rng);
    scroll.x = room.x + 1 + Math.floor(rng() * Math.max(1, room.w - 2));
    scroll.y = room.y + 1 + Math.floor(rng() * Math.max(1, room.h - 2));
    items.push(scroll);
  }

  // 技の書：このフロアに 1 個（10% 確率）配置
  if (rng() <= 0.10 && rooms.length > 2) {
    const room = rooms[1 + Math.floor(rng() * Math.max(1, rooms.length - 2))];
    const book = randomSkillBook(rng, dungeonData.rarityBase.name);
    if (book) {
      book.x = room.x + 1 + Math.floor(rng() * Math.max(1, room.w - 2));
      book.y = room.y + 1 + Math.floor(rng() * Math.max(1, room.h - 2));
      items.push(book);
    }
  }

  // 宝箱：このフロアに最大 1 個（18% 確率）。中身は武器 (75%) または防具 (25%)。
  // 装備獲得の主経路をここに集約する（敵からは武器が出ない）。
  if (rng() <= 0.18 && rooms.length > 2) {
    const room = rooms[1 + Math.floor(rng() * Math.max(1, rooms.length - 2))];
    const seed = hashString(`chest:${dungeonData.seed}:${floor}`);
    const code = seed.toString().padStart(13, '0').slice(0, 13);
    // 中身を「武器か防具」になるよう生成（typeIdx 0 or 1）
    const want = rng() < 0.75 ? 'weapon' : 'armor';
    const inner = _generateEquipmentFromBarcode(code, dungeonData.rarityBase, itemLevel, want);
    if (inner) {
      const cx = room.x + 1 + Math.floor(rng() * Math.max(1, room.w - 2));
      const cy = room.y + 1 + Math.floor(rng() * Math.max(1, room.h - 2));
      items.push({
        type: 'chest',
        name: '宝箱',
        emoji: '🎁',
        rarity: inner.rarity,
        rarityColor: inner.rarityColor,
        inner,                 // 開けると inner が出る（rarity に応じた SFX 付き）
        x: cx, y: cy,
      });
    }
  }

  rooms.slice(1, -1).forEach((room, idx) => {
    // 通常アイテム（出現率 22%）。床落ち消耗品が多すぎたので段階的に削減。
    // 巻物（scroll）は _SCROLL_DROPS_ENABLED = false の間ドロップしない。
    // バランス調整中は薬のみが床に出る。
    if (rng() <= 0.22) {
      const subHash  = hashString(`${dungeonData.barcode}:${floor}:room${idx}`);
      const subCode  = subHash.toString().padStart(13, '0').slice(0, 13);
      const want = (_SCROLL_DROPS_ENABLED && rng() >= 0.6) ? 'scroll' : 'potion';
      const item = _generateConsumableFromBarcode(subCode, null, itemLevel, want);
      if (item) {
        const x = room.x + 1 + Math.floor(rng() * Math.max(1, room.w - 2));
        const y = room.y + 1 + Math.floor(rng() * Math.max(1, room.h - 2));
        item.x = x; item.y = y;
        items.push(item);
      }
    }

    // ゴールドの山（部屋ごと 28% で出現）。スロットを消費しない即時加算アイテム
    if (rng() <= 0.28) {
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

// バーコードから装備（weapon|armor）を生成。type を強制したい時用：
// generateItemFromBarcode は digit sum で type が決まるので、ここでは末尾を
// 補正して目的の type が出るバーコードに作り変える。
function _generateEquipmentFromBarcode(code, dungeonRarity, level, want) {
  const wantIdx = want === 'weapon' ? 0 : 1;
  const adjusted = _forceTypeBarcode(code, wantIdx);
  // 宝箱の中身はダンジョン基準レアリティ（少し贅沢）
  return generateItemFromBarcode(adjusted, dungeonRarity, level);
}

// バーコードから消耗品（potion/scroll）を生成。
function _generateConsumableFromBarcode(code, rarityOverride, level, want) {
  const wantIdx = want === 'potion' ? 2 : 3;
  const adjusted = _forceTypeBarcode(code, wantIdx);
  return generateItemFromBarcode(adjusted, rarityOverride, level);
}

// バーコードを「digit sum % 4 == wantIdx」になるよう先頭桁だけ補正
function _forceTypeBarcode(code, wantIdx) {
  const digits = code.split('').map(Number);
  let sum = 0;
  for (let i = 1; i < digits.length; i++) sum += digits[i];
  const cur = sum % 4;
  const delta = ((wantIdx - cur) % 4 + 4) % 4;
  digits[0] = (digits[0] + delta) % 10;
  return digits.join('');
}

// 公開：呼び出し側からも装備強制生成を使えるように
export { _forceTypeBarcode as forceTypeBarcode };

// ── レベリング設定 ──
export const MAX_LEVEL      = 100;
export const HP_PER_LEVEL   = 15;
export const ATK_PER_LEVEL  = 2;
export const DEF_PER_LEVEL  = 1;
export const MP_PER_LEVEL   = 4;
export const SKILL_MP_COST  = 8;

// 指定レベルへの「次のレベル到達に必要なXP」
//   旧: level * 20（Lv5 で 100 XP）→ 体感が遅すぎたので緩和。
//   新: 12 + level * 8（Lv1 で 20 / Lv5 で 52 / Lv50 で 412）。低 Lv はとても早く、
//   高 Lv では緩やかに伸びるカーブ。「格上撃破ボーナス」（main.js _xpFromMonster）
//   と組み合わせると、雑魚狩りでも適度に Lv が上がる体感になる。
export function xpRequiredForLevel(level) {
  return 12 + level * 8;
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
    inventory: [],          // 武器・防具・巻物（最大8個・スタック可）
    consumables: [],        // 回復薬専用ボックス（HP/MP ポーション）。容量無制限・スタック可・敗北時はロスト
    storage:   [],          // 容量無制限のアイテムボックス
    materials: [],          // 合成素材専用ボックス（持ち物を圧迫しない / 敗北時はロスト）
    gold:      0,           // 所持金（敵撃破・床落ちで増加。死亡しても持ち越し）
    type:      null,        // プレイヤータイプ（PLAYER_TYPES の id）。設定で変更
    learnedSkills: [],      // 習得済みすべての技
    skillSlots: [null, null, null, null],   // 装備中の技 4 スロット（各要素は技 or null）
    minions:   [],          // 仲間ミニオン [{ id, name, level, ... , learnedSkills, skillSlots }]
  };
}

export const SKILL_SLOTS_MAX = 4;

// ゴールドのフロアアイテムを生成（共通の見た目を統一）
export function makeGoldFloorItem(amount) {
  return {
    type: 'gold',
    name: `${amount} ゴールド`,
    emoji: '🪙',
    amount,
    rarity: 'コモン',
    rarityColor: '#ffd54f',
  };
}

// 敵撃破時のゴールド報酬（決定論的ではなくランダム要素を含む）。
// 戻り値が 0 の場合は「ドロップなし」を意味する（ボスは常に >0）。
// 通常雑魚は 50% の確率で 0 を返し、確定報酬ではなく「たまに出る」感覚にする。
export function rollGoldDropFromMonster(mob) {
  if (!mob.isBoss && Math.random() > 0.5) return 0;
  const lvl  = mob.level ?? 1;
  const rar  = mob.rarity;
  const base = 12 + lvl * 4;
  const rarBonus =
    rar === 'レジェンド' ? 150 :
    rar === 'エピック'   ? 55  :
    rar === 'レア'       ? 22  :
    0;
  const bossMul = mob.isBoss ? 4 : 1;
  const roll = 0.8 + Math.random() * 0.5;
  return Math.max(2, Math.floor((base + rarBonus) * bossMul * roll));
}
