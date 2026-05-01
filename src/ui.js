// プレイヤー頭上にダメージをフロート表示（canvas中央＝プレイヤーアイコン、赤）。
// opts.kind: 'normal' | 'crit' | 'effective' | 'weak' でスケールと色を変える
export function showFloatingDamage(amount, opts = {}) {
  const canvas = document.getElementById('dungeon-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = `damage-float ${_dmgFloatClass(opts.kind)}`;
  el.textContent = opts.kind === 'crit' ? `-${amount}!!` : `-${amount}`;
  el.style.left = (rect.left + rect.width / 2) + 'px';
  el.style.top  = (rect.top + rect.height / 2 - 18) + 'px';
  el.style.fontSize = _dmgFontSize(amount, opts.kind) + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

// 任意の画面座標 {left, top, width, height} の中心にダメージ数値を浮かべる。
// 範囲技で命中マスごとに別々の数値を出す時用。
export function showDamageAt(rect, amount, opts = {}) {
  if (!rect) return;
  const cx = rect.left + (rect.width  ?? 0) / 2;
  const cy = rect.top  + (rect.height ?? 0) / 2;
  const el = document.createElement('div');
  el.className = `damage-float damage-float-enemy ${_dmgFloatClass(opts.kind)}`;
  el.textContent = opts.kind === 'crit' ? `-${amount}!!` : `-${amount}`;
  el.style.left = cx + 'px';
  el.style.top  = cy + 'px';
  el.style.fontSize = _dmgFontSize(amount, opts.kind) + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

// 敵に与えたダメージを戦闘パネル上の敵情報ボックス上端付近にフロート表示（緑）
export function showEnemyDamage(amount, opts = {}) {
  const target = document.querySelector('.combat-enemy');
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = `damage-float damage-float-enemy ${_dmgFloatClass(opts.kind)}`;
  el.textContent = opts.kind === 'crit' ? `-${amount}!!` : `-${amount}`;
  el.style.left = (rect.left + rect.width / 2) + 'px';
  el.style.top  = (rect.top + 6) + 'px';
  el.style.fontSize = _dmgFontSize(amount, opts.kind) + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

// ダメージ数値の見た目を kind 別に振り分け（スケール／色／アニメ）
function _dmgFloatClass(kind) {
  switch (kind) {
    case 'crit':      return 'damage-crit';
    case 'effective': return 'damage-effective';
    case 'weak':      return 'damage-weak';
    default:          return '';
  }
}
function _dmgFontSize(amount, kind) {
  // 大ダメージほど数値も大きく。クリ・効果絶大はさらに底上げ
  let base = 22 + Math.min(20, amount / 6);
  if (kind === 'crit')      base += 8;
  if (kind === 'effective') base += 4;
  if (kind === 'weak')      base -= 2;
  return Math.round(base);
}

// 画面全体の白フラッシュ（一瞬）。クリティカル / 大技で使う
export function hitFlash(opts = {}) {
  const div = document.createElement('div');
  div.className = 'vfx-hitflash';
  div.style.background = opts.color ?? 'rgba(255,255,255,0.55)';
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 140);
}

// 画面シェイク。amount: ピクセル幅、duration: ms
export function screenShake(amount = 8, duration = 280) {
  const root = document.body;
  const start = performance.now();
  const tick = () => {
    const t = performance.now() - start;
    if (t >= duration) {
      root.style.transform = '';
      return;
    }
    const decay = 1 - t / duration;
    const dx = (Math.random() * 2 - 1) * amount * decay;
    const dy = (Math.random() * 2 - 1) * amount * decay;
    root.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// 敵撃破の爆散（複数演出を組み合わせ）。死亡時の派手な締めくくり用
export function deathBurst(target, opts = {}) {
  const r = _rectOf(target);
  if (!r) return;
  const cx = r.left + r.width / 2;
  const cy = r.top  + r.height / 2;
  const color = opts.color ?? '#ff7043';
  // 中央の閃光
  _spawn(`<div class="vfx-explosion" style="left:${cx}px;top:${cy}px;
    --c1:${color};--c2:rgba(255,255,255,0.95)"></div>`, document.body, 850);
  // 大量火花
  sparkSpray(target, { count: 20, color });
  sparkSpray(target, { count: 14, color: '#ffe082' });
  // 拡大リング 2 段
  _spawn(`<div class="vfx-ring vfx-ring-1" style="left:${cx}px;top:${cy}px;--c:${color}"></div>`, document.body, 700);
  setTimeout(() => {
    _spawn(`<div class="vfx-ring vfx-ring-2" style="left:${cx}px;top:${cy}px;--c:rgba(255,255,255,0.85)"></div>`, document.body, 600);
  }, 90);
}

// レア度に応じて取得アイテムを派手に告知。
//   - コモン: 何もしない（呼び出し側の dungeonLog のみ）
//   - レア:   控えめなフチ付きトースト
//   - エピック: 紫の中央バナー
//   - レジェンド: 全画面の金色バナー＋星屑
// item.rarity を見て自動で振り分け。
export function showItemBanner(item, opts = {}) {
  if (!item || !item.rarity) return;
  const rarity = item.rarity;
  if (rarity === 'コモン') return;

  const action = opts.action ?? '入手';   // "入手" / "ドロップ" など
  const cls    = `item-banner rarity-${rarityKey(rarity)}`;
  const icon   = item.emoji ?? '🎁';
  const tag    =
    rarity === 'レジェンド' ? '🏆 LEGENDARY' :
    rarity === 'エピック'   ? '💎 EPIC'      :
                              '✨ RARE';
  const lvHtml = item.level ? `<span class="item-banner-lv">Lv${item.level}</span>` : '';

  const div = document.createElement('div');
  div.className = cls;
  div.innerHTML = `
    <div class="item-banner-tag">${tag}</div>
    <div class="item-banner-row">
      <span class="item-banner-icon">${icon}</span>
      <div class="item-banner-text">
        <div class="item-banner-name">${item.name}</div>
        <div class="item-banner-meta">${action} ${lvHtml}</div>
      </div>
    </div>
  `;

  // レジェンドのみ星屑を追加
  if (rarity === 'レジェンド') {
    const sparkles = document.createElement('div');
    sparkles.className = 'item-banner-sparkles';
    for (let i = 0; i < 16; i++) {
      const s = document.createElement('span');
      s.className = 'sparkle';
      s.style.left  = `${Math.random() * 100}%`;
      s.style.top   = `${Math.random() * 100}%`;
      s.style.animationDelay = `${Math.random() * 0.6}s`;
      sparkles.appendChild(s);
    }
    div.appendChild(sparkles);
  }

  document.body.appendChild(div);
  // 自動で消える時間（レアリティで変える）
  const lifetime =
    rarity === 'レジェンド' ? 2200 :
    rarity === 'エピック'   ? 1700 :
                              1300;
  setTimeout(() => {
    div.classList.add('fade-out');
    setTimeout(() => div.remove(), 400);
  }, lifetime);
}

function rarityKey(name) {
  switch (name) {
    case 'レア':       return 'rare';
    case 'エピック':   return 'epic';
    case 'レジェンド': return 'legendary';
    default:           return 'common';
  }
}

// 強化成功時の派手バナー：
//   武器名・ATK の before → after を大きく出し、画面フラッシュ・粒子・
//   星屑・シェイクを重ねて「強化された！」感を演出する。
//   呼び出し側は強化前と強化後の atkBonus を渡す。
export function showEnhanceCelebration(item, beforeAtk, afterAtk) {
  if (!item) return;
  const tag    = item.isMythic ? '🌟 MYTHIC FUSE' : '🛠 ENHANCED';
  const subTag = item.isMythic ? '神話級に到達！' : '強化成功！';
  const cls    = `enhance-banner rarity-${rarityKey(item.rarity)}` + (item.isMythic ? ' mythic' : '');
  const icon   = item.emoji ?? '⚔️';

  const div = document.createElement('div');
  div.className = cls;
  div.innerHTML = `
    <div class="enhance-banner-tag">${tag}</div>
    <div class="enhance-banner-sub">${subTag}</div>
    <div class="enhance-banner-row">
      <span class="enhance-banner-icon">${icon}</span>
      <div class="enhance-banner-text">
        <div class="enhance-banner-name">${item.name}</div>
        <div class="enhance-banner-stats">
          <span class="atk-before">ATK ${beforeAtk}</span>
          <span class="atk-arrow">➤</span>
          <span class="atk-after">ATK ${afterAtk}</span>
          <span class="atk-delta">+${afterAtk - beforeAtk}</span>
        </div>
      </div>
    </div>
    <div class="enhance-banner-rays"></div>
    <div class="enhance-banner-sparkles"></div>
  `;

  // 星屑 16 粒
  const sparkles = div.querySelector('.enhance-banner-sparkles');
  for (let i = 0; i < 16; i++) {
    const s = document.createElement('span');
    s.className = 'sparkle';
    s.style.left  = `${Math.random() * 100}%`;
    s.style.top   = `${Math.random() * 100}%`;
    s.style.animationDelay = `${Math.random() * 0.6}s`;
    sparkles.appendChild(s);
  }

  // 全画面フラッシュ + シェイク
  hitFlash({ color: item.isMythic ? 'rgba(255,213,79,0.55)' : 'rgba(124,77,255,0.45)' });
  screenShake(item.isMythic ? 14 : 8, 380);

  document.body.appendChild(div);
  // バナー周辺に火花を散らす
  setTimeout(() => {
    const r = div.getBoundingClientRect();
    const anchor = { left: r.left + r.width / 2 - 18, top: r.top + r.height / 2 - 18, width: 36, height: 36 };
    sparkSpray(anchor, { count: 24, color: item.isMythic ? '#ffd54f' : '#b39bff' });
    if (item.isMythic) sparkSpray(anchor, { count: 18, color: '#fff8e1' });
  }, 100);

  const lifetime = item.isMythic ? 2400 : 1800;
  setTimeout(() => {
    div.classList.add('fade-out');
    setTimeout(() => div.remove(), 400);
  }, lifetime);
}

// ─────────────────────────────────────────────
// 戦闘演出（パーティクル / 爆発 / 魔法陣）
//   全て fixed 配置の DOM で軽量実装。Canvas 描画には介入しない。
//   - sparkSpray:  小さな火花（命中時）
//   - explosion:   大きな閃光（クリティカル / 敵スキル）
//   - shockwave:   衝撃波（被ダメ）
//   - magicCircle: 属性カラーの魔法陣（魔法発動）
//
//   target は対象要素か {x, y, w, h} 矩形。要素なら getBoundingClientRect で位置算出。
// ─────────────────────────────────────────────

function _rectOf(target) {
  if (!target) return null;
  if (target.getBoundingClientRect) return target.getBoundingClientRect();
  return target;
}

function _spawn(html, parent = document.body, lifetime = 800) {
  const el = document.createElement('div');
  el.innerHTML = html.trim();
  const node = el.firstChild;
  parent.appendChild(node);
  setTimeout(() => node.remove(), lifetime);
  return node;
}

export function sparkSpray(target, opts = {}) {
  const r = _rectOf(target);
  if (!r) return;
  const cx = r.left + r.width  / 2;
  const cy = r.top  + r.height / 2;
  const count = opts.count ?? 12;     // デフォ 8 → 12 に増量
  const color = opts.color ?? '#ffd54f';
  const wrap = document.createElement('div');
  wrap.className = 'vfx-wrap';
  wrap.style.left = cx + 'px';
  wrap.style.top  = cy + 'px';
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'vfx-spark';
    const angle = (Math.PI * 2) * (i / count) + Math.random() * 0.4;
    const dist  = 28 + Math.random() * 28;     // 飛距離も広げる
    p.style.background  = color;
    p.style.boxShadow   = `0 0 8px ${color}`;
    p.style.setProperty('--vx', Math.cos(angle) * dist + 'px');
    p.style.setProperty('--vy', Math.sin(angle) * dist + 'px');
    wrap.appendChild(p);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 700);
}

export function explosion(target, opts = {}) {
  const r = _rectOf(target);
  if (!r) return;
  const cx = r.left + r.width  / 2;
  const cy = r.top  + r.height / 2;
  const color = opts.color ?? '#ff7043';
  const html = `<div class="vfx-explosion" style="left:${cx}px;top:${cy}px;
    --c1:${color};--c2:rgba(255,255,255,0.9)"></div>`;
  _spawn(html, document.body, 750);
  // パーティクルも一緒に（増量）
  sparkSpray(target, { count: 16, color });
  sparkSpray(target, { count: 8,  color: '#fff' });
}

export function shockwave(target, opts = {}) {
  const r = _rectOf(target);
  if (!r) return;
  const cx = r.left + r.width  / 2;
  const cy = r.top  + r.height / 2;
  const color = opts.color ?? 'rgba(255,82,82,0.6)';
  const html = `<div class="vfx-shockwave" style="left:${cx}px;top:${cy}px;--c:${color}"></div>`;
  _spawn(html, document.body, 600);
}

export function magicCircle(target, element) {
  const r = _rectOf(target);
  if (!r) return;
  const cx = r.left + r.width  / 2;
  const cy = r.top  + r.height / 2;
  const color = _elementColor(element);
  const html = `<div class="vfx-circle" style="left:${cx}px;top:${cy}px;--c:${color}"></div>`;
  _spawn(html, document.body, 900);
}

function _elementColor(element) {
  switch (element) {
    case '火': return '#ff6b3d';
    case '水': return '#4dc4ff';
    case '草': return '#66bb6a';
    case '雷': return '#ffd54f';
    case '光': return '#fff176';
    case '闇': return '#b070dd';
    default:   return '#ffffff';
  }
}

// プレイヤーアイコン中心 / 戦闘パネル敵スプライト位置を取得するヘルパ
export function playerVfxAnchor() {
  const canvas = document.getElementById('dungeon-canvas');
  if (!canvas) return null;
  const r = canvas.getBoundingClientRect();
  // プレイヤーは canvas 中央
  return { left: r.left + r.width / 2 - 20, top: r.top + r.height / 2 - 20, width: 40, height: 40 };
}

export function enemyVfxAnchor() {
  const sprite = document.getElementById('enemy-sprite');
  if (!sprite) return null;
  return sprite.getBoundingClientRect();
}

// 攻撃の方向（誰が誰を狙ったか）を直感的に示す細長いストリーク。
//   from / to は { left, top, width, height } または { x, y } を受け付ける。
//   element 文字列を渡せば属性カラーで彩色（無ければ default の橙）。
//   呼び出し側は「攻撃側 → 被弾側」の順で渡す。
export function attackTrail(from, to, opts = {}) {
  const a = _toCenterPoint(from);
  const b = _toCenterPoint(to);
  if (!a || !b) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;
  const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
  const color = opts.color ?? _elementColor(opts.element) ?? '#ff7043';

  const el = document.createElement('div');
  el.className = 'vfx-attack-trail';
  el.style.left = a.x + 'px';
  el.style.top  = a.y + 'px';
  el.style.width  = len + 'px';
  el.style.transform = `translate(0, -50%) rotate(${angleDeg}deg)`;
  el.style.background = `linear-gradient(90deg, transparent 0%, ${color} 25%, #fff 50%, ${color} 75%, transparent 100%)`;
  el.style.boxShadow = `0 0 10px ${color}, 0 0 20px ${color}`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 480);

  // 着弾点に小さな閃光（誰が「誰を」攻撃したかを強調）
  const hit = document.createElement('div');
  hit.className = 'vfx-attack-impact';
  hit.style.left = b.x + 'px';
  hit.style.top  = b.y + 'px';
  hit.style.background = color;
  hit.style.boxShadow  = `0 0 16px ${color}`;
  document.body.appendChild(hit);
  setTimeout(() => hit.remove(), 420);
}

function _toCenterPoint(target) {
  if (!target) return null;
  if (typeof target.x === 'number' && typeof target.y === 'number' && target.width === undefined) {
    return { x: target.x, y: target.y };
  }
  const r = _rectOf(target);
  if (!r) return null;
  return { x: r.left + (r.width ?? 0) / 2, y: r.top + (r.height ?? 0) / 2 };
}

// ─────────────────────────────────────────────
// 技パターン別の特殊演出
//   A 型 = 上下左右の隣 4 マス：プレイヤー中心に十字スラッシュ
//   B 型 = 周囲 8 マス（王将）：プレイヤー中心に拡大円波
//   C 型 = 4 方向 2 マス先まで：4 方向のレーザービーム
//   D 型 = 周囲 2 マス全 24：大きな拡大リング + 渦
//
//   呼び出し側は技の属性カラーと「マス幅 (tileSize)」を渡す。
//   playerCenter = { x, y } はプレイヤーの画面中心（canvas 内中央）。
// ─────────────────────────────────────────────
export function showSkillPatternVfx(pattern, playerCenter, tileSize, color = '#b070dd') {
  switch (pattern) {
    case 'A': _vfxCrossSlash (playerCenter, tileSize, color); break;
    case 'B': _vfxOmniSweep  (playerCenter, tileSize, color); break;
    case 'C': _vfxFourBeams  (playerCenter, tileSize, color); break;
    case 'D': _vfxBigAoeRing (playerCenter, tileSize, color); break;
    default:  _vfxOmniSweep  (playerCenter, tileSize, color);
  }
}

// 十字スラッシュ：上下左右に 4 つのスラッシュ片（細長矩形）を伸ばす
function _vfxCrossSlash(c, ts, color) {
  const len = ts * 1.4;
  const dirs = [
    { rot: 90,    dx: 0, dy: -len * 0.55 },   // 上
    { rot: 90,    dx: 0, dy:  len * 0.55 },   // 下
    { rot: 0,     dx: -len * 0.55, dy: 0 },   // 左
    { rot: 0,     dx:  len * 0.55, dy: 0 },   // 右
  ];
  for (const d of dirs) {
    const el = document.createElement('div');
    el.className = 'vfx-slash';
    el.style.left = (c.x + d.dx) + 'px';
    el.style.top  = (c.y + d.dy) + 'px';
    el.style.width  = len + 'px';
    el.style.height = (ts * 0.18) + 'px';
    el.style.background = `linear-gradient(90deg, transparent 0%, ${color} 30%, #fff 50%, ${color} 70%, transparent 100%)`;
    el.style.boxShadow = `0 0 12px ${color}`;
    el.style.transform = `translate(-50%,-50%) rotate(${d.rot}deg)`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 480);
  }
}

// 周囲 8 マスを薙ぐ：プレイヤー中心の拡大円
function _vfxOmniSweep(c, ts, color) {
  const el = document.createElement('div');
  el.className = 'vfx-omni-sweep';
  el.style.left = c.x + 'px';
  el.style.top  = c.y + 'px';
  el.style.setProperty('--c', color);
  el.style.setProperty('--max', (ts * 3.4) + 'px');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 600);
}

// 4 方向のレーザー：上下左右に伸びる長いビーム
function _vfxFourBeams(c, ts, color) {
  const len = ts * 2.6;
  const dirs = [
    { rot: 0,   tx: len / 2 + ts * 0.5, ty: 0 },
    { rot: 0,   tx: -len / 2 - ts * 0.5, ty: 0 },
    { rot: 90,  tx: 0, ty: len / 2 + ts * 0.5 },
    { rot: 90,  tx: 0, ty: -len / 2 - ts * 0.5 },
  ];
  for (const d of dirs) {
    const el = document.createElement('div');
    el.className = 'vfx-beam';
    el.style.left = (c.x + d.tx) + 'px';
    el.style.top  = (c.y + d.ty) + 'px';
    el.style.width  = len + 'px';
    el.style.height = (ts * 0.22) + 'px';
    el.style.background = `linear-gradient(90deg, transparent 0%, ${color} 50%, transparent 100%)`;
    el.style.boxShadow = `0 0 14px ${color}, 0 0 28px ${color}`;
    el.style.transform = `translate(-50%,-50%) rotate(${d.rot}deg)`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 520);
  }
}

// 大規模 AoE：拡大リングを 2 段 + 中央渦
function _vfxBigAoeRing(c, ts, color) {
  const ring1 = document.createElement('div');
  ring1.className = 'vfx-aoe-ring vfx-aoe-ring-1';
  ring1.style.left = c.x + 'px';
  ring1.style.top  = c.y + 'px';
  ring1.style.setProperty('--c', color);
  ring1.style.setProperty('--max', (ts * 5.2) + 'px');
  document.body.appendChild(ring1);
  setTimeout(() => {
    const ring2 = document.createElement('div');
    ring2.className = 'vfx-aoe-ring vfx-aoe-ring-2';
    ring2.style.left = c.x + 'px';
    ring2.style.top  = c.y + 'px';
    ring2.style.setProperty('--c', color);
    ring2.style.setProperty('--max', (ts * 5.0) + 'px');
    document.body.appendChild(ring2);
    setTimeout(() => ring2.remove(), 720);
  }, 120);
  // 中央の渦（回転する円）
  const swirl = document.createElement('div');
  swirl.className = 'vfx-aoe-swirl';
  swirl.style.left = c.x + 'px';
  swirl.style.top  = c.y + 'px';
  swirl.style.setProperty('--c', color);
  document.body.appendChild(swirl);
  setTimeout(() => ring1.remove(), 800);
  setTimeout(() => swirl.remove(), 900);
}
