// ─────────────────────────────────────────────
// オンライン対戦 (PvP) - Phase 1: 招待コード式 1v1 ターン制
// ─────────────────────────────────────────────
//   既存の Firebase Auth + Firestore 基盤に乗せる。新規コレクションは pvpRooms。
//   ドキュメント ID = 6 桁のロビーコード（数字 6 桁、ホストが生成）。
//
//   データ構造:
//     pvpRooms/{code} = {
//       state: 'waiting' | 'battle' | 'finished',
//       host: { uid, name, level, atk, def, maxHp, maxMp, hp, mp, ready },
//       guest: null | { ...同上 },
//       turn: 'host' | 'guest',     // 行動権を持つ側
//       turnNo: number,              // ターン番号（同期確認用）
//       actions: [                   // 単純な行動ログ（appendOnly）
//         { byUid, kind, dmg, hpAfter, ts }
//       ],
//       winnerUid: string | null,
//       createdAt: serverTimestamp,
//     }
//
//   ホストとゲストは onSnapshot で同じ document を購読し、相手の行動を
//   ローカルで再生する。決定論性は重視せず（同期前提）、サーバ側ジャッジは無し。
//   不正対策は将来的に Cloud Functions に判定を寄せる前提（現状はクライアント信頼）。
// ─────────────────────────────────────────────

import {
  getFirestore,
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
  arrayUnion,
  deleteDoc,
} from 'firebase/firestore';
import { initializeApp, getApps } from 'firebase/app';
import { firebaseConfig, isConfigured } from './firebase-config.js';

let _db = null;
function _getDb() {
  if (_db) return _db;
  if (!isConfigured) return null;
  // save.js が既に initializeApp している可能性があるので getApps で確認。
  const app = getApps()[0] ?? initializeApp(firebaseConfig);
  _db = getFirestore(app);
  return _db;
}

const ROOMS = 'pvpRooms';

// 6 桁のロビーコード（先頭 0 OK）。衝突は再試行で吸収する。
function _genCode() {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

// プレイヤーオブジェクトから「対戦に必要な情報だけ」を抜き出す。
// 装備の中身など重いフィールドを送ると Firestore のドキュメントサイズ上限に
// 当たるので、ステータスとレア度ぐらいに絞る。
//
// 1 ルームアリーナ（21x19）。host/guest のスタート座標と装備設定はモード次第:
//   pvp  current → host=下中央, guest=上中央, 武器/防具属性あり
//   pvp  set     → 同上、装備属性は無効（ATK/DEF も均等化された preset 値）
//   coop         → host=下左, guest=下右（横並び）、装備は current 装備
const ARENA_W = 21;
const ARENA_H = 19;

// セット装備（PvP の公平戦用）。装備差を均すため固定値で補正する。
// 自分の atkBase / defBase に preset の bonus を足した値を atk/def として送る。
const PVP_SET_PRESET = { atkBonus: 25, defBonus: 15 };

// 初期座標を mode + role から決定する純粋関数。
function _arenaStartPos(mode, role) {
  const cx = Math.floor(ARENA_W / 2);
  if (mode === 'coop') {
    // 協力: 両者下端に横並び（ボスは上方 y=9 付近）
    return role === 'host'
      ? { x: cx - 2, y: ARENA_H - 5, facing: [0, -1] }
      : { x: cx + 2, y: ARENA_H - 5, facing: [0, -1] };
  }
  // 対戦: ホスト下、ゲスト上で向き合う
  return role === 'host'
    ? { x: cx, y: ARENA_H - 5, facing: [0, -1] }
    : { x: cx, y: 4,           facing: [0,  1] };
}

// 装備フォーマット (set/current) に応じて atk/def/element を導出する。
function _applyEquipFormat(player, equipFormat) {
  if (equipFormat === 'set') {
    // 公平戦: ベース + preset bonus、装備属性は無効
    return {
      atk:           (player.atkBase ?? player.atk ?? 0) + PVP_SET_PRESET.atkBonus,
      def:           (player.defBase ?? player.def ?? 0) + PVP_SET_PRESET.defBonus,
      weaponName:    'セット武器',
      weaponElement: null,
      armorName:     'セット防具',
      armorElement:  null,
    };
  }
  // current: 持ち物の装備をそのまま
  return {
    atk:           player.atk ?? 0,
    def:           player.def ?? 0,
    weaponName:    player.weapon?.name ?? null,
    weaponElement: player.weapon?.element ?? null,
    armorName:     player.armor?.name ?? null,
    armorElement:  player.armor?.element ?? null,
  };
}

export function buildPvpProfile(uid, displayName, player, role, opts = {}) {
  const mode        = opts.mode === 'coop' ? 'coop' : 'pvp';
  const equipFormat = opts.equipFormat === 'set' ? 'set' : 'current';
  const startPos    = _arenaStartPos(mode, role);
  const equip       = _applyEquipFormat(player, mode === 'pvp' ? equipFormat : 'current');
  return {
    uid,
    role,                    // 'host' | 'guest' — 自分の役割を埋め込んで再描画しやすくする
    name:    (displayName || 'プレイヤー').slice(0, 20),
    level:   player.level ?? 1,
    atk:     equip.atk,
    def:     equip.def,
    maxHp:   player.maxHp ?? 1,
    maxMp:   player.maxMp ?? 0,
    hp:      player.maxHp ?? 1,    // バトル開始時は満タン
    mp:      player.maxMp ?? 0,
    weaponName:    equip.weaponName,
    weaponElement: equip.weaponElement,
    armorName:     equip.armorName,
    armorElement:  equip.armorElement,
    emoji:         player.emoji ?? '🧙',
    x:             startPos.x,
    y:             startPos.y,
    facing:        startPos.facing,
    statuses:      [],
    ready:         false,
  };
}

// 協力モード用のボス候補リスト。ロビーでホストが選択してメンバーに同期する。
// id をキーに Firestore へ書き込み、両クライアントが同じスペックでアリーナを組む。
export const COOP_BOSSES = [
  { id: 'fire-drake',   name: '🔥 火竜',       emoji: '🐉', element: '火', hp: 280, maxHp: 280, atk: 16, def: 6  },
  { id: 'water-spirit', name: '💧 水妖',       emoji: '🐳', element: '水', hp: 360, maxHp: 360, atk:  9, def: 12 },
  { id: 'thunder-lord', name: '⚡ 雷神',       emoji: '⚡', element: '雷', hp: 300, maxHp: 300, atk: 14, def:  8 },
  { id: 'earth-titan',  name: '🪨 大地の巨人', emoji: '🗿', element: '草', hp: 420, maxHp: 420, atk: 11, def: 10 },
  { id: 'shadow-king',  name: '🌑 影の王',     emoji: '👤', element: '闇', hp: 260, maxHp: 260, atk: 18, def:  5 },
  { id: 'angel',        name: '✨ 天使',       emoji: '😇', element: '光', hp: 320, maxHp: 320, atk: 13, def:  9 },
];

function _bossSpecById(id) {
  return COOP_BOSSES.find(b => b.id === id) ?? COOP_BOSSES[0];
}

// 協力モード用のボス NPC 初期スペック。Lobby でホストが選んだ id から組み立てる。
// id 未指定なら先頭のボス（火竜）。アリーナ中央上方に配置。
//
// 第 2 引数の customSpec が指定されている場合、ID マッチではなく完全カスタム
// （ダンジョン由来のボス）として組み立てる。これにより「マップ上の任意ダンジョン
// のボスをマルチ協力で討伐する」フローが、既存の協力ボス機構の上に乗っかる。
function _buildInitialCoopBoss(bossId, customSpec = null) {
  const spec = customSpec ?? _bossSpecById(bossId);
  return {
    bossId:  spec.id ?? bossId ?? 'custom',
    name:    spec.name,
    emoji:   spec.emoji,
    element: spec.element,
    hp:      spec.hp,
    maxHp:   spec.maxHp,
    atk:     spec.atk,
    def:     spec.def,
    x:       Math.floor(ARENA_W / 2),
    y:       9,
    // 任意の出自タグ（ダンジョン由来なら 'dungeon-coop'）。再戦時のリセット用。
    source:  spec.source ?? null,
    dungeonName: spec.dungeonName ?? null,
  };
}

// ホストが部屋のモード（pvp/coop）を waiting 中に切り替える。
//   - 関連フィールド（boss / pvpFormat / 両者の位置・装備値）を一括で更新
//   - ready フラグはリセットして「準備し直し」にする
//   - state==='waiting' でなければ何もしない
export async function setRoomMode(code, newMode, opts = {}) {
  const db = _getDb();
  if (!db) return;
  const ref  = doc(db, ROOMS, code);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data();
  if (data.state !== 'waiting') return;
  const mode = newMode === 'coop' ? 'coop' : 'pvp';
  const updates = { mode };
  // 開始位置: 既存プロファイルから x/y/facing だけ書き換え
  const hostPos = _arenaStartPos(mode, 'host');
  updates['host.x']      = hostPos.x;
  updates['host.y']      = hostPos.y;
  updates['host.facing'] = hostPos.facing;
  updates['host.ready']  = false;
  if (data.guest) {
    const guestPos = _arenaStartPos(mode, 'guest');
    updates['guest.x']      = guestPos.x;
    updates['guest.y']      = guestPos.y;
    updates['guest.facing'] = guestPos.facing;
    updates['guest.ready']  = false;
  }
  if (mode === 'coop') {
    // ボスを初期化（指定があればそれを使う）
    updates.boss      = _buildInitialCoopBoss(opts.bossId ?? data.bossId);
    updates.pvpFormat = null;
  } else {
    updates.boss      = null;
    // 装備フォーマットを保持（指定があれば更新、無ければ既存値、無ければ default 'current'）
    updates.pvpFormat = opts.pvpFormat ?? data.pvpFormat ?? 'current';
  }
  await updateDoc(ref, updates);
}

// ホストが PvP の装備フォーマットを切り替える。pvp モード時のみ意味がある。
export async function setRoomPvpFormat(code, format) {
  const db = _getDb();
  if (!db) return;
  const ref  = doc(db, ROOMS, code);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data();
  if (data.state !== 'waiting' || data.mode !== 'pvp') return;
  const newFormat = format === 'set' ? 'set' : 'current';
  await updateDoc(ref, { pvpFormat: newFormat });
}

// ホストが協力ボスを切り替える。coop モード時のみ意味がある。
export async function setRoomBoss(code, bossId) {
  const db = _getDb();
  if (!db) return;
  const ref  = doc(db, ROOMS, code);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data();
  if (data.state !== 'waiting' || data.mode !== 'coop') return;
  await updateDoc(ref, { boss: _buildInitialCoopBoss(bossId) });
}

// ホスト: 部屋を作って code を返す。コリジョン時は最大 5 回まで再試行。
//   opts.mode       = 'pvp' | 'coop'   デフォルト 'pvp'
//   opts.pvpFormat  = 'current' | 'set' （pvp 時のみ。デフォルト 'current'）
//   opts.bossId     = COOP_BOSSES[i].id （coop 時のみ。デフォルト先頭）
//   opts.customBoss = { name, emoji, element, hp, maxHp, atk, def, dungeonName? }
//                     （coop 時、ダンジョン由来の動的ボスを直接指定する場合）
export async function createRoom(profile, opts = {}) {
  const db = _getDb();
  if (!db) throw new Error('Firestore 未初期化');
  const mode       = opts.mode === 'coop' ? 'coop' : 'pvp';
  const pvpFormat  = opts.pvpFormat === 'set' ? 'set' : 'current';
  const initialBoss = mode === 'coop'
    ? _buildInitialCoopBoss(opts.bossId, opts.customBoss ?? null)
    : null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = _genCode();
    const ref  = doc(db, ROOMS, code);
    const snap = await getDoc(ref);
    if (snap.exists()) continue;          // 既存コードならやり直し
    await setDoc(ref, {
      state:     'waiting',
      mode,
      pvpFormat: mode === 'pvp' ? pvpFormat : null,
      host:      profile,
      guest:     null,
      turn:      'host',
      turnNo:    0,
      actions:   [],
      winnerUid: null,
      cause:     null,                    // 'bossKilled' | 'playerDied' | null
      boss:      initialBoss,
      createdAt: serverTimestamp(),
    });
    return code;
  }
  throw new Error('部屋コードの確保に失敗（しばらくしてから再試行）');
}

// ゲスト: 既存部屋に参加。waiting 状態でなければエラー。
// 部屋のモード/装備フォーマットに合わせて profile の x/y/atk/def 等を再計算する
// ため、ゲスト側は player スナップショットも opts で渡してもらう。
export async function joinRoom(code, profile, opts = {}) {
  const db = _getDb();
  if (!db) throw new Error('Firestore 未初期化');
  const ref  = doc(db, ROOMS, code);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('部屋が見つかりません');
  const data = snap.data();
  if (data.state !== 'waiting') throw new Error('この部屋には参加できません（既に開始 or 終了）');
  if (data.host?.uid === profile.uid) throw new Error('自分の部屋には参加できません');
  // 部屋のモード・装備フォーマットに合わせて開始位置と装備を上書き
  const startPos = _arenaStartPos(data.mode ?? 'pvp', 'guest');
  let finalProfile = { ...profile, ...startPos, role: 'guest' };
  if (opts.player && data.mode === 'pvp') {
    const equip = _applyEquipFormat(opts.player, data.pvpFormat ?? 'current');
    finalProfile = {
      ...finalProfile,
      atk:           equip.atk,
      def:           equip.def,
      weaponName:    equip.weaponName,
      weaponElement: equip.weaponElement,
      armorName:     equip.armorName,
      armorElement:  equip.armorElement,
    };
  }
  await updateDoc(ref, {
    guest: finalProfile,
  });
  return code;
}

// 部屋の購読。cb({ data }) を呼び出す。戻り値は unsubscribe 関数。
export function watchRoom(code, cb) {
  const db = _getDb();
  if (!db) return () => {};
  const ref = doc(db, ROOMS, code);
  return onSnapshot(ref, snap => {
    if (!snap.exists()) cb(null);
    else cb(snap.data());
  });
}

// 「準備 OK」を立てる。両者 ready で battle へ遷移する判定はクライアント側で行う。
export async function setReady(code, role, value) {
  const db = _getDb();
  if (!db) return;
  const ref = doc(db, ROOMS, code);
  const field = role === 'host' ? 'host.ready' : 'guest.ready';
  await updateDoc(ref, { [field]: !!value });
}

// 両者 ready が揃った時にホストが呼んで state を battle に切り替える。
export async function startBattle(code) {
  const db = _getDb();
  if (!db) return;
  await updateDoc(doc(db, ROOMS, code), {
    state:  'battle',
    turn:   'host',
    turnNo: 1,
  });
}

// 行動を提出（攻撃 / 防御 / 逃走）。結果（与ダメ・残 HP）はクライアント側で計算済み。
//   args = { kind: 'attack'|'defend'|'flee'|'skill', byUid, byRole,
//            dmg, hpAfter, mpAfter, msg }
// updateDoc + arrayUnion で actions に追加し、相手側の HP も上書きする。
export async function submitAction(code, args) {
  const db = _getDb();
  if (!db) return;
  const ref = doc(db, ROOMS, code);
  const updates = {
    actions: arrayUnion({
      byUid:   args.byUid,
      byRole:  args.byRole,           // 'host' or 'guest'
      kind:    args.kind,
      dmg:     args.dmg ?? 0,
      hpAfter: args.hpAfter ?? null,  // 「対象側」の HP（攻撃なら相手、防御なら自分）
      mpAfter: args.mpAfter ?? null,
      msg:     args.msg ?? '',
      ts:      Date.now(),
    }),
    turn:   args.byRole === 'host' ? 'guest' : 'host',
    turnNo: (args.turnNo ?? 0) + 1,
  };
  // 攻撃の場合は相手側の HP/MP を反映
  if (args.kind === 'attack' || args.kind === 'skill') {
    const targetField = args.byRole === 'host' ? 'guest.hp' : 'host.hp';
    updates[targetField] = Math.max(0, args.hpAfter ?? 0);
    if (args.attackerHp != null) {
      const selfField = args.byRole === 'host' ? 'host.hp' : 'guest.hp';
      updates[selfField] = args.attackerHp;
    }
    if (args.attackerMp != null) {
      const selfMpField = args.byRole === 'host' ? 'host.mp' : 'guest.mp';
      updates[selfMpField] = args.attackerMp;
    }
  }
  // 勝敗判定
  if ((args.hpAfter ?? 1) <= 0) {
    updates.state     = 'finished';
    updates.winnerUid = args.byUid;
  }
  if (args.kind === 'flee') {
    updates.state     = 'finished';
    // 逃走側は敗北扱い（相手が勝者）
    updates.winnerUid = args.byRole === 'host'
      ? (args.guestUid ?? null)
      : (args.hostUid  ?? null);
  }
  await updateDoc(ref, updates);
}

// アリーナでの「移動」アクション。自身の x/y/facing を更新し、ターンを相手に渡す。
//   role: 'host' | 'guest'
//   pos:  { x, y, facing }
export async function submitMove(code, role, pos, turnNo) {
  const db = _getDb();
  if (!db) return;
  const ref = doc(db, ROOMS, code);
  const updates = {
    [`${role}.x`]:      pos.x,
    [`${role}.y`]:      pos.y,
    [`${role}.facing`]: pos.facing,
    turn:   role === 'host' ? 'guest' : 'host',
    turnNo: (turnNo ?? 0) + 1,
  };
  await updateDoc(ref, updates);
}

// アリーナでの「攻撃」アクション。相手の HP/MP/statuses を更新し、ターンを相手に渡す。
// 結果（hpAfter / mpAfter / 状態異常付与）はクライアント側で計算済の前提。HP0 なら state 終了。
export async function submitArenaAttack(code, role, args) {
  const db = _getDb();
  if (!db) return;
  const ref = doc(db, ROOMS, code);
  const otherRole = role === 'host' ? 'guest' : 'host';
  const updates = {
    [`${otherRole}.hp`]: Math.max(0, args.targetHpAfter ?? 0),
    actions: arrayUnion({
      byRole: role,
      kind:   args.kind ?? 'attack',
      dmg:    args.dmg ?? 0,
      ts:     Date.now(),
    }),
    turn:   otherRole,
    turnNo: (args.turnNo ?? 0) + 1,
  };
  if (args.attackerMpAfter != null) {
    updates[`${role}.mp`] = args.attackerMpAfter;
  }
  // 攻撃側の atk/def/statuses が変動した場合（バフ込みダメージ計算ベースを共有する用途）
  if (Array.isArray(args.attackerStatuses)) {
    updates[`${role}.statuses`] = args.attackerStatuses;
  }
  if (typeof args.attackerAtk === 'number') updates[`${role}.atk`] = args.attackerAtk;
  if (typeof args.attackerDef === 'number') updates[`${role}.def`] = args.attackerDef;
  // 攻撃で相手に状態異常を付与した場合は statuses 配列ごと更新
  if (Array.isArray(args.targetStatuses)) {
    updates[`${otherRole}.statuses`] = args.targetStatuses;
  }
  if ((args.targetHpAfter ?? 1) <= 0) {
    updates.state     = 'finished';
    updates.winnerUid = args.attackerUid ?? null;
  }
  await updateDoc(ref, updates);
}

// 自分の状態（HP/MP/atk/def/statuses）だけを更新（攻撃を伴わない自己バフ・状態異常 tick）。
// hp が 0 以下になった場合は state=finished で相手を勝者にする。
export async function submitOwnState(code, role, args) {
  const db = _getDb();
  if (!db) return;
  const ref = doc(db, ROOMS, code);
  const updates = {};
  if (typeof args.hp === 'number')        updates[`${role}.hp`]       = Math.max(0, args.hp);
  if (typeof args.mp === 'number')        updates[`${role}.mp`]       = Math.max(0, args.mp);
  if (typeof args.atk === 'number')       updates[`${role}.atk`]      = args.atk;
  if (typeof args.def === 'number')       updates[`${role}.def`]      = args.def;
  if (Array.isArray(args.statuses))       updates[`${role}.statuses`] = args.statuses;
  if (typeof args.x === 'number')         updates[`${role}.x`]        = args.x;
  if (typeof args.y === 'number')         updates[`${role}.y`]        = args.y;
  if (Array.isArray(args.facing))         updates[`${role}.facing`]   = args.facing;
  // 状態異常等で HP 0 になった場合は相手勝利
  if (typeof args.hp === 'number' && args.hp <= 0 && args.otherUid) {
    updates.state     = 'finished';
    updates.winnerUid = args.otherUid;
  }
  // ターン交代も一緒に行う場合（自己バフ系の SELF 技で「ターン消費した」扱いにする等）
  if (args.flipTurn) {
    updates.turn   = role === 'host' ? 'guest' : 'host';
    updates.turnNo = (args.turnNo ?? 0) + 1;
  }
  if (Object.keys(updates).length === 0) return;
  await updateDoc(ref, updates);
}

// 勝敗確定後の「再戦準備」: 部屋の state を waiting に戻し、両者の HP/MP/statuses
// を満タンに戻す。位置・向き・ready フラグも初期化。両方のクライアントが
// 結果ダイアログ OK 後に呼ぶ前提だが、idempotent（同じ値で last-write-wins）なので
// 競合しても安全。state が既に waiting / battle / null ならスキップする。
export async function resetForRematch(code) {
  const db = _getDb();
  if (!db) return;
  const ref  = doc(db, ROOMS, code);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data();
  if (data.state !== 'finished') return;     // 既にリセット済 / 進行中ならスキップ
  const host  = data.host;
  const guest = data.guest;
  if (!host) return;
  // 開始位置はモードに応じて決定（協力なら横並び、対戦なら向かい合う）
  const hostPos = _arenaStartPos(data.mode === 'coop' ? 'coop' : 'pvp', 'host');
  const updates = {
    state:     'waiting',
    turn:      'host',
    turnNo:    0,
    actions:   [],
    winnerUid: null,
    cause:     null,
    'host.hp':       host.maxHp ?? host.hp ?? 1,
    'host.mp':       host.maxMp ?? 0,
    'host.statuses': [],
    'host.x':        hostPos.x,
    'host.y':        hostPos.y,
    'host.facing':   hostPos.facing,
    'host.ready':    false,
  };
  if (guest) {
    const guestPos = _arenaStartPos(data.mode === 'coop' ? 'coop' : 'pvp', 'guest');
    updates['guest.hp']       = guest.maxHp ?? guest.hp ?? 1;
    updates['guest.mp']       = guest.maxMp ?? 0;
    updates['guest.statuses'] = [];
    updates['guest.x']        = guestPos.x;
    updates['guest.y']        = guestPos.y;
    updates['guest.facing']   = guestPos.facing;
    updates['guest.ready']    = false;
  }
  // 協力モードならボスも HP/位置をリセットして再戦可能にする（同じ id を維持）
  if (data.mode === 'coop') {
    updates.boss = _buildInitialCoopBoss(data.boss?.bossId);
  }
  await updateDoc(ref, updates);
}

// 協力モード: ボスの HP / 位置 を更新する。プレイヤーがボスを攻撃した結果や
// ホストがボス AI を進めた時に使う。HP が 0 以下なら state=finished + cause=bossKilled。
//   args.counter = { role, hpAfter, dmg } を渡すと、攻撃したプレイヤーへの反撃を
//   同じ書き込みでまとめて適用する（ボス HP 更新 + プレイヤー HP 減少 + ターン交代）。
//   反撃でプレイヤーが HP 0 になったら cause=playerDied で state を終了させる。
export async function submitBossUpdate(code, args) {
  const db = _getDb();
  if (!db) return;
  const ref = doc(db, ROOMS, code);
  const updates = {};
  if (typeof args.hp === 'number') updates['boss.hp'] = Math.max(0, args.hp);
  if (typeof args.x  === 'number') updates['boss.x']  = args.x;
  if (typeof args.y  === 'number') updates['boss.y']  = args.y;
  // ターン交代を一緒に行う場合
  if (args.flipTurn) {
    updates.turn   = args.nextTurn ?? 'host';
    updates.turnNo = (args.turnNo ?? 0) + 1;
  }
  // 反撃: 攻撃したプレイヤーの HP を更新
  if (args.counter && args.counter.role) {
    updates[`${args.counter.role}.hp`] = Math.max(0, args.counter.hpAfter ?? 0);
  }
  // ボス撃破でクリア
  if (typeof args.hp === 'number' && args.hp <= 0) {
    updates.state = 'finished';
    updates.cause = 'bossKilled';
    // 協力勝利は両者勝者扱い: winnerUid を 'coop' のセンチネルにする
    updates.winnerUid = 'coop';
  } else if (args.counter && args.counter.hpAfter <= 0) {
    // 反撃でプレイヤーが死亡 → 全滅扱い（協力モードでは個別の勝者は無し）
    updates.state = 'finished';
    updates.cause = 'playerDied';
    updates.winnerUid = null;
  }
  if (Object.keys(updates).length === 0) return;
  await updateDoc(ref, updates);
}

// ハートビート（接続生存通知）。長期間更新が無ければ「相手が落ちた」とみなす。
// 値は serverTimestamp で書き込むため、両クライアントの時計ズレに強い。
export async function pingHeartbeat(code, role) {
  const db = _getDb();
  if (!db) return;
  const ref = doc(db, ROOMS, code);
  await updateDoc(ref, { [`${role}.lastSeen`]: serverTimestamp() }).catch(() => {});
}

// 逃走: 相手勝利確定で state=finished
export async function submitFlee(code, role, otherUid) {
  const db = _getDb();
  if (!db) return;
  await updateDoc(doc(db, ROOMS, code), {
    state:     'finished',
    winnerUid: otherUid ?? null,
    actions:   arrayUnion({ byRole: role, kind: 'flee', ts: Date.now() }),
  });
}

// ホストがゲストへ手動で権限を譲渡する。waiting 状態でのみ意味がある操作。
//   - swap: 旧ゲストが新ホストに、旧ホストが新ゲストになる
//   - 両者の role / 位置 / 向きも入れ替える（host=下, guest=上 のレイアウト維持）
//   - ready フラグはリセット（譲渡後に改めて準備し直す）
export async function transferHost(code) {
  const db = _getDb();
  if (!db) return;
  const ref  = doc(db, ROOMS, code);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data();
  if (!data.guest) throw new Error('参加者がいないので譲渡できません');
  const mode = data.mode === 'coop' ? 'coop' : 'pvp';
  const hostPos  = _arenaStartPos(mode, 'host');
  const guestPos = _arenaStartPos(mode, 'guest');
  // 新ホスト = 旧ゲスト / 新ゲスト = 旧ホスト
  const newHost  = { ...data.guest, role: 'host',  ...hostPos,  ready: false };
  const newGuest = { ...data.host,  role: 'guest', ...guestPos, ready: false };
  await updateDoc(ref, { host: newHost, guest: newGuest });
}

// ホスト本人がアプリを離脱した時の自動処理:
//   - waiting 状態 + ゲストあり → ゲストを新ホストに昇格、guest を空にする
//   - waiting 状態 + ゲストなし → 部屋を削除
//   - battle 状態 → ゲストの勝利として state=finished
//   - finished 状態 → 何もしない（呼び出し側が 30s 遅延 destroy を担当）
export async function handleHostLeave(code) {
  const db = _getDb();
  if (!db) return;
  const ref  = doc(db, ROOMS, code);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data();
  if (data.state === 'waiting') {
    if (data.guest) {
      const hostPos = _arenaStartPos(data.mode === 'coop' ? 'coop' : 'pvp', 'host');
      const promoted = {
        ...data.guest,
        role:   'host',
        ...hostPos,
        ready:  false,
      };
      await updateDoc(ref, { host: promoted, guest: null });
    } else {
      await deleteDoc(ref);
    }
  } else if (data.state === 'battle' && data.guest) {
    // 戦闘中の離脱はゲストの不戦勝
    await updateDoc(ref, {
      state:     'finished',
      winnerUid: data.guest.uid,
      cause:     'hostLeft',
    });
  } else {
    // 想定外の状態（or finished）は何もせず、呼び出し側に任せる
  }
}

// ゲストが離脱した時の自動処理: guest フィールドを null にして、ホストが
// 待機画面に戻ったように見せる。
//   - waiting → guest を null にして待機画面に戻す
//   - battle  → ホストの不戦勝で finished に
//   - finished → guest を null（既に勝敗確定後の退室。これが無いとゲストが
//     部屋に残ったまま雪だるま式に増えるバグになっていた）
export async function handleGuestLeave(code) {
  const db = _getDb();
  if (!db) return;
  const ref  = doc(db, ROOMS, code);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data();
  if (data.state === 'battle' && data.host) {
    await updateDoc(ref, {
      state:     'finished',
      winnerUid: data.host.uid,
      cause:     'guestLeft',
    });
  } else if (data.state === 'waiting' || data.state === 'finished') {
    await updateDoc(ref, { guest: null });
  }
}

// 部屋を完全に削除（戦闘終了後の掃除）。ホスト権限のみ。
export async function destroyRoom(code) {
  const db = _getDb();
  if (!db) return;
  try {
    await deleteDoc(doc(db, ROOMS, code));
  } catch (err) {
    console.warn('destroyRoom failed:', err?.message);
  }
}
