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
| 11 | [2-6-weekend-day.md](2-6-weekend-day.md) | S2「週末の1日」（メンバー列のタイムライン、共通の空きから予定を作る） | 完了（PR #25。[2-6-review-fixes.md](2-6-review-fixes.md) の3回分を反映済み）。実機確認待ち |
| 12 | [ci-skip-docs-deploy.md](ci-skip-docs-deploy.md) | ドキュメントだけの push では staging のデプロイを走らせない（CI の変更。マージは人間） | 未着手 |

前の PR がマージされてから次に着手する（同じ画面を続けて変更するため、同時には進めない）。
