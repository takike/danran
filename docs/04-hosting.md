# 04. ホスティング候補と推奨

## 要件

- PWA（静的アセット＋Service Worker）を HTTPS で配信する
- API サーバー：Google OAuth（サーバーでリフレッシュトークンを保持）、Google Calendar REST、LLM API の呼び出し
- DB：リレーショナルが扱いやすい（家族・メンバー・予定メタ・TODO）
- オブジェクトストレージ：プリント写真
- 定期実行：週1まとめ（日曜夜）、月1の祝日スキップ適用、日次の公開コピー同期
- Web Push の送信
- 家族数世帯の規模では、ほぼ無料で運用できること。一般公開後も急に高くならないこと
- 個人開発者がコーディングエージェント任せでも運用できる単純さ

## 候補

### A. Cloudflare Workers（Static Assets）＋ D1 ＋ R2 ＋ Cron Triggers　**← 推奨**

- 1つの Worker で SPA 配信と `/api/*` を兼ねる（SPA モード：`not_found_handling: "single-page-application"`）。
- D1（SQLite）、R2、Cron Triggers、Secrets がすべて同じ `wrangler.jsonc` にまとまる。デプロイ単位が1つで済む。
- 静的アセットへのリクエストは無料。規模的に無料枠でほぼ収まる見込み（CPU 時間などが足りなければ Workers Paid に上げる）。
- R2 は外向きの転送料がかからないので、写真の配信コストを気にしなくてよい。
- 注意点
  - Workers ランタイムは Node.js 完全互換ではない。`googleapis` のような重いパッケージは避け、`fetch` で REST を呼ぶ。
  - リクエストあたりの CPU 時間に制限がある。画像のリサイズはクライアント側で行う（LLM や Google API の待ち時間は CPU 時間に数えない）。
  - D1 は SQLite なので、複雑な集計や全文検索は弱い（このアプリでは問題にならない）。
- 補足：Cloudflare Pages（＋ Functions）も選べるが、Pages は Cron Triggers を持たず、Workers のほうが機能が広い。新規なら Workers の Static Assets で始めるのが素直。

### B. Firebase（Hosting ＋ Cloud Functions ＋ Firestore ＋ Cloud Storage ＋ FCM）

- 長所：Google ログインとの親和性、FCM による通知、Google Cloud 側の OAuth 審査と同じ土俵にある。
- 短所：Cloud Functions の利用に従量課金プラン（Blaze）が必要。Firestore はドキュメント DB なので、家族・メンバー・予定メタ・TODO の関係を扱うには設計の工夫がいる。デプロイ対象が複数に分かれる。

### C. Vercel（フロント＋API）＋ Supabase（Postgres・Storage）

- 長所：開発体験がよい。Postgres が使える。Supabase Auth で Google ログインが簡単。
- 短所：サービスが2つにまたがる（障害点・設定・課金が2倍）。無料プランの Cron の頻度や、Supabase 無料プロジェクトの非アクティブ時の一時停止など、個人利用で引っかかる制約がある（最新の条件は要確認）。

### D. Google Cloud Run ＋ Cloud SQL

- 長所：コンテナなので何でも動く。
- 短所：Cloud SQL の常時課金がこの規模には重い。運用の手間が一番大きい。

## 比較

| 観点 | A. Cloudflare Workers | B. Firebase | C. Vercel＋Supabase | D. Cloud Run |
|---|---|---|---|---|
| デプロイ単位 | 1 | 3〜4 | 2 | 2〜3 |
| RDB | ◯ D1（SQLite） | △ Firestore | ◎ Postgres | ◎ Cloud SQL |
| 定期実行 | ◎ Cron Triggers | ◯ Scheduler | △ 無料枠に制約 | ◯ Scheduler |
| 写真ストレージ | ◎ R2（転送無料） | ◯ | ◯ | ◯ |
| 家族規模のコスト | ◎ ほぼ無料 | ◯ 従量（少額） | ◯ 無料枠内 | △ 常時課金 |
| ランタイムの制約 | △ Node 非完全互換 | ◯ | ◯ | ◎ |
| エージェントに任せやすいか | ◎ 設定が1ファイル | ◯ | ◯ | △ |

## 推奨

**A. Cloudflare Workers（Static Assets）＋ D1 ＋ R2 ＋ Cron Triggers**。

理由：必要な部品（配信・API・DB・ストレージ・定期実行・Secrets）が1つのプラットフォーム、1つの設定ファイル、1つのデプロイにまとまる。家族規模ではほぼ無料で、一般公開しても単価が低い。Node 非互換の制約は「Google API を `fetch` で直接呼ぶ」方針で回避できる。

移行性の担保：ドメインロジック（`src/shared/`）は基盤に依存させない。DB アクセスは Drizzle 経由にしておく（D1 → Postgres への移行時は方言差分だけ直せばよい）。

## 初期セットアップ（人間がやること）

Codex に渡す前に、次のアカウント作業を済ませておく（Codex はブラウザでの操作ができないため）。

1. Cloudflare アカウント作成、`wrangler login`（または API トークン発行 → GitHub Secrets の `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`）
2. D1 データベース（`danran-staging`、`danran-prod`）と R2 バケット（`danran-photos-staging`、`danran-photos-prod`）を作成し、ID を控える
3. Google Cloud プロジェクト作成 → Calendar API を有効化 → OAuth 同意画面（外部、スコープ登録）→ OAuth クライアント（ウェブ）を local / staging / prod のリダイレクト URI で作成
4. **OAuth 同意画面の公開ステータスを「本番」に切り替える**（テストのままだと7日でトークンが失効する。未確認アプリの警告は家族利用なら許容）
5. Anthropic API キーを発行する
6. `wrangler secret put` で各 Secret を登録する（[03-architecture.md](03-architecture.md#セキュリティ) の一覧）
