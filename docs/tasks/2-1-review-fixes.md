# タスク 2-1 のレビュー指摘（PR #19 への追加コミット）

- 対象ブランチ: `phase2/2-1-personal-events`（PR #19）。新しいブランチや PR は作らず、同じブランチに追加コミットする。
- この指示書は main にある。ブランチ側では `git fetch origin` のあと `git show origin/main:docs/tasks/2-1-review-fixes.md` で読める。

レビューでは、個人予定が本人以外の API に出ないこと、本人のトークンだけを使うこと、予定の中身を D1 に保存しないこと、家族の `/week` に混ぜていないこと、再ログインで追加スコープが残ることを確認し、問題はなかった。以下の2点を直す。

## 1. 選んでいないカレンダーの ID まで保存している（要修正）

`PUT /api/families/:id/personal-calendars` は、本人の `calendarList` にある**すべて**のカレンダーを `member_calendars` に書き込み、選んでいないものは `display_enabled = false` として残している。

- Google のカレンダー ID はメールアドレスの形であることが多い。購読しているほかの人のカレンダーがあれば、選んでもいないその人のメールアドレスが D1 に残る。
- 画面（「家族」タブ）とプライバシーポリシーは「選択したカレンダー ID のみを保存」と説明しており、実装と食い違っている。

直し方：

- 保存するのは、**本人が選んだカレンダーの行だけ**にする（最大10行）。選んでいないカレンダーの行は作らない。保存は従来どおり「全削除 → 選択分を挿入」を1つの batch で行う。
- すべて外して保存した場合は、行が0件になる。`/week/personal` は従来どおり `unselected` を返す。
- `member_calendars` のテーブル定義とマイグレーション `0005` は変えない（`display_enabled` は選択行で常に true になる）。
- 行が0件のとき、初回と「すべて外して保存した後」を区別できなくなる。これは受け入れる。代わりに、カレンダー一覧の応答（GET と PUT の `ready`）に `hasSavedSelection`（保存済みの選択が1件以上あるか）を足す。
  - `hasSavedSelection` が false のとき、一覧の `selected` は従来の初回と同じ（主カレンダーだけ true の下書き）。
  - 画面は、`hasSavedSelection` が false のとき「現在、自分の予定は表示していません。カレンダーを選んで保存すると表示が始まります。」と出す。
- テスト：
  - 保存後の `member_calendars` に、選んでいないカレンダーの ID が1件も無いこと。
  - すべて外して保存すると行が0件になり、`/week/personal` が `unselected` になること。
  - 既存の「全解除の状態を行として保持する」前提のテスト（Vitest・Playwright）は、新しい仕様に合わせて直す。
- docs：`docs/18-personal-events.md`、`docs/03-architecture.md`、`docs/06-decisions.md` の「すべて外した状態も行として保持する」という記述を、上の仕様に直す。画面とプライバシーポリシーの文言（「選択したカレンダー ID のみを保存」）はそのままでよい。

## 2. 追加の同意で、ログイン中の Google アカウントを指定する

「自分の予定を表示する」から Google の同意画面へ進むとき、`login_hint` を付けていない。端末に複数の Google アカウントがあると、別のアカウントを選んでしまい「アカウントが異なります」のエラーになりやすい。

- 家族カレンダーの共有（`family-acl`）と同じように、`personal-events` の認可 URL にも `login_hint`（ログイン中の利用者の Google の sub）を付ける。
- テスト：`personal-events` の認可 URL に `login_hint` が入っていること。

## 変えないもの

- API のパス、認可（401 / 404）、エラーコード、一部失敗時に全体を失敗にする方針。
- 週ビューの見た目と挙動。
- 通常ログイン・招待ログイン・`family-acl` の流れ。
- 既存のマイグレーションファイル。

## 確認

- `pnpm typecheck` / `lint` / `test` / `e2e` が通ること。`pnpm db:generate` で差分が出ないこと。
- `docs/screenshots/family.png` を更新する（390px 幅、合成データ）。
- PR の説明に、追加コミットの内容を追記する。

追加コミットを push したら、マージせずに止まること。
