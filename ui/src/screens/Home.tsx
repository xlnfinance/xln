import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UsdAmount } from '../components/Amount';
import { Bar, DeltaBar, DeltaCaption } from '../components/Bars';
import { Icon } from '../components/Icons';
import { Sheet } from '../components/Sheet';
import { TokenIcon } from '../components/TokenPicker';
import { useApp } from '../runtime/store';
import { DEFAULT_ACCOUNT_DISPUTE_CONFIG, sendEntityTxs } from '../runtime/tx';
import { formatMoney, formatSigned, formatUsd, getTokenMeta, parseAmount, shortId } from '../runtime/format';
import { isUsdStable, usdOf } from '../runtime/financial/prices';
import { useWallet, type AccountView, type TokenTotals, type WalletView } from '../runtime/views';
import { USER_ACTIVITY_TYPES, useMovements } from '../runtime/financial/movements';
import { ActivityRow } from './Activity';

export function Home() {
	const entityId = useApp(s => s.activeEntityId);
	const places = useApp(s => s.places);
	const wallet = useWallet(entityId);
	const navigate = useNavigate();
	const [open, setOpen] = useState<Set<number>>(() => new Set());
	const [opening, setOpening] = useState(false);

	const accountIds = useMemo(() => wallet.accounts.map(account => account.counterpartyId), [wallet.accounts]);
	const recent = useMovements(entityId, USER_ACTIVITY_TYPES, 40, accountIds);
	const recentMovements = recent.movements.slice(0, 4);

	const activeTotals = useMemo(() => wallet.totals.filter(total => total.active), [wallet.totals]);

	const toggle = (tokenId: number): void =>
		setOpen(current => {
			const next = new Set(current);
			if (next.has(tokenId)) next.delete(tokenId);
			else next.add(tokenId);
			return next;
		});

	const heroSegments = [
		{ usd: places.onchain ? wallet.usd.onchain : 0, kind: 'slate' as const },
		{ usd: places.reserve ? wallet.usd.reserve : 0, kind: 'coll' as const },
		{ usd: places.reserve ? wallet.usd.pending : 0, kind: 'pend' as const },
		{ usd: places.accounts ? wallet.usd.receivable : 0, kind: 'credit' as const },
	];
	const visibleNet =
		(places.onchain ? wallet.usd.onchain : 0) +
		(places.reserve ? wallet.usd.reserve : 0) +
		(places.accounts ? wallet.usd.receivable - wallet.usd.owed : 0);

	return (
		<div className="screen fade-in">
			<div className="screen-header">
				<span className="screen-title">
					<span className="avatar sm">{wallet.name.slice(0, 1).toUpperCase()}</span>
					<span>
						<span style={{ display: 'block', lineHeight: 1.2 }}>{wallet.name}</span>
						<span className="state st-settled" style={{ fontSize: 11 }} data-testid="home-frame">
							synced · frame {wallet.frameHeight.toLocaleString('en-US')}
						</span>
					</span>
				</span>
				<span className="hash" style={{ display: 'none' }} data-testid="home-entity-id">
					{wallet.entityId}
				</span>
			</div>

			<div className="two-col">
				<div>
					<div className="hero">
						<div className="hero-label">Total balance</div>
						<UsdAmount value={visibleNet} size={52} testId="home-total" />
						<div className="rb">
							<Bar segments={heroSegments} height={8} />
						</div>
						<div className="tiers">
							{places.onchain && (
								<span>
									<i className="sw c-slate" />
									On-chain <b className="num">{formatUsd(wallet.usd.onchain)}</b>
								</span>
							)}
							{places.reserve && (
								<span>
									<i className="sw c-coll" />
									Reserve <b className="num">{formatUsd(wallet.usd.reserve)}</b>
									{wallet.usd.pending > 0 ? <span className="st-pending num"> +{formatUsd(wallet.usd.pending)} pending</span> : null}
								</span>
							)}
							{places.accounts && (
								<span>
									<i className="sw c-credit" />
									Accounts <b className="num">{formatUsd(wallet.usd.receivable)}</b>
									{wallet.usd.owed > 0 ? (
										<span className="num" style={{ color: 'var(--ink-3)' }}>
											{' '}
											owed {formatUsd(wallet.usd.owed)}
										</span>
									) : null}
								</span>
							)}
						</div>
						{places.accounts && (
							<div className="tiers" style={{ marginTop: 8 }}>
								<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
									<span style={{ color: 'var(--accent-2)', display: 'inline-flex' }}>
										<Icon name="bolt" size={13} />
									</span>
									<span data-testid="home-send-capacity">
										Instant: send up to <b className="num">{formatUsd(wallet.usd.sendCapacity)}</b>, receive up to{' '}
										<b className="num">{formatUsd(wallet.usd.receiveCapacity)}</b>
									</span>
								</span>
							</div>
						)}
					</div>

					<div className="actions">
						<button type="button" className="btn primary" onClick={() => navigate('/pay')} data-testid="home-pay">
							<Icon name="pay" size={18} />
							Pay
						</button>
						<button type="button" className="btn" onClick={() => navigate('/receive')} data-testid="home-receive">
							<Icon name="receive" size={18} />
							Receive
						</button>
						<button type="button" className="btn" onClick={() => navigate('/swap')} data-testid="home-swap">
							<Icon name="swap" size={18} />
							Swap
						</button>
					</div>

					<div className="sect">
						<h3 className="caps">Balances</h3>
						<span className="more">
							{activeTotals.length} {activeTotals.length === 1 ? 'token' : 'tokens'}
							{wallet.totals.length > activeTotals.length ? ` · ${wallet.totals.length - activeTotals.length} empty hidden` : ''}
						</span>
					</div>
					{activeTotals.map((total, index) => (
						<TokenRow
							key={total.tokenId}
							total={total}
							wallet={wallet}
							first={index === 0}
							open={open.has(total.tokenId)}
							onToggle={() => toggle(total.tokenId)}
							onAccount={counterpartyId => navigate(`/accounts/${counterpartyId}`)}
						/>
					))}
					{activeTotals.length === 0 && !wallet.loading && (
						<p className="note" style={{ padding: '18px 0' }}>
							Nothing here yet. Receive a payment or open an account with a hub to start.
						</p>
					)}
				</div>

				<div className="aside">
					<div className="card" data-testid="home-accounts">
						<h3 className="caps">Accounts</h3>
						{wallet.accounts.map((account, index) => (
							<AccountRow key={account.counterpartyId} account={account} first={index === 0} onClick={() => navigate(`/accounts/${account.counterpartyId}`)} />
						))}
						{wallet.accounts.length === 0 && !wallet.loading && (
							<p className="note" style={{ padding: '6px 0 10px' }}>
								No bilateral accounts yet.
							</p>
						)}
						<button type="button" className="btn ghost sm" style={{ marginTop: 12 }} onClick={() => setOpening(true)}>
							<Icon name="plus" size={15} />
							Open account
						</button>
					</div>

					<div className="card">
						<h3 className="caps">Recent</h3>
						{recentMovements.map((movement, index) => (
							<ActivityRow key={movement.id} movement={movement} names={wallet.names} first={index === 0} />
						))}
						{recentMovements.length === 0 && !recent.loading && (
							<p className="note" style={{ padding: '6px 0' }}>
								Quiet so far.
							</p>
						)}
						{recentMovements.length > 0 && (
							<button type="button" className="btn quiet" style={{ marginTop: 10 }} onClick={() => navigate('/activity')}>
								All activity
							</button>
						)}
					</div>
				</div>
			</div>

			{opening && <OpenAccountSheet wallet={wallet} onClose={() => setOpening(false)} />}
		</div>
	);
}

function TokenRow({
	total,
	wallet,
	first,
	open,
	onToggle,
	onAccount,
}: {
	total: TokenTotals;
	wallet: WalletView;
	first: boolean;
	open: boolean;
	onToggle: () => void;
	onAccount: (counterpartyId: string) => void;
}) {
	const places = useApp(s => s.places);
	const meta = getTokenMeta(total.tokenId);
	const money = (value: bigint): string => formatMoney(value, meta.decimals);
	const segments = [
		{ usd: places.onchain ? usdOf(total.tokenId, total.onchain) : 0, kind: 'slate' as const },
		{ usd: places.reserve ? usdOf(total.tokenId, total.reserve) : 0, kind: 'coll' as const },
		{ usd: places.reserve ? usdOf(total.tokenId, total.pending) : 0, kind: 'pend' as const },
		{ usd: places.accounts ? usdOf(total.tokenId, total.receivable) : 0, kind: 'credit' as const },
	];
	const visibleNet =
		(places.onchain ? total.onchain : 0n) + (places.reserve ? total.reserve : 0n) + (places.accounts ? total.receivable + total.owed : 0n);
	const accounts = wallet.accounts.filter(account => account.tokens.some(token => token.tokenId === total.tokenId));

	return (
		<div className={`row${first ? ' first' : ''}`} data-testid={`token-row-${meta.symbol}`}>
			<button type="button" className="rt" style={{ width: '100%', textAlign: 'left' }} onClick={onToggle} aria-expanded={open}>
				<TokenIcon tokenId={total.tokenId} />
				<span className="tx">
					<span className="t">
						{meta.symbol}
						{total.jurisdictions.map(name => (
							<span key={name} className="chip">
								{name}
							</span>
						))}
					</span>
					<span className="s">
						{meta.name}
						{places.accounts && total.owed < 0n ? (
							<>
								{' · '}
								<span className="st-pending num">you owe {money(-total.owed)}</span>
							</>
						) : null}
					</span>
				</span>
				<span className="r">
					<span className="v num" data-testid={`token-net-${meta.symbol}`}>
						{money(visibleNet)}
					</span>
					<span className="u num">
						{isUsdStable(total.tokenId) ? '' : `≈ ${formatUsd(usdOf(total.tokenId, visibleNet))}`}
						{places.reserve && total.pending > 0n ? <span className="st-pending"> +{money(total.pending)} pending</span> : null}
					</span>
				</span>
				<span className="chev">
					<Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
				</span>
			</button>
			<div className="rb">
				<Bar segments={segments} />
			</div>
			{open && (
				<div className="fade-in">
					{places.onchain &&
						wallet.onchain
							.filter(row => row.tokenId === total.tokenId)
							.map(row => (
								<div key={`onchain-${row.jurisdiction}`} className="sub">
									<div className="rt">
										<span className="tx">
											<span className="t">On-chain{row.jurisdiction ? ` · ${row.jurisdiction}` : ''}</span>
											<span className="s">Your wallet</span>
										</span>
										<span className="r">
											<span className="v num">{money(row.amount)}</span>
										</span>
									</div>
									<div className="rb">
										<Bar segments={[{ usd: usdOf(total.tokenId, row.amount), kind: 'slate' }]} height={4} />
									</div>
								</div>
							))}
					{places.reserve &&
						wallet.reserves
							.filter(row => row.tokenId === total.tokenId)
							.map(row => (
								<div key={`reserve-${row.jurisdiction}`} className="sub">
									<div className="rt">
										<span className="tx">
											<span className="t">Reserve{row.jurisdiction ? ` · ${row.jurisdiction}` : ''}</span>
											<span className="s">
												Depository escrow
												{row.pending > 0n ? (
													<>
														{' · '}
														<span className="st-pending num">{money(row.pending)} depositing</span>
													</>
												) : null}
											</span>
										</span>
										<span className="r">
											<span className="v num">{money(row.amount)}</span>
										</span>
									</div>
									<div className="rb">
										<Bar
											segments={[
												{ usd: usdOf(total.tokenId, row.amount), kind: 'coll' },
												{ usd: usdOf(total.tokenId, row.pending), kind: 'pend' },
											]}
											height={4}
										/>
									</div>
								</div>
							))}
					{places.accounts &&
						accounts.map(account => {
							const token = account.tokens.find(entry => entry.tokenId === total.tokenId);
							if (!token) return null;
							return (
								<button
									key={account.counterpartyId}
									type="button"
									className="sub"
									style={{ width: '100%', textAlign: 'left', display: 'block' }}
									onClick={() => onAccount(account.counterpartyId)}
								>
									<div className="rt">
										<span className="tx">
											<span className="t">
												{account.label}
												{account.isHub ? <span className="chip hub">hub</span> : null}
												{wallet.jurisdiction ? <span className="faint">· {wallet.jurisdiction}</span> : null}
											</span>
											<span className="s">{token.signed > 0n ? 'owes you' : token.signed < 0n ? 'you owe' : 'even'}</span>
										</span>
										<span className="r">
											<span className="v num">{formatSigned(token.signed, meta.decimals)}</span>
										</span>
									</div>
									<div className="rb">
										<DeltaBar derived={token.derived} tokenId={total.tokenId} />
										<DeltaCaption derived={token.derived} format={money} />
									</div>
								</button>
							);
						})}
				</div>
			)}
		</div>
	);
}

function AccountRow({ account, first, onClick }: { account: AccountView; first: boolean; onClick: () => void }) {
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const token = account.tokens.find(entry => entry.tokenId === selectedTokenId) ?? account.tokens[0];
	const meta = getTokenMeta(token?.tokenId ?? selectedTokenId);
	const hold = token?.derived.outTotalHold ?? 0n;
	return (
		<button type="button" className={`row tappable${first ? ' first' : ''}`} onClick={onClick} data-testid="account-row">
			<span className="rt">
				<span className="avatar">{account.label.slice(0, 1).toUpperCase()}</span>
				<span className="tx">
					<span className="t">
						{account.label}
						{account.isHub ? <span className="chip hub">hub</span> : null}
						{account.disputed ? <span className="state st-dispute">dispute</span> : null}
					</span>
					<span className="s">
						{meta.symbol}
						{hold > 0n ? (
							<>
								{' · '}
								<span className="st-inflight num">{formatMoney(hold, meta.decimals)} in flight</span>
							</>
						) : null}
					</span>
				</span>
				<span className="r">
					<span className="v num">{token ? formatSigned(token.signed, meta.decimals) : '—'}</span>
					<span className="u">{token ? (token.signed > 0n ? 'owes you' : token.signed < 0n ? 'you owe' : 'even') : 'no tokens'}</span>
				</span>
			</span>
			{token ? (
				<span className="rb" style={{ display: 'block' }}>
					<DeltaBar derived={token.derived} tokenId={token.tokenId} />
					<DeltaCaption derived={token.derived} format={value => formatMoney(value, meta.decimals)} />
				</span>
			) : null}
		</button>
	);
}

function OpenAccountSheet({ wallet, onClose }: { wallet: WalletView; onClose: () => void }) {
	const toast = useApp(s => s.toast);
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const [targetId, setTargetId] = useState('');
	const [creditText, setCreditText] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const meta = getTokenMeta(selectedTokenId);
	const existing = new Set(wallet.accounts.map(account => account.counterpartyId));
	const candidates = wallet.summaries
		.map(summary => summary.entityId.toLowerCase())
		.filter(id => id && id !== wallet.entityId && !existing.has(id));

	const openAccount = async (): Promise<void> => {
		if (!wallet.entityId || !wallet.signerId || !targetId) return;
		setSubmitting(true);
		try {
			const creditAmount = creditText.trim() ? parseAmount(creditText, meta.decimals) : 0n;
			await sendEntityTxs(wallet.entityId, wallet.signerId, [
				{
					type: 'openAccount',
					data: { targetEntityId: targetId, creditAmount, tokenId: selectedTokenId, disputeConfig: DEFAULT_ACCOUNT_DISPUTE_CONFIG },
				},
			]);
			toast('Account proposed');
			onClose();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Sheet title="Open account" onClose={onClose}>
			<div className="field">
				<span className="field-label">Counterparty</span>
				{candidates.map(id => (
					<button
						key={id}
						type="button"
						className={`picker-option${targetId === id ? ' active' : ''}`}
						style={{ padding: '10px 10px' }}
						onClick={() => setTargetId(id)}
					>
						<span className="t">
							{wallet.names.get(id) || 'Entity'}
							{wallet.hubs.has(id) ? <span className="chip hub">hub</span> : null}
						</span>
						<span className="hash">{shortId(id, 10, 6)}</span>
					</button>
				))}
				<input
					className="input mono"
					placeholder="or paste an entity id, 0x…"
					value={targetId}
					onChange={event => setTargetId(event.target.value.trim().toLowerCase())}
					spellCheck={false}
				/>
			</div>
			<div className="field">
				<span className="field-label">Credit line you extend · optional</span>
				<div className="field-row">
					<input className="input" placeholder="0.00" inputMode="decimal" value={creditText} onChange={event => setCreditText(event.target.value)} />
					<span className="muted">{meta.symbol}</span>
				</div>
				<p className="note">Credit lets them owe you up to this amount, so they can pay you without pre-funding.</p>
			</div>
			<button type="button" className="btn" disabled={!/^0x[0-9a-f]{64}$/.test(targetId) || submitting} onClick={() => void openAccount()}>
				{submitting ? 'Proposing…' : 'Propose account'}
			</button>
		</Sheet>
	);
}
