import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installBrowserErrorTelemetry } from '../../../src/lib/debug/browser-telemetry';

import { DocsPage } from '../pages/DocsPage';
import { DocsErrorBoundary } from './DocsErrorBoundary';
import '../styles/docs.css';

installBrowserErrorTelemetry();
const root = document.getElementById('root');
if (!root) throw new Error('REACT_DOCS_ROOT_MISSING');

window.addEventListener('error', event => {
  console.error('REACT_DOCS_WINDOW_ERROR', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', event => {
  console.error('REACT_DOCS_UNHANDLED_REJECTION', event.reason);
});

createRoot(root).render(
  <StrictMode>
    <DocsErrorBoundary><DocsPage /></DocsErrorBoundary>
  </StrictMode>,
);
