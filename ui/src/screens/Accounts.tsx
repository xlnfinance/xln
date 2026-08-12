import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RuntimeAdapterEntitySummary } from '@xln/runtime/api/runtime-adapter/types';
import { DeltaBar } from '../components/DeltaBar';
import { Sheet } from '../components/Sheet';
import { useAdapterRead } from '../runtime/hooks';
import { useApp } from '../runtime/store';
import { DEFAULT_ACCOUNT_DISPUTE_CONFIG, sendEntityTxs } from '../runtime/tx';
import { formatAmount, getTokenMeta, parseAmount } from '../runtime/format';
import { useAccounts, useEntityCore } from '../runtime/views';

export function Accounts() {
	const navigate = useNavigate();
	const entityId = useApp(s => s.activeEntityId);
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const toast = useApp(s => s.toast);
	const core = useEntityCore(entityId);
	const { accounts, loading } = useAccounts(entityId);
	const entities = useAdapterRead<RuntimeAdapterEntitySummary[]>('entities');

	const [opening, setOpening] = useState(false);
	const [targetId, setTargetId] = useState('');
	const [creditText, setCreditText] = useState('');
	const [submitting, setSubmitting] = useState(false);

	const meta = getTokenMeta(selectedTokenId);
	const self = (entityId ?? '').toLowerCase();
	const existing = new Set(accounts.map(a => a.counterpartyId));

	const names = useMemo(() => {
		const map = new Map<string, string>();
		for (const summary of entities.data ?? []) {
			if (summary.entityId) map.set(summary.entityId.toLowerCase(), summary.label || '');
		}
		return map;
	}, [entities.data]);

	const candidates = useMemo(
		() =>
			(entities.data ?? [])
				.map(summary => summary.entityId?.toLowerCase() ?? '')
				.filter(id => id && id !== self && !existing.has(id)),
		[entities.data, self, existing],
	);

	const openAccount = async (): Promise<void> => {
		if (!entityId || !core.data?.signerId || !targetId) return;
		setSubmitting(true);
		try {
			const creditAmount = creditText.trim() ? parseAmount(creditText, meta.decimals) : 0n;
			await sendEntityTxs(entityId, core.data.signerId, [
				{
					type: 'openAccount',
					data: { targetEntityId: targetId, creditAmount, tokenId: selectedTokenId, disputeConfig: DEFAULT_ACCOUNT_DISPUTE_CONFIG },
				},
			]);
			toast('Account opening proposed');
			setOpening(false);
			setTargetId('');
			setCreditText('');
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="screen fade-in" style={{ maxWidth: 760 }}>
			<div className="screen-header">
				<span className="screen-title">Accounts</span>
				<button type="button" className="btn btn-ghost" onClick={() => setOpening(true)}>
					Open account
				</button>
			</div>

			<div>
				{accounts.map(account => {
					const token = account.tokens.find(t => t.tokenId === selectedTokenId) ?? account.tokens[0];
					const tokenMeta = getTokenMeta(token?.tokenId ?? selectedTokenId);
					return (
						<button
							key={account.counterpartyId}
							type="button"
							className="row row-tappable"
							style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}
							onClick={() => navigate(`/accounts/${account.counterpartyId}`)}
						>
							<span style={{ flex: '1 1 100%', display: 'flex', justifyContent: 'space-between', gap: 16 }}>
								<span style={{ fontSize: 14 }}>{names.get(account.counterpartyId) || 'Account'}</span>
								<span className="display num" style={{ fontSize: 16 }}>
									{token ? formatAmount(token.signed, tokenMeta.decimals, 2) : '0'}{' '}
									<span className="faint" style={{ fontSize: 11, fontFamily: 'var(--font-ui)' }}>{tokenMeta.symbol}</span>
								</span>
							</span>
							<span className="hash" style={{ flex: '1 1 100%', marginTop: 2 }}>
								{account.counterpartyId}
							</span>
							<span style={{ flex: '1 1 100%', marginTop: 10 }}>
								{token ? (
									<>
										<DeltaBar derived={token.derived} height={6} />
										<span className="faint" style={{ display: 'block', fontSize: 11, marginTop: 6 }}>
											{formatAmount(token.derived.outCapacity, tokenMeta.decimals, 2)} spendable ·{' '}
											{formatAmount(token.derived.inCapacity, tokenMeta.decimals, 2)} receivable · {tokenMeta.symbol}
										</span>
									</>
								) : (
									<span className="faint" style={{ fontSize: 11 }}>
										No tokens yet
									</span>
								)}
							</span>
						</button>
					);
				})}
				{accounts.length === 0 && !loading && (
					<p className="muted" style={{ padding: '18px 0', fontSize: 13 }}>
						No bilateral accounts yet — open one to start paying.
					</p>
				)}
			</div>

			{opening && (
				<Sheet title="Open account" onClose={() => setOpening(false)}>
					<div className="field">
						<span className="field-label">Counterparty</span>
						{candidates.map(id => (
							<button
								key={id}
								type="button"
								className="row row-tappable"
								style={{ padding: '12px 0', flexWrap: 'wrap', borderColor: targetId === id ? 'var(--hairline-2)' : undefined }}
								onClick={() => setTargetId(id)}
							>
								<span style={{ fontSize: 13.5, flex: '1 1 100%' }}>
									{targetId === id ? <span className="dot" style={{ display: 'inline-block', marginRight: 10 }} /> : null}
									{names.get(id) || 'Entity'}
								</span>
								<span className="hash" style={{ flex: '1 1 100%', marginTop: 2 }}>
									{id}
								</span>
							</button>
						))}
						<input
							className="input mono"
							placeholder="or paste an entity id — 0x…"
							value={targetId}
							onChange={e => setTargetId(e.target.value.trim().toLowerCase())}
							spellCheck={false}
						/>
					</div>
					<div className="field">
						<span className="field-label">Requested credit line · optional</span>
						<div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
							<input
								className="input"
								placeholder="0.00"
								inputMode="decimal"
								value={creditText}
								onChange={e => setCreditText(e.target.value)}
							/>
							<span className="muted">{meta.symbol}</span>
						</div>
					</div>
					<button
						type="button"
						className="btn btn-primary btn-block"
						disabled={!/^0x[0-9a-f]{64}$/.test(targetId) || submitting}
						onClick={() => void openAccount()}
					>
						{submitting ? 'Proposing…' : 'Propose account'}
					</button>
				</Sheet>
			)}
		</div>
	);
}
