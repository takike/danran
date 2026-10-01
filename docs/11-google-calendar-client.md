# 11. Google Calendar REST クライアント仕様（Task 1-2）

Cloudflare Workers 向け Google Calendar API v3 REST クライアントの仕様、対応メソッド、リトライ設計、エラーサニタイズ、およびプライバシー保護方針。

---

## 1. 概要とアーキテクチャ

Workers 環境では `googleapis` npm パッケージが動作しないため、`fetch` を直接呼び出す軽量な REST クライアント（`src/worker/google/calendar.ts`）を実装しています。

- **ファクトリ**: `createGoogleCalendarClient(env, userId)`
- **ベース URL**: `https://www.googleapis.com/calendar/v3`（固定）
- **認証**: `Authorization: Bearer <accessToken>` ヘッダのみ（URL クエリに付与しない）
- **トークン取得**: `getGoogleAccessToken(env, userId)` により要求時オンデマンドで取得。メソッド実行中はメモリ内でトークンを再利用し、グローバルキャッシュや永続化は行わない。
- **workerd 互換性**: 全リクエストで `redirect: 'manual'` を指定し、3xx 応答を即座に拒否（資格情報の意図しない送信先漏洩を遮断）。

---

## 2. 実装済み 12 メソッド一覧

本クライアントで実装されたメソッドは以下の 12 件です：

| # | メソッド | HTTP | パス | 概要 | 主な引数・戻り値 |
|---|---|---|---|---|---|
| 1 | `calendars.insert` | `POST` | `/calendars` | 家族カレンダーの新規作成 | `InsertCalendarInput` → `GoogleCalendar`（既定 timeZone: `Asia/Tokyo`） |
| 2 | `calendars.delete` | `DELETE` | `/calendars/{calId}` | カレンダーの削除 | `calendarId` → `void`（204 No Content） |
| 3 | `acl.insert` | `POST` | `/calendars/{calId}/acl` | 家族カレンダーの ACL 付与（writer 等） | `InsertAclRuleInput` → `GoogleAclRule`（`sendNotifications` オプション対応） |
| 4 | `events.list` | `GET` | `/calendars/{calId}/events` | 家族予定の単一ページ一覧取得 | `EventsListOptions` → `GoogleEventsPage`（`timeMin`/`timeMax`/`singleEvents`） |
| 5 | `events.get` | `GET` | `/calendars/{calId}/events/{eventId}` | 予定の詳細取得 | `calendarId`, `eventId` → `GoogleEvent` |
| 6 | `events.insert` | `POST` | `/calendars/{calId}/events` | 予定の作成 | `InsertEventInput` → `GoogleEvent`（クライアント生成安定 ID） |
| 7 | `events.patch` | `PATCH` | `/calendars/{calId}/events/{eventId}` | 予定の部分更新 | `PatchEventInput` → `GoogleEvent`（デフォルト値無補完・nullクリア対応） |
| 8 | `events.delete` | `DELETE` | `/calendars/{calId}/events/{eventId}` | 予定の削除 | `calendarId`, `eventId` → `void`（204 No Content） |
| 9 | `events.instances` | `GET` | `/calendars/{calId}/events/{eventId}/instances` | 繰り返し予定の個別回一覧取得 | `EventsInstancesOptions` → `GoogleEventsPage` |
| 10 | `calendarList.list` | `GET` | `/users/me/calendarList` | カレンダー一覧（free/busy 対象選択用） | `CalendarListListOptions` → `GoogleCalendarListPage`（最大 250 件） |
| 11 | `calendarList.insert` | `POST` | `/users/me/calendarList` | カレンダー一覧への登録（歴史的経緯により保持、本番未使用） | `InsertCalendarListEntryInput` → `GoogleCalendarListEntry` |
| 12 | `freeBusy.query` | `POST` | `/freeBusy` | 個人カレンダーの空き時間問い合わせ | `FreeBusyQueryInput` → `FreeBusyQueryResponse`（プライバシー保護済み） |

### ページネーション契約

一覧取得メソッド（`events.list`、`events.instances`、`calendarList.list`）は**単一ページ**を返却します。クライアントまたは呼び出し側サービスが `nextPageToken` を評価して反復処理を行う契約としており、クライアント内部で暗黙の自動切り捨てや無限フェッチを行いません。

---

## 3. リトライ方針とミューテーション安全性

Google API のレート制限（429、特定の 403）およびサーバーエラー（5xx）に対して、指数バックオフとジッターを適用した自動再試行を行います。

- **最大試行回数**: 最大 4 回（401 再試行を含む）
- **遅延間隔**: 1,000ms、2,000ms、4,000ms ＋ ランダムジッター（0〜250ms）
- **401 Unauthorized**: 初回 401 発生時に `getGoogleAccessToken` でトークンを 1 回だけ更新し即座に再試行。2 回連続 401 の場合は `AUTH_ERROR` をスローして停止（無限ループ防止）。
- **非リトライ対象**: 400、通常の 403（権限不足等）、404、409、410、412、3xx、不正な JSON / スキーマ不一致。
- **Retry-After ヘッダ**: 本フェーズでは実装を簡潔かつ決定論的に保つため処理を省略し、固定指数バックオフ＋ジッターで運用（将来必要に応じて追加）。

### 重要：非冪等な作成におけるミューテーション安全性

1. **`calendars.insert` および `acl.insert`**:
   - 429 やレート制限 403 は再試行しますが、**5xx サーバーエラーおよび曖昧なトランスポート障害（ネットワーク切断等）は一切自動再試行しません**。
   - 理由：カレンダー作成や ACL 追加には Google API 上で重複を排除する一意の冪等性キーが存在せず、5xx 発生時に Google 側で作成が完了していた場合、自動再試行によって重複した家族カレンダーや重複 ACL レコードが生成される危険があるためです。
   - この場合、`GoogleCalendarError`（`code: 'UNCERTAIN_MUTATION'`, `outcome: 'uncertain'`）を即座にスローし、呼び出し側サービスが既存カレンダーの照合等を行ってから再試行する設計としています。
2. **`events.insert`**:
   - 呼び出し側から `id` が渡されない場合、初回試行前に `crypto.randomUUID().replaceAll('-', '')`（Google 仕様の base32hex 形式 32 文字）を 1 回だけ生成します。
   - **すべての再試行（429/5xx）において同一の `id` とボディを再利用**します。これにより、ネットワーク不達による再送時にも同一イベントとして処理され、二重登録を防止します。409 Conflict が返却された場合は暗黙の成功とみなさず、型付けされた `CONFLICT` エラーを返却します。

---

## 4. エラーサニタイズと `GoogleCalendarError`

プライバシー保護およびセキュリティ不変条件に基づき、生のエラーレスポンスやトークン、URL、個人データが漏洩しないようサニタイズしています：

```ts
export class GoogleCalendarError extends Error {
  readonly code: GoogleCalendarErrorCode; // 'INVALID_INPUT' | 'AUTH_ERROR' | 'RATE_LIMITED' | 'NOT_FOUND' | 'CONFLICT' | 'UNCERTAIN_MUTATION' | 'REDIRECT_REJECTED' | 'INVALID_RESPONSE' | 'API_ERROR'
  readonly status: number;                // HTTP ステータスコード
  readonly reason?: string;               // 許可リスト化された安全な識別子のみ（例: 'rateLimitExceeded', 'forbidden', 'insufficientPermissions'）
  readonly outcome: 'uncertain' | 'failed';
  readonly googleStatus?: number;         // 実際の Google HTTP ステータス（upstream レスポンスが存在する場合のみ設定）
}
```

- Google の生エラーメッセージ（ユーザー名、メールアドレス、カレンダー ID 等が含まれ得る）は一切 Error の message やログに出力せず、コードに基づいた固定安全メッセージを返却します。
- 許可リストにない upstream reason は `undefined` として扱われます（許可リスト: `rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded`, `notFound`, `conflict`, `invalid`, `required`, `backendError`, `authError`, `invalidCredentials`, `forbidden`, `insufficientPermissions`, `requiredAccessLevel`）。
- `googleStatus` は、Google から実際に HTTP レスポンス（パース失敗・ステータスコードを含む）を受信した場合にのみ記録され、ローカルバリデーション失敗やネットワーク到達不能、トークン取得エラーでは設定されません（捏造ステータスの防止）。

---

## 5. 入出力境界とプライバシー不変条件

- **入力バリデーション**:
  リクエスト引数（オプション・ボディ）は Zod スキーマの `.strict()` によりネットワーク送信およびトークン取得の前に検証されます。未対応の不正なキーや型不一致は事前検証で弾かれます。
- **日付・時刻フォーマット（明示的 RFC3339 オフセットの要求）**:
  - 終日予定の日付（`date`）は実在するカレンダー日付（YYYY-MM-DD、各月の日数・閏年判定を含む）を検証します。`2026-02-29` や `2026-02-30` などの不正な日付は拒否されます。
  - 時間指定予定の日時（`dateTime`）およびクエリ期間境界（`timeMin`/`timeMax` 等）は、ホスト環境に依存したローカルタイム解釈を排除し、安全に `Date.parse` による順序比較（`end > start`）を行うため、**明示的な RFC3339 オフセット（`Z` または `+HH:MM` / `-HH:MM`）を必須**とするサポートサブセットとして運用します（入力・Google レスポンスの双方で検証）。`timeZone` プロパティが併記されている場合でもオフセットなしの日時は受け付けません。
  - 任意の IANA `timeZone`（例: `Asia/Tokyo`）は `Intl.DateTimeFormat` により実在する識別子であることを検証します。
  - すべての期間（`end` と `start`、`timeMax` と `timeMin`）において厳格に `end > start` を要求します（同時刻・同日や終日・時間指定の混在は拒否）。
- **パスセグメントのトラバーサル遮断**:
  `calendarId` および `eventId` は空文字、空白のみ、境界空白、`.`、`..` を即座に拒否し、`encodeURIComponent` 処理を適用します。また不正な Unicode 孤立サロゲート等は `INVALID_INPUT` として安全に拒否されます。
- **Google レスポンスの未知フィールド除去**:
  Google から返却された未知のフィールド（参加者リスト、プロファイル画像、システム内部属性等）は出力オブジェクトから安全にストリップされます。
- **`freeBusy.query` のプライバシー保護**:
  - `busy` オブジェクトからは `start` と `end` のみを取得し、タイトル、場所、説明、参加者等の属性は完全に除去されます。
  - 正常な問い合わせにおいてビジー区間が存在しない場合（`busy: []`）は、空き時間（予定なし）として正当な成功レスポンスとして受理されます。
  - 一方で、`busy` 配列が存在せず非空の `errors` も存在しないような不完全なレスポンスは拒否されます。また、問い合わせたカレンダーがレスポンスに含まれなかった場合（未取得）は欠損として扱われ、暗黙に空き（`busy: []`）として偽装・補完することは厳格に禁止されています。

---

## 6. 要求スコープと設計メモ

1. **ACL 共有スコープ**:
   - Google 公式リファレンスでは `acl.insert` に必要なスコープとして `calendar` または `calendar.acls` が挙げられています。Task 1-3 スパイク実機検証において、基本の `calendar.app.created` のみでは権限不足（403 insufficientPermissions）となることを確認済みです（Q1(a)）。API 仕様上は広範な `calendar` スコープも選択肢として存在しますが、本プロジェクトでは最小権限の原則に基づき `calendar.acls` を選択し、Task 1-4 にてオーナーの招待リンク発行時に段階的認可（incremental authorization）で要求する設計を採用しています。
2. **`freeBusy.query` のスコープ**:
   - 将来の Phase 2（空き状況取得）に向けたクライアントメソッドとして実装していますが、Phase 1 の OAuth 認可スコープには `calendar.freebusy` は含まれていません（Phase 2 で段階的認可を実施予定）。
3. **`calendarList.insert` メソッド（歴史的経緯により保持、本番未使用）**:
   - Task 1-3 スパイク検証用にクライアントメソッドとして実装されましたが、スパイクによりこのメソッドの実行には `calendar.calendarlist` または `calendar` スコープが必要（403 拒否）であることが判明しました。Task 1-4 ではスコープを拡大せず、Google カレンダー共有通知メール（「カレンダーを追加」リンク）経由で参加者が自身のカレンダーに追加する方式を採用したため、本番アプリケーションコードからは呼び出されない歴史的メソッドとして保持されています。
