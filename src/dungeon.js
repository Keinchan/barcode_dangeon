import { createRNG, hashString } from './rng.js';
import { generateMonster } from './generator.js';

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
    this.playerPos  = { x: 2, y: 2 };
    this.stairsPos  = null;
    this._build();
  }

  _build() {
    // 全部壁で初期化
    this.grid = Array.from({ length: H }, () => new Uint8Array(W));

    // 部屋を生成
    const rooms = this._genRooms(4 + Math.floor(this.rng() * 3));
    rooms.forEach(r => this._carve(r));

    // 部屋同士を廊下でつなぐ
    for (let i = 0; i + 1 < rooms.length; i++) {
      this._corridor(this._center(rooms[i]), this._center(rooms[i + 1]));
    }

    // プレイヤー開始位置（最初の部屋の中心）
    const c0 = this._center(rooms[0]);
    this.playerPos = { x: c0.x, y: c0.y };

    // 階段（最後の部屋の中心）
    const cl = this._center(rooms[rooms.length - 1]);
    this.stairsPos = { x: cl.x, y: cl.y };
    this.grid[cl.y][cl.x] = T.STAIRS;

    // モンスター配置
    const isFinal = this.isFinal;
    rooms.slice(1).forEach((room, i) => {
      const isLast = i === rooms.length - 2;
      if (isLast && isFinal) {
        // 最終フロアの最後の部屋にボス
        const bc = this._center(room);
        const boss = generateMonster(this.data, this.floor, true);
        boss.x = bc.x; boss.y = bc.y;
        this.monsters.push(boss);
      } else {
        // 通常モンスターを1〜2体
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
  }

  _genRooms(target) {
    const rooms = [];
    for (let tries = 0; tries < target * 15 && rooms.length < target; tries++) {
      const w = 4 + Math.floor(this.rng() * 5);
      const h = 3 + Math.floor(this.rng() * 4);
      const x = 1 + Math.floor(this.rng() * (W - w - 2));
      const y = 1 + Math.floor(this.rng() * (H - h - 2));
      const room = { x, y, w, h };
      if (!rooms.some(r => this._overlap(r, room))) rooms.push(room);
    }
    return rooms;
  }

  _overlap(a, b) {
    return !(a.x + a.w + 1 <= b.x || b.x + b.w + 1 <= a.x ||
             a.y + a.h + 1 <= b.y || b.y + b.h + 1 <= a.y);
  }

  _carve(room) {
    for (let y = room.y; y < room.y + room.h && y < H - 1; y++)
      for (let x = room.x; x < room.x + room.w && x < W - 1; x++)
        this.grid[y][x] = T.FLOOR;
  }

  _corridor(a, b) {
    let { x, y } = a;
    while (x !== b.x) { this.grid[y][x] = T.FLOOR; x += x < b.x ? 1 : -1; }
    while (y !== b.y) { this.grid[y][x] = T.FLOOR; y += y < b.y ? 1 : -1; }
  }

  _center(room) {
    return {
      x: room.x + Math.floor(room.w / 2),
      y: room.y + Math.floor(room.h / 2),
    };
  }

  _monsterAt(x, y) {
    return this.monsters.find(m => m.x === x && m.y === y && m.hp > 0);
  }

  monsterAt(x, y) { return this._monsterAt(x, y); }

  removeMonster(m) {
    const idx = this.monsters.indexOf(m);
    if (idx !== -1) this.monsters.splice(idx, 1);
  }

  canWalk(x, y) {
    return x >= 0 && x < W && y >= 0 && y < H && this.grid[y][x] !== T.WALL;
  }

  atStairs(x, y) {
    return this.stairsPos && x === this.stairsPos.x && y === this.stairsPos.y;
  }

  // ── Canvas 描画 ──
  render(canvas) {
    const VIEW = 11; // 表示タイル数（奇数）
    const half = Math.floor(VIEW / 2);

    const size = Math.min(canvas.parentElement.clientWidth, canvas.parentElement.clientHeight) || 352;
    const tileSize = Math.floor(size / VIEW);
    canvas.width  = tileSize * VIEW;
    canvas.height = tileSize * VIEW;

    const ctx = canvas.getContext('2d');
    const { x: px, y: py } = this.playerPos;
    const theme = this.data.theme;

    for (let dy = 0; dy < VIEW; dy++) {
      for (let dx = 0; dx < VIEW; dx++) {
        const wx = px - half + dx;
        const wy = py - half + dy;
        const sx = dx * tileSize;
        const sy = dy * tileSize;

        // タイル描画
        if (wx < 0 || wx >= W || wy < 0 || wy >= H || this.grid[wy][wx] === T.WALL) {
          ctx.fillStyle = theme.wallColor;
        } else if (this.grid[wy][wx] === T.STAIRS) {
          ctx.fillStyle = theme.floorColor;
        } else {
          ctx.fillStyle = theme.floorColor;
        }
        ctx.fillRect(sx, sy, tileSize, tileSize);

        // 軽いグリッド線
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.strokeRect(sx, sy, tileSize, tileSize);

        if (wx < 0 || wx >= W || wy < 0 || wy >= H) continue;

        const fs = Math.floor(tileSize * 0.7);
        ctx.font = `${fs}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const cx = sx + tileSize / 2;
        const cy = sy + tileSize / 2;

        // 階段
        if (this.grid[wy][wx] === T.STAIRS) {
          ctx.fillText('🔽', cx, cy);
        }
      }
    }

    // モンスター描画
    for (const m of this.monsters) {
      if (m.hp <= 0) continue;
      const dx = m.x - (px - half);
      const dy = m.y - (py - half);
      if (dx < 0 || dx >= VIEW || dy < 0 || dy >= VIEW) continue;

      const sx = dx * tileSize + tileSize / 2;
      const sy = dy * tileSize + tileSize / 2;
      const fs = Math.floor(tileSize * 0.7);
      ctx.font = `${fs}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.emoji, sx, sy);

      if (m.isBoss) {
        ctx.strokeStyle = 'gold';
        ctx.lineWidth = 2;
        ctx.strokeRect(dx * tileSize + 2, dy * tileSize + 2, tileSize - 4, tileSize - 4);
        ctx.lineWidth = 1;
      }
    }

    // プレイヤー（常に中央）
    const fs = Math.floor(tileSize * 0.7);
    ctx.font = `${fs}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🧙', half * tileSize + tileSize / 2, half * tileSize + tileSize / 2);
  }
}
