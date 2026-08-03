import { useState } from 'react';

import type { WalletBootPhase } from '../../../packages/runtime-client/wallet-boot-machine';
import { walletErrorText } from './error-surface';

const BOOT_LABELS: Partial<Record<WalletBootPhase, string>> = {
  'detecting-environment': 'Checking this device',
  'initializing-native': 'Preparing secure device access',
  'acquiring-tab': 'Acquiring wallet ownership',
  'loading-settings': 'Applying wallet settings',
  'loading-vault': 'Opening the protected vault',
  'loading-runtime': 'Connecting the runtime',
};

export const WalletLoading = ({ phase }: Readonly<{ phase: WalletBootPhase }>) => (
  <main className="wallet-state" data-testid="app-loading-screen" aria-busy="true">
    <div className="wallet-state-mark" aria-hidden="true">x</div>
    <p className="wallet-eyebrow">wallet boot</p>
    <h1>{BOOT_LABELS[phase] ?? 'Preparing your wallet'}</h1>
    <p>Keys stay on this device while xln restores the last committed session.</p>
    <span className="wallet-progress" aria-hidden="true"><i /></span>
  </main>
);

export const WalletInactiveTab = ({ onClaim }: Readonly<{ onClaim: () => Promise<void> }>) => {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claim = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await onClaim();
    } catch (claimError) {
      setError(walletErrorText(claimError));
    } finally {
      setPending(false);
    }
  };
  return (
    <main className="wallet-state" data-testid="inactive-tab-screen">
      <p className="wallet-eyebrow">wallet already active</p>
      <h1>Another tab owns this runtime.</h1>
      <p>Only one tab may submit commands. Take ownership here when the other session is no longer in use.</p>
      {error && <p className="wallet-inline-error" role="alert">{error}</p>}
      <button data-testid="inactive-tab-acquire" type="button" disabled={pending} onClick={() => void claim()}>
        {pending ? 'Acquiring…' : 'Use wallet in this tab'}
      </button>
    </main>
  );
};

type BootErrorProps = Readonly<{
  message: string;
  recoverable: boolean;
  canRecoverBackup: boolean;
  onRetry: () => Promise<void>;
  onRecoverBackup: () => Promise<void>;
}>;

export const WalletBootError = (props: BootErrorProps) => {
  const [pending, setPending] = useState<'retry' | 'recover' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const run = async (kind: 'retry' | 'recover', action: () => Promise<void>): Promise<void> => {
    setPending(kind);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(walletErrorText(error));
    } finally {
      setPending(null);
    }
  };
  return (
    <main className="wallet-state wallet-state-error" data-testid="app-initialization-error" role="alert">
      <p className="wallet-eyebrow">initialization stopped</p>
      <h1>Your wallet did not continue.</h1>
      <pre>{props.message}</pre>
      {actionError && <p className="wallet-inline-error">{actionError}</p>}
      <div className="wallet-actions">
        {props.recoverable && (
          <button type="button" disabled={pending !== null} onClick={() => void run('retry', props.onRetry)}>
            {pending === 'retry' ? 'Retrying…' : 'Retry safely'}
          </button>
        )}
        {props.canRecoverBackup && (
          <button data-testid="storage-schema-recover" className="wallet-button-secondary" type="button" disabled={pending !== null} onClick={() => void run('recover', props.onRecoverBackup)}>
            {pending === 'recover' ? 'Recovering…' : 'Recover authenticated backup'}
          </button>
        )}
      </div>
    </main>
  );
};
