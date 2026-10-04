import { App } from '@client/app/App';
import { startPwaUpdateManager } from '@client/features/pwa/updateManager';
import React from 'react';
import ReactDOM from 'react-dom/client';
import '@client/styles/tokens.css';

const stopPwaUpdateManager = startPwaUpdateManager();
if (import.meta.hot) import.meta.hot.dispose(stopPwaUpdateManager);

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
