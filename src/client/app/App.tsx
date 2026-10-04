import { OfflineFallback } from '@client/components/OfflineFallback';
import { useSessionQuery } from '@client/features/auth/useSession';
import { PwaUpdateBanner } from '@client/features/pwa/PwaUpdateBanner';
import { useIsOnline } from '@client/hooks/useIsOnline';
import ComingSoonPage from '@client/pages/ComingSoonPage';
import FamilyPage from '@client/pages/FamilyPage';
import HomePage from '@client/pages/HomePage';
import InviteJoinPage from '@client/pages/InviteJoinPage';
import OnboardingPage from '@client/pages/OnboardingPage';
import PrivacyPage from '@client/pages/PrivacyPage';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useRef } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';

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

function PrivateCacheGuard(): null {
  const { data: user, isError } = useSessionQuery();
  const queryClient = useQueryClient();
  const userId = user?.id;
  const previousUserId = useRef<string | undefined>(userId);

  useEffect(() => {
    const identityChanged = previousUserId.current !== userId;
    const oldUserId = previousUserId.current;
    previousUserId.current = userId;
    if (oldUserId && (identityChanged || isError || !userId)) {
      void (async () => {
        await queryClient.cancelQueries({ queryKey: ['week', oldUserId] });
        await queryClient.cancelQueries({ queryKey: ['families', oldUserId] });
        queryClient.removeQueries({ queryKey: ['week', oldUserId] });
        queryClient.removeQueries({ queryKey: ['families', oldUserId] });
      })();
    }
  }, [isError, queryClient, userId]);

  return null;
}

function RouteAwarePrivateCacheGuard(): React.ReactElement | null {
  const { pathname } = useLocation();
  const isPublicOnlyRoute =
    pathname === '/privacy' ||
    pathname === '/dev/ui' ||
    pathname === '/spike' ||
    pathname.startsWith('/spike/');

  return isPublicOnlyRoute ? null : <PrivateCacheGuard />;
}

export function App() {
  const isOnline = useIsOnline();

  return (
    <>
      <PwaUpdateBanner />
      {!isOnline ? (
        <OfflineFallback />
      ) : (
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <RouteAwarePrivateCacheGuard />
            <Routes>
              <Route path="/family" element={<FamilyPage />} />
              <Route path="/coming-soon" element={<ComingSoonPage feature="capture" />} />
              <Route path="/import" element={<ComingSoonPage feature="capture" />} />
              <Route path="/routines" element={<ComingSoonPage feature="routines" />} />
              <Route path="/tasks" element={<ComingSoonPage feature="tasks" />} />
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
                        <div className="p-[var(--spacing-md)] text-xs text-muted">
                          読み込み中...
                        </div>
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
      )}
    </>
  );
}
