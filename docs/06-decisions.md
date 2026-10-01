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
| 2026-09-29 | Google OAuth の一時フロー管理に `oauth_states` テーブルを採用し、コールバック時に `DELETE ... RETURNING` によるアトミック単一消費を徹底。ブラウザバインド（署名付き Cookie `__Host-danran_oauth` のハッシュ）と紐づけて PKCE verifier / nonce を AES-256-GCM で暗号化保持。認可コード横取り・リプレイ攻撃・多重送信を防止し、フロー完了時は即座に破棄 | 認可コード横取り・リプレイ攻撃・多重送信の防止、およびステートレス Cookie の容量制限・ブラウザ改ざんの排除 |
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
| 2026-09-29 | `closure_days` の `family_id` 外部キー順序と `member_ids` 規約：Task 1-4（家族の作成・参加）が `families` テーブルを所有するため、Task 1-5 ではスタブの families テーブルを作成せず、`family_id` は論理参照（FK なし）として配備。Task 1-4 実装時に新しいマイグレーションで FK を付与し、API/サービス層でメンバー所有権を検証する。`member_ids` は空配列 `[]` を家族全体休園日、非空配列を対象メンバー限定休園日と規約化し、保存スキーマでは必須化して暗黙拡大を防止 | 未実装テーブルの先行スタブ作成による競合防止、および休園日スコープ解釈の厳格化 |
| 2026-09-29 | 週ビューの範囲と祝日延長：週の起点を月曜日固定とし、日曜日に連続する国民の祝日（スポーツの日、シルバーウィーク等）を終端まで自動延長。平日が挟まった時点で延長を停止。ナビゲーションは表示日数に依存せず常に月曜起点 ±7 暦日とする | 週末と連休の一体的な把握、および安定した前週・次週カレンダーナビゲーションの担保 |
| 2026-09-29 | Asia/Tokyo 日時計算の統一：ホスト環境（Node、ブラウザ、Worker）のローカルタイム汚染を完全に防ぐため、`date-fns` と `@date-fns/tz`（`TZDate`）に集約。`TZDate.toISOString()` のオフセット挙動を考慮し、UTC 境界は明示的にエポックミリ秒から生成 | 実行環境に依存しない厳格な JST 判定および真の UTC ISO シリアライズの担保 |
| 2026-09-30 | フロントエンドのデータ取得・セッション管理に TanStack Query（v5）を採用。`QueryClientProvider` をルートに配備し、セッション取得（`/api/auth/me`）およびログアウト（`/api/auth/logout`）を管理。ログアウト処理時は未完了のセッションクエリをキャンセルした上でキャッシュを破棄し、遅れて到着したレスポンスによる再表示を防止 | 非同期状態管理の統一とログアウト時の競合防止のため |
| 2026-09-30 | ログイン UI とエラー通知の設計：Google OAuth ログインは同一オリジン `/api/auth/login` へのネイティブナビゲーションとし、コールバックでの同意拒否（`error=access_denied`）は安全な固定日本語メッセージ（「Google ログインがキャンセルされました。」）として表示（任意のクエリパラメータやエラー文字列の DOM 反映を禁止）。ホーム画面は表示名とログアウトボタンのみを表示し、メールアドレスの常時表示を排除 | 不正なパラメータ注入の防止およびプライバシー保護のため |
| 2026-09-30 | 静的プライバシーポリシー（`/privacy`）：認証 API やバックエンド Secret の設定状態に依存しない独立した公開ルートとして配置。Google 連携情報・リフレッシュトークン暗号化・3層データモデル（個人予定の内容は保持せず busy のみ共有）を平易な日本語で記載し、現在実装済みのログイン機能と将来の予定を明確に区分 | ユーザーへの情報提供および Google OAuth 同意画面要件の充足のため |
| 2026-09-30 | シークレット鍵フォーマットの明確化：`SESSION_SECRET` は `openssl rand -hex 32` による 64文字 16進文字列（256bit エントロピー、互換性のため 32文字以上の文字列も許容）を推奨とし、`TOKEN_ENC_KEY` は `openssl rand -base64 32` による標準 Base64 32バイト（44文字、末尾 `=`）に規約化。環境（local/staging/production）ごとに独立させ、ローテーション時の影響を文書化 | 鍵生成の標準化と運用の明確化のため |
| 2026-10-01 | カレンダー共有スパイク（Task 1-3）の検証アーキテクチャ：一時的な認証付き検証画面（`/spike/calendar-sharing`）および API（`/api/spike/calendar-sharing`）を配備。wrangler の `env.staging.vars` のみ `ENABLE_SPIKES: "true"` を設定し、local/production は未定義（デフォルト無効）。`assets.binding = "ASSETS"` および `assets.run_worker_first = ["/api/*", "/spike", "/spike/*"]` により、無効環境では SPA 静的アセット配信前に Worker が真の HTTP 404 を返却。Workbox `navigateFallbackDenylist` にも `/^\/spike(?:\/|$)/` を追加。新規 DB テーブルやスキーマ変更を行わず、jose と `SESSION_SECRET` による 24時間有効な短命 HS256 署名付きレシート（kind, userId, calendarId, eventId）をページメモリ内のみで保持し、カレンダー・予定の破壊的削除および ACL 付与を暗号学的にガード。E2E の SQLite ロック（SQLITE_BUSY）防止のため `DANRAN_PERSIST_PATH` による D1 永続化ディレクトリ分離を導入 | 実 Google アカウントによる共有権限境界（Q1）の客観的検証を安全に行うため。本番・ローカルへの不要な画面露出や DB マイグレーションの汚染を防ぎ、無効時のフェイルクローズおよび破壊的操作の境界を厳格に保護するため |
| 2026-10-01 | 家族カレンダーの共有方式：招待リンク発行時のみオーナーに `calendar.acls` を incremental authorization で追加要求し、参加時に `acl.insert`（writer、通知あり）。参加者はログイン時の `calendar.app.created` のみで家族カレンダーを読み書きする。参加者の Google カレンダー一覧への追加は共有通知メール経由（`calendar.calendarlist` は要求しない） | 1-3 スパイクの結果（acl.insert / calendarList.insert は 403、参加者の予定読み書きは可）。同意画面の権限を最小にし、強い権限は必要な人に必要なときだけ求めるため |

## 未決事項

| # | 論点 | いつ決めるか | メモ |
|---|---|---|---|
| Q1 | `calendar.app.created` だけで (a) 家族カレンダーの ACL を追加できるか、(b) 招待された大人が自分のトークンで家族カレンダーを読み書きできるか | Phase 1（タスク 1-3） | (a) が不可なら `calendar.acls` を追加するか、手動共有の手順を案内する。(b) が不可なら、読み書きを作成者のトークンに寄せる（サーバー経由なので可能）か、`calendar.events` を Phase 1 から要求する。**2026-10-01 解決**：(a) 不可（403）、(b) 可。共有は招待時のみ `calendar.acls` を追加同意、一覧への追加は共有通知メールから（下の記録を参照） |
| Q2 | Workers 上の Web Push の実装方法 | Phase 6（タスク 6-4） | WebCrypto 対応のライブラリか自前実装か |
| Q3 | プリント抽出に使う LLM のモデル、データ利用ポリシーの確認と記載 | Phase 4 の前 | 子どもの名前を含む画像を送るため、学習利用されない API 設定であることを確認する |
| Q4 | 送迎ブロックを担当者の個人カレンダーに書き出すか（仕事側に「いない」ことを伝えるため） | Phase 2 以降 | 書き出す場合は `mirrored_blocks` で二重表示を防ぐ。既定はオフが無難 |
| Q5 | 家族の時間帯（平日の夜など）の定義を固定にするか、設定にするか | Phase 6 | 初期値：平日 18–21 時、土日祝の終日 |
| Q6 | 空きの計算対象に子どもを含めるか（昼寝など子どものルーティンを入れるか） | Phase 2 | 初期は含める。子どものルーティンは家族予定として入れる |
| Q7 | 独自ドメイン | 一般公開の前 | 当面は `workers.dev` を使う（上の決定事項）。候補は、個人ドメインを取ってサブドメインに割り当てるか、プロダクト名確定後に専用ドメインを取るか。Google の OAuth 審査には所有ドメインが必須 |
| Q8 | 一般公開時の料金モデル（無料／買い切り／サブスク）。LLM のコストをどう賄うか | 一般公開の前 | — |
| Q9 | ビジュアルのリフレッシュをいつやるか | Phase 1 の後に一度見直す | 実データで使ってから決めたほうがよい |

### Q1 カレンダー共有スパイク（Task 1-3）実験記録枠

> [!NOTE]
> Task 1-3 の検証ツール（認証付き画面 `/spike/calendar-sharing`、API `/api/spike/calendar-sharing`、自動テスト）の実装は完了しています。
> 実 Google アカウント（Account A / Account B）による staging 環境での実機実験は**人間（管理者・検証者）の操作待ち（保留中・PENDING）**です。
> 実験完了後に結果を記録し、意思決定を行います（現時点では Q1 を完了・解決済みとしてマークしません）。
> 詳細な検証プロトコルおよび手順は [docs/13-calendar-sharing-spike.md](13-calendar-sharing-spike.md) を参照してください。

#### 実験環境およびアカウント情報（記録枠）

| 項目 | 記録内容 | 備考 |
|---|---|---|
| 実施日 | 2026-10-01 | — |
| 検証環境 | staging (`https://danran-staging.tak-ikemachi.workers.dev`) | `ENABLE_SPIKES === 'true'` |
| Account A エイリアス | `user-a`（カレンダー作成者） | 実メールアドレスはコミットしない |
| Account B エイリアス | `user-b`（招待される大人） | 実メールアドレスはコミットしない |
| スコープ確認（A） | 未確認（Danran 用の OAuth クライアントは 2026-09-29 新規作成で、Phase 1 の 5 スコープ以外を要求したことはない） | 余分な広範スコープが付与されていないことを確認 |
| スコープ確認（B） | 未確認（同上） | 余分な広範スコープが付与されていないことを確認 |

#### 実験結果記録テーブル

| 検証項目 | 実行主体 | 実行操作 | 期待される挙動 / 確認内容 | 成否 (OK/NG) | Google HTTP Status | safe reason | 備考・所見 |
|---|---|---|---|---|---|---|---|
| **事前準備** | Account A | カレンダー作成 (`calendars.insert`) | 検証用カレンダー "Danran spike" が作成され ID 発行 | OK | 200 | — | — |
| **事前準備** | Account A | 基準予定作成 (`events.insert`) | 合成予定 "Danran spike test" (2030-01-01) が登録される | 未実施 | — | — | 省略（B の events.list は 0 件、B 作成後の削除まで確認済み） |
| **Q1(a)** | Account A | ACL 付与 (`acl.insert`) | Account B のメールアドレスに対し writer 権限を付与できるか | **NG** | 403 | insufficientPermissions | 予想どおり。複数回再試行しても同一結果 |
| **手動共有** | 人間 | Google カレンダー Web UI 手動共有 | Q1(a) が 403 で拒否された場合のみ、Web UI から Account B に変更権限を手動共有 | OK | — | — | 実施有無: はい（「予定の変更」権限） |
| **補助検証** | Account B | リスト追加 (`calendarList.insert`) | Account B が共有カレンダーを自身のカレンダーリストに追加できるか | **NG** | 403 | insufficientPermissions | `calendarList.insert` は `calendar.calendarlist`（または `calendar`）が必要 |
| **Q1(b)-1** | Account B | 予定一覧取得 (`events.list`) | Account B 自身のトークンで共有カレンダーの予定一覧が読めるか（1件確認） | **OK** | 200 | — | 0 件（基準予定は未作成のため） |
| **Q1(b)-2** | Account B | 予定作成 (`events.insert`) | Account B 自身のトークンで共有カレンダーにテスト予定を登録できるか | **OK** | 200 | — | 合成予定 (2030-01-01) |
| **Q1(b)-3** | Account B | 予定削除 (`events.delete`) | Account B 自身が作成したテスト予定を削除できるか | **OK** | 204 | — | — |
| **後片付け** | Account A | カレンダー削除 (`calendars.delete`) | Account A のレシートで検証用カレンダーが削除されるか | 実施待ち | — | — | 3-a で削除予定 |

#### 意思決定ステータス

- **Q1(a) 判定（2026-10-01）**: `calendar.app.created` だけでは `acl.insert` は **不可**（403 insufficientPermissions）。共有方法は下の「1-4 の共有方式」で決める。
- **Q1(b) 判定（2026-10-01）**: 招待された大人は、自分のトークン（`calendar.app.created` のみ）で、共有された家族カレンダーの予定を **読み書き・削除できる**。作成者トークンへのプロキシや `calendar.events` の追加は不要。
- **補助（calendarList）**: `calendarList.insert` は今のスコープでは **不可**。招待された大人の Google カレンダー画面に家族カレンダーを出すには、共有通知メールからの追加、または `calendar.calendarlist` スコープが必要。
- **1-4 の共有方式（2026-10-01 決定）**: 招待リンク発行時に、オーナーにだけ `calendar.acls` を追加で同意してもらい（incremental authorization）、参加時にアプリが `acl.insert`（writer、`sendNotifications=true`）を実行する。参加者の Google カレンダー一覧への追加はスコープを増やさず、共有通知メールから追加してもらう。
