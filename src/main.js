import { initMap, refreshPin, setPlayerPosition, invalidateMapSize, recenterOnPlayer } from './map.js';
import { startScanner, stopScanner, getPosition, categoryOfFormat } from './scanner.js';
import {
  createPlayer,
  applyLevelStats,
  xpRequiredForLevel,
  statsForLevel,
  enemyLevel,
  MAX_LEVEL,
  HP_PER_LEVEL,
  ATK_PER_LEVEL,
  DEF_PER_LEVEL,
} from './generator.js';
import { generateItemFromBarcode, rarityFromDigit, bumpRarity, RARITIES } from './items.js';
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

document.getElementById('btn-scan').addEventListener('click', () => {
  playSfx('click');
  show('scanner');
  launchScanner();
});

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
  document.getElementById('menu-atk').textContent = player.atk;
  document.getElementById('menu-def').textContent = player.def;

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
  if (_storageCat !== 'all') arr = arr.filter(x => x.it.type === _storageCat);
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
  div.innerHTML = `
    <div class="menu-row-emoji">${iconImg(item, 38)}</div>
    <div class="menu-row-info">
      <div class="menu-row-name" style="color:${item.rarityColor}">${item.name} ${lvHtml}</div>
      <div class="menu-row-stat">${_statLine(item)} / ${item.rarity}</div>
      ${skillHtml}
    </div>
    <div class="menu-row-actions">
      <button class="menu-action-btn move withdraw">→持ち物</button>
      <button class="menu-action-btn danger discard">廃棄</button>
    </div>
  `;
  div.querySelector('.withdraw').addEventListener('click', () => {
    if (player.inventory.length >= 8) {
      showAlert('持ち物が満杯です');
      return;
    }
    const it = player.storage.splice(idx, 1)[0];
    if (it) {
      player.inventory.push(it);
      playSfx('equip');
      refreshMenu();
      autoSave();
    }
  });
  div.querySelector('.discard').addEventListener('click', async () => {
    const ok = await showConfirm(`${item.name} を廃棄しますか？`, { danger: true, okLabel: '廃棄' });
    if (!ok) return;
    player.storage.splice(idx, 1);
    playSfx('discard');
    refreshMenu();
    autoSave();
  });
  return div;
}

// 持ち物 → ストレージ単品送り（_renderInventoryRow にボタンを追加するヘルパ）
function _depositToStorage(idx) {
  const it = player.inventory.splice(idx, 1)[0];
  if (!it) return;
  player.storage.push(it);
  playSfx('discard');
  refreshMenu();
  autoSave();
}

// ボス撃破直後など、フロアに置けないドロップを自動取得。
// インベントリに余裕があればそこに、満杯ならストレージに退避（永久消失を防ぐ）。
function _autoCollectDrop(drop) {
  if (!Array.isArray(player.storage)) player.storage = [];
  let toStorage = false;
  if (player.inventory.length < 8) {
    player.inventory.push(drop);
  } else {
    player.storage.push(drop);
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
  if (item.type === 'potion') return `HP +${item.heal} 回復`;
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
  const isUsableHere = item.type === 'potion' && screen === 'dungeon' && !combatActive;
  const hasMainAction = isEquippable || isUsableHere;
  const action =
    isEquippable ? 'equip' :
    isUsableHere ? 'use' : 'none';

  const lvHtml = item.level ? `<span class="menu-row-lv">Lv${item.level}</span>` : '';
  div.innerHTML = `
    <button class="menu-row-main" data-action="${action}" ${hasMainAction ? '' : 'disabled'}>
      <div class="menu-row-emoji">${iconImg(item, 38)}</div>
      <div class="menu-row-info">
        <div class="menu-row-name" style="color:${item.rarityColor}">${item.name} ${lvHtml}</div>
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
        if (player.hp >= player.maxHp) {
          showAlert('HPが満タンです');
          return;
        }
        showActionConfirm(`${item.name} を使いますか？`, item, '使う', () => {
          _usePotionFromInventory(idx);
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

function _usePotionFromInventory(idx) {
  const item = player.inventory[idx];
  if (!item || item.type !== 'potion') return;
  if (player.hp >= player.maxHp) {
    showAlert('HPが満タンです');
    return;
  }
  const before = player.hp;
  player.hp = Math.min(player.maxHp, player.hp + item.heal);
  const actual = player.hp - before;
  player.inventory.splice(idx, 1);
  if (typeof dungeonLog === 'function' && screen === 'dungeon') {
    dungeonLog(`🧪 ${item.name} を使用！ HPが${actual}回復した`);
  }
  playSfx('drink');
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
    item.type === 'potion' ? `HP +${item.heal} 回復` :
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
      if (old && player.inventory.length < 8) player.inventory.push(old);
      return `⚔️ ${item.name} を装備！`;
    }
  } else if (item.type === 'armor') {
    if (!player.armor || item.defBonus > player.armor.defBonus) {
      const old = player.armor;
      player.armor = item;
      player.def   = player.defBase + item.defBonus;
      if (old && player.inventory.length < 8) player.inventory.push(old);
      return `🛡️ ${item.name} を装備！`;
    }
  }
  if (player.inventory.length >= 8) {
    return `🎒 持ち物が満杯！ ${item.name} を諦めた...`;
  }
  player.inventory.push(item);
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
  player.hp    = player.maxHp;     // 入場時に全回復
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
  refreshHUD();
  dungeonLog(`B${floor}F に入った`);
  dungeon.render(document.getElementById('dungeon-canvas'));
}

function refreshHUD() {
  document.getElementById('player-lv').textContent = `Lv${player.level}`;
  document.getElementById('player-hp').textContent = `HP: ${player.hp}/${player.maxHp}`;
  const wName = player.weapon ? `${player.weapon.emoji} +${player.weapon.atkBonus}` : '⚔️ ー';
  const aName = player.armor  ? `${player.armor.emoji} +${player.armor.defBonus}`  : '🛡️ ー';
  document.getElementById('equip-display').textContent = `${wName}　${aName}`;
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
    if (mob) { startBattle(mob); return; }   // 戦闘パネル発動 → 敵ターン無し

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
  if (player.inventory.length >= 8 && item.type !== 'weapon' && item.type !== 'armor') {
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
      if (old && player.inventory.length < 8) player.inventory.push(old);
      action = '装備';
    } else if (player.inventory.length < 8) {
      player.inventory.push(item);
      dungeonLog(`🎒 ${item.name} を拾った`, { rarity: item.rarity });
    } else {
      dungeonLog(`🎒 満杯！ ${item.name} を拾えなかった`);
      return;
    }
  } else if (item.type === 'armor') {
    if (!player.armor || item.defBonus > player.armor.defBonus) {
      const old = player.armor;
      player.armor = item;
      player.def   = player.defBase + item.defBonus;
      dungeonLog(`🛡️ ${item.name} を装備！ DEF+${item.defBonus}`, { rarity: item.rarity });
      if (old && player.inventory.length < 8) player.inventory.push(old);
      action = '装備';
    } else if (player.inventory.length < 8) {
      player.inventory.push(item);
      dungeonLog(`🎒 ${item.name} を拾った`, { rarity: item.rarity });
    } else {
      dungeonLog(`🎒 満杯！ ${item.name} を拾えなかった`);
      return;
    }
  } else {
    player.inventory.push(item);
    dungeonLog(`🎒 ${item.name} を拾った`, { rarity: item.rarity });
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
      // XP獲得
      gainXp(_xpFromMonster(mob));
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

// モンスター撃破時のドロップ判定
function _rollMonsterDrop(mob) {
  const dbg = getDebugState();
  const dropChance = dbg.forceDrop ? 1 :
    mob.isBoss               ? 1.0 :
    mob.rarity === 'レジェンド' ? 0.8 :
    mob.rarity === 'エピック'   ? 0.5 :
    mob.rarity === 'レア'       ? 0.3 :
    0.2;
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
      const canUse = it.type === 'potion' || it.type === 'scroll';
      const lvHtml = it.level ? `<span class="menu-row-lv">Lv${it.level}</span>` : '';
      return `
        <div class="item-row${canUse ? '' : ' disabled'}" data-idx="${idx}">
          <span class="item-emoji">${iconImg(it, 32)}</span>
          <div class="item-info">
            <div class="item-name">${it.name} ${lvHtml}</div>
            <div class="item-desc">${it.desc}</div>
          </div>
          <span class="item-rarity" style="color:${it.rarityColor}">${it.rarity}</span>
        </div>`;
    }).join('');

    list.querySelectorAll('.item-row:not(.disabled)').forEach(row => {
      row.addEventListener('click', () => {
        const idx  = parseInt(row.dataset.idx, 10);
        const item = player.inventory[idx];
        player.inventory.splice(idx, 1);
        document.getElementById('item-modal').classList.add('hidden');
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
      atkBase: player.atkBase,
      defBase: player.defBase,
      atk: player.atk,
      def: player.def,
      weapon: player.weapon,
      armor: player.armor,
      inventory: player.inventory,
      storage:   player.storage ?? [],
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
  clearedSet.clear();
  if (Array.isArray(data.clearedSeeds)) {
    for (const s of data.clearedSeeds) clearedSet.add(s);
  }
  refreshHUD();
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

  document.getElementById('debug-clear-inv').addEventListener('click', async () => {
    const ok = await showConfirm('インベントリと装備を全廃棄します', { danger: true, okLabel: '全廃棄' });
    if (!ok) return;
    player.inventory = [];
    player.weapon = null;
    player.armor  = null;
    player.atk    = player.atkBase;
    player.def    = player.defBase;
    if (!document.getElementById('menu-modal').classList.contains('hidden')) refreshMenu();
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
