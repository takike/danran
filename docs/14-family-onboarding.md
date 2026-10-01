# 14. 家族作成・参加オンボーディング仕様（Task 1-4）

本ドキュメントは、Danran の家族カレンダー作成、子どもメンバー管理、段階的認可による招待リンク発行、招待参加フロー、セキュリティ設計、およびマージ後の実機動作確認手順を定めた仕様書です。

---

## 1. 概要とアーキテクチャ

Danran では、家族の予定を共有する「家族カレンダー」（専用の Google カレンダー）を正本として管理します。
Task 1-3 の実機検証結果に基づき、以下の共有方式を採用しています：

1. **オーナーによる家族カレンダー作成**:
   - オーナー（ログイン中の大人）が家族名を入力し、自身の Google アカウント上に専用カレンダー（`calendars.insert`）を作成。
   - この時点では追加の権限（ACL 編集権限など）は要求せず、ログイン時の基本 5 スコープのみで動作。
2. **子どもメンバーの登録**:
   - Google アカウントを持たない子どもメンバー（0〜10名）を登録（名前・表示色）。
3. **段階的認可（Incremental Authorization）による招待リンク発行**:
   - 招待リンクを発行する際、家族カレンダーの共有（`acl.insert`）に必要な `calendar.acls` スコープを追加同意（オーナーのみ）。
   - 招待 URL は安全なフラグメント形式（`APP_ORIGIN/invite#<raw43token>`）で発行され、有効期限は 7 日間。
4. **招待された大人の参加**:
   - 招待リンクを受信した大人は、未ログイン時は招待トークンを暗号化保持した状態で Google ログイン。
   - ログイン後、自動参加は行わず、画面上で家族名を確認した上で明示的に「この家族に参加する」ボタンを押下。
   - 参加時にサーバーが `acl.insert`（writer 権限、`sendNotifications=true`）を実行。
5. **普段の Google カレンダーへの表示案内**:
   - 招待された大人は、Google から届く共有通知メール内の「カレンダーを追加」リンクから自身の Google カレンダーに追加（`calendarList.insert`は呼ばず、`calendar.calendarlist`スコープは要求しない）。

---

## 2. API エンドポイント仕様

| メソッド | パス | 認証要否 | 概要 | 主な入出力 |
|---|---|---|---|---|
| `GET` | `/api/families` | 必須 | ログイン中ユーザーが所属するアクティブな家族一覧を取得（※オーナーの場合は `creating` / `uncertain` / `failed` の予約中家族も含まれますが、招待参加処理中 `pending` のユーザーは除外されます） | 200 OK: `{ families: FamilyPublic[] }` |
| `GET` | `/api/families/:id` | 必須 | ログイン中ユーザーがオーナーまたはアクティブメンバーである指定家族の取得（非メンバーまたは存在しない場合は 404 NOT_FOUND） | 200 OK: `{ family: FamilyPublic }` |
| `POST` | `/api/families` | 必須 | 家族カレンダーの新規作成および初期メンバー（オーナー）登録（新規作成時は 201 Created、同一オーナーで既に `ready` 状態の家族が存在する場合は 200 OK で既存家族を返却） | Body: `{ name: string, children?: ChildInput[] }`<br>201 Created / 200 OK: `{ family: FamilyPublic }` |
| `PUT` | `/api/families/:id/children` | 必須（オーナー限定） | 子どもメンバー情報の一括置換（0〜10人、オーナー限定） | Body: `{ children: ChildInput[] }`<br>200 OK: `{ family: FamilyPublic }` |
| `POST` | `/api/families/:id/invites` | 必須（オーナー限定） | 招待リンクの発行または段階的認可 URL の要求（オーナー限定） | 200 OK: `{ authorizationRequired: true, authorizationUrl: string }`<br>または `{ authorizationRequired: false, inviteUrl: string, expiresAt: number }` |
| `POST` | `/api/invites/inspect` | 必須 | 招待トークンの有効性・家族名の照会（期限切れ時は HTTP 410 Gone） | Body: `{ token: string }`<br>200 OK: `{ familyName: string, status: InviteStatus, alreadyMember: boolean }` |
| `POST` | `/api/invites/join` | 必須 | 招待トークンによる明示的な家族参加 | Body: `{ token: string }`<br>200 OK: `{ family: FamilyPublic }` |
| `POST` | `/api/auth/login` | 不要（同一オリジン） | 招待トークンを暗号化 state に保持した Google ログインの開始（※エラー時は既存の認証エラー形式 `{ error: string }` を返却） | Body: `{ inviteToken: string }`<br>200 OK: `{ authorizationUrl: string }` |

### エラーハンドリング仕様
- 家族系 API（`/api/families/*`, `/api/invites/*`）のエラー応答は固定フォーマット `{ error: string, code: FamilyErrorCode, googleStatus?: number, reason?: string }` で統一。
- 一方、`POST /api/auth/login` は既存の認証系 API エラーフォーマット `{ error: string }`（`apiErrorResponseSchema`）を使用します（`FamilyErrorCode` ではなく一般的な認証エラー形式）。
- **プライバシー保護不変条件**: クライアント UI は `code` に基づく固定の日本語メッセージのみを表示し、サーバー内部のエラー文字列や Google API の生エラーを画面に露出しない。
  - `INVALID_INPUT`: 「入力内容を確認してください。」
  - `UNAUTHORIZED`: 「ログインが必要です。」
  - `FORBIDDEN`: 「この操作を行う権限がありません。」
  - `NOT_FOUND`: 「対象のデータが見つかりませんでした。」
  - `ALREADY_IN_FAMILY`: 「すでに家族に所属しています。別の家族には参加できません。」
  - `IN_PROGRESS`: 「現在処理中です。しばらくお待ちください。」
  - `UNCERTAIN_MUTATION`: 「処理結果を確認できませんでした。二重作成を防ぐため再試行は行わず、Google カレンダーで同名カレンダーの有無を確認し手動で整理してください。」
  - `GOOGLE_ERROR`: 「Google カレンダーとの通信に失敗しました。時間をおいて再度お試しください。」
  - `REAUTH_REQUIRED`: 「Google カレンダーの認可が不足しています。家族のオーナーに招待リンクの再発行を依頼してください。」
  - `INTERNAL_ERROR`: 「サーバーで問題が発生しました。しばらく経ってから再度お試しください。」
  - `EXPIRED_INVITE`: 「招待リンクの有効期限が切れています。」（※HTTP 410 Gone で返却され、200 OK のステータス値ではありません）
  - `USED_INVITE`: 「この招待リンクは既に使用されています。」

---

## 3. データモデル（D1 スキーマ）と整合性設計

```sql
-- 家族テーブル
CREATE TABLE families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  family_calendar_id TEXT UNIQUE,
  owner_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  day_start_hour INTEGER NOT NULL DEFAULT 8,
  day_end_hour INTEGER NOT NULL DEFAULT 20,
  creation_status TEXT NOT NULL DEFAULT 'creating', -- 'creating', 'ready', 'uncertain', 'failed'
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- メンバーテーブル
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id TEXT UNIQUE REFERENCES users(id), -- 子どもの場合は NULL
  kind TEXT NOT NULL,                      -- 'adult', 'child'
  name TEXT NOT NULL,
  color TEXT NOT NULL,                     -- 'papa', 'mama', 'daughter', 'son'
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'    -- 'pending', 'active'
);

-- 招待テーブル
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,         -- SHA-256 ハッシュ（平文トークンは保持しない）
  expires_at INTEGER NOT NULL,             -- epoch 秒（7日間有効）
  used_at INTEGER,                         -- 使用日時（単一使用）
  claimed_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'available', -- 'available', 'claiming', 'uncertain', 'used'
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

### 設計上の決定事項と整合性ルール
1. **初期制約：大人 1 人につき 1 家族**:
   - 初期フェーズでは、大人のユーザーが同時に所属できる家族は 1 つに限定します。
   - 招待を受け取ったユーザーが既に別の家族のアクティブメンバーである場合は `ALREADY_IN_FAMILY` として拒否します。
2. **メンバー状態（`pending` と `active`）**:
   - 招待受諾処理中の競合状態や多重登録を防ぐため、参加処理の段階に応じてステータスを管理します。
3. **カレンダー作成状態の曖昧性管理（Creation Uncertainty）**:
   - Google Calendar API（`calendars.insert`）の呼び出しと D1 のコミットは非アトミックです。
   - 途中でネットワーク切断や 5xx エラーが発生した場合、`creation_status = 'uncertain'` として記録。
    - UI 上では盲目的な「作成の再試行」ボタンを無効化し、Google カレンダー側で重複作成が行われないよう、手動確認と再読み込みを促します。
4. **休園日テーブルの外部キー移行**:
   - Task 1-5 で先行配備された `closure_days.family_id`（論理参照）に対し、Task 1-4 の `families` テーブル配備に伴い外部キー制約を付与。既存データに孤立レコードが存在する場合はマイグレーションが拒否され、既存行は保持されます（サイレントな自動削除や穴埋めは行いません）。新規登録時にも孤立レコードの発生を防止します。

---

## 4. 招待リンクとセキュリティ設計

### 1. URL フラグメントによる機密トークン保護
- 招待リンクの形式：`APP_ORIGIN/invite#<raw43token>`（※`APP_ORIGIN` にはプロトコルが含まれます）
- トークンは 256bit 乱数の URL-safe Base64（43文字）で生成。
- **URL フラグメント（`#`）の採用**:
  - URL フラグメントはブラウザから HTTP リクエストラインとしてサーバーに送信されません。
  - これにより、Web サーバーのアクセスログ、プロキシログ、CDN ログ、および WAF に平文の招待トークンが記録されるリスクを大幅に抑制します（※ブラウザの閲覧履歴にはフラグメント付き URL が記録される可能性がある点に留意）。
- **Referrer-Policy `no-referrer`**:
  - `index.html` に `<meta name="referrer" content="no-referrer" />` を設定し、招待リンクを開いたページから外部サイト（Google 同意画面等）へ遷移する際に Referer ヘッダ経由でトークンが漏洩することを防ぎます。
- **ブラウザストレージ非保存**:
  - トークンを `localStorage` や `sessionStorage`、Cookie などのブラウザストレージに永続化・保存せず、メモリ上でのみ保持します。
- **明示的なクリップボードコピー**:
  - 招待リンクのコピーは `navigator.clipboard.writeText` によるユーザーの明示的な操作に限定されます。

### 2. 招待付きログイン（`POST /api/auth/login`）
- 招待リンクを開いた未ログインユーザーが「Google でログインして参加」を押下した際、同一オリジンからの `POST /api/auth/login` でトークンを渡します。
- サーバーは `oauth_states` テーブルの暗号化ペイロード内にトークンを保持し、OAuth コールバック完了後にブラウザを `/invite#<raw43token>` へ復帰させます。
- クエリパラメータ等への平文露出を行わず、フラグメントとして安全に復元されます。

### 3. 明示的な参加同意（Explicit Confirmation）
- ログイン完了後に自動で `POST /api/invites/join` を実行することは固く禁止します。
- ユーザーに招待された家族名を表示し、ユーザー本人が「この家族に参加する」ボタンを押下して初めて参加処理を実行します。

---

## 5. UI 仕様

### 1. オンボーディング画面（`/onboarding`）
- **未認証時**: ログイン案内と Google ログインボタンを表示。
- **家族未作成時**: 家族名入力フォーム（最大80文字）と「家族を作成する」ボタンを表示（この時点では ACL 認可は要求しない）。
- **作成中・未確定時（`creating` / `uncertain`）**:
  - 状態案内ボックスを表示し、重複作成を防ぐため盲目的再試行を禁止。再読み込みボタンを配置。
- **準備完了時（`ready`）**:
  - 家族名とステータスバッジ（「準備完了」）、メンバー凡例（色ドット＋名前）を表示。
  - **子ども編集（オーナー限定）**: 子どもメンバーの名前入力と色選択（藍: papa, 緑: mama, 黄土: daughter, 紫: son）。追加（最大10人）・削除（>=44px タップ領域）・保存。
  - **招待発行（オーナー限定）**:
    - オーナー以外には「招待リンクの発行は家族カレンダーの作成者のみ行えます」と表示。
    - オーナーが「招待リンクを発行する」を押下。
    - `calendar.acls` が未同意の場合は Google 認可画面（strict accounts.google.com）へ自動遷移。
    - 認可完了（`/onboarding?acl=granted`）後、再度押下で招待リンクを発行。
    - 発行後は読み取り専用 input、コピーボタン（`navigator.clipboard`）、および「招待リンクは7日間有効です」の固定案内文を表示。

### 2. 招待参加画面（`/invite`）
- **URL ハッシュ検証**:
  - `window.location.hash` から厳格な 43文字正規表現 `/^[A-Za-z0-9_-]{43}$/` でトークンを抽出。
  - トークンが不正または欠落している場合は固定エラー「無効な招待リンクです。URL を確認してください。」を表示し、一切の招待系 API（`/api/invites/*`）を送信しない（※セッション確認 `GET /api/auth/me` 等は通常通り実行されます）。
- **未認証時**:
  - 家族カレンダーへの招待案内と「Google でログインして参加」ボタンを表示。
- **認証済み・確認時**:
  - 家族名を照会して表示。
  - 参加処理中（`claiming` / `uncertain`）の場合はボタンを無効化しオーナー確認を案内。
  - 使用済み（`used`）の場合は固定エラー「この招待リンクは既に使用されています。」を表示。
  - 期限切れ（`EXPIRED_INVITE`、HTTP 410）の場合は固定エラー「招待リンクの有効期限が切れています。」を表示し、参加ボタンは表示されない（fail-closed）。
  - 有効な場合、明示的な「この家族に参加する」ボタンを表示。
- **参加完了時**:
  - 家族名と参加メンバー一覧を表示。
  - 共有通知メールからの追加を促す固定案内文を表示：
    > Google から届く共有通知メールの『カレンダーを追加』を押すと、普段の Google カレンダーにも表示されます

---

## 6. マージ後の人間による手動動作確認手順（Staging 実機検証）

> [!IMPORTANT]
> **実機検証ステータス（人間の実施待ち・PENDING）**:
> Task 1-3 のスパイクにおいて、アカウント B による共有カレンダーの読み書き・削除（Q1(b)）は staging 実機で実証済みです。
> しかし、本 Task 1-4 で新設された「オンボーディング画面（`/onboarding`）」「子どもの追加」「オーナー段階的認可」「招待発行」「招待参加画面（`/invite`）」の通し動線については、**PR マージ後に人間（オペレーター）が 2 つの実 Google アカウントを用いて staging 環境で実施**する必要があります。
> 事実に基づかないアカウント設定や架空の完了記録は行いません。

### 前提条件と記録ルール
- アカウント A（オーナー）：実 Google アカウント（ブラウザの通常プロファイル、初期ログイン時は基本 5 スコープのみで ACL 権限なし）。
- アカウント B（参加者）：実 Google アカウント（ブラウザのシークレットウィンドウまたは別プロファイル、ログイン時は基本 5 スコープのみで ACL 権限なし）。
- 検証環境：staging (`https://danran-staging.tak-ikemachi.workers.dev`)
- **記録ルール**: コミットする記録にはアカウント A / B 等の仮名ラベルを用い、実メールアドレス・実カレンダー ID・生の招待トークン文字列を含めないこと。

### 検証ステップ

1. **アカウント A：家族の作成**
   - アカウント A でログインし、`/onboarding` にアクセス。
   - 家族名（例：「だんらんテスト家」）を入力し、「家族を作成する」をクリック。
   - 家族カレンダーが作成され、ステータスが「準備完了」になることを確認。
   - Google カレンダー Web UI を開き、作成されたカレンダーのタイトルが `Danran（だんらんテスト家）` であることを確認。

2. **アカウント A：子どもの登録**
   - 「子どもを追加」をクリックし、1人目「はな」（黄土）、2人目「たろう」（紫）を入力。
   - 「子ども情報を保存する」をクリックし、保存成功メッセージが表示されることを確認。

3. **アカウント A：段階的認可と招待リンク発行**
   - 「招待リンクを発行する」をクリック。
   - Google の同意画面（`calendar.acls` 追加要求、`include_granted_scopes=true`）へ遷移することを確認。
   - （任意確認）同意画面で「キャンセル」した場合、`/onboarding?error=acl_denied` に安全に戻り、再度「招待リンクを発行する」を押下することで再試行できること。
   - 同意を完了し、`/onboarding?acl=granted` へ復帰することを確認。
   - 再度「招待リンクを発行する」をクリック。
   - 発行された招待リンク（`APP_ORIGIN/invite#<token>`）が表示されることを確認。
   - 「リンクをコピー」をクリックして招待リンクをクリップボードに取得。

4. **アカウント B：招待リンクからの未ログイン参加動線**
   - アカウント B のブラウザ（未ログイン状態）で、コピーした招待リンクを開く。
   - 「家族カレンダーへの招待」画面が表示され、「Google でログインして参加」ボタンが表示されることを確認（URL バーにトークンがフラグメントとして残っていることを確認）。
   - 「Google でログインして参加」をクリックし、アカウント B で Google ログインを完了。
   - ログイン後、`/invite#<token>` へ復帰することを確認。
   - **自動参加が行われず**、「だんらんテスト家に招待されています」と「この家族に参加する」ボタンが表示されることを確認。

5. **アカウント B：参加確定と案内文の確認**
   - 「この家族に参加する」ボタンをクリック。
   - 参加成功画面が表示され、家族名およびメンバー一覧が表示されることを確認。
   - 以下の正確な案内文が表示されていることを確認：
     > Google から届く共有通知メールの『カレンダーを追加』を押すと、普段の Google カレンダーにも表示されます

6. **Google カレンダー共有通知メールの確認と自トークン受け入れ基準の整理**
   - アカウント B の Gmail を開き、Google カレンダーから共有通知メールが届いていることを確認。
   - メールの「カレンダーを追加」リンクをクリックし、アカウント B の普段の Google カレンダーに「Danran（だんらんテスト家）」カレンダーが追加されることを確認。
   - **技術的整理と境界の明確化**:
     - メールリンクからの Google カレンダー追加および Web UI 上での操作は Google カレンダー側の共有（writer）を検証しますが、アプリ経由の `calendar.app.created` OAuth スコープによる読み書きを単独で証明するものではありません。
     - アカウント B が自身のトークン（`calendar.app.created`）で共有カレンダーの予定を読み書き・削除できることは、先行の Task 1-3 スパイク（Q1(b)）において実機検証済みです。
     - 本 Task 1-4 には家族予定の表示・作成 UI/API は含まれておらず（後続の Task 1-6 週表示 API、Task 1-8 予定作成等で実装予定）、テストではモック統合テスト（`test/family.spec.ts`）において参加後のアカウント B の個別認証資格情報を用いたクライアントメソッド実行を検証しています。架空の予定作成 UI 操作やスパイクツールの再利用は行いません。
     - 新規オンボーディング機能全体の Google 実アカウントによる通し動作確認は、本 PR マージ後に人間オペレーターが staging 環境で実施待ち（PENDING）です。
