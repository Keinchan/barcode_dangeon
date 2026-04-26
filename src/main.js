import { initMap, addDungeonPin } from './map.js';
import { startScanner, stopScanner, getPosition } from './scanner.js';
import { generateDungeonData, createPlayer } from './generator.js';
import { Dungeon } from './dungeon.js';
import { Battle } from './battle.js';

// ── 状態 ──
let screen       = 'map';
let player       = createPlayer();
let dungeonData  = null;
let dungeon      = null;
let currentFloor = 1;
let battle       = null;
const clearedSet = new Set();

// ── 画面切替 ──
function show(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  screen = name;
}

// ─────────────────────────────────────────────
// マップ画面
// ─────────────────────────────────────────────
initMap();

document.getElementById('btn-scan').addEventListener('click', () => {
  show('scanner');
  launchScanner();
});

// ─────────────────────────────────────────────
// スキャン画面
// ─────────────────────────────────────────────
async function launchScanner() {
  document.getElementById('scan-result').classList.add('hidden');
  try {
    await startScanner(async barcode => {
      stopScanner();
      const pos = await getPosition();
      dungeonData = generateDungeonData(barcode, pos.lat, pos.lng);
      showDungeonPreview(dungeonData);
    });
  } catch (e) {
    alert('カメラを起動できません。HTTPS環境か、カメラの許可を確認してください。\n\n' + e.message);
    show('map');
  }
}

function showDungeonPreview(d) {
  document.getElementById('dungeon-preview').innerHTML =
    `<h3>${d.name}</h3>` +
    `<p>テーマ　：${d.theme.name}</p>` +
    `<p>属性　　：${d.element}</p>` +
    `<p>フロア　：B${d.floors}F</p>` +
    `<p>難易度　：${'⭐'.repeat(d.difficulty)}</p>` +
    `<p>レアリティ：<span style="color:${d.rarityBase.color}">${d.rarityBase.name}</span></p>` +
    `<p style="font-size:11px;color:#666;margin-top:6px">コード：${d.barcode}</p>`;
  document.getElementById('scan-result').classList.remove('hidden');
}

document.getElementById('btn-back-scan').addEventListener('click', () => {
  stopScanner();
  show('map');
});

document.getElementById('btn-enter-dungeon').addEventListener('click', () => {
  if (!dungeonData) return;
  getPosition().then(pos => {
    addDungeonPin(pos.lat, pos.lng, dungeonData, clearedSet.has(dungeonData.seed), enterDungeon);
    enterDungeon(dungeonData);
  });
});

// ─────────────────────────────────────────────
// ダンジョン
// ─────────────────────────────────────────────
function enterDungeon(data) {
  dungeonData  = data;
  player       = createPlayer();
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
  if (!dungeon || screen !== 'dungeon') return;
  const nx = dungeon.playerPos.x + dx;
  const ny = dungeon.playerPos.y + dy;
  if (!dungeon.canWalk(nx, ny)) return;

  const mob = dungeon.monsterAt(nx, ny);
  if (mob) { startBattle(mob); return; }

  dungeon.playerPos = { x: nx, y: ny };

  // アイテム自動ピックアップ
  const floorItem = dungeon.itemAt(nx, ny);
  if (floorItem) pickupItem(floorItem);

  // 階段チェック
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
  if (player.inventory.length >= 8) {
    dungeonLog(`🎒 満杯！ ${item.name} を拾えなかった`);
    return;
  }
  dungeon.removeFloorItem(item);

  // 武器・防具は自動装備（今より強ければ）
  if (item.type === 'weapon') {
    if (!player.weapon || item.atkBonus > player.weapon.atkBonus) {
      const old = player.weapon;
      player.weapon = item;
      player.atk    = player.atkBase + item.atkBonus;
      dungeonLog(`⚔️ ${item.name} を装備！ ATK+${item.atkBonus}`);
      if (old) player.inventory.push(old); // 外した装備はインベントリへ
    } else {
      player.inventory.push(item);
      dungeonLog(`🎒 ${item.name} を拾った`);
    }
  } else if (item.type === 'armor') {
    if (!player.armor || item.defBonus > player.armor.defBonus) {
      const old = player.armor;
      player.armor = item;
      player.def   = player.defBase + item.defBonus;
      dungeonLog(`🛡️ ${item.name} を装備！ DEF+${item.defBonus}`);
      if (old) player.inventory.push(old);
    } else {
      player.inventory.push(item);
      dungeonLog(`🎒 ${item.name} を拾った`);
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
    const map = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0], wait:[0,0] };
    const d   = map[btn.dataset.dir];
    if (d) move(...d);
  });
});

// キーボード（PC確認用）
document.addEventListener('keydown', e => {
  if (screen !== 'dungeon') return;
  const map = {
    ArrowUp:[0,-1], ArrowDown:[0,1], ArrowLeft:[-1,0], ArrowRight:[1,0],
    w:[0,-1], s:[0,1], a:[-1,0], d:[1,0], ' ':[0,0],
  };
  if (map[e.key]) { e.preventDefault(); move(...map[e.key]); }
});

// スワイプ（モバイル）
let touchStart = null;
const canvas   = document.getElementById('dungeon-canvas');
canvas.addEventListener('touchstart', e => {
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
canvas.addEventListener('touchend', e => {
  if (!touchStart) return;
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
  show('battle');
  battle = new Battle(player, mob, (result, defeated) => {
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
        show('dungeon');
        dungeon.render(document.getElementById('dungeon-canvas'));
      }
    } else if (result === 'lose') {
      showResult(false);
    } else if (result === 'run') {
      dungeonLog('逃げた！');
      show('dungeon');
      dungeon.render(document.getElementById('dungeon-canvas'));
    }
  });
  document.getElementById('battle-log').innerHTML = '';
  battle.updateUI();
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
  const usable = player.inventory.filter(it => it.type === 'potion' || it.type === 'scroll');
  const list   = document.getElementById('item-list');

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
  showResult(true);
}

function showResult(isWin) {
  show('result');
  document.getElementById('result-icon').textContent  = isWin ? '🎉' : '💀';
  document.getElementById('result-title').textContent = isWin ? '攻略成功！' : 'ゲームオーバー';
  document.getElementById('result-body').textContent  = isWin
    ? `${dungeonData.name} を踏破した！`
    : 'ダンジョンで力尽きた...';
}

document.getElementById('btn-result-back').addEventListener('click', () => {
  player = createPlayer();
  show('map');
});
