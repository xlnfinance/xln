import { useState } from 'react';

import type { WalletPaymentProjection } from './wallet-payment-model';
import type {
  WalletLendingTerm,
  WalletOperationKind,
} from './wallet-payment-operations-model';
import type { WalletPaymentSource, WalletPaymentSourceSnapshot } from './wallet-payment-source';

const operationCopy: Record<WalletOperationKind, Readonly<{
  label: string;
  detail: string;
  action: string;
}>> = {
  r2r: { label: 'Reserve transfer', detail: 'Queue a reserve-to-reserve J-batch operation.', action: 'Queue reserve transfer' },
  r2c: { label: 'Fund collateral', detail: 'Queue reserve into one existing bilateral Account.', action: 'Queue collateral funding' },
  c2r: { label: 'Withdraw collateral', detail: 'Propose a bilateral collateral-to-reserve settlement.', action: 'Propose settlement' },
  lend: { label: 'Lend to hub', detail: 'Publish a lending offer against an existing Hub Account.', action: 'Submit lending offer' },
  borrow: { label: 'Borrow from hub', detail: 'Submit a bounded borrow request to an existing Hub Account.', action: 'Submit borrow request' },
};

const lendingTerms: ReadonlyArray<Readonly<{ id: WalletLendingTerm; label: string }>> = [
  { id: '1h', label: '1 hour' },
  { id: '1d', label: '1 day' },
  { id: '1m', label: '1 month' },
];

export function WalletPaymentOperations({
  projection,
  snapshot,
  source,
}: Readonly<{
  projection: WalletPaymentProjection;
  snapshot: WalletPaymentSourceSnapshot;
  source: WalletPaymentSource;
}>) {
  const [kind, setKind] = useState<WalletOperationKind>('r2r');
  const [target, setTarget] = useState('');
  const [tokenId, setTokenId] = useState(0);
  const [amount, setAmount] = useState('');
  const [termId, setTermId] = useState<WalletLendingTerm>('1d');
  const [interestBps, setInterestBps] = useState(100);
  const [error, setError] = useState('');
  const accountOnly = kind !== 'r2r';
  const options = accountOnly
    ? projection.recipients.filter((recipient) => projection.accounts.some((account) => account.counterpartyId === recipient.entityId))
    : projection.recipients;
  const selectedTarget = options.some(({ entityId }) => entityId === target)
    ? target
    : options[0]?.entityId || '';
  const selectedTokenId = tokenId || projection.tokens[0]?.tokenId || 0;
  const busy = snapshot.command.status === 'submitting' || snapshot.command.status === 'pending';
  const isLending = kind === 'lend' || kind === 'borrow';

  const submit = async (): Promise<void> => {
    setError('');
    try {
      const intentId = isLending ? `${kind}-${crypto.randomUUID()}` : '';
      await source.submitOperation({
        kind,
        targetEntityId: selectedTarget,
        tokenId: selectedTokenId,
        amount,
        termId,
        interestBps,
        intentId,
      });
      setAmount('');
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <section className="wallet-payments-pane" aria-labelledby="wallet-operations-title">
      <div className="wallet-payments-section-heading">
        <div><p>03</p><h2 id="wallet-operations-title">Account operations</h2></div>
        <span>One explicit Runtime command</span>
      </div>
      <div className="wallet-operation-picker" role="radiogroup" aria-label="Account operation">
        {(Object.keys(operationCopy) as WalletOperationKind[]).map((operation) => (
          <button
            aria-checked={kind === operation}
            className={kind === operation ? 'is-selected' : ''}
            disabled={busy}
            key={operation}
            onClick={() => { setKind(operation); setError(''); }}
            role="radio"
            type="button"
          >
            <strong>{operationCopy[operation].label}</strong>
            <span>{operationCopy[operation].detail}</span>
          </button>
        ))}
      </div>

      <div className="wallet-payment-form-grid wallet-operation-form">
        <label>
          <span>{isLending ? 'Hub Account' : kind === 'r2r' ? 'Recipient' : 'Counterparty Account'}</span>
          <select disabled={busy} onChange={(event) => setTarget(event.target.value)} value={selectedTarget}>
            {options.map((option) => (
              <option disabled={option.blocked} key={option.entityId} value={option.entityId}>{option.label}{option.blocked ? ' · dispute gate' : ''}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Asset</span>
          <select disabled={busy} onChange={(event) => setTokenId(Number(event.target.value))} value={selectedTokenId}>
            {projection.tokens.map((token) => <option key={token.tokenId} value={token.tokenId}>{token.symbol}</option>)}
          </select>
        </label>
        <label>
          <span>Amount</span>
          <input disabled={busy} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} placeholder="0.00" value={amount} />
        </label>
        {isLending ? (
          <>
            <label>
              <span>Term</span>
              <select disabled={busy} onChange={(event) => setTermId(event.target.value as WalletLendingTerm)} value={termId}>
                {lendingTerms.map((term) => <option key={term.id} value={term.id}>{term.label}</option>)}
              </select>
            </label>
            <label>
              <span>{kind === 'lend' ? 'Interest' : 'Maximum interest'} · basis points</span>
              <input disabled={busy} max="10000" min="0" onChange={(event) => setInterestBps(Number(event.target.value))} type="number" value={interestBps} />
            </label>
          </>
        ) : null}
      </div>

      {kind === 'c2r' ? (
        <p className="wallet-operation-note">This creates a settlement proposal only. Peer approval, execution, and J-batch broadcast remain separate committed steps.</p>
      ) : null}
      {isLending ? (
        <p className="wallet-operation-note">The Runtime validates Hub policy, matching, capacity, and final terms. This form does not estimate acceptance.</p>
      ) : null}
      {error ? <p className="wallet-payment-error" role="alert">{error}</p> : null}
      <div className="wallet-payment-actions">
        <button
          className="is-primary"
          disabled={busy || !selectedTarget || !selectedTokenId || !amount.trim()}
          onClick={() => void submit()}
          type="button"
        >
          {operationCopy[kind].action}
        </button>
      </div>
    </section>
  );
}
