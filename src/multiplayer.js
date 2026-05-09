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
export function buildPvpProfile(uid, displayName, player) {
  return {
    uid,
    name:    (displayName || 'プレイヤー').slice(0, 20),
    level:   player.level ?? 1,
    atk:     player.atk ?? 0,
    def:     player.def ?? 0,
    maxHp:   player.maxHp ?? 1,
    maxMp:   player.maxMp ?? 0,
    hp:      player.maxHp ?? 1,    // バトル開始時は満タン
    mp:      player.maxMp ?? 0,
    weaponName: player.weapon?.name ?? null,
    weaponElement: player.weapon?.element ?? null,
    armorName:  player.armor?.name ?? null,
    armorElement: player.armor?.element ?? null,
    ready: false,
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
