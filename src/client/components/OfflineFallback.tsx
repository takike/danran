export function OfflineFallback() {
  const handleReload = () => {
    window.location.reload();
  };

  return (
    <main
      data-testid="offline-screen"
      style={{
        maxWidth: '390px',
        margin: '0 auto',
        padding: 'var(--spacing-lg) var(--spacing-md)',
        minHeight: '100vh',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          backgroundColor: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--spacing-xl) var(--spacing-md)',
          textAlign: 'center',
        }}
      >
        <h1
          style={{
            fontSize: '20px',
            fontWeight: 700,
            margin: '0 0 var(--spacing-sm) 0',
            color: 'var(--ink)',
          }}
        >
          オフラインです
        </h1>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--muted)',
            margin: '0 0 var(--spacing-lg) 0',
            lineHeight: 1.6,
          }}
        >
          インターネット接続が切断されています。
          <br />
          接続が回復すると自動的に再接続されます。
        </p>
        <button
          type="button"
          onClick={handleReload}
          style={{
            minHeight: '44px',
            minWidth: '44px',
            padding: 'var(--spacing-sm) var(--spacing-lg)',
            backgroundColor: 'var(--accent)',
            color: 'var(--surface)',
            border: 'none',
            borderRadius: 'var(--radius-md)',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          再読み込み
        </button>
      </div>
    </main>
  );
}
