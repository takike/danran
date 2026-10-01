# AGENTS.md

コーディングエージェント（Codex など）向けの作業ルール。作業を始める前に必ず読むこと。

## このプロジェクト

Danran は家族の予定共有 PWA。「ルーティンは背景に、週末は前景に」がコンセプト。個人の Google カレンダーは free/busy だけを共有し、家族の予定は専用の共有 Google カレンダーに保存する。

## 最初に読むもの（この順で）

1. [docs/01-concept.md](docs/01-concept.md)：原則と用語集（コード上の命名もここに従う）
2. [docs/03-architecture.md](docs/03-architecture.md)：スタック、データの3層モデル、Google 連携
3. [docs/05-implementation-plan.md](docs/05-implementation-plan.md)：今やるタスクと受け入れ基準
4. UI を触るときは [docs/02-screens.md](docs/02-screens.md)
5. 迷ったら [docs/06-decisions.md](docs/06-decisions.md)

## コマンド（Phase 0 で整備中。変えたらここを更新すること）

### 実装済みコマンド（Task 0-1, 0-2, 0-3, 0-4）

```bash
pnpm install             # 依存関係のインストール
pnpm db:generate         # Drizzle スキーマからマイグレーション SQL を生成（migrations/）
pnpm db:migrate:local    # ローカル D1 にマイグレーションを適用（wrangler d1 migrations apply DB --local）
pnpm db:migrate:staging  # 【リモート操作】staging D1 にマイグレーションを適用（wrangler d1 migrations apply DB --env staging --remote）
pnpm db:migrate:production # 【リモート操作】production D1 にマイグレーションを適用（wrangler d1 migrations apply DB --env production --remote）
pnpm dev                 # Vite ＋ Worker 開発サーバー（@cloudflare/vite-plugin）
pnpm build               # クライアント・Worker のビルド
pnpm build:staging       # staging 向けビルド（CLOUDFLARE_ENV=staging vite build）
pnpm build:production    # production 向けビルド（CLOUDFLARE_ENV=production vite build）
pnpm preview             # ビルド成果物のローカルプレビュー
pnpm pwa:icons           # PWA アイコンの生成（lucide-react ＋ sharp）
pnpm typecheck           # TypeScript 型チェック（tsc --noEmit）
pnpm lint                # Biome による静的解析（lint:fix / format も利用可）
pnpm test                # Vitest によるテスト実行（D1・R2統合テスト含む）
pnpm e2e                 # Playwright による E2E テスト（認証 UI ＋ 開発 UI ＋ 本番 PWA / Chromium）
```

※ 初回または CI 環境で Playwright ブラウザ未導入の場合は `pnpm exec playwright install chromium` を実行する。
※ ローカル開発環境の環境変数雛形として `.dev.vars.example` を配置（実 Secret を含む `.dev.vars` は Git 管理外）。ローカル D1 や `/api/health` の動作確認には `.dev.vars` は不要。

## 絶対に守ること

1. **プライバシーの不変条件**：他のメンバーの個人カレンダーの予定について、クライアントに返してよいのは busy の区間（開始・終了）だけ。タイトル・場所・説明・参加者を返さない。これに関わる API には、漏れていないことを確かめるテストを必ず書く。
2. **タイムゾーン**：日付・曜日・「今日」の判定は、すべて `Asia/Tokyo` で `src/shared/time` のユーティリティを通して行う。`new Date().getDay()` などを直接使わない。
3. **Google API は `fetch` で REST を直接呼ぶ**（`src/worker/google/`）。`googleapis` npm パッケージは Workers で動かないので使わない。
4. **境界では zod で検証する**：API の入出力、Google のレスポンス、LLM の出力。スキーマは `src/shared/schemas` に置き、クライアントとサーバーで共有する。
5. **ドメインロジックは `src/shared/domain` に純粋関数で書き**、ユニットテストを付ける（dayLayout、freeWindows、conflicts、importPostprocess、taskGeneration、publishRules）。Worker や React に依存させない。
6. **Secret・トークン・実在の予定・写真をコミットしない**。`fixtures/prints/` は `.gitignore` 対象。ログにも出さない。
7. D1 のスキーマ変更は必ず Drizzle のスキーマ → `pnpm db:generate` でマイグレーションを作る。既存のマイグレーションファイルは編集しない。

## コーディング規約

- TypeScript strict。`any` は使わない（やむを得ない場合は理由をコメントする）。
- UI の文言は日本語、コード（識別子・コメント・コミットメッセージ）は英語。用語は docs/01 の用語集の「コード上の名前」に合わせる。
- UI は docs/02 のアクセシビリティ要件を守る：本物の `<button>`／`<a>`／`<input>`＋`<label>`、アイコンのみのボタンには `aria-label`、タップ領域は44px以上、色だけで区別しない。
- 色・余白・角丸は `src/client/styles/tokens.css` のトークンを使い、値を直書きしない（後でビジュアルを差し替えるため）。
- アイコンは線画のアイコンライブラリを使い、絵文字は使わない。
- 小さく作る：1PR は1タスク。ついでのリファクタリングは別 PR にする。

## PR のルール

- **PR は作成したら止まる。自分でマージしない**（`gh pr merge` や main への直接 push もしない）。レビューは人間側で行い、マージも人間が行う。レビューで修正依頼があれば、同じブランチに追加コミットする。
- ブランチ名：`phase{N}/{task-id}-{slug}`
- PR の説明：対応タスク ID、やったこと、受け入れ基準の確認結果、UI ならスクリーンショット（390px 幅）、更新した docs、未解決の点
- スクリーンショットの置き場所：`docs/screenshots/` に、**画面ごとに固定したファイル名**でコミットする（例：`s1-week-view.png`、`s2-weekend-day.png`。番号は docs/02-screens.md の画面 ID に合わせる。モック未作成の画面は `onboarding.png` など）。画面を変えたら同じファイルを上書きし、タスク番号入りのファイルは作らない（PR 上で変更前後の画像差分が見えるようにするため）。幅 390px、Playwright で撮影する。PR の説明には、更新した画像のパスを書く。
- 設計を変えた・未決事項を決めた場合は、同じ PR で docs（特に 06-decisions.md）を更新する。
- CI（typecheck・lint・test）が通っていること。

## 人間に確認が必要なこと

次のことは推測で進めず、PR の「未解決の点」に書くか、作業を止めて質問する。

- Google Cloud・Cloudflare のアカウント上の操作（OAuth クライアントの作成、Secret の登録、D1/R2 の作成）
- スコープの追加（ユーザーの同意画面が変わるため）
- 個人データの保存方針に関わる変更（新たに何かを保存する場合）
