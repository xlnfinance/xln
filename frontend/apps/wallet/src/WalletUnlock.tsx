import { useEffect, useId, useState, type FormEvent } from 'react';

import { countMnemonicWords, hasSupportedMnemonicWordCount } from '../../../packages/runtime-client/wallet-onboarding';
import { walletErrorText } from './error-surface';
import type { WalletViewSnapshot } from './wallet-view-store';

export type WalletUnlockProps = Readonly<{
  wallet: WalletViewSnapshot;
  onSelect: (runtimeId: string) => Promise<void>;
  onUnlock: (runtimeId: string, mnemonic: string) => Promise<void>;
}>;

export const WalletUnlock = ({ wallet, onSelect, onUnlock }: WalletUnlockProps) => {
  const mnemonicId = useId();
  const fallbackRuntimeId = wallet.runtimes[0]?.id ?? '';
  const [runtimeId, setRuntimeId] = useState(wallet.activeRuntimeId ?? fallbackRuntimeId);
  const [mnemonic, setMnemonic] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setRuntimeId(wallet.activeRuntimeId ?? fallbackRuntimeId), [wallet.activeRuntimeId, fallbackRuntimeId]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!runtimeId || !hasSupportedMnemonicWordCount(mnemonic)) return;
    setPending(true);
    setError(null);
    try {
      await onUnlock(runtimeId, mnemonic);
      setMnemonic('');
    } catch (unlockError) {
      setError(walletErrorText(unlockError));
    } finally {
      setPending(false);
    }
  };
  const selectUnlocked = async (selectedRuntimeId: string): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await onSelect(selectedRuntimeId);
    } catch (selectError) {
      setError(walletErrorText(selectError));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="wallet-unlock">
      <section>
        <p className="wallet-eyebrow">protected vault</p>
        <h1>Unlock your local runtime.</h1>
        <p>The recovery phrase is checked on this device. Failed attempts do not alter committed runtime state.</p>
      </section>
      <form onSubmit={event => void submit(event)}>
        <label htmlFor="wallet-runtime-select">Runtime</label>
        <select id="wallet-runtime-select" value={runtimeId} onChange={event => setRuntimeId(event.target.value)}>
          {wallet.runtimes.map(runtime => <option key={runtime.id} value={runtime.id}>{runtime.label}</option>)}
        </select>
        <div className="wallet-label-row">
          <label htmlFor={mnemonicId}>Recovery phrase</label>
          <span>{countMnemonicWords(mnemonic)} words</span>
        </div>
        <textarea
          id={mnemonicId}
          data-testid="wallet-unlock-mnemonic"
          value={mnemonic}
          rows={4}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          onChange={event => setMnemonic(event.target.value)}
        />
        {error && <p className="wallet-inline-error" role="alert">{error}</p>}
        <button type="submit" disabled={pending || !runtimeId || !hasSupportedMnemonicWordCount(mnemonic)}>
          {pending ? 'Unlocking…' : 'Unlock wallet'}
        </button>
      </form>
      {wallet.runtimes.some(runtime => runtime.unlocked && runtime.id !== runtimeId) && (
        <aside className="wallet-unlocked-options">
          <p>Already unlocked on this device</p>
          {wallet.runtimes.filter(runtime => runtime.unlocked && runtime.id !== runtimeId).map(runtime => (
            <button className="wallet-button-secondary" type="button" key={runtime.id} disabled={pending} onClick={() => void selectUnlocked(runtime.id)}>
              Open {runtime.label}
            </button>
          ))}
        </aside>
      )}
    </main>
  );
};
