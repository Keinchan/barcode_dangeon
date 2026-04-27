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
