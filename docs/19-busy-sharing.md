# 19. 空き状況の共有設定（Task 2-2）

このタスクでは、大人のメンバーが追加同意を行い、空き状況に使う個人カレンダーを選んで保存します。カレンダーの busy 取得 API や週ビューへの反映は Task 2-3 以降で行います。このタスクでは `freeBusy.query` を呼びません。

## プライバシーと保存範囲

- カレンダー一覧はリクエストした本人の Google トークンで取得し、その本人への応答にだけ返します。他のメンバーが誰のどのカレンダーを選んだかを知る API や画面は作りません。
- D1 `member_calendars` に保存するのは、本人が選んだ Google カレンダー ID と用途別フラグ `display_enabled` / `include_in_busy` だけです。カレンダー名、予定のタイトルや時刻、予定 ID などは保存しません。カレンダー ID はメール形式の場合があるため、選択していない ID の行は作りません。
- `display_enabled`（本人の画面で個人予定を表示）と `include_in_busy`（家族へ busy 時間帯を共有）は独立しています。個人予定用の選択保存は `include_in_busy` を変えず、busy 用の選択保存は `display_enabled` を変えません。両方 false になる行だけ削除します。
- 各用途の選択上限は10件です。選択状態が重ならない場合、1人あたり最大20行を保持できます。新しい `include_in_busy` 列は NOT NULL、既定値 false で、既存行は保持したまま false とします。

## 追加の同意

通常ログインでは free/busy スコープを求めません。本人が `/family` の「空き状況の共有」を有効にしたときに限り、`https://www.googleapis.com/auth/calendar.freebusy` を追加要求します。認可 state の purpose は `free-busy` です。認可 URL には `include_granted_scopes=true` とログイン中ユーザーの Google `sub` を使う `login_hint` を付け、既存スコープへの許可を維持します。callback では Google が返した許可スコープ集合を保存します。

成功時は `/family?busy=granted` に戻ります。拒否は `/family?error=busy_denied`、その他の失敗は `/family?error=busy_failed`、認可対象と別の Google アカウントで完了した場合は `/family?error=busy_account_mismatch` に戻します。state の消費・検証前の失敗は `/?error=auth_expired` です。Google の生エラーや callback query の任意値は表示しません。

Google Cloud の `calendar.freebusy` 登録は人間が2026-10-05に確認済みです。実アカウントを使った staging 確認はこの文書作成時点では未実施です。

## API

両 endpoint は `familySecurityMiddleware` を通します。認証済みの active な大人が自分の家族に対して使えます。未ログインは401、家族がない・利用者がその家族の active な大人でない場合は404です。家族カレンダーは選択肢から除外します。入出力は共有 zod schema で検証し、キャッシュしません。

### `GET /api/families/:id/busy-calendars`

本人の `calendarList.list` から選択肢を取得します。追加同意前は次を返します。

```json
{
  "status": "authorization_required",
  "memberId": "mem_self",
  "calendars": []
}
```

同意済みの場合、`hasSavedSelection` は本人の `include_in_busy = true` の行が1件以上あれば `true` です。`selected` は `include_in_busy` だけから決めます。保存済み選択がない初期状態は primary を含めすべて `false` で、primary を自動選択しません。

```json
{
  "status": "ready",
  "memberId": "mem_self",
  "hasSavedSelection": false,
  "calendars": [
    { "id": "primary", "name": "自分", "isPrimary": true, "selected": false },
    { "id": "work@example.test", "name": "仕事", "isPrimary": false, "selected": false }
  ]
}
```

カレンダー名は Google から都度取得し、D1 には保存しません。

一覧は1ページ250件、最大10ページまで取得します。10ページ以内に完了できない場合は部分一覧を返さず、エラーにします。

### `PUT /api/families/:id/busy-calendars`

本人が選択した ID の一覧を置き換えます。request body は最大16 KiBで、`calendarIds` は本人の最新の `calendarList` に存在する一意な ID（各 ID 最大1024文字）の配列、最大10件です。リクエストは `{ "calendarIds": ["primary"] }` の形です。選択なし `{ "calendarIds": [] }` も保存できます。

この PUT は `include_in_busy` だけを変更し、`display_enabled` は保ちます。`include_in_busy` と `display_enabled` の両方が false になる行は削除します。同意が必要なら `200 { "authorizationRequired": true, "authorizationUrl": "https://..." }` を返して追加認可へ進みます。同意済みなら `200` で `{ "authorizationRequired": false, "status": "ready", "memberId": "...", "hasSavedSelection": true, "calendars": [...] }` を返します。`calendars[].selected` は busy 用の保存状態のみを表します。

この API は選択を保存するだけです。個人カレンダーの free/busy を取得する処理は Task 2-3 の責務です。

### 固定エラー

エラー応答は `{ "error": "<固定文>", "code": "<code>" }` です。Google の生本文や予定内容は含めません。

| HTTP | code | 意味 |
|---:|---|---|
| 400 / 413 | `INVALID_INPUT` | 不正な入力、存在しない選択 ID、または16 KiBを超える PUT body |
| 401 | `UNAUTHORIZED` | セッションがない、無効、または期限切れ |
| 401 | `REAUTH_REQUIRED` | Google の保存済み認可が失効し再認証が必要 |
| 403 | `FORBIDDEN` | Origin/CSRF 検証で拒否 |
| 403 | `CALENDAR_ACCESS_DENIED` | Google がカレンダー一覧へのアクセスを拒否 |
| 404 | `NOT_FOUND` | 家族がない、または利用者が active な大人メンバーではない |
| 502 | `GOOGLE_ERROR` / `CALENDAR_PAGE_LIMIT` | Google の不正応答、または一覧のページ上限 |
| 503 | `GOOGLE_TEMPORARY_ERROR` | Google の一時障害が再試行後も継続 |
| 500 / 503 | `INTERNAL_ERROR` | 想定外の内部障害／middleware の構成不足 |

## 画面

`/family` の「自分の予定の表示」の下に「空き状況の共有」を表示します。説明では、家族に伝わるのは予定がある時間帯だけであり、タイトルや内容は伝わらないこと、選んだカレンダー ID だけを保存することを伝えます。

未同意時は「空き状況を家族に共有する」ボタンを表示します。同意後は本人のカレンダー一覧を選択肢として表示します。初期状態はすべて未選択とし、「現在、空き状況は共有していません。共有するカレンダーを選んで保存してください。」と案内します。選択がなく保存済み選択もない場合は保存ボタンを無効にし、1件以上選択すると有効にします。保存済みの選択をすべて外して保存すれば共有を止められます。

会社の Google カレンダーを一覧に出すには、会社アカウント側で個人アカウントへ「予定の有無のみ」を共有します。会社の管理者が外部共有を禁止している場合は利用できません。

## Staging の人間による確認手順

PR マージ後に staging へデプロイして、合成データとテスト用 Google アカウントで確認します。Google Cloud のスコープ登録は完了済みですが、実アカウント確認は未実施です。

1. テスト用アカウント A と B を同じ家族に参加させ、A にテスト用カレンダーを用意します。実在の個人予定は使いません。A は `calendar.freebusy` にまだ同意していない状態から始めます。
2. A の `/family` で「空き状況を家族に共有する」を押し、Google の同意画面で拒否します。`/family?error=busy_denied` に固定で戻ることを確認し、再試行できることを確認します。
3. 再試行時に A ではない Google アカウントを選び、`calendar.freebusy` の同意を完了します。`/family?error=busy_account_mismatch` に固定で戻り、生の Google エラーが表示されないことを確認します。再試行できることも確認します。
4. もう一度再試行し、今度は `login_hint` で指定された A の Google アカウントで同意します。同意画面で `calendar.freebusy` が追加要求されていることを確認します。成功後は primary を含む全選択肢が未選択で、保存ボタンが無効になっていることを確認します。
5. A の `/family` で「自分の予定の表示」に個人予定用カレンダーを選んで保存します。次に busy 用のテストカレンダーを選んで保存し、再読込後も両方の選択が残ることを確認します。
6. busy 用の保存済み選択をすべて外して保存し、busy 選択が空に戻る一方、個人予定表示の選択が残ることを確認します。busy 用にテストカレンダーを再選択・保存したあと、個人予定表示の選択を変更または全解除し、busy 用選択は変わらないことを確認します。必要なら個人予定表示も再選択して保存します。
7. 個人予定用・busy 用の両方に選択済みカレンダーがある状態で再ログインします。両方の認可が維持され、`/personal-calendars` と `/busy-calendars` でそれぞれの保存済み選択だけが表示されることを確認します。
8. B の画面と `/busy-calendars`、`/personal-calendars`、`/week`、`/week/personal` の応答に、A のカレンダー名・IDや選択状態が出ないことを確認します。このタスクでは free/busy 取得はまだ行いません。

## 参考

- [Google Calendar API: Choose Google Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Google Identity: Incremental authorization](https://developers.google.com/identity/protocols/oauth2/web-server#incremental-auth)
- [認証・段階的認可の詳細](10-authentication.md)
- [本人の個人予定表示の選択と保存](18-personal-events.md)
