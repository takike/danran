# 05. 実装計画

コーディングエージェント（Codex）に段階的に渡すための計画。**1タスク＝1PR** を目安にする。各タスクには受け入れ基準（AC）を付けた。フェーズの順番は「自分の家族で早く使い始められること」を優先している。

## 進め方

- 1セッションで扱うのは1フェーズまで。着手前に、このファイルと [AGENTS.md](../AGENTS.md)、関係する docs を読む。
- ブランチ名：`phase{N}/{task-id}-{短い説明}`（例：`phase1/1-3-google-client`）
- PR の説明には「対応タスク ID」「やったこと」「AC の確認結果」「スクリーンショット（UI の場合、390px 幅。置き場所とファイル名のルールは AGENTS.md の「PR のルール」）」「docs の更新箇所」「未解決の点」を書く。
- 実装中に設計を変えた場合や、未決事項を決めた場合は、同じ PR で [06-decisions.md](06-decisions.md) と該当 docs を更新する。
- 全タスク共通の完了条件（Definition of Done）
  - `pnpm typecheck`、`pnpm lint`、`pnpm test` が通る
  - `src/shared/domain` に追加したロジックにはユニットテストがある
  - UI はスマホ幅（390px）で崩れず、タップ領域は44px以上
  - Secret や個人情報（実在のカレンダー内容、写真）をコミットしていない

---

## Phase 0：基盤

ゴール：空のアプリが staging にデプロイされ、PWA としてインストールできる。

| ID | タスク | AC |
|---|---|---|
| 0-1 | **雛形**：pnpm、Vite＋React＋TS（strict）、`@cloudflare/vite-plugin`、Hono、`wrangler.jsonc`（Static Assets、SPA モード、`/api/*` を Worker で処理）、Biome、Vitest、パスエイリアス（`@client` `@worker` `@shared`）。ディレクトリ構成は [03](03-architecture.md#ディレクトリ構成目標) に従う | `pnpm dev` で画面が表示され、`GET /api/health` が `{ok:true}` を返す。`pnpm typecheck/lint/test` が通る |
| 0-2 | **PWA**：`vite-plugin-pwa`、manifest（name: Danran、short_name: だんらん、`display: standalone`、`lang: ja`）、仮アイコン、オフライン時のフォールバック画面 | Lighthouse の PWA インストール要件を満たす。iOS Safari でホーム画面に追加できる |
| 0-3 | **D1 ＋ Drizzle**：スキーマ定義の置き場、drizzle-kit 設定、`pnpm db:generate` / `pnpm db:migrate:local` / `db:migrate:staging`。R2 バインディングの宣言。`.dev.vars.example` | ローカル D1 にマイグレーションが適用され、テストから D1 を使える（`@cloudflare/vitest-pool-workers`） |
| 0-4 | **CI/CD**：GitHub Actions で lint/typecheck/test。`main` への push で staging にデプロイ（マイグレーション含む）、手動 workflow で production にデプロイ | PR で CI が走る。main マージで staging に反映される |
| 0-5 | **デザイントークンと基本部品**：`tokens.css`（[02 のトークン表](02-screens.md#ビジュアル暫定)）、Tailwind 連携、`Chip` `Card` `MemberDot` `Segmented` `IconButton` `TabBar`、アイコン（lucide-react 等の線画アイコン、絵文字は使わない）。開発用の部品一覧ページ `/dev/ui`（本番ビルドでは除外） | `/dev/ui` で全部品を確認できる。トークンの差し替えだけで配色が変わる |

## Phase 1：ログイン・家族・週ビュー（家族予定のみ）

ゴール：大人2人がログインし、同じ家族カレンダーの予定を週ビューで見て、追加・編集できる。追加した予定は普段の Google Calendar にも出る。

| ID | タスク | AC |
|---|---|---|
| 1-1 | **Google OAuth**：`/api/auth/login`（state・PKCE）、`/api/auth/callback`、`/api/auth/logout`、セッション Cookie、`users` `sessions` `google_tokens`（AES-GCM 暗号化）、アクセストークンの自動更新。このフェーズのスコープは `openid email profile calendar.app.created calendar.calendarlist.readonly` | ログイン・ログアウトできる。再起動後もセッションが続く。DB 上のリフレッシュトークンが平文でない |
| 1-2 | **Google Calendar REST クライアント**（`src/worker/google/`）：`calendars.insert`、`acl.insert`、`events.list/get/insert/patch/delete`、`events.instances`、`calendarList.list`、`freeBusy.query`。`fetch` ベース、zod でレスポンスを検証、429/5xx の指数バックオフ | 各メソッドに fetch をモックしたテストがある |
| 1-3 | **スパイク：家族カレンダーの共有方法**。(a) `calendar.app.created` だけで作成者が `acl.insert` できるか、(b) 招待されたもう1人の大人が、自分のトークン（`calendar.app.created`）で家族カレンダーの予定を読み書きできるか、を実際に検証する | 結果を [06-decisions.md](06-decisions.md) に記録し、必要ならスコープや手順を更新する |
| 1-4 | **家族の作成・参加**：オンボーディング（家族名 → 家族カレンダー作成 → 子どもの追加［名前・色］→ 招待リンク発行）、招待リンクから参加、`families` `members` `invites`。共有方式は 03 の「② 家族カレンダー」に従う：招待リンク発行時にオーナーへ `calendar.acls` を追加で同意してもらい（incremental authorization）、参加時に `acl.insert`（writer、`sendNotifications=true`）を実行する。参加者の Google カレンダー一覧への追加はアプリでは行わず、共有通知メールからの追加を案内する | 2つの Google アカウントで同じ家族に入れる。参加者が自分のトークンで家族カレンダーの予定を読み書きできる。オーナーの同意画面で `calendar.acls` は招待リンク発行時に初めて求められる（ログイン時には求めない）。参加者の Google カレンダーには共有通知メールから追加でき、その案内が参加完了画面に出る |
| 1-5 | **時間・祝日・レイアウトのドメインロジック**：`shared/time`（Asia/Tokyo 固定の日付ユーティリティ、週の範囲、連休で週末を延長）、`@holiday-jp/holiday_jp` による祝日、`closure_days`、`shared/domain/dayLayout` | テストケース：2026-10-05〜10-12（10/12 スポーツの日で3連休、週が月曜まで伸びる）、年末年始、振替休日、平日の単発予定で `expanded` になる |
| 1-6 | **`GET /api/families/:id/week`**：家族カレンダーの予定、`event_meta`、祝日・休園日、`dayLayout` を返す | レスポンスが zod スキーマ（shared）に合致する |
| 1-7 | **S1 週ビュー（家族予定版）**：平日 compact／expanded、週末カード（予定リストのみ。空きタイムラインは Phase 2）、前週・次週、メンバー凡例、タブバー（未実装のタブは「準備中」） | [02 の S1](02-screens.md#s1-週ビュー) の構造どおりに表示される。390px の Playwright スクリーンショット（`docs/screenshots/s1-week-view.png`）を更新する |
| 1-8 | **予定の作成・編集・削除**：タイトル、日時・終日、対象メンバー（子どもを含む）、担当、持ち物、候補／確定。`extendedProperties.private` と `event_meta` の両方に保存する | 作成した予定が Google Calendar に出る。Google Calendar 側で時間を変えても、アプリの表示が追従する（付加情報は保持される） |
| 1-9 | **設定（最小）**：メンバーの名前・色、休園日の登録 | 休園日が週ビューで「休園」として週末カード扱いになる |

## Phase 2：空き状況と「週末の1日」

ゴール：まず本人の個人予定を本人の画面だけに表示し、その後、週末の計画に家族全員の空きと共通の空きへの予定作成を加える。

実施順メモ：表では 2-2 → 2-3 → 2-4 と並ぶが、入力済みデータを計算するだけの純粋関数である 2-4 は 2-2・2-3 に依存しないため、先に実施する。2-3 の取得結果と 2-5 の表示から利用する。

| ID | タスク | AC |
|---|---|---|
| 2-1 | **本人の個人予定を表示**：`calendar.events.readonly` の追加同意（incremental authorization）、本人が選択した予定を本人の画面にだけ「自分だけ」表示 | 別の家族の API・画面に予定内容が出ないことをテストで保証する |
| 2-2 | **free/busy 対象カレンダーの選択**：設定画面で `calendarList` から選ぶ（`member_calendars`）。会社カレンダーを個人アカウントに共有する方法の案内文 | 選んだカレンダーだけが busy 計算に使われる |
| 2-3 | **free/busy 取得 API**：各 active 大人本人のトークンで `include_in_busy` 選択だけを `freeBusy.query` し、`GET /api/families/:id/week/busy` にメンバー別の busy 区間と `ready` / `not_shared` / `unavailable` を返す。予定情報・カレンダー情報は返さず、失敗はメンバーごとに分離する。`mirrored_blocks` の差し引きは個人カレンダー書き出し機能の後続タスクで扱う | **他の大人の予定情報・カレンダー情報が API レスポンスに含まれないことを検証するテスト**がある |
| 2-4 | **`shared/domain/freeWindows`**：メンバーごとの busy（個人 free/busy ＋ 家族予定 ＋ 担当）、`affects_availability` の除外、共通の空きの計算、30分未満の切り捨て | 境界（端点が接する、日をまたぐ、終日予定）のテストがある |
| 2-5 | **週末カードの空きタイムライン**：メンバー行と「共通」行、「みんな空き N時間」 | [S1](02-screens.md#s1-週ビュー) のとおりに表示される |
| 2-6 | **S2 週末の1日**：メンバー列のタイムライン、斜線の「予定あり」、共通の空き帯、候補カード、空き帯をタップしてその時間で予定作成 | [S2](02-screens.md#s2-週末の1日) のとおりに表示される。空き帯から作った予定の初期値が正しい |

## Phase 3：繰り返し予定

| ID | タスク | AC |
|---|---|---|
| 3-1 | **繰り返し予定の作成・最小一覧・シリーズ削除**：毎週（曜日の複数選択）・隔週、時間、対象、既定の担当、カテゴリ、`affects_availability`。Google の RRULE で作成し、`routine_settings` を保存する。S4 は一覧から作成・シリーズ全体削除まで | Google Calendar 上でも繰り返し予定として表示され、空き判定フラグが週ビューに反映される |
| 3-2 | **繰り返し予定の回ごとの操作**：直近4回のチップ、「この回を休む」（instance を cancelled）、「振替」（instance の日時を変更）、例外の表示 | [S4](02-screens.md#s4-繰り返し予定) の拡張範囲どおりに動作する |
| 3-3 | **祝日・年末年始・休園日のスキップ**：設定の変更時と月1の Cron で今後6か月分を適用・解除する。適用履歴を記録する | 祝日に当たる回（例：毎週火曜のスイミングの 2026-11-03〔文化の日〕）がキャンセルされる。設定をオフにすると元に戻る |
| 3-4 | **重複検出 `shared/domain/conflicts`** と表示（S4 の解決パネル、週ビューの警告） | 運動会（単発）とピアノ（毎週土）の重複が検出される |
| 3-5 | **ルーティン判定を dayLayout に反映**：通常回＝ルーティン、例外回・単発＝非ルーティン | 振替が入った平日が `expanded` になる |

## Phase 4：プリント取り込み

事前準備（人間）：実際の保育園プリントの写真を数枚用意し、名前などを塗りつぶしてから `fixtures/prints/`（コミットしない。`.gitignore` に入れる）に置く。

| ID | タスク | AC |
|---|---|---|
| 4-1 | **撮影・アップロード**：クライアントでリサイズ（長辺2000px・JPEG 0.8）→ `POST /api/imports` → R2 ＋ `attachments` ＋ `import_jobs`。写真は認可つきのエンドポイント `GET /api/attachments/:id` で配信 | 他の家族の写真に 403 が返る |
| 4-2 | **抽出モジュール**（`src/worker/llm/`）：プロンプト、JSON スキーマ（[03](03-architecture.md#プリント取り込み)）、Anthropic API 呼び出し（モデルは `LLM_MODEL`）、zod 検証、`shared/domain/importPostprocess`（年の補完、曜日の整合性チェック、`low` 判定、重複検出）。手動確認用スクリプト `pnpm extract:try <画像パス>` | 後処理のユニットテスト（LLM はモック、ゴールデン JSON で）。実画像で試した結果を PR に記載する |
| 4-3 | **S3 確認画面**：種類別の件数、チェック、編集、日付の候補ボタン、「写真で確認」（拡大表示）、重複の警告、週末の強調 | [S3](02-screens.md#s3-プリント取り込み) のとおりに動作する。`low` の項目は既定でオフ |
| 4-4 | **確定**：家族カレンダーへの一括作成、`event_meta` と添付の紐づけ、説明欄への写真リンク、締切と持ち物からの TODO 生成（Phase 5 のテーブルを先に作る） | 確定後、週ビューの予定に添付アイコンが付き、写真を開ける |
| 4-5 | **失敗・再試行**：抽出失敗時の表示と再試行。抽出結果の再利用 | 失敗したジョブを再試行できる |

## Phase 5：やること

| ID | タスク | AC |
|---|---|---|
| 5-1 | **tasks の API と自動生成**：[03 の表](03-architecture.md#やることtasksの自動生成)のルール。予定の変更・削除に追従（期限の再計算、予定削除で TODO を孤立させず「予定に紐づかない」に移す） | 生成ルールごとのテストがある |
| 5-2 | **S5 やること画面**：予定ごと／期限順／自分の担当、サマリーピル、進捗バー、担当の割り当て、完了 | [S5](02-screens.md#s5-やること) のとおりに動作する |
| 5-3 | **週ビューとの連携**：締切チップ、expanded カードに未完了の TODO 数 | — |

## Phase 6：公開ルール・週1まとめ・通知

| ID | タスク | AC |
|---|---|---|
| 6-1 | **公開コピー**：個人予定 → 家族カレンダーへのコピー（粒度 `title`/`details`）、`published_copies`、日次 Cron で元の予定の変更・削除に追従 | `title` のコピーに場所・説明が含まれない |
| 6-2 | **公開ルール**：複数日・終日・カレンダー単位・`#家族` タグ・キーワード。設定画面 | 出張（複数日）が自動で `title` 公開される |
| 6-3 | **週1まとめ**：日曜 20:00 JST の Cron で `digest_items` を生成（家族の時間帯・担当・家族全員の予定との重なり）、S6 画面、決定の反映、「次回から適用」でルール化 | [S6](02-screens.md#s6-週1の公開まとめ) のとおりに動作する |
| 6-4 | **スパイク：Workers 上の Web Push**：WebCrypto で動く実装・ライブラリの選定 | 結果を 06-decisions.md に記録する |
| 6-5 | **Web Push**：購読の登録、VAPID、送信（週1まとめ、TODO の当日朝）。iOS 向けに「ホーム画面に追加」の案内 | iOS（ホーム画面の PWA）と Android Chrome で通知を受け取れる |

## Phase 7：仕上げ（一般公開の前）

- ビジュアルのリフレッシュ（ポップな方向。トークンの差し替え＋イラスト・空状態のデザイン）
- オフライン時の表示（直近2週間のキャッシュ）、エラー状態、ローディングのスケルトン。Phase 0-2 の「オフライン中はアプリ全体をオフライン画面に差し替える」仮実装は、ここで「キャッシュ済みのデータを表示したまま、上部にオフラインのバナーを出す」形に置き換える
- `syncToken` による差分同期、`events.watch` の webhook
- プライバシーポリシー・利用規約ページ、Google OAuth の審査準備（センシティブスコープの利用目的の説明、デモ動画）
- 独自ドメイン、監視（Workers のログ・エラー通知）
- ネイティブ化の判断材料の整理（通知、カメラ、ウィジェット）
