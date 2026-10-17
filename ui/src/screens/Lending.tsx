import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LENDING_TERM_MS, lendingLoanMaximumAmount } from '@xln/core/lendbook/state';
import { MANAGE, PageHead } from '../components/PageHead';
import { isAccountTxKindAvailable } from '@xln/core/account/tx/admission-policy';
import { TokenIcon } from '../components/TokenPicker';
import { LendingClose } from '../components/LendingClose';
import { LendingRepay } from '../components/LendingRepay';
import { LendingRiskConsent } from '../components/LendingRiskConsent';
import { BankLendingPolicy } from '../components/BankLendingPolicy';
import { ReceiveCapacity } from '../components/ReceiveCapacity';
import { walletHelp } from '@xln/frontend/lib/utils/ui/walletHelp';
import { useApp } from '../runtime/store';
import { sendEntityTxs } from '../runtime/tx';
import { formatAmount, formatMoney, parseAmount } from '../runtime/format';
import { getTokenMeta } from '../runtime/token-meta';
import { useWallet } from '../runtime/views';
import {
	LENDING_TERMS,
	previewLendingTerms,
	previewSavingsRisk,
	buildLendingBorrowTx,
	buildLendingOfferTx,
	fetchLendingState,
	isLendingLoanRepayable,
	type LendingState,
	type TermId,
} from '../runtime/financial/lending';

const rate = (bps: number): string => `${(bps / 100).toFixed(2)}%`;
const UNAVAILABLE = 'Lending is unavailable in this release';

export function Lending() {
	const entityId = useApp(s => s.activeEntityId);
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const toast = useApp(s => s.toast);
	const height = useApp(s => s.height);
	const wallet = useWallet(entityId);
	const hubs = useMemo(() => wallet.accounts.filter(account => account.isHub), [wallet.accounts]);
	const [hubId, setHubId] = useState('');
	const [tokenId, setTokenId] = useState(selectedTokenId);
	const [side, setSide] = useState<'lend' | 'borrow'>('lend');
	const [amountText, setAmountText] = useState('');
	const [termId, setTermId] = useState<TermId>('demand');
	const [rateText, setRateText] = useState(side === 'lend' ? '100' : '250');
	const [state, setState] = useState<LendingState | null>(null);
	const [stateError, setStateError] = useState('');
	const [loading, setLoading] = useState(false);
	const refreshVersion = useRef(0);
	const [busy, setBusy] = useState(false);
	const [submittedRequest, setSubmittedRequest] = useState<{ id: string; owner: string; hub: string; token: number } | null>(null);
	const requestId = submittedRequest?.owner === wallet.entityId && submittedRequest.hub === hubId && submittedRequest.token === tokenId ? submittedRequest.id : undefined;
	const meta = getTokenMeta(tokenId);
	const hub = hubs.find(account => account.counterpartyId === hubId) ?? null;
	const offerAvailable = isAccountTxKindAvailable('lending_fund');
	const borrowAvailable = isAccountTxKindAvailable('lending_borrow_request');
	const repayAvailable = isAccountTxKindAvailable('lending_repay');
	const submitAvailable = side === 'lend' ? offerAvailable : borrowAvailable;
	const bankTerms = hub ? state?.terms.find(value => value.tokenId === tokenId && value.termId === termId
		&& value.chainId === hub.doc.state.domain.chainId && value.depositoryAddress === hub.doc.state.domain.depositoryAddress
		&& value.expiresAt > Date.now()) : undefined;
	const quotedRate = side === 'lend' ? (bankTerms ? String(bankTerms.savingsInterestBps) : '') : rateText;
	const bankOfferUnavailable = !bankTerms;
	const borrowPreview = side === 'borrow' ? previewLendingTerms(amountText, rateText, meta.decimals, { termMs: LENDING_TERM_MS[termId], lateMs: bankTerms?.loanLateMs ?? 0 }) : null;
	const savingsRisk = side === 'lend' && hub && bankTerms ? previewSavingsRisk(hub, tokenId, amountText, quotedRate, meta.decimals) : null;
	const needsRiskConsent = savingsRisk?.ok === true && savingsRisk.requiredLimit > savingsRisk.currentLimit;
	const quoteError = borrowPreview?.ok === false || savingsRisk?.ok === false;
	const needsReceiveCapacity = borrowPreview?.ok === true && borrowPreview.principal > (hub?.tokens.find(token => token.tokenId === tokenId)?.derived.inCapacity ?? 0n);

	useEffect(() => {
		if (!hubId && hubs.length > 0) setHubId(hubs[0]!.counterpartyId);
	}, [hubs, hubId]);

	const refresh = useCallback(async () => {
		if (!hubId || !wallet.entityId) return;
		const version = ++refreshVersion.current;
		setLoading(true);
		try {
			const next = await fetchLendingState({ hubEntityId: hubId, userEntityId: wallet.entityId, tokenId, ...(requestId ? { requestId } : {}) });
			if (version !== refreshVersion.current) return;
			setState(next);
			setStateError('');
		} catch (error) {
			if (version !== refreshVersion.current) return;
			setState(null);
			setStateError(error instanceof Error ? error.message : String(error));
		} finally {
			if (version === refreshVersion.current) setLoading(false);
		}
	}, [hubId, wallet.entityId, tokenId, requestId]);

	useEffect(() => {
		let stopped = false;
		let timer = 0;
		// The bank can commit after our last Account ACK. Its HTTP view must
		// refresh independently of local heights and routing-profile gossip.
		const poll = async () => {
			await refresh();
			if (!stopped) timer = window.setTimeout(poll, 2_000);
		};
		void poll();
		return () => {
			stopped = true;
			window.clearTimeout(timer);
			refreshVersion.current++;
		};
	}, [refresh, height]);

	const submit = async (): Promise<void> => {
		if (!submitAvailable) { toast(UNAVAILABLE, 'danger'); return; }
		if (!bankTerms || bankOfferUnavailable || needsRiskConsent || needsReceiveCapacity || quoteError) return;
		if (!wallet.signerId || !hubId) return;
		setBusy(true);
		try {
			const amount = parseAmount(amountText, meta.decimals);
			if (amount <= 0n) throw new Error('Enter a positive amount');
			const bps = Math.max(0, Math.floor(Number(quotedRate) || 0));
			const tx =
				side === 'lend'
					? buildLendingOfferTx({ hubEntityId: hubId, tokenId, amount, termId, interestBps: bps })
					: buildLendingBorrowTx({ hubEntityId: hubId, tokenId, amount, termId, maxInterestBps: bps, maxLateMs: bankTerms.loanLateMs });
			await sendEntityTxs(wallet.entityId, wallet.signerId, [tx]);
			if (tx.type === 'lendingBorrow') setSubmittedRequest({ id: tx.data.requestId, owner: wallet.entityId, hub: hubId, token: tokenId });
			toast(side === 'lend' ? `Offered ${formatMoney(amount, meta.decimals)} ${meta.symbol} to ${hub?.label ?? 'the hub'}` : `Borrow request for ${formatMoney(amount, meta.decimals)} ${meta.symbol} sent`);
			setAmountText('');
			if (tx.type !== 'lendingBorrow') void refresh();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setBusy(false);
		}
	};

	const myLoans = state?.loans.filter(loan => loan.borrowerEntityId.toLowerCase() === wallet.entityId) ?? [];
	const myPools = state?.savings.filter(pool => pool.lenderEntityId.toLowerCase() === wallet.entityId) ?? [];

	return (
		<div className="screen fade-in">
			<PageHead
				title="Lending"
				parent={MANAGE}
			/>
			{!offerAvailable || !borrowAvailable || !repayAvailable ? (
				<p className="note" role="status" data-testid="lending-unavailable">{UNAVAILABLE}. Existing positions remain visible below.</p>
			) : null}
			<details className="disclosure"><summary>How lending works — with an example</summary><p className="note">{walletHelp.lendingBalance}</p></details>
			{wallet.frame?.activeEntity?.core.profile?.isHub === true && <BankLendingPolicy wallet={wallet} />}
			<div className="two-col">
				<div>
					{hubs.length === 0 ? (
						<p className="note">Lending runs through a hub. Open an account with one first.</p>
					) : (
						<>
							<div className="field">
								<span className="field-label">Hub</span>
								<div className="mode-grid">
									{hubs.map(account => (
										<button key={account.counterpartyId} type="button" className={`mode-card${hubId === account.counterpartyId ? ' active' : ''}`} onClick={() => setHubId(account.counterpartyId)}>
											<span className="t">{account.label}</span>
											<span className="s">{account.tokens.length} lanes</span>
										</button>
									))}
								</div>
							</div>
							<div className="field">
								<span className="field-label">Token</span>
								<div className="mode-grid compact">
									{(hub?.tokens ?? []).map(token => (
										<button key={token.tokenId} type="button" className={`mode-card${tokenId === token.tokenId ? ' active' : ''}`} onClick={() => setTokenId(token.tokenId)}>
											<span className="t">{getTokenMeta(token.tokenId).symbol}</span>
											<span className="s">{getTokenMeta(token.tokenId).name}</span>
										</button>
									))}
								</div>
							</div>
							<div className="segc" style={{ marginBottom: 14 }} role="tablist">
								<button type="button" role="tab" aria-selected={side === 'lend'} className={side === 'lend' ? 'active' : ''} onClick={() => { setSide('lend'); setRateText('100'); }} data-testid="lend-side-lend">
									Lend
								</button>
								<button type="button" role="tab" aria-selected={side === 'borrow'} className={side === 'borrow' ? 'active' : ''} onClick={() => { setSide('borrow'); setRateText('250'); if (termId === 'demand') setTermId('1d'); }} data-testid="lend-side-borrow">
									Borrow
								</button>
							</div>
							<div className="field">
								<span className="field-label">{side === 'lend' ? 'Amount to lend' : 'Amount to borrow'}</span>
								<div className="field-row">
									<input className="input big" placeholder="0.00" inputMode="decimal" value={amountText} onChange={event => setAmountText(event.target.value)} data-testid="lend-amount" />
									<span className="muted">{meta.symbol}</span>
								</div>
							</div>
							<div className="field">
								<span className="field-label">Term</span>
								<div className="mode-grid compact">
									{LENDING_TERMS.filter(entry => side === 'lend' || entry.id !== 'demand').map(entry => (
										<button key={entry.id} type="button" className={`mode-card${termId === entry.id ? ' active' : ''}`} onClick={() => setTermId(entry.id)}>
											<span className="t">{entry.label}</span>
										</button>
									))}
								</div>
							</div>
							<div className="field">
								<span className="field-label">{side === 'lend' ? 'Bank savings rate · basis points' : 'Maximum interest you accept · basis points'}</span>
								<div className="field-row">
									<input className="input" inputMode="numeric" readOnly={side === 'lend'} value={quotedRate} onChange={event => setRateText(event.target.value)} data-testid="lend-rate" />
									<span className="muted">{quotedRate ? `= ${rate(Number(quotedRate))} ${termId === 'demand' ? 'per year · simple interest' : 'per term'}` : 'No current offer'}</span>
								</div>
							</div>
							{bankOfferUnavailable && <p className="note" data-testid="lending-bank-terms">This bank has not published a current offer for this asset and term.</p>}
							{side === 'borrow' && <p className="note" data-testid="lending-bank-approval">{bankTerms ? `Bank loan rate: ${rate(bankTerms.loanInterestBps)} per term. ` : ''}The bank must approve your facility before it can fund a request.</p>}
							{borrowPreview && <p className="note" data-testid="lending-borrow-preview">
								{!borrowPreview.ok ? borrowPreview.error : <>
									Term repayment: {formatAmount(borrowPreview.repayment, meta.decimals, meta.decimals)} {meta.symbol}, due {termId === '1m' ? '30 days' : LENDING_TERMS.find(entry => entry.id === termId)!.label} after approval.
									{' '}Early repayment charges only elapsed interest. After maturity, simple interest continues for at most {(bankTerms?.loanLateMs ?? 0) / 3_600_000} hours. Maximum repayment: {formatAmount(borrowPreview.maximum, meta.decimals, meta.decimals)} {meta.symbol}. No compounding. These bounds use your maximum rate; the confirmed rate may be lower.
								</>}
							</p>}
							{savingsRisk?.ok === false && <p role="alert">{savingsRisk.error}</p>}
							{hub && borrowPreview?.ok && <ReceiveCapacity
								account={hub.doc.state} ownerEntityId={wallet.entityId} signerId={wallet.signerId}
								counterpartyEntityId={hubId} accountLabel={hub.label} jurisdiction={wallet.jurisdiction}
								tokenId={tokenId} requiredAmount={borrowPreview.principal} disabled={busy || hub.disputed || !borrowAvailable}
							/>}
							{needsRiskConsent && savingsRisk?.ok && <LendingRiskConsent
								entityId={wallet.entityId} signerId={wallet.signerId} hubId={hubId} tokenId={tokenId}
								currentLimit={savingsRisk.currentLimit} requiredLimit={savingsRisk.requiredLimit}
								disabled={!submitAvailable || busy || !wallet.signerId || Boolean(hub?.disputed)}
							/>}
							<button type="button" className="btn primary" disabled={!submitAvailable || bankOfferUnavailable || busy || !amountText.trim() || !hubId || quoteError || needsRiskConsent || needsReceiveCapacity} onClick={() => void submit()} data-testid="lend-submit">
								{busy ? 'Sending…' : side === 'lend' ? 'Save with this bank' : 'Request the loan'}
							</button>
							{requestId && <p role="status" data-testid="lending-request-status">
								{!state || state.requestId !== requestId || state.requestStatus === null || state.requestStatus === 'unseen' ? 'Waiting for the bank to process your request.'
									: state.requestStatus === 'not-funded' ? 'Request processed. No loan was funded. The bank needs an approved facility and available funds.'
										: state.requestStatus === 'opening' ? 'Bank funding is awaiting Account confirmation.'
											: `Loan ${state.requestStatus}. See your loan below for the committed balance and terms.`}
							</p>}
							<p className="note" style={{ marginTop: 10 }}>
								{side === 'lend'
									? termId === 'demand' ? 'Withdraw at any time with interest earned until payment. The bank may change future rates through a signed Account update; earned interest stays yours and never compounds. Each signed rate covers up to one year. Renewal requires current bank terms, Account risk capacity and both parties online. The coverage end is shown with your claim.' : 'The bank owes your principal and agreed interest independently of its borrowers. Early cancellation returns principal; at maturity the full agreed return is due. Payout requires capacity in your Account with the bank.'
									: 'The bank must approve your borrowing facility. Draws within it transfer principal once, subject to Account capacity and accepted risk. Your credit limit stays unchanged. Repayment charges principal plus interest for the actual elapsed time.'}
							</p>
						</>
					)}
				</div>
				<div className="aside">
					<div className="card" data-testid="lending-state">
						<div className="sect" style={{ marginTop: 0 }}>
							<h3 className="caps">{hub ? `${hub.label} pool` : 'Pool'}</h3>
							<button type="button" className="more" onClick={() => void refresh()} disabled={loading}>
								{loading ? 'Loading…' : 'Refresh'}
							</button>
						</div>
						{stateError ? (
							<p className="note" style={{ color: 'var(--debt)' }}>
								{stateError.includes('HTTP API') ? 'This runtime has no lending API. Pools and loans show against a hosted hub.' : stateError}
							</p>
						) : null}
						{state ? (
							<>
								<div className="kv">
									<span className="k">Savings principal</span>
									<span className="v num">{formatMoney(state.totals.savingsPrincipal, meta.decimals)}</span>
								</div>
								<div className="kv">
									<span className="k">Outstanding loan principal</span>
									<span className="v num">{formatMoney(state.totals.loanPrincipal, meta.decimals)}</span>
								</div>
								<div className="kv">
									<span className="k">Active principal</span>
									<span className="v num">{formatMoney(state.totals.activePrincipal, meta.decimals)}</span>
								</div>
							</>
						) : stateError ? null : (
							<p className="note">
								{loading ? 'Reading the pool…' : 'This hub has published no pool yet, so there is nothing to lend into or borrow from.'}
							</p>
						)}
					</div>
					{myPools.length > 0 ? (
						<div className="card">
							<h3 className="caps">Your offers</h3>
							{myPools.map((pool, index) => (
								<div key={pool.positionId}>
								<div className={`row${index === 0 ? ' first' : ''}`}>
									<span className="rt">
										<TokenIcon tokenId={pool.tokenId} />
										<span className="tx">
											<span className="t">{formatMoney(pool.principalAmount, meta.decimals)} {meta.symbol}</span>
											<span className="s">
												{pool.termId === 'demand' ? 'On demand' : pool.termId} · {rate(pool.interestBps)}{pool.termId === 'demand' ? ' per year' : ''} · {pool.status} · {formatMoney(pool.closeAmount, meta.decimals)} claim
											</span>
										</span>
									</span>
								</div>
								{pool.rateExpiresAt !== null && <p className="note" data-testid="savings-rate-coverage">{pool.rateExpiresAt <= Date.now() ? 'Rate coverage ended. Your principal and earned interest remain owed; further interest needs a signed renewal.' : `Signed rate coverage ends ${new Date(pool.rateExpiresAt).toLocaleString()}. Renewal cannot exceed your accepted risk.`}</p>}
								<LendingClose pool={pool} wallet={wallet} onSubmitted={() => void refresh()} />
								</div>
							))}
						</div>
					) : null}
					{myLoans.length > 0 ? (
						<div className="card">
							<h3 className="caps">Your loans</h3>
							{myLoans.map((loan, index) => (
								<div key={loan.loanId} className={`row${index === 0 ? ' first' : ''}`}>
									<span className="rt">
										<TokenIcon tokenId={loan.tokenId} />
										<span className="tx">
											<span className="t">{formatMoney(loan.principalAmount, meta.decimals)} {meta.symbol}</span>
											<span className="s">
												{loan.termId} · {rate(loan.interestBps)} · {loan.status} · due {loan.dueAt ? new Date(loan.dueAt).toLocaleString() : '—'} · repaid{' '}
												{formatMoney(loan.repaidAmount, meta.decimals)} of {formatMoney(loan.repaymentAmount, meta.decimals)}
											{isLendingLoanRepayable(loan) && <> · Repay authorizes up to {formatAmount(lendingLoanMaximumAmount(loan), meta.decimals, meta.decimals)} {meta.symbol}; only the amount due at confirmation is debited.</>}
											</span>
										</span>
									</span>
									<LendingRepay loan={loan} wallet={wallet} onSubmitted={() => void refresh()} />
								</div>
							))}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
