import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar, DeltaBar, Legend } from '../components/Bars';
import { Icon } from '../components/Icons';
import { Orderbook } from '../components/Orderbook';
import { PendingBatch } from '../components/PendingBatch';
import { useApp } from '../runtime/store';
import { formatMoney, formatSigned, formatUsd, getTokenMeta } from '../runtime/format';
import { usdOf } from '../runtime/financial/prices';
import { useOrderbook } from '../runtime/financial/orderbook';
import { USER_ACTIVITY_TYPES, useMovements } from '../runtime/financial/movements';
import { useWallet, type AccountView, type AccountTokenView } from '../runtime/views';
import { ActivityRow } from './Activity';

const USDC = 1;
const WETH = 2;

type Lane = { account: AccountView; token: AccountTokenView; secured: bigint; risk: bigint };

/**
 * The dense console for a wide screen: every lane of every account in one
 * table at the shared money scale, the hub's book beside it, the last
 * movements under it. Same data as Home, nothing folded away.
 */
export function Desk() {
	const navigate = useNavigate();
	const entityId = useApp(s => s.activeEntityId);
	const usdPerPx = useApp(s => s.usdPerPx);
	const fitScale = useApp(s => s.fitScale);
	const wallet = useWallet(entityId);
	const accountIds = useMemo(() => wallet.accounts.map(account => account.counterpartyId), [wallet.accounts]);
	const recent = useMovements(entityId, USER_ACTIVITY_TYPES, 40, accountIds);
	const hub = wallet.accounts.find(account => account.isHub) ?? null;
	const book = useOrderbook({ hubId: hub?.counterpartyId ?? '', tokenA: WETH, tokenB: USDC, ownEntityId: wallet.entityId, baseDecimals: getTokenMeta(WETH).decimals, depth: 8 });

	const lanes = useMemo<Lane[]>(() => {
		const out: Lane[] = [];
		for (const account of wallet.accounts) {
			for (const token of account.tokens) {
				const unsecured = token.signed > 0n ? (token.derived.outPeerCredit < token.signed ? token.derived.outPeerCredit : token.signed) : 0n;
				out.push({ account, token, secured: token.signed > 0n ? token.signed - unsecured : 0n, risk: unsecured });
			}
		}
		return out;
	}, [wallet.accounts]);

	const largest = useMemo(() => Math.max(wallet.usd.net, ...lanes.map(lane => usdOf(lane.token.tokenId, lane.token.derived.totalCapacity))), [wallet.usd.net, lanes]);
	useEffect(() => fitScale(largest), [largest, fitScale]);

	const money = (tokenId: number, value: bigint): string => formatMoney(value, getTokenMeta(tokenId).decimals);

	return (
		<div className="screen fade-in" data-testid="desk">
			<div className="screen-header">
				<span className="screen-title">
					<span className="avatar sm">{wallet.name.slice(0, 1).toUpperCase()}</span>
					<span>
						<span style={{ display: 'block', lineHeight: 1.2 }}>{wallet.name}</span>
						<span className="state st-settled" style={{ fontSize: 11 }}>
							frame #{wallet.frameHeight.toLocaleString('en-US')} · <span className="num">1 px = ${usdPerPx.toLocaleString('en-US')}</span>
						</span>
					</span>
				</span>
				<span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
					<span className="faint">
						<span className="kbd">⌘K</span> jump
					</span>
					<button type="button" className="btn sm" onClick={() => navigate('/pay')} data-testid="desk-pay">
						<Icon name="pay" size={14} /> Pay
					</button>
					<button type="button" className="btn sm" onClick={() => navigate('/swap')}>
						<Icon name="swap" size={14} /> Swap
					</button>
					<button type="button" className="btn sm" onClick={() => navigate('/move')}>
						<Icon name="arrow" size={14} /> Move
					</button>
					<button type="button" className="icon-btn" onClick={() => navigate('/sovereignty')} aria-label="Sovereignty" title="Keys, proofs, what is at risk">
						<Icon name="shield" size={18} />
					</button>
				</span>
			</div>

			<div className="desk-stat">
				<div className="card">
					<div className="k">Net</div>
					<div className="v num display" data-testid="desk-net">
						{formatUsd(wallet.usd.net)}
					</div>
				</div>
				<div className="card">
					<div className="k">Yours on-chain</div>
					<div className="v num" style={{ color: 'var(--reserve)' }}>
						{formatUsd(wallet.usd.onchain + wallet.usd.reserve + wallet.usd.secured)}
					</div>
				</div>
				<div className="card">
					<div className="k">At risk</div>
					<div className="v num" style={{ color: 'var(--risk)' }}>
						{formatUsd(wallet.usd.risk)}
					</div>
				</div>
				<div className="card">
					<div className="k">Instant send · receive</div>
					<div className="v num" style={{ fontSize: 18 }}>
						{formatUsd(wallet.usd.sendCapacity)} · {formatUsd(wallet.usd.receiveCapacity)}
					</div>
				</div>
			</div>

			<div className="desk-grid">
				<div>
					<PendingBatch wallet={wallet} compact />
					<div className="card" style={{ padding: 0, overflowX: 'auto' }}>
						<table className="desk-table" data-testid="desk-table">
							<thead>
								<tr>
									<th>Account · lane</th>
									<th>Position</th>
									<th>Secured</th>
									<th>At risk</th>
									<th>You owe</th>
									<th>Send · receive</th>
									<th>Lines out · in</th>
									<th>Frame</th>
									<th className="bar-cell">−send ‖ receive+</th>
								</tr>
							</thead>
							<tbody>
								{lanes.map(({ account, token, secured, risk }) => {
									const d = token.derived;
									const owed = token.signed < 0n ? -token.signed : 0n;
									return (
										<tr key={`${account.counterpartyId}-${token.tokenId}`} className="tappable" onClick={() => navigate(`/accounts/${account.counterpartyId}`)}>
											<td>
												<span style={{ fontWeight: 500 }}>{account.label}</span>
												{account.isHub ? <span className="chip hub" style={{ marginLeft: 6 }}>hub</span> : null}
												{account.dispute !== 'none' ? <span className="state st-dispute" style={{ marginLeft: 6 }}>dispute</span> : null}
												{account.settlement === 'awaiting_you' ? <span className="state st-pending" style={{ marginLeft: 6 }}>sign</span> : null}
												<span className="faint"> · {getTokenMeta(token.tokenId).symbol}</span>
											</td>
											<td className={`num ${token.signed > 0n ? 'st-settled' : token.signed < 0n ? 'st-pending' : ''}`}>{formatSigned(token.signed, getTokenMeta(token.tokenId).decimals)}</td>
											<td className="num" style={{ color: 'var(--coll)' }}>{secured > 0n ? money(token.tokenId, secured) : '·'}</td>
											<td className="num" style={{ color: risk > 0n ? 'var(--risk)' : undefined }}>{risk > 0n ? money(token.tokenId, risk) : '·'}</td>
											<td className="num" style={{ color: owed > 0n ? 'var(--debt)' : undefined }}>{owed > 0n ? money(token.tokenId, owed) : '·'}</td>
											<td className="num faint">
												{money(token.tokenId, d.outCapacity)} · {money(token.tokenId, d.inCapacity)}
											</td>
											<td className="num faint">
												{money(token.tokenId, d.peerCreditLimit)} · {money(token.tokenId, d.ownCreditLimit)}
											</td>
											<td className="num faint">#{account.frameHeight.toLocaleString('en-US')}</td>
											<td className="bar-cell">
												<DeltaBar derived={d} tokenId={token.tokenId} />
											</td>
										</tr>
									);
								})}
								{lanes.length === 0 && !wallet.loading ? (
									<tr>
										<td colSpan={9} className="note" style={{ textAlign: 'left' }}>
											No accounts yet. Open one from Home.
										</td>
									</tr>
								) : null}
							</tbody>
							<tfoot>
								<tr>
									<td>Reserve · on-chain</td>
									<td className="num">{formatUsd(wallet.usd.reserve + wallet.usd.onchain)}</td>
									<td className="num" style={{ color: 'var(--coll)' }}>{formatUsd(wallet.usd.secured)}</td>
									<td className="num" style={{ color: 'var(--risk)' }}>{formatUsd(wallet.usd.risk)}</td>
									<td className="num" style={{ color: 'var(--debt)' }}>{formatUsd(wallet.usd.owed)}</td>
									<td className="num faint">
										{formatUsd(wallet.usd.sendCapacity)} · {formatUsd(wallet.usd.receiveCapacity)}
									</td>
									<td />
									<td />
									<td className="bar-cell">
										<Bar
											segments={[
												{ usd: wallet.usd.onchain, kind: 'onchain' },
												{ usd: wallet.usd.reserve, kind: 'reserve' },
												{ usd: wallet.usd.secured, kind: 'coll' },
												{ usd: wallet.usd.risk, kind: 'risk' },
											]}
											height={4}
										/>
									</td>
								</tr>
							</tfoot>
						</table>
					</div>
					<div style={{ margin: '10px 0 0' }}>
						<Legend places />
					</div>
				</div>
				<div>
					{hub ? (
						<div className="card" style={{ padding: 0 }}>
							<Orderbook book={book} hubLabel={hub.label} onPick={() => navigate(`/swap?hub=${hub.counterpartyId}`)} />
						</div>
					) : null}
					<div className="card">
						<h3 className="caps">Recent</h3>
						{recent.movements.slice(0, 8).map((movement, index) => (
							<ActivityRow key={movement.id} movement={movement} names={wallet.names} first={index === 0} />
						))}
						{recent.movements.length === 0 && !recent.loading ? (
							<p className="note" style={{ padding: '6px 0' }}>
								Quiet so far.
							</p>
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}
