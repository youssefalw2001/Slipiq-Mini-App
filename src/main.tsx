import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

const legacyPath = window.location.pathname;
const hasHashRoute = window.location.hash.startsWith('#/');

if (legacyPath !== '/' && !hasHashRoute) {
  window.history.replaceState(null, '', `/#${legacyPath}${window.location.search}`);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
