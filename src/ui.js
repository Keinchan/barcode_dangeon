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
