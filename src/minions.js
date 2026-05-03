// ─────────────────────────────────────────────
// ミニオン（仲間）
//   - プレイヤーの後ろを追従しダンジョン内で共闘する NPC
//   - 名前は花から取る（ズラン = スズラン / ラナン = ラナンキュラス など）
//   - 戦闘・移動の AI は dungeon.js の tickMinions() に集約
//   - v1 はダメージを受けない設計（壁役にはならないが強力すぎないように
//     攻撃力を控えめにする）。HP/死亡判定は今後の拡張余地として残す。
// ─────────────────────────────────────────────

// ミニオンの種別テンプレート。recruit 時にこの id を player.minions に積む。
// レアリティに応じた攻撃倍率の差で「強い仲間ほど稀」になるよう設計。
export const MINION_LIBRARY = [
  {
    id:      'suzuran',
    name:    'ズラン',
    fullName:'スズラン',
    emoji:   '🌼',
    element: '光',
    rarity:  'レア',
    baseAtk: 7,
    baseDef: 2,
    baseHp:  20,
    desc:    '清楚な白花の精。光属性の小柄な仲間。',
  },
  {
    id:      'ranan',
    name:    'ラナン',
    fullName:'ラナンキュラス',
    emoji:   '🌺',
    element: '火',
    rarity:  'エピック',
    baseAtk: 11,
    baseDef: 3,
    baseHp:  28,
    desc:    '幾重にも花弁を重ねた火の精。攻撃的に立ち回る。',
  },
];

export function findMinionTemplate(id) {
  return MINION_LIBRARY.find(t => t.id === id) ?? null;
}

// 仲間としてプレイヤー所有に加えるためのインスタンスを作成。
//   level: ミニオンレベル（1 から）。レベルで攻撃・HP がスケールする。
export function makeMinion(id, level = 1) {
  const t = findMinionTemplate(id);
  if (!t) return null;
  const lv  = Math.max(1, Math.floor(level));
  const atk = t.baseAtk + Math.floor((lv - 1) * 1.5);
  const def = t.baseDef + Math.floor((lv - 1) * 0.7);
  const hp  = t.baseHp  + (lv - 1) * 4;
  return {
    id:      t.id,
    name:    t.name,
    emoji:   t.emoji,
    element: t.element,
    rarity:  t.rarity,
    level:   lv,
    atk,
    def,
    hp,
    maxHp:   hp,
  };
}

// セーブ復元時の整合性チェック。古いセーブにテンプレートが消えた id があれば
// nullable で返す（呼び出し側で除外してもらう）。
export function rehydrateMinion(saved) {
  if (!saved || !saved.id) return null;
  const t = findMinionTemplate(saved.id);
  if (!t) return null;
  return {
    id:      t.id,
    name:    t.name,
    emoji:   t.emoji,
    element: t.element,
    rarity:  t.rarity,
    level:   saved.level ?? 1,
    atk:     saved.atk ?? t.baseAtk,
    def:     saved.def ?? t.baseDef,
    hp:      saved.hp ?? saved.maxHp ?? t.baseHp,
    maxHp:   saved.maxHp ?? t.baseHp,
  };
}
