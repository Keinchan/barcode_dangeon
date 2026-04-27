// プレイヤー頭上にダメージをフロート表示（canvas中央＝プレイヤーアイコン、赤）
export function showFloatingDamage(amount) {
  const canvas = document.getElementById('dungeon-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'damage-float';
  el.textContent = `-${amount}`;
  el.style.left = (rect.left + rect.width / 2) + 'px';
  el.style.top  = (rect.top + rect.height / 2 - 18) + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

// 敵に与えたダメージを戦闘パネル上の敵情報ボックス上端付近にフロート表示（緑）
export function showEnemyDamage(amount) {
  const target = document.querySelector('.combat-enemy');
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'damage-float damage-float-enemy';
  el.textContent = `-${amount}`;
  el.style.left = (rect.left + rect.width / 2) + 'px';
  el.style.top  = (rect.top + 6) + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1300);
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
  const count = opts.count ?? 8;
  const color = opts.color ?? '#ffd54f';
  const wrap = document.createElement('div');
  wrap.className = 'vfx-wrap';
  wrap.style.left = cx + 'px';
  wrap.style.top  = cy + 'px';
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'vfx-spark';
    const angle = (Math.PI * 2) * (i / count) + Math.random() * 0.4;
    const dist  = 22 + Math.random() * 18;
    p.style.background  = color;
    p.style.boxShadow   = `0 0 6px ${color}`;
    p.style.setProperty('--vx', Math.cos(angle) * dist + 'px');
    p.style.setProperty('--vy', Math.sin(angle) * dist + 'px');
    wrap.appendChild(p);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 600);
}

export function explosion(target, opts = {}) {
  const r = _rectOf(target);
  if (!r) return;
  const cx = r.left + r.width  / 2;
  const cy = r.top  + r.height / 2;
  const color = opts.color ?? '#ff7043';
  const html = `<div class="vfx-explosion" style="left:${cx}px;top:${cy}px;
    --c1:${color};--c2:rgba(255,255,255,0.9)"></div>`;
  _spawn(html, document.body, 700);
  // パーティクルも一緒に
  sparkSpray(target, { count: 12, color });
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
    case '地': return '#caa15a';
    case '風': return '#9adf8e';
    case '光': return '#ffe890';
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
