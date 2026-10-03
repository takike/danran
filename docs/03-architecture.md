# 03. アーキテクチャ

前提：ホスティングは Cloudflare Workers（[04-hosting.md](04-hosting.md) 参照）。別の基盤を選ぶ場合は、この文書の「実行基盤」と「ストレージ」の節だけを差し替える。ドメインロジック（`src/shared/`）は基盤に依存させない。

## 全体像

```
┌─────────────── ブラウザ（PWA） ───────────────┐
│ React SPA ─ Service Worker（オフラインキャッシュ・Web Push 受信） │
└───────────────┬───────────────────────────────┘
                │ HTTPS（同一オリジン /api/*、セッション Cookie）
┌───────────────▼─────────── Cloudflare Worker ───────────────────┐
│ Static Assets（SPA 配信）                                         │
│ Hono API（/api/*）── ドメインロジック（src/shared）               │
│ Cron Triggers（週1まとめ・祝日スキップ適用・公開コピー同期）      │
└──┬──────────────┬──────────────┬──────────────┬─────────────────┘
   │ D1           │ R2           │ Google APIs   │ LLM API（Claude）
   │ 付加情報・   │ プリント写真 │ Calendar /    │ プリント画像から
   │ トークン等   │              │ OAuth         │ 予定を抽出
```

## 技術スタック

| 層 | 採用 | 理由・メモ |
|---|---|---|
| 言語 | TypeScript（strict） | フロント・API・ドメインロジックで型を共有する |
| フロント | React 18+ / Vite / React Router | SPA。SSR は不要 |
| PWA | `vite-plugin-pwa`（Workbox） | manifest、アイコン、オフラインキャッシュ、Web Push 受信 |
| データ取得 | TanStack Query | キャッシュ・再取得・楽観的更新 |
| スタイル | Tailwind CSS ＋ CSS 変数のデザイントークン | 後でポップな配色に差し替えやすくする（[02-screens.md](02-screens.md) のトークン表） |
| 日付 | `date-fns` ＋ `@date-fns/tz` | **すべての日付計算は `Asia/Tokyo` で行う**。`new Date()` の素の比較を避ける |
| 繰り返し | Google Calendar の RRULE をそのまま使う | 独自の繰り返しエンジンは作らない（後述） |
| 祝日 | `@holiday-jp/holiday_jp`（npm） | 年1回、依存の更新で追従する。保育園の休園日は家族ごとに D1 で管理する |
| API | Hono（Cloudflare Workers） | 軽量でルーティングとミドルウェアが揃っている |
| バリデーション | zod | API 入出力と LLM 出力の検証に使う |
| DB | Cloudflare D1（SQLite）＋ Drizzle ORM ＋ drizzle-kit | マイグレーションは `migrations/` |
| ストレージ | Cloudflare R2 | プリント写真 |
| 開発サーバー | `@cloudflare/vite-plugin` | Vite と Worker を同じ dev サーバーで動かす |
| テスト | Vitest（ユニット・ドメイン）、`@cloudflare/vitest-pool-workers`（API）、Playwright（E2E・主要動線のみ） | |
| Lint/Format | Biome | 設定が1つで済む |
| パッケージ管理 | pnpm | |

**注意（Workers ランタイム）**：Node.js の完全互換ではない。`googleapis` npm パッケージのような重い Node 向けライブラリは使わず、**Google API は `fetch` で REST を直接呼ぶ**薄いクライアントを自作する（`src/worker/google/`）。Web Push の暗号処理も WebCrypto で動くライブラリを選ぶ（要検証）。

## ディレクトリ構成（目標）

```
danran/
├─ AGENTS.md
├─ docs/
├─ src/
│  ├─ client/            # React SPA
│  │  ├─ app/            # ルーティング、レイアウト、タブバー
│  │  ├─ features/       # week/ weekend-day/ import/ routines/ tasks/ digest/ settings/ onboarding/
│  │  ├─ components/     # 汎用 UI（Chip, Card, Segmented, MemberDot ...）
│  │  ├─ api/            # API クライアント（zod スキーマは shared から）
│  │  └─ styles/         # tokens.css など
│  ├─ worker/            # Cloudflare Worker
│  │  ├─ index.ts        # Hono アプリ ＋ scheduled ハンドラ
│  │  ├─ routes/         # /api/auth, /api/families, /api/calendar, /api/imports, /api/tasks, /api/digest ...
│  │  ├─ google/         # OAuth、Calendar REST クライアント
│  │  ├─ llm/            # プリント抽出（プロンプト・スキーマ）
│  │  ├─ db/             # Drizzle スキーマ、リポジトリ
│  │  ├─ push/           # Web Push
│  │  └─ cron/           # 定期ジョブ
│  └─ shared/            # 基盤非依存のドメインロジックと型
│     ├─ domain/         # dayLayout, freeWindows, conflicts, publishRules, taskGeneration ...
│     ├─ schemas/        # zod（API 契約、LLM 抽出結果）
│     └─ time/           # Asia/Tokyo 前提の日付ユーティリティ
├─ migrations/           # D1 マイグレーション（drizzle-kit 生成）
├─ public/               # アイコン、manifest 素材
├─ e2e/                  # Playwright
├─ wrangler.jsonc
└─ vite.config.ts
```

## データの持ち方（3層）

これがこのアプリの設計の中心。

| 層 | 何か | 正本 | アプリが持つもの |
|---|---|---|---|
| ① 個人カレンダー | 各大人の Google カレンダー（仕事用を含む） | Google | **中身は持たない**。free/busy を都度取得する。本人の画面用に本人の予定を取得するのは本人のトークンでのみ |
| ② 家族カレンダー | Danran が作る共有 Google カレンダー | Google | 付加情報（担当・持ち物・添付・候補状態・由来）を D1 に持ち、Google のイベント ID で紐づける |
| ③ アプリ固有データ | やること、取り込みジョブ、公開ルール、設定 | D1 | すべて |

### ① 個人カレンダー（free/busy）

- 他の家族に見せるのは **busy の区間だけ**。API のレスポンスに他人の予定タイトルが含まれないことを、テストで保証する。
- 他人の個人カレンダーは自分のトークンでは読めないので、**サーバーが各大人のトークンでそれぞれ `freeBusy.query` を呼ぶ**。
- 対象カレンダーは本人が設定画面で選ぶ（`calendarList` から選択。既定は primary）。
- **会社の Google Workspace の予定**：会社アカウント側で、個人アカウントに「予定の有無のみ」を共有してもらえば、個人アカウントの `calendarList` に現れ、free/busy の対象にできる。会社の管理者が外部共有を禁止している場合は、手動の「仕事ブロック」予定で代替する。オンボーディングにこの案内を入れる。
- **二重表示の回避**：Danran が個人カレンダーに書き出した予定（送迎ブロック等）も free/busy に含まれてしまう。free/busy は中身を返さないので、**D1 に記録した「書き出し済み区間」と完全一致する busy 区間を差し引く**。
- `transparency: transparent`（「予定なし」扱い）の予定は、Google 側で busy に含まれない。

### ② 家族カレンダー

- 家族作成時に、オーナーのトークンで `calendars.insert` を呼んで作成する（名前例「Danran（家族）」、タイムゾーン `Asia/Tokyo`）。
  - 作成試行ごとの識別子を説明欄に付け、結果が不確定になったときはオーナーの `calendarList.list` で照合する。判定条件と復旧手順は [14-family-onboarding.md](14-family-onboarding.md) を参照。
- 他の大人は ACL（`writer`）で共有する（2026-10-01 のスパイク結果に基づく。[06-decisions.md](06-decisions.md) の Q1）。
  - **共有の設定**：`calendar.app.created` だけでは `acl.insert` が 403 になるため、オーナーが招待リンクを発行するときに限り `https://www.googleapis.com/auth/calendar.acls` を追加で同意してもらう（incremental authorization、`include_granted_scopes=true`）。`acl.insert` は `sendNotifications=true` で呼び、Google から招待された大人に共有通知メールが届くようにする。
  - **招待された大人の読み書き**：自分のトークン（`calendar.app.created` のみ）で、共有された家族カレンダーの予定を読み書き・削除できることを確認済み。オーナーのトークンに寄せる必要はない。
  - **招待された大人の Google カレンダー一覧への表示**：`calendarList.insert` は今のスコープでは不可。スコープは増やさず、共有通知メールの「カレンダーを追加」から追加してもらう。参加完了画面でその操作を案内する。
- イベントの `extendedProperties.private` に最小限のメタデータを入れる。Google 側だけでも関係が復元できるようにするため。
  - `danran`: `"1"`（Danran 管理のイベント）
  - `members`: `"m_xxx,m_yyy"`（対象メンバー ID。子どもを含む）
  - `assignee`: `"m_xxx"`（送迎・担当）
  - `status`: `"tentative" | "confirmed"`
  - `source`: `"manual" | "import" | "publish"`
  - `sourceRef`: 取り込みジョブ ID、または公開元の個人イベント ID（ハッシュ化）
- 持ち物リスト、添付、繰り返しの設定など大きめ・構造的な情報は D1 に持つ（`event_meta`）。キーは `(calendar_id, event_id)`。繰り返しの個別回は `(calendar_id, recurring_event_id, original_start)`。
- 子どもは Google アカウントを持たない。子どもの予定は家族カレンダー上の予定で、`members` で表現する。
- Google 側の「添付ファイル」は Drive 前提なので使わない。代わりに説明欄に Danran 上の写真ページへのリンクを入れる（ログイン必須）。

### ③ アプリ固有データ（D1 スキーマ案）

```
users            id, google_sub, email, display_name, created_at
oauth_states     state_hash, browser_binding_hash, payload_enc, expires_at, created_at -- PKCE/nonce/ブラウザバインド暗号化一時保管（単一消費・TTL10分）
google_tokens    user_id, refresh_token_enc, scopes, updated_at        -- AES-GCM で暗号化（AAD: google-refresh:userId）
sessions         id, user_id, expires_at, created_at                   -- id は生の256bit乱数トークンの SHA-256。Cookie には HMAC 署名値を格納
families         id, name, family_calendar_id, owner_user_id, day_start_hour(8), day_end_hour(20),
                 creation_status(creating|ready|uncertain|failed), calendar_creation_id, created_at
members          id, family_id, user_id NULL, kind(adult|child), name,
                 color(indigo|green|ochre|purple|coral|teal|rose|slate), sort_order, status(active|pending)
member_calendars member_id, calendar_id, include_in_busy(bool)          -- free/busy 対象の個人カレンダー
invites          id, family_id, token_hash, expires_at, used_at, claimed_user_id NULL,
                 status(available|claiming|uncertain|used), created_at
closure_days     id, family_id, date, label, member_ids                -- 保育園の休園日など
event_meta       id PK, family_id FK families CASCADE, calendar_id, event_id,
                 recurring_event_id NULL, original_start NULL, items_json TEXT NOT NULL DEFAULT '[]',
                 assignee_member_id NULL FK members SET NULL, status CHECK confirmed|tentative DEFAULT confirmed,
                 source CHECK manual|import|publish DEFAULT manual, import_job_id NULL (FKなし), updated_at DEFAULT unixepoch()
routine_settings id, family_id, calendar_id, recurring_event_id, category(lesson|housework|other),
                 skip_holidays(bool), skip_new_year(bool), affects_availability(bool), default_assignee_member_id
attachments      id, family_id, r2_key, content_type, width, height, created_by, created_at
event_attachments event_meta_id, attachment_id
import_jobs      id, family_id, attachment_id, status(pending|extracted|failed|committed),
                 extracted_json, error, model, created_by, created_at
tasks            id, family_id, title, due_at NULL, due_kind(date|datetime|none), done_at NULL,
                 assignee_member_id NULL, event_meta_id NULL, source(import|items|conflict|manual),
                 source_ref NULL, created_at
mirrored_blocks  id, member_id, personal_calendar_id, event_id, start, end   -- 二重表示の差し引き用
publish_rules    id, member_id, kind(multi_day|all_day|calendar|hashtag|title_keyword),
                 value NULL, visibility(title|details), enabled
published_copies id, member_id, source_event_hash, family_event_id, visibility, last_synced_at
digest_items     id, member_id, week_start, source_event_hash, reason, suggested_visibility,
                 decided_visibility NULL, decided_at NULL
push_subscriptions id, user_id, endpoint, p256dh, auth, created_at
```

個人予定そのものは保存しない。公開判断に必要な参照はハッシュ（`source_event_hash` = HMAC(イベント ID)）で持つ。

## Google 連携

### OAuth

- サーバーサイドの Authorization Code フロー（`access_type=offline`, `prompt=consent`、S256 PKCE）。リフレッシュトークンを AES-256-GCM で暗号化して D1（`google_tokens`）に保存する。
- 一時テーブル `oauth_states` を用いたコールバック時のアトミック単一消費（`DELETE ... RETURNING`）により、認可コード横取り・リプレイ攻撃・多重送信を確実に防止する。ブラウザ識別には署名付き一時 Cookie（`__Host-danran_oauth`）のハッシュバインドを用いる。
- スコープ（Phase 1 最小限）：
  - `openid email profile`
  - `https://www.googleapis.com/auth/calendar.app.created`：家族カレンダーの作成と、その上の予定の読み書き
  - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`：free/busy 対象カレンダーの選択
  - ※ `https://www.googleapis.com/auth/calendar.freebusy`（空き状況取得）および `https://www.googleapis.com/auth/calendar.events`（個人予定の取得・書き出し）は **Phase 2 以降で追加の同意を求める incremental authorization とする**。
  - `https://www.googleapis.com/auth/calendar.acls`：**招待リンクを発行するオーナーだけ**に、発行時に追加で同意を求める（incremental authorization）。家族カレンダーの共有設定にのみ使う
- **公開ステータスの落とし穴**：OAuth 同意画面を「テスト」ステータスのままにすると、テストユーザーの同意とリフレッシュトークンが **7日で失効**する。家族利用の段階では「本番（未確認）」に切り替え、「未確認のアプリ」の警告を許容する（センシティブスコープ使用時は最大100ユーザーまで）。一般公開前に Google の審査（センシティブスコープの確認）を受ける。

### 週ビューの取得（Phase 1: 家族予定のみ）

週ビュー API は `GET /api/families/:id/week?start=YYYY-MM-DD`。`start` を省略すると `Asia/Tokyo` の今日を含む週を返す。家族カレンダーの Google イベントと D1 の `event_meta`、有効なメンバー、祝日、休園日を読み取り、`shared/domain/dayLayout` で日ごとのレイアウトを決める。完全な入出力契約、境界条件、エラーコードは [15-week-api.md](15-week-api.md) を参照。

この API は Phase 1 では家族カレンダーだけを読む。リクエストした本人を含め、個人カレンダーの `events.list` と全メンバーの `freeBusy.query` は呼ばず、予定作成・更新・削除も行わない。個人カレンダーの空きや本人だけに見える予定は Phase 2 で追加認可し、Task 2-2 以降で週 API に組み込む予定。週範囲が祝日ライブラリの対応年（1970–2050）を越える場合は、祝日を平日と誤認しないようリクエストを拒否する。

Google の家族カレンダー `events.list` は、リクエストユーザー自身のトークンで `singleEvents=true`、`orderBy=startTime`、`timeZone=Asia/Tokyo`、週の JST 境界、`showDeleted=false` を指定して取得する。最大10ページまで追跡し、ページ上限到達、同じページトークンの再出現、または不完全な取得はエラーとして扱う。イベントの Google metadata と `event_meta` は許可リストに沿ってレスポンスへ整形し、個人カレンダー情報は混ぜない。

`event_meta` は `(calendar_id,event_id)` の一意制約と、`(family_id,calendar_id)`、`(calendar_id,recurring_event_id,original_start)`、`assignee_member_id` の各検索インデックスを持つ。週 API が読むのは持ち物の `items_json` だけである。`assignee_member_id`、`status`、`source` 列は将来の D1 利用に備えた予約フィールドであり、この API のレスポンス値には使わない。担当・状態・由来は Google の `extendedProperties.private` から検証して導出する。

後のフェーズでは `syncToken` による差分取得と `events.watch`（Push 通知 → Worker の webhook）で高速化する。最初は行わない。

### 繰り返し予定

- 習い事・家事代行は、家族カレンダー上の **Google の繰り返しイベント（RRULE）** として作る。独自の繰り返しエンジンは作らない。
- 「この回だけ休む」は、その回の `status: cancelled`。「振替」は、その回の開始日時を変更する（`events.instances` → `patch`）。
- 「祝日は休み」：Google の RRULE は日本の祝日を知らないので、**Cron（月1）で今後6か月分の祝日・休園日に当たる回をキャンセル**する。設定をオフにしたら元に戻す。適用済みの回は D1 に記録しておく。
- 「年末年始は休み」も同じ仕組み（12/29〜1/3 を既定値に、家族ごとに変更可）。
- `affects_availability = false`（家事代行など）は、共通の空きの計算から除外する。

## 表示ロジック（`src/shared/domain`）

### dayLayout：日ごとの表示サイズ

```
入力：日付、祝日、休園日、その日の家族予定（ルーティンか否か）、締切、公開済みの個人予定
出力：'weekend-card' | 'expanded' | 'compact'

- 土日・祝日・休園日 → 'weekend-card'
- 平日で、非ルーティンの家族予定がある → 'expanded'
- それ以外 → 'compact'（締切・公開済み個人予定はチップで表示）
ルーティン判定：繰り返しイベントの通常回 ＝ ルーティン。例外回（振替・時間変更）と単発予定 ＝ 非ルーティン
```

週ビューの表示範囲は月〜日。翌月曜が祝日なら、その日まで伸ばす（連休を途中で切らない）。

### freeWindows：共通の空き

- 対象時間帯は `families.day_start_hour` 〜 `day_end_hour`（既定 8〜20時）。
- 各メンバーの busy = 個人の free/busy（大人）＋ そのメンバーが `members` に含まれる家族予定 ＋ 担当になっている予定（送迎。前後に余裕を持たせる）。`affects_availability=false` は除外。
- 共通の空き = 全対象メンバーの busy の和集合の補集合。30分未満の空きは切り捨てる（設定値）。
- 「みんな空き N時間」は、その合計時間を表示する。

### conflicts：重複検出

- 新しい予定（取り込み・手入力）が、同じメンバーの繰り返し予定の回と時間的に重なる場合に警告する。
- 公開まとめでは、本人の個人予定が「本人が担当の予定・TODO」または「家族全員の予定」に重なる場合を「重なり」とする。

## プリント取り込み

1. **撮影**：`<input type="file" accept="image/*" capture="environment">`。クライアントで長辺2000px程度にリサイズし、JPEG 品質0.8でアップロードする（Worker の CPU を使わないため）。
2. **保存**：`POST /api/imports` → R2（`families/{familyId}/imports/{jobId}.jpg`）に保存し、`attachments` と `import_jobs(pending)` を作る。
3. **抽出**：Worker から LLM（Claude の画像入力対応モデル。モデル名は環境変数 `LLM_MODEL`）を呼ぶ。
   - 入力：画像、今日の日付、タイムゾーン、家族の子どもの名前（クラス名があれば）、既存の繰り返し予定の概要
   - 出力：JSON スキーマで強制する（tool use / structured output）

   ```ts
   type ExtractedItem = {
     kind: 'event' | 'deadline' | 'closure';
     title: string;
     date: string;              // YYYY-MM-DD（推定）
     startTime?: string;        // HH:mm
     endTime?: string;
     allDay: boolean;
     memberHint?: string;       // 対象の子ども（名前・クラス名）
     bringItems: string[];      // 持ち物
     confidence: 'high' | 'low';
     alternatives?: string[];   // 日付の別候補（読み取りが怪しいとき）
     sourceText: string;        // 根拠となった原文
   };
   type ExtractionResult = { documentTitle?: string; items: ExtractedItem[] };
   ```
4. **後処理（`shared/domain/importPostprocess`）**：zod で検証する。年を補完する（年度をまたぐ場合を考慮）。印字された曜日と日付が矛盾すれば `low` にする。重複検出をかける。
5. **確認**：クライアントで [S3](02-screens.md#s3-プリント取り込み) を表示し、ユーザーが編集・選択する。
6. **確定**：`POST /api/imports/:id/commit` → 家族カレンダーにイベントを作成し、`event_meta`・添付を紐づける。締切と持ち物から `tasks` を生成する。
7. **失敗時**：`failed` にして再試行ボタンを出す。抽出結果はジョブに保存し、再表示のために LLM を二度呼ばない。
- プライバシー：画像には子どもの名前が含まれる。アプリのログに画像や抽出結果を出さない。LLM 提供元のデータ利用ポリシーを確認して記載する（[06-decisions.md](06-decisions.md)）。

## やること（tasks）の自動生成

| 発生元 | 生成ルール | 期限の既定 |
|---|---|---|
| 締切（取り込み） | 締切1件 → TODO 1件 | 締切日 |
| 持ち物 | 予定1件につき「〈持ち物〉を準備」1件（まとめる） | 前日 20:00 |
| 重複 | 「〈習い事〉に欠席を連絡」 | 重複する回の前日 |
| 手動 | — | 任意 |

担当は未設定で作り、画面で割り当てる。

## 公開ルールと週1まとめ（Phase 5）

- Cron（毎週日曜 20:00 JST = 日曜 11:00 UTC）で、各大人の翌週の個人予定を本人のトークンで取得する。
  1. `publish_rules` に合致 → 自動で公開コピーを作る（「自動公開済み」に載せる）
  2. 家族の時間帯（平日 18〜21時、週末、本人が担当の時間）に重なる → `digest_items` に提案として保存する
- Web Push で通知し、[S6](02-screens.md#s6-週1の公開まとめ) で決定する。
- 公開コピーは家族カレンダー上のイベントで、`source=publish` とする。`title` 粒度のときはタイトルと日時のみで、場所・説明はコピーしない。元の予定が変わったら、日次の Cron で追従する。
- 「次回から同じ種類に適用」は、決定内容から `publish_rules` を生成する（例：タイトルのキーワード）。

## 通知（Web Push）

- VAPID 鍵は Worker の secret に置く。購読は `push_subscriptions`。
- iOS は **ホーム画面に追加した PWA でのみ** Web Push を受け取れる。オンボーディングで追加を案内する。
- 送る通知：週1まとめ、TODO の当日期限（朝）、取り込み完了（任意）。

## セキュリティ

- セッション Cookie：`HttpOnly; Secure; SameSite=Lax`。状態を変える API は `X-Requested-With` ヘッダの確認で CSRF 対策をする。
- すべての `/api/families/:id/*` でメンバー所属をチェックするミドルウェアを通す。
- リフレッシュトークンは AES-GCM で暗号化する（鍵は secret の `TOKEN_ENC_KEY`）。
- R2 の写真は公開しない。Worker 経由で認可したうえで配信する。
- Secrets：`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`SESSION_SECRET`、`TOKEN_ENC_KEY`、`ANTHROPIC_API_KEY`、`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`LLM_MODEL`（var）

## 環境

| 環境 | 用途 | 備考 |
|---|---|---|
| local | `pnpm dev`（Vite ＋ Worker、ローカルの D1/R2） | Google OAuth のリダイレクト先は `http://localhost:5173/api/auth/callback` |
| staging | `danran-staging` Worker | 本番と別の D1/R2。Google OAuth クライアントも別 |
| production | `danran` Worker ＋ 独自ドメイン（任意） | |
