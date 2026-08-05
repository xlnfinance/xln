import { useId, useState, type FormEvent } from 'react';

import {
  countMnemonicWords,
  validateWalletOnboarding,
  type WalletOnboardingInput,
  type WalletOnboardingMode,
} from '../../../packages/runtime-client/wallet-onboarding';
import { walletErrorText } from './error-surface';

export type WalletOnboardingProps = Readonly<{
  onSubmit: (input: WalletOnboardingInput) => Promise<void>;
  onGenerateMnemonic: () => Promise<string>;
}>;

export const WalletOnboarding = ({ onSubmit, onGenerateMnemonic }: WalletOnboardingProps) => {
  const labelId = useId();
  const mnemonicId = useId();
  const [mode, setMode] = useState<WalletOnboardingMode>('create');
  const [label, setLabel] = useState('My wallet');
  const [mnemonic, setMnemonic] = useState('');
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [pending, setPending] = useState<'generate' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = { mode, label, mnemonic, recoveryConfirmed } as const;
  const validation = validateWalletOnboarding(input);

  const chooseMode = (nextMode: WalletOnboardingMode): void => {
    setMode(nextMode);
    setMnemonic('');
    setRecoveryConfirmed(false);
    setError(null);
  };
  const generate = async (): Promise<void> => {
    setPending('generate');
    setError(null);
    try {
      setMnemonic(await onGenerateMnemonic());
    } catch (generateError) {
      setError(walletErrorText(generateError));
    } finally {
      setPending(null);
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (validation.errors[0]) {
      setError(validation.errors[0]);
      return;
    }
    setPending('submit');
    setError(null);
    try {
      await onSubmit(input);
    } catch (submitError) {
      setError(walletErrorText(submitError));
    } finally {
      setPending(null);
    }
  };

  return (
    <main className="wallet-onboarding" data-testid="wallet-onboarding">
      <section className="wallet-onboarding-intro">
        <p className="wallet-eyebrow">first local runtime</p>
        <h1>Create xln wallet</h1>
        <p>One recovery phrase controls the local runtime. xln never sends it to an analytics service or remote wallet UI.</p>
        <ol className="wallet-principles">
          <li><span>01</span>Generated on this device</li>
          <li><span>02</span>Protected by the existing vault</li>
          <li><span>03</span>Used only to sign explicit commands</li>
        </ol>
      </section>
      <form className="wallet-onboarding-form" onSubmit={event => void submit(event)}>
        <div className="wallet-segmented" aria-label="Wallet setup method">
          <button type="button" aria-pressed={mode === 'create'} onClick={() => chooseMode('create')}>New wallet</button>
          <button type="button" aria-pressed={mode === 'import'} onClick={() => chooseMode('import')}>Import phrase</button>
        </div>
        <label htmlFor={labelId}>Wallet name</label>
        <input id={labelId} value={label} maxLength={64} autoComplete="off" onChange={event => setLabel(event.target.value)} />
        <div className="wallet-label-row">
          <label htmlFor={mnemonicId}>Recovery phrase</label>
          <span>{countMnemonicWords(mnemonic)} words</span>
        </div>
        <textarea
          id={mnemonicId}
          data-testid="wallet-mnemonic-input"
          value={mnemonic}
          rows={5}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          placeholder={mode === 'create' ? 'Generate a new 24-word phrase' : 'Enter your 12-word or 24-word phrase'}
          onChange={event => setMnemonic(event.target.value)}
        />
        {mode === 'create' && (
          <>
            <button className="wallet-button-secondary" type="button" disabled={pending !== null} onClick={() => void generate()}>
              {pending === 'generate' ? 'Generating…' : mnemonic ? 'Generate another phrase' : 'Generate recovery phrase'}
            </button>
            <label className="wallet-check">
              <input type="checkbox" checked={recoveryConfirmed} onChange={event => setRecoveryConfirmed(event.target.checked)} />
              <span>I stored this phrase offline and understand it cannot be recovered by xln.</span>
            </label>
          </>
        )}
        {error && <p className="wallet-inline-error" role="alert">{error}</p>}
        <button type="submit" disabled={pending !== null || validation.errors.length > 0}>
          {pending === 'submit' ? 'Creating runtime…' : mode === 'create' ? 'Create wallet' : 'Import wallet'}
        </button>
      </form>
    </main>
  );
};
