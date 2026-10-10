import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Legend } from '../components/Bars';
import { CopyId } from '../components/CopyId';
import { Icon } from '../components/Icons';
import { Sheet } from '../components/Sheet';
import { TokenSection } from '../components/account/TokenSection';
import { SettlementCard } from '../components/account/SettlementCard';
import { ManageSheet, type ManageTab } from '../components/account/ManageSheet';
import { FrameHistory } from '../components/account/FrameHistory';
import { useApp } from '../runtime/store';
import { accountSafety, formatDuration } from '../runtime/financial/sovereignty';
import { usdOf } from '../runtime/financial/prices';
import { disputeView } from '../runtime/financial/manage';
import { sendEntityTxs } from '../runtime/tx';
import { formatMoney, formatUsd, getTokenMeta, parseAmount } from '../runtime/format';
import { useWallet, type AccountTokenView } from '../runtime/views';

export function AccountDetail() {
	const navigate = useNavigate();
	const { counterpartyId = '' } = useParams();
	const entityId = useApp(s => s.activeEntityId);
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const toast = useApp(s => s.toast);
	const wallet = useWallet(entityId);
	const [showEmpty, setShowEmpty] = useState(false);
	const [showFrames, setShowFrames] = useState(false);
	const [managing, setManaging] = useState<false | ManageTab>(false);
	const account = wallet.accounts.find(entry => entry.counterpartyId === counterpartyId.toLowerCase()) ?? null;
	// A lane with no position, no credit either way and no collateral is plumbing until money touches it.
	const lanes = useMemo(() => {
		const tokens = account?.tokens ?? [];
		const isEmpty = (token: AccountTokenView): boolean =>
			token.signed === 0n &&
			token.derived.ownCreditLimit === 0n &&
			token.derived.peerCreditLimit === 0n &&
			token.derived.collateral === 0n &&
			(token.derived.outTotalHold ?? 0n) === 0n &&
			(token.derived.inTotalHold ?? 0n) === 0n;
		return { active: tokens.filter(token => !isEmpty(token)), empty: tokens.filter(isEmpty) };
	}, [account]);
	const label = account?.label ?? 'Account';
	const dispute = account ? disputeView(account.doc, account.isLeft, wallet.frame?.activeEntity?.core?.jBatchState?.batch ?? null) : null;

	const [extending, setExtending] = useState(false);
	const [creditText, setCreditText] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const meta = getTokenMeta(selectedTokenId);

	const extendCredit = async (): Promise<void> => {
		if (!wallet.entityId || !wallet.signerId) return;
		setSubmitting(true);
		try {
			const amount = parseAmount(creditText, meta.decimals);
			if (amount <= 0n) throw new Error('Enter a positive amount');
			await sendEntityTxs(wallet.entityId, wallet.signerId, [
				{ type: 'extendCredit', data: { counterpartyEntityId: counterpartyId.toLowerCase(), tokenId: selectedTokenId, amount } },
			]);
			toast(`Credit limit set to ${formatMoney(amount, meta.decimals)} ${meta.symbol} for ${label}`);
			setExtending(false);
			setCreditText('');
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setSubmitting(false);
		}
	};

	const statusLabel = !account
		? '—'
		: dispute?.phase === 'closed'
			? 'Closed after dispute'
		: dispute?.phase === 'active'
			? 'Disputed'
			: dispute?.phase === 'queued'
				? 'Dispute queued'
			: dispute?.phase === 'sent'
				? 'Dispute sent'
			: dispute?.phase === 'preparing'
				? 'Dispute preparing'
				: account.settlement === 'awaiting_you'
					? 'Settlement needs your signature'
					: account.settlement !== 'none'
						? 'Settling'
						: 'Open';

	return (
		<div className="screen fade-in">
			<div className="screen-header">
				<span className="screen-title">
					<button type="button" className="icon-btn" onClick={() => navigate(-1)} aria-label="Back" data-testid="back">
						<Icon name="chevronLeft" size={18} />
					</button>
					<span>
						<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
							{label}
							{account?.isHub ? <span className="chip hub">hub</span> : null}
						</span>
						<span style={{ display: 'block' }}>
							<CopyId value={counterpartyId.toLowerCase()} label="Entity id" />
						</span>
					</span>
				</span>
			</div>

			<div className="two-col">
			<div>
			<div className="actions" style={{ margin: '0 0 18px' }}>
				<button type="button" className="btn primary" disabled={account?.disputed} onClick={() => navigate(`/pay?to=${counterpartyId.toLowerCase()}`)}>
					<Icon name="pay" size={18} />
					Pay
				</button>
				<button type="button" className="btn" disabled={account?.disputed} onClick={() => setExtending(true)} data-testid="account-extend-credit">
					<Icon name="plus" size={18} />
					Extend credit
				</button>
				{account?.isHub ? (
					<button type="button" className="btn" disabled={account.disputed} onClick={() => navigate(`/swap?hub=${counterpartyId.toLowerCase()}`)}>
						<Icon name="swap" size={18} />
						Swap
					</button>
				) : (
					<button type="button" className="btn" disabled={account?.disputed} onClick={() => navigate(`/receive`)}>
						<Icon name="receive" size={18} />
						Receive
					</button>
				)}
				<button type="button" className="btn" disabled={!account} onClick={() => setManaging(account?.disputed ? 'dispute' : 'collateral')} data-testid="account-manage">
					<Icon name="settings" size={18} />
					Manage
				</button>
				{account && account.dispute === 'none' ? (
					<button type="button" className="btn" onClick={() => setManaging('dispute')} data-testid="account-dispute" title="Take the last page you both signed to the chain. You never need the other side's permission.">
						<Icon name="shield" size={18} />
						Dispute
					</button>
				) : null}
			</div>

			{!account && !wallet.loading && <p className="note">No account with this counterparty yet.</p>}
			{dispute?.phase === 'closed' ? (
				<p className="state" style={{ marginBottom: 14 }} data-testid="account-dispute-state">
					Dispute finalized. This account is permanently closed.
				</p>
			) : dispute?.phase === 'active' ? (
				<p className="state st-dispute" style={{ marginBottom: 14 }} data-testid="account-dispute-state">
					Dispute in progress{dispute.observedOnChain ? ' on-chain' : ''}. Payments through this account are paused.
				</p>
			) : dispute?.phase === 'queued' ? (
				<p className="state st-dispute" style={{ marginBottom: 14 }} data-testid="account-dispute-state">
					Dispute start queued in your on-chain batch. Sign and send it from Home.
				</p>
			) : dispute?.phase === 'sent' ? (
				<p className="state st-dispute" style={{ marginBottom: 14 }} data-testid="account-dispute-state">
					Dispute start sent to the chain. Waiting for the DisputeStarted confirmation; the account stays frozen.
				</p>
			) : dispute?.phase === 'preparing' ? (
				<p className="state st-dispute" style={{ marginBottom: 14 }} data-testid="account-dispute-state">
					Dispute preparing. Traffic is frozen; the on-chain start joins your batch once orders are withdrawn.
				</p>
			) : null}
			{account ? <SettlementCard account={account} wallet={wallet} /> : null}
			{account && lanes.active.length > 0 ? (
				<div style={{ margin: '0 0 12px' }}>
					<Legend />
				</div>
			) : null}
			{account && lanes.active.map(token => (
				<TokenSection key={token.tokenId} token={token} disputed={account.disputed} closed={account.dispute === 'closed'} />
			))}
			{lanes.empty.length > 0 ? (
				<button type="button" className="btn quiet" style={{ marginBottom: 14 }} onClick={() => setShowEmpty(value => !value)} data-testid="account-unused-lanes" data-open={showEmpty ? 'yes' : 'no'}>
					{showEmpty ? 'Hide' : 'Show'} {lanes.empty.length} unused {lanes.empty.length === 1 ? 'token' : 'tokens'} ·{' '}
					{lanes.empty.map(token => getTokenMeta(token.tokenId).symbol).join(', ')}
				</button>
			) : null}
			{account && showEmpty ? lanes.empty.map(token => <TokenSection key={token.tokenId} token={token} disputed={account.disputed} closed={account.dispute === 'closed'} />) : null}
			<button
				type="button"
				className="btn quiet"
				style={{ marginBottom: 14 }}
				onClick={() => setShowFrames(value => !value)}
				data-testid="account-frames-toggle"
				data-open={showFrames ? 'yes' : 'no'}
			>
				{showFrames ? 'Hide' : 'Show'} the signed pages of this account
			</button>
			{showFrames ? <FrameHistory entityId={wallet.entityId} counterpartyId={counterpartyId.toLowerCase()} /> : null}
			</div>
			<div className="aside">
				<div className="card">
					<h3 className="caps">This account</h3>
					<div className="kv" style={{ marginTop: 8 }}>
						<span className="k">Counterparty</span>
						<span className="v">{account?.isHub ? 'Hub' : 'Direct'}</span>
					</div>
					<div className="kv">
						<span className="k">Network</span>
						<span className="v">{wallet.jurisdiction || '—'}</span>
					</div>
					<div className="kv">
						<span className="k">Frames signed</span>
						<span className="v num">{(account?.frameHeight ?? 0).toLocaleString('en-US')}</span>
					</div>
					{account ? (
						(() => {
							const safety = accountSafety(account);
							return (
								<>
									<div className="kv" data-testid="account-exposure">
										<span className="k">They owe you, uncovered</span>
										<span className="v num" style={{ color: safety.riskUsd > 0 ? 'var(--risk)' : undefined }}>
											{formatUsd(safety.riskUsd)}
											{safety.riskUsd > 0 && account.isHub && account.dispute === 'none' ? (
												<button type="button" className="btn quiet sm" style={{ marginLeft: 8 }} onClick={() => setManaging('collateral')} data-testid="account-cover" title="Ask the hub to lock its own collateral for what it owes you">
													Cover it
												</button>
											) : null}
										</span>
									</div>
									<div className="kv">
										<span className="k">Their debt covered by collateral</span>
										<span className="v num" style={{ color: safety.securedUsd > 0 ? 'var(--coll)' : undefined }}>{formatUsd(safety.securedUsd)}</span>
									</div>
									<div className="kv">
										<span className="k">Collateral you posted</span>
										<span className="v num">{formatUsd(account.tokens.reduce((sum, token) => sum + usdOf(token.tokenId, token.derived.collateral), 0))}</span>
									</div>
									<div className="kv">
										<span className="k">You owe</span>
										<span className="v num" style={{ color: safety.owedUsd > 0 ? 'var(--debt)' : undefined }}>{formatUsd(safety.owedUsd)}</span>
									</div>
									<div className="kv">
										<span className="k">If you dispute, they answer within</span>
										<span className="v num">{formatDuration(safety.theirResponseSeconds)}</span>
									</div>
								</>
							);
						})()
					) : null}
					<div className="kv">
						<span className="k">Status</span>
						<span className={`v ${dispute && dispute.phase !== 'none' ? 'st-dispute' : account?.settlement === 'awaiting_you' ? 'st-pending' : 'st-settled'}`} data-testid="account-status">
							{statusLabel}
						</span>
					</div>
					<p className="note" style={{ marginTop: 12 }}>
						Every frame here is signed by both of you. The credit line is your cap on what they can owe you; collateral is what is enforceable on-chain.
					</p>
				</div>
			</div>
			</div>

			{extending && (
				<Sheet title="Extend credit" onClose={() => setExtending(false)}>
					<p className="note">
						You allow {label} to owe you up to this amount in {meta.symbol}. It widens what you can receive from them and what they can route
						through you. Your risk is capped at this line.
					</p>
					<div className="field">
						<span className="field-label">Credit line</span>
						<div className="field-row">
							<input className="input big" placeholder="0.00" inputMode="decimal" value={creditText} onChange={event => setCreditText(event.target.value)} autoFocus />
							<span className="muted">{meta.symbol}</span>
						</div>
					</div>
					<button type="button" className="btn" disabled={account?.disputed || submitting || !creditText.trim()} onClick={() => void extendCredit()}>
						{submitting ? 'Extending…' : 'Extend credit'}
					</button>
				</Sheet>
			)}
			{managing && account ? <ManageSheet account={account} wallet={wallet} initialTab={managing} onClose={() => setManaging(false)} /> : null}
		</div>
	);
}
