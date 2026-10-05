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

## 先に確かめること

- `docs/` 配下や直下の `*.md` が、ビルドの成果物・テスト・検証スクリプト（`scripts/` を含む）から読まれていないこと。読まれている場合は、除外すると検証が抜けるので、**変更を入れずに止まり、PR の代わりに何が読まれているかを報告する**。
- `docs/screenshots/` の画像は Playwright が書き出すだけで、アプリやテストの入力になっていないこと。

## 変えないもの

- 検証の内容（`verify.yml`）、staging へのデプロイの手順、マイグレーションの適用、Secret の扱い、権限（`permissions`）、同時実行の設定（`concurrency`）。
- production のデプロイ（`deploy-production.yml`）。手動実行のままにする。
- アプリのコード、テスト、設定ファイル。
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
- 変更は `.github/workflows/ci.yml` のトリガーと docs だけである。
- PR 上の検証が成功している。

PR を作成したらマージせずに止まること。
