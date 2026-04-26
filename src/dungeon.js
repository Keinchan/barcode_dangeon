import { createRNG, hashString } from './rng.js';
import { generateMonster, generateFloorItems } from './generator.js';

const W = 21;
const H = 19;
const T = { WALL: 0, FLOOR: 1, STAIRS: 2 };

export class Dungeon {
  constructor(dungeonData, floor) {
    this.data      = dungeonData;
    this.floor     = floor;
    this.isFinal   = floor === dungeonData.floors;
    this.rng       = createRNG(hashString(`${dungeonData.seed}:${floor}`));
    this.grid      = [];
    this.monsters  = [];
    this.floorItems = [];  // 床に落ちているアイテム
    this.rooms     = [];
    this.playerPos = { x: 2, y: 2 };
    this.stairsPos = null;
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

    // プレイヤー開始位置
    const c0 = this._center(rooms[0]);
    this.playerPos = { x: c0.x, y: c0.y };

    // 階段
    const cl = this._center(rooms[rooms.length - 1]);
    this.stairsPos = { x: cl.x, y: cl.y };
    this.grid[cl.y][cl.x] = T.STAIRS;

    // モンスター配置
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

    // アイテム配置
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

  // ── Canvas 描画 ──
  render(canvas) {
    const VIEW = 11;
    const half = Math.floor(VIEW / 2);
    // 実際のヘッダー/フッター高さを測定して canvas に必要な空間を確保。
    // canvas は flex-shrink:0 なので flex の伸縮に巻き込まれない（測定は安定）。
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

    const ctx   = canvas.getContext('2d');
    const { x: px, y: py } = this.playerPos;
    const theme = this.data.theme;

    // タイル
    for (let dy = 0; dy < VIEW; dy++) {
      for (let dx = 0; dx < VIEW; dx++) {
        const wx = px - half + dx;
        const wy = py - half + dy;
        const sx = dx * ts;
        const sy = dy * ts;

        const outOfBounds = wx < 0 || wx >= W || wy < 0 || wy >= H;
        ctx.fillStyle = (outOfBounds || this.grid[wy][wx] === T.WALL)
          ? theme.wallColor
          : theme.floorColor;
        ctx.fillRect(sx, sy, ts, ts);
        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        ctx.strokeRect(sx, sy, ts, ts);

        if (outOfBounds) continue;

        const fs = Math.floor(ts * 0.65);
        ctx.font = `${fs}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const cx = sx + ts / 2;
        const cy = sy + ts / 2;

        if (this.grid[wy][wx] === T.STAIRS) ctx.fillText('🔽', cx, cy);
      }
    }

    // アイテム
    for (const it of this.floorItems) {
      const dx = it.x - (px - half);
      const dy = it.y - (py - half);
      if (dx < 0 || dx >= VIEW || dy < 0 || dy >= VIEW) continue;
      const fs = Math.floor(ts * 0.6);
      ctx.font = `${fs}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(it.emoji, dx * ts + ts / 2, dy * ts + ts / 2);
    }

    // モンスター
    for (const m of this.monsters) {
      if (m.hp <= 0) continue;
      const dx = m.x - (px - half);
      const dy = m.y - (py - half);
      if (dx < 0 || dx >= VIEW || dy < 0 || dy >= VIEW) continue;
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
        // レアリティインジケーター（左上の小ドット）
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
  }
}
