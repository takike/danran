# 20. 繰り返し予定（Task 3-1、3-2）

Task 3-1 では、家族カレンダー上に毎週または隔週の繰り返し予定を作成し、S4（`/routines`）で一覧・作成・シリーズ全体の削除を行う。Task 3-2 では、直近4回を表示し、個別の回を休止・振替・復元する。週 API は各回をルーティンとして返す。Google Calendar が予定の正本で、個人カレンダーにはアクセスしない。

## API

すべて `familySecurityMiddleware` の認証・Origin・`X-Requested-With`・ボディサイズ制限を通す。リクエスト元は家族の active な大人でなければならない。未ログインは `401`、家族がないか利用者が active メンバーでない場合は `404`。カレンダー ID は受け取らず `families.family_calendar_id` を使用し、Google 呼び出しには利用者自身のトークンを使う。入出力は `src/shared/schemas/routines.ts` の共有 Zod schema で検証する。

| メソッド・パス | 用途 | 成功レスポンス |
|---|---|---|
| `POST /api/families/:id/routines` | 繰り返し予定を作成 | `{ "routineId": "...", "eventId": "..." }` |
| `GET /api/families/:id/routines` | 設定と Google の繰り返し予定本体を合わせて一覧 | `{ "routines": [...] }` |
| `DELETE /api/families/:id/routines/:routineId` | シリーズ全体を削除 | `{ "ok": true }` |
| `POST /api/families/:id/routines/:routineId/instances/:instanceId/skip` | その回だけ休みにする | `{ "instance": ... }` |
| `POST /api/families/:id/routines/:routineId/instances/:instanceId/restore` | 休み・振替を元の日時へ戻す | `{ "instance": ... }` |
| `POST /api/families/:id/routines/:routineId/instances/:instanceId/move` | その回を別日時へ振り替える | `{ "instance": ... }` |

一覧の各 `ready` 項目は `upcoming: { status, instances }` を持つ。`status` は `ready` / `unavailable`、`instances` は次の回を最大4件含む。取得できないシリーズだけ `unavailable` となり、一覧全体の取得は続ける。`missing` / `unsupported` の項目は空の `ready` とする。

Google [`events.instances`](https://developers.google.com/workspace/calendar/api/v3/reference/events/instances) の `timeMin` は実際の回の終了時刻を対象にするため、`timeMin=now` を使うと、元は今後の回でも過去へ振り替えたものが取得結果から外れる。このため Google からは1970年から2051年1月1日未満までをページングして取得し、元の開始日時が今日以降の回に絞ってから元の日時順に4件を選ぶ。繰り返し予定の RRULE は変更せず、取得対象期間だけを2051年未満にする。Google の `orderBy` は使わない。各シリーズの取得は最大25ページ（1ページ最大2500件）とし、シリーズの並列数は4件までに制限する。上限を超える取得失敗はそのシリーズだけ `unavailable` とし、部分的な結果を返さない。

各 instance は `id`, `originalStart`, `originalEnd`, `start`, `end`, `status` を持つ。日時は Asia/Tokyo の RFC3339（`+09:00`）。`start` / `end` は Google が示す実際の日時で、休みの回は `null`。状態は Google の `cancelled` を `skipped`、実際の日時または長さが元と異なる回を `moved`、それ以外を `normal` として返す。直近4回の選択は実際の日時ではなく元の開始日時順に行うため、振替後もシリーズ内の元の位置に表示される。

回の変更要求では `routineId` と Google の instance ID の両方を検証する。instance の `recurringEventId` が指定シリーズと一致し、家族カレンダー上にあることを確認するため、別の家族・別シリーズ・単発予定の ID は変更できない。`skip` と `restore` の本文は空の JSON object `{}`。`move` は `{ "date": "YYYY-MM-DD", "startTime": "HH:mm", "endTime": "HH:mm" }` で、同じ日の時刻指定とし、日付は1970〜2050年。過去日も記録用に指定できる。時刻は開始より後でなければならない。

Google `events.patch` では `sendUpdates=none` を使い、開始・終了に `dateTime` と `timeZone: "Asia/Tokyo"` を送り、同じオブジェクトの `date` は `null` にする。振替の取消しは、休止前・振替前を問わず、回を `confirmed` にして元の開始・終了へ戻す。`extendedProperties.private` にある対象メンバーや担当者は維持する。同じ操作の再送は同じ状態に収束する。

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

`/routines` は一覧、追加フォーム、画面内の削除確認に加え、各カードに直近4回の日付チップを表示する。休みは取り消し線と「お休み」、振替は元の日付・時刻と振替先を示す。チップを押すとカード内に操作が開き、通常回は休止・振替、休みは復元・振替、振替は元に戻す・振替先変更を選べる。振替入力を開いている間は PWA 更新を保留する。操作中は同じカードの操作を無効にし、失敗時は固定の案内を表示して変更前の表示を保つ。週クエリを無効化し、週ビューと S2 のデータを再取得する。

週ビューまたは S2 で繰り返し予定を選ぶと、「この予定は繰り返し予定です。休み・振替は『繰り返し』タブで設定できます。」と「繰り返し」タブへのリンクを表示する。シリーズ全体の変更は引き続き S4 から行う。

このタスクではカテゴリフィルタ、祝日・年末年始・休園日の自動スキップ、重複検出、シリーズ内容の編集を扱わない。

## staging 確認

デプロイとマイグレーション適用後、人間が既存の staging アカウントで次を確認する。Google Cloud の設定、OAuth scope の追加、Secret 登録はこの手順に含まない。

1. `/routines` の空一覧を開き、フォームから複数曜日の毎週予定を作る。Google Calendar の家族カレンダーで繰り返し予定として見えることを確認する。
2. 別の隔週予定を作り、Google Calendar で2週ごとの曜日・時刻を確認する。
3. 開始日が選択曜日でない予定を作り、最初の回が開始日以降の選択曜日に移っていることを確認する。
4. `affectsAvailability` をオフにした予定が週ビューと S2 に表示され、週末カードと S2 の共通空き計算を狭めないことを確認する。
5. 一覧でシリーズ削除を選び、確認後に週ビューからも予定が消えることを確認する。
6. 予定を Google Calendar 側で削除した後、Danran の一覧で `missing` として残ることを確認する。
7. 毎週のシリーズで次の4回が元の日付順に表示されることを確認し、1回を休みにして Google Calendar でその回だけがキャンセル表示になることを確認する。Danran から休みを取り消し、元の日時に戻ることを確認する。
8. 別の回を未来または過去の日付へ振り替え、Google Calendar でその回だけの日時が変わることを確認する。振替を取り消し、元の日時に戻ることを確認する。振替前後も private extended properties の対象・担当が維持されることを確認する。
9. Google 側で回の更新権限がない場合は、Danran に固定のエラー案内が出て表示が更新されないことを確認する。

ローカルの Playwright API モックでは合成データを使う。Task 3-2 の Google Calendar 実アカウント staging 確認は人間による確認が必要であり、自動テストの結果として扱わない。Task 3-1 の staging 手順も人間による確認項目として残る。
