# 07. PWA 検証手順書（Task 0-2）

Danran の PWA インストール要件、Service Worker 動作、キャッシュ分離、および検証手順。

## 再現・検証コマンド

```bash
pnpm install
pnpm exec playwright install chromium # 初回環境のみ
pnpm pwa:icons                        # tokens.css からアイコン・favicon を決定論的生成
pnpm typecheck
pnpm lint
pnpm test                             # Worker ユニットテスト（3件）
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
   - 新しい Service Worker は即座にアクティベートされクライアントを制御します。新しいページアセットは次回のナビゲーションまたはリロード時に読み込まれます（現スキャフォールドでは強制リロードハンドラやプロンプトモーダルは未登録）。
4. **オフライン挙動**:
   - 初回訪問で SW がキャッシュされた後、オフライン状態ではキャッシュからシェルが配信され、`useIsOnline`（`navigator.onLine`）により日本語のオフラインフォールバック画面（44px以上の再読み込みボタン）が表示されます。
   - 初回訪問時（キャッシュ未取得）のオフライン起動は不可能です。

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
6. 機内モードを解除し、自動的に準備中画面へ復帰することを確認。

---

## 参考リンク

- [Changes to progressive web app install criteria (Chrome for Developers)](https://developer.chrome.com/blog/update-install-criteria)
- [Installable manifest audit (Lighthouse)](https://developer.chrome.com/docs/lighthouse/pwa/installable-manifest)
- [Vite PWA Guide](https://vite-pwa-org.netlify.app/guide/)
- [Web Push for Web Apps on iOS and iPadOS (WebKit Blog)](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
