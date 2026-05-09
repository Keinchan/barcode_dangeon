// ─────────────────────────────────────────────
// アイテム用 手続きアイコン生成（Canvas）
//   - emoji の代わりに type×base×element×rarity から手続き的に描く
//   - getItemIconCanvas: <canvas>（drawImage 用、同期取得）
//   - getItemIconUrl:    DataURL（<img src> 用）
//   - キャッシュは barcode+rarity+size をキーに保持
// ─────────────────────────────────────────────

import { hashString, createRNG } from './rng.js';

// 直感的な 6 属性カラー（火=赤橙、水=シアン、草=緑、雷=黄、光=淡黄、闇=紫）。
// ELEMENT_GLYPH は巻物の中央に配置するシンボル絵文字。
const ELEMENT_COLOR = {
  '火': '#ff6b3d',
  '水': '#4dc4ff',
  '草': '#66bb6a',
  '雷': '#ffd54f',
  '光': '#fff176',
  '闇': '#b070dd',
};
const ELEMENT_GLYPH = {
  '火': '🔥', '水': '💧', '草': '🌿',
  '雷': '⚡', '光': '✨', '闇': '🌑',
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
    case 'weapon':        _drawWeapon(ctx, item, size, rng); break;
    case 'armor':         _drawArmor (ctx, item, size, rng); break;
    case 'potion':        _drawPotion(ctx, item, size, rng); break;
    case 'mpPotion':      _drawMpPotion(ctx, item, size, rng); break;
    case 'scroll':        _drawScroll(ctx, item, size, rng); break;
    case 'mysteryScroll': _drawEmojiOnFrame(ctx, item.emoji ?? '📜', size); break;
    case 'skillBook':     _drawSkillBook(ctx, item, size); break;
    case 'key':           _drawEmojiOnFrame(ctx, '🗝️', size); break;
    case 'material':      _drawEmojiOnFrame(ctx, item.emoji ?? '⛓️', size); break;
    case 'gold':          _drawGold(ctx, size); break;
    case 'chest':         _drawChest(ctx, size); break;
    default:              _drawEmojiOnFrame(ctx, item.emoji ?? '🎁', size);
  }
  ctx.restore();
}

// 既存の絵文字を中央にそのまま重ねる（手続き描画が用意されていないタイプ用）。
// レアリティ枠と属性グラデーションは _drawFrame 側で先に描いてあるので、その上に
// 大きめに絵文字を 1 つ落とすだけで「ドロップ時と同じアイコン」として成立する。
function _drawEmojiOnFrame(ctx, emoji, size) {
  ctx.font = `${Math.floor(size * 0.6)}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur  = 4;
  ctx.fillText(emoji, 0, 0);
}

// 技の書: 📕 + 属性バッジを左上に重ねて、属性が一目でわかるようにする。
// 旧実装は 📕 だけだったため「これ何属性の書？」と毎回テキストを読まないと
// 分からない不便さがあった。
const _BOOK_ELEMENT_BADGE = {
  '火': '🔥', '水': '💧', '草': '🌿', '雷': '⚡', '光': '✨', '闇': '🌑',
};
function _drawSkillBook(ctx, item, size) {
  // 本体（書）
  ctx.font = `${Math.floor(size * 0.6)}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur  = 4;
  ctx.fillText('📕', 0, 0);
  // 属性バッジ（左上に小さく重ねる。size の 1/4 程度）
  const badge = _BOOK_ELEMENT_BADGE[item?.element];
  if (!badge) return;
  ctx.shadowBlur = 0;
  ctx.font = `${Math.floor(size * 0.34)}px serif`;
  ctx.fillStyle = '#fff';
  ctx.fillText(badge, -size * 0.28, -size * 0.28);
}

// 宝箱：木製の本体 + 金属ベルト + 鍵。中身レアリティに応じた金縁の輝きで
// 「これは普通の落ちアイテムではなく特別」と一目でわかるようにする。
function _drawChest(ctx, size) {
  const w = size * 0.6;
  const h = size * 0.45;
  const lidH = h * 0.45;
  // 本体
  const bodyG = ctx.createLinearGradient(0, 0, 0, h);
  bodyG.addColorStop(0, '#8b5a2b');
  bodyG.addColorStop(1, '#5a3a1a');
  ctx.fillStyle = bodyG;
  _roundRect(ctx, -w / 2, -h * 0.1, w, h, 4);
  ctx.fill();
  ctx.strokeStyle = '#3a2410';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // 蓋（半開き気味の遠近表現は省略してフラットに）
  const lidG = ctx.createLinearGradient(0, -h * 0.55, 0, -h * 0.1);
  lidG.addColorStop(0, '#a06b32');
  lidG.addColorStop(1, '#6b3f1a');
  ctx.fillStyle = lidG;
  _roundRect(ctx, -w / 2, -h * 0.55, w, lidH, 4);
  ctx.fill();
  ctx.strokeStyle = '#3a2410';
  ctx.stroke();
  // 金属ベルト
  ctx.fillStyle = '#caa15a';
  ctx.fillRect(-w / 2, -h * 0.18, w, 3);
  ctx.fillRect(-w / 2 + w * 0.46, -h * 0.55, 3, h);
  // 鍵（中央の南京錠）
  ctx.fillStyle = '#ffd54f';
  ctx.beginPath();
  ctx.arc(0, -h * 0.06, size * 0.05, 0, Math.PI * 2);
  ctx.fill();
  // 中央のキラリ（レジェンド時はもっと派手に。ここはレアリティ枠の glow に任せる）
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.beginPath();
  ctx.arc(-size * 0.02, -h * 0.09, size * 0.012, 0, Math.PI * 2);
  ctx.fill();
}

// 金貨の山。レアリティ枠の上にコインを 3 枚重ねた図案
function _drawGold(ctx, size) {
  ctx.shadowColor = 'rgba(255,213,79,0.7)';
  ctx.shadowBlur  = 10;
  for (const [ox, oy, r] of [
    [-size * 0.10,  size * 0.06, size * 0.18],
    [ size * 0.10,  size * 0.10, size * 0.18],
    [ 0,           -size * 0.10, size * 0.20],
  ]) {
    const g = ctx.createRadialGradient(ox - r * 0.4, oy - r * 0.4, 0, ox, oy, r);
    g.addColorStop(0, '#fff8c0');
    g.addColorStop(0.6, '#ffd54f');
    g.addColorStop(1, '#b8860b');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(ox, oy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

// MP 薬：通常薬と同じ瓶を青系で塗る簡易バリアント。
function _drawMpPotion(ctx, item, size, rng) {
  const baseName = (item.name ?? '');
  const big   = baseName.includes('大');
  const small = baseName.includes('小');
  const liquid = '#4dc4ff';
  const bw = (small ? 0.18 : big ? 0.30 : 0.24) * size;
  const bh = (small ? 0.25 : big ? 0.40 : 0.32) * size;
  ctx.fillStyle = '#cfd8dc';
  ctx.fillRect(-bw * 0.35, -bh - size * 0.13, bw * 0.7, size * 0.10);
  ctx.fillStyle = '#5a3a1f';
  ctx.fillRect(-bw * 0.30, -bh - size * 0.18, bw * 0.6, size * 0.07);
  ctx.fillStyle = 'rgba(220,235,245,0.55)';
  _roundRect(ctx, -bw, -bh, bw * 2, bh * 2, bw * 0.4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  _roundRectPath(ctx, -bw + 2, -bh + bh * 0.4, bw * 2 - 4, bh * 1.55, bw * 0.35);
  ctx.clip();
  ctx.fillStyle = liquid;
  ctx.fillRect(-bw, -bh + bh * 0.4, bw * 2, bh * 1.6);
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillRect(-bw + 4, -bh + bh * 0.42, bw * 0.5, 2);
  ctx.restore();
  // MP マーカー（青い星）
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.floor(size * 0.18)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('MP', 0, 0);
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
