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
    statuses: [],            // 罹患中の状態異常 / バフを 1 配列で管理（PvP同期）
    ready:   false,
  };
}

// 協力モード用のボス NPC 初期スペック。プレイヤーの平均レベル想定で固定値。
// Phase 3 の MVP では 1 体の固定ボスのみ。レベル別調整は将来。
function _buildInitialCoopBoss() {
  return {
    name:    '🐉 古竜',
    emoji:   '🐉',
    element: '火',
    hp:      300,
    maxHp:   300,
    atk:     14,
    def:     6,
    x:       Math.floor(ARENA_W / 2),
    y:       9,                          // アリーナ中央付近
  };
}

// ホスト: 部屋を作って code を返す。コリジョン時は最大 5 回まで再試行。
//   opts.mode = 'pvp' | 'coop'  デフォルト 'pvp'
export async function createRoom(profile, opts = {}) {
  const db = _getDb();
  if (!db) throw new Error('Firestore 未初期化');
  const mode = opts.mode === 'coop' ? 'coop' : 'pvp';
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = _genCode();
    const ref  = doc(db, ROOMS, code);
    const snap = await getDoc(ref);
    if (snap.exists()) continue;          // 既存コードならやり直し
    await setDoc(ref, {
      state:     'waiting',
      mode,
      host:      profile,
      guest:     null,
      turn:      'host',
      turnNo:    0,
      actions:   [],
      winnerUid: null,
      cause:     null,                    // 'bossKilled' | 'playerDied' | null
      boss:      mode === 'coop' ? _buildInitialCoopBoss() : null,
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
  const cx = Math.floor(ARENA_W / 2);
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
    'host.x':        cx,
    'host.y':        ARENA_H - 5,
    'host.facing':   [0, -1],
    'host.ready':    false,
  };
  if (guest) {
    updates['guest.hp']       = guest.maxHp ?? guest.hp ?? 1;
    updates['guest.mp']       = guest.maxMp ?? 0;
    updates['guest.statuses'] = [];
    updates['guest.x']        = cx;
    updates['guest.y']        = 4;
    updates['guest.facing']   = [0, 1];
    updates['guest.ready']    = false;
  }
  // 協力モードならボスも HP/位置をリセットして再戦可能にする
  if (data.mode === 'coop') {
    updates.boss = _buildInitialCoopBoss();
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
  const cx = Math.floor(ARENA_W / 2);
  // 新ホスト = 旧ゲスト
  const newHost = {
    ...data.guest,
    role:    'host',
    x:       cx,
    y:       ARENA_H - 5,
    facing:  [0, -1],
    ready:   false,
  };
  // 新ゲスト = 旧ホスト
  const newGuest = {
    ...data.host,
    role:    'guest',
    x:       cx,
    y:       4,
    facing:  [0, 1],
    ready:   false,
  };
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
      const cx = Math.floor(ARENA_W / 2);
      const promoted = {
        ...data.guest,
        role:    'host',
        x:       cx,
        y:       ARENA_H - 5,
        facing:  [0, -1],
        ready:   false,
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
  } else if (data.state === 'waiting') {
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
