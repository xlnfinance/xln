import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icons';
import { TokenIcon } from '../components/TokenPicker';
import { useApp } from '../runtime/store';
import { sendEntityTxs } from '../runtime/tx';
import { formatMoney, getTokenMeta, parseAmount, timeAgo } from '../runtime/format';
import { useWallet } from '../runtime/views';
import {
	LENDING_TERMS,
	buildLendingBorrowTx,
	buildLendingOfferTx,
	buildLendingRepayTx,
	fetchLendingState,
	type LendingState,
	type TermId,
} from '../runtime/financial/lending';

const rate = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

/**
 * Lend to a hub's pool or borrow from it. The pool state is the hub runtime's
 * HTTP view; the offers, borrows and repayments are entity txs committed on
 * the bilateral account with the hub.
 */
export function Lending() {
	const navigate = useNavigate();
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
	const [termId, setTermId] = useState<TermId>('1d');
	const [rateText, setRateText] = useState(side === 'lend' ? '100' : '250');
	const [state, setState] = useState<LendingState | null>(null);
	const [stateError, setStateError] = useState('');
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const meta = getTokenMeta(tokenId);
	const hub = hubs.find(account => account.counterpartyId === hubId) ?? null;

	useEffect(() => {
		if (!hubId && hubs.length > 0) setHubId(hubs[0]!.counterpartyId);
	}, [hubs, hubId]);

	const refresh = useCallback(async () => {
		if (!hubId || !wallet.entityId) return;
		setLoading(true);
		try {
			setState(await fetchLendingState({ hubEntityId: hubId, userEntityId: wallet.entityId, tokenId }));
			setStateError('');
		} catch (error) {
			setState(null);
			setStateError(error instanceof Error ? error.message : String(error));
		} finally {
			setLoading(false);
		}
	}, [hubId, wallet.entityId, tokenId]);

	useEffect(() => {
		void refresh();
	}, [refresh, height]);

	const submit = async (): Promise<void> => {
		if (!wallet.signerId || !hubId) return;
		setBusy(true);
		try {
			const amount = parseAmount(amountText, meta.decimals);
			if (amount <= 0n) throw new Error('Enter a positive amount');
			const bps = Math.max(0, Math.floor(Number(rateText) || 0));
			const tx =
				side === 'lend'
					? buildLendingOfferTx({ hubEntityId: hubId, tokenId, amount, termId, interestBps: bps })
					: buildLendingBorrowTx({ hubEntityId: hubId, tokenId, amount, termId, maxInterestBps: bps });
			await sendEntityTxs(wallet.entityId, wallet.signerId, [tx]);
			toast(side === 'lend' ? `Offered ${formatMoney(amount, meta.decimals)} ${meta.symbol} to ${hub?.label ?? 'the hub'}` : `Borrow request for ${formatMoney(amount, meta.decimals)} ${meta.symbol} sent`);
			setAmountText('');
			void refresh();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setBusy(false);
		}
	};

	const repay = async (loanId: string): Promise<void> => {
		const loan = state?.loans.find(entry => entry.loanId === loanId);
		if (!loan || !wallet.signerId) return;
		setBusy(true);
		try {
			await sendEntityTxs(wallet.entityId, wallet.signerId, [buildLendingRepayTx(loan, wallet.entityId)]);
			toast('Repayment sent');
			void refresh();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setBusy(false);
		}
	};

	const myLoans = state?.loans.filter(loan => loan.borrowerEntityId.toLowerCase() === wallet.entityId) ?? [];
	const myPools = state?.pools.filter(pool => pool.lenderEntityId.toLowerCase() === wallet.entityId) ?? [];

	return (
		<div className="screen fade-in">
			<div className="screen-header">
				<span className="screen-title">
					<button type="button" className="icon-btn" onClick={() => navigate(-1)} aria-label="Back">
						<Icon name="chevronLeft" size={18} />
					</button>
					Lending
				</span>
			</div>
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
								<div className="mode-grid">
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
								<button type="button" role="tab" aria-selected={side === 'borrow'} className={side === 'borrow' ? 'active' : ''} onClick={() => { setSide('borrow'); setRateText('250'); }} data-testid="lend-side-borrow">
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
								<div className="mode-grid">
									{LENDING_TERMS.map(entry => (
										<button key={entry.id} type="button" className={`mode-card${termId === entry.id ? ' active' : ''}`} onClick={() => setTermId(entry.id)}>
											<span className="t">{entry.label}</span>
										</button>
									))}
								</div>
							</div>
							<div className="field">
								<span className="field-label">{side === 'lend' ? 'Interest you ask · basis points' : 'Maximum interest you accept · basis points'}</span>
								<div className="field-row">
									<input className="input" inputMode="numeric" value={rateText} onChange={event => setRateText(event.target.value)} data-testid="lend-rate" />
									<span className="muted">= {rate(Math.max(0, Math.floor(Number(rateText) || 0)))} per term</span>
								</div>
							</div>
							<button type="button" className="btn primary" disabled={busy || !amountText.trim() || !hubId} onClick={() => void submit()} data-testid="lend-submit">
								{busy ? 'Sending…' : side === 'lend' ? 'Offer to the pool' : 'Request the loan'}
							</button>
							<p className="note" style={{ marginTop: 10 }}>
								{side === 'lend'
									? 'Your offer sits in the hub pool until borrowed; principal and interest come back on your account with the hub at term end.'
									: 'The hub matches you against open offers at or under your rate. The loan lands on your account; repay before it is due.'}
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
									<span className="k">Available</span>
									<span className="v num">{formatMoney(state.totals.available, meta.decimals)}</span>
								</div>
								<div className="kv">
									<span className="k">Borrowed</span>
									<span className="v num">{formatMoney(state.totals.borrowed, meta.decimals)}</span>
								</div>
								<div className="kv">
									<span className="k">Active principal</span>
									<span className="v num">{formatMoney(state.totals.activePrincipal, meta.decimals)}</span>
								</div>
							</>
						) : null}
					</div>
					{myPools.length > 0 ? (
						<div className="card">
							<h3 className="caps">Your offers</h3>
							{myPools.map((pool, index) => (
								<div key={pool.positionId} className={`row${index === 0 ? ' first' : ''}`}>
									<span className="rt">
										<TokenIcon tokenId={pool.tokenId} />
										<span className="tx">
											<span className="t">{formatMoney(pool.principalAmount, meta.decimals)} {meta.symbol}</span>
											<span className="s">
												{pool.termId} · {rate(pool.interestBps)} · {pool.status} · {formatMoney(pool.availableAmount, meta.decimals)} free
											</span>
										</span>
									</span>
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
												{loan.termId} · {rate(loan.interestBps)} · {loan.status} · due {loan.dueAt ? timeAgo(loan.dueAt) : '—'} · repaid{' '}
												{formatMoney(loan.repaidAmount, meta.decimals)} of {formatMoney(loan.repaymentAmount, meta.decimals)}
											</span>
										</span>
										{loan.status === 'active' ? (
											<button type="button" className="btn ghost sm" disabled={busy} onClick={() => void repay(loan.loanId)}>
												Repay
											</button>
										) : null}
									</span>
								</div>
							))}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
