# 18. 本人だけに表示する個人予定（Task 2-1）

このタスクでは、本人が選択した個人 Google カレンダーの予定を、本人の週画面だけに表示します。家族の週 API には個人予定を加えず、個人予定の取得に失敗しても家族予定は表示し続けます。

## プライバシー境界と保存範囲

- 個人予定の取得にはリクエストした本人の Google トークンだけを使います。他のメンバーのトークンでは個人予定を読みません。
- 個人予定のタイトル、日時、Google event ID、説明、場所、参加者、作成者メールアドレス等は D1、ブラウザの永続ストレージ、HTTP/Service Worker のキャッシュ、ログに保存しません。表示用データは本人単位のメモリ上の query cache に限られ、アカウント・家族・週の切替時に別の利用者へ引き継ぎません。API はタイトル・時刻・繰り返しかどうか・カレンダー ID を本人の `/week/personal` 応答にだけ含めます（Google のカレンダー ID はメール形式の場合があります）。
- D1 `member_calendars` は本人の大人メンバー行と Google カレンダー ID、`display_enabled` を保持します。カレンダー名は保存せず、一覧を表示するときに本人の `calendarList.list` から取得します。個人予定を別の家族へ共有する設定とは結び付けません。
- 初回のカレンダー選択画面では primary だけを選択済みの下書きとして表示します。保存前の personal-week は `unselected` で空です。保存すると選択状態を全置換し、すべて外した状態も行として保持するため、再読込や再認可で primary が自動選択され直すことはありません。
- 選択中のカレンダーのいずれかで取得失敗またはページング失敗が起きた場合、個人予定の部分一覧は返さず個人予定 API 全体を失敗させます。家族の `/week` API は別取得なので独立して成功・表示を続けます。

## 段階的認可

通常ログイン時には個人予定のスコープを求めません。利用者が `/family` で「自分の予定を表示する」を選んだとき、本人の Google アカウントに `https://www.googleapis.com/auth/calendar.events.readonly` を追加で要求します。書き込み権限を含む `calendar.events` は要求しません。認可 URL は既存同意を保つ `include_granted_scopes=true` を使います。

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

本人の `calendarList.list` を取得し、Danran の共有家族カレンダーを除いた選択肢を返します。保存済み選択がまだない初回は primary を選択済みにした下書き一覧です。未同意状態は通常の結果として返します。

```json
{
  "status": "ready",
  "memberId": "mem_self",
  "calendars": [
    { "id": "primary", "name": "自分", "isPrimary": true, "selected": true },
    { "id": "work@example.test", "name": "仕事", "isPrimary": false, "selected": false }
  ]
}
```

未同意の場合は `{ "status": "authorization_required", "memberId": "mem_self", "calendars": [] }` です。

### `PUT /api/families/:familyId/personal-calendars`

リスト全体の選択を置き換えます。`calendarIds` は本人のカレンダー一覧にある ID の一意な配列で、最大10件です。ID は最大1024文字。選択なしも `{"calendarIds":[]}` として保存します。

Request body は最大16 KiBです。Google Calendar 一覧は1ページ250件・最大10ページ、予定は1ページ2500件・最大10ページまで取得し、ページ上限に達した場合は部分結果を成功として返しません。

追加スコープが未同意なら `200 {"authorizationRequired":true,"authorizationUrl":"https://..."}` を返し、同意済みなら `200 {"authorizationRequired":false,"status":"ready","memberId":"...","calendars":[...]}` を返します。Google が返した最新の選択肢に存在しない ID は受け付けません。

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

同意が必要な場合は `status: "authorization_required"`、保存した選択が空の場合は `status: "unselected"` を返し、いずれも `events: []` です。取得に失敗したときはエラー応答とし、部分イベントを返しません。

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

`/family` の「自分の予定の表示」欄は、未同意時に目的を説明し追加同意ボタンを表示します。同意後は本人のカレンダー名と選択チェックボックスを表示し、一括保存します。全て外して保存すると週表示を停止できます。Google 側で Danran のアクセスを取り消す方法も案内します。

S1 では本人の個人予定に本人の色、点線枠、鍵アイコン、「自分だけ」を付けます。編集 UI は開きません。compact 平日は最大2件を表示し、「ほか N 件」から当日の個人予定全件を読めます。expanded 日、週末・祝日カードでは家族予定と時刻順に並べます。ルーティンを隠す設定は個人予定にも適用します。個人予定取得エラーはその欄にだけ案内し、家族予定は残します。

## Staging の人間による確認手順

Google Cloud OAuth 同意画面に `calendar.events.readonly` が登録済みで、staging の Web OAuth クライアントを使用できることが前提です。このタスクの開始時点ではスコープ登録済みを想定していますが、ここで人間による staging 実施を確認したという意味ではありません。未登録なら人間が Google Cloud Console で登録してから確認してください。PR マージ後に staging へデプロイして行います。

1. 2つのテスト用 Google アカウント A/B を用意し、両方を staging にログインさせて同じ家族に参加させます。実在の個人予定は使わず、テスト専用カレンダーと合成予定を用意します。
2. A で `/family` を開き、「自分の予定を表示する」を押します。Google の同意画面では、今回 `calendar.events.readonly` が追加要求されていることを確認し、必要項目にチェックして許可します。既存の許可も画面に表示されることがあります。未審査アプリの警告が出た場合は、利用を許可されたテストアカウントで警告内容を確認し、「詳細」から「Danran に移動（安全ではないページ）」を選びます。戻った画面では primary だけが選択済みの下書きとして表示されます。
3. A の画面で primary とテスト用カレンダーを選んで保存し、予定が A の S1 に「自分だけ」と表示されることを確認します。説明や場所は表示されません。
4. B で同じ週を開き、A の個人予定のタイトルや日時が表示・API 応答されず、家族予定のみ表示されることを確認します。
5. A で選択をすべて外して保存し、再読込後も選択が空で週の個人予定が表示されないことを確認します。必要に応じて再認可後も全解除状態が維持されることを確認します。
6. 別のテスト用カレンダーの取得を一時的に拒否し、A の個人予定が部分表示されず固定エラーになり、家族予定は表示されたままであることを確認します。

この文書作成時点で staging の実アカウント確認は未実施です。OAuth スコープの登録・Secret 操作・Google アカウント変更はこのタスクでは行いません。
