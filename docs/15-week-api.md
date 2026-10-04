# 15. 週ビュー API 契約（Task 1-6）

`GET /api/families/:id/week` は S1 の週表示に必要な家族カレンダーの情報を読み取り、共有スキーマに沿って返します。この契約は Phase 1 の家族予定版です。個人カレンダーの予定や free/busy は取得しません。

## エンドポイント

```http
GET /api/families/{familyId}/week?start=2026-10-05
```

- 認証済みセッション Cookie が必要です。
- `start` は省略可能です。省略時は `Asia/Tokyo` の今日を含む週を返します。
- 指定する場合、`start` は実在する `YYYY-MM-DD` 日付で、祝日ライブラリの対応範囲 1970–2050 年内である必要があります。指定日から週の表示範囲を計算し、その週の月曜日をアンカーにします。
- 表示範囲は通常月曜から日曜までです。日曜の直後に続く祝日があれば、連続する祝日の最終日まで延長します。前週・次週のアンカーは、表示日数にかかわらず `start` の月曜からそれぞれ7暦日前・後です。
- 日付検証、今日、週範囲、曜日の計算は `src/shared/time` を通し、ホストのタイムゾーンに依存しません。
- start と連休延長後の全日付が 1970–2050 年に収まらない場合は `400 INVALID_INPUT` を返します。祝日データがない年を平日と誤判定して返すことはありません。

## 認可と読み取り範囲

1. 有効なログインセッションを要求します。
2. 指定家族に属する **active メンバー**であることを要求します。オーナーであっても active メンバーでなければ `404 NOT_FOUND` です。家族の存在や他人の所属状態を漏らさないため、アクセス不可と存在しない家族は同じ応答にします。
3. 家族の作成状態が `ready` で、家族カレンダー ID が設定済みの場合だけ処理します。
4. リクエストユーザー自身の Google トークンで、その家族カレンダーだけを `events.list` します。
5. D1 から同じ家族の active メンバー、対象週の休園日、および今回返すイベントの `event_meta` を読みます。家族予定・`event_meta`・休園日の書き込みは行いません。

この API は個人カレンダーの `events.list`、`freeBusy.query`、他メンバーのトークンを使った取得を行いません。個人予定のタイトル・場所・説明・参加者や free/busy 区間をレスポンスに含めません。公開コピーが家族カレンダー上に存在する場合は、家族カレンダーの予定として扱います。

## レスポンス

成功時は `200 application/json`。実装上の共有 Zod スキーマが契約の正本です。全 ID は不透明な文字列です。

```json
{
  "family": { "id": "f_123", "name": "だんらん" },
  "week": {
    "start": "2026-10-05",
    "endInclusive": "2026-10-12",
    "prevWeekStart": "2026-09-28",
    "nextWeekStart": "2026-10-12",
    "today": "2026-10-03"
  },
  "members": [
    { "id": "m_1", "name": "はな", "color": "ochre", "kind": "child", "sortOrder": 1 }
  ],
  "days": [
    {
      "date": "2026-10-12",
      "weekday": 1,
      "holidayName": "スポーツの日",
      "closures": [],
      "layout": "weekend-card",
      "eventIds": ["g_event_1"]
    }
  ],
  "events": [
    {
      "id": "g_event_1",
      "title": "運動会",
      "time": {
        "kind": "timed",
        "start": "2026-10-12T09:00:00+09:00",
        "endExclusive": "2026-10-12T12:00:00+09:00"
      },
      "memberIds": ["m_1"],
      "assigneeMemberId": null,
      "status": "confirmed",
      "isRoutine": false,
      "source": "manual",
      "items": ["水筒"]
    }
  ]
}
```

上記は契約の一部を示す抜粋です。実レスポンスの `days` には表示範囲の全日が入り、`events` には週と重なる全イベントが入ります。

### フィールド規則

- `family`: 認可済みの家族の `id` と `name` のみ。
- `week.start`: 表示範囲の月曜アンカー。`endInclusive` は延長を含む表示最終日。`prevWeekStart` / `nextWeekStart` は月曜アンカーを7暦日ずつ移動した日付。`today` は JST の今日。
- `members`: `active` メンバーのみを、成人 (`kind: "adult"`) → 子ども (`kind: "child"`) の順で返します。同じ種別では `sortOrder`、続いて `id` の昇順とし、既存データで `sortOrder` が重複していても順序を安定させます。`userId` などアカウント情報は返しません。
- `days`: 表示範囲の全日を昇順に返します。`weekday` は日曜を0とする曜日番号です。`holidayName` は祝日名または `null`。`closures` は `{label, memberIds}` の配列で、休園日の対象メンバー ID は現在 active な既知 ID のみを含みます。`layout` は `'weekend-card' | 'expanded' | 'compact'`。`eventIds` はその暦日に重なるイベント ID を含みます。
- `events`: 週表示範囲と重なる家族カレンダーイベントを、各イベントの完全な時間範囲で返します。時刻は `+09:00` 付き ISO 8601。終日は `{kind: "all-day", start: "YYYY-MM-DD", endExclusive: "YYYY-MM-DD"}` です。終日イベントの `endExclusive` は Google Calendar と同じ排他的終了日です。タイトルが空または空白だけの場合は `（無題）` を返します。
- `memberIds`: イベント対象メンバーのうち、現在 active な既知のメンバー ID のみ。未知または壊れた ID は除きます。`assigneeMemberId` も同様に既知の active メンバーでなければ `null` です。
- `status`: `'confirmed' | 'tentative'`。有効な Danran private metadata があればその値を使い、欠落・不正なら Google イベント状態から決めます。Google が tentative と示す場合だけ `tentative`、それ以外は `confirmed` とします。
- `isRoutine`: Google イベントに `recurringEventId` がある場合 `true`。通常回か例外回かの詳細な判定は後続の繰り返しタスクで扱います。
- `source`: `'manual' | 'import' | 'publish' | 'external'`。Danran marker がある場合は private metadata の有効な値を使い、値が欠落または不正なら `'manual'`。marker がない場合だけ `'external'`。
- `items`: `event_meta.itemsJson` が有効な JSON 文字列配列ならその内容、そうでなければ空配列。メタデータ候補は、(1) `(calendarId,eventId)` のイベント行、(2) `(calendarId,recurringEventId,originalStart)` の個別回、(3) `(calendarId,eventId=recurringEventId)` のシリーズ行の順に選びます。個別回の `originalStart` は、終日なら日付の完全一致、時刻付きなら JST に正規化した同一 instant で照合します（例：`Z` と等価な `+09:00` は一致）。見つかった候補の JSON が不正なら空配列とし、下位候補にフォールバックしません。D1 の bind 上限を避けるため、event ID と recurring ID を重複除去したうえで49件ずつ問い合わせます。1クエリの ID 条件は最大98 bind 値（event ID / recurring ID 各49）で、家族・カレンダー条件が加わります。空週では `event_meta` の全件検索をしません。

### イベントの日付への割り当てと順序

- `events` は日単位に切り詰めず、Google の開始・終了範囲を維持します。
- `days[].eventIds` にはイベント時間と重なる日すべてを割り当てます。終了が日付境界ちょうど（00:00）の場合、その終了日には割り当てません。終日イベントも排他的終了日をそのイベントの日に含めません。
- `days[].eventIds` は終日イベントを先にし、続いて開始時刻、タイトル、イベント ID の順で並べます。

### Google イベント metadata と休園日

- `extendedProperties.private.danran === "1"` のイベントは Danran 管理イベントとして扱います。`members` は CSV から既知の active ID だけを残し、`assignee` も同様に検証します。`status` は定義済み値だけ受け入れます。`source` は `manual` / `import` / `publish` だけ受け入れ、欠落または不正なら `manual` にします。
- Danran marker のないイベントは外部イベントとして扱い、`memberIds: []`、`assigneeMemberId: null`、`source: "external"` とします。Google イベントのタイトル等は家族カレンダー上のイベント情報として返ります。
- `assigneeMemberId`、`status`、`source` の返却値は Google private metadata を正本とします。書き込み API はこれらを `event_meta` にも保存しますが、週 API のレスポンスでは Google の値を検証して使います。`event_meta` の読み取りは返却対象イベントに限ります。
- `closure_days.member_ids` が有効な `[]` の場合は家族全員対象です。非空配列の場合は既知の active ID のみ残します。壊れた JSON や、未知 ID だけを含む配列はその休園日を破棄し、家族全体の休園日として解釈しません。
- `dayLayout` は `src/shared/domain/dayLayout` の既存ルールを使い、週末・祝日・休園日を `weekend-card`、平日の非ルーティン家族予定があれば `expanded`、それ以外を `compact` とします。キャンセル済み予定は表示対象から外します。

## Google Calendar 取得条件と上限

`events.list` は家族カレンダー ID を指定し、呼び出しユーザー自身のトークンで行います。`singleEvents=true`、`orderBy=startTime`、`timeMin` / `timeMax` に週の JST 境界（`+09:00`）、`timeZone=Asia/Tokyo`、`showDeleted=false` を指定し、`maxResults=2500` でページングします。

- 全ページを結合してから day layout とレスポンスを作ります。空でないページトークンの再出現は `502 CALENDAR_PAGE_LIMIT`、空文字または空白だけのページトークンは `502 GOOGLE_ERROR` で失敗します。
- 最大10ページまで取得します。10ページ目に次ページトークンが残っていれば、部分データを返さず `502 CALENDAR_PAGE_LIMIT` とします。
- Google からの失敗、不正レスポンス、ページング異常を成功レスポンスに見せかけません。エラー応答に Google の生レスポンスや予定内容を含めません。

## エラー応答

エラー本文は `{ "error": "<固定された英語メッセージ>", "code": "<code>" }` 形式です。Google の生メッセージやレスポンス本文は返しません。

| HTTP | `code` | 条件 |
|---:|---|---|
| 400 | `INVALID_INPUT` | `start` の形式・暦日が不正、または週範囲が祝日データの 1970–2050 年外に出る |
| 401 | `UNAUTHORIZED` | セッションがない、無効、または期限切れ |
| 401 | `REAUTH_REQUIRED` | 保存トークンで認証を継続できず、再認証が必要 |
| 403 | `FORBIDDEN` | 既存 security middleware がリクエスト Origin を許可しない（エンドポイント処理前） |
| 403 | `CALENDAR_ACCESS_DENIED` | Google Calendar が家族カレンダーへのアクセスを拒否（Google 403/404。`RATE_LIMITED` に分類されたレート制限は 503 の一時エラーとして扱う） |
| 404 | `NOT_FOUND` | 家族が存在しない、またはユーザーがその家族の active メンバーでない |
| 409 | `FAMILY_NOT_READY` | 家族作成が完了していない、または家族カレンダー ID がない |
| 500 | `INTERNAL_ERROR` | 想定外の内部エラー |
| 502 | `GOOGLE_ERROR` | Google の不正応答、スキーマ不一致、その他の非一時エラー |
| 502 | `CALENDAR_PAGE_LIMIT` | 10ページ以内に全件取得できない |
| 503 | `INTERNAL_ERROR` | 既存 security middleware が認証設定未構成を検出（エンドポイント処理前） |
| 503 | `GOOGLE_TEMPORARY_ERROR` | 再試行後も Google 429/5xx またはネットワーク障害が続く |

すべての成功・エラー応答は `Cache-Control: no-store` を維持します。

## 実装範囲

この文書は週ビュー読み取り API の契約です。単発予定の書き込み API は [16-event-editing.md](16-event-editing.md) に記載します。個人カレンダー、free/busy は含みません。週 API テストは認可、共有スキーマ、日付境界、プライバシー、Google ページング・エラー、休園日と event metadata の対応を確認します。実 Google アカウントや staging の週データ取得を確認したという意味ではありません。
