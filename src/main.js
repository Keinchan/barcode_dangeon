import { initMap, refreshPin, setPlayerPosition, invalidateMapSize, recenterOnPlayer } from './map.js';
import { startScanner, stopScanner, getPosition, categoryOfFormat } from './scanner.js';
import {
  createPlayer,
  applyLevelStats,
  xpRequiredForLevel,
  statsForLevel,
  enemyLevel,
  rollGoldDropFromMonster,
  MAX_LEVEL,
  HP_PER_LEVEL,
  ATK_PER_LEVEL,
  DEF_PER_LEVEL,
  SKILL_SLOTS_MAX,
} from './generator.js';
import {
  generateItemFromBarcode, rarityFromDigit, bumpRarity, RARITIES, migrateElement,
  isStackable, stackKey, materialForRarity,
  PATTERN_OFFSETS, PATTERN_DESC, findSkillById, elementMatchup, matchupLabel,
  shopPriceFor,
} from './items.js';
import { hashString } from './rng.js';
import { Dungeon } from './dungeon.js';
import { Battle } from './battle.js';
import { showFloatingDamage, showItemBanner, shockwave, magicCircle, playerVfxAnchor } from './ui.js';
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
// インベントリに追加できるか事前判定（スタックなら既存に合算可能なので true）
function canAddToInventory(item) {
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
function addToInventory(item) { return _addToList(player.inventory, item, 8); }
function addToStorage(item)   { return _addToList(player.storage,   item, null); }

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
  for (const arrName of ['inventory', 'storage']) {
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
let battle       = null;
let combatActive = false;               // 戦闘中フラグ（インライン化のため screen は dungeon のまま）
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
    });
  }
  _bgmForScreen(name);
}

// 画面 → BGM のマッピング。combat 中は startBattle 側で battle に切り替える
function _bgmForScreen(name) {
  if (combatActive) return;       // 戦闘中はそちらの BGM を維持
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
    ? `<div class="pre-dungeon-info-line">${w.emoji} <span style="color:${w.rarityColor}">${w.name}</span> ATK+${w.atkBonus}` +
      (w.skill?.name ? ` <span style="color:#888">(${w.skill.name})</span>` : '') + `</div>`
    : '<div class="pre-dungeon-info-line" style="color:#888">⚔️ 武器なし</div>';
  const aLine = a
    ? `<div class="pre-dungeon-info-line">${a.emoji} <span style="color:${a.rarityColor}">${a.name}</span> DEF+${a.defBonus}` +
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
  // スキャン上限チェック。0/5 + 結晶も無ければ開始させない。
  // 結晶があれば使うか確認、無料枠があればそのまま消費。
  if (!await _consumeScanQuota()) return;
  show('scanner');
  launchScanner();
});

// スキャンクオータを 1 回消費。無料枠が残っていれば true、結晶がある場合は確認、
// どちらも無ければ購入を促して false。
async function _consumeScanQuota() {
  ensureScanBudget(player);
  const s = getScanStatus(player);
  if (s.freeRemaining > 0) {
    tryConsumeScan(player);
    autoSave();
    _refreshScanStatusUI();
    return true;
  }
  // 無料枠尽きている → 結晶があれば確認
  if (s.platinum > 0) {
    const ok = await showConfirm(
      `今日の無料スキャンを使い切りました（${s.dailyMax}/${s.dailyMax}）。\n` +
      `プラチナ結晶 1 個を消費して +1 スキャンしますか？\n` +
      `（所持: 💎${s.platinum}）`,
      { okLabel: '結晶を使う', cancelLabel: 'やめる' },
    );
    if (!ok) return false;
    const r = tryConsumeScan(player);
    autoSave();
    _refreshScanStatusUI();
    return r.ok;
  }
  // 結晶も無い → 購入導線
  const buy = await showConfirm(
    `今日のスキャン上限（${s.dailyMax}/${s.dailyMax}）に達しました。\n` +
    `プラチナ結晶を購入しますか？\n\n` +
    `※ テストビルドのため購入ボタンで ${PLATINUM_STUB_GRANT} 個付与（実決済は未実装）`,
    { okLabel: `${PLATINUM_STUB_GRANT}個購入`, cancelLabel: 'やめる' },
  );
  if (!buy) return false;
  // TODO: 本番では Stripe / Apple IAP / Google Play Billing に差し替え。
  addPlatinum(player, PLATINUM_STUB_GRANT);
  autoSave();
  _refreshScanStatusUI();
  await showAlert(
    `💎${PLATINUM_STUB_GRANT} を付与しました（テストビルド）。\n` +
    `もう一度「スキャン」を押してください。`,
  );
  return false;   // 一旦 UI を戻して再タップさせる
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
  if (combatActive) {
    showAlert('戦闘中はメニューを開けません');
    return;
  }
  playSfx('click');
  openMenu();
});

function openMenu() {
  refreshMenu();
  document.getElementById('menu-modal').classList.remove('hidden');
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

  // 持ち物
  const inv = document.getElementById('menu-inventory');
  document.getElementById('menu-inv-count').textContent = `(${player.inventory.length}/8)`;
  inv.innerHTML = '';
  if (player.inventory.length === 0) {
    inv.innerHTML = '<div class="menu-empty">持ち物なし</div>';
  } else {
    player.inventory.forEach((item, idx) => {
      inv.appendChild(_renderInventoryRow(item, idx));
    });
  }

  // ストレージ
  _refreshStorageUI();
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
  div.innerHTML = `
    <div class="menu-row-emoji">${iconImg(item, 38)}</div>
    <div class="menu-row-info">
      <div class="menu-row-name" style="color:${item.rarityColor}">${item.name} ${lvHtml} ${countHtml}</div>
      <div class="menu-row-stat">${_statLine(item)} / ${item.rarity}</div>
      ${skillHtml}
    </div>
    <div class="menu-row-actions">
      <button class="menu-action-btn move withdraw">→持ち物</button>
      <button class="menu-action-btn danger discard">廃棄</button>
    </div>
  `;
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

// ボス撃破直後など、フロアに置けないドロップを自動取得。
// インベントリに余裕があればそこに、満杯ならストレージに退避（永久消失を防ぐ）。
function _autoCollectDrop(drop) {
  if (!Array.isArray(player.storage)) player.storage = [];
  let toStorage = false;
  if (canAddToInventory(drop)) {
    addToInventory(drop);
  } else {
    addToStorage(drop);
    toStorage = true;
  }
  playSfx('drop', { rarityTier: rarityTier(drop.rarity) });
  const where = toStorage ? '📦ストレージへ' : '🎒持ち物へ';
  if (typeof dungeonLog === 'function' && screen === 'dungeon') {
    dungeonLog(`💎 ${drop.name} を獲得！（${where}）`, { rarity: drop.rarity });
  }
  // レア+はバナー、コモンは控えめなアラート。ボスは満杯時のみ通知が欲しい
  if (drop.rarity !== 'コモン') {
    _celebratePickup(drop, toStorage ? 'ストレージへ' : 'ドロップ');
  } else if (toStorage) {
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

function _statLine(item) {
  if (item.type === 'weapon') return `ATK +${item.atkBonus}（${item.element}属性）`;
  if (item.type === 'armor')  return `DEF +${item.defBonus}（${item.element}属性）`;
  if (item.type === 'potion')        return `HP +${item.heal} 回復`;
  if (item.type === 'mpPotion')      return `MP +${item.mpHeal} 回復`;
  if (item.type === 'mysteryScroll') return item.desc;
  if (item.type === 'skillBook')     return `📕 ${item.skillName} を習得`;
  if (item.type === 'scroll') return `${item.element}属性 ${item.dmg}ダメージ`;
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
    (item.type === 'potion' || item.type === 'mpPotion' || item.type === 'mysteryScroll')
    && screen === 'dungeon' && !combatActive;
  const isLearnable = item.type === 'skillBook';   // 場所問わず学べる
  const hasMainAction = isEquippable || isUsableHere || isLearnable;
  const action =
    isEquippable                  ? 'equip'   :
    isLearnable                   ? 'learn'   :
    item.type === 'mysteryScroll' ? 'mystery' :
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
      } else if (action === 'learn') {
        showActionConfirm(`${item.name} を読んで「${item.skillName}」を習得しますか？\n${item.skillDesc}`, item, '習得する', () => {
          _learnSkillFromBook(idx);
        });
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
  if (!Array.isArray(player.skills)) player.skills = [];

  // 既に同じ技を習得済み？ → 上書き不要、消費だけしてアラート
  if (player.skills.find(s => s.id === item.skillId)) {
    showAlert(`${item.skillName} は既に習得済みです`);
    return;
  }

  const skillSpec = findSkillById(item.skillId);
  if (!skillSpec) { showAlert('技データが見つかりませんでした'); return; }

  // スロットが空いていれば即習得。満杯なら忘れる技を選ばせる
  if (player.skills.length < SKILL_SLOTS_MAX) {
    player.skills.push({ ...skillSpec });
    takeOneFromInventory(idx);
    playSfx('levelup');
    showAlert(`✨ ${skillSpec.name} を習得した！`);
    refreshMenu();
    autoSave();
    return;
  }

  // 満杯：簡易的に「忘れる技を選ぶ」リストを表示
  _openForgetSkillModal(skillSpec, idx);
}

function _openForgetSkillModal(newSkill, bookIdx) {
  const list = player.skills.map((s, i) =>
    `${i + 1}. ${s.name}（${s.pattern}型 / MP-${s.mpCost}）`,
  ).join('\n');
  showConfirm(
    `技スロットが満杯（${SKILL_SLOTS_MAX}/${SKILL_SLOTS_MAX}）。\n\n` +
    `習得したい技: ${newSkill.name}（${newSkill.pattern}型 / MP-${newSkill.mpCost}）\n\n` +
    `現在の技:\n${list}\n\n` +
    `1 番目の技を忘れて新しい技を覚えますか？\n（順番指定の UI は今後追加予定）`,
    { okLabel: '1 番を忘れる', cancelLabel: 'やめる' },
  ).then(ok => {
    if (!ok) return;
    player.skills[0] = { ...newSkill };
    takeOneFromInventory(bookIdx);
    playSfx('levelup');
    showAlert(`📕 1 番目の技を忘れ、${newSkill.name} を習得しました`);
    refreshMenu();
    autoSave();
  });
}

// 技を発動（ダンジョン探索中、戦闘パネル中ではなく）
function _executeSkill(skill) {
  if (!dungeon || screen !== 'dungeon' || combatActive) {
    showAlert('技はダンジョン探索中にだけ使えます');
    return;
  }
  if ((player.mp ?? 0) < skill.mpCost) {
    showAlert(`MP が足りません（必要 ${skill.mpCost}）`);
    return;
  }
  player.mp = Math.max(0, (player.mp ?? 0) - skill.mpCost);

  const offsets = PATTERN_OFFSETS[skill.pattern] ?? [];
  const px = dungeon.playerPos.x;
  const py = dungeon.playerPos.y;
  const hits = [];

  for (const [dx, dy] of offsets) {
    const m = dungeon.monsterAt(px + dx, py + dy);
    if (!m) continue;
    const matchup = elementMatchup(skill.element, m.element);
    const base = Math.max(1, Math.floor(player.atk * skill.dmgMult) - m.def);
    const dmg  = Math.max(1, Math.floor((base + Math.floor(Math.random() * Math.max(1, base * 0.4)))
      * matchup));
    m.hp = Math.max(0, m.hp - dmg);
    hits.push({ m, dmg, matchup });
  }

  dungeonLog(`✨ 技「${skill.name}」発動！ ${hits.length} 体に命中（MP -${skill.mpCost}）`);
  playSfx('crit');

  // 死亡した敵を一括処理（XP・ゴールド・ドロップ）
  const dead = dungeon.monsters.filter(m => m.hp <= 0);
  for (const m of dead) {
    dungeon.removeMonster(m);
    gainXp(_xpFromMonster(m));
    const gold = rollGoldDropFromMonster(m);
    if (gold > 0) {
      player.gold = (player.gold ?? 0) + gold;
      dungeonLog(`🪙 ${m.name} は ${gold} ゴールドを落とした`);
    }
    const matDrop = _rollMaterialDrop(m);
    if (matDrop) _autoCollectDrop(matDrop);
    const drop = _rollMonsterDrop(m);
    if (drop) {
      drop.x = m.x; drop.y = m.y;
      dungeon.floorItems.push(drop);
      dungeonLog(`💎 ${m.name} は ${drop.name} を落とした！`, { rarity: drop.rarity });
    }
  }

  refreshHUD();
  dungeon.render(document.getElementById('dungeon-canvas'));
  // 行動後の敵ターン
  _runEnemyTurn();
  autoSave();
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
          <span class="item-emoji">${it.emoji ?? '🎁'}</span>
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
  return it.rarity ?? '';
}

function _buyFromShop(idx) {
  if (!_currentShopkeeper) return;
  const stock = dungeon.getShopStock(_currentShopkeeper);
  const entry = stock[idx];
  if (!entry) return;
  if ((player.gold ?? 0) < entry.price) { showAlert('ゴールドが足りません'); return; }
  // インベントリ余裕チェック（スタック合算で OK な場合あり）
  if (!canAddToInventory(entry.item)) { showAlert('持ち物が満杯です（先に整理してから）'); return; }
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
  _currentShopkeeper = null;
});

document.getElementById('btn-shop-attack').addEventListener('click', async () => {
  if (!_currentShopkeeper) return;
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
  startBattle(target);
});

// わざボタン → モーダル表示
function _openWazaModal() {
  if (!dungeon || screen !== 'dungeon' || combatActive) {
    showAlert('技はダンジョン探索中にだけ使えます'); return;
  }
  const skills = Array.isArray(player.skills) ? player.skills : [];
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
document.getElementById('btn-waza').addEventListener('click', () => {
  playSfx('click');
  _openWazaModal();
});
document.getElementById('btn-waza-cancel').addEventListener('click', () => {
  playSfx('click');
  document.getElementById('waza-modal').classList.add('hidden');
});

// 不思議系巻物の使用：効果フラグを dungeon に書き込み再描画。フロアでのみ使える
function _useMysteryScrollFromInventory(idx) {
  const item = player.inventory[idx];
  if (!item || item.type !== 'mysteryScroll') return;
  if (!dungeon || screen !== 'dungeon' || combatActive) {
    showAlert('巻物はダンジョン探索中にしか使えません');
    return;
  }
  switch (item.effect) {
    case 'reveal-stairs':  dungeon.revealStairs  = true; break;
    case 'reveal-enemies': dungeon.revealEnemies = true; break;
    case 'reveal-items':   dungeon.revealItems   = true; break;
    case 'reveal-all':     dungeon.revealFloor   = true; break;
    default: showAlert('効果不明な巻物'); return;
  }
  takeOneFromInventory(idx);
  dungeonLog(`📜 ${item.name} を読んだ！効果は今のフロアに有効`);
  playSfx('crit');
  refreshHUD();
  refreshMenu();
  dungeon.render(document.getElementById('dungeon-canvas'));
  autoSave();
}

function _usePotionFromInventory(idx) {
  const item = player.inventory[idx];
  if (!item) return;
  if (item.type === 'potion') {
    if (player.hp >= player.maxHp) { showAlert('HPが満タンです'); return; }
    const before = player.hp;
    player.hp = Math.min(player.maxHp, player.hp + item.heal);
    const actual = player.hp - before;
    takeOneFromInventory(idx);
    if (typeof dungeonLog === 'function' && screen === 'dungeon') {
      dungeonLog(`🧪 ${item.name} を使用！ HPが${actual}回復した`);
    }
    playSfx('drink');
  } else if (item.type === 'mpPotion') {
    if ((player.mp ?? 0) >= (player.maxMp ?? 0)) { showAlert('MPが満タンです'); return; }
    const before = player.mp ?? 0;
    player.mp = Math.min(player.maxMp ?? 0, before + item.mpHeal);
    const actual = player.mp - before;
    takeOneFromInventory(idx);
    if (typeof dungeonLog === 'function' && screen === 'dungeon') {
      dungeonLog(`🔵 ${item.name} を使用！ MPが${actual}回復した`);
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
      const item = _itemFromScan(scanResult);
      pendingItem = item;
      _showItemResult(item, scanResult);
    });
  } catch (e) {
    showAlert('カメラを起動できません。HTTPS環境か、カメラの許可を確認してください。\n\n' + e.message);
    show('map');
  }
}

function _itemFromScan({ text, category }) {
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
    item.type === 'scroll' ? `${item.element}属性 ${item.dmg}ダメージ` : '';

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

document.getElementById('btn-rescan').addEventListener('click', () => {
  playSfx('click');
  pendingItem = null;
  launchScanner();
});

document.getElementById('btn-keep-item').addEventListener('click', () => {
  if (!pendingItem) return;
  const item = pendingItem;
  const msg = _acquireItem(item);
  pendingItem = null;
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
  // 戦闘UIを必ずリセット（デバッグ操作で途中離脱した場合の保険）
  combatActive = false;
  battle       = null;
  document.getElementById('combat-panel').classList.add('hidden');
  document.getElementById('dungeon-footer').classList.remove('hidden');

  dungeonData  = data;
  // 入場前スナップショット（敗北時ロールバック）
  entrySnapshot = {
    inventory: [...player.inventory],
    weapon:    player.weapon,
    armor:     player.armor,
    atk:       player.atk,
    def:       player.def,
  };
  player.hp    = player.maxHp;     // 入場時に HP/MP 全回復
  player.mp    = player.maxMp ?? 0;
  currentFloor = 1;
  loadFloor(1);
  show('dungeon');
  autoSave();
}

function loadFloor(floor) {
  currentFloor = floor;
  dungeon = new Dungeon(dungeonData, floor);
  document.getElementById('dungeon-title').textContent = dungeonData.name;
  document.getElementById('floor-label').textContent   = `B${floor}F`;
  // フロア進入時に MP 全回復（HP は据え置き）。スキル/技を毎フロアで気軽に振れる
  // よう、ローグライクの「フロア境界＝休憩」の感覚に合わせる
  player.mp = player.maxMp ?? 0;
  refreshHUD();
  dungeonLog(`B${floor}F に入った（MP 全回復）`);
  dungeon.render(document.getElementById('dungeon-canvas'));
}

function refreshHUD() {
  document.getElementById('player-lv').textContent = `Lv${player.level}`;
  document.getElementById('player-hp').textContent = `HP: ${player.hp}/${player.maxHp}`;
  const mpEl = document.getElementById('player-mp');
  if (mpEl) mpEl.textContent = `MP: ${player.mp ?? 0}/${player.maxMp ?? 0}`;
  const wName = player.weapon ? `${player.weapon.emoji} +${player.weapon.atkBonus}` : '⚔️ ー';
  const aName = player.armor  ? `${player.armor.emoji} +${player.armor.defBonus}`  : '🛡️ ー';
  document.getElementById('equip-display').textContent = `${wName}　${aName}`;

  // ゴールド表示はマップ HUD と ダンジョンヘッダの両方にある（無ければスキップ）
  const goldStr = `🪙 ${player.gold ?? 0}`;
  const dungeonGold = document.getElementById('player-gold');
  if (dungeonGold) dungeonGold.textContent = goldStr;
  const mapGold = document.getElementById('map-gold-display');
  if (mapGold) mapGold.textContent = goldStr;

  _refreshScanStatusUI();
}

// XP獲得＆レベルアップ
function gainXp(amount) {
  if (amount <= 0) return;
  player.xp += amount;
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
  }
  refreshHUD();
  if (!document.getElementById('menu-modal').classList.contains('hidden')) refreshMenu();
  autoSave();
}

// モンスター撃破時のXP量
function _xpFromMonster(mob) {
  const base =
    mob.rarity === 'レジェンド' ? 200 :
    mob.rarity === 'エピック'   ? 70  :
    mob.rarity === 'レア'       ? 25  :
    10;
  return mob.isBoss ? base * 3 : base;
}

function dungeonLog(msg, opts = {}) {
  const el = document.getElementById('dungeon-log');
  const cls = opts.rarity ? ` class="${_logClassFor(opts.rarity)}"` : '';
  el.innerHTML = `<div${cls}>${msg}</div>` + el.innerHTML;
  const lines = el.querySelectorAll('div');
  if (lines.length > 4) lines[lines.length - 1].remove();
}

function _logClassFor(rarity) {
  switch (rarity) {
    case 'レア':       return 'dungeon-log-rare';
    case 'エピック':   return 'dungeon-log-epic';
    case 'レジェンド': return 'dungeon-log-legendary';
    default:           return '';
  }
}

// 拾得時の派手な演出（コモンは何もしない）。レア+はバナー、テキストも色付け
function _celebratePickup(item, action = '入手') {
  if (!item) return;
  if (item.rarity !== 'コモン') {
    showItemBanner(item, { action });
  }
}

// ── 移動 ──
function move(dx, dy) {
  if (!dungeon || screen !== 'dungeon' || combatActive) return;

  // 移動 or 待機の処理
  if (dx !== 0 || dy !== 0) {
    const px = dungeon.playerPos.x;
    const py = dungeon.playerPos.y;
    const nx = px + dx;
    const ny = py + dy;

    // 斜め移動の壁抜け禁止：縦横どちらか1つでも壁ならその角の斜めへは進めない
    if (dx !== 0 && dy !== 0) {
      const sideX = dungeon.canWalk(px + dx, py);
      const sideY = dungeon.canWalk(px, py + dy);
      if (!sideX || !sideY) {
        // 壁の角越しに敵がいれば、戦闘パネルを開く（壁越しの戦闘＝魔法のみ）
        const mob = dungeon.monsterAt(nx, ny);
        if (mob && dungeon.canWalk(nx, ny)) {
          startBattle(mob, { wallPiercing: true });
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
      startBattle(mob); return;
    }   // 戦闘パネル発動 → 敵ターン無し

    dungeon.playerPos = { x: nx, y: ny };

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
  }

  _runEnemyTurn();
}

// 敵ターン共通処理
//   各敵の魔法攻撃を 1 件ずつ時間差で表示する（合算しない）。
//   1 体撃破でも複数体に囲まれていると連続でダメージ表示・SFX・ログが重なる演出。
function _runEnemyTurn() {
  const result = dungeon.tickEnemies(player);
  const magics = result.events.filter(e => e.type === 'magic');

  // 描画はとりあえず移動結果だけ先に反映
  dungeon.render(document.getElementById('dungeon-canvas'));

  if (magics.length === 0) return;

  let i = 0;
  const STEP_MS = 320;
  const apply = () => {
    if (player.hp <= 0) return;
    const ev = magics[i++];
    if (!ev) return;
    player.hp = Math.max(0, player.hp - ev.dmg);
    showFloatingDamage(ev.dmg);
    playSfx('damage');
    // 壁越し魔法は属性魔法陣＋衝撃波
    magicCircle(playerVfxAnchor(), ev.mob.element);
    shockwave(playerVfxAnchor(), { color: 'rgba(255,82,82,0.6)' });
    dungeonLog(`✨ ${ev.mob.name} の魔法攻撃！ ${ev.dmg} ダメージ`);
    refreshHUD();
    if (player.hp <= 0) {
      setTimeout(() => showResult(false), 350);
      return;
    }
    if (i < magics.length) setTimeout(apply, STEP_MS);
  };
  apply();
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
document.querySelectorAll('.dpad-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const d = DPAD_DIRS[btn.dataset.dir];
    if (d) move(...d);
  });
});

// キーボード（PC確認用、8方向対応）
document.addEventListener('keydown', e => {
  if (screen !== 'dungeon' || combatActive) return;
  const m = {
    ArrowUp:[0,-1], ArrowDown:[0,1], ArrowLeft:[-1,0], ArrowRight:[1,0],
    w:[0,-1], s:[0,1], a:[-1,0], d:[1,0], ' ':[0,0],
    q:[-1,-1], e:[1,-1], z:[-1,1], c:[1,1],
    Q:[-1,-1], E:[1,-1], Z:[-1,1], C:[1,1],
  };
  if (m[e.key]) { e.preventDefault(); move(...m[e.key]); }
});

// スワイプ（モバイル）
let touchStart = null;
const canvas = document.getElementById('dungeon-canvas');
canvas.addEventListener('touchstart', e => {
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
canvas.addEventListener('touchend', e => {
  if (!touchStart || combatActive) return;
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
// バトル
// ─────────────────────────────────────────────
function startBattle(mob, opts = {}) {
  // 戦闘モードに切替（screen は dungeon のままインライン化）
  combatActive = true;
  document.getElementById('dungeon-footer').classList.add('hidden');
  document.getElementById('combat-panel').classList.remove('hidden');

  // ボス遭遇は専用 SFX、その後バトル BGM へ
  if (mob.isBoss) playSfx('boss');
  startBgm('battle');

  battle = new Battle(player, mob, (result /*, defeated (cloneのため使わない) */) => {
    // 戦闘終了：探索モードに復帰
    combatActive = false;
    document.getElementById('combat-panel').classList.add('hidden');
    document.getElementById('dungeon-footer').classList.remove('hidden');

    player.hp  = battle.player.hp;
    player.mp  = battle.player.mp ?? player.mp;
    player.atk = battle.player.atk;
    player.def = battle.player.def;
    refreshHUD();

    // 通常勝利・逃走時はダンジョンBGMに戻す（ボス勝利は dungeonClear 経由で result 画面）
    if (result !== 'lose' && !(result === 'win' && mob.isBoss)) {
      startBgm('dungeon');
    }

    if (result === 'win') {
      // 元のmobリファレンスで確実に削除（cloneのdefeatedではindexOf不一致）
      dungeon.removeMonster(mob);
      // 商人撃破: 在庫を全て床にぶちまける + 大量ゴールド
      if (mob.isShopkeeper) {
        const stock = dungeon.getShopStock(mob);
        const placed = [];
        for (const entry of stock) {
          const it = { ...entry.item, x: mob.x, y: mob.y };
          // 周囲 8 マスを埋めながら配置（壁/他mob を避ける）
          for (const [dx, dy] of [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
            const tx = mob.x + dx, ty = mob.y + dy;
            if (!dungeon.canWalk(tx, ty)) continue;
            if (placed.some(p => p.x === tx && p.y === ty)) continue;
            it.x = tx; it.y = ty;
            placed.push(it);
            break;
          }
          dungeon.floorItems.push(it);
        }
        dungeon.shopkeeperToStock?.delete(mob);
        // 巨額ゴールドのボーナス
        const bonus = 500 + (mob.level ?? 30) * 30;
        player.gold = (player.gold ?? 0) + bonus;
        dungeonLog(`💰 商人を撃破！ ${bonus} ゴールドと在庫すべてが床に...`, { rarity: 'レジェンド' });
      }
      // XP獲得
      gainXp(_xpFromMonster(mob));
      // ゴールドドロップ（アイテムドロップとは独立）
      const gold = rollGoldDropFromMonster(mob);
      if (gold > 0) {
        player.gold = (player.gold ?? 0) + gold;
        dungeonLog(`🪙 ${mob.name} は ${gold} ゴールドを落とした`);
        refreshHUD();
      }
      // 素材ドロップ（装備ドロップとは独立）
      const mat = _rollMaterialDrop(mob);
      if (mat) {
        _autoCollectDrop(mat);
      }
      // ドロップ判定
      const drop = _rollMonsterDrop(mob);
      if (drop) {
        if (mob.isBoss) {
          // ボスは即 dungeonClear で離脱するためフロアに置けない。直接取得し、
          // インベントリ満杯ならストレージに自動退避（永久消失を防ぐ）。
          _autoCollectDrop(drop);
        } else {
          drop.x = mob.x;
          drop.y = mob.y;
          dungeon.floorItems.push(drop);
          dungeonLog(`💎 ${mob.name} は ${drop.name} を落とした！`, { rarity: drop.rarity });
          playSfx('drop', { rarityTier: rarityTier(drop.rarity) });
          _celebratePickup(drop, 'ドロップ');
        }
      } else {
        dungeonLog(`${mob.name} を倒した！`);
      }
      if (mob.isBoss) {
        dungeonClear();
      } else {
        requestAnimationFrame(() => dungeon.render(document.getElementById('dungeon-canvas')));
      }
    } else if (result === 'lose') {
      showResult(false);
    } else if (result === 'run') {
      dungeonLog('逃げた！');
      requestAnimationFrame(() => dungeon.render(document.getElementById('dungeon-canvas')));
    }
  }, {
    ...opts,
    dungeon,                       // 戦闘中に他敵をティックさせる
    mobRef: mob,                   // ティックから除外する戦闘中 mob
    onTick: () => {                // 他敵が動いた後の再描画
      dungeon.render(document.getElementById('dungeon-canvas'));
    },
  });
  document.getElementById('battle-log').innerHTML = '';
  battle.updateUI();

  // 戦闘パネルが表示・レイアウト確定された後に canvas を再サイズして再描画
  requestAnimationFrame(() => dungeon.render(document.getElementById('dungeon-canvas')));
}

// 画面サイズ変動時にも canvas を追従させる
window.addEventListener('resize', () => {
  if (dungeon && screen === 'dungeon') {
    dungeon.render(document.getElementById('dungeon-canvas'));
  }
});

// モンスター撃破時の素材ドロップ（装備ドロップと独立）。15% で発生し、
// モンスターのレアリティに対応した素材 1 個。合成・ショップで使う想定。
function _rollMaterialDrop(mob) {
  const dbg = getDebugState();
  const chance = dbg.forceDrop ? 1 : 0.15;
  if (Math.random() > chance) return null;
  return materialForRarity(mob.rarity);
}

// モンスター撃破時のドロップ判定
function _rollMonsterDrop(mob) {
  const dbg = getDebugState();
  const dropChance = dbg.forceDrop ? 1 :
    mob.isBoss               ? 1.0 :
    mob.rarity === 'レジェンド' ? 0.95 :
    mob.rarity === 'エピック'   ? 0.7  :
    mob.rarity === 'レア'       ? 0.5  :
    0.4;
  if (Math.random() > dropChance) return null;

  const seed = hashString(`drop:${dungeonData.seed}:${currentFloor}:${mob.x}:${mob.y}`);
  const code = String(seed).padStart(13, '0').slice(0, 13);

  // ドロップアイテムのレアリティ：基本はモンスターと同レベル、ボスは+1段階
  const baseRarity = RARITIES.find(r => r.name === mob.rarity);
  let rarityOverride = baseRarity ?? null;
  if (mob.isBoss && baseRarity) rarityOverride = bumpRarity(baseRarity, 1);

  // アイテムレベル: 落とした敵のレベルに準拠（ボスは +5 相当）
  const itemLevel = (mob.level ?? 1) + (mob.isBoss ? 5 : 0);
  return generateItemFromBarcode(code, rarityOverride, itemLevel);
}

document.getElementById('btn-attack').addEventListener('click', () => battle?.attack());
document.getElementById('btn-skill' ).addEventListener('click', () => battle?.skill());
document.getElementById('btn-run'   ).addEventListener('click', () => battle?.run());

// アイテムボタン → モーダル表示
document.getElementById('btn-item').addEventListener('click', () => {
  showItemModal();
});

document.getElementById('btn-item-cancel').addEventListener('click', () => {
  document.getElementById('item-modal').classList.add('hidden');
});

function showItemModal() {
  const list = document.getElementById('item-list');

  if (player.inventory.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:#888;padding:12px">アイテムを持っていない</div>';
  } else {
    list.innerHTML = player.inventory.map((it, idx) => {
      const canUse = it.type === 'potion' || it.type === 'mpPotion' || it.type === 'scroll';
      const lvHtml = it.level ? `<span class="menu-row-lv">Lv${it.level}</span>` : '';
      const cnt    = (isStackable(it) && (it.count ?? 1) > 1) ? `<span class="menu-row-count">×${it.count}</span>` : '';
      return `
        <div class="item-row${canUse ? '' : ' disabled'}" data-idx="${idx}">
          <span class="item-emoji">${iconImg(it, 32)}</span>
          <div class="item-info">
            <div class="item-name">${it.name} ${lvHtml} ${cnt}</div>
            <div class="item-desc">${it.desc}</div>
          </div>
          <span class="item-rarity" style="color:${it.rarityColor}">${it.rarity}</span>
        </div>`;
    }).join('');

    list.querySelectorAll('.item-row:not(.disabled)').forEach(row => {
      row.addEventListener('click', () => {
        const idx  = parseInt(row.dataset.idx, 10);
        const item = takeOneFromInventory(idx);
        if (!item) return;
        document.getElementById('item-modal').classList.add('hidden');
        // battle 内では this.player.inventory が clone され同一参照。
        // takeOneFromInventory が player.inventory を変更したので battle 側にも
        // 反映させる必要がある（戦闘終了時に inventory を書き戻していないため）
        battle.player.inventory = player.inventory;
        battle.useItem(item);
      });
    });
  }

  document.getElementById('item-modal').classList.remove('hidden');
}

// ─────────────────────────────────────────────
// クリア / ゲームオーバー
// ─────────────────────────────────────────────
function dungeonClear() {
  clearedSet.add(dungeonData.seed);
  refreshPin(dungeonData.seed);
  showResult(true);
  autoSave();
}

function showResult(isWin) {
  if (!isWin && entrySnapshot) {
    // 敗北：ダンジョンで拾った装備とアイテムをロールバック
    player.inventory = entrySnapshot.inventory;
    player.weapon    = entrySnapshot.weapon;
    player.armor     = entrySnapshot.armor;
    player.atk       = entrySnapshot.atk;
    player.def       = entrySnapshot.def;
  }
  player.hp = player.maxHp;       // マップ復帰時は全回復
  entrySnapshot = null;

  show('result');
  document.getElementById('result-icon').textContent  = isWin ? '🎉' : '💀';
  document.getElementById('result-title').textContent = isWin ? '攻略成功！' : 'ゲームオーバー';
  document.getElementById('result-body').textContent  = isWin
    ? `${dungeonData.name} を踏破した！\n（再挑戦可）`
    : 'ダンジョンで力尽きた...\nこのダンジョンで拾ったものは失われた';
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
      inventory: player.inventory,
      storage:   player.storage ?? [],
      gold:       player.gold       ?? 0,
      platinum:   player.platinum   ?? 0,
      scanBudget: player.scanBudget ?? null,
      skills:     player.skills     ?? [],
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
  // 旧セーブ互換: storage が無いケース
  if (!Array.isArray(player.storage)) player.storage = [];
  if (typeof player.gold !== 'number') player.gold = 0;
  // 旧セーブ互換: maxMp / mp が未設定 → レベル相当の値を埋め込み
  if (typeof player.maxMp !== 'number') player.maxMp = statsForLevel(player.level || 1).maxMp;
  if (typeof player.mp    !== 'number') player.mp    = player.maxMp;
  // 旧セーブ互換: platinum / scanBudget の正規化（日次リセットも内側で実施）
  ensureScanBudget(player);
  // 旧属性 (火/水/...) を新属性 (棒人間/落書き/...) にマイグレート
  _migrateItemElements(player);
  // 旧セーブのスタック未対応データを集約（count 付与 + 同種重複統合）
  _consolidateStacks(player);
  if (!Array.isArray(player.skills)) player.skills = [];
  clearedSet.clear();
  if (Array.isArray(data.clearedSeeds)) {
    for (const s of data.clearedSeeds) clearedSet.add(s);
  }
  refreshHUD();
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
    if (combatActive) {
      showAlert('戦闘中はスキャンできません（戦闘を終わらせてください）');
      return;
    }
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
    if (!dungeon || screen !== 'dungeon' || combatActive) {
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
      dungeon.removeMonster(mob);
      gainXp(_xpFromMonster(mob));
      const gold = rollGoldDropFromMonster(mob);
      if (gold > 0) {
        player.gold = (player.gold ?? 0) + gold;
        dungeonLog(`🪙 ${mob.name} は ${gold} ゴールドを落とした`);
      }
      const drop = _rollMonsterDrop(mob);
      if (drop) {
        drop.x = mob.x;
        drop.y = mob.y;
        dungeon.floorItems.push(drop);
        dungeonLog(`💎 ${mob.name} は ${drop.name} を落とした！`, { rarity: drop.rarity });
        playSfx('drop', { rarityTier: rarityTier(drop.rarity) });
        _celebratePickup(drop, 'ドロップ');
      } else {
        dungeonLog(`${mob.name} を撃破`);
      }
    }
    dungeon.render(document.getElementById('dungeon-canvas'));
  });

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
