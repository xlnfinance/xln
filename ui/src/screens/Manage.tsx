import { useNavigate } from 'react-router-dom';
import { isAccountTxKindAvailable } from '@xln/core/account/tx/admission-policy';
import { Icon, type IconName } from '../components/Icons';
import { PageHead } from '../components/PageHead';
import { PendingBatch } from '../components/PendingBatch';
import { useApp } from '../runtime/store';
import { formatMoney, formatUsd, getTokenMeta } from '../runtime/format';
import { useWallet } from '../runtime/views';
import { debtGroups } from '../runtime/financial/debts';

/**
 * Everything on the SvelteKit main page that is not paying, receiving or
 * trading: on-chain batch, accounts needing attention (signatures, disputes),
 * debts, and the doors to assets, lending and ownership.
 */
export function Manage() {
	const navigate = useNavigate();
	const entityId = useApp(s => s.activeEntityId);
	const wallet = useWallet(entityId);
	const debts = debtGroups(wallet.frame);
	const needsSignature = wallet.accounts.filter(account => account.settlement === 'awaiting_you');
	const settling = wallet.accounts.filter(account => account.settlement !== 'none' && account.settlement !== 'awaiting_you');
	const disputed = wallet.accounts.filter(account => account.dispute !== 'none' && account.dispute !== 'closed');
	const owed = debts.owed.reduce((sum, group) => sum + group.outstanding, 0n);

	const doors: Array<{ to: string; icon: IconName; title: string; hint: string; testId: string }> = [
		{ to: '/sovereignty', icon: 'shield', title: 'Security and recovery', hint: 'Keys, proofs, what is at risk', testId: 'manage-sovereignty' },
		{ to: '/move', icon: 'arrow', title: 'Move', hint: 'Wallet ↔ reserve ↔ accounts', testId: 'manage-move' },
		{ to: '/assets', icon: 'wallet', title: 'Assets', hint: 'On-chain wallet, faucets, debts', testId: 'manage-assets' },
		{ to: '/lend', icon: 'bank', title: 'Lending', hint: isAccountTxKindAvailable('lending_fund') && isAccountTxKindAvailable('lending_borrow_request') ? 'Lend to a hub pool or borrow' : 'Unavailable in this release · view existing positions', testId: 'manage-lend' },
		{ to: '/ownership', icon: 'accounts', title: 'Ownership', hint: 'Board, shares, takeovers', testId: 'manage-ownership' },
		{ to: '/manage/custom-contracts', icon: 'bolt', title: 'Custom contracts', hint: 'Experimental Solidity rules · experts only', testId: 'manage-custom-contracts' },
	];

	return (
		<div className="screen fade-in">
			<PageHead
				title="Manage"
				eyebrow={`Wallet${wallet.jurisdiction ? ` · ${wallet.jurisdiction}` : ''}`}
				sub="Keys, collateral, on-chain funds and everything that is not a payment."
			/>
			<div className="doors">
				{doors.map(door => (
					<button key={door.to} type="button" className="door" onClick={() => navigate(door.to)} data-testid={door.testId}>
						<span className="resource-ic">
							<Icon name={door.icon} size={16} />
						</span>
						<span>
							<span className="t">{door.title}</span>
							<span className="s" style={{ display: 'block' }}>{door.hint}</span>
						</span>
					</button>
				))}
			</div>
			<div className="two-col">
				<div className="stack" style={{ gap: 20 }}>
					<PendingBatch wallet={wallet} />

					<div className="card" data-testid="manage-position">
						<h3 className="caps">Where your money stands</h3>
						<div className="kv"><span className="k">Total</span><span className="v num">{formatUsd(wallet.usd.net)}</span></div>
						<div className="kv"><span className="k">Enforceable on-chain</span><span className="v num" style={{ color: 'var(--coll)' }}>{formatUsd(wallet.usd.onchain + wallet.usd.reserve + wallet.usd.secured)}</span></div>
						<div className="kv"><span className="k">At risk · no collateral</span><span className="v num" style={{ color: 'var(--risk)' }}>{formatUsd(wallet.usd.risk)}</span></div>
						<div className="kv"><span className="k">You owe</span><span className="v num">{formatUsd(wallet.usd.owed)}</span></div>
						<p className="note">Enforceable is yours whatever a hub does: on-chain, in your reserve or locked as collateral. At risk is a hub&apos;s promise with nothing locked behind it; cover it with collateral or dispute if the hub misbehaves.</p>
					</div>
					<div className="card" data-testid="attention">
						<h3 className="caps">Needs attention</h3>
						{needsSignature.length === 0 && disputed.length === 0 && settling.length === 0 && owed === 0n ? (
							<p className="note" style={{ marginTop: 8 }}>
								Nothing waiting on you.
							</p>
						) : null}
						{needsSignature.map(account => (
							<button key={`sign-${account.counterpartyId}`} type="button" className="row tappable" onClick={() => navigate(`/accounts/${account.counterpartyId}`)} data-testid="attention-sign">
								<span className="rt">
									<span className="tx">
										<span className="t">Sign the settlement with {account.label}</span>
										<span className="s">They proposed; your signature lets it go on-chain.</span>
									</span>
									<span className="chev">
										<Icon name="chevronRight" size={16} />
									</span>
								</span>
							</button>
						))}
						{settling.map(account => (
							<button key={`settle-${account.counterpartyId}`} type="button" className="row tappable" onClick={() => navigate(`/accounts/${account.counterpartyId}`)}>
								<span className="rt">
									<span className="tx">
										<span className="t">Settlement with {account.label}</span>
										<span className="s">{account.settlement === 'awaiting_them' ? 'Waiting for their signature.' : account.settlement === 'submitted' ? 'On the chain, waiting for confirmation.' : 'Both signed, going on-chain.'}</span>
									</span>
									<span className="chev">
										<Icon name="chevronRight" size={16} />
									</span>
								</span>
							</button>
						))}
						{disputed.map(account => (
							<button key={`dispute-${account.counterpartyId}`} type="button" className="row tappable" onClick={() => navigate(`/accounts/${account.counterpartyId}`)} data-testid="attention-dispute">
								<span className="rt">
									<span className="tx">
										<span className="t">
											<span className="state st-dispute">dispute</span> {account.label}
										</span>
										<span className="s">
											{account.dispute === 'active'
												? 'On-chain challenge window open.'
												: account.dispute === 'queued'
													? 'Dispute start waits in your batch.'
													: account.dispute === 'sent'
														? 'Dispute start sent; waiting for the chain.'
														: 'Preparing: orders withdrawn, traffic frozen.'}
										</span>
									</span>
									<span className="chev">
										<Icon name="chevronRight" size={16} />
									</span>
								</span>
							</button>
						))}
						{owed > 0n ? (
							<button type="button" className="row tappable" onClick={() => navigate('/assets')} data-testid="attention-debt">
								<span className="rt">
									<span className="tx">
										<span className="t">Debts on the Depository</span>
										<span className="s">
											{debts.owed.map(group => `${formatMoney(group.outstanding, getTokenMeta(group.tokenId).decimals)} ${getTokenMeta(group.tokenId).symbol}`).join(' · ')} owed
										</span>
									</span>
									<span className="chev">
										<Icon name="chevronRight" size={16} />
									</span>
								</span>
							</button>
						) : null}
					</div>
				</div>
				<div className="aside">
					<div className="card">
						<h3 className="caps">Accounts</h3>
						{wallet.accounts.map((account, index) => (
							<button key={account.counterpartyId} type="button" className={`row tappable${index === 0 ? ' first' : ''}`} onClick={() => navigate(`/accounts/${account.counterpartyId}`)}>
								<span className="rt">
									<span className="avatar">{account.label.slice(0, 1).toUpperCase()}</span>
									<span className="tx">
										<span className="t">
											{account.label}
											{account.isHub ? <span className="chip hub">hub</span> : null}
										</span>
										<span className="s">
											{account.tokens.length} {account.tokens.length === 1 ? 'lane' : 'lanes'} · {account.frameHeight.toLocaleString('en-US')} frames ·{' '}
											{account.dispute === 'closed' ? 'closed' : account.dispute !== 'none' ? 'disputed' : account.settlement === 'none' ? 'open' : 'settling'}
										</span>
									</span>
									<span className="chev">
										<Icon name="chevronRight" size={16} />
									</span>
								</span>
							</button>
						))}
						{wallet.accounts.length === 0 && !wallet.loading ? (
							<p className="note" style={{ padding: '6px 0' }}>
								No accounts yet. Open one from Home.
							</p>
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}
