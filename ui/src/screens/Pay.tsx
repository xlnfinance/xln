import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { PaymentDeliveryMode } from '@xln/core/api/public/runtime-module';
import { parseXlnInvoice, type ParsedXlnInvoice } from '$lib/utils/xlnInvoice';
import { Bar, DeltaBar, DeltaCaption } from '../components/Bars';
import { Icon } from '../components/Icons';
import { ScanSheet } from '../components/ScanSheet';
import { TokenPicker } from '../components/TokenPicker';
import { useApp } from '../runtime/store';
import { peekXLN } from '../runtime/xln-loader';
import {
	DELIVERY_OPTIONS,
	eligibleRoutes,
	isEntityId,
	quotePaymentRoutes,
	routeModeError,
	submitPayment,
	type PaymentRouteQuote,
} from '../runtime/financial/payments';
import { amountInputText, formatMoney, getTokenMeta, parseAmount, shortId } from '../runtime/format';
import { usdOf } from '../runtime/financial/prices';
import { displayEntityName, useWallet, type AccountView } from '../runtime/views';

const looksLikeInvoice = (text: string): boolean => {
	const value = text.trim();
	return value.startsWith('xln://') || value.startsWith('http://') || value.startsWith('https://') || (value.startsWith('0x') && value.includes('?'));
};

export function Pay() {
	const navigate = useNavigate();
	const location = useLocation();
	const [params] = useSearchParams();
	const entityId = useApp(s => s.activeEntityId);
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const setSelectedTokenId = useApp(s => s.setSelectedTokenId);
	const toast = useApp(s => s.toast);
	const wallet = useWallet(entityId);

	const [toText, setToText] = useState(params.get('to')?.toLowerCase() ?? '');
	const [toFocused, setToFocused] = useState(false);
	const [invoice, setInvoice] = useState<ParsedXlnInvoice | null>(null);
	const [invoiceError, setInvoiceError] = useState<string | null>(null);
	const [amountText, setAmountText] = useState(params.get('amount') ?? '');
	const [tokenId, setTokenId] = useState(Number(params.get('token') ?? selectedTokenId) || selectedTokenId);
	const [deliveryMode, setDeliveryMode] = useState<PaymentDeliveryMode>('instant');
	const [description, setDescription] = useState(params.get('desc') ?? '');
	const [noteOpen, setNoteOpen] = useState(Boolean(params.get('desc')));
	const [modeOpen, setModeOpen] = useState(false);
	const [routes, setRoutes] = useState<PaymentRouteQuote[] | null>(null);
	const [routeIndex, setRouteIndex] = useState(0);
	const [routeError, setRouteError] = useState<string | null>(null);
	const [quoting, setQuoting] = useState(false);
	const [sending, setSending] = useState(false);
	const [scanning, setScanning] = useState(false);
	const quoteSeq = useRef(0);

	const meta = getTokenMeta(tokenId);
	const self = wallet.entityId;

	const applyInvoice = useCallback((raw: string): boolean => {
		try {
			const parsed = parseXlnInvoice(raw);
			setInvoice(parsed);
			setInvoiceError(null);
			setToText(parsed.targetEntityId);
			if (parsed.tokenId) setTokenId(parsed.tokenId);
			if (parsed.amount) setAmountText(parsed.amount);
			if (parsed.description) {
				setDescription(parsed.description);
				setNoteOpen(true);
			}
			return true;
		} catch (error) {
			setInvoice(null);
			setInvoiceError(error instanceof Error ? error.message : String(error));
			return false;
		}
	}, []);

	// Deep link: /#pay/<invoice> lands here with the full href in navigation state.
	useEffect(() => {
		const state = location.state as { invoice?: string } | null;
		if (state?.invoice) applyInvoice(state.invoice);
	}, [location.state, applyInvoice]);

	const known = useMemo(
		() =>
			wallet.summaries
				.map(summary => ({ entityId: summary.entityId.toLowerCase(), label: summary.label || '', isHub: summary.isHub === true }))
				.filter(entry => entry.entityId && entry.entityId !== self),
		[wallet.summaries, self],
	);
	const recents = useMemo(() => wallet.accounts.filter(account => !account.disputed).slice(0, 4), [wallet.accounts]);

	const query = toText.trim().toLowerCase();
	const target = useMemo(() => {
		if (isEntityId(query)) return query;
		const byName = known.find(entry => entry.label.toLowerCase() === query);
		return byName?.entityId ?? '';
	}, [query, known]);
	const validTarget = Boolean(target);
	const suggestions = useMemo(() => {
		if (validTarget) return [];
		if (!query) return known;
		return known.filter(entry => entry.label.toLowerCase().includes(query) || entry.entityId.includes(query));
	}, [known, query, validTarget]);

	const parsedAmount = useMemo(() => {
		try {
			const value = parseAmount(amountText || '0', meta.decimals);
			return value > 0n ? value : null;
		} catch {
			return null;
		}
	}, [amountText, meta.decimals]);

	// PaymentPanel semantics: the largest single-account capacity, since one route uses one first hop.
	const payMax = wallet.accounts
		.flatMap(account => account.tokens)
		.filter(token => token.tokenId === tokenId)
		.reduce((max, token) => (token.derived.outCapacity > max ? token.derived.outCapacity : max), 0n);

	useEffect(() => {
		setRoutes(null);
		setRouteError(null);
		setRouteIndex(0);
		if (!self || !validTarget || !parsedAmount) return;
		const seq = ++quoteSeq.current;
		setQuoting(true);
		const timer = setTimeout(() => {
			quotePaymentRoutes({ sourceEntityId: self, targetEntityId: target, tokenId, amount: parsedAmount })
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

	const usable = useMemo(() => (routes ? eligibleRoutes(routes, deliveryMode) : []), [routes, deliveryMode]);
	const chosen = usable[Math.min(routeIndex, Math.max(0, usable.length - 1))] ?? null;
	const modeError = routeModeError(chosen, deliveryMode);
	const firstHop = chosen?.path[1] ?? null;
	const hopAccount = firstHop ? wallet.accounts.find(account => account.counterpartyId === firstHop) ?? null : null;
	const hopToken = hopAccount?.tokens.find(token => token.tokenId === tokenId) ?? null;

	const send = async (): Promise<void> => {
		if (!self || !wallet.signerId || !chosen || !parsedAmount || modeError) return;
		setSending(true);
		try {
			await submitPayment({
				entityId: self,
				signerId: wallet.signerId,
				targetEntityId: target,
				tokenId,
				deliveryMode,
				description,
				route: chosen,
			});
			toast(`Payment submitted: ${formatMoney(chosen.recipientAmount, meta.decimals)} ${meta.symbol} to ${displayEntityName(wallet.names, target)}`);
			navigate('/');
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setSending(false);
		}
	};

	const nameOf = (id: string): string => (id === self ? 'You' : displayEntityName(wallet.names, id));

	return (
		<div className="screen fade-in">
			<div className="screen-header">
				<span className="screen-title">
					<button type="button" className="icon-btn" onClick={() => navigate(-1)} aria-label="Back">
						<Icon name="chevronLeft" size={18} />
					</button>
					Pay
				</span>
				<button type="button" className="icon-btn" onClick={() => setScanning(true)} aria-label="Scan invoice">
					<Icon name="scan" size={18} />
				</button>
			</div>

			<div className="two-col pay">
				<div className="stack">
					<div className="field">
						<div className="field-head">
							<span>To</span>
							{validTarget ? (
								<span className="st-settled" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
									<Icon name="check" size={12} /> {displayEntityName(wallet.names, target)}
								</span>
							) : invoice ? (
								<span className="st-pending">invoice</span>
							) : null}
						</div>
						<div className="picker">
							<input
								className="input"
								style={{ fontFamily: query.startsWith('0x') || looksLikeInvoice(query) ? 'var(--font-mono)' : 'var(--font-ui)', fontSize: 15 }}
								placeholder="Name, entity id or invoice"
								value={toText}
								spellCheck={false}
								data-testid="pay-to"
								onChange={event => {
									const value = event.target.value;
									setToText(value);
									setInvoice(null);
									setInvoiceError(null);
									if (looksLikeInvoice(value)) applyInvoice(value);
								}}
								onFocus={() => setToFocused(true)}
								onBlur={() => setToFocused(false)}
							/>
							{toFocused && suggestions.length > 0 && (
								<div className="picker-menu">
									{suggestions.map(entry => (
										<button
											key={entry.entityId}
											type="button"
											className="picker-option"
											data-testid={`pay-suggestion-${entry.label || entry.entityId}`}
											onMouseDown={event => {
												event.preventDefault();
												setToText(entry.label || entry.entityId);
												setToFocused(false);
											}}
										>
											<span className="t">
												{entry.label || 'Entity'}
												{entry.isHub ? <span className="chip hub">hub</span> : null}
											</span>
											<span className="hash">{shortId(entry.entityId, 10, 6)}</span>
										</button>
									))}
								</div>
							)}
						</div>
						{validTarget ? <span className="hash">{target}</span> : null}
						{invoiceError ? <span style={{ color: 'var(--dispute)', fontSize: 12.5 }}>{invoiceError}</span> : null}
					</div>

					{recents.length > 0 && !validTarget && (
						<div className="chips">
							{recents.map(account => (
								<button key={account.counterpartyId} type="button" onClick={() => setToText(account.label)} data-testid={`pay-recent-${account.label}`}>
									{account.label}
									{account.isHub ? <span className="chip hub">hub</span> : null}
								</button>
							))}
							<button type="button" onClick={() => setScanning(true)}>
								<Icon name="scan" size={13} /> Scan
							</button>
						</div>
					)}

					<div className="field">
						<div className="field-head">
							<span>Amount</span>
							<button type="button" className="btn quiet num" style={{ fontSize: 12 }} disabled={payMax <= 0n} onClick={() => setAmountText(amountInputText(payMax, meta.decimals))}>
								Up to {formatMoney(payMax, meta.decimals)} instantly
							</button>
						</div>
						<div className="field-row">
							<input
								className="input big"
								placeholder="0.00"
								inputMode="decimal"
								value={amountText}
								onChange={event => setAmountText(event.target.value)}
								data-testid="pay-amount"
							/>
							<TokenPicker
								tokenId={tokenId}
								onChange={id => {
									setTokenId(id);
									setSelectedTokenId(id);
								}}
							/>
						</div>
						{parsedAmount ? (
							<div style={{ marginTop: 6 }}>
								<div className="dcap" style={{ margin: '0 0 5px' }}>
									<span>This payment</span>
									<span>{formatMoney(chosen?.senderAmount ?? parsedAmount, meta.decimals)}</span>
								</div>
								<Bar segments={[{ usd: usdOf(tokenId, chosen?.senderAmount ?? parsedAmount), kind: 'this' }]} height={4} />
								{hopAccount && hopToken ? (
									<>
										<div className="dcap" style={{ margin: '10px 0 5px' }}>
											<span>Your account with {hopAccount.label}</span>
											<span>{formatMoney(hopToken.signed, meta.decimals)}</span>
										</div>
										<DeltaBar derived={hopToken.derived} tokenId={tokenId} />
										<DeltaCaption derived={hopToken.derived} format={value => formatMoney(value, meta.decimals)} />
									</>
								) : null}
							</div>
						) : null}
					</div>

					{quoting && <p className="faint" style={{ fontSize: 12 }}>Quoting routes…</p>}
					{routeError && validTarget && parsedAmount && <p style={{ color: 'var(--dispute)', fontSize: 13 }}>{routeError}</p>}
					{routes && routes.length > 0 && usable.length === 0 && (
						<p style={{ color: 'var(--dispute)', fontSize: 13 }}>No route matches this delivery mode.</p>
					)}

					{chosen && (
						<div className="card tight">
							<div className="kv">
								<span className="k">Route</span>
								<span className="hops">
									{chosen.path.map((hop, index) => (
										<span key={`${hop}-${index}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
											{index > 0 ? <Icon name="arrow" size={12} /> : null}
											<span className={`hop${hop === self ? ' me' : ''}`}>{nameOf(hop)}</span>
										</span>
									))}
								</span>
							</div>
							<div className="kv">
								<span className="k">Fee</span>
								<span className={`v ${chosen.totalFee === 0n ? 'st-settled' : 'num'}`}>
									{chosen.totalFee === 0n ? 'Free' : `${formatMoney(chosen.totalFee, meta.decimals, 6)} ${meta.symbol}`}
								</span>
							</div>
							<div className="kv">
								<span className="k">Arrives</span>
								<span className="v st-settled">Instantly</span>
							</div>
							<div className="kv">
								<span className="k">Delivery</span>
								<span className="v">
									{DELIVERY_OPTIONS.find(option => option.value === deliveryMode)?.label}
									<button type="button" className="btn quiet" style={{ marginLeft: 8 }} onClick={() => setModeOpen(value => !value)}>
										Change
									</button>
								</span>
							</div>
							{modeOpen && (
								<div className="mode-grid fade-in" role="radiogroup" aria-label="Delivery" style={{ padding: '6px 0 10px' }}>
									{DELIVERY_OPTIONS.map(option => (
										<button
											key={option.value}
											type="button"
											role="radio"
											aria-checked={deliveryMode === option.value}
											className={`mode-card${deliveryMode === option.value ? ' active' : ''}`}
											onClick={() => {
												setDeliveryMode(option.value);
												setRouteIndex(0);
											}}
										>
											<span>
												{option.label}
												{option.recommended ? <span className="chip" style={{ marginLeft: 6 }}>Default</span> : null}
											</span>
											<span className="d">{option.description}</span>
										</button>
									))}
								</div>
							)}
							{usable.length > 1 && (
								<div className="stack" style={{ gap: 6, padding: '8px 0 10px' }}>
									<span className="caps">{usable.length} routes</span>
									{usable.map((route, index) => (
										<button key={route.path.join('>')} type="button" className={`route-card${route === chosen ? ' active' : ''}`} onClick={() => setRouteIndex(index)}>
											<span className="hops" style={{ justifyContent: 'flex-start' }}>
												{route.path.map((hop, hopIndex) => (
													<span key={`${hop}-${hopIndex}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
														{hopIndex > 0 ? <Icon name="arrow" size={12} /> : null}
														<span className={`hop${hop === self ? ' me' : ''}`}>{nameOf(hop)}</span>
													</span>
												))}
											</span>
											<span className="meta">
												<span>Fee {formatMoney(route.totalFee, meta.decimals, 6)}</span>
												<span>You send {formatMoney(route.senderAmount, meta.decimals)}</span>
											</span>
										</button>
									))}
								</div>
							)}
						</div>
					)}
					{modeError && <p style={{ color: 'var(--dispute)', fontSize: 12.5 }}>{modeError}</p>}

					<button type="button" className="btn quiet" style={{ alignSelf: 'flex-start' }} onClick={() => setNoteOpen(value => !value)}>
						{noteOpen ? 'Note' : 'Add a note'} <Icon name={noteOpen ? 'chevronDown' : 'chevronRight'} size={13} />
					</button>
					{noteOpen && (
						<div className="field fade-in">
							<input className="input" value={description} onChange={event => setDescription(event.target.value)} placeholder="What is this for?" />
						</div>
					)}

					<button
						type="button"
						className="btn"
						data-testid="pay-submit"
						disabled={!chosen || !parsedAmount || sending || Boolean(modeError) || !wallet.signerId}
						onClick={() => void send()}
					>
						<Icon name="pay" size={15} />
						{sending ? 'Sending…' : chosen && parsedAmount ? `Pay ${formatMoney(chosen.senderAmount, meta.decimals)} ${meta.symbol}` : 'Pay'}
					</button>
				</div>

				<div className="aside desktop-only">
					{chosen ? (
						<div className="card">
							<h3 className="caps">Route</h3>
							<div className="tl">
								{chosen.path.map((hop, index) => {
									const fee = chosen.hops[index - 1]?.fee ?? 0n;
									return (
										<div key={`${hop}-${index}`} className="ev done">
											<div className="t">
												{nameOf(hop)}
												{wallet.hubs.has(hop) ? <span className="chip hub">hub</span> : null}
											</div>
											<div className="s">
												{index === 0 ? wallet.jurisdiction || 'sender' : index === chosen.path.length - 1 ? shortId(hop, 10, 6) : `forwards atomically · fee ${formatMoney(fee, meta.decimals, 6)}`}
											</div>
										</div>
									);
								})}
							</div>
						</div>
					) : null}
					{hopAccount && hopToken && chosen ? (
						<BeforeAfter account={hopAccount} tokenId={tokenId} senderAmount={chosen.senderAmount} />
					) : null}
					<div className="card" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
						<span style={{ color: 'var(--coll)' }}>
							<Icon name="shield" size={20} />
						</span>
						<div className="note">
							<b style={{ color: 'var(--ink)', fontWeight: 600 }}>Provable.</b> A payment is a frame signed by both sides of each account it crosses.
							Collateral is enforceable on-chain if a counterparty ever defaults.
						</div>
					</div>
				</div>
			</div>

			{scanning && (
				<ScanSheet
					onClose={() => setScanning(false)}
					onDecode={value => {
						setScanning(false);
						if (!applyInvoice(value)) toast('That QR is not an xln invoice', 'danger');
					}}
				/>
			)}
		</div>
	);
}

/**
 * The account with the first hop before and after this payment. "After" is the
 * canonical deriveDelta over the same delta with Δ moved by the sender debit, so
 * the user sees which components the payment consumes.
 */
function BeforeAfter({ account, tokenId, senderAmount }: { account: AccountView; tokenId: number; senderAmount: bigint }) {
	const xln = peekXLN();
	const token = account.tokens.find(entry => entry.tokenId === tokenId);
	if (!xln || !token) return null;
	const meta = getTokenMeta(tokenId);
	const money = (value: bigint): string => formatMoney(value, meta.decimals);
	const shifted = { ...token.delta, offdelta: token.delta.offdelta + (account.isLeft ? -senderAmount : senderAmount) };
	let after;
	try {
		after = xln.deriveDelta(shifted, account.isLeft);
	} catch {
		return null;
	}
	const signedAfter = account.isLeft ? shifted.ondelta + shifted.offdelta : -(shifted.ondelta + shifted.offdelta);
	const collateralUsed = token.derived.outCollateral - after.outCollateral;
	const creditUsed = token.derived.outOwnCredit - after.outOwnCredit;
	const debtNetted = token.derived.outPeerCredit - after.outPeerCredit;
	const parts = [
		debtNetted > 0n ? `${money(debtNetted)} nets what ${account.label} owes you` : '',
		collateralUsed > 0n ? `${money(collateralUsed)} is covered by collateral` : '',
		creditUsed > 0n ? `${money(creditUsed)} goes on your credit line of ${money(token.derived.ownCreditLimit)}` : '',
	].filter(Boolean);
	return (
		<div className="card">
			<h3 className="caps">Your account with {account.label}</h3>
			<div className="kv" style={{ paddingTop: 0 }}>
				<span className="k">Before</span>
				<span className="v num">
					{money(token.signed)} <span className="muted" style={{ fontWeight: 400 }}>{token.signed >= 0n ? 'owes you' : 'you owe'}</span>
				</span>
			</div>
			<DeltaBar derived={token.derived} tokenId={tokenId} />
			<DeltaCaption derived={token.derived} format={money} />
			<div className="kv" style={{ marginTop: 14 }}>
				<span className="k">After</span>
				<span className="v num">
					{money(signedAfter)} <span className="muted" style={{ fontWeight: 400 }}>{signedAfter >= 0n ? 'owes you' : 'you owe'}</span>
				</span>
			</div>
			<DeltaBar derived={after} tokenId={tokenId} />
			<DeltaCaption derived={after} format={money} />
			{parts.length > 0 ? <p className="note" style={{ marginTop: 14 }}>{parts.join('. ')}. Nothing moves on-chain.</p> : null}
		</div>
	);
}
