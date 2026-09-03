import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { DeltaBar, DeltaCaption, Legend } from '../components/Bars';
import { Icon } from '../components/Icons';
import { Sheet } from '../components/Sheet';
import { TokenIcon } from '../components/TokenPicker';
import { useApp } from '../runtime/store';
import { sendEntityTxs } from '../runtime/tx';
import { formatMoney, formatSigned, getTokenMeta, parseAmount } from '../runtime/format';
import { useWallet, type AccountTokenView } from '../runtime/views';

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
			<div style={{ marginTop: 12 }}>
				<Legend />
			</div>
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
					<span className="v num st-settled">{money(d.collateral)}</span>
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
				Canonical state <Icon name={details ? 'chevronDown' : 'chevronRight'} size={13} />
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

export function AccountDetail() {
	const navigate = useNavigate();
	const { counterpartyId = '' } = useParams();
	const entityId = useApp(s => s.activeEntityId);
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const toast = useApp(s => s.toast);
	const wallet = useWallet(entityId);
	const account = wallet.accounts.find(entry => entry.counterpartyId === counterpartyId.toLowerCase()) ?? null;
	const label = account?.label ?? 'Account';

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

	return (
		<div className="screen screen-narrow fade-in">
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
						<span className="hash" style={{ display: 'block' }}>
							{counterpartyId.toLowerCase()}
						</span>
					</span>
				</span>
			</div>

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
			</div>

			{!account && !wallet.loading && <p className="note">No account with this counterparty yet.</p>}
			{account?.disputed ? (
				<p className="state st-dispute" style={{ marginBottom: 14 }}>
					Dispute in progress. Payments through this account are paused.
				</p>
			) : null}
			{account?.tokens.map(token => <TokenSection key={token.tokenId} token={token} />)}

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
		</div>
	);
}
