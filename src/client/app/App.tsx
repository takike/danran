import { OfflineFallback } from '@client/components/OfflineFallback';
import { useIsOnline } from '@client/hooks/useIsOnline';
import React from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

function Home() {
  return (
    <main
      data-testid="home-screen"
      style={{
        maxWidth: '390px',
        margin: '0 auto',
        padding: 'var(--spacing-lg) var(--spacing-md)',
        minHeight: '100vh',
        boxSizing: 'border-box',
      }}
    >
      <header
        style={{
          borderBottom: '1px solid var(--line)',
          paddingBottom: 'var(--spacing-md)',
        }}
      >
        <h1
          style={{
            fontSize: '24px',
            fontWeight: 700,
            margin: 0,
            color: 'var(--ink)',
          }}
        >
          Danran
        </h1>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--muted)',
            margin: 'var(--spacing-sm) 0 0 0',
            lineHeight: 1.5,
          }}
        >
          ルーティンは背景に、週末は前景に。家族の時間を守るカレンダー。
        </p>
      </header>

      <section
        style={{
          marginTop: 'var(--spacing-xl)',
          padding: 'var(--spacing-md)',
          backgroundColor: 'var(--surface)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--line)',
        }}
      >
        <h2
          style={{
            fontSize: '16px',
            fontWeight: 600,
            margin: '0 0 var(--spacing-sm) 0',
            color: 'var(--ink)',
          }}
        >
          準備中
        </h2>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--muted)',
            margin: 0,
            lineHeight: 1.6,
          }}
        >
          ただいまサービスを準備しています。
        </p>
      </section>
    </main>
  );
}

const DevUiPage = import.meta.env.DEV ? React.lazy(() => import('@client/pages/DevUiPage')) : null;

export function App() {
  const isOnline = useIsOnline();

  if (!isOnline) {
    return <OfflineFallback />;
  }

  return (
    <BrowserRouter>
      <Routes>
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
        <Route path="*" element={<Home />} />
      </Routes>
    </BrowserRouter>
  );
}
