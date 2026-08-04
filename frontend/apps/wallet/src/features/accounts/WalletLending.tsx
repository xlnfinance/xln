import { useEffect, useState } from 'react';
import type { RuntimeInput } from '@xln/runtime/api/public/runtime-module';

import type { CommandReceipt } from '$lib/stores/runtimeCommandBus';
import {
  buildWalletLendingBorrowInput,
  buildWalletLendingOfferInput,
  buildWalletLendingRepayInput,
  getWalletLendingRemaining,
} from '../../../../../packages/runtime-client/wallet-financial-input-adapter';
import type { WalletEntityAccountsView } from './account-view-model';
import { submitWalletFinancialCommand } from './wallet-financial-actions';
import { WalletCommandReceipt } from './WalletCommandReceipt';

type LendingTerm = '1h' | '1d' | '1m';
type LendingLoan = Readonly<{
  loanId: string;
  hubEntityId: string;
  tokenId: number;
  repaymentAmount: string;
  repaidAmount: string;
  status: string;
}>;
type LendingState = Readonly<{
  pools: readonly Readonly<{ positionId: string; availableAmount: string; borrowedAmount: string; interestBps: number; termId: string; status: string }>[];
  loans: readonly LendingLoan[];
}>;

type LendingConfirmation = Readonly<{
  input: RuntimeInput;
  key: string;
  operation: 'lendingOffer' | 'lendingBorrow';
  amountInput: string;
  amountRaw: string;
  tokenSymbol: string;
  term: LendingTerm;
  rateBps: number;
  hubEntityId: string;
}>;

type RepayConfirmation = Readonly<{
  input: RuntimeInput;
  key: string;
  loan: LendingLoan;
  remainingRaw: string;
}>;

const intentId = (prefix: 'lend' | 'borrow'): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`;
};

export const WalletLending = ({ entity, receipt }: Readonly<{ entity: WalletEntityAccountsView; receipt: CommandReceipt | null }>) => {
  const [hubEntityId, setHubEntityId] = useState(entity.accounts[0]?.counterpartyId ?? '');
  const account = entity.accounts.find(candidate => candidate.counterpartyId === hubEntityId) ?? entity.accounts[0] ?? null;
  const [tokenId, setTokenId] = useState(account?.tokens[0]?.tokenId ?? 0);
  const token = account?.tokens.find(candidate => candidate.tokenId === tokenId) ?? account?.tokens[0] ?? null;
  const [action, setAction] = useState<'lend' | 'borrow'>('lend');
  const [amount, setAmount] = useState('');
  const [term, setTerm] = useState<LendingTerm>('1d');
  const [rateBps, setRateBps] = useState(100);
  const [state, setState] = useState<LendingState | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState<LendingConfirmation | null>(null);
  const [repayConfirmation, setRepayConfirmation] = useState<RepayConfirmation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    if (!hubEntityId || !token) return;
    setLoading(true);
    setError(null);
    try {
      const url = new URL('/api/lending/state', window.location.origin);
      url.searchParams.set('hubEntityId', hubEntityId);
      url.searchParams.set('userEntityId', entity.entityId);
      url.searchParams.set('tokenId', String(token.tokenId));
      const response = await fetch(url, { cache: 'no-store' });
      const body = await response.json() as { success?: boolean; error?: string; pools?: LendingState['pools']; loans?: LendingState['loans'] };
      if (!response.ok || body.success !== true) throw new Error(body.error || `Lending state failed (${response.status})`);
      setState({ pools: body.pools ?? [], loans: body.loans ?? [] });
    } catch (refreshError) {
      setState(null);
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, [entity.entityId, hubEntityId, token?.tokenId]);

  const review = (): void => {
    try {
      if (!token) throw new Error('Select a lending asset');
      const owner = { entityId: entity.entityId, signerId: entity.signerId };
      const input = action === 'lend'
        ? buildWalletLendingOfferInput({
            ...owner, positionId: intentId('lend'), hubEntityId,
            tokenId: token.tokenId, tokenDecimals: token.decimals,
            amountInput: amount, termId: term, interestBps: rateBps,
          })
        : buildWalletLendingBorrowInput({
            ...owner, requestId: intentId('borrow'), hubEntityId,
            tokenId: token.tokenId, tokenDecimals: token.decimals,
            amountInput: amount, termId: term, maxInterestBps: rateBps,
          });
      const tx = input.entityInputs?.[0]?.entityTxs?.[0];
      if (!tx || (tx.type !== 'lendingOffer' && tx.type !== 'lendingBorrow')) {
        throw new Error('WALLET_LENDING_COMMAND_INVALID');
      }
      setError(null);
      setConfirmation(Object.freeze({
        input,
        key: ['wallet-lending', action, entity.entityId, hubEntityId, token.tokenId, amount, term, rateBps].join(':'),
        operation: tx.type,
        amountInput: amount,
        amountRaw: tx.data.amount.toString(),
        tokenSymbol: token.symbol,
        term,
        rateBps,
        hubEntityId,
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
      await submitWalletFinancialCommand(confirmation.key, confirmation.input);
      setAmount('');
      setConfirmation(null);
      await refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const reviewRepay = (loan: LendingLoan): void => {
    try {
      const remaining = getWalletLendingRemaining(loan.repaymentAmount, loan.repaidAmount);
      const input = buildWalletLendingRepayInput({
        entityId: entity.entityId,
        signerId: entity.signerId,
        hubEntityId: loan.hubEntityId,
        loanId: loan.loanId,
        tokenId: loan.tokenId,
        amountRaw: remaining,
      });
      setError(null);
      setRepayConfirmation(Object.freeze({
        input,
        key: `wallet-lending-repay:${loan.loanId}:${remaining}`,
        loan,
        remainingRaw: remaining.toString(),
      }));
    } catch (reviewError) {
      setRepayConfirmation(null);
      setError(reviewError instanceof Error ? reviewError.message : String(reviewError));
    }
  };

  const repay = async (): Promise<void> => {
    if (!repayConfirmation) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitWalletFinancialCommand(repayConfirmation.key, repayConfirmation.input);
      setRepayConfirmation(null);
      await refresh();
    } catch (repayError) {
      setError(repayError instanceof Error ? repayError.message : String(repayError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="wallet-operation" data-testid="wallet-lending-panel">
      <header><p className="wallet-eyebrow">hub credit market</p><h2>Lending</h2></header>
      <div className="wallet-form-grid">
        <label><span>Hub account</span><select value={account?.counterpartyId ?? ''} disabled={submitting} onChange={event => { setHubEntityId(event.target.value); setConfirmation(null); }}>{entity.accounts.map(candidate => <option key={candidate.counterpartyId} value={candidate.counterpartyId}>{candidate.counterpartyId}</option>)}</select></label>
        <label><span>Asset</span><select value={token?.tokenId ?? 0} disabled={submitting} onChange={event => { setTokenId(Number(event.target.value)); setConfirmation(null); }}>{account?.tokens.map(candidate => <option key={candidate.tokenId} value={candidate.tokenId}>{candidate.symbol}</option>)}</select></label>
        <label><span>Intent</span><select value={action} disabled={submitting} onChange={event => { setAction(event.target.value as 'lend' | 'borrow'); setConfirmation(null); }}><option value="lend">Offer liquidity</option><option value="borrow">Borrow</option></select></label>
        <label><span>Term</span><select value={term} disabled={submitting} onChange={event => { setTerm(event.target.value as LendingTerm); setConfirmation(null); }}><option value="1h">1 hour</option><option value="1d">1 day</option><option value="1m">1 month</option></select></label>
        <label><span>Amount</span><input value={amount} inputMode="decimal" disabled={submitting} onChange={event => { setAmount(event.target.value); setConfirmation(null); }} /></label>
        <label><span>{action === 'lend' ? 'Interest' : 'Maximum interest'} (bps)</span><input value={rateBps} inputMode="numeric" disabled={submitting} onChange={event => { setRateBps(Number(event.target.value)); setConfirmation(null); }} /></label>
      </div>
      {error && <p className="wallet-inline-error" role="alert">{error}</p>}
      {confirmation ? <div className="wallet-confirm"><h3>Confirm lending intent</h3><dl><div><dt>Operation</dt><dd>{confirmation.operation}</dd></div><div><dt>Amount</dt><dd>{confirmation.amountInput} {confirmation.tokenSymbol} ({confirmation.amountRaw} raw)</dd></div><div><dt>Term / rate</dt><dd>{confirmation.term} · {confirmation.rateBps} bps</dd></div><div><dt>Hub</dt><dd>{confirmation.hubEntityId}</dd></div></dl><div className="wallet-action-row"><button type="button" className="wallet-button-secondary" onClick={() => setConfirmation(null)}>Back</button><button type="button" disabled={submitting} onClick={() => void submit()}>{submitting ? 'Submitting…' : 'Submit intent'}</button></div></div> : <button type="button" disabled={!token || !amount || submitting} onClick={review}>Review lending intent</button>}
      {repayConfirmation && <div className="wallet-confirm"><h3>Confirm exact repayment</h3><dl><div><dt>Operation</dt><dd>lendingRepay</dd></div><div><dt>Loan</dt><dd>{repayConfirmation.loan.loanId}</dd></div><div><dt>Hub</dt><dd>{repayConfirmation.loan.hubEntityId}</dd></div><div><dt>Amount</dt><dd>{repayConfirmation.remainingRaw} raw</dd></div></dl><div className="wallet-action-row"><button type="button" className="wallet-button-secondary" disabled={submitting} onClick={() => setRepayConfirmation(null)}>Back</button><button type="button" disabled={submitting} onClick={() => void repay()}>{submitting ? 'Submitting…' : 'Submit repayment'}</button></div></div>}
      <section className="wallet-lending-state"><header><h3>Committed market state</h3><button type="button" className="wallet-button-secondary" disabled={loading || submitting} onClick={() => void refresh()}>{loading ? 'Refreshing…' : 'Refresh'}</button></header>{state?.pools.map(pool => <article key={pool.positionId}><div><strong>{pool.status}</strong><code>{pool.positionId}</code></div><span>{pool.availableAmount} available · {pool.borrowedAmount} borrowed · {pool.interestBps} bps · {pool.termId}</span></article>)}{state?.loans.map(loan => <article key={loan.loanId}><div><strong>{loan.status}</strong><code>{loan.loanId}</code></div><span>{loan.repaidAmount} / {loan.repaymentAmount} raw repaid</span>{loan.status !== 'repaid' && <button type="button" disabled={submitting || repayConfirmation !== null} onClick={() => reviewRepay(loan)}>Review repayment</button>}</article>)}</section>
      <WalletCommandReceipt receipt={receipt} />
    </section>
  );
};
