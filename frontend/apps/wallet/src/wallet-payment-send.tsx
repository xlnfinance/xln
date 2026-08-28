import { useState } from 'react';
import type { RuntimePaymentDeliveryMode } from '../../../packages/runtime-client/src/payment-command-types';

import { parseXlnInvoice } from '../../../src/lib/utils/xlnInvoice';
import type { WalletPaymentProjection } from './wallet-payment-model';
import type { WalletPaymentSource, WalletPaymentSourceSnapshot } from './wallet-payment-source';

const deliveryModes: ReadonlyArray<Readonly<{
  id: RuntimePaymentDeliveryMode;
  label: string;
  detail: string;
}>> = [
  { id: 'instant', label: 'Instant', detail: 'Conditional route, immediate delivery attempt' },
  { id: 'async', label: 'Async', detail: 'Conditional route, durable eventual delivery' },
  { id: 'direct', label: 'Direct', detail: 'One bilateral Account only' },
  { id: 'trusted', label: 'Trusted', detail: 'One fee-free gateway only' },
];

const initialInvoice = (): string => {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.toLowerCase().startsWith('pay/')) return '';
  try {
    return decodeURIComponent(hash.slice(4));
  } catch {
    return '';
  }
};

export function WalletPaymentSend({
  projection,
  snapshot,
  source,
}: Readonly<{
  projection: WalletPaymentProjection;
  snapshot: WalletPaymentSourceSnapshot;
  source: WalletPaymentSource;
}>) {
  const [recipient, setRecipient] = useState('');
  const [tokenId, setTokenId] = useState(0);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [deliveryMode, setDeliveryMode] = useState<RuntimePaymentDeliveryMode>('instant');
  const [invoice, setInvoice] = useState(initialInvoice);
  const [formError, setFormError] = useState('');
  const selectedRecipient = recipient || projection.recipients[0]?.entityId || '';
  const selectedTokenId = tokenId || projection.tokens[0]?.tokenId || 0;
  const busy = snapshot.quote.status === 'loading'
    || snapshot.command.status === 'submitting'
    || snapshot.command.status === 'pending';

  const applyInvoice = (): void => {
    try {
      const parsed = parseXlnInvoice(invoice);
      if (!projection.recipients.some(({ entityId }) => entityId === parsed.targetEntityId)) {
        throw new Error('Invoice recipient is not present in this committed Runtime view.');
      }
      setRecipient(parsed.targetEntityId);
      if (parsed.tokenId) setTokenId(parsed.tokenId);
      if (parsed.amount) setAmount(parsed.amount);
      if (parsed.description) setDescription(parsed.description);
      setInvoice(parsed.canonicalUri);
      setFormError('');
    } catch (error: unknown) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const quote = async (): Promise<void> => {
    setFormError('');
    try {
      await source.quotePayment({
        targetEntityId: selectedRecipient,
        tokenId: selectedTokenId,
        amount,
        deliveryMode,
      });
    } catch (error: unknown) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const submit = async (): Promise<void> => {
    setFormError('');
    try {
      await source.submitQuotedPayment(description);
    } catch (error: unknown) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const route = snapshot.quote.routes[0];
  return (
    <section className="wallet-payments-pane" aria-labelledby="wallet-send-title">
      <div className="wallet-payments-section-heading">
        <div><p>01</p><h2 id="wallet-send-title">Send a payment</h2></div>
        <span>Quote first · submit once</span>
      </div>

      <div className="wallet-payment-invoice-row">
        <label htmlFor="wallet-payment-invoice">Recipient or invoice</label>
        <div>
          <input
            id="wallet-payment-invoice"
            onChange={(event) => setInvoice(event.target.value)}
            placeholder="Entity ID, invoice, wallet link, or xln:// link"
            value={invoice}
          />
          <button disabled={!invoice.trim() || busy} onClick={applyInvoice} type="button">Apply invoice</button>
        </div>
      </div>

      <div className="wallet-payment-form-grid">
        <label>
          <span>Recipient</span>
          <select disabled={busy} onChange={(event) => setRecipient(event.target.value)} value={selectedRecipient}>
            {projection.recipients.map((option) => (
              <option disabled={option.blocked} key={option.entityId} value={option.entityId}>
                {option.label}{option.blocked ? ' · dispute gate' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Asset</span>
          <select disabled={busy} onChange={(event) => setTokenId(Number(event.target.value))} value={selectedTokenId}>
            {projection.tokens.map((token) => (
              <option key={token.tokenId} value={token.tokenId}>{token.symbol} · {token.spendableLabel} visible</option>
            ))}
          </select>
        </label>
        <label>
          <span>Recipient amount</span>
          <input disabled={busy} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} placeholder="0.00" value={amount} />
        </label>
        <label>
          <span>Description</span>
          <input disabled={busy} maxLength={200} onChange={(event) => setDescription(event.target.value)} placeholder="Optional, committed with the payment" value={description} />
        </label>
      </div>

      <fieldset className="wallet-payment-modes" disabled={busy}>
        <legend>Delivery</legend>
        {deliveryModes.map((mode) => (
          <label className={deliveryMode === mode.id ? 'is-selected' : ''} key={mode.id}>
            <input checked={deliveryMode === mode.id} name="wallet-payment-mode" onChange={() => setDeliveryMode(mode.id)} type="radio" />
            <strong>{mode.label}</strong><span>{mode.detail}</span>
          </label>
        ))}
      </fieldset>

      {formError || snapshot.quote.status === 'error' ? (
        <p className="wallet-payment-error" role="alert">{formError || snapshot.quote.message}</p>
      ) : null}

      {route ? (
        <article className="wallet-payment-route">
          <header><span>Cheapest eligible route</span><strong>{route.path.length - 1} hops</strong></header>
          <div className="wallet-payment-route-path">
            {route.path.map((entityId, index) => <code key={entityId}>{index === 0 ? 'You' : index === route.path.length - 1 ? 'Recipient' : `${entityId.slice(0, 8)}…`}</code>)}
          </div>
          <dl>
            <div><dt>Recipient</dt><dd>{route.recipientAmount.toString()} base units</dd></div>
            <div><dt>Fee</dt><dd>{route.totalFee.toString()} base units</dd></div>
            <div><dt>Maximum debit</dt><dd>{route.senderAmount.toString()} base units</dd></div>
            <div><dt>Route confidence</dt><dd>{Math.round(route.probability * 100)}%</dd></div>
          </dl>
        </article>
      ) : null}

      <div className="wallet-payment-actions">
        <button disabled={busy || !selectedRecipient || !selectedTokenId || !amount.trim()} onClick={() => void quote()} type="button">
          {snapshot.quote.status === 'loading' ? 'Finding route…' : 'Find route'}
        </button>
        <button className="is-primary" disabled={busy || !route} onClick={() => void submit()} type="button">Submit quoted payment</button>
      </div>
    </section>
  );
}
