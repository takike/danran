# 19. 空き状況の共有設定・取得・週末表示（Task 2-2・2-3・2-5）

Task 2-2 では大人のメンバーが追加同意を行い、空き状況に使う個人カレンダーを選んで保存します。Task 2-3 では別 API で各メンバーの busy 区間を取得します。選択保存 API 自体は `freeBusy.query` を呼びません。

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

この API は選択を保存するだけです。個人カレンダーの free/busy を取得するのは後述の Task 2-3 の別 API です。

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

## 家族の busy 週 API（Task 2-3）

`GET /api/families/:id/week/busy?start=YYYY-MM-DD` は `familySecurityMiddleware` を通し、指定家族の active な大人（`user_id` があるメンバー）だけが利用できます。リクエスト本人も含め、メンバーは `sortOrder`、次に `id` の昇順で返します。`start` は省略可能で、省略時は JST の今日を含む週です。指定時は `/week` と同じ実在日付、重複指定、`getWeekRange` および 1970–2050 年の検証を適用します。

成功応答は `/week` のイベント一覧とは別の共有 Zod 契約です。例では busy 区間以外の予定情報を含めません。

```json
{
  "family": { "id": "fam_synthetic_123" },
  "week": {
    "start": "2026-10-05",
    "endInclusive": "2026-10-12",
    "prevWeekStart": "2026-09-28",
    "nextWeekStart": "2026-10-12",
    "today": "2026-10-06"
  },
  "members": [
    {
      "memberId": "mem_adult_a",
      "status": "ready",
      "busy": [
        { "start": "2026-10-07T09:00:00+09:00", "end": "2026-10-07T10:00:00+09:00" }
      ]
    },
    { "memberId": "mem_adult_b", "status": "not_shared", "busy": [] },
    { "memberId": "mem_adult_c", "status": "unavailable", "busy": [] }
  ]
}
```

`family` は家族 ID のみ、`week` は家族 `/week` と同じ週メタデータです。各 `members[]` は `{ memberId, status, busy }` だけを返し、`status` は `ready` / `not_shared` / `unavailable` のいずれかです。`ready` は取得できた区間（0件もあり）、`not_shared` は free/busy の追加同意がないか `include_in_busy = true` の保存選択がない状態、`unavailable` は本人の取得に失敗した状態です。後二者の `busy` は空配列ですが、予定なしや空き時間を意味しません。`ready` と `busy: []` の組み合わせだけが、取得済みで busy 区間がなかった状態です。失敗理由は返しません。

各本人の保存済みトークンで、その本人の `include_in_busy = true` のカレンダー ID だけを `freeBusy.query` します。未同意・未選択の場合は Google を呼びません。選択一覧のうち1件でも Google の calendar error がある、要求したカレンダーが応答から欠落している、週境界が要求と一致しない、または応答が不正な場合、その本人全体を `unavailable` とし、成功分だけを返しません。1人の失敗は他のメンバーの取得を妨げません。家族カレンダーは問い合わせから除外します。

busy 区間は週の JST 境界に切り取り、重複または端点が接する区間を統合して返します。時刻は Asia/Tokyo の `+09:00` 付き ISO 形式です。予定のタイトル・場所・説明・参加者、カレンダー ID・名前・件数・busy の由来、個々の Google エラー理由は API レスポンスに含めません。取得した busy 区間は D1・キャッシュ・ログに保存しません。D1 には 2-2 の選択状態としてカレンダー ID と用途別フラグを保存します。成功・失敗とも `Cache-Control: no-store` です。既存の `/week` と `/week/personal` の応答は変更せず、共通空き時間の計算と `mirrored_blocks` の差し引きは行いません。

リクエスト全体のエラーは固定 `{ "error": "<固定文>", "code": "<code>" }` 形式です。認証・家族 membership は既存 middleware と週 API に従います。メンバーごとの Google 取得失敗は HTTP エラーにせず、そのメンバーを `unavailable` にします。

| HTTP | code | 条件 |
|---:|---|---|
| 400 | `INVALID_INPUT` | `start` が不正、重複指定、または週が対応年の範囲外 |
| 401 | `UNAUTHORIZED` | リクエストセッションがない、無効、または期限切れ |
| 403 | `FORBIDDEN` | Origin/CSRF 検証で拒否 |
| 404 | `NOT_FOUND` | 家族がない、または利用者がその家族の active な大人メンバーではない |
| 500 | `INTERNAL_ERROR` | 想定外の内部エラー |
| 503 | `INTERNAL_ERROR` | security middleware の構成不足 |

### Staging の人間による busy 取得確認

Google Cloud への `calendar.freebusy` スコープ登録は人間が確認済みですが、実アカウントでの staging 検証は未実施です。合成の予定・カレンダーと staging 用のテストアカウントだけを使い、実在の個人予定を使わずに確認します。

1. A・B を同じ家族の active な大人として用意します。A は `calendar.freebusy` に同意し、週内に重複・接触・週境界をまたぐ合成予定を含む複数のテストカレンダーを選択・保存済みにします。B は未同意の状態から始めます。実在の個人予定は使いません。
2. B が未同意のまま `GET /api/families/{familyId}/week/busy?start=2026-10-05` を呼び、B が `not_shared`・空区間、A は `ready` になることを確認します。未同意・未選択時に Google を呼ばないこと、および各人の選択 ID と本人のトークンを組み合わせて問い合わせることは自動テストで保証します（画面から Google 呼び出し件数は確認できません）。
3. B に free/busy の追加同意を行います。カレンダー選択を保存する前に同じ API を再度確認し、B が引き続き `not_shared` であることを確認します。
4. B に複数のテスト busy カレンダーと、A の区間と重なる合成予定を用意し、選択・保存します。A・B がともに `ready` になり、各人の区間が週境界で切り取られ、重複・接触区間を統合して返ることを確認します。
5. B の保存済み選択をすべて解除して保存し、B が `not_shared`・空区間、A は `ready` のままであることを確認します。
6. B がテスト用カレンダーを再選択・保存します。そのカレンダーが別のテスト用 Google アカウントの所有・共有なら、その所有アカウントから B への共有を解除します。B 自身が作った追加カレンダーなら、primary や実在カレンダーには触れず、そのテスト専用カレンダーだけを Google 側で削除します。いずれも D1 の選択行は残し、選択を保存し直さずに API を呼び、B だけ `unavailable`・空区間、A は `ready` のままであることを確認します。Google の生のエラー理由は表示されません。実在の個人カレンダーや予定は使いません。
7. B から同 API を取得し、A のメンバー項目に返るのが busy 区間だけであること、A の予定情報・カレンダー ID・名前・件数・由来・エラー情報が含まれないことを確認します。成功・エラー応答に `Cache-Control: no-store` があり、HTTP キャッシュに保存されないことも確認します。
8. 通常週、連休で延長される週、および前週・次週へ移動した `start` を指定し、`/week` と同じ週境界・メタデータになることを確認します。不正・重複・対応年外の `start` は `400 INVALID_INPUT` になります。

Task 2-3 で追加したのは取得 API と共有 schema までです。Task 2-5 ではクライアント query と週末カード表示を加え、共通空きの計算は Task 2-4 のドメイン関数を利用します。

### Task 2-5: S1 週末タイムラインの staging 確認

Task 2-5 の S1 表示は API モックの Playwright E2E で検証します。実 Google アカウントを使った staging 表示確認は未実施です。確認する場合は staging へデプロイ後、実在の個人予定ではなく、テスト専用アカウントと合成イベントを使います。

1. テスト用アカウント A・B と子どもメンバーを同じ家族に用意します。A・B はそれぞれ free/busy の追加同意とテスト専用カレンダーの選択を済ませ、家族予定と各人のテスト busy が重なる週末・祝日を作ります。
2. 390px 幅の S1 で週末・祝日カードだけにメンバー別行と「共通」行が出ること、他メンバーの個人予定のタイトルやカレンダー情報が表示されないこと、30分単位の合計と busy 区間が合成予定どおりであることを確認します。家族予定と本人の個人予定は従来どおり表示されます。平日と「いつもと違う日」カードにはタイムラインが出ないことも確認します。
3. B の free/busy 選択を全解除し、B 本人として S1 を開いた場合は「個人の予定は未共有」と家族ページへのリンク、カードに未共有注記が出ることを確認します。A から B の行を見たときに家族ページへのリンクが出ないことも確認します。家族予定による busy は維持され、共通時間もその家族予定を含めて計算されることを確認します。
4. B のテスト用 busy カレンダーを再選択したうえで、Task 2-3 staging 手順のカレンダー共有解除またはテスト専用カレンダー削除によって B を `unavailable` にします。B のバーと共通行・合計が表示されず、B の行には「取得できませんでした」と出る一方、A の家族予定・本人個人予定・busy 表示は残ることを確認します。
5. 「ルーティンを隠す」を切り替え、ルーティン予定の表示だけが変化し、メンバー別 busy 区間と共通時間は変わらないことを確認します。
6. 次週へ切り替え、切替中に前週の busy が新しい週の日付へ残らず、新週データの到着後は正しい週だけを表示することを確認します。busy API の失敗・遅延中も家族予定と自分の予定、予定追加操作が利用できることを確認します。
7. ログアウトまたはテスト用の別 Google アカウントへの切替後、直前アカウントの busy 区間が残らないことを確認します。445px 幅でも横にはみ出さず、名前が長いときも時間バーの幅が保たれることを確認します。

### Task 2-6: S2 週末の1日 staging 確認

Task 2-6 の画面統合は API モック E2E で検証します。実 Google アカウントを使った staging 確認は未実施です。マージ後に staging へデプロイし、実在する個人予定を使わず、テスト用アカウント A・B と合成した家族予定・個人予定を使って確認してください。

1. A と B を同じ準備済み家族に参加させます。テスト専用カレンダーを選択し、A にはタイトル付きの個人予定、B には別の時間帯の個人 busy を作ります。家族カレンダーには担当つき・候補・終日・時間帯外のテスト予定を用意します。
2. S1 の週末・祝日カードにある「この日を詳しく見る」リンクから S2 を開き、日付と週の範囲が合っていること、戻るボタンとブラウザ戻るが元の週へ戻ることを確認します。祝日で延長された10/5週の10/12と、直接 URL を開いた10/12がそれぞれ意図した週を保つことも確認します。
3. A で家族予定、担当列、候補、終日・時間帯外の予定、本人のタイトル付き個人予定が合成データどおりに並ぶことを確認します。B の個人予定はタイトルや calendar ID を出さず、busy の時間帯に斜線の「予定あり」だけが出ることを確認します。未共有なら家族予定だけで共通空きを計算し、取得不能なら共通帯と検索ボタンを無効にして理由を表示します。
4. 共通空きの帯を押して、当日の開始時刻から1時間（帯が1時間未満なら帯の終わりまで）で作成ダイアログが開くことを確認します。合成予定を保存し、S2 と S1 の両方に反映されることを確認します。
5. 家族予定の編集・削除、繰り返し予定の変更案内、busy または個人 API の遅延・失敗時にも家族予定と追加操作が使えることを確認します。A から B へアカウントを切り替えた後、A の本人用予定タイトルが残らないことも確認します。
6. 390px と445pxでページ全体の横はみ出しがなく、メンバーが多い場合もタイムライン領域だけで横スクロールできること、操作対象が44px以上で読み上げ文が利用できることを確認します。

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
8. B の画面と `/busy-calendars`、`/personal-calendars`、`/week`、`/week/personal` の応答に、A のカレンダー名・IDや選択状態が出ないことを確認します。この手順は Task 2-2 の認可と選択設定の確認です。busy 取得 API は下記 Task 2-3 の手順を参照します。

## 参考

- [Google Calendar API: Choose Google Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Google Calendar API: Freebusy query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
- [Google Identity: Incremental authorization](https://developers.google.com/identity/protocols/oauth2/web-server#incremental-auth)
- [認証・段階的認可の詳細](10-authentication.md)
- [本人の個人予定表示の選択と保存](18-personal-events.md)
