import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type {
	RuntimeAdapterEntitySummary,
	RuntimeAdapterPaymentRoutesResponse,
} from '@xln/runtime/api/runtime-adapter/types';
import { Icon } from '../components/Icons';
import { useAdapterRead } from '../runtime/hooks';
import { useApp } from '../runtime/store';
import { getAdapter } from '../runtime/adapter';
import { sendEntityTxs } from '../runtime/tx';
import { formatAmount, getTokenMeta, knownTokenIds, parseAmount } from '../runtime/format';
import { useAccounts, useEntityCore } from '../runtime/views';

type DeliveryMode = 'instant' | 'async' | 'direct' | 'trusted';

const DELIVERY_MODES: Array<{
	value: DeliveryMode;
	label: string;
	description: string;
	recommended?: boolean;
}> = [
	{ value: 'instant', label: 'Instant', description: 'Atomic · recipient online', recommended: true },
	{ value: 'async', label: 'Async', description: 'Atomic · recipient may be offline' },
	{ value: 'direct', label: 'Direct', description: 'One hop · shared account' },
	{ value: 'trusted', label: 'Trusted', description: 'Trusts the selected hub' },
];

type RouteChoice = {
	path: string[];
	hops: Array<{ from: string; to: string; fee: bigint }>;
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
				hops: route.hops.map(hop => ({
					from: hop.from.toLowerCase(),
					to: hop.to.toLowerCase(),
					fee: BigInt(hop.fee),
				})),
				totalFee: BigInt(route.totalFee),
				senderAmount: BigInt(route.senderAmount),
				recipientAmount: BigInt(route.recipientAmount),
			}));
		}
	} catch {
		// Empty gossip graph on a fresh embedded runtime — fall back to the
		// committed account topology below.
	}

	const mine = await adapter.read<AccountsPageLite>(`entity/${source}/accounts`);
	const direct = accountCounterparties(mine, source);
	const routes: RouteChoice[] = [];
	if (direct.includes(target)) {
		routes.push({
			path: [source, target],
			hops: [{ from: source, to: target, fee: 0n }],
			totalFee: 0n,
			senderAmount: amount,
			recipientAmount: amount,
		});
	}
	for (const via of direct) {
		if (via === target) continue;
		try {
			const theirs = await adapter.read<AccountsPageLite>(`entity/${via}/accounts`);
			if (accountCounterparties(theirs, via).includes(target)) {
				routes.push({
					path: [source, via, target],
					hops: [
						{ from: source, to: via, fee: 0n },
						{ from: via, to: target, fee: 0n },
					],
					totalFee: 0n,
					senderAmount: amount,
					recipientAmount: amount,
				});
			}
		} catch {
			// Counterparty state unreadable in this scope — skip the hop.
		}
	}
	if (routes.length === 0) throw new Error('No route to this recipient');
	return routes;
}

function rawAmountText(value: bigint, decimals: number): string {
	const base = 10n ** BigInt(decimals);
	const whole = value / base;
	const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
	return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function Pay() {
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const entityId = useApp(s => s.activeEntityId);
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const setSelectedTokenId = useApp(s => s.setSelectedTokenId);
	const toast = useApp(s => s.toast);

	const core = useEntityCore(entityId);
	const { accounts } = useAccounts(entityId);
	const entities = useAdapterRead<RuntimeAdapterEntitySummary[]>('entities');

	const [toText, setToText] = useState(params.get('to')?.toLowerCase() ?? '');
	const [toFocused, setToFocused] = useState(false);
	const [amountText, setAmountText] = useState(params.get('amount') ?? '');
	const [tokenId, setTokenId] = useState(Number(params.get('token') ?? selectedTokenId) || selectedTokenId);
	const [tokenOpen, setTokenOpen] = useState(false);
	const [advancedOpen, setAdvancedOpen] = useState(Boolean(params.get('desc')));
	const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>('instant');
	const [description, setDescription] = useState(params.get('desc') ?? '');
	const [routes, setRoutes] = useState<RouteChoice[] | null>(null);
	const [routeIndex, setRouteIndex] = useState(0);
	const [routeError, setRouteError] = useState<string | null>(null);
	const [quoting, setQuoting] = useState(false);
	const [sending, setSending] = useState(false);
	const quoteSeq = useRef(0);

	const meta = getTokenMeta(tokenId);
	const self = (entityId ?? '').toLowerCase();

	const known = useMemo(
		() =>
			(entities.data ?? [])
				.map(summary => ({
					entityId: summary.entityId?.toLowerCase() ?? '',
					label: summary.label || '',
				}))
				.filter(entry => entry.entityId && entry.entityId !== self),
		[entities.data, self],
	);

	const nameOf = (id: string): string =>
		known.find(entry => entry.entityId === id.toLowerCase())?.label || `${id.slice(0, 10)}…`;

	// One combobox: free text resolves either to a pasted 32-byte id or to a
	// known contact by name; suggestions filter live under the same input.
	const query = toText.trim().toLowerCase();
	const target = useMemo(() => {
		if (/^0x[0-9a-f]{64}$/.test(query)) return query;
		const byName = known.find(entry => entry.label.toLowerCase() === query);
		return byName?.entityId ?? '';
	}, [query, known]);
	const validTarget = Boolean(target);

	const suggestions = useMemo(() => {
		if (validTarget && known.some(entry => entry.entityId === target && entry.label.toLowerCase() === query)) return [];
		if (!query) return known;
		return known.filter(
			entry => entry.label.toLowerCase().includes(query) || entry.entityId.includes(query),
		);
	}, [known, query, target, validTarget]);

	const parsedAmount = useMemo(() => {
		try {
			const value = parseAmount(amountText || '0', meta.decimals);
			return value > 0n ? value : null;
		} catch {
			return null;
		}
	}, [amountText, meta.decimals]);

	const spendable = accounts
		.flatMap(a => a.tokens)
		.filter(t => t.tokenId === tokenId)
		.reduce((sum, t) => sum + t.derived.outCapacity, 0n);

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
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [self, target, validTarget, parsedAmount, tokenId]);

	const chosen = routes?.[routeIndex] ?? null;

	const modeError = useMemo(() => {
		if (!chosen) return null;
		if (deliveryMode === 'direct' && chosen.path.length !== 2) {
			return 'Direct delivery requires a bilateral route.';
		}
		if (deliveryMode === 'trusted' && (chosen.path.length !== 3 || chosen.totalFee !== 0n)) {
			return 'Trusted delivery requires one fee-free gateway.';
		}
		return null;
	}, [chosen, deliveryMode]);

	const send = async (): Promise<void> => {
		if (!entityId || !core.data?.signerId || !chosen || !parsedAmount || modeError) return;
		setSending(true);
		try {
			const usesDirectPayment = deliveryMode === 'direct' || deliveryMode === 'trusted';
			await sendEntityTxs(entityId, core.data.signerId, [
				usesDirectPayment
					? {
							type: 'directPayment',
							data: {
								targetEntityId: target,
								tokenId,
								amount: chosen.recipientAmount,
								route: chosen.path,
								deliveryMode,
								...(deliveryMode === 'trusted' ? { trustedGatewayEntityId: chosen.path[1]! } : {}),
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
								deliveryMode,
								...(description.trim() ? { description: description.trim() } : {}),
							},
						},
			]);
			toast(`Paid ${formatAmount(chosen.recipientAmount, meta.decimals, 2)} ${meta.symbol} to ${nameOf(target)}`);
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
			</div>

			<div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
				<div className="field">
					<span className="field-label">To</span>
					<div className="picker">
						<input
							className="input"
							style={{ fontFamily: query.startsWith('0x') ? 'var(--font-mono)' : 'var(--font-ui)' }}
							placeholder="Name or entity id — 0x…"
							value={toText}
							spellCheck={false}
							onChange={e => setToText(e.target.value)}
							onFocus={() => setToFocused(true)}
							onBlur={() => setToFocused(false)}
						/>
						{toFocused && suggestions.length > 0 && (
							<div className="picker-menu glass">
								{suggestions.map(entry => (
									<button
										key={entry.entityId}
										type="button"
										className="picker-option"
										onMouseDown={e => {
											e.preventDefault();
											setToText(entry.label || entry.entityId);
											setToFocused(false);
										}}
									>
										<span style={{ fontSize: 13.5 }}>{entry.label || 'Entity'}</span>
										<span className="hash">{entry.entityId}</span>
									</button>
								))}
							</div>
						)}
					</div>
					{validTarget && (
						<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
							<span className="dot" />
							<span className="hash">{target}</span>
						</span>
					)}
				</div>

				<div className="field">
					<span className="field-label">Amount</span>
					<div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
						<input
							className="input display"
							style={{ fontSize: 32, fontWeight: 300, padding: '10px 16px', minWidth: 0 }}
							placeholder="0"
							inputMode="decimal"
							value={amountText}
							onChange={e => setAmountText(e.target.value)}
						/>
						<div className="picker" style={{ flex: 'none' }}>
							<button
								type="button"
								className="picker-control"
								style={{ height: '100%', minWidth: 120 }}
								onClick={() => setTokenOpen(open => !open)}
							>
								{meta.symbol}
								<Icon name="chevronDown" size={14} />
							</button>
							{tokenOpen && (
								<div className="picker-menu glass" style={{ minWidth: 220, right: 0, left: 'auto' }}>
									{knownTokenIds().map(id => {
										const tokenMeta = getTokenMeta(id);
										return (
											<button
												key={id}
												type="button"
												className="picker-option"
												onClick={() => {
													setTokenId(id);
													setSelectedTokenId(id);
													setTokenOpen(false);
												}}
											>
												<span style={{ fontSize: 13.5 }}>
													{tokenMeta.symbol}
													{id === tokenId ? ' ·' : ''}
												</span>
												<span className="faint" style={{ fontSize: 11.5 }}>
													{tokenMeta.name}
												</span>
											</button>
										);
									})}
								</div>
							)}
						</div>
					</div>
					<button
						type="button"
						className="btn-quiet btn"
						style={{ alignSelf: 'flex-start', padding: '2px 0', fontSize: 12 }}
						disabled={spendable <= 0n}
						onClick={() => setAmountText(rawAmountText(spendable, meta.decimals))}
					>
						{formatAmount(spendable, meta.decimals, 2)} {meta.symbol} available
					</button>
				</div>

				{quoting && (
					<p className="faint" style={{ fontSize: 12 }}>
						Quoting routes…
					</p>
				)}
				{routeError && validTarget && parsedAmount && (
					<p style={{ color: 'var(--danger)', fontSize: 13 }}>{routeError}</p>
				)}

				{routes && routes.length > 0 && (
					<div className="field">
						<span className="field-label">
							{routes.length} route{routes.length === 1 ? '' : 's'}
						</span>
						{routes.map((route, index) => (
							<button
								key={route.path.join('>')}
								type="button"
								className={`route-card${index === routeIndex ? ' active' : ''}`}
								onClick={() => setRouteIndex(index)}
							>
								<span className="route-hops">
									{route.path.map((hopId, hopIndex) => (
										<span key={`${hopId}-${hopIndex}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
											<span className="hop-chip">{hopId === self ? 'You' : nameOf(hopId)}</span>
											{hopIndex < route.path.length - 1 && (
												<span className="faint" aria-hidden>
													→
												</span>
											)}
										</span>
									))}
								</span>
								<span className="route-meta">
									<span>
										Fee {formatAmount(route.totalFee, meta.decimals, 6)} {meta.symbol}
									</span>
									<span>
										You send {formatAmount(route.senderAmount, meta.decimals, 2)} · they receive{' '}
										{formatAmount(route.recipientAmount, meta.decimals, 2)}
									</span>
								</span>
								{route.hops.some(hop => hop.fee > 0n) && (
									<span className="route-hop-fees">
										{route.hops.map((hop, hopIndex) => (
											<span key={hopIndex} className="faint">
												{hop.from === self ? 'You' : nameOf(hop.from)} → {hop.to === self ? 'You' : nameOf(hop.to)}:{' '}
												{formatAmount(hop.fee, meta.decimals, 6)}
											</span>
										))}
									</span>
								)}
							</button>
						))}
					</div>
				)}

				<div>
					<button
						type="button"
						className="btn btn-quiet"
						style={{ padding: '2px 0', fontSize: 12.5 }}
						onClick={() => setAdvancedOpen(open => !open)}
					>
						Advanced
						<Icon name={advancedOpen ? 'chevronDown' : 'chevronRight'} size={13} />
					</button>
					{advancedOpen && (
						<div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: 14 }} className="fade-in">
							<div className="field">
								<span className="field-label">Delivery</span>
								<div className="mode-grid" role="radiogroup" aria-label="Payment delivery mode">
									{DELIVERY_MODES.map(mode => (
										<button
											key={mode.value}
											type="button"
											role="radio"
											aria-checked={deliveryMode === mode.value}
											className={`mode-card${deliveryMode === mode.value ? ' active' : ''}`}
											onClick={() => setDeliveryMode(mode.value)}
										>
											<span className="mode-card-name">
												<span className="mode-radio" aria-hidden />
												{mode.label}
												{mode.recommended && <span className="mode-default">Default</span>}
											</span>
											<span className="mode-card-desc">{mode.description}</span>
										</button>
									))}
								</div>
							</div>
							<div className="field">
								<span className="field-label">Note</span>
								<input
									className="input"
									value={description}
									onChange={e => setDescription(e.target.value)}
									placeholder="What's this for?"
								/>
							</div>
						</div>
					)}
					{modeError && (
						<p style={{ color: 'var(--danger)', fontSize: 12.5, marginTop: 10 }}>{modeError}</p>
					)}
				</div>

				<button
					type="button"
					className="btn btn-primary btn-lg btn-block"
					disabled={!chosen || !parsedAmount || sending || Boolean(modeError) || !core.data?.signerId}
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
