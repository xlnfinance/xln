import { useEffect, useState } from 'react';
import type { RuntimeInput } from '@xln/runtime/api/public/runtime-module';

import { parseTokenAmountInput } from '$lib/components/Entity/token-amount-input';
import { refreshRuntimeGossipProfiles } from '$lib/stores/xlnStore';
import { buildWalletOpenAccountInput } from '../../../../../packages/runtime-client/wallet-financial-input-adapter';
import type { WalletEntityAccountsView } from './account-view-model';
import type { WalletDirectoryEntity } from './wallet-account-store';
import { walletAccountStoreController } from './wallet-account-store';
import { submitWalletFinancialCommand } from './wallet-financial-actions';

type OpenAccountConfirmation = Readonly<{
  input: RuntimeInput;
  targetEntityId: string;
  tokenSymbol: string;
  creditAmount: string;
  creditAmountRaw: string;
}>;

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
  const [tokenId, setTokenId] = useState(entity.catalog[0]?.tokenId ?? 0);
  const token = entity.catalog.find(candidate => candidate.tokenId === tokenId) ?? entity.catalog[0] ?? null;
  const [creditAmount, setCreditAmount] = useState('10000');
  const [confirmation, setConfirmation] = useState<OpenAccountConfirmation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectiveTarget = manualTarget.trim().toLowerCase() || target;
  useEffect(() => {
    if (!candidates.some(candidate => candidate.entityId === target)) {
      setTarget(candidates[0]?.entityId ?? '');
    }
  }, [candidates, target]);

  const review = (): void => {
    try {
      if (!token) throw new Error('Select an initial credit asset');
      const amount = parseTokenAmountInput(creditAmount, token.decimals);
      const input = buildWalletOpenAccountInput(
        { entityId: entity.entityId, signerId: entity.signerId },
        effectiveTarget,
        { tokenId: token.tokenId, amount },
      );
      setError(null);
      setConfirmation(Object.freeze({
        input,
        targetEntityId: effectiveTarget,
        tokenSymbol: token.symbol,
        creditAmount,
        creditAmountRaw: amount.toString(),
      }));
    } catch (reviewError) {
      setConfirmation(null);
      setError(reviewError instanceof Error ? reviewError.message : String(reviewError));
    }
  };

  const submit = async (): Promise<void> => {
    if (!confirmation) return;
    setSubmitting(true);
    setError(null);
    try {
      await refreshRuntimeGossipProfiles({
        reason: 'wallet-open-account',
        sourceEntityId: entity.entityId,
        targetEntities: [confirmation.targetEntityId],
      });
      await submitWalletFinancialCommand(
        `wallet-open-account:${entity.entityId}:${confirmation.targetEntityId}`,
        confirmation.input,
      );
      setConfirmation(null);
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
      {!confirmation ? <>
        <select aria-label="Open account with discovered entity" value={target} disabled={submitting || candidates.length === 0} onChange={event => { setTarget(event.target.value); setManualTarget(''); }}>{candidates.map(candidate => <option key={candidate.entityId} value={candidate.entityId}>{candidate.label}{candidate.isHub ? ' · hub' : ''}</option>)}</select>
        <input aria-label="Open account with entity ID" value={manualTarget} disabled={submitting} onChange={event => setManualTarget(event.target.value)} placeholder="Or paste 0x… entity ID" />
        <label><span>Initial credit asset</span><select aria-label="Initial credit asset" value={token?.tokenId ?? 0} disabled={submitting} onChange={event => setTokenId(Number(event.target.value))}>{entity.catalog.map(item => <option key={item.tokenId} value={item.tokenId}>{item.symbol}</option>)}</select></label>
        <label><span>Initial credit limit</span><input aria-label="Initial credit limit" value={creditAmount} inputMode="decimal" disabled={submitting} onChange={event => setCreditAmount(event.target.value)} /></label>
        <button type="button" disabled={!effectiveTarget || !token || !creditAmount || submitting} onClick={review}>Review open account</button>
      </> : <div className="wallet-open-confirm"><span>Operation: <code>openAccount</code></span><span>Initial credit: <strong>{confirmation.creditAmount} {confirmation.tokenSymbol}</strong> <small>({confirmation.creditAmountRaw} raw)</small></span><button type="button" className="wallet-button-secondary" disabled={submitting} onClick={() => setConfirmation(null)}>Back</button><button type="button" disabled={submitting} onClick={() => void submit()}>{submitting ? 'Submitting…' : 'Submit account intent'}</button></div>}
      {error && <p className="wallet-inline-error" role="alert">{error}</p>}
    </section>
  );
};
