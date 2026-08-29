import { useCallback, useEffect, useRef, useState } from 'react';

import {
  WALLET_DEPLOY_VERSION_KEY,
} from '../../../packages/browser/src/wallet-deploy-version';
import type { WalletRuntimeSummary } from './app-shell-model';
import {
  resolveWalletBrowserDiagnostics,
  resolveWalletDeployVersionDiagnostic,
  unavailableWalletDeployVersionDiagnostic,
  type WalletDeployVersionDiagnostic,
} from './wallet-diagnostics-model';
import './styles/wallet-diagnostics.css';

type WalletDiagnosticsState = Readonly<{
  browserItems: ReturnType<typeof resolveWalletBrowserDiagnostics>;
  release: WalletDeployVersionDiagnostic;
}>;

const emptyRelease: WalletDeployVersionDiagnostic = {
  status: 'unavailable',
  storedVersion: 'Checking…',
  currentVersion: 'Checking…',
  message: 'Reading current deployment metadata.',
};

const readStoredDeployVersion = (): Readonly<{ value: string; readable: boolean; error: unknown }> => {
  try {
    return {
      value: String(localStorage.getItem(WALLET_DEPLOY_VERSION_KEY) || '').trim(),
      readable: true,
      error: null,
    };
  } catch (error: unknown) {
    return { value: '', readable: false, error };
  }
};

type PersistedStorageProbe = Readonly<{ value: boolean | null; error: string }>;

const readPersistedStorage = async (): Promise<PersistedStorageProbe> => {
  if (!navigator.storage?.persisted) return { value: null, error: '' };
  try {
    return { value: await navigator.storage.persisted(), error: '' };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { value: null, error: `Persistence status failed: ${message}` };
  }
};

const fetchCurrentDeployVersion = async (signal: AbortSignal): Promise<unknown> => {
  const response = await fetch(`/api/jurisdictions?ts=${Date.now()}`, {
    cache: 'no-store',
    signal,
    headers: {
      'cache-control': 'no-cache, no-store, must-revalidate',
      pragma: 'no-cache',
    },
  });
  if (!response.ok) throw new Error(`DEPLOY_VERSION_FETCH_FAILED:${response.status}`);
  return response.json();
};

export function WalletDiagnostics({
  runtime,
}: Readonly<{ runtime: WalletRuntimeSummary }>) {
  const [state, setState] = useState<WalletDiagnosticsState>({
    browserItems: [],
    release: emptyRelease,
  });
  const [refreshing, setRefreshing] = useState(true);
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    activeRequest.current?.abort();
    const request = new AbortController();
    activeRequest.current = request;
    setRefreshing(true);
    const stored = readStoredDeployVersion();
    const persistedStorage = await readPersistedStorage();
    if (request.signal.aborted) return;
    const browserItems = resolveWalletBrowserDiagnostics({
      online: navigator.onLine,
      secureContext: window.isSecureContext,
      dedicatedWorkers: typeof Worker !== 'undefined',
      webLocks: Boolean(navigator.locks),
      serviceWorkers: 'serviceWorker' in navigator,
      localStorageReadable: stored.readable,
      persistedStorage: persistedStorage.value,
      persistedStorageError: persistedStorage.error,
    });
    if (!stored.readable) {
      setState({
        browserItems,
        release: unavailableWalletDeployVersionDiagnostic('', stored.error),
      });
      setRefreshing(false);
      return;
    }
    try {
      const release = resolveWalletDeployVersionDiagnostic(
        stored.value,
        await fetchCurrentDeployVersion(request.signal),
      );
      if (request.signal.aborted) return;
      setState({ browserItems, release });
    } catch (error: unknown) {
      if (request.signal.aborted) return;
      setState({
        browserItems,
        release: unavailableWalletDeployVersionDiagnostic(stored.value, error),
      });
    } finally {
      if (activeRequest.current === request) {
        activeRequest.current = null;
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [refresh]);

  return (
    <section className="wallet-diagnostics" aria-labelledby="wallet-diagnostics-title">
      <header className="wallet-diagnostics-heading">
        <div>
          <p className="wallet-shell-eyebrow">Redacted device report</p>
          <h1 id="wallet-diagnostics-title">Wallet diagnostics</h1>
          <p>Live browser signals and deployment metadata, refreshed only on request.</p>
        </div>
        <button disabled={refreshing} onClick={() => void refresh()} type="button">
          {refreshing ? 'Checking…' : 'Refresh report'}
        </button>
      </header>

      <section className="wallet-diagnostics-section" aria-labelledby="wallet-runtime-diagnostics-title">
        <div className="wallet-diagnostics-section-heading">
          <div>
            <p>01</p>
            <h2 id="wallet-runtime-diagnostics-title">Runtime selection</h2>
          </div>
          <span>Configuration, not a connection handshake</span>
        </div>
        <dl className="wallet-diagnostics-runtime">
          <div><dt>Adapter</dt><dd>{runtime.modeLabel}</dd></div>
          <div><dt>Endpoint</dt><dd>{runtime.endpointLabel}</dd></div>
          <div><dt>Command authority</dt><dd>{runtime.authorityLabel}</dd></div>
          <div><dt>Browser link</dt><dd>{runtime.browserLabel}</dd></div>
        </dl>
      </section>

      <section className="wallet-diagnostics-section" aria-labelledby="wallet-browser-diagnostics-title">
        <div className="wallet-diagnostics-section-heading">
          <div>
            <p>02</p>
            <h2 id="wallet-browser-diagnostics-title">Browser capabilities</h2>
          </div>
          <span>{state.browserItems.length} checks</span>
        </div>
        <div className="wallet-diagnostics-grid">
          {state.browserItems.map((item) => (
            <article data-tone={item.tone} key={item.label}>
              <p>{item.label}</p>
              <strong>{item.value}</strong>
              <span>{item.detail}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="wallet-diagnostics-section" aria-labelledby="wallet-release-diagnostics-title">
        <div className="wallet-diagnostics-section-heading">
          <div>
            <p>03</p>
            <h2 id="wallet-release-diagnostics-title">Release alignment</h2>
          </div>
          <span className={`is-${state.release.status}`}>{state.release.status}</span>
        </div>
        <dl className="wallet-diagnostics-release">
          <div><dt>Stored deploy</dt><dd>{state.release.storedVersion}</dd></div>
          <div><dt>Current deploy</dt><dd>{state.release.currentVersion}</dd></div>
        </dl>
        <p className={`wallet-diagnostics-message is-${state.release.status}`} role={state.release.status === 'unavailable' || state.release.status === 'changed' ? 'alert' : undefined}>
          {state.release.message}
        </p>
      </section>

      <p className="wallet-diagnostics-boundary">
        This report never includes capability secrets, identity secrets, Runtime state, or financial data.
      </p>
    </section>
  );
}
