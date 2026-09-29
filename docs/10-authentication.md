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
- 32 文字以上の高エントロピーなランダム文字列（Hono `getSignedCookie` / `setSignedCookie` に使用）。

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
> **未検証ステータスおよび Secret 登録について**:
> 本タスク（Task 1-1）の時点では、実際の Google アカウントを用いた同意・認可画面遷移や実トークン発行の疎通確認は**未完了（UNVERIFIED）**です。
> Cloudflare staging 環境の Secret 登録状況は確認済み（`staging = []` verified 2026-09-29）、production 環境の Secret は未確認（not checked）です。
> ローカル環境では、合成フィクスチャによる Vite ＋ Worker 開発サーバーおよび永続 Chrome プロファイルの再起動検証（再起動前後の `/api/auth/me` 200 OK、ログアウト後の 200 OK および失効後 401 Unauthorized、`HttpOnly`/`Secure`/`no-store` の付与）が正常に確認されています。ただし、Cloudflare デプロイ環境での結合検証は未実施です。
> このタスクでは、外部サービスのアカウント設定や Secret 登録を人間（管理者）の担当作業として残しており、エージェントによる自動設定・登録は実施していません（権限管理上の制約による）。

### 1. Google Cloud Console 設定手順
1. Google Cloud Console でプロジェクトを作成（または既存プロジェクトを選択）。
2. **Google Calendar API** を有効化。
3. **OAuth 同意画面**を設定：
   - ユーザータイプ: 外部（External）
   - アプリ名: `Danran`
   - スコープ: `openid`, `email`, `profile`, `.../auth/calendar.app.created`, `.../auth/calendar.calendarlist.readonly` を追加。
   - 公開ステータス: 家族利用時は「本番（未確認）」を選択（※「テスト」のままだとトークンが 7 日で失効します）。
4. **OAuth 2.0 クライアント ID** を作成：
   - アプリケーションの種類: ウェブ アプリケーション
   - 承認済みのリダイレクト URI:
     - ローカル開発: `http://localhost:5173/api/auth/callback`
     - ステージング: `https://danran-staging.tak-ikemachi.workers.dev/api/auth/callback`
     - 本番: `https://danran.tak-ikemachi.workers.dev/api/auth/callback`

### 2. Cloudflare Secrets の登録手順
ステージングおよび本番環境の Worker に、以下の 4 つの Secret を登録します：

```bash
# staging
pnpm exec wrangler secret put GOOGLE_CLIENT_ID --env staging
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --env staging
pnpm exec wrangler secret put SESSION_SECRET --env staging
pnpm exec wrangler secret put TOKEN_ENC_KEY --env staging

# production
pnpm exec wrangler secret put GOOGLE_CLIENT_ID --env production
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --env production
pnpm exec wrangler secret put SESSION_SECRET --env production
pnpm exec wrangler secret put TOKEN_ENC_KEY --env production
```

※ ローカル開発環境では `.dev.vars.example` をコピーして `.dev.vars` を作成し、上記値を設定します。

---

## 9. 手動動作確認手順（UI 実装前の手動確認）

フロントエンド UI が未実装の段階で、ローカル環境（`pnpm dev`）およびブラウザ／curl による動作確認を行う手順：

1. **環境準備とマイグレーション**:
   - `.dev.vars.example` をコピーして `.dev.vars` を作成し、Google Cloud Console で発行した Client ID / Secret、生成した `SESSION_SECRET`、`TOKEN_ENC_KEY`、および `APP_ORIGIN=http://localhost:5173` を設定。
   - ローカル D1 マイグレーションを適用：
     ```bash
     pnpm db:migrate:local
     ```
   - 開発サーバーを起動：
     ```bash
     pnpm dev
     ```
2. **ログイン開始**:
   ブラウザで `http://localhost:5173/api/auth/login` にアクセス。
   → Google のアカウント選択・同意画面が表示されることを確認。
3. **同意とコールバック**:
   Google アカウントで同意を完了。
   → `http://localhost:5173/` へ 302 リダイレクトされ、開発者ツールの Application > Cookies に `__Host-danran_session` が発行されていることを確認。
4. **現在のセッション確認**:
   ブラウザで `http://localhost:5173/api/auth/me` にアクセス。
   → `{"user":{"id":"usr_...","email":"...","displayName":"..."}}` が 200 で返却されることを確認。
5. **永続性とサーバー再起動検証（Worker / ブラウザ再起動）**:
   - ※ **必ずログアウトの前に実施してください**（ログアウト後はセッションが消去されるため 401 となり、再起動永続性の検証ができなくなります）。
   - ターミナルで `pnpm dev` を停止（Ctrl+C）し、再度 `pnpm dev` を起動する。
   - ブラウザをリロード（F5）または一度閉じて再起動後、再度 `http://localhost:5173/api/auth/me` にアクセス。
   - セッションが D1 に正しく永続化され、再起動後も引き続き 200 OK でログイン状態が維持されることを確認。
6. **ログアウト確認（冪等性・セッション無効化）**:
   コンソールまたは Fetch API で POST リクエストを実行：
   ```js
   fetch('/api/auth/logout', {
     method: 'POST',
     headers: {
       'X-Requested-With': 'XMLHttpRequest',
     },
   }).then((r) => r.json()).then(console.log);
   ```
   → `{"ok":true}` が返り、Cookie が消去され、`/api/auth/me` が 401 Unauthorized になることを確認。
   → 続けてもう一度同じ logout リクエストを実行し、未認証状態でもエラーにならず 200 OK（`{"ok":true}`）が返却される（冪等）ことを確認。

---

## 10. 参考リンク（一次情報）

- [Google Identity: Using OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Identity: OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google Identity: PKCE Code Verifier & Challenge Guidelines](https://developers.google.com/identity/protocols/oauth2/native-app#step1-code-verifier)
- [panva/jose: Universal Web Cryptography JSON Object Signing and Encryption](https://github.com/panva/jose)
- [Hono Helpers: Cookie / Signed Cookie Helper](https://hono.dev/docs/helpers/cookie)
