// Firebase 設定（Firebase コンソール「プロジェクト設定 → マイアプリ」より）
//
// 実APIキー類は公開フロントに埋め込まれる前提で、Firestore セキュリティルールで
// アクセス制御する。実際のルール例は README またはチャット履歴を参照。
export const firebaseConfig = {
  apiKey:            'AIzaSyAuKFCtEmPrGG8KpiE4jz8YTSJremyOtRE',
  authDomain:        'barcode-d1c01.firebaseapp.com',
  projectId:         'barcode-d1c01',
  storageBucket:     'barcode-d1c01.firebasestorage.app',
  messagingSenderId: '664237494636',
  appId:             '1:664237494636:web:5dfb7bf44e5efd66d7e349',
  measurementId:     'G-HQGGW33JG8',
};

export const isConfigured =
  !firebaseConfig.apiKey.startsWith('TODO') &&
  !firebaseConfig.projectId.startsWith('TODO');
