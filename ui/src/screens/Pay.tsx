import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { RuntimeAdapterEntitySummary, RuntimeAdapterPaymentRoutesResponse } from '@xln/runtime/api/runtime-adapter/types';
import { Icon } from '../components/Icons';
import { useAdapterRead } from '../runtime/hooks';
import { useApp } from '../runtime/store';
import { getAdapter } from '../runtime/adapter';
import { sendEntityTxs } from '../runtime/tx';
import { formatAmount, getTokenMeta, parseAmount, shortId } from '../runtime/format';
import { useAccounts, useEntityCore } from '../runtime/views';

type RouteChoice = {
	path: string[];
	totalFee: bigint;
	senderAmount: bigint;
	recipientAmount: bigint;
};

type AccountsPageLite = { items: Array<{ state: { leftEntity: string; rightEntity: string } }> };

function accountCounterparties(page: AccountsPageLite | null, self: string): string[] {
	if (!page?.items) return [];
	const out: string[] = [];
	for (const doc of page.items) {
		const left = String(doc.state?.leftEntity || '').toLowerCase();
		const right = String(doc.state?.rightEntity || '').toLowerCase();
		const other = left === self ? right : left;
		if (other) out.push(other);
	}
	return out;
}

async function resolveRoutes(source: string, target: string, tokenId: number, amount: bigint): Promise<RouteChoice[]> {
	const adapter = getAdapter();
	if (!adapter) throw new Error('Runtime is not connected');

	try {
		const response = await adapter.read<RuntimeAdapterPaymentRoutesResponse>('payment-routes', {
			sourceEntityId: source,
			targetEntityId: target,
			tokenId,
			amount: amount.toString(),
		});
		if (response.routes.length > 0) {
			return response.routes.map(route => ({
				path: route.path.map(id => id.toLowerCase()),
				totalFee: BigInt(route.totalFee),
				senderAmount: BigInt(route.senderAmount),
				recipientAmount: BigInt(route.recipientAmount),
			}));
		}
	} catch {
		// Graph may be empty (fresh embedded runtime). Fall back to committed topology.
	}

	const mine = await adapter.read<AccountsPageLite>(`entity/${source}/accounts`);
	const direct = accountCounterparties(mine, source);
	if (direct.includes(target)) {
		return [{ path: [source, target], totalFee: 0n, senderAmount: amount, recipientAmount: amount }];
	}
	const routes: RouteChoice[] = [];
	for (const via of direct) {
		try {
			const theirs = await adapter.read<AccountsPageLite>(`entity/${via}/accounts`);
			if (accountCounterparties(theirs, via).includes(target)) {
				routes.push({ path: [source, via, target], totalFee: 0n, senderAmount: amount, recipientAmount: amount });
			}
		} catch {
			// Counterparty state may be unreadable (remote scope) — skip this hop.
		}
	}
	if (routes.length === 0) throw new Error('No route to this recipient');
	return routes;
}

export function Pay() {
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const entityId = useApp(s => s.activeEntityId);
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const toast = useApp(s => s.toast);

	const core = useEntityCore(entityId);
	const { accounts } = useAccounts(entityId);
	const entities = useAdapterRead<RuntimeAdapterEntitySummary[]>('entities');

	const [target, setTarget] = useState(params.get('to')?.toLowerCase() ?? '');
	const [amountText, setAmountText] = useState(params.get('amount') ?? '');
	const [tokenId, setTokenId] = useState(Number(params.get('token') ?? selectedTokenId) || selectedTokenId);
	const [description, setDescription] = useState(params.get('desc') ?? '');
	const [routes, setRoutes] = useState<RouteChoice[] | null>(null);
	const [routeIndex, setRouteIndex] = useState(0);
	const [routeError, setRouteError] = useState<string | null>(null);
	const [quoting, setQuoting] = useState(false);
	const [sending, setSending] = useState(false);
	const quoteSeq = useRef(0);

	const meta = getTokenMeta(tokenId);
	const self = (entityId ?? '').toLowerCase();

	const recipients = useMemo(() => {
		const list: Array<{ entityId: string; label: string }> = [];
		const seen = new Set<string>();
		for (const summary of entities.data ?? []) {
			const id = summary.entityId?.toLowerCase();
			if (!id || id === self || seen.has(id)) continue;
			seen.add(id);
			list.push({ entityId: id, label: summary.label || shortId(id) });
		}
		return list;
	}, [entities.data, self]);

	const parsedAmount = useMemo(() => {
		try {
			const value = parseAmount(amountText || '0', meta.decimals);
			return value > 0n ? value : null;
		} catch {
			return null;
		}
	}, [amountText, meta.decimals]);

	const validTarget = /^0x[0-9a-f]{64}$/.test(target);

	useEffect(() => {
		setRoutes(null);
		setRouteError(null);
		setRouteIndex(0);
		if (!self || !validTarget || !parsedAmount) return;
		const seq = ++quoteSeq.current;
		setQuoting(true);
		const timer = setTimeout(() => {
			resolveRoutes(self, target, tokenId, parsedAmount)
				.then(found => {
					if (seq !== quoteSeq.current) return;
					setRoutes(found);
					setQuoting(false);
				})
				.catch((error: unknown) => {
					if (seq !== quoteSeq.current) return;
					setRouteError(error instanceof Error ? error.message : String(error));
					setQuoting(false);
				});
		}, 250);
		return () => clearTimeout(timer);
	}, [self, target, validTarget, parsedAmount, tokenId]);

	const chosen = routes?.[routeIndex] ?? null;
	const spendable = accounts
		.flatMap(a => a.tokens)
		.filter(t => t.tokenId === tokenId)
		.reduce((sum, t) => sum + t.derived.outCapacity, 0n);

	const send = async (): Promise<void> => {
		if (!entityId || !core.data?.signerId || !chosen || !parsedAmount) return;
		setSending(true);
		try {
			const isDirect = chosen.path.length === 2;
			await sendEntityTxs(entityId, core.data.signerId, [
				isDirect
					? {
							type: 'directPayment',
							data: {
								targetEntityId: target,
								tokenId,
								amount: chosen.recipientAmount,
								route: chosen.path,
								deliveryMode: 'direct',
								...(description.trim() ? { description: description.trim() } : {}),
							},
						}
					: {
							type: 'htlcPayment',
							data: {
								targetEntityId: target,
								tokenId,
								amount: chosen.recipientAmount,
								route: chosen.path,
								deliveryMode: 'instant',
								...(description.trim() ? { description: description.trim() } : {}),
							},
						},
			]);
			toast(`Paid ${formatAmount(chosen.recipientAmount, meta.decimals, 2)} ${meta.symbol}`);
			navigate('/');
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setSending(false);
		}
	};

	return (
		<div className="screen screen-narrow fade-in">
			<div className="screen-header">
				<span className="screen-title">Pay</span>
				<span className="faint" style={{ fontSize: 12 }}>
					{formatAmount(spendable, meta.decimals, 2)} {meta.symbol} spendable
				</span>
			</div>

			<div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
				<div className="field">
					<span className="field-label">To</span>
					<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
						{recipients.map(recipient => (
							<button
								key={recipient.entityId}
								type="button"
								className="row row-tappable"
								style={{ padding: '12px 0', borderColor: target === recipient.entityId ? 'var(--hairline-2)' : undefined }}
								onClick={() => setTarget(recipient.entityId)}
							>
								<span style={{ fontSize: 13.5 }}>
									{target === recipient.entityId ? <span className="dot" style={{ display: 'inline-block', marginRight: 10 }} /> : null}
									{recipient.label}
								</span>
								<span className="mono">{shortId(recipient.entityId)}</span>
							</button>
						))}
						<input
							className="input mono"
							placeholder="or paste an entity id — 0x…"
							value={target}
							onChange={e => setTarget(e.target.value.trim().toLowerCase())}
							spellCheck={false}
						/>
					</div>
				</div>

				<div className="field">
					<span className="field-label">Amount</span>
					<div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
						<input
							className="input display"
							style={{ fontSize: 30, fontWeight: 300, padding: '10px 16px' }}
							placeholder="0.00"
							inputMode="decimal"
							value={amountText}
							onChange={e => setAmountText(e.target.value)}
						/>
						<span className="muted" style={{ fontSize: 14 }}>
							{meta.symbol}
						</span>
					</div>
				</div>

				<div className="field">
					<span className="field-label">Note · optional</span>
					<input className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="Dinner, invoice 42…" />
				</div>

				{quoting && (
					<p className="faint" style={{ fontSize: 12 }}>
						Quoting route…
					</p>
				)}
				{routeError && validTarget && parsedAmount && (
					<p style={{ color: 'var(--danger)', fontSize: 13 }}>{routeError}</p>
				)}
				{routes && routes.length > 0 && (
					<div className="field">
						<span className="field-label">Route</span>
						{routes.map((route, index) => (
							<button
								key={route.path.join('>')}
								type="button"
								className="row row-tappable"
								style={{ padding: '12px 0', borderColor: index === routeIndex ? 'var(--hairline-2)' : undefined }}
								onClick={() => setRouteIndex(index)}
							>
								<span style={{ fontSize: 13 }}>
									{index === routeIndex ? <span className="dot" style={{ display: 'inline-block', marginRight: 10 }} /> : null}
									{route.path.length === 2 ? 'Direct' : `Via ${route.path.length - 2} hop${route.path.length > 3 ? 's' : ''}`}
								</span>
								<span className="faint" style={{ fontSize: 12 }}>
									fee {formatAmount(route.totalFee, meta.decimals, 2)} {meta.symbol}
								</span>
							</button>
						))}
					</div>
				)}

				<button
					type="button"
					className="btn btn-primary btn-lg btn-block"
					disabled={!chosen || !parsedAmount || sending || !core.data?.signerId}
					onClick={() => void send()}
				>
					<Icon name="pay" size={15} />
					{sending
						? 'Sending…'
						: chosen && parsedAmount
							? `Pay ${formatAmount(chosen.senderAmount, meta.decimals, 2)} ${meta.symbol}`
							: 'Pay'}
				</button>
			</div>
		</div>
	);
}
