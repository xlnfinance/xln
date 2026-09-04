import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { AccountState, RuntimeAdapterEntitySummary } from '@xln/core/api/public/runtime-module';
import { getJurisdictionStackId } from '@xln/core/api/public/runtime-module';
import { buildCrossSwapSetupSteps } from '$lib/components/Entity/swap/swap-panel-helpers';
import { DeltaBar, DeltaCaption } from '../components/Bars';
import { Orderbook, type BookSide } from '../components/Orderbook';
import { quoteForBase, useOrderbook, type BookLevel } from '../runtime/financial/orderbook';
import { Icon } from '../components/Icons';
import { TokenPicker } from '../components/TokenPicker';
import { useApp } from '../runtime/store';
import { peekXLN } from '../runtime/xln-loader';
import { sendEntityTxs } from '../runtime/tx';
import { hubTakerFeeBps, jurisdictionRef, planSwap, readAccountState, submitSwapPlan } from '../runtime/financial/swap';
import { amountInputText, formatMoney, getTokenMeta, parseAmount } from '../runtime/format';
import { openSwapOffers, useWallet } from '../runtime/views';

type Mode = 'same' | 'cross';

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

export function Swap() {
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const entityId = useApp(s => s.activeEntityId);
	const toast = useApp(s => s.toast);
	const wallet = useWallet(entityId);
	const xln = peekXLN();

	const hubs = useMemo(() => wallet.accounts.filter(account => account.isHub && !account.disputed), [wallet.accounts]);
	const [mode, setMode] = useState<Mode>('same');
	const [hubId, setHubId] = useState(params.get('hub')?.toLowerCase() ?? '');
	const hub = hubs.find(account => account.counterpartyId === hubId) ?? hubs[0] ?? null;

	const [giveTokenId, setGiveTokenId] = useState(1);
	const [wantTokenId, setWantTokenId] = useState(2);
	const [giveText, setGiveText] = useState('');
	const [wantText, setWantText] = useState('');
	const [submitting, setSubmitting] = useState(false);
	// The hub's book stays open, as in the SvelteKit panel; a level fills the ticket.
	const [showBook, setShowBook] = useState(true);
	const [cancelingId, setCancelingId] = useState<string | null>(null);

	// Cross-network: our entity on the other network and a hub that lives there.
	const otherEntities = useMemo(
		() =>
			wallet.summaries.filter(
				summary => summary.signerId && normalizeId(summary.entityId) !== wallet.entityId && (summary.jurisdiction?.name || '') !== wallet.jurisdiction,
			),
		[wallet.summaries, wallet.entityId, wallet.jurisdiction],
	);
	const [targetEntityId, setTargetEntityId] = useState('');
	const targetEntity = otherEntities.find(summary => normalizeId(summary.entityId) === targetEntityId) ?? otherEntities[0] ?? null;
	const targetHubs = useMemo(
		() =>
			wallet.summaries.filter(
				summary => summary.isHub && targetEntity && (summary.jurisdiction?.name || '') === (targetEntity.jurisdiction?.name || '') && normalizeId(summary.entityId) !== normalizeId(targetEntity.entityId),
			),
		[wallet.summaries, targetEntity],
	);
	const [targetHubId, setTargetHubId] = useState('');
	const targetHub = targetHubs.find(summary => normalizeId(summary.entityId) === targetHubId) ?? targetHubs[0] ?? null;
	const [targetAccount, setTargetAccount] = useState<AccountState | null | undefined>(undefined);

	useEffect(() => {
		if (mode !== 'cross' || !targetEntity || !targetHub) {
			setTargetAccount(undefined);
			return;
		}
		let cancelled = false;
		readAccountState(targetEntity.entityId, targetHub.entityId)
			.then(state => {
				if (!cancelled) setTargetAccount(state);
			})
			.catch(() => {
				if (!cancelled) setTargetAccount(null);
			});
		return () => {
			cancelled = true;
		};
	}, [mode, targetEntity, targetHub, wallet.frameHeight]);

	const giveMeta = getTokenMeta(giveTokenId);
	const wantMeta = getTokenMeta(wantTokenId);
	const book = useOrderbook({
		hubId: hub?.counterpartyId ?? '',
		tokenA: giveTokenId,
		tokenB: wantTokenId,
		ownEntityId: wallet.entityId,
		baseDecimals: getTokenMeta(xln?.getSwapPairOrientation?.(giveTokenId, wantTokenId).baseTokenId ?? Math.max(giveTokenId, wantTokenId)).decimals,
	});
	const pickLevel = (side: BookSide, level: BookLevel): void => {
		const base = getTokenMeta(book.baseTokenId);
		const quote = getTokenMeta(book.quoteTokenId);
		const quoteAmount = quoteForBase(level.size, level.priceTicks, base.decimals, quote.decimals);
		if (side === 'ask') {
			// Someone sells base at this price: we pay quote, we get base.
			setGiveTokenId(book.quoteTokenId);
			setWantTokenId(book.baseTokenId);
			setGiveText(plainAmount(quoteAmount, quote.decimals));
			setWantText(plainAmount(level.size, base.decimals));
		} else {
			setGiveTokenId(book.baseTokenId);
			setWantTokenId(book.quoteTokenId);
			setGiveText(plainAmount(level.size, base.decimals));
			setWantText(plainAmount(quoteAmount, quote.decimals));
		}
	};
	const giveToken = hub?.tokens.find(token => token.tokenId === giveTokenId) ?? null;
	const giveSpendable = giveToken?.derived.outCapacity ?? 0n;

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
		if (!xln || !parsedGive || !parsedWant || giveTokenId === wantTokenId) return null;
		try {
			return xln.prepareSwapOrder(giveTokenId, wantTokenId, parsedGive, parsedWant);
		} catch {
			return null;
		}
	}, [xln, giveTokenId, wantTokenId, parsedGive, parsedWant]);

	const feeBps = useMemo(() => {
		if (!hub || mode !== 'same') return null;
		try {
			return hubTakerFeeBps(hub.counterpartyId);
		} catch {
			return null;
		}
	}, [hub, mode, wallet.frameHeight]);

	const sameToken = giveTokenId === wantTokenId;
	const overCapacity = Boolean(prepared && prepared.effectiveGive > giveSpendable);

	// Inbound room on the target account for what we want to receive.
	const targetInbound = useMemo(() => {
		if (!xln || !targetAccount || !targetEntity || !targetHub) return 0n;
		const delta = targetAccount.deltas.get(wantTokenId);
		if (!delta) return 0n;
		const isLeft = xln.isLeftEntity(targetEntity.entityId, targetHub.entityId);
		return xln.deriveDelta(delta, isLeft).inCapacity;
	}, [xln, targetAccount, targetEntity, targetHub, wantTokenId]);

	const setupSteps = useMemo(() => {
		if (mode !== 'cross' || !targetHub || !targetEntity) return [];
		const want = prepared?.effectiveWant ?? parsedWant ?? 0n;
		return buildCrossSwapSetupSteps({
			routeMode: 'cross',
			targetAccountReady: targetAccount !== null && targetAccount !== undefined,
			canOpenTargetAccount: true,
			needsCreditLimit: want > 0n && targetInbound < want,
			targetHubLabel: targetHub.label,
			targetJurisdictionLabel: targetEntity.jurisdiction?.name || 'target network',
			creditLimitLabel: want > 0n ? formatMoney(want, wantMeta.decimals) : '',
			creditIncreaseLabel: want > targetInbound ? `+${formatMoney(want - targetInbound, wantMeta.decimals)}` : '',
			tokenSymbol: wantMeta.symbol,
		});
	}, [mode, targetHub, targetEntity, targetAccount, targetInbound, prepared, parsedWant, wantMeta.decimals, wantMeta.symbol]);

	const flip = (): void => {
		setGiveTokenId(wantTokenId);
		setWantTokenId(giveTokenId);
		setGiveText(wantText);
		setWantText(giveText);
	};

	const place = async (): Promise<void> => {
		if (!wallet.frame || !hub || !prepared || !wallet.signerId) return;
		setSubmitting(true);
		try {
			const source = {
				entityId: wallet.entityId,
				signerId: wallet.signerId,
				hubEntityId: hub.counterpartyId,
				jurisdiction: jurisdictionRef(wallet.frame),
				account: (wallet.frame.activeEntity?.accounts.items.find(doc => {
					const left = normalizeId(doc.state.leftEntity);
					const right = normalizeId(doc.state.rightEntity);
					return (left === wallet.entityId ? right : left) === hub.counterpartyId;
				})?.state as AccountState | undefined) ?? null,
			};
			const target =
				mode === 'cross' && targetEntity && targetHub
					? {
							entityId: normalizeId(targetEntity.entityId),
							signerId: normalizeId(targetEntity.signerId),
							hubEntityId: normalizeId(targetHub.entityId),
							jurisdiction: getJurisdictionStackId(targetEntity.jurisdiction),
							account: targetAccount ?? null,
						}
					: undefined;
			const plan = await planSwap({
				mode,
				frame: wallet.frame,
				source,
				...(target ? { target } : {}),
				giveTokenId,
				giveTokenDecimals: giveMeta.decimals,
				wantTokenId,
				wantTokenDecimals: wantMeta.decimals,
				giveAmount: prepared.effectiveGive,
				priceTicks: prepared.priceTicks,
				expectedWantAmount: prepared.effectiveWant,
				routeValue: target ? `cross:${hub.counterpartyId}>${target.hubEntityId}` : `same:${hub.counterpartyId}`,
			});
			await submitSwapPlan(plan);
			toast(
				mode === 'cross'
					? `Cross-network swap submitted: ${formatMoney(prepared.effectiveGive, giveMeta.decimals)} ${giveMeta.symbol} for ${formatMoney(prepared.effectiveWant, wantMeta.decimals)} ${wantMeta.symbol}`
					: `Order placed: ${formatMoney(prepared.effectiveGive, giveMeta.decimals)} ${giveMeta.symbol} for ${formatMoney(prepared.effectiveWant, wantMeta.decimals)} ${wantMeta.symbol}`,
			);
			setGiveText('');
			setWantText('');
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setSubmitting(false);
		}
	};

	const cancel = async (offerCounterpartyId: string, offerId: string): Promise<void> => {
		if (!wallet.entityId || !wallet.signerId) return;
		setCancelingId(offerId);
		try {
			await sendEntityTxs(wallet.entityId, wallet.signerId, [
				{ type: 'proposeCancelSwap', data: { counterpartyEntityId: offerCounterpartyId, offerId } },
			]);
			toast('Cancellation requested');
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setCancelingId(null);
		}
	};

	const mine = openSwapOffers(wallet.frame, wallet.entityId).filter(offer => offer.mine);
	const disabledReason = !hub ? 'No hub account to swap through' : sameToken ? 'Choose two different tokens' : overCapacity ? 'Exceeds what you can send' : null;

	return (
		<div className="screen fade-in">
			<div className="screen-header">
				<span className="screen-title">
					<button type="button" className="icon-btn" onClick={() => navigate(-1)} aria-label="Back" data-testid="back">
						<Icon name="chevronLeft" size={18} />
					</button>
					Swap
				</span>
				<span className="segc">
					<button type="button" className={mode === 'same' ? 'active' : ''} onClick={() => setMode('same')}>
						Same network
					</button>
					<button type="button" className={mode === 'cross' ? 'active' : ''} onClick={() => setMode('cross')} disabled={otherEntities.length === 0}>
						Across networks
					</button>
				</span>
			</div>

			<div className="two-col pay">
				<div className="stack">
					<div className="field">
						<div className="field-head">
							<span>You pay</span>
							<button type="button" className="btn quiet num" style={{ fontSize: 12 }} disabled={giveSpendable <= 0n} onClick={() => setGiveText(amountInputText(giveSpendable, giveMeta.decimals))}>
								Up to {formatMoney(giveSpendable, giveMeta.decimals)}
								{hub ? ` with ${hub.label}` : ''}
							</button>
						</div>
						<div className="field-row">
							<input className="input big" placeholder="0.00" inputMode="decimal" value={giveText} onChange={event => setGiveText(event.target.value)} data-testid="swap-give" />
							<TokenPicker tokenId={giveTokenId} onChange={setGiveTokenId} exclude={wantTokenId} {...(wallet.jurisdiction ? { chip: wallet.jurisdiction } : {})} />
						</div>
					</div>
					<div className="flip">
						<button type="button" onClick={flip} aria-label="Flip">
							<Icon name="swap" size={16} />
						</button>
					</div>
					<div className="field">
						<div className="field-head">
							<span>You receive</span>
							<span>{mode === 'cross' && targetEntity ? `into your ${targetEntity.jurisdiction?.name || 'other'} account` : hub ? `from ${hub.label}` : ''}</span>
						</div>
						<div className="field-row">
							<input
								className="input big"
								style={{ color: 'var(--accent-2)' }}
								placeholder="0.00"
								inputMode="decimal"
								value={wantText}
								onChange={event => setWantText(event.target.value)}
								data-testid="swap-want"
							/>
							<TokenPicker
								tokenId={wantTokenId}
								onChange={setWantTokenId}
								exclude={giveTokenId}
								{...(mode === 'cross' && targetEntity?.jurisdiction?.name ? { chip: targetEntity.jurisdiction.name } : {})}
							/>
						</div>
						{giveText.trim() && !wantText.trim() ? (
							<div className="note" style={{ marginTop: 8 }}>
								Set the amount you want. The order rests on your account at that price until {hub?.label ?? 'the hub'} fills it.
							</div>
						) : null}
					</div>

					{hubs.length > 1 && (
						<div className="chips">
							{hubs.map(account => (
								<button key={account.counterpartyId} type="button" className={hub?.counterpartyId === account.counterpartyId ? 'active' : ''} onClick={() => setHubId(account.counterpartyId)}>
									{account.label}
								</button>
							))}
						</div>
					)}

					{mode === 'cross' && (
						<div className="card tight">
							<div className="kv">
								<span className="k">Your other account</span>
								<span className="v">
									<select className="input" style={{ width: 'auto', textAlign: 'right' }} value={targetEntity ? normalizeId(targetEntity.entityId) : ''} onChange={event => setTargetEntityId(event.target.value)}>
										{otherEntities.map(summary => (
											<option key={summary.entityId} value={normalizeId(summary.entityId)}>
												{summary.label || summary.entityId.slice(0, 10)} · {summary.jurisdiction?.name || 'unknown'}
											</option>
										))}
									</select>
								</span>
							</div>
							<div className="kv">
								<span className="k">Hub there</span>
								<span className="v">
									<select className="input" style={{ width: 'auto', textAlign: 'right' }} value={targetHub ? normalizeId(targetHub.entityId) : ''} onChange={event => setTargetHubId(event.target.value)}>
										{targetHubs.map(summary => (
											<option key={summary.entityId} value={normalizeId(summary.entityId)}>
												{summary.label || summary.entityId.slice(0, 10)}
											</option>
										))}
									</select>
								</span>
							</div>
						</div>
					)}

					{prepared && (
						<div className="card tight">
							<div className="kv">
								<span className="k">Limit price</span>
								<span className="v num">
									{formatMoney(prepared.priceTicks, 4, 4)} {getTokenMeta(prepared.quoteTokenId).symbol} per {getTokenMeta(prepared.baseTokenId).symbol}
								</span>
							</div>
							{mode === 'same' && (
								<div className="kv">
									<span className="k">Hub fee</span>
									<span className={`v num ${feeBps === null ? 'st-pending' : ''}`}>
										{feeBps === null ? 'not published yet' : `${feeBps} bps · up to ${formatMoney((prepared.effectiveWant * BigInt(feeBps)) / 10_000n, wantMeta.decimals, 4)} ${wantMeta.symbol}`}
									</span>
								</div>
							)}
							<div className="kv">
								<span className="k">Route</span>
								<span className="hops">
									<span className="hop">{wallet.jurisdiction || 'here'}</span>
									<Icon name="arrow" size={12} />
									<span className="hop me">{hub?.label ?? 'hub'}</span>
									{mode === 'cross' && targetEntity ? (
										<>
											<Icon name="arrow" size={12} />
											<span className="hop">{targetEntity.jurisdiction?.name || 'there'}</span>
										</>
									) : null}
								</span>
							</div>
							<div className="kv">
								<span className="k">Settlement</span>
								<span className="v" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
									<Icon name="link" size={14} />
									{mode === 'cross' ? 'Atomic · both legs or neither' : 'Bilateral · signed by both sides'}
								</span>
							</div>
							{prepared.unspentGiveAmount > 0n && (
								<div className="kv">
									<span className="k">Lot rounding</span>
									<span className="v num muted" style={{ fontWeight: 400 }}>
										{formatMoney(prepared.unspentGiveAmount, giveMeta.decimals, 6)} {giveMeta.symbol} stays with you
									</span>
								</div>
							)}
						</div>
					)}

					{mode === 'cross' && setupSteps.length > 0 && (
						<div>
							{setupSteps.map(step => (
								<div key={step.id} className="check">
									<span className="ck todo">
										<Icon name="plus" size={11} />
									</span>
									<span>
										<b style={{ fontWeight: 600 }}>{step.label}.</b> <span className="muted">{step.detail}</span>
									</span>
								</div>
							))}
							<p className="note">These happen automatically as part of the swap.</p>
						</div>
					)}
					{mode === 'cross' && targetAccount && setupSteps.length === 0 && targetEntity && targetHub && (
						<div className="check">
							<span className="ck">
								<Icon name="check" size={11} />
							</span>
							<span>
								{targetEntity.jurisdiction?.name} account with {targetHub.label} is ready to receive {wantMeta.symbol}
							</span>
						</div>
					)}

					{disabledReason && (giveText || wantText) ? <p style={{ color: 'var(--dispute)', fontSize: 12.5 }}>{disabledReason}</p> : null}

					<button type="button" className="btn" data-testid="swap-submit" disabled={!prepared || Boolean(disabledReason) || submitting || !wallet.signerId} onClick={() => void place()}>
						<Icon name="swap" size={15} />
						{submitting ? 'Placing…' : prepared ? `Swap ${giveMeta.symbol} for ${wantMeta.symbol}` : 'Swap'}
					</button>

					{hub && mode === 'same' ? (
						<div className="mobile-only card">
							<div className="sect" style={{ marginTop: 0 }}>
								<h3 className="caps">Book</h3>
								<button type="button" className="more" onClick={() => setShowBook(value => !value)}>
									{showBook ? 'Hide' : 'Show'}
								</button>
							</div>
							{showBook ? <Orderbook book={book} hubLabel={hub.label} onPick={pickLevel} /> : null}
						</div>
					) : null}

					{mine.length > 0 && (
						<div>
							<div className="sect">
								<h3 className="caps">Your open orders</h3>
								<span className="more">{mine.length}</span>
							</div>
							{mine.map((offer, index) => {
								const gMeta = getTokenMeta(offer.giveTokenId);
								const wMeta = getTokenMeta(offer.wantTokenId);
								return (
									<div key={`${offer.counterpartyId}-${offer.offerId}`} className={`row${index === 0 ? ' first' : ''}`}>
										<div className="rt">
											<span className="ev-ic swap">
												<Icon name="swap" size={15} />
											</span>
											<span className="tx">
												<span className="t num">
													{formatMoney(offer.giveAmount, gMeta.decimals, 4)} {gMeta.symbol} for {formatMoney(offer.wantAmount, wMeta.decimals, 4)} {wMeta.symbol}
												</span>
												<span className="s">
													with {wallet.names.get(offer.counterpartyId) || 'hub'} · height {offer.createdHeight}
												</span>
											</span>
											<span className="r">
												<span className="state st-inflight">open</span>
												<div>
													<button type="button" className="btn quiet" style={{ fontSize: 12 }} disabled={cancelingId === offer.offerId} onClick={() => void cancel(offer.counterpartyId, offer.offerId)}>
														{cancelingId === offer.offerId ? 'Canceling…' : 'Cancel'}
													</button>
												</div>
											</span>
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>

				<div className="aside desktop-only">
					{hub && mode === 'same' ? (
						<div className="card">
							<div className="sect" style={{ marginTop: 0 }}>
								<h3 className="caps">Book</h3>
								<button type="button" className="more" onClick={() => setShowBook(value => !value)}>
									{showBook ? 'Hide' : 'Show'}
								</button>
							</div>
							{showBook ? <Orderbook book={book} hubLabel={hub.label} onPick={pickLevel} /> : null}
						</div>
					) : null}
					{mode === 'cross' ? (
						<div className="card">
							<h3 className="caps">Legs</h3>
							<div className="tl">
								<div className="ev">
									<div className="t">1 · {wallet.jurisdiction || 'here'}</div>
									<div className="s">
										You lock {prepared ? formatMoney(prepared.effectiveGive, giveMeta.decimals) : '…'} {giveMeta.symbol} with {hub?.label ?? 'the hub'}
									</div>
								</div>
								<div className="ev">
									<div className="t">2 · {targetEntity?.jurisdiction?.name || 'there'}</div>
									<div className="s">
										{targetHub?.label ?? 'The hub'} pays {prepared ? formatMoney(prepared.effectiveWant, wantMeta.decimals) : '…'} {wantMeta.symbol} into your account there
									</div>
								</div>
								<div className="ev">
									<div className="t">Clear</div>
									<div className="s">One secret releases both legs. If it never appears, both unlock.</div>
								</div>
							</div>
						</div>
					) : null}
					{hub && giveToken ? (
						<div className="card">
							<h3 className="caps">Your account with {hub.label}</h3>
							<DeltaBar derived={giveToken.derived} tokenId={giveTokenId} />
							<DeltaCaption derived={giveToken.derived} format={value => formatMoney(value, giveMeta.decimals)} />
							<p className="note" style={{ marginTop: 12 }}>
								The order rests on this account. Filled amounts move Δ, nothing moves on-chain.
							</p>
						</div>
					) : null}
					{hubs.length === 0 && (
						<div className="card">
							<p className="note">Open an account with a hub to swap. Hubs run the order books.</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

/** Decimal text for an input field: no grouping, trailing zeros trimmed. */
function plainAmount(amount: bigint, decimals: number): string {
	const unit = 10n ** BigInt(decimals);
	const whole = amount / unit;
	const fraction = (amount % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
	return fraction ? `${whole}.${fraction}` : whole.toString();
}

export type { RuntimeAdapterEntitySummary };
