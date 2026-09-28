# Danran（だんらん）

> 平日はルーティン、週末は家族の時間。家族のための予定共有 PWA。

Danran は、小さな子どもがいる共働き家庭向けの予定共有アプリです。TimeTree のような「予定を等しく並べるカレンダー」ではなく、**ルーティンは背景に沈め、週末・祝日・いつもと違う日を前景に出す**ことで、家族の時間を計画しやすくします。

## 主な機能（構想）

- **平日小・週末大のレイアウト**：平日は1行に畳み、土日祝や「いつもと違う日」だけを大きく表示する
- **繰り返し予定**：習い事や家事代行などを管理し、祝日スキップ・振替・この回だけ休む、に対応する
- **プリント撮影 → 予定化**：保育園のお知らせを撮影すると、予定・締切・持ち物を抽出し、確認のうえ一括登録する（写真は各予定に添付）
- **Google Calendar 連携**：各自の個人カレンダーは free/busy だけを共有し、家族の予定は専用の共有カレンダーに保存する
- **やること**：予定に紐づく TODO（締切・準備・持ち物）を担当者つきで管理する
- **週1の公開まとめ**：家族の時間と重なる個人予定を、日曜夜にまとめて「家族に公開するか」提案する

## 画面イメージ

| 週ビュー | 週末の1日 | プリント取り込み |
|---|---|---|
| <img src="docs/mocks/01-week-view.png" width="240"> | <img src="docs/mocks/02-weekend-day.png" width="240"> | <img src="docs/mocks/03-print-import.png" width="240"> |

繰り返し予定・やること・週1まとめを含む全画面は [docs/mocks/](docs/mocks/) と [docs/02-screens.md](docs/02-screens.md) を参照。配色は暫定（もっとポップにする予定）。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | コーディングエージェント（Codex 等）向けの作業ルール |
| [docs/01-concept.md](docs/01-concept.md) | プロダクトコンセプト・原則・用語集 |
| [docs/02-screens.md](docs/02-screens.md) | 画面仕様（デザインモックの文章化） |
| [docs/03-architecture.md](docs/03-architecture.md) | 技術構成・データモデル・Google 連携・プリント取り込み |
| [docs/04-hosting.md](docs/04-hosting.md) | ホスティング候補の比較と推奨 |
| [docs/05-implementation-plan.md](docs/05-implementation-plan.md) | フェーズ別の実装計画と受け入れ基準 |
| [docs/06-decisions.md](docs/06-decisions.md) | 決定事項ログと未決事項 |
| [docs/07-pwa-verification.md](docs/07-pwa-verification.md) | PWA 検証手順書（自動テスト・Lighthouse基準・iOS Safari手順） |

## 前提条件

- **Node.js**: `^22.12.0 || >=24.0.0`（Node 22.12+ または Node 24+、開発検証環境: `v24.21.0`）
- **pnpm**: `12.6.0`（Corepack 経由での利用を推奨: `corepack enable`）

## 開発と動作確認

```bash
# 依存関係のインストール
pnpm install

# Playwright ブラウザ（Chromium）のインストール（E2E初回時）
pnpm exec playwright install chromium

# PWA 仮アイコンの生成（lucide-react ＋ sharp）
pnpm pwa:icons

# 開発サーバー起動（Vite ＋ Worker 統合環境）
pnpm dev

# 型チェック（TypeScript strict）
pnpm typecheck

# 静的解析・フォーマットチェック（Biome）
pnpm lint

# ユニット・Worker テスト実行（Vitest / @cloudflare/vitest-pool-workers）
pnpm test

# 本番ビルド（フロントエンド dist/client ＋ Worker）
pnpm build

# 本番成果物のローカルプレビュー
pnpm preview

# E2E ブラウザテスト実行（Playwright / Chromium）
pnpm e2e
```

## ステータス

Phase 0 基盤（タスク 0-1 雛形、タスク 0-2 PWA・オフライン対応）：実装およびローカル検証（型チェック・静的解析・テスト・E2E）完了。
- この雛形のローカル動作確認および E2E テストには Cloudflare / Google アカウントや Secret は不要です。
- PWA の自動検証（Chromium CDP インストール性・SW制御・オフライン動作）はローカル環境で確認済みです。
- iOS 実機でのホーム画面追加（AC）は、開発環境に物理実機が未接続のためステージング環境（Phase 0-4）での実機検証待ちです（詳細は [docs/07-pwa-verification.md](docs/07-pwa-verification.md) を参照）。
- 後続タスク（未着手）：D1/R2（0-3）、CI/CD（0-4）、Tailwind/デザインシステム（0-5）
