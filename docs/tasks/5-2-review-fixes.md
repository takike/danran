# タスク 5-2 のレビュー指摘（PR #37 への追加コミット）

- 対象ブランチ: `phase5/5-2-tasks-screen`（PR #37）。新しいブランチや PR は作らず、同じブランチに追加コミットする。
- この指示書は main にある。ブランチ側では `git fetch origin` のあと `git show origin/main:docs/tasks/5-2-review-fixes.md` で読める。

レビューでは typecheck / lint / test（634件）/ e2e（171件）/ build がすべて成功し、表示の切り替え、完了・担当・追加・編集・削除、失敗時の巻き戻し、アカウント切替でやることが残らないこと、`src/worker` と `migrations` に変更がないこと、スクリーンショット3枚の見た目に問題はなかった。**直すのは次の1点だけ。**

## 完了にした手動のやることに、取り消し線が出ていない（要修正）

`docs/screenshots/s5-tasks.png` の「前日に確認」（完了・手動）は、文字が薄くなって「済」は出ているが、取り消し線が出ていない。

原因：`src/client/features/tasks/TaskRow.tsx` の、手動のやることのタイトル（編集を開くボタン）のクラスに、`underline decoration-transparent` と、完了時の `line-through` が同時に付いている。どちらも文字の飾り線の指定なので、片方しか効かず、線の色も透明になっている。自動のやること（`<span>`）は `underline` を持たないので、取り消し線が出る。PR #29 で直した「保存」ボタンと同じ種類の、指定の重なり。

直し方：

- 完了のときは、手動・自動のどちらのタイトルにも、取り消し線が**見える色で**出るようにする。**文字の飾り線の指定（`underline` と `line-through`、`decoration-*`）が、1つの要素に同時に2種類付かない**形にする。
- 未完了の手動のやることの、ホバー時の下線（押せることの手がかり）は残してよい。完了のときは、下線ではなく取り消し線にする。
- 同じ重なり方が、`src/client/features/tasks/` のほかの要素にないかを確かめ、あれば同じように直す。見つけた箇所は PR の説明に書く。

## 変えないもの

- 行の並び、文言、押したときの挙動、ほかの見た目。
- `src/worker`、`src/shared`、`migrations`。

## テスト

- Playwright：完了にした手動のやることと、完了にした自動のやることの両方で、タイトルの計算後のスタイルが、取り消し線（`text-decoration-line` に `line-through` を含む）で、線の色が透明でないことを確かめる。未完了のものには、取り消し線が付いていないこと。
- 既存のテストがすべて通ること。

## 確認

- `pnpm typecheck` / `lint` / `test` / `e2e` が通ること。
- `docs/screenshots/s5-tasks.png` と `docs/screenshots/s5-tasks-assignee.png` を撮り直す（完了の行に取り消し線が出ている状態）。
- PR の説明に、追加コミットの内容を追記する。

追加コミットを push したら、マージせずに止まること。
