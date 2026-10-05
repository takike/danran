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
| [docs/08-deployment.md](docs/08-deployment.md) | CI/CD・デプロイ運用手順書（GitHub Actions、環境構成、マイグレーション、復旧） |
| [docs/09-ui-foundation.md](docs/09-ui-foundation.md) | デザイントークンと汎用 UI 部品（UI Foundation）の仕様・利用例 |
| [docs/10-authentication.md](docs/10-authentication.md) | 認証・Google OAuth 連携仕様（エンドポイント、Cookie、暗号化、手動確認） |
| [docs/11-google-calendar-client.md](docs/11-google-calendar-client.md) | Google Calendar REST クライアント仕様（13メソッド、リトライ、サニタイズ、プライバシー） |
| [docs/12-time-and-layout.md](docs/12-time-and-layout.md) | 日時・祝日・週レイアウト仕様（Asia/Tokyo 日付計算、連休延長、dayLayout、休園日） |
| [docs/13-calendar-sharing-spike.md](docs/13-calendar-sharing-spike.md) | カレンダー共有スパイク仕様書（staging A/B 実機検証プロトコル、記録枠、権限境界） |
| [docs/14-family-onboarding.md](docs/14-family-onboarding.md) | 家族作成・招待オンボーディング仕様（データモデル、段階的認可、招待URL、手動検証手順） |
| [docs/15-week-api.md](docs/15-week-api.md) | 週ビュー API 契約（Task 1-6、入出力・認可・祝日範囲・Google ページング） |
| [docs/16-event-editing.md](docs/16-event-editing.md) | 家族予定の作成・編集・削除 API、保存・再試行、制限と staging 確認手順 |
| [docs/17-settings.md](docs/17-settings.md) | メンバー設定・休園日 API、権限、制限と staging 確認手順 |
| [docs/18-personal-events.md](docs/18-personal-events.md) | 本人だけに表示する個人予定 API・段階的認可・プライバシー保証 |
| [docs/19-busy-sharing.md](docs/19-busy-sharing.md) | free/busy 用カレンダー選択、家族 busy 週 API・プライバシー保証・staging 手順 |
| [docs/20-routines.md](docs/20-routines.md) | 繰り返し予定と個別の回の作成・一覧・変更 API、Google Calendar との対応、再試行、staging 手順 |

## 前提条件

- **Node.js**: `^22.12.0 || >=24.0.0`（Node 22.12+ または Node 24+、開発検証環境: `v24.21.0`）
- **pnpm**: `12.6.0`（Corepack 経由での利用を推奨: `corepack enable`）

## 開発と動作確認

### 1. 依存関係とブラウザのセットアップ

```bash
# 依存関係のインストール
pnpm install

# Playwright ブラウザ（Chromium）のインストール（E2E初回時）
pnpm exec playwright install chromium

# PWA 仮アイコンの生成（lucide-react ＋ sharp）
pnpm pwa:icons
```

### 2. D1 データベース（ローカル環境）のマイグレーション適用

Danran は Cloudflare D1（SQLite）および Drizzle ORM を採用しています。
リポジトリのクローン後や更新時は、コミット済みのマイグレーションをローカル D1 に適用して開発を始めます。

```bash
# ローカル D1 データベース（danran-local）にマイグレーションを適用
pnpm db:migrate:local
```

※ スキーマ（`src/worker/db/schema.ts`）を編集したときのみ、`pnpm db:generate` を実行して新しいマイグレーション SQL を生成します（普段の開発開始ごとの実行は不要です）。

> **環境とマイグレーションのコマンド体系**:
> - `wrangler.jsonc` のルート設定はデフォルトのローカル環境（`danran-local`、センチネル UUID `00000000-0000-0000-0000-000000000000`、`remote: false`）です。
> - staging 環境へのマイグレーション適用は明示的に環境フラグを指定する `pnpm db:migrate:staging`（`--env staging --remote`）で行います。
> - production 環境へのマイグレーション適用は明示的に環境フラグを指定する `pnpm db:migrate:production`（`--env production --remote`）で行います。
> - シークレット情報の雛形は `.dev.vars.example` に記載されています（ローカル DB やヘルスチェックテストには `.dev.vars` の作成は不要です）。

### 3. 開発サーバーと各種検証コマンド

```bash
# 開発サーバー起動（Vite ＋ Worker 統合環境、ローカル永続 D1 を参照）
# ※ 起動中、ローカル環境限定で http://localhost:5173/dev/ui にて部品一覧（ショーケース）を確認できます
pnpm dev

# 型チェック（TypeScript strict）
pnpm typecheck

# 静的解析・フォーマットチェック（Biome）
pnpm lint

# ユニット・Worker 統合テスト実行（Vitest / @cloudflare/vitest-pool-workers）
# ※ Miniflare 上でマイグレーションが自動適用され、合成データで D1 / R2 バインディングがテストされます
pnpm test

# 本番ビルド（フロントエンド dist/client ＋ Worker、ローカルプレビュー用）
pnpm build

# 環境別ビルド（Vite の CLOUDFLARE_ENV 指定）
pnpm build:staging
pnpm build:production

# 本番成果物のローカルプレビュー
pnpm preview

# E2E ブラウザテスト実行（Playwright / Chromium）
pnpm e2e
```

## ステータス

Phase 0 基盤（タスク 0-1 雛形、タスク 0-2 PWA・オフライン対応、タスク 0-3 D1 ＋ Drizzle、タスク 0-4 CI/CD、タスク 0-5 デザイントークンと基本部品）：
- この雛形のローカル動作確認および E2E テストには Cloudflare / Google アカウントや Secret は不要です。
- PWA の自動検証（Chromium CDP インストール性・SW制御・オフライン動作）はローカル環境で確認済みです。
- タスク 0-4（PR #4、コミット `b2137cda`）は main にマージされ、GitHub Actions CI/CD による staging デプロイ（公開 URL: `https://danran-staging.tak-ikemachi.workers.dev`）が成功しました。
- staging 環境における HTTPS SPA・ディープリンク、ヘルスチェックおよび API 404 JSON 応答、390px レンダリング、コンソールエラー皆無、CDP インストール性、SW による公開アセット限定キャッシュ（API 非キャッシュ）、オフライン再読み込み・回復、および Lighthouse 11.7.1 PWA 100 点（6つの自動チェック）の通過を確認済みです（iOS 実機確認待ち、production 未デプロイ）。
- D1 スキーマ（初期 `users` テーブル）、Drizzle 設定（`drizzle.config.ts`）、マイグレーションコマンド、R2 バインディング（`PHOTOS`）、`.dev.vars.example` を配備。
- `@cloudflare/vitest-pool-workers` による Worker 統合テスト（7件）で D1 マイグレーション適用、CRUD 操作、制約検証、R2 疎通を確認しています。
- デザイントークン（`tokens.css`）と Tailwind CSS v4 連携、汎用 UI 部品（`Card`, `Chip`, `MemberDot`, `Segmented`, `IconButton`, `TabBar`）、開発専用カタログ（`/dev/ui`、本番ビルドから完全除外）を実装（[docs/09-ui-foundation.md](docs/09-ui-foundation.md)）。
- Phase 1 ログイン・家族・週ビュー：
  - **タスク 1-1（Google OAuth 2.0 連携）**: 実装完了。staging 環境においてすべての Secret（`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `TOKEN_ENC_KEY`）が登録され、実 Google アカウントによるログイン（同意フロー・コールバック・D1 セッション発行・ユーザー表示名表示）が正常に完了することを確認済み（2026-10-01 人間により確認。※実環境での詳細ケース（ログアウト後再ログイン・セッション維持・トークン自動更新等）は自動テストでカバー、production は未確認）。
  - **タスク 1-2（Google カレンダー REST クライアント実装）**: 実装完了（[docs/11-google-calendar-client.md](docs/11-google-calendar-client.md)）。13 メソッド（`calendars.insert/delete`, `acl.insert/list`, `events.list/get/insert/patch/delete/instances`, `calendarList.list/insert`, `freeBusy.query`）、Zod 入出力境界検証、429/5xx 指数バックオフ、単一 401 トークン更新、非冪等作成の 5xx 即時フェイルクローズ、workerd redirect: manual 制御、エラーサニタイズ（`googleStatus` 追加）、および D1 暗号化トークン復号を含む Worker 統合テストを配備。
  - **タスク 1-3（スパイク：家族カレンダー共有方法）**: 実機検証完了、Q1 解決済み（[docs/13-calendar-sharing-spike.md](docs/13-calendar-sharing-spike.md)）。Q1(a) 403 不可、Q1(b) 読み書き可能を確認し、オーナーへの段階的認可（`calendar.acls`）および共有通知メールからのカレンダー追加方式を採用。スパイク用ツールは Task 1-4 で削除済みです。
  - **タスク 1-4（家族の作成・参加）**: 実装完了（[docs/14-family-onboarding.md](docs/14-family-onboarding.md)）。オンボーディング画面（`/onboarding`）、招待参加画面（`/invite`）、8色メンバーパレット、曖昧な Google 操作結果の安全な照合・明示的再開、API クライアント、Playwright E2E テスト（`e2e/family.spec.ts`）、段階的認可連携を配備。2つの実 Google アカウントを使った staging の通し動線を人間が 2026-10-02 に確認済み。OAuth コールバック堅牢化の追加実装済み（自動テストで検証。Android 実機の回帰再確認は別途必要）。
  - **タスク 1-5（時間・祝日・レイアウトのドメインロジック）**: 実装完了（[docs/12-time-and-layout.md](docs/12-time-and-layout.md)）。Asia/Tokyo 固定の日付計算、@holiday-jp/holiday_jp による祝日判定（1970–2050）、月曜起点・祝日連続延長週範囲、dayLayout（週末カード/展開平日/畳み込み平日）、および休園日（`closure_days`、タスク 1-4 にて families への外部キー制約を追加）Drizzle スキーマ・Zod バリデーション・テストを配備。ローカルマイグレーション適用および 4 つのホストタイムゾーン（UTC, Asia/Tokyo, America/New_York, Pacific/Auckland）検証を通過。
  - **タスク 1-6（`GET /api/families/:id/week` 週表示 API）**: 実装完了（[docs/15-week-api.md](docs/15-week-api.md)）。ログイン中の active メンバーに対し、家族カレンダーの予定・D1 付加情報・祝日・休園日・日ごとのレイアウトを返します。認可、共有スキーマ、日付範囲、プライバシー、ページング・エラー条件の API テストを追加。実 Google アカウントや staging での週データ取得は未確認です。
  - **タスク 1-7（S1 週ビュー、家族予定版）**: 実装完了。Phase 1 の表示範囲は [docs/02-screens.md](docs/02-screens.md#s1-週ビュー) に記載。390px の Playwright E2E とスクリーンショット（`docs/screenshots/s1-week-view.png`）を整備。実 Google アカウントと staging での週データ取得は未確認です。
  - **タスク 1-8（予定の作成・編集・削除）**: 実装・API モック E2E を整備。詳細は [docs/16-event-editing.md](docs/16-event-editing.md)、画面仕様は [docs/02-screens.md](docs/02-screens.md#s1-週ビュー)。Google Calendar と staging の実確認は未実施で、人間による staging 手順の確認が残っています。
  - **タスク 1-9（家族設定）**: `/family` で active な大人によるメンバー名・色変更、休園日の登録・削除を実装。API と権限の仕様は [docs/17-settings.md](docs/17-settings.md)。API モック E2E と390px スクリーンショット（`docs/screenshots/family.png`）を整備。Staging の人間による確認は未実施です。
- Phase 2：本人の個人予定、free/busy、週末計画：
  - **タスク 2-1（本人の個人予定）**: `/family` での段階的認可とカレンダー選択、本人の S1 に限った予定表示を実装。API・保存範囲・staging の確認手順は [docs/18-personal-events.md](docs/18-personal-events.md)。API モック E2E と合成データの 390px スクリーンショット（`docs/screenshots/family.png`, `docs/screenshots/s1-week-view.png`）を整備。Google Cloud の追加スコープ登録状況と staging 実機確認は人間による確認待ちです。
  - **タスク 2-2（空き状況に使うカレンダー）**: `/family` に free/busy 用の追加同意と本人のカレンダー選択を実装。`include_in_busy` は個人予定の `display_enabled` と独立し、選択保存までを扱います（busy 取得は Task 2-3）。仕様と staging 手順は [docs/19-busy-sharing.md](docs/19-busy-sharing.md)。Google Cloud の `calendar.freebusy` 登録は人間が2026-10-05に確認済みで、実 Google アカウントによる staging 確認は未実施です。
  - **タスク 2-3（家族の busy 週 API）**: 各 active 大人自身のトークンで busy 区間を取得する別 API を実装。未共有・取得失敗をメンバー単位の状態で区別し、区間以外の予定・カレンダー情報を返しません。契約と staging 手順は [docs/19-busy-sharing.md](docs/19-busy-sharing.md)。実 Google アカウントによる staging 確認は未実施です。
  - **タスク 2-5（週末カードの空きタイムライン）**: S1 の週末・祝日カードにメンバー別 busy と共通空きのタイムラインを表示。API モック E2E と合成データの390px スクリーンショット（`docs/screenshots/s1-week-view.png`）を整備。実 Google アカウントによる staging 表示確認は未実施です。
  - **タスク 2-6（S2 週末の1日）**: `/day/YYYY-MM-DD` にメンバー別の1日タイムラインと共通空きからの予定作成を追加。詳細は [docs/02-screens.md](docs/02-screens.md#s2-週末の1日) と [docs/19-busy-sharing.md](docs/19-busy-sharing.md) を参照。API モック E2E と合成データの390pxスクリーンショット（`docs/screenshots/s2-weekend-day.png`、`docs/screenshots/s1-week-view.png`）を整備。実 Google アカウントによる staging 表示確認は人間による確認待ちです。
- Phase 3：繰り返し予定：
  - **タスク 3-1（作成・最小一覧・シリーズ削除）**: 毎週・隔週の時刻指定予定を Google Calendar の RRULE で作り、対象・担当・カテゴリ・空き判定設定を保存します。`/routines` で一覧、作成、シリーズ全体の削除ができます。実 Google アカウントによる staging 確認は人間による確認待ちです。
  - **タスク 3-2（回ごとの休み・振替）**: `/routines` に元の予定日順の直近4回を表示し、回ごとの休み・振替と取消しを行います。週ビューと S2 から繰り返しタブへ案内します。API・staging 確認手順は [docs/20-routines.md](docs/20-routines.md)。ローカル E2E は API モックと合成データを使い、実 Google アカウントでの staging 確認は人間による実施待ちです。
