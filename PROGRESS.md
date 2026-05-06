# バーコードダンジョン 開発進捗

設計書 `documents/2026_05_06/all/` 一式（gitignore のためリポジトリ外）に
基づく機能拡張作業ログ。次セッションでこの md を最初に読めば即再開できる構成。

最終更新: 2026-05-06（Phase 5 完了で更新）
本番URL: https://barcode-d1c01.web.app

---

## 完了したフェーズ

### Phase 1 — メニュー戻るボタン非表示（fix/menu-back-button-on-home）
- メニューホーム画面（stage=home）で「↑メニュー」戻るボタンが表示され続けていた
- CSS で `.menu-modal[data-stage="home"] #btn-menu-back { display: none }` を追加
- HTML の `class="hidden"` は汎用 `.hidden { display:none }` ルールが無く効いていなかった

### Phase 2 — 範囲タイプ19種拡張（feat/range-type-vocabulary）
- 旧 A/B/C/D/E/F → 設計書準拠の 19 種類に置換（既存仕様の上書き方針）
- `RANGE_TYPES` オブジェクトを `items.js` に新設
  - 単体・近接系: SELF / MELEE / ADJ / CROSS / DIAG
  - 直線・距離系: LINE3 / LINE5 / LINE_INF / PIERCE / RANGED
  - 部屋・全体系: ROOM / ROOM_ALL / FLOOR / FLOOR_ALL
  - 地形・特殊系: TERRAIN_3X3 / TERRAIN_5X5 / CONE3 / AROUND_TARGET / TRAP
- `_executeSkill` を kind ベースに再実装、`showSkillPatternVfx` に新範囲別 VFX 追加
- 旧 A-F → 新範囲タイプの **セーブ互換マイグレーション**（プレイヤー / ミニオン両方）
- TRAP（罠設置）は次フェーズ用にプレースホルダー実装のみ

### Phase 3 — タイプ別ウィザード技ツリー（feat/wizard-skill-tree）
- 設計書 `wizard_moves_with_range.md` 準拠で 6 タイプ × 26 技 = **156 技**を実装
- 新ファイル `src/wizard-skills.js` に `WIZARD_SKILLS_BY_ELEMENT` を定義
- レベルアップ時に `_autoLearnWizardSkills()` で自動習得
- タイプ変更時にもキャッチアップ習得（既習得は失われない）
- セーブロード時に既存ハイレベルユーザーへの追いつき習得（silent モード）
- レアリティ自動決定: Lv1-15 コモン / 16-44 レア / 45-72 エピック / 73+ レジェンド
- PP→MP コスト換算（PP30→MP4、PP1→MP60 など）
- SELF（バフ系）技は support フラグ付与 → ダメージ無し・VFX + ログのみで敵ターンへ

### 緊急修正（fix/menu / fix/log / fix/combat / fix/scroll）
スマホ実機デバッグでのフィードバック対応:
- スマホで waza-bar が D-pad と重なる → `@media (max-width:480px)` でフッターを縦積みに
- 敵にも命中率（whiff）追加: レジェンド5% / エピック10% / レア18% / コモン25%
- ミニオン攻撃にも一律 12% の外し率
- 戦闘テンポ「高速 / 低速」切替モード新設（`src/combat-speed.js`）
  - 低速モード: 720ms ステップ + 攻撃前テレグラフフラッシュ + 詳細ログ
  - メニュー → サウンド画面に「⏱ 戦闘速度」セグメントボタン
  - localStorage 永続化
- ダンジョンログ大改善:
  - `log-line` クラスで構造化、recent クラスで最新行強調
  - スライドインアニメ + フェードアウト
  - 数値（ダメージ/HP/MP/ゴールド/Lv）を色付き span でハイライト
  - レア度別の左カラーバー
  - 行数 4→5、フォント拡大
- 攻撃巻物（炎の巻物・草の巻物等の `type: scroll`）が使えなかった不具合修正
  - 旧戦闘パネル前提で `isUsableHere` から漏れていた
  - 正面方向 6 マス走査で最寄り敵に着弾する RANGED 風の使い切り技として再定義

### Phase 4 — 巻物カテゴリ大拡張（feat/scroll-categories）
- 不思議系巻物を 4 種 → **16 種・5 カテゴリ**に拡張
- ディスパッチを `_MYSTERY_SCROLL_EFFECTS` 表に集約
- 新規実装した効果:
  - **移動**: ブリンク / ワープ / ステアウェイ
  - **状態**: キュアオール / パワーアップ / シルバージュエル
  - **地形**: ウォールクラッシュ / パッセージ
  - **AoE**: 室内雷撃 / 裁き
  - **禁忌**: アポカリプス / ベルセルク（自傷代償型）
- `dungeon.js` にヘルパ追加: `destroyAdjacentWalls` / `carvePassageToStairs` /
  `monstersInRoom` / `allLivingMonsters` / `randomFloorInRoom` /
  `randomRoomCenterOtherThan`
- `randomMysteryScroll` をレアリティ重み + 同レア内均等抽選に置換（種類増加に強い）

### Phase 5 — モンスター職業制（feat/monster-jobs）
- `src/monster-jobs.js` 新規。8 職業（獣王/武道家/ホラーマン/コウモリ/
  スケルトン/蛇族/ゾンビ/ドラゴン）を定義。各職業に statMul（HP/ATK/DEF 補正）・
  aiHint・preferredRange・chargeBonus を持つ。
- `_buildDungeonFromSeed` でバーコード 3 桁目から決定論的に職業選択
  （`dungeonData.jobId` として保持）
- `generateMonster` を職業対応に拡張：属性プレフィックス × 職業ベース名で
  動的命名（例: 火 + 獣王 = フレイムビースト、闇 + スケルトン = シャドウスケルトン）
- `tickEnemies` に職業別 AI を追加：
  - ドラゴン: 正面 5 マスのブレス（5 ターンチャージ・1.5x）
  - コウモリ: 正面 3 マスの超音波（3 ターンチャージ）
  - 蛇族: 同行/同列 6 マスの貫通牙（3 ターンチャージ）
  - ホラーマン: 斜め 3 マスのファントムボルト
  - 武道家: 隣接時にたまに 2 連撃
  - ゾンビ: 毎ターン HP 4% 自然回復
  - 獣王/スケルトン: 純粋な近接（既存挙動）
- LOS は壁・他敵で遮蔽。`_jobLosClear` ヘルパで線上を歩いて判定
- 既存の magic イベント形に乗せて飛び道具化（VFX の `attackTrail` がそのまま使える）
- B1F 入場時に「このダンジョンには ◯属性の◯◯が棲みついている…」と 1 度ログで紹介

---

## 残作業（次セッション以降）

### 設計書の他の未実装要素（優先度低）
- **TRAP 系**（足元設置型の罠スクロール）: 罠システム自体が未実装。Phase 5 後に検討
- **TimeStop / Reshuffle / Pandora の巻物**: ターン管理 / フロア再生成が必要で複雑
- **状態異常システムの拡張**: 現状 `stun`/`seal` のみ。毒/混乱/眠り/麻痺は未実装
- **天候システム**: 設計書の FLOOR 系技で「日照り」「あめ」等の天候変化があるが、
  現状はログだけで実効果無し
- **召喚システム**: SELF 系の「サモン◯◯」が現状 VFX のみ
- **タイプ巻物**（他タイプ技を覚える専用巻物）: 既存の skillBook + secondary aptitude
  で代替可能と判断し、Phase 4 では未実装

---

## ユーザーが未確認 / 要動作検証

- 巻物 16 種類の実機動作（特にアポカリプス・ベルセルク等の禁忌系の派手演出）
- ウィザード技ツリーで Lv77 メテオなど究極技の発動（FLOOR 範囲、要 MP 60）
- タイプ変更時のキャッチアップ習得通知
- 低速モードでの攻撃テレグラフ可読性
- ドラゴンのブレス・コウモリの超音波・蛇族の貫通牙が同行/同列で実際に発動するか
- ホラーマンの斜め攻撃が斜めに並んだとき LOS 通って当たるか
- 武道家の 2 連撃発動率（3 ターンチャージ）
- ゾンビの自然回復が体感で長期戦化しているか

---

## 開発フロー（次セッション用メモ）

1. `documents/` は `.gitignore` 済み（リポジトリに含めない）
2. ブランチ → コミット → main マージ → push → `firebase deploy --only hosting` の順
3. `Bash(firebase deploy*)` は `.claude/settings.json` で許可済み（権限プロンプト無し）
4. ビルドは `npm run build` で `dist/` に出る。デプロイ前に毎回叩く
5. Firebase プロジェクト: `barcode-d1c01`
6. ホスティング URL: https://barcode-d1c01.web.app

---

## ブランチ一覧（このセッションで作成・マージ済み）

```
fix/menu-back-button-on-home
feat/range-type-vocabulary
feat/wizard-skill-tree
fix/combat-pacing-and-mobile-ui
fix/log-readability
fix/usable-scrolls
feat/scroll-categories
feat/monster-jobs            ← 新規（Phase 5）
```

すべて main にマージ・origin に push 済み。
