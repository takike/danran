import { AlertCircle } from 'lucide-react';
import type React from 'react';
import { useSearchParams } from 'react-router-dom';

/** Renders only allowlisted OAuth callback states; query text is never echoed. */
export function OAuthNotices(): React.ReactElement | null {
  const [searchParams] = useSearchParams();
  const rawError = searchParams.get('error');
  const personalGranted = searchParams.get('personal') === 'granted';
  const content =
    rawError === 'access_denied'
      ? { title: 'ログインが中断されました', body: 'Google ログインがキャンセルされました。' }
      : rawError === 'auth_expired'
        ? {
            title: '認証手続きを確認してください',
            body: '手続きの有効期限が切れたか、すでに完了しています。必要ならもう一度操作してください。',
          }
        : rawError === 'auth_failed'
          ? {
              title: 'ログインを完了できませんでした',
              body: 'Google ログインに失敗しました。許可画面の項目にチェックが入っているか確認してください。時間をおいて、もう一度お試しください。',
            }
          : rawError === 'personal_denied'
            ? {
                title: '個人予定の表示を許可できませんでした',
                body: 'Google の予定読み取りは有効になっていません。必要な場合は家族ページからもう一度お試しください。',
              }
            : rawError === 'personal_failed'
              ? {
                  title: '個人予定の表示を開始できませんでした',
                  body: 'Google との連携を確認できませんでした。時間をおいて、家族ページからもう一度お試しください。',
                }
              : rawError === 'personal_account_mismatch'
                ? {
                    title: 'Google アカウントを確認してください',
                    body: 'ログイン中のアカウントと予定を読み取るアカウントが異なります。Google アカウントを確認して、もう一度お試しください。',
                  }
                : null;

  if (!content && !personalGranted) return null;
  const notice = content ?? {
    title: '個人カレンダーを連携しました',
    body: '週ビューに表示するカレンダーを選んで保存してください。',
  };
  return (
    <div
      data-testid={
        personalGranted && !content
          ? 'personal-consent-success'
          : rawError === 'access_denied'
            ? 'access-denied-message'
            : rawError === 'auth_expired'
              ? 'auth-expired-message'
              : rawError === 'auth_failed'
                ? 'auth-failed-message'
                : 'personal-consent-error'
      }
      role={rawError === 'access_denied' ? undefined : 'alert'}
      className="mb-[var(--spacing-md)] flex items-start gap-[var(--spacing-sm)] rounded-[var(--radius-md)] border border-accent/20 bg-accent-tint p-[var(--spacing-md)] text-accent"
    >
      <AlertCircle size={18} aria-hidden="true" className="mt-[var(--spacing-2xs)] shrink-0" />
      <div className="text-xs leading-relaxed">
        <strong className="block font-semibold">{notice.title}</strong>
        <span>{notice.body}</span>
      </div>
    </div>
  );
}
