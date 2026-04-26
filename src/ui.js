// プレイヤー頭上にダメージをフロート表示（canvas中央＝プレイヤーアイコン）
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
