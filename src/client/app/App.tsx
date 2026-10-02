import { OfflineFallback } from '@client/components/OfflineFallback';
import { useIsOnline } from '@client/hooks/useIsOnline';
import HomePage from '@client/pages/HomePage';
import InviteJoinPage from '@client/pages/InviteJoinPage';
import OnboardingPage from '@client/pages/OnboardingPage';
import PrivacyPage from '@client/pages/PrivacyPage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

const DevUiPage = import.meta.env.DEV ? React.lazy(() => import('@client/pages/DevUiPage')) : null;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: true,
      staleTime: 0,
    },
  },
});

export function App() {
  const isOnline = useIsOnline();

  if (!isOnline) {
    return <OfflineFallback />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/invite" element={<InviteJoinPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route
            path="/spike/*"
            element={
              <div className="min-h-screen bg-bg text-ink flex flex-col items-center justify-center p-[var(--spacing-md)] text-sm">
                <p className="font-semibold">404 - ページが見つかりません</p>
              </div>
            }
          />
          {import.meta.env.DEV && DevUiPage ? (
            <Route
              path="/dev/ui"
              element={
                <React.Suspense
                  fallback={
                    <div className="p-[var(--spacing-md)] text-xs text-muted">読み込み中...</div>
                  }
                >
                  <DevUiPage />
                </React.Suspense>
              }
            />
          ) : null}
          <Route path="*" element={<HomePage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
