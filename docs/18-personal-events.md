# 18. 本人だけに表示する個人予定（Task 2-1）

このタスクでは、本人が選択した個人 Google カレンダーの予定を、本人の週画面だけに表示します。家族の週 API には個人予定を加えず、個人予定の取得に失敗しても家族予定は表示し続けます。

## プライバシー境界と保存範囲

- 個人予定の取得にはリクエストした本人の Google トークンだけを使います。他のメンバーのトークンでは個人予定を読みません。
- 個人予定のタイトル、日時、Google event ID、説明、場所、参加者、作成者メールアドレス等は D1、ブラウザの永続ストレージ、HTTP/Service Worker のキャッシュ、ログに保存しません。表示用データは本人単位のメモリ上の query cache に限られ、アカウント・家族・週の切替時に別の利用者へ引き継ぎません。API はタイトル・時刻・繰り返しかどうか・カレンダー ID を本人の `/week/personal` 応答にだけ含めます（Google のカレンダー ID はメール形式の場合があります）。
- D1 `member_calendars` は本人が用途ごとに選択したカレンダー ID と `display_enabled` / `include_in_busy` フラグを保持します。個人予定表示で使うカレンダーは最大10件です。カレンダー名や予定の中身は保存せず、名前は一覧表示時に本人の `calendarList.list` から取得します。2つの用途の選択は独立しています。
- personal-events の選択保存は `display_enabled` だけを変更し、既存の `include_in_busy` を保持します。両フラグが false になる行は削除します。画面表示用の選択が0件なら `/week/personal` は `unselected` で空です。busy 用の行が残っていても個人予定表示の選択済みとは数えません。カレンダー一覧 API の `hasSavedSelection` は `display_enabled = true` の行が1件以上ある場合だけ `true` で、`selected` はその行だけに基づきます。0件なら primary を含めてすべて `false` で、再読込や再認可後も同じ状態を表示します。
- 選択中のカレンダーのいずれかで取得失敗またはページング失敗が起きた場合、個人予定の部分一覧は返さず個人予定 API 全体を失敗させます。家族の `/week` API は別取得なので独立して成功・表示を続けます。

## 段階的認可

通常ログイン時には個人予定のスコープを求めません。利用者が `/family` で「自分の予定を表示する」を選んだとき、本人の Google アカウントに `https://www.googleapis.com/auth/calendar.events.readonly` を追加で要求します。書き込み権限を含む `calendar.events` は要求しません。認可 URL は既存同意を保つ `include_granted_scopes=true` を使い、ログイン中ユーザーの Google `sub` を `login_hint` として指定します。callback では既存のアカウント照合を引き続き行い、不一致は `personal_account_mismatch` とします。

OAuth callback は同一オリジンの固定パスへ戻します。

| 結果 | 戻り先 |
|---|---|
| 同意完了 | `/family?personal=granted` |
| 利用者が拒否 | `/family?error=personal_denied` |
| その他の失敗 | `/family?error=personal_failed` |
| 別の Google アカウントで完了 | `/family?error=personal_account_mismatch` |

state の消費・検証前に失敗した場合は既存 OAuth callback の規則に従い `/?error=auth_expired` に戻ります。Google の生エラーや任意の callback 値を UI に表示しません。

## API

すべての endpoint は認証済みユーザーが指定家族の active メンバーであることを要求します。家族や所属を漏らさないため、存在しない家族とアクセス権のない家族は `404 NOT_FOUND` になります。CSRF/Origin の検証も既存の family security middleware に従います。成功・失敗ともキャッシュ不可です。

### `GET /api/families/:familyId/personal-calendars`

本人の `calendarList.list` を取得し、Danran の共有家族カレンダーを除いた選択肢を返します。`hasSavedSelection` は D1 に `display_enabled = true` の行が1件以上ある場合 `true` です。該当行がない場合（初回または全解除を保存した後）は `false` とし、一覧の `selected` は primary を含めてすべて `false` です。busy 用の行がある場合も、`selected` は個人予定表示用フラグだけを反映します。表示選択がない場合は個人予定を表示しません。未同意状態は通常の結果として返します。

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

未同意の場合は `{ "status": "authorization_required", "memberId": "mem_self", "calendars": [] }` です。

### `PUT /api/families/:familyId/personal-calendars`

リスト全体の個人予定表示選択を置き換えます。`calendarIds` は本人のカレンダー一覧にある ID の一意な配列で、最大10件です。ID は最大1024文字。選択なしも `{"calendarIds":[]}` として保存します。PUT は `display_enabled` だけを更新し、既存の `include_in_busy` を変更しません。選択されていない ID の `display_enabled` を false にし、`include_in_busy` も false になった行だけ削除します。選択なしを保存した後は表示有効行が0件となり、`hasSavedSelection` は `false`、一覧の `selected` はすべて `false` です。busy 用に選択された行は残ることがあります。

Request body は最大16 KiBです。Google Calendar 一覧は1ページ250件・最大10ページ、予定は1ページ2500件・最大10ページまで取得し、ページ上限に達した場合は部分結果を成功として返しません。

追加スコープが未同意なら `200 {"authorizationRequired":true,"authorizationUrl":"https://..."}` を返し、同意済みなら `200 {"authorizationRequired":false,"status":"ready","memberId":"...","hasSavedSelection":true,"calendars":[...]}` の形で一覧を返します。`hasSavedSelection` は `display_enabled = true` の保存行が1件以上あれば `true` です。`selected` も `display_enabled` だけを反映し、表示有効行がなければすべて `false` です。Google が返した最新の選択肢に存在しない ID は受け付けません。たとえば選択なしの PUT は次の応答になります。

```json
{
  "authorizationRequired": false,
  "status": "ready",
  "memberId": "mem_self",
  "hasSavedSelection": false,
  "calendars": [
    { "id": "primary", "name": "自分", "isPrimary": true, "selected": false },
    { "id": "work@example.test", "name": "仕事", "isPrimary": false, "selected": false }
  ]
}
```

### `GET /api/families/:familyId/week/personal?start=YYYY-MM-DD`

家族 `/week` API と同じ JST の週範囲を使います。`start` は省略可能で、省略時は JST の今日を含む週です。本人が選択したカレンダーだけを、本人のトークンで `events.list` します。成功時の本体は次の形です。

```json
{
  "family": { "id": "fam_123" },
  "memberId": "mem_self",
  "week": {
    "start": "2026-10-05",
    "endInclusive": "2026-10-12",
    "prevWeekStart": "2026-09-28",
    "nextWeekStart": "2026-10-12",
    "today": "2026-10-06"
  },
  "status": "ready",
  "events": [
    {
      "id": "primary::google-event-id",
      "calendarId": "primary",
      "title": "歯科",
      "time": {
        "kind": "timed",
        "start": "2026-10-07T09:00:00+09:00",
        "endExclusive": "2026-10-07T10:00:00+09:00"
      },
      "isRoutine": false
    }
  ]
}
```

Event ID は `<calendarId>::<GoogleEventId>` です。終日イベントは `{ "kind":"all-day", "start":"YYYY-MM-DD", "endExclusive":"YYYY-MM-DD" }` です。`singleEvents=true` で繰り返しを展開し、本人が辞退した予定とキャンセル済み予定を除きます。`description`、`location`、`attendees`、イベント作成者や参加者のメールアドレスは返しません。`calendarId` は API の指定フィールドで、Google の ID がメール形式の場合はその形式を保ちます。

同意が必要な場合は `status: "authorization_required"`、`display_enabled = true` の保存行がない場合は `status: "unselected"` を返し、いずれも `events: []` です。取得に失敗したときはエラー応答とし、部分イベントを返しません。

### 固定エラー

エラーは `{ "error": "<固定文>", "code": "<code>" }` 形式で、Google の生本文を含めません。

| HTTP | code | 意味 |
|---:|---|---|
| 400 | `INVALID_INPUT` | 不正な日付、範囲外の週、または無効な選択カレンダー ID |
| 401 | `UNAUTHORIZED` | セッションがない、無効、または期限切れ |
| 401 | `REAUTH_REQUIRED` | Google の保存済み認可が失効し再認証が必要 |
| 403 | `FORBIDDEN` | Origin/CSRF 検証で拒否 |
| 403 | `CALENDAR_ACCESS_DENIED` | Google がカレンダーアクセスを拒否 |
| 404 | `NOT_FOUND` | 家族がない、または利用者が active メンバーではない |
| 413 | `INVALID_INPUT` | PUT の body が16 KiBを超える |
| 502 | `GOOGLE_ERROR` / `CALENDAR_PAGE_LIMIT` | Google の不正応答または上限内にページングを完了できない |
| 503 | `GOOGLE_TEMPORARY_ERROR` | Google の一時障害が再試行後も継続 |
| 500 / 503 | `INTERNAL_ERROR` | 想定外の内部障害／middleware の構成不足 |

## 画面と操作

`/family` の「自分の予定の表示」欄は、未同意時に目的を説明し追加同意ボタンを表示します。同意後は本人のカレンダー名と選択チェックボックスを表示し、一括保存します。`hasSavedSelection` が `false` のときは「現在、自分の予定は表示していません。表示するカレンダーを選んで保存してください。」と案内し、primary を含むすべてのチェックを外します。保存済み選択がなく何も選んでいない場合は保存ボタンを無効にし、カレンダーを1件以上選ぶと有効にします。保存済み選択がある状態からすべて外した場合は、0件で保存でき、週表示を停止できます。Google 側で Danran のアクセスを取り消す方法も案内します。

S1 では本人の個人予定に本人の色、点線枠、鍵アイコン、「自分だけ」を付けます。編集 UI は開きません。compact 平日は最大2件を表示し、「ほか N 件」から当日の個人予定全件を読めます。expanded 日、週末・祝日カードでは家族予定と時刻順に並べます。ルーティンを隠す設定は個人予定にも適用します。個人予定取得エラーはその欄にだけ案内し、家族予定は残します。

## Staging の人間による確認手順

Google Cloud OAuth 同意画面に `calendar.events.readonly` が登録済みで、staging の Web OAuth クライアントを使用できることが前提です。このタスクの開始時点ではスコープ登録済みを想定していますが、ここで人間による staging 実施を確認したという意味ではありません。未登録なら人間が Google Cloud Console で登録してから確認してください。PR マージ後に staging へデプロイして行います。

1. 2つのテスト用 Google アカウント A/B を用意し、両方を staging にログインさせて同じ家族に参加させます。実在の個人予定は使わず、テスト専用カレンダーと合成予定を用意します。
2. A で `/family` を開き、「自分の予定を表示する」を押します。Google の同意画面では、今回 `calendar.events.readonly` が追加要求されていることを確認し、必要項目にチェックして許可します。`login_hint` によりログイン中の Google アカウントが指定されます。既存の許可も画面に表示されることがあります。未審査アプリの警告が出た場合は、利用を許可されたテストアカウントで警告内容を確認し、「詳細」から「Danran に移動（安全ではないページ）」を選びます。戻った画面では primary を含むすべての選択肢が未選択で、個人予定を表示していない案内が表示されます。
3. A の画面で primary とテスト用カレンダーを選んで保存し、予定が A の S1 に「自分だけ」と表示されることを確認します。説明や場所は表示されません。
4. B で同じ週を開き、A の個人予定のタイトルや日時が表示・API 応答されず、家族予定のみ表示されることを確認します。
5. A で保存済みの個人予定表示選択をすべて外して保存し、D1 に `display_enabled = true` の行がなく、`/week/personal` が `unselected` であることを確認します。busy 用に選ばれた行は残っていても構いません。再読込または再認可後も個人予定表示はすべて未選択で、「現在、自分の予定は表示していません。表示するカレンダーを選んで保存してください。」と案内されます。初回など表示用の保存済み選択がないときは何も選ばず保存できないこと、カレンダーを1件選ぶと保存できることも確認します。
6. 別のテスト用カレンダーの取得を一時的に拒否し、A の個人予定が部分表示されず固定エラーになり、家族予定は表示されたままであることを確認します。

この文書作成時点で staging の実アカウント確認は未実施です。OAuth スコープの登録・Secret 操作・Google アカウント変更はこのタスクでは行いません。
