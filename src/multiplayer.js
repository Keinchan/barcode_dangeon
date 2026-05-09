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
// 1 ルームアリーナ（21x19）で host=下中央 / guest=上中央スタートにするので
// 初期座標もここで決め打ちで載せる。実際のセル数は dungeon.js の W/H と一致させる。
const ARENA_W = 21;
const ARENA_H = 19;
export function buildPvpProfile(uid, displayName, player, role) {
  const cx = Math.floor(ARENA_W / 2);
  const isHost = role === 'host';
  return {
    uid,
    role,                    // 'host' | 'guest' — 自分の役割を埋め込んで再描画しやすくする
    name:    (displayName || 'プレイヤー').slice(0, 20),
    level:   player.level ?? 1,
    atk:     player.atk ?? 0,
    def:     player.def ?? 0,
    maxHp:   player.maxHp ?? 1,
    maxMp:   player.maxMp ?? 0,
    hp:      player.maxHp ?? 1,    // バトル開始時は満タン
    mp:      player.maxMp ?? 0,
    weaponName:    player.weapon?.name ?? null,
    weaponElement: player.weapon?.element ?? null,
    armorName:     player.armor?.name ?? null,
    armorElement:  player.armor?.element ?? null,
    emoji:         player.emoji ?? '🧙',
    // アリーナ内の初期位置: ホストは下、ゲストは上。互いに距離をとってスタート。
    x:       cx,
    y:       isHost ? (ARENA_H - 5) : 4,
    facing:  isHost ? [0, -1] : [0, 1],
    ready:   false,
  };
}

// ホスト: 部屋を作って code を返す。コリジョン時は最大 5 回まで再試行。
export async function createRoom(profile) {
  const db = _getDb();
  if (!db) throw new Error('Firestore 未初期化');
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = _genCode();
    const ref  = doc(db, ROOMS, code);
    const snap = await getDoc(ref);
    if (snap.exists()) continue;          // 既存コードならやり直し
    await setDoc(ref, {
      state:     'waiting',
      host:      profile,
      guest:     null,
      turn:      'host',
      turnNo:    0,
      actions:   [],
      winnerUid: null,
      createdAt: serverTimestamp(),
    });
    return code;
  }
  throw new Error('部屋コードの確保に失敗（しばらくしてから再試行）');
}

// ゲスト: 既存部屋に参加。waiting 状態でなければエラー。
export async function joinRoom(code, profile) {
  const db = _getDb();
  if (!db) throw new Error('Firestore 未初期化');
  const ref  = doc(db, ROOMS, code);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('部屋が見つかりません');
  const data = snap.data();
  if (data.state !== 'waiting') throw new Error('この部屋には参加できません（既に開始 or 終了）');
  if (data.host?.uid === profile.uid) throw new Error('自分の部屋には参加できません');
  await updateDoc(ref, {
    guest: profile,
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

// アリーナでの「攻撃」アクション。相手の HP/MP を更新し、ターンを相手に渡す。
// 結果（hpAfter / mpAfter）はクライアント側で計算済の前提。HP0 なら state 終了。
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
  if ((args.targetHpAfter ?? 1) <= 0) {
    updates.state     = 'finished';
    updates.winnerUid = args.attackerUid ?? null;
  }
  await updateDoc(ref, updates);
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
