import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installBrowserErrorTelemetry } from '../../../src/lib/debug/browser-telemetry';
import { OpsApp } from './OpsApp';
import { OpsErrorBoundary } from './OpsErrorBoundary';
import '../styles/ops.css';

installBrowserErrorTelemetry();
const container = document.getElementById('root');
if (!container) throw new Error('REACT_OPS_ROOT_MISSING');

createRoot(container, {
  onCaughtError: error => console.error('OPS_REACT_CAUGHT', error),
  onRecoverableError: error => console.error('OPS_REACT_RECOVERABLE', error),
  onUncaughtError: error => console.error('OPS_REACT_UNCAUGHT', error),
}).render(<StrictMode><OpsErrorBoundary><OpsApp /></OpsErrorBoundary></StrictMode>);
