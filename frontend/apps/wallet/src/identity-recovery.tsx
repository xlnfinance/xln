import type { WalletIdentityDraft, WalletIdentityDraftValidation } from './identity-onboarding-model';
import { walletIdentityModeLabel } from './identity-onboarding-model';
import './styles/identity-recovery.css';

type IdentityReviewProps = Readonly<{
  address: string;
  draft: WalletIdentityDraft;
  onEdit: () => void;
  onVerifyMnemonic: () => void;
  validation: WalletIdentityDraftValidation;
}>;

export function IdentityReview({
  address,
  draft,
  onEdit,
  onVerifyMnemonic,
  validation,
}: IdentityReviewProps) {
  return (
    <section className="identity-review" aria-labelledby="identity-review-title">
      <p className="wallet-shell-eyebrow">Identity input ready</p>
      <h1 id="identity-review-title">Review recovery requirements</h1>
      <p>No wallet has been created and no secret has left this form.</p>
      <dl>
        <div><dt>Method</dt><dd>{walletIdentityModeLabel(draft.mode)}</dd></div>
        {draft.mode === 'brainvault' ? <div><dt>Vault name</dt><dd>{draft.name}</dd></div> : null}
        {address ? <div><dt>Public address</dt><dd>{address}</dd></div> : null}
        <div><dt>Recovery</dt><dd>{validation.detail}</dd></div>
      </dl>
      <div className="identity-review-warning">
        <strong>{draft.mode === 'brainvault' ? 'Exact inputs are mandatory.' : 'The words control the wallet.'}</strong>
        <span>{draft.mode === 'brainvault'
          ? 'Name, passphrase, and work factor must match on every recovery.'
          : 'Keep the seed offline and hidden from cameras, cloud backups, and other people.'}</span>
      </div>
      <div className="identity-review-actions">
        {draft.mode === 'mnemonic' ? (
          <button className="identity-primary-action" onClick={onVerifyMnemonic} type="button">
            Verify recovery
          </button>
        ) : null}
        <button className="identity-secondary-action" onClick={onEdit} type="button">
          Edit inputs
        </button>
      </div>
    </section>
  );
}

export function IdentityRecoveryVerified({
  address,
  onReset,
}: Readonly<{ address: string; onReset: () => void }>) {
  return (
    <section className="identity-review" aria-labelledby="identity-verified-title">
      <p className="wallet-shell-eyebrow">Recovery verified</p>
      <h1 id="identity-verified-title">The same wallet returned</h1>
      <p>The second seed phrase reproduced the first public address.</p>
      <dl className="identity-verified-facts">
        <div><dt>Method</dt><dd>Mnemonic</dd></div>
        <div><dt>Public address</dt><dd>{address}</dd></div>
        <div><dt>Status</dt><dd>Recovery match</dd></div>
      </dl>
      <div className="identity-verified-note">
        <strong>Both seed entries were cleared.</strong>
        <span>No wallet has been created or persisted by this rehearsal.</span>
      </div>
      <button className="identity-secondary-action" onClick={onReset} type="button">
        Start over
      </button>
    </section>
  );
}
