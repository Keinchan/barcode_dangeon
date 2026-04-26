// Firebase 設定
//
// 1) https://console.firebase.google.com で新規プロジェクトを作成
// 2) Authentication → Sign-in method で「メール/パスワード」と「Google」を有効化
// 3) Firestore Database を作成（本番モード推奨）
// 4) プロジェクト設定 → マイアプリ → Web アプリを追加 → 設定オブジェクトをコピー
// 5) この firebaseConfig を上書きしてください
//
// ※ 5) を行わない限り、起動時にコンソールへ警告が出てログイン操作はエラーになります
export const firebaseConfig = {
  apiKey: 'TODO_API_KEY',
  authDomain: 'TODO.firebaseapp.com',
  projectId: 'TODO_PROJECT_ID',
  storageBucket: 'TODO.appspot.com',
  messagingSenderId: 'TODO_SENDER_ID',
  appId: 'TODO_APP_ID',
};

export const isConfigured =
  !firebaseConfig.apiKey.startsWith('TODO') &&
  !firebaseConfig.projectId.startsWith('TODO');
