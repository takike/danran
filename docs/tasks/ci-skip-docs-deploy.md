# タスク：ドキュメントだけの push では、staging のデプロイを走らせない

- ブランチ名: `chore/ci-skip-docs-deploy`（最新の main から分岐）
- 作業前に読むもの: [AGENTS.md](../../AGENTS.md)、`.github/workflows/ci.yml`、`.github/workflows/verify.yml`、`.github/workflows/deploy-production.yml`、[docs/08-deployment.md](../08-deployment.md)
- **人間の確認が必要**（CI/CD の変更。マージは人間が行う）

## 背景

main への push のたびに「CI & Staging Deployment」が走り、検証と staging へのデプロイを行う。指示書や引き継ぎメモなど、ドキュメントだけを更新した push でも同じように走るため、アプリが何も変わらないデプロイが1日に十数回起きている。

## 目的

main への push が**ドキュメントだけ**の変更のときは、検証もデプロイも走らせない。アプリに関わる変更が1つでも含まれる push は、これまでどおり検証してデプロイする。

## 対象範囲

- `.github/workflows/ci.yml` の `push`（main）のトリガーに、ドキュメントだけの変更を除外する条件を足す。
  - 除外するもの：`docs/**`、リポジトリ直下の `*.md`（`README.md`、`AGENTS.md`、`CLAUDE.md` など）。
  - 除外の指定は GitHub Actions の標準の機能（`paths-ignore`）で行う。自作のスクリプトや外部のアクションを足さない。
- **`pull_request` のトリガーは変えない。** PR では、ドキュメントだけの変更でも、これまでどおり検証が走ること（レビューで「同じコミットで CI が成功していること」を確かめているため）。

## 先に行うこと：ドキュメントを Tailwind の読み取り対象から外す（2026-10-05 追記）

1回目の実施で、Codex が次のことを見つけて止まった（指示どおりの正しい判断）：`src/client/styles/tokens.css` の `@import "tailwindcss";` は、Tailwind の自動スキャンで `docs/**` と直下の Markdown（計39ファイル）も読んでいる。ドキュメントに書かれたクラス名が、生成される CSS に入りうるので、ドキュメントはビルドの入力になっている。このままデプロイを除外すると、「ドキュメントだけの変更」が実はアプリの CSS を変えていた、という取りこぼしが起こりうる。

そこで、このタスクの中で、先に次を行う。

- Tailwind がクラス名を探す範囲を、**アプリのソースだけ**に限定する（`src/` と `index.html`）。`docs/**` と直下の `*.md`（`README.md`、`AGENTS.md`、`CLAUDE.md` など）を対象から外す。Tailwind v4 の標準の指定（`@import "tailwindcss" source(...)`、`@source`、`@source not` など）で行い、設定は `src/client/styles/tokens.css` に置く。
- **変更の前後で、ビルドした CSS を比べる**（`pnpm build` の成果物）。
  - 変更後の CSS から消えたセレクタが、`src/` と `index.html` のどこでも使われていないこと。使われているものが1つでも消えていたら、範囲の指定を直す。
  - 増えたセレクタがないこと。
  - 比べた結果（消えたセレクタの数と例）を、PR の説明に書く。
- 変更後に、Tailwind が `docs/**` と直下の Markdown を読んでいないことを、1回目と同じ方法で確かめ、結果を PR の説明に書く。
- それでも、ドキュメントがビルド・テスト・検証スクリプトの入力として残る場合は、CI の変更を入れずに止まり、何が残っているかを報告する。

## そのほかに確かめること

- `docs/screenshots/` の画像は Playwright が書き出すだけで、アプリやテストの入力になっていないこと（1回目に確認済み）。
- `scripts/` 配下の検証スクリプトが、`docs/` や直下の Markdown を読んでいないこと。

## 変えないもの

- 検証の内容（`verify.yml`）、staging へのデプロイの手順、マイグレーションの適用、Secret の扱い、権限（`permissions`）、同時実行の設定（`concurrency`）。
- production のデプロイ（`deploy-production.yml`）。手動実行のままにする。
- アプリのコード、テスト、設定ファイル（例外は、上の Tailwind の読み取り範囲の指定だけ）。画面の見た目は変えない。
- 既存のアクションのバージョン指定（コミット SHA での固定）。

## テスト

- この変更は、main に入って初めて確かめられる。PR では次を確認する。
  - PR 上で、これまでどおり検証（Verification）が走り、成功していること。
  - ワークフローの YAML が正しいこと（構文の検査ができる手段があれば使う。なければ、変更が `on.push` の数行だけであることを PR の説明に示す）。
- マージ後の確認手順を PR の説明と docs に書く：
  1. ドキュメントだけを変える push を main に行い、「CI & Staging Deployment」が**走らない**こと。
  2. アプリのコードを含む次の PR をマージしたとき、検証とデプロイが**走る**こと。

## docs

- `docs/08-deployment.md` に、「ドキュメントだけの push ではデプロイしない」ことと、除外しているパスを書く。
- `docs/06-decisions.md` に決定を1行足す。

## 受け入れ基準

- main へのドキュメントだけの push で、検証とデプロイが走らない設定になっている。
- アプリに関わる変更を含む push と、すべての PR では、これまでどおり検証が走る。
- 変更は、`.github/workflows/ci.yml` のトリガー、Tailwind の読み取り範囲の指定（`src/client/styles/tokens.css`）、docs だけである。
- ビルドした CSS から、アプリで使っているクラスが消えていない。`pnpm typecheck` / `lint` / `test` / `e2e` / `build` が通る。
- PR 上の検証が成功している。

PR を作成したらマージせずに止まること。
