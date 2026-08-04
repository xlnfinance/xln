import { useMemo, useState } from 'react';

import type { CommandReceipt } from '$lib/stores/runtimeCommandBus';
import { parseXlnInvoice } from '$lib/utils/xlnInvoice';
import type { WalletEntityAccountsView } from '../accounts/account-view-model';
import { submitWalletFinancialCommand } from '../accounts/wallet-financial-actions';
import { WalletCommandReceipt } from '../accounts/WalletCommandReceipt';
import {
  buildWalletPaymentCommand,
  type WalletPaymentCommand,
} from '../../../../../packages/runtime-client/wallet-payment-input-adapter';

type DeliveryMode = 'direct' | 'instant' | 'async';

export type WalletPaymentFormProps = Readonly<{
  entity: WalletEntityAccountsView;
  receipt: CommandReceipt | null;
  initialInvoice?: string | null;
}>;

const initialIntent = (raw: string | null | undefined) => {
  if (!raw) return null;
  try {
    return parseXlnInvoice(raw);
  } catch {
    return null;
  }
};

export const WalletPaymentForm = ({ entity, receipt, initialInvoice }: WalletPaymentFormProps) => {
  const imported = useMemo(() => initialIntent(initialInvoice), [initialInvoice]);
  const [target, setTarget] = useState(imported?.targetEntityId ?? entity.accounts[0]?.counterpartyId ?? '');
  const selectedAccount = entity.accounts.find(account => account.counterpartyId === target) ?? null;
  const availableTokens = selectedAccount?.tokens ?? [];
  const initialToken = imported?.tokenId ?? availableTokens[0]?.tokenId ?? 0;
  const [tokenId, setTokenId] = useState(initialToken);
  const token = availableTokens.find(candidate => candidate.tokenId === tokenId) ?? availableTokens[0] ?? null;
  const [amount, setAmount] = useState(imported?.amount ?? '');
  const [description, setDescription] = useState(imported?.description ?? '');
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>('direct');
  const [confirmation, setConfirmation] = useState<WalletPaymentCommand | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const build = () => {
    if (!selectedAccount || !token) throw new Error('Select an account and asset');
    return buildWalletPaymentCommand({
      entityId: entity.entityId,
      signerId: entity.signerId,
      targetEntityId: selectedAccount.counterpartyId,
      tokenId: token.tokenId,
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      amountInput: amount,
      route: [entity.entityId, selectedAccount.counterpartyId],
      deliveryMode,
      totalFee: 0n,
      description,
    });
  };

  const review = (): void => {
    try {
      setError(null);
      setConfirmation(build());
    } catch (previewError) {
      setConfirmation(null);
      setError(previewError instanceof Error ? previewError.message : String(previewError));
    }
  };

  const submit = async (): Promise<void> => {
    if (!confirmation) return;
    setSubmitting(true);
    setError(null);
    try {
      const command = confirmation;
      const key = [command.preview.entityId, command.preview.targetEntityId, command.preview.tokenId, command.preview.amountRaw, command.preview.deliveryMode].join(':');
      await submitWalletFinancialCommand(key, command.input);
      setConfirmation(null);
      setAmount('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="wallet-operation" data-testid="wallet-payment-form">
      <header><p className="wallet-eyebrow">one intent · one command</p><h2>Pay</h2></header>
      <label><span>Account</span><select value={target} disabled={submitting} onChange={event => { setTarget(event.target.value); setConfirmation(null); }}>
        {entity.accounts.map(account => <option key={account.counterpartyId} value={account.counterpartyId}>{account.counterpartyId}</option>)}
      </select></label>
      <div className="wallet-form-grid">
        <label><span>Asset</span><select value={token?.tokenId ?? 0} disabled={submitting} onChange={event => { setTokenId(Number(event.target.value)); setConfirmation(null); }}>
          {availableTokens.map(item => <option key={item.tokenId} value={item.tokenId}>{item.symbol} · {item.outbound} available</option>)}
        </select></label>
        <label><span>Delivery</span><select value={deliveryMode} disabled={submitting} onChange={event => { setDeliveryMode(event.target.value as DeliveryMode); setConfirmation(null); }}>
          <option value="direct">Direct</option><option value="instant">Instant HTLC</option><option value="async">Async HTLC</option>
        </select></label>
      </div>
      <label><span>Amount</span><input id="payment-amount-input" value={amount} inputMode="decimal" disabled={submitting} onChange={event => { setAmount(event.target.value); setConfirmation(null); }} placeholder="0.00" /></label>
      <label><span>Private note</span><input value={description} disabled={submitting} maxLength={200} onChange={event => { setDescription(event.target.value); setConfirmation(null); }} /></label>
      {error && <p className="wallet-inline-error" role="alert">{error}</p>}
      {confirmation ? (
        <div className="wallet-confirm" data-testid="wallet-payment-confirmation">
          <h3>Confirm exact command</h3>
          <dl>
            <div><dt>Recipient</dt><dd>{confirmation.preview.targetEntityId}</dd></div>
            <div><dt>Amount</dt><dd>{amount} {confirmation.preview.tokenSymbol} <small>({confirmation.preview.amountRaw} raw)</small></dd></div>
            <div><dt>Fee</dt><dd>{confirmation.preview.totalFeeRaw} raw</dd></div>
            <div><dt>Operation</dt><dd>{confirmation.preview.deliveryMode === 'direct' ? 'directPayment' : 'htlcPayment'}</dd></div>
          </dl>
          <div className="wallet-action-row"><button type="button" className="wallet-button-secondary" disabled={submitting} onClick={() => setConfirmation(null)}>Back</button><button type="button" disabled={submitting} onClick={() => void submit()}>{submitting ? 'Submitting…' : 'Submit payment'}</button></div>
        </div>
      ) : (
        <button type="button" disabled={submitting || !target || !token || !amount} onClick={review}>Review payment</button>
      )}
      <WalletCommandReceipt receipt={receipt} />
    </section>
  );
};
