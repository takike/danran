import { BrowserRouter, Route, Routes } from 'react-router-dom';

function Home() {
  return (
    <main
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

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="*" element={<Home />} />
      </Routes>
    </BrowserRouter>
  );
}
