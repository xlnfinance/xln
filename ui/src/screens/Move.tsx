import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bar } from '../components/Bars';
import { Icon } from '../components/Icons';
import { PendingBatch } from '../components/PendingBatch';
import { TokenPicker } from '../components/TokenPicker';
import { useApp } from '../runtime/store';
import { formatMoney, getTokenMeta, parseAmount } from '../runtime/format';
import { usdOf } from '../runtime/financial/prices';
import {
	MOVE_ENDPOINTS,
	approveDepository,
	availableAt,
	awaitingCounterparty,
	buildMoveRouteSteps,
	depositoryAddress,
	externalTokens,
	hasSentBatch,
	isExternalTransferMoveRoute,
	isMoveRouteSupported,
	sendExternal,
	submitMove,
	validateMove,
	type MoveEndpoint,
	type MoveIntent,
	type MoveMode,
} from '../runtime/financial/move';
import { displayEntityName, useWallet } from '../runtime/views';

const PLACE_LABEL: Record<MoveEndpoint, { title: string; hint: string; kind: 'onchain' | 'reserve' | 'coll' }> = {
	external: { title: 'Wallet', hint: 'On-chain, in your signer', kind: 'onchain' },
	reserve: { title: 'Reserve', hint: 'Depository escrow', kind: 'reserve' },
	account: { title: 'Account', hint: 'Bilateral, instant', kind: 'coll' },
};

const isPlace = (value: string | null): value is MoveEndpoint => value === 'external' || value === 'reserve' || value === 'account';

/**
 * Move money between the three places it lives. Same routes and the same
 * entity transactions as the SvelteKit Move workspace: reserve legs queue in
 * the on-chain batch, account legs open a bilateral settlement.
 */
export function Move() {
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const entityId = useApp(s => s.activeEntityId);
	const toast = useApp(s => s.toast);
	const wallet = useWallet(entityId);
	const [from, setFrom] = useState<MoveEndpoint>(isPlace(params.get('from')) ? params.get('from') as MoveEndpoint : 'reserve');
	const [to, setTo] = useState<MoveEndpoint>(isPlace(params.get('to')) ? params.get('to') as MoveEndpoint : 'account');
	const [tokenId, setTokenId] = useState(Number(params.get('token') || 1) || 1);
	const [amountText, setAmountText] = useState('');
	const [sourceAccountId, setSourceAccountId] = useState(params.get('account')?.toLowerCase() ?? '');
	const [targetHubId, setTargetHubId] = useState(params.get('account')?.toLowerCase() ?? '');
	const [targetEntityId, setTargetEntityId] = useState('');
	const [reserveRecipientId, setReserveRecipientId] = useState('');
	const [externalRecipient, setExternalRecipient] = useState('');
	const [depository, setDepository] = useState('');
	const [busy, setBusy] = useState<MoveMode | 'approve' | 'direct' | null>(null);

	const meta = getTokenMeta(tokenId);
	const external = useMemo(() => externalTokens(wallet.frame, wallet.signerId, depository), [wallet.frame, wallet.signerId, depository]);
	const externalRow = external.find(row => row.tokenId === tokenId) ?? null;
	const accounts = wallet.accounts.filter(account => !account.disputed);
	const firstAccount = accounts[0]?.counterpartyId ?? '';
	useEffect(() => {
		if (!sourceAccountId && firstAccount) setSourceAccountId(firstAccount);
		if (!targetHubId && firstAccount) setTargetHubId(firstAccount);
	}, [firstAccount, sourceAccountId, targetHubId]);
	useEffect(() => {
		if (!wallet.entityId || !wallet.signerId) return;
		void depositoryAddress(wallet.entityId, wallet.signerId).then(setDepository);
	}, [wallet.entityId, wallet.signerId]);

	const amount = useMemo(() => {
		try {
			return parseAmount(amountText, meta.decimals);
		} catch {
			return 0n;
		}
	}, [amountText, meta.decimals]);
	const intent: MoveIntent = {
		from,
		to,
		tokenId,
		amount,
		sourceAccountId,
		targetEntityId: targetEntityId.trim().toLowerCase() || wallet.entityId,
		targetHubId,
		reserveRecipientId: reserveRecipientId.trim().toLowerCase() || wallet.entityId,
		externalRecipient: externalRecipient.trim(),
		tokenAddress: externalRow?.tokenAddress ?? '',
	};
	const available = availableAt(from, wallet, tokenId, sourceAccountId, external);
	const supported = isMoveRouteSupported(from, to);
	const direct = isExternalTransferMoveRoute(from, to);
	const check = (mode: MoveMode): string | null =>
		validateMove({
			intent,
			mode,
			self: wallet.entityId,
			selfSigner: wallet.signerId,
			available,
			awaiting: awaitingCounterparty(wallet.frame),
			sentBatch: hasSentBatch(wallet.frame),
			allowance: externalRow?.allowance ?? null,
		});
	const draftIssue = check('draft');
	const nowIssue = check('now');
	const needsAllowance = from === 'external' && !direct && amount > 0n && (externalRow?.allowance ?? 0n) < amount;
	const steps = buildMoveRouteSteps(from, to, {
		targetEntityLabel: intent.targetEntityId === wallet.entityId ? 'you' : displayEntityName(wallet.names, intent.targetEntityId),
		targetHubLabel: displayEntityName(wallet.names, targetHubId),
		reserveRecipientLabel: intent.reserveRecipientId === wallet.entityId ? 'your reserve' : displayEntityName(wallet.names, intent.reserveRecipientId),
		hasRemoteReserveRecipient: intent.reserveRecipientId !== wallet.entityId,
	});

	const go = async (mode: MoveMode): Promise<void> => {
		if (!wallet.signerId) return;
		setBusy(mode);
		try {
			await submitMove(wallet.entityId, wallet.signerId, intent, mode);
			toast(mode === 'draft' ? 'Added to the on-chain batch' : from === 'account' ? 'Settlement proposed to the counterparty' : 'Signed and sent to the chain');
			setAmountText('');
			if (mode === 'now') navigate('/');
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setBusy(null);
		}
	};
	const approve = async (): Promise<void> => {
		if (!wallet.signerId || !externalRow) return;
		setBusy('approve');
		try {
			await approveDepository(wallet.entityId, wallet.signerId, externalRow.tokenAddress, amount, tokenId);
			toast(`Depository may now pull ${formatMoney(amount, meta.decimals)} ${meta.symbol}`);
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setBusy(null);
		}
	};
	const sendDirect = async (): Promise<void> => {
		if (!wallet.signerId || !externalRow) return;
		setBusy('direct');
		try {
			const hash = await sendExternal(wallet.entityId, wallet.signerId, externalRow.tokenAddress, intent.externalRecipient, amount);
			toast(`Sent on-chain · ${hash.slice(0, 10)}…`);
			setAmountText('');
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setBusy(null);
		}
	};

	const placeAmount = (place: MoveEndpoint): bigint => availableAt(place, wallet, tokenId, place === 'account' ? sourceAccountId || firstAccount : '', external);

	const Place = ({ place, side }: { place: MoveEndpoint; side: 'from' | 'to' }) => {
		const active = side === 'from' ? from === place : to === place;
		const value = placeAmount(place);
		return (
			<button type="button" className={`mode-card${active ? ' active' : ''}`} onClick={() => (side === 'from' ? setFrom(place) : setTo(place))} data-testid={`move-${side}-${place}`}>
				<span className="t">{PLACE_LABEL[place].title}</span>
				<span className="s">{PLACE_LABEL[place].hint}</span>
				<span className="v num">
					{formatMoney(value, meta.decimals)} {meta.symbol}
				</span>
				<Bar segments={[{ usd: usdOf(tokenId, value), kind: PLACE_LABEL[place].kind }]} height={4} />
			</button>
		);
	};

	return (
		<div className="screen fade-in">
			<div className="screen-header">
				<span className="screen-title">
					<button type="button" className="icon-btn" onClick={() => navigate(-1)} aria-label="Back">
						<Icon name="chevronLeft" size={18} />
					</button>
					Move
				</span>
				<TokenPicker tokenId={tokenId} onChange={setTokenId} />
			</div>

			<div className="two-col pay">
				<div className="stack">
					<div>
						<div className="caps" style={{ marginBottom: 8 }}>
							From
						</div>
						<div className="mode-grid places">
							{MOVE_ENDPOINTS.map(place => (
								<Place key={`from-${place}`} place={place} side="from" />
							))}
						</div>
					</div>
					<div>
						<div className="caps" style={{ marginBottom: 8 }}>
							To
						</div>
						<div className="mode-grid places">
							{MOVE_ENDPOINTS.map(place => (
								<Place key={`to-${place}`} place={place} side="to" />
							))}
						</div>
					</div>

					<div className="field">
						<div className="field-head">
							<span>Amount</span>
							<button type="button" className="more" onClick={() => setAmountText(formatMoney(available, meta.decimals, meta.decimals).replace(/,/g, '').replace(/\.?0+$/, ''))}>
								up to {formatMoney(available, meta.decimals)} {meta.symbol}
							</button>
						</div>
						<input className="input big" placeholder="0.00" inputMode="decimal" value={amountText} onChange={event => setAmountText(event.target.value)} data-testid="move-amount" />
					</div>

					{from === 'account' ? (
						<div className="field">
							<span className="field-label">From your account with</span>
							<select className="input" value={sourceAccountId} onChange={event => setSourceAccountId(event.target.value)} data-testid="move-source-account">
								{accounts.map(account => (
									<option key={account.counterpartyId} value={account.counterpartyId}>
										{account.label}
									</option>
								))}
							</select>
						</div>
					) : null}
					{to === 'account' ? (
						<>
							<div className="field">
								<span className="field-label">Into an account with</span>
								<select className="input" value={targetHubId} onChange={event => setTargetHubId(event.target.value)} data-testid="move-target-hub">
									{accounts.map(account => (
										<option key={account.counterpartyId} value={account.counterpartyId}>
											{account.label}
										</option>
									))}
								</select>
							</div>
							<div className="field">
								<span className="field-label">Recipient entity · leave empty for yourself</span>
								<input className="input" placeholder="0x… entity id" value={targetEntityId} onChange={event => setTargetEntityId(event.target.value)} />
							</div>
						</>
					) : null}
					{to === 'reserve' ? (
						<div className="field">
							<span className="field-label">Whose reserve · leave empty for yours</span>
							<input className="input" placeholder="0x… entity id" value={reserveRecipientId} onChange={event => setReserveRecipientId(event.target.value)} />
						</div>
					) : null}
					{to === 'external' ? (
						<div className="field">
							<span className="field-label">Receiving wallet address</span>
							<input className="input" placeholder="0x…" value={externalRecipient} onChange={event => setExternalRecipient(event.target.value)} data-testid="move-external-recipient" />
						</div>
					) : null}

					{!supported ? <p style={{ color: 'var(--dispute)', fontSize: 13 }}>This route is not available.</p> : null}

					{direct ? (
						<button type="button" className="btn" disabled={busy !== null || Boolean(nowIssue)} onClick={() => void sendDirect()}>
							<Icon name="pay" size={15} />
							{busy === 'direct' ? 'Sending…' : 'Send from wallet'}
						</button>
					) : (
						<div className="actions">
							{needsAllowance ? (
								<button type="button" className="btn" disabled={busy !== null || amount <= 0n} onClick={() => void approve()} data-testid="move-approve">
									{busy === 'approve' ? 'Allowing…' : `Allow ${meta.symbol}`}
								</button>
							) : null}
							<button type="button" className="btn" disabled={busy !== null || Boolean(nowIssue) || needsAllowance} onClick={() => void go('now')} data-testid="move-now">
								<Icon name="check" size={15} />
								{busy === 'now' ? 'Sending…' : from === 'account' ? 'Propose settlement' : 'Sign & send'}
							</button>
							<button type="button" className="btn ghost" disabled={busy !== null || Boolean(draftIssue)} onClick={() => void go('draft')} data-testid="move-draft">
								{busy === 'draft' ? 'Adding…' : 'Add to batch'}
							</button>
						</div>
					)}
					{(amountText || from === 'external') && (nowIssue || draftIssue) ? (
						<p className="note" style={{ color: nowIssue ? 'var(--dispute)' : 'var(--ink-2)' }}>{nowIssue ?? draftIssue}</p>
					) : null}

					<PendingBatch wallet={wallet} compact />
				</div>

				<div className="aside">
					<div className="card">
						<h3 className="caps">What happens</h3>
						<div className="tl">
							{steps.map(step => (
								<div key={step} className="ev">
									<div className="t">{step.replace(/^\d+\.\s*/, '')}</div>
								</div>
							))}
						</div>
						<p className="note" style={{ marginTop: 12 }}>
							{from === 'account'
								? 'Leaving an account is a settlement both sides sign; the on-chain part follows in your batch.'
								: to === 'account'
									? 'Reserve to account posts collateral on-chain; the account can then be used instantly.'
									: 'Reserve moves settle in the next Depository batch you sign.'}
						</p>
					</div>
					{from === 'external' && external.length === 0 ? (
						<div className="card">
							<p className="note">No on-chain tokens observed for your signer yet. Deposits appear here once the runtime sees them on the chain.</p>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
