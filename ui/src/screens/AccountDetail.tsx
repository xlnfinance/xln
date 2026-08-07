import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { RuntimeAdapterEntitySummary } from '@xln/runtime/api/runtime-adapter/types';
import { DeltaBar, DeltaLegend } from '../components/DeltaBar';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icons';
import { useAdapterRead } from '../runtime/hooks';
import { useApp } from '../runtime/store';
import { sendEntityTxs } from '../runtime/tx';
import { formatAmount, getTokenMeta, parseAmount } from '../runtime/format';
import { useAccounts, useEntityCore, type AccountTokenView } from '../runtime/views';

function TokenAmount({ value, decimals, tone }: { value: bigint; decimals: number; tone?: 'coll' | 'debt' }) {
	const color = tone === 'coll' ? '#7fae8e' : tone === 'debt' ? 'var(--danger)' : undefined;
	return (
		<span className="num" style={{ fontSize: 13, textAlign: 'right', ...(color ? { color } : {}) }}>
			{formatAmount(value, decimals, 6)}
		</span>
	);
}

function PerspectiveRow({
	label,
	out,
	inn,
	decimals,
	tone,
}: {
	label: string;
	out: bigint;
	inn: bigint;
	decimals: number;
	tone?: 'coll' | 'debt';
}) {
	return (
		<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) 1fr 1fr', gap: 12, padding: '8px 0', borderTop: '1px solid var(--hairline)' }}>
			<span className="muted" style={{ fontSize: 12.5 }}>
				{label}
			</span>
			<TokenAmount value={out} decimals={decimals} {...(tone ? { tone } : {})} />
			<TokenAmount value={inn} decimals={decimals} {...(tone ? { tone } : {})} />
		</div>
	);
}

function TokenSection({ token }: { token: AccountTokenView }) {
	const meta = getTokenMeta(token.tokenId);
	const d = token.derived;
	return (
		<section style={{ marginBottom: 44 }}>
			<div className="section-head" style={{ marginTop: 0, marginBottom: 12 }}>
				<span>
					<span className="caps">{meta.symbol}</span>
					<span className="faint" style={{ fontSize: 11.5, marginLeft: 10 }}>
						{meta.name}
					</span>
				</span>
				<span className="display num" style={{ fontSize: 20 }}>
					{formatAmount(token.signed, meta.decimals, 2)}
				</span>
			</div>

			<DeltaBar derived={d} signed={token.signed} height={8} />
			<div style={{ marginTop: 8 }}>
				<DeltaLegend />
			</div>

			<div className="glass" style={{ padding: '14px 18px', marginTop: 16, borderRadius: 16 }}>
				<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) 1fr 1fr', gap: 12, paddingBottom: 8 }}>
					<span className="caps" style={{ fontSize: 10 }}>
						Perspective
					</span>
					<span className="caps" style={{ fontSize: 10, textAlign: 'right' }}>
						Out
					</span>
					<span className="caps" style={{ fontSize: 10, textAlign: 'right' }}>
						In
					</span>
				</div>
				<PerspectiveRow label="Capacity" out={d.outCapacity} inn={d.inCapacity} decimals={meta.decimals} />
				<PerspectiveRow label="Credit limit" out={d.ownCreditLimit} inn={d.peerCreditLimit} decimals={meta.decimals} />
				<PerspectiveRow label="Own credit component" out={d.outOwnCredit} inn={d.inOwnCredit} decimals={meta.decimals} />
				<PerspectiveRow label="Peer credit component" out={d.outPeerCredit} inn={d.inPeerCredit} decimals={meta.decimals} tone="debt" />
				<PerspectiveRow label="Collateral component" out={d.outCollateral} inn={d.inCollateral} decimals={meta.decimals} tone="coll" />
				<PerspectiveRow label="Hold deduction" out={d.outTotalHold ?? 0n} inn={d.inTotalHold ?? 0n} decimals={meta.decimals} tone="debt" />
			</div>

			<div className="glass" style={{ padding: '14px 18px', marginTop: 10, borderRadius: 16 }}>
				<span className="caps" style={{ fontSize: 10 }}>
					Canonical state
				</span>
				<div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', gap: 12 }}>
					<span className="muted" style={{ fontSize: 12.5 }}>
						delta
					</span>
					<TokenAmount value={d.delta} decimals={meta.decimals} />
				</div>
				<div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', gap: 12 }}>
					<span className="muted" style={{ fontSize: 12.5 }}>
						offdelta
					</span>
					<TokenAmount value={token.delta.offdelta} decimals={meta.decimals} />
				</div>
				<div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', gap: 12 }}>
					<span className="muted" style={{ fontSize: 12.5 }}>
						ondelta
					</span>
					<TokenAmount value={token.delta.ondelta} decimals={meta.decimals} />
				</div>
				<div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', gap: 12 }}>
					<span className="muted" style={{ fontSize: 12.5 }}>
						collateral
					</span>
					<TokenAmount value={d.collateral} decimals={meta.decimals} tone="coll" />
				</div>
			</div>
		</section>
	);
}

export function AccountDetail() {
	const navigate = useNavigate();
	const { counterpartyId = '' } = useParams();
	const entityId = useApp(s => s.activeEntityId);
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const toast = useApp(s => s.toast);
	const core = useEntityCore(entityId);
	const { accounts } = useAccounts(entityId);
	const entities = useAdapterRead<RuntimeAdapterEntitySummary[]>('entities');

	const account = accounts.find(a => a.counterpartyId === counterpartyId.toLowerCase()) ?? null;
	const label = useMemo(() => {
		const summary = (entities.data ?? []).find(s => s.entityId?.toLowerCase() === counterpartyId.toLowerCase());
		return summary?.label || 'Account';
	}, [entities.data, counterpartyId]);

	const [extending, setExtending] = useState(false);
	const [creditText, setCreditText] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const meta = getTokenMeta(selectedTokenId);

	const extendCredit = async (): Promise<void> => {
		if (!entityId || !core.data?.signerId) return;
		setSubmitting(true);
		try {
			const amount = parseAmount(creditText, meta.decimals);
			if (amount <= 0n) throw new Error('Enter a positive amount');
			await sendEntityTxs(entityId, core.data.signerId, [
				{ type: 'extendCredit', data: { counterpartyEntityId: counterpartyId.toLowerCase(), tokenId: selectedTokenId, amount } },
			]);
			toast(`Extended ${formatAmount(amount, meta.decimals, 2)} ${meta.symbol} of credit to ${label}`);
			setExtending(false);
			setCreditText('');
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="screen fade-in" style={{ maxWidth: 760 }}>
			<div className="screen-header" style={{ marginBottom: 10 }}>
				<span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
					<button type="button" className="btn btn-quiet" onClick={() => navigate(-1)} aria-label="Back">
						<Icon name="chevronLeft" size={16} strokeWidth={1.6} />
					</button>
					<span className="screen-title">{label}</span>
				</span>
				<span style={{ display: 'flex', gap: 10 }}>
					<button type="button" className="btn btn-primary" onClick={() => navigate(`/pay?to=${counterpartyId.toLowerCase()}`)}>
						<Icon name="pay" size={15} /> Pay
					</button>
					<button type="button" className="btn btn-ghost" onClick={() => setExtending(true)}>
						Extend credit
					</button>
				</span>
			</div>
			<p className="hash" style={{ marginBottom: 30 }}>
				{counterpartyId.toLowerCase()}
			</p>

			{!account && <p className="muted">No account with this counterparty yet.</p>}

			{account?.tokens.map(token => (
				<TokenSection key={token.tokenId} token={token} />
			))}

			{extending && (
				<Sheet title="Extend credit" onClose={() => setExtending(false)}>
					<p className="muted" style={{ fontSize: 13 }}>
						You allow {label} to owe you up to this amount in {meta.symbol}. It widens their spendable capacity toward
						you — and what they can route through you.
					</p>
					<div className="field">
						<span className="field-label">Credit line</span>
						<div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
							<input
								className="input"
								placeholder="0.00"
								inputMode="decimal"
								value={creditText}
								onChange={e => setCreditText(e.target.value)}
								autoFocus
							/>
							<span className="muted">{meta.symbol}</span>
						</div>
					</div>
					<button type="button" className="btn btn-primary btn-block" disabled={submitting} onClick={() => void extendCredit()}>
						{submitting ? 'Extending…' : 'Extend credit'}
					</button>
				</Sheet>
			)}
		</div>
	);
}
