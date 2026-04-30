// ─────────────────────────────────────────────
// アイテム用 手続きアイコン生成（Canvas）
//   - emoji の代わりに type×base×element×rarity から手続き的に描く
//   - getItemIconCanvas: <canvas>（drawImage 用、同期取得）
//   - getItemIconUrl:    DataURL（<img src> 用）
//   - キャッシュは barcode+rarity+size をキーに保持
// ─────────────────────────────────────────────

import { hashString, createRNG } from './rng.js';

// 新属性のカラー：手描き感を意識（ダルめの彩度・ややくすんだ色合い）
const ELEMENT_COLOR = {
  '棒人間':     '#c5c5d4',   // 鉛筆の灰
  '落書き':     '#ff6b6b',   // クレヨンの赤
  '影絵':       '#5b5b78',   // インクブルー
  'ピクセル':   '#4dc4ff',   // 8bit シアン
  'ホログラム': '#b070dd',   // 紫光
  '折り紙':     '#ffd54f',   // 黄色い紙
};
const ELEMENT_GLYPH = {
  '棒人間': '🥢', '落書き': '✏️', '影絵': '👤',
  'ピクセル': '🟦', 'ホログラム': '🌈', '折り紙': '📄',
};
const NEUTRAL_COLOR = '#aab0c2';

const RARITY_FRAME = {
  コモン:     { color: '#9e9e9e', glow: 0,  gems: 0, plate: '#1a1d28' },
  レア:       { color: '#29b6f6', glow: 6,  gems: 0, plate: '#102031' },
  エピック:   { color: '#ab47bc', glow: 12, gems: 2, plate: '#1d122c' },
  レジェンド: { color: '#ffc107', glow: 18, gems: 4, plate: '#2a1f08' },
};

const cache = new Map();

function _cacheKey(item, size) {
  // base 名 + element + rarity + barcode（個体差用）+ size
  return `${item.type}|${item.barcode ?? '-'}|${item.rarity}|${item.element ?? '-'}|${size}`;
}

export function getItemIconCanvas(item, size = 64) {
  const key = _cacheKey(item, size);
  let c = cache.get(key);
  if (c) return c;
  c = _renderToCanvas(item, size);
  cache.set(key, c);
  return c;
}

export function getItemIconUrl(item, size = 64) {
  return getItemIconCanvas(item, size).toDataURL();
}

// ─── ベース描画 ───
function _renderToCanvas(item, size) {
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // 個体差用 RNG（同じ item は毎回同じ見た目）
  const rng = createRNG(hashString(`icon:${item.barcode ?? item.name}:${item.rarity}`));

  _drawFrame(ctx, item, size);
  _drawBody(ctx, item, size, rng);
  _drawRarityDecorations(ctx, item, size, rng);

  return canvas;
}

function _drawFrame(ctx, item, size) {
  const r = RARITY_FRAME[item.rarity] ?? RARITY_FRAME.コモン;
  const pad = 2;

  // 角丸の暗いプレート
  _roundRect(ctx, pad, pad, size - pad * 2, size - pad * 2, size * 0.18);
  ctx.fillStyle = r.plate;
  ctx.fill();

  // レアグロウ
  if (r.glow > 0) {
    ctx.save();
    ctx.shadowColor = r.color;
    ctx.shadowBlur  = r.glow;
    ctx.strokeStyle = r.color;
    ctx.lineWidth   = 2.5;
    _roundRect(ctx, pad, pad, size - pad * 2, size - pad * 2, size * 0.18);
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.strokeStyle = r.color;
    ctx.lineWidth   = 1.5;
    _roundRect(ctx, pad, pad, size - pad * 2, size - pad * 2, size * 0.18);
    ctx.stroke();
  }

  // 背景に属性カラーのほのかなグラデーション
  const elColor = ELEMENT_COLOR[item.element] ?? NEUTRAL_COLOR;
  const grad = ctx.createRadialGradient(
    size * 0.5, size * 0.55, size * 0.05,
    size * 0.5, size * 0.55, size * 0.5,
  );
  grad.addColorStop(0, _alpha(elColor, 0.32));
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  _roundRect(ctx, pad + 2, pad + 2, size - pad * 2 - 4, size - pad * 2 - 4, size * 0.16);
  ctx.fill();
}

function _drawBody(ctx, item, size, rng) {
  ctx.save();
  ctx.translate(size / 2, size / 2);

  switch (item.type) {
    case 'weapon': _drawWeapon(ctx, item, size, rng); break;
    case 'armor':  _drawArmor (ctx, item, size, rng); break;
    case 'potion': _drawPotion(ctx, item, size, rng); break;
    case 'scroll': _drawScroll(ctx, item, size, rng); break;
    default: ctx.fillStyle = '#ddd';
  }
  ctx.restore();
}

// ─── 武器 ───
function _drawWeapon(ctx, item, size, rng) {
  const elColor = ELEMENT_COLOR[item.element] ?? NEUTRAL_COLOR;
  const baseName = _baseFromName(item.name);
  // 基本武器形状：剣/短剣/槍/斧/杖
  if (baseName.includes('短剣'))         _drawDagger(ctx, size, elColor);
  else if (baseName.includes('斧'))      _drawAxe(ctx, size, elColor);
  else if (baseName.includes('槍'))      _drawSpear(ctx, size, elColor);
  else if (baseName.includes('魔法杖') || baseName.includes('杖')) _drawWand(ctx, size, elColor);
  else                                    _drawSword(ctx, size, elColor);
}

function _bladeGradient(ctx, size, elColor) {
  const g = ctx.createLinearGradient(-size * 0.2, -size * 0.2, size * 0.2, size * 0.2);
  g.addColorStop(0, '#fafbff');
  g.addColorStop(0.5, '#cdd3e0');
  g.addColorStop(1, _alpha(elColor, 0.85));
  return g;
}

function _drawSword(ctx, size, elColor) {
  ctx.save();
  ctx.rotate(-Math.PI / 4);
  // 刀身
  const bw = size * 0.10;
  const bl = size * 0.55;
  ctx.fillStyle = _bladeGradient(ctx, size, elColor);
  ctx.beginPath();
  ctx.moveTo(0, -bl);
  ctx.lineTo(bw, -bl + bw);
  ctx.lineTo(bw, bl * 0.1);
  ctx.lineTo(-bw, bl * 0.1);
  ctx.lineTo(-bw, -bl + bw);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // 鍔
  ctx.fillStyle = '#c5a23c';
  ctx.fillRect(-size * 0.22, bl * 0.10, size * 0.44, size * 0.07);
  // 柄
  ctx.fillStyle = '#5a3a1f';
  ctx.fillRect(-size * 0.05, bl * 0.17, size * 0.10, size * 0.18);
  // 柄頭
  ctx.fillStyle = '#c5a23c';
  ctx.beginPath();
  ctx.arc(0, bl * 0.17 + size * 0.20, size * 0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function _drawDagger(ctx, size, elColor) {
  ctx.save();
  ctx.rotate(-Math.PI / 4);
  const bw = size * 0.07;
  const bl = size * 0.35;
  ctx.fillStyle = _bladeGradient(ctx, size, elColor);
  ctx.beginPath();
  ctx.moveTo(0, -bl);
  ctx.lineTo(bw, -bl + bw);
  ctx.lineTo(bw, bl * 0.1);
  ctx.lineTo(-bw, bl * 0.1);
  ctx.lineTo(-bw, -bl + bw);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#888';
  ctx.fillRect(-size * 0.15, bl * 0.10, size * 0.30, size * 0.05);
  ctx.fillStyle = '#3a2812';
  ctx.fillRect(-size * 0.04, bl * 0.15, size * 0.08, size * 0.18);
  ctx.restore();
}

function _drawAxe(ctx, size, elColor) {
  ctx.save();
  ctx.rotate(-Math.PI / 6);
  // 柄
  ctx.fillStyle = '#5a3a1f';
  ctx.fillRect(-size * 0.04, -size * 0.4, size * 0.08, size * 0.8);
  // 斧頭
  ctx.fillStyle = _bladeGradient(ctx, size, elColor);
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.32);
  ctx.lineTo(size * 0.36, -size * 0.18);
  ctx.lineTo(size * 0.32, size * 0.06);
  ctx.lineTo(0, -size * 0.05);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
}

function _drawSpear(ctx, size, elColor) {
  ctx.save();
  ctx.rotate(-Math.PI / 4);
  // 柄（長い）
  ctx.fillStyle = '#5a3a1f';
  ctx.fillRect(-size * 0.025, -size * 0.45, size * 0.05, size * 0.95);
  // 穂先
  ctx.fillStyle = _bladeGradient(ctx, size, elColor);
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.50);
  ctx.lineTo(size * 0.10, -size * 0.30);
  ctx.lineTo(-size * 0.10, -size * 0.30);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.stroke();
  ctx.restore();
}

function _drawWand(ctx, size, elColor) {
  ctx.save();
  ctx.rotate(-Math.PI / 6);
  // 柄
  ctx.strokeStyle = '#5a3a1f';
  ctx.lineWidth = size * 0.06;
  ctx.beginPath();
  ctx.moveTo(0, size * 0.4);
  ctx.lineTo(size * 0.05, -size * 0.15);
  ctx.stroke();
  // 先端のオーブ
  ctx.fillStyle = _alpha(elColor, 0.95);
  ctx.beginPath();
  ctx.arc(size * 0.07, -size * 0.22, size * 0.13, 0, Math.PI * 2);
  ctx.fill();
  // ハイライト
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.arc(size * 0.04, -size * 0.27, size * 0.04, 0, Math.PI * 2);
  ctx.fill();
  // オーラ
  ctx.save();
  ctx.shadowColor = elColor;
  ctx.shadowBlur = 12;
  ctx.strokeStyle = _alpha(elColor, 0.6);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(size * 0.07, -size * 0.22, size * 0.18, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  ctx.restore();
}

// ─── 防具 ───
function _drawArmor(ctx, item, size, rng) {
  const elColor = ELEMENT_COLOR[item.element] ?? NEUTRAL_COLOR;
  const baseName = _baseFromName(item.name);
  if (baseName.includes('盾'))      _drawShield(ctx, size, elColor);
  else if (baseName.includes('鎧')) _drawChestplate(ctx, size, elColor);
  else                              _drawCape(ctx, size, elColor);
}

function _drawShield(ctx, size, elColor) {
  // カイトシールド
  const w = size * 0.42;
  const h = size * 0.55;
  ctx.fillStyle = _alpha(elColor, 0.85);
  ctx.beginPath();
  ctx.moveTo(0, -h);
  ctx.bezierCurveTo(w, -h, w, h * 0.2, 0, h);
  ctx.bezierCurveTo(-w, h * 0.2, -w, -h, 0, -h);
  ctx.fill();
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 2;
  ctx.stroke();
  // 中央の縦線
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.7);
  ctx.lineTo(0, h * 0.6);
  ctx.stroke();
  // 中央の宝石
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(0, -h * 0.05, size * 0.06, 0, Math.PI * 2);
  ctx.fill();
}

function _drawChestplate(ctx, size, elColor) {
  // 胸甲（台形）
  ctx.fillStyle = _alpha(elColor, 0.85);
  ctx.beginPath();
  ctx.moveTo(-size * 0.30, -size * 0.30);
  ctx.lineTo( size * 0.30, -size * 0.30);
  ctx.lineTo( size * 0.36,  size * 0.30);
  ctx.lineTo(-size * 0.36,  size * 0.30);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 2;
  ctx.stroke();
  // 首回り
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.ellipse(0, -size * 0.30, size * 0.13, size * 0.06, 0, 0, Math.PI * 2);
  ctx.fill();
  // 装飾ライン
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.20);
  ctx.lineTo(0,  size * 0.25);
  ctx.stroke();
  // リベット
  ctx.fillStyle = '#fff';
  for (const x of [-size * 0.22, size * 0.22]) {
    ctx.beginPath();
    ctx.arc(x, size * 0.05, size * 0.025, 0, Math.PI * 2);
    ctx.fill();
  }
}

function _drawCape(ctx, size, elColor) {
  // マント（流れる布）
  ctx.fillStyle = _alpha(elColor, 0.85);
  ctx.beginPath();
  ctx.moveTo(-size * 0.25, -size * 0.30);
  ctx.lineTo( size * 0.25, -size * 0.30);
  ctx.bezierCurveTo(size * 0.42, 0, size * 0.30, size * 0.30, size * 0.10, size * 0.36);
  ctx.lineTo(-size * 0.10, size * 0.36);
  ctx.bezierCurveTo(-size * 0.30, size * 0.30, -size * 0.42, 0, -size * 0.25, -size * 0.30);
  ctx.fill();
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 2;
  ctx.stroke();
  // 留め金
  ctx.fillStyle = '#ffc107';
  ctx.beginPath();
  ctx.arc(0, -size * 0.27, size * 0.05, 0, Math.PI * 2);
  ctx.fill();
  // 裾の縁
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-size * 0.22, -size * 0.10);
  ctx.bezierCurveTo(0, size * 0.05, 0, size * 0.05, size * 0.22, -size * 0.10);
  ctx.stroke();
}

// ─── 薬 ───
function _drawPotion(ctx, item, size, rng) {
  const baseName = _baseFromName(item.name);
  const big   = baseName.includes('大');
  const small = baseName.includes('小');
  const liquid = item.rarity === 'レジェンド' ? '#ffc107'
              : item.rarity === 'エピック'   ? '#ce93d8'
              : item.rarity === 'レア'       ? '#80d8ff'
              : '#ef9a9a';

  // 瓶の輪郭
  const bw = (small ? 0.18 : big ? 0.30 : 0.24) * size;
  const bh = (small ? 0.25 : big ? 0.40 : 0.32) * size;
  // 首
  ctx.fillStyle = '#cfd8dc';
  ctx.fillRect(-bw * 0.35, -bh - size * 0.13, bw * 0.7, size * 0.10);
  // 栓
  ctx.fillStyle = '#5a3a1f';
  ctx.fillRect(-bw * 0.30, -bh - size * 0.18, bw * 0.6, size * 0.07);

  // 本体（角丸長方形）
  ctx.fillStyle = 'rgba(220,235,245,0.55)';
  _roundRect(ctx, -bw, -bh, bw * 2, bh * 2, bw * 0.4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 中身（少し浮かせる）
  ctx.save();
  ctx.beginPath();
  _roundRectPath(ctx, -bw + 2, -bh + bh * 0.4, bw * 2 - 4, bh * 1.55, bw * 0.35);
  ctx.clip();
  ctx.fillStyle = liquid;
  ctx.fillRect(-bw, -bh + bh * 0.4, bw * 2, bh * 1.6);
  // 表面ハイライト
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillRect(-bw + 4, -bh + bh * 0.42, bw * 0.5, 2);
  ctx.restore();

  // 気泡
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath();
  ctx.arc(-bw * 0.3, bh * 0.4, 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(bw * 0.2, bh * 0.7, 1.2, 0, Math.PI * 2);
  ctx.fill();
}

// ─── 巻物 ───
function _drawScroll(ctx, item, size, rng) {
  const elColor = ELEMENT_COLOR[item.element] ?? NEUTRAL_COLOR;
  const w = size * 0.55;
  const h = size * 0.44;

  // ロール（上下の巻き）
  ctx.fillStyle = '#7a5a2a';
  ctx.fillRect(-w * 0.5 - size * 0.03, -h * 0.6, w + size * 0.06, size * 0.08);
  ctx.fillRect(-w * 0.5 - size * 0.03,  h * 0.52, w + size * 0.06, size * 0.08);

  // 紙
  ctx.fillStyle = '#ede0c0';
  _roundRect(ctx, -w * 0.5, -h * 0.55, w, h * 1.1, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 装飾線
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(-w * 0.4, -h * 0.30 + i * h * 0.20);
    ctx.lineTo( w * 0.4, -h * 0.30 + i * h * 0.20);
    ctx.stroke();
  }

  // 中央に属性シンボル
  const glyph = ELEMENT_GLYPH[item.element] ?? '✶';
  ctx.save();
  ctx.shadowColor = elColor;
  ctx.shadowBlur = 8;
  ctx.fillStyle = elColor;
  ctx.font = `bold ${Math.floor(size * 0.30)}px serif`;
  ctx.textAlign = 'middle' /* ignored */;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, 0, 0);
  ctx.restore();
}

// ─── レアリティ装飾（角の宝石・煌き） ───
function _drawRarityDecorations(ctx, item, size, rng) {
  const r = RARITY_FRAME[item.rarity] ?? RARITY_FRAME.コモン;
  if (r.gems === 0) return;
  const cx = size / 2;
  const cy = size / 2;
  const rad = size / 2 - 4;

  const positions = r.gems === 2
    ? [[cx - rad + 4, cy - rad + 4], [cx + rad - 4, cy - rad + 4]]
    : [
        [cx - rad + 4, cy - rad + 4], [cx + rad - 4, cy - rad + 4],
        [cx - rad + 4, cy + rad - 4], [cx + rad - 4, cy + rad - 4],
      ];

  for (const [x, y] of positions) {
    ctx.save();
    ctx.shadowColor = r.color;
    ctx.shadowBlur  = 8;
    ctx.fillStyle   = r.color;
    ctx.beginPath();
    ctx.arc(x, y, size * 0.045, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(x - size * 0.012, y - size * 0.012, size * 0.018, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // レジェンドのみ追加で星屑
  if (item.rarity === 'レジェンド') {
    for (let i = 0; i < 4; i++) {
      const px = 8 + rng() * (size - 16);
      const py = 8 + rng() * (size - 16);
      ctx.save();
      ctx.fillStyle = 'rgba(255, 230, 120, 0.85)';
      ctx.shadowColor = '#fff7c0';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(px, py, 1.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

// ─── ヘルパ ───
function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  _roundRectPath(ctx, x, y, w, h, r);
}
function _roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y,     x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x,     y + h, rr);
  ctx.arcTo(x,     y + h, x,     y,     rr);
  ctx.arcTo(x,     y,     x + w, y,     rr);
  ctx.closePath();
}
function _alpha(hex, a) {
  // #rrggbb → rgba
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return `rgba(255,255,255,${a})`;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${a})`;
}

// アイテム名の中から「短剣」「剣」「斧」「槍」「魔法杖」「盾」「鎧」「マント」を抽出。
// items.js の生成名は `${element}の${base}${suffix}` 構造で、`base` は固定語彙。
function _baseFromName(name) {
  return name ?? '';
}
