import { useNavigate } from 'react-router-dom';
import { useMemo } from 'react';
import { Amount } from '../components/Amount';
import { CapacityBar } from '../components/CapacityBar';
import { Icon } from '../components/Icons';
import { useAdapterRead } from '../runtime/hooks';
import { useApp } from '../runtime/store';
import { formatAmount, getTokenMeta, shortId, timeAgo } from '../runtime/format';
import { displayEntityName, useAccounts, useEntityCore, usePortfolio } from '../runtime/views';
import type { RuntimeAdapterEntitySummary } from '@xln/runtime/api/runtime-adapter/types';

type HeadView = { latestHeight?: number; frameHash?: string; stateHash?: string } & Record<string, unknown>;
type ActivityView = {
	events?: Array<{ type?: string; kind?: string; timestamp?: number; height?: number; description?: string }>;
};

export function Home() {
	const navigate = useNavigate();
	const entityId = useApp(s => s.activeEntityId);
	const height = useApp(s => s.height);
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const setSelectedTokenId = useApp(s => s.setSelectedTokenId);

	const core = useEntityCore(entityId);
	const { accounts } = useAccounts(entityId);
	const portfolio = usePortfolio(core.data, accounts);
	const entities = useAdapterRead<RuntimeAdapterEntitySummary[]>('entities');
	const head = useAdapterRead<HeadView>('head');
	const activity = useAdapterRead<ActivityView>('activity', { limit: 4 });

	const names = useMemo(() => {
		const map = new Map<string, string>();
		for (const summary of entities.data ?? []) {
			if (summary.entityId && summary.label) map.set(summary.entityId.toLowerCase(), summary.label);
		}
		return map;
	}, [entities.data]);

	const tokenIds = portfolio.length > 0 ? portfolio.map(p => p.tokenId) : [selectedTokenId];
	const activeTokenId = tokenIds.includes(selectedTokenId) ? selectedTokenId : tokenIds[0]!;
	const activeToken = portfolio.find(p => p.tokenId === activeTokenId) ?? null;
	const meta = getTokenMeta(activeTokenId);
	const name = displayEntityName(core.data, entityId);

	const frameHash = String(head.data?.frameHash ?? head.data?.stateHash ?? core.data?.prevFrameHash ?? '');

	return (
		<div className="screen fade-in">
			<div className="screen-header">
				<span className="screen-title">{name}</span>
				<span className="status-pill">
					<span className="dot" />
					<span>
						local runtime · frame {height.toLocaleString('en-US')}
					</span>
				</span>
			</div>

			<div className="home-grid">
				<div>
					<div className="caps">Net position</div>
					<div className="home-balance">
						<Amount value={activeToken?.total ?? 0n} decimals={meta.decimals} symbol={meta.symbol} size={52} />
					</div>
					<div className="champagne-rule" style={{ margin: '18px 0 12px' }} />
					<p className="muted" style={{ fontSize: 13 }}>
						Reserve {formatAmount(activeToken?.reserve ?? 0n, meta.decimals, 2)} · Accounts{' '}
						{formatAmount(activeToken?.accountsNet ?? 0n, meta.decimals, 2)} · Spendable{' '}
						{formatAmount(activeToken?.spendable ?? 0n, meta.decimals, 2)}
					</p>

					{tokenIds.length > 1 && (
						<div className="token-switch" style={{ marginTop: 18 }}>
							{tokenIds.map(tokenId => (
								<button
									key={tokenId}
									type="button"
									className={tokenId === activeTokenId ? 'active' : ''}
									onClick={() => setSelectedTokenId(tokenId)}
								>
									{getTokenMeta(tokenId).symbol}
								</button>
							))}
						</div>
					)}

					<div className="home-actions">
						<button type="button" className="btn btn-primary" onClick={() => navigate('/pay')}>
							<Icon name="pay" size={15} /> Pay
						</button>
						<button type="button" className="btn btn-ghost" onClick={() => navigate('/receive')}>
							<Icon name="request" size={15} /> Request
						</button>
					</div>

					<div className="section-head">
						<span className="caps">Accounts</span>
						<span className="faint" style={{ fontSize: 12 }}>
							{accounts.length} open
						</span>
					</div>
					<div>
						{accounts.map(account => {
							const token = account.tokens.find(t => t.tokenId === activeTokenId) ?? account.tokens[0];
							const tokenMeta = getTokenMeta(token?.tokenId ?? activeTokenId);
							const label = names.get(account.counterpartyId) ?? shortId(account.counterpartyId);
							return (
								<button
									key={account.counterpartyId}
									type="button"
									className="row row-tappable"
									onClick={() => navigate(`/accounts/${account.counterpartyId}`)}
								>
									<span style={{ minWidth: 120 }}>
										<span style={{ display: 'block', fontSize: 13.5 }}>{label}</span>
										<span className="faint" style={{ display: 'block', fontSize: 11.5, marginTop: 2 }}>
											bilateral · {shortId(account.counterpartyId)}
										</span>
									</span>
									<span style={{ flex: 1, margin: '0 12px' }}>
										{token ? (
											<>
												<CapacityBar
													collateral={token.derived.collateral}
													creditUsed={token.derived.outOwnCredit}
													free={token.derived.outCapacity}
												/>
												<span className="faint" style={{ display: 'block', fontSize: 11, marginTop: 6 }}>
													{formatAmount(token.derived.outCapacity, tokenMeta.decimals, 2)} {tokenMeta.symbol} spendable ·{' '}
													{formatAmount(token.derived.inCapacity, tokenMeta.decimals, 2)} receivable
												</span>
											</>
										) : (
											<span className="faint" style={{ fontSize: 11 }}>
												No tokens yet
											</span>
										)}
									</span>
									<span className="display num" style={{ fontSize: 15 }}>
										{token ? formatAmount(token.signed, tokenMeta.decimals, 2) : '0'}
									</span>
								</button>
							);
						})}
						{accounts.length === 0 && !core.loading && (
							<p className="muted" style={{ padding: '18px 0', fontSize: 13 }}>
								No bilateral accounts yet.
							</p>
						)}
					</div>
				</div>

				<div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
					<div className="glass proof-panel">
						<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
							<span className="caps" style={{ color: 'var(--champagne)' }}>
								Sovereignty
							</span>
							<span style={{ color: 'var(--champagne)' }}>
								<Icon name="shield" size={15} />
							</span>
						</div>
						<div className="proof-row">
							<span className="muted">Runtime</span>
							<span>yours · local</span>
						</div>
						<div className="proof-row">
							<span className="muted">Frame</span>
							<span className="mono">#{height.toLocaleString('en-US')}</span>
						</div>
						<div className="proof-row">
							<span className="muted">State hash</span>
							<span className="mono">{frameHash ? shortId(frameHash, 8, 4) : '—'}</span>
						</div>
						<div className="proof-row">
							<span className="muted">Signer</span>
							<span className="mono">{core.data?.signerId ? shortId(core.data.signerId, 6, 4) : '—'}</span>
						</div>
					</div>

					<div className="glass proof-panel">
						<span className="caps" style={{ marginBottom: 8 }}>
							Activity
						</span>
						{(activity.data?.events ?? []).slice(0, 4).map((event, index) => (
							<div key={index} className="proof-row">
								<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
									{String(event.description || event.type || event.kind || 'Frame')}
								</span>
								<span className="faint" style={{ whiteSpace: 'nowrap' }}>
									{event.timestamp ? timeAgo(Number(event.timestamp)) : `#${event.height ?? ''}`}
								</span>
							</div>
						))}
						{(activity.data?.events?.length ?? 0) === 0 && (
							<p className="faint" style={{ fontSize: 12, padding: '10px 0' }}>
								Quiet so far.
							</p>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
