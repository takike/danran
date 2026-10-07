# 21. やること（tasks）

Task 5-1 の API と保存・生成規則。画面（S5）と週ビュー連携はそれぞれ Task 5-2、5-3 で扱う。

## 保存するもの

`tasks` は家族単位で管理する。期限は `due_kind`（`date` / `datetime` / `none`）と `due_at` で表し、完了・作成・更新時刻は epoch seconds で保存する。担当メンバーと `event_meta` は削除時に `NULL` になる。家族削除ではタスクも削除する。

手動作成は `clientRequestId` を使い、家族・作成ユーザー・UUID に基づく `source_ref` とタスク ID で同じ POST の再送を識別する。`source_ref` の一意制約は `source='manual'` の行だけに適用され、家族内で重複させない。`event_meta_id` と `source='items'` の部分一意インデックスにより、予定ごとの持ち物タスクは最大1件に制限する。

## 保存しないもの

予定のタイトル、日時、場所、説明は D1 に保存しない。持ち物タスクには固定タイトル「持ち物を準備」、`event_meta_id`、発生元だけを保存し、期限は `due_kind='none'` / `due_at=NULL` とする。期限は一覧を返すときに、Google Calendar から取得した現在のイベント開始日を使い、Asia/Tokyo の前日20:00として算出する。取得に失敗した場合は `due: { kind: 'unknown' }` とし、期限なしと区別する。

## API

すべての family endpoint は `familySecurityMiddleware` を通す。家族の active な大人だけが利用でき、非メンバーや他家族のリソースは404とする。変更系 endpoint は `X-Requested-With`、Origin 検査と16 KiBのボディ上限を適用する。Google Calendar の操作はリクエストした本人のトークンと、DB に保存された家族カレンダー ID を使う。

### `GET /api/families/:id/tasks`

未完了タスクと、完了後14日以内のタスクを返す。タスク一覧には件数上限を設けない。予定 ID は重複を除き最大200件までまとめて取得し、Google `events.list` は最大4ページ、各ページ最大2,500件を走査する。すべてのリンク先が見つかった場合はそこで走査を終える。予定情報の状態は `ready` / `missing` / `unavailable` / `none` で表す。見つからない予定や取得失敗では D1 を変更しない。`ready` の予定情報には ID、タイトル、日時、対象メンバー、持ち物だけを含める。

完全なページ走査が終わり Google で予定が見つからない場合、または Google 側で削除・キャンセル済みの場合は `missing`。Google 取得失敗、リンク先 ID が200件を超える場合、4ページ上限、または循環ページトークンで走査を完了できない場合は、すべてのリンク済み予定を `unavailable` とする。タスク一覧自体は全件返し、予定情報を `null` や空予定として偽装しない。自動タスクの期限は取得不能または missing なら `unknown` とする。GET は D1 と Google のどちらも変更しない。

ここでの読み取り専用保証はタスク・`event_meta` と Google Calendar の業務データに適用する。共通認証処理は既存 API と同じで、セッション期限切れの cleanup、Google がローテーションしたリフレッシュトークンの暗号化保存、返却された許可スコープの保存は従来どおり起こり得る。Task 5-1 では認証共通処理を変更しない。

レスポンス例：

```json
{
  "tasks": [
    {
      "id": "task-id",
      "title": "持ち物を準備",
      "due": { "kind": "datetime", "dueAt": "2026-10-07T20:00:00+09:00" },
      "doneAt": null,
      "assigneeMemberId": null,
      "source": "items",
      "linkedEvent": {
        "state": "ready",
        "eventId": "google-event-id",
        "title": "遠足",
        "time": { "kind": "all-day", "start": "2026-10-08", "endExclusive": "2026-10-09" },
        "memberIds": ["member-id"],
        "items": ["水筒"]
      }
    }
  ]
}
```

### `POST /api/families/:id/tasks`

手動タスクを作成する。入力はタイトル（1〜200文字）、期限（`none` / `date` / `datetime`）、担当（active な大人または `null`）、任意の家族予定 ID、UUID の `clientRequestId`。同じユーザーが同じ家族内で同じ UUID を再送したときは同じタスクを返す。子どもや他家族のメンバーは担当にできない。

入力例：

```json
{
  "title": "水筒を洗う",
  "due": { "kind": "date", "dueAt": "2026-10-08" },
  "assigneeMemberId": null,
  "eventId": null,
  "clientRequestId": "8e900000-0000-4000-8000-000000000001"
}
```

予定 ID を指定した場合は、その予定が家族カレンダーに存在し、繰り返し予定の本体ではないことを Google Calendar で確認する。対応する `event_meta` がなければ作成し、手動タスクを紐づける。

成功時は `{ "task": { ... } }` を返す。再送された既存タスクは HTTP 200、初回作成は HTTP 201。

### `PATCH /api/families/:id/tasks/:taskId`

担当と完了状態は全タスクで変更できる。完了時刻は完了にした時に設定し、未完了に戻すと `NULL` にする。同じ完了状態を繰り返し設定しても結果は変わらない。タイトル、期限、予定との紐づけは手動タスクのみ変更できる。自動タスクのタイトル・期限を変更しようとした場合は固定エラーコードで拒否する。

例：`{ "done": true }`。成功時は `{ "task": { ... } }`。

### `DELETE /api/families/:id/tasks/:taskId`

手動タスクだけ削除できる。`source='items'` の自動タスクは拒否する。自動タスクは予定の持ち物をすべて外すと削除される。

成功時は `{ "ok": true }`。

### エラー形式

エラーは `{ "error": "固定メッセージ", "code": "..." }`。Google のエラー詳細、URL、予定内容はエラー本文やログに含めない。

| HTTP | `code` | 主な条件 |
|---|---|---|
| 400 | `INVALID_INPUT` | Zod 検証失敗、子ども・非 active メンバーの担当、存在しない予定 ID |
| 401 | `UNAUTHORIZED` / `REAUTH_REQUIRED` | 未ログイン、Google 再認証が必要 |
| 404 | `NOT_FOUND` | 家族・タスクがない、active な大人の家族メンバーではない |
| 403 | `FORBIDDEN` | 変更系リクエストで CSRF ヘッダーまたは Origin の検査に失敗 |
| 409 | `FAMILY_NOT_READY` | 家族カレンダー準備中 |
| 409 | `AUTO_TASK_IMMUTABLE` | 自動タスクの削除、タイトル・期限・予定紐づけ変更 |
| 409 | `RECURRING_EVENT_UNSUPPORTED` | 繰り返し予定の本体をリンクしようとした |
| 413 | `INVALID_INPUT` | 16 KiBを超える変更リクエスト |
| 403 | `CALENDAR_ACCESS_DENIED` | Google が家族カレンダーへのアクセスを拒否 |
| 503 | `GOOGLE_TEMPORARY_ERROR` | Google の一時障害・レート制限 |
| 502 | `GOOGLE_ERROR` | その他の Google Calendar エラー |
| 500 | `INTERNAL_ERROR` | 内部処理失敗 |

## 自動生成と予定への追従

- 保存済み `event_meta.items_json` の要素数が1以上なら持ち物タスクを1件作る。0なら未完了・完了済みを問わず削除する。
- 持ち物タスクが既にある場合は変更しない。完了状態と担当者を保つ。
- 予定の変更・作成後は、リクエスト内の古い持ち物ではなく、保存済み `event_meta` を読み直して reconcile する。
- イベント日時は保存しない。期限は一覧取得ごとに Google の開始日時から算出するため、開始時刻の変更も次の GET に反映される。
- 予定削除では持ち物タスクを削除し、手動タスクは `event_meta_id` を `NULL` にして残す。タスクの変更と `event_meta` の削除は D1 の batch で実行する。
- Google への予定保存が成功した後に reconcile が失敗した場合は、予定 API を成功として返す。同じ予定を次に保存すると reconcile が再実行される。Google と D1 は単一トランザクションではないため、GET による自動修復は行わない。
- 予定を Google から削除した後に D1 batch が失敗した場合は予定 API がエラーを返す。同じ DELETE の再試行では Google 側の削除済み応答を成功扱いにしてから batch を再試行する。

プリント締切（`source='import'`）と重複連絡（`source='conflict'`）は Task 5-1 では生成しない。

## staging 確認

コードを staging に反映し、既存の staging アカウントで次を確認する。実予定の内容や個人情報はテスト記録やログに残さない。

1. 手動タスクを期限なし・日付・日時で作り、一覧に反映されることを確認する。同じ `clientRequestId` の POST 再送で重複しないことも API テストで確認する。
2. 家族予定に持ち物を付け、持ち物タスクが1件だけ出ることを確認する。予定の開始日時を変更した後、期限が新しい開始日の前日20:00になることを確認する。
3. 持ち物をすべて外し、完了済みを含む持ち物タスクが消えることを確認する。
4. 手動タスクを予定に紐づけた状態で予定を削除し、タスクが予定なしで残り、持ち物タスクが削除されることを確認する。
5. Google 取得不能状態は自動テストで確認する。実 staging で意図的な権限変更や Google 側障害を起こす必要はない。
