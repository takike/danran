import { App } from '@client/app/App';
import React from 'react';
import ReactDOM from 'react-dom/client';
import '@client/styles/tokens.css';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
