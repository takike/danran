# 20. 繰り返し予定（Task 3-1）

Task 3-1 では、家族カレンダー上に毎週または隔週の繰り返し予定を作成し、S4（`/routines`）で一覧・作成・シリーズ全体の削除を行う。週 API は各回をルーティンとして返す。Google Calendar が予定の正本で、個人カレンダーにはアクセスしない。

## API

すべて `familySecurityMiddleware` の認証・Origin・`X-Requested-With`・ボディサイズ制限を通す。リクエスト元は家族の active な大人でなければならない。未ログインは `401`、家族がないか利用者が active メンバーでない場合は `404`。カレンダー ID は受け取らず `families.family_calendar_id` を使用し、Google 呼び出しには利用者自身のトークンを使う。入出力は `src/shared/schemas/routines.ts` の共有 Zod schema で検証する。

| メソッド・パス | 用途 | 成功レスポンス |
|---|---|---|
| `POST /api/families/:id/routines` | 繰り返し予定を作成 | `{ "routineId": "...", "eventId": "..." }` |
| `GET /api/families/:id/routines` | 設定と Google の繰り返し予定本体を合わせて一覧 | `{ "routines": [...] }` |
| `DELETE /api/families/:id/routines/:routineId` | シリーズ全体を削除 | `{ "ok": true }` |

作成 JSON は `title`, `weekdays`, `interval`, `startDate`, `startTime`, `endTime`, `endDate`, `memberIds`, `assigneeMemberId`, `category`, `affectsAvailability`, `clientRequestId` を含む。曜日コードは `MO`〜`SU`、間隔は `1`（毎週）または `2`（隔週）。`endDate` と `assigneeMemberId` は `null` を指定でき、対象メンバーを空配列にすると家族全員対象。カテゴリは `lesson` / `housework` / `other`。

終了時刻は開始時刻より後でなければならない。終了日を指定するときは、開始日以降かつ選択曜日へ補正した初回の日付以降でなければならない。担当は同じ家族の active な大人に限り、対象メンバーは同じ家族の active メンバーに限る。繰り返し予定は時刻指定のみで、終日は作成しない。

一覧の各要素は `id`, `title`, `weekdays`, `interval`, `startDate`, `endDate`, `startTime`, `endTime`, `memberIds`, `assigneeMemberId`, `category`, `affectsAvailability`, `status` を持つ。`status` は `ready` / `missing` / `unsupported`。Google 上の master が消されている場合も D1 の設定を残して `missing` として表示する。対応外または解釈できない繰り返しルールは `unsupported` とし、取得できない Google の各フィールドは `null` または空配列で返す。

エラー応答・ログには Google の生レスポンス、予定本文、トークンを含めない。

| HTTP | `code` | 条件 |
|---:|---|---|
| 400 / 413 | `INVALID_INPUT` | 入力不正または本文サイズ超過 |
| 401 | `UNAUTHORIZED` / `REAUTH_REQUIRED` | ログインしていない、または再認証が必要 |
| 403 | `FORBIDDEN` / `CALENDAR_ACCESS_DENIED` | Origin 不許可、または Google が家族カレンダーへのアクセスを拒否 |
| 404 | `NOT_FOUND` | 家族の active な大人でない、または指定シリーズが見つからない |
| 409 | `FAMILY_NOT_READY` | 家族カレンダーが準備中 |
| 500 | `INTERNAL_ERROR` | 想定外の Worker / D1 エラー |
| 502 | `GOOGLE_ERROR` | Google Calendar の応答エラー |
| 503 | `GOOGLE_TEMPORARY_ERROR` | 再試行後も Google Calendar の一時障害が続く |

## 保存と Google Calendar の対応

タイトル、曜日、時間、開始・終了日、対象メンバーは Google の recurring master と private extended properties を正本とする。Google Calendar のイベントには `RRULE`、`Asia/Tokyo` のタイムゾーン付き開始・終了、`danran="1"`、`members`、`assignee`、`status="confirmed"`、`source="manual"` を保存する。RRULE は `FREQ=WEEKLY` と選択曜日の `BYDAY` を使い、隔週は `INTERVAL=2`、終了日がある場合は `UNTIL` を設定する。

開始日は選択曜日と一致しないことがある。その場合は開始日以降で選んだ曜日に当たる最初の日へ開始日を移してから Google へ送る。終了日は補正後の初回日付より前にはできない。Google の `UNTIL` は終了日の23:59:59 JSTを含む UTC RFC3339 値にする。複数曜日を選んだ場合は1つのシリーズにまとめる。作成したシリーズは常に確定状態。

D1 の `routine_settings` は `id`, `family_id`, `calendar_id`, `recurring_event_id`, `category`, `skip_holidays`, `skip_new_year`, `affects_availability`, `default_assignee_member_id`, `created_at`, `updated_at` を保持する。家族削除で連動削除し、担当メンバー削除時は担当を `null` にする。`(calendar_id, recurring_event_id)` は一意。`skip_holidays` と `skip_new_year` は初期値 false だが、このタスクでは UI に出さず、予定の回にも適用しない。

## 週 API と空き判定

週 API の各 `WeekEvent` は `affectsAvailability` を必ず持つ。ルーティン回に紐づく `routine_settings.affects_availability` が false の場合だけ false、それ以外は true。false の予定も週ビューと S2 に表示し、`getFreeWindows` のメンバー別 busy と共通空きの計算からだけ除外する。

## 再試行と失敗からの回復

作成時は `clientRequestId` から同じ家族・利用者に対して安定した Google event ID を使う。Google の private extended properties には、曜日と対象メンバーを順序固定・重複除去した予定設定入力の SHA-256 `routineRequestHash` を記録する。生の `clientRequestId` は保存しない。同じ UUID と同じ入力の再送は既存のシリーズを照合し、Google 上に重複作成せず D1 保存を回復する。同じ UUID で内容が異なるリクエストは拒否する。

結果が不明な作成エラーの後、クライアントは元の入力と UUID を固定する。フォーム項目は変更できないが、同じ内容の再試行とフォームを閉じる操作はできる。再試行では最初の POST と同一の JSON を送り、成功後に作成フォームを閉じる。

削除は Google の recurring master を削除してから D1 の設定を削除する。Google が `404` / `410`（既に削除済み）を返した場合も D1 を削除し成功とする。同じ削除操作は再試行できる。Google 操作と D1 は単一トランザクションではないため、Google 成功後に D1 障害が起きたときは同じ API 操作を再試行して整合させる。

## 画面範囲

`/routines` は一覧、追加フォーム、画面内の削除確認を提供する。フォームは曜日を複数選択でき、未保存の入力がある間は PWA 更新を保留する。保存失敗時は入力を残して案内を表示する。週画面の予定カードから繰り返し予定の編集・削除は行わず、編集は「準備中」と案内する。

このタスクではカテゴリフィルタ、直近4回、祝日・年末年始・休園日のスキップ、重複検出、回ごとの休止・振替、シリーズ内容の編集を扱わない。

## staging 確認

デプロイとマイグレーション適用後、人間が既存の staging アカウントで次を確認する。Google Cloud の設定、OAuth scope の追加、Secret 登録はこの手順に含まない。

1. `/routines` の空一覧を開き、フォームから複数曜日の毎週予定を作る。Google Calendar の家族カレンダーで繰り返し予定として見えることを確認する。
2. 別の隔週予定を作り、Google Calendar で2週ごとの曜日・時刻を確認する。
3. 開始日が選択曜日でない予定を作り、最初の回が開始日以降の選択曜日に移っていることを確認する。
4. `affectsAvailability` をオフにした予定が週ビューと S2 に表示され、週末カードと S2 の共通空き計算を狭めないことを確認する。
5. 一覧でシリーズ削除を選び、確認後に週ビューからも予定が消えることを確認する。
6. 予定を Google Calendar 側で削除した後、Danran の一覧で `missing` として残ることを確認する。

ローカルの Playwright API モックでは合成データを使う。実アカウントの staging 確認を自動テストの結果として扱わない。
