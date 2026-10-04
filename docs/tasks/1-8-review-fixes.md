# タスク 1-8 のレビュー指摘（PR #17 への追加コミット）

- 対象ブランチ: `phase1/1-8-event-editing`（PR #17）。新しいブランチや PR は作らず、同じブランチに追加コミットする。
- この指示書は main にある。ブランチ側では `git fetch origin` のあと `git show origin/main:docs/tasks/1-8-review-fixes.md` で読める。

レビューでは typecheck / lint / test（389件）/ e2e（95件）/ build がすべて成功し、認可・二重作成の防止・プライバシーの扱いに問題はなかった。以下の3点を直す。

## 1. 終日と時刻指定を切り替える編集が Google 側で失敗する（要修正）

`PATCH /api/families/:id/events/:eventId` は、Google の `events.patch` に `start` / `end` を「新しい側のフィールドだけ」で送っている。

- 終日 → 時刻指定：`start: { dateTime, timeZone }`
- 時刻指定 → 終日：`start: { date }`

`events.patch` は入れ子のオブジェクトをフィールド単位でマージするため、既存の `date`（または `dateTime`）が残り、`date` と `dateTime` が両方ある状態になって Google が 400 を返す。fetch をモックしたテストでは検出できない。

直し方：

- 更新時は、使わない側のフィールドを明示的に `null` で送る。
  - 時刻指定にする場合：`{ date: null, dateTime: "...", timeZone: "Asia/Tokyo" }`
  - 終日にする場合：`{ date: "...", dateTime: null, timeZone: null }`
- 切り替えの有無にかかわらず、PATCH では常に明示的な `null` を送ってよい（既存の種別と比較する必要はない）。
- `patchEventInputSchema` の `start` / `end` を、PATCH 専用の日時スキーマ（`null` を許可）に変える。`events.insert` 用の `insertEventDateTimeSchema` は変えない。
- テスト：終日 → 時刻指定、時刻指定 → 終日の両方で、Google に送るリクエスト本文に明示的な `null` が入っていることを検証する。
- `docs/16-event-editing.md` の staging 確認手順に「終日と時刻指定を切り替えて保存し、Google カレンダーに反映されること」を追加する。

## 2. フォームの余白

`docs/screenshots/event-form.png` で、次のラベルが直前の要素に接している。ほかの項目と同じ間隔を空ける。

- 「担当（大人）」が、対象メンバーのチェックボックスの直下に余白なしで置かれている。
- 「状態」が、「持ち物を追加」ボタンの直下に余白なしで置かれている。

## 3. 各日の「追加」ボタンを控えめにする

各日に枠付きの「＋ 追加」ボタンが並び、平日の行が再び高く、にぎやかになった（「平日は背景に」の方針に反する）。

- 各日のボタンは、枠と文字のないアイコンだけの「＋」にする。タップ領域は 44px 以上を保ち、`aria-label` は日付入り（例「10月6日に予定を追加」）にする。
- 予定のない平日の行は、PR #16 で詰めた高さを保つ（ボタンのために行が高くならないようにする）。
- 週末・祝日カードでは、連休バッジを日付の並び（左側）に戻し、「＋」は右端に置く。
- 画面上部の「予定を追加」ボタン（主ボタン）は現状のまま。

## 確認

- `pnpm typecheck` / `lint` / `test` / `e2e` が通ること。
- `docs/screenshots/event-form.png` と `s1-week-view.png` を更新する。
- PR の説明に、追加コミットの内容を追記する。

追加コミットを push したら、マージせずに止まること。
