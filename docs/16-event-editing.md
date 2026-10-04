# 16. 家族予定の作成・編集・削除（Task 1-8）

週ビューから家族カレンダー上の単発予定を管理する。予定の日時とタイトルは Google Calendar を正本とする。対象メンバーは Google イベントの private extended properties に保存する。担当・状態・由来は Google 側と D1 の `event_meta` に保存し、持ち物は D1 の `event_meta.items_json` に保存する。個人カレンダーや free/busy にはアクセスしない。

## API 契約

すべて既存の `securityMiddleware` の認証、Origin、`X-Requested-With`、16 KiB のボディサイズ制限を通す。カレンダー ID はリクエストから受け取らず、家族レコードの `family_calendar_id` を使う。Google 呼び出しはリクエストした active メンバー本人のトークンを使い、通知は送らない（`sendUpdates=none`）。共有 Zod スキーマはリクエストの形・日時・文字列長・配列上限を検証し、家族内の active メンバー ID と大人の担当者という所属条件は Worker が D1 の家族データに照らして検証する。

| メソッド・パス | 用途 | 成功レスポンス |
|---|---|---|
| `POST /api/families/:id/events` | 単発予定の作成 | `{ "eventId": "..." }` |
| `PATCH /api/families/:id/events/:eventId` | 予定の全編集 | `{ "eventId": "..." }` |
| `DELETE /api/families/:id/events/:eventId` | 予定の削除 | `{ "ok": true }` |

POST と PATCH の JSON は `title`, `time`, `memberIds`, `assigneeMemberId`, `items`, `status` を含む。`time` は週 API と同じ終日または時刻指定の形式で、`endExclusive` を使う。POST は再試行を識別する UUID の `clientRequestId` も受け取る。日時・メンバー・担当・長さの検証は共有 Zod スキーマで行う。

- タイトルは trim 後に1〜200文字。
- 持ち物は最大20件、各項目は trim 後に1〜100文字。
- `memberIds` は最大100件（各 ID は最大200文字）。ID は同じ家族の active メンバーに限り、重複を除いた CSV 値は Google Calendar private extended property の上限に合わせて1024文字以内とする。担当は大人の active メンバー1人か `null`。
- 家族が準備中なら `409 FAMILY_NOT_READY`。未ログインは `401`、家族が存在しないか利用者が active メンバーでなければ `404`。
- `recurringEventId` または `recurrence` を持つイベントの PATCH / DELETE は固定コードで拒否する。繰り返し単位や個別回の変更は Phase 3。
- エラーは固定の `error` と `code` を返す。Google の本文、予定内容、アクセストークンは返さず、ログにも記録しない。

| HTTP | `code` | 条件 |
|---:|---|---|
| 400 | `INVALID_INPUT` | 入力形式・日時・所属条件が不正 |
| 401 | `UNAUTHORIZED` / `REAUTH_REQUIRED` | セッションが無効、または Google 再認証が必要 |
| 403 | `FORBIDDEN` / `CALENDAR_ACCESS_DENIED` | Origin が許可されない、または Google が家族カレンダーへのアクセスを拒否 |
| 404 | `NOT_FOUND` | 家族・予定が存在しない、または利用者が active メンバーでない |
| 409 | `FAMILY_NOT_READY` / `RECURRING_EVENT_UNSUPPORTED` | 家族未準備、または繰り返し予定の変更 |
| 502 | `GOOGLE_ERROR` | Google の応答が不正、またはその他の Google エラー |
| 503 | `GOOGLE_TEMPORARY_ERROR` | Google の一時障害 |
| 500 | `INTERNAL_ERROR` | 想定外の内部エラー |
| 413 | `INVALID_INPUT` | リクエスト本文が16 KiBを超える |

Google Calendar の private extended property 値は1024文字までです（[Google Calendar API extended properties](https://developers.google.com/workspace/calendar/api/guides/extended-properties)）。

## 保存・再試行

Google イベントの `extendedProperties.private` に `danran="1"`、`members`（CSV）、`assignee`、`status`、`source="manual"` を書く。更新時は未知の private extended property を保持する。Google Calendar で作られた外部予定を編集したときは Danran marker を付ける。D1 には `event_meta` の `(calendar_id,event_id)` キーで持ち物・担当・状態・由来を保存する。既存スキーマを使い、Task 1-8 のスキーマ変更はない。

Google REST の PATCH では、終日と時刻指定を切り替える場合に古い日時フィールドが残らないよう、使用しない nested field を明示的に `null` で送る。時刻指定は `date: null` と `dateTime` / `timeZone`、終日は `date` と `dateTime: null` / `timeZone: null` を送る。共有 API の `time` 入力形式は変わらない。

Google event ID は家族 ID・リクエストユーザー ID・UUID の `clientRequestId` から決定する。初回入力は ID の決定には使わない。Google insert が同じ ID による `409` を返した場合は既存イベントを取得して処理を続けるため、同じ POST の再送で予定を重複作成しない。クライアントは初回に送った POST 入力を固定し、結果が曖昧な失敗の後も同じ UUID と同じ入力で再送する。失敗後に利用者がフォームを変更していた場合は、POST の回復後に同じイベントへ最新入力を PATCH する。作成 POST の D1 insert は競合時に既存行を保持し、遅れて届いた再送が後から保存された持ち物等を上書きしない。Google insert 後に D1 insert が失敗した場合、同じ POST を再送すると Google 上のイベントを再利用し、D1 保存を完了できる。作成後の PATCH が失敗した場合は解決済みの event ID で PATCH を再試行し、イベントを再作成しない。通常の同時編集は楽観ロックを設けず、後から保存された更新が勝つ。

削除では Google が `404` / `410`（対象イベントが既にない）を返した場合も成功とし、D1 の `event_meta` を削除する。Google と D1 は単一トランザクションではない。作成の部分失敗は同じ `clientRequestId` と元の入力で回復できる。入力を変更した場合は、作成回復後に PATCH する。更新・削除は Google の成功後に D1 を反映するため、D1 障害時は週 API が一時的に古い持ち物を返したり、削除済み予定のメタデータが残ったりする可能性がある。週 API の取得だけでは D1 を修復しない。更新は同じ PATCH、削除は同じ DELETE を再試行して D1 を整合させる。Google API への部分成功をエラー本文から推測させない。

## 週 API のメタデータ取得

週 API は返却対象イベント ID と繰り返しシリーズ ID に絞って `event_meta` を読む。D1 のバインド数上限を超えないよう、ID 集合は小さなチャンクに分けて問い合わせる。Google Calendar 側で直接変更された開始・終了時刻は次回の週取得で反映し、D1 の持ち物および Google private metadata の対象メンバー・担当・状態・由来は維持する。

## UI の範囲と staging 確認

週画面から単発予定を追加・編集・削除できる。保存失敗では入力を保持し、繰り返し予定の変更は案内を表示する。添付、説明、場所、空き時間からの作成、繰り返し予定の作成・変更は含まない。

実 Google / staging の確認はまだ行っていない。staging へのコード配信後、人間が既存 staging アカウントで、(1) 家族予定を作成して共有 Google カレンダーに表示されること、(2) 終日予定を時刻指定へ、時刻指定を終日へ切り替えて保存し、両方の変更が Google Calendar に反映されること、(3) Google Calendar で時刻を変更して週画面が追従すること、(4) 対象・担当・候補状態・持ち物が保持されること、(5) 編集・削除と他の active メンバーの操作を確認する。Google / Cloudflare アカウント上の新しい設定、追加 scope、手動デプロイはこのタスクで行っていない。
