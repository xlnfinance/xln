import {
  parseWalletDeployVersionPayload,
  type WalletDeployVersionPayload,
} from '../../../packages/browser/src/wallet-deploy-version';

export type WalletDiagnosticTone = 'ok' | 'attention' | 'neutral';

export type WalletDiagnosticItem = Readonly<{
  label: string;
  value: string;
  detail: string;
  tone: WalletDiagnosticTone;
}>;

export type WalletBrowserCapabilityInput = Readonly<{
  online: boolean;
  secureContext: boolean;
  dedicatedWorkers: boolean;
  webLocks: boolean;
  serviceWorkers: boolean;
  localStorageReadable: boolean;
  persistedStorage: boolean | null;
  persistedStorageError: string;
}>;

const networkDiagnostic = (online: boolean): WalletDiagnosticItem => ({
  label: 'Network',
  value: online ? 'Online' : 'Offline',
  detail: online ? 'Browser connectivity is available.' : 'Network requests will fail until connectivity returns.',
  tone: online ? 'ok' : 'attention',
});

const secureContextDiagnostic = (available: boolean): WalletDiagnosticItem => ({
  label: 'Secure context',
  value: available ? 'Available' : 'Unavailable',
  detail: available ? 'Security-sensitive browser APIs may be used.' : 'Use HTTPS or localhost for the complete wallet feature set.',
  tone: available ? 'ok' : 'attention',
});

const dedicatedWorkerDiagnostic = (available: boolean): WalletDiagnosticItem => ({
  label: 'Dedicated workers',
  value: available ? 'Available' : 'Unavailable',
  detail: available ? 'Browser BrainVault work can run off the UI thread.' : 'Browser BrainVault derivation cannot start here.',
  tone: available ? 'ok' : 'attention',
});

const webLockDiagnostic = (available: boolean): WalletDiagnosticItem => ({
  label: 'Cross-tab lock',
  value: available ? 'Available' : 'Unavailable',
  detail: available ? 'This browser supports exclusive Runtime ownership.' : 'Embedded Runtime ownership cannot be coordinated safely.',
  tone: available ? 'ok' : 'attention',
});

const serviceWorkerDiagnostic = (available: boolean): WalletDiagnosticItem => ({
  label: 'PWA worker',
  value: available ? 'Available' : 'Unavailable',
  detail: available ? 'This browser supports the wallet service-worker lifecycle.' : 'Offline and push-wake support is unavailable.',
  tone: available ? 'ok' : 'neutral',
});

const localStorageDiagnostic = (readable: boolean): WalletDiagnosticItem => ({
  label: 'Local storage',
  value: readable ? 'Readable' : 'Blocked',
  detail: readable ? 'Device-local wallet metadata can be inspected.' : 'Stored adapter and deploy metadata cannot be read.',
  tone: readable ? 'ok' : 'attention',
});

const durableStorageDiagnostic = (
  persisted: boolean | null,
  error: string,
): WalletDiagnosticItem => ({
  label: 'Durable storage',
  value: persisted === null ? 'Unknown' : persisted ? 'Granted' : 'Best effort',
  detail: error || (persisted === null
    ? 'The browser does not expose origin-storage persistence status.'
    : persisted
      ? 'The origin is protected from routine storage eviction.'
      : 'The browser may evict origin storage under pressure.'),
  tone: persisted ? 'ok' : 'neutral',
});

export const resolveWalletBrowserDiagnostics = (
  input: WalletBrowserCapabilityInput,
): readonly WalletDiagnosticItem[] => [
  networkDiagnostic(input.online),
  secureContextDiagnostic(input.secureContext),
  dedicatedWorkerDiagnostic(input.dedicatedWorkers),
  webLockDiagnostic(input.webLocks),
  serviceWorkerDiagnostic(input.serviceWorkers),
  localStorageDiagnostic(input.localStorageReadable),
  durableStorageDiagnostic(input.persistedStorage, input.persistedStorageError),
];

export type WalletDeployVersionDiagnostic = Readonly<{
  status: 'aligned' | 'untracked' | 'changed' | 'unavailable';
  storedVersion: string;
  currentVersion: string;
  message: string;
}>;

export const resolveWalletDeployVersionDiagnostic = (
  storedVersion: string,
  payload: unknown,
): WalletDeployVersionDiagnostic => {
  const current: WalletDeployVersionPayload = parseWalletDeployVersionPayload(payload);
  if (!storedVersion) {
    return {
      status: 'untracked',
      storedVersion: 'Not recorded',
      currentVersion: current.version,
      message: 'The boot flow has not recorded a deploy version in this browser.',
    };
  }
  if (storedVersion === current.version) {
    return {
      status: 'aligned',
      storedVersion,
      currentVersion: current.version,
      message: 'Stored browser metadata matches the current deployment.',
    };
  }
  return {
    status: 'changed',
    storedVersion,
    currentVersion: current.version,
    message: current.ephemeralTestnet
      ? 'The ephemeral testnet deployment changed; the canonical boot flow may reset disposable data.'
      : 'The deployment changed; review recovery coverage before resetting local data.',
  };
};

export const unavailableWalletDeployVersionDiagnostic = (
  storedVersion: string,
  error: unknown,
): WalletDeployVersionDiagnostic => ({
  status: 'unavailable',
  storedVersion: storedVersion || 'Unavailable',
  currentVersion: 'Unavailable',
  message: `Deploy version check failed: ${error instanceof Error ? error.message : String(error)}`,
});
