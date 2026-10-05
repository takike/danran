# 08. デプロイ運用手順書（Task 0-4）

Danran の CI/CD パイプライン構成、環境定義、デプロイ手順、および障害リカバリ方針。

## CI/CD ワークフロー概要

GitHub Actions にて 3 つのワークフローで構成されています。

```
[Pull Request 作成/更新]
      │
      ▼
.github/workflows/verify.yml (再利用可能ワークフロー)
├─ Node 24.21.0 ＋ pnpm frozen-lockfile
├─ pnpm typecheck
├─ pnpm lint (Biome)
├─ pnpm test (Vitest / Miniflare D1・R2統合)
├─ pnpm db:generate ＋ マイグレーション差分検出
└─ Playwright E2E (開発 UI ＋ 本番 PWA / Chromium)

[main ブランチへの push]
      │
      ▼
.github/workflows/ci.yml
├─ verify ジョブ (上記 verify.yml を実行)
└─ deploy-staging ジョブ (verify 成功後のみ実行)
   ├─ pnpm build:staging (CLOUDFLARE_ENV=staging vite build)
   ├─ node scripts/verify-deployment-config.mjs staging (設定ガード)
   ├─ pnpm db:migrate:staging (D1 リモートマイグレーション先行適用)
   └─ wrangler deploy --config dist/danran_local/wrangler.json

[手動本番デプロイ (workflow_dispatch)]
      │
      ▼
.github/workflows/deploy-production.yml
├─ guard ジョブ (main ブランチ実行の検証、非 main は明示的エラー)
├─ verify ジョブ (verify.yml を実行)
└─ deploy-production ジョブ (verify 成功後のみ実行)
   ├─ pnpm build:production (CLOUDFLARE_ENV=production vite build)
   ├─ node scripts/verify-deployment-config.mjs production (設定ガード)
   ├─ pnpm db:migrate:production (D1 リモートマイグレーション先行適用)
   └─ wrangler deploy --config dist/danran_local/wrangler.json
```

`main` への push では、`docs/**` とリポジトリ直下の `*.md`（`README.md`、`AGENTS.md`、`CLAUDE.md` など）だけが変更された場合、CI と staging デプロイを起動しません。これら以外の変更が1つでも含まれる push は従来どおり検証・デプロイされます。Pull request の検証は変更内容にかかわらず実行します。

ドキュメントをアプリのビルド入力にしないため、Tailwind CSS v4 は [`src/client/styles/tokens.css`](../src/client/styles/tokens.css) で読み取り元を `src/` とリポジトリ直下の `index.html` に限定しています。`docs/**` とリポジトリ直下の `*.md` は Tailwind のクラス名スキャン対象ではありません。

マージ後は、次の2点を GitHub Actions で確認します。

1. ドキュメントだけを変更した main への push では「CI & Staging Deployment」が起動しないこと。
2. アプリのコードを含む次の pull request では検証が成功し、main へのマージ後に検証と staging デプロイが起動すること。

---

## 環境とリソース定義

| 環境 | Worker 名 | D1 データベース名 | D1 Database ID | R2 バケット名 | ビルドコマンド | マイグレーションコマンド |
|---|---|---|---|---|---|---|
| **local** | `danran-local` | `danran-local` | `00000000-0000-0000-0000-000000000000` (センチネル) | `danran-photos-local` | `pnpm build` | `pnpm db:migrate:local` |
| **staging** | `danran-staging` | `danran-staging` | `6cfc0f40-0017-4f4a-8cd7-45744044c4db` | `danran-photos-staging` | `pnpm build:staging` | `pnpm db:migrate:staging` |
| **production** | `danran` | `danran-prod` | `f2ce6e9c-d6e6-48e3-81f0-22189593e962` | `danran-photos-prod` | `pnpm build:production` | `pnpm db:migrate:production` |

> **重要（環境解決の仕組み）**:
> `@cloudflare/vite-plugin`（v1.61.0）では、環境変数はビルド時（`CLOUDFLARE_ENV=<env> vite build`）に解決され、ビルド成果物としてフラット化された設定ファイル `dist/danran_local/wrangler.json` が出力されます。
> そのため、デプロイ時は常にこの生成された設定ファイルを明示指定して実行します：
> `pnpm exec wrangler deploy --config dist/danran_local/wrangler.json`
> （※ ルートの `wrangler.jsonc` を直接 deploy コマンドで指定してはいけません。ローカルセンチネル設定が誤デプロイされるのを防ぐためです）

---

## 認証情報と Secrets

### CI/CD デプロイ用認証情報 (GitHub Secrets)

GitHub リポジトリの Secrets に登録されている既存の認証情報を使用します：
- `CLOUDFLARE_API_TOKEN`: Cloudflare デプロイおよび D1 リモート操作用 API トークン
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare アカウント ID

### アプリケーション設定値（APP_ORIGIN）

各環境の `APP_ORIGIN` は `wrangler.jsonc` の `vars`（local: `http://localhost:5173`）および各環境の `env.<name>.vars` で定義されています。OAuth コールバック URI は常に `${APP_ORIGIN}/api/auth/callback` として構築されます。

| 環境 | APP_ORIGIN | コールバック URI |
|---|---|---|
| **local** | `http://localhost:5173` | `http://localhost:5173/api/auth/callback` |
| **staging** | `https://danran-staging.tak-ikemachi.workers.dev` | `https://danran-staging.tak-ikemachi.workers.dev/api/auth/callback` |
| **production** | `https://danran.tak-ikemachi.workers.dev` | `https://danran.tak-ikemachi.workers.dev/api/auth/callback` |

### アプリケーション Secrets（Task 1-1: 認証・トークン暗号化）

| Secret 名 | 用途 | 推奨生成コマンド / 形式 | ローテーションの影響 |
|---|---|---|---|
| `SESSION_SECRET` | セッション Cookie の HMAC 署名鍵 | `openssl rand -hex 32`<br>（64文字の小文字 16進文字列、256bit エントロピー。互換性のため 32文字以上の文字列も許容） | 既存の全セッション Cookie が無効化され、全ユーザーが再ログインを要求されます。 |
| `TOKEN_ENC_KEY` | Google リフレッシュトークンの AES-256-GCM 暗号化鍵 | `openssl rand -base64 32`<br>（厳格な標準 Base64 エンコードされた 32バイト / 44文字、末尾 `=`） | 既存の保存済みトークンが復号不可となり、ユーザーの再同意・再認証が必要となります。 |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 Web クライアント ID | Google Cloud Console 発行値 | 認可フローが停止します。 |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 クライアントシークレット | Google Cloud Console 発行値 | トークン交換・更新が停止します。 |

※ 鍵の値は環境（local / staging / production）ごとに独立させ、Worker やサーバーの再起動をまたいで永続・固定化する必要があります。

### オペレーター作業手順（未登録 Secret の登録）

人間による確認済み（2026-09-30）：Google Cloud Console で Web OAuth クライアントが作成され、staging 環境の `GOOGLE_CLIENT_ID` および `GOOGLE_CLIENT_SECRET` は既に Cloudflare Secrets に登録済み、ローカル開発環境の `.dev.vars` にも設定済みであることが人間により報告・確認されています。
一方、`SESSION_SECRET` および `TOKEN_ENC_KEY` の登録状況は**未確認（UNCONFIRMED）**です（未登録と断定するものではありません）。

オペレーターは、未登録の Secret のみ（未登録の場合のみ）を以下のコマンドで登録します（※ 生成コマンドのみを実行し、実際のシークレット値をリポジトリやログに出力しないでください）：

```bash
# 1. staging 環境の Secret 登録（未登録の場合のみ）
pnpm exec wrangler secret put SESSION_SECRET --env staging
pnpm exec wrangler secret put TOKEN_ENC_KEY --env staging

# 2. production 環境の Secret 登録（本番稼働準備時、未登録の場合のみ）
pnpm exec wrangler secret put GOOGLE_CLIENT_ID --env production
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --env production
pnpm exec wrangler secret put SESSION_SECRET --env production
pnpm exec wrangler secret put TOKEN_ENC_KEY --env production
```

※ **ローカル開発環境（`.dev.vars`）**: `.dev.vars` は**存在しない場合のみ** `.dev.vars.example` を参考に新規作成し、既存の `.dev.vars` を `cp` 等で上書きしてはいけません。

### Google OAuth 同意画面のプライバシーポリシー URL

ステージング環境のデプロイ完了後、Google Cloud Console の OAuth 同意画面に以下のプライバシーポリシー URL を設定できます：
- **staging**: `https://danran-staging.tak-ikemachi.workers.dev/privacy`
（※ production は後日の本番公開・独自ドメイン確定時に設定します）。

**CI/CD デプロイ認証情報のセキュリティ原則**:
- デプロイ用認証情報（`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`）は、デプロイおよびリモートマイグレーション実行ステップのみに GitHub Secrets から環境変数として注入されます（実行時の OAuth / アプリケーション Secret は Cloudflare Secrets で Worker 側に保持され、CI/CD ランナーには注入されません）。
- PR の自動検証ジョブ（`verify.yml`）にはデプロイ用シークレットを渡しません（外部 PR からの安全性を確保）。
- シークレットの値はログやコミットに出力されません。

---

## 安全設計とデプロイ原則

1. **マイグレーション先行適用（Migration-Before-Deploy）**:
   - Worker のデプロイより前に、必ず D1 マイグレーションを適用します。
   - 新しいコードが稼働する時点で、必要な DB スキーマが既に存在していることを保証します。
2. **生成設定ガード（`verify-deployment-config.mjs`）**:
   - ビルド後、デプロイ前に生成された `dist/danran_local/wrangler.json` の Worker 名、D1 ID、R2 バケット名を機械的に検証します。
   - ローカルセンチネル UUID（`00000000-...`）や環境の取り違えを確実にブロックします。
3. **再現性（Frozen Lockfile）**:
   - CI およびデプロイジョブでは常に `pnpm install --frozen-lockfile` を使用します。
4. **マイグレーションドリフト検出**:
   - `verify.yml` 内で `pnpm db:generate` を実行し、未コミットのスキーマ差分（`git status --porcelain -- migrations`）が存在する場合は CI を即座に失敗させます。
5. **並行実行制御（Concurrency）**:
   - PR 検証：同一 PR への新しい push があった場合、古い実行を自動キャンセルします（`cancel-in-progress: true`）。
   - デプロイジョブ：staging および production デプロイは後続の実行によって自動キャンセルされず、シリアライズ（直列実行）されます（`cancel-in-progress: false`）。
6. **本番デプロイの手動限定とブランチ制限**:
   - 本番デプロイは `workflow_dispatch` のみ。
   - `github.ref` が `refs/heads/main` 以外で実行された場合は、guard ジョブで明示的にエラー終了します。

---

## ローカルでの検証・Dry-Run 手順

本番・ステージングへのデプロイ内容を、リソース変更なしで確認する手順：

```bash
# 1. 型チェック・静的解析・テスト
pnpm typecheck
pnpm lint
pnpm test

# 2. マイグレーションドリフトの確認（差分がないこと）
pnpm db:generate
git status --porcelain -- migrations

# 3. E2E テスト（本番プレビュービルドを含む）
pnpm e2e

# 4. staging ビルドと設定ガードの検証
pnpm build:staging
node scripts/verify-deployment-config.mjs staging

# 5. staging デプロイのドライラン（実際の変更なし）
pnpm exec wrangler deploy --config dist/danran_local/wrangler.json --dry-run

# 6. production ビルドと設定ガードの検証
pnpm build:production
node scripts/verify-deployment-config.mjs production

# 7. production デプロイのドライラン（実際の変更なし）
pnpm exec wrangler deploy --config dist/danran_local/wrangler.json --dry-run
```

### テスト環境の独立性とシークレット隔離（Vitest Pool）

Vitest（`@cloudflare/vitest-pool-workers`）による統合テスト（`pnpm test`）は、`vitest.config.ts` で `wrangler.configPath` を省略し、Miniflare オプション（`d1Databases: ['DB']`, `r2Buckets: ['PHOTOS']`, `APP_ORIGIN: 'http://localhost:5173'`）を明示指定して実行されます。これにより、Wrangler 設定読み込みに伴うローカル `.dev.vars` の自動ロードを完全に遮断し、テスト用合成鍵と厳格なモックの下でテストを実行することで、ローカル秘密情報への依存や漏洩を防止しています。

---

## 障害リカバリ方針（フォワードマイグレーション原則）

- **適用済みマイグレーションの不変条件**:
  一度 staging または production に適用された `migrations/*.sql` ファイルは、絶対に手動編集・削除・並べ替えをしてはいけません。
- **スキーマ修正時のリカバリ手順**:
  1. `src/worker/db/schema.ts` を修正する。
  2. `pnpm db:generate` を実行し、新しい追補マイグレーションファイル（例：`0001_...sql`）を生成する。
  3. ローカルテスト（`pnpm test`）で動作を確認する。
  4. PR を作成して CI 検証を通し、マージしてデプロイを再実行する。

---

## iOS Safari 実機検証について

- **保留ステータス**:
  iOS Safari の「ホーム画面に追加」機能の実機テストは、ヘッドレス環境に物理 iOS 端末が接続されていないため保留中（Pending）です。
- **ステージング環境での検証**:
  Task 0-4 によりステージング環境が Cloudflare HTTPS 上に展開された後、開発者の iOS 実機からステージング URL にアクセスして [docs/07-pwa-verification.md](07-pwa-verification.md) の手順を実施します。
