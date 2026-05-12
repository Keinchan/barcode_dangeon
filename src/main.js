import { initMap, refreshPin, setPlayerPosition, invalidateMapSize, recenterOnPlayer, resumeGeolocation, setEncounterCallbacks, removeEncounterPin, debugSpawnEncounter } from './map.js';
import { startScanner, stopScanner, getPosition, categoryOfFormat } from './scanner.js';
import {
  createPlayer,
  applyLevelStats,
  xpRequiredForLevel,
  statsForLevel,
  enemyLevel,
  rollGoldDropFromMonster,
  makeGoldFloorItem,
  forceTypeBarcode,
  MAX_LEVEL,
  HP_PER_LEVEL,
  ATK_PER_LEVEL,
  DEF_PER_LEVEL,
  SKILL_SLOTS_MAX,
  buildSpecialDungeonForTome,
} from './generator.js';
import { applyJobStats, findJob, monsterDisplayName, jobForBarcode } from './monster-jobs.js';
import {
  generateItemFromBarcode, rarityFromDigit, bumpRarity, RARITIES, migrateElement,
  isStackable, stackKey, materialForRarity,
  PATTERN_OFFSETS, PATTERN_DESC, RANGE_TYPES, normalizeRangeType,
  findSkillById, elementMatchup, matchupLabel,
  elementMatchupTable, ELEMENTS,
  shopPriceFor,
  ENHANCE_RECIPES, applyEnhanceRecipe, fuseLegendaries, MATERIALS,
  makeLegendaryTome, makeKey,
  PLAYER_TYPES, findPlayerType,
  aptitudeElementsForPlayer, aptitudeElementsForMinion,
  canLearnSkillForPlayer, canLearnSkillForMinion,
  skillLevelReq, SKILLS_LIBRARY,
  WIZARD_SKILL_LIBRARY, wizardSkillsLearnableAt,
} from './items.js';
import { hashString } from './rng.js';
import { Dungeon } from './dungeon.js';
import {
  STATUS_DEFS, applyStatus, hasStatus, removeStatus, tickStatuses,
  accuracyMultiplier, shockSkipChance, fractureSelfHurtChance, dominantStatus,
  attackBuffMult, defenseBuffMult, activeBuffs, actionsPerTurn,
} from './status.js';
import {
  showFloatingDamage, showItemBanner, shockwave, magicCircle, playerVfxAnchor,
  hitFlash, screenShake, deathBurst, sparkSpray, explosion,
  showEnhanceCelebration, showDamageAt, showMissAt, showSkillPatternVfx,
  attackTrail, showAttackTelegraph, showSkillBadge,
} from './ui.js';
import {
  getCombatSpeed, setCombatSpeed,
  combatStepMs, combatPreFlashMs, shouldShowTelegraph,
  COMBAT_SPEED_NAMES, combatSpeedLabel, combatSpeedDesc,
} from './combat-speed.js';
import {
  isFirebaseConfigured,
  subscribeAuth,
  getCurrentAuthUser,
  signInEmail,
  signUpEmail,
  signInGoogle,
  signOutUser,
  loadSave,
  saveData,
  deleteSave,
} from './save.js';
import {
  DEBUG,
  setMockGps,
  clearMockGps,
  setBypassEnterRadius,
  setDisableEnemyAI,
  setRevealAll,
  setForceDrop,
  getDebugState,
} from './debug.js';
import {
  startBgm,
  stopBgm,
  playSfx,
  rarityTier,
  getAudioSettings,
  setBgmEnabled,
  setSfxEnabled,
  setBgmVolume,
  setSfxVolume,
  BGM_NAMES,
  SFX_NAMES,
} from './audio.js';
import { getItemIconUrl } from './icons.js';
import { showAlert, showConfirm } from './dialog.js';
import {
  buildPvpProfile,
  createRoom as pvpCreateRoom,
  joinRoom as pvpJoinRoom,
  watchRoom as pvpWatchRoom,
  setReady as pvpSetReady,
  startBattle as pvpStartBattle,
  destroyRoom as pvpDestroyRoom,
  submitMove as pvpSubmitMove,
  submitArenaAttack as pvpSubmitArenaAttack,
  submitFlee as pvpSubmitFlee,
  submitOwnState as pvpSubmitOwnState,
  pingHeartbeat as pvpPingHeartbeat,
  resetForRematch as pvpResetForRematch,
  submitBossUpdate as pvpSubmitBossUpdate,
  transferHost as pvpTransferHost,
  handleHostLeave as pvpHandleHostLeave,
  handleGuestLeave as pvpHandleGuestLeave,
  setRoomMode as pvpSetRoomMode,
  setRoomPvpFormat as pvpSetRoomPvpFormat,
  setRoomBoss as pvpSetRoomBoss,
  COOP_BOSSES as PVP_COOP_BOSSES,
} from './multiplayer.js';
import { MINION_LIBRARY, makeMinion, findMinionTemplate, rehydrateMinion } from './minions.js';
import {
  ensureScanBudget,
  getScanStatus,
  tryConsumeScan,
  addPlatinum,
  debugResetDailyScans,
  DAILY_FREE_SCANS,
  PLATINUM_STUB_GRANT,
} from './scan-budget.js';

// ─────────────────────────────────────────────
// インベントリのスタック操作
// ─────────────────────────────────────────────
//   isStackable(item) が true の場合、同じ stackKey のスタックに合算する。
//   非スタックは個体差があるので必ず別スロット。
//   capacity 指定時は新規スタック作成のみ枠を消費する（既存スタックへの加算は枠外）。
// 回復薬（potion / mpPotion）は別ボックス（player.consumables / 容量無制限）。
// 「持ち物8枠」を圧迫しないので、判定とプッシュ先を分岐させる。
function _isConsumableType(item) {
  return item?.type === 'potion' || item?.type === 'mpPotion';
}
// インベントリに追加できるか事前判定。
//   - 回復薬: 容量無制限なので常に true
//   - スタック可能アイテム: 既存スタックがあれば true（枠を消費しない）
//   - それ以外: 持ち物枠 < 8 で true
function canAddToInventory(item) {
  if (_isConsumableType(item)) return true;
  if (isStackable(item)) {
    const ex = player.inventory.find(it => isStackable(it) && stackKey(it) === stackKey(item));
    if (ex) return true;
  }
  return player.inventory.length < 8;
}

function _addToList(list, item, capacity) {
  if (!item) return { ok: false, msg: 'invalid' };
  const incomingCount = item.count ?? 1;
  if (isStackable(item)) {
    const key = stackKey(item);
    const ex  = list.find(it => isStackable(it) && stackKey(it) === key);
    if (ex) {
      ex.count = (ex.count ?? 1) + incomingCount;
      return { ok: true, stacked: true };
    }
  }
  if (capacity != null && list.length >= capacity) return { ok: false, msg: 'full' };
  // 新規追加。スタック対象は count 必須にする
  const entry = isStackable(item) ? { ...item, count: incomingCount } : { ...item };
  list.push(entry);
  return { ok: true, stacked: false };
}
// 回復薬は player.consumables（容量無制限）へ自動振り分け。それ以外は従来通り inventory（8枠）。
function addToInventory(item) {
  if (_isConsumableType(item)) {
    if (!Array.isArray(player.consumables)) player.consumables = [];
    return _addToList(player.consumables, item, null);
  }
  return _addToList(player.inventory, item, 8);
}
function addToStorage(item)   { return _addToList(player.storage,   item, null); }
// 素材は専用ボックス（容量無制限・スタック）。
// 持ち物を 1 枠も消費せず、敗北時の entrySnapshot 復元対象に含める。
function addToMaterials(item) { return _addToList(player.materials, item, null); }
// 回復薬の取り出し（HUD/メニュー使用時の 1 個減らし）。
function takeOneFromConsumables(idx) {
  if (!Array.isArray(player.consumables)) return null;
  const it = player.consumables[idx];
  if (!it) return null;
  if (isStackable(it) && (it.count ?? 1) > 1) {
    it.count -= 1;
    return { ...it, count: 1 };
  }
  return player.consumables.splice(idx, 1)[0];
}

// 指定 idx のアイテムを 1 個取り出す。スタックなら count -= 1、最後の 1 個 or
// 非スタックなら splice で除去。返り値は count=1 のシングルアイテム
function takeOneFromInventory(idx) {
  const it = player.inventory[idx];
  if (!it) return null;
  if (isStackable(it) && (it.count ?? 1) > 1) {
    it.count -= 1;
    return { ...it, count: 1 };
  }
  return player.inventory.splice(idx, 1)[0];
}

// セーブロード時の互換: 既存配列に count を埋め、同 stackKey の重複を 1 スタックに集約
function _consolidateStacks(p) {
  for (const arrName of ['inventory', 'consumables', 'storage', 'materials']) {
    const arr = p[arrName];
    if (!Array.isArray(arr)) continue;
    const merged = [];
    for (const it of arr) {
      if (typeof it.count !== 'number' && isStackable(it)) it.count = 1;
      if (isStackable(it)) {
        const ex = merged.find(m => isStackable(m) && stackKey(m) === stackKey(it));
        if (ex) { ex.count = (ex.count ?? 1) + (it.count ?? 1); continue; }
      }
      merged.push(it);
    }
    p[arrName] = merged;
  }
}

// アイテム表示を絵文字 → 手続きアイコンに置換するためのヘルパ
function iconImg(item, size = 38) {
  const url = getItemIconUrl(item, 64);
  return `<img class="item-icon" width="${size}" height="${size}" src="${url}" alt="${item.name}" />`;
}

// ── 状態 ──
let screen       = 'title';
let player       = createPlayer();      // セッション通して維持
let dungeonData  = null;
let dungeon      = null;
let currentFloor = 1;
const clearedSet = new Set();

// ダンジョン入場時のスナップショット（敗北時ロールバック用）
let entrySnapshot = null;
// スキャン直後の保留アイテム（「受け取る」で確定）
let pendingItem = null;

// ── 画面切替 ──
function show(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  screen = name;
  // マップを表示する時は Leaflet のサイズキャッシュを更新（非表示中に初期化されると
  // タイル配置がズレて、クリック座標と表示位置が不一致になり地図が勝手に動いて見える）。
  // また、ダンジョン入場〜離脱の間に GPS が大きく動いた場合に「地図中心は古い場所
  // のまま、新しいダンジョンが画面外」になるのを防ぐため、強制的にプレイヤー位置に
  // 再センタリングする。
  if (name === 'map') {
    requestAnimationFrame(() => {
      invalidateMapSize();
      recenterOnPlayer();
      // ダンジョン中にバックグラウンドで止まった可能性のある GPS watch を
      // 必ず再起動して即時 getCurrentPosition も叩く。死亡→マップ復帰直後に
      // ワンタップしないと現在地が動かない UX バグの根治。
      resumeGeolocation();
    });
  }
  _bgmForScreen(name);
}

// 画面 → BGM のマッピング
function _bgmForScreen(name) {
  switch (name) {
    case 'title':    startBgm('title');   break;
    case 'map':      startBgm('map');     break;
    case 'scanner':  startBgm('map');     break;   // スキャン中もマップ系
    case 'dungeon':  startBgm('dungeon'); break;
    case 'result':   stopBgm();           break;
    default:         /* keep */           break;
  }
}

// ─────────────────────────────────────────────
// マップ画面（位置ベース固定湧き）
// ─────────────────────────────────────────────
let pendingDungeon = null;

initMap({
  onEnter:       d => requestEnterDungeon(d),
  isCleared:     seed => clearedSet.has(seed),
  difficulty:    d => assessDifficulty(d, player),
  recommendedLv: d => recommendedLevel(d),
});

// ── 道端エンカウント（地図上のモンスター/強敵/宝箱/商人）──
//   消費済み（拾った宝箱・倒した強敵）の seed セットは localStorage に保持し、
//   再描画時に同じピンが再出現しないようにする。商人/雑魚モンスターは消費しない
//   （Pokemon GO 風に「同じ場所に戻ってきたらまた出会える」体験を維持）。
const _CONSUMED_KEY = 'real_hide:consumed-encounters:v1';
const consumedEncounters = new Set();
try {
  const raw = localStorage.getItem(_CONSUMED_KEY);
  if (raw) {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) for (const s of arr) consumedEncounters.add(s);
  }
} catch {}
function _markEncounterConsumed(seed) {
  consumedEncounters.add(seed);
  try {
    localStorage.setItem(_CONSUMED_KEY, JSON.stringify([...consumedEncounters]));
  } catch {}
  removeEncounterPin(seed);
}

// 地図 → main.js のコールバック登録。 GPS が来てから initMap が走る順序の都合で、
// player はこの時点で createPlayer() 済みなので level 取得も安全。
setEncounterCallbacks({
  onEncounter:  e => _handleMapEncounter(e),
  isConsumed:   seed => consumedEncounters.has(seed),
  playerLevel:  () => player?.level ?? 1,
});

// プレイヤーvsダンジョンの難易度評価
// 最終フロアのボスLvを基準に turnsToKill / turnsToDie の比から5段階のラベルを返す
// （フロアが深いほどボスLvが高くなる→自動でフロア難易度も加味される）
export function assessDifficulty(d, p) {
  const bossLvl   = enemyLevel(d, d.floors, true);
  const bossStats = statsForLevel(bossLvl);
  const mHp  = bossStats.maxHp;
  const mAtk = bossStats.atkBase;
  const mDef = bossStats.defBase;

  const playerEffectiveAtk = p.atk * 1.2;  // スキル/クリ込みでざっくり
  const turnsToKill = Math.max(1, mHp / Math.max(1, playerEffectiveAtk - mDef));
  const turnsToDie  = Math.max(1, p.hp / Math.max(1, mAtk - p.def));
  const ratio = turnsToKill / turnsToDie;

  if (ratio < 0.5) return { label: '楽勝', color: '#4caf50' };
  if (ratio < 1.0) return { label: '余裕', color: '#8bc34a' };
  if (ratio < 2.0) return { label: '適正', color: '#ffc107' };
  if (ratio < 4.0) return { label: '危険', color: '#ff9800' };
  return                  { label: '無謀', color: '#f44336' };
}

// ダンジョンの推奨レベル：装備なしの素体で「適正」以上になる最小レベル
export function recommendedLevel(d) {
  for (let L = 1; L <= MAX_LEVEL; L++) {
    const s = statsForLevel(L);
    const fake = { hp: s.maxHp, atk: s.atkBase, def: s.defBase };
    const diff = assessDifficulty(d, fake);
    if (diff.label !== '危険' && diff.label !== '無謀') return L;
  }
  return MAX_LEVEL;
}

// 入場前モーダル
function requestEnterDungeon(d) {
  playSfx('select');
  pendingDungeon = d;
  showPreDungeonModal(d);
}

// ── 道端エンカウント ハンドラ群 ──

// エンカウント kind ごとに処理を振り分ける。タップ時の主入口。
async function _handleMapEncounter(e) {
  if (!e) return;
  switch (e.kind) {
    case 'monster':  return _enterMapBattle(e, false);
    case 'strong':   return _enterMapBattle(e, true);
    case 'chest':    return _collectMapChest(e);
    case 'merchant': return _openMapMerchant(e);
  }
}

// エンカウントの spawn データ（level, rarity, element, jobId 等）から
// 戦闘可能なモンスターオブジェクトを再構築する。dungeon.js の generateMonster
// と同じ statsForLevel + applyJobStats を通すので、敵 AI もそのまま動く。
function _buildEncounterMob(e, isStrong) {
  const job = findJob(e.jobId) ?? jobForBarcode(e.barcode ?? '0000000000000');
  const stats   = statsForLevel(e.level);
  const jobStats = applyJobStats(stats, job);
  // 強敵は HP/ATK/DEF を更にブースト（boss 級）
  const hpMult  = isStrong ? 1.5 : 1.0;
  const atkMult = isStrong ? 1.2 : 1.0;
  const defMult = isStrong ? 1.2 : 1.0;
  const hp  = Math.max(1, Math.floor(jobStats.hp  * hpMult));
  const atk = Math.max(1, Math.floor(jobStats.atk * atkMult));
  const def = Math.max(0, Math.floor(jobStats.def * defMult));
  const skill = SKILLS_BY_ELEMENT_FALLBACK[e.element] ?? null;
  const display = monsterDisplayName(job, e.element);
  return {
    base: job.baseName,
    emoji: job.emoji,
    isBoss: true,                    // 単独敵: クリア判定で boss 扱いさせる
    name: isStrong ? `👹 強敵 ${display}` : display,
    level: e.level,
    rarity: e.rarity?.name ?? 'コモン',
    rarityColor: e.rarity?.color ?? '#9e9e9e',
    element: e.element,
    skill,
    skillCharge: 0,
    hp, maxHp: hp, atk, def, floor: 1,
    job: {
      id: job.id, label: job.label,
      aiHint: job.aiHint, preferredRange: job.preferredRange,
      chargeBonus: job.chargeBonus ?? 0,
    },
  };
}

// 簡易の属性スキル参照（generator.js SKILLS と同等）。
// generator.js の SKILLS は export していないため、
// ここに簡易テーブルを置いて単独敵の特殊技を割り当てる。
const SKILLS_BY_ELEMENT_FALLBACK = {
  '火': { name: '火炎放射',     mult: 2.0, healSelf: 0,    poison: false },
  '水': { name: 'ウォーターバ', mult: 1.8, healSelf: 0,    poison: false },
  '草': { name: '毒の蔓',       mult: 1.5, healSelf: 0,    poison: true  },
  '雷': { name: '雷撃',         mult: 2.4, healSelf: 0,    poison: false },
  '光': { name: '聖なる癒し',   mult: 0,   healSelf: 0.25, poison: false },
  '闇': { name: '影縫い',       mult: 2.0, healSelf: 0,    poison: true  },
};

// 1 ルーム戦闘ステージへ突入する。dungeonData は最低限のフィールドだけで
// dungeon.js の Dungeon クラスを満たし、isSingleRoom + encounterMonster で
// _buildSingleRoom 経路に入る。
async function _enterMapBattle(e, isStrong) {
  // 強敵は明示の確認モーダル（弱いプレイヤーが事故らないように）
  if (isStrong) {
    const ok = await showConfirm(
      `👹 強敵が現れた！\n\nLv${e.level} ${e.element ?? ''}属性 / ${e.rarity?.name ?? ''}\n` +
      `あなたは Lv${player.level}。挑みますか？\n\n` +
      `※ 倒すと大量経験値。挑戦は任意です。`,
      { okLabel: '挑む', cancelLabel: 'やめる', danger: true },
    );
    if (!ok) return;
  }
  const mob = _buildEncounterMob(e, isStrong);
  // dungeon.js が期待する最小限の dungeonData を組む。
  // theme は描画用の壁/床色。汎用の「野外」テーマ風にしておく。
  const dungeonForBattle = {
    seed: 'map:' + e.seed,
    barcode: e.barcode ?? String(e.seed).padStart(13, '0'),
    name: isStrong ? '強敵との戦い' : '野生の戦闘',
    theme: { name: '野外', wallColor: '#2a3a2a', floorColor: '#1a2218' },
    floors: 1,
    difficulty: 1,
    monsterTypeIdx: 0,
    elementIdx: 0,
    element: e.element,
    rarityBase: e.rarity ?? RARITIES[0],
    jobId: e.jobId,
    isMapBattle:   true,
    isSingleRoom:  true,
    encounterMonster: mob,
    encounterSeed: e.seed,            // クリア時に消費する種別
    isEncounterStrong: !!isStrong,
  };
  // pre-dungeon モーダルはダンジョン用（推奨 Lv やフロア構成を出す）。
  // 地図エンカウントの 1 ルーム戦闘は内容が固定なので、ポップアップで既に
  // 確認済み → 直で enterDungeon に進める。
  enterDungeon(dungeonForBattle);
}

// 宝箱: 拾うか確認してストレージへ自動収納。中身は鍵で開けるまで秘密にして、
// 開封時の演出で「初公開」する楽しみを残す（拾った瞬間に中身名を見せない）。
async function _collectMapChest(e) {
  if (consumedEncounters.has(e.seed)) return;
  if (!e.inner) return;
  const rarityName = e.rarity?.name ?? e.inner.rarity ?? 'コモン';
  const ok = await showConfirm(
    `🎁 ${rarityName}の宝箱を拾いますか？\n\n` +
    `中身は鍵を使って開けるまで分かりません。\n` +
    `（自動でストレージに収納されます）`,
    { okLabel: '拾う', cancelLabel: 'やめる' },
  );
  if (!ok) return;
  const chestItem = {
    type: 'chest',
    name: `${rarityName}の宝箱`,
    emoji: '🎁',
    rarity: rarityName,
    rarityColor: e.rarity?.color ?? e.inner.rarityColor,
    inner: e.inner,
  };
  addToStorage(chestItem);
  playSfx('pickup', { rarityTier: rarityTier(chestItem.rarity) });
  showAlert(`🎁 ${rarityName}の宝箱をストレージへ収納\nメニュー → 📦ストレージ → 🎁タブ から鍵で開けてください`);
  _markEncounterConsumed(e.seed);
  refreshHUD();
  refreshMenu();
  autoSave();
}

// 地図商人セッション: _openShopModal / _buyFromShop は dungeon.getShopStock に依存
// しているので、地図上から開いている間だけ dungeon を「在庫だけ返す軽量アダプタ」
// に差し替える。ショップ閉じる時 (btn-shop-close) に元へ戻す。
let _mapMerchantPrevDungeon = null;
function _openMapMerchant(e) {
  const fakeShopkeeper = {
    name: '行商人',
    level: e.level,
    isShopkeeper: true,
    isBoss: false,
    isMapMerchant: true,
    encounterSeed: e.seed,
  };
  // dungeon.getShopStock(mob) → e.stock を返すだけのアダプタ。
  // shopkeeperToStock.has は _handleMonsterDefeated 経路でしか使わないが
  // 互換のため空 Map を載せておく。
  const adapter = {
    getShopStock: (m) => (m === fakeShopkeeper ? e.stock : []),
    shopkeeperToStock: new Map([[fakeShopkeeper, e.stock]]),
  };
  _mapMerchantPrevDungeon = dungeon;
  dungeon = adapter;
  _openShopModal(fakeShopkeeper);
}

function showPreDungeonModal(d) {
  const stars = '⭐'.repeat(d.difficulty);
  const cleared = clearedSet.has(d.seed) ? '<span style="color:#4caf50">✅ 攻略済み</span> ' : '';
  const diff   = assessDifficulty(d, player);
  const recLv  = recommendedLevel(d);
  const bossLv = enemyLevel(d, d.floors, true);
  const lvDiff = player.level - recLv;
  const recLvColor = lvDiff >= 5 ? '#4caf50' : lvDiff >= 0 ? '#8bc34a' : lvDiff >= -5 ? '#ffc107' : '#f44336';
  document.getElementById('pre-dungeon-info').innerHTML =
    `<div class="pre-dungeon-info-line"><span class="label">名称</span><b>${d.name}</b></div>` +
    `<div class="pre-dungeon-info-line"><span class="label">難易度</span>${stars} / B${d.floors}F</div>` +
    `<div class="pre-dungeon-info-line"><span class="label">レアリティ</span>` +
      `<span style="color:${d.rarityBase.color};font-weight:bold">${d.rarityBase.name}</span></div>` +
    `<div class="pre-dungeon-info-line"><span class="label">属性</span>${d.element}</div>` +
    `<div class="pre-dungeon-info-line"><span class="label">推奨Lv</span>` +
      `<b style="color:${recLvColor};font-size:15px">Lv${recLv}</b>` +
      `<span style="color:#888;font-size:11px"> （ボスLv${bossLv}・あなたLv${player.level}）</span></div>` +
    `<div class="pre-dungeon-info-line"><span class="label">評価</span>` +
      `<b style="color:${diff.color};font-size:15px">${diff.label}</b>` +
      `<span style="color:#888;font-size:11px"> （現装備込み）</span></div>` +
    (cleared ? `<div class="pre-dungeon-info-line">${cleared}（再戦可）</div>` : '');

  const w = player.weapon;
  const a = player.armor;
  const wLine = w
    ? `<div class="pre-dungeon-info-line">${iconImg(w, 22)} <span style="color:${w.rarityColor}">${w.name}</span> ATK+${w.atkBonus}` +
      (w.skill?.name ? ` <span style="color:#888">(${w.skill.name})</span>` : '') + `</div>`
    : '<div class="pre-dungeon-info-line" style="color:#888">⚔️ 武器なし</div>';
  const aLine = a
    ? `<div class="pre-dungeon-info-line">${iconImg(a, 22)} <span style="color:${a.rarityColor}">${a.name}</span> DEF+${a.defBonus}` +
      (a.skill?.name ? ` <span style="color:#888">(${a.skill.name})</span>` : '') + `</div>`
    : '<div class="pre-dungeon-info-line" style="color:#888">🛡️ 防具なし</div>';

  document.getElementById('pre-dungeon-player').innerHTML =
    `<div class="pre-dungeon-info-line"><span class="label">レベル</span>` +
      `<b style="color:#ffc107">Lv${player.level}</b></div>` +
    `<div class="pre-dungeon-info-line">HP: <b style="color:#4caf50">${player.maxHp}/${player.maxHp}</b>` +
      ` <span style="color:#888">（入場時に全回復）</span></div>` +
    `<div class="pre-dungeon-info-line">ATK ${player.atk}　DEF ${player.def}</div>` +
    wLine + aLine +
    `<div class="pre-dungeon-info-line"><span class="label">持ち物</span>${player.inventory.length}/8 個</div>`;

  document.getElementById('pre-dungeon-modal').classList.remove('hidden');
}

document.getElementById('btn-pre-confirm').addEventListener('click', () => {
  if (!pendingDungeon) return;
  const d = pendingDungeon;
  pendingDungeon = null;
  playSfx('confirm');
  document.getElementById('pre-dungeon-modal').classList.add('hidden');
  enterDungeon(d);
});

document.getElementById('btn-pre-cancel').addEventListener('click', () => {
  pendingDungeon = null;
  playSfx('click');
  document.getElementById('pre-dungeon-modal').classList.add('hidden');
});

document.getElementById('btn-pre-menu').addEventListener('click', () => {
  // メニューを上に重ねて開く（pendingDungeon は維持）
  playSfx('click');
  openMenu();
});

document.getElementById('btn-scan').addEventListener('click', async () => {
  playSfx('click');
  // ボタン押下では消費せず「カメラを起こせるか」だけ事前確認する。
  // 実際のカウント消費はバーコードを読み取れた瞬間（_itemFromScan の直前）。
  // これにより読取失敗・キャンセルで無料枠が減る不具合を解消。
  if (!await _ensureCanScan()) return;
  show('scanner');
  launchScanner();
});

// スキャン開始前のチェック。残量があれば true。0 で結晶もあれば「使うか」確認、
// どちらも無ければ購入導線へ。ここでは消費しない（実スキャン成功時に消費）。
async function _ensureCanScan() {
  ensureScanBudget(player);
  const s = getScanStatus(player);
  if (s.freeRemaining > 0) return true;
  if (s.platinum > 0) {
    const ok = await showConfirm(
      `今日の無料スキャンを使い切りました（${s.dailyMax}/${s.dailyMax}）。\n` +
      `次に読み取れた 1 件にプラチナ結晶 1 個を使いますか？\n` +
      `（所持: 💎${s.platinum}）`,
      { okLabel: '結晶を使う', cancelLabel: 'やめる' },
    );
    return !!ok;
  }
  const buy = await showConfirm(
    `今日のスキャン上限（${s.dailyMax}/${s.dailyMax}）に達しました。\n` +
    `プラチナ結晶を購入しますか？\n\n` +
    `※ テストビルドのため購入ボタンで ${PLATINUM_STUB_GRANT} 個付与（実決済は未実装）`,
    { okLabel: `${PLATINUM_STUB_GRANT}個購入`, cancelLabel: 'やめる' },
  );
  if (!buy) return false;
  addPlatinum(player, PLATINUM_STUB_GRANT);
  autoSave();
  _refreshScanStatusUI();
  await showAlert(
    `💎${PLATINUM_STUB_GRANT} を付与しました（テストビルド）。\n` +
    `もう一度「スキャン」を押してください。`,
  );
  return false;
}

// スキャン成功時に呼ぶ：実際にカウントを 1 進める。
// 戻り値 false なら「もう消費できない＝結果を捨てる」を意味する。
function _consumeOnScanResult() {
  ensureScanBudget(player);
  const r = tryConsumeScan(player);
  if (r.ok) {
    autoSave();
    _refreshScanStatusUI();
  }
  return r.ok;
}

// スキャン残量・結晶残量の UI 反映（マップ HUD・スキャナーヘッダ・メニュー）
function _refreshScanStatusUI() {
  const s = getScanStatus(player);
  const text = `📷 ${s.used}/${s.dailyMax}　💎 ${s.platinum}`;
  const mapEl     = document.getElementById('map-scan-status');
  const scannerEl = document.getElementById('scanner-status');
  const menuEl    = document.getElementById('menu-scan-status');
  if (mapEl)     mapEl.textContent     = text;
  if (scannerEl) scannerEl.textContent = `本日 ${s.used}/${s.dailyMax}　💎 ${s.platinum}`;
  if (menuEl)    menuEl.textContent    = text;
}

document.getElementById('btn-menu').addEventListener('click', () => {
  playSfx('click');
  openMenu();
});
document.getElementById('btn-menu-close').addEventListener('click', () => {
  playSfx('click');
  document.getElementById('menu-modal').classList.add('hidden');
  // 入場前モーダルが裏にあれば、装備変更を反映するため再描画
  if (pendingDungeon) showPreDungeonModal(pendingDungeon);
});

// ダンジョン画面のメニューボタン
const btnDungeonMenu = document.getElementById('btn-dungeon-menu');
btnDungeonMenu.addEventListener('click', () => {
  playSfx('click');
  openMenu();
});

// ── フィールド拡大率（ユーザー操作で +/-）──
//   localStorage に永続化。0.5（50%）〜 2.0（200%）の範囲、ステップ 0.1。
//   dungeon.js の render() が window.__fieldZoom を見て canvas サイズに反映。
const ZOOM_STEP = 0.1;
const ZOOM_MIN  = 0.5;
const ZOOM_MAX  = 2.0;

function _loadFieldZoom() {
  const raw = parseFloat(localStorage.getItem('fieldZoom') ?? '1');
  if (!Number.isFinite(raw)) return 1;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, raw));
}
function _saveFieldZoom(z) {
  localStorage.setItem('fieldZoom', String(z));
}
function _applyFieldZoom(z) {
  window.__fieldZoom = z;
  const lvl = document.getElementById('zoom-level');
  if (lvl) lvl.textContent = `${Math.round(z * 100)}%`;
  const inBtn  = document.getElementById('btn-zoom-in');
  const outBtn = document.getElementById('btn-zoom-out');
  if (inBtn)  inBtn.disabled  = z >= ZOOM_MAX - 1e-6;
  if (outBtn) outBtn.disabled = z <= ZOOM_MIN + 1e-6;
  // ダンジョン画面に居る時は即時再描画。居ない時は次回 enterDungeon で反映。
  const canvas = document.getElementById('dungeon-canvas');
  if (canvas && typeof dungeon !== 'undefined' && dungeon) {
    dungeon.render(canvas);
  }
}
function _bumpFieldZoom(delta) {
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX,
    Math.round((( window.__fieldZoom ?? 1 ) + delta) * 10) / 10));
  if (next === window.__fieldZoom) return;
  _saveFieldZoom(next);
  _applyFieldZoom(next);
  playSfx('click');
}

// 初期化（localStorage から復元 → window.__fieldZoom にセット → 表示更新）
_applyFieldZoom(_loadFieldZoom());

document.getElementById('btn-zoom-in') ?.addEventListener('click', () => _bumpFieldZoom(+ZOOM_STEP));
document.getElementById('btn-zoom-out')?.addEventListener('click', () => _bumpFieldZoom(-ZOOM_STEP));

function openMenu() {
  // メニューを開いた直後は必ずホームに戻す（前回開いた stage は保持しない）
  _setMenuStage('home');
  refreshMenu();
  document.getElementById('menu-modal').classList.remove('hidden');
}

// メニューの 2 段階切り替え。data-stage を書き換えるだけで CSS が表示制御する。
const MENU_STAGE_TITLES = {
  home:      'メニュー',
  pocket:    '装備・持ち物',
  storage:   'ストレージ',
  materials: '素材ボックス',
  synth:     '合成・強化',
  skills:    '技・タイプ',
  element:   '属性相性',
  currency:  '通貨・スキャン',
  sound:     'サウンド',
  account:   'アカウント',
};
function _setMenuStage(stage) {
  const modal = document.getElementById('menu-modal');
  if (!modal) return;
  modal.dataset.stage = stage;
  const title = document.getElementById('menu-modal-title');
  if (title) title.textContent = MENU_STAGE_TITLES[stage] ?? 'メニュー';
  // ストレージ画面に入った時は持ち物ミニ一覧を再描画
  if (stage === 'storage') _refreshInventoryMini();
  if (stage === 'skills')  _refreshSkillConfig();
}

// タイル → ステージ切替
document.querySelectorAll('.menu-tile').forEach(btn => {
  btn.addEventListener('click', () => {
    playSfx('click');
    _setMenuStage(btn.dataset.go);
  });
});
document.getElementById('btn-menu-back').addEventListener('click', () => {
  playSfx('click');
  _setMenuStage('home');
});

// ストレージ画面の「持ち物ミニ」描画。
// 旧: 行全体タップで 1 個ストレージへ送られる → 名前を見ようとした時の誤送信が
// 多発していた。明示的に「→📦」ボタンタップ時だけ送るよう変更。
function _refreshInventoryMini() {
  const wrap = document.getElementById('menu-inventory-mini');
  if (!wrap) return;
  const cnt = document.getElementById('menu-inv-count-mini');
  if (cnt) cnt.textContent = `(${player.inventory.length}/8)`;
  if (player.inventory.length === 0) {
    wrap.innerHTML = '<div class="menu-empty">持ち物なし</div>';
    return;
  }
  wrap.innerHTML = '';
  player.inventory.forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'storage-mini-row';
    const cnt = (isStackable(it) && (it.count ?? 1) > 1) ? `<span class="menu-row-count">×${it.count}</span>` : '';
    row.innerHTML = `
      ${iconImg(it, 28)}
      <div class="storage-mini-row-info">
        <div class="storage-mini-row-name" style="color:${it.rarityColor}">${it.name} ${cnt}</div>
        <div class="storage-mini-row-stat">${_statLine(it)}</div>
      </div>
      <button class="storage-mini-row-send" type="button" aria-label="ストレージへ送る">→📦</button>
    `;
    row.querySelector('.storage-mini-row-send').addEventListener('click', (e) => {
      e.stopPropagation();
      _depositToStorage(idx);
      _refreshInventoryMini();   // ミニ側も即更新
    });
    wrap.appendChild(row);
  });
}

// ─────────────────────────────────────────────
// メニュー（装備・持ち物管理）
// ─────────────────────────────────────────────
function refreshMenu() {
  const u = getCurrentAuthUser();
  const label = u ? `(${u.email || 'Google: ' + (u.displayName ?? u.uid.slice(0, 6))})` : '(未ログイン)';
  document.getElementById('menu-username').textContent = label;
  // 音量設定の現在値をUIに反映
  _refreshAudioMenu();
  document.getElementById('menu-lv').textContent  = player.level;
  document.getElementById('menu-hp').textContent  = `${player.hp}/${player.maxHp}`;
  const menuMp = document.getElementById('menu-mp');
  if (menuMp) menuMp.textContent = `${player.mp ?? 0}/${player.maxMp ?? 0}`;
  document.getElementById('menu-atk').textContent = player.atk;
  document.getElementById('menu-def').textContent = player.def;
  const menuGold = document.getElementById('menu-gold');
  if (menuGold) menuGold.textContent = `🪙 ${player.gold ?? 0}`;

  // XP表示
  if (player.level >= MAX_LEVEL) {
    document.getElementById('menu-xp-current').textContent = 'MAX';
    document.getElementById('menu-xp-next').textContent    = 'MAX';
    document.getElementById('menu-xp-bar').style.width = '100%';
  } else {
    const need = xpRequiredForLevel(player.level);
    document.getElementById('menu-xp-current').textContent = player.xp;
    document.getElementById('menu-xp-next').textContent    = need;
    document.getElementById('menu-xp-bar').style.width = `${Math.min(100, (player.xp / need) * 100)}%`;
  }

  // 通貨・スキャン状況
  _refreshScanStatusUI();

  // 装備中
  const eq = document.getElementById('menu-equipment');
  eq.innerHTML = '';
  if (player.weapon) eq.appendChild(_renderEquippedRow(player.weapon, 'weapon'));
  if (player.armor)  eq.appendChild(_renderEquippedRow(player.armor,  'armor'));
  if (!player.weapon && !player.armor) {
    eq.innerHTML = '<div class="menu-empty">装備なし</div>';
  }

  // 持ち物（タブ切替対応）
  if (!Array.isArray(player.consumables)) player.consumables = [];
  const consCount = player.consumables.reduce((s, it) => s + (it.count ?? 1), 0);
  document.getElementById('menu-inv-count').textContent =
    `(${player.inventory.length}/8 + 回復${consCount}個)`;
  _refreshPocketTabs();
  _renderActivePocketTab();

  // ストレージ + 持ち物ミニ（ストレージ画面用）
  _refreshStorageUI();
  _refreshInventoryMini();
  // 素材ボックス
  _refreshMaterialsUI();
  // 合成
  _refreshSynthesisUI();
  // 属性相性チャート
  _refreshElementChart();
  // 技・タイプ設定
  _refreshSkillConfig();
  // 技を学ぶ/忘れるとスロット内容が変わるのでクイックバーも再描画
  _refreshWazaBar();
}

// ─────────────────────────────────────────────
// 持ち物タブ（all / weapon / armor / scroll / cons）
//   cons は consumables ボックス（容量無制限の回復薬専用）。それ以外は
//   player.inventory を type でフィルタ。
// ─────────────────────────────────────────────
let _activePocketTab = 'all';
function _refreshPocketTabs() {
  const wrap = document.getElementById('pocket-tabs');
  if (!wrap || wrap._wired) return;
  wrap._wired = true;
  for (const btn of wrap.querySelectorAll('.pocket-tab')) {
    btn.addEventListener('click', () => {
      _activePocketTab = btn.dataset.cat;
      wrap.querySelectorAll('.pocket-tab').forEach(b =>
        b.classList.toggle('active', b === btn));
      _renderActivePocketTab();
    });
  }
}
function _renderActivePocketTab() {
  const inv = document.getElementById('menu-inventory');
  if (!inv) return;
  inv.innerHTML = '';
  if (_activePocketTab === 'cons') {
    const list = player.consumables ?? [];
    if (list.length === 0) {
      inv.innerHTML = '<div class="menu-empty">回復薬なし</div>';
      return;
    }
    list.forEach((item, idx) => {
      inv.appendChild(_renderConsumableRow(item, idx));
    });
    return;
  }
  // 通常タブ: player.inventory を type でフィルタ。'all' はそのまま全件
  const filterFn = (it) => {
    switch (_activePocketTab) {
      case 'weapon': return it.type === 'weapon';
      case 'armor':  return it.type === 'armor';
      case 'scroll': return it.type === 'scroll' || it.type === 'mysteryScroll' || it.type === 'skillBook' || it.type === 'legendaryTome' || it.type === 'dungeonPortal';
      case 'key':    return it.type === 'key';
      default:       return true;
    }
  };
  // 元の idx を保持したいので map → filter（idx は player.inventory 内のもの）
  const rows = player.inventory
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => filterFn(item));
  if (rows.length === 0) {
    inv.innerHTML = '<div class="menu-empty">該当アイテムなし</div>';
    return;
  }
  for (const { item, idx } of rows) {
    inv.appendChild(_renderInventoryRow(item, idx));
  }
}

// 回復薬行: _renderInventoryRow と似ているが consumables ボックス用に
// idx の解釈と削除/消費が異なる（splice 対象が player.consumables）。
function _renderConsumableRow(item, idx) {
  const div = document.createElement('div');
  div.className = 'menu-row';
  const countHtml = (isStackable(item) && (item.count ?? 1) > 1)
    ? `<span class="menu-row-count">×${item.count}</span>` : '';
  // 使用は screen === 'dungeon' のみ。ダンジョン外でも表示はするが行動は不可にする
  // （_usePotionFromInventory が dungeonLog を出すので screen 不問でも安全に動くが、
  // UX 上は満タン警告のみを場外で出す挙動になる）。
  const isUsable = (item.type === 'potion' || item.type === 'mpPotion') && screen === 'dungeon';
  const action = isUsable ? 'use' : 'none';
  div.innerHTML = `
    <button class="menu-row-main" data-action="${action}" ${isUsable ? '' : 'disabled'}>
      <div class="menu-row-emoji">${iconImg(item, 38)}</div>
      <div class="menu-row-info">
        <div class="menu-row-name" style="color:${item.rarityColor}">${item.name} ${countHtml}</div>
        <div class="menu-row-stat">${_statLine(item)} / ${item.rarity}</div>
      </div>
    </button>
    <div class="menu-row-actions">
      <button class="menu-action-btn move deposit" title="ストレージへ">→📦</button>
      <button class="menu-action-btn danger discard">廃棄</button>
    </div>
  `;
  if (isUsable) {
    div.querySelector('.menu-row-main').addEventListener('click', () => {
      if (item.type === 'potion' && player.hp >= player.maxHp) {
        showAlert('HPが満タンです'); return;
      }
      if (item.type === 'mpPotion' && (player.mp ?? 0) >= (player.maxMp ?? 0)) {
        showAlert('MPが満タンです'); return;
      }
      showActionConfirm(`${item.name} を使いますか？`, item, '使う', () => {
        _usePotionFromInventory(idx, 'cons');
      });
    });
  }
  div.querySelector('.discard').addEventListener('click', async () => {
    const ok = await showConfirm(`${item.name} を廃棄しますか？`, { danger: true, okLabel: '廃棄' });
    if (!ok) return;
    player.consumables.splice(idx, 1);
    playSfx('discard');
    refreshMenu();
    autoSave();
  });
  div.querySelector('.deposit').addEventListener('click', () => {
    // 1 個だけストレージへ。スタックなら count -= 1。
    const taken = takeOneFromConsumables(idx);
    if (!taken) return;
    addToStorage(taken);
    refreshMenu();
    playSfx('click');
    autoSave();
  });
  return div;
}

// ─────────────────────────────────────────────
// 技・タイプ設定 UI
//   - プレイヤーのタイプ表示 + 「タイプを選ぶ」ボタン
//   - プレイヤーの技スロット 4 個（タップで習得済みから選ぶ）
//   - 各ミニオンの技スロット 4 個（同様）
//   - 習得済み技の一覧（ロック中の技には鍵マーク）
// ─────────────────────────────────────────────
function _ensurePlayerSkillFields() {
  if (!Array.isArray(player.learnedSkills)) player.learnedSkills = [];
  if (!Array.isArray(player.skillSlots) || player.skillSlots.length !== 4) {
    player.skillSlots = [null, null, null, null];
  }
}

// プライマリタイプの属性に対応するウィザード技を、現在レベル以下のものまで
// 自動習得する。重複は弾く。レベルアップ時 / タイプ変更時に呼ぶ。
//
//   silent: true なら習得バナーを表示しない（タイプ変更で 20 個まとめて学習する
//     ようなケースで通知が連発するのを抑制）。
//   slotAuto: true（デフォルト）なら、空きスロットにレベル要件を満たす新規技を
//     自動でセットする（プレイヤーがメニューを開かなくても技が発動可能になる）。
function _autoLearnWizardSkills({ silent = false, slotAuto = true } = {}) {
  _ensurePlayerSkillFields();
  const t = findPlayerType(player.type);
  if (!t) return;                           // タイプ未設定は救済（コモン技のみ）。自動習得しない
  const want = wizardSkillsLearnableAt(t.primary, player.level);
  const newlyLearned = [];
  for (const sk of want) {
    if (player.learnedSkills.find(x => x.id === sk.id)) continue;
    player.learnedSkills.push({ ...sk });
    newlyLearned.push(sk);
  }
  if (newlyLearned.length === 0) return;

  // 空きスロットがあればレベル要件を満たす新規技から順にオートセット
  if (slotAuto) {
    for (const sk of newlyLearned) {
      if (player.level < skillLevelReq(sk)) continue;
      const empty = player.skillSlots.findIndex(s => !s);
      if (empty === -1) break;
      player.skillSlots[empty] = { ...sk };
    }
  }

  // ダンジョン内ならログ。それ以外（マップ画面で経験値増減ボタン等）はバナー
  if (!silent) {
    for (const sk of newlyLearned) {
      const msg = `📕 ${sk.name} を習得！（${sk.element}・${sk.rarity}）`;
      if (screen === 'dungeon') dungeonLog(msg, { rarity: sk.rarity });
      else                       showItemBanner(
        { name: sk.name, rarity: sk.rarity, rarityColor: RARITIES.find(r => r.name === sk.rarity)?.color, level: sk.learnedAt, emoji: '📕' },
        { action: '技を習得' },
      );
    }
    playSfx('pickup', { rarityTier: rarityTier(newlyLearned[newlyLearned.length - 1].rarity) });
  }
  // メニュー開きっぱなしなら反映
  if (!document.getElementById('menu-modal').classList.contains('hidden')) {
    refreshMenu();
  }
}
function _ensureMinionSkillFields(mi) {
  if (!Array.isArray(mi.learnedSkills)) mi.learnedSkills = [];
  if (!Array.isArray(mi.skillSlots) || mi.skillSlots.length !== 4) {
    mi.skillSlots = [null, null, null, null];
  }
}

function _refreshSkillConfig() {
  _ensurePlayerSkillFields();
  // タイプ表示
  const typeEl = document.getElementById('player-type-display');
  if (typeEl) {
    const t = findPlayerType(player.type);
    if (t) {
      typeEl.innerHTML = `
        <span class="pt-emoji">${t.emoji}</span>
        <div>
          <div class="pt-name">${t.name}</div>
          <div class="pt-desc">${t.desc}</div>
          <div class="pt-apt">適性: ${t.primary}・${t.secondary}</div>
        </div>`;
    } else {
      typeEl.innerHTML = `
        <span class="pt-emoji">❔</span>
        <div>
          <div class="pt-name">未設定</div>
          <div class="pt-desc">タイプを設定すると属性に合った技が覚えられます。</div>
          <div class="pt-apt">未設定: コモン技のみ習得可（救済）</div>
        </div>`;
    }
  }
  // プレイヤースロット
  const pSlot = document.getElementById('player-skill-config');
  if (pSlot) {
    pSlot.innerHTML = _renderSkillConfigRow({
      ownerLabel: '自分', ownerEmoji: findPlayerType(player.type)?.emoji ?? '🧙',
      ownerLevel: player.level,
      slots: player.skillSlots,
      onSlotClick: i => _openSkillPicker({ owner: 'player', slotIdx: i }),
    });
    _bindSkillConfigRow(pSlot, player.skillSlots,
      i => _openSkillPicker({ owner: 'player', slotIdx: i }));
  }
  // ミニオン群
  const miBox = document.getElementById('minion-skill-config');
  if (miBox) {
    if (!Array.isArray(player.minions) || player.minions.length === 0) {
      miBox.innerHTML = '<div class="menu-empty">仲間はまだいません</div>';
    } else {
      miBox.innerHTML = '';
      player.minions.forEach((mi, mi_i) => {
        _ensureMinionSkillFields(mi);
        const wrap = document.createElement('div');
        wrap.innerHTML = _renderSkillConfigRow({
          ownerLabel: mi.name, ownerEmoji: mi.emoji ?? '🌸',
          ownerLevel: mi.level,
          slots: mi.skillSlots,
        });
        const row = wrap.firstElementChild;
        miBox.appendChild(row);
        _bindSkillConfigRow(row, mi.skillSlots,
          i => _openSkillPicker({ owner: 'minion', minionIdx: mi_i, slotIdx: i }));
      });
    }
  }
  // プレイヤー習得済み技
  const learnedEl = document.getElementById('player-learned-skills');
  const cnt = document.getElementById('player-learned-count');
  if (cnt) cnt.textContent = `(${player.learnedSkills.length})`;
  if (learnedEl) {
    if (player.learnedSkills.length === 0) {
      learnedEl.innerHTML = '<div class="menu-empty">習得済みの技はまだありません</div>';
    } else {
      learnedEl.innerHTML = player.learnedSkills.map(s => {
        const lvReq = skillLevelReq(s);
        const locked = player.level < lvReq;
        const emoji = SKILL_ELEMENT_EMOJI[s.element] ?? '✨';
        return `
          <div class="learned-skill-row${locked ? ' locked' : ''}">
            <span class="lr-emoji">${emoji}</span>
            <div>
              <div class="lr-name" style="color:${SKILL_ELEMENT_COLOR[s.element] ?? '#ddd'}">
                ${s.name}${locked ? `🔒Lv${lvReq}` : ''}
              </div>
              <div class="lr-meta">${s.element} / ${s.pattern}型 / 威力×${s.dmgMult} / MP-${s.mpCost} / ${s.rarity}</div>
            </div>
          </div>`;
      }).join('');
    }
  }
}

function _renderSkillConfigRow({ ownerLabel, ownerEmoji, ownerLevel, slots }) {
  const slotHtml = (slots ?? [null,null,null,null]).map((sk, i) => {
    if (!sk) {
      return `<button class="skill-config-slot empty" data-slot="${i}">
        <span class="slot-emoji">＋</span><span class="slot-name">空き</span></button>`;
    }
    const emoji = SKILL_ELEMENT_EMOJI[sk.element] ?? '✨';
    const lvReq = skillLevelReq(sk);
    const locked = (ownerLevel ?? 1) < lvReq;
    const color = SKILL_ELEMENT_COLOR[sk.element] ?? '#c5c5d4';
    return `<button class="skill-config-slot${locked ? ' locked' : ''}" data-slot="${i}"
      style="border-color:${color};color:${color};background:linear-gradient(180deg,${color}33 0%,${color}11 100%)">
      <span class="slot-emoji">${emoji}</span>
      <span class="slot-name">${sk.name}${locked ? '🔒' : ''}</span>
      <span class="slot-mp">MP-${sk.mpCost}</span>
    </button>`;
  }).join('');
  return `
    <div class="skill-config-row">
      <div class="skill-config-icon">${ownerEmoji}</div>
      <div class="skill-config-info">
        <div class="name">${ownerLabel}</div>
        <div class="meta">Lv${ownerLevel ?? 1}</div>
      </div>
      <div class="skill-config-slots">${slotHtml}</div>
    </div>`;
}

function _bindSkillConfigRow(rowEl, slots, onClickSlot) {
  if (!rowEl) return;
  rowEl.querySelectorAll('.skill-config-slot').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.slot, 10);
      if (Number.isNaN(i)) return;
      onClickSlot(i);
    });
  });
}

// ── タイプ選択モーダル ──
document.getElementById('btn-open-type-select')?.addEventListener('click', () => {
  const list = document.getElementById('type-select-list');
  if (!list) return;
  list.innerHTML = PLAYER_TYPES.map(t => {
    const active = t.id === player.type ? ' active' : '';
    return `<button class="type-select-cell${active}" data-id="${t.id}">
      <div class="ts-name">${t.emoji} ${t.name}</div>
      <div class="ts-desc">${t.desc}</div>
      <div class="ts-apt">適性: ${t.primary}・${t.secondary}</div>
    </button>`;
  }).join('');
  list.querySelectorAll('.type-select-cell').forEach(btn => {
    btn.addEventListener('click', () => {
      player.type = btn.dataset.id;
      playSfx('confirm');
      document.getElementById('type-select-modal').classList.add('hidden');
      // タイプ変更時も自動習得を回す。すでに覚えた技（旧タイプの技含む）は失われない。
      // 新タイプのプライマリ属性で「現在のレベル以下の技」を全部覚える。
      _autoLearnWizardSkills({ silent: true });
      // 装着中のスロットに新タイプ適性外の技が残っていると「使えるが当たらない」
      // 不整合になるので、適性外スロットだけ空にする（learnedSkills は保持）
      _purgeOffAptitudeSlots();
      _refreshSkillConfig();
      _refreshWazaBar();
      autoSave();
    });
  });
  document.getElementById('type-select-modal').classList.remove('hidden');
});
document.getElementById('btn-type-select-cancel')?.addEventListener('click', () => {
  document.getElementById('type-select-modal').classList.add('hidden');
});

// プレイヤーの現在タイプ適性に技 element が含まれるか判定。
// タイプ未設定は救済としてコモン技だけ許可する。
function _skillElementInAptitude(skill) {
  if (!skill) return false;
  const t = findPlayerType(player.type);
  if (!t) return skill.rarity === 'コモン';
  return skill.element === t.primary || skill.element === t.secondary;
}
// タイプ変更後にスロットへ残っている適性外の技を取り除く。
// learnedSkills（コレクション）は触らず、装備中スロットだけクリアする。
function _purgeOffAptitudeSlots() {
  if (!Array.isArray(player.skillSlots)) return;
  for (let i = 0; i < player.skillSlots.length; i++) {
    const sk = player.skillSlots[i];
    if (sk && !_skillElementInAptitude(sk)) {
      player.skillSlots[i] = null;
    }
  }
}

// ── 技選択（スロットへ割り当て）モーダル ──
let _skillPickContext = null;
function _openSkillPicker(ctx) {
  _skillPickContext = ctx;
  const modal = document.getElementById('skill-pick-modal');
  const title = document.getElementById('skill-pick-title');
  const meta  = document.getElementById('skill-pick-meta');
  const list  = document.getElementById('skill-pick-list');
  if (!modal || !list) return;

  let pool = [];
  let ownerLevel = 1;
  let labelMeta = '';
  if (ctx.owner === 'player') {
    _ensurePlayerSkillFields();
    // タイプ変更後に旧タイプの技をスロットへ載せられないよう適性でフィルタする。
    // learnedSkills 自体は将来タイプを戻したときに復活できるよう温存する。
    pool = (player.learnedSkills ?? []).filter(_skillElementInAptitude);
    ownerLevel = player.level;
    const t = findPlayerType(player.type);
    labelMeta = `自分のスロット ${ctx.slotIdx + 1} 番に技を割り当てます。タイプ: ${t ? t.name : '未設定'}（適性外の技は表示されません）`;
  } else {
    const mi = player.minions[ctx.minionIdx];
    if (!mi) return;
    _ensureMinionSkillFields(mi);
    pool = mi.learnedSkills;
    ownerLevel = mi.level;
    labelMeta = `${mi.name} のスロット ${ctx.slotIdx + 1} 番に割り当てます。属性: ${mi.element}`;
  }

  title.textContent = `スロット ${ctx.slotIdx + 1} の技を選ぶ`;
  meta.textContent  = labelMeta;
  if (!pool || pool.length === 0) {
    list.innerHTML = '<div class="menu-empty">習得済みの技がありません</div>';
  } else {
    list.innerHTML = pool.map((sk, i) => {
      const lvReq = skillLevelReq(sk);
      const locked = ownerLevel < lvReq;
      const emoji = SKILL_ELEMENT_EMOJI[sk.element] ?? '✨';
      const color = SKILL_ELEMENT_COLOR[sk.element] ?? '#c5c5d4';
      return `<div class="skill-pick-row${locked ? ' locked' : ''}" data-idx="${i}">
        <span class="sp-emoji">${emoji}</span>
        <div>
          <div class="sp-name" style="color:${color}">${sk.name}</div>
          <div class="sp-meta">${sk.element} / ${sk.pattern}型 / 威力×${sk.dmgMult} / MP-${sk.mpCost} / ${sk.rarity}</div>
        </div>
        ${locked ? `<span class="sp-lock">🔒 Lv${lvReq}</span>` : ''}
      </div>`;
    }).join('');
    list.querySelectorAll('.skill-pick-row:not(.locked)').forEach(row => {
      row.addEventListener('click', () => {
        const i = parseInt(row.dataset.idx, 10);
        const sk = pool[i];
        if (!sk) return;
        _assignSkillToSlot(_skillPickContext, sk);
        modal.classList.add('hidden');
      });
    });
  }
  modal.classList.remove('hidden');
}
function _assignSkillToSlot(ctx, skill) {
  if (!ctx) return;
  if (ctx.owner === 'player') {
    _ensurePlayerSkillFields();
    player.skillSlots[ctx.slotIdx] = skill ? { ...skill } : null;
  } else {
    const mi = player.minions[ctx.minionIdx];
    if (!mi) return;
    _ensureMinionSkillFields(mi);
    mi.skillSlots[ctx.slotIdx] = skill ? { ...skill } : null;
  }
  playSfx('equip');
  _refreshSkillConfig();
  _refreshWazaBar();
  autoSave();
}
document.getElementById('btn-skill-pick-clear')?.addEventListener('click', () => {
  if (_skillPickContext) _assignSkillToSlot(_skillPickContext, null);
  document.getElementById('skill-pick-modal').classList.add('hidden');
});
document.getElementById('btn-skill-pick-cancel')?.addEventListener('click', () => {
  document.getElementById('skill-pick-modal').classList.add('hidden');
});

// 素材ボックスの一覧表示。アイコンと個数だけのシンプルなグリッド。
function _refreshMaterialsUI() {
  const grid = document.getElementById('menu-materials');
  if (!grid) return;
  if (!Array.isArray(player.materials)) player.materials = [];
  const total = player.materials.reduce((s, it) => s + (it.count ?? 1), 0);
  document.getElementById('menu-materials-count').textContent = `(${total})`;
  if (player.materials.length === 0) {
    grid.innerHTML = '<div class="menu-empty">素材なし</div>';
    return;
  }
  grid.innerHTML = '';
  for (const it of player.materials) {
    const cell = document.createElement('div');
    cell.className = 'material-cell';
    cell.title = `${it.name}（${it.rarity}）${it.desc ? ' / ' + it.desc : ''}`;
    cell.innerHTML = `
      <div class="material-cell-emoji">${iconImg(it, 32)}</div>
      <div class="material-cell-name" style="color:${it.rarityColor}">${it.name}</div>
      <div class="material-cell-count">×${it.count ?? 1}</div>
    `;
    grid.appendChild(cell);
  }
}

// 属性相性チャート：2 つの 3 元素サイクルを矢印付きで描画する。
// 「攻撃側 → 防御側 が 1.5 倍」を A → B として横に並べる。
const ELEMENT_EMOJI = {
  '火': '🔥', '水': '💧', '草': '🌿',
  '雷': '⚡', '光': '✨', '闇': '🌑',
};
const ELEMENT_COLOR_HEX = {
  '火': '#ff6b3d', '水': '#4dc4ff', '草': '#66bb6a',
  '雷': '#ffd54f', '光': '#fff176', '闇': '#b070dd',
};
function _refreshElementChart() {
  const el = document.getElementById('element-chart');
  if (!el) return;
  // 自然サイクル（火→草→水→火）と神秘サイクル（光→闇→雷→光）を 2 行で表示
  const cycles = [
    { title: '🌿 自然', order: ['火', '草', '水'] },
    { title: '✨ 神秘', order: ['光', '闇', '雷'] },
  ];
  el.innerHTML = cycles.map(c => {
    const cells = c.order.map(e => `
      <span class="element-chart-cell" style="color:${ELEMENT_COLOR_HEX[e]};
        background:${ELEMENT_COLOR_HEX[e]}22;border-color:${ELEMENT_COLOR_HEX[e]}66">
        ${ELEMENT_EMOJI[e]} ${e}
      </span>`).join('<span class="element-chart-arrow">→</span>');
    return `<div class="element-chart-row">
      <span class="element-chart-cycle-name">${c.title}</span>
      ${cells}<span class="element-chart-arrow">↩︎</span>
    </div>`;
  }).join('');
}

// ─── ストレージ UI ───
let _storageCat  = 'all';
let _storageSort = 'rarity';
let _storageBound = false;

function _refreshStorageUI() {
  if (!Array.isArray(player.storage)) player.storage = [];

  // 初回バインド
  if (!_storageBound) {
    _storageBound = true;
    document.querySelectorAll('.storage-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        _storageCat = btn.dataset.cat;
        document.querySelectorAll('.storage-tab').forEach(b => b.classList.toggle('active', b === btn));
        _refreshStorageUI();
      });
    });
    document.getElementById('storage-sort').addEventListener('change', e => {
      _storageSort = e.target.value;
      _refreshStorageUI();
    });
    document.getElementById('btn-deposit-all').addEventListener('click', () => {
      if (player.inventory.length === 0) return;
      const moved = player.inventory.length;
      // weapon/armor は装備中以外を全部ストレージへ
      for (const it of player.inventory) player.storage.push(it);
      player.inventory = [];
      playSfx('discard');   // 「ガサッ」と入れる感のため流用
      refreshMenu();
      autoSave();
      showAlert(`${moved} 個をストレージに移動しました`);
    });
  }

  const grid = document.getElementById('menu-storage');
  document.getElementById('menu-storage-count').textContent = `(${player.storage.length})`;
  grid.innerHTML = '';

  let arr = player.storage.map((it, origIdx) => ({ it, origIdx }));
  if (_storageCat !== 'all') {
    // 'potion' タブには HP / MP の両方を、'scroll' タブには通常巻物 + 不思議系 + 技の書も含める
    arr = arr.filter(x => x.it.type === _storageCat
      || (_storageCat === 'potion' && x.it.type === 'mpPotion')
      || (_storageCat === 'scroll' && (x.it.type === 'mysteryScroll' || x.it.type === 'skillBook')));
  }
  arr = _sortStorageRows(arr, _storageSort);

  if (arr.length === 0) {
    grid.innerHTML = '<div class="menu-empty">ストレージは空です</div>';
    return;
  }
  for (const { it, origIdx } of arr) {
    grid.appendChild(_renderStorageRow(it, origIdx));
  }
}

const _RARITY_RANK = { 'レジェンド': 4, 'エピック': 3, 'レア': 2, 'コモン': 1 };
function _sortStorageRows(arr, sortKey) {
  const cp = arr.slice();
  switch (sortKey) {
    case 'rarity':
      cp.sort((a, b) => {
        const r = (_RARITY_RANK[b.it.rarity] ?? 0) - (_RARITY_RANK[a.it.rarity] ?? 0);
        if (r !== 0) return r;
        return (b.it.level ?? 1) - (a.it.level ?? 1);
      });
      break;
    case 'level':
      cp.sort((a, b) => (b.it.level ?? 1) - (a.it.level ?? 1));
      break;
    case 'name':
      cp.sort((a, b) => a.it.name.localeCompare(b.it.name, 'ja'));
      break;
    case 'recent':
    default:
      // origIdx が大きいほど新しい
      cp.sort((a, b) => b.origIdx - a.origIdx);
      break;
  }
  return cp;
}

function _renderStorageRow(item, idx) {
  const div = document.createElement('div');
  div.className = 'menu-row';
  const skillHtml = item.skill?.name
    ? `<div class="menu-row-skill">✨ ${item.skill.name}</div>` : '';
  const lvHtml = item.level ? `<span class="menu-row-lv">Lv${item.level}</span>` : '';
  const countHtml = (isStackable(item) && (item.count ?? 1) > 1)
    ? `<span class="menu-row-count">×${item.count}</span>` : '';
  // 宝箱はストレージから直接「鍵で開ける」アクションを出す（持ち物に戻す手間を省略）。
  const isChest = item.type === 'chest';
  const openBtn = isChest
    ? `<button class="menu-action-btn open">🗝️ 開ける</button>` : '';
  div.innerHTML = `
    <div class="menu-row-emoji">${iconImg(item, 38)}</div>
    <div class="menu-row-info">
      <div class="menu-row-name" style="color:${item.rarityColor}">${item.name} ${lvHtml} ${countHtml}</div>
      <div class="menu-row-stat">${_statLine(item)} / ${item.rarity}</div>
      ${skillHtml}
    </div>
    <div class="menu-row-actions">
      ${openBtn}
      <button class="menu-action-btn move withdraw">→持ち物</button>
      <button class="menu-action-btn danger discard">廃棄</button>
    </div>
  `;
  if (isChest) {
    div.querySelector('.open').addEventListener('click', () => _openChestFromStorage(idx));
  }
  div.querySelector('.withdraw').addEventListener('click', () => {
    // スタック対象なら持ち物の同じスタックに合流できるので満杯でも OK な場合あり
    const probe = player.storage[idx];
    if (!probe) return;
    if (!canAddToInventory(probe)) { showAlert('持ち物が満杯です'); return; }
    // 1 個だけ取り出してインベントリへ
    const it = isStackable(probe) && (probe.count ?? 1) > 1
      ? (probe.count -= 1, { ...probe, count: 1 })
      : player.storage.splice(idx, 1)[0];
    if (it) {
      addToInventory(it);
      playSfx('equip');
      refreshMenu();
      autoSave();
    }
  });
  div.querySelector('.discard').addEventListener('click', async () => {
    const cnt = (isStackable(item) && (item.count ?? 1) > 1)
      ? `（×${item.count} まとめて）` : '';
    const ok = await showConfirm(`${item.name}${cnt} を廃棄しますか？`, { danger: true, okLabel: '廃棄' });
    if (!ok) return;
    player.storage.splice(idx, 1);
    playSfx('discard');
    refreshMenu();
    autoSave();
  });
  return div;
}

// 持ち物 → ストレージ単品送り（_renderInventoryRow にボタンを追加するヘルパ）。
// スタックなら 1 個だけ送る（残りはインベントリ側のスタックに残る）。
function _depositToStorage(idx) {
  const it = takeOneFromInventory(idx);
  if (!it) return;
  addToStorage(it);
  playSfx('discard');
  refreshMenu();
  autoSave();
}

// 床にアイテムをドロップする時の配置ヘルパ。元座標 (ox,oy) が walkable で
// 他の床アイテムが居なければそこ、既に何か置いてあれば BFS で 8 方向に
// 1 マスずつ広げて空き walkable マスを探す。階段マスは除外（拾い忘れの
// 「降りた瞬間に消える」UX 事故を防ぐ）。完全に詰まっていたら原点に重ねる。
// drop.x / drop.y を確定させた状態で floorItems に push する。
function _placeFloorDrop(item, ox, oy) {
  if (!dungeon) return;
  const occupied = (x, y) => dungeon.floorItems.some(i => i.x === x && i.y === y);
  const isStairs = (x, y) => dungeon.atStairs?.(x, y);
  const tryPlace = (x, y) => {
    if (!dungeon.canWalk(x, y)) return false;
    if (isStairs(x, y))           return false;
    if (occupied(x, y))           return false;
    item.x = x; item.y = y;
    dungeon.floorItems.push(item);
    return true;
  };
  if (tryPlace(ox, oy)) return;
  // BFS: 距離 1 → 2 → 3 ... 最大 4 まで（壁に閉じ込められた特殊配置は諦める）
  for (let r = 1; r <= 4; r++) {
    const ring = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        ring.push([dx, dy]);
      }
    }
    // 同じ距離内ではランダム順で試す（毎回同じ方向に偏らないように）
    for (let i = ring.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ring[i], ring[j]] = [ring[j], ring[i]];
    }
    for (const [dx, dy] of ring) {
      if (tryPlace(ox + dx, oy + dy)) return;
    }
  }
  // 完全に詰まっている時は原点に重ねるしかない（旧挙動）
  item.x = ox; item.y = oy;
  dungeon.floorItems.push(item);
}

// ボス撃破直後など、フロアに置けないドロップを自動取得。
// 素材は素材ボックスへ直行（インベントリを圧迫しない）。
// それ以外はインベントリ余裕があればそこ、満杯ならストレージに退避（永久消失を防ぐ）。
function _autoCollectDrop(drop) {
  if (!Array.isArray(player.storage))   player.storage   = [];
  if (!Array.isArray(player.materials)) player.materials = [];
  let to = '🎒持ち物へ';
  if (drop.type === 'material') {
    addToMaterials(drop);
    to = '🧰素材ボックスへ';
  } else if (canAddToInventory(drop)) {
    addToInventory(drop);
  } else {
    addToStorage(drop);
    to = '📦ストレージへ';
  }
  playSfx('drop', { rarityTier: rarityTier(drop.rarity) });
  if (typeof dungeonLog === 'function' && screen === 'dungeon') {
    dungeonLog(`💎 ${drop.name} を獲得！（${to}）`, { rarity: drop.rarity });
  }
  if (drop.rarity !== 'コモン') {
    _celebratePickup(drop, to);
  } else if (to === '📦ストレージへ') {
    showAlert(`持ち物満杯のため ${drop.name} はストレージへ`);
  }
}

// 音声設定UI（メニュー）の現在値反映と一回限りのバインド
let _audioMenuBound = false;
function _refreshAudioMenu() {
  const s = getAudioSettings();
  const bgmChk = document.getElementById('menu-bgm-toggle');
  const sfxChk = document.getElementById('menu-sfx-toggle');
  const bgmVol = document.getElementById('menu-bgm-volume');
  const sfxVol = document.getElementById('menu-sfx-volume');
  if (!bgmChk) return;
  bgmChk.checked = s.bgmEnabled;
  sfxChk.checked = s.sfxEnabled;
  bgmVol.value   = s.bgmVolume;
  sfxVol.value   = s.sfxVolume;

  // 戦闘速度セグメント描画（毎回 active を更新する必要があるので毎回再描画）
  _refreshCombatSpeedUI();

  if (_audioMenuBound) return;
  _audioMenuBound = true;
  bgmChk.addEventListener('change', e => {
    setBgmEnabled(e.target.checked);
    if (e.target.checked) _bgmForScreen(screen);
  });
  sfxChk.addEventListener('change', e => {
    setSfxEnabled(e.target.checked);
    if (e.target.checked) playSfx('click');
  });
  bgmVol.addEventListener('input', e => setBgmVolume(parseFloat(e.target.value)));
  sfxVol.addEventListener('input', e => setSfxVolume(parseFloat(e.target.value)));
  sfxVol.addEventListener('change', () => playSfx('click'));
}

// 戦闘速度セグメント（高速 / 低速）。クリックで即時切替・active 表示更新。
function _refreshCombatSpeedUI() {
  const wrap = document.getElementById('menu-combat-speed');
  if (!wrap) return;
  const cur = getCombatSpeed();
  wrap.innerHTML = COMBAT_SPEED_NAMES.map(name => {
    const active = (name === cur) ? ' active' : '';
    return `<button class="combat-speed-btn${active}" data-speed="${name}">
      <span class="combat-speed-btn-label">${combatSpeedLabel(name)}</span>
      <span class="combat-speed-btn-desc">${combatSpeedDesc(name)}</span>
    </button>`;
  }).join('');
  wrap.querySelectorAll('.combat-speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setCombatSpeed(btn.dataset.speed);
      playSfx('click');
      _refreshCombatSpeedUI();
    });
  });
}

function _statLine(item) {
  if (item.type === 'weapon') return `ATK +${item.atkBonus}（${item.element}属性）`;
  if (item.type === 'armor')  return `DEF +${item.defBonus}（${item.element}属性）`;
  if (item.type === 'potion')        return `HP +${item.heal} 回復`;
  if (item.type === 'mpPotion')      return `MP +${item.mpHeal} 回復`;
  if (item.type === 'mysteryScroll') return item.desc;
  if (item.type === 'skillBook')     return `📕 ${item.skillName} を習得`;
  if (item.type === 'legendaryTome') return item.desc;
  if (item.type === 'scroll') return `${item.element}属性 ${item.dmg}ダメージ`;
  if (item.type === 'key')    return '🗝️ 宝箱を 1 つ開ける';
  if (item.type === 'chest')  {
    if (!item.inner) return '🎁 中身は空…';
    // 中身は秘密にして、レア度だけ匂わせる（開封時の演出で初公開する設計）
    return `🎁 ${item.rarity ?? ''}の宝箱（鍵で開ける）`;
  }
  if (item.type === 'dungeonPortal') {
    const f = item.dungeonData?.floors ?? '?';
    return `🌀 ${item.element ?? ''}属性 / B${f}F（突入＝入口消費）`;
  }
  return '';
}

function _renderEquippedRow(item, slot) {
  const div = document.createElement('div');
  div.className = 'menu-row';
  const skillHtml = item.skill?.name
    ? `<div class="menu-row-skill">✨ ${item.skill.name}: ${item.skill.desc}</div>` : '';
  const lvHtml = item.level ? `<span class="menu-row-lv">Lv${item.level}</span>` : '';
  div.innerHTML = `
    <button class="menu-row-main" data-action="unequip">
      <div class="menu-row-emoji">${iconImg(item, 38)}</div>
      <div class="menu-row-info">
        <div class="menu-row-name" style="color:${item.rarityColor}">${item.name} ${lvHtml}</div>
        <div class="menu-row-stat">${_statLine(item)} / ${item.rarity}</div>
        ${skillHtml}
      </div>
    </button>
  `;
  div.querySelector('.menu-row-main').addEventListener('click', () => {
    _onUnequipClick(slot);
  });
  return div;
}

// 装備外し：同スロットの候補がある場合は交換モーダル、無ければ単に外す
function _onUnequipClick(slot) {
  const candidates = player.inventory
    .map((it, idx) => ({ it, idx }))
    .filter(({ it }) => it.type === slot);

  if (candidates.length === 0) {
    if (player.inventory.length >= 8) {
      showAlert('持ち物が満杯のため外せません。先に何か廃棄してください');
      return;
    }
    const cur = slot === 'weapon' ? player.weapon : player.armor;
    showActionConfirm('装備を外して持ち物に入れますか？', cur, '外す', () => {
      _unequipDirect(slot);
      refreshHUD();
      refreshMenu();
      autoSave();
    });
    return;
  }

  _showSwapModal(slot, candidates);
}

function _unequipDirect(slot) {
  if (slot === 'weapon' && player.weapon) {
    player.inventory.push(player.weapon);
    player.weapon = null;
    player.atk    = player.atkBase;
    playSfx('unequip');
  } else if (slot === 'armor' && player.armor) {
    player.inventory.push(player.armor);
    player.armor  = null;
    player.def    = player.defBase;
    playSfx('unequip');
  }
}

function _showSwapModal(slot, candidates) {
  const cur = slot === 'weapon' ? player.weapon : player.armor;
  const swapModal = document.getElementById('swap-modal');
  swapModal.dataset.slot = slot;

  // 現在装備
  const curEl = document.getElementById('swap-current');
  curEl.innerHTML = '';
  curEl.appendChild(_renderSwapRow(cur, null));

  // 候補
  const cEl = document.getElementById('swap-candidates');
  cEl.innerHTML = '';
  candidates.forEach(({ it, idx }) => {
    cEl.appendChild(_renderSwapRow(it, idx));
  });

  swapModal.classList.remove('hidden');
}

function _renderSwapRow(item, swapIdx) {
  const div = document.createElement('div');
  div.className = 'menu-row';
  const skillHtml = item.skill?.name
    ? `<div class="menu-row-skill">✨ ${item.skill.name}</div>` : '';
  const lvHtml = item.level ? `<span class="menu-row-lv">Lv${item.level}</span>` : '';
  div.innerHTML = `
    <div class="menu-row-emoji">${iconImg(item, 38)}</div>
    <div class="menu-row-info">
      <div class="menu-row-name" style="color:${item.rarityColor}">${item.name} ${lvHtml}</div>
      <div class="menu-row-stat">${_statLine(item)} / ${item.rarity}</div>
      ${skillHtml}
    </div>
    ${swapIdx !== null
      ? `<div class="menu-row-actions"><button class="menu-action-btn">これに装備</button></div>`
      : ''}
  `;
  if (swapIdx !== null) {
    div.querySelector('.menu-action-btn').addEventListener('click', () => {
      _equipFromInventory(swapIdx);
      document.getElementById('swap-modal').classList.add('hidden');
    });
  }
  return div;
}

document.getElementById('btn-swap-unequip').addEventListener('click', () => {
  const slot = document.getElementById('swap-modal').dataset.slot;
  if (player.inventory.length >= 8) {
    showAlert('持ち物が満杯のため外せません');
    return;
  }
  _unequipDirect(slot);
  document.getElementById('swap-modal').classList.add('hidden');
  refreshHUD();
  refreshMenu();
  autoSave();
});

document.getElementById('btn-swap-cancel').addEventListener('click', () => {
  playSfx('click');
  document.getElementById('swap-modal').classList.add('hidden');
});

function _renderInventoryRow(item, idx) {
  const div = document.createElement('div');
  div.className = 'menu-row';
  const skillHtml = item.skill?.name
    ? `<div class="menu-row-skill">✨ ${item.skill.name}</div>` : '';
  const isEquippable = item.type === 'weapon' || item.type === 'armor';
  const isUsableHere =
    (item.type === 'potion' || item.type === 'mpPotion'
      || item.type === 'mysteryScroll' || item.type === 'scroll')
    && screen === 'dungeon';
  const isLearnable = item.type === 'skillBook';   // 場所問わず学べる
  // 伝説の書はダンジョン外でだけ使える（読むと特殊ダンジョンへ突入するため、
  // 別ダンジョン内からは使わせない）
  const isTomeUsable = item.type === 'legendaryTome' && screen !== 'dungeon';
  // 宝箱はダンジョン内で「鍵を消費して開ける」アクションになる。
  // 鍵在庫が無い時はダイアログで案内する（ボタン自体は活性のまま）。
  const isChest = item.type === 'chest';
  // バーコードダンジョン入口: 伝説の書と同じ「ダンジョン外でだけ使える」運用。
  // 入ると消費され、もう一度欲しければ同じバーコードをスキャンし直す。
  const isPortalUsable = item.type === 'dungeonPortal' && screen !== 'dungeon';
  const hasMainAction = isEquippable || isUsableHere || isLearnable || isTomeUsable || isChest || isPortalUsable;
  const action =
    isEquippable                  ? 'equip'   :
    isLearnable                   ? 'learn'   :
    isTomeUsable                  ? 'tome'    :
    isPortalUsable                ? 'portal'  :
    isChest                       ? 'open'    :
    item.type === 'mysteryScroll' ? 'mystery' :
    item.type === 'scroll'        ? 'scroll'  :
    isUsableHere                  ? 'use'     : 'none';

  const lvHtml    = item.level ? `<span class="menu-row-lv">Lv${item.level}</span>` : '';
  const countHtml = (isStackable(item) && (item.count ?? 1) > 1)
    ? `<span class="menu-row-count">×${item.count}</span>` : '';
  div.innerHTML = `
    <button class="menu-row-main" data-action="${action}" ${hasMainAction ? '' : 'disabled'}>
      <div class="menu-row-emoji">${iconImg(item, 38)}</div>
      <div class="menu-row-info">
        <div class="menu-row-name" style="color:${item.rarityColor}">${item.name} ${lvHtml} ${countHtml}</div>
        <div class="menu-row-stat">${_statLine(item)} / ${item.rarity}</div>
        ${skillHtml}
      </div>
    </button>
    <div class="menu-row-actions">
      <button class="menu-action-btn move deposit" title="ストレージへ">→📦</button>
      <button class="menu-action-btn danger discard">廃棄</button>
    </div>
  `;
  if (hasMainAction) {
    div.querySelector('.menu-row-main').addEventListener('click', () => {
      if (action === 'equip') {
        showActionConfirm(`${item.name} を装備しますか？`, item, '装備する', () => {
          _equipFromInventory(idx);
        });
      } else if (action === 'use') {
        // 薬は HP/MP 満タン時にアラート（消費を防ぐ）。MP 薬は MP 側で判定
        if (item.type === 'potion' && player.hp >= player.maxHp) {
          showAlert('HPが満タンです'); return;
        }
        if (item.type === 'mpPotion' && (player.mp ?? 0) >= (player.maxMp ?? 0)) {
          showAlert('MPが満タンです'); return;
        }
        showActionConfirm(`${item.name} を使いますか？`, item, '使う', () => {
          _usePotionFromInventory(idx);
        });
      } else if (action === 'mystery') {
        showActionConfirm(`${item.name} を読みますか？\n${item.desc}`, item, '読む', () => {
          _useMysteryScrollFromInventory(idx);
        });
      } else if (action === 'scroll') {
        const stsLabel = item.status
          ? ` + ${{ burn:'熱傷', sleep:'睡魔', poison:'毒', shock:'感電', confuse:'錯乱' }[item.status.kind] ?? item.status.kind}${item.status.turns}T`
          : '';
        showActionConfirm(
          `${item.name} を読みますか？\n正面方向の最初に当たる敵に ${item.dmg} ダメージ${stsLabel}`,
          item, '読む',
          () => { _useScrollFromInventory(idx); },
        );
      } else if (action === 'learn') {
        showActionConfirm(`${item.name} を読んで「${item.skillName}」を習得しますか？\n${item.skillDesc}`, item, '習得する', () => {
          _learnSkillFromBook(idx);
        });
      } else if (action === 'tome') {
        showActionConfirm(`${item.name} を読んで試練ダンジョンへ向かいますか？\n（書は使うと消費されます）`, item, '挑む', () => {
          _useLegendaryTomeFromInventory(idx);
        });
      } else if (action === 'portal') {
        const floors = item.dungeonData?.floors ?? '?';
        showActionConfirm(
          `${item.name} に突入しますか？\n\n${item.rarity}・B${floors}F・${item.element ?? ''}属性\n（突入すると入口は消費されます）`,
          item, '突入する',
          () => { _useDungeonPortalFromInventory(idx); },
        );
      } else if (action === 'open') {
        _openChestFromInventory(idx);
      }
    });
  }
  div.querySelector('.discard').addEventListener('click', async () => {
    const ok = await showConfirm(`${item.name} を廃棄しますか？`, { danger: true, okLabel: '廃棄' });
    if (!ok) return;
    player.inventory.splice(idx, 1);
    playSfx('discard');
    refreshMenu();
    autoSave();
  });
  div.querySelector('.deposit').addEventListener('click', () => {
    _depositToStorage(idx);
  });
  return div;
}

// 汎用アクション確認モーダル
let _pendingConfirmAction = null;
function showActionConfirm(title, item, actionLabel, onConfirm) {
  document.getElementById('confirm-title').textContent = title;
  const skillHtml = item.skill?.name
    ? `<div class="menu-row-skill">✨ ${item.skill.name}: ${item.skill.desc ?? ''}</div>` : '';
  const lvHtml = item.level ? `<span class="menu-row-lv">Lv${item.level}</span>` : '';
  document.getElementById('confirm-detail').innerHTML = `
    <div class="menu-row" style="cursor:default">
      <div class="menu-row-main" style="background:transparent;cursor:default" disabled>
        <div class="menu-row-emoji">${iconImg(item, 38)}</div>
        <div class="menu-row-info">
          <div class="menu-row-name" style="color:${item.rarityColor}">${item.name} ${lvHtml}</div>
          <div class="menu-row-stat">${_statLine(item)} / ${item.rarity}</div>
          ${skillHtml}
        </div>
      </div>
    </div>
  `;
  document.getElementById('btn-confirm-ok').textContent = actionLabel;
  _pendingConfirmAction = onConfirm;
  document.getElementById('action-confirm-modal').classList.remove('hidden');
}

document.getElementById('btn-confirm-ok').addEventListener('click', () => {
  const fn = _pendingConfirmAction;
  _pendingConfirmAction = null;
  document.getElementById('action-confirm-modal').classList.add('hidden');
  if (fn) fn();
});
document.getElementById('btn-confirm-cancel').addEventListener('click', () => {
  _pendingConfirmAction = null;
  playSfx('click');
  document.getElementById('action-confirm-modal').classList.add('hidden');
});

// ─────────────────────────────────────────────
// 技の書 / 技発動
// ─────────────────────────────────────────────
function _learnSkillFromBook(idx) {
  const item = player.inventory[idx];
  if (!item || item.type !== 'skillBook') return;
  _ensurePlayerSkillFields();

  const skillSpec = findSkillById(item.skillId);
  if (!skillSpec) { showAlert('技データが見つかりませんでした'); return; }

  // 学習可能な対象を列挙（プレイヤー / 各ミニオン）
  const eligible = [];
  if (canLearnSkillForPlayer(skillSpec, player)) {
    const already = player.learnedSkills.find(s => s.id === skillSpec.id);
    eligible.push({
      kind: 'player',
      label: '自分（' + (findPlayerType(player.type)?.name ?? '未設定') + '）',
      emoji: findPlayerType(player.type)?.emoji ?? '🧙',
      already, level: player.level,
    });
  }
  for (const mi of (player.minions ?? [])) {
    _ensureMinionSkillFields(mi);
    if (!canLearnSkillForMinion(skillSpec, mi)) continue;
    const already = mi.learnedSkills.find(s => s.id === skillSpec.id);
    eligible.push({
      kind: 'minion', minion: mi,
      label: `${mi.name}（${mi.element}属性）`,
      emoji: mi.emoji,
      already, level: mi.level,
    });
  }

  if (eligible.length === 0) {
    const t = findPlayerType(player.type);
    const apt = t ? `${t.name}（${t.primary}・${t.secondary}）` : '未設定';
    showAlert(
      `この技（${skillSpec.element}属性）を覚えられる仲間がいません。\n\n` +
      `自分のタイプ: ${apt}\n` +
      `仲間: ${(player.minions ?? []).map(m => `${m.name}(${m.element})`).join(' / ') || 'なし'}\n\n` +
      `適性に合う属性のタイプ／仲間が必要です。`,
    );
    return;
  }

  // 候補を選ばせる（学習済みは disabled）
  _openLearnerPicker(skillSpec, idx, eligible);
}

function _openLearnerPicker(skillSpec, bookIdx, eligible) {
  const title = `📕 ${skillSpec.name} を誰に覚えさせる？`;
  const meta  = `${skillSpec.element} / ${skillSpec.pattern}型 / 威力×${skillSpec.dmgMult} / MP-${skillSpec.mpCost} / ${skillSpec.rarity}`;
  const list = eligible.map((e, i) => {
    const lvReq = skillLevelReq(skillSpec);
    const lvOk  = e.level >= lvReq;
    const dis = e.already ? ' locked' : '';
    return `<div class="skill-pick-row${dis}" data-idx="${i}">
      <span class="sp-emoji">${e.emoji}</span>
      <div>
        <div class="sp-name">${e.label}</div>
        <div class="sp-meta">${e.already ? '既に習得済み' : (lvOk ? '習得可能' : `習得は可・装備は Lv${lvReq} で解放`)}</div>
      </div>
    </div>`;
  }).join('');

  // skill-pick-modal を流用
  const modal = document.getElementById('skill-pick-modal');
  document.getElementById('skill-pick-title').textContent = title;
  document.getElementById('skill-pick-meta').textContent  = meta;
  const listEl = document.getElementById('skill-pick-list');
  listEl.innerHTML = list;
  listEl.querySelectorAll('.skill-pick-row:not(.locked)').forEach(row => {
    row.addEventListener('click', () => {
      const i = parseInt(row.dataset.idx, 10);
      const e = eligible[i];
      modal.classList.add('hidden');
      _commitLearn(skillSpec, bookIdx, e);
    });
  });
  modal.classList.remove('hidden');
}

function _commitLearn(skillSpec, bookIdx, target) {
  const lvReq = skillLevelReq(skillSpec);
  if (target.kind === 'player') {
    _ensurePlayerSkillFields();
    player.learnedSkills.push({ ...skillSpec });
    const emptyIdx = player.skillSlots.findIndex(s => !s);
    if (emptyIdx >= 0 && player.level >= lvReq) {
      player.skillSlots[emptyIdx] = { ...skillSpec };
    }
    takeOneFromInventory(bookIdx);
    playSfx('levelup');
    showAlert(`✨ あなたは ${skillSpec.name} を習得した！${emptyIdx >= 0 && player.level >= lvReq
      ? '\n\nスロットに自動セットしました' : ''}`);
  } else {
    const mi = target.minion;
    _ensureMinionSkillFields(mi);
    mi.learnedSkills.push({ ...skillSpec });
    const emptyIdx = mi.skillSlots.findIndex(s => !s);
    if (emptyIdx >= 0 && mi.level >= lvReq) {
      mi.skillSlots[emptyIdx] = { ...skillSpec };
    }
    takeOneFromInventory(bookIdx);
    playSfx('levelup');
    showAlert(`🌸 ${mi.name} は ${skillSpec.name} を習得した！${emptyIdx >= 0 && mi.level >= lvReq
      ? '\n\nスロットに自動セットしました' : ''}`);
  }
  refreshMenu();
  autoSave();
}

// 向き [fx, fy] に応じてオフセット [a, b] をグリッド方向で写像。
// 元のオフセットは「forward=[0,1] (下) / left=[1,0]」基準で書かれている前提。
// 旧実装は cos/sin の回転行列だったが、これは Euclidean 距離を保存するため
// 斜め向き [1,1]（magnitude √2）では LINE3 の [0,3] が [2,2] までしか伸びず、
// VFX と命中マスがズレる原因になっていた。
// 新実装は forward 軸を facing ベクトルそのまま、left 軸をその CW 90° 回転に
// したアフィン変換にし、グリッドの斜め方向でも N マス先 = facing×N を保証する。
function _rotateOffsetByFacing([a, b], [fx, fy]) {
  // forward = (fx, fy) / left = (fy, -fx)
  // → (a, b) = a * left + b * forward = (b*fx + a*fy, b*fy - a*fx)
  return [b * fx + a * fy, b * fy - a * fx];
}

// 範囲タイプの offsets を向きに合わせて回転する。RANGE_TYPES[id].rotatable が
// false（ADJ / CROSS / DIAG / TERRAIN_5X5 等の放射状）の場合は回転しない。
function _facingRotatedOffsets(rangeId, facing) {
  const r = RANGE_TYPES[rangeId];
  if (!r || r.kind !== 'offsets') return [];
  const base = r.offsets ?? [];
  if (!r.rotatable) return base;
  if (!facing || (facing[0] === 0 && facing[1] === 0)) return base;
  // 重複除去
  const seen = new Set();
  const out  = [];
  for (const off of base) {
    const rot = _rotateOffsetByFacing(off, facing);
    const k = `${rot[0]},${rot[1]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(rot);
  }
  return out;
}

// 直線系（LINE_INF / PIERCE）のターゲット解決。向き方向に最大 maxRange マスまで
// 走査し、壁で止まる。PIERCE は敵を貫通するが LINE_INF は敵には止まらず通過する
// （ただし「壁で停止」は両方共通）。
function _resolveLineSkillCells(rangeId, facing, px, py) {
  const r = RANGE_TYPES[rangeId];
  if (!r) return [];
  const max = r.maxRange ?? 12;
  // 基準下向き [0,1] を facing 方向に回す
  const [fx, fy] = _rotateOffsetByFacing([0, 1], facing);
  if (fx === 0 && fy === 0) return [];
  const cells = [];
  for (let i = 1; i <= max; i++) {
    const dx = fx * i;
    const dy = fy * i;
    if (!dungeon.canWalk(px + dx, py + dy)) break;
    cells.push([dx, dy]);
  }
  return cells;
}

// 技ごとの「すかし（whiff）」確率。レアリティが上がるほど安定して当たる。
// 技は MP コストさえあればいつでも撃てる仕様にしたので、命中率の揺らぎで
// バランスを取る（コモン技は手数で稼ぎ、レジェンド技は確実な大火力）。
const _WHIFF_CHANCE = {
  'コモン':     0.28,
  'レア':       0.20,
  'エピック':   0.12,
  'レジェンド': 0.06,
};

// MP 不足時のクイック回復: consumables 内の MP ポーションから「最も必要量を満たす
// 小さいもの」を選んで使用する。完全に不足を満たせないなら最大の 1 本を使う。
// 戻り値: true = 1 本消費して MP 回復した（呼び出し側は再度チェック）/ false = 何もしなかった。
async function _tryQuickMpRecover(mpNeeded) {
  if (!Array.isArray(player.consumables)) return false;
  const mps = player.consumables
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it?.type === 'mpPotion');
  if (mps.length === 0) return false;
  // 「不足ぶんを満たす最小」を選ぶ。満たすものが無ければ heal 最大を選ぶ。
  const have = player.mp ?? 0;
  const lack = Math.max(1, mpNeeded - have);
  const sufficient = mps
    .filter(({ it }) => (it.mpHeal ?? 0) >= lack)
    .sort((a, b) => (a.it.mpHeal ?? 0) - (b.it.mpHeal ?? 0));
  const chosen = sufficient[0] ?? mps.sort((a, b) => (b.it.mpHeal ?? 0) - (a.it.mpHeal ?? 0))[0];
  if (!chosen) return false;
  const total = mps.reduce((s, { it }) => s + (it.count ?? 1), 0);
  const ok = await showConfirm(
    `MP が足りません（必要 ${mpNeeded} / 現在 ${have}）。\n\n` +
    `「${chosen.it.name}」（MP +${chosen.it.mpHeal}）を使って回復しますか？\n` +
    `（所持 MP 回復薬 計 ${total} 本）`,
    { okLabel: '使う', cancelLabel: 'やめる' },
  );
  if (!ok) return false;
  // takeOneFromConsumables は count 1 にした個体を返す。 splice/減算は内部で実施
  const used = takeOneFromConsumables(chosen.i);
  if (!used) return false;
  player.mp = (player.mp ?? 0) + (used.mpHeal ?? 0);
  dungeonLog(`🔵 ${used.name} 使用！ MPが${used.mpHeal}回復した`);
  playSfx('heal');
  refreshHUD();
  return true;
}

// 向き ベクトルを「ひがし／にし／きた／みなみ／北西…」風の人間向けラベルに。
// 8 方向 + 自分（[0,0]）に対応。確認モーダルで「どっちに撃つか」を分かりやすく。
function _facingName([fx, fy]) {
  if (fx === 0 && fy === 0) return '自分';
  const ns = fy < 0 ? '北' : fy > 0 ? '南' : '';
  const ew = fx < 0 ? '西' : fx > 0 ? '東' : '';
  return ns + ew;
}

// 広範囲・遠距離技を撃つ前の「どこを攻撃しますか？」確認モーダル。
// 戻り値: true = 続行（MP 消費して発動）/ false = キャンセル（無消費で何もしない）
// 範囲種別ごとに対象スコープと命中見込み数を計算して人間向けの文面にする。
async function _confirmBigSkillTarget(skill, rangeId, r) {
  if (!r) return true;
  const needsConfirm = ['room','room_all','floor','floor_all','line_inf','pierce','ranged','around_target'].includes(r.kind);
  if (!needsConfirm) return true;

  const facing = dungeon.playerPos.facing ?? [0, 1];
  const px = dungeon.playerPos.x;
  const py = dungeon.playerPos.y;

  let scope = '';
  let hitCount = 0;
  switch (r.kind) {
    case 'room':
    case 'room_all': {
      const room = dungeon.roomAt?.(px, py);
      if (room) {
        const inRoom = (dungeon.monstersInRoom?.(room) ?? []).filter(m => m.hp > 0 && !m.isShopkeeper);
        hitCount = inRoom.length;
        scope = `今いる部屋全体（${room.w}×${room.h}）`;
      } else {
        scope = '通路（部屋に入っていないため不発）';
      }
      break;
    }
    case 'floor':
    case 'floor_all': {
      const all = (dungeon.allLivingMonsters?.() ?? []).filter(m => !m.isShopkeeper);
      hitCount = all.length;
      scope = 'フロア全体';
      break;
    }
    case 'line_inf':
    case 'pierce': {
      const cells = _resolveLineSkillCells(rangeId, facing, px, py);
      hitCount = cells.filter(([dx, dy]) => dungeon.monsterAt(px + dx, py + dy)).length;
      scope = `${_facingName(facing)}方向に最大 ${cells.length} マス`;
      break;
    }
    case 'ranged': {
      const dist = r.distance ?? 3;
      const [fx, fy] = _rotateOffsetByFacing([0, 1], facing);
      hitCount = dungeon.monsterAt(px + fx * dist, py + fy * dist) ? 1 : 0;
      scope = `${_facingName(facing)}方向 ${dist} マス先の 1 点`;
      break;
    }
    case 'around_target': {
      const max = r.maxRange ?? 5;
      const [fx, fy] = _rotateOffsetByFacing([0, 1], facing);
      let anchor = null;
      for (let i = 1; i <= max; i++) {
        const ax = px + fx * i, ay = py + fy * i;
        if (!dungeon.canWalk(ax, ay)) break;
        const mob = dungeon.monsterAt(ax, ay);
        if (mob) { anchor = { x: ax, y: ay }; break; }
      }
      if (anchor) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dungeon.monsterAt(anchor.x + dx, anchor.y + dy)) hitCount += 1;
          }
        }
        scope = `${_facingName(facing)}方向最寄り敵 + 周囲 8 マス`;
      } else {
        scope = `${_facingName(facing)}方向に対象敵なし（不発）`;
      }
      break;
    }
  }

  const elBadge = SKILL_ELEMENT_EMOJI[skill.element] ?? '✨';
  const burnExtra = hasStatus(player, 'burn') ? 1 : 0;
  const mpDisplay = skill.mpCost + (burnExtra ? ` (+${burnExtra} 熱傷)` : '');
  const msg =
    `どこを攻撃しますか？\n\n` +
    `${elBadge} 技「${skill.name}」\n` +
    `対象: ${scope}\n` +
    `対象敵数: ${hitCount} 体${hitCount === 0 ? '（空振りに注意）' : ''}\n` +
    `MP -${mpDisplay}`;
  return await showConfirm(msg, { okLabel: '撃つ', cancelLabel: 'やめる' });
}

// 技を発動（ダンジョン探索中。向きに合わせてパターンを回転して発射）
async function _executeSkill(skill) {
  if (!dungeon || screen !== 'dungeon') {
    showAlert('技はダンジョン探索中にだけ使えます');
    return;
  }
  // PvP アリーナ: 自分のターンじゃなければ技も封じる
  if (dungeonData?.isPvpArena && _pvpData?.turn !== _pvpRole) return;
  // タイプ変更後に旧タイプの技を発動しようとしてもブロックする。
  // セーブの整合性が崩れている場合に備えた多重防御（slot 側でも purge 済み）。
  if (!_skillElementInAptitude(skill)) {
    const t = findPlayerType(player.type);
    const aptLabel = t ? `${t.primary}・${t.secondary}` : 'コモン';
    showAlert(`「${skill.name}」は今のタイプ（適性: ${aptLabel}）では発動できません。タイプ変更前の技です。`);
    return;
  }
  // 状態異常で技使用が制限される: sleep=封じ / shock=確率封じ / burn=MP+1
  if (hasStatus(player, 'sleep')) {
    dungeonLog('😴 睡眠中で技を使えない！'); _runEnemyTurn(); return;
  }
  if (Math.random() < shockSkipChance(player)) {
    dungeonLog('⚡ 感電して技を発動できなかった！'); _runEnemyTurn(); return;
  }
  const burnExtra = hasStatus(player, 'burn') ? 1 : 0;
  const mpNeeded  = skill.mpCost + burnExtra;
  if ((player.mp ?? 0) < mpNeeded) {
    // MP 切れの時は持っている MP 回復薬から自動で 1 本使えるか提案する。
    // 使ったら今のターンを消費せずに技発動の再判定へ進む（ターン外行動扱い）。
    const recovered = await _tryQuickMpRecover(mpNeeded);
    if (!recovered) {
      showAlert(`MP が足りません（必要 ${mpNeeded}${burnExtra ? ' / 熱傷で+1' : ''}）\nMP 回復薬を持っていません。`);
      return;
    }
    // 再チェック: それでも足りないなら諦め
    if ((player.mp ?? 0) < mpNeeded) {
      showAlert(`MP がまだ足りません（必要 ${mpNeeded} / 現在 ${player.mp}）`);
      return;
    }
  }
  // 範囲タイプを正規化（旧 A〜F のセーブからもこの段で新名称になる）
  const rangeId = normalizeRangeType(skill.pattern);
  const r       = RANGE_TYPES[rangeId];

  // 広範囲・遠距離・部屋/フロア技は誤発射のコストが大きい（MP 高め＋ターン消費）。
  // 発射前に「どこを攻撃しますか？」モーダルで対象範囲と命中見込み数を見せて確認。
  // 小さな範囲（ADJ / CROSS / DIAG / MELEE / LINE3 / LINE5 / TERRAIN）は確認しない。
  if (!(await _confirmBigSkillTarget(skill, rangeId, r))) {
    // キャンセル: MP 消費もターン経過も無し（移動と等価で気軽にキャンセルできる）
    return;
  }

  player.mp = Math.max(0, (player.mp ?? 0) - mpNeeded);
  // 骨折で行動時に自傷判定
  _maybeFractureSelfHurt();

  const facing = dungeon.playerPos.facing ?? [0, 1];
  const px = dungeon.playerPos.x;
  const py = dungeon.playerPos.y;
  const hits   = [];
  const misses = [];   // すかした敵: { m, dx, dy }
  // 痙攣で命中率が下がるので whiff が増える
  const baseWhiff = _WHIFF_CHANCE[skill.rarity] ?? 0.20;
  const whiffP    = Math.min(0.85, baseWhiff / accuracyMultiplier(player));

  // 対象敵を {m, dx, dy} の形で集める（dx, dy はプレイヤー基準のオフセット）。
  // 範囲タイプの kind ごとに走査方法を変える:
  //   self           - 自分自身（バフ系。命中対象は無し。VFX のみ）
  //   offsets        - 静的オフセット（ADJ / CROSS / DIAG / LINE3 等）
  //   line_inf       - 向き方向に壁まで（LINE_INF）
  //   pierce         - 向き方向に壁まで（敵貫通。LINE_INF と同じ走査だが効果が違う）
  //   ranged         - 向き方向 distance マス先の 1 点
  //   room           - 同じ部屋の敵全員
  //   room_all       - 同じ部屋（味方含む）。Phase 2 では敵だけ選ぶ実装
  //   floor          - フロア全敵
  //   floor_all      - フロア全員（味方含む）。Phase 2 では敵だけ選ぶ実装
  //   around_target  - 正面方向最寄り敵 + 周囲 8 マス
  //   trap           - 足元に罠設置（Phase 2 では未実装メッセージ）
  let targets = [];   // { m, dx, dy } の配列
  switch (r?.kind) {
    case 'self': {
      // バフ・回復・召喚等の支援系。skill.selfBuff があれば対応する status を
      // applyStatus 経由でプレイヤーに付与し、refreshHUD で player.atk/def に
      // 即時反映させる。selfBuff が無い SELF 技は VFX のみ（旧仕様互換）。
      const elColor = SKILL_ELEMENT_COLOR[skill.element] ?? '#b070dd';
      hitFlash({ color: _alphaize(elColor, 0.35) });
      magicCircle(playerVfxAnchor(), skill.element);
      const canvas = document.getElementById('dungeon-canvas');
      if (canvas) {
        const cRect = canvas.getBoundingClientRect();
        const ts    = canvas.width / 11;
        const half  = 5;
        const playerScreen = {
          x: cRect.left + (half * ts + ts / 2),
          y: cRect.top  + (half * ts + ts / 2),
        };
        showSkillPatternVfx(rangeId, playerScreen, ts, elColor, { facing });
      }
      let buffMsg = '';
      if (skill.selfBuff?.kind && STATUS_DEFS[skill.selfBuff.kind]?.isBuff) {
        const turns = skill.selfBuff.turns ?? 5;
        applyStatus(player, skill.selfBuff.kind, { turns, stacks: 1 });
        const def = STATUS_DEFS[skill.selfBuff.kind];
        buffMsg = `／ ${def.emoji} ${def.label}（${turns}T）`;
      }
      dungeonLog(`✨ 技「${skill.name}」を発動！（${skill.desc}）${buffMsg}／ MP -${skill.mpCost}`, { rarity: skill.rarity });
      playSfx('crit');
      refreshHUD();   // ここで player.atk/def がバフ込みに再計算される
      // PvP: 自己バフ + MP 消費 + ターン交代をまとめて Firestore に流す
      if (dungeonData?.isPvpArena) {
        _pvpSendSelfBuff();
        autoSave();
        return;
      }
      _runEnemyTurn();
      autoSave();
      return;
    }
    case 'offsets': {
      const offsets = _facingRotatedOffsets(rangeId, facing);
      for (const [dx, dy] of offsets) {
        const mob = dungeon.monsterAt(px + dx, py + dy);
        if (mob) targets.push({ m: mob, dx, dy });
      }
      break;
    }
    case 'line_inf':
    case 'pierce': {
      const cells = _resolveLineSkillCells(rangeId, facing, px, py);
      for (const [dx, dy] of cells) {
        const mob = dungeon.monsterAt(px + dx, py + dy);
        if (!mob) continue;
        targets.push({ m: mob, dx, dy });
        // LINE_INF は敵を通過、PIERCE は敵で止まる仕様にしてもよいが、
        // 設計書の意図は「LINE_INF=壁まで貫通、PIERCE=敵貫通（壁で停止）」で
        // どちらも複数体当たる。差は VFX とフレーバーで表現するに留める。
      }
      break;
    }
    case 'ranged': {
      const dist = r.distance ?? 3;
      const [fx, fy] = _rotateOffsetByFacing([0, 1], facing);
      const dx = fx * dist;
      const dy = fy * dist;
      const mob = dungeon.monsterAt(px + dx, py + dy);
      if (mob) targets.push({ m: mob, dx, dy });
      break;
    }
    case 'room':
    case 'room_all': {
      const room = dungeon.roomAt?.(px, py);
      if (room) {
        for (const m of dungeon.monsters) {
          if (m.hp <= 0) continue;
          if (m.isShopkeeper) continue;
          if (m.x >= room.x && m.x < room.x + room.w &&
              m.y >= room.y && m.y < room.y + room.h) {
            targets.push({ m, dx: m.x - px, dy: m.y - py });
          }
        }
      }
      break;
    }
    case 'floor':
    case 'floor_all': {
      for (const m of dungeon.monsters) {
        if (m.hp <= 0) continue;
        if (m.isShopkeeper) continue;
        targets.push({ m, dx: m.x - px, dy: m.y - py });
      }
      break;
    }
    case 'around_target': {
      // 正面方向に maxRange マス走査して最寄り敵を起点に。見つからなければ空振り。
      const max = r.maxRange ?? 5;
      const [fx, fy] = _rotateOffsetByFacing([0, 1], facing);
      let anchor = null;
      for (let i = 1; i <= max; i++) {
        const ax = px + fx * i;
        const ay = py + fy * i;
        if (!dungeon.canWalk(ax, ay)) break;
        const mob = dungeon.monsterAt(ax, ay);
        if (mob) { anchor = { x: ax, y: ay, mob }; break; }
      }
      if (anchor) {
        // anchor とその 8 近傍を対象に
        for (let dy0 = -1; dy0 <= 1; dy0++) {
          for (let dx0 = -1; dx0 <= 1; dx0++) {
            const tx = anchor.x + dx0;
            const ty = anchor.y + dy0;
            const mob = dungeon.monsterAt(tx, ty);
            if (!mob) continue;
            targets.push({ m: mob, dx: tx - px, dy: ty - py });
          }
        }
      }
      break;
    }
    case 'trap': {
      // Phase 2 では未実装。MP は消費しているのでログだけ出す。
      dungeonLog(`🪤 ${skill.name}: 罠設置はまだ実装されていません（MP -${skill.mpCost}）`);
      refreshHUD();
      _runEnemyTurn();
      autoSave();
      return;
    }
    default: {
      // 想定外: ログだけ出す
      dungeonLog(`⚠ 未対応の範囲タイプ: ${rangeId}（MP -${skill.mpCost}）`);
      refreshHUD();
      _runEnemyTurn();
      autoSave();
      return;
    }
  }

  // 協力モード: 仲間プレイヤー (isPvpOpponent) は技の対象から外す。
  // 上のループで targets[] に含まれていた場合だけ filter で取り除く。
  if (dungeonData?.isPvpArena && _pvpData?.mode === 'coop') {
    targets = targets.filter(t => !t.m?.isPvpOpponent);
  }

  for (const t of targets) {
    if (Math.random() < whiffP) {
      // すかし: ダメージは入らないが、技自体は発動済み（MP は消費したまま）。
      misses.push(t);
      continue;
    }
    const matchup = elementMatchup(skill.element, t.m.element);
    const base = Math.max(1, Math.floor(player.atk * skill.dmgMult) - t.m.def);
    const dmg  = Math.max(1, Math.floor((base + Math.floor(Math.random() * Math.max(1, base * 0.4)))
      * matchup));
    t.m.hp = Math.max(0, t.m.hp - dmg);
    hits.push({ m: t.m, dmg, matchup, dx: t.dx, dy: t.dy });
  }

  // 状態異常付与: 命中した生存中の敵に status を上書き。
  // 旧 stun / seal は m.status（単一）に、新 7 種類は m.statuses[] に乗せる。
  // すかした敵には付かない。
  if (skill.status && hits.length > 0) {
    const isLegacy = skill.status.kind === 'stun' || skill.status.kind === 'seal';
    for (const h of hits) {
      if (h.m.hp <= 0) continue;
      if (isLegacy) {
        const cur = h.m.status;
        if (cur && cur.kind === skill.status.kind) {
          cur.turns = Math.max(cur.turns, skill.status.turns);
        } else {
          h.m.status = { kind: skill.status.kind, turns: skill.status.turns };
        }
      } else {
        applyStatus(h.m, skill.status.kind, {
          turns:  skill.status.turns,
          stacks: skill.status.stacks ?? 1,
        });
      }
    }
  }

  // 吹き飛ばし（knockback）: 命中した（生存中の）敵を、プレイヤーから見て外側に
  // skill.knockback マス押し出す。壁・他の敵・盤外で詰まったらそこで止まる。
  // 死んだ敵は処理しない（死亡演出は元位置で出した方が分かりやすい）。
  if (skill.knockback && skill.knockback > 0) {
    for (const h of hits) {
      if (h.m.hp <= 0) continue;
      const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
      const kx = sgn(h.dx);
      const ky = sgn(h.dy);
      if (kx === 0 && ky === 0) continue;   // 真上重なりは押し出し不能
      let nx = h.m.x;
      let ny = h.m.y;
      for (let step = 0; step < skill.knockback; step++) {
        const tx = nx + kx;
        const ty = ny + ky;
        if (!dungeon.canWalk(tx, ty)) break;
        if (dungeon.monsterAt(tx, ty)) break;
        nx = tx;
        ny = ty;
      }
      h.m.x = nx;
      h.m.y = ny;
    }
  }

  // ログは「命中数 / すかし数」を併記。0 命中 0 すかしなら「敵がいなかった」表示。
  let logMsg;
  if (hits.length === 0 && misses.length === 0) {
    logMsg = `${SKILL_ELEMENT_EMOJI[skill.element] ?? '✨'} 技「${skill.name}」を放ったが範囲に敵はいなかった（MP -${skill.mpCost}）`;
  } else if (hits.length === 0 && misses.length > 0) {
    logMsg = `${SKILL_ELEMENT_EMOJI[skill.element] ?? '✨'} 技「${skill.name}」全弾すかし！${misses.length} 体に当たり損ね（MP -${skill.mpCost}）`;
  } else if (misses.length > 0) {
    logMsg = `${SKILL_ELEMENT_EMOJI[skill.element] ?? '✨'} 技「${skill.name}」発動！ ${hits.length} 体命中 / ${misses.length} 体すかし（MP -${skill.mpCost}）`;
  } else {
    logMsg = `${SKILL_ELEMENT_EMOJI[skill.element] ?? '✨'} 技「${skill.name}」発動！ ${hits.length} 体に命中（MP -${skill.mpCost}）`;
  }
  if (skill.status && hits.length > 0) {
    const statusLabel = skill.status.kind === 'stun' ? '気絶' : '攻撃封印';
    logMsg += ` / ${statusLabel} ${skill.status.turns} ターン`;
  }
  dungeonLog(logMsg);
  playSfx('crit');

  // 範囲技 VFX: 技の属性カラー + 技パターン別の特殊エフェクト
  //   A 型 = 十字スラッシュ / B 型 = 周囲を薙ぐ円 / C 型 = 4 方向ビーム / D 型 = 大 AoE
  const elColor = SKILL_ELEMENT_COLOR[skill.element] ?? '#b070dd';
  const elColorAlpha = _alphaize(elColor, 0.45);
  hitFlash({ color: elColorAlpha });
  screenShake(Math.min(14, 6 + hits.length * 2), 350);
  magicCircle(playerVfxAnchor(), skill.element);

  // 攻撃者（プレイヤー）に技種別バッジと発光テレグラフを出して、
  // 「誰が・何の技を・これから撃つか」を視覚化する。ダメージ着弾は
  // この余韻のあとに setTimeout でずらす（preDelay）。
  const playerAnchor = playerVfxAnchor();
  if (playerAnchor) {
    showAttackTelegraph(playerAnchor, elColor, 380);
    showSkillBadge(playerAnchor, SKILL_ELEMENT_EMOJI[skill.element] ?? '✨', elColor, 700);
  }
  // 戦闘速度設定があればその preFlashMs を使い、無ければ最低 240ms 待たせる。
  const preDelay = Math.max(240, combatPreFlashMs() | 0);

  const canvas = document.getElementById('dungeon-canvas');
  const cRect  = canvas.getBoundingClientRect();
  const ts     = canvas.width / 11;
  const half   = 5;

  // プレイヤー中心の画面座標（半マスずれているので half * ts + ts/2 = canvas 中央）
  const playerScreen = {
    x: cRect.left + (half * ts + ts / 2),
    y: cRect.top  + (half * ts + ts / 2),
  };
  // 範囲タイプに応じた特殊演出（円・十字・ビーム・AoE リング）。
  // pattern VFX はバッジと同じタイミングで出すので preDelay は加味しない。
  showSkillPatternVfx(rangeId, playerScreen, ts, elColor, { facing });

  hits.forEach((h, i) => {
    setTimeout(() => {
      // 爆発・ダメ表示は「命中時点の座標」で出す。knockback で m.x が動いた後に
      // h.m.x を使うと吹き飛ばし先で爆発する不自然演出になるため、保存した dx/dy を使う
      const tx = h.dx + half;
      const ty = h.dy + half;
      const sx = cRect.left + tx * ts + ts / 2;
      const sy = cRect.top  + ty * ts + ts / 2;
      const anchor = { left: sx - 18, top: sy - 18, width: 36, height: 36 };
      explosion(anchor, { color: elColor });
      const kind = h.matchup >= 1.5 ? 'crit' : h.matchup <= 0.7 ? 'weak' : 'effective';
      showDamageAt({ left: sx, top: sy - 18, width: 0, height: 0 }, h.dmg, { kind });
      if (h.m.hp <= 0) deathBurst(anchor, { color: h.m.rarityColor ?? '#ff7043' });
    }, preDelay + i * 70);
  });

  // すかしマスにも MISS をフロート（命中演出と同じタイミング系列上に並べる）
  misses.forEach((mi, i) => {
    setTimeout(() => {
      const tx = mi.dx + half;
      const ty = mi.dy + half;
      const sx = cRect.left + tx * ts + ts / 2;
      const sy = cRect.top  + ty * ts + ts / 2;
      showMissAt({ left: sx, top: sy - 14, width: 0, height: 0 });
    }, preDelay + (hits.length + i) * 70);
  });

  // 死亡した敵を一括処理（XP・ゴールド・ドロップ）
  const dead = dungeon.monsters.filter(m => m.hp <= 0);
  for (const m of dead) {
    _maybeRecruitMinion(m);
    dungeon.removeMonster(m);
    gainXp(_xpFromMonster(m));
    const gold = rollGoldDropFromMonster(m);
    if (gold > 0) {
      _placeFloorDrop(makeGoldFloorItem(gold), m.x, m.y);
      dungeonLog(`🪙 ${m.name} は ${gold} ゴールドを落とした`);
    }
    const matDrop = _rollMaterialDrop(m);
    if (matDrop) _autoCollectDrop(matDrop);
    const keyDrop = _rollKeyDrop(m);
    if (keyDrop) _autoCollectDrop(keyDrop);
    const drop = _rollMonsterDrop(m);
    if (drop) {
      _placeFloorDrop(drop, m.x, m.y);
      dungeonLog(`💎 ${m.name} は ${drop.name} を落とした！`, { rarity: drop.rarity });
    }
  }

  refreshHUD();
  dungeon.render(document.getElementById('dungeon-canvas'));
  // 行動後の敵ターン（PvP では Firestore に技ダメージを送って相手にターンを渡す）
  if (dungeonData?.isPvpArena) {
    // hits 配列から相手プレイヤーへの最終 HP を抜き出して送る
    const opp = (dungeon.monsters ?? []).find(m => m?.isPvpOpponent);
    const totalDmg = hits.reduce((s, h) => s + (h.dmg ?? 0), 0);
    const hpAfter  = opp ? Math.max(0, opp.hp) : 0;
    _pvpSendSkillAction({
      skillName: skill.name,
      element:   skill.element,
      totalDmg,
      hpAfter,
      attackerMpAfter: player.mp,
    });
    autoSave();
    return;
  }
  _runEnemyTurn();
  autoSave();
}

// ─────────────────────────────────────────────
// 合成（武器強化 + レジェンド融合）
// ─────────────────────────────────────────────
//   インベントリ + ストレージから武器を一覧表示し、対応する素材を持っていれば
//   強化ボタンが押せる。確定で素材消費 + 武器置換。
//   同名レジェンド武器 2 個 を持っているとレジェンド融合のレシピもサジェスト。

function _countMaterial(name) {
  let n = 0;
  // 新仕様: 素材は player.materials に貯まる。
  // 旧セーブ互換のため inventory / storage に残った素材も合算してカウントする。
  for (const arr of [player.materials, player.inventory, player.storage]) {
    for (const it of arr ?? []) {
      if (it?.type === 'material' && it.name === name) n += (it.count ?? 1);
    }
  }
  return n;
}

// 指定名の素材を N 個消費（素材ボックス → 持ち物 → ストレージの順）
function _consumeMaterial(name, count) {
  let need = count;
  for (const arr of [player.materials, player.inventory, player.storage]) {
    if (!Array.isArray(arr)) continue;
    if (need <= 0) break;
    for (let i = arr.length - 1; i >= 0 && need > 0; i--) {
      const it = arr[i];
      if (it?.type !== 'material' || it.name !== name) continue;
      const take = Math.min(it.count ?? 1, need);
      it.count = (it.count ?? 1) - take;
      need -= take;
      if ((it.count ?? 0) <= 0) arr.splice(i, 1);
    }
  }
  return need === 0;
}

// 全武器列挙（インベントリ＋ストレージ＋装備中）。idxRef は { src: 'inv'|'sto'|'eq', idx }
function _allWeaponsForCraft() {
  const out = [];
  if (player.weapon) out.push({ item: player.weapon, ref: { src: 'eq', idx: -1 } });
  (player.inventory ?? []).forEach((it, idx) => {
    if (it?.type === 'weapon') out.push({ item: it, ref: { src: 'inv', idx } });
  });
  (player.storage ?? []).forEach((it, idx) => {
    if (it?.type === 'weapon') out.push({ item: it, ref: { src: 'sto', idx } });
  });
  return out;
}

function _replaceWeaponAt(ref, newWeapon) {
  if (ref.src === 'eq') {
    player.weapon = newWeapon;
    player.atk    = player.atkBase + newWeapon.atkBonus;
  } else if (ref.src === 'inv') {
    player.inventory[ref.idx] = newWeapon;
  } else {
    player.storage[ref.idx] = newWeapon;
  }
}
function _removeWeaponAt(ref) {
  if (ref.src === 'eq') {
    player.weapon = null;
    player.atk    = player.atkBase;
  } else if (ref.src === 'inv') {
    player.inventory.splice(ref.idx, 1);
  } else {
    player.storage.splice(ref.idx, 1);
  }
}

function _refreshSynthesisUI() {
  const grid = document.getElementById('synthesis-list');
  if (!grid) return;
  // 仕様: ダンジョン探索中は合成不可（街の鍛冶屋に戻ってから、というイメージ）。
  // ロックアウト時は説明だけ出して全ボタンを非活性に。
  if (screen === 'dungeon') {
    grid.innerHTML =
      '<div class="menu-empty" style="line-height:1.6">' +
      '🛠 ダンジョン内では合成できません<br>' +
      '<span style="font-size:11px;color:#888">マップ画面に戻ってから素材ボックスの素材を使って強化・融合できます</span>' +
      '</div>';
    document.getElementById('synthesis-fuse').classList.add('hidden');
    return;
  }
  const weapons = _allWeaponsForCraft();
  if (weapons.length === 0) {
    grid.innerHTML = '<div class="menu-empty">武器を持っていません</div>';
    document.getElementById('synthesis-fuse').classList.add('hidden');
    return;
  }

  grid.innerHTML = '';
  for (const { item, ref } of weapons) {
    const recipe = ENHANCE_RECIPES[item.rarity];
    const matCount = recipe ? _countMaterial(recipe.matName) : 0;
    const canDo    = recipe && matCount >= recipe.matCount;
    // 必要素材を絵文字付き＋所持/必要の比較で色分け表示。
    // 「鉄片 ⛓️ 1/2」のように赤(不足)/緑(達成)で視認性を上げる。
    let requirementHtml;
    if (!recipe) {
      requirementHtml = '<span style="color:#888">🛠 このレア度の武器には強化レシピがありません</span>';
    } else {
      const matInfo  = MATERIALS.find(m => m.name === recipe.matName);
      const matEmoji = matInfo?.emoji ?? '🧰';
      const colorOk  = matCount >= recipe.matCount ? '#4caf50' : '#ff5252';
      requirementHtml =
        `<span class="synth-mat" style="color:${colorOk}">${matEmoji} ${recipe.matName} ` +
        `<b>${matCount}/${recipe.matCount}</b></span>` +
        ` <span style="color:#aaa">→ ATK×${recipe.mult.toFixed(2)}</span>`;
    }

    const div = document.createElement('div');
    div.className = 'menu-row';
    const where = ref.src === 'eq' ? '【装備中】' : ref.src === 'inv' ? '【持ち物】' : '【ストレージ】';
    div.innerHTML = `
      <div class="menu-row-emoji">${iconImg(item, 38)}</div>
      <div class="menu-row-info">
        <div class="menu-row-name" style="color:${item.rarityColor}">${item.name} <span class="menu-row-lv">${where}</span></div>
        <div class="menu-row-stat">ATK +${item.atkBonus} / ${item.rarity}</div>
        <div class="menu-row-skill">🛠 ${requirementHtml}</div>
      </div>
      <div class="menu-row-actions">
        <button class="menu-action-btn" ${canDo ? '' : 'disabled'}>強化</button>
      </div>
    `;
    if (canDo) {
      div.querySelector('button').addEventListener('click', () => {
        showActionConfirm(`${item.name} を強化しますか？\n\n${recipe.matName}×${recipe.matCount} を消費`,
          item, '強化', () => {
            if (!_consumeMaterial(recipe.matName, recipe.matCount)) {
              showAlert('素材消費に失敗（途中で減った？）'); return;
            }
            const beforeAtk = item.atkBonus;
            const upgraded  = applyEnhanceRecipe(item, recipe);
            _replaceWeaponAt(ref, upgraded);
            playSfx('crit');
            playSfx('levelup');
            refreshHUD();
            refreshMenu();
            autoSave();
            // 派手な強化バナー（フラッシュ + シェイク + 星屑 + 火花 + before→after 表示）
            showEnhanceCelebration(upgraded, beforeAtk, upgraded.atkBonus);
          });
      });
    }
    grid.appendChild(div);
  }

  // レジェンド武器の融合候補
  const legendaries = weapons.filter(w => w.item.rarity === 'レジェンド');
  const fuseBtn = document.getElementById('synthesis-fuse');
  // 同名（接尾辞 +xxx を除く）でグルーピング
  const groups = new Map();
  for (const w of legendaries) {
    const key = w.item.name.replace(/\+.*$/, '').replace(/・神話$/, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  const fusable = [...groups.values()].filter(arr => arr.length >= 2);
  // 旧: 候補が無ければボタン自体を hidden にしていた。新: 常に表示し、候補が
  // 無い時はタップで「なぜできないのか」をモーダルで説明する（融合の存在自体が
  // 見えないと UX 上の発見性が低いという指摘への対応）。
  fuseBtn.classList.remove('hidden');
  if (fusable.length === 0) {
    fuseBtn.textContent = '🌟 同名レジェンド融合（条件未達）';
    fuseBtn.onclick = () => {
      // 詳細: 現在のレジェンド武器名と「同名 2 個」になっているグループ数を見せる
      const list = legendaries.map(w => `・${w.item.name}`).join('\n') || '（レジェンド武器なし）';
      showAlert(
        '同名レジェンド融合をするには、同じ名前のレジェンド武器が 2 個以上必要です。\n\n' +
        '現在のレジェンド武器:\n' + list + '\n\n' +
        '※ 強化済み（+鉄/+魔 等の接尾辞付き）でも、ベース名が同じなら融合可能です。',
      );
    };
  } else {
    fuseBtn.textContent = `🌟 同名レジェンド融合 (${fusable.length} 種)`;
    fuseBtn.onclick = () => _openFuseModal(fusable);
  }
}

function _openFuseModal(fusable) {
  // 簡易: 一番上のグループの先頭 2 つを融合
  const group = fusable[0];
  const [a, b] = [group[0], group[1]];
  showActionConfirm(
    `「${a.item.name}」と「${b.item.name}」を融合させ、神話級武器を作成しますか？\n\n` +
    `両方の武器を消費します（強い方のステータスを基準に ATK×1.8）。`,
    a.item, '融合', () => {
      const fused = fuseLegendaries(a.item, b.item);
      if (!fused) { showAlert('融合できませんでした'); return; }
      // refを破壊する順番に注意：indexのずれを避けるため、後半 b を先に削除
      // src 'eq' は単一なので、両方が eq になることはない
      const order = [a, b].sort((x, y) => {
        // storage を先、inventory を次、eq を最後（idx 大きい順）
        const score = ref => (ref.src === 'sto' ? 2 : ref.src === 'inv' ? 1 : 0) * 1000 + ref.idx;
        return score(y.ref) - score(x.ref);
      });
      _removeWeaponAt(order[0].ref);
      _removeWeaponAt(order[1].ref);
      // 融合品はインベントリへ（満杯ならストレージ）
      if (canAddToInventory(fused)) addToInventory(fused);
      else                          addToStorage(fused);
      playSfx('crit');
      playSfx('levelup');
      refreshHUD();
      refreshMenu();
      autoSave();
      // 神話級バナー：mythic フラグで色とエフェクトをさらに派手に
      const beforeAtk = Math.max(a.item.atkBonus, b.item.atkBonus);
      showEnhanceCelebration(fused, beforeAtk, fused.atkBonus);
    });
}

// ─────────────────────────────────────────────
// ダンジョン内ショップ（徘徊商人）
// ─────────────────────────────────────────────
let _currentShopkeeper = null;
function _openShopModal(shopkeeper) {
  _currentShopkeeper = shopkeeper;
  const stock = dungeon.getShopStock(shopkeeper);
  const list  = document.getElementById('shop-list');

  document.getElementById('shop-gold-status').textContent = `所持金 🪙 ${player.gold ?? 0}`;
  document.getElementById('shop-keeper-meta').textContent = `Lv${shopkeeper.level} の商人（攻撃するなら相応の覚悟を）`;

  if (stock.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:#888;padding:14px">在庫切れ</div>';
  } else {
    list.innerHTML = stock.map((entry, i) => {
      const it = entry.item;
      const cantAfford = (player.gold ?? 0) < entry.price;
      return `
        <div class="item-row${cantAfford ? ' disabled' : ''}" data-idx="${i}">
          <span class="item-emoji">${iconImg(it, 32)}</span>
          <div class="item-info">
            <div class="item-name" style="color:${it.rarityColor}">${it.name}</div>
            <div class="item-desc">${_shopItemDescription(it)}</div>
          </div>
          <span class="shop-price">🪙 ${entry.price}${cantAfford ? ' ⚠️不足' : ''}</span>
        </div>`;
    }).join('');
    list.querySelectorAll('.item-row:not(.disabled)').forEach(row => {
      row.addEventListener('click', () => {
        const i = parseInt(row.dataset.idx, 10);
        _buyFromShop(i);
      });
    });
  }
  document.getElementById('shop-modal').classList.remove('hidden');
}

function _shopItemDescription(it) {
  if (it.type === 'potion')        return `HP +${it.heal} 回復 / ${it.rarity}`;
  if (it.type === 'mpPotion')      return `MP +${it.mpHeal} 回復 / ${it.rarity}`;
  if (it.type === 'scroll')        return `${it.element}属性 ${it.dmg} ダメージ / ${it.rarity}`;
  if (it.type === 'weapon')        return `ATK +${it.atkBonus}（${it.element}属性） / ${it.rarity}`;
  if (it.type === 'armor')         return `DEF +${it.defBonus}（${it.element}属性） / ${it.rarity}`;
  if (it.type === 'material')      return `${it.desc} / ${it.rarity}`;
  if (it.type === 'mysteryScroll') return `${it.desc} / ${it.rarity}`;
  if (it.type === 'skillBook')     return `📕 ${it.skillName} / ${it.rarity}`;
  if (it.type === 'key')           return '🗝️ 宝箱を 1 つ開ける';
  return it.rarity ?? '';
}

async function _buyFromShop(idx) {
  if (!_currentShopkeeper) return;
  const stock = dungeon.getShopStock(_currentShopkeeper);
  const entry = stock[idx];
  if (!entry) return;
  if ((player.gold ?? 0) < entry.price) { showAlert('ゴールドが足りません'); return; }
  // インベントリ余裕チェック（スタック合算で OK な場合あり）
  if (!canAddToInventory(entry.item)) { showAlert('持ち物が満杯です（先に整理してから）'); return; }

  // 購入前確認: 値段が上がった + 持ち物枠を圧迫するアイテムは「やっぱりやめる」が
  // 出来ないと所持金が消えて辛い。アイテム名・レア度・残ゴールドを並べて確認する。
  const remaining = (player.gold ?? 0) - entry.price;
  const ok = await showConfirm(
    `「${entry.item.name}」を購入しますか？\n\n` +
    `価格: 🪙 ${entry.price}\n` +
    `所持金: 🪙 ${player.gold ?? 0} → 🪙 ${remaining}`,
    { okLabel: '購入する', cancelLabel: 'やめる' },
  );
  if (!ok) return;

  player.gold -= entry.price;
  addToInventory({ ...entry.item });   // 同名同レアの新規個体（同じスタックに合流）
  stock.splice(idx, 1);
  playSfx('pickup', { rarityTier: rarityTier(entry.item.rarity) });
  refreshHUD();
  // 再描画
  _openShopModal(_currentShopkeeper);
  autoSave();
}

document.getElementById('btn-shop-close').addEventListener('click', () => {
  playSfx('click');
  document.getElementById('shop-modal').classList.add('hidden');
  // 地図商人モードで dungeon を差し替えていた場合は元に戻す
  if (_mapMerchantPrevDungeon !== null) {
    dungeon = _mapMerchantPrevDungeon;
    _mapMerchantPrevDungeon = null;
  }
  _currentShopkeeper = null;
});

document.getElementById('btn-shop-attack').addEventListener('click', async () => {
  if (!_currentShopkeeper) return;
  // 地図商人を攻撃しようとしても 1 ルーム戦闘ステージへ突入させない
  // （実装範囲外。普通のダンジョン商人だけ敵対化に進む）。
  if (_currentShopkeeper.isMapMerchant) {
    showAlert('地図上の行商人とは戦闘できません。');
    return;
  }
  const ok = await showConfirm(
    '本当に商人を攻撃しますか？\n\n' +
    '商人は Lv ' + _currentShopkeeper.level + ' の超強敵です。\n' +
    '勝てれば在庫すべてと大量のゴールドが手に入ります。',
    { danger: true, okLabel: '攻撃する' },
  );
  if (!ok) return;
  document.getElementById('shop-modal').classList.add('hidden');
  const target = _currentShopkeeper;
  _currentShopkeeper = null;
  // 敵対化：以後はバンプ近接攻撃の対象になり、敵 AI も動く。在庫は撃破時に
  // _handleMonsterDefeated 側で getShopStock() 経由で床にぶちまく
  target.isShopkeeper = false;
  target.hostile      = true;
  dungeonLog(`💢 ${target.name} は敵意をあらわにした！`, { rarity: 'レジェンド' });
  // 商人がプレイヤーの隣にいることが多い。即時に 1 撃殴る形にしてテンポ維持
  _bumpMeleeAttack(target);
});

// 技クイックバー描画：4 スロットに player.skills を順番にバインド。
// 学習済み技はスロットに「絵文字 + 名前頭文字」で表示し、属性カラーで縁取り。
// MP 不足時は disabled、タップで即発動（モーダルを開かない）。
const SKILL_ELEMENT_COLOR = {
  '火': '#ff6b3d', '水': '#4dc4ff', '草': '#66bb6a',
  '雷': '#ffd54f', '光': '#fff176', '闇': '#b070dd',
};
const SKILL_ELEMENT_EMOJI = {
  '火': '🔥', '水': '💧', '草': '🌿',
  '雷': '⚡', '光': '✨', '闇': '🌑',
};

// #rrggbb と alpha (0-1) を rgba(...) 文字列に。VFX の半透明色合成用
function _alphaize(hex, a) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${a})`;
}
// 技の効果範囲を将棋風グリッドで描画してモーダルに表示する。
// waza-slot 内の右上にある「?」情報ボタンから呼ばれる。
// （旧仕様：長押し / 右クリックは UX 不明瞭だったので明示的なボタン化）
function _showSkillRangePreview(skill) {
  if (!skill) return;
  const rangeId = normalizeRangeType(skill.pattern);
  const r       = RANGE_TYPES[rangeId];
  if (!r) return;
  const color   = SKILL_ELEMENT_COLOR[skill.element] ?? '#ff5252';
  const titleEl = document.getElementById('range-preview-title');
  const bodyEl  = document.getElementById('range-preview-body');
  if (!titleEl || !bodyEl) return;
  titleEl.textContent = `${skill.name} の効果範囲`;

  // ヘッダ情報（属性 / コスト / 説明）
  const infoHtml = `
    <div class="range-preview-info" style="--rp-color:${color}">
      <div class="rp-name" style="color:${color}">${SKILL_ELEMENT_EMOJI[skill.element] ?? '✨'} ${skill.name}</div>
      <div class="rp-meta">${skill.element}属性 / ${PATTERN_DESC[rangeId] ?? r.label} / 威力×${skill.dmgMult ?? 1} / MP-${skill.mpCost ?? 0}</div>
      <div class="rp-desc">${skill.desc ?? ''}</div>
    </div>
  `;

  // 範囲タイプを将棋風マス図にする。kind ごとに「7×7 グリッドで表現」
  // できるものはマス図、できない（部屋全体・フロア全体等）ものは
  // 説明テキストを大きく表示。プレイヤーは中心の 🧙 マスで固定表示。
  let gridHtml = '';
  const kind = r.kind;

  // ヘルパ: N×N グリッドを生成。center=Math.floor(N/2)。
  // hits は [[dx, dy], ...] のセットで、中心からの相対オフセット。
  const buildGrid = (N, hits, opts = {}) => {
    const half = Math.floor(N / 2);
    const hitSet = new Set(hits.map(([dx, dy]) => `${dx},${dy}`));
    const isPlayerCenter = !opts.includeSelf;
    let h = `<div class="range-preview-grid" style="grid-template-columns:repeat(${N},auto);grid-template-rows:repeat(${N},auto);--rp-color:${color}55;--rp-border:${color};--rp-glow:${color}66">`;
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const isCenter = dx === 0 && dy === 0;
        const isHit    = hitSet.has(`${dx},${dy}`);
        const cls = ['range-cell'];
        if (isCenter && isPlayerCenter) cls.push('player');
        else if (isHit) cls.push('hit');
        const inner = (isCenter && isPlayerCenter) ? '🧙' : '';
        h += `<div class="${cls.join(' ')}">${inner}</div>`;
      }
    }
    h += '</div>';
    return h;
  };

  // ヘルパ: 部屋全体・フロア全体など、グリッドで表現しにくい range の説明バナー
  const buildSpecial = (icon, title, sub) => `
    <div class="range-preview-special" style="--rp-color:${color}">
      <div style="font-size:28px;line-height:1">${icon}</div>
      <div style="margin-top:8px;font-size:14px">${title}</div>
      <div style="margin-top:4px;font-size:11px;color:var(--muted);font-weight:normal">${sub ?? ''}</div>
    </div>
  `;

  if (kind === 'self') {
    // 自分中心。中心マスを hit 扱いにする。
    gridHtml = buildGrid(3, [[0, 0]], { includeSelf: true });
  } else if (kind === 'offsets') {
    // 静的オフセット。下向き想定（プレイヤーが下を向いている）でそのまま表示。
    const offsets = r.offsets ?? [];
    // グリッドサイズはオフセットの最大絶対値で決定
    let maxAbs = 1;
    for (const [dx, dy] of offsets) maxAbs = Math.max(maxAbs, Math.abs(dx), Math.abs(dy));
    const N = Math.min(11, maxAbs * 2 + 1);
    gridHtml = buildGrid(N, offsets, { includeSelf: !!r.includeSelf });
  } else if (kind === 'line_inf' || kind === 'pierce') {
    // 直線貫通（壁まで）。下方向に最大 5 マスを描画（実ゲームは壁まで延びる）
    const cells = [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5]];
    gridHtml = buildGrid(11, cells);
  } else if (kind === 'ranged') {
    const d = r.distance ?? 3;
    gridHtml = buildGrid(Math.max(7, d * 2 + 1), [[0, d]]);
  } else if (kind === 'around_target') {
    // 正面方向最寄り敵 + 周囲 8 マス。距離 3 を仮定して中心(0,3)の周囲 8 マスを hit 扱い
    const cx = 0, cy = 3;
    const cells = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cells.push([cx + dx, cy + dy]);
    gridHtml = buildGrid(11, cells);
  } else if (kind === 'trap') {
    // 足元設置: プレイヤーマスを hit 扱いに（self と区別するため hit カラー）
    gridHtml = buildGrid(3, [[0, 0]], { includeSelf: false });
  } else if (kind === 'room') {
    gridHtml = buildSpecial('🏠', '同じ部屋の敵全員', '部屋に入っている全モンスターに着弾');
  } else if (kind === 'room_all') {
    gridHtml = buildSpecial('🏠', '同じ部屋の全員', 'プレイヤー・敵・味方を含む同部屋全員');
  } else if (kind === 'floor') {
    gridHtml = buildSpecial('🌐', 'フロアの敵全員', 'このフロアに居る全モンスターに着弾');
  } else if (kind === 'floor_all') {
    gridHtml = buildSpecial('🌐', 'フロア全員', 'プレイヤー・敵・味方を含むフロア全員');
  } else {
    gridHtml = buildSpecial('?', '範囲不明', '');
  }

  bodyEl.innerHTML = infoHtml + gridHtml;
  document.getElementById('range-preview-modal').classList.remove('hidden');
}

// 範囲プレビューモーダルの閉じるボタン
document.getElementById('btn-range-preview-close')?.addEventListener('click', () => {
  document.getElementById('range-preview-modal').classList.add('hidden');
});
// 背景タップでも閉じる
document.getElementById('range-preview-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'range-preview-modal') {
    e.target.classList.add('hidden');
  }
});

function _refreshWazaBar() {
  const bar = document.getElementById('waza-bar');
  if (!bar) return;
  if (!Array.isArray(player.skillSlots) || player.skillSlots.length !== 4) {
    player.skillSlots = [null, null, null, null];
  }
  const slots = bar.querySelectorAll('.waza-slot');
  const skills = player.skillSlots;
  for (let i = 0; i < slots.length; i++) {
    const btn = slots[i];
    const sk  = skills[i];
    // 既存ハンドラを完全に剥がす（onclick と addEventListener 両方）。
    // 同じスロットに別のスキルが再割り当てされた時の二重発火を防ぐ。
    btn.onclick = null;
    if (btn._wazaHandler) {
      btn.removeEventListener('click', btn._wazaHandler);
      btn._wazaHandler = null;
    }
    // 旧仕様の長押し / 右クリックハンドラが残っていれば剥がす
    if (btn._wazaLongHandler) {
      btn.removeEventListener('contextmenu', btn._wazaLongHandler.context);
      btn.removeEventListener('touchstart',  btn._wazaLongHandler.touchstart, { passive: true });
      btn.removeEventListener('touchend',    btn._wazaLongHandler.touchend);
      btn.removeEventListener('touchmove',   btn._wazaLongHandler.touchmove);
      btn._wazaLongHandler = null;
    }

    if (!sk) {
      btn.classList.add('empty');
      btn.classList.remove('lowmp');
      // 空スロットは tap で技割り当てメニューへ誘導（disabled だと反応無しと
      // 誤解されるので、ボタン自体は有効化してハンドラで処理する）
      btn.disabled = false;
      btn.style.borderColor   = '';
      btn.style.background    = '';
      btn.style.color         = '';
      btn.title    = '空きスロット（タップで技割り当てメニューを開く）';
      btn.innerHTML = '—';
      const emptyHandler = () => {
        playSfx('click');
        // メニューを開いて技スロット設定タブを表示
        if (typeof openMenu === 'function') openMenu();
        if (typeof _setMenuStage === 'function') _setMenuStage('skills');
      };
      btn._wazaHandler = emptyHandler;
      btn.addEventListener('click', emptyHandler);
      continue;
    }
    btn.classList.remove('empty');
    const color = SKILL_ELEMENT_COLOR[sk.element] ?? '#c5c5d4';
    const emoji = SKILL_ELEMENT_EMOJI[sk.element] ?? '✨';
    const lvLocked = player.level < skillLevelReq(sk);
    const lowMp    = (player.mp ?? 0) < sk.mpCost;
    const offAptitude = !_skillElementInAptitude(sk);
    btn.classList.toggle('lowmp', lowMp || lvLocked || offAptitude);
    btn.classList.toggle('off-aptitude', offAptitude);
    // disabled にすると「押しても無反応」と誤解されるので、ボタンは常に有効化。
    // ハンドラ側で MP 不足・Lv ロックを判定して案内ダイアログを出す方針。
    btn.disabled = false;
    btn.style.borderColor = color;
    btn.style.background  = `linear-gradient(180deg, ${color}33 0%, ${color}11 100%)`;
    btn.style.color       = color;
    btn.title = lvLocked
      ? `${sk.name}（Lv${skillLevelReq(sk)} で解放）`
      : offAptitude
        ? `${sk.name}（タイプ変更により適性外: 発動できません）`
        : `${sk.name}（${sk.element} / ${sk.pattern}型 / MP-${sk.mpCost}）${lowMp ? ' MP不足' : ''}`;
    btn.innerHTML =
      `<span class="waza-slot-emoji">${emoji}</span>` +
      `<span class="waza-slot-name">${sk.name}${lvLocked ? '🔒' : offAptitude ? '✕' : ''}</span>` +
      `<span class="waza-slot-mp">MP-${sk.mpCost}</span>` +
      `<span class="waza-slot-info" role="button" aria-label="効果範囲を見る" title="効果範囲を見る">?</span>`;
    const filledHandler = () => {
      // ダンジョン外では使えない（メニューや他画面でも誤発動しないように）
      if (screen !== 'dungeon' || !dungeon) {
        showAlert('技はダンジョン探索中にだけ使えます');
        return;
      }
      if (lvLocked) {
        showAlert(`${sk.name} は Lv${skillLevelReq(sk)} で解放されます`);
        return;
      }
      if ((player.mp ?? 0) < sk.mpCost) {
        showAlert(`MP が足りません（必要 ${sk.mpCost} / 現在 ${player.mp ?? 0}）`);
        return;
      }
      playSfx('click');
      _executeSkill(sk);
    };
    btn._wazaHandler = filledHandler;
    btn.addEventListener('click', filledHandler);

    // 「?」情報ボタンで効果範囲プレビューを開く（タップ専用 / 明示 UI）。
    // span は button 内に置いてあり、click を stopPropagation して
    // スロット本体（技発動）への伝播を止めることで誤発動を防ぐ。
    const infoEl = btn.querySelector('.waza-slot-info');
    if (infoEl) {
      const onInfo = (e) => {
        e.stopPropagation();
        e.preventDefault();
        playSfx('click');
        _showSkillRangePreview(sk);
      };
      infoEl.addEventListener('click', onInfo);
      // touchend でも click を発火させない端末向け（pointerup 系の保険）。
      // pointerdown は無視させる必要は無いが、念のため stop しておく。
      infoEl.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    }
  }
}

// わざモーダル（旧仕様）→ 直接発動に切り替え後はクイックバーから呼ばれる。
// モーダルは「技スロットを並び替える/詳細を見たい」時用に残しても良いが
// 現状は不要なので関数だけ残しておく（将来の slot 編集 UI へ転用予定）
function _openWazaModal() {
  if (!dungeon || screen !== 'dungeon') {
    showAlert('技はダンジョン探索中にだけ使えます'); return;
  }
  const skills = (Array.isArray(player.skillSlots) ? player.skillSlots : []).filter(Boolean);
  const list   = document.getElementById('waza-list');
  document.getElementById('waza-mp-status').textContent =
    `(MP ${player.mp ?? 0}/${player.maxMp ?? 0})`;

  if (skills.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:#888;padding:14px">技をまだ覚えていない<br><small>📕 技の書を「読む」と習得できる</small></div>';
  } else {
    list.innerHTML = skills.map((s, i) => {
      const lowMp = (player.mp ?? 0) < s.mpCost;
      return `
        <div class="item-row${lowMp ? ' disabled' : ''}" data-idx="${i}">
          <span class="item-emoji">📕</span>
          <div class="item-info">
            <div class="item-name" style="color:${RARITIES.find(r => r.name === s.rarity)?.color ?? '#ddd'}">${s.name}</div>
            <div class="item-desc">${PATTERN_DESC[s.pattern]} / 威力×${s.dmgMult} / ${s.element}属性 / MP -${s.mpCost}${lowMp ? ' ⚠️不足' : ''}</div>
          </div>
          <span class="item-rarity" style="color:${RARITIES.find(r => r.name === s.rarity)?.color ?? '#ddd'}">${s.rarity}</span>
        </div>`;
    }).join('');
    list.querySelectorAll('.item-row:not(.disabled)').forEach(row => {
      row.addEventListener('click', () => {
        const i = parseInt(row.dataset.idx, 10);
        const s = skills[i];
        document.getElementById('waza-modal').classList.add('hidden');
        _executeSkill(s);
      });
    });
  }
  document.getElementById('waza-modal').classList.remove('hidden');
}
document.getElementById('btn-waza-cancel').addEventListener('click', () => {
  playSfx('click');
  document.getElementById('waza-modal').classList.add('hidden');
});

// 伝説の書: ミニオン試練ダンジョンへの招待状。
//   書を消費して buildSpecialDungeonForTome で生成した一回限りのダンジョンに入る。
//   ダンジョン中（screen==='dungeon'）からは使えない（インベントリ表示で
//   action='tome' が出ない仕様）が、念のため runtime ガードもかけておく。
function _useLegendaryTomeFromInventory(idx) {
  const item = player.inventory[idx];
  if (!item || item.type !== 'legendaryTome') return;
  if (screen === 'dungeon') {
    showAlert('伝説の書はダンジョン外でしか使えません');
    return;
  }
  const tpl = findMinionTemplate(item.minionId);
  if (!tpl) {
    showAlert('この書に対応するミニオンが見つからない…（書は消費されません）');
    return;
  }
  // 書を 1 枚消費 → 試練ダンジョン生成 → 突入
  takeOneFromInventory(idx);
  const data = buildSpecialDungeonForTome(item, tpl);
  playSfx('confirm');
  dungeonLog(`📖 ${item.name} を読んだ！${tpl.fullName} の試練に挑む`);
  enterDungeon(data);
}

// バーコード由来のダンジョン入口を使用。1 個消費して即時突入。
// dungeonData は makeBarcodeDungeonPortal が事前に組み立てている。
function _useDungeonPortalFromInventory(idx) {
  const item = player.inventory[idx];
  if (!item || item.type !== 'dungeonPortal') return;
  if (screen === 'dungeon') {
    showAlert('ダンジョン入口は外側でしか使えません');
    return;
  }
  const data = item.dungeonData;
  if (!data) {
    showAlert('入口データが見つかりません（破棄します）');
    takeOneFromInventory(idx);
    return;
  }
  // 入口を 1 個消費 → 突入
  takeOneFromInventory(idx);
  playSfx('confirm');
  enterDungeon(data);
}

// 攻撃巻物（炎/水/草/雷/光/闇 の属性ダメージ）の使用。
//   旧戦闘パネル時代は単一敵に当てる仕様だったが、現行のダンジョン探索では
//   「現在のターゲット」が無いので、プレイヤーの向きから正面方向 6 マスを走査して
//   最初に見つかった敵に着弾させる。要するに RANGED 系の使い切り技として機能。
//   - 命中時: 属性相性込みダメージ + 撃破時はドロップ処理 + 敵ターン進行
//   - 正面に敵がいない: 「向きを変えて」アラート。巻物は消費しない
function _useScrollFromInventory(idx) {
  const item = player.inventory[idx];
  if (!item || item.type !== 'scroll') return;
  if (!dungeon || screen !== 'dungeon') {
    showAlert('巻物はダンジョン探索中にしか使えません');
    return;
  }
  const facing = dungeon.playerPos.facing ?? [0, 1];
  const px = dungeon.playerPos.x;
  const py = dungeon.playerPos.y;
  const [fx, fy] = _rotateOffsetByFacing([0, 1], facing);
  // 正面方向を 6 マスまで走査して最寄り敵を取得（壁で停止）
  let target = null;
  let tDx = 0, tDy = 0;
  for (let i = 1; i <= 6; i++) {
    const tx = px + fx * i;
    const ty = py + fy * i;
    if (!dungeon.canWalk(tx, ty)) break;
    const mob = dungeon.monsterAt(tx, ty);
    if (mob) { target = mob; tDx = fx * i; tDy = fy * i; break; }
  }
  if (!target) {
    showAlert('正面方向に敵がいません。\n向き（最後に動いた方向）を変えてから読んでください');
    return;
  }

  // 属性相性込みのダメージ（巻物属性 vs 敵属性）。基礎威力は item.dmg
  const matchup = elementMatchup(item.element, target.element);
  const dmg     = Math.max(1, Math.floor(item.dmg * matchup));
  target.hp     = Math.max(0, target.hp - dmg);
  // 状態異常付与（火→熱傷 / 雷→感電 等）。生存中の敵にだけ乗る。
  let appliedStatusLabel = '';
  if (item.status && target.hp > 0) {
    applyStatus(target, item.status.kind, {
      turns:  item.status.turns,
      stacks: item.status.stacks ?? 1,
    });
    const def = STATUS_DEFS?.[item.status.kind];
    if (def) appliedStatusLabel = `　${def.emoji}${def.label}付与`;
  }
  takeOneFromInventory(idx);

  // 演出: プレイヤー → 着弾点へのトレイル + 敵側の爆発 + 属性魔法陣
  const playerAt = playerVfxAnchor();
  const enemyAt  = _mobScreenAnchor(target);
  const elColor  = SKILL_ELEMENT_COLOR[item.element] ?? '#b070dd';
  if (playerAt && enemyAt) attackTrail(playerAt, enemyAt, { color: elColor });
  magicCircle(playerAt, item.element);
  if (enemyAt) {
    explosion(enemyAt, { color: elColor });
    const kind = matchup >= 1.5 ? 'crit' : matchup <= 0.7 ? 'weak' : 'effective';
    showDamageAt(enemyAt, dmg, { kind });
  }
  hitFlash({ color: _alphaize(elColor, 0.35) });
  playSfx('crit');

  const matchLbl = matchupLabel(matchup);
  dungeonLog(
    `${item.emoji ?? '📜'} ${item.name} を読んだ！ ${target.name} に ${dmg} ダメージ${matchLbl ? '　' + matchLbl : ''}${appliedStatusLabel}`,
    { rarity: item.rarity },
  );

  if (target.hp <= 0) {
    if (enemyAt) deathBurst(enemyAt, { color: target.rarityColor ?? '#ff7043' });
    _handleMonsterDefeated(target);
  }

  // メニューが開いた状態だと VFX が見えにくいので、巻物使用に限り閉じる
  document.getElementById('menu-modal')?.classList.add('hidden');
  refreshHUD();
  dungeon.render(document.getElementById('dungeon-canvas'));
  // 巻物使用は 1 ターン消費
  _runEnemyTurn();
  autoSave();
}

// 不思議系巻物の使用。Phase 4 から 5 カテゴリの効果に拡張。
//   scout    : フロアの可視化フラグを書き換え（再フロアでリセット）
//   move     : プレイヤーを瞬間移動
//   status   : HP/MP 全回復・経験値ブースト・所持金倍化
//   terrain  : 壁破壊・通路掘削
//   combat   : 部屋 / フロア全敵にダメージ
//   forbidden: 諸刃の剣（自傷ダメージと引き換えに大効果）
function _useMysteryScrollFromInventory(idx) {
  const item = player.inventory[idx];
  if (!item || item.type !== 'mysteryScroll') return;
  if (!dungeon || screen !== 'dungeon') {
    showAlert('巻物はダンジョン探索中にしか使えません');
    return;
  }
  // 効果ハンドラ。戻り値 false なら巻物を消費しない（条件不足等）。
  const effect = _MYSTERY_SCROLL_EFFECTS[item.effect];
  if (!effect) {
    showAlert(`効果不明な巻物: ${item.effect}`);
    return;
  }
  const ok = effect(item);
  if (ok === false) return;   // 効果側がアラート出して中断

  // 共通: 巻物を消費 + メニュー閉じる + 演出 + 1 ターン進行
  takeOneFromInventory(idx);
  document.getElementById('menu-modal')?.classList.add('hidden');
  playSfx('crit');
  refreshHUD();
  dungeon.render(document.getElementById('dungeon-canvas'));
  // 索敵・地形・移動系は敵ターンを進める（巻物使用 = 1 ターン）。
  // 戦闘 AoE は既に大ダメージを与えているので敵ターンも回す（取り囲まれても
  // 1 ターン猶予する仕様にしない＝撃ち漏らしたら反撃を食らう）。
  _runEnemyTurn();
  autoSave();
}

// 巻物効果のディスパッチ表。各ハンドラは true を返したら成功（消費する）、
// false を返したら失敗（巻物を消費せずに中断）。
const _MYSTERY_SCROLL_EFFECTS = {
  // ── 索敵系（既存） ──
  'reveal-stairs':  (item) => { dungeon.revealStairs  = true; dungeonLog(`🔍 ${item.name} を読んだ！ 階段位置が見える`); return true; },
  'reveal-enemies': (item) => { dungeon.revealEnemies = true; dungeonLog(`👁 ${item.name} を読んだ！ 敵位置が見える`); return true; },
  'reveal-items':   (item) => { dungeon.revealItems   = true; dungeonLog(`🎁 ${item.name} を読んだ！ アイテム位置が見える`); return true; },
  'reveal-all':     (item) => { dungeon.revealFloor   = true; dungeonLog(`🗺 ${item.name} を読んだ！ フロア全マップが照らされた`); return true; },

  // ── 移動系 ──
  'blink': (item) => {
    const room = dungeon.roomAt?.(dungeon.playerPos.x, dungeon.playerPos.y);
    const dst  = dungeon.randomFloorInRoom(room);
    if (!dst) { showAlert('部屋の中で他に移動できる場所がありません'); return false; }
    _teleportPlayer(dst.x, dst.y);
    dungeonLog(`✨ ${item.name} を読んだ！ 同じ部屋の別マスに転移した`);
    return true;
  },
  'warp': (item) => {
    const curRoom = dungeon.roomAt?.(dungeon.playerPos.x, dungeon.playerPos.y);
    const dst = dungeon.randomRoomCenterOtherThan(curRoom);
    if (!dst) { showAlert('別の部屋がありません'); return false; }
    _teleportPlayer(dst.x, dst.y);
    dungeonLog(`🌀 ${item.name} を読んだ！ 別の部屋に転移した`);
    return true;
  },
  'stairway': (item) => {
    if (!dungeon.stairsPos) { showAlert('階段の位置が見つかりません'); return false; }
    _teleportPlayer(dungeon.stairsPos.x, dungeon.stairsPos.y);
    dungeonLog(`⤵ ${item.name} を読んだ！ 階段に転移した`, { rarity: item.rarity });
    return true;
  },

  // ── 状態回復・支援系 ──
  'cure-all': (item) => {
    player.hp = player.maxHp;
    player.mp = player.maxMp ?? 0;
    // ミニオンも回復対象（味方共通の癒し）
    for (const mi of (player.minions ?? [])) mi.hp = mi.maxHp ?? mi.hp ?? 0;
    dungeonLog(`💖 ${item.name} を読んだ！ HP/MP が完全回復した`);
    return true;
  },
  'power-up': (item) => {
    if (player.level >= MAX_LEVEL) { showAlert('既に最大レベルです'); return false; }
    const need = xpRequiredForLevel(player.level) - player.xp;
    gainXp(Math.max(1, need));
    dungeonLog(`⬆ ${item.name} を読んだ！ レベルアップした！`, { rarity: item.rarity });
    return true;
  },
  'silver-jewel': (item) => {
    const before = player.gold ?? 0;
    if (before <= 0) { showAlert('所持金が無いので効果がない…'); return false; }
    const after = Math.floor(before * 1.5);
    const gain  = after - before;
    player.gold = after;
    dungeonLog(`💎 ${item.name} を読んだ！ ${gain} ゴールド増えた（合計 ${after}）`, { rarity: item.rarity });
    return true;
  },

  // ── 地形操作系 ──
  'wall-crush': (item) => {
    const n = dungeon.destroyAdjacentWalls(dungeon.playerPos.x, dungeon.playerPos.y);
    if (n === 0) { showAlert('隣接マスに破壊できる壁がありません'); return false; }
    dungeonLog(`🪨 ${item.name} を読んだ！ ${n} マスの壁を破壊した`);
    return true;
  },
  'passage': (item) => {
    if (!dungeon.stairsPos) { showAlert('階段が見つかりません'); return false; }
    dungeon.carvePassageToStairs(dungeon.playerPos.x, dungeon.playerPos.y);
    dungeonLog(`🛤 ${item.name} を読んだ！ 階段までの通路が開けた`, { rarity: item.rarity });
    return true;
  },

  // ── 戦闘 AoE ──
  'room-damage': (item) => {
    const room = dungeon.roomAt?.(dungeon.playerPos.x, dungeon.playerPos.y);
    const targets = dungeon.monstersInRoom(room);
    if (targets.length === 0) { showAlert('部屋に敵がいません'); return false; }
    _scrollAoeDamage(targets, item, 1.6, '⚡', '#ffd54f');
    return true;
  },
  'floor-damage': (item) => {
    const targets = dungeon.allLivingMonsters();
    if (targets.length === 0) { showAlert('フロアに敵がいません'); return false; }
    _scrollAoeDamage(targets, item, 1.2, '🔥', '#ff6b3d');
    return true;
  },

  // ── 禁忌系 ──
  'apocalypse': (item) => {
    const targets = dungeon.allLivingMonsters();
    // 敵がいなくても代償だけは払う（禁忌の名にふさわしい）
    _scrollAoeDamage(targets, item, 3.0, '☠', '#b070dd');
    const cost = Math.floor(player.maxHp * 0.5);
    player.hp = Math.max(1, player.hp - cost);   // 1 だけは残す（自殺技にはしない）
    dungeonLog(`💀 代償として HP が ${cost} 減った…`, { rarity: 'レジェンド' });
    hitFlash({ color: 'rgba(176,112,221,0.55)' });
    screenShake(14, 480);
    return true;
  },
  'berserk': (item) => {
    const cost = Math.floor(player.hp * 0.5);
    player.hp = Math.max(1, player.hp - cost);
    // ATK ベースを 30% 加算（フロア中持続。次フロア入場の applyLevelStats でリセット）。
    player.atkBase = Math.floor(player.atkBase * 1.3);
    player.atk     = player.atkBase + (player.weapon?.atkBonus ?? 0);
    dungeonLog(`😈 ${item.name} を読んだ！ HP -${cost} と引き換えに ATK が大幅上昇！`, { rarity: 'レジェンド' });
    hitFlash({ color: 'rgba(255,82,82,0.4)' });
    screenShake(8, 280);
    return true;
  },

  // ── 単体超火力（投擲一発 500 ダメージ・属性相性無視） ──
  'mega-bolt': (item) => {
    const facing = dungeon.playerPos.facing ?? [0, 1];
    const px = dungeon.playerPos.x;
    const py = dungeon.playerPos.y;
    const [fx, fy] = _rotateOffsetByFacing([0, 1], facing);
    // 壁を貫通して最初の生存中の敵を撃つ
    let target = null;
    for (let i = 1; i <= 30; i++) {
      const tx = px + fx * i;
      const ty = py + fy * i;
      if (tx < 0 || ty < 0) break;
      const mob = dungeon.monsterAt(tx, ty);
      if (mob) { target = mob; break; }
    }
    if (!target) { showAlert('正面方向に敵がいません'); return false; }
    const dmg = 500;
    target.hp = Math.max(0, target.hp - dmg);
    const enemyAt = _mobScreenAnchor(target);
    const playerAt = playerVfxAnchor();
    if (playerAt && enemyAt) attackTrail(playerAt, enemyAt, { color: '#ffd54f' });
    if (enemyAt) {
      explosion(enemyAt, { color: '#ffd54f' });
      explosion(enemyAt, { color: '#fff176' });
      showDamageAt(enemyAt, dmg, { kind: 'crit' });
    }
    hitFlash({ color: 'rgba(255,213,79,0.55)' });
    screenShake(12, 380);
    dungeonLog(`🌩 ${item.name}！ ${target.name} に ${dmg} ダメージ`, { rarity: 'レジェンド' });
    if (target.hp <= 0) {
      if (enemyAt) deathBurst(enemyAt, { color: target.rarityColor ?? '#ffd54f' });
      _handleMonsterDefeated(target);
    }
    return true;
  },

  // ── 自己バフ（ATK +30% を 8 ターン）──
  // 旧仕様は player.atkBase を直接 1.3x して _atkBuff 状態をオブジェクトで持って
  // いたが、新バフシステム（player.statuses[] + applyStatus + _refreshStatsWithBuffs）
  // に統合。同じ atkUp 状態を 8 ターン付与し、refreshHUD が atk を再計算する。
  'attack-up': (item) => {
    const turns = 8;
    applyStatus(player, 'atkUp', { turns, stacks: 1 });
    dungeonLog(`💪 ${item.name}！ ATK +30%（${turns} ターン持続）`, { rarity: 'エピック' });
    hitFlash({ color: 'rgba(255,213,79,0.30)' });
    sparkSpray(playerVfxAnchor(), { count: 16, color: '#ffd54f' });
    refreshHUD();
    return true;
  },
};

// 旧 _atkBuff（attack-up 巻物の単発バフ）はバフシステム統合に伴い廃止。
// 今は player.statuses[] にぶら下がる atkUp / atkUpHigh / defUp / defUpHigh が
// tickStatuses で自動的に減衰し、refreshHUD で player.atk/def に反映される。
// 旧呼び出し側互換のため空関数を残しておく（_runEnemyTurn から呼ばれている）。
function _tickAttackBuff() {
  // no-op: バフは player.statuses 経由で _tickPlayerStatuses が一括処理する。
}

// プレイヤーの位置を瞬間移動（巻物の移動効果共通ヘルパ）
function _teleportPlayer(nx, ny) {
  dungeon.playerPos.x = nx;
  dungeon.playerPos.y = ny;
  hitFlash({ color: 'rgba(124,77,255,0.45)' });
  magicCircle(playerVfxAnchor(), '光');
}

// 巻物の AoE ダメージ共通処理: 各ターゲットに dmgMult をプレイヤー ATK に乗せた
// 攻撃力を当てる。属性相性は無し（無属性扱い）。
function _scrollAoeDamage(targets, item, dmgMult, fxEmoji, fxColor) {
  hitFlash({ color: fxColor + '55' });
  screenShake(10, 380);
  let killed = 0;
  for (const m of targets) {
    const base = Math.max(2, Math.floor(player.atk * dmgMult) - Math.floor(m.def * 0.5));
    const dmg  = Math.max(2, base + Math.floor(Math.random() * Math.max(1, base * 0.3)));
    m.hp = Math.max(0, m.hp - dmg);
    const anchor = _mobScreenAnchor(m);
    if (anchor) {
      explosion(anchor, { color: fxColor });
      showDamageAt(anchor, dmg, { kind: 'crit' });
      if (m.hp <= 0) deathBurst(anchor, { color: m.rarityColor ?? fxColor });
    }
    if (m.hp <= 0) killed += 1;
  }
  dungeonLog(`${fxEmoji} ${item.name} を読んだ！ ${targets.length} 体に直撃 / ${killed} 体撃破！`, { rarity: item.rarity });
  // 撃破した敵をフロアから一括除去 + XP/ドロップ
  const dead = dungeon.monsters.filter(m => m.hp <= 0);
  for (const m of dead) {
    _maybeRecruitMinion(m);
    dungeon.removeMonster(m);
    gainXp(_xpFromMonster(m));
    const gold = rollGoldDropFromMonster(m);
    if (gold > 0) _placeFloorDrop(makeGoldFloorItem(gold), m.x, m.y);
    const matDrop = _rollMaterialDrop(m);
    if (matDrop) _autoCollectDrop(matDrop);
    const keyDrop = _rollKeyDrop(m);
    if (keyDrop) _autoCollectDrop(keyDrop);
    const drop = _rollMonsterDrop(m);
    if (drop) _placeFloorDrop(drop, m.x, m.y);
  }
  // 地図エンカウントの 1 ルーム戦闘で技撃ちで全員倒した場合のクリア。
  // バンプキルは _handleMonsterDefeated→dungeonClear（boss 経路）でカバーされる。
  if (dungeonData?.isMapBattle && dungeon.monsters.filter(m => m.hp > 0 && !m.isShopkeeper).length === 0) {
    dungeonClear();
  }
}

// 持ち物 8 枠の中から（旧仕様）/ consumables ボックスから（新仕様）薬を 1 個使用。
// 第二引数 source で 'inv' or 'cons' を区別（'inv' は旧コードからのフォールバック）。
function _usePotionFromInventory(idx, source = 'cons') {
  const list = source === 'inv' ? player.inventory : (player.consumables ?? []);
  const item = list[idx];
  if (!item) return;
  if (item.type === 'potion') {
    if (player.hp >= player.maxHp) { showAlert('HPが満タンです'); return; }
    // 「少しでも欠けていれば上限解放」: 欠けている時に飲むなら回復量フルで加算し、
    // maxHp を一時的に上回る overcap を許可する。次に被弾すれば自然に max 以下に
    // 戻る（HUD は overcap 中だけ金色表示）。
    const before = player.hp;
    player.hp = before + item.heal;
    const actual = player.hp - before;
    if (source === 'inv') takeOneFromInventory(idx); else takeOneFromConsumables(idx);
    if (typeof dungeonLog === 'function' && screen === 'dungeon') {
      const overcap = player.hp > player.maxHp ? `（上限突破！ ${player.hp}/${player.maxHp}）` : '';
      dungeonLog(`🧪 ${item.name} を使用！ HPが${actual}回復した${overcap}`,
                 overcap ? { rarity: 'レア' } : {});
    }
    playSfx('drink');
  } else if (item.type === 'mpPotion') {
    if ((player.mp ?? 0) >= (player.maxMp ?? 0)) { showAlert('MPが満タンです'); return; }
    const before = player.mp ?? 0;
    player.mp = before + item.mpHeal;
    const actual = player.mp - before;
    if (source === 'inv') takeOneFromInventory(idx); else takeOneFromConsumables(idx);
    if (typeof dungeonLog === 'function' && screen === 'dungeon') {
      const overcap = player.mp > (player.maxMp ?? 0) ? `（上限突破！ ${player.mp}/${player.maxMp}）` : '';
      dungeonLog(`🔵 ${item.name} を使用！ MPが${actual}回復した${overcap}`,
                 overcap ? { rarity: 'レア' } : {});
    }
    playSfx('drink');
  } else {
    return;
  }
  refreshHUD();
  refreshMenu();
  autoSave();
}

function _equipFromInventory(idx) {
  const item = player.inventory[idx];
  if (!item) return;
  // 入れ替え：まず取り出す
  player.inventory.splice(idx, 1);
  if (item.type === 'weapon') {
    if (player.weapon) player.inventory.push(player.weapon);
    player.weapon = item;
    player.atk    = player.atkBase + item.atkBonus;
  } else if (item.type === 'armor') {
    if (player.armor) player.inventory.push(player.armor);
    player.armor  = item;
    player.def    = player.defBase + item.defBonus;
  }
  playSfx('equip');
  refreshHUD();
  refreshMenu();
  autoSave();
}

// ─────────────────────────────────────────────
// スキャン → アイテム獲得
// ─────────────────────────────────────────────
async function launchScanner() {
  document.getElementById('scan-result').classList.add('hidden');
  pendingItem = null;
  try {
    await startScanner(scanResult => {
      stopScanner();
      // バーコードが読み取れた瞬間にカウントを 1 消費する。
      // クォータが尽きていたら結果を破棄してマップに戻す（ボタン押下時点では
      // 「読み取れた 1 件で消費する」許可が取れている前提）。
      if (!_consumeOnScanResult()) {
        showAlert('スキャン上限に達しています。マップに戻ります。');
        show('map');
        return;
      }
      const item = _itemFromScan(scanResult);
      pendingItem = item;
      _showItemResult(item, scanResult);
    });
  } catch (e) {
    showAlert('カメラを起動できません。HTTPS環境か、カメラの許可を確認してください。\n\n' + e.message);
    show('map');
  }
}

// 伝説の書ドロップ確率（バーコード 1 回スキャンあたり）。
// 数値感: 約 2%（50 回に 1 回）。レシート系はレアブーストの代わりに、
// 既に rarityOverride が立つので tome 抽選は同じ確率にしておく。
const _LEGENDARY_TOME_DROP_RATE = 0.02;

function _itemFromScan({ text, category }) {
  // 伝説の書: 通常アイテムの代わりに低確率で出現。出る場合はランダムなミニオン枠の
  // 書を返す（同じバーコードでも毎回違うミニオンになる）。
  if (Math.random() < _LEGENDARY_TOME_DROP_RATE && MINION_LIBRARY.length > 0) {
    const tpl = MINION_LIBRARY[Math.floor(Math.random() * MINION_LIBRARY.length)];
    return makeLegendaryTome(tpl.id, tpl.fullName, tpl.element);
  }

  // レシート系（Code 128 / ITF）はレア度を1段階底上げ
  let rarityOverride = null;
  if (category === 'receipt') {
    const baseRarity = rarityFromDigit(parseInt(text.slice(-1), 10));
    rarityOverride   = bumpRarity(baseRarity, 1);
  }
  const padded = text.padStart(13, '0').slice(0, 13);
  // スキャン取得アイテムは「プレイヤーLv相当」の強さで生成（同じバーコードでも
  // 育っているプレイヤーには相応のステータスで出る）
  return generateItemFromBarcode(padded, rarityOverride, player.level);
}

function _showItemResult(item, scan) {
  const statsLine =
    item.type === 'weapon' ? `ATK +${item.atkBonus}（${item.element}属性）` :
    item.type === 'armor'  ? `DEF +${item.defBonus}（${item.element}属性）` :
    item.type === 'potion'   ? `HP +${item.heal} 回復`   :
    item.type === 'mpPotion' ? `MP +${item.mpHeal} 回復` :
    item.type === 'scroll' ? `${item.element}属性 ${item.dmg}ダメージ` :
    item.type === 'legendaryTome' ? item.desc :
    item.type === 'key'    ? '🗝️ 宝箱を 1 つ開けられる' :
    item.type === 'dungeonPortal' ? `🌀 ${item.dungeonData?.theme?.name ?? ''}・B${item.dungeonData?.floors ?? '?'}F・${item.element ?? ''}属性` : '';

  const skillBlock = item.skill?.name
    ? `<div class="item-result-skill">
         <span class="skill-name">✨ ${item.skill.name}</span><br>
         <span class="skill-desc">${item.skill.desc}</span>
       </div>` : '';

  const categoryLabel =
    scan.category === 'receipt' ? '（レシート系：レア度+1）' :
    scan.category === 'product' ? '（商品コード）' : '';

  const lvHtml = item.level ? `<span class="item-result-lv">Lv${item.level}</span>` : '';

  document.getElementById('item-result').innerHTML = `
    <div class="item-result-row">
      <div class="item-result-emoji">${iconImg(item, 56)}</div>
      <div class="item-result-info">
        <div class="item-result-name">${item.name} ${lvHtml}</div>
        <div class="item-result-rarity" style="color:${item.rarityColor}">${item.rarity}</div>
      </div>
    </div>
    <div class="item-result-stats">${statsLine}</div>
    ${skillBlock}
    <div class="item-result-meta">${scan.format} / ${scan.text}${categoryLabel}</div>
  `;
  // ダンジョン入口は「突入する」ボタンに切り替え。それ以外のアイテムは従来通り
  // 「受け取る」（btn-keep-item の click ハンドラ側で type 分岐する）。
  const keepBtn = document.getElementById('btn-keep-item');
  if (keepBtn) {
    keepBtn.textContent = item.type === 'dungeonPortal' ? '🌀 突入する' : '受け取る';
  }
  document.getElementById('scan-result').classList.remove('hidden');
  // スキャン → アイテム判明時に取得SFX（レアリティで音色変化）
  playSfx('pickup', { rarityTier: rarityTier(item.rarity) });
}

document.getElementById('btn-back-scan').addEventListener('click', () => {
  playSfx('click');
  stopScanner();
  pendingItem = null;
  show('map');
});

document.getElementById('btn-rescan').addEventListener('click', async () => {
  playSfx('click');
  pendingItem = null;
  // もう一度スキャンする前にクォータの再確認（残量切れなら結晶確認 or 購入導線）
  if (!await _ensureCanScan()) { show('map'); return; }
  launchScanner();
});

document.getElementById('btn-keep-item').addEventListener('click', () => {
  if (!pendingItem) return;
  const item = pendingItem;
  pendingItem = null;
  // ダンジョン入口は「受け取る」ではなく即時突入する。
  // インベントリ経由をスキップして体験を短くする（持ち物枠も消費しない）。
  if (item.type === 'dungeonPortal' && item.dungeonData) {
    playSfx('confirm');
    enterDungeon(item.dungeonData);
    autoSave();
    return;
  }
  const msg = _acquireItem(item);
  show('map');
  // レア+はバナーで派手に告知（コモンは軽いアラート）
  if (item.rarity !== 'コモン') {
    _celebratePickup(item, '入手');
  } else {
    showAlert(msg);
  }
  autoSave();
});

// 装備自動切替＋インベントリ追加。戻り値: 通知メッセージ
function _acquireItem(item) {
  if (item.type === 'weapon') {
    if (!player.weapon || item.atkBonus > player.weapon.atkBonus) {
      const old = player.weapon;
      player.weapon = item;
      player.atk    = player.atkBase + item.atkBonus;
      if (old) addToInventory(old);
      return `⚔️ ${item.name} を装備！`;
    }
  } else if (item.type === 'armor') {
    if (!player.armor || item.defBonus > player.armor.defBonus) {
      const old = player.armor;
      player.armor = item;
      player.def   = player.defBase + item.defBonus;
      if (old) addToInventory(old);
      return `🛡️ ${item.name} を装備！`;
    }
  }
  const r = addToInventory(item);
  if (!r.ok) return `🎒 持ち物が満杯！ ${item.name} を諦めた...`;
  return `🎒 ${item.name} を入手！`;
}

// ─────────────────────────────────────────────
// ダンジョン
// ─────────────────────────────────────────────
function enterDungeon(data) {
  document.getElementById('dungeon-footer').classList.remove('hidden');

  // 入る度ランダム生成: 入場時に runSalt（毎回違う数値）を生成して dungeonData に
  // 載せ、フロアレイアウト・モンスター配置・床アイテム・ショップ在庫の RNG seed に
  // 混ぜる。これにより同じダンジョン（場所）に何度入っても毎回別物になる。
  // 元データを直接書き換えると map.js の renderedPins キャッシュが汚染されるので
  // 必ず spread でクローンしてから書き加える。
  dungeonData  = { ...data, runSalt: `${Date.now()}-${Math.floor(Math.random() * 1e9)}` };
  if (!Array.isArray(player.materials))   player.materials   = [];
  if (!Array.isArray(player.consumables)) player.consumables = [];
  if (!Array.isArray(player.statuses))    player.statuses    = [];
  // 入場前スナップショット（敗北時ロールバック）。
  // ロスト対象は inventory + consumables + 装備 + 素材ボックス。storage は据え置き。
  // 配列はディープコピー（アイテム参照だけのコピーだが count などは別個体）が必要なので
  // map で {...it} する：ロールバック時に二重カウントを防ぐ。
  entrySnapshot = {
    inventory:   player.inventory.map(it => ({ ...it })),
    consumables: player.consumables.map(it => ({ ...it })),
    materials:   player.materials.map(it => ({ ...it })),
    weapon:    player.weapon,
    armor:     player.armor,
    atk:       player.atk,
    def:       player.def,
  };
  player.hp    = player.maxHp;     // 入場時に HP/MP 全回復
  player.mp    = player.maxMp ?? 0;
  currentFloor = 1;
  // 先に screen を活性化。screen が hidden（display:none）のままだと
  // header/footer の offsetHeight が 0 になり、render が canvas サイズを過大に
  // 計算してタイルが過剰に大きく描かれてしまう（入場直後に拡大されすぎる
  // バグの根治）。loadFloor 内の render は次フレームに走らせる。
  show('dungeon');
  loadFloor(1);
  // レイアウト確定後にもう一度描いて、初期 render が hidden 中の
  // 古い offsetHeight を拾っていた場合の見た目を修正する（保険）。
  requestAnimationFrame(() => {
    if (dungeon) dungeon.render(document.getElementById('dungeon-canvas'));
  });
  autoSave();
}

function loadFloor(floor) {
  currentFloor = floor;
  dungeon = new Dungeon(dungeonData, floor);
  // 仲間ミニオンをプレイヤーの隣に配置。フロアごとに展開し直す
  dungeon.initializePlayerMinions(player);
  document.getElementById('dungeon-title').textContent = dungeonData.name;
  document.getElementById('floor-label').textContent   = `B${floor}F`;
  // フロア進入時に MP 全回復（HP は据え置き）。スキル/技を毎フロアで気軽に振れる
  // よう、ローグライクの「フロア境界＝休憩」の感覚に合わせる
  player.mp = player.maxMp ?? 0;
  // 行動回数カウンタをフロア境界でリセット（agility は status 経由で持続するので、
  // 残ターン数があれば次フロアでも 2 回行動が継続する）。
  _actionsLeftThisTurn = actionsPerTurn(player);
  // ミニオン HP もフロア境界で全回復（休憩感）
  for (const mi of (player.minions ?? [])) {
    mi.hp = mi.maxHp ?? mi.hp ?? 0;
  }
  refreshHUD();
  dungeonLog(`B${floor}F に入った（MP 全回復）`);
  // 入場時に「このダンジョンの主」を 1 度だけログで紹介（職業×属性の体験導入）。
  // B1F だけに絞ってフロア毎の鬱陶しさを避ける。特殊ダンジョン（試練）は除外。
  if (floor === 1 && !dungeonData.isSpecial) {
    const sample = (dungeon.monsters ?? []).find(m => m && m.job && !m.isShopkeeper);
    if (sample?.job?.label) {
      dungeonLog(`👁️ このダンジョンには ${dungeonData.element}属性の${sample.job.label}が棲みついている…`);
    }
  }
  dungeon.render(document.getElementById('dungeon-canvas'));
}

// バフ status（atkUp / defUp 系）を player.atk / player.def に反映する。
// 既存の applyLevelStats / 装備変更後でも、この関数が呼ばれれば最終値に補正される。
// バフ status は player.statuses[] にぶら下がり、tickStatuses でターンごとに減衰。
function _refreshStatsWithBuffs() {
  const atkMult = attackBuffMult(player);
  const defMult = defenseBuffMult(player);
  // 旧 _atkBuff（attack-up 巻物の単発バフ）は player.atkBase 自体を 1.3x して
  // いたので、新 status と二重計上される可能性がある。レガシー側はもう使用
  // しないが念のためここでは player.atkBase / defBase をそのまま base に使う。
  player.atk = Math.floor((player.atkBase + (player.weapon?.atkBonus ?? 0)) * atkMult);
  player.def = Math.floor((player.defBase + (player.armor?.defBonus  ?? 0)) * defMult);
}

function refreshHUD() {
  // 装備変更・level up・status 変動の度に呼ばれるので、最初に必ずバフ補正を反映。
  _refreshStatsWithBuffs();
  document.getElementById('player-lv').textContent = `Lv${player.level}`;
  const hpEl = document.getElementById('player-hp');
  hpEl.textContent = `HP: ${player.hp}/${player.maxHp}`;
  // overcap（上限突破中）= 現 HP > maxHp。CSS の .hp-text.overcap で金色表示にする
  hpEl.classList.toggle('overcap', player.hp > player.maxHp);
  const mpEl = document.getElementById('player-mp');
  if (mpEl) {
    mpEl.textContent = `MP: ${player.mp ?? 0}/${player.maxMp ?? 0}`;
    mpEl.classList.toggle('overcap', (player.mp ?? 0) > (player.maxMp ?? 0));
  }
  // HP / MP 棒グラフ。HP は残量で緑→黄→赤の 3 段階、MP は水色固定。
  // overcap 中は 100% に張り付かせて棒が消えないようにする（数値側で金色に切替）
  const hpBar = document.getElementById('dungeon-hp-bar');
  if (hpBar) {
    const ratio = player.maxHp > 0 ? player.hp / player.maxHp : 0;
    const pct = Math.min(100, Math.max(0, ratio * 100));
    hpBar.style.width = pct + '%';
    hpBar.style.background = pct > 50 ? '#4caf50' : pct > 25 ? '#ffc107' : '#f44336';
  }
  const mpBar = document.getElementById('dungeon-mp-bar');
  if (mpBar) {
    const max = player.maxMp ?? 0;
    const cur = player.mp ?? 0;
    const pct = max > 0 ? Math.min(100, (cur / max) * 100) : 0;
    mpBar.style.width = pct + '%';
  }
  const wHtml = player.weapon ? `${iconImg(player.weapon, 18)} +${player.weapon.atkBonus}` : '⚔️ ー';
  const aHtml = player.armor  ? `${iconImg(player.armor, 18)} +${player.armor.defBonus}`  : '🛡️ ー';
  document.getElementById('equip-display').innerHTML = `${wHtml}　${aHtml}`;

  // ゴールド表示はマップ HUD と ダンジョンヘッダの両方にある（無ければスキップ）
  const goldStr = `🪙 ${player.gold ?? 0}`;
  const dungeonGold = document.getElementById('player-gold');
  if (dungeonGold) dungeonGold.textContent = goldStr;
  const mapGold = document.getElementById('map-gold-display');
  if (mapGold) mapGold.textContent = goldStr;

  _refreshScanStatusUI();
  // 技クイックバーは MP 残量で disabled が切り替わるので HUD と同じタイミングで再描画
  _refreshWazaBar();
  // 状態異常オーバーレイも HUD と同じタイミングで再評価（罹患/解除直後に色が乗る）
  _refreshStatusOverlay();
  // バフ chip 表示
  _refreshBuffChips();
}

// プレイヤーに掛かっているバフ status を chip にして dungeon-right-hud に並べる。
// ターン経過は tickStatuses で自動減衰、剥がれたら _refreshStatusOverlay と
// 一緒にこちらも空になる。
function _refreshBuffChips() {
  const el = document.getElementById('player-buffs');
  if (!el) return;
  const buffs = activeBuffs(player);
  if (buffs.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = buffs.map(b =>
    `<span class="buff-chip" style="--c:${b.def.color}">${b.def.emoji}${b.turns}T</span>`
  ).join('');
}

// XP獲得＆レベルアップ
function gainXp(amount) {
  if (amount <= 0) return;
  player.xp += amount;
  const startLevel = player.level;
  let leveledUp = false;
  while (player.level < MAX_LEVEL && player.xp >= xpRequiredForLevel(player.level)) {
    player.xp -= xpRequiredForLevel(player.level);
    player.level += 1;
    leveledUp = true;
  }
  if (player.level >= MAX_LEVEL) {
    player.xp = 0; // 上限到達でXP溢れは捨てる
  }
  if (leveledUp) {
    applyLevelStats(player);
    player.hp = player.maxHp;
    if (typeof dungeonLog === 'function' && screen === 'dungeon') {
      dungeonLog(`🎉 レベルアップ！ Lv${player.level}（HP+${HP_PER_LEVEL} ATK+${ATK_PER_LEVEL} DEF+${DEF_PER_LEVEL}）`);
    }
    playSfx('levelup');
    // タイプ別ウィザード技の自動習得（プライマリ属性のみ）。
    // 既習得の技は重複追加しない。新規習得分は習得バナーとログで通知する。
    const learnedBefore = (player.learnedSkills ?? []).map(s => s.id);
    _autoLearnWizardSkills({ slotAuto: true });
    const newlyLearned = (player.learnedSkills ?? []).filter(s => !learnedBefore.includes(s.id));
    const gained = player.level - startLevel;
    _enqueueLevelUpPopup({
      fromLevel: startLevel,
      toLevel:   player.level,
      hpDelta:   HP_PER_LEVEL  * gained,
      atkDelta:  ATK_PER_LEVEL * gained,
      defDelta:  DEF_PER_LEVEL * gained,
      learned:   newlyLearned,
    });
  }
  refreshHUD();
  if (!document.getElementById('menu-modal').classList.contains('hidden')) refreshMenu();
  autoSave();
}

// レベルアップ ポップアップ。
//   - 連続レベルアップ（1 回の XP で複数 Lv 上がる場合）は 1 枚に集約。
//   - 別の戦闘で再度 LvUp が起きた場合はキューに積んで順次表示。
//   - 表示中は OK ボタン or 背景タップで閉じる。3.5 秒で自動クローズ（自動クリア）。
const _LEVELUP_POPUP_QUEUE = [];
let   _LEVELUP_POPUP_OPEN  = false;
let   _LEVELUP_POPUP_AUTO  = null;
function _enqueueLevelUpPopup(payload) {
  _LEVELUP_POPUP_QUEUE.push(payload);
  if (!_LEVELUP_POPUP_OPEN) _showNextLevelUpPopup();
}
function _showNextLevelUpPopup() {
  const next = _LEVELUP_POPUP_QUEUE.shift();
  const modal = document.getElementById('levelup-popup');
  if (!next || !modal) { _LEVELUP_POPUP_OPEN = false; return; }
  _LEVELUP_POPUP_OPEN = true;
  document.getElementById('levelup-old').textContent = `Lv ${next.fromLevel}`;
  document.getElementById('levelup-new').textContent = `Lv ${next.toLevel}`;
  const stats = document.getElementById('levelup-stats');
  if (stats) {
    stats.innerHTML =
      `<div class="lvup-stat"><div class="label">HP</div><div class="delta">+${next.hpDelta}</div></div>` +
      `<div class="lvup-stat"><div class="label">ATK</div><div class="delta">+${next.atkDelta}</div></div>` +
      `<div class="lvup-stat"><div class="label">DEF</div><div class="delta">+${next.defDelta}</div></div>`;
  }
  const skills = document.getElementById('levelup-skills');
  if (skills) {
    if (!next.learned || next.learned.length === 0) {
      skills.innerHTML = '';
    } else {
      skills.innerHTML = next.learned.slice(0, 6).map(sk => {
        const col = RARITIES.find(r => r.name === sk.rarity)?.color ?? '#ffd54f';
        return `<div class="lvup-skill" style="--c:${col}">📕 <span class="name">${sk.name}</span><span style="opacity:0.8">${sk.element}・${sk.rarity}</span></div>`;
      }).join('');
    }
  }
  modal.classList.remove('hidden');
  if (_LEVELUP_POPUP_AUTO) clearTimeout(_LEVELUP_POPUP_AUTO);
  _LEVELUP_POPUP_AUTO = setTimeout(_closeLevelUpPopup, 3500);
}
function _closeLevelUpPopup() {
  if (_LEVELUP_POPUP_AUTO) { clearTimeout(_LEVELUP_POPUP_AUTO); _LEVELUP_POPUP_AUTO = null; }
  document.getElementById('levelup-popup')?.classList.add('hidden');
  _LEVELUP_POPUP_OPEN = false;
  // 次がキューにあれば 200ms 遅延で再オープン（連打防止）
  if (_LEVELUP_POPUP_QUEUE.length > 0) setTimeout(_showNextLevelUpPopup, 200);
}
document.getElementById('btn-levelup-close')?.addEventListener('click', _closeLevelUpPopup);
document.getElementById('levelup-popup')?.addEventListener('click', (e) => {
  if (e.target.id === 'levelup-popup') _closeLevelUpPopup();
});

// モンスター撃破時のXP量。旧仕様は固定値だったので、低 Lv プレイヤーが格上を
// 倒しても全然レベルが上がらず作業感が強かった。
//   - 基礎値: レアリティで決まる（旧仕様より気持ち多め）
//   - レベル差補正: 敵 Lv > 自 Lv で指数的にブースト（最大 ×3.0）。
//     具体的には diff > 0 の時 mult = 1 + 0.18 * diff（diff の上限 11 で頭打ち）
//   - 格下: 敵 Lv < 自 Lv で穏やかに減衰（最大半減）。0 にはしない（見つけたら倒す）
//   - ボス: 最後に ×3 を乗せる（仕様変更前後で同じ）
function _xpFromMonster(mob) {
  const base =
    mob.rarity === 'レジェンド' ? 240 :
    mob.rarity === 'エピック'   ? 90  :
    mob.rarity === 'レア'       ? 32  :
    14;
  const diff = (mob.level ?? 1) - (player?.level ?? 1);
  let mult = 1;
  if (diff > 0) {
    // 格上: +18% per Lv（11 段差で約 ×3.0）
    mult = 1 + 0.18 * Math.min(11, diff);
  } else if (diff < 0) {
    // 格下: -8% per Lv（最低 ×0.5 で頭打ち）
    mult = Math.max(0.5, 1 + 0.08 * diff);
  }
  const total = Math.floor(base * mult);
  return mob.isBoss ? total * 3 : Math.max(1, total);
}

// ダンジョンログを 1 行追加。新規行を最前列に挿入し、古い行から消していく。
//   opts.rarity: レア度別の左カラーバー / グロウを付ける（アイテム入手系）
//   _enhanceLogText: 数値（ダメージ・HP・MP・ゴールド・Lv）を色付き <span> にして
//   重要な情報が一目で読めるようにする（XSS は内部呼び出しのみで未対策）。
// ダンジョンログの保持上限。表示自体は max-height でクリップされるが、
// 「ログ履歴」モーダルで最大 100 件まで遡って読めるようにする。
const _DUNGEON_LOG_MAX_LINES = 100;
function dungeonLog(msg, opts = {}) {
  const el = document.getElementById('dungeon-log');
  if (!el) return;
  // 既存の "recent" を剥がして「古い行」扱いに
  el.querySelectorAll('.log-line.recent').forEach(d => d.classList.remove('recent'));
  const div = document.createElement('div');
  const rarityCls = opts.rarity ? _logClassFor(opts.rarity) : '';
  div.className = `log-line recent ${rarityCls}`.trim();
  div.innerHTML = _enhanceLogText(msg);
  el.prepend(div);
  // ユーザーが過去ログを見るためにスクロールしていても、新規ログは最上段に
  // 居るのが原則（最新が常に明るくハイライトされている UX）。一律 0 に戻す。
  el.scrollTop = 0;
  // 最大行数を超えたら一番古いものから削除
  const lines = el.querySelectorAll('.log-line');
  for (let i = lines.length - 1; i >= _DUNGEON_LOG_MAX_LINES; i--) {
    lines[i].remove();
  }
}

// ── 状態異常 (status) システム ─────────────────────────────────
// プレイヤー / 敵に共通の付与・解除・tick・UI 連携。詳細は src/status.js。

// プレイヤー罹患の画面オーバーレイ更新。dominant status の overlay 色を使う。
function _refreshStatusOverlay() {
  const el = document.getElementById('status-overlay');
  if (!el) return;
  const dom = dominantStatus(player);
  if (!dom || screen !== 'dungeon') {
    el.classList.add('hidden');
    el.style.removeProperty('--overlay');
    return;
  }
  const def = STATUS_DEFS[dom.kind];
  if (!def) { el.classList.add('hidden'); return; }
  el.style.setProperty('--overlay', def.overlay);
  el.classList.remove('hidden');
}

// プレイヤーに状態異常を付与。バナーログ + オーバーレイ更新。
function _applyStatusToPlayer(kind, opts = {}) {
  const ok = applyStatus(player, kind, opts);
  if (!ok) return;
  const def = STATUS_DEFS[kind];
  if (def) dungeonLog(`${def.emoji} ${def.label} 状態になった！`, { rarity: 'レア' });
  _refreshStatusOverlay();
}

// プレイヤーのターン経過処理: DoT / mp+1 / 期限切れ通知。
// 戻り値: 'dead' なら HP 0 で死亡確定、'alive' なら継続。
function _tickPlayerStatuses() {
  const tick = tickStatuses(player);
  if (tick.dotDamage > 0) {
    player.hp = Math.max(0, player.hp - tick.dotDamage);
    dungeonLog(`💥 状態異常で ${tick.dotDamage} ダメージ`);
    refreshHUD();
  }
  for (const ex of tick.expired) {
    const def = STATUS_DEFS[ex.kind];
    if (def) dungeonLog(`✨ ${def.label} が解除された`);
  }
  _refreshStatusOverlay();
  return player.hp <= 0 ? 'dead' : 'alive';
}

// 入力された移動方向を状態異常で改変する。confuse でランダム化、
// shock で 確率的に待機（dx,dy=0,0）に置換、sleep で常に待機。
// 返り値: { dx, dy, blocked, replacedReason }
function _transformInputForStatuses(dx, dy) {
  if (hasStatus(player, 'sleep')) {
    return { dx: 0, dy: 0, blocked: true, replacedReason: 'sleep' };
  }
  const skip = shockSkipChance(player);
  if (skip > 0 && Math.random() < skip) {
    return { dx: 0, dy: 0, blocked: true, replacedReason: 'shock' };
  }
  if (hasStatus(player, 'confuse')) {
    const dirs = [[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[-1,1],[1,-1],[1,1]];
    const r = dirs[Math.floor(Math.random() * dirs.length)];
    return { dx: r[0], dy: r[1], blocked: false, replacedReason: 'confuse' };
  }
  return { dx, dy, blocked: false, replacedReason: null };
}

// 行動時の自傷判定（骨折）。発動するとプレイヤーが小ダメージを受ける。
function _maybeFractureSelfHurt() {
  const ch = fractureSelfHurtChance(player);
  if (ch <= 0) return false;
  if (Math.random() >= ch) return false;
  const dmg = Math.max(1, Math.floor(player.maxHp * 0.05));
  player.hp = Math.max(0, player.hp - dmg);
  dungeonLog(`🦴 骨折で ${dmg} ダメージ（自傷）`);
  refreshHUD();
  return true;
}

// 状態異常 説明モーダル
function _openStatusInfoModal() {
  const body = document.getElementById('status-info-body');
  if (!body) return;
  // 旧実装は外側の wrapper div が flex の min-width を持たず、
  // 内側テキスト（status-info-text）が幅を取れずに崩れて読めなかった。
  // 説明テキストを span ではなく block 要素で置き、明示的な flex で囲う。
  body.innerHTML = Object.entries(STATUS_DEFS).map(([kind, def]) =>
    `<div class="status-info-row" style="--c:${def.color}">
       <div class="status-info-emoji">${def.emoji}</div>
       <div class="status-info-text">
         <div class="status-info-name">${def.label}</div>
         <div>${def.desc}</div>
       </div>
     </div>`
  ).join('');
  document.getElementById('status-info-modal')?.classList.remove('hidden');
}
document.getElementById('btn-open-status-info')?.addEventListener('click', () => {
  playSfx('click');
  _openStatusInfoModal();
});
document.getElementById('btn-status-info-close')?.addEventListener('click', () => {
  document.getElementById('status-info-modal')?.classList.add('hidden');
});
document.getElementById('status-info-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'status-info-modal') e.target.classList.add('hidden');
});

// 「📜 ログ履歴」モーダル：保持中の log-line を全件まとめて表示する。
// クイックバー左の📜ボタンから開く。閉じる/背景タップで閉じる。
function _openLogHistoryModal() {
  const modal = document.getElementById('log-history-modal');
  const body  = document.getElementById('log-history-body');
  const count = document.getElementById('log-history-count');
  if (!modal || !body) return;
  const src   = document.getElementById('dungeon-log');
  const lines = src ? Array.from(src.querySelectorAll('.log-line')) : [];
  if (count) count.textContent = `(${lines.length} 件 / 最大 ${_DUNGEON_LOG_MAX_LINES})`;
  if (!lines.length) {
    body.innerHTML = '<div style="text-align:center;color:#888;padding:14px">ログはまだありません</div>';
  } else {
    // 既に最新→旧の順で並んでいる（dungeonLog が prepend するため）。innerHTML をコピーして
    // recent クラスは外す（モーダル側では「最新行=リストの先頭」が一目で分かる視覚で十分）。
    body.innerHTML = lines.map(l => {
      const cls = l.className.replace('recent', '').trim();
      return `<div class="${cls}">${l.innerHTML}</div>`;
    }).join('');
  }
  modal.classList.remove('hidden');
}
document.getElementById('btn-log-history')?.addEventListener('click', () => {
  playSfx('click');
  _openLogHistoryModal();
});
document.getElementById('btn-log-history-close')?.addEventListener('click', () => {
  document.getElementById('log-history-modal')?.classList.add('hidden');
});
document.getElementById('log-history-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'log-history-modal') e.target.classList.add('hidden');
});

// ログメッセージの数値・キーワードを色付き <span> でラップ。
// HTML 注入は無し（内部呼び出しのみ）の前提で正規表現による軽量装飾。
function _enhanceLogText(msg) {
  if (typeof msg !== 'string') return msg ?? '';
  return msg
    // 「N ダメージ」: ダメージ数を赤強調
    .replace(/(\d+)(\s*)ダメージ/g, '<span class="log-dmg">$1</span>$2ダメージ')
    // 「HPが N 回復」「N HP回復」など
    .replace(/HPが(\d+)回復/g,  'HPが<span class="log-heal">$1</span>回復')
    .replace(/MPが(\d+)回復/g,  'MPが<span class="log-mana">$1</span>回復')
    // 「N ゴールド」: 金色強調
    .replace(/(\d+)(\s*)ゴールド/g, '<span class="log-gold">$1</span>$2ゴールド')
    // 「MP -N」: 青小さめ
    .replace(/MP\s*-(\d+)/g, '<span class="log-mp">MP -$1</span>')
    // 「Lv N」: 黄色
    .replace(/Lv\s*(\d+)/g, '<span class="log-lv">Lv$1</span>')
    // 弱点表示は派手に
    .replace(/弱点!!/g, '<span class="log-weakness">弱点!!</span>')
    .replace(/効果絶大[！!]/g, '<span class="log-weakness">効果絶大！</span>');
}

function _logClassFor(rarity) {
  switch (rarity) {
    case 'レア':       return 'dungeon-log-rare';
    case 'エピック':   return 'dungeon-log-epic';
    case 'レジェンド': return 'dungeon-log-legendary';
    default:           return '';
  }
}

// 拾得 / ドロップ時の派手な演出。
//   コモン: 何もしない
//   レア:   バナーのみ
//   エピック: バナー + 紫フラッシュ + 軽いシェイク + 紫スパーク
//   レジェンド: バナー + 金フラッシュ + 強シェイク + 金スパーク多重 + 中央爆発 +
//                 0.4s 後に再スパーク（脳汁ポップ）
//   action が「ドロップ」のときも同じ演出を出す。
//   _celebratePickup の旧仕様（バナーだけ）から拡張：レア度別に層を重ねる。
function _celebratePickup(item, action = '入手') {
  if (!item) return;
  const rarity = item.rarity;
  if (rarity === 'コモン') return;
  showItemBanner(item, { action });

  // 画面中央のアンカー: window 全域を使う仮想 rect
  const centerAnchor = (() => {
    const cx = (window.innerWidth ?? 360) / 2;
    const cy = (window.innerHeight ?? 600) / 2;
    return { left: cx - 12, top: cy - 12, width: 24, height: 24 };
  })();
  const playerAt = playerVfxAnchor() ?? centerAnchor;

  if (rarity === 'エピック') {
    hitFlash({ color: 'rgba(171,71,188,0.32)' });
    screenShake(5, 220);
    sparkSpray(centerAnchor, { count: 16, color: '#ce93d8' });
    sparkSpray(playerAt,     { count: 10, color: '#ce93d8' });
    playSfx('crit');
  } else if (rarity === 'レジェンド') {
    hitFlash({ color: 'rgba(255,213,79,0.42)' });
    screenShake(10, 340);
    explosion(centerAnchor, { color: '#ffd54f' });
    sparkSpray(centerAnchor, { count: 26, color: '#ffd54f' });
    sparkSpray(centerAnchor, { count: 16, color: '#fff' });
    sparkSpray(playerAt,     { count: 14, color: '#ffd54f' });
    playSfx('crit');
    // 0.4 秒遅らせて 2 波目（脳汁感）
    setTimeout(() => {
      sparkSpray(centerAnchor, { count: 18, color: '#ffe082' });
      sparkSpray(playerAt,     { count: 10, color: '#fff176' });
      playSfx('levelup');
    }, 400);
  }
}

// 敵 / ミニオンのアニメーション中はプレイヤーの新しい行動を遮断するためのフラグ。
// move() の入口でチェックし、_runEnemyTurn の完了コールバックでクリアする。
// 長押し（ArrowKey 自動リピート）で次のターンが「前のターンの最中」に始まり、
// 攻撃演出が重なる/HP 表示がチカチカするバグを防ぐ。
let _turnBusy = false;

// 瞬発力（agility）バフで「1 ターンに複数回行動」を実現するためのカウンタ。
// 各ターンの先頭でバフ status から actionsPerTurn を計算してセット。プレイヤーの
// 行動を 1 つ消化するたびに -1 され、0 になった時点で初めて敵ターンが回る。
// dungeon 入場時に初期化し、敵ターン完了時に次ターンの値を再計算する。
let _actionsLeftThisTurn = 1;

// ── 移動（2 段階：向き変更 → 同方向で前進）──
//   - 待機 (0,0): その場で 1 ターン経過（向きは変えない）
//   - 入力方向と現在の向きが違う: 向きだけ変更、ターンは経過しない
//   - 入力方向と現在の向きが同じ: 1 マス前進（敵がいれば近接攻撃、壁越しは魔法）
function move(dx, dy) {
  if (!dungeon || screen !== 'dungeon') return;
  if (_turnBusy) return;   // ターン進行中の入力は捨てる（長押しの暴発防止）
  // PvP アリーナでは「自分のターン」じゃなければ全入力を捨てる。
  if (dungeonData?.isPvpArena && _pvpData?.turn !== _pvpRole) return;

  // 状態異常で入力が変質する: sleep=必ず待機 / shock=確率で待機 / confuse=方向ランダム
  if (dx !== 0 || dy !== 0) {
    const t = _transformInputForStatuses(dx, dy);
    if (t.replacedReason === 'sleep') {
      dungeonLog('😴 睡眠中で動けない！');
    } else if (t.replacedReason === 'shock') {
      dungeonLog('⚡ 感電して行動できなかった！');
    } else if (t.replacedReason === 'confuse') {
      dungeonLog(`😵 錯乱で別方向（${t.dx},${t.dy}）に動いた！`);
    }
    dx = t.dx; dy = t.dy;
  }

  // 待機: その場で敵ターンを進める
  if (dx === 0 && dy === 0) {
    // PvP アリーナでも待機を有効に（移動と同じ「ターン終了」扱いで Firestore 通知）
    if (dungeonData?.isPvpArena) {
      _pvpSendMoveAction();
      return;
    }
    _runEnemyTurn();
    return;
  }

  const facing = dungeon.playerPos.facing ?? [0, 1];
  const sameDir = facing[0] === dx && facing[1] === dy;
  if (!sameDir) {
    // 向きを変えるだけ。敵ターンは進めない（1 アクションを「向く」だけで消費しない）
    dungeon.playerPos.facing = [dx, dy];
    dungeon.render(document.getElementById('dungeon-canvas'));
    return;
  }

  const px = dungeon.playerPos.x;
  const py = dungeon.playerPos.y;
  const nx = px + dx;
  const ny = py + dy;

  // 斜め移動の壁抜け禁止：縦横どちらか1つでも壁なら斜めへは進めない
  if (dx !== 0 && dy !== 0) {
    const sideX = dungeon.canWalk(px + dx, py);
    const sideY = dungeon.canWalk(px, py + dy);
    if (!sideX || !sideY) {
      // 壁の角越しに敵がいる場合は遠隔魔法で殴る（旧 wallPiercing 戦闘の代替）
      const mob = dungeon.monsterAt(nx, ny);
      if (mob && dungeon.canWalk(nx, ny)) {
        _wallPiercingAttack(mob);
      }
      return;
    }
  }

  if (!dungeon.canWalk(nx, ny)) return;

  const mob = dungeon.monsterAt(nx, ny);
  if (mob) {
    // 商人マスへ進入 → 戦闘ではなく購入モーダル
    if (mob.isShopkeeper) {
      _openShopModal(mob);
      return;
    }
    // 協力モード: 仲間プレイヤー (isPvpOpponent) は攻撃対象にせず移動だけブロック
    if (mob.isPvpOpponent && _pvpData?.mode === 'coop') {
      return;
    }
    // バンプ近接攻撃（戦闘パネルは無し）。1 撃で倒せなければ敵ターン
    _bumpMeleeAttack(mob);
    return;
  }

  // ミニオンマスへの侵入 → 位置交換（同マスに重ならない）
  const minion = dungeon.minionAt ? dungeon.minionAt(nx, ny) : null;
  if (minion) {
    minion.x = px;
    minion.y = py;
    dungeon.playerPos.x = nx;
    dungeon.playerPos.y = ny;
    dungeon.render(document.getElementById('dungeon-canvas'));
    _runEnemyTurn();
    return;
  }

  dungeon.playerPos.x = nx;
  dungeon.playerPos.y = ny;

  const floorItem = dungeon.itemAt(nx, ny);
  if (floorItem) pickupItem(floorItem);

  if (dungeon.atStairs(nx, ny)) {
    playSfx('stairs');
    if (currentFloor >= dungeonData.floors) {
      dungeonClear();
    } else {
      dungeonLog(`B${currentFloor + 1}F へ降りた`);
      loadFloor(currentFloor + 1);
    }
    return;
  }

  // PvP アリーナ: 移動結果を Firestore に送ってターン終了
  if (dungeonData?.isPvpArena) {
    _pvpSendMoveAction();
    return;
  }
  _runEnemyTurn();
}

// 敵ターン共通処理
//   ミニオン行動 → 敵行動を 1 件ずつ時間差で演出する（プレイヤーが目で追える速さ）。
//   各攻撃にはアタックトレイル + ダメージ表示 + 1 呼吸の間（STEP_MS）を入れる。
// 地図エンカウント由来の 1 ルーム戦闘で、何らかの経路でモンスターが全滅した時に
// 必ずクリア扱いにして地図に戻すための保険ヘルパ。bump kill / skill kill 経路に
// 加え、DoT 死亡や minion による撃破でも漏れ無くクリアを検知できるようにする。
//   戻り値: true = クリア処理を発火した（呼び出し側はそれ以降の処理を打ち切るべき）
function _maybeMapBattleClear() {
  if (!dungeonData?.isMapBattle) return false;
  const alive = (dungeon?.monsters ?? []).filter(m => m.hp > 0 && !m.isShopkeeper);
  if (alive.length > 0) return false;
  dungeonClear();
  return true;
}

// 装備形式変更時に自分の atk/def を再計算する（ロビー waiting 中のみ呼ばれる）。
//   pvp + set    → atkBase + 25, defBase + 15（公平戦の固定補正）
//   それ以外     → 現在の player.atk / player.def をそのまま
// 数値は multiplayer.PVP_SET_PRESET と一致させる必要がある（重複定義のため要保守）。
async function _pvpReapplyOwnEquip(mode, format) {
  if (!_pvpCode || !_pvpRole) return;
  let atk, def;
  if (mode === 'pvp' && format === 'set') {
    atk = (player.atkBase ?? 0) + 25;
    def = (player.defBase ?? 0) + 15;
  } else {
    atk = player.atk;
    def = player.def;
  }
  try {
    await pvpSubmitOwnState(_pvpCode, _pvpRole, { atk, def });
  } catch (err) { console.warn('reapply equip failed:', err); }
}

// PvP アリーナ: 移動完了を Firestore に通知して相手側にターンを渡す。
function _pvpSendMoveAction() {
  if (!_pvpCode || !_pvpRole || !_pvpData || !dungeon) return;
  _turnBusy = true;     // 相手の応答が来るまで自分の入力を弾く
  pvpSubmitMove(_pvpCode, _pvpRole, {
    x:      dungeon.playerPos.x,
    y:      dungeon.playerPos.y,
    facing: dungeon.playerPos.facing.slice(),
  }, _pvpData?.turnNo ?? 0)
    .catch(err => console.warn('PvP move sync failed:', err))
    .finally(() => {
      _turnBusy = false;
      if (dungeon) dungeon.render(document.getElementById('dungeon-canvas'));
    });
}

// PvP アリーナ: 技を撃った結果を Firestore に通知。MP コストや状態異常付与も送る。
// バンプ攻撃と同じく submitArenaAttack を使うが、kind='skill' で区別する。
//   協力モードで技がボスに当たった場合は boss 用同期に振り替える（_pvpSendBossDamage 経由で
//   反撃も入る）。仲間プレイヤーは技の対象外なので opp.hp は変動しない前提。
function _pvpSendSkillAction(args) {
  if (!_pvpCode || !_pvpRole || !_pvpData) return;
  // 協力モード: 技がボスを攻撃したら boss 同期側（反撃含む）に切替
  if (_pvpData.mode === 'coop') {
    const localBoss = (dungeon?.monsters ?? []).find(m => m?.isCoopBoss);
    if (localBoss) {
      _pvpSendBossDamage(Math.max(0, localBoss.hp), args.totalDmg ?? 0);
      // MP コストだけは別途同期（submitOwnState で送る）
      pvpSubmitOwnState(_pvpCode, _pvpRole, {
        mp: player.mp,
        atk: player.atk,
        def: player.def,
        statuses: Array.isArray(player.statuses) ? player.statuses : [],
      }).catch(() => {});
      return;
    }
  }
  const opp = (dungeon?.monsters ?? []).find(m => m?.isPvpOpponent);
  _turnBusy = true;
  pvpSubmitArenaAttack(_pvpCode, _pvpRole, {
    kind: 'skill',
    dmg: args.totalDmg ?? 0,
    targetHpAfter: args.hpAfter ?? 0,
    attackerUid: _pvpData[_pvpRole]?.uid,
    attackerMpAfter: args.attackerMpAfter,
    attackerStatuses: Array.isArray(player.statuses) ? player.statuses : null,
    attackerAtk: player.atk,
    attackerDef: player.def,
    targetStatuses: Array.isArray(opp?.statuses) ? opp.statuses : null,
    turnNo: _pvpData.turnNo ?? 0,
  })
    .catch(err => console.warn('PvP skill sync failed:', err))
    .finally(() => {
      _turnBusy = false;
      if (dungeon) dungeon.render(document.getElementById('dungeon-canvas'));
    });
}

// PvP アリーナ: 自己バフ系 SELF 技を撃った時、own statuses + atk/def + MP +
// ターン交代をまとめて Firestore に送る。submitOwnState の flipTurn で 1 行で済む。
function _pvpSendSelfBuff() {
  if (!_pvpCode || !_pvpRole || !_pvpData) return;
  _turnBusy = true;
  const otherRole = _pvpRole === 'host' ? 'guest' : 'host';
  pvpSubmitOwnState(_pvpCode, _pvpRole, {
    hp:       player.hp,
    mp:       player.mp,
    atk:      player.atk,
    def:      player.def,
    statuses: Array.isArray(player.statuses) ? player.statuses : [],
    flipTurn: true,
    turnNo:   _pvpData.turnNo ?? 0,
    otherUid: _pvpData[otherRole]?.uid,
  })
    .catch(err => console.warn('PvP self-buff sync failed:', err))
    .finally(() => {
      _turnBusy = false;
      if (dungeon) dungeon.render(document.getElementById('dungeon-canvas'));
    });
}

// 協力モード: 共有ボスにダメージを与えた結果を Firestore に同期。
// ボス HP/位置 の更新 + 反撃 + ターン交代を一発で行う。
// 撃破なら state=finished+cause=bossKilled、反撃で自分が死ねば cause=playerDied。
function _pvpSendBossDamage(bossHpAfter, dmg) {
  if (!_pvpCode || !_pvpRole || !_pvpData) {
    // typo guard: _pvpCode 大文字小文字に注意
  }
  if (!_pvpCode || !_pvpRole || !_pvpData) return;
  _turnBusy = true;
  const otherRole = _pvpRole === 'host' ? 'guest' : 'host';
  // ボスがまだ生きていれば反撃: boss.atk - 自分の def を最低 1 で適用。
  // 反撃命中演出（フローティングダメージ + ヒットフラッシュ + シェイク）を即時にローカルでも出す。
  let counter = null;
  if (bossHpAfter > 0 && _pvpData.boss) {
    const counterDmg = Math.max(1, (_pvpData.boss.atk ?? 0) - (player.def ?? 0));
    const myHpAfter  = Math.max(0, (player.hp ?? 0) - counterDmg);
    counter = { role: _pvpRole, hpAfter: myHpAfter, dmg: counterDmg };
    // ローカル反映（演出 + HP 表示）
    player.hp = myHpAfter;
    dungeonLog(`💥 ボスの反撃！ ${counterDmg} ダメージ`, { rarity: 'レア' });
    showFloatingDamage(counterDmg);
    const playerAt = playerVfxAnchor();
    if (playerAt) shockwave(playerAt, { color: 'rgba(255,82,82,0.65)' });
    screenShake(counterDmg > 20 ? 8 : 4, counterDmg > 20 ? 280 : 160);
    hitFlash({ color: 'rgba(255,82,82,0.30)' });
    playSfx('damage');
    refreshHUD();
    // _pvpLastMyHp も更新しておかないと、次の watcher snapshot で「相手の攻撃」と
    // 誤判定されてダメージ表示が二重になる
    _pvpLastMyHp = myHpAfter;
  }
  pvpSubmitBossUpdate(_pvpCode, {
    hp:       bossHpAfter,
    flipTurn: true,
    nextTurn: otherRole,
    turnNo:   _pvpData.turnNo ?? 0,
    counter,
  })
    .catch(err => console.warn('PvP boss update failed:', err))
    .finally(() => {
      _turnBusy = false;
      if (dungeon) dungeon.render(document.getElementById('dungeon-canvas'));
    });
}

// PvP アリーナ: バンプ攻撃で相手プレイヤーにダメージを与えた結果を通知。
function _pvpSendAttackAction(dmg, targetHpAfter) {
  if (!_pvpCode || !_pvpRole || !_pvpData) return;
  _turnBusy = true;
  pvpSubmitArenaAttack(_pvpCode, _pvpRole, {
    kind: 'attack',
    dmg,
    targetHpAfter,
    attackerUid: _pvpData[_pvpRole]?.uid,
    turnNo: _pvpData.turnNo ?? 0,
  })
    .catch(err => console.warn('PvP attack sync failed:', err))
    .finally(() => {
      _turnBusy = false;
      if (dungeon) dungeon.render(document.getElementById('dungeon-canvas'));
    });
}

function _runEnemyTurn() {
  // PvP アリーナでは AI を走らせず、相手の入力を Firestore 経由で待つ。
  // 自分のターン終了の通知は move() / 攻撃ハンドラ側で submitMove/Attack 済。
  if (dungeonData?.isPvpArena) return;

  // 瞬発力バフ中は 1 ターンに複数回行動できる。
  // _actionsLeftThisTurn が 1 より多ければ、これは「同じターン内の追加行動」なので
  // 敵ターンや status tick を走らせず、すぐに次の入力を許可して return する。
  // 0 になった時に初めて本番の敵ターンが回り、最後にカウンタを次ターンぶん再計算。
  _actionsLeftThisTurn = Math.max(0, _actionsLeftThisTurn - 1);
  if (_actionsLeftThisTurn > 0) {
    if (typeof dungeonLog === 'function') {
      dungeonLog(`💨 瞬発力で追加行動！（残り ${_actionsLeftThisTurn} 回）`);
    }
    refreshHUD();
    if (dungeon) dungeon.render(document.getElementById('dungeon-canvas'));
    _turnBusy = false;
    return;
  }

  // ターン進行: アニメーションが終わるまで move() の追加入力を弾く。
  // 完了パスが複数ある（即終了/death/最後の magic 後など）ため、ここで上限の
  // setTimeout も予防的に張って必ずクリアされるようにする。
  _turnBusy = true;
  const _clearBusy = () => {
    _turnBusy = false;
    // 敵ターン完了時点で次ターンの行動回数を再計算（バフ tick 反映後の値）
    _actionsLeftThisTurn = actionsPerTurn(player);
  };
  // 上限ガード: 通常はアニメ完了 callback でクリアするが、想定外で漏れた場合の保険
  setTimeout(_clearBusy, 6000);

  // ターン進行: 状態異常 (DoT / 期限切れ通知) を最初に処理。
  // 死亡したらリザルトへ。
  if (_tickPlayerStatuses() === 'dead') {
    setTimeout(() => showResult(false), 250);
    _clearBusy();
    return;
  }
  _tickAttackBuff();
  // 敵側の状態異常もまとめてティック（DoT は m.hp に直接適用）
  for (const m of (dungeon?.monsters ?? [])) {
    if (m.hp <= 0) continue;
    const t = tickStatuses(m);
    if (t.dotDamage > 0) {
      m.hp = Math.max(0, m.hp - t.dotDamage);
      if (m.hp <= 0) {
        // 倒した扱い: ドロップ等は省略（状態異常での自然死は通常撃破とは別経路）
        dungeon.removeMonster(m);
        dungeonLog(`💢 ${m.name} は状態異常で力尽きた`);
      }
    }
  }
  // DoT 死亡で地図エンカウントの最後の 1 体が落ちた場合のクリア検知
  if (_maybeMapBattleClear()) { _clearBusy(); return; }
  // 1) ミニオンのターン: 攻撃と位置交換イベントを同期処理
  const minionRes = dungeon.tickMinions(player);
  const minionAttacks = (minionRes?.events ?? []).filter(e => e.type === 'minion-attack');

  // 描画はミニオン移動結果（swap 含む）を先に反映
  dungeon.render(document.getElementById('dungeon-canvas'));

  // 低速モード時はステップを長く取り、攻撃前にテレグラフ（攻撃者をフラッシュ）。
  // 高速モードは旧仕様のまま 280ms ステップ・テレグラフ無し。
  const STEP_MS  = combatStepMs();
  const PRE_FLASH = combatPreFlashMs();
  const TELEGRAPH = shouldShowTelegraph();

  const playMinionAttacks = (cb) => {
    if (minionAttacks.length === 0) { cb(); return; }
    let i = 0;
    const step = () => {
      const ev = minionAttacks[i++];
      if (!ev) { cb(); return; }
      const next = () => setTimeout(() => {
        dungeon.render(document.getElementById('dungeon-canvas'));
        if (i < minionAttacks.length) setTimeout(step, STEP_MS);
        else cb();
      }, STEP_MS);
      // 低速モード: ミニオンのマスを緑系でフラッシュ → 短い間 → 攻撃発動
      if (TELEGRAPH) {
        const fromAnchor = _minionScreenAnchor(ev.minion);
        const elColor = SKILL_ELEMENT_COLOR[ev.minion.element] ?? '#66bb6a';
        if (fromAnchor) showAttackTelegraph(fromAnchor, elColor, PRE_FLASH);
        dungeonLog(`${ev.minion.emoji} ${ev.minion.name} が攻撃の構え…`);
        setTimeout(() => {
          _animateMinionAttack(ev);
          if (ev.killed) {
            _maybeRecruitMinion(ev.mob);
            dungeon.removeMonster(ev.mob);
            gainXp(_xpFromMonster(ev.mob));
          }
          next();
        }, PRE_FLASH);
      } else {
        _animateMinionAttack(ev);
        if (ev.killed) {
          _maybeRecruitMinion(ev.mob);
          dungeon.removeMonster(ev.mob);
          gainXp(_xpFromMonster(ev.mob));
        }
        next();
      }
    };
    step();
  };

  // ミニオン攻撃で地図エンカウントの最後の 1 体を倒した場合はここでクリア確定。
  // playEnemyTurn を進めても残敵が居ないので 0 件 magic で終わる無駄を省きつつ、
  // 「敵ターン後に画面遷移したい」UX を即座に満たす。
  const playEnemyTurn = () => {
    if (_maybeMapBattleClear()) { _clearBusy(); return; }
    const result = dungeon.tickEnemies(player);
    const magics = result.events.filter(e => e.type === 'magic');
    dungeon.render(document.getElementById('dungeon-canvas'));
    if (magics.length === 0) { _clearBusy(); return; }

    let i = 0;
    const apply = () => {
      if (player.hp <= 0) { _clearBusy(); return; }
      const ev = magics[i++];
      if (!ev) { _clearBusy(); return; }

      const fire = () => {
        // hit=false（外れ）の場合はダメージ無し + MISS フロート + 専用ログ
        if (ev.hit === false) {
          dungeonLog(`💨 ${ev.mob.name} の魔法攻撃が外れた！`);
          const playerAt = playerVfxAnchor();
          if (playerAt) showMissAt({ left: playerAt.left + 18, top: playerAt.top + 8, width: 0, height: 0 });
          if (i < magics.length) setTimeout(apply, STEP_MS);
          else _clearBusy();
          return;
        }
        player.hp = Math.max(0, player.hp - ev.dmg);
        showFloatingDamage(ev.dmg);
        playSfx('damage');
        const mobScreen = _mobScreenAnchor(ev.mob);
        if (mobScreen) attackTrail(mobScreen, playerVfxAnchor(), { element: ev.mob.element });
        magicCircle(playerVfxAnchor(), ev.mob.element);
        shockwave(playerVfxAnchor(), { color: 'rgba(255,82,82,0.6)' });
        const matchup = elementMatchup(ev.mob.element, player.armor?.element);
        if (matchup >= 1.5) _showWeaknessBanner('弱点ヒット!!');
        dungeonLog(`✨ ${ev.mob.name} の魔法攻撃！ ${ev.dmg} ダメージ${matchup >= 1.5 ? '　弱点!!' : ''}`);
        // 命中時の状態異常付与（dungeon.tickEnemies が ev.inflict に乗せた）。
        if (ev.inflict && player.hp > 0) {
          _applyStatusToPlayer(ev.inflict.kind, { turns: ev.inflict.turns, stacks: ev.inflict.stacks });
        }
        refreshHUD();
        if (player.hp <= 0) {
          setTimeout(() => showResult(false), 350);
          _clearBusy();
          return;
        }
        if (i < magics.length) setTimeout(apply, STEP_MS);
        else _clearBusy();
      };

      // 低速モードでは攻撃前にテレグラフ + 詳細ログ → PRE_FLASH 後に発動
      if (TELEGRAPH) {
        const mobScreen = _mobScreenAnchor(ev.mob);
        const elColor = SKILL_ELEMENT_COLOR[ev.mob.element] ?? '#ff7043';
        if (mobScreen) showAttackTelegraph(mobScreen, elColor, PRE_FLASH);
        dungeonLog(`📢 ${ev.mob.name} が魔法を構えた…（${ev.mob.element}属性）`);
        setTimeout(fire, PRE_FLASH);
      } else {
        fire();
      }
    };
    apply();
  };

  playMinionAttacks(playEnemyTurn);
}

// ミニオン位置のスクリーン中心アンカー（VFX 用）
function _minionScreenAnchor(mi) {
  if (!dungeon || !mi) return null;
  const canvas = document.getElementById('dungeon-canvas');
  if (!canvas) return null;
  const r = canvas.getBoundingClientRect();
  // VIEW/ts は zoom に応じて動的に変わるので dungeon が最後の render で残した
  // 値を使う（未設定なら従来の 11/55 互換でフォールバック）。
  const VIEW = dungeon._viewTiles ?? 11;
  const half = Math.floor(VIEW / 2);
  const ts   = dungeon._tileSize ?? (canvas.width / VIEW);
  const px = dungeon.playerPos.x;
  const py = dungeon.playerPos.y;
  const tx = mi.x - (px - half);
  const ty = mi.y - (py - half);
  if (tx < 0 || tx >= VIEW || ty < 0 || ty >= VIEW) return null;
  return {
    left: r.left + tx * ts + ts / 2 - 16,
    top:  r.top  + ty * ts + ts / 2 - 16,
    width: 32, height: 32,
  };
}

// ミニオンの攻撃 1 件を画面に演出する（プレイヤー側演出 _bumpMeleeAttack の簡略版）
function _animateMinionAttack(ev) {
  const fromAnchor = _minionScreenAnchor(ev.minion);
  const toAnchor   = _mobScreenAnchor(ev.mob);
  const elColor = SKILL_ELEMENT_COLOR[ev.minion.element] ?? '#66bb6a';

  // 外し: 攻撃トレイルだけ出して MISS フロート + ログ
  if (ev.hit === false) {
    if (fromAnchor && toAnchor) {
      attackTrail(fromAnchor, toAnchor, { color: elColor });
    }
    if (toAnchor) showMissAt({ left: toAnchor.left + 18, top: toAnchor.top + 8, width: 0, height: 0 });
    dungeonLog(`💨 ${ev.minion.emoji} ${ev.minion.name} の攻撃が外れた…`);
    return;
  }

  if (fromAnchor && toAnchor) {
    attackTrail(fromAnchor, toAnchor, { color: elColor });
  }
  if (toAnchor) {
    sparkSpray(toAnchor, { color: elColor, count: 10 });
    const kind = ev.matchup >= 1.5 ? 'effective' : ev.matchup <= 0.7 ? 'weak' : 'normal';
    showDamageAt(toAnchor, ev.dmg, { kind });
    if (ev.matchup >= 1.5) {
      explosion(toAnchor, { color: elColor });
      _showWeaknessBanner(`WEAKNESS!`);
      screenShake(8, 220);
    }
    if (ev.killed) deathBurst(toAnchor, { color: ev.mob.rarityColor ?? '#ff7043' });
  }
  playSfx('hit');
  const mtxt = matchupLabel(ev.matchup);
  dungeonLog(`${ev.minion.emoji} ${ev.minion.name} の攻撃！ ${ev.mob.name} に ${ev.dmg} ダメージ${mtxt ? '　' + mtxt : ''}`);
  if (ev.killed) {
    dungeonLog(`${ev.minion.emoji} ${ev.minion.name} が ${ev.mob.name} を倒した！`);
  }
}

// 弱点ヒット時のフルスクリーンバナー（800ms で自動消去）
let _weaknessBannerTimer = null;
function _showWeaknessBanner(text = 'WEAKNESS!') {
  const el = document.getElementById('weakness-banner');
  if (!el) return;
  el.innerHTML = `<div class="wb-text">${text}</div>`;
  el.classList.remove('hidden');
  hitFlash({ color: 'rgba(255,213,79,0.45)' });
  if (_weaknessBannerTimer) clearTimeout(_weaknessBannerTimer);
  _weaknessBannerTimer = setTimeout(() => {
    el.classList.add('hidden');
    el.innerHTML = '';
    _weaknessBannerTimer = null;
  }, 800);
}

// ダンジョン上のモンスターのスクリーン中心座標を取り出す（攻撃方向矢印用）。
// 視野外（描画されていない）モンスターは null を返す。
function _mobScreenAnchor(mob) {
  if (!dungeon || !mob) return null;
  const canvas = document.getElementById('dungeon-canvas');
  if (!canvas) return null;
  const r = canvas.getBoundingClientRect();
  const VIEW = dungeon._viewTiles ?? 11;
  const half = Math.floor(VIEW / 2);
  const ts   = dungeon._tileSize ?? (canvas.width / VIEW);
  const px = dungeon.playerPos.x;
  const py = dungeon.playerPos.y;
  const tx = mob.x - (px - half);
  const ty = mob.y - (py - half);
  if (tx < 0 || tx >= VIEW || ty < 0 || ty >= VIEW) return null;
  return {
    left: r.left + tx * ts + ts / 2 - 16,
    top:  r.top  + ty * ts + ts / 2 - 16,
    width: 32, height: 32,
  };
}

function pickupItem(item) {
  // ゴールドはインベントリスロットを消費しない、即時加算
  if (item.type === 'gold') {
    dungeon.removeFloorItem(item);
    player.gold = (player.gold ?? 0) + item.amount;
    dungeonLog(`🪙 ${item.amount} ゴールドを拾った（合計 ${player.gold}）`);
    playSfx('pickup', { rarityTier: 0 });
    refreshHUD();
    autoSave();
    return;
  }

  // 素材：床に直接ドロップした場合も素材ボックス直行（持ち物を消費しない）。
  if (item.type === 'material') {
    dungeon.removeFloorItem(item);
    addToMaterials(item);
    playSfx('pickup', { rarityTier: rarityTier(item.rarity) });
    dungeonLog(`🧰 ${item.name} を素材ボックスに収納`, { rarity: item.rarity });
    refreshHUD();
    dungeon.render(document.getElementById('dungeon-canvas'));
    autoSave();
    return;
  }

  // 宝箱：踏むと自動でストレージへ。鍵で開けるまで持ち物 8 枠を圧迫しないようにする。
  // 中身を取り出すにはストレージ側の「鍵で開ける」ボタンから（_openChestFromStorage）。
  // 仕様変更履歴: 旧 1: 踏んだ瞬間に中身が床に出る → 旧 2: 持ち物枠を消費する → 新: ストレージ直行。
  if (item.type === 'chest') {
    dungeon.removeFloorItem(item);
    const r = addToStorage({ ...item });
    if (!r.ok) { dungeonLog('📦 ストレージへの収納に失敗'); return; }
    playSfx('pickup', { rarityTier: rarityTier(item.rarity) });
    dungeonLog(`🎁 宝箱をストレージへ収納（メニューの📦から鍵で開ける）`, { rarity: item.rarity });
    refreshHUD();
    refreshMenu();
    dungeon.render(document.getElementById('dungeon-canvas'));
    autoSave();
    return;
  }

  // 装備品は装備に置き換えられる可能性があるので満杯でも拾う（古い装備が
  // 持ち物に押し戻される時に追加で空きが必要にはなるが、その時点で再評価）。
  // 非装備で持ち物に入れられない場合はここで弾く。
  if (item.type !== 'weapon' && item.type !== 'armor' && !canAddToInventory(item)) {
    dungeonLog(`🎒 満杯！ ${item.name} を拾えなかった`);
    return;
  }

  dungeon.removeFloorItem(item);
  playSfx('pickup', { rarityTier: rarityTier(item.rarity) });

  let action = '拾った';
  if (item.type === 'weapon') {
    if (!player.weapon || item.atkBonus > player.weapon.atkBonus) {
      const old = player.weapon;
      player.weapon = item;
      player.atk    = player.atkBase + item.atkBonus;
      dungeonLog(`⚔️ ${item.name} を装備！ ATK+${item.atkBonus}`, { rarity: item.rarity });
      if (old) addToInventory(old);
      action = '装備';
    } else {
      const r = addToInventory(item);
      if (!r.ok) { dungeonLog(`🎒 満杯！ ${item.name} を拾えなかった`); return; }
      dungeonLog(`🎒 ${item.name} を拾った`, { rarity: item.rarity });
    }
  } else if (item.type === 'armor') {
    if (!player.armor || item.defBonus > player.armor.defBonus) {
      const old = player.armor;
      player.armor = item;
      player.def   = player.defBase + item.defBonus;
      dungeonLog(`🛡️ ${item.name} を装備！ DEF+${item.defBonus}`, { rarity: item.rarity });
      if (old) addToInventory(old);
      action = '装備';
    } else {
      const r = addToInventory(item);
      if (!r.ok) { dungeonLog(`🎒 満杯！ ${item.name} を拾えなかった`); return; }
      dungeonLog(`🎒 ${item.name} を拾った`, { rarity: item.rarity });
    }
  } else {
    const r = addToInventory(item);
    if (!r.ok) { dungeonLog(`🎒 満杯！ ${item.name} を拾えなかった`); return; }
    dungeonLog(`🎒 ${item.name} を拾った${r.stacked ? '（同種を持っていたのでまとめた）' : ''}`, { rarity: item.rarity });
  }
  _celebratePickup(item, action);

  refreshHUD();
  dungeon.render(document.getElementById('dungeon-canvas'));
  autoSave();
}

// D-パッド（8方向＋待機）
const DPAD_DIRS = {
  'up-left':    [-1, -1],
  'up':         [ 0, -1],
  'up-right':   [ 1, -1],
  'left':       [-1,  0],
  'wait':       [ 0,  0],
  'right':      [ 1,  0],
  'down-left':  [-1,  1],
  'down':       [ 0,  1],
  'down-right': [ 1,  1],
};
// 長押し連続移動: 矢印キー / D-pad ボタンを押し続けると一定間隔で移動を続ける。
// _turnBusy が立っている間は move() 側で握りつぶされるので、敵ターン中の連打が
// 演出を破壊することはない。OS の auto-repeat に頼らず JS 側で間隔を制御する
// ことで、ブラウザ差分（Safari の 30Hz / Chrome の 50Hz）を吸収する。
const HOLD_DELAY_MS    = 320;    // 押下から自動リピートを始めるまでの待ち
const HOLD_INTERVAL_MS = 180;    // 自動リピート間隔（_turnBusy 中はスキップ）
const _hold = { dir: null, startTimer: null, repeatTimer: null };

function _holdStart(dx, dy) {
  // 既に同じ方向を保持しているなら何もしない（同じ key が連続 keydown する OS の挙動向け）
  if (_hold.dir && _hold.dir[0] === dx && _hold.dir[1] === dy) return;
  _holdStop();
  _hold.dir = [dx, dy];
  // 起動時は即移動。HOLD_DELAY_MS 経過後にリピート開始。
  move(dx, dy);
  _hold.startTimer = setTimeout(() => {
    _hold.repeatTimer = setInterval(() => {
      if (!_hold.dir) return;
      if (screen !== 'dungeon') return;
      // _turnBusy 中は move() が早期 return するので空打ちでも安全。
      move(_hold.dir[0], _hold.dir[1]);
    }, HOLD_INTERVAL_MS);
  }, HOLD_DELAY_MS);
}

function _holdStop() {
  _hold.dir = null;
  if (_hold.startTimer)  { clearTimeout (_hold.startTimer);  _hold.startTimer  = null; }
  if (_hold.repeatTimer) { clearInterval(_hold.repeatTimer); _hold.repeatTimer = null; }
}

// D-pad: pointerdown で長押し開始、pointerup/leave で停止。click は廃止（重複発火を防ぐ）。
document.querySelectorAll('.dpad-btn').forEach(btn => {
  const d = DPAD_DIRS[btn.dataset.dir];
  if (!d) return;
  // 待機ボタン (0,0) は単発タップのみで OK（長押しで「待機を連打」しても無意味）
  const isWait = d[0] === 0 && d[1] === 0;
  if (isWait) {
    btn.addEventListener('click', () => move(0, 0));
    return;
  }
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    _holdStart(d[0], d[1]);
  });
  // pointerup / cancel / leave のいずれでも停止する（指を滑らせて外した場合の保険）
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
    btn.addEventListener(ev, () => _holdStop()));
});
// キーボード（PC確認用、8方向対応 + 技クイックバー 1〜4）
const _KEY_DIRS = {
  ArrowUp:[0,-1], ArrowDown:[0,1], ArrowLeft:[-1,0], ArrowRight:[1,0],
  w:[0,-1], s:[0,1], a:[-1,0], d:[1,0],
  q:[-1,-1], e:[1,-1], z:[-1,1], c:[1,1],
  Q:[-1,-1], E:[1,-1], Z:[-1,1], C:[1,1],
};
document.addEventListener('keydown', e => {
  if (screen !== 'dungeon') return;
  // 1〜4 で技スロットを発動（PC からのデバッグ動作確認用）
  if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') {
    const idx = parseInt(e.key, 10) - 1;
    const sk  = (player.skillSlots ?? [])[idx];
    if (sk) { e.preventDefault(); _executeSkill(sk); }
    return;
  }
  if (e.key === ' ') { e.preventDefault(); move(0, 0); return; }   // 待機
  const dir = _KEY_DIRS[e.key];
  if (!dir) return;
  e.preventDefault();
  // OS の auto-repeat（e.repeat）は JS 側のリピートと競合するので無視。
  // 初回 keydown だけを長押し開始トリガにする。
  if (e.repeat) return;
  _holdStart(dir[0], dir[1]);
});
document.addEventListener('keyup', e => {
  const dir = _KEY_DIRS[e.key];
  if (!dir) return;
  // 別の方向に切り替え途中で離されるパターンに備え、現在保持している方向と
  // 一致した時だけ停止（diff キーが残っているなら継続）。
  if (_hold.dir && _hold.dir[0] === dir[0] && _hold.dir[1] === dir[1]) {
    _holdStop();
  }
});
// 画面非表示やフォーカスアウトでも止める（タブ切り替え中に動き続けないように）
window.addEventListener('blur',         () => _holdStop());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) _holdStop();
});

// スワイプ（モバイル）
let touchStart = null;
const canvas = document.getElementById('dungeon-canvas');
canvas.addEventListener('touchstart', e => {
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
canvas.addEventListener('touchend', e => {
  if (!touchStart) return;
  const dx = e.changedTouches[0].clientX - touchStart.x;
  const dy = e.changedTouches[0].clientY - touchStart.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (Math.max(adx, ady) < 20) { touchStart = null; return; }

  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const ratio = Math.min(adx, ady) / Math.max(adx, ady);

  let mx, my;
  if (ratio > 0.4) {
    // 縦横の比が近ければ斜め
    mx = sx; my = sy;
  } else if (adx > ady) {
    mx = sx; my = 0;
  } else {
    mx = 0; my = sy;
  }
  move(mx, my);
  touchStart = null;
}, { passive: true });

// ─────────────────────────────────────────────
// バトル（インライン化：戦闘パネルは廃止し、ダンジョン上で全完結）
//   ・近接バンプ攻撃: 敵マスに向かって 1 マス前進すると 1 撃殴る
//   ・壁越し攻撃:     斜め隣で壁角越しにいる敵に弱魔法を当てる（無 MP）
//   ・技:             方向キーで向きを決め、技ボタンで向きに合わせて発射
// ─────────────────────────────────────────────

// 撃破した mob が試練ダンジョンの「ミニオン王」（recruitMinionId 持ち）なら、
// そのミニオンを仲間として player.minions に追加する。
//   - 重複はスキップ（同じミニオンは何度も生成しない）
//   - 仲間化レベル: ボスのレベル ÷ 2（最低 1）にして、初期では弱めに合流
//   - ダンジョン中なら現フロアの dungeon.minions にも即追加し、その場で共闘開始
function _maybeRecruitMinion(mob) {
  if (!mob || !mob.recruitMinionId) return;
  if (!Array.isArray(player.minions)) player.minions = [];
  if (player.minions.some(m => m.id === mob.recruitMinionId)) {
    dungeonLog(`✨ ${mob.name} は既に仲間にいる（重複追加なし）`);
    return;
  }
  const startLv  = Math.max(1, Math.floor((mob.level ?? 1) / 2));
  const recruit  = makeMinion(mob.recruitMinionId, startLv);
  if (!recruit) return;
  player.minions.push(recruit);

  // ダンジョン中ならその場で実体化（プレイヤーの隣に空きマス探して配置）
  if (dungeon && Array.isArray(dungeon.minions)) {
    const px = dungeon.playerPos.x;
    const py = dungeon.playerPos.y;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
    let placed = null;
    for (const [dx, dy] of dirs) {
      const x = px + dx, y = py + dy;
      if (!dungeon.canWalk(x, y)) continue;
      if (dungeon.monsterAt(x, y)) continue;
      if (dungeon.minions.some(m => m.x === x && m.y === y)) continue;
      placed = { x, y };
      break;
    }
    if (placed) {
      dungeon.minions.push({ ...recruit, x: placed.x, y: placed.y });
    }
  }

  dungeonLog(`🌸 ${recruit.emoji} ${recruit.name} が仲間になった！`, { rarity: 'レジェンド' });
  showItemBanner({
    name:        `${recruit.name} が仲間に！`,
    rarity:      'レジェンド',
    rarityColor: '#ffc107',
    emoji:       recruit.emoji,
    level:       recruit.level,
  }, { action: '仲間化' });
  playSfx('levelup');
}

// 共通：撃破処理（XP・ドロップ・ボスならクリア）。Battle.onEnd の win 分岐の流用
function _handleMonsterDefeated(mob) {
  // PvP アリーナで相手プレイヤーを倒した場合は通常のドロップ等は出さず、
  // Firestore 側の state=finished に任せる（既に submitArenaAttack 内で更新済）。
  if (mob?.isPvpOpponent) {
    dungeon.removeMonster(mob);
    return;
  }
  // 協力モードの共有ボスも同様: Firestore で勝敗が決まるのでドロップ無し
  if (mob?.isCoopBoss) {
    dungeon.removeMonster(mob);
    return;
  }
  _maybeRecruitMinion(mob);
  dungeon.removeMonster(mob);

  // 商人撃破: 在庫を全て床にぶちまける + 大量ゴールド
  if (mob.isShopkeeper || dungeon.shopkeeperToStock?.has(mob)) {
    const stock = dungeon.getShopStock(mob);
    for (const entry of stock) {
      // _placeFloorDrop が他の床アイテムを避けて配置するので、商人の在庫が
      // 全部同じマスに重なる旧バグも自動で解消される。
      _placeFloorDrop({ ...entry.item }, mob.x, mob.y);
    }
    dungeon.shopkeeperToStock?.delete(mob);
    const bonus = 500 + (mob.level ?? 30) * 30;
    player.gold = (player.gold ?? 0) + bonus;
    dungeonLog(`💰 商人を撃破！ ${bonus} ゴールドと在庫すべてが床に...`, { rarity: 'レジェンド' });
  }

  gainXp(_xpFromMonster(mob));

  const gold = rollGoldDropFromMonster(mob);
  if (gold > 0) {
    if (mob.isBoss) {
      player.gold = (player.gold ?? 0) + gold;
      dungeonLog(`🪙 ${mob.name} から ${gold} ゴールドを得た`);
      refreshHUD();
    } else {
      _placeFloorDrop(makeGoldFloorItem(gold), mob.x, mob.y);
      dungeonLog(`🪙 ${mob.name} は ${gold} ゴールドを落とした`);
    }
  }

  const mat = _rollMaterialDrop(mob);
  if (mat) _autoCollectDrop(mat);

  // 鍵ドロップ（宝箱を開ける主経路）
  const keyDrop = _rollKeyDrop(mob);
  if (keyDrop) _autoCollectDrop(keyDrop);

  const drop = _rollMonsterDrop(mob);
  if (drop) {
    if (mob.isBoss) {
      _autoCollectDrop(drop);
    } else {
      _placeFloorDrop(drop, mob.x, mob.y);
      dungeonLog(`💎 ${mob.name} は ${drop.name} を落とした！`, { rarity: drop.rarity });
      playSfx('drop', { rarityTier: rarityTier(drop.rarity) });
      _celebratePickup(drop, 'ドロップ');
    }
  } else {
    dungeonLog(`${mob.name} を倒した！`);
  }

  if (mob.isBoss) {
    dungeonClear();
    return;
  }
  // 防御策: 地図エンカウント由来の 1 ルーム戦闘でフラグだけ消えてしまった場合
  // （セーブから復元した時等）でも、生存敵 0 なら必ずクリア扱いにして地図に戻す。
  if (dungeonData?.isMapBattle &&
      (dungeon.monsters ?? []).filter(m => m.hp > 0 && !m.isShopkeeper).length === 0) {
    dungeonClear();
  }
}

// 敵マス座標 → スクリーンアンカー（VFX 用）
function _enemyAnchor(mob) {
  return _mobScreenAnchor(mob);
}

// 物理バンプ近接攻撃。単発打撃 → 命中 VFX → 1 呼吸の間 → 死亡判定 → 敵ターン
function _bumpMeleeAttack(mob) {
  const matchup = elementMatchup(player.weapon?.element, mob.element);
  const base = Math.max(1, player.atk - mob.def);
  const roll = 1 + Math.floor(Math.random() * Math.ceil(base * 0.4));
  const dmg  = Math.floor((base + roll) * matchup);
  const isCrit      = dmg >= Math.max(2, Math.floor((player.atk - mob.def) * 1.4 * matchup));
  const isEffective = matchup >= 1.5;
  const isWeak      = matchup <= 0.7;
  mob.hp = Math.max(0, mob.hp - dmg);
  const matchLbl = matchupLabel(matchup);
  dungeonLog(`⚔️ ${mob.name} に ${dmg} ダメージ${matchLbl ? '　' + matchLbl : ''}`);

  const enemyAt = _enemyAnchor(mob);
  const elColor = SKILL_ELEMENT_COLOR[player.weapon?.element] ?? null;
  const playerAt = playerVfxAnchor();
  if (enemyAt && playerAt) attackTrail(playerAt, enemyAt, { color: elColor ?? '#ffd54f' });
  const dmgKind = isCrit ? 'crit' : isEffective ? 'effective' : isWeak ? 'weak' : 'normal';
  if (enemyAt) showDamageAt(enemyAt, dmg, { kind: dmgKind });
  playSfx(isCrit ? 'crit' : 'hit');
  if (isCrit) {
    hitFlash({ color: 'rgba(255,213,79,0.55)' });
    screenShake(10, 320);
    if (enemyAt) explosion(enemyAt, { color: elColor ?? '#ff7043' });
    if (enemyAt) sparkSpray(enemyAt, { count: 18, color: '#fff' });
  } else if (isEffective) {
    screenShake(8, 260);
    if (enemyAt) explosion(enemyAt, { color: elColor ?? '#ffd54f' });
    if (enemyAt) sparkSpray(enemyAt, { color: elColor ?? '#ffd54f', count: 18 });
    _showWeaknessBanner('WEAKNESS!');
  } else if (enemyAt) {
    sparkSpray(enemyAt, { color: elColor ?? '#ffd54f', count: 10 });
  }

  if (mob.hp <= 0) {
    if (enemyAt) deathBurst(enemyAt, { color: mob.rarityColor ?? '#ff7043' });
    if (mob.isPvpOpponent) {
      // PvP: 致命傷を相手側に通知。state=finished に切り替わる
      _pvpSendAttackAction(dmg, 0);
    } else if (mob.isCoopBoss) {
      // 協力モード: ボス撃破を Firestore に通知（state=finished + cause=bossKilled）
      _pvpSendBossDamage(0, dmg);
    }
    _handleMonsterDefeated(mob);
    refreshHUD();
    if (!mob.isBoss) requestAnimationFrame(() => dungeon.render(document.getElementById('dungeon-canvas')));
    return;
  }

  refreshHUD();
  dungeon.render(document.getElementById('dungeon-canvas'));
  // PvP アリーナ: ダメージを相手側に通知してターン交代
  if (mob.isPvpOpponent) {
    _pvpSendAttackAction(dmg, mob.hp);
    return;
  }
  // 協力モード: 共有ボスへのダメージを Firestore で同期（ターン交代も）
  if (mob.isCoopBoss) {
    _pvpSendBossDamage(mob.hp, dmg);
    return;
  }
  // 1 呼吸の間（演出が見える時間を確保）→ 敵ターン
  setTimeout(() => _runEnemyTurn(), 220);
}

// 壁角越しの斜めバンプ → 弱体魔法（無 MP）。プレイヤーは移動しない
function _wallPiercingAttack(mob) {
  const matchup = elementMatchup(player.weapon?.element, mob.element);
  const base = Math.max(1, Math.floor(player.atk * 0.6) - mob.def);
  const dmg = Math.max(1, Math.floor((base + Math.floor(Math.random() * Math.max(1, base * 0.4))) * matchup));
  mob.hp = Math.max(0, mob.hp - dmg);
  const matchLbl = matchupLabel(matchup);
  dungeonLog(`✨ 壁越しの魔弾！ ${mob.name} に ${dmg} ダメージ${matchLbl ? '　' + matchLbl : ''}`);

  const enemyAt = _enemyAnchor(mob);
  const playerAt = playerVfxAnchor();
  const elColor = SKILL_ELEMENT_COLOR[player.weapon?.element] ?? '#b070dd';
  if (enemyAt && playerAt) attackTrail(playerAt, enemyAt, { color: elColor });
  if (enemyAt) {
    magicCircle(enemyAt, player.weapon?.element ?? '闇');
    setTimeout(() => explosion(enemyAt, { color: elColor }), 200);
    showDamageAt(enemyAt, dmg, { kind: matchup >= 1.5 ? 'effective' : 'normal' });
  }
  playSfx('hit');

  if (mob.hp <= 0) {
    if (enemyAt) deathBurst(enemyAt, { color: mob.rarityColor ?? '#ff7043' });
    _handleMonsterDefeated(mob);
    refreshHUD();
    if (!mob.isBoss) requestAnimationFrame(() => dungeon.render(document.getElementById('dungeon-canvas')));
    return;
  }

  refreshHUD();
  dungeon.render(document.getElementById('dungeon-canvas'));
  _runEnemyTurn();
}

// 画面サイズ変動時にも canvas を追従させる
window.addEventListener('resize', () => {
  if (dungeon && screen === 'dungeon') {
    dungeon.render(document.getElementById('dungeon-canvas'));
  }
});

// 持ち物 / ストレージの鍵を 1 本消費して、宝箱を開ける共通ヘルパ。
//   src: 'inv' | 'sto'
//   - 鍵が無ければ「鍵が必要」ダイアログを出して中断
//   - 開いたら宝箱を該当 list から除去し、中身を addToInventory
//     （持ち物が満杯ならストレージに流す）
async function _openChestAt(src, idx) {
  const list = src === 'inv' ? player.inventory : player.storage;
  const item = list?.[idx];
  if (!item || item.type !== 'chest') return;
  const inner = item.inner;
  if (!inner) {
    showAlert('中身が空っぽの宝箱でした…');
    list.splice(idx, 1);
    refreshMenu();
    autoSave();
    return;
  }
  // 鍵を持っているか（inventory + storage）から数える。最寄りの 1 本を消費。
  const keyLocations = [];
  (player.inventory ?? []).forEach((it, i) => {
    if (it?.type === 'key') keyLocations.push({ src: 'inv', i });
  });
  (player.storage ?? []).forEach((it, i) => {
    if (it?.type === 'key') keyLocations.push({ src: 'sto', i });
  });
  if (keyLocations.length === 0) {
    showAlert('🗝️ 宝箱を開ける鍵を持っていません。\n敵を倒すかバーコードをスキャンすると鍵が手に入ることがあります。');
    return;
  }
  // 開ける確認モーダルでも中身は明かさない（レアリティと所持鍵だけ）。
  // 中身は開封時の演出で初公開して「ガチャを引いた瞬間」感を作る。
  const chestRarity = item.rarity ?? inner.rarity ?? 'コモン';
  const ok = await showConfirm(
    `🎁 ${chestRarity}の宝箱を 🗝️ 鍵 1 本で開けますか？\n\n` +
    `中身は開けてからのお楽しみ。\n所持鍵: ${keyLocations.length} 本`,
    { okLabel: '開ける' },
  );
  if (!ok) return;

  // 鍵 1 本を所定の場所から消費
  const keySlot = keyLocations[0];
  const keyArr  = keySlot.src === 'inv' ? player.inventory : player.storage;
  const k = keyArr[keySlot.i];
  if ((k.count ?? 1) > 1) k.count -= 1;
  else keyArr.splice(keySlot.i, 1);

  // 宝箱を消費して中身を獲得
  list.splice(idx, 1);
  // chest の中身は装備品が中心。持ち物が満杯のときはストレージへ流す。
  let stowed = false;
  if (canAddToInventory(inner)) {
    addToInventory({ ...inner });
  } else {
    addToStorage({ ...inner });
    stowed = true;
  }
  // 開封演出: 宝箱のレアリティ（中身レアリティ）に応じた段階別フィーバー。
  // _celebrateChestOpen がフラッシュ・シェイク・スパーク・爆発を組み合わせて派手にする。
  _celebrateChestOpen(inner);
  if (screen === 'dungeon') {
    dungeonLog(`🎁 宝箱を開けた！ ${inner.name} ${stowed ? 'をストレージへ' : 'を獲得'}`, { rarity: inner.rarity });
  }
  refreshMenu();
  refreshHUD();
  autoSave();
}

// 宝箱開封結果モーダル。OK ボタンを押すまで閉じない明示ダイアログ。
// レア度別の縁色 + アイテム情報（名前・レア度・Lv・基本ステ）を見やすく出す。
const _RARITY_KEY = { 'コモン':'common', 'レア':'rare', 'エピック':'epic', 'レジェンド':'legendary' };
const _RARITY_TAG = { 'コモン':'🎁 COMMON', 'レア':'✨ RARE', 'エピック':'💎 EPIC', 'レジェンド':'🏆 LEGENDARY' };
function _showChestResultModal(inner) {
  if (!inner) return;
  const modal = document.getElementById('chest-result-modal');
  const box   = document.getElementById('chest-result-box');
  if (!modal || !box) return;
  const rarityKey = _RARITY_KEY[inner.rarity] ?? 'common';
  // クラスを差し替え（前回の rarity-* を全部剥がしてから付け直す）
  box.classList.remove('rarity-common','rarity-rare','rarity-epic','rarity-legendary');
  box.classList.add('rarity-' + rarityKey);
  document.getElementById('chest-result-tag').textContent  = _RARITY_TAG[inner.rarity] ?? '🎁 GET';
  document.getElementById('chest-result-icon').innerHTML   = iconImg(inner, 80);
  const nameEl = document.getElementById('chest-result-name');
  nameEl.textContent = inner.name;
  nameEl.style.color = inner.rarityColor ?? '#fff';
  const lv = inner.level ? ` / Lv${inner.level}` : '';
  document.getElementById('chest-result-meta').textContent = `${inner.rarity}${lv}`;
  document.getElementById('chest-result-stat').textContent = _statLine(inner) || '';
  modal.classList.remove('hidden');
}
document.getElementById('btn-chest-result-ok')?.addEventListener('click', () => {
  document.getElementById('chest-result-modal')?.classList.add('hidden');
  playSfx('click');
});
// 背景タップでも閉じる（誤爆少なめ）
document.getElementById('chest-result-modal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'chest-result-modal') {
    e.target.classList.add('hidden');
    playSfx('click');
  }
});

// 宝箱開封の専用演出。レア度ごとに派手さを段階的に上げる：
//   コモン   - 軽いキラキラ + ピックアップ SFX
//   レア     - フラッシュ + 中量スパーク + crit SFX
//   エピック - 大量スパーク + 爆発 + シェイク + フラッシュ + crit SFX
//   レジェンド- 全力フィーバー（多段ウェーブ + シェイク + 大爆発 + levelup SFX）
// _celebratePickup より「開封」に特化していて、コモン/レアでも演出が出る。
function _celebrateChestOpen(inner) {
  if (!inner) return;
  const rarity = inner.rarity ?? 'コモン';
  // 画面中央 + プレイヤー位置の 2 点をアンカーに使う
  const cx = (window.innerWidth ?? 360) / 2;
  const cy = (window.innerHeight ?? 600) / 2;
  const centerAnchor = { left: cx - 12, top: cy - 12, width: 24, height: 24 };
  const playerAt = playerVfxAnchor() ?? centerAnchor;
  // 開封結果モーダル: アイテム名・レア度・基本ステータスを「OK 押すまで居座る」
  // 形でちゃんと見せる。トースト型 banner はメニュー(z=5500) の裏に隠れるケースが
  // あるので、専用の z=6000 モーダルで確実に通知する。
  _showChestResultModal(inner);
  // バナーも併発（ダンジョン中は派手さの足し。force:true でコモンも表示）。
  showItemBanner(inner, { action: '宝箱から', force: true });

  if (rarity === 'コモン') {
    sparkSpray(centerAnchor, { count: 12, color: '#ffd54f' });
    sparkSpray(playerAt,     { count: 6,  color: '#ffd54f' });
    playSfx('pickup', { rarityTier: rarityTier(rarity) });
    return;
  }
  if (rarity === 'レア') {
    hitFlash({ color: 'rgba(77,196,255,0.30)' });
    screenShake(4, 180);
    sparkSpray(centerAnchor, { count: 18, color: '#4dc4ff' });
    sparkSpray(centerAnchor, { count: 8,  color: '#fff' });
    sparkSpray(playerAt,     { count: 10, color: '#4dc4ff' });
    playSfx('crit');
    return;
  }
  if (rarity === 'エピック') {
    hitFlash({ color: 'rgba(171,71,188,0.40)' });
    screenShake(8, 280);
    explosion(centerAnchor, { color: '#ce93d8' });
    sparkSpray(centerAnchor, { count: 26, color: '#ce93d8' });
    sparkSpray(centerAnchor, { count: 12, color: '#fff' });
    sparkSpray(playerAt,     { count: 16, color: '#ba68c8' });
    playSfx('crit');
    setTimeout(() => {
      sparkSpray(centerAnchor, { count: 14, color: '#e1bee7' });
      playSfx('pickup', { rarityTier: rarityTier(rarity) });
    }, 360);
    return;
  }
  // レジェンド: フィーバー総力戦
  hitFlash({ color: 'rgba(255,213,79,0.55)' });
  screenShake(14, 480);
  explosion(centerAnchor, { color: '#ffd54f' });
  sparkSpray(centerAnchor, { count: 36, color: '#ffd54f' });
  sparkSpray(centerAnchor, { count: 20, color: '#fff' });
  sparkSpray(playerAt,     { count: 18, color: '#ffd54f' });
  playSfx('crit');
  // 0.3s 後の 2 波目
  setTimeout(() => {
    explosion(centerAnchor, { color: '#fff176' });
    sparkSpray(centerAnchor, { count: 24, color: '#ffe082' });
    sparkSpray(playerAt,     { count: 14, color: '#fff176' });
    playSfx('levelup');
  }, 320);
  // 0.7s 後の最後のキラキラ
  setTimeout(() => {
    sparkSpray(centerAnchor, { count: 18, color: '#fff' });
    sparkSpray(playerAt,     { count: 12, color: '#fff' });
    playSfx('victory');
  }, 720);
}

// 旧 API 互換: 持ち物 idx の宝箱を開ける（旧セーブで持ち物に居る宝箱用）
function _openChestFromInventory(idx) { return _openChestAt('inv', idx); }
// 新仕様: ストレージ idx の宝箱を開ける（拾い物の宝箱はここから）
function _openChestFromStorage(idx)   { return _openChestAt('sto', idx); }

// モンスター撃破時の素材ドロップ（装備ドロップと独立）。15% で発生し、
// モンスターのレアリティに対応した素材 1 個。合成・ショップで使う想定。
function _rollMaterialDrop(mob) {
  const dbg = getDebugState();
  const chance = dbg.forceDrop ? 1 : 0.15;
  if (Math.random() > chance) return null;
  return materialForRarity(mob.rarity);
}

// 鍵ドロップ。宝箱を開ける主経路。レアリティと「ボスかどうか」で確率を上げる。
// ボスは確定 1 本（ボス部屋で必ず 1 つ宝箱を開けられる安心感）。
//   コモン雑魚 6% / レア 12% / エピック 22% / レジェンド 35% / ボス 100%
// 既存の _rollMonsterDrop / _rollMaterialDrop と独立で、複数ドロップが乗っても OK。
function _rollKeyDrop(mob) {
  const dbg = getDebugState();
  if (mob.isBoss) return makeKey();
  const chance = dbg.forceDrop ? 1 :
    mob.rarity === 'レジェンド' ? 0.35 :
    mob.rarity === 'エピック'   ? 0.22 :
    mob.rarity === 'レア'       ? 0.12 :
    0.06;
  if (Math.random() > chance) return null;
  return makeKey();
}

// モンスター撃破時のドロップ判定。
// 仕様変更: 雑魚からは武器/防具を出さない（消耗品のみ）。
// 装備の主経路はフロアの宝箱とボスドロップに集約。
function _rollMonsterDrop(mob) {
  const dbg = getDebugState();
  // 雑魚のドロップ率も全体的に下げる（40→25 / 50→35 / 70→55 / 95→90）
  const dropChance = dbg.forceDrop ? 1 :
    mob.isBoss               ? 1.0 :
    mob.rarity === 'レジェンド' ? 0.55 :
    mob.rarity === 'エピック'   ? 0.40 :
    mob.rarity === 'レア'       ? 0.25 :
    0.15;
  if (Math.random() > dropChance) return null;

  const seed = hashString(`drop:${dungeonData.seed}:${currentFloor}:${mob.x}:${mob.y}`);
  const code = String(seed).padStart(13, '0').slice(0, 13);

  const baseRarity = RARITIES.find(r => r.name === mob.rarity);
  let rarityOverride = baseRarity ?? null;
  if (mob.isBoss && baseRarity) rarityOverride = bumpRarity(baseRarity, 1);
  const itemLevel = (mob.level ?? 1) + (mob.isBoss ? 5 : 0);

  if (mob.isBoss) {
    // ボスは武器/防具を含む全種から（ボスドロップは装備獲得の主経路）
    return generateItemFromBarcode(code, rarityOverride, itemLevel);
  }
  // 雑魚は消耗品（potion/scroll）に強制（武器/防具は宝箱・ボス専用）
  const wantPotion = (Math.random() < 0.6);
  const adjusted = forceTypeBarcode(code, wantPotion ? 2 : 3);
  return generateItemFromBarcode(adjusted, rarityOverride, itemLevel);
}

// 旧戦闘パネルの 4 ボタン（こうげき/スキル/アイテム/にげる）は廃止。
// 代わりに：方向キーで向き → 同方向で前進（敵に当たればバンプ近接）、
// 1〜4 キー or わざバーで技を発射（向きに合わせて回転）。
// アイテム使用は街/メニューから（ダンジョン内では持ち物 → 使う）。

// ─────────────────────────────────────────────
// クリア / ゲームオーバー
// ─────────────────────────────────────────────
function dungeonClear() {
  clearedSet.add(dungeonData.seed);
  refreshPin(dungeonData.seed);
  // 地図エンカウント由来の 1 ルーム戦闘なら、エンカウントを消費して
  // 同じ場所のピンを今後出さない。dungeonData.encounterSeed に元の seed を載せている。
  if (dungeonData?.isMapBattle && dungeonData.encounterSeed) {
    _markEncounterConsumed(dungeonData.encounterSeed);
  }
  showResult(true);
  autoSave();
}

function showResult(isWin) {
  if (!isWin && entrySnapshot) {
    // 敗北：ダンジョンで拾った装備・アイテム・回復薬・素材をすべてロールバック。
    // ストレージは入場前から触っていないので据え置き。
    player.inventory   = entrySnapshot.inventory;
    player.consumables = entrySnapshot.consumables ?? [];
    player.materials   = entrySnapshot.materials;
    player.weapon      = entrySnapshot.weapon;
    player.armor       = entrySnapshot.armor;
    player.atk         = entrySnapshot.atk;
    player.def         = entrySnapshot.def;
  }
  player.hp = player.maxHp;       // マップ復帰時は全回復
  player.statuses = [];           // ダンジョン外では状態異常も全解除
  _refreshStatusOverlay();
  entrySnapshot = null;

  show('result');
  // 1 ルーム戦闘ステージ（地図エンカウント由来）はダンジョン踏破とは別の文脈なので
  // 「攻略成功」より「撃破成功」の方が体感に合う。本文も短く倒した相手を讃える。
  const isMapBattle = !!dungeonData?.isMapBattle;
  document.getElementById('result-icon').textContent  = isWin ? '🎉' : '💀';
  document.getElementById('result-title').textContent = isWin
    ? (isMapBattle ? '撃破成功！' : '攻略成功！')
    : 'ゲームオーバー';
  document.getElementById('result-body').textContent  = isWin
    ? (isMapBattle
        ? `${dungeonData.name} に勝利した！`
        : `${dungeonData.name} を踏破した！\n（再挑戦可）`)
    : (isMapBattle
        ? '敗北...\nこの戦闘で拾ったものは失われた'
        : 'ダンジョンで力尽きた...\nこのダンジョンで拾ったものは失われた');
  playSfx(isWin ? 'victory' : 'defeat');
  autoSave();
}

document.getElementById('btn-result-back').addEventListener('click', () => {
  playSfx('click');
  show('map');
  autoSave();
});

// ─────────────────────────────────────────────
// ログイン / セーブ（Firebase Auth + Firestore）
// ─────────────────────────────────────────────
let _authUid = null;
let _isLoadingSave = false;

function autoSave() {
  if (!_authUid || _isLoadingSave) return;
  saveData(_authUid, {
    player: {
      level: player.level,
      xp: player.xp,
      hp: player.hp,
      maxHp: player.maxHp,
      mp: player.mp,
      maxMp: player.maxMp,
      atkBase: player.atkBase,
      defBase: player.defBase,
      atk: player.atk,
      def: player.def,
      weapon: player.weapon,
      armor: player.armor,
      inventory:   player.inventory,
      consumables: player.consumables ?? [],
      storage:     player.storage     ?? [],
      materials:   player.materials   ?? [],
      statuses:    player.statuses    ?? [],   // 罹患中の状態異常も保持（ダンジョン途中ログアウト対応）
      gold:       player.gold       ?? 0,
      platinum:   player.platinum   ?? 0,
      scanBudget: player.scanBudget ?? null,
      type:          player.type ?? null,
      learnedSkills: player.learnedSkills ?? [],
      skillSlots:    player.skillSlots    ?? [null, null, null, null],
      // 旧セーブ互換のため skills も併記（読み込み側でマイグレートする）
      skills:        player.learnedSkills ?? [],
      // ミニオンは座標 x,y を持つ場合があるが永続データには不要なので落とす
      minions:    (player.minions ?? []).map(({ x, y, ...rest }) => rest),
    },
    clearedSeeds: Array.from(clearedSet),
    savedAt: Date.now(),
  });
  _updateDebugSaveStatus();
}

function _applySave(data) {
  if (!data || !data.player) return;
  // フィールドの取り残しを防ぐため初期化してから上書き
  player = createPlayer();
  Object.assign(player, data.player);
  // 旧セーブ互換: storage / materials / minions / consumables が無いケース
  if (!Array.isArray(player.storage))     player.storage     = [];
  if (!Array.isArray(player.materials))   player.materials   = [];
  if (!Array.isArray(player.consumables)) player.consumables = [];
  if (!Array.isArray(player.minions))     player.minions     = [];
  if (typeof player.gold !== 'number') player.gold = 0;
  // 旧セーブで持ち物・ストレージに混ざっていた素材を素材ボックスへ移送
  _migrateMaterialsFromOldSlots(player);
  // 旧セーブで持ち物に入っていた回復薬を consumables へ移送（容量無制限化）。
  // ストレージ内の回復薬は触らない（手動で出し入れする運用前提）。
  _migrateConsumablesFromInventory(player);
  // 旧セーブ互換: maxMp / mp が未設定 → レベル相当の値を埋め込み
  if (typeof player.maxMp !== 'number') player.maxMp = statsForLevel(player.level || 1).maxMp;
  if (typeof player.mp    !== 'number') player.mp    = player.maxMp;
  // 旧セーブ互換: platinum / scanBudget の正規化（日次リセットも内側で実施）
  ensureScanBudget(player);
  // 旧属性（棒人間/落書き等の手描き属性 or さらに古い 地/風 等）を
  // 新属性（火/水/草/雷/光/闇）にマイグレート
  _migrateItemElements(player);
  // 旧セーブのスタック未対応データを集約（count 付与 + 同種重複統合）
  _consolidateStacks(player);
  // 旧セーブ互換: player.skills のみ存在 → learnedSkills + skillSlots へ展開
  _migrateSkillFields(player);
  // ミニオンも learnedSkills / skillSlots を持つようリハイドレート
  player.minions = (player.minions ?? [])
    .map(m => rehydrateMinion(m))
    .filter(Boolean);
  clearedSet.clear();
  if (Array.isArray(data.clearedSeeds)) {
    for (const s of data.clearedSeeds) clearedSet.add(s);
  }
  // 既存ユーザーがレベルだけ高くタイプ別技を持っていない場合のキャッチアップ:
  // タイプが設定されていれば現在レベルまでのプライマリ属性技を一括習得する。
  // バナーは出さず（ロード時に大量通知が出ないように）静かに揃える。
  _autoLearnWizardSkills({ silent: true, slotAuto: false });
  refreshHUD();
}

// 旧セーブ互換: player.skills（4 個までの装備中技配列）→
// learnedSkills + skillSlots（4 スロット）へ展開する。
//   さらに旧 pattern: 'A'..'F' を新範囲タイプ ID（CROSS / ADJ / LINE3 / TERRAIN_5X5 /
//   LINE_INF / ROOM）に正規化する。
function _migrateSkillFields(p) {
  if (!Array.isArray(p.skillSlots) || p.skillSlots.length !== 4) {
    p.skillSlots = [null, null, null, null];
  }
  if (!Array.isArray(p.learnedSkills)) p.learnedSkills = [];
  if (Array.isArray(p.skills) && p.skills.length > 0) {
    for (const sk of p.skills) {
      if (!sk?.id) continue;
      if (!p.learnedSkills.find(x => x.id === sk.id)) {
        p.learnedSkills.push({ ...sk });
      }
    }
    // 旧セーブの skills の並びをそのままスロットに反映（先頭 4 個）
    for (let i = 0; i < 4; i++) {
      const src = p.skills[i];
      if (src && !p.skillSlots[i]) p.skillSlots[i] = { ...src };
    }
  }
  // 旧 pattern を新範囲タイプ ID に置換
  const fixPattern = (sk) => {
    if (!sk) return;
    sk.pattern = normalizeRangeType(sk.pattern);
  };
  for (const s of p.learnedSkills) fixPattern(s);
  for (const s of p.skillSlots)    fixPattern(s);
  // ミニオン側も同様に migrate
  for (const mi of (p.minions ?? [])) {
    for (const s of (mi.learnedSkills ?? [])) fixPattern(s);
    for (const s of (mi.skillSlots    ?? [])) fixPattern(s);
  }
  // 旧 skills フィールドを削除（保存時の冗長を防ぐ）
  delete p.skills;
}

// 旧セーブの素材を持ち物・ストレージから取り出して、新しい素材ボックスへ移動する。
// 移動後はインベントリ枠が空き、既存ユーザーが「持ち物満杯」になる事故を防げる。
function _migrateMaterialsFromOldSlots(p) {
  if (!Array.isArray(p.materials)) p.materials = [];
  for (const arrName of ['inventory', 'storage']) {
    const arr = p[arrName];
    if (!Array.isArray(arr)) continue;
    for (let i = arr.length - 1; i >= 0; i--) {
      const it = arr[i];
      if (it?.type !== 'material') continue;
      arr.splice(i, 1);
      _addToList(p.materials, it, null);
    }
  }
}

// 旧セーブで持ち物に混ざっていた回復薬（potion / mpPotion）を consumables ボックスへ移送。
// ストレージは整理用なので触らない。スタックは _consolidateStacks がこの後で集約する。
function _migrateConsumablesFromInventory(p) {
  if (!Array.isArray(p.consumables)) p.consumables = [];
  const inv = p.inventory;
  if (!Array.isArray(inv)) return;
  for (let i = inv.length - 1; i >= 0; i--) {
    const it = inv[i];
    if (!_isConsumableType(it)) continue;
    inv.splice(i, 1);
    _addToList(p.consumables, it, null);
  }
}

// 旧属性表記のアイテムを新属性表記にインプレースで書き換える。
// ELEMENT_LEGACY_MAP に該当しない値はスルー（既に新表記）。アイコンは新表記の
// element をキーにキャッシュされるため、書き換え後の getItemIconUrl は自動で
// 新カラーで再描画される。
function _migrateItemElements(p) {
  const fix = it => {
    if (!it) return;
    if (it.element) it.element = migrateElement(it.element);
    if (it.skill?.element) it.skill.element = migrateElement(it.skill.element);
  };
  fix(p.weapon);
  fix(p.armor);
  for (const it of p.inventory ?? []) fix(it);
  for (const it of p.storage   ?? []) fix(it);
}

function _setError(msg) {
  const el = document.getElementById('title-error');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// メールログイン
document.getElementById('btn-title-login').addEventListener('click', async () => {
  const email = document.getElementById('title-email').value.trim();
  const pw    = document.getElementById('title-password').value;
  if (!email || !pw) { _setError('メールとパスワードを入力してください'); return; }
  try {
    _setError(null);
    await signInEmail(email, pw);
  } catch (e) {
    _setError('ログイン失敗: ' + (e.code || e.message));
  }
});

// メール新規登録
document.getElementById('btn-title-signup').addEventListener('click', async () => {
  const email = document.getElementById('title-email').value.trim();
  const pw    = document.getElementById('title-password').value;
  if (!email || !pw) { _setError('メールとパスワードを入力してください'); return; }
  if (pw.length < 6) { _setError('パスワードは6文字以上が必要です'); return; }
  try {
    _setError(null);
    await signUpEmail(email, pw);
  } catch (e) {
    _setError('新規登録失敗: ' + (e.code || e.message));
  }
});

// Google ログイン
document.getElementById('btn-title-google').addEventListener('click', async () => {
  try {
    _setError(null);
    await signInGoogle();
  } catch (e) {
    _setError('Google ログイン失敗: ' + (e.code || e.message));
  }
});

// ログアウト
document.getElementById('btn-logout').addEventListener('click', async () => {
  const ok = await showConfirm('ログアウトしますか？（クラウドのセーブは残ります）');
  if (!ok) return;
  autoSave();
  document.getElementById('menu-modal').classList.add('hidden');
  await signOutUser();
});

// auth state 監視：ログイン状態変化に追従
subscribeAuth(async user => {
  if (user) {
    _authUid = user.uid;
    _isLoadingSave = true;
    const data = await loadSave(user.uid);
    if (data) {
      _applySave(data);
    } else {
      // 初回ログイン：新規プレイヤー作成
      player = createPlayer();
      clearedSet.clear();
    }
    _isLoadingSave = false;
    // 初回ログイン後または日付跨ぎ後のリセット反映（_applySave 内でも呼ぶが保険）
    ensureScanBudget(player);
    show('map');
    refreshHUD();
    _updateDebugSaveStatus();
    // 初回ログインの場合のみ初期セーブ書き込み
    if (!data) autoSave();
  } else {
    _authUid = null;
    player = createPlayer();
    clearedSet.clear();
    show('title');
    _updateDebugSaveStatus();
  }
});

// 設定未投入時の警告表示
if (!isFirebaseConfigured()) {
  document.getElementById('title-config-warning').classList.remove('hidden');
}

// メニューの「プラチナ結晶を購入（テスト）」ボタン。
// TODO: 本番では Stripe / Apple IAP / Google Play Billing に差し替え。
document.getElementById('btn-buy-platinum').addEventListener('click', async () => {
  const ok = await showConfirm(
    `プラチナ結晶を購入しますか？\n\n` +
    `※ テストビルドのため購入ボタンで ${PLATINUM_STUB_GRANT} 個付与（実決済は未実装）`,
    { okLabel: `${PLATINUM_STUB_GRANT}個購入`, cancelLabel: 'キャンセル' },
  );
  if (!ok) return;
  addPlatinum(player, PLATINUM_STUB_GRANT);
  autoSave();
  refreshMenu();
  await showAlert(`💎${PLATINUM_STUB_GRANT} を付与しました（テストビルド）`);
});

// ページを離れる時に保険として最後の保存
window.addEventListener('beforeunload', () => {
  autoSave();
});

// ─────────────────────────────────────────────
// デバッグパネル（?debug=1 で有効）
// ─────────────────────────────────────────────
if (DEBUG) {
  const panel = document.getElementById('debug-panel');
  panel.classList.remove('hidden');

  // 折り畳み（panel 自体にも collapsed を付けて幅を縮める）
  document.getElementById('debug-toggle').addEventListener('click', () => {
    const panel = document.getElementById('debug-panel');
    const body  = document.getElementById('debug-panel-body');
    const btn   = document.getElementById('debug-toggle');
    panel.classList.toggle('collapsed');
    const collapsed = body.classList.toggle('collapsed');
    btn.textContent = collapsed ? '+' : '−';
  });

  // モックスキャン
  document.getElementById('debug-mock-scan').addEventListener('click', () => {
    if (screen === 'dungeon') {
      showAlert('ダンジョン内ではスキャンできません（マップに戻ってから）');
      return;
    }
    const text   = document.getElementById('debug-scan-text').value.trim();
    const format = document.getElementById('debug-scan-format').value;
    if (!/^\d{8,20}$/.test(text)) {
      showAlert('バーコードは数字8〜20桁で入力してください');
      return;
    }
    stopScanner();
    const category = categoryOfFormat(format);
    const scanResult = { text, format, category };
    const item = _itemFromScan(scanResult);
    pendingItem = item;
    show('scanner');
    _showItemResult(item, scanResult);
  });

  // モックGPS
  document.getElementById('debug-set-gps').addEventListener('click', () => {
    const lat = document.getElementById('debug-gps-lat').value;
    const lng = document.getElementById('debug-gps-lng').value;
    if (!setMockGps(lat, lng)) {
      showAlert('緯度経度の入力が不正です');
      return;
    }
    const m = getDebugState().mockGps;
    setPlayerPosition(m.lat, m.lng);
    document.getElementById('debug-gps-status').textContent =
      `モック中: ${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`;
  });
  document.getElementById('debug-clear-gps').addEventListener('click', () => {
    clearMockGps();
    document.getElementById('debug-gps-status').textContent = '実GPSを使用中（次回のGPS更新で反映）';
  });

  // 入場距離バイパス
  document.getElementById('debug-bypass').addEventListener('change', e => {
    setBypassEnterRadius(e.target.checked);
  });

  // 敵AI停止
  document.getElementById('debug-disable-ai').addEventListener('change', e => {
    setDisableEnemyAI(e.target.checked);
  });

  // ダンジョン全可視化（切り替え時に再描画）
  document.getElementById('debug-reveal').addEventListener('change', e => {
    setRevealAll(e.target.checked);
    if (dungeon && screen === 'dungeon') {
      dungeon.render(document.getElementById('dungeon-canvas'));
    }
  });

  // ドロップ強制
  document.getElementById('debug-force-drop').addEventListener('change', e => {
    setForceDrop(e.target.checked);
  });

  // 隣接敵を即時撃破（ドロップ判定は通る）
  document.getElementById('debug-kill-adj').addEventListener('click', () => {
    if (!dungeon || screen !== 'dungeon') {
      showAlert('ダンジョン探索中のみ実行可能です');
      return;
    }
    const px = dungeon.playerPos.x;
    const py = dungeon.playerPos.y;
    const adj = dungeon.monsters.filter(m =>
      m.hp > 0 &&
      Math.abs(m.x - px) <= 1 && Math.abs(m.y - py) <= 1 &&
      !(m.x === px && m.y === py),
    );
    if (adj.length === 0) {
      showAlert('隣接する敵がいません');
      return;
    }
    for (const mob of adj) {
      _maybeRecruitMinion(mob);
      dungeon.removeMonster(mob);
      gainXp(_xpFromMonster(mob));
      const gold = rollGoldDropFromMonster(mob);
      if (gold > 0) {
        _placeFloorDrop(makeGoldFloorItem(gold), mob.x, mob.y);
        dungeonLog(`🪙 ${mob.name} は ${gold} ゴールドを落とした`);
      }
      const drop = _rollMonsterDrop(mob);
      if (drop) {
        _placeFloorDrop(drop, mob.x, mob.y);
        dungeonLog(`💎 ${mob.name} は ${drop.name} を落とした！`, { rarity: drop.rarity });
        playSfx('drop', { rarityTier: rarityTier(drop.rarity) });
        _celebratePickup(drop, 'ドロップ');
      } else {
        dungeonLog(`${mob.name} を撃破`);
      }
    }
    dungeon.render(document.getElementById('dungeon-canvas'));
  });

  // 道端エンカウント強制スポーン（プレイヤーから 30m 北にピンを出す）
  // 4 種類の動作確認用。グリッドの決定論には載らないので、押すたびに別個体になる。
  const _spawn = (kind) => {
    const ok = debugSpawnEncounter(kind);
    if (!ok) showAlert('GPS 位置がまだ取得できていません（数秒後に再試行）');
  };
  document.getElementById('debug-spawn-monster')?.addEventListener('click',  () => _spawn('monster'));
  document.getElementById('debug-spawn-strong')?.addEventListener('click',   () => _spawn('strong'));
  document.getElementById('debug-spawn-chest')?.addEventListener('click',    () => _spawn('chest'));
  document.getElementById('debug-spawn-merchant')?.addEventListener('click', () => _spawn('merchant'));

  // インベントリ操作（バーコードを type / rarity 確定の組合せで決め打ち）
  const DEBUG_ITEM_CODES = {
    weapon: {
      コモン:     '0000000000000',
      レア:       '1000000000007',
      エピック:   '0000000000008',
      レジェンド: '3000000000009',
    },
    armor: {
      コモン:     '0000000000001',
      レア:       '0000000000005',
      エピック:   '1000000000008',
      レジェンド: '0000000000009',
    },
    potion: {
      コモン:     '0000000000002',
      レア:       '1000000000005',
      エピック:   '2000000000008',
      レジェンド: '1000000000009',
    },
    scroll: {
      コモン:     '0000000000003',
      レア:       '0000000000007',
      エピック:   '3000000000008',
      レジェンド: '2000000000009',
    },
  };
  const RARITY_NAMES = ['コモン', 'レア', 'エピック', 'レジェンド'];

  function debugAddItem(type) {
    const rarity = RARITY_NAMES[Math.floor(Math.random() * RARITY_NAMES.length)];
    const code   = DEBUG_ITEM_CODES[type][rarity];
    const item   = generateItemFromBarcode(code);

    // 何も装備していない場合は自動装備（インベントリには入れない）
    if (item.type === 'weapon' && !player.weapon) {
      player.weapon = item;
      player.atk    = player.atkBase + item.atkBonus;
    } else if (item.type === 'armor' && !player.armor) {
      player.armor  = item;
      player.def    = player.defBase + item.defBonus;
    } else {
      if (player.inventory.length >= 8) {
        showAlert('インベントリ満杯です（先に廃棄）');
        return;
      }
      player.inventory.push(item);
    }
    refreshHUD();
    if (!document.getElementById('menu-modal').classList.contains('hidden')) refreshMenu();
  }

  document.getElementById('debug-add-weapon').addEventListener('click', () => debugAddItem('weapon'));
  document.getElementById('debug-add-armor' ).addEventListener('click', () => debugAddItem('armor'));
  document.getElementById('debug-add-potion').addEventListener('click', () => debugAddItem('potion'));
  document.getElementById('debug-add-scroll').addEventListener('click', () => debugAddItem('scroll'));

  // ゴールド操作
  document.getElementById('debug-gold-give').addEventListener('click', () => {
    const n = Math.max(1, parseInt(document.getElementById('debug-gold-amount').value, 10) || 0);
    player.gold = (player.gold ?? 0) + n;
    refreshHUD();
    if (!document.getElementById('menu-modal').classList.contains('hidden')) refreshMenu();
    autoSave();
  });
  document.getElementById('debug-gold-clear').addEventListener('click', () => {
    player.gold = 0;
    refreshHUD();
    if (!document.getElementById('menu-modal').classList.contains('hidden')) refreshMenu();
    autoSave();
  });

  // プラチナ結晶 / スキャン回数の操作
  document.getElementById('debug-platinum-give').addEventListener('click', () => {
    const n = Math.max(1, parseInt(document.getElementById('debug-platinum-amount').value, 10) || 0);
    addPlatinum(player, n);
    refreshHUD();
    if (!document.getElementById('menu-modal').classList.contains('hidden')) refreshMenu();
    autoSave();
  });
  document.getElementById('debug-scan-reset').addEventListener('click', () => {
    debugResetDailyScans(player);
    refreshHUD();
    if (!document.getElementById('menu-modal').classList.contains('hidden')) refreshMenu();
    autoSave();
  });

  document.getElementById('debug-clear-inv').addEventListener('click', async () => {
    const ok = await showConfirm('インベントリ・装備・ストレージを全廃棄します', { danger: true, okLabel: '全廃棄' });
    if (!ok) return;
    player.inventory = [];
    player.storage   = [];
    player.weapon = null;
    player.armor  = null;
    player.atk    = player.atkBase;
    player.def    = player.defBase;
    if (!document.getElementById('menu-modal').classList.contains('hidden')) refreshMenu();
    autoSave();
  });

  // レベル操作
  document.getElementById('debug-lv-up').addEventListener('click', () => {
    if (player.level >= MAX_LEVEL) { showAlert('既にLv MAX です'); return; }
    const n = Math.max(1, parseInt(document.getElementById('debug-lv-amount').value, 10) || 1);
    // n回連続で次レベル必要XPを補填
    for (let i = 0; i < n && player.level < MAX_LEVEL; i++) {
      const need = xpRequiredForLevel(player.level);
      gainXp(need - player.xp);
    }
  });

  document.getElementById('debug-lv-max').addEventListener('click', () => {
    player.level = MAX_LEVEL;
    player.xp    = 0;
    applyLevelStats(player);
    player.hp = player.maxHp;
    refreshHUD();
    if (!document.getElementById('menu-modal').classList.contains('hidden')) refreshMenu();
    showAlert(`Lv${MAX_LEVEL} に強制設定しました（HP/ATK/DEF 全更新）`);
  });

  document.getElementById('debug-lv-reset').addEventListener('click', async () => {
    const ok = await showConfirm('レベルとXPを Lv1 にリセットします', { danger: true, okLabel: 'リセット' });
    if (!ok) return;
    player.level = 1;
    player.xp    = 0;
    applyLevelStats(player);
    player.hp = player.maxHp;
    refreshHUD();
    if (!document.getElementById('menu-modal').classList.contains('hidden')) refreshMenu();
    autoSave();
  });

  // セーブ強制
  document.getElementById('debug-save-now').addEventListener('click', () => {
    const u = getCurrentAuthUser();
    if (!u) { showAlert('未ログインです'); return; }
    autoSave();
    showAlert(`セーブしました (${u.email || u.uid})`);
  });

  // 自分のセーブのみ削除（クラウド側）
  document.getElementById('debug-clear-all').addEventListener('click', async () => {
    const u = getCurrentAuthUser();
    if (!u) { showAlert('未ログインです'); return; }
    const ok = await showConfirm('クラウドの自分のセーブを消去してログアウトします。よろしいですか？', { danger: true, okLabel: '消去' });
    if (!ok) return;
    await deleteSave(u.uid);
    await signOutUser();
  });

  // ── 🎵 BGM テスト ──
  const bgmSelect = document.getElementById('debug-bgm-select');
  if (bgmSelect) {
    bgmSelect.innerHTML = ['(自動)', ...BGM_NAMES]
      .map(n => `<option value="${n === '(自動)' ? '' : n}">${n}</option>`)
      .join('');
    document.getElementById('debug-bgm-play').addEventListener('click', () => {
      const v = bgmSelect.value;
      if (!v) {
        _bgmForScreen(screen);
      } else {
        startBgm(v);
      }
    });
    document.getElementById('debug-bgm-stop').addEventListener('click', () => stopBgm());
  }

  // ── 🔊 SFX テスト ──
  const sfxSelect = document.getElementById('debug-sfx-select');
  if (sfxSelect) {
    sfxSelect.innerHTML = SFX_NAMES.map(n => `<option value="${n}">${n}</option>`).join('');
    document.getElementById('debug-sfx-play').addEventListener('click', () => {
      const tier = parseInt(document.getElementById('debug-sfx-rarity').value, 10) || 0;
      playSfx(sfxSelect.value, { rarityTier: tier });
    });
  }

  // ── 🖼 アイコンギャラリー ──
  document.getElementById('debug-icon-gallery').addEventListener('click', () => {
    showIconGallery();
  });
  document.getElementById('btn-gallery-close').addEventListener('click', () => {
    document.getElementById('icon-gallery-modal').classList.add('hidden');
  });

  // ── 🌸 ミニオン / 📖 伝説の書 デバッグ ──
  // ボタンは MINION_LIBRARY を見て動的生成。新ミニオンを追加すれば自動で並ぶ。
  function _refreshMinionDebugList() {
    const el = document.getElementById('debug-minion-list');
    if (!el) return;
    const list = (player.minions ?? []);
    if (list.length === 0) {
      el.textContent = '仲間: なし';
    } else {
      el.textContent = '仲間: ' + list.map(m => `${m.emoji}${m.name}(Lv${m.level})`).join(' / ');
    }
  }

  function _debugRecruitMinion(minionId) {
    if (!Array.isArray(player.minions)) player.minions = [];
    if (player.minions.some(m => m.id === minionId)) {
      showAlert('既に仲間にいます');
      return;
    }
    const lv  = Math.max(1, Math.floor((player.level ?? 1) / 2));
    const mi  = makeMinion(minionId, lv);
    if (!mi) return;
    player.minions.push(mi);
    // ダンジョン中なら現フロアにも実体化
    if (dungeon && Array.isArray(dungeon.minions)) {
      const px = dungeon.playerPos.x;
      const py = dungeon.playerPos.y;
      const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
      let placed = null;
      for (const [dx, dy] of dirs) {
        const x = px + dx, y = py + dy;
        if (!dungeon.canWalk(x, y)) continue;
        if (dungeon.monsterAt(x, y)) continue;
        if (dungeon.minions.some(m => m.x === x && m.y === y)) continue;
        placed = { x, y };
        break;
      }
      if (placed) dungeon.minions.push({ ...mi, x: placed.x, y: placed.y });
      dungeon.render(document.getElementById('dungeon-canvas'));
    }
    playSfx('levelup');
    _refreshMinionDebugList();
    autoSave();
  }

  function _debugGiveTome(minionId) {
    const tpl = findMinionTemplate(minionId);
    if (!tpl) return;
    if (!Array.isArray(player.inventory)) player.inventory = [];
    if (player.inventory.length >= 8) {
      showAlert('インベントリ満杯です（先に廃棄）');
      return;
    }
    player.inventory.push(makeLegendaryTome(tpl.id, tpl.fullName, tpl.element));
    playSfx('pickup', { rarityTier: 3 });
    if (!document.getElementById('menu-modal').classList.contains('hidden')) refreshMenu();
    autoSave();
  }

  function _debugEnterTrial(minionId) {
    const tpl = findMinionTemplate(minionId);
    if (!tpl) return;
    if (screen === 'dungeon') {
      showAlert('既にダンジョン内です');
      return;
    }
    // 書を消費せずに直接突入できるよう、ダミー tome を渡す（debug 専用）
    const fakeTome = { type: 'legendaryTome', minionId, name: `${tpl.fullName} の試練(debug)`, element: tpl.element };
    const data = buildSpecialDungeonForTome(fakeTome, tpl);
    playSfx('confirm');
    enterDungeon(data);
  }

  // 動的にボタンを生成
  const recruitBox = document.getElementById('debug-minion-recruit-buttons');
  const tomeBox    = document.getElementById('debug-tome-give-buttons');
  const trialBox   = document.getElementById('debug-trial-enter-buttons');
  for (const tpl of MINION_LIBRARY) {
    const recruitBtn = document.createElement('button');
    recruitBtn.className = 'debug-action';
    recruitBtn.textContent = `${tpl.emoji} ${tpl.name} 仲間化`;
    recruitBtn.addEventListener('click', () => _debugRecruitMinion(tpl.id));
    recruitBox.appendChild(recruitBtn);

    const tomeBtn = document.createElement('button');
    tomeBtn.className = 'debug-action';
    tomeBtn.textContent = `📖 ${tpl.name}書`;
    tomeBtn.addEventListener('click', () => _debugGiveTome(tpl.id));
    tomeBox.appendChild(tomeBtn);

    const trialBtn = document.createElement('button');
    trialBtn.className = 'debug-action ghost';
    trialBtn.textContent = `${tpl.emoji} ${tpl.name} 試練突入`;
    trialBtn.addEventListener('click', () => _debugEnterTrial(tpl.id));
    trialBox.appendChild(trialBtn);
  }

  document.getElementById('debug-minion-clear').addEventListener('click', async () => {
    const ok = await showConfirm('仲間ミニオンを全解除しますか？', { danger: true, okLabel: '全解除' });
    if (!ok) return;
    player.minions = [];
    if (dungeon) dungeon.minions = [];
    if (dungeon) dungeon.render(document.getElementById('dungeon-canvas'));
    _refreshMinionDebugList();
    autoSave();
  });

  _refreshMinionDebugList();
}

// アイコンギャラリー：4種別×4レアリティ×3属性のサンプルを並べて目視確認
function showIconGallery() {
  const grid = document.getElementById('icon-gallery-grid');
  grid.innerHTML = '';

  // items.js のルール:
  //   typeIdx = 全桁合計 % 4 (0=武器/1=防具/2=薬/3=巻物)
  //   rarity  = 末桁 (0-4=コモン / 5-7=レア / 8=エピック / 9=レジェンド)
  //   element = parseInt(slice(3,5)) % ELEMENTS.length
  // それぞれを保ったままバーコードを組み立て、digits[0] で type 補正を入れる
  function makeBarcode(typeIdx, rarityDigit, elemIdx) {
    const digits = Array(13).fill('0');
    const elStr  = String(elemIdx).padStart(2, '0');
    digits[3]  = elStr[0];
    digits[4]  = elStr[1];
    digits[12] = String(rarityDigit);
    let sum = 0;
    for (let i = 1; i < 13; i++) sum += Number(digits[i]);
    digits[0] = String(((typeIdx - sum) % 4 + 4) % 4);
    return digits.join('');
  }

  const types = [
    { idx: 0, label: '武器' },
    { idx: 1, label: '防具' },
    { idx: 2, label: '薬'   },
    { idx: 3, label: '巻物' },
  ];
  const rarities = [
    { name: 'コモン',     digit: 0 },
    { name: 'レア',       digit: 5 },
    { name: 'エピック',   digit: 8 },
    { name: 'レジェンド', digit: 9 },
  ];
  const elemSamples = [0, 2, 4]; // 火, 地, 光

  for (const t of types) {
    for (const r of rarities) {
      for (const elIdx of elemSamples) {
        const barcode = makeBarcode(t.idx, r.digit, elIdx);
        const item    = generateItemFromBarcode(barcode, null, 25);
        const cell = document.createElement('div');
        cell.className = 'gallery-cell';
        cell.innerHTML = `
          <img src="${getItemIconUrl(item, 64)}" width="56" height="56" />
          <div class="gallery-cell-name" style="color:${item.rarityColor}">${item.name}</div>
          <div class="gallery-cell-meta">${item.rarity} / Lv${item.level}</div>
        `;
        grid.appendChild(cell);
      }
    }
  }

  document.getElementById('icon-gallery-modal').classList.remove('hidden');
}

// デバッグパネルのセーブ状態表示
function _updateDebugSaveStatus() {
  const el = document.getElementById('debug-save-status');
  if (!el) return;
  const u = getCurrentAuthUser();
  if (u) {
    el.textContent = `ログイン中: ${u.email || 'Google: ' + (u.displayName ?? u.uid.slice(0, 6))}`;
  } else {
    el.textContent = '未ログイン';
  }
}

// ─────────────────────────────────────────────
// オンライン対戦 (PvP) - Phase 1: 招待コード式 1v1 ターン制
//   Firestore の pvpRooms/{code} に状態を載せて、両者で onSnapshot 同期する。
//   Phase 1 はテンポ重視の最小機能（こうげき/技/にげる）。
// ─────────────────────────────────────────────
let _pvpCode    = null;        // 6 桁ロビーコード
let _pvpRole    = null;        // 'host' | 'guest'
let _pvpUnsub   = null;        // watchRoom の unsubscribe
let _pvpData    = null;        // 最新のスナップショット
let _pvpEntered = false;       // バトル画面に入ったか

function _showPvpError(msg) {
  const el = document.getElementById('pvp-lobby-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function _resetPvpLobbyUI() {
  document.getElementById('pvp-lobby-actions').classList.remove('hidden');
  document.getElementById('pvp-lobby-room').classList.add('hidden');
  document.getElementById('pvp-lobby-error').classList.add('hidden');
  document.getElementById('pvp-lobby-code').textContent = '------';
  document.getElementById('pvp-lobby-players').innerHTML = '';
  const inp = document.getElementById('pvp-join-code');
  if (inp) inp.value = '';
}

function _enterPvpLobby() {
  _resetPvpLobbyUI();
  show('pvp-lobby');
}

function _leavePvpRoom() {
  _stopPvpHeartbeat();
  if (_pvpUnsub) { try { _pvpUnsub(); } catch {} _pvpUnsub = null; }
  if (_pvpCode) {
    const code = _pvpCode;
    if (_pvpRole === 'host') {
      // 退室時の挙動を状態別に分岐:
      //   finished → 30s 遅延 destroy（相手が結果を読む時間を確保）
      //   waiting+guestあり → ゲストを新ホストへ昇格（部屋は残す）
      //   battle → ゲスト不戦勝として finished に
      //   waiting+guestなし → 即 destroy
      if (_pvpData?.state === 'finished' || _pvpFinishShown) {
        setTimeout(() => { pvpDestroyRoom(code).catch(() => {}); }, 30000);
      } else if (_pvpData?.state === 'waiting' || _pvpData?.state === 'battle') {
        pvpHandleHostLeave(code).catch(err => console.warn('host leave failed:', err));
      } else {
        pvpDestroyRoom(code).catch(() => {});
      }
    } else if (_pvpRole === 'guest') {
      // ゲスト退室: 待機中なら guest 欄を空にする / 戦闘中ならホスト不戦勝
      pvpHandleGuestLeave(code).catch(err => console.warn('guest leave failed:', err));
    }
  }
  _pvpCode = null;
  _pvpRole = null;
  _pvpData = null;
  _pvpEntered = false;
  _pvpLastMyHp = null;
  _resetPvpLobbyUI();
  // ターン UI の後始末
  document.getElementById('pvp-turn-banner')?.classList.add('hidden');
  document.getElementById('dungeon-footer')?.classList.remove('pvp-foe-turn');
}

async function _pvpCreate() {
  const u = getCurrentAuthUser();
  if (!u) { _showPvpError('ログインが必要です'); return; }
  // ロビーのモードラジオから 'pvp' / 'coop' を取得
  const modeInput = document.querySelector('input[name="pvp-mode"]:checked');
  const mode = modeInput?.value === 'coop' ? 'coop' : 'pvp';
  const profile = buildPvpProfile(u.uid, u.displayName ?? u.email ?? 'プレイヤー', player, 'host', { mode });
  try {
    // 初期ボス: 先頭の候補。装備フォーマット: current（あとから host が変えられる）
    const code = await pvpCreateRoom(profile, { mode, pvpFormat: 'current', bossId: PVP_COOP_BOSSES[0].id });
    _pvpCode = code;
    _pvpRole = 'host';
    _pvpUnsub = pvpWatchRoom(code, _onPvpUpdate);
    document.getElementById('pvp-lobby-actions').classList.add('hidden');
    document.getElementById('pvp-lobby-room').classList.remove('hidden');
    document.getElementById('pvp-lobby-code').textContent = code;
  } catch (err) {
    _showPvpError(err?.message ?? '部屋作成に失敗');
  }
}

async function _pvpJoin() {
  const u = getCurrentAuthUser();
  if (!u) { _showPvpError('ログインが必要です'); return; }
  const inp = document.getElementById('pvp-join-code');
  const code = (inp?.value ?? '').trim();
  if (!/^\d{6}$/.test(code)) { _showPvpError('6 桁の数字を入力してください'); return; }
  // 参加時はまずベース profile を作る。joinRoom 側で部屋の mode/pvpFormat に合わせて
  // 位置や装備値を上書きする（player の生スナップショットも一緒に渡す）。
  const profile = buildPvpProfile(u.uid, u.displayName ?? u.email ?? 'プレイヤー', player, 'guest');
  try {
    await pvpJoinRoom(code, profile, { player });
    _pvpCode = code;
    _pvpRole = 'guest';
    _pvpUnsub = pvpWatchRoom(code, _onPvpUpdate);
    document.getElementById('pvp-lobby-actions').classList.add('hidden');
    document.getElementById('pvp-lobby-room').classList.remove('hidden');
    document.getElementById('pvp-lobby-code').textContent = code;
  } catch (err) {
    _showPvpError(err?.message ?? '参加に失敗');
  }
}

// 部屋スナップショットを受け取って UI を更新する。state に応じて
// 待機画面 / アリーナ突入 / 結果 を出し分ける。
function _onPvpUpdate(data) {
  if (!data) {
    // 部屋が削除された。
    // すでに勝敗が確定している（state==='finished'）か、こちらの結果ダイアログが
    // 表示中の場合は「離脱しました」アラートを出さない。勝者側が部屋を破棄した時に
    // 敗者側の勝敗ダイアログがこのアラートで上書きされて消えてしまう問題への対策。
    const wasFinished = _pvpData?.state === 'finished' || _pvpFinishShown;
    if (_pvpEntered && !wasFinished) {
      showAlert('対戦相手が部屋を離脱しました');
    }
    _leavePvpRoom();
    show(wasFinished ? 'map' : 'pvp-lobby');
    return;
  }
  // 役割昇格 / 譲渡の検知。自分の uid がどちらの slot に居るかで _pvpRole を更新。
  // 旧 host が離脱して自分（guest）が昇格、または手動譲渡で host/guest が入れ替わった場合に適用。
  const myUid = getCurrentAuthUser()?.uid;
  if (myUid && _pvpRole) {
    let newRole = null;
    if (data.host?.uid === myUid)        newRole = 'host';
    else if (data.guest?.uid === myUid)  newRole = 'guest';
    if (newRole && newRole !== _pvpRole) {
      const promoted = (newRole === 'host' && _pvpRole === 'guest');
      _pvpRole = newRole;
      // 昇格時のみ通知（譲渡された側にも譲渡した側にも分かりやすく）
      if (promoted) {
        dungeonLog?.('👑 ホスト権限を引き継ぎました');
        showAlert('👑 ホスト権限を引き継ぎました');
      } else {
        dungeonLog?.('👤 ホスト権限を譲渡しました（あなたはゲストです）');
      }
    }
  }
  const prev = _pvpData;
  _pvpData = data;
  // モード・装備形式の変更を検知して、自分の atk/def を再計算して Firestore へ反映。
  // 両クライアントがそれぞれ自分のぶんを書き戻すので idempotent。
  if (_pvpRole && data.state === 'waiting') {
    const modeChanged   = prev?.mode      !== data.mode;
    const formatChanged = prev?.pvpFormat !== data.pvpFormat;
    if (modeChanged || formatChanged) {
      _pvpReapplyOwnEquip(data.mode, data.pvpFormat).catch(() => {});
    }
  }
  if (data.state === 'waiting') {
    _renderPvpLobbyRoom(data);
  } else if (data.state === 'battle') {
    // 1 ルームアリーナへ突入。両者の初期位置はプロファイルに含まれている。
    if (!_pvpEntered) {
      _pvpEntered = true;
      _enterPvpArena(data);
    }
    _onPvpArenaUpdate(data);
    // ターン開始検知: 直前のターンが相手で、今回自分になった瞬間にだけ tick を走らせる
    const becameMine = (prev?.turn !== _pvpRole) && (data.turn === _pvpRole);
    if (becameMine) _onPvpMyTurnStart();
  } else if (data.state === 'finished') {
    _onPvpArenaUpdate(data);
    _showPvpFinished(data);
  }
}

// 自分のターンが開始されたタイミングで状態異常をひとつ進める。
// DoT (毒/熱傷) ダメージと持続ターンの減少が起こり、HP 0 になったら相手勝利。
// バフの残ターンも 1 減るので「3T で切れる atkUp」が正しく短くなる。
async function _onPvpMyTurnStart() {
  if (!Array.isArray(player.statuses) || player.statuses.length === 0) return;
  const tick = tickStatuses(player);
  if (tick.dotDamage > 0) {
    player.hp = Math.max(0, player.hp - tick.dotDamage);
    dungeonLog(`💥 状態異常で ${tick.dotDamage} ダメージ`);
    showFloatingDamage(tick.dotDamage);
    const playerAt = playerVfxAnchor();
    if (playerAt) shockwave(playerAt, { color: 'rgba(176,112,221,0.55)' });
  }
  for (const ex of tick.expired) {
    const def = STATUS_DEFS[ex.kind];
    if (def) dungeonLog(`✨ ${def.label} が解除された`);
  }
  refreshHUD();
  _refreshStatusOverlay();
  // tick 後の自分の状態を Firestore に反映
  try {
    const otherRole = _pvpRole === 'host' ? 'guest' : 'host';
    await pvpSubmitOwnState(_pvpCode, _pvpRole, {
      hp:       player.hp,
      atk:      player.atk,
      def:      player.def,
      statuses: player.statuses ?? [],
      otherUid: _pvpData?.[otherRole]?.uid,
    });
  } catch (err) {
    console.warn('PvP own-state sync (tick) failed:', err);
  }
}

// PvP アリーナへ突入: 既存の 1 ルーム戦闘ステージを使って、相手プレイヤーを
// 「リモート操作のモンスター」として配置する。tickEnemies は isPvpOpponent を
// 行動対象から除外しているので、相手側は AI ではなく Firestore のスナップショット
// 経由で位置 / HP が更新される。
// PvP 接続生存通知。8 秒ごとに自分の lastSeen を更新して、相手が長時間沈黙
// したら検知できるようにする。アリーナ突入で開始、退室で停止。
let _pvpHeartbeatTimer = null;
function _startPvpHeartbeat() {
  _stopPvpHeartbeat();
  if (!_pvpCode || !_pvpRole) return;
  pvpPingHeartbeat(_pvpCode, _pvpRole);
  _pvpHeartbeatTimer = setInterval(() => {
    if (!_pvpCode || !_pvpRole) { _stopPvpHeartbeat(); return; }
    pvpPingHeartbeat(_pvpCode, _pvpRole);
  }, 8000);
}
function _stopPvpHeartbeat() {
  if (_pvpHeartbeatTimer) clearInterval(_pvpHeartbeatTimer);
  _pvpHeartbeatTimer = null;
}

function _enterPvpArena(data) {
  const me  = data[_pvpRole];
  const foe = data[_pvpRole === 'host' ? 'guest' : 'host'];
  if (!me || !foe) return;
  _pvpLastMyHp = me.hp ?? null;     // 差分検知の初期値（最初は被弾扱いしない）
  // リマッチに備えて自分の状態異常 / バフを必ず初期化（前マッチの残骸を持ち越さない）
  player.statuses = [];
  _refreshStatusOverlay();
  _startPvpHeartbeat();
  // 相手プレイヤーをモンスターオブジェクトに変換（既存の dungeon 描画と
  // _bumpMeleeAttack を再利用するため、最小限のフィールドを揃える）
  // element = 相手の防具属性（こちらの攻撃の matchup 計算に使う）。
  // 武器属性で計算してしまうと「火属性の人が火属性の鎧を着ても自分が苦手な
  // 属性扱いになる」ような違和感が出るので、armor を採用する。
  const opponentMob = {
    base:  '対戦相手',
    emoji: foe.emoji ?? '🧙',
    name:  `${foe.name} Lv${foe.level}`,
    isBoss: true,                  // 撃破でクリア処理が走る
    isPvpOpponent: true,           // tickEnemies のスキップ対象
    rarity: 'レジェンド',
    rarityColor: '#ffd54f',
    element: foe.armorElement ?? foe.weaponElement ?? '火',
    skillCharge: 0,
    hp: foe.hp ?? foe.maxHp ?? 1,
    maxHp: foe.maxHp ?? 1,
    atk: foe.atk ?? 1,
    def: foe.def ?? 0,
    statuses: Array.isArray(foe.statuses) ? foe.statuses.map(s => ({ ...s })) : [],
    floor: 1,
    job: { id: 'pvp', label: 'PvP', aiHint: 'rush', preferredRange: 'ADJ', chargeBonus: 0 },
  };
  // 自分の現在 HP / MP を Firestore の最新値で同期
  player.hp = me.hp ?? player.maxHp;
  player.mp = me.mp ?? player.maxMp;
  // dungeon データを組み立て：1 ルーム + isMapBattle 互換 + PvP 専用フラグ
  const arena = {
    seed: 'pvp:' + (_pvpCode ?? Date.now()),
    barcode: '0000000000000',
    name: '🌐 タイマンアリーナ',
    theme: { name: 'アリーナ', wallColor: '#34344a', floorColor: '#14141c' },
    floors: 1,
    difficulty: 1,
    monsterTypeIdx: 0,
    elementIdx: 0,
    element: foe.weaponElement ?? '火',
    rarityBase: { name: 'レジェンド', color: '#ffd54f', mult: 4.2 },
    isMapBattle:   true,
    isSingleRoom:  true,
    isPvpArena:    true,
    encounterMonster: opponentMob,
    pvpRole: _pvpRole,
  };
  enterDungeon(arena);
  // 自分の初期向きを Firestore の値に合わせる
  if (dungeon?.playerPos && me.facing) {
    dungeon.playerPos.facing = me.facing.slice();
    dungeon.playerPos.x = me.x;
    dungeon.playerPos.y = me.y;
  }
  // 協力モード: 共有ボス NPC を盤面に追加（両プレイヤーから見える）。
  // isPvpOpponent ではなく isCoopBoss フラグで識別し、両者が攻撃可能にする。
  if (data.mode === 'coop' && data.boss) {
    const b = data.boss;
    dungeon.monsters.push({
      base: 'ボス',
      emoji: b.emoji ?? '🐉',
      name:  b.name ?? 'ボス',
      isBoss: false,
      isCoopBoss: true,
      rarity: 'レジェンド',
      rarityColor: '#ffd54f',
      element: b.element ?? '火',
      skillCharge: 0,
      hp: b.hp ?? 1,
      maxHp: b.maxHp ?? 1,
      atk: b.atk ?? 1,
      def: b.def ?? 0,
      x: b.x, y: b.y,
      floor: 1,
      job: { id: 'coopboss', label: 'ボス', aiHint: 'rush', preferredRange: 'ADJ', chargeBonus: 0 },
    });
  }
  // 相手モンスターの初期位置も同期
  _syncPvpOpponentToData(data);
  refreshHUD();
  if (dungeon) dungeon.render(document.getElementById('dungeon-canvas'));
}

// 相手プレイヤーの位置 / HP / atk / def / statuses を最新スナップショットに合わせて適用。
// 移動 / 攻撃 を受けるたびに呼ばれる。被弾検知して視覚フィードバックを出す。
let _pvpLastMyHp = null;     // 前回の自分 HP（差分検知でフラッシュ）
function _syncPvpOpponentToData(data) {
  if (!dungeon || !data) return;
  // 協力モード: 共有ボスの HP/位置 を反映（両者の攻撃が混ざる）
  if (data.mode === 'coop' && data.boss) {
    const localBoss = (dungeon.monsters ?? []).find(m => m?.isCoopBoss);
    if (localBoss) {
      localBoss.hp = data.boss.hp ?? localBoss.hp;
      localBoss.x  = data.boss.x  ?? localBoss.x;
      localBoss.y  = data.boss.y  ?? localBoss.y;
    }
  }
  const foe = data[_pvpRole === 'host' ? 'guest' : 'host'];
  if (!foe) return;
  const opp = (dungeon.monsters ?? []).find(m => m?.isPvpOpponent);
  if (!opp) return;
  opp.x = foe.x ?? opp.x;
  opp.y = foe.y ?? opp.y;
  opp.hp = foe.hp ?? opp.hp;
  // バフ込みの atk/def を相手側から共有（自分の攻撃ダメージ計算にも使われる）
  if (typeof foe.atk === 'number') opp.atk = foe.atk;
  if (typeof foe.def === 'number') opp.def = foe.def;
  // 状態異常 / バフを共有（dungeon.render が m.statuses を読んでアイコンを出す）
  if (Array.isArray(foe.statuses)) opp.statuses = foe.statuses.map(s => ({ ...s }));
  // 自分の HP / MP / 状態異常も最新化（相手が攻撃した結果が来るので必須）
  const me = data[_pvpRole];
  if (me) {
    if (typeof me.hp === 'number') {
      // 相手の攻撃で HP が下がった瞬間に視覚フィードバック
      if (_pvpLastMyHp != null && me.hp < _pvpLastMyHp) {
        const taken = _pvpLastMyHp - me.hp;
        const acts = data.actions ?? [];
        const last = acts.length > 0 ? acts[acts.length - 1] : null;
        const kindLabel = last?.kind === 'skill' ? '技' : 'こうげき';
        dungeonLog(`💥 相手の${kindLabel}！ ${taken} ダメージ`, { rarity: 'レア' });
        showFloatingDamage(taken);
        const playerAt = playerVfxAnchor();
        if (playerAt) shockwave(playerAt, { color: 'rgba(255,82,82,0.65)' });
        screenShake(taken > 20 ? 8 : 4, taken > 20 ? 280 : 160);
        hitFlash({ color: 'rgba(255,82,82,0.30)' });
        playSfx('damage');
      }
      player.hp = me.hp;
      _pvpLastMyHp = me.hp;
    }
    if (typeof me.mp === 'number') player.mp = me.mp;
    // 自分の statuses は基本的にローカルが正だが、相手が状態異常を付与したケースは
    // Firestore 経由で初めて来るので merge しておく。タイミング差で被ることはあるが
    // applyStatus が「同じ kind は turns max + stacks 加算」で吸収するので大事故は無し。
    if (Array.isArray(me.statuses)) {
      // 既存に無い kind を追加するだけ。ローカルの方が新しい場合は維持。
      const existing = new Set((player.statuses ?? []).map(s => s.kind));
      for (const s of me.statuses) {
        if (!existing.has(s.kind)) {
          if (!Array.isArray(player.statuses)) player.statuses = [];
          player.statuses.push({ ...s });
        }
      }
      _refreshStatusOverlay();
    }
  }
}

function _onPvpArenaUpdate(data) {
  if (!_pvpEntered) return;
  _syncPvpOpponentToData(data);
  _refreshPvpTurnUI(data);
  refreshHUD();
  if (dungeon) dungeon.render(document.getElementById('dungeon-canvas'));
}

// PvP のターン表示・入力封鎖を更新する。自分のターンの時は緑バナーで脈動、
// 相手のターンの時はグレーバナー＋フッターを暗くしてタップ封鎖。
function _refreshPvpTurnUI(data) {
  const banner = document.getElementById('pvp-turn-banner');
  const text   = document.getElementById('pvp-turn-banner-text');
  const footer = document.getElementById('dungeon-footer');
  if (!banner || !text || !footer) return;
  if (!data || data.state !== 'battle') {
    banner.classList.add('hidden');
    footer.classList.remove('pvp-foe-turn');
    return;
  }
  const myTurn = data.turn === _pvpRole;
  banner.classList.remove('hidden');
  banner.classList.toggle('my-turn',  myTurn);
  banner.classList.toggle('foe-turn', !myTurn);
  text.textContent = myTurn ? '🟢 あなたのターン' : '⌛ 相手のターン…';
  // フッターの D-pad / 技バー / ログを暗くしてタップ無効に
  footer.classList.toggle('pvp-foe-turn', !myTurn);
}

function _renderPvpLobbyRoom(data) {
  // ── モード切替ボタン群（host だけ操作可能、guest は disabled で表示のみ）──
  const modeRow = document.getElementById('pvp-room-mode-row');
  if (modeRow) {
    modeRow.classList.remove('hidden');
    modeRow.querySelectorAll('.pvp-room-btn').forEach(btn => {
      const isActive = btn.dataset.mode === (data.mode ?? 'pvp');
      btn.classList.toggle('active', isActive);
      btn.disabled = _pvpRole !== 'host' || data.state !== 'waiting';
    });
  }
  // ── 装備形式（pvp の時のみ表示）──
  const formatRow = document.getElementById('pvp-room-format-row');
  if (formatRow) {
    if (data.mode === 'pvp') {
      formatRow.classList.remove('hidden');
      formatRow.querySelectorAll('.pvp-room-btn').forEach(btn => {
        const isActive = btn.dataset.format === (data.pvpFormat ?? 'current');
        btn.classList.toggle('active', isActive);
        btn.disabled = _pvpRole !== 'host' || data.state !== 'waiting';
      });
    } else {
      formatRow.classList.add('hidden');
    }
  }
  // ── 協力ボス選択 ──
  const bossRow = document.getElementById('pvp-room-boss-row');
  const bossSel = document.getElementById('pvp-boss-select');
  if (bossRow && bossSel) {
    if (data.mode === 'coop') {
      bossRow.classList.remove('hidden');
      // option を再構築（毎回するが軽量なので OK）
      bossSel.innerHTML = PVP_COOP_BOSSES.map(b =>
        `<option value="${b.id}">${b.name}（HP ${b.maxHp} / ATK ${b.atk} / DEF ${b.def} / ${b.element}属性）</option>`
      ).join('');
      bossSel.value = data.boss?.bossId ?? PVP_COOP_BOSSES[0].id;
      bossSel.disabled = _pvpRole !== 'host' || data.state !== 'waiting';
    } else {
      bossRow.classList.add('hidden');
    }
  }
  // ── サマリ（モード + 形式 / ボス。ゲスト視点でも一目で分かる）──
  const summary = document.getElementById('pvp-room-summary');
  if (summary) {
    if (data.mode === 'coop') {
      const b = data.boss;
      summary.textContent = b
        ? `🤝 協力 / 対象: ${b.name}（HP ${b.maxHp}・${b.element}属性）`
        : '🤝 協力 / 対象未選択';
    } else {
      const fmtLabel = data.pvpFormat === 'set' ? 'セット装備（公平戦）' : '現在の装備';
      summary.textContent = `⚔️ 対戦 / 装備: ${fmtLabel}`;
    }
  }
  // ── プレイヤー行 ──
  const wrap = document.getElementById('pvp-lobby-players');
  wrap.innerHTML = '';
  const rows = [];
  if (data.host) rows.push({ p: data.host, role: 'host', tag: 'ホスト' });
  if (data.guest) rows.push({ p: data.guest, role: 'guest', tag: 'ゲスト' });
  for (const { p, tag } of rows) {
    const div = document.createElement('div');
    div.className = 'pvp-row' + (p.ready ? ' ready' : '');
    div.innerHTML = `<span>${tag}: ${p.name} Lv${p.level}</span>` +
                    `<span>${p.ready ? '✅ 準備OK' : '⌛ 待機中'}</span>`;
    wrap.appendChild(div);
  }
  if (!data.guest) {
    wrap.innerHTML += '<div class="pvp-row" style="opacity:0.6">ゲスト: 参加待ち…</div>';
  }
  // ホスト譲渡ボタンの活性: ホスト権限を持っていて、ゲストが居る時だけ表示
  const transferBtn = document.getElementById('btn-pvp-transfer-host');
  if (transferBtn) {
    if (_pvpRole === 'host' && data.guest && data.state === 'waiting') {
      transferBtn.classList.remove('hidden');
    } else {
      transferBtn.classList.add('hidden');
    }
  }
  // 両者 ready ならホストがバトル開始
  const bothReady = data.host?.ready && data.guest?.ready;
  if (bothReady && _pvpRole === 'host') {
    pvpStartBattle(_pvpCode).catch(err => console.warn(err));
  }
}

// ── ロビー部屋画面の設定変更ハンドラ ──
// モード切替（host のみ・waiting 中のみ）
document.getElementById('pvp-room-mode-row')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pvp-room-btn');
  if (!btn || btn.disabled) return;
  if (_pvpRole !== 'host' || !_pvpCode) return;
  const newMode = btn.dataset.mode === 'coop' ? 'coop' : 'pvp';
  if ((_pvpData?.mode ?? 'pvp') === newMode) return;
  try {
    await pvpSetRoomMode(_pvpCode, newMode);
    playSfx('click');
  } catch (err) { showAlert(err?.message ?? 'モード切替に失敗'); }
});
// 装備形式切替（PvP 時・host のみ）
document.getElementById('pvp-room-format-row')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pvp-room-btn');
  if (!btn || btn.disabled) return;
  if (_pvpRole !== 'host' || !_pvpCode) return;
  const fmt = btn.dataset.format === 'set' ? 'set' : 'current';
  if ((_pvpData?.pvpFormat ?? 'current') === fmt) return;
  try {
    await pvpSetRoomPvpFormat(_pvpCode, fmt);
    playSfx('click');
  } catch (err) { showAlert(err?.message ?? '装備形式切替に失敗'); }
});
// 協力ボス選択（coop 時・host のみ）
document.getElementById('pvp-boss-select')?.addEventListener('change', async (e) => {
  if (_pvpRole !== 'host' || !_pvpCode) return;
  const bossId = e.target.value;
  try {
    await pvpSetRoomBoss(_pvpCode, bossId);
    playSfx('click');
  } catch (err) { showAlert(err?.message ?? 'ボス変更に失敗'); }
});

// 手動ホスト譲渡ボタン
document.getElementById('btn-pvp-transfer-host')?.addEventListener('click', async () => {
  if (!_pvpCode || _pvpRole !== 'host') return;
  const ok = await showConfirm(
    '👑 ホスト権限を相手に譲渡しますか？\n\n譲渡後はあなたがゲストになり、相手が部屋を仕切ります。',
    { okLabel: '譲渡する', cancelLabel: 'やめる' },
  );
  if (!ok) return;
  try {
    await pvpTransferHost(_pvpCode);
    playSfx('confirm');
  } catch (err) {
    showAlert(err?.message ?? '譲渡に失敗しました');
  }
});

document.getElementById('btn-pvp')?.addEventListener('click', () => {
  if (!getCurrentAuthUser()) {
    showAlert('オンライン対戦にはログインが必要です');
    return;
  }
  playSfx('click');
  _enterPvpLobby();
});
document.getElementById('btn-pvp-back')?.addEventListener('click', () => {
  playSfx('click');
  _leavePvpRoom();
  show('map');
});
document.getElementById('btn-pvp-create')?.addEventListener('click', () => {
  playSfx('click');
  _pvpCreate();
});
document.getElementById('btn-pvp-join')?.addEventListener('click', () => {
  playSfx('click');
  _pvpJoin();
});
document.getElementById('btn-pvp-cancel')?.addEventListener('click', () => {
  playSfx('click');
  _leavePvpRoom();
});
document.getElementById('btn-pvp-ready')?.addEventListener('click', async () => {
  if (!_pvpCode || !_pvpRole) return;
  const cur = _pvpData?.[_pvpRole]?.ready ?? false;
  await pvpSetReady(_pvpCode, _pvpRole, !cur);
  playSfx('click');
});

// ── バトル画面の描画 + 行動 ──
function _renderPvpBattle(data) {
  const me  = data[_pvpRole];
  const foe = data[_pvpRole === 'host' ? 'guest' : 'host'];
  if (!me || !foe) return;
  document.getElementById('pvp-me-name').textContent  = `${me.name} Lv${me.level}`;
  document.getElementById('pvp-foe-name').textContent = `${foe.name} Lv${foe.level}`;
  _setBar('pvp-me-hp-bar',  me.hp,  me.maxHp,  'hp');
  _setBar('pvp-me-mp-bar',  me.mp,  me.maxMp,  'mp');
  _setBar('pvp-foe-hp-bar', foe.hp, foe.maxHp, 'hp');
  _setBar('pvp-foe-mp-bar', foe.mp, foe.maxMp, 'mp');
  document.getElementById('pvp-me-stats').textContent  = `HP ${me.hp}/${me.maxHp}　MP ${me.mp}/${me.maxMp}　ATK ${me.atk}　DEF ${me.def}`;
  document.getElementById('pvp-foe-stats').textContent = `HP ${foe.hp}/${foe.maxHp}　MP ${foe.mp}/${foe.maxMp}　ATK ${foe.atk}　DEF ${foe.def}`;

  // 行動ボタンの活性: data.turn が自分のロールなら活性
  const myTurn = data.turn === _pvpRole && data.state === 'battle';
  const turnEl = document.getElementById('pvp-turn-label');
  turnEl.textContent = data.state === 'finished'
    ? '🏁 終了'
    : (myTurn ? '🟢 あなたのターン' : '⌛ 相手のターン');
  turnEl.className = 'pvp-turn-label ' + (myTurn ? 'my-turn' : 'foe-turn');
  for (const id of ['btn-pvp-attack','btn-pvp-skill','btn-pvp-flee']) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !myTurn;
  }
  // 「技」は MP 8 以上ある時のみ
  const skillBtn = document.getElementById('btn-pvp-skill');
  if (skillBtn && myTurn && (me.mp ?? 0) < 8) skillBtn.disabled = true;

  // ログ（直近 6 件）
  const log = document.getElementById('pvp-battle-log');
  if (log) {
    const acts = (data.actions ?? []).slice(-6);
    log.innerHTML = acts.map(a => `<p>${_pvpActionLine(a, data)}</p>`).join('') || '<p style="color:#888">行動を選んでください…</p>';
  }
}
function _setBar(id, cur, max, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
  el.style.width = pct + '%';
  if (kind === 'hp') {
    el.style.background = pct > 50 ? '#4caf50' : pct > 25 ? '#ffc107' : '#f44336';
  } else {
    el.style.background = '#4dc4ff';
  }
}
function _pvpActionLine(a, data) {
  const role = a.byRole === 'host' ? 'ホスト' : 'ゲスト';
  const who  = a.byUid === data?.host?.uid ? data?.host?.name : data?.guest?.name;
  if (a.kind === 'attack') return `⚔️ ${who || role} のこうげき！ ${a.dmg} ダメージ`;
  if (a.kind === 'skill')  return `✨ ${who || role} の技！ ${a.dmg} ダメージ`;
  if (a.kind === 'flee')   return `🏃 ${who || role} は逃げ出した（敗北）`;
  return a.msg ?? '';
}

async function _pvpDoAction(kind) {
  if (!_pvpData || !_pvpRole || !_pvpCode) return;
  const me  = _pvpData[_pvpRole];
  const foe = _pvpData[_pvpRole === 'host' ? 'guest' : 'host'];
  if (!me || !foe) return;
  if (_pvpData.turn !== _pvpRole || _pvpData.state !== 'battle') return;
  let dmg = 0, hpAfter = foe.hp, attackerMp = me.mp;
  if (kind === 'attack') {
    const base = Math.max(1, me.atk - foe.def);
    const roll = 1 + Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.4)));
    dmg = base + roll;
    hpAfter = Math.max(0, foe.hp - dmg);
  } else if (kind === 'skill') {
    if ((me.mp ?? 0) < 8) { showAlert('MP が足りません'); return; }
    attackerMp = (me.mp ?? 0) - 8;
    const base = Math.max(1, Math.floor(me.atk * 1.6) - foe.def);
    const roll = 1 + Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.4)));
    dmg = base + roll;
    hpAfter = Math.max(0, foe.hp - dmg);
  } else if (kind === 'flee') {
    // 逃走: 相手の勝利確定
  }
  await pvpSubmitAction(_pvpCode, {
    byUid:  me.uid,
    byRole: _pvpRole,
    kind,
    dmg,
    hpAfter,
    attackerHp: me.hp,
    attackerMp,
    turnNo: _pvpData.turnNo ?? 0,
    hostUid:  _pvpData.host?.uid,
    guestUid: _pvpData.guest?.uid,
  });
  playSfx(kind === 'flee' ? 'click' : (kind === 'skill' ? 'crit' : 'hit'));
}

document.getElementById('btn-pvp-attack')?.addEventListener('click', () => _pvpDoAction('attack'));
document.getElementById('btn-pvp-skill') ?.addEventListener('click', () => _pvpDoAction('skill'));
document.getElementById('btn-pvp-flee')  ?.addEventListener('click', async () => {
  const ok = await showConfirm('本当に逃げますか？（敗北扱い）', { danger: true, okLabel: '逃げる' });
  if (!ok) return;
  _pvpDoAction('flee');
});

// 協力モードでボスを撃破した時のローカル報酬。両クライアントがそれぞれ
// 「自分のレベルで」アイテムをロールするので、host / guest で違う品が出ることがある
// （仕様。決定論的にする必要があれば host が seed を書いて両者が読む方式に変更可能）。
function _grantCoopBossReward() {
  // 高レアリティ（エピック）の装備を 1 個 + 経験値 + ゴールド + 鍵 1 本
  const seed = String((Date.now() ^ Math.floor(Math.random() * 1e6)) % 1e13).padStart(13, '0');
  const epicRarity = RARITIES.find(r => r.name === 'エピック') ?? RARITIES[2];
  const reward = generateItemFromBarcode(seed, epicRarity, player.level ?? 1);
  if (reward) {
    if (canAddToInventory(reward)) addToInventory({ ...reward });
    else addToStorage({ ...reward });
    showItemBanner(reward, { action: 'ボス討伐報酬', force: true });
  }
  // ゴールド
  const gold = 300 + (player.level ?? 1) * 12;
  player.gold = (player.gold ?? 0) + gold;
  // 鍵 1 本（宝箱があれば即開けられるようにご褒美）
  addToInventory(makeKey());
  // 経験値
  const xp = 80 + (player.level ?? 1) * 10;
  gainXp(xp);
  refreshHUD();
  autoSave();
}

let _pvpFinishShown = false;
function _showPvpFinished(data) {
  if (_pvpFinishShown) return;
  _pvpFinishShown = true;
  // 協力モードでボス討伐成功なら、ダイアログを出す前に報酬を与える
  if (data?.mode === 'coop' && data?.cause === 'bossKilled') {
    try { _grantCoopBossReward(); } catch (err) { console.warn('coop reward failed:', err); }
  }
  const me = data[_pvpRole];
  // PvP: winnerUid が自分なら勝利。
  // 協力モード: winnerUid='coop' なら両者勝利、cause=playerDied なら両者敗北。
  let titleText;
  if (data.mode === 'coop') {
    if (data.cause === 'bossKilled') titleText = '🎉 ボス討伐成功！';
    else                              titleText = '💀 全滅…';
  } else {
    const win = data.winnerUid === me?.uid;
    titleText = win ? '🎉 勝利！' : '💀 敗北…';
  }
  setTimeout(async () => {
    // 勝敗ダイアログは confirm 形式で「もう一度」「退室」を選べる。
    //   OK   = 同じ部屋でリマッチ（state を waiting にリセットしてロビー待機画面へ）
    //   Cancel = 部屋を出てマップへ戻る
    const ok = await showConfirm(
      `${titleText}\n\n同じ部屋でもう一度戦いますか？`,
      { okLabel: 'もう一度', cancelLabel: '退室する' },
    );
    _pvpFinishShown = false;
    if (ok) {
      // リマッチ: state を waiting に戻して両者を待機画面に戻す
      try { await pvpResetForRematch(_pvpCode); } catch (err) { console.warn(err); }
      // 次の battle で _enterPvpArena が再実行されるよう entered フラグも降ろす
      _pvpEntered = false;
      _pvpLastMyHp = null;
      // ロビー画面のルーム表示部を見せる（actions は隠す）
      show('pvp-lobby');
      document.getElementById('pvp-lobby-actions')?.classList.add('hidden');
      document.getElementById('pvp-lobby-room')?.classList.remove('hidden');
      // ターンバナー / フッター暗転は降ろす（次戦に備えて）
      document.getElementById('pvp-turn-banner')?.classList.add('hidden');
      document.getElementById('dungeon-footer')?.classList.remove('pvp-foe-turn');
    } else {
      // 退室: 部屋を出てマップに戻る（host は 30s 遅延 destroy で相手の動作を妨げない）
      _leavePvpRoom();
      show('map');
    }
  }, 600);
}
