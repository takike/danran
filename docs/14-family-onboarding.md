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
6. **不確定状態からの明示的な復旧**:
   - 家族カレンダー作成が `uncertain` の場合、オーナーが画面の「状態を確認する」を押したときだけ `calendarList.list` で照合します。作成試行ごとの `calendarCreationId` を照合マーカーとして用い、完全な一覧で一意に一致した場合だけ `ready` にします。
   - 招待 ACL 付与が `uncertain` の場合、元の招待をそのユーザーが明示的に再確認します。参加者の `pending` メンバー行と紐づく同じ招待を再利用し、別ユーザーの引き受けや別メンバー行の作成はしません。`claiming` の HTTP 200 応答を確認できるのは元の引受ユーザーだけで、別ユーザーには `USED_INVITE`（HTTP 410）を返します。

---

## 2. API エンドポイント仕様

| メソッド | パス | 認証要否 | 概要 | 主な入出力 |
|---|---|---|---|---|
| `GET` | `/api/families` | 必須 | ログイン中ユーザーが所属するアクティブな家族一覧を取得（※オーナーの場合は `creating` / `uncertain` / `failed` の予約中家族も含まれますが、招待参加処理中 `pending` のユーザーは除外されます） | 200 OK: `{ families: FamilyPublic[] }` |
| `GET` | `/api/families/:id` | 必須 | ログイン中ユーザーがオーナーまたはアクティブメンバーである指定家族の取得（非メンバーまたは存在しない場合は 404 NOT_FOUND） | 200 OK: `{ family: FamilyPublic }` |
| `POST` | `/api/families` | 必須 | 家族カレンダーの新規作成および初期メンバー（オーナー）登録（新規作成時は 201 Created、同一オーナーで既に `ready` 状態の家族が存在する場合は 200 OK で既存家族を返却） | Body: `{ name: string, children?: ChildInput[] }`<br>201 Created / 200 OK: `{ family: FamilyPublic }` |
| `PUT` | `/api/families/:id/children` | 必須（オーナー限定） | 子どもメンバー情報の一括置換（0〜10人、オーナー限定） | Body: `{ children: ChildInput[] }`<br>200 OK: `{ family: FamilyPublic }` |
| `POST` | `/api/families/:id/reconcile` | 必須（オーナー限定） | `uncertain` な家族カレンダー作成を Google 上で照合。ready 状態の再要求は冪等 | Body: `{}`<br>200 OK: `{ family: FamilyPublic }` |
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
  - `UNCERTAIN_MUTATION`: 「処理結果を確認できませんでした。状態を確認するか、しばらく経ってから再度お試しください。」不確定な家族作成は専用の状態確認操作で復旧し、不確定な招待参加は引き受け済み本人に限り明示的な再確認を許可します。
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
  calendar_creation_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))), -- 作成試行マーカー。API には公開しない
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
  color TEXT NOT NULL CHECK (color IN ('indigo', 'green', 'ochre', 'purple', 'coral', 'teal', 'rose', 'slate')),
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
   - 途中でネットワーク切断や 5xx エラーが発生した場合、`creation_status = 'uncertain'` として記録します。
   - `calendarCreationId` を Google カレンダー説明欄の `danran-family:<familyId>;creation:<creationId>` に含めます。カレンダー名は `Danran（<family.name>）` で、summary はこの文字列と完全一致させます。照合はオーナー権限、非 primary・非 deleted、説明マーカー完全一致を要求し、`dataOwner` が存在する場合は検証済みオーナーメールとも一致させます。
   - 全ページを安全に走査して一意一致なら `ready`、完全走査でゼロ件なら `failed` とします。複数一致、ページング異常、途中エラー、無効な応答では `uncertain` を維持します。Google への照会前後に認証・所有権を確認し、作成試行 ID と状態の CAS が一致するときだけ書き込みます。
   - UI は盲目的な作成再試行を行わず、オーナーの明示的な「状態を確認する」操作だけで照合 API を呼びます。完全走査で `failed` になった後の新しい作成試行は新しい `calendarCreationId` を先に発行します。
4. **招待参加と不確定 ACL の復旧**:
   - `available` 招待は7日で失効します。期限前に引受処理を開始して `uncertain` になった招待は、同じ `claimed_user_id` と同じ `pending` adult member に限り、期限後も状態照会・再試行を許可します。
   - 不確定後の再試行では、Google エラーや内部エラーを含む失敗時も招待と pending メンバーを保持して `uncertain` に戻します。最初の ACL 挿入が成功していた可能性を失わないためです。
   - Google が ACL 挿入に 409 を返した場合、`acl.list` の完全な走査で同じ宛先の `writer` ルールを確認できた場合のみ成功扱いとします。照合できない場合は不確定状態を保持します。
5. **休園日テーブルの外部キー移行**:
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
  - 状態案内ボックスを表示。オーナーの `uncertain` 状態では「状態を確認する」ボタンを表示し、実行中は「確認中...」にして再押下を防ぎます。`creating` は読み取り更新のみを許可します。
  - 家族作成リクエストが `UNCERTAIN_MUTATION` になった場合は、同じユーザーの家族一覧を読み直して状態を表示します。作成や状態確認 API は自動で再送しません。
- **準備完了時（`ready`）**:
  - 家族名とステータスバッジ（「準備完了」）、メンバー凡例（色ドット＋名前）を表示。
  - **子ども編集（オーナー限定）**: 子どもメンバーの名前入力と色選択（藍、深緑、黄土、紫、珊瑚、青緑、薔薇、グレー）。追加（最大10人）・削除（44px 以上のタップ領域）・保存。初期色はパレット順です。
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
  - 自分が引き受けた `claiming` 招待は状態案内を表示して参加ボタンを無効化します（別ユーザーには `USED_INVITE`、HTTP 410 が返ります）。自分が引き受けた `uncertain` 招待では「参加状態を確認する」を明示表示し、押下時のみ同じ参加処理を再実行します。実行中は「確認中...」で無効化します。
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
> **Task 1-4 通し動線の実機確認済み（2026-10-02）**: 人間が2つの実 Google アカウントを使い、staging で家族作成、子どもの登録、オーナーの段階的認可、招待発行、招待参加、Google 共有通知メールの「カレンダーを追加」まで確認しました。下記手順は再利用可能な確認記録です。
>
> OAuth コールバック堅牢化は追加実装済みで、自動テストで検証済みです。Android 実機での招待リンク連打、戻る・キャンセル後の再試行、消費済み callback URL 再読み込みの回帰確認は別途必要です。

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
   - （任意確認）同意画面で「キャンセル」した場合、`/onboarding?error=acl_denied` に安全に戻り、カレンダー共有の項目にチェックを入れて許可する必要がある案内を確認する。案内に従って「招待リンクを発行する」を押下し、再試行できること。
   - Google OAuth アプリが未確認の場合、`Google hasn't verified this app`（このアプリは Google で確認されていません）という警告が表示されることがあります。表示された場合は `Advanced` → `Go to …`（詳細設定 → … に移動）を選びます。遷移先の表示名は Google の画面によって異なるため、特定のホスト名が表示されるとは限りません。警告が表示されない場合、この操作は不要です。
   - 同意を完了し、`/onboarding?acl=granted` へ復帰することを確認。
   - 再度「招待リンクを発行する」をクリック。
   - 発行された招待リンク（`APP_ORIGIN/invite#<token>`）が表示されることを確認。
   - 「リンクをコピー」をクリックして招待リンクをクリップボードに取得。

4. **アカウント B：招待リンクからの未ログイン参加動線**
   - アカウント B のブラウザ（未ログイン状態）で、コピーした招待リンクを開く。
   - 「家族カレンダーへの招待」画面が表示され、「Google でログインして参加」ボタンが表示されることを確認（URL バーにトークンがフラグメントとして残っていることを確認）。
   - 「Google でログインして参加」をクリックし、アカウント B で Google ログインを完了。
   - ログイン後、`/invite#<token>` へ復帰することを確認。
   - 同意をキャンセルした場合は `/invite?error=access_denied#<token>`、トークン交換・検証等で失敗した場合は `/invite?error=auth_failed#<token>` に戻り、固定の案内と同じ招待トークンが残ることを確認する。Google の許可画面の項目を確認し、同じ画面のログインボタンから再試行できること。
   - **自動参加が行われず**、「だんらんテスト家に招待されています」と「この家族に参加する」ボタンが表示されることを確認。

5. **アカウント B：参加確定と案内文の確認**
   - 「この家族に参加する」ボタンをクリック。
   - 参加成功画面が表示され、家族名およびメンバー一覧が表示されることを確認。
   - 以下の正確な案内文が表示されていることを確認：
     > Google から届く共有通知メールの『カレンダーを追加』を押すと、普段の Google カレンダーにも表示されます

6. **Google カレンダー共有通知メールの確認**
   - アカウント B の Gmail を開き、Google カレンダーから共有通知メールが届いていることを確認。
   - メールの「カレンダーを追加」リンクをクリックし、アカウント B の普段の Google カレンダーに「Danran（だんらんテスト家）」カレンダーが追加されることを確認。
   - 共有通知メールが届き、「カレンダーを追加」から普段の Google カレンダーに追加できたことを確認済み（2026-10-02）。この確認は Google 側の共有通知と一覧追加の操作を対象とします。
   - このメールおよび Google カレンダー Web UI の確認だけでは、アプリ経由の `calendar.app.created` スコープによる読み書きを証明しません。アカウント B が自身のトークンで共有カレンダーの予定を読み書き・削除できることは、先行の Task 1-3 スパイク（Q1(b)）で実機検証済みです。
   - Task 1-4 には家族予定の一覧・作成 UI/API はまだ含まれません（後続の Task 1-6、1-8 で実装予定）。参加者トークンを使う統合動作は fetch をモックしたテストで確認しています。

### OAuth コールバック堅牢化の Android 回帰確認（追加実装の自動テスト検証済み・実機確認待ち）

以下は Task 1-4 通し動線の確認とは別の、追加された OAuth コールバック堅牢化に対する人間の確認手順です。追加実装は自動テストで検証済みですが、この手順による Android 実機確認は完了したものとして扱いません。

現象の発生原因はまだ特定されていません。候補として記録するのは、(1) Google へ遷移中に2回目の POST が発生して OAuth のブラウザバインディングを上書きしたこと、(2) callback URL が二度読み込まれ、先行リクエストですでに state が消費されていたこと、の2点です。いずれかを根本原因と断定するものではありません。BFCache 復元は必要な UI 動作であり、報告された原因候補ではありません。

1. Android 端末で招待リンクを開き、「Google でログインして参加」または ACL 認可の開始操作を連続してタップする。OAuth 遷移が重複せず、遷移中は「Google に移動中...」となって操作できないことを確認する。
2. Google 認可画面から戻る、または同意をキャンセルして Danran に戻る。招待付きログインではキャンセル時 `access_denied`、その他の認証失敗時 `auth_failed` の案内と同じ招待リンクが表示され、許可画面の項目を確認して同じ招待リンクから再試行できることを確認する。ACL 同意キャンセル時は `acl_denied`、その他の ACL 失敗時は `acl_failed` の案内が表示され、カレンダー共有の許可を促すことを確認する。BFCache でページが復元された場合も操作が再び有効になることを確認する。
3. すでに処理済みの OAuth callback URL をブラウザ履歴から再読み込みする。安全な固定エラー案内（期限切れ、またはすでに完了した可能性を含む）が表示され、招待トークンを引き継がず、JSON や生の Google エラーが画面に出ないことを確認する。
4. 確認記録には結果と端末・ブラウザ種別のみを記載する。招待トークンをコピーして記録したり、メールアドレス・予定情報などの個人データをログやコミットへ残したりしない。
