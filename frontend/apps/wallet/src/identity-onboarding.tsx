import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { DEMO_ACCOUNTS } from '$lib/config/demo-accounts';
import {
  resolveWalletIdentityModeNavigation,
  selectWalletIdentityMode,
  type WalletIdentityMode,
} from '../../../packages/browser/src/wallet-identity-entry';
import {
  beginWalletMnemonicRecoveryRehearsal,
  createWalletIdentityDraft,
  deriveWalletIdentityMnemonicAddress,
  evaluateWalletMnemonicRecoveryAttempt,
  validateWalletIdentityDraft,
  walletIdentityMnemonicErrorMessage,
  walletIdentityModeLabel,
  type WalletIdentityDraft,
} from './identity-onboarding-model';
import { IdentityRecoveryVerified, IdentityReview } from './identity-recovery';
import {
  resetWalletRecoveryRehearsal,
  type WalletRecoveryRehearsalState,
} from '../../../packages/browser/src/wallet-recovery-rehearsal';
import './styles/identity-onboarding.css';

const FACTORS = [1, 2, 3, 4, 5] as const;

export function IdentityOnboarding() {
  const [draft, setDraft] = useState<WalletIdentityDraft>(() => (
    createWalletIdentityDraft(window.location.search, DEMO_ACCOUNTS)
  ));
  const [reviewing, setReviewing] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submissionError, setSubmissionError] = useState('');
  const [derivedAddress, setDerivedAddress] = useState('');
  const [deriving, setDeriving] = useState(false);
  const [recoveryVerified, setRecoveryVerified] = useState(false);
  const [rehearsal, setRehearsal] = useState<WalletRecoveryRehearsalState>(
    resetWalletRecoveryRehearsal,
  );
  const tabRefs = useRef<Record<WalletIdentityMode, HTMLButtonElement | null>>({
    brainvault: null,
    mnemonic: null,
  });
  const validation = validateWalletIdentityDraft(draft);

  const selectMode = (nextMode: WalletIdentityMode): void => {
    setSubmitted(false);
    setSubmissionError('');
    setDerivedAddress('');
    setReviewing(false);
    setRecoveryVerified(false);
    setRehearsal(resetWalletRecoveryRehearsal());
    setDraft((current) => ({
      ...current,
      ...selectWalletIdentityMode({
        state: current,
        phase: 'input',
        rehearsalMode: null,
        nextMode,
      }),
    }));
  };

  const handleModeKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentMode: WalletIdentityMode,
  ): void => {
    const nextMode = resolveWalletIdentityModeNavigation({
      currentMode,
      key: event.key,
      rehearsalMode: null,
    });
    if (nextMode === null) return;
    event.preventDefault();
    selectMode(nextMode);
    tabRefs.current[nextMode]?.focus();
  };

  const reviewIdentity = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSubmitted(true);
    setSubmissionError('');
    if (!validation.valid) return;
    if (draft.mode === 'mnemonic') {
      setDeriving(true);
      let address: string;
      try {
        address = await deriveWalletIdentityMnemonicAddress(draft.mnemonicInput);
      } catch (error: unknown) {
        setSubmissionError(walletIdentityMnemonicErrorMessage(error));
        setDeriving(false);
        return;
      }
      setDeriving(false);
      if (rehearsal.mode !== null) {
        const attempt = evaluateWalletMnemonicRecoveryAttempt(rehearsal, address);
        setRehearsal(attempt.state);
        if (!attempt.matched) {
          setSubmissionError(attempt.error);
          return;
        }
        setDraft((current) => ({ ...current, mnemonicInput: '' }));
        setDerivedAddress(address);
        setRecoveryVerified(true);
        return;
      }
      setDerivedAddress(address);
    }
    setReviewing(true);
  };

  const beginMnemonicRecovery = (): void => {
    if (draft.mode !== 'mnemonic' || !derivedAddress) {
      throw new Error('WALLET_MNEMONIC_RECOVERY_REVIEW_REQUIRED');
    }
    setRehearsal(beginWalletMnemonicRecoveryRehearsal(derivedAddress));
    setDraft((current) => ({ ...current, mnemonicInput: '' }));
    setDerivedAddress('');
    setSubmissionError('');
    setSubmitted(false);
    setReviewing(false);
  };

  const resetIdentity = (): void => {
    setDraft(createWalletIdentityDraft('', DEMO_ACCOUNTS));
    setDerivedAddress('');
    setSubmissionError('');
    setSubmitted(false);
    setReviewing(false);
    setRecoveryVerified(false);
    setRehearsal(resetWalletRecoveryRehearsal());
  };

  if (recoveryVerified) {
    return <IdentityRecoveryVerified address={derivedAddress} onReset={resetIdentity} />;
  }

  if (reviewing) {
    return <IdentityReview
      address={derivedAddress}
      draft={draft}
      onEdit={() => setReviewing(false)}
      onVerifyMnemonic={beginMnemonicRecovery}
      validation={validation}
    />;
  }

  const rehearsalActive = rehearsal.mode !== null;

  return (
    <section className="identity-onboarding" aria-labelledby="identity-onboarding-title">
      <header>
        <p className="wallet-shell-eyebrow">{rehearsalActive ? 'Recovery rehearsal' : 'Wallet identity'}</p>
        <h1 id="identity-onboarding-title">{rehearsalActive ? 'Re-enter your seed' : 'Set up identity'}</h1>
        <p>{rehearsalActive
          ? 'The first phrase was cleared. Only its public wallet address remains.'
          : 'Choose how this wallet can be recovered.'}</p>
      </header>

      {rehearsalActive ? (
        <p className="identity-rehearsal-context">
          Enter the same seed phrase again. A different valid wallet is rejected without replacing the expected address.
        </p>
      ) : <div className="identity-mode-tabs" role="tablist" aria-label="Wallet identity method">
        {(['brainvault', 'mnemonic'] as const).map((mode) => (
          <button
            aria-controls={`identity-panel-${mode}`}
            aria-selected={draft.mode === mode}
            id={`identity-mode-${mode}`}
            key={mode}
            disabled={deriving}
            onClick={() => selectMode(mode)}
            onKeyDown={(event) => handleModeKey(event, mode)}
            ref={(node) => { tabRefs.current[mode] = node; }}
            role="tab"
            tabIndex={draft.mode === mode ? 0 : -1}
            type="button"
          >
            <strong>{walletIdentityModeLabel(mode)}</strong>
            <span>{mode === 'brainvault' ? 'Memorized recovery' : 'Physical backup'}</span>
          </button>
        ))}
      </div>}

      <form onSubmit={(event) => { void reviewIdentity(event); }} noValidate>
        {draft.mode === 'brainvault' ? (
          <div id="identity-panel-brainvault" role="tabpanel" aria-labelledby="identity-mode-brainvault">
            <label>
              <span>Vault name <small>public, exact input</small></span>
              <input
                autoCapitalize="none"
                autoComplete="off"
                disabled={deriving}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                spellCheck={false}
                type="text"
                value={draft.name}
              />
            </label>
            <label>
              <span>Secret passphrase <small>never stored by this screen</small></span>
              <span className="identity-secret-input">
                <input
                  autoCapitalize="none"
                  autoComplete="off"
                  disabled={deriving}
                  onChange={(event) => setDraft((current) => ({ ...current, passphrase: event.target.value }))}
                  spellCheck={false}
                  type={draft.showPassphrase ? 'text' : 'password'}
                  value={draft.passphrase}
                />
                <button
                  aria-label={draft.showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
                  disabled={deriving}
                  onClick={() => setDraft((current) => ({
                    ...current,
                    showPassphrase: !current.showPassphrase,
                  }))}
                  type="button"
                >
                  {draft.showPassphrase ? 'Hide' : 'Show'}
                </button>
              </span>
            </label>
            <fieldset>
              <legend>Work factor</legend>
              <div className="identity-factor-row">
                {FACTORS.map((factor) => (
                  <button
                    aria-pressed={draft.factor === factor}
                    disabled={deriving}
                    key={factor}
                    onClick={() => setDraft((current) => ({ ...current, factor }))}
                    type="button"
                  >
                    {factor}
                  </button>
                ))}
              </div>
              <p>Higher factors require more recovery time and memory work.</p>
            </fieldset>
          </div>
        ) : (
          <div id="identity-panel-mnemonic" role="tabpanel" aria-labelledby="identity-mode-mnemonic">
            <label>
              <span>Seed phrase <small>{validation.detail}</small></span>
              <textarea
                autoCapitalize="none"
                autoComplete="off"
                disabled={deriving}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  mnemonicInput: event.target.value,
                }))}
                placeholder="Enter 12 or 24 BIP39 words"
                rows={5}
                spellCheck={false}
                value={draft.mnemonicInput}
              />
            </label>
            <p className="identity-inline-warning">Anyone with these words controls the wallet.</p>
          </div>
        )}

        {submitted && (!validation.valid || submissionError) ? (
          <ul className="identity-errors" aria-label="Identity input errors" aria-live="polite">
            {validation.errors.map((error) => <li key={error}>{error}</li>)}
            {submissionError ? <li>{submissionError}</li> : null}
          </ul>
        ) : null}

        <div className={rehearsalActive ? 'identity-rehearsal-actions' : undefined}>
          <button className="identity-primary-action" disabled={deriving} type="submit">
            {deriving ? 'Checking phrase…' : rehearsalActive ? 'Verify recovered wallet' : 'Review identity inputs'}
          </button>
          {rehearsalActive ? (
            <button className="identity-secondary-action" onClick={resetIdentity} type="button">
              Cancel rehearsal
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
