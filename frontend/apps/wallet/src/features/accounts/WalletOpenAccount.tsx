import { useEffect, useState } from 'react';

import { buildWalletOpenAccountInput } from '../../../../../packages/runtime-client/wallet-financial-input-adapter';
import type { WalletEntityAccountsView } from './account-view-model';
import type { WalletDirectoryEntity } from './wallet-account-store';
import { walletAccountStoreController } from './wallet-account-store';
import { submitWalletFinancialCommand } from './wallet-financial-actions';

export const WalletOpenAccount = ({
  entity,
  directory,
}: Readonly<{ entity: WalletEntityAccountsView; directory: readonly WalletDirectoryEntity[] }>) => {
  const candidates = directory.filter(candidate =>
    candidate.entityId !== entity.entityId
    && !entity.accounts.some(account => account.counterpartyId === candidate.entityId)
    && (!entity.jurisdiction || !candidate.jurisdiction || candidate.jurisdiction === entity.jurisdiction));
  const [target, setTarget] = useState(candidates[0]?.entityId ?? '');
  const [manualTarget, setManualTarget] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectiveTarget = manualTarget.trim() || target;
  useEffect(() => {
    if (!candidates.some(candidate => candidate.entityId === target)) {
      setTarget(candidates[0]?.entityId ?? '');
    }
  }, [candidates, target]);
  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const input = buildWalletOpenAccountInput({ entityId: entity.entityId, signerId: entity.signerId }, effectiveTarget);
      await submitWalletFinancialCommand(`wallet-open-account:${entity.entityId}:${effectiveTarget}`, input);
      setConfirming(false);
      setManualTarget('');
      await walletAccountStoreController.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section className="wallet-open-account" data-testid="wallet-open-account">
      <div><span>New bilateral account</span><strong>{effectiveTarget || 'Choose a discovered entity or paste its exact ID.'}</strong></div>
      {!confirming ? <>
        <select aria-label="Open account with discovered entity" value={target} disabled={submitting || candidates.length === 0} onChange={event => { setTarget(event.target.value); setManualTarget(''); }}>{candidates.map(candidate => <option key={candidate.entityId} value={candidate.entityId}>{candidate.label}{candidate.isHub ? ' · hub' : ''}</option>)}</select>
        <input aria-label="Open account with entity ID" value={manualTarget} disabled={submitting} onChange={event => setManualTarget(event.target.value)} placeholder="Or paste 0x… entity ID" />
        <button type="button" disabled={!effectiveTarget || submitting} onClick={() => setConfirming(true)}>Review open account</button>
      </> : <div className="wallet-open-confirm"><span>Operation: <code>openAccount</code></span><button type="button" className="wallet-button-secondary" disabled={submitting} onClick={() => setConfirming(false)}>Back</button><button type="button" disabled={submitting} onClick={() => void submit()}>{submitting ? 'Submitting…' : 'Submit account intent'}</button></div>}
      {error && <p className="wallet-inline-error" role="alert">{error}</p>}
    </section>
  );
};
