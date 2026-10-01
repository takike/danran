# 13. 家族カレンダー共有スパイク実施手順書（Task 1-3）

本ドキュメントは、Danran の家族カレンダー共有設計（未決事項 Q1）をステージング環境で実アカウント 2 名（アカウント A / アカウント B）を用いて検証するための実験手順、前提条件、記録用テーブル、およびフォールバック手順を定めたものです。

> [!IMPORTANT]
> **本タスクの受け入れ基準ステータス**:
> 検証ツール（画面 `/spike/calendar-sharing`、API `/api/spike/calendar-sharing`、暗号署名レシート、Vitest / Playwright テスト）の実装は完了しています。
> 実 Google アカウントによる staging 実機実験および Q1 の判定は**人間（オペレーター）の実施待ち（保留中・PENDING）**です。本タスクを全受け入れ基準完了としてマークせず、実験実施後に記録して意思決定を行います。

---

## 1. 実験の目的と背景（未決事項 Q1）

Danran では最小権限の原則（Least Privilege）に基づき、Phase 1 では広範な `calendar`（フルアクセス）や `calendar.events` を要求せず、以下の 5 スコープのみを要求しています：

1. `openid`
2. `email`
3. `profile`
4. `https://www.googleapis.com/auth/calendar.app.created`
5. `https://www.googleapis.com/auth/calendar.calendarlist.readonly`

このスコープ構成において、以下の 2 つの疑問（未決事項 Q1）を実 Google API 挙動で検証します：

- **Q1(a)**: カレンダー作成者（アカウント A）は、`calendar.app.created` のみで共有先（アカウント B）への `acl.insert`（writer 権限付与）を実行できるか？
- **Q1(b)**: 招待された側（アカウント B）は、自身のトークン（`calendar.app.created`）のみで、共有された家族カレンダーの予定を読み書き（`events.list` / `events.insert` / `events.delete`）できるか？
- **補助論点**: 招待された側（アカウント B）の Google カレンダー一覧への追加（`calendarList.insert`）は可能か？

### 候補スコープ（文書上の候補のみ・コード上は未要求）
もし既存スコープで拒絶された場合、最小限の候補スコープを検討します（※コード上は追加していません）：
- ACL 追加用: `https://www.googleapis.com/auth/calendar.acls`
- 招待カレンダー予定読み書き用: `https://www.googleapis.com/auth/calendar.events`
- カレンダー一覧追加用: `https://www.googleapis.com/auth/calendar.calendarlist`
※ 最上位のフル権限 `https://www.googleapis.com/auth/calendar` は不要な過剰権限であるため候補から除外します。

---

## 2. 実験前の厳格な前提条件と環境準備

1. **同一 OAuth クライアント ＋ 既存 5 スコープの確認**:
   - アカウント A およびアカウント B の双方が、同じ Google Cloud OAuth 2.0 クライアント ID で staging 環境にログインすること。
   - **注意（同一クライアントでの過剰権限汚染の排除）**: 対象の Google アカウントにおいて、**同一 OAuth クライアント / プロジェクト**に対して過去の開発等で `calendar` や `calendar.events` のフル権限が付与されている場合、実験結果が無効化されます（※無関係な別アプリの権限は Danran のトークンを汚染しません）。事前に Google アカウント設定（「セキュリティ」>「サードパーティ製のアプリとサービス」）にて、Danran に許可されたスコープが既存 5 スコープのみであることを確認・記録してください（ログインが成功したこと自体はスコープの限定性を証明しません）。
2. **ブラウザプロファイル・セッションの完全分離**:
   - **重要**: 同一ブラウザの複数のシークレットウィンドウ同士はセッション Cookie を共有してしまうため、アカウント A とアカウント B で同一ブラウザのシークレットウィンドウを 2 枚開くことは避けてください。
   - 以下のいずれかの方法で確実に分離してください：
     - 方法 1: アカウント A は通常プロファイル、アカウント B はシークレットウィンドウ。
     - 方法 2: ブラウザの別プロファイル（Profile 1 と Profile 2）を利用。
     - 方法 3: 異なるブラウザ（Chrome と Firefox 等）を利用。
3. **ステージング環境 URL**:
   - `https://danran-staging.tak-ikemachi.workers.dev/spike/calendar-sharing`
   - ※ staging 環境では `ENABLE_SPIKES="true"` が設定されているため利用可能です（local および production では 404 になり無効化されています）。
4. **アカウント A 画面の維持とレシート有効期限**:
   - 作成されたカレンダーおよび予定の削除レシートは、ブラウザのメモリ内のみで保持され、有効期限は 24 時間です。
   - 実験中はアカウント A のブラウザタブを閉じたりリロードしたりせず開いたままにしてください。

---

## 3. ステップ別実験手順

### ステップ 1: アカウント A によるカレンダー作成と ID 共有
1. アカウント A のプロファイルで staging にログイン後、`/spike/calendar-sharing` にアクセス。
2. 表示名がアカウント A のものであることを確認。
3. **「1-a. 検証カレンダーを作成」**をクリック（Google API: `calendars.insert`、固定 summary: `Danran spike`、`Asia/Tokyo`）。
   - **失敗・通信エラー時**: カレンダー作成時に失敗や通信エラー（ネットワーク切断等）が発生した場合、カレンダー ID や作成結果は未確定（リクエストが到達してカレンダーが作成済みである可能性あり）です。後続の操作を中止し、再試行する前にアカウント A の Google カレンダー Web UI を確認して「Danran spike」カレンダーが作成されていないか点検してください（作成されている場合は Web UI から手動削除して整理した上で再試行してください）。
4. 画面上に表示された**カレンダー ID**をコピーし、アカウント B の操作者へ伝達する。
5. （基準予定の確認）アカウント A の画面で対象カレンダー ID に作成カレンダー ID を設定し、**「2-c. テスト予定を作成」**をクリックして基準イベントを作成しておく（固定予定: 2030-01-01 12:00–12:15 JST、サマリー `Danran spike test`）。

### ステップ 2: Q1(a) の検証（ACL 付与）
1. アカウント A の画面の「共有先メールアドレス」欄にアカウント B のメールアドレスを入力。
2. **「1-b. 共有先へ writer 権限を付与」**をクリック（Google API: `acl.insert`、role: `writer`、`sendNotifications: false`）。
3. **結果の記録**:
   - 成功した場合: 成功と記録し、ステップ 3 へ進む。
   - 失敗した場合（403 Forbidden 等）:
     - 画面の操作履歴に表示された **Google HTTP ステータス**および**理由（reason）**を記録表に転記する（※生のログやエラーメッセージ、個人メールアドレスはコミットしない）。
     - **手動フォールバック（手動共有）**:
       アカウント A が普段の Google カレンダー Web UI（`https://calendar.google.com`）を開き、作成された「Danran spike」カレンダーの設定からアカウント B を手動で「予定の変更権限（writer）」として共有する。
       記録表に「手動共有実施: あり」と記録し、ステップ 3 へ進む。

### ステップ 3: アカウント B による補助論点検証（カレンダー一覧への追加）
1. アカウント B のプロファイルで staging にログインし、`/spike/calendar-sharing` にアクセス。
2. 表示名がアカウント B のものであることを確認。
3. 「対象カレンダー ID」欄にアカウント A から共有されたカレンダー ID を入力。
4. **「2-a. カレンダー一覧に追加」**をクリック（Google API: `calendarList.insert`）。
5. **結果の記録**:
   - 成功か、403（権限不足）かを記録。
   - ※ **重要**: `calendarList.insert` が 403 で失敗した場合でも、そのままステップ 4（予定の読み書き実験）を継続してください。一覧への登録可否と予定アクセス権は独立しています。

### ステップ 4: Q1(b) の検証（アカウント B 自身による予定の読み書き）
1. **読み取り検証（events.list）**:
   - **「2-b. 予定件数を取得」**をクリック（Google API: `events.list`）。
   - 件数（および `hasMore`）が表示されるか確認し記録。
   - ※ `events.list` の件数は 1 ページ目（単一ページ）の取得件数です。`hasMore` が `true` の場合は件数のみから全体の件数や影響を推測せず、アカウント A が新規作成した空の検証用カレンダー（「Danran spike」）であること、および Google カレンダー Web UI での実際の予定状況を確認してください。
   - **対象カレンダーの厳守**: オペレーターが操作対象とするカレンダーは、アカウント A から共有された新規作成の「Danran spike」カレンダー ID のみです（個人のプライベートカレンダー ID を入力してはいけません）。
2. **書き込み検証（events.insert）**:
   - **「2-c. テスト予定を作成」**をクリック（Google API: `events.insert`、固定合成予定: 2030-01-01 12:00–12:15 JST `Danran spike test`）。
   - 作成成功とイベント ID の発行を確認し記録。
   - 再度**「2-b. 予定件数を取得」**をクリックし、件数が 1 件増加したことを確認。
   - **失敗時**: 書き込みが失敗した場合、削除検証はスキップし、記録表の `events.delete` には「未実施（作成失敗のため）」と記入してください。
3. **削除検証（events.delete）**:
   - 書き込みに成功した場合のみ、**「2-d. 作成したテスト予定を削除」**をクリック（Google API: `events.delete`）。
   - 削除成功を確認し、再度**「2-b. 予定件数を取得」**をクリックして件数が元に戻ったことを確認。

### ステップ 5: 実験終了後のクリーンアップと機能無効化
1. アカウント A の画面に戻り、セクション 3 の**「3-a. 作成したカレンダーを削除」**をクリック（Google API: `calendars.delete`）。
2. カレンダーが Google カレンダーから削除されたことを確認。
3. （※タブを閉じてしまった場合やリロード等で削除に必要な情報（レシート）が失われた場合、あるいは 24 時間の有効期限が切れた場合は、アカウント A が Google カレンダー Web UI から「Danran spike」カレンダーを手動削除してください）。
4. **実験後のステージング機能無効化（運用メモ）**:
   人間による実機検証・クリーンアップおよび Q1 結果記録がすべて完了した後は、`wrangler.jsonc` の `env.staging.vars` から `ENABLE_SPIKES` を削除するか文字列 `'false'` に変更してステージングへ通常デプロイすることで、ステージング環境のスパイク機能を無効化（404 化）できます（※**現時点では無効化しないでください**。実機実験に必要です）。

### 3.1 通信エラー・不確定応答・無効応答への対処指針
- **操作が反映されている可能性**: 5xx やネットワーク切断（`UNCERTAIN_MUTATION` 等）、あるいは `INVALID_RESPONSE`（解析失敗やリソース ID 不一致）が発生した場合でも、Google カレンダー側には操作がすでに反映されている可能性があります。無闇にカレンダー作成や ACL 付与を繰り返さず、必ず Google カレンダー Web UI の状態を確認・手動整理してください（※リロードや画面終了等で削除に必要な情報が失われた場合の手動削除手順は上記ステップ 5 に記載）。
- **画面表示と記録の区別（Google HTTP ステータスと技術的エラー）**:
  - 画面に Google HTTP ステータスが表示されている場合は、その実際のステータス値（例: 403 やスキーマ不整合時の 200 等）および safe reason を記録表に転記してください。
  - Google の HTTP ステータスが表示されていない場合（ブラウザ側の通信エラーや解析失敗等で `googleStatus` が null の場合）は、Google ステータス欄に「Google応答未取得」と記載し、画面に表示されたコード（例: `NETWORK_ERROR`, `INVALID_RESPONSE`）を記録してください。なお、セッション失効（POST 401）時は履歴がクリアされ「ログインが必要です」画面へ遷移するため、その旨を記録してください。
  - `INVALID_RESPONSE`（スキーマ不整合やリソース ID 不一致等）は、たとえ Google ステータスが 200 であっても技術的障害として扱い、共有権限境界の成否が確定しない場合は Q1 の権限判定を「保留」のまま維持します。

---

## 4. 実験結果記録用テンプレート（人間が実験後に記入）

> [!NOTE]
> 現在は実験準備完了状態（ツール実装済み・人間による実機検証待ち）です。以下の表は空のテンプレートです。実験実施後に記入してください。

| 項目 | 記録内容 |
|---|---|
| 実験実施日時 | （未実施 / YYYY-MM-DD HH:MM JST） |
| 実行環境 | Staging (`https://danran-staging.tak-ikemachi.workers.dev`) |
| アカウント A 識別子（仮名） | UserA |
| アカウント B 識別子（仮名） | UserB |
| 事前スコープ確認 | アカウント A: [ ] 既存5スコープのみ確認済み / アカウント B: [ ] 既存5スコープのみ確認済み |
| **Q1(a) acl.insert 結果** | **[ 成功 / 失敗 (HTTP ステータス: ____, reason: ____) ]** |
| 手動共有フォールバック実施 | [ なし（APIで成功） / あり（Google Web UIで手動共有） ] |
| **補助 calendarList.insert 結果** | **[ 成功 / 失敗 (HTTP ステータス: ____, reason: ____) ]** |
| **Q1(b) events.list (読取)** | **[ 成功 (件数: __) / 失敗 (HTTP ステータス: ____, reason: ____) ]** |
| **Q1(b) events.insert (書込)** | **[ 成功 / 失敗 (HTTP ステータス: ____, reason: ____) ]** |
| **Q1(b) events.delete (削除)** | **[ 成功 / 失敗 (HTTP ステータス: ____, reason: ____) / 未実施 ]** |
| 実験後クリーンアップ | [ ] API削除完了 / [ ] Google Web UI手動削除 |
| **Q1 判定・結論** | 未判定（保留中・実験待ち） |

※ コミットする記録表には、実カレンダー ID、実イベント ID、実メールアドレス、トークン、生のリクエスト/レスポンスヘッダや生の Google レスポンスペイロードを含めないでください。

---

## 5. 参考公式ドキュメント

- [Google Calendar API: Acl.insert](https://developers.google.com/workspace/calendar/api/v3/reference/acl/insert)
  （※要求スコープとして `calendar` または `calendar.acls` が記載されており、`calendar.app.created` の記載はありません。実機での挙動を確認します）
- [Google Calendar API: CalendarList.insert](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/insert)
  （※要求スコープとして `calendar` または `calendar.calendarlist` が記載されています）
- [Google Calendar API: Events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
  （※公式ドキュメントの要求スコープ一覧には `calendar.app.created` や `calendar.events` 等が記載されています。招待されたアカウント B が自身の `calendar.app.created` トークンで共有カレンダーの予定を読み取れるかが、未決事項 Q1(b) の実機実験検証論点です）
- [Google Calendar API: Events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
  （※公式ドキュメントの要求スコープ一覧には `calendar.app.created` や `calendar.events` 等が記載されています。招待されたアカウント B の `calendar.app.created` での予定登録可否が Q1(b) の実機実験検証論点です）
- [Google Calendar API: Events.delete](https://developers.google.com/workspace/calendar/api/v3/reference/events/delete)
  （※公式ドキュメントの要求スコープ一覧には `calendar.app.created` や `calendar.events` 等が記載されています。招待されたアカウント B の `calendar.app.created` での予定削除可否が Q1(b) の実機実験検証論点です）
- [Google Calendar API: Calendars.delete](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/delete)
  （※`calendar.app.created` での作成カレンダー削除が対応しています）
- [Cloudflare Workers: Static Assets Binding](https://developers.cloudflare.com/workers/static-assets/binding/)
