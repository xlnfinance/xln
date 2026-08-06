import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { RuntimeAdapterEntitySummary } from '@xln/runtime/api/runtime-adapter/types';
import { CapacityBar } from '../components/CapacityBar';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icons';
import { useAdapterRead } from '../runtime/hooks';
import { useApp } from '../runtime/store';
import { sendEntityTxs } from '../runtime/tx';
import { formatAmount, getTokenMeta, parseAmount, shortId } from '../runtime/format';
import { useAccounts, useEntityCore } from '../runtime/views';

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
		return summary?.label || shortId(counterpartyId);
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
		<div className="screen fade-in" style={{ maxWidth: 720 }}>
			<div className="screen-header">
				<span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
					<button type="button" className="btn btn-quiet" onClick={() => navigate(-1)} aria-label="Back">
						<Icon name="chevronRight" size={16} strokeWidth={1.6} />
					</button>
					<span className="screen-title">{label}</span>
				</span>
				<span className="mono">{shortId(counterpartyId, 8, 6)}</span>
			</div>

			{!account && <p className="muted">No account with this counterparty yet.</p>}

			{account?.tokens.map(token => {
				const tokenMeta = getTokenMeta(token.tokenId);
				const d = token.derived;
				return (
					<div key={token.tokenId} style={{ marginBottom: 36 }}>
						<div className="section-head" style={{ marginTop: 0 }}>
							<span className="caps">{tokenMeta.symbol}</span>
							<span className="display num" style={{ fontSize: 18 }}>
								{formatAmount(token.signed, tokenMeta.decimals, 2)}
							</span>
						</div>
						<CapacityBar collateral={d.collateral} creditUsed={d.outOwnCredit} free={d.outCapacity} height={3} />
						<div style={{ marginTop: 14 }}>
							<div className="row" style={{ padding: '11px 0' }}>
								<span className="muted" style={{ fontSize: 13 }}>
									Spendable
								</span>
								<span className="num" style={{ fontSize: 13 }}>
									{formatAmount(d.outCapacity, tokenMeta.decimals, 2)} {tokenMeta.symbol}
								</span>
							</div>
							<div className="row" style={{ padding: '11px 0' }}>
								<span className="muted" style={{ fontSize: 13 }}>
									Receivable
								</span>
								<span className="num" style={{ fontSize: 13 }}>
									{formatAmount(d.inCapacity, tokenMeta.decimals, 2)} {tokenMeta.symbol}
								</span>
							</div>
							<div className="row" style={{ padding: '11px 0' }}>
								<span className="muted" style={{ fontSize: 13 }}>
									Collateral
								</span>
								<span className="num" style={{ fontSize: 13 }}>
									{formatAmount(d.collateral, tokenMeta.decimals, 2)} {tokenMeta.symbol}
								</span>
							</div>
							<div className="row" style={{ padding: '11px 0' }}>
								<span className="muted" style={{ fontSize: 13 }}>
									Credit they extended to you
								</span>
								<span className="num" style={{ fontSize: 13 }}>
									{formatAmount(d.ownCreditLimit, tokenMeta.decimals, 2)} {tokenMeta.symbol}
								</span>
							</div>
							<div className="row" style={{ padding: '11px 0' }}>
								<span className="muted" style={{ fontSize: 13 }}>
									Credit you extended to them
								</span>
								<span className="num" style={{ fontSize: 13 }}>
									{formatAmount(d.peerCreditLimit, tokenMeta.decimals, 2)} {tokenMeta.symbol}
								</span>
							</div>
						</div>
					</div>
				);
			})}

			{account && (
				<div style={{ display: 'flex', gap: 10 }}>
					<button
						type="button"
						className="btn btn-primary"
						onClick={() => navigate(`/pay?to=${counterpartyId.toLowerCase()}`)}
					>
						<Icon name="pay" size={15} /> Pay
					</button>
					<button type="button" className="btn btn-ghost" onClick={() => setExtending(true)}>
						Extend credit
					</button>
				</div>
			)}

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
