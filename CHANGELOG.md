# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-02-04

### Added
- **マルチテナント（組織分離）機能**
  - OrganizationContext: 組織管理のコンテキスト
  - 組織セレクター: 複数組織所属時にヘッダーで切り替え可能
  - システム管理パネル: 組織作成・メンバー一括追加
  - 組織ベースのFirestoreセキュリティルール
- **メールアドレス一括登録機能**
  - 管理パネルでコピー＆ペーストによる一括登録
  - 改行・カンマ・セミコロン区切りに対応

### Changed
- Firestoreセキュリティルールを組織ベースに拡張（後方互換性維持）

### Technical Notes
- 新しいFirestoreコレクション: `organizations`, `organizationMembers`
- システム管理者は `config/systemAdmin` ドキュメントで設定
- 既存の `users/{uid}/patients` パスは後方互換性のため維持

---

## [1.3.0] - 2026-02-02

### Added
- **経過グラフ作成機能の改善**
  - 二軸表示: 異なるスケールの検査値を左右の軸で表示
  - 分離表示モードでの二軸表示対応
  - 検査項目クリックで軸を切り替え
- **操作ガイドの更新**
  - アプリ内に4ステップガイドを追加
  - HTMLマニュアル（manual.html）を更新

### Changed
- 「経時データ分析」を「経過グラフ作成」に名称変更
- 臨床経過セクションを入力専用に変更（出力は経過グラフ作成へ）

---

## [1.2.0] - Previous

### Added
- 臨床経過タイムライン機能
- 治療薬管理機能
- Excelエクスポート機能
- 群間統計比較機能

---

## [1.1.0] - Previous

### Added
- OCR機能（Cloud Vision API）
- 検査データ一括インポート
- 患者一括登録機能

---

## [1.0.0] - Initial Release

### Added
- Firebase Authentication によるユーザー認証
- 患者データ管理
- 検査データ入力・可視化
- CSVエクスポート機能
