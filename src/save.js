// Firebase Auth + Firestore 連携の認証＆セーブシステム
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  deleteDoc,
} from 'firebase/firestore';
import { firebaseConfig, isConfigured } from './firebase-config.js';

let app  = null;
let auth = null;
let db   = null;
const googleProvider = new GoogleAuthProvider();

if (isConfigured) {
  app  = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db   = getFirestore(app);
  // 認証状態をブラウザに永続化（リロードしてもログイン維持）
  setPersistence(auth, browserLocalPersistence).catch(err => {
    console.warn('setPersistence failed:', err);
  });
} else {
  console.warn('[firebase-config] config が未設定です。src/firebase-config.js を編集してください');
}

export function isFirebaseConfigured() {
  return isConfigured;
}

// 認証状態変化のリスナー登録
export function subscribeAuth(cb) {
  if (!auth) {
    cb(null);
    return () => {};
  }
  return onAuthStateChanged(auth, user => cb(user));
}

export function getCurrentAuthUser() {
  return auth ? auth.currentUser : null;
}

// メール/パスワード ログイン
export async function signInEmail(email, password) {
  if (!auth) throw new Error('Firebase 未初期化');
  return signInWithEmailAndPassword(auth, email, password);
}

// メール/パスワード 新規登録
export async function signUpEmail(email, password) {
  if (!auth) throw new Error('Firebase 未初期化');
  return createUserWithEmailAndPassword(auth, email, password);
}

// Google ログイン
export async function signInGoogle() {
  if (!auth) throw new Error('Firebase 未初期化');
  return signInWithPopup(auth, googleProvider);
}

// ログアウト
export async function signOutUser() {
  if (!auth) return;
  return signOut(auth);
}

// セーブ読み込み（uid指定）
export async function loadSave(uid) {
  if (!db || !uid) return null;
  try {
    const ref = doc(db, 'saves', uid);
    const snap = await getDoc(ref);
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error('loadSave failed:', err);
    return null;
  }
}

// セーブ書き込み（uid指定）
export async function saveData(uid, data) {
  if (!db || !uid) return;
  try {
    const ref = doc(db, 'saves', uid);
    await setDoc(ref, data, { merge: false });
  } catch (err) {
    console.error('saveData failed:', err);
  }
}

// セーブ削除（uid指定）
export async function deleteSave(uid) {
  if (!db || !uid) return;
  try {
    await deleteDoc(doc(db, 'saves', uid));
  } catch (err) {
    console.error('deleteSave failed:', err);
  }
}
