import { useEffect, useState } from 'react';

import { useExternalStore } from '../../../packages/react-adapters/use-external-store';
import { settingsExternalStore } from '$lib/stores/settingsStore';
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

export const WalletApp = () => {
  const boot = useExternalStore(walletBootController.store);
  const wallet = useExternalStore(walletViewExternalStore);
  const settings = useExternalStore(settingsExternalStore);
  const online = useOnlineStatus();
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
  } else if (boot.phase === 'connecting' || boot.phase === 'ready') {
    content = (
      <WalletShell
        wallet={wallet}
        settings={settings}
        connected={boot.phase === 'ready'}
        online={online}
        onSelectRuntime={selectWalletRuntime}
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
