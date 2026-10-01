import { OfflineFallback } from '@client/components/OfflineFallback';
import { useIsOnline } from '@client/hooks/useIsOnline';
import HomePage from '@client/pages/HomePage';
import PrivacyPage from '@client/pages/PrivacyPage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

const DevUiPage = import.meta.env.DEV ? React.lazy(() => import('@client/pages/DevUiPage')) : null;
const SpikeCalendarSharingPage = React.lazy(() => import('@client/pages/SpikeCalendarSharingPage'));

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
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route
            path="/spike/calendar-sharing"
            element={
              <React.Suspense
                fallback={
                  <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-[var(--spacing-md)] text-xs text-muted">
                    読み込み中...
                  </div>
                }
              >
                <SpikeCalendarSharingPage />
              </React.Suspense>
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
