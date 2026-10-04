import { ArrowLeft, ExternalLink } from 'lucide-react';
import type React from 'react';
import { Link } from 'react-router-dom';

/**
 * Public Japanese Privacy Policy page.
 *
 * Invariants:
 * - Independent of auth state, backend configuration, or secrets.
 * - Written in plain Japanese describing data uses rather than implementation internals.
 * - Plain headings: Googleアカウント情報, ログイン情報, カレンダー情報, 連携の解除.
 * - Accurately describes handling rules without absolute security guarantees.
 * - External Google permissions link is a standalone >= 44px control.
 * - All spacing and paddings use CSS tokens.
 */
export default function PrivacyPage(): React.ReactElement {
  return (
    <main
      data-testid="privacy-screen"
      className="mx-auto min-h-screen w-full max-w-[var(--app-max-width)] px-[var(--spacing-md)] py-[var(--spacing-lg)] bg-bg text-ink box-border"
    >
      <header className="mb-[var(--spacing-lg)]">
        <Link
          to="/"
          data-testid="back-to-home"
          className="inline-flex items-center gap-[var(--spacing-xs)] text-sm font-medium text-ink hover:text-muted min-h-[var(--tap-target-min)] px-[var(--spacing-xs)] py-[var(--spacing-sm)] rounded-[var(--radius-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          aria-label="ホームへ戻る"
        >
          <ArrowLeft size={18} aria-hidden="true" />
          <span>ホームへ戻る</span>
        </Link>
        <h1 className="text-xl font-bold text-ink mt-[var(--spacing-sm)]">プライバシーポリシー</h1>
        <p className="text-sm text-muted mt-[var(--spacing-xs)] leading-relaxed">
          Danran における情報の取り扱い方針について説明します。
        </p>
      </header>

      <article className="space-y-[var(--spacing-md)] text-sm leading-relaxed text-ink">
        {/* 1. Google account information */}
        <section
          className="p-[var(--spacing-md)] bg-surface border border-line rounded-[var(--radius-md)]"
          aria-labelledby="heading-account"
        >
          <h2
            id="heading-account"
            className="text-base font-semibold text-ink mb-[var(--spacing-xs)]"
          >
            Google アカウント情報
          </h2>
          <p className="text-muted m-0">
            ログインおよび本人確認のために、Google
            アカウントの表示名とメールアドレスを取得・保存して利用します。
          </p>
        </section>

        {/* 2. Login session and token storage */}
        <section
          className="p-[var(--spacing-md)] bg-surface border border-line rounded-[var(--radius-md)]"
          aria-labelledby="heading-login"
        >
          <h2
            id="heading-login"
            className="text-base font-semibold text-ink mb-[var(--spacing-xs)]"
          >
            ログイン情報
          </h2>
          <p className="text-muted mb-[var(--spacing-xs)]">
            ログイン状態を保つためにブラウザの Cookie を使用します。
          </p>
          <p className="text-muted m-0">
            カレンダー連携を継続するため、リフレッシュトークンはサーバー側で暗号化して保存します。一時的なアクセストークンはメモリ上でのみ扱い、保存しません。
          </p>
        </section>

        {/* 3. Calendar integration principles */}
        <section
          className="p-[var(--spacing-md)] bg-surface border border-line rounded-[var(--radius-md)]"
          aria-labelledby="heading-calendar"
        >
          <h2
            id="heading-calendar"
            className="text-base font-semibold text-ink mb-[var(--spacing-xs)]"
          >
            カレンダー情報
          </h2>
          <p className="text-muted mb-[var(--spacing-xs)]">
            専用の家族カレンダーの作成およびメンバー間の共有機能を提供しています。個人カレンダーの予定詳細は、同意した本人の週ビューに表示できます。個人の空き時間（busy）を家族と共有する機能は、今後のアップデートで提供予定です。
          </p>
          <p className="text-muted mb-[var(--spacing-xs)]">
            家族の設定や招待のために、家族名、メンバーのお名前（表示名）、および表示色をサーバーに保存して利用します。
          </p>
          <p className="text-muted mb-[var(--spacing-xs)]">
            Google
            の追加同意を行い、家族設定で表示を有効にした場合、選択した個人カレンダーの予定タイトルと時間を本人の週ビューにだけ表示します。予定の内容はサーバーにもアプリ内にも保存せず、他の家族の画面や
            API に返しません。サーバーに保存するのは選択したカレンダー ID のみです。
          </p>
          <p className="text-muted m-0">
            家族カレンダーの予定は Google
            カレンダー側に保存され、担当者や持ち物などの追加情報のみをアプリ側で保持します。
          </p>
        </section>

        {/* 4. Revocation and disconnect guidance */}
        <section
          className="p-[var(--spacing-md)] bg-surface border border-line rounded-[var(--radius-md)]"
          aria-labelledby="heading-revocation"
        >
          <h2
            id="heading-revocation"
            className="text-base font-semibold text-ink mb-[var(--spacing-xs)]"
          >
            連携の解除
          </h2>
          <p className="text-muted mb-[var(--spacing-md)]">
            アプリ内でのログアウトは端末でのログインセッションを終了する操作です。Google
            アカウント側で許可した連携は解除されません。連携を完全に解除したい場合は、以下のボタンから
            Google の管理画面を開いて設定してください。
          </p>
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-sm font-medium hover:bg-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus inline-flex items-center justify-center gap-[var(--spacing-xs)] text-center no-underline box-border cursor-pointer"
          >
            <span>Google アカウントの権限管理</span>
            <ExternalLink size={16} aria-hidden="true" />
          </a>
        </section>
      </article>

      <footer className="mt-[var(--spacing-xl)] pt-[var(--spacing-md)] border-t border-line text-center">
        <Link
          to="/"
          className="inline-flex items-center justify-center min-h-[var(--tap-target-min)] px-[var(--spacing-md)] text-sm text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          ホームへ戻る
        </Link>
      </footer>
    </main>
  );
}
