# 20. 繰り返し予定（Task 3-1〜3-5）

Task 3-1 では、家族カレンダー上に毎週または隔週の繰り返し予定を作成し、S4（`/routines`）で一覧・作成・シリーズ全体の削除を行う。Task 3-2 では、直近4回を表示し、個別の回を休止・振替・復元する。Task 3-3 では祝日・年末年始設定に基づいて通常回を自動でお休みにし、設定をオフにした場合は該当する自動スキップだけを復元する。Task 3-4 では、単発家族予定と確定済みの繰り返し回の重複を検出し、S4 の操作と週ビューの印で知らせる。Task 3-5 では、週 API が繰り返しの回か（`isRecurring`）と通常回か（`isRoutine`）を別々に返し、振替・開始時刻変更をした回を週ビューで目立たせる。Google Calendar が予定の正本で、個人カレンダーにはアクセスしない。

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
| `PATCH /api/families/:id/routines/:routineId/settings` | 祝日・年末年始の設定を保存して適用または復元 | `{ "skipHolidays": boolean, "skipNewYear": boolean, "hasMore": boolean }` |
| `POST /api/families/:id/routines/:routineId/auto-skips/apply` | 現在の設定で適用範囲を補完 | `{ "skipHolidays": boolean, "skipNewYear": boolean, "hasMore": boolean }` |

一覧の各項目は `upcoming: { status, instances }` を持つ。`status` は `ready` / `unavailable`、`instances` は次の回を最大4件含む。直近回の取得に失敗したシリーズだけ `unavailable` となり、一覧全体の取得は続ける。Google で削除を確認した `missing` と、取得済みの本体が対応外だった `unsupported` は空の `ready` とする。外部リクエスト上限に達して本体を読めなかった場合は、誤って `missing` とせず、`unsupported` と空の `unavailable` を組み合わせて取得不能を示す。Task 3-3 後は各項目に `skipHolidays`, `skipNewYear`, `autoSkipDue` を返し、各 upcoming instance が自動適用によってキャンセル中の場合にその理由 `autoSkipReason`（`holiday` / `new_year`）を含める。それ以外は `null`。`GET` は読み取り専用で、Google Calendar を変更しない。

`/routines` の各 API リクエストでは、Google アクセストークンをリクエスト内のメモリだけで再利用する。保存やリクエスト間の共有はしない。`GET /api/families/:id/routines` の外部リクエスト予算は OAuth と Calendar REST の合計48回。直近4回が1ページで取れる典型的な10シリーズでは、トークン取得1回、master取得10回、instances取得10回、重複確認1回の計22回となる。重複確認が4ページまで必要な場合も計25回で、ページングや再試行の余裕を残す。シリーズ並列数4と一覧全体で1回の重複確認は維持する。上限到達時も一覧を返し、該当する直近回、本体または重複確認だけを取得不能として示す。

Google [`events.instances`](https://developers.google.com/workspace/calendar/api/v3/reference/events/instances) の `timeMin` は実際の回の終了時刻を対象にするため、`timeMin=now` を使うと、元は今後の回でも過去へ振り替えたものが取得結果から外れる。このため Google からは JST の今日の31日前 00:00 から今日の120日後 00:00 までを取得する（`timeMax` の境界は含まない）。取得した回は元の開始日が今日以降のものに絞ってから、元の日時順に4件を選ぶ。繰り返し予定の RRULE は変更せず、Google の `orderBy` も使わない。取得範囲外、つまり今日の31日前より前に終了する回や、今日の120日後 00:00 以降に始まる回は候補に含まれない。このため、元の予定日が今日以降でも、過去へ大きく振り替えて実際の終了が範囲より前になった回は表示されない。各シリーズの取得は最大4ページ（1ページ最大250件）とし、シリーズの並列数は4件までに制限する。4ページ以内に取得が終わらない場合はそのシリーズだけ `unavailable` とし、部分的な結果を返さない。

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

D1 の `routine_settings` は `id`, `family_id`, `calendar_id`, `recurring_event_id`, `category`, `skip_holidays`, `skip_new_year`, `affects_availability`, `default_assignee_member_id`, `auto_skip_applied_until`, `created_at`, `updated_at` を保持する。家族削除で連動削除し、担当メンバー削除時は担当を `null` にする。`(calendar_id, recurring_event_id)` は一意。`skip_holidays` と `skip_new_year` は初期値 false。

`routine_auto_skips` は自動でお休みにする回の記録で、`id`, `routine_settings_id`, `original_start`, `reason`（`holiday` / `new_year`）, `status`（`applied` / `overridden`）, `created_at` を持つ。`(routine_settings_id, original_start)` は一意で、シリーズ設定の削除に連動して消す。Google イベントのタイトル・場所・説明などの内容は保存しない。`status: applied` は自動キャンセル済み、または曖昧な Google 応答後の再試行で照合するため保持中の記録を表す。`overridden` は利用者がその自動処理を上書きした記録で、後者は以後の自動適用・復元から除外する。`auto_skip_applied_until` は適用済み範囲の終端日を表す nullable な日付。

## 祝日・年末年始の自動スキップ（Task 3-3）

この機能に Cron は使わない。Google Calendar の変更は、設定を保存した利用者のリクエスト、または `/routines` 表示後に行う補完リクエストで、その利用者自身の Google トークンを使って実行する。利用者が操作していないときに自動で Google Calendar を変更する処理はない。追加の OAuth scope は要求しない。

対象範囲は Asia/Tokyo の今日から183日後までで、両端を含む。設定をオンにした時点でこの範囲を適用する。さらに `GET /api/families/:id/routines` が示す `autoSkipDue` が true のシリーズは、S4 の一覧を表示した後に同じ apply API で範囲を補完する。`autoSkipDue` は、少なくとも一方の設定がオンで、`auto_skip_applied_until` が未設定または今日から150日後より前なら true。半年以上 `/routines` を開かなければ、その時点での適用範囲より先にある回はお休みにならない。

対象日は `skipHolidays` がオンなら日本の祝日（振替休日を含む）、`skipNewYear` がオンなら12/29〜1/3。両方に該当する1/1は `holiday` を優先する。休園日のスキップと、年末年始期間を家族ごとに変更する設定は対象外。対象日は `originalStart` の Asia/Tokyo 日付で判定し、今日以降の通常回だけを変更する。すでにキャンセル済みの回、振替済みまたは開始・終了時刻や長さを手動変更した回、手動操作で `overridden` と記録された回は自動処理から除く。RRULE は変更しない。

設定 API の PATCH 本文は `{ "skipHolidays": boolean, "skipNewYear": boolean }` で、両方の値を必須とする。設定値を先に保存してから、オンにした理由の適用とオフにした理由の復元を行う。apply API の本文は空の JSON object `{}`。両 API は設定値と `hasMore` を返す。同じリクエストで変更する回は最大20件（キャンセルと復元を合わせて20件）とし、続きがあれば `hasMore: true` を返す。画面は同じ apply API を続けて呼び、完了まで「適用中...」を表示する。OAuth トークン更新と Google Calendar REST（リトライを含む）の外部呼び出しは、合計で1リクエストあたり最大48回に制限する。同じリクエスト内では利用者自身のアクセストークンをメモリ上で再利用する。上限に達して完了できない場合は失敗として返し、未確定の自動スキップ記録を残して再試行に備える。続きの API リクエストでは改めて本人のトークンを使う。

キャンセル対象は `events.patch` で `status: "cancelled"` にし、`sendUpdates=none` を指定する。オフにした理由の `applied` 記録について、今日以降の回がまだキャンセル状態なら元の日時へ `confirmed` で復元して記録を削除する。過去回は Google Calendar を変えずに履歴を削除する。自動スキップ回を S4 から手動で復元または振替した場合は、記録を削除せず `overridden` として保持する。これにより設定がオンのままでも再キャンセルせず、後から設定をオフにしても触れない。自動履歴の状態はアプリ内の手動復元・振替で更新する。

Google を変更する前に履歴行を作る。Google が明確に拒否した場合は失敗した行を整理し、応答が曖昧な場合は行を残す。再試行ではその回の Google 現在状態を確認し、通常回ならキャンセルを再試行し、キャンセル済みなら適用済みに収束させる。設定は保存済み値を表示するため、途中失敗後もトグルを巻き戻さない。再試行成功後に一覧を再取得し、残りがあれば続きも処理する。

## 週 API と空き判定

週 API の各 `WeekEvent` は `isRecurring`, `isRoutine`, `movedFrom`, `affectsAvailability` を持つ。`isRecurring` は Google の `recurringEventId` の有無で決まり、通常回・例外回とも true。`isRoutine` は通常回だけ true。開始日時を変えた例外回は `movedFrom` に元の開始日時を Asia/Tokyo の `+09:00` 付き ISO 文字列で示し、単発予定・通常回では `null`。元の開始が終日なら、元の日付の Asia/Tokyo 午前0時（`getDayBounds(date).startIso`）を表す値にする。

週 API の例外判定では、既存の `events.list(singleEvents=true)` が返す個別回だけを使い、Google 呼び出しを追加しない。実際の開始日時と `originalStartTime` を比較する。時刻付き日時は同一 instant に正規化し（`Z` と等価な `+09:00` は同じ）、終日は日付で比較する。開始日時が違えば例外回として `isRoutine: false` と `movedFrom` を設定する。シリーズ master の本来の長さを取得しない制約があるため、終了だけを変えた回は通常回として扱う。`originalStartTime` がない繰り返し回は保守的に通常回（`isRecurring: true`, `isRoutine: true`, `movedFrom: null`）とする。

S4 の回状態表示は Google の実際の日時・長さと元の日時・長さを比べる既存判定を続ける。ここでの開始時刻だけの制限は週 API の分類に限る。

`affectsAvailability` は引き続き recurring series の `recurringEventId` と `routine_settings.affects_availability` で決める。設定が false なら通常回・例外回とも false、それ以外は true。false の予定も週ビューと S2 に表示し、`getFreeWindows` のメンバー別 busy と共通空きの計算からだけ除外する。

週ビューでは `isRecurring` が繰り返しアイコンと編集案内を決める。`isRoutine` は compact／expanded、グレー表示、「ルーティンを隠す」を決めるため、例外回は隠さず非ルーティン予定と同じ見た目にする。異なる日への振替は「振替（10/20 から）」、同じ Asia/Tokyo の日付内で開始時刻だけ変えた回は「時間変更」と表示する。S2 では幅に余裕があるブロックに同じ印を出し、読み上げ用一覧には幅にかかわらず印を含め、振替の場合は元の日付も示す。

## 再試行と失敗からの回復

作成時は `clientRequestId` から同じ家族・利用者に対して安定した Google event ID を使う。Google の private extended properties には、曜日と対象メンバーを順序固定・重複除去した予定設定入力の SHA-256 `routineRequestHash` を記録する。生の `clientRequestId` は保存しない。同じ UUID と同じ入力の再送は既存のシリーズを照合し、Google 上に重複作成せず D1 保存を回復する。同じ UUID で内容が異なるリクエストは拒否する。

結果が不明な作成エラーの後、クライアントは元の入力と UUID を固定する。フォーム項目は変更できないが、同じ内容の再試行とフォームを閉じる操作はできる。再試行では最初の POST と同一の JSON を送り、成功後に作成フォームを閉じる。

削除は Google の recurring master を削除してから D1 の設定を削除する。Google が `404` / `410`（既に削除済み）を返した場合も D1 を削除し成功とする。同じ削除操作は再試行できる。Google 操作と D1 は単一トランザクションではないため、Google 成功後に D1 障害が起きたときは同じ API 操作を再試行して整合させる。

## 画面範囲

`/routines` は一覧、追加フォーム、画面内の削除確認に加え、各カードに直近4回の日付チップを表示する。初回取得中はカード形状のプレースホルダーを2件表示し、別タブから戻ったときは同じユーザー・家族のキャッシュをすぐ表示して裏で再取得する。休みは取り消し線と「お休み」、振替は元の日付・時刻と振替先を示す。チップを押すとカード内に操作が開き、通常回は休止・振替、休みは復元・振替、振替は元に戻す・振替先変更を選べる。振替入力を開いている間は PWA 更新を保留する。操作中は同じカードの操作を無効にし、成功応答で対象チップを即時更新してから、一覧を裏で再取得する。再取得中も既存の一覧・カード・チップを表示し続け、成功したら新しい一覧を反映する。一時的な再取得失敗ではキャッシュを保ち、固定の案内と再試行を表示する。401 / 403 / 404、認証セッション喪失、ユーザーまたは家族の切り替えでは以前の内容を隠す。週クエリを無効化し、週ビューと S2 のデータを再取得する。

週ビューまたは S2 で繰り返し予定を選ぶと、「この予定は繰り返し予定です。休み・振替は『繰り返し』タブで設定できます。」と「繰り返し」タブへのリンクを表示する。シリーズ全体の変更は引き続き S4 から行う。

このタスクではカテゴリフィルタ、休園日の自動スキップ、シリーズ内容の編集を扱わない。祝日・年末年始の自動スキップは Task 3-3、単発予定との重複検出は Task 3-4 の範囲。

## 単発予定との重複（Task 3-4）

重複は `src/shared/domain/conflicts.ts` の純粋関数 `getRoutineConflicts` で判定する。対象は、確定済みで時刻指定の繰り返し回と、確定済みの単発家族予定。重複するのは同じ active 家族メンバーが関わり、実際の時間区間が重なる組。時刻指定は半開区間として扱うので、終了と開始が接するだけなら重複しない。単発の終日予定は Asia/Tokyo の日付範囲（終了日を含まない）として比較する。振替・時間変更された回は実際の日時で判定する。候補、休みの回、繰り返し同士、終日の繰り返し回は対象外。対象に `affectsAvailability` は影響しない。

関わるメンバーは対象メンバーと担当者の和集合。Google の対象メタデータは週 API と同様に active メンバー ID だけに正規化し、その結果が空なら全 active 家族メンバーを対象とする。担当だけが共通する場合も重複とする。ページ境界などで同じ予定 ID が複数回入力されても、同じ回・単発予定の組は1件だけ表示する。

`GET /api/families/:id/routines` の `upcoming` に `conflictsStatus`（`ready` / `unavailable`）を追加し、各 upcoming 回に `conflicts: [{ id, title, time }]` を返す。`time` は週 API の `WeekEvent.time` と同じ時刻指定または終日形式。家族カレンダーの単発予定は一覧全体でまとめて読み、各シリーズ・各回ごとには取得しない。対象は全シリーズの active upcoming 回が実際に占める区間で、`timeMin` は最も早い開始日の JST 0時。`timeMax` は最も遅い実際の `endExclusive` が JST 0時ならその時刻、そうでなければその終端日の翌日0時とする。取得は最大4ページ、各ページ最大2,500件。次ページが残る、ページトークンが空・循環する、Google の取得に失敗する、upcoming 回が取得結果に含まれない、イベントの時刻が不正な場合は `unavailable` とする。未知の家族メンバー ID は除去し、それだけでは `unavailable` にしない。直近回の一覧はそのまま返し、空の重複配列を「重複なし」と見せない。active upcoming 回がないときはイベント取得を省略し、`ready` と空配列を返す。Google の家族カレンダーだけを読み、個人カレンダーにはアクセスしない。週 API と保存データは変更しない。

週ビューでは週 API が返す家族予定から同じ純粋関数を使い、重なる単発予定と繰り返し回の両方に警告アイコンと「重複」の印を付ける。S4 では重複回のチップと解決パネルを表示し、単発予定のタイトル・日時、既存の「この回を休む」「振替を設定」操作を並べる。回の休止・振替後は一覧を再取得し、解消したパネルを消す。取得できない場合は「重複を確認できませんでした」と案内する。

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

### Task 3-3 の staging 確認

staging にマイグレーションとアプリを反映した後、人間が合成の繰り返し予定を使って確認する。Google Cloud のスコープ変更や Secret 登録は不要。実行主体の Google アカウント自身が家族カレンダーを更新できることを前提とする。

1. JST の今後183日以内に祝日または12/29〜1/3に当たる予定を持つテスト用シリーズを作る。S4 を開き、「祝日はお休み」または「年末年始はお休み」をオンにする。処理中表示の後に、該当する通常回だけ Google Calendar 上でキャンセルされ、S4 のチップに理由が表示されることを確認する。
2. その設定をオフにし、自動でお休みにした未来の回だけが元の日時に復元されることを確認する。手動でお休みにした回は復元されない。
3. 別の回を自動でお休みにした後、S4 から手動で「休みを取り消す」。その後、設定をオフにして再度オンにし、再び自動スキップが適用されてもその回がキャンセルされないことを確認する。画面の再読込だけでは補完 API が起動しない状態（`autoSkipDue: false`）もあるため、`POST .../auto-skips/apply` を使った確認も行う。
4. 自動でお休みにした別の回を手動で振り替える。後続の自動適用・設定オフ処理がその回を変更せず、手動の日時を維持することを確認する。
5. 1シリーズに20件を超える対象回を用意できる場合は、1回の応答で最大20件だけが変更され、`hasMore` に応じて画面が続きの呼び出しを行い、最後まで適用または復元することを確認する。
6. staging で管理可能な一時的な Google API エラー条件を使い、設定値は保存されたまま固定のエラー案内と再試行が表示されることを確認する。条件を戻して再試行し、Google と D1 の状態が一致することを確認する。結果が曖昧な失敗では記録を残し、再試行で Google の現在状態と照合して完了することを確認する。
7. `autoSkipDue` のシリーズがある状態で `/routines` を開く。一覧表示を待たせずに補完が始まり、成功後に理由つきチップへ更新されることを確認する。補完に失敗しても一覧は表示され、再試行できる。

### Task 3-4 の staging 確認

実 Google アカウントによる staging 確認は人間が合成予定で行う。家族カレンダーに限り、個人カレンダーや追加スコープは使わない。

1. 同じ active メンバーを対象にした、毎週土曜9:30のピアノと、10:00開始の単発「運動会」を作る。S4 でその upcoming 回に「重複」の印と解決パネルが表示され、運動会のタイトル・日時が読めることを確認する。
2. パネルから「この回を休む」を選び、既存の休み操作が完了した後に重複の印とパネルが消えることを確認する。
3. 別の重複する回から「振替を設定」を選び、既存の振替フォームで日時を変更する。完了後、回の実際の時間が重ならなければ印とパネルが消えることを確認する。
4. 単発予定を別のメンバーだけに割り当てた場合、候補にした場合、時刻の端点だけを接した場合に重複表示されないことを確認する。終日の単発予定はその日と複数日それぞれの対象回を覆い、排他的な終了日には重複しないことを確認する。別の同一メンバーの単発予定を重ね、同じ回に複数件を表示できることも確認する。
5. S1 の週ビューで、重なる単発予定と繰り返し回の両方に「重複」の印と読み上げラベルが出ることを確認する。どちらかを休止または振替した後、週ビューを再取得すると印が消えることを確認する。
6. API モックテストでは単発イベント取得の失敗・ページ上限到達時も直近回が維持され、`conflictsStatus: unavailable` と控えめな案内になり、空の配列を重複なしと解釈しないことを確認する。staging で障害を人為的に起こす必要はない。

実アカウントで行う前に、合成データ以外の繰り返し予定が対象に含まれないこと、手動変更した回を上書きしないことを確認する。この機能は Cron を使わないため、利用者が `/routines` を開かない期間は適用範囲を先へ進めない。半年以上画面を開かなかった場合、その期間の先にある該当回は自動でお休みにならない。休園日の回は対象外。

ローカルの Playwright API モックでは合成データを使う。Task 3-2 の Google Calendar 実アカウント staging 確認は人間による確認が必要であり、自動テストの結果として扱わない。Task 3-1 の staging 手順も人間による確認項目として残る。
