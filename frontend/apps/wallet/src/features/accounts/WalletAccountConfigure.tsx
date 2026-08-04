import { useState } from 'react';
import type { RuntimeInput } from '@xln/runtime/api/public/runtime-module';

import type { CommandReceipt } from '$lib/stores/runtimeCommandBus';
import { buildWalletAddTokenInput } from '../../../../../packages/runtime-client/wallet-financial-input-adapter';
import type { WalletAccountView, WalletEntityAccountsView } from './account-view-model';
import { submitWalletFinancialCommand } from './wallet-financial-actions';
import { WalletCommandReceipt } from './WalletCommandReceipt';
import { walletAccountStoreController } from './wallet-account-store';

export const WalletAccountConfigure = ({
  entity,
  account,
  receipt,
}: Readonly<{
  entity: WalletEntityAccountsView;
  account: WalletAccountView;
  receipt: CommandReceipt | null;
}>) => {
  const available = entity.catalog.filter(token => !account.tokens.some(current => current.tokenId === token.tokenId));
  const [tokenId, setTokenId] = useState(available[0]?.tokenId ?? 0);
  const token = available.find(candidate => candidate.tokenId === tokenId) ?? available[0] ?? null;
  const [confirmation, setConfirmation] = useState<Readonly<{
    input: RuntimeInput;
    tokenId: number;
    tokenSymbol: string;
  }> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = (): void => {
    try {
      if (!token) throw new Error('Select an asset');
      const input = buildWalletAddTokenInput({
        entityId: entity.entityId,
        signerId: entity.signerId,
        counterpartyEntityId: account.counterpartyId,
        tokenId: token.tokenId,
      });
      setError(null);
      setConfirmation(Object.freeze({ input, tokenId: token.tokenId, tokenSymbol: token.symbol }));
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
      await submitWalletFinancialCommand(
        `wallet-add-token:${entity.entityId}:${account.counterpartyId}:${confirmation.tokenId}`,
        confirmation.input,
      );
      setConfirmation(null);
      await walletAccountStoreController.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };
  if (available.length === 0) return null;
  return (
    <div className="wallet-account-configure" data-testid="wallet-account-configure">
      {!confirmation ? <>
        <label><span>Add asset</span><select value={token?.tokenId ?? 0} disabled={submitting} onChange={event => setTokenId(Number(event.target.value))}>{available.map(item => <option key={item.tokenId} value={item.tokenId}>{item.symbol} · token {item.tokenId}</option>)}</select></label>
        <button type="button" disabled={!token || submitting} onClick={review}>Review add asset</button>
      </> : <div className="wallet-confirm"><h3>Confirm exact account command</h3><dl><div><dt>Operation</dt><dd>extendCredit</dd></div><div><dt>Counterparty</dt><dd>{account.counterpartyId}</dd></div><div><dt>Asset</dt><dd>{confirmation.tokenSymbol} · token {confirmation.tokenId}</dd></div><div><dt>Amount</dt><dd>0 raw · initialize delta only</dd></div></dl><div className="wallet-action-row"><button type="button" className="wallet-button-secondary" disabled={submitting} onClick={() => setConfirmation(null)}>Back</button><button type="button" disabled={submitting} onClick={() => void submit()}>{submitting ? 'Submitting…' : 'Submit add asset'}</button></div></div>}
      {error && <p className="wallet-inline-error" role="alert">{error}</p>}
      <WalletCommandReceipt receipt={receipt} />
    </div>
  );
};
