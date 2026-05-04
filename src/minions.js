// ─────────────────────────────────────────────
// ミニオン（仲間）
//   - プレイヤーの後ろを追従しダンジョン内で共闘する NPC
//   - 名前は花から取る（ズラン = スズラン / ラナン = ラナンキュラス など）
//   - 戦闘・移動の AI は dungeon.js の tickMinions() に集約
//   - aptitudeElements: 主属性 + 副属性の 2〜3 個。覚えられる技を決める
// ─────────────────────────────────────────────

import { findSkillById, SKILLS_LIBRARY } from './items.js';

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
    aptitudeElements: ['光', '水'],     // 光主・水副
    starterSkillId:   'sweep',          // 初期所持技（コモン）
    desc:    '清楚な白花の精。光・水の技に適性。',
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
    aptitudeElements: ['火', '雷'],     // 火主・雷副
    starterSkillId:   'jab',            // 初期所持技（コモン）
    desc:    '幾重にも花弁を重ねた火の精。火・雷の技に適性。',
  },
];

export function findMinionTemplate(id) {
  return MINION_LIBRARY.find(t => t.id === id) ?? null;
}

// テンプレに紐付く初期技（コモン）。元素にマッチする最初のコモンを返す。
function _starterSkillFor(t) {
  if (t.starterSkillId) {
    const sk = findSkillById(t.starterSkillId);
    if (sk) return { ...sk };
  }
  // フォールバック: テンプレ属性のコモン技
  const fb = SKILLS_LIBRARY.find(s => s.rarity === 'コモン' && s.element === t.element)
          ?? SKILLS_LIBRARY.find(s => s.rarity === 'コモン');
  return fb ? { ...fb } : null;
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
  const starter = _starterSkillFor(t);
  return {
    id:      t.id,
    name:    t.name,
    emoji:   t.emoji,
    element: t.element,
    rarity:  t.rarity,
    aptitudeElements: t.aptitudeElements?.slice() ?? [t.element],
    level:   lv,
    atk,
    def,
    hp,
    maxHp:   hp,
    learnedSkills: starter ? [starter] : [],
    skillSlots:    starter ? [starter, null, null, null] : [null, null, null, null],
  };
}

// セーブ復元時の整合性チェック。古いセーブにテンプレートが消えた id があれば
// nullable で返す（呼び出し側で除外してもらう）。
export function rehydrateMinion(saved) {
  if (!saved || !saved.id) return null;
  const t = findMinionTemplate(saved.id);
  if (!t) return null;
  // 旧セーブ互換: 技フィールドが無ければスターターを 1 個入れる
  const starter = _starterSkillFor(t);
  const learned = Array.isArray(saved.learnedSkills) && saved.learnedSkills.length > 0
    ? saved.learnedSkills.map(s => ({ ...s }))
    : (starter ? [starter] : []);
  const slots = Array.isArray(saved.skillSlots) && saved.skillSlots.length === 4
    ? saved.skillSlots.map(s => (s ? { ...s } : null))
    : (starter ? [starter, null, null, null] : [null, null, null, null]);
  return {
    id:      t.id,
    name:    t.name,
    emoji:   t.emoji,
    element: t.element,
    rarity:  t.rarity,
    aptitudeElements: t.aptitudeElements?.slice() ?? [t.element],
    level:   saved.level ?? 1,
    atk:     saved.atk ?? t.baseAtk,
    def:     saved.def ?? t.baseDef,
    hp:      saved.hp ?? saved.maxHp ?? t.baseHp,
    maxHp:   saved.maxHp ?? t.baseHp,
    learnedSkills: learned,
    skillSlots:    slots,
  };
}
