import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { DeltaBar, DeltaCaption, Legend } from '../components/Bars';
import { CopyId } from '../components/CopyId';
import { Icon } from '../components/Icons';
import { Sheet } from '../components/Sheet';
import { TokenIcon } from '../components/TokenPicker';
import { useApp } from '../runtime/store';
import { sendEntityTxs } from '../runtime/tx';
import { formatMoney, formatSigned, getTokenMeta, knownTokenIds, parseAmount } from '../runtime/format';
import { useWallet, type AccountTokenView, type AccountView, type WalletView } from '../runtime/views';
import {
	buildAddTokenTx,
	buildDisputeFinalizeTx,
	buildPrepareDisputeTx,
	buildRequestCollateralTx,
	buildSettleApproveTx,
	collateralFee,
	counterpartyFeePolicy,
	describeSettlementOp,
	disputeView,
	requestCreditFromHub,
	settlementView,
} from '../runtime/financial/manage';

function TokenSection({ token }: { token: AccountTokenView }) {
	const meta = getTokenMeta(token.tokenId);
	const d = token.derived;
	const money = (value: bigint): string => formatMoney(value, meta.decimals);
	const [details, setDetails] = useState(false);
	return (
		<section className="card" style={{ marginBottom: 14 }}>
			<div className="rt" style={{ marginBottom: 14 }}>
				<TokenIcon tokenId={token.tokenId} />
				<span className="tx">
					<span className="t">{meta.symbol}</span>
					<span className="s">{token.signed > 0n ? 'they owe you' : token.signed < 0n ? 'you owe them' : 'even'}</span>
				</span>
				<span className="r">
					<span className="v num display" style={{ fontSize: 22 }}>
						{formatSigned(token.signed, meta.decimals)}
					</span>
				</span>
			</div>
			<DeltaBar derived={d} tokenId={token.tokenId} />
			<DeltaCaption derived={d} format={money} />
			<div style={{ marginTop: 14 }}>
				<div className="kv">
					<span className="k">Their credit line to you</span>
					<span className="v num">{money(d.ownCreditLimit)}</span>
				</div>
				<div className="kv">
					<span className="k">Your credit line to them</span>
					<span className="v num">{money(d.peerCreditLimit)}</span>
				</div>
				<div className="kv">
					<span className="k">Collateral</span>
					<span className={`v num${d.collateral > 0n ? ' st-settled' : ''}`}>{money(d.collateral)}</span>
				</div>
				{(d.outTotalHold ?? 0n) > 0n || (d.inTotalHold ?? 0n) > 0n ? (
					<div className="kv">
						<span className="k">In flight</span>
						<span className="v num st-inflight">
							{money(d.outTotalHold ?? 0n)} out · {money(d.inTotalHold ?? 0n)} in
						</span>
					</div>
				) : null}
			</div>
			<button type="button" className="btn quiet" style={{ marginTop: 10 }} onClick={() => setDetails(value => !value)}>
				Ledger detail <Icon name={details ? 'chevronDown' : 'chevronRight'} size={13} />
			</button>
			{details && (
				<div className="fade-in" style={{ marginTop: 6 }}>
					<div className="kv">
						<span className="k">Δ</span>
						<span className="v num mono" style={{ color: 'var(--ink-2)' }}>
							{formatMoney(d.delta, meta.decimals, 6)}
						</span>
					</div>
					<div className="kv">
						<span className="k">offdelta</span>
						<span className="v num mono" style={{ color: 'var(--ink-2)' }}>
							{formatMoney(token.delta.offdelta, meta.decimals, 6)}
						</span>
					</div>
					<div className="kv">
						<span className="k">ondelta</span>
						<span className="v num mono" style={{ color: 'var(--ink-2)' }}>
							{formatMoney(token.delta.ondelta, meta.decimals, 6)}
						</span>
					</div>
					<div className="kv">
						<span className="k">Total capacity</span>
						<span className="v num mono" style={{ color: 'var(--ink-2)' }}>
							{formatMoney(d.totalCapacity, meta.decimals, 6)}
						</span>
					</div>
				</div>
			)}
		</section>
	);
}

const moneyOf = (tokenId: number, amount: bigint): string => {
	const meta = getTokenMeta(tokenId);
	return `${formatMoney(amount, meta.decimals)} ${meta.symbol}`;
};

/**
 * Settlement workspace on this account: who proposed, who signed, and the one
 * action the wallet can take (sign when it is our turn). Execution and the
 * on-chain batch follow automatically once both hankos are in.
 */
function SettlementCard({ account, wallet }: { account: AccountView; wallet: WalletView }) {
	const toast = useApp(s => s.toast);
	const [busy, setBusy] = useState(false);
	const view = settlementView(account.doc, account.isLeft);
	if (!view) return null;

	const sign = async (): Promise<void> => {
		if (!wallet.signerId) return;
		setBusy(true);
		try {
			await sendEntityTxs(wallet.entityId, wallet.signerId, [buildSettleApproveTx(account.counterpartyId, view.workspaceHash)]);
			toast('Settlement signed');
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="card" style={{ marginBottom: 14 }} data-testid="settlement-card" data-phase={view.phase}>
			<div className="sect" style={{ marginTop: 0 }}>
				<h3 className="caps">Settlement</h3>
				<span className={`state ${view.phase === 'awaiting_you' ? 'st-pending' : view.phase === 'submitted' || view.phase === 'ready' ? 'st-inflight' : 'st-settled'}`}>
					{view.label}
				</span>
			</div>
			{view.ops.map((op, index) => (
				<div key={index} className="kv">
					<span className="k">{op.type}</span>
					<span className="v" style={{ fontWeight: 400 }}>
						{describeSettlementOp(op, moneyOf, view.proposedByUs)}
					</span>
				</div>
			))}
			<div className="kv">
				<span className="k">Signatures</span>
				<span className="v" style={{ fontWeight: 400 }}>
					you {view.signedByUs ? '✓' : '·'} · {account.label} {view.signedByThem ? '✓' : '·'}
				</span>
			</div>
			<div className="kv">
				<span className="k">Submits on-chain</span>
				<span className="v" style={{ fontWeight: 400 }}>
					{view.weExecute ? 'you' : account.label}
				</span>
			</div>
			{view.memo ? (
				<p className="note" style={{ marginTop: 8 }}>
					{view.memo}
				</p>
			) : null}
			{view.phase === 'awaiting_you' ? (
				<button type="button" className="btn" style={{ marginTop: 12 }} disabled={busy || !wallet.signerId} onClick={() => void sign()} data-testid="settlement-sign">
					<Icon name="check" size={15} />
					{busy ? 'Signing…' : 'Sign settlement'}
				</button>
			) : null}
		</div>
	);
}

type ManageTab = 'collateral' | 'credit' | 'token' | 'dispute';

function ManageSheet({ account, wallet, onClose }: { account: AccountView; wallet: WalletView; onClose: () => void }) {
	const navigate = useNavigate();
	const toast = useApp(s => s.toast);
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const [tab, setTab] = useState<ManageTab>(account.dispute !== 'none' ? 'dispute' : 'collateral');
	const [tokenId, setTokenId] = useState(selectedTokenId);
	const [amountText, setAmountText] = useState('');
	const [creditText, setCreditText] = useState('');
	const [addTokenId, setAddTokenId] = useState<number | null>(null);
	const [confirmDispute, setConfirmDispute] = useState(false);
	const [busy, setBusy] = useState(false);
	const meta = getTokenMeta(tokenId);
	const counterpartyId = account.counterpartyId;
	const laneTokenIds = new Set(account.tokens.map(token => token.tokenId));
	const addable = knownTokenIds().filter(id => !laneTokenIds.has(id));
	const policy = counterpartyFeePolicy(account.doc, account.isLeft, tokenId);
	const dispute = disputeView(account.doc, account.isLeft, wallet.frame?.activeEntity?.core?.jBatchState?.batch ?? null);
	const amount = useMemo(() => {
		try {
			return amountText.trim() ? parseAmount(amountText, meta.decimals) : 0n;
		} catch {
			return 0n;
		}
	}, [amountText, meta.decimals]);
	const fee = policy && amount > 0n ? collateralFee(policy, amount) : 0n;
	const net = amount > fee ? amount - fee : 0n;

	const run = async (label: string, work: () => Promise<void>): Promise<void> => {
		setBusy(true);
		try {
			await work();
			toast(label);
			onClose();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setBusy(false);
		}
	};
	const send = (txs: Parameters<typeof sendEntityTxs>[2]): Promise<unknown> => {
		if (!wallet.signerId) throw new Error('No signer for this entity');
		return sendEntityTxs(wallet.entityId, wallet.signerId, txs);
	};

	const tabs: Array<{ id: ManageTab; label: string }> = [
		{ id: 'collateral', label: 'Collateral' },
		...(account.isHub ? [{ id: 'credit' as const, label: 'Credit' }] : []),
		{ id: 'token', label: 'Add token' },
		{ id: 'dispute', label: 'Dispute' },
	];

	return (
		<Sheet title={`Manage · ${account.label}`} onClose={onClose}>
			<div className="segc" style={{ marginBottom: 14 }} role="tablist">
				{tabs.map(entry => (
					<button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={tab === entry.id ? 'active' : ''} onClick={() => setTab(entry.id)} data-testid={`manage-tab-${entry.id}`}>
						{entry.label}
					</button>
				))}
			</div>

			{tab === 'collateral' ? (
				<div className="fade-in">
					<p className="note">
						Ask {account.label} to lock collateral on-chain against what they owe you. They charge their published fee, taken from the amount; the rest becomes
						enforceable collateral.
					</p>
					<div className="field">
						<span className="field-label">Token</span>
						<div className="mode-grid">
							{account.tokens.map(token => (
								<button key={token.tokenId} type="button" className={`mode-card${tokenId === token.tokenId ? ' active' : ''}`} onClick={() => setTokenId(token.tokenId)}>
									<span className="t">{getTokenMeta(token.tokenId).symbol}</span>
									<span className="s">{getTokenMeta(token.tokenId).name}</span>
								</button>
							))}
						</div>
					</div>
					<div className="field">
						<span className="field-label">Gross amount</span>
						<div className="field-row">
							<input className="input big" placeholder="0.00" inputMode="decimal" value={amountText} onChange={event => setAmountText(event.target.value)} data-testid="collateral-amount" />
							<span className="muted">{meta.symbol}</span>
						</div>
					</div>
					{policy ? (
						<div style={{ marginBottom: 12 }}>
							<div className="kv">
								<span className="k">Their fee</span>
								<span className="v num">
									{formatMoney(policy.baseFee + policy.gasFee, meta.decimals)} + {(Number(policy.liquidityFeeBps) / 100).toFixed(2)}%
								</span>
							</div>
							{amount > 0n ? (
								<>
									<div className="kv">
										<span className="k">Fee on this request</span>
										<span className="v num">{formatMoney(fee, meta.decimals)}</span>
									</div>
									<div className="kv">
										<span className="k">Collateral you get</span>
										<span className="v num st-settled">{formatMoney(net, meta.decimals)}</span>
									</div>
								</>
							) : null}
						</div>
					) : (
						<p className="note" style={{ color: 'var(--debt)' }}>
							{account.label} has not published a fee policy for {meta.symbol} on this account yet. The request needs their committed policy frame.
						</p>
					)}
					<button type="button" className="btn" disabled={busy || !policy || amount <= 0n || net <= 0n} onClick={() => void run(`Collateral request sent to ${account.label}`, async () => { await send([buildRequestCollateralTx(counterpartyId, tokenId, amount, policy!)]); })} data-testid="collateral-request">
						{busy ? 'Sending…' : 'Request collateral'}
					</button>
				</div>
			) : null}

			{tab === 'credit' ? (
				<div className="fade-in">
					<p className="note">
						Ask the hub to extend you a credit line in {meta.symbol}. The hub decides and commits the line; it lands on this account as “their credit line to you”.
					</p>
					<div className="field">
						<span className="field-label">Token</span>
						<div className="mode-grid">
							{account.tokens.map(token => (
								<button key={token.tokenId} type="button" className={`mode-card${tokenId === token.tokenId ? ' active' : ''}`} onClick={() => setTokenId(token.tokenId)}>
									<span className="t">{getTokenMeta(token.tokenId).symbol}</span>
									<span className="s">{getTokenMeta(token.tokenId).name}</span>
								</button>
							))}
						</div>
					</div>
					<div className="field">
						<span className="field-label">Credit line</span>
						<div className="field-row">
							<input className="input big" placeholder="0.00" inputMode="decimal" value={creditText} onChange={event => setCreditText(event.target.value)} data-testid="credit-amount" />
							<span className="muted">{meta.symbol}</span>
						</div>
					</div>
					<button
						type="button"
						className="btn"
						disabled={busy || !creditText.trim()}
						onClick={() =>
							void run('Credit requested from the hub', async () => {
								const value = parseAmount(creditText, meta.decimals);
								if (value <= 0n) throw new Error('Enter a positive amount');
								await requestCreditFromHub({ userEntityId: wallet.entityId, hubEntityId: counterpartyId, tokenId, amount: value });
							})
						}
						data-testid="credit-request"
					>
						{busy ? 'Asking…' : 'Request credit'}
					</button>
					<p className="note" style={{ marginTop: 8 }}>
						Goes to the hub's HTTP API. A sandbox has no hub server, so the request fails there.
					</p>
				</div>
			) : null}

			{tab === 'token' ? (
				<div className="fade-in">
					<p className="note">Adds a lane for another token with zero credit. Use “Extend credit” afterwards to set a line.</p>
					{addable.length === 0 ? (
						<p className="note">Every known token already has a lane here.</p>
					) : (
						<div className="field">
							<span className="field-label">Token</span>
							<div className="mode-grid">
								{addable.map(id => (
									<button key={id} type="button" className={`mode-card${addTokenId === id ? ' active' : ''}`} onClick={() => setAddTokenId(id)} data-testid={`add-token-${getTokenMeta(id).symbol}`}>
										<span className="t">{getTokenMeta(id).symbol}</span>
										<span className="s">{getTokenMeta(id).name}</span>
									</button>
								))}
							</div>
						</div>
					)}
					<button type="button" className="btn" disabled={busy || addTokenId === null} onClick={() => void run(`${getTokenMeta(addTokenId ?? 0).symbol} lane proposed`, async () => { await send([buildAddTokenTx(counterpartyId, addTokenId!)]); })} data-testid="add-token-submit">
						{busy ? 'Proposing…' : 'Add token'}
					</button>
				</div>
			) : null}

			{tab === 'dispute' ? (
				<div className="fade-in">
					{dispute.phase === 'active' ? (
						<>
							<p className="state st-dispute" style={{ marginBottom: 10 }}>
								Dispute {dispute.observedOnChain ? 'on-chain' : 'queued'} · started by {dispute.startedByUs ? 'you' : account.label}
							</p>
							<p className="note">
								{dispute.timeout > 0 ? `Challenge window closes ${new Date(dispute.timeout * 1000).toLocaleString()}. ` : ''}
								Finalize only after it passes on-chain; the finalization joins your next batch.
							</p>
							<button type="button" className="btn danger" disabled={busy || dispute.finalizeQueued} onClick={() => void run('Dispute finalization queued', async () => { await send([buildDisputeFinalizeTx(counterpartyId)]); })} data-testid="dispute-finalize">
								{dispute.finalizeQueued ? 'Finalize already queued' : busy ? 'Queuing…' : 'Queue dispute finalize'}
							</button>
						</>
					) : dispute.phase === 'queued' ? (
						<>
							<p className="state st-dispute" style={{ marginBottom: 10 }}>
								Dispute start queued
							</p>
							<p className="note">
								This account is frozen and the on-chain dispute start sits in your batch. Sign and send the batch from Home; the chain then opens the challenge
								window.
							</p>
							<button type="button" className="btn" onClick={() => { onClose(); navigate('/'); }} data-testid="dispute-go-batch">
								Go to the batch
							</button>
						</>
					) : dispute.phase === 'sent' ? (
						<>
							<p className="state st-dispute" style={{ marginBottom: 10 }}>
								Dispute start sent
							</p>
							<p className="note">
								The batch with the dispute start went to the chain. The account stays frozen; the challenge window and the finalize step appear once the
								runtime observes DisputeStarted.
							</p>
						</>
					) : dispute.phase === 'preparing' ? (
						<>
							<p className="state st-dispute" style={{ marginBottom: 10 }}>
								Preparing the dispute
							</p>
							<p className="note">
								Traffic on this account is frozen and open orders are being withdrawn. The on-chain dispute start joins your batch as soon as the evidence is
								stable.
							</p>
						</>
					) : (
						<>
							<p className="note">
								Disputing freezes this account, withdraws your orders at the hub and puts the latest signed state on-chain. Use it when {account.label} stops
								responding or refuses a settlement. It cannot be undone.
							</p>
							{!confirmDispute ? (
								<button type="button" className="btn danger" disabled={busy} onClick={() => setConfirmDispute(true)} data-testid="dispute-prepare">
									Dispute this account…
								</button>
							) : (
								<div className="actions">
									<button type="button" className="btn danger" disabled={busy} onClick={() => void run('Dispute prepared; the on-chain start joins your batch', async () => { await send([buildPrepareDisputeTx(counterpartyId)]); })} data-testid="dispute-prepare-confirm">
										{busy ? 'Preparing…' : 'Yes, dispute'}
									</button>
									<button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirmDispute(false)}>
										Keep the account
									</button>
								</div>
							)}
						</>
					)}
				</div>
			) : null}
		</Sheet>
	);
}

export function AccountDetail() {
	const navigate = useNavigate();
	const { counterpartyId = '' } = useParams();
	const entityId = useApp(s => s.activeEntityId);
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const toast = useApp(s => s.toast);
	const wallet = useWallet(entityId);
	const [showEmpty, setShowEmpty] = useState(false);
	const [managing, setManaging] = useState(false);
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
			toast(`Extended ${formatMoney(amount, meta.decimals)} ${meta.symbol} of credit to ${label}`);
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
					<button type="button" className="icon-btn" onClick={() => navigate(-1)} aria-label="Back">
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
				<button type="button" className="btn primary" onClick={() => navigate(`/pay?to=${counterpartyId.toLowerCase()}`)}>
					<Icon name="pay" size={18} />
					Pay
				</button>
				<button type="button" className="btn" onClick={() => setExtending(true)}>
					<Icon name="plus" size={18} />
					Extend credit
				</button>
				{account?.isHub ? (
					<button type="button" className="btn" onClick={() => navigate(`/swap?hub=${counterpartyId.toLowerCase()}`)}>
						<Icon name="swap" size={18} />
						Swap
					</button>
				) : (
					<button type="button" className="btn" onClick={() => navigate(`/receive`)}>
						<Icon name="receive" size={18} />
						Receive
					</button>
				)}
				<button type="button" className="btn" disabled={!account} onClick={() => setManaging(true)} data-testid="account-manage">
					<Icon name="settings" size={18} />
					Manage
				</button>
			</div>

			{!account && !wallet.loading && <p className="note">No account with this counterparty yet.</p>}
			{dispute?.phase === 'active' ? (
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
			{lanes.active.map(token => (
				<TokenSection key={token.tokenId} token={token} />
			))}
			{lanes.empty.length > 0 ? (
				<button type="button" className="btn quiet" style={{ marginBottom: 14 }} onClick={() => setShowEmpty(value => !value)}>
					{showEmpty ? 'Hide' : 'Show'} {lanes.empty.length} empty {lanes.empty.length === 1 ? 'lane' : 'lanes'} ·{' '}
					{lanes.empty.map(token => getTokenMeta(token.tokenId).symbol).join(', ')}
				</button>
			) : null}
			{showEmpty ? lanes.empty.map(token => <TokenSection key={token.tokenId} token={token} />) : null}
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
					<button type="button" className="btn" disabled={submitting || !creditText.trim()} onClick={() => void extendCredit()}>
						{submitting ? 'Extending…' : 'Extend credit'}
					</button>
				</Sheet>
			)}
			{managing && account ? <ManageSheet account={account} wallet={wallet} onClose={() => setManaging(false)} /> : null}
		</div>
	);
}
