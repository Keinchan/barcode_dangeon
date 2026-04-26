import { initMap, refreshPin, setPlayerPosition } from './map.js';
import { startScanner, stopScanner, getPosition, categoryOfFormat } from './scanner.js';
import { createPlayer } from './generator.js';
import { generateItemFromBarcode, rarityFromDigit, bumpRarity } from './items.js';
import { Dungeon } from './dungeon.js';
import { Battle } from './battle.js';
import {
  DEBUG,
  setMockGps,
  clearMockGps,
  setBypassEnterRadius,
  getDebugState,
} from './debug.js';

// ── 状態 ──
let screen       = 'map';
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
}

// ─────────────────────────────────────────────
// マップ画面（位置ベース固定湧き）
// ─────────────────────────────────────────────
let pendingDungeon = null;

initMap({
  onEnter:   d => requestEnterDungeon(d),
  isCleared: seed => clearedSet.has(seed),
});

// 入場前モーダル
function requestEnterDungeon(d) {
  pendingDungeon = d;
  showPreDungeonModal(d);
}

function showPreDungeonModal(d) {
  const stars = '⭐'.repeat(d.difficulty);
  const cleared = clearedSet.has(d.seed) ? '<span style="color:#4caf50">✅ 攻略済み</span> ' : '';
  document.getElementById('pre-dungeon-info').innerHTML =
    `<div class="pre-dungeon-info-line"><span class="label">名称</span><b>${d.name}</b></div>` +
    `<div class="pre-dungeon-info-line"><span class="label">難易度</span>${stars} / B${d.floors}F</div>` +
    `<div class="pre-dungeon-info-line"><span class="label">レアリティ</span>` +
      `<span style="color:${d.rarityBase.color};font-weight:bold">${d.rarityBase.name}</span></div>` +
    `<div class="pre-dungeon-info-line"><span class="label">属性</span>${d.element}</div>` +
    (cleared ? `<div class="pre-dungeon-info-line">${cleared}（再戦可）</div>` : '');

  const w = player.weapon;
  const a = player.armor;
  const wLine = w
    ? `<div class="pre-dungeon-info-line">⚔️ <span style="color:${w.rarityColor}">${w.name}</span> ATK+${w.atkBonus}` +
      (w.skill?.name ? ` <span style="color:#888">(${w.skill.name})</span>` : '') + `</div>`
    : '<div class="pre-dungeon-info-line" style="color:#888">⚔️ 武器なし</div>';
  const aLine = a
    ? `<div class="pre-dungeon-info-line">🛡️ <span style="color:${a.rarityColor}">${a.name}</span> DEF+${a.defBonus}` +
      (a.skill?.name ? ` <span style="color:#888">(${a.skill.name})</span>` : '') + `</div>`
    : '<div class="pre-dungeon-info-line" style="color:#888">🛡️ 防具なし</div>';

  document.getElementById('pre-dungeon-player').innerHTML =
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
  document.getElementById('pre-dungeon-modal').classList.add('hidden');
  enterDungeon(d);
});

document.getElementById('btn-pre-cancel').addEventListener('click', () => {
  pendingDungeon = null;
  document.getElementById('pre-dungeon-modal').classList.add('hidden');
});

document.getElementById('btn-pre-menu').addEventListener('click', () => {
  // メニューを上に重ねて開く（pendingDungeon は維持）
  openMenu();
});

document.getElementById('btn-scan').addEventListener('click', () => {
  show('scanner');
  launchScanner();
});

document.getElementById('btn-menu').addEventListener('click', () => {
  openMenu();
});
document.getElementById('btn-menu-close').addEventListener('click', () => {
  document.getElementById('menu-modal').classList.add('hidden');
  // 入場前モーダルが裏にあれば、装備変更を反映するため再描画
  if (pendingDungeon) showPreDungeonModal(pendingDungeon);
});

// ダンジョン画面のメニューボタン
const btnDungeonMenu = document.getElementById('btn-dungeon-menu');
btnDungeonMenu.addEventListener('click', () => {
  if (combatActive) {
    alert('戦闘中はメニューを開けません');
    return;
  }
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
  document.getElementById('menu-hp').textContent  = `${player.hp}/${player.maxHp}`;
  document.getElementById('menu-atk').textContent = player.atk;
  document.getElementById('menu-def').textContent = player.def;

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
  div.innerHTML = `
    <div class="menu-row-emoji">${item.emoji}</div>
    <div class="menu-row-info">
      <div class="menu-row-name" style="color:${item.rarityColor}">${item.name}</div>
      <div class="menu-row-stat">${_statLine(item)} / ${item.rarity}</div>
      ${skillHtml}
    </div>
    <div class="menu-row-actions">
      <button class="menu-action-btn">外す</button>
    </div>
  `;
  div.querySelector('.menu-action-btn').addEventListener('click', () => {
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
      alert('持ち物が満杯のため外せません。先に何か廃棄してください');
      return;
    }
    _unequipDirect(slot);
    refreshHUD();
    refreshMenu();
    return;
  }

  _showSwapModal(slot, candidates);
}

function _unequipDirect(slot) {
  if (slot === 'weapon' && player.weapon) {
    player.inventory.push(player.weapon);
    player.weapon = null;
    player.atk    = player.atkBase;
  } else if (slot === 'armor' && player.armor) {
    player.inventory.push(player.armor);
    player.armor  = null;
    player.def    = player.defBase;
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
  div.innerHTML = `
    <div class="menu-row-emoji">${item.emoji}</div>
    <div class="menu-row-info">
      <div class="menu-row-name" style="color:${item.rarityColor}">${item.name}</div>
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
    alert('持ち物が満杯のため外せません');
    return;
  }
  _unequipDirect(slot);
  document.getElementById('swap-modal').classList.add('hidden');
  refreshHUD();
  refreshMenu();
});

document.getElementById('btn-swap-cancel').addEventListener('click', () => {
  document.getElementById('swap-modal').classList.add('hidden');
});

function _renderInventoryRow(item, idx) {
  const div = document.createElement('div');
  div.className = 'menu-row';
  const skillHtml = item.skill?.name
    ? `<div class="menu-row-skill">✨ ${item.skill.name}</div>` : '';
  const isEquippable = item.type === 'weapon' || item.type === 'armor';
  // 探索中は回復薬を使える（戦闘中はバトル側のアイテムボタン経由なのでここでは出さない）
  const isUsableHere = item.type === 'potion' && screen === 'dungeon' && !combatActive;
  div.innerHTML = `
    <div class="menu-row-emoji">${item.emoji}</div>
    <div class="menu-row-info">
      <div class="menu-row-name" style="color:${item.rarityColor}">${item.name}</div>
      <div class="menu-row-stat">${_statLine(item)} / ${item.rarity}</div>
      ${skillHtml}
    </div>
    <div class="menu-row-actions">
      ${isUsableHere ? '<button class="menu-action-btn use">使う</button>' : ''}
      ${isEquippable ? '<button class="menu-action-btn equip">装備</button>' : ''}
      <button class="menu-action-btn danger discard">廃棄</button>
    </div>
  `;
  if (isUsableHere) {
    div.querySelector('.use').addEventListener('click', () => _usePotionFromInventory(idx));
  }
  if (isEquippable) {
    div.querySelector('.equip').addEventListener('click', () => _equipFromInventory(idx));
  }
  div.querySelector('.discard').addEventListener('click', () => {
    if (!confirm(`${item.name} を廃棄しますか？`)) return;
    player.inventory.splice(idx, 1);
    refreshMenu();
  });
  return div;
}

function _usePotionFromInventory(idx) {
  const item = player.inventory[idx];
  if (!item || item.type !== 'potion') return;
  if (player.hp >= player.maxHp) {
    alert('HPが満タンです');
    return;
  }
  const before = player.hp;
  player.hp = Math.min(player.maxHp, player.hp + item.heal);
  const actual = player.hp - before;
  player.inventory.splice(idx, 1);
  if (typeof dungeonLog === 'function' && screen === 'dungeon') {
    dungeonLog(`🧪 ${item.name} を使用！ HPが${actual}回復した`);
  }
  refreshHUD();
  refreshMenu();
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
  refreshHUD();
  refreshMenu();
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
    alert('カメラを起動できません。HTTPS環境か、カメラの許可を確認してください。\n\n' + e.message);
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
  return generateItemFromBarcode(padded, rarityOverride);
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

  document.getElementById('item-result').innerHTML = `
    <div class="item-result-row">
      <div class="item-result-emoji">${item.emoji}</div>
      <div class="item-result-info">
        <div class="item-result-name">${item.name}</div>
        <div class="item-result-rarity" style="color:${item.rarityColor}">${item.rarity}</div>
      </div>
    </div>
    <div class="item-result-stats">${statsLine}</div>
    ${skillBlock}
    <div class="item-result-meta">${scan.format} / ${scan.text}${categoryLabel}</div>
  `;
  document.getElementById('scan-result').classList.remove('hidden');
}

document.getElementById('btn-back-scan').addEventListener('click', () => {
  stopScanner();
  pendingItem = null;
  show('map');
});

document.getElementById('btn-rescan').addEventListener('click', () => {
  pendingItem = null;
  launchScanner();
});

document.getElementById('btn-keep-item').addEventListener('click', () => {
  if (!pendingItem) return;
  const msg = _acquireItem(pendingItem);
  pendingItem = null;
  alert(msg);
  show('map');
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
  document.getElementById('player-hp').textContent = `HP: ${player.hp}/${player.maxHp}`;
  const wName = player.weapon ? `⚔️${player.weapon.atkBonus}` : '⚔️ー';
  const aName = player.armor  ? `🛡️${player.armor.defBonus}`  : '🛡️ー';
  document.getElementById('equip-display').textContent = `${wName}　${aName}`;
}

function dungeonLog(msg) {
  const el = document.getElementById('dungeon-log');
  el.innerHTML = `<div>${msg}</div>` + el.innerHTML;
  const lines = el.querySelectorAll('div');
  if (lines.length > 4) lines[lines.length - 1].remove();
}

// ── 移動 ──
function move(dx, dy) {
  if (!dungeon || screen !== 'dungeon' || combatActive) return;
  const nx = dungeon.playerPos.x + dx;
  const ny = dungeon.playerPos.y + dy;
  if (!dungeon.canWalk(nx, ny)) return;

  const mob = dungeon.monsterAt(nx, ny);
  if (mob) { startBattle(mob); return; }

  dungeon.playerPos = { x: nx, y: ny };

  const floorItem = dungeon.itemAt(nx, ny);
  if (floorItem) pickupItem(floorItem);

  if (dungeon.atStairs(nx, ny)) {
    if (currentFloor >= dungeonData.floors) {
      dungeonClear();
    } else {
      dungeonLog(`B${currentFloor + 1}F へ降りた`);
      loadFloor(currentFloor + 1);
    }
    return;
  }

  dungeon.render(document.getElementById('dungeon-canvas'));
}

function pickupItem(item) {
  if (player.inventory.length >= 8 && item.type !== 'weapon' && item.type !== 'armor') {
    dungeonLog(`🎒 満杯！ ${item.name} を拾えなかった`);
    return;
  }
  dungeon.removeFloorItem(item);

  if (item.type === 'weapon') {
    if (!player.weapon || item.atkBonus > player.weapon.atkBonus) {
      const old = player.weapon;
      player.weapon = item;
      player.atk    = player.atkBase + item.atkBonus;
      dungeonLog(`⚔️ ${item.name} を装備！ ATK+${item.atkBonus}`);
      if (old && player.inventory.length < 8) player.inventory.push(old);
    } else if (player.inventory.length < 8) {
      player.inventory.push(item);
      dungeonLog(`🎒 ${item.name} を拾った`);
    } else {
      dungeonLog(`🎒 満杯！ ${item.name} を拾えなかった`);
    }
  } else if (item.type === 'armor') {
    if (!player.armor || item.defBonus > player.armor.defBonus) {
      const old = player.armor;
      player.armor = item;
      player.def   = player.defBase + item.defBonus;
      dungeonLog(`🛡️ ${item.name} を装備！ DEF+${item.defBonus}`);
      if (old && player.inventory.length < 8) player.inventory.push(old);
    } else if (player.inventory.length < 8) {
      player.inventory.push(item);
      dungeonLog(`🎒 ${item.name} を拾った`);
    } else {
      dungeonLog(`🎒 満杯！ ${item.name} を拾えなかった`);
    }
  } else {
    player.inventory.push(item);
    dungeonLog(`🎒 ${item.name} を拾った`);
  }

  refreshHUD();
  dungeon.render(document.getElementById('dungeon-canvas'));
}

// D-パッド
document.querySelectorAll('.dpad-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const m = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0], wait:[0,0] };
    const d = m[btn.dataset.dir];
    if (d) move(...d);
  });
});

// キーボード（PC確認用）
document.addEventListener('keydown', e => {
  if (screen !== 'dungeon' || combatActive) return;
  const m = {
    ArrowUp:[0,-1], ArrowDown:[0,1], ArrowLeft:[-1,0], ArrowRight:[1,0],
    w:[0,-1], s:[0,1], a:[-1,0], d:[1,0], ' ':[0,0],
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
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
  if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 1 : -1, 0);
  else                              move(0, dy > 0 ? 1 : -1);
  touchStart = null;
}, { passive: true });

// ─────────────────────────────────────────────
// バトル
// ─────────────────────────────────────────────
function startBattle(mob) {
  // 戦闘モードに切替（screen は dungeon のままインライン化）
  combatActive = true;
  document.getElementById('dungeon-footer').classList.add('hidden');
  document.getElementById('combat-panel').classList.remove('hidden');

  battle = new Battle(player, mob, (result, defeated) => {
    // 戦闘終了：探索モードに復帰
    combatActive = false;
    document.getElementById('combat-panel').classList.add('hidden');
    document.getElementById('dungeon-footer').classList.remove('hidden');

    player.hp  = battle.player.hp;
    player.atk = battle.player.atk;
    player.def = battle.player.def;
    refreshHUD();

    if (result === 'win') {
      dungeon.removeMonster(defeated);
      if (defeated.isBoss) {
        dungeonClear();
      } else {
        dungeonLog(`${defeated.name} を倒した！`);
        // フッターが探索パネルに戻ったので canvas を再サイズ
        requestAnimationFrame(() => dungeon.render(document.getElementById('dungeon-canvas')));
      }
    } else if (result === 'lose') {
      showResult(false);
    } else if (result === 'run') {
      dungeonLog('逃げた！');
      requestAnimationFrame(() => dungeon.render(document.getElementById('dungeon-canvas')));
    }
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
      return `
        <div class="item-row${canUse ? '' : ' disabled'}" data-idx="${idx}">
          <span class="item-emoji">${it.emoji}</span>
          <div class="item-info">
            <div class="item-name">${it.name}</div>
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
}

document.getElementById('btn-result-back').addEventListener('click', () => {
  show('map');
});

// ─────────────────────────────────────────────
// デバッグパネル（?debug=1 で有効）
// ─────────────────────────────────────────────
if (DEBUG) {
  const panel = document.getElementById('debug-panel');
  panel.classList.remove('hidden');

  // 折り畳み
  document.getElementById('debug-toggle').addEventListener('click', () => {
    const body = document.getElementById('debug-panel-body');
    const btn  = document.getElementById('debug-toggle');
    const collapsed = body.classList.toggle('collapsed');
    btn.textContent = collapsed ? '+' : '−';
  });

  // モックスキャン
  document.getElementById('debug-mock-scan').addEventListener('click', () => {
    if (combatActive) {
      alert('戦闘中はスキャンできません（戦闘を終わらせてください）');
      return;
    }
    if (screen === 'dungeon') {
      alert('ダンジョン内ではスキャンできません（マップに戻ってから）');
      return;
    }
    const text   = document.getElementById('debug-scan-text').value.trim();
    const format = document.getElementById('debug-scan-format').value;
    if (!/^\d{8,20}$/.test(text)) {
      alert('バーコードは数字8〜20桁で入力してください');
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
      alert('緯度経度の入力が不正です');
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
    if (player.inventory.length >= 8) {
      alert('インベントリ満杯です（先に廃棄）');
      return;
    }
    const rarity = RARITY_NAMES[Math.floor(Math.random() * RARITY_NAMES.length)];
    const code   = DEBUG_ITEM_CODES[type][rarity];
    const item   = generateItemFromBarcode(code);
    player.inventory.push(item);
    if (!document.getElementById('menu-modal').classList.contains('hidden')) refreshMenu();
  }

  document.getElementById('debug-add-weapon').addEventListener('click', () => debugAddItem('weapon'));
  document.getElementById('debug-add-armor' ).addEventListener('click', () => debugAddItem('armor'));
  document.getElementById('debug-add-potion').addEventListener('click', () => debugAddItem('potion'));
  document.getElementById('debug-add-scroll').addEventListener('click', () => debugAddItem('scroll'));

  document.getElementById('debug-clear-inv').addEventListener('click', () => {
    if (!confirm('インベントリと装備を全廃棄します')) return;
    player.inventory = [];
    player.weapon = null;
    player.armor  = null;
    player.atk    = player.atkBase;
    player.def    = player.defBase;
    if (!document.getElementById('menu-modal').classList.contains('hidden')) refreshMenu();
  });
}
