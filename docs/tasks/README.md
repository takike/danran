# タスク指示書

コーディングエージェント（Codex）に渡す作業指示を置く場所。指示書を書き、PR をレビューするのは計画・レビュー担当（[CLAUDE.md](../../CLAUDE.md)）。チャットには「どのファイルを実施するか」だけを書き、内容はここを正とする。

## 使い方

- 人間からの指示は `git pull して docs/tasks/<ファイル名> を実施して` の形で届く。
- 指示書を最初から最後まで読み、そこに書かれた順で進める。[AGENTS.md](../../AGENTS.md) のルールは常に適用される。
- 1つの指示書につき1つの PR。PR を作成したらマージせずに止まる。
- 指示書と実装が食い違う判断をした場合は、PR の「未解決の点」に理由を書く。
- レビューの修正依頼も、ここにファイルで置く（例 `1-8-review-fixes.md`）。その場合は新しいブランチを作らず、対象の PR のブランチに追加コミットする。
- 完了した指示書は消さない（経緯の記録として残す）。下の表の状態は、PR のマージ後に人間側で更新する。

## 一覧（上から順に実施する）

| 順 | ファイル | 内容 | 状態 |
|---|---|---|---|
| 1 | [fix-pwa-update-reload.md](fix-pwa-update-reload.md) | デプロイ後に古い画面が残る問題の修正 | 完了（PR #15） |
| 2 | [1-7-followup-week-polish.md](1-7-followup-week-polish.md) | 週ビューの実機確認で見つかった点の修正 | 完了（PR #16） |
| 3 | [1-8-event-editing.md](1-8-event-editing.md) | 予定の作成・編集・削除 | 完了（PR #17。[1-8-review-fixes.md](1-8-review-fixes.md) 反映済み） |
| 4 | [1-9-settings.md](1-9-settings.md) | 設定：メンバーの名前・色、休園日 | 完了（PR #18） |
| 5 | [2-1-personal-events.md](2-1-personal-events.md) | 自分の個人予定を自分の画面にだけ表示（要：人間による Google Cloud のスコープ登録） | 完了（PR #19。[2-1-review-fixes.md](2-1-review-fixes.md) 反映済み） |
| 6 | [2-1-followup-calendar-picker.md](2-1-followup-calendar-picker.md) | カレンダー選択の初期状態を「すべて未選択」にする（実機確認の指摘） | 完了（PR #20） |
| 7 | [2-4-free-windows.md](2-4-free-windows.md) | 共通の空きを計算するドメインロジック（API・画面には触らない。2-2・2-3 より先に実施） | 完了（PR #21） |
| 8 | [2-2-busy-calendars.md](2-2-busy-calendars.md) | 空き状況に使うカレンダーの選択と、追加の同意（`calendar.freebusy`。取得 API は次の 2-3） | 完了（PR #22） |
| 9 | [2-3-busy-api.md](2-3-busy-api.md) | 家族の空き状況を取得する API（開始・終了だけを返す。画面は変えない） | 完了（PR #23） |
| 10 | [2-5-weekend-timeline.md](2-5-weekend-timeline.md) | 週末カードの空きタイムライン（メンバーごとの埋まっている時間、共通の空き、「みんな空き N時間」） | 完了（PR #24） |
| 11 | [2-6-weekend-day.md](2-6-weekend-day.md) | S2「週末の1日」（メンバー列のタイムライン、共通の空きから予定を作る） | 完了（PR #25。[2-6-review-fixes.md](2-6-review-fixes.md) の3回分を反映済み） |
| 12 | [ci-skip-docs-deploy.md](ci-skip-docs-deploy.md) | ドキュメントだけの push では staging のデプロイを走らせない（Tailwind の読み取り範囲の限定を含む） | 完了（PR #26） |
| 13 | [3-1-routine-creation.md](3-1-routine-creation.md) | 繰り返し予定の作成（毎週・隔週。最小の一覧とシリーズ全体の削除を含む） | 完了（PR #27） |
| 14 | [3-2-routine-instances.md](3-2-routine-instances.md) | 繰り返し予定の直近の回、「この回を休む」、「振替」 | 完了（PR #28。[3-2-review-fixes.md](3-2-review-fixes.md) 反映済み） |
| 15 | [3-2-followup-move-save-button.md](3-2-followup-move-save-button.md) | 振替の「保存」ボタンが空白に見える問題の修正（実機確認の指摘） | 完了（PR #29） |
| 16 | [3-5-routine-exceptions.md](3-5-routine-exceptions.md) | 振替した回を、週ビューで「いつもと違う日」として扱う（3-3 より先に実施） | 完了（PR #30） |
| 17 | [s1-compact-unusual-day-card.md](s1-compact-unusual-day-card.md) | 週ビューの「いつもと違う日」のカードを小さくし、「＋」をカードの外に出す（実機確認の指摘） | 完了（PR #31） |
| 18 | [3-3-routine-holiday-skips.md](3-3-routine-holiday-skips.md) | 祝日・年末年始に当たる回を、自動でお休みにする（Cron なし。休園日は別のタスク） | 完了（PR #32） |
| 19 | [3-4-routine-conflicts.md](3-4-routine-conflicts.md) | 繰り返し予定と単発の予定の重複を知らせる（「繰り返し」の解決パネル、週ビューの印） | 完了（PR #33） |
| 20 | [fix-new-event-default-date.md](fix-new-event-default-date.md) | 23 時以降に「＋」から予定を追加すると、日付が翌日になる問題の修正（実機確認の指摘） | 完了（PR #34）。実機確認済み |
| 21 | [perf-routines-responsiveness.md](perf-routines-responsiveness.md) | 「繰り返し」の画面の待ち時間と、操作後のちらつきを減らす（実機確認の指摘） | 完了（PR #35）。実機確認済み（ちらつきは解消。操作の反映に3秒ほどかかる点は 24 で対応） |
| 22 | [5-1-tasks-api.md](5-1-tasks-api.md) | やること（tasks）の API と、持ち物からの自動生成（画面は次の 5-2） | 完了（PR #36） |
| 23 | [5-2-tasks-screen.md](5-2-tasks-screen.md) | S5「やること」の画面（予定ごと・期限順・自分の担当、完了、担当、手動の追加） | 完了（PR #37。[5-2-review-fixes.md](5-2-review-fixes.md) 反映済み）。実機確認済み（5-1 の API を含む） |
| 24 | [perf-routines-instant-actions.md](perf-routines-instant-actions.md) | 「繰り返し」の回の操作を、押した瞬間に画面へ反映する（実機確認の指摘） | 完了（PR #38）。実機確認済み |
| 25 | [5-2-followup-task-event-picker.md](5-2-followup-task-event-picker.md) | 「やること」の画面から、予定を選んでやることを足す（実機確認の要望）。スクリーンショットの書き出しの修正を含む | 完了（PR #39）。実機確認済み |
| 26 | [5-3-week-tasks.md](5-3-week-tasks.md) | 週ビューに、やることの締切のチップと、予定ごとの残りの数を出す | 完了（PR #40。[5-3-review-fixes.md](5-3-review-fixes.md) 反映済み）。実機確認済み |
| 27 | [5-4-absence-tasks.md](5-4-absence-tasks.md) | 習い事の回を休みにしたら、「欠席を連絡」のやることを作る | 完了（PR #41。[5-4-review-fixes.md](5-4-review-fixes.md) 反映済み）。実機確認済み |
| 28 | [4-1-print-upload.md](4-1-print-upload.md) | プリントの撮影とアップロード（写真の保存・一覧・表示・削除。読み取りの手前まで）。**人間の確認が必要** | PR #44。レビュー済み・人間のマージ待ち |
| 29 | [5-2-followup-hide-done-tasks.md](5-2-followup-hide-done-tasks.md) | 完了したやることを、ふだんは隠す（実機確認の指摘） | 完了（PR #42）。実機確認済み |
| 30 | [perf-event-save.md](perf-event-save.md) | 予定の保存を速くし、失敗の原因を追えるようにする（実機確認の指摘）。staging の Workers Logs を有効にする。**人間の確認が必要**（デプロイ設定） | 完了（PR #43。人間の了承でマージ）。実機確認待ち |

前の PR がマージされてから次に着手する（同じ画面を続けて変更するため、同時には進めない）。

## PR を出したあとの連絡（Codex。2026-10-19 から）

PR を作成したとき、または修正依頼に応えて PR に追加コミットを push したときは、CI の結果を待ってから、herdr で計画・レビュー担当（Claude Code）のペインに1行で連絡する。

1. `herdr agent list` で、`agent` が `claude`、作業フォルダ（`cwd`）が `/home/takuyaikemachi/danran-review` のペインを探す。ペインの ID は変わるので、毎回探す。見つからない、または複数あるときは、連絡せずに止まる（最後の報告に、連絡できなかったことを書く）。
2. `herdr agent get <ペイン>` の `agent_status` が `idle` か `done` のときだけ送る。`working` や `blocked` のときは、30 秒ごとに確かめて、最大 10 分待つ。それでも送れないときは、送らずに止まる（最後の報告に書く）。
3. 送り方：`herdr agent prompt <ペイン> "<1行>"`。送るのは、次の形の1行だけ。
   - `[Codex] PR #<番号> を作成しました（ブランチ <ブランチ名>、コミット <短い SHA>、CI <成功／失敗>）。レビューしてください。`
   - 追加コミットのときは「作成しました」を「に追加コミットしました」にする。
4. 同じ PR・同じコミットについて、2回送らない。キー操作を送らない。ほかの指示や依頼を書かない。

連絡したあとも、PR をマージせずに止まること。
