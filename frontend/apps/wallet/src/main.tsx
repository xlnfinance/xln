import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { vaultOperations } from '$lib/stores/vaultStore';
import { WalletApp } from './WalletApp';
import { detectWalletEnvironment, walletBootController } from './wallet-controller';
import { WalletErrorBoundary } from './WalletErrorBoundary';
import { installWalletGlobalErrorSurface, reportWalletError } from './error-surface';
import { normalizeWalletEntryPath } from './wallet-entry';
import '../styles/wallet.css';

const environment = detectWalletEnvironment();
const normalizedPath = normalizeWalletEntryPath(window.location.pathname, environment);
if (normalizedPath !== window.location.pathname) {
  window.history.replaceState(window.history.state, '', `${normalizedPath}${window.location.search}${window.location.hash}`);
}

const container = document.getElementById('root');
if (!container) throw new Error('REACT_WALLET_ROOT_MISSING');

installWalletGlobalErrorSurface();
void walletBootController.start().catch(error => reportWalletError('boot-promise', error));

window.addEventListener('pagehide', () => {
  try {
    vaultOperations.beginRuntimePageUnload();
  } catch (error) {
    reportWalletError('pagehide', error);
  }
});

createRoot(container, {
  onCaughtError: error => reportWalletError('react-caught', error),
  onRecoverableError: error => reportWalletError('react-recoverable', error),
  onUncaughtError: error => reportWalletError('react-uncaught', error),
}).render(
  <StrictMode>
    <WalletErrorBoundary>
      <WalletApp />
    </WalletErrorBoundary>
  </StrictMode>,
);
