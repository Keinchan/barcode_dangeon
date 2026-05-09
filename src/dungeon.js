import { createRNG, hashString } from './rng.js';
import { generateMonster, generateFloorItems, generateShopkeeperFor, generateShopStock, generateMinionBoss } from './generator.js';
import { getDebugState } from './debug.js';
import { getItemIconCanvas } from './icons.js';
import { findMinionTemplate } from './minions.js';
import { elementMatchup } from './items.js';
import { rollInflictOnHit } from './monster-jobs.js';

const W = 21;
const H = 19;
const T = { WALL: 0, FLOOR: 1, STAIRS: 2 };

// 敵魔法攻撃の外し率（レアリティが高いほど命中精度も高い）。プレイヤー側の
// 技 whiff と対称的な仕組みを敵にも導入する。
function _enemyWhiffChance(mob) {
  switch (mob?.rarity) {
    case 'レジェンド': return 0.05;
    case 'エピック':   return 0.10;
    case 'レア':       return 0.18;
    default:           return 0.25;
  }
}

export class Dungeon {
  constructor(dungeonData, floor) {
    this.data       = dungeonData;
    this.floor      = floor;
    this.isFinal    = floor === dungeonData.floors;
    // 入る度ランダム生成: dungeonData.runSalt があれば seed に混ぜて
    // 部屋レイアウト・モンスター配置・床アイテム位置をシャッフルする。
    // 旧仕様との互換のため runSalt が無ければ従来通り（場所固定）。
    const _runSalt = dungeonData.runSalt ?? '';
    this.rng        = createRNG(hashString(`${dungeonData.seed}:${floor}:${_runSalt}`));
    this.grid       = [];
    this.monsters   = [];
    this.floorItems = [];
    this.rooms      = [];
    // 仲間ミニオン: フロア入場時に initializePlayerMinions(player) で展開する。
    // 配列内の各要素は player.minions のコピーに { x, y } を加えたもの。
    this.minions    = [];
    // facing: [dx, dy]。プレイヤーが向いている方向。技の発射方向 / 2 段階移動の
    // 「確定方向」を兼ねる。new Dungeon の度（フロア境界）に下向きでリセット
    this.playerPos  = { x: 2, y: 2, facing: [0, 1] };
    this.stairsPos  = null;
    this.discovered = Array.from({ length: H }, () => new Uint8Array(W));
    this.visible    = new Set();
    // 不思議系巻物の効果フラグ。フロアごと（new Dungeon ごと）にリセット
    this.revealStairs  = false;
    this.revealEnemies = false;
    this.revealItems   = false;
    this.revealFloor   = false;
    this._build();
  }

  _build() {
    this.grid = Array.from({ length: H }, () => new Uint8Array(W));

    // 地図エンカウントの 1 ルーム戦闘ステージ。階段は無く、
    // data.encounterMonster をフロアに 1 体だけ置いて全滅したらクリア。
    if (this.data.isSingleRoom) {
      this._buildSingleRoom();
      return;
    }

    const rooms = this._genRooms(4 + Math.floor(this.rng() * 3));
    this.rooms  = rooms;
    rooms.forEach(r => this._carve(r));
    for (let i = 0; i + 1 < rooms.length; i++) {
      this._corridor(this._center(rooms[i]), this._center(rooms[i + 1]));
    }

    const c0 = this._center(rooms[0]);
    this.playerPos = { x: c0.x, y: c0.y, facing: [0, 1] };

    const cl = this._center(rooms[rooms.length - 1]);
    this.stairsPos = { x: cl.x, y: cl.y };
    this.grid[cl.y][cl.x] = T.STAIRS;

    rooms.slice(1).forEach((room, i) => {
      const isLast  = i === rooms.length - 2;
      const isFinal = this.isFinal;

      if (isLast && isFinal) {
        const bc   = this._center(room);
        // 特殊ダンジョン（ミニオンの試練）の場合は通常ボスを置き換えて
        // ミニオン王を配置する。撃破時の仲間化判定に使う recruitMinionId を持つ。
        let boss;
        if (this.data.isSpecial && this.data.bossMinionId) {
          const tpl = findMinionTemplate(this.data.bossMinionId);
          if (tpl) {
            boss = generateMinionBoss(this.data, this.floor, tpl);
          }
        }
        if (!boss) boss = generateMonster(this.data, this.floor, true);
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

    // ショップ：30% 確率で商人 NPC を配置（最終フロアにはボスがいるので避ける）
    this.shopkeeperToStock = new Map();   // monster ref → stock 配列（撃破時の落下用にも使う）
    if (!this.isFinal && rooms.length > 2 && this.rng() <= 0.30) {
      const room = rooms[1 + Math.floor(this.rng() * Math.max(1, rooms.length - 2))];
      const sx = room.x + 1 + Math.floor(this.rng() * Math.max(1, room.w - 2));
      const sy = room.y + 1 + Math.floor(this.rng() * Math.max(1, room.h - 2));
      if (this.grid[sy][sx] === T.FLOOR && !this._monsterAt(sx, sy)) {
        const shopkeeper = generateShopkeeperFor(this.data, this.floor);
        shopkeeper.x = sx;
        shopkeeper.y = sy;
        const stock = generateShopStock(this.data, this.floor);
        this.shopkeeperToStock.set(shopkeeper, stock);
        this.monsters.push(shopkeeper);
      }
    }

    // 念のためスポーン直後にもオーバーラップを解消（_pickSurroundSlot 等の前提条件）
    this._fixOverlaps?.();
  }

  // 商人 mob か？ tickEnemies は商人を行動対象から除外する
  isShopkeeperMob(m) { return m && m.isShopkeeper; }
  // 商人の在庫を返す（撃破時の落下や購入時の更新に使う）
  getShopStock(mob)  { return this.shopkeeperToStock?.get(mob) ?? []; }

  // 地図エンカウント用の単一部屋ステージ。盤面いっぱいの 1 部屋、
  // 階段なし。data.encounterMonster をプレイヤーから 5 マス先に配置する。
  // 撃破時の判定は main.js 側でモンスター数 0 をチェックして dungeonClear を呼ぶ。
  _buildSingleRoom() {
    const room = { x: 2, y: 2, w: W - 4, h: H - 4 };
    this.rooms = [room];
    this._carve(room);
    // プレイヤーは下端中央、敵は上端中央（5 マス前進で接触）
    const cx = Math.floor(W / 2);
    this.playerPos = { x: cx, y: H - 5, facing: [0, -1] };
    this.stairsPos = null;     // 階段なし: 撃破クリア
    const mob = this.data.encounterMonster;
    if (mob) {
      mob.x = cx;
      mob.y = 4;
      this.monsters.push(mob);
    }
    this.shopkeeperToStock = new Map();
    this._fixOverlaps?.();
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
  minionAt(x, y)      { return this.minions.find(mi => mi.x === x && mi.y === y); }
  removeMonster(m)    { const i = this.monsters.indexOf(m);    if (i !== -1) this.monsters.splice(i, 1); }
  removeFloorItem(it) { const i = this.floorItems.indexOf(it); if (i !== -1) this.floorItems.splice(i, 1); }

  // ── 巻物による地形操作ヘルパ（Phase 4 で追加） ──

  // 隣接 4 方向の壁を破壊する（ウォールクラッシュの巻物）。
  // 盤外と外周（最外列）はそのまま残す（穴が空くと描画/AI が壊れるため）。
  // 戻り値: 破壊できたマスの数
  destroyAdjacentWalls(x, y) {
    let n = 0;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const tx = x + dx, ty = y + dy;
      if (tx <= 0 || tx >= W - 1 || ty <= 0 || ty >= H - 1) continue;
      if (this.grid[ty][tx] === T.WALL) {
        this.grid[ty][tx] = T.FLOOR;
        n += 1;
      }
    }
    return n;
  }

  // 自分から階段まで通路を生成する（パッセージの巻物）。
  // 既存の _corridor と同じ L 字型のシンプルな掘削。
  carvePassageToStairs(fromX, fromY) {
    if (!this.stairsPos) return false;
    let x = fromX, y = fromY;
    while (x !== this.stairsPos.x) {
      if (this.grid[y][x] === T.WALL) this.grid[y][x] = T.FLOOR;
      x += x < this.stairsPos.x ? 1 : -1;
    }
    while (y !== this.stairsPos.y) {
      if (this.grid[y][x] === T.WALL) this.grid[y][x] = T.FLOOR;
      y += y < this.stairsPos.y ? 1 : -1;
    }
    return true;
  }

  // 部屋内の全ての（生存中・非商人）モンスターを返す（部屋系巻物用）。
  monstersInRoom(room) {
    if (!room) return [];
    return this.monsters.filter(m =>
      m.hp > 0 && !m.isShopkeeper &&
      m.x >= room.x && m.x < room.x + room.w &&
      m.y >= room.y && m.y < room.y + room.h
    );
  }

  // フロア内の全ての（生存中・非商人）モンスターを返す。
  allLivingMonsters() {
    return this.monsters.filter(m => m.hp > 0 && !m.isShopkeeper);
  }

  // 同じ部屋のランダム床マス（プレイヤーマス除く）を返す。ブリンクの巻物用。
  randomFloorInRoom(room) {
    if (!room) return null;
    const cands = [];
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (this.grid[y][x] !== T.FLOOR) continue;
        if (this.playerPos.x === x && this.playerPos.y === y) continue;
        if (this._monsterAt(x, y)) continue;
        if (this.minionAt && this.minionAt(x, y)) continue;
        cands.push({ x, y });
      }
    }
    if (cands.length === 0) return null;
    return cands[Math.floor(Math.random() * cands.length)];
  }

  // フロアのランダムな部屋の中央（プレイヤーが今いる部屋以外）を返す。ワープの巻物用。
  randomRoomCenterOtherThan(room) {
    if (!Array.isArray(this.rooms) || this.rooms.length <= 1) return null;
    const others = this.rooms.filter(r => r !== room);
    if (others.length === 0) return null;
    const target = others[Math.floor(Math.random() * others.length)];
    return this._center(target);
  }

  // ミニオンをプレイヤーの周囲 8 マスに展開する。フロア入場時に 1 度だけ呼ぶ。
  // 入場直後は player.minions（テンプレート＋現在 HP）と同じ並びでスポーンし、
  // 階層を越えるたびにこれを呼び直すため、各フロアでスポーン位置がリセットされる。
  initializePlayerMinions(player) {
    this.minions = [];
    const list = Array.isArray(player?.minions) ? player.minions : [];
    if (list.length === 0) return;
    const px = this.playerPos.x;
    const py = this.playerPos.y;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
    let di = 0;
    for (const src of list) {
      let placed = null;
      for (let tries = 0; tries < dirs.length; tries++) {
        const [dx, dy] = dirs[(di + tries) % dirs.length];
        const x = px + dx;
        const y = py + dy;
        if (!this.canWalk(x, y)) continue;
        if (this._monsterAt(x, y)) continue;
        if (this.minions.some(m => m.x === x && m.y === y)) continue;
        placed = { x, y };
        di = (di + tries + 1) % dirs.length;
        break;
      }
      if (!placed) continue;
      this.minions.push({
        ...src,                  // id, name, emoji, level, atk, def, hp, maxHp など
        x: placed.x, y: placed.y,
      });
    }
  }

  // ミニオン AI: プレイヤーの行動後に 1 ティック動かす。
  //   1. 隣接 8 マスに敵がいたら最寄り 1 体を攻撃（whiff なし、固定で当たる）
  //      ダメージは ATK と DEF に加え属性相性（elementMatchup）を適用する。
  //   2. なければプレイヤーに 1 マス近づく。プレイヤーマスへ進む際は「位置交換」、
  //      他ミニオン・敵で詰まれば待機。
  // 戻り値: events = [{ type:'minion-attack', minion, mob, dmg, killed, matchup }]
  tickMinions(player) {
    const events = [];
    if (!Array.isArray(this.minions) || this.minions.length === 0) return { events };
    if (getDebugState().disableEnemyAI) return { events };

    for (const mi of this.minions) {
      // 攻撃対象の探索（隣接 8 マス）
      let target = null;
      let bestDist = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const m = this._monsterAt(mi.x + dx, mi.y + dy);
          if (!m) continue;
          if (m.isShopkeeper) continue;
          const d = Math.abs(dx) + Math.abs(dy);
          if (d < bestDist) { bestDist = d; target = m; }
        }
      }

      if (target) {
        // ミニオンも 12% で外す（敵命中率と対称的に。レア度別ではなく一律）。
        // 攻撃したかどうかは hit フラグで返し、UI 側で MISS フロートを出す。
        if (Math.random() < 0.12) {
          events.push({
            type: 'minion-attack', minion: mi, mob: target,
            dmg: 0, killed: false, matchup: 1, hit: false,
          });
          continue;
        }
        // 属性相性込みのダメージ計算（ミニオンの主属性 vs 敵属性）
        const matchup = elementMatchup(mi.element, target.element);
        const base = Math.max(1, mi.atk - target.def);
        const roll = Math.floor(Math.random() * Math.max(1, base * 0.4));
        const dmg  = Math.max(1, Math.floor((base + roll) * matchup));
        target.hp = Math.max(0, target.hp - dmg);
        events.push({
          type: 'minion-attack', minion: mi, mob: target,
          dmg, killed: target.hp <= 0, matchup, hit: true,
        });
        continue;
      }

      // プレイヤーに近づく（既に隣接していたら待機）
      const px = this.playerPos.x;
      const py = this.playerPos.y;
      const adx = Math.abs(mi.x - px);
      const ady = Math.abs(mi.y - py);
      if (adx <= 1 && ady <= 1) continue;
      const sx = Math.sign(px - mi.x);
      const sy = Math.sign(py - mi.y);
      // tryStep: プレイヤーマスは「位置交換」で許可。他ミニオン・敵は不許可
      const tryStep = (dx, dy) => {
        if (dx === 0 && dy === 0) return false;
        const tx = mi.x + dx;
        const ty = mi.y + dy;
        if (!this.canWalk(tx, ty)) return false;
        if (this._monsterAt(tx, ty)) return false;
        if (this.minions.some(o => o !== mi && o.x === tx && o.y === ty)) return false;
        return true;
      };
      const swapWithPlayer = (dx, dy) => {
        const oldX = mi.x, oldY = mi.y;
        mi.x = px; mi.y = py;
        this.playerPos.x = oldX; this.playerPos.y = oldY;
        events.push({ type: 'swap', minion: mi });
      };
      const trySwap = (dx, dy) => {
        const tx = mi.x + dx;
        const ty = mi.y + dy;
        return tx === px && ty === py;
      };
      if      (trySwap(sx, sy)) swapWithPlayer(sx, sy);
      else if (trySwap(sx, 0))  swapWithPlayer(sx, 0);
      else if (trySwap(0, sy))  swapWithPlayer(0, sy);
      else if (tryStep(sx, sy)) { mi.x += sx; mi.y += sy; }
      else if (tryStep(sx, 0))  { mi.x += sx; }
      else if (tryStep(0, sy))  { mi.y += sy; }
      // どこにも進めなければ待機
    }
    return { events };
  }

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
  // ルール:
  //   魔法攻撃の射程＝8近傍（壁貫通）。射程外は「プレイヤー周囲8マスのうち
  //   未予約のスロット」を greedy に予約し、そこに最短で向かう。これにより
  //   複数の mob が一塊にならず、プレイヤーを取り囲む形で接近する。
  //
  //   excludeMob: 戦闘パネルで戦闘中の敵 1 体を除外するためのオプション
  tickEnemies(player, opts = {}) {
    if (getDebugState().disableEnemyAI) return { events: [], totalDmg: 0 };

    const events = [];
    let totalDmg = 0;
    const exclude = opts.excludeMob ?? null;

    // 行動対象（生存・除外外・非商人）を距離昇順で並べる：近い mob が先にスロットを
    // 取れる方が「囲み」が自然に成立する。商人は攻撃されない限りその場でじっとしている
    const actors = this.monsters
      .filter(m => m.hp > 0 && m !== exclude && !m.isShopkeeper)
      .map(m => ({
        m,
        dist: Math.abs(m.x - this.playerPos.x) + Math.abs(m.y - this.playerPos.y),
      }))
      .sort((a, b) => a.dist - b.dist);

    // 周囲8マスのスロット（予約済みは Set に追加していく）
    const reserved = new Set();

    for (const { m } of actors) {
      // 状態異常: stun は移動も攻撃も不可、seal は移動だけ可・攻撃不可。
      // 1 ターン分カウントを消費するため continue 前に turns-- する。
      if (m.status && m.status.turns > 0) {
        if (m.status.kind === 'stun') {
          reserved.add(`${m.x},${m.y}`);
          m.status.turns -= 1;
          if (m.status.turns <= 0) m.status = null;
          continue;
        }
        // seal: 移動は通常通り、攻撃判定の所だけ後ろで握りつぶす
      }

      // 職業ターン頭の固有効果（ゾンビの自然回復など）
      this._jobTurnStart(m);
      // チャージは毎ターン進行（職業特殊技の発動に使う）
      m.skillCharge = (m.skillCharge ?? 0) + 1;

      const adx = Math.abs(m.x - this.playerPos.x);
      const ady = Math.abs(m.y - this.playerPos.y);
      const inMagicRange = adx <= 1 && ady <= 1 && !(adx === 0 && ady === 0);

      // 職業による遠距離・特殊行動を先に試す（成立すれば移動も隣接攻撃もスキップ）
      const sealed = !!(m.status && m.status.kind === 'seal' && m.status.turns > 0);
      if (!sealed && !inMagicRange) {
        const ranged = this._tryJobRangedAttack(m, player);
        if (ranged) {
          reserved.add(`${m.x},${m.y}`);
          for (const ev of ranged) {
            events.push(ev);
            if (ev.hit && ev.dmg) totalDmg += ev.dmg;
          }
          continue;
        }
      }

      if (inMagicRange) {
        // 既に隣接：その場で魔法攻撃。座標もスロット予約に入れて他敵と衝突回避
        reserved.add(`${m.x},${m.y}`);
        // seal 中は攻撃ができない。turn カウントだけ消費して終了
        if (sealed) {
          m.status.turns -= 1;
          if (m.status.turns <= 0) m.status = null;
          continue;
        }
        // 命中率: 敵レアリティが高いほど精度が上がる。プレイヤーの whiff と
        // 同じ「外す」概念を敵側にも導入し、緊張感の偏りを減らす。
        // レジェンド 5% / エピック 10% / レア 18% / コモン 25% で外す。
        const whiff = _enemyWhiffChance(m);
        if (Math.random() < whiff) {
          events.push({ type: 'magic', mob: m, dmg: 0, hit: false });
          continue;
        }
        const base = Math.max(1, m.atk - player.def);
        const roll = 1 + Math.floor(Math.random() * Math.ceil(base * 0.4));
        const dmg  = base + roll;
        // ジョブ / 属性ベースで状態異常付与をロール（命中時のみ）。
        const inflict = rollInflictOnHit(m, { ranged: false });
        events.push({ type: 'magic', mob: m, dmg, hit: true, inflict });
        totalDmg += dmg;

        // 武道家: 隣接時の 2 連撃（chargeBonus + 2 でチャージ充填）
        if (m.job?.aiHint === 'doublehit' && m.skillCharge >= 3) {
          m.skillCharge = 0;
          if (Math.random() >= whiff) {
            const base2 = Math.max(1, Math.floor(m.atk * 0.7) - player.def);
            const roll2 = 1 + Math.floor(Math.random() * Math.ceil(base2 * 0.4));
            const dmg2  = base2 + roll2;
            const inflict2 = rollInflictOnHit(m, { ranged: false });
            events.push({ type: 'magic', mob: m, dmg: dmg2, hit: true, inflict: inflict2 });
            totalDmg += dmg2;
          }
        }
        continue;
      }

      // 周囲8マスから「歩ける・他敵未予約・壁でない」スロットを mob ごとに選ぶ。
      // 候補は「自 mob からの距離」が短い順に評価し、最も近いものを予約する。
      const slot = this._pickSurroundSlot(m, reserved);
      if (!slot) {
        // 取れるスロットが無い → その場待機（混雑時の暴走を防止）
        reserved.add(`${m.x},${m.y}`);
        continue;
      }
      reserved.add(`${slot.x},${slot.y}`);

      // 目標スロットへ 1 ステップ greedy に詰める
      const tdx = Math.sign(slot.x - m.x);
      const tdy = Math.sign(slot.y - m.y);
      const tAdx = Math.abs(slot.x - m.x);
      const tAdy = Math.abs(slot.y - m.y);
      const tryStep = (sx, sy) => {
        if (sx === 0 && sy === 0) return false;
        if (sx !== 0 && sy !== 0) {
          if (!this.canWalk(m.x + sx, m.y) || !this.canWalk(m.x, m.y + sy)) return false;
        }
        return this._canMonsterStep(m.x + sx, m.y + sy, m);
      };
      let moved = false;
      if (tAdx >= tAdy) {
        if      (tryStep(tdx, 0))  { m.x += tdx; moved = true; }
        else if (tryStep(0, tdy))  { m.y += tdy; moved = true; }
        else if (tryStep(tdx, tdy)) { m.x += tdx; m.y += tdy; moved = true; }
      } else {
        if      (tryStep(0, tdy))  { m.y += tdy; moved = true; }
        else if (tryStep(tdx, 0))  { m.x += tdx; moved = true; }
        else if (tryStep(tdx, tdy)) { m.x += tdx; m.y += tdy; moved = true; }
      }
      // 動いた後の座標も予約に追加（他敵が同マスに来ないように）
      if (moved) reserved.add(`${m.x},${m.y}`);

      // seal は移動を消費して残り turn を減らす（stun は冒頭で continue 済み）
      if (m.status && m.status.kind === 'seal' && m.status.turns > 0) {
        m.status.turns -= 1;
        if (m.status.turns <= 0) m.status = null;
      }
    }

    // 万一同一マスに複数 mob が乗っている状態が発生したら最終ガードで解消
    this._fixOverlaps();

    return { events, totalDmg };
  }

  // ── 職業システム（Phase 5）──
  //   毎ターンの先頭で呼ぶ「ターン開始フック」。ゾンビの自然回復のような、
  //   敵の位置や行動に依存しない継続的な効果を処理する。
  _jobTurnStart(m) {
    if (m.hp <= 0) return;
    const hint = m.job?.aiHint;
    if (hint === 'regen' && m.hp < m.maxHp) {
      // ゾンビ: 毎ターン最大 HP の 4%（最低 1）回復。徐々にプレイヤーをすり減らす想定
      const heal = Math.max(1, Math.floor(m.maxHp * 0.04));
      m.hp = Math.min(m.maxHp, m.hp + heal);
    }
  }

  // 職業の遠距離・特殊行動を試みる。成功時は 1 件以上の magic イベントを返し、
  // 呼び出し側はそれを events に積み、移動と隣接攻撃をスキップする。
  // 失敗時（条件未充足・チャージ不足・LOS が通らない 等）は null を返す。
  _tryJobRangedAttack(m, player) {
    const hint = m.job?.aiHint;
    if (!hint) return null;

    const px = this.playerPos.x;
    const py = this.playerPos.y;
    const dx = px - m.x;
    const dy = py - m.y;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    // 同行/同列/同斜め判定（dx==0 or dy==0 or |dx|==|dy|）
    const onOrtho = (dx === 0) !== (dy === 0); // どちらか一方が 0
    const onDiag  = adx === ady && adx > 0;

    // 攻撃 1 発分のダメージ計算 + whiff
    const fireOnce = (mult) => {
      const whiff = _enemyWhiffChance(m);
      if (Math.random() < whiff) {
        return { type: 'magic', mob: m, dmg: 0, hit: false, ranged: true };
      }
      const base = Math.max(1, Math.floor(m.atk * mult) - player.def);
      const roll = 1 + Math.floor(Math.random() * Math.ceil(base * 0.4));
      // 飛び道具は ranged=true で付与確率にブーストが乗る
      const inflict = rollInflictOnHit(m, { ranged: true });
      return { type: 'magic', mob: m, dmg: base + roll, hit: true, ranged: true, inflict };
    };

    // breath（ドラゴン）: chargeBonus を加味して 5 ターンに 1 回、正面 5 マス・1.5x
    if (hint === 'breath') {
      if (!onOrtho || Math.max(adx, ady) > 5) return null;
      const need = 5 + (m.job?.chargeBonus ?? 0);
      if ((m.skillCharge ?? 0) < need) return null;
      const sx = Math.sign(dx), sy = Math.sign(dy);
      if (!this._jobLosClear(m.x, m.y, sx, sy, Math.max(adx, ady))) return null;
      m.skillCharge = 0;
      return [fireOnce(1.5)];
    }

    // line3（コウモリ）: 3 ターンに 1 回、正面 3 マス・1.0x
    if (hint === 'line3') {
      if (!onOrtho || Math.max(adx, ady) > 3) return null;
      const need = 2 + (m.job?.chargeBonus ?? 0);
      if ((m.skillCharge ?? 0) < need) return null;
      const sx = Math.sign(dx), sy = Math.sign(dy);
      if (!this._jobLosClear(m.x, m.y, sx, sy, Math.max(adx, ady))) return null;
      m.skillCharge = 0;
      return [fireOnce(1.0)];
    }

    // pierce（蛇族）: 3 ターンに 1 回、同行/同列に最大 6 マス、1.1x
    if (hint === 'pierce') {
      if (!onOrtho || Math.max(adx, ady) > 6) return null;
      const need = 2 + (m.job?.chargeBonus ?? 0);
      if ((m.skillCharge ?? 0) < need) return null;
      const sx = Math.sign(dx), sy = Math.sign(dy);
      if (!this._jobLosClear(m.x, m.y, sx, sy, Math.max(adx, ady))) return null;
      m.skillCharge = 0;
      return [fireOnce(1.1)];
    }

    // phasebolt（ホラーマン）: 3 ターンに 1 回、斜め 3 マス、0.95x
    if (hint === 'phasebolt') {
      if (!onDiag || adx > 3) return null;
      const need = 2 + (m.job?.chargeBonus ?? 0);
      if ((m.skillCharge ?? 0) < need) return null;
      const sx = Math.sign(dx), sy = Math.sign(dy);
      if (!this._jobLosClear(m.x, m.y, sx, sy, adx)) return null;
      m.skillCharge = 0;
      return [fireOnce(0.95)];
    }

    return null;
  }

  // (sx, sy) ステップで steps 歩進む線上に壁・他の敵が無いか確認。
  // ゴール（プレイヤー位置）には到達するため、ループは steps-1 まで。
  _jobLosClear(fromX, fromY, sx, sy, steps) {
    let x = fromX, y = fromY;
    for (let i = 1; i < steps; i++) {
      x += sx; y += sy;
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      if (this.grid[y][x] === T.WALL) return false;
      // 経路上に他の敵が居ると遮蔽（飛び道具が刺さる）
      const other = this._monsterAt(x, y);
      if (other) return false;
    }
    return true;
  }

  // 同一マスに 2 体以上の mob が居る場合、後から見つかった方を 8 近傍の空きマスへ
  // 退避させる。アルゴリズム上は重ならないはずだが、診断・将来の変更への保険。
  _fixOverlaps() {
    const occ = new Map();
    for (const m of this.monsters) {
      if (m.hp <= 0) continue;
      const k = `${m.x},${m.y}`;
      if (occ.has(k)) {
        // 別の空きマスへ退避
        if (!this._evacuateMob(m)) {
          // どこも開いてない場合は諦め（次ティックで解消される可能性あり）
        } else {
          occ.set(`${m.x},${m.y}`, m);
        }
      } else {
        occ.set(k, m);
      }
    }
  }

  _evacuateMob(m) {
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    for (const [dx, dy] of dirs) {
      const nx = m.x + dx;
      const ny = m.y + dy;
      if (!this.canWalk(nx, ny)) continue;
      if (this.playerPos.x === nx && this.playerPos.y === ny) continue;
      const other = this._monsterAt(nx, ny);
      if (other && other !== m) continue;
      m.x = nx;
      m.y = ny;
      return true;
    }
    return false;
  }

  // プレイヤー周囲8マスから、まだ誰にも予約されていない・歩ける・通行可能な
  // スロットを mob から見て最も近い順に1つ返す
  _pickSurroundSlot(m, reserved) {
    const px = this.playerPos.x;
    const py = this.playerPos.y;
    const candidates = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const sx = px + dx;
        const sy = py + dy;
        if (!this.canWalk(sx, sy)) continue;
        const key = `${sx},${sy}`;
        if (reserved.has(key)) continue;
        // 別 mob が既にそこに居る場合も予約済み扱い
        const other = this._monsterAt(sx, sy);
        if (other && other !== m) continue;
        const d = Math.abs(sx - m.x) + Math.abs(sy - m.y);
        candidates.push({ x: sx, y: sy, d });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.d - b.d);
    return candidates[0];
  }

  _canMonsterStep(x, y, self) {
    if (!this.canWalk(x, y)) return false;
    if (this.playerPos.x === x && this.playerPos.y === y) return false;
    const other = this._monsterAt(x, y);
    if (other && other !== self) return false;
    // ミニオンが居るマスにも入れない（壁役にして敵の動線を制限する）
    if (this.minionAt && this.minionAt(x, y)) return false;
    return true;
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
    const header  = document.querySelector('#screen-dungeon .dungeon-header');
    const explore = document.getElementById('dungeon-footer');
    const visibleFooter = explore && !explore.classList.contains('hidden') ? explore : null;

    const headerH = header?.offsetHeight ?? 60;
    const footerH = visibleFooter?.offsetHeight ?? 200;
    const availW  = window.innerWidth;
    const availH  = window.innerHeight - headerH - footerH - 16;
    // ユーザー指定の拡大率（main.js が localStorage から読み込んで
    // window.__fieldZoom にセットする）。0.5〜2.0 の範囲。
    const zoom = (typeof window !== 'undefined' && Number.isFinite(window.__fieldZoom))
      ? Math.max(0.5, Math.min(2.0, window.__fieldZoom))
      : 1.0;
    // canvas は viewport に合わせる（PC 上限 760）。利用可能スペースで頭打ち。
    const baseSize = Math.max(160, Math.min(availW, availH, 760));
    // 「拡大率」= タイルサイズ倍率。zoom が大きいほどタイルが大きく描かれ、
    // その分 canvas 内に収まるタイル数（VIEW）が減る = マップにズームインした感覚。
    // 逆に zoom < 1.0 ではタイルが小さくなり VIEW が増える = ズームアウト。
    // VIEW は 5〜17 にクランプ（極端な値で描画ループが破綻しないように）。
    // zoom 2.0 → VIEW=5 / 1.5 → 7 / 1.0 → 11 / 0.7 → 17 のように段階的に変わる。
    // floor で算出 → bit-or 1 で奇数化（中央 1 マスを保証）→ [5,17] にクランプ。
    const VIEW = Math.max(5, Math.min(17, Math.floor(11 / zoom) | 1));
    const half = Math.floor(VIEW / 2);
    const ts = Math.max(18, Math.floor(baseSize / VIEW));
    canvas.width  = ts * VIEW;
    canvas.height = ts * VIEW;
    // 主要 VFX のアンカー計算（main.js の _minionScreenAnchor / _mobScreenAnchor）が
    // 動的 VIEW と整合できるように、最後の描画状態を dungeon インスタンスに残す。
    this._viewTiles = VIEW;
    this._tileSize  = ts;
    canvas.style.width  = canvas.width  + 'px';
    canvas.style.height = canvas.height + 'px';

    this.refreshVisibility();
    const dbg       = getDebugState();
    // デバッグの全可視化 or 巻物による全可視化
    const revealAll = !!dbg.revealAll || this.revealFloor;
    // 個別系巻物（階段だけ / アイテムだけ / 敵だけ をフォグ越しに表示）
    const showStairsThruFog  = revealAll || this.revealStairs;
    const showItemsThruFog   = revealAll || this.revealItems;
    const showEnemiesThruFog = revealAll || this.revealEnemies;

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

        // 階段感知中は階段マスをフォグ越しでも描く（タイルは黒のまま、シンボルだけ薄く出す）
        const isStairs = !outOfBounds && this.grid[wy][wx] === T.STAIRS;
        if (outOfBounds || (!isVisible && !isDiscovered)) {
          ctx.fillStyle = '#000';
          ctx.fillRect(sx, sy, ts, ts);
          if (isStairs && showStairsThruFog) {
            const fs = Math.floor(ts * 0.6);
            ctx.font = `${fs}px serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.globalAlpha = 0.55;
            ctx.fillText('🔽', sx + ts / 2, sy + ts / 2);
            ctx.globalAlpha = 1;
          }
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
    //   全タイプを getItemIconCanvas 経由で描く（icons.js が type 別に処理）。
    //   こうすることで「床に落ちている時のアイコン」と「メニューで見るアイコン」が
    //   完全一致する（旧実装は gold/material/mysteryScroll/skillBook を絵文字直描き
    //   していて、メニュー側の手続きアイコンと食い違っていた）。
    //   アイテム感知の巻物使用中はフォグ越しでも半透明で表示する
    for (const it of this.floorItems) {
      const dx = it.x - (px - half);
      const dy = it.y - (py - half);
      if (dx < 0 || dx >= VIEW || dy < 0 || dy >= VIEW) continue;
      const inSight = this.visible.has(`${it.x},${it.y}`);
      if (!revealAll && !inSight && !showItemsThruFog) continue;
      const dim = !revealAll && !inSight;
      if (dim) ctx.globalAlpha = 0.55;

      const iconSize = Math.max(20, Math.floor(ts * 0.85));
      const icon = getItemIconCanvas(it, 64);
      const ix = dx * ts + (ts - iconSize) / 2;
      const iy = dy * ts + (ts - iconSize) / 2;
      ctx.drawImage(icon, ix, iy, iconSize, iconSize);
      ctx.globalAlpha = 1;
    }

    // モンスター（現視野内のみ。敵感知巻物中はフォグ越しでも半透明表示）
    for (const m of this.monsters) {
      if (m.hp <= 0) continue;
      const dx = m.x - (px - half);
      const dy = m.y - (py - half);
      if (dx < 0 || dx >= VIEW || dy < 0 || dy >= VIEW) continue;
      const inSight = this.visible.has(`${m.x},${m.y}`);
      if (!revealAll && !inSight && !showEnemiesThruFog) continue;
      const dim = !revealAll && !inSight;
      if (dim) ctx.globalAlpha = 0.55;
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
      } else if (m.isShopkeeper) {
        // 商人マーカー: 紫の円とドル風 ¥ を描く
        ctx.fillStyle = '#7c4dff';
        ctx.beginPath();
        ctx.arc(dx * ts + ts - 8, dy * ts + 8, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.floor(ts * 0.35)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('¥', dx * ts + ts - 8, dy * ts + 9);
      } else {
        ctx.fillStyle = m.rarityColor ?? '#9e9e9e';
        ctx.beginPath();
        ctx.arc(dx * ts + 6, dy * ts + 6, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // 状態異常マーカー: 右上に絵文字を重ねて、行動不能か封じか一目で分かる。
      // stun=💫 / seal=🔒（旧 m.status 単独管理）。
      // 新仕様の m.statuses[] は別ライン（左上）で 3 個まで表示。
      if (m.status && m.status.turns > 0) {
        const glyph = m.status.kind === 'stun' ? '💫' : '🔒';
        ctx.font = `${Math.floor(ts * 0.40)}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(glyph, dx * ts + ts - 9, dy * ts + 9);
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.floor(ts * 0.22)}px sans-serif`;
        ctx.fillText(String(m.status.turns), dx * ts + ts - 4, dy * ts + ts - 6);
      }
      if (Array.isArray(m.statuses) && m.statuses.length > 0) {
        const STATUS_GLYPH = {
          poison: '☠', burn: '🔥', confuse: '😵', sleep: '😴',
          shock: '⚡', fracture: '🦴', spasm: '💢',
        };
        ctx.font = `${Math.floor(ts * 0.32)}px serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const visible = m.statuses.slice(0, 3);
        visible.forEach((s, i) => {
          const g = STATUS_GLYPH[s.kind] ?? '?';
          ctx.fillText(g, dx * ts + 1 + i * (ts * 0.30), dy * ts + 1);
        });
      }
      ctx.globalAlpha = 1;
    }

    // ミニオン（プレイヤー視野内）: emoji + 緑のマーカーで「味方」と分かるように
    for (const mi of (this.minions ?? [])) {
      const dxm = mi.x - (px - half);
      const dym = mi.y - (py - half);
      if (dxm < 0 || dxm >= VIEW || dym < 0 || dym >= VIEW) continue;
      const inSight = this.visible.has(`${mi.x},${mi.y}`);
      if (!revealAll && !inSight) continue;
      const fsm = Math.floor(ts * 0.65);
      ctx.font = `${fsm}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(mi.emoji ?? '🌼', dxm * ts + ts / 2, dym * ts + ts / 2);
      // 仲間マーカー（緑円・敵の rarityColor 円と区別）
      ctx.fillStyle = '#66bb6a';
      ctx.beginPath();
      ctx.arc(dxm * ts + 6, dym * ts + 6, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // プレイヤー（常に中央）
    const fs = Math.floor(ts * 0.65);
    ctx.font = `${fs}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🧙', half * ts + ts / 2, half * ts + ts / 2);

    // 向きインジケータ：技の発射方向と移動の確定方向を兼ねる「向き」を矢印で表示。
    // playerPos.facing = [fx, fy] (-1,0,1 のいずれか) を main.js が更新する想定
    const facing = this.playerPos.facing;
    if (facing && (facing[0] !== 0 || facing[1] !== 0)) {
      const cx = half * ts + ts / 2;
      const cy = half * ts + ts / 2;
      const r  = ts * 0.42;
      const tipX = cx + facing[0] * r;
      const tipY = cy + facing[1] * r;
      const ang  = Math.atan2(facing[1], facing[0]);
      const wing = ts * 0.18;
      const ax1 = tipX - Math.cos(ang - 0.5) * wing;
      const ay1 = tipY - Math.sin(ang - 0.5) * wing;
      const ax2 = tipX - Math.cos(ang + 0.5) * wing;
      const ay2 = tipY - Math.sin(ang + 0.5) * wing;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(ax1, ay1);
      ctx.lineTo(ax2, ay2);
      ctx.closePath();
      ctx.fillStyle = '#ffd54f';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
    }

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
