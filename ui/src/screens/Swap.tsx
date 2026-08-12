import { useMemo, useState } from 'react';
import type { RuntimeAdapterEntitySummary } from '@xln/runtime/api/runtime-adapter/types';
import { Icon } from '../components/Icons';
import { peekXLN } from '../runtime/xln-loader';
import { useAdapterRead } from '../runtime/hooks';
import { useApp } from '../runtime/store';
import { sendEntityTxs } from '../runtime/tx';
import { formatAmount, getTokenMeta, knownTokenIds, parseAmount } from '../runtime/format';
import { useAccounts, useEntityCore, useOpenSwapOffers, type AccountView } from '../runtime/views';

type TifOption = { value: 0 | 1 | 2; label: string; description: string };

const TIF_OPTIONS: TifOption[] = [
	{ value: 0, label: 'Good til canceled', description: 'Rests on the book until filled or canceled' },
	{ value: 1, label: 'Immediate or cancel', description: 'Fills what it can now, cancels the rest' },
	{ value: 2, label: 'Fill or kill', description: 'Fills completely now, or not at all' },
];

function rawAmountText(value: bigint, decimals: number): string {
	const base = 10n ** BigInt(decimals);
	const whole = value / base;
	const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
	return fraction ? `${whole}.${fraction}` : whole.toString();
}

function TokenPicker({
	tokenId,
	onChange,
	open,
	setOpen,
	exclude,
}: {
	tokenId: number;
	onChange: (id: number) => void;
	open: boolean;
	setOpen: (open: boolean) => void;
	exclude?: number;
}) {
	const meta = getTokenMeta(tokenId);
	return (
		<div className="picker" style={{ flex: 'none' }}>
			<button type="button" className="picker-control" style={{ height: '100%', minWidth: 120 }} onClick={() => setOpen(!open)}>
				{meta.symbol}
				<Icon name="chevronDown" size={14} />
			</button>
			{open && (
				<div className="picker-menu glass" style={{ minWidth: 220, right: 0, left: 'auto' }}>
					{knownTokenIds()
						.filter(id => id !== exclude)
						.map(id => {
							const tokenMeta = getTokenMeta(id);
							return (
								<button
									key={id}
									type="button"
									className="picker-option"
									onClick={() => {
										onChange(id);
										setOpen(false);
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
	);
}

export function Swap() {
	const entityId = useApp(s => s.activeEntityId);
	const toast = useApp(s => s.toast);
	const core = useEntityCore(entityId);
	const { accounts } = useAccounts(entityId);
	const { offers } = useOpenSwapOffers(entityId);
	const entities = useAdapterRead<RuntimeAdapterEntitySummary[]>('entities');

	const names = useMemo(() => {
		const map = new Map<string, string>();
		for (const summary of entities.data ?? []) {
			if (summary.entityId) map.set(summary.entityId.toLowerCase(), summary.label || '');
		}
		return map;
	}, [entities.data]);

	const [counterpartyId, setCounterpartyId] = useState('');
	const [counterpartyOpen, setCounterpartyOpen] = useState(false);
	const [giveTokenId, setGiveTokenId] = useState(1);
	const [wantTokenId, setWantTokenId] = useState(2);
	const [giveText, setGiveText] = useState('');
	const [wantText, setWantText] = useState('');
	const [giveTokenOpen, setGiveTokenOpen] = useState(false);
	const [wantTokenOpen, setWantTokenOpen] = useState(false);
	const [tif, setTif] = useState<0 | 1 | 2>(0);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [cancelingId, setCancelingId] = useState<string | null>(null);

	const activeCounterpartyId = counterpartyId || accounts[0]?.counterpartyId || '';
	const counterparty: AccountView | undefined = accounts.find(a => a.counterpartyId === activeCounterpartyId);

	const giveMeta = getTokenMeta(giveTokenId);
	const wantMeta = getTokenMeta(wantTokenId);

	const giveSpendable = counterparty?.tokens.find(t => t.tokenId === giveTokenId)?.derived.outCapacity ?? 0n;

	const parsedGive = useMemo(() => {
		try {
			const value = parseAmount(giveText || '0', giveMeta.decimals);
			return value > 0n ? value : null;
		} catch {
			return null;
		}
	}, [giveText, giveMeta.decimals]);

	const parsedWant = useMemo(() => {
		try {
			const value = parseAmount(wantText || '0', wantMeta.decimals);
			return value > 0n ? value : null;
		} catch {
			return null;
		}
	}, [wantText, wantMeta.decimals]);

	const prepared = useMemo(() => {
		const xln = peekXLN();
		if (!xln || !parsedGive || !parsedWant || giveTokenId === wantTokenId) return null;
		try {
			return xln.prepareSwapOrder(giveTokenId, wantTokenId, parsedGive, parsedWant);
		} catch {
			return null;
		}
	}, [giveTokenId, wantTokenId, parsedGive, parsedWant]);

	const sameToken = giveTokenId === wantTokenId;
	const noAccount = !counterparty;
	const overCapacity = Boolean(prepared && prepared.effectiveGive > giveSpendable);

	const flip = (): void => {
		const g = giveTokenId;
		const w = wantTokenId;
		const gt = giveText;
		const wt = wantText;
		setGiveTokenId(w);
		setWantTokenId(g);
		setGiveText(wt);
		setWantText(gt);
	};

	const place = async (): Promise<void> => {
		const xln = peekXLN();
		if (!xln || !entityId || !core.data?.signerId || !counterparty || !prepared) return;
		setSubmitting(true);
		try {
			const auth = xln.deriveSwapNetAuthorization(prepared.effectiveWant, 1);
			const offerId = crypto.randomUUID();
			await sendEntityTxs(entityId, core.data.signerId, [
				{
					type: 'placeSwapOffer',
					data: {
						counterpartyEntityId: counterparty.counterpartyId,
						offerId,
						giveTokenId,
						giveAmount: prepared.effectiveGive,
						wantTokenId,
						wantAmount: prepared.effectiveWant,
						maxFee: auth.maxFee,
						minNetReceive: auth.minNetReceive,
						priceTicks: prepared.priceTicks,
						timeInForce: tif,
					},
				},
			]);
			toast(`Offer placed — ${formatAmount(prepared.effectiveGive, giveMeta.decimals, 4)} ${giveMeta.symbol} for ${formatAmount(prepared.effectiveWant, wantMeta.decimals, 4)} ${wantMeta.symbol}`);
			setGiveText('');
			setWantText('');
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setSubmitting(false);
		}
	};

	const cancel = async (offerCounterpartyId: string, offerId: string): Promise<void> => {
		if (!entityId || !core.data?.signerId) return;
		setCancelingId(offerId);
		try {
			await sendEntityTxs(entityId, core.data.signerId, [
				{ type: 'proposeCancelSwap', data: { counterpartyEntityId: offerCounterpartyId, offerId } },
			]);
			toast('Cancellation requested');
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setCancelingId(null);
		}
	};

	const mine = offers.filter(o => o.mine);

	return (
		<div className="screen screen-narrow fade-in">
			<div className="screen-header">
				<span className="screen-title">Swap</span>
			</div>

			<div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
				<div className="field">
					<span className="field-label">With</span>
					<div className="picker">
						<button type="button" className="picker-control" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => setCounterpartyOpen(!counterpartyOpen)}>
							<span>{counterparty ? names.get(counterparty.counterpartyId) || 'Account' : 'Select a counterparty'}</span>
							<Icon name="chevronDown" size={14} />
						</button>
						{counterpartyOpen && (
							<div className="picker-menu glass">
								{accounts.length === 0 && (
									<p className="faint" style={{ padding: '10px 14px', fontSize: 12.5 }}>
										No bilateral accounts yet — open one first.
									</p>
								)}
								{accounts.map(account => (
									<button
										key={account.counterpartyId}
										type="button"
										className="picker-option"
										onMouseDown={e => {
											e.preventDefault();
											setCounterpartyId(account.counterpartyId);
											setCounterpartyOpen(false);
										}}
									>
										<span style={{ fontSize: 13.5 }}>{names.get(account.counterpartyId) || 'Account'}</span>
										<span className="hash">{account.counterpartyId}</span>
									</button>
								))}
							</div>
						)}
					</div>
					{counterparty && <span className="hash">{counterparty.counterpartyId}</span>}
				</div>

				<div className="field">
					<span className="field-label">You give</span>
					<div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
						<input
							className="input display"
							style={{ fontSize: 32, fontWeight: 300, padding: '10px 16px', minWidth: 0 }}
							placeholder="0"
							inputMode="decimal"
							value={giveText}
							onChange={e => setGiveText(e.target.value)}
						/>
						<TokenPicker tokenId={giveTokenId} onChange={setGiveTokenId} open={giveTokenOpen} setOpen={setGiveTokenOpen} exclude={wantTokenId} />
					</div>
					<button
						type="button"
						className="btn-quiet btn"
						style={{ alignSelf: 'flex-start', padding: '2px 0', fontSize: 12 }}
						disabled={giveSpendable <= 0n}
						onClick={() => setGiveText(rawAmountText(giveSpendable, giveMeta.decimals))}
					>
						{formatAmount(giveSpendable, giveMeta.decimals, 2)} {giveMeta.symbol} available
					</button>
				</div>

				<button
					type="button"
					className="btn-quiet btn"
					aria-label="Flip give and receive"
					style={{ alignSelf: 'center', padding: 6, borderRadius: 999, border: '1px solid var(--hairline-2)' }}
					onClick={flip}
				>
					<Icon name="swap" size={15} />
				</button>

				<div className="field">
					<span className="field-label">You receive</span>
					<div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
						<input
							className="input display"
							style={{ fontSize: 32, fontWeight: 300, padding: '10px 16px', minWidth: 0 }}
							placeholder="0"
							inputMode="decimal"
							value={wantText}
							onChange={e => setWantText(e.target.value)}
						/>
						<TokenPicker tokenId={wantTokenId} onChange={setWantTokenId} open={wantTokenOpen} setOpen={setWantTokenOpen} exclude={giveTokenId} />
					</div>
				</div>

				{sameToken && (
					<p style={{ color: 'var(--danger)', fontSize: 12.5 }}>Choose two different tokens.</p>
				)}
				{!sameToken && overCapacity && (
					<p style={{ color: 'var(--danger)', fontSize: 12.5 }}>
						Exceeds spendable capacity ({formatAmount(giveSpendable, giveMeta.decimals, 2)} {giveMeta.symbol}).
					</p>
				)}

				{prepared && (
					<div className="route-card active" style={{ cursor: 'default' }}>
						<span className="route-meta">
							<span>
								Limit price {formatAmount(prepared.priceTicks, 4, 4)} {getTokenMeta(prepared.quoteTokenId).symbol} per{' '}
								{getTokenMeta(prepared.baseTokenId).symbol}
							</span>
							<span>
								Order books at {formatAmount(prepared.effectiveGive, giveMeta.decimals, 4)} {giveMeta.symbol} for{' '}
								{formatAmount(prepared.effectiveWant, wantMeta.decimals, 4)} {wantMeta.symbol}
							</span>
						</span>
						{prepared.unspentGiveAmount > 0n && (
							<span className="route-hop-fees">
								<span className="faint">
									{formatAmount(prepared.unspentGiveAmount, giveMeta.decimals, 6)} {giveMeta.symbol} left unspent — lot size rounding
								</span>
							</span>
						)}
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
						<div style={{ marginTop: 14 }} className="fade-in field">
							<span className="field-label">Time in force</span>
							<div className="mode-grid" role="radiogroup" aria-label="Time in force">
								{TIF_OPTIONS.map(option => (
									<button
										key={option.value}
										type="button"
										role="radio"
										aria-checked={tif === option.value}
										className={`mode-card${tif === option.value ? ' active' : ''}`}
										onClick={() => setTif(option.value)}
									>
										<span className="mode-card-name">
											<span className="mode-radio" aria-hidden />
											{option.label}
											{option.value === 0 && <span className="mode-default">Default</span>}
										</span>
										<span className="mode-card-desc">{option.description}</span>
									</button>
								))}
							</div>
						</div>
					)}
				</div>

				<button
					type="button"
					className="btn btn-primary btn-lg btn-block"
					disabled={!prepared || noAccount || overCapacity || submitting || !core.data?.signerId}
					onClick={() => void place()}
				>
					<Icon name="swap" size={15} />
					{submitting ? 'Placing…' : noAccount ? 'No account to swap through' : prepared ? `Swap ${giveMeta.symbol} → ${wantMeta.symbol}` : 'Swap'}
				</button>

				{mine.length > 0 && (
					<div className="field">
						<span className="field-label">
							Your open orders · {mine.length}
						</span>
						{mine.map(offer => {
							const gMeta = getTokenMeta(offer.giveTokenId);
							const wMeta = getTokenMeta(offer.wantTokenId);
							return (
								<div key={`${offer.counterpartyId}-${offer.offerId}`} className="row" style={{ flexWrap: 'wrap' }}>
									<span style={{ flex: '1 1 100%', display: 'flex', justifyContent: 'space-between', gap: 16 }}>
										<span style={{ fontSize: 13.5 }}>
											{formatAmount(offer.giveAmount, gMeta.decimals, 4)} {gMeta.symbol} → {formatAmount(offer.wantAmount, wMeta.decimals, 4)} {wMeta.symbol}
										</span>
										<button
											type="button"
											className="btn-quiet btn"
											style={{ fontSize: 12 }}
											disabled={cancelingId === offer.offerId}
											onClick={() => void cancel(offer.counterpartyId, offer.offerId)}
										>
											{cancelingId === offer.offerId ? 'Canceling…' : 'Cancel'}
										</button>
									</span>
									<span className="faint" style={{ fontSize: 11 }}>
										#{offer.offerId.slice(0, 8)} · height {offer.createdHeight}
									</span>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
