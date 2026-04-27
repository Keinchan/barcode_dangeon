import { createRNG, hashString } from './rng.js';
import { generateMonster, generateFloorItems } from './generator.js';
import { getDebugState } from './debug.js';
import { getItemIconCanvas } from './icons.js';

const W = 21;
const H = 19;
const T = { WALL: 0, FLOOR: 1, STAIRS: 2 };

export class Dungeon {
  constructor(dungeonData, floor) {
    this.data       = dungeonData;
    this.floor      = floor;
    this.isFinal    = floor === dungeonData.floors;
    this.rng        = createRNG(hashString(`${dungeonData.seed}:${floor}`));
    this.grid       = [];
    this.monsters   = [];
    this.floorItems = [];
    this.rooms      = [];
    this.playerPos  = { x: 2, y: 2 };
    this.stairsPos  = null;
    this.discovered = Array.from({ length: H }, () => new Uint8Array(W));
    this.visible    = new Set();
    this._build();
  }

  _build() {
    this.grid = Array.from({ length: H }, () => new Uint8Array(W));

    const rooms = this._genRooms(4 + Math.floor(this.rng() * 3));
    this.rooms  = rooms;
    rooms.forEach(r => this._carve(r));
    for (let i = 0; i + 1 < rooms.length; i++) {
      this._corridor(this._center(rooms[i]), this._center(rooms[i + 1]));
    }

    const c0 = this._center(rooms[0]);
    this.playerPos = { x: c0.x, y: c0.y };

    const cl = this._center(rooms[rooms.length - 1]);
    this.stairsPos = { x: cl.x, y: cl.y };
    this.grid[cl.y][cl.x] = T.STAIRS;

    rooms.slice(1).forEach((room, i) => {
      const isLast  = i === rooms.length - 2;
      const isFinal = this.isFinal;

      if (isLast && isFinal) {
        const bc   = this._center(room);
        const boss = generateMonster(this.data, this.floor, true);
        boss.x = bc.x; boss.y = bc.y;
        this.monsters.push(boss);
      } else {
        const count = 1 + Math.floor(this.rng() * 2);
        for (let m = 0; m < count; m++) {
          const mx = room.x + 1 + Math.floor(this.rng() * Math.max(1, room.w - 2));
          const my = room.y + 1 + Math.floor(this.rng() * Math.max(1, room.h - 2));
          if (this.grid[my][mx] === T.FLOOR && !this._monsterAt(mx, my)) {
            const mob = generateMonster(this.data, this.floor, false);
            mob.x = mx; mob.y = my;
            this.monsters.push(mob);
          }
        }
      }
    });

    this.floorItems = generateFloorItems(this.data, this.floor, rooms);
  }

  _genRooms(target) {
    const rooms = [];
    for (let t = 0; t < target * 15 && rooms.length < target; t++) {
      const w = 4 + Math.floor(this.rng() * 5);
      const h = 3 + Math.floor(this.rng() * 4);
      const x = 1 + Math.floor(this.rng() * (W - w - 2));
      const y = 1 + Math.floor(this.rng() * (H - h - 2));
      const r = { x, y, w, h };
      if (!rooms.some(e => this._overlap(e, r))) rooms.push(r);
    }
    return rooms;
  }

  _overlap(a, b) {
    return !(a.x + a.w + 1 <= b.x || b.x + b.w + 1 <= a.x ||
             a.y + a.h + 1 <= b.y || b.y + b.h + 1 <= a.y);
  }

  _carve(r) {
    for (let y = r.y; y < r.y + r.h && y < H - 1; y++)
      for (let x = r.x; x < r.x + r.w && x < W - 1; x++)
        this.grid[y][x] = T.FLOOR;
  }

  _corridor(a, b) {
    let { x, y } = a;
    while (x !== b.x) { this.grid[y][x] = T.FLOOR; x += x < b.x ? 1 : -1; }
    while (y !== b.y) { this.grid[y][x] = T.FLOOR; y += y < b.y ? 1 : -1; }
  }

  _center(r) {
    return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
  }

  _monsterAt(x, y) {
    return this.monsters.find(m => m.x === x && m.y === y && m.hp > 0);
  }

  monsterAt(x, y)     { return this._monsterAt(x, y); }
  itemAt(x, y)        { return this.floorItems.find(i => i.x === x && i.y === y); }
  removeMonster(m)    { const i = this.monsters.indexOf(m);    if (i !== -1) this.monsters.splice(i, 1); }
  removeFloorItem(it) { const i = this.floorItems.indexOf(it); if (i !== -1) this.floorItems.splice(i, 1); }

  canWalk(x, y) {
    return x >= 0 && x < W && y >= 0 && y < H && this.grid[y][x] !== T.WALL;
  }

  atStairs(x, y) {
    return this.stairsPos && x === this.stairsPos.x && y === this.stairsPos.y;
  }

  // ── 視界システム ──
  roomAt(x, y) {
    return this.rooms.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  }

  computeVisible(px, py) {
    const vis = new Set();
    const add = (x, y) => {
      if (x >= 0 && x < W && y >= 0 && y < H) vis.add(`${x},${y}`);
    };

    add(px, py);
    // 8近傍は常時可視
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        add(px + dx, py + dy);

    // 同じ部屋全体
    const room = this.roomAt(px, py);
    if (room) {
      for (let y = room.y; y < room.y + room.h; y++)
        for (let x = room.x; x < room.x + room.w; x++)
          add(x, y);
    }

    // 4方向のレイ（壁で停止、通路一直線可視）
    for (const [dx, dy] of [[1,0], [-1,0], [0,1], [0,-1]]) {
      let x = px, y = py;
      while (true) {
        x += dx; y += dy;
        if (x < 0 || x >= W || y < 0 || y >= H) break;
        if (this.grid[y][x] === T.WALL) break;
        add(x, y);
      }
    }

    return vis;
  }

  refreshVisibility() {
    this.visible = this.computeVisible(this.playerPos.x, this.playerPos.y);
    for (const k of this.visible) {
      const [x, y] = k.split(',').map(Number);
      this.discovered[y][x] = 1;
    }
  }

  // ── 敵AI（プレイヤー行動後に呼ぶ）──
  // 戻り値: { events: [{type, mob, dmg}, ...], totalDmg }
  // ルール: 魔法攻撃の射程＝8近傍（壁貫通）。射程外なら必ずプレイヤーへ向かって移動
  tickEnemies(player) {
    if (getDebugState().disableEnemyAI) return { events: [], totalDmg: 0 };

    const events = [];
    let totalDmg = 0;

    for (const m of this.monsters) {
      if (m.hp <= 0) continue;

      const adx = Math.abs(m.x - this.playerPos.x);
      const ady = Math.abs(m.y - this.playerPos.y);
      const inMagicRange = adx <= 1 && ady <= 1 && !(adx === 0 && ady === 0);

      if (inMagicRange) {
        // 魔法攻撃（壁貫通）
        const base = Math.max(1, m.atk - player.def);
        const roll = 1 + Math.floor(Math.random() * Math.ceil(base * 0.4));
        const dmg  = base + roll;
        events.push({ type: 'magic', mob: m, dmg });
        totalDmg += dmg;
        continue;
      }

      // 射程外 → プレイヤーへ向かって移動（無条件追跡）
      const dx = Math.sign(this.playerPos.x - m.x);
      const dy = Math.sign(this.playerPos.y - m.y);
      const dxLarger = adx >= ady;
      const tryStep = (sx, sy) => {
        if (sx === 0 && sy === 0) return false;
        // モンスター側の移動も「壁角の斜め抜け」を禁止して挙動を統一
        if (sx !== 0 && sy !== 0) {
          if (!this.canWalk(m.x + sx, m.y) || !this.canWalk(m.x, m.y + sy)) return false;
        }
        return this._canMonsterStep(m.x + sx, m.y + sy, m);
      };
      if (dxLarger) {
        if      (tryStep(dx, 0))  m.x += dx;
        else if (tryStep(0, dy))  m.y += dy;
        else if (tryStep(dx, dy)) { m.x += dx; m.y += dy; }
      } else {
        if      (tryStep(0, dy))  m.y += dy;
        else if (tryStep(dx, 0))  m.x += dx;
        else if (tryStep(dx, dy)) { m.x += dx; m.y += dy; }
      }
    }

    return { events, totalDmg };
  }

  _canMonsterStep(x, y, self) {
    if (!this.canWalk(x, y)) return false;
    if (this.playerPos.x === x && this.playerPos.y === y) return false;
    const other = this._monsterAt(x, y);
    return !other || other === self;
  }

  _monsterSeesPlayer(m) {
    const r  = this.roomAt(m.x, m.y);
    const pr = this.roomAt(this.playerPos.x, this.playerPos.y);
    if (r && r === pr) return true;

    if (m.x === this.playerPos.x) {
      const y0 = Math.min(m.y, this.playerPos.y);
      const y1 = Math.max(m.y, this.playerPos.y);
      for (let y = y0 + 1; y < y1; y++) {
        if (this.grid[y][m.x] === T.WALL) return false;
      }
      return true;
    }
    if (m.y === this.playerPos.y) {
      const x0 = Math.min(m.x, this.playerPos.x);
      const x1 = Math.max(m.x, this.playerPos.x);
      for (let x = x0 + 1; x < x1; x++) {
        if (this.grid[m.y][x] === T.WALL) return false;
      }
      return true;
    }
    return false;
  }

  // ── Canvas 描画 ──
  render(canvas) {
    const VIEW = 11;
    const half = Math.floor(VIEW / 2);
    const header  = document.querySelector('#screen-dungeon .dungeon-header');
    const combat  = document.getElementById('combat-panel');
    const explore = document.getElementById('dungeon-footer');
    const visibleFooter =
      combat  && !combat.classList .contains('hidden') ? combat  :
      explore && !explore.classList.contains('hidden') ? explore : null;

    const headerH = header?.offsetHeight ?? 60;
    const footerH = visibleFooter?.offsetHeight ?? 200;
    const availW  = window.innerWidth;
    const availH  = window.innerHeight - headerH - footerH - 16;
    const size = Math.max(220, Math.min(availW, availH, 480));
    const ts = Math.max(20, Math.floor(size / VIEW));
    canvas.width  = ts * VIEW;
    canvas.height = ts * VIEW;
    canvas.style.width  = canvas.width  + 'px';
    canvas.style.height = canvas.height + 'px';

    this.refreshVisibility();
    const dbg       = getDebugState();
    const revealAll = !!dbg.revealAll;

    const ctx   = canvas.getContext('2d');
    const { x: px, y: py } = this.playerPos;
    const theme = this.data.theme;

    for (let dy = 0; dy < VIEW; dy++) {
      for (let dx = 0; dx < VIEW; dx++) {
        const wx = px - half + dx;
        const wy = py - half + dy;
        const sx = dx * ts;
        const sy = dy * ts;

        const outOfBounds = wx < 0 || wx >= W || wy < 0 || wy >= H;
        const isVisible    = revealAll || (!outOfBounds && this.visible.has(`${wx},${wy}`));
        const isDiscovered = revealAll || (!outOfBounds && this.discovered[wy][wx] === 1);

        if (outOfBounds || (!isVisible && !isDiscovered)) {
          ctx.fillStyle = '#000';
          ctx.fillRect(sx, sy, ts, ts);
          continue;
        }

        const isWall = this.grid[wy][wx] === T.WALL;
        if (isVisible) {
          ctx.fillStyle = isWall ? theme.wallColor : theme.floorColor;
        } else {
          // 既踏だが現視野外: テーマに依らない統一の暗色で、視野内とハッキリ差をつける
          ctx.fillStyle = isWall ? '#23232c' : '#0f0f17';
        }
        ctx.fillRect(sx, sy, ts, ts);

        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.strokeRect(sx, sy, ts, ts);

        // 視野内の壁には微かなハイライトでさらに視認性UP
        if (isVisible && isWall) {
          ctx.strokeStyle = 'rgba(255,255,255,0.07)';
          ctx.strokeRect(sx + 0.5, sy + 0.5, ts - 1, ts - 1);
        }

        if (this.grid[wy][wx] === T.STAIRS) {
          const fs = Math.floor(ts * 0.65);
          ctx.font = `${fs}px serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          if (!isVisible) ctx.globalAlpha = 0.55;
          ctx.fillText('🔽', sx + ts / 2, sy + ts / 2);
          ctx.globalAlpha = 1;
        }
      }
    }

    // アイテム（現視野内のみ。既踏でも非表示にして「拾われたかも」のミスリードを避ける）
    //   絵文字ではなく手続きアイコンを drawImage する
    for (const it of this.floorItems) {
      const dx = it.x - (px - half);
      const dy = it.y - (py - half);
      if (dx < 0 || dx >= VIEW || dy < 0 || dy >= VIEW) continue;
      if (!revealAll && !this.visible.has(`${it.x},${it.y}`)) continue;
      const iconSize = Math.max(20, Math.floor(ts * 0.85));
      const icon = getItemIconCanvas(it, 64);
      const ix = dx * ts + (ts - iconSize) / 2;
      const iy = dy * ts + (ts - iconSize) / 2;
      ctx.drawImage(icon, ix, iy, iconSize, iconSize);
    }

    // モンスター（現視野内のみ）
    for (const m of this.monsters) {
      if (m.hp <= 0) continue;
      const dx = m.x - (px - half);
      const dy = m.y - (py - half);
      if (dx < 0 || dx >= VIEW || dy < 0 || dy >= VIEW) continue;
      if (!revealAll && !this.visible.has(`${m.x},${m.y}`)) continue;
      const fs = Math.floor(ts * 0.65);
      ctx.font = `${fs}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.emoji, dx * ts + ts / 2, dy * ts + ts / 2);

      if (m.isBoss) {
        ctx.strokeStyle = 'gold';
        ctx.lineWidth = 2;
        ctx.strokeRect(dx * ts + 2, dy * ts + 2, ts - 4, ts - 4);
        ctx.lineWidth = 1;
      } else {
        ctx.fillStyle = m.rarityColor ?? '#9e9e9e';
        ctx.beginPath();
        ctx.arc(dx * ts + 6, dy * ts + 6, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // プレイヤー（常に中央）
    const fs = Math.floor(ts * 0.65);
    ctx.font = `${fs}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🧙', half * ts + ts / 2, half * ts + ts / 2);

    // ミニマップ
    const mini = document.getElementById('minimap');
    if (mini) this._renderMinimap(mini);
  }

  // ── ミニマップ描画（既踏マスのみ、視野内は強調） ──
  _renderMinimap(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const tx = w / W;
    const ty = h / H;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, w, h);

    const dbg = getDebugState();
    const revealAll = !!dbg.revealAll;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const isDiscovered = revealAll || this.discovered[y][x] === 1;
        if (!isDiscovered) continue;
        const isVisible = revealAll || this.visible.has(`${x},${y}`);
        const isWall    = this.grid[y][x] === T.WALL;

        if (this.grid[y][x] === T.STAIRS) {
          ctx.fillStyle = isVisible ? '#4caf50' : '#2e6b32';
        } else if (isWall) {
          ctx.fillStyle = isVisible ? '#888' : '#444';
        } else {
          ctx.fillStyle = isVisible ? '#ddd' : '#777';
        }
        ctx.fillRect(x * tx, y * ty, Math.ceil(tx), Math.ceil(ty));
      }
    }

    // 視野内モンスター（オレンジ点）
    for (const m of this.monsters) {
      if (m.hp <= 0) continue;
      if (!revealAll && !this.visible.has(`${m.x},${m.y}`)) continue;
      ctx.fillStyle = '#ff9800';
      const r = Math.max(1, Math.min(tx, ty) * 0.5);
      ctx.beginPath();
      ctx.arc(m.x * tx + tx / 2, m.y * ty + ty / 2, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // プレイヤー（赤点）
    ctx.fillStyle = '#ff5252';
    const pr = Math.max(1.5, Math.min(tx, ty) * 0.65);
    ctx.beginPath();
    ctx.arc(this.playerPos.x * tx + tx / 2, this.playerPos.y * ty + ty / 2, pr, 0, Math.PI * 2);
    ctx.fill();
  }
}
