# 10. 認証と Google OAuth 連携仕様（Task 1-1）

Danran の Google OAuth 2.0 認証、セッション管理、リフレッシュトークン暗号化、およびセキュリティ設計仕様書。

---

## 1. 概要とアーキテクチャ

Danran では、家族のプライバシー保護と Google カレンダー連携の両立のため、サーバーサイド Authorization Code フロー（PKCE S256 併用）および自律セッション管理を採用しています。

```
[ブラウザ]                           [Danran Worker]                      [Google OAuth / API]
    │                                       │                                      │
    │ 1. GET /api/auth/login                │                                      │
    │──────────────────────────────────────>│                                      │
    │                                       │ 2. oauth_states (PKCE+nonce暗号化)   │
    │<──────────────────────────────────────│                                      │
    │    302 Redirect (Google Auth URL)     │                                      │
    │    Set-Cookie: __Host-danran_oauth    │                                      │
    │                                       │                                      │
    │ 3. ユーザー同意・リダイレクト         │                                      │
    │─────────────────────────────────────────────────────────────────────────────>│
    │                                       │                                      │
    │ 4. GET /api/auth/callback?code=...    │                                      │
    │──────────────────────────────────────>│                                      │
    │                                       │ 5. DELETE oauth_states RETURNING     │
    │                                       │    (単一消費・アトミック検証)        │
    │                                       │ 6. POST /token (code_verifier 送信)  │
    │                                       │─────────────────────────────────────>│
    │                                       │<─────────────────────────────────────│
    │                                       │    access_token + refresh + id_token │
    │                                       │ 7. RS256 JWKS 検証 (jose)            │
    │                                       │ 8. D1: users ＋ google_tokens 保存   │
    │                                       │ 9. D1: sessions 作成 ＆ 署名 Cookie  │
    │<──────────────────────────────────────│                                      │
    │    302 Redirect (/)                   │                                      │
    │    Set-Cookie: __Host-danran_session  │                                      │
    │                                       │                                      │
    │ 10. GET /api/auth/me                  │                                      │
    │──────────────────────────────────────>│ (公開ユーザー情報のみ返却)            │
    │<──────────────────────────────────────│                                      │
    │    { user: { id, email, ... } }       │                                      │
```

---

## 2. エンドポイント一覧と仕様

| メソッド | パス | 認証要否 | 概要 | 主なレスポンス |
|---|---|---|---|---|
| `GET` | `/api/auth/login` | 不要 | Google OAuth 同意フローを開始。PKCE・state・nonce を生成し、Google 認可 URL へ 302 リダイレクト | 302 Redirect（Location: Google Auth URL、Set-Cookie: `__Host-danran_oauth`） |
| `GET` | `/api/auth/callback` | 不要 | Google からのリダイレクトを処理。state 単一消費、code 交換、ID Token 検証、セッション発行 | 302 Redirect（Location: `/`、Set-Cookie: `__Host-danran_session`） |
| `POST` | `/api/auth/logout` | 不要（CSRF検証必須・冪等） | セッション破棄。CSRF 防御のため `X-Requested-With: XMLHttpRequest` および完全一致 `Origin` が必須。未認証状態でも 200 OK を返却（冪等）し、Google の認可・リフレッシュトークンは破棄せず Danran セッションのみを消去 | 200 OK（`{ "ok": true }`、Set-Cookie: `Max-Age=0`） |
| `GET` | `/api/auth/me` | 必須 | 現在のセッションの公開ユーザー情報を取得 | 200 OK（`{ "user": { "id", "email", "displayName" } }`） / 401 Unauthorized |

### セキュリティレスポンスヘッダ

すべての認証関連エンドポイント（成功・リダイレクト・エラー問わず）において、以下のヘッダを常に強制適用します：
- `Cache-Control: no-store`
- `Pragma: no-cache`
- `Referrer-Policy: no-referrer`

---

## 3. Cookie 仕様と有効期限（TTL）

| Cookie 名 | 格納内容 | 属性 | TTL | 用途 |
|---|---|---|---|---|
| `__Host-danran_session` | 256bit 乱数トークンの HMAC-SHA256 署名値（`SESSION_SECRET`） | `HttpOnly; Secure; SameSite=Lax; Path=/` | 30日（2,592,000秒） | 永続ログインセッション。絶対有効期限（30d absolute TTL）で管理。DB には生の平文トークンではなく SHA-256 ハッシュ値のみを保持 |
| `__Host-danran_oauth` | 256bit 乱数ブラウザバインディングの HMAC-SHA256 署名値 | `HttpOnly; Secure; SameSite=Lax; Path=/` | 10分（600秒） | OAuth コールバック時のブラウザ紐付け検証用。コールバック処理（成功・拒否問わず）時に即時破棄 |

※ `__Host-` プレフィックス規約に準拠し、Domain 属性は付与せず、Path は `/` に固定します（localhost 開発環境でもブラウザの Secure 属性例外により同一に動作）。
※ ログアウト時（`POST /api/auth/logout`）は Danran のセッションレコードおよび Cookie のみを消去し、Google の認可・リフレッシュトークンは保持します（家族カレンダー連携を維持するため）。

---

## 4. Phase 1 要求スコープ

Danran では最小権限の原則（Least Privilege）を遵守し、Phase 1 では以下のスコープのみを要求します：

- `openid`: OpenID Connect 認証および ID Token 取得
- `email`: ユーザーのアカウントメールアドレス
- `profile`: ユーザーの表示名
- `https://www.googleapis.com/auth/calendar.app.created`: 家族共有カレンダーの作成および作成カレンダー上の予定の読み書き
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`: カレンダー一覧の読み取り（Phase 1-4/2-1 向け）

※ 空き時間取得用の `calendar.freebusy` や個人カレンダー読み取り用の `calendar.events` は、Phase 1 では要求せず、**Phase 2 以降で追加の同意を求める段階的認可（Incremental Authorization）**とします。

---

## 5. 暗号化方式と鍵フォーマット

### 1. `TOKEN_ENC_KEY`（リフレッシュトークン暗号化鍵）
- **アルゴリズム**: AES-256-GCM
- **鍵フォーマット**: 厳格な標準 Base64 エンコードされた 32 バイト（256 ビット）キー（末尾 `=` の 44 文字）。
- **生成コマンド例**:
  ```bash
  openssl rand -base64 32
  ```
- **暗号化エンベロープ形式**:
  `v1.<12バイトIVのbase64url>.<暗号文および128bit認証タグのbase64url>`
- **AAD（追加認証データ）による改ざん・置換防御**:
  - Google リフレッシュトークン暗号化時: `google-refresh:${userId}`
  - OAuth 一時ステート暗号化時: `oauth-state:${stateHash}`
  （行間置換や用途外復号攻撃を暗号学的に防止）。

### 2. `SESSION_SECRET`（Cookie HMAC 署名鍵）
- **アルゴリズム / 用途**: HMAC-SHA256（Hono `getSignedCookie` / `setSignedCookie` に使用）。
- **推奨生成コマンド**:
  ```bash
  openssl rand -hex 32
  ```
  （64文字の小文字16進文字列、256ビットエントロピー。互換性のため32文字以上の文字列も許容。詳細は [docs/08-deployment.md](08-deployment.md) 参照）。

---

## 6. コールバック時のアトミック単一消費（Anti-Replay）

一時テーブル `oauth_states` を使用し、コールバック受信時に即座にアトミックな削除クエリを実行します：

```sql
DELETE FROM oauth_states
WHERE state_hash = ? AND browser_binding_hash = ? AND expires_at > ?
RETURNING payload_enc;
```

- レコードが存在しない場合（期限切れ、ブラウザバインド不一致、既に消費済み）、Google へのトークン交換リクエスト（POST /token）は一切実行されず、即座に 400 Bad Request を返却します。
- OAuth state パラメータ、PKCE（RFC 7636 S256）、および暗号署名されたブラウザバインディング Cookie の多層防御により、認可コードの差し替えやブラウザ横断でのリプレイ、戻るボタンによる多重交換を防止します（※ state 単体ですべての認可コード横取り攻撃を防げるわけではなく、PKCE code_verifier やブラウザバインディングと組み合わせることで安全性を確保しています）。
- 同意画面で拒否（`error=access_denied` 等）された場合も、有効な state とブラウザバインドが存在する場合に限り DB レコードと Cookie をアトミックに消費・破棄し、ルート URL へ安全な固定エラーパラメータ（`/?error=access_denied`）でリダイレクトします。

---

## 7. オンデマンドアクセストークン取得（`getGoogleAccessToken`）

Google Calendar REST クライアント（Task 1-2 以降）向けに、`getGoogleAccessToken(env, userId)` を提供します：

1. D1 `google_tokens` からユーザーの暗号化リフレッシュトークンを取得し、復号。
2. Google トークンエンドポイントへ `grant_type=refresh_token` をリクエスト。
3. **安全設計**:
   - アクセストークンは D1 に永続化・キャッシュせず、アクセストークン取得ヘルパー呼び出しの都度（EVERY acquisition）、Google トークンエンドポイントから最新トークンを取得してメモリ上でのみ利用。
   - **workerd 実行環境互換性**: Google トークンエンドポイント呼び出し時は `redirect: 'manual'` を指定し、3xx リダイレクトを含む非 2xx 応答を即座に拒否（資格情報の外部漏洩を遮断）。
   - `invalid_grant`（同意取り消し・トークン失効）時: 既存の旧暗号文に一致する行のみを条件付き削除（`WHERE user_id = ? AND refresh_token_enc = ?`）し、`ReauthNeededError` をスロー。別端末での新規ログインによるトークン上書きを誤消去しません。
   - ネットワーク障害や 5xx / 429 発生時: DB のトークンは保持したまま `GoogleApiError` をスロー（一時的エラーによる誤失効を防止）。
   - Google によるリフレッシュトークン自律ローテーション時: 新トークンを AES-256-GCM で再暗号化し、条件付き UPDATE で安全に保存。返却スコープが存在する場合はスコープもアトミックに更新（空・部分スコープは拒否）し、省略時のみ既存スコープを維持。

---

## 8. 環境設定と人間による手順（Cloudflare / Google Cloud）

> [!IMPORTANT]
> **2026-10-01 人間による確認済みステータス**:
> - **Google Cloud Console**: Web OAuth クライアント作成済み。
> - **登録済みリダイレクト URI**:
>   - `http://localhost:5173/api/auth/callback`
>   - `https://danran-staging.tak-ikemachi.workers.dev/api/auth/callback`
> - **登録済みスコープ**:
>   `openid`, `email`, `profile`, `https://www.googleapis.com/auth/calendar.app.created`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
> - **Secret 登録状況**:
>   - local: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` が `.dev.vars` に設定済み。
>   - staging: すべての Secret（`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `TOKEN_ENC_KEY`）が Cloudflare Secrets に登録済み（2026-10-01 人間により確認）。
>   - production: OAuth 設定およびすべての Secret は**未確認**です。
> - **プライバシーポリシー公開 URL**:
>   staging 環境において公開 URL（`https://danran-staging.tak-ikemachi.workers.dev/privacy`）が利用可能（OAuth 同意画面の設定項目として利用可能。Google Cloud Console への登録有無は未確認）。
> - **ログイン動作確認状況**:
>   - staging 環境において、実 Google アカウントによるログインが正常に完了することを確認済み（2026-10-01 人間により確認）。
>   - ※ なお、実ステージング環境でのその他の詳細手動ケース（ログアウト後の再ログイン、ブラウザ再起動後のセッション維持、トークン自動更新・失効時のハンドリング等）は未確認（自動テストにてカバー）。

### 1. Google Cloud Console 設定手順
1. Google Cloud Console でプロジェクトを作成（または既存プロジェクトを選択）。
2. **Google Calendar API** を有効化。
3. **OAuth 同意画面**を設定：
   - ユーザータイプ: 外部（External）
   - アプリ名: `Danran`
   - スコープ: `openid`, `email`, `profile`, `.../auth/calendar.app.created`, `.../auth/calendar.calendarlist.readonly` を追加。
   - プライバシーポリシー URL（staging）: `https://danran-staging.tak-ikemachi.workers.dev/privacy`
   - 公開ステータス: 家族利用時は「本番（未確認）」を選択（※「テスト」のままだとトークンが 7 日で失効します）。
4. **OAuth 2.0 クライアント ID** を作成：
   - アプリケーションの種類: ウェブ アプリケーション
   - 承認済みのリダイレクト URI:
     - ローカル開発: `http://localhost:5173/api/auth/callback`
     - ステージング: `https://danran-staging.tak-ikemachi.workers.dev/api/auth/callback`
     - 本番: `https://danran.tak-ikemachi.workers.dev/api/auth/callback`

### 2. Cloudflare Secrets の登録手順
オペレーターは、環境構築時やシークレットローテーション時に以下のコマンドで登録します（staging は 2026-10-01 時点ですべて登録済み）：

```bash
# staging の Secret 登録・更新（SESSION_SECRET, TOKEN_ENC_KEY 等）
pnpm exec wrangler secret put GOOGLE_CLIENT_ID --env staging
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --env staging
pnpm exec wrangler secret put SESSION_SECRET --env staging
pnpm exec wrangler secret put TOKEN_ENC_KEY --env staging

# production の Secret 登録（本番稼働準備時に実施・未確認）
pnpm exec wrangler secret put GOOGLE_CLIENT_ID --env production
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --env production
pnpm exec wrangler secret put SESSION_SECRET --env production
pnpm exec wrangler secret put TOKEN_ENC_KEY --env production
```

※ **ローカル開発環境（`.dev.vars`）**: `.dev.vars` は**存在しない場合のみ** `.dev.vars.example` を参考に作成し、既存の `.dev.vars` を `cp` 等で上書きしてはいけません。

---

## 9. 手動動作確認手順（UI を用いた手動動作確認）

フロントエンド UI（Task 1-1）を用いたローカル環境（`pnpm dev`）およびステージング環境での動作確認手順：

1. **環境準備とマイグレーション**:
   - `.dev.vars` が未作成の場合のみ作成し、Google Client ID / Secret、生成した `SESSION_SECRET`、`TOKEN_ENC_KEY`、および `APP_ORIGIN=http://localhost:5173` を設定。
   - ローカル D1 マイグレーションを適用：
     ```bash
     pnpm db:migrate:local
     ```
   - 開発サーバーを起動：
     ```bash
     pnpm dev
     ```
2. **ログイン画面とプライバシーポリシーの確認**:
   - ブラウザで `http://localhost:5173/` にアクセス。
   - 「Danran」見出し、コンセプト説明、および「Google でログイン」ボタンが表示されることを確認。
   - 画面内の「プライバシーポリシー」リンクをクリックし、`/privacy` 画面に遷移して Google アカウント情報の利用方針、暗号化、および 3層モデルの説明が正しく表示され、ホームへ戻れることを確認。
3. **同意拒否（キャンセル）フローの確認**:
   - ホームの「Google でログイン」をクリック（同一オリジンの `/api/auth/login` 経由で Google 同意画面へ遷移）。
   - Google の同意画面で「キャンセル」（または拒否）を選択。
   - `http://localhost:5173/?error=access_denied` へ安全にリダイレクトされ、UI 上に日本語のキャンセル通知（「Google ログインがキャンセルされました。」）が表示されることを確認（任意のクエリパラメータやエラー文字列が DOM に露出しないことを確認）。
4. **ログイン完了とユーザー情報の確認**:
   - 再度「Google でログイン」をクリックし、Google アカウントで同意を完了。
   - `http://localhost:5173/` へ 302 リダイレクトされ、UI にユーザーの表示名（`displayName`）および「ログアウト」ボタンが表示されることを確認（メールアドレスや内部トークン値が不必要に表示されないことを確認）。
5. **Cookie 属性の確認**:
   - ブラウザの開発者ツール（Application > Cookies）を開き、`__Host-danran_session` が以下の安全な属性で発行されていることを確認：
     `HttpOnly: true`, `Secure: true`, `SameSite: Lax`, `Path: /`
   - クライアント JavaScript からセッション値やトークンが読み取れないことを確認。
6. **リロード耐性の確認**:
   - 画面をリロード（F5）し、セッションが維持され、再読み込み後もユーザーの表示名が表示されたままであることを確認。
7. **サーバー再起動およびブラウザ再起動による永続性検証**:
   - ※ **必ずログアウト前に実施してください**（ログアウト後はセッションが消去されるため、永続性の検証ができなくなります）。
   - ターミナルで `pnpm dev` を停止（Ctrl+C）し、再度 `pnpm dev` を起動。
   - ブラウザを閉じて再起動後、再度 `http://localhost:5173/` にアクセス。
   - D1 にセッションが正しく永続化されているため、再起動後もログイン状態（表示名）が維持されることを確認。
8. **ログアウトの確認（多重クリック防止・セッション無効化・再ログイン）**:
   - 「ログアウト」ボタンをクリック。
   - 処理中にボタンが無効化・ローディング表示（「ログアウト中...」）となり、多重クリックが防止されることを確認。
   - `POST /api/auth/logout`（`X-Requested-With: XMLHttpRequest` 付与）が実行され、D1 のセッションレコードおよび Cookie が破棄され、未ログイン画面（「Google でログイン」）に安全に戻ることを確認。
   - ブラウザで直接 `http://localhost:5173/api/auth/me` にアクセスし、401 Unauthorized になることを確認。
   - 再度「Google でログイン」から再ログインが正常に行えることを確認。
9. **アクセストークン自動更新（`getGoogleAccessToken`）について**:
   - オンデマンドでのアクセストークン取得、リフレッシュトークンによる自動更新、トークン失効（`invalid_grant`）時の安全なレコードクリーンアップ、およびエラーハンドリングは、Vitest 自動テスト（`test/auth.spec.ts`）において Google トークンエンドポイントのモックを用いてテストされています。
   - 実際の Google Calendar API との連携疎通は後続の Task 1-3（スパイク）にて実施するため、専用の検証用 API エンドポイント等は新設しません。
10. **テスト実行時のシークレット隔離（Vitest Pool）**:
   - Vitest（`@cloudflare/vitest-pool-workers`）による自動テストは、`vitest.config.ts` で `wrangler.configPath` を省略し、Miniflare オプション（`d1Databases: ['DB']`, `r2Buckets: ['PHOTOS']`, `APP_ORIGIN: 'http://localhost:5173'`）を明示指定して実行されます。
   - これによりローカル `.dev.vars` の自動読み込みを防止し、テスト用合成シークレットと厳格なネットワークモックの下で隔離実行されます。

---

## 11. 段階的認可（Incremental Authorization）と招待ログイン連携（Task 1-4）

Task 1-4 において、最小権限の原則（Least Privilege）を維持しながら家族カレンダー共有（ACL）を実現するため、Google OAuth 2.0 の段階的認可（Incremental Authorization）および招待付きログインを採用しています。

```
【オーナー：カレンダー共有権限の追加認可フロー】
[オーナーブラウザ]                     [Danran Worker]                     [Google OAuth]
       │                                     │                                    │
       │ 1. POST /api/families/:id/invites   │                                    │
       │────────────────────────────────────>│ (calendar.acls 未同意を検知)       │
       │<────────────────────────────────────│                                    │
       │    { authorizationRequired: true,   │                                    │
       │      authorizationUrl: GoogleURL }  │                                    │
       │                                     │                                    │
       │ 2. Google 認可画面へ遷移            │                                    │
       │─────────────────────────────────────────────────────────────────────────>│
       │    (scope: calendar.acls, include_granted_scopes: true)                  │
       │                                                                          │
       │ 3. 認可完了リダイレクト                                                  │
       │<─────────────────────────────────────────────────────────────────────────│
       │ 4. GET /api/auth/callback           │                                    │
       │────────────────────────────────────>│ 5. トークン更新 (D1: google_tokens)│
       │<────────────────────────────────────│                                    │
       │    302 Redirect (/onboarding?acl=granted)                                │
       │                                     │                                    │
       │ 6. POST /api/families/:id/invites   │                                    │
       │────────────────────────────────────>│ 7. acl.acls スコープ確認済み       │
       │<────────────────────────────────────│    招待リンク発行                  │
       │    { authorizationRequired: false,  │                                    │
       │      inviteUrl: .../invite#token }  │                                    │
```

### 1. オーナー向け共有権限の追加認可（`calendar.acls`）
- **基本スコープの不変性**: 通常ログイン（`GET /api/auth/login`）では `calendar.acls` を要求しません。家族カレンダーの共有（`acl.insert`）を必要とするオーナーが招待リンクを発行する瞬間にのみ追加同意を求めます。
- **認可パラメータ**: `include_granted_scopes: 'true'` を付与し、既存の 5 スコープを保持したまま `https://www.googleapis.com/auth/calendar.acls` を追加します。
- **コールバックと復帰**: 同意完了後は `/onboarding?acl=granted` へリダイレクトし、UI 上でユーザーが「招待リンクを発行する」を再度押すことで、実際の招待トークンが発行されます。同意拒否時は `/onboarding?error=acl_denied` へ安全な固定パラメータで戻り、任意のエラー文字列は DOM に反映しません。

### 2. 招待付きログイン（`POST /api/auth/login`）
- **未認証ユーザーの動線**: `/invite#<raw43token>` を開いた未ログインユーザーが「Google でログインして参加」を押すと、同一オリジンからの `POST /api/auth/login`（JSON ペイロード `{ inviteToken: raw43token }`）が送信されます。
- **暗号化 state への格納**: `oauth_states` テーブルに保存される一時暗号化ペイロード内に `inviteToken` を保持（ブラウザバインディングおよび AES-256-GCM で保護）。
- **復帰と URL フラグメント**: OAuth コールバック完了時、暗号化 state から `inviteToken` を復元し、302 リダイレクト先として `/invite#<inviteToken>` を指定します。トークンはクエリパラメータ（`?token=...`）や Cookie ではなく、URL フラグメント（`#`）としてブラウザにのみ渡され、サーバーアクセスログやリファラヘッダ（Referrer-Policy: `no-referrer`）への平文漏洩を完全に防止します。
- **自動参加の禁止（Explicit Confirmation）**: ログイン復帰後、即座に家族参加（`join`）API を自動実行することは固く禁止します。UI 上で家族名を確認し、ユーザー本人が明示的に「この家族に参加する」ボタンを押下して初めて `POST /api/invites/join` が実行されます。

---

## 12. 参考リンク（一次情報）

- [Google Identity: Using OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Identity: Incremental Authorization](https://developers.google.com/identity/protocols/oauth2/web-server#incremental-auth)
- [Google Identity: OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google Identity: PKCE Code Verifier & Challenge Guidelines](https://developers.google.com/identity/protocols/oauth2/native-app#step1-code-verifier)
- [panva/jose: Universal Web Cryptography JSON Object Signing and Encryption](https://github.com/panva/jose)
- [Hono Helpers: Cookie / Signed Cookie Helper](https://hono.dev/docs/helpers/cookie)
