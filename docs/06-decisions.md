# 06. 決定事項と未決事項

決めたこと・決めていないことの記録。実装中に決めたことは、日付と理由を添えてここに追記する。

## 決定事項

| 日付 | 決定 | 理由 |
|---|---|---|
| 2026-09-27 | 仮プロダクト名は **Danran（だんらん）**、repo は `takike/danran` | 家族の時間を守る、という軸が名前だけで伝わる |
| 2026-09-27 | まず自分の家族用に作り、良ければ一般公開する | — |
| 2026-09-27 | PWA で始め、必要ならネイティブに移行する | 開発速度。カメラと通知は PWA で足りる見込み |
| 2026-09-27 | コンセプトは「ルーティンは背景に、週末は前景に」。表示サイズは非ルーティン度で決める | [01-concept.md](01-concept.md) |
| 2026-09-27 | 個人カレンダーは free/busy のみを共有、家族予定は専用の共有 Google カレンダーを正本とし、付加情報は D1 に持つ（3層モデル） | アプリを開かない家族にも見える。個人予定の中身を持たない |
| 2026-09-27 | 繰り返しは Google の RRULE を使い、祝日スキップは Cron で個別の回をキャンセルして実現する | 独自の繰り返しエンジンを持たない |
| 2026-09-27 | ホスティングは Cloudflare Workers（Static Assets）＋ D1 ＋ R2 ＋ Cron | [04-hosting.md](04-hosting.md) |
| 2026-09-27 | 公開操作は1件ずつのチェックにしない。ルールで自動化し、迷うものは週1まとめで聞く。粒度は3段階 | 入力負担の最小化 |
| 2026-09-27 | 自分の予定は自分の画面では中身まで見える（「自分だけ」表示） | — |
| 2026-09-27 | ビジュアルはモックよりポップな方向にする。トークン化して後で差し替える | オーナーの意向 |
| 2026-09-28 | ホスティングは Cloudflare Workers で確定。D1（`danran-staging` / `danran-prod`）と R2（`danran-photos-staging` / `danran-photos-prod`）は作成済み。GitHub Secrets に `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を登録済み | — |
| 2026-09-28 | ドメインは当面 `workers.dev` のサブドメイン（`danran` / `danran-staging` Worker）を使う。独自ドメインは一般公開の前に決める。URL の直書きを避け、オリジンは環境変数（`APP_ORIGIN`）で持つ | 家族利用の段階では URL 変更の手間が小さい。名前が仮のため |
| 2026-09-28 | PWA は `vite-plugin-pwa`（Workbox `generateSW`）を採用し、`outDir: 'dist/client'` でクライアント公開アセットのみを事前キャッシュする | Cloudflare のクライアント出力分離に適合させ、Worker バンドルを事前キャッシュから除外するため |
| 2026-09-28 | CacheStorage に `/api/*` を保存しない（静的アセット限定）。また `navigateFallbackDenylist: [/^\/api(?:\/|$)/]` で API ナビゲーションの SPA HTML 誤インターセプトを防止 | プライバシー不変条件の厳守および API 404 / 正常レスポンスの保護 |
| 2026-09-28 | 更新戦略は `registerType: 'autoUpdate'`（`skipWaiting` / `clientsClaim`）を採用 | 初期スキャフォールドで過剰なプロンプト UI や強制リロードによる中断を避けるため |
| 2026-09-28 | PWA インストール性検証は Chromium CDP（`Page.getInstallabilityErrors`）および Playwright E2E で自動化し、レガシー Lighthouse 11.7.1（スコア100）を参考値として記録。iOS Safari 実機確認手順は文書化して分離 | 現代 Lighthouse での PWA カテゴリ削除に追従し、客観的ブラウザ API で検証するため（[07-pwa-verification.md](07-pwa-verification.md)） |
| 2026-09-28 | D1 初期スキーマは認証・認可の起点となる `users` テーブルのみでスキャフォールドし、他テーブルは所有タスクで漸進追加。マイグレーションは drizzle-kit 生成のみとし手書きを禁止。wrangler ルートはセンチネル UUID の `danran-local` をデフォルトとし、リモートマイグレーションは `--env`、Vite の環境選択は `CLOUDFLARE_ENV`（staging/production）で明示指定する | 責務の局所化、マイグレーション再現性の担保、各ツールの環境解決仕様への適合 |
| 2026-09-29 | デプロイ対象設定の選択：`@cloudflare/vite-plugin` の環境解決仕様に基づき、ビルド時（`CLOUDFLARE_ENV=staging/production vite build`）に設定をフラット化し、デプロイは生成成果物 `dist/danran_local/wrangler.json` を明示指定（`wrangler deploy --config ...`）する。デプロイ直前に `scripts/verify-deployment-config.mjs` で Worker 名・D1・R2 を機械的ガード | Vite プラグインのビルド時環境解決仕様に適合させ、ルートのローカルセンチネル設定の誤デプロイを防止するため |
| 2026-09-29 | CI/CD 構成とデプロイゲーティング：再利用可能ワークフロー `verify.yml` で型・静的解析・テスト・マイグレーションドリフト・E2E を統合。PR 検証には Secret を渡さず、main への push で staging へ自動デプロイ。production デプロイは main ブランチ限定の手動 `workflow_dispatch` とし、すべてのデプロイで D1 マイグレーション先行適用を徹底 | 外部 PR からの Secret 保護、スキーマ不整合の防止、および安全な運用サイクルの確立のため |
| 2026-09-29 | Tailwind CSS v4（`@tailwindcss/vite`）とデザイントークン連携、および開発用部品一覧（`/dev/ui`）の条件付き除外：`tokens.css` を単一の真実源として `@theme inline` で Tailwind ユーティリティにマッピングし、将来のテーマ・ポップ配色差し替えを CSS 変数更新のみで完結させる。`/dev/ui` は `import.meta.env.DEV` の動的インポート境界とし、本番ビルドから完全にコードを除外する | トークン変更による配色動的変更の担保、および本番バンドルの軽量化・開発専用ページの混入防止のため |
| 2026-09-29 | Google OAuth の一時フロー管理に `oauth_states` テーブルを採用し、コールバック時に `DELETE ... RETURNING` によるアトミック単一消費を徹底。ブラウザバインド（署名付き Cookie `__Host-danran_oauth` のハッシュ）と紐づけて PKCE verifier / nonce を AES-256-GCM で暗号化保持。認可コード横取り・リプレイ攻撃・多重送信を防止し、フロー完了時は即座に破棄 | 認可コード横取り・リプレイ攻撃・多重送信の根本防止、およびステートレス Cookie の容量制限・ブラウザ改ざんの排除 |
| 2026-09-29 | セッション管理：生の 256bit 乱数トークンを HMAC 署名（`SESSION_SECRET`）して `__Host-danran_session` Cookie（`HttpOnly; Secure; SameSite=Lax; Path=/`、TTL 30日）に格納し、D1 `sessions` テーブルの PK にはトークンの SHA-256 ハッシュのみを保存。セッション漏洩時も DB から平文 Cookie 値が流出しない設計 | セッションハイジャックおよび DB リーク時の被害局所化 |
| 2026-09-29 | Google リフレッシュトークン暗号化：`TOKEN_ENC_KEY`（厳格な base64 32バイト AES-256 キー）による AES-256-GCM 暗号化。AAD（`google-refresh:${userId}`）を付与して行間・目的外置換攻撃を防止。初回ログイン時はリフレッシュトークン必須とし、以降の同意省略時は既存トークンを保持 | トークン流出防止、暗号学的改ざん検知、およびマルチデバイス再ログイン耐性 |
| 2026-09-29 | オンデマンドアクセストークン取得：アクセストークン・ID トークンは D1 に永続化・キャッシュせず、`getGoogleAccessToken` により要求時オンデマンドで Google REST から取得。`invalid_grant` 検出時は旧暗号文の一致を条件とする条件付き DELETE で安全に失効させ、ネットワーク/5xx の一時障害時はトークンを保持 | トークン管理の簡素化、漏洩リスク最小化、および競合ログイン時の意図しないトークン消去防止 |
| 2026-09-29 | 認証ヘッダと CSRF 防御：全認証エンドポイントに `Cache-Control: no-store; Pragma: no-cache; Referrer-Policy: no-referrer` を強制。`POST /api/auth/logout` は `X-Requested-With: XMLHttpRequest` かつ `Origin === APP_ORIGIN` の双方を要求して CSRF を遮断。未設定時は 503 で fail-closed | ブラウザキャッシュ混入・CSRF攻撃の防止、および環境変数未設定時の安全なフォールバック |
| 2026-09-29 | Google OAuth トークンエンドポイント呼び出し時のリダイレクト制御：workerd 実行環境（`redirect: 'error'` 未サポート）に適合させるため、`redirect: 'manual'` を指定し、3xx リダイレクトを含む非 2xx レスポンスを即座に拒否する。これにより資格情報の意図しない送信先漏洩を防止する | workerd 実行環境の制約への適合および認可コード・クライアントシークレットの安全保護 |
| 2026-09-29 | Google Calendar REST クライアント（Task 1-2）の非冪等作成リトライ例外：`calendars.insert` および `acl.insert` は Google 側に一意な冪等性キーが存在しないため、明示的なレート制限（429 / 403 rateLimitExceeded）のみを再試行し、5xx サーバーエラーおよび曖昧なネットワーク切断時は自動再試行せず即座に `UNCERTAIN_MUTATION`（`outcome: 'uncertain'`）として fail-closed とする。呼び出し側が既存カレンダーの照合後に手動復旧する方針 | 重複した家族カレンダーや重複 ACL の多重作成防止 |
| 2026-09-29 | イベント作成（`events.insert`）における安定クライアント生成 ID：ID 未指定時は初回試行前に `crypto.randomUUID().replaceAll('-', '')`（Google base32hex 形式）を生成し、全再試行（429/5xx）で同一 ID を再利用する。409 Conflict は暗黙の成功とせず型付きエラーとして返却 | ネットワーク不達時の重複イベント登録防止および安全な後続照合の担保 |
| 2026-09-29 | Google Calendar エラーの完全サニタイズ：upstream のエラーメッセージや詳細・URL・ヘッダをレスポンスやログに出力せず、固定メッセージと許可リスト化された安全な reason（`rateLimitExceeded`, `notFound` 等）のみに制限した `GoogleCalendarError` を発行 | ユーザー名・メールアドレス・カレンダー ID・イベント詳細等の機密情報漏洩防止 |
| 2026-09-29 | `freeBusy.query` のプライバシー境界：返却オブジェクトからタイトル・場所・説明・参加者等を Zod で完全にストリップし、`start`/`end` のみを出力。またエラー状態のカレンダーを空の `busy: []` として扱うことを禁止し、エラーを正確に保持する | プライバシー不変条件の厳守および誤った空き時間判定の防止 |
| 2026-09-29 | workerd 実行環境における Google Calendar REST リクエスト：OAuth トークンエンドポイントと同様に全 API 呼び出しで `redirect: 'manual'` を指定し、3xx 応答を即座に拒否する | 資格情報の外部漏洩防止および workerd ランタイム制約への適合 |
| 2026-09-29 | Google Calendar REST 入出力における明示的 RFC3339 オフセットの必須化：時間指定日時（`dateTime`）およびクエリ境界（`timeMin`/`timeMax` 等）について、`timeZone` の有無に関わらず明示的なオフセット（`Z` または `±HH:MM`）を持つ RFC3339 形式のみを受け付けるサブセットとして運用。ホスト依存のローカルタイムパースを排除し、`Date.parse` による順序判定（`end > start`）の安全性を担保。任意の IANA `timeZone` は `Intl.DateTimeFormat` で実在性を検証 | タイムゾーン解釈の曖昧さ・環境差異の排除、およびライブラリ非依存での安全な順序比較の担保 |

## 未決事項

| # | 論点 | いつ決めるか | メモ |
|---|---|---|---|
| Q1 | `calendar.app.created` だけで (a) 家族カレンダーの ACL を追加できるか、(b) 招待された大人が自分のトークンで家族カレンダーを読み書きできるか | Phase 1（タスク 1-3） | (a) が不可なら `calendar.acls` を追加するか、手動共有の手順を案内する。(b) が不可なら、読み書きを作成者のトークンに寄せる（サーバー経由なので可能）か、`calendar.events` を Phase 1 から要求する |
| Q2 | Workers 上の Web Push の実装方法 | Phase 6（タスク 6-4） | WebCrypto 対応のライブラリか自前実装か |
| Q3 | プリント抽出に使う LLM のモデル、データ利用ポリシーの確認と記載 | Phase 4 の前 | 子どもの名前を含む画像を送るため、学習利用されない API 設定であることを確認する |
| Q4 | 送迎ブロックを担当者の個人カレンダーに書き出すか（仕事側に「いない」ことを伝えるため） | Phase 2 以降 | 書き出す場合は `mirrored_blocks` で二重表示を防ぐ。既定はオフが無難 |
| Q5 | 家族の時間帯（平日の夜など）の定義を固定にするか、設定にするか | Phase 6 | 初期値：平日 18–21 時、土日祝の終日 |
| Q6 | 空きの計算対象に子どもを含めるか（昼寝など子どものルーティンを入れるか） | Phase 2 | 初期は含める。子どものルーティンは家族予定として入れる |
| Q7 | 独自ドメイン | 一般公開の前 | 当面は `workers.dev` を使う（上の決定事項）。候補は、個人ドメインを取ってサブドメインに割り当てるか、プロダクト名確定後に専用ドメインを取るか。Google の OAuth 審査には所有ドメインが必須 |
| Q8 | 一般公開時の料金モデル（無料／買い切り／サブスク）。LLM のコストをどう賄うか | 一般公開の前 | — |
| Q9 | ビジュアルのリフレッシュをいつやるか | Phase 1 の後に一度見直す | 実データで使ってから決めたほうがよい |
