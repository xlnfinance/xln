import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { DEMO_ACCOUNTS } from '$lib/config/demo-accounts';
import {
  resolveWalletIdentityModeNavigation,
  selectWalletIdentityMode,
  type WalletIdentityMode,
} from '../../../packages/browser/src/wallet-identity-entry';
import {
  createWalletIdentityDraft,
  deriveWalletIdentityMnemonicAddress,
  validateWalletIdentityDraft,
  walletIdentityModeLabel,
  type WalletIdentityDraft,
} from './identity-onboarding-model';
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
      try {
        const address = await deriveWalletIdentityMnemonicAddress(draft.mnemonicInput);
        setDerivedAddress(address);
      } catch {
        setSubmissionError('Seed phrase checksum or words are invalid.');
        return;
      }
    }
    setReviewing(true);
  };

  if (reviewing) {
    return (
      <section className="identity-review" aria-labelledby="identity-review-title">
        <p className="wallet-shell-eyebrow">Identity input ready</p>
        <h1 id="identity-review-title">Review recovery requirements</h1>
        <p>No wallet has been created and no secret has left this form.</p>
        <dl>
          <div><dt>Method</dt><dd>{walletIdentityModeLabel(draft.mode)}</dd></div>
          {draft.mode === 'brainvault' ? <div><dt>Vault name</dt><dd>{draft.name}</dd></div> : null}
          {derivedAddress ? <div><dt>Public address</dt><dd>{derivedAddress}</dd></div> : null}
          <div><dt>Recovery</dt><dd>{validation.detail}</dd></div>
        </dl>
        <div className="identity-review-warning">
          <strong>{draft.mode === 'brainvault' ? 'Exact inputs are mandatory.' : 'The words control the wallet.'}</strong>
          <span>{draft.mode === 'brainvault'
            ? 'Name, passphrase, and work factor must match on every recovery.'
            : 'Keep the seed offline and hidden from cameras, cloud backups, and other people.'}</span>
        </div>
        <button className="identity-secondary-action" onClick={() => setReviewing(false)} type="button">
          Edit inputs
        </button>
      </section>
    );
  }

  return (
    <section className="identity-onboarding" aria-labelledby="identity-onboarding-title">
      <header>
        <p className="wallet-shell-eyebrow">Wallet identity</p>
        <h1 id="identity-onboarding-title">Set up identity</h1>
        <p>Choose how this wallet can be recovered.</p>
      </header>

      <div className="identity-mode-tabs" role="tablist" aria-label="Wallet identity method">
        {(['brainvault', 'mnemonic'] as const).map((mode) => (
          <button
            aria-controls={`identity-panel-${mode}`}
            aria-selected={draft.mode === mode}
            id={`identity-mode-${mode}`}
            key={mode}
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
      </div>

      <form onSubmit={(event) => { void reviewIdentity(event); }} noValidate>
        {draft.mode === 'brainvault' ? (
          <div id="identity-panel-brainvault" role="tabpanel" aria-labelledby="identity-mode-brainvault">
            <label>
              <span>Vault name <small>public, exact input</small></span>
              <input
                autoCapitalize="none"
                autoComplete="off"
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
                  onChange={(event) => setDraft((current) => ({ ...current, passphrase: event.target.value }))}
                  spellCheck={false}
                  type={draft.showPassphrase ? 'text' : 'password'}
                  value={draft.passphrase}
                />
                <button
                  aria-label={draft.showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
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
          <ul className="identity-errors" aria-label="Identity input errors">
            {validation.errors.map((error) => <li key={error}>{error}</li>)}
            {submissionError ? <li>{submissionError}</li> : null}
          </ul>
        ) : null}

        <button className="identity-primary-action" type="submit">Review identity inputs</button>
      </form>
    </section>
  );
}
