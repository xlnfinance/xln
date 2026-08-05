import { useEffect, useState } from 'react';

import { useExternalStore } from '../../../packages/react-adapters/use-external-store';
import { settingsExternalStore } from '$lib/stores/settingsStore';
import { runtimesStateExternalStore } from '$lib/stores/vaultStore';
import { readAnyOnboardingComplete, writeOnboardingCompleteForEntities } from '$lib/utils/onboardingState';
import {
  createOrImportWallet,
  generateWalletMnemonic,
  lockWalletRuntime,
  recoverWalletFromConfiguredBackups,
  selectWalletRuntime,
  unlockWalletRuntime,
  walletSettingsActions,
} from './wallet-actions';
import { walletBootController } from './wallet-controller';
import { WalletBootError, WalletInactiveTab, WalletLoading } from './WalletBootScreens';
import { WalletNotices } from './WalletNotices';
import { WalletOnboarding } from './WalletOnboarding';
import { WalletShell } from './WalletShell';
import { WalletUnlock } from './WalletUnlock';
import { walletViewExternalStore } from './wallet-view-store';
import { WalletAddressDetail } from './features/routes/WalletAddressDetail';
import { WalletAddressDirectory } from './features/routes/WalletAddressDirectory';
import { WalletTestnetPage } from './features/routes/WalletTestnetPage';
import { WalletProfileOnboarding } from './features/onboarding/WalletProfileOnboarding';
import {
  walletProfileOnboardingEntityIds,
  walletProfileOnboardingRequired,
} from './features/onboarding/wallet-profile-onboarding';
import { walletAccountStoreController } from './features/accounts/wallet-account-store';
import { parseWalletScenarioPreview } from './wallet-entry';

const LOADING_PHASES = new Set([
  'cold',
  'detecting-environment',
  'initializing-native',
  'acquiring-tab',
  'loading-settings',
  'loading-vault',
  'loading-runtime',
] as const);

const useOnlineStatus = (): boolean => {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
};

const WalletRuntimeApp = () => {
  const boot = useExternalStore(walletBootController.store);
  const wallet = useExternalStore(walletViewExternalStore);
  const vault = useExternalStore(runtimesStateExternalStore);
  const settings = useExternalStore(settingsExternalStore);
  const [onboardingRevision, setOnboardingRevision] = useState(0);
  const online = useOnlineStatus();
  const pathname = window.location.pathname;
  const runtime = vault.activeRuntimeId ? vault.runtimes[vault.activeRuntimeId] ?? null : null;
  const onboardingEntityIds = walletProfileOnboardingEntityIds(runtime);
  const onboardingComplete = onboardingRevision > 0 || readAnyOnboardingComplete(onboardingEntityIds);
  const onboardingRequired = walletProfileOnboardingRequired(runtime, onboardingComplete);
  useEffect(() => {
    if (onboardingComplete) writeOnboardingCompleteForEntities(onboardingEntityIds, true);
  }, [onboardingComplete, onboardingEntityIds.join('|')]);
  if (pathname === '/testnet') return <WalletTestnetPage />;
  let content;
  if (LOADING_PHASES.has(boot.phase as typeof LOADING_PHASES extends Set<infer T> ? T : never)) {
    content = <WalletLoading phase={boot.phase} />;
  } else if (boot.phase === 'inactive-tab') {
    content = <WalletInactiveTab onClaim={walletBootController.claimActiveTab} />;
  } else if (boot.phase === 'recoverable-error' || boot.phase === 'fatal-error') {
    const message = boot.error ?? 'Wallet initialization failed without an error message.';
    content = (
      <WalletBootError
        message={message}
        recoverable={boot.phase === 'recoverable-error'}
        canRecoverBackup={message.includes('STORAGE_SCHEMA')}
        onRetry={walletBootController.retry}
        onRecoverBackup={recoverWalletFromConfiguredBackups}
      />
    );
  } else if (boot.phase === 'empty') {
    content = <WalletOnboarding onSubmit={createOrImportWallet} onGenerateMnemonic={generateWalletMnemonic} />;
  } else if (boot.phase === 'locked') {
    content = <WalletUnlock wallet={wallet} onSelect={selectWalletRuntime} onUnlock={unlockWalletRuntime} />;
  } else if (boot.phase === 'ready' && runtime && onboardingRequired) {
    content = <WalletProfileOnboarding runtime={runtime} onComplete={() => setOnboardingRevision(revision => revision + 1)} />;
  } else if (boot.phase === 'connecting' || boot.phase === 'ready') {
    const addressMatch = /^\/address\/([^/]+)$/.exec(pathname);
    content = pathname === '/address'
      ? <WalletAddressDirectory />
      : addressMatch?.[1]
        ? <WalletAddressDetail entityId={decodeURIComponent(addressMatch[1])} />
        : (
      <WalletShell
        wallet={wallet}
        settings={settings}
        connected={boot.phase === 'ready'}
        online={online}
        onSelectRuntime={selectWalletRuntime}
        onSelectEntity={walletAccountStoreController.selectEntity}
        onLockRuntime={lockWalletRuntime}
        onTheme={walletSettingsActions.setTheme}
        onLiteMode={walletSettingsActions.setLiteMode}
        onTimeMachine={walletSettingsActions.setShowTimeMachine}
        onMascot={walletSettingsActions.setShowXlnMascot}
      />
    );
  } else {
    throw new Error(`REACT_WALLET_PHASE_UNRENDERABLE:${boot.phase}`);
  }
  const shellOwnsNetworkState = boot.phase === 'connecting' || boot.phase === 'ready';
  return (
    <>
      {!online && !shellOwnsNetworkState && (
        <p className="wallet-global-offline" role="status">Offline — wallet setup and local vault access remain available.</p>
      )}
      {content}
      <WalletNotices />
    </>
  );
};

export const WalletApp = () => {
  const scenarioPreview = parseWalletScenarioPreview(window.location.search);
  return scenarioPreview ? (
    <main className="wallet-scenario-preview" data-testid="scenario-preview-wallet-banner">
      <p className="wallet-eyebrow">deterministic preview</p>
      <h1>Scenario preview</h1>
      <p>Runtime writes and wallet bootstrap are disabled in this view.</p>
      <dl><div><dt>scenario</dt><dd>{scenarioPreview.scenarioId}</dd></div><div><dt>frame</dt><dd>{scenarioPreview.frame + 1}</dd></div></dl>
      <a href="/scenarios">Return to scenarios</a>
    </main>
  ) : <WalletRuntimeApp />;
};
