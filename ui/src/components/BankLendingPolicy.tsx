import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../runtime/store';
import { normalizeInterestBps } from '@xln/core/lendbook/state';
import type { EntityTx } from '@xln/core/types/entity-tx';
import type { WalletView } from '../runtime/views';
import { fetchLendingState, LENDING_TERMS, type LendingState, type TermId } from '../runtime/financial/lending';
import { formatAmount, parseAmount } from '../runtime/format';
import { getTokenMeta } from '../runtime/token-meta';
import { sendEntityTxs } from '../runtime/tx';

/** These controls submit ordinary authenticated bank Entity commands. */
export function BankLendingPolicy({ wallet }: { wallet: WalletView }) {
  const [borrowerId, setBorrowerId] = useState('');
  const commandReady = useApp(s => s.commandReady);
  const [tokenId, setTokenId] = useState(1);
  const [termId, setTermId] = useState<TermId>('1d');
  const [saverRate, setSaverRate] = useState('100');
  const [loanRate, setLoanRate] = useState('200');
  const [lateHours, setLateHours] = useState('24');
  const [principal, setPrincipal] = useState('');
  const [validHours, setValidHours] = useState('24');
  const [state, setState] = useState<LendingState | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const account = wallet.accounts.find(value => value.counterpartyId === borrowerId);
  const meta = getTokenMeta(tokenId);
  const canSubmit = Boolean(account && !account.disputed && account.doc.state.deltas.has(tokenId) && wallet.signerId);
  const terms = account ? state?.terms.find(value => value.tokenId === tokenId && value.termId === termId
    && value.chainId === account.doc.state.domain.chainId && value.depositoryAddress === account.doc.state.domain.depositoryAddress) : undefined;
  const facility = state?.facilities.find(value => value.borrowerEntityId === borrowerId && value.tokenId === tokenId && value.termId === termId);
  const refresh = useCallback(async () => {
    if (!borrowerId) return;
    try {
      setState(await fetchLendingState({ hubEntityId: wallet.entityId, userEntityId: borrowerId, tokenId }));
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [borrowerId, tokenId, wallet.entityId]);
  useEffect(() => { void refresh(); }, [refresh, wallet.frameHeight]);

  const submit = async (action: 'terms' | 'approve' | 'revoke') => {
    if (!account || !canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const hours = Number(validHours);
      const expiresAt = Date.now() + hours * 3_600_000;
      if (!Number.isFinite(hours) || hours <= 0 || !Number.isSafeInteger(expiresAt)) throw new Error('Enter a valid approval duration');
      const loanLateMs = termId === 'demand' ? 0 : Number(lateHours) * 3_600_000;
      if (termId !== 'demand' && (!lateHours.trim() || !Number.isSafeInteger(loanLateMs) || loanLateMs < 0)) throw new Error('Enter a nonnegative late-interest duration');
      const maxPrincipal = action === 'approve' ? parseAmount(principal, meta.decimals) : 0n;
      if (action === 'approve' && maxPrincipal <= 0n) throw new Error('Enter a positive facility principal cap');
      const tx: EntityTx = action === 'terms' ? { type: 'lendingSetTerms', data: {
        ...account.doc.state.domain, tokenId, termId, expiresAt,
        loanLateMs, savingsInterestBps: normalizeInterestBps(saverRate), loanInterestBps: termId === 'demand' ? 0 : normalizeInterestBps(loanRate),
      } } : { type: 'lendingApprove', data: { borrowerEntityId: borrowerId, tokenId, termId, maxPrincipal, expiresAt } };
      await sendEntityTxs(wallet.entityId, wallet.signerId, [tx]);
      setNotice('Command sent. The committed bank policy appears below.');
      void refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return <details className="disclosure" data-testid="bank-lending-policy">
    <summary>Bank administration</summary>
    <p className="note">Publish savings and loan rates, then approve a named borrower. Approval never increases the Account credit limit. Existing signed debts survive revocation.</p>
    <label className="field"><span className="field-label">Account</span>
      <select className="input" value={borrowerId} onChange={event => { setBorrowerId(event.target.value); setTokenId(wallet.accounts.find(value => value.counterpartyId === event.target.value)?.tokens[0]?.tokenId ?? 0); setState(null); }} data-testid="bank-borrower">
        <option value="">Select an Account</option>
        {wallet.accounts.map(value => <option key={value.counterpartyId} value={value.counterpartyId}>{value.label} · {value.counterpartyId.slice(0, 14)}</option>)}
      </select>
    </label>
    <label className="field"><span className="field-label">Asset</span>
      <select className="input" value={tokenId} onChange={event => { setTokenId(Number(event.target.value)); setState(null); }} data-testid="bank-token">
        {account?.tokens.map(value => <option key={value.tokenId} value={value.tokenId}>{getTokenMeta(value.tokenId).symbol}</option>)}
      </select>
    </label>
    <p className="note">{account ? `Jurisdiction ${account.doc.state.domain.chainId} · ${account.doc.state.domain.depositoryAddress}` : 'Select the Account whose asset and jurisdiction you want to configure.'}</p>
    <div className="mode-grid">{LENDING_TERMS.map(value => <button key={value.id} type="button" className={`mode-card${termId === value.id ? ' active' : ''}`} onClick={() => { setTermId(value.id); if (value.id === 'demand') setValidHours('8760'); }} data-testid={`bank-term-${value.id}`}>{value.label}</button>)}</div>
    <label className="field"><span className="field-label">{termId === 'demand' ? 'Savings interest · basis points per year' : 'Savings interest · basis points per term'}</span><input className="input" value={saverRate} onChange={event => setSaverRate(event.target.value)} data-testid="bank-savings-rate" /></label>
    {termId !== 'demand' && <>
    <label className="field"><span className="field-label">Loan interest · basis points per term</span><input className="input" value={loanRate} onChange={event => setLoanRate(event.target.value)} data-testid="bank-loan-rate" /></label>
    <label className="field"><span className="field-label">Loan late interest ends after · hours past maturity</span><input className="input" value={lateHours} onChange={event => setLateHours(event.target.value)} data-testid="bank-late-hours" /></label>
    <p className="note">The ordinary loan rate continues as simple interest until this end. Zero stops interest at maturity. Existing loans keep their original signed terms.</p>
    </>}
    <label className="field"><span className="field-label">New offers and renewals valid for · hours</span><input className="input" value={validHours} onChange={event => setValidHours(event.target.value)} data-testid="bank-valid-hours" /></label>
    <button type="button" className="btn" disabled={!canSubmit || busy || !commandReady} onClick={() => void submit('terms')} data-testid="bank-publish-rates">Publish bank rates</button>
    {termId === 'demand' && <p className="note">Prospective annual rate. Existing earnings never change. Online Accounts renew before their signed coverage ends, within accepted risk; queued withdrawals retain their current rate.</p>}
    {terms && <p className="note" data-testid="bank-committed-rates">Committed rates: savings {(terms.savingsInterestBps / 100).toFixed(2)}% {termId === 'demand' ? 'per year.' : `· loans ${(terms.loanInterestBps / 100).toFixed(2)}% per term. Late interest ends ${terms.loanLateMs / 3_600_000} hours after maturity.`} {terms.expiresAt <= Date.now() ? 'Expired' : `Valid until ${new Date(terms.expiresAt).toLocaleString()}`}</p>}
    {termId !== 'demand' && <>
    <label className="field"><span className="field-label">Facility principal cap · {meta.symbol}</span><input className="input" value={principal} onChange={event => setPrincipal(event.target.value)} data-testid="bank-facility-principal" /></label>
    <div className="field-row">
      <button type="button" className="btn primary" disabled={!canSubmit || busy || !principal.trim() || !commandReady} onClick={() => void submit('approve')} data-testid="bank-approve">Approve facility</button>
      <button type="button" className="btn" disabled={!canSubmit || busy || !commandReady} onClick={() => void submit('revoke')} data-testid="bank-revoke">Revoke new draws</button>
    </div>
    {facility && <p className="note" data-testid="bank-committed-facility">Principal cap: {formatAmount(facility.maxPrincipal, meta.decimals, meta.decimals)} {meta.symbol}. {facility.maxPrincipal === 0n ? 'New draws revoked.' : facility.expiresAt <= Date.now() || facility.jNonce !== account?.doc.state.jNonce ? 'Approval expired.' : `Valid until ${new Date(facility.expiresAt).toLocaleString()}`}</p>}
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
