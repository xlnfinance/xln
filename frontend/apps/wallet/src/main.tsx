import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { vaultOperations } from '$lib/stores/vaultStore';
import { installBrowserErrorTelemetry } from '$lib/debug/browser-telemetry';
import {
  describeAuthKey,
  persistRemoteRuntimeRequest,
  readRemoteRuntimeRequestFromUrl,
  remoteAcceptKey,
  stripRemoteRuntimeParamsFromHistory,
  type RemoteRuntimeRequest,
} from '$lib/utils/runtimeConnection';
import { WalletApp } from './WalletApp';
import { detectWalletEnvironment, walletBootController } from './wallet-controller';
import { WalletRemoteRuntimeLogin } from './WalletBootScreens';
import { WalletErrorBoundary } from './WalletErrorBoundary';
import { installWalletGlobalErrorSurface, reportWalletError } from './error-surface';
import { normalizeWalletEntryPath, parseWalletScenarioPreview } from './wallet-entry';
import '../styles/wallet.css';

const environment = detectWalletEnvironment();
const normalizedPath = normalizeWalletEntryPath(window.location.pathname, environment);
if (normalizedPath !== window.location.pathname) {
  window.history.replaceState(window.history.state, '', `${normalizedPath}${window.location.search}${window.location.hash}`);
}

const container = document.getElementById('root');
if (!container) throw new Error('REACT_WALLET_ROOT_MISSING');

installBrowserErrorTelemetry();
installWalletGlobalErrorSurface();

const scenarioPreview = parseWalletScenarioPreview(window.location.search);
const remoteRequest = scenarioPreview ? null : readRemoteRuntimeRequestFromUrl();
const initialPendingRemoteRequest = remoteRequest?.requiresAuthPaste ? remoteRequest : null;
if (initialPendingRemoteRequest) stripRemoteRuntimeParamsFromHistory();
if (remoteRequest && !remoteRequest.requiresAuthPaste) persistRemoteRuntimeRequest(remoteRequest);
if (!scenarioPreview && !initialPendingRemoteRequest) {
  void walletBootController.start().catch(error => reportWalletError('boot-promise', error));
}

const WalletEntry = () => {
  const [pendingRemoteRequest, setPendingRemoteRequest] = useState<RemoteRuntimeRequest | null>(
    initialPendingRemoteRequest,
  );
  const connectRemoteRuntime = async (authKey: string): Promise<void> => {
    if (!pendingRemoteRequest) throw new Error('REMOTE_RUNTIME_REQUEST_MISSING');
    if (!authKey) throw new Error('REMOTE_RUNTIME_CAPABILITY_REQUIRED');
    const acceptedRequest: RemoteRuntimeRequest = {
      ...pendingRemoteRequest,
      authKey,
      keyLabel: describeAuthKey(authKey),
      acceptKey: remoteAcceptKey(pendingRemoteRequest.wsUrl, authKey),
      requiresAuthPaste: false,
    };
    persistRemoteRuntimeRequest(acceptedRequest);
    await walletBootController.start();
    setPendingRemoteRequest(null);
  };
  return pendingRemoteRequest ? (
    <WalletRemoteRuntimeLogin
      hostLabel={pendingRemoteRequest.hostLabel}
      onConnect={connectRemoteRuntime}
    />
  ) : <WalletApp />;
};

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
      <WalletEntry />
    </WalletErrorBoundary>
  </StrictMode>,
);
