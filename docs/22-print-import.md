# プリント取り込み（Task 4-1）

このタスクは写真を安全に保存し、家族の大人が一覧・表示・削除できるところまでを扱う。画像の読み取り、LLM の呼び出し、予定の作成は行わない。

## 保存するデータ

ブラウザーで画像の向きを補正し、長辺を最大 2000px に縮小して JPEG（初期品質 0.8）に再エンコードする。3 × 1024 × 1024 bytes（3 MiB）を超える場合は品質を下げて再エンコードし、それでも上限を超える画像は送らない。再エンコードで EXIF などの付加情報を落とす。サーバーも JPEG の構造・寸法・実際に読み取ったバイト数を検証し、EXIF APP1 を含む画像を拒否する。

R2 には縮小後の JPEG のみを保存する。`attachments` は家族 ID、R2 キー、MIME type、幅、高さ、バイト数、作成者、作成時刻を持つ。`import_jobs` は家族 ID、attachment ID、状態、抽出結果・エラー・モデル（このタスクでは空）、作成者、`clientRequestId`、作成時刻を持つ。二重送信防止の一意制約は家族・作成者・`clientRequestId` の組み合わせに置く。状態は `pending`、`extracted`、`failed`、`committed` を許し、このタスクでは `pending` のみを作る。`event_attachments` はこのタスクでは作らない。

元画像、ファイル名、位置情報、撮影機器情報、画像バイト列は D1 に保存しない。R2 キーは D1 の attachment 行に保存するが、ログ、エラー応答、API 応答、URLには出力しない。R2 キーはサーバーが `families/{familyId}/imports/{jobId}.jpg` の形で決める。`pending` の取り込みは家族ごとに最大20件。

## API

すべて `/api/families/:id/...` 以下。未ログインは 401、active な家族の大人でない利用者や他の家族のリソースは 404。家族の準備ができていない場合は `FAMILY_NOT_READY` を返す。変更系リクエストは既存 API と同じ `X-Requested-With`・`Origin` 検査を行う。入力・応答は `src/shared/schemas/imports.ts` で検証する。

| 操作 | 契約 |
|---|---|
| `POST /api/families/:id/imports` | `Content-Type: image/jpeg` の生バイト列。`X-Client-Request-Id` に UUID を指定する。成功時は `{ id, status, createdAt, createdByMemberId, attachment: { id, width, height } }`。 |
| `GET /api/families/:id/imports` | 新しい順の最大50件を `{ imports: [...] }` で返す。 |
| `GET /api/families/:id/attachments/:attachmentId` | 認可後に JPEG を返す。`Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`、`Content-Disposition: inline` を付ける。 |
| `DELETE /api/families/:id/imports/:importId` | 未確定の取り込みと写真を削除し `{ ok: true }` を返す。同じ削除の再送も成功扱い。 |

| HTTP status | code | 意味 |
|---:|---|---|
| 400 | `INVALID_INPUT`, `INVALID_JPEG`, `EXIF_NOT_ALLOWED` | UUID、JPEG 構造、寸法などの入力が不正 |
| 403 | `FORBIDDEN` | CSRF 検査などで変更系リクエストを拒否 |
| 401 | `UNAUTHORIZED` | セッションなし |
| 404 | `NOT_FOUND` | 家族外の利用者・リソース。存在を明かさない |
| 409 | `FAMILY_NOT_READY`, `PENDING_LIMIT_REACHED`, `UPLOAD_IN_PROGRESS`, `COMMITTED_IMPORT` | 現在の家族状態・上限・操作状態では処理できない |
| 413 | `IMAGE_TOO_LARGE` | 実際に読み取った本文が 3 MiB を超える |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `Content-Type` が `image/jpeg` でない |
| 500 | `INTERNAL_ERROR` | 保存・取得・削除に失敗。内部情報は応答に含めない |

POST は Content-Length の値だけを信用せず、実際に読み取ったサイズを上限と比較する。JPEG の SOF から寸法を確認し、幅・高さの各値が上限以内であることを確かめる。JPEG でない、壊れている、寸法超過、EXIF を含む、pending 件数超過の入力は固定コードで拒否する。同じ `X-Client-Request-Id` を再送した場合は最初の結果を返し、R2/D1 に二重作成しない。R2 保存後に D1 の batch 応答が失敗した場合は `client_request_id` で D1 を照合する。既存行が確認できれば保存済みの結果を返して R2 オブジェクトを保持する。D1 の照合自体ができない場合も、commit 済みの可能性があるため R2 を削除せず、固定エラーを返す。D1 に行がないと確認できた場合に限って補償として R2 オブジェクトを削除する。補償削除に失敗した場合や Worker が処理途中で停止した場合は R2 に孤立オブジェクトが残る可能性があり、現在は D1/R2 間の横断トランザクションや定期クリーンアップを設けていない。削除時は R2 の削除を先に行い、失敗した場合は D1 の行を残す。家族削除時は D1 の外部キー cascade が適用されるが、R2 の家族 prefix 削除はこのタスクの対象外。

## 画面と失敗時の扱い

`/import` はログイン済みで、家族の準備ができている利用者にだけ表示する。カメラ撮影と写真選択のどちらでも、送信前に縮小・再エンコードする。送信中はプレビューを残して操作を無効にする。失敗時もプレビューを残し、「もう一度送る」で同じ UUID を使って再送する。保存済み写真は認可付き API から取得し、閲覧画面を閉じるとフォーカスを元の操作へ戻す。削除は画面内で確認し、失敗時には一覧を保持して案内する。

ユーザー ID と家族 ID を一覧 query key に含める。ログアウト、利用者・家族の切替、画面を離れるときに古い写真を表示せず、生成した object URL を解放する。保存・削除後の一覧再取得はバックグラウンドで行い、同じ利用者・家族のキャッシュがある場合は再取得中も表示する。

Service Worker の precache 対象は静的ファイルに限られる。Workbox の `navigateFallbackDenylist` は `/api/` を除外し、`runtimeCaching` は空配列であるため、写真・API 応答は Service Worker のキャッシュ対象にならない（[vite.config.ts](../vite.config.ts)）。写真レスポンスにも `private, no-store` を指定する。

## staging 確認

1. staging で最新のマイグレーションを適用する。
2. active な大人としてログインし、タブバー中央の「プリントを撮影」から `/import` を開く。
3. 実機で撮影ボタンを押し、背面カメラが開くことを確認する。縦向き・横向きの合成テスト画像を撮影し、プレビューと保存後の向きが一致することを確かめる。
4. 個人情報を含まない合成画像を選び、保存後に一覧・拡大表示を確認する。
5. 写真を削除し、一覧から消えることを確認する。
6. 別の家族の利用者では対象家族の取り込み・写真を参照できず、404 になることを確認する。
7. Cloudflare 上で実データの画像、R2 キー、ファイル名がアプリログに出ていないことを確認する。

実機カメラ起動と縦横の向きの staging 確認は未実施。自動 E2E とコミットするスクリーンショットは合成画像だけを使う。

このタスクでは LLM API キーを設定せず、外部のモデル API を呼ばない。Task 4-2 で Gemini API を追加する際は、有料区分のプロジェクトで発行したキーを `GEMINI_API_KEY` に設定し、モデル名を `LLM_MODEL` で指定する。
