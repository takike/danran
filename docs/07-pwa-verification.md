# 07. PWA 検証手順書（Task 0-2）

Danran の PWA インストール要件、Service Worker 動作、キャッシュ分離、および検証手順。

## 再現・検証コマンド

```bash
pnpm install
pnpm exec playwright install chromium # 初回環境のみ
pnpm pwa:icons                        # tokens.css からアイコン・favicon を決定論的生成
pnpm typecheck
pnpm lint
pnpm test                             # Vitest による共有・クライアント・Worker テスト
pnpm e2e                              # Playwright E2E（build ＋ 127.0.0.1:4173 プレビューを自律実行）
```

※ `pnpm e2e` は `playwright.config.ts` の `webServer` により `pnpm build && node node_modules/vite/bin/vite.js preview` を自律起動するため、手動の先行ビルドは不要です。

---

## キャッシュと更新動作の仕様

1. **静的アセット事前キャッシュ（Precache）**:
   - `dist/client` 配下の公開ファイル（`index.html`、ハッシュ付き JS/CSS、マニフェスト、アイコン画像）のみを事前キャッシュ。
   - Vite 8 環境分離（`applyToEnvironment: env => env.name === 'client'`）により、Worker 成果物・設定ファイルは一切事前キャッシュおよびクライアント成果物に含まれません。
2. **API 隔離とプライバシー不変条件**:
   - CacheStorage に `/api/*` リクエスト・レスポンスを保存しない。
   - `navigateFallbackDenylist: [/^\/api(?:\/|$)/]` により、API ルートや未定義 API へのアクセスが SPA の `index.html` にすり替わるのを防止。
3. **更新戦略（`autoUpdate`）**:
   - `registerType: 'autoUpdate'`（`skipWaiting: true`, `clientsClaim: true`）を採用。
   - 新しい Service Worker が開いているページの制御を引き継ぐと、入力保護がなければページを1回だけ自動で再読み込みし、新しい HTML とアセットを読み込みます。初回インストールで初めて制御された場合は再読み込みしません。
   - オンボーディングの未保存の家族名・子どもの名前・色・追加・削除は自動再読み込みを保留します。更新バナーを表示し、利用者が「更新」を選んだ場合に再読み込みします。Google/D1 の作成・保存などの処理中は、自動・手動どちらの再読み込みも処理完了まで保留します。処理完了後も更新バナーは残り、勝手に再読み込みを再開しません。
   - `visibilitychange` で画面が再表示されたとき、オンラインなら `registration.update()` で更新を確認します。確認間隔は60秒以上空け、同時に複数回実行しません。
   - この更新ハンドラは新しいアプリコードに含まれます。修正版がデプロイされる前から開いたままのタブにはハンドラがまだないため、修正版のアプリコードを手動で読み込んでから、以後のデプロイで自動更新を確認できます。
   - 将来の入力画面でも `useReloadProtection(isDialogOpen, isSaving)` を使い、編集中のダイアログは自動再読み込みを保留し、保存中は手動適用も保留します。
4. **オフライン挙動**:
   - 初回訪問で SW がキャッシュされた後、オフライン状態ではキャッシュからシェルが配信され、`useIsOnline`（`navigator.onLine`）により日本語のオフラインフォールバック画面（44px以上の再読み込みボタン）が表示されます。
   - 初回訪問時（キャッシュ未取得）のオフライン起動は不可能です。
   - 接続が戻ると `online` イベントを受けて通常のアプリ画面へ自動で戻ります。接続復帰のためにページを強制再読み込みする挙動ではありません。

## 更新動作の自動検証

`e2e/pwa-update.spec.ts` は、テストごとに `127.0.0.1` の一時 HTTP サーバーを起動します。現在の `dist/client` の公開アセットを配信し、内容の異なる `sw.js` A/B がそれぞれ異なるバージョン印付き HTML を事前キャッシュする、実ブラウザの Service Worker 更新を検証します。初回制御で再読み込みしないこと、A から B への交代で1回だけ新しい HTML に切り替わること、API をキャッシュしないこと、オンボーディングの未保存入力を保護することを確認します。このテストはローカルの合成レスポンスを使うもので、staging や iOS 実機での検証結果ではありません。

```bash
DANRAN_SCREENSHOTS=1 pnpm exec playwright test e2e/pwa-update.spec.ts --project=production
```

## staging での更新確認

実際の staging 確認には、同じオリジンで連続する2つのデプロイが必要です。修正版をデプロイしただけでは、すでに開いている旧コードのタブに更新ハンドラは追加されません。

1. 修正版を一度読み込み、アプリが表示されて Service Worker がページを制御している状態にします。
2. そのタブを開いたまま次のアプリバージョンを staging にデプロイします。前回の更新確認から60秒以上経ってから、アプリを一度バックグラウンドに移し、オンライン状態で再び表示します。
3. 入力保護のない画面で、新しい Service Worker の制御後にページが再読み込みされ、新バージョンが表示されることを確認します。
4. オンボーディングに未保存の家族名または子どもの変更を入力し、再デプロイ後にバナーが出て入力が維持されることを確認します。保存中は「更新」が無効で、処理終了後に利用者が選んだときだけ再読み込みされることを確認します。
5. オフライン・オンライン復帰と `/api/*` の応答が、従来のキャッシュ分離・復帰動作を保つことを確認します。

この staging 確認はまだ実施していません。Google/Cloudflare アカウント操作やデプロイは、この文書の変更では行っていません。

---

## アイコン仕様

- **カラーパレット**: `src/client/styles/tokens.css` より `--bg: #f6f3ee`、`--accent: #b8472f`、`--surface: #ffffff` をパースして適用。
- **192x192 / 512x512（purpose: any）**: アクセント背景（`#b8472f`）に角丸スクワークル＋白線（`#ffffff`）の `CalendarDays` アイコン。
- **512x512（purpose: maskable）**: 背景全面（`#b8472f`、角丸なし）、中央 80% セーフゾーン内に収まるサイズでアートワークを配置。
- **180x180 Apple Touch Icon**: Apple HIG に準拠した角丸なし不透明アクセント背景（`#b8472f`）＋白線ストローク。
- **favicon.svg**: 同一の Lucide `CalendarDays` から動的に生成。

---

## 実施済み検証ログ（2026-09-28）

- **Chromium 153.0.8010.52 CDP**:
  - `Page.getAppManifest`: パースエラー 0 件。
  - `Page.getInstallabilityErrors`: インストールエラー 0 件（非 incognito プロファイルで確認）。
- **ブラウザ実動作（Playwright E2E）**:
  - SW 制御下での in-browser API fetch（200 / 404）および直接ナビゲーション正常。
  - オフライン時の事前キャッシュシェル読み込み、日本語オフライン画面表示（118x44 ボタン）、ディープリンク対応、`context.setOffline(false)` による実ブラウザ復帰正常。
  - 事前 warming 後のオフライン API fetch 失敗（非キャッシュ化）正常。
  - CacheStorage インベントリ：公開静的アセット（10件）のみ格納、`/api`・`/danran/`・`wrangler.json`・`/.vite/` の非混入を確認。
- **Lighthouse 11.7.1（レガシー PWA 監査）**:
  - スコア 100（PWA 1.0）、`installable-manifest` パス（自動監査6項目合格、手動確認3項目は未主張）。
  - ※ 現代の Lighthouse（v12+）では PWA カテゴリが廃止されたため、本監査は過去仕様互換の参考値として特定バージョンで実施。
  - 再現コマンド（要 Chrome インストール、別ターミナルで `pnpm build && pnpm preview` 起動中）:
    `pnpm dlx lighthouse@11.7.1 http://127.0.0.1:4173 --only-categories=pwa --chrome-flags="--headless"`
- **iOS 実機検証**:
  - 物理 iOS 端末でのホーム画面追加は**未実施（Pending physical device test）**。全 AC 完了は主張せず、Phase 0-4 ステージング環境展開時に実施予定。

---

## iOS Safari 手動検証手順

> **ステータス**: **実機未実施（Pending physical device test）**
> 物理 iOS 実機は現在のヘッドレス開発環境にないため、Phase 0-4（ステージング環境へのデプロイ）後に開発者の iPhone 実機で実施します。

1. iOS Safari でアプリを開く。
2. 共有（Share）シートから「ホーム画面に追加（Add to Home Screen）」を選択。
3. タイトル「だんらん」とアクセント背景・白線アイコンを確認して追加。
4. ホーム画面から起動し、ブラウザ UI のない全画面（`standalone`）表示を確認。
5. 機内モードを有効にして起動し、オフライン画面（「オフラインです」）が表示されることを確認。
6. 機内モードを解除し、オンラインイベントで通常のアプリ画面へ戻ることを確認。

---

## 参考リンク

- [Changes to progressive web app install criteria (Chrome for Developers)](https://developer.chrome.com/blog/update-install-criteria)
- [Installable manifest audit (Lighthouse)](https://developer.chrome.com/docs/lighthouse/pwa/installable-manifest)
- [Vite PWA Guide](https://vite-pwa-org.netlify.app/guide/)
- [Web Push for Web Apps on iOS and iPadOS (WebKit Blog)](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
