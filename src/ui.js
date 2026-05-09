import { getItemIconUrl } from './icons.js';

// アイテムバナー類は元々 emoji を直接表示していたが、ドロップ時のアイコン
// （icons.js の手続きアイコン）と見た目が分岐していたため、こちらでも同じ
// 画像を <img> で表示するためのヘルパ。サイズはバナーごとの CSS に合わせる。
function _bannerIconHtml(item, size) {
  if (!item) return '';
  return `<img class="item-icon" width="${size}" height="${size}" src="${getItemIconUrl(item, 64)}" alt="${item.name ?? ''}" />`;
}

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

// 技のすかし（whiff）演出。技が命中しなかったマスに「MISS」をフロート表示。
// damage-miss クラスのみ違い、サイズや動きは damage-float の流用で十分（淡色 +
// 縮小気味の動きで「効いてない感」を出す）。
export function showMissAt(rect) {
  if (!rect) return;
  const cx = rect.left + (rect.width  ?? 0) / 2;
  const cy = rect.top  + (rect.height ?? 0) / 2;
  const el = document.createElement('div');
  el.className = 'damage-float damage-miss';
  el.textContent = 'MISS';
  el.style.left = cx + 'px';
  el.style.top  = cy + 'px';
  el.style.fontSize = '20px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1100);
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
//   - コモン: 通常は無音（dungeonLog のみ）。opts.force=true で強制表示する
//             （宝箱開封など「中身を初公開する瞬間」用）。
//   - レア:   控えめなフチ付きトースト
//   - エピック: 紫の中央バナー
//   - レジェンド: 全画面の金色バナー＋星屑
// item.rarity を見て自動で振り分け。
export function showItemBanner(item, opts = {}) {
  if (!item || !item.rarity) return;
  const rarity = item.rarity;
  // 通常は コモン だと出さない（取得 SFX 過多になるため）。
  // opts.force=true なら強制表示する。
  if (rarity === 'コモン' && !opts.force) return;

  const action = opts.action ?? '入手';   // "入手" / "ドロップ" など
  const cls    = `item-banner rarity-${rarityKey(rarity)}`;
  const iconSize = rarity === 'レジェンド' ? 48 : 36;
  const iconHtml = _bannerIconHtml(item, iconSize);
  const tag    =
    rarity === 'レジェンド' ? '🏆 LEGENDARY' :
    rarity === 'エピック'   ? '💎 EPIC'      :
    rarity === 'レア'       ? '✨ RARE'      :
                              '🎁 COMMON';
  const lvHtml = item.level ? `<span class="item-banner-lv">Lv${item.level}</span>` : '';

  const div = document.createElement('div');
  div.className = cls;
  div.innerHTML = `
    <div class="item-banner-tag">${tag}</div>
    <div class="item-banner-row">
      <span class="item-banner-icon">${iconHtml}</span>
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
  const iconHtml = _bannerIconHtml(item, 48);

  const div = document.createElement('div');
  div.className = cls;
  div.innerHTML = `
    <div class="enhance-banner-tag">${tag}</div>
    <div class="enhance-banner-sub">${subTag}</div>
    <div class="enhance-banner-row">
      <span class="enhance-banner-icon">${iconHtml}</span>
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

// 攻撃予告テレグラフ。低速モードで「次に攻撃する敵」をプレイヤーに把握させるため、
// 攻撃発動前にそのマスを派手に光らせる。発動時の attackTrail / explosion とは別の
// クラスを使うことで、低速モードでも視覚的に「予告 → 発動」が区別できる。
//   target は要素か矩形（{ left, top, width, height }）。
//   color は枠の色（属性カラーを渡すのが推奨）。
//   durationMs はフラッシュの持続時間（テレグラフ後に攻撃を発動するタイマーと
//   合わせる）。
// 技種別バッジ：攻撃者の上に絵文字をふわっと浮かせる。
//   target: 要素 or 矩形（_rectOf 互換）
//   emoji:  '😡' / '❄' / '⚡' のような短い記号
//   color:  発光色（属性カラー推奨）。省略時は白
//   durationMs: 表示時間。CSS 側のアニメーション長と概ね揃える
export function showSkillBadge(target, emoji, color = '#fff', durationMs = 700) {
  if (!emoji) return;
  const r = _rectOf(target);
  if (!r) return;
  const cx = r.left + (r.width  ?? 0) / 2;
  const cy = r.top  + (r.height ?? 0) / 2;
  const el = document.createElement('div');
  el.className = 'vfx-skill-badge';
  el.style.left  = cx + 'px';
  el.style.top   = cy + 'px';
  el.style.color = color;
  el.style.animationDuration = (durationMs / 1000) + 's';
  el.textContent = emoji;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), durationMs + 80);
}

export function showAttackTelegraph(target, color = '#ffd54f', durationMs = 360) {
  const r = _rectOf(target);
  if (!r) return;
  const cx = r.left + (r.width  ?? 0) / 2;
  const cy = r.top  + (r.height ?? 0) / 2;
  const size = Math.max(36, Math.max(r.width ?? 0, r.height ?? 0) + 12);
  const el = document.createElement('div');
  el.className = 'vfx-telegraph';
  el.style.left = cx + 'px';
  el.style.top  = cy + 'px';
  el.style.width  = size + 'px';
  el.style.height = size + 'px';
  el.style.borderColor = color;
  el.style.boxShadow = `0 0 16px ${color}, 0 0 32px ${color}`;
  el.style.animationDuration = (durationMs / 1000) + 's';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), durationMs + 80);
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
// 範囲タイプ別の特殊演出（19 種類）
//
//   呼び出し側は範囲タイプ ID（CROSS / ADJ / LINE_INF 等）と
//   技の属性カラーと「マス幅 (tileSize)」を渡す。
//   playerCenter = { x, y } はプレイヤーの画面中心（canvas 内中央）。
//
//   旧 A/B/C/D/E/F も互換的に受け付ける（古いセーブからの保険）。
// ─────────────────────────────────────────────
const _LEGACY_PATTERN_TO_RANGE = {
  A: 'CROSS', B: 'ADJ', C: 'LINE3', D: 'TERRAIN_5X5', E: 'LINE_INF', F: 'ROOM',
};

export function showSkillPatternVfx(rangeId, playerCenter, tileSize, color = '#b070dd', opts = {}) {
  const id = _LEGACY_PATTERN_TO_RANGE[rangeId] ?? rangeId;
  const facing = opts.facing ?? [0, 1];
  switch (id) {
    // 単体・近接系
    case 'SELF':         _vfxSelfAura   (playerCenter, tileSize, color); break;
    case 'MELEE':        _vfxLongBeam   (playerCenter, tileSize, color, facing, 1.0); break;
    case 'ADJ':          _vfxOmniSweep  (playerCenter, tileSize, color); break;
    case 'CROSS':        _vfxCrossSlash (playerCenter, tileSize, color); break;
    case 'DIAG':         _vfxDiagSlash  (playerCenter, tileSize, color); break;

    // 直線・距離系
    case 'LINE3':        _vfxLongBeam   (playerCenter, tileSize, color, facing, 3.4); break;
    case 'LINE5':        _vfxLongBeam   (playerCenter, tileSize, color, facing, 5.4); break;
    case 'LINE_INF':     _vfxLongBeam   (playerCenter, tileSize, color, facing, 6.4); break;
    case 'PIERCE':       _vfxPierceBeam (playerCenter, tileSize, color, facing); break;
    case 'RANGED':       _vfxRangedShot (playerCenter, tileSize, color, facing); break;

    // 部屋・全体系
    case 'ROOM':         _vfxRoomFlash  (playerCenter, tileSize, color); break;
    case 'ROOM_ALL':     _vfxRoomFlash  (playerCenter, tileSize, color); break;
    case 'FLOOR':        _vfxFloorBurst (playerCenter, tileSize, color); break;
    case 'FLOOR_ALL':    _vfxFloorBurst (playerCenter, tileSize, color); break;

    // 地形・特殊系
    case 'TERRAIN_3X3':  _vfxBigAoeRing (playerCenter, tileSize * 0.7, color); break;
    case 'TERRAIN_5X5':  _vfxBigAoeRing (playerCenter, tileSize, color); break;
    case 'CONE3':        _vfxConeFan    (playerCenter, tileSize, color, facing); break;
    case 'AROUND_TARGET':_vfxAroundTarget(playerCenter, tileSize, color, facing); break;
    case 'TRAP':         _vfxTrapPulse  (playerCenter, tileSize, color); break;

    default:             _vfxOmniSweep  (playerCenter, tileSize, color);
  }
}

// 正面方向に伸びる長尺ビーム。lengthInTiles を変えれば MELEE / LINE3 / LINE5 /
// LINE_INF を同じ実装で描き分けられる。
// facing は dungeon の playerPos.facing をそのまま渡す ([dx, dy] / 8 方向)。
function _vfxLongBeam(c, ts, color, facing, lengthInTiles = 6.4) {
  const fx = facing[0];
  const fy = facing[1];
  if (fx === 0 && fy === 0) return;
  // 斜め向きは 1 ステップ進むと grid 上 √2 マス分の Euclidean 距離を進む。
  // ビーム長は「カバーするマス数 × √2」にしないと N 番目の命中マスより手前で
  // 視覚効果が途切れて、線の方向と着弾点がズレて見える。
  const isDiag = fx !== 0 && fy !== 0;
  const len = ts * lengthInTiles * (isDiag ? Math.SQRT2 : 1);
  // 角度: 基準は右方向（rotate 0deg = ベース向き）。faceing [1,0] → 0deg, [0,1] → 90deg
  const ang = Math.atan2(fy, fx) * 180 / Math.PI;
  const offX = Math.cos(ang * Math.PI / 180) * (len / 2 + ts * 0.3);
  const offY = Math.sin(ang * Math.PI / 180) * (len / 2 + ts * 0.3);
  const el = document.createElement('div');
  el.className = 'vfx-beam';
  el.style.left = (c.x + offX) + 'px';
  el.style.top  = (c.y + offY) + 'px';
  el.style.width  = len + 'px';
  el.style.height = (ts * 0.30) + 'px';
  el.style.background = `linear-gradient(90deg, transparent 0%, ${color} 30%, #fff 50%, ${color} 70%, transparent 100%)`;
  el.style.boxShadow = `0 0 18px ${color}, 0 0 36px ${color}`;
  // CSS の vfxBeam keyframes は transform を rotate(var(--r, 0deg)) で参照する。
  // ここで el.style.transform を直接書くとアニメーション側で上書きされて角度が
  // 常に 0deg（横向き）になるバグがあったので、CSS 変数経由で角度を渡す。
  el.style.setProperty('--r', ang + 'deg');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 560);
}

// SELF: 自分中心の柔らかいオーラリング（バフ感）
function _vfxSelfAura(c, ts, color) {
  for (let i = 0; i < 2; i++) {
    setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'vfx-aoe-ring vfx-aoe-ring-1';
      el.style.left = c.x + 'px';
      el.style.top  = c.y + 'px';
      el.style.setProperty('--c', color);
      el.style.setProperty('--max', (ts * 2.0) + 'px');
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 700);
    }, i * 120);
  }
  sparkSpray({ left: c.x - 16, top: c.y - 16, width: 32, height: 32 }, { count: 14, color });
}

// DIAG: 斜め 4 方向のスラッシュ
function _vfxDiagSlash(c, ts, color) {
  const len = ts * 1.3;
  const angles = [45, 135, -45, -135];
  for (const aDeg of angles) {
    const el = document.createElement('div');
    el.className = 'vfx-slash';
    const a = aDeg * Math.PI / 180;
    el.style.left = (c.x + Math.cos(a) * len * 0.55) + 'px';
    el.style.top  = (c.y + Math.sin(a) * len * 0.55) + 'px';
    el.style.width  = len + 'px';
    el.style.height = (ts * 0.18) + 'px';
    el.style.background = `linear-gradient(90deg, transparent 0%, ${color} 30%, #fff 50%, ${color} 70%, transparent 100%)`;
    el.style.boxShadow = `0 0 12px ${color}`;
    el.style.setProperty('--r', aDeg + 'deg');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 480);
  }
}

// PIERCE: 細く速いビーム + 中央の貫通弾エフェクト
function _vfxPierceBeam(c, ts, color, facing) {
  _vfxLongBeam(c, ts, '#fff', facing, 6.4);   // 白い芯
  setTimeout(() => _vfxLongBeam(c, ts, color, facing, 6.4), 60);
}

// RANGED: 正面 N マス先に閃光リング + 中央へのビーム導入
function _vfxRangedShot(c, ts, color, facing) {
  _vfxLongBeam(c, ts, color, facing, 3.0);
  const fx = facing[0], fy = facing[1];
  const dist = ts * 3;
  const tx = c.x + fx * dist;
  const ty = c.y + fy * dist;
  setTimeout(() => {
    const ring = document.createElement('div');
    ring.className = 'vfx-aoe-ring vfx-aoe-ring-1';
    ring.style.left = tx + 'px';
    ring.style.top  = ty + 'px';
    ring.style.setProperty('--c', color);
    ring.style.setProperty('--max', (ts * 1.6) + 'px');
    document.body.appendChild(ring);
    setTimeout(() => ring.remove(), 700);
    sparkSpray({ left: tx - 16, top: ty - 16, width: 32, height: 32 }, { count: 14, color });
  }, 200);
}

// FLOOR: フロア全体に広がる超大型 AoE（部屋技より大きく）
function _vfxFloorBurst(c, ts, color) {
  const flash = document.createElement('div');
  flash.className = 'vfx-hitflash';
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
  if (m) {
    const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    flash.style.background = `rgba(${r},${g},${b},0.55)`;
  }
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 280);
  _vfxBigAoeRing(c, ts * 1.8, color);
  // 4 方向にも光帯を伸ばしてフロアスケール感を出す
  for (const angle of [0, 90, 180, 270]) {
    const el = document.createElement('div');
    el.className = 'vfx-beam';
    el.style.left = c.x + 'px';
    el.style.top  = c.y + 'px';
    el.style.width  = (ts * 14) + 'px';
    el.style.height = (ts * 0.22) + 'px';
    el.style.background = `linear-gradient(90deg, transparent 0%, ${color} 50%, transparent 100%)`;
    el.style.boxShadow = `0 0 14px ${color}`;
    el.style.setProperty('--r', angle + 'deg');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 560);
  }
}

// CONE3: 正面扇形 3 マス幅。3 本のスラッシュを少し時差で重ねる
function _vfxConeFan(c, ts, color, facing) {
  const fx = facing[0], fy = facing[1];
  if (fx === 0 && fy === 0) return _vfxOmniSweep(c, ts, color);
  const baseAng = Math.atan2(fy, fx) * 180 / Math.PI;
  const offsets = [-25, 0, 25];   // 中央 + 左右 25°
  offsets.forEach((da, i) => {
    setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'vfx-beam';
      const a = (baseAng + da) * Math.PI / 180;
      const len = ts * 3.2;
      el.style.left = (c.x + Math.cos(a) * (len / 2 + ts * 0.3)) + 'px';
      el.style.top  = (c.y + Math.sin(a) * (len / 2 + ts * 0.3)) + 'px';
      el.style.width  = len + 'px';
      el.style.height = (ts * 0.22) + 'px';
      el.style.background = `linear-gradient(90deg, transparent 0%, ${color} 40%, #fff 50%, ${color} 60%, transparent 100%)`;
      el.style.boxShadow = `0 0 12px ${color}`;
      el.style.setProperty('--r', (baseAng + da) + 'deg');
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 520);
    }, i * 60);
  });
}

// AROUND_TARGET: 正面方向にビーム → 着弾点で 3x3 の AoE
function _vfxAroundTarget(c, ts, color, facing) {
  _vfxLongBeam(c, ts, color, facing, 4.0);
  const fx = facing[0], fy = facing[1];
  const dist = ts * 3;
  const tx = c.x + fx * dist;
  const ty = c.y + fy * dist;
  setTimeout(() => _vfxBigAoeRing({ x: tx, y: ty }, ts * 0.8, color), 180);
}

// TRAP: 足元にパルスする小さなリング（設置済みマーカー感）
function _vfxTrapPulse(c, ts, color) {
  const el = document.createElement('div');
  el.className = 'vfx-aoe-ring vfx-aoe-ring-2';
  el.style.left = c.x + 'px';
  el.style.top  = c.y + 'px';
  el.style.setProperty('--c', color);
  el.style.setProperty('--max', (ts * 1.2) + 'px');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 700);
}

// F 型: 部屋全体を覆う色付きフラッシュ + 大型 AoE リング（部屋掃除感）。
function _vfxRoomFlash(c, ts, color) {
  // 画面全体の薄い色フラッシュ（hitFlash と同じ系統だが色を技色に）
  const flash = document.createElement('div');
  flash.className = 'vfx-hitflash';
  flash.style.background = color.replace(/^#/, 'rgba(') ; // fallback
  // 確実に色を出すため inline で alpha 付きの色を作る
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
  if (m) {
    const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    flash.style.background = `rgba(${r},${g},${b},0.40)`;
  }
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 220);
  // 大型 AoE リング（D 型の流用、より大きく）
  _vfxBigAoeRing(c, ts * 1.25, color);
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
    el.style.setProperty('--r', d.rot + 'deg');
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
    el.style.setProperty('--r', d.rot + 'deg');
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
