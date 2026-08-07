import { useNavigate } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { Amount } from '../components/Amount';
import { DeltaBar } from '../components/DeltaBar';
import { Icon } from '../components/Icons';
import { useAdapterRead } from '../runtime/hooks';
import { useApp } from '../runtime/store';
import { demoFaucet, getDemoTopology } from '../runtime/sandbox';
import { formatAmount, getTokenMeta, parseAmount, timeAgo } from '../runtime/format';
import { displayEntityName, useAccounts, useEntityCore, usePortfolio } from '../runtime/views';
import type { RuntimeAdapterEntitySummary } from '@xln/runtime/api/runtime-adapter/types';

import { formatEventAmount, USER_ACTIVITY_TYPES, type ActivityEventView } from './Activity';

type HeadView = { latestHeight?: number; frameHash?: string; stateHash?: string } & Record<string, unknown>;
type ActivityView = { events?: ActivityEventView[] };

export function Home() {
	const navigate = useNavigate();
	const entityId = useApp(s => s.activeEntityId);
	const height = useApp(s => s.height);
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const setSelectedTokenId = useApp(s => s.setSelectedTokenId);

	const toast = useApp(s => s.toast);
	const core = useEntityCore(entityId);
	const { accounts } = useAccounts(entityId);
	const portfolio = usePortfolio(core.data, accounts);
	const [faucetBusy, setFaucetBusy] = useState(false);
	const demo = getDemoTopology();

	const requestFaucet = (): void => {
		void (async () => {
			if (!entityId || faucetBusy) return;
			setFaucetBusy(true);
			try {
				const amount = parseAmount('100', getTokenMeta(1).decimals);
				await demoFaucet(entityId, amount);
				toast('+100 USDC from Hub One');
			} catch (error) {
				toast(error instanceof Error ? error.message : String(error), 'danger');
			} finally {
				setFaucetBusy(false);
			}
		})();
	};
	const entities = useAdapterRead<RuntimeAdapterEntitySummary[]>('entities');
	const head = useAdapterRead<HeadView>('head');
	const activity = useAdapterRead<ActivityView>('activity', {
		limit: 4,
		types: USER_ACTIVITY_TYPES,
		...(entityId ? { entityId } : {}),
	});

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
							const label = names.get(account.counterpartyId) ?? 'Account';
							const isDemoHub = demo?.hub.entityId === account.counterpartyId;
							return (
								<div
									key={account.counterpartyId}
									className="row row-tappable"
									role="link"
									tabIndex={0}
									style={{ alignItems: 'flex-start', flexWrap: 'wrap', cursor: 'pointer' }}
									onClick={() => navigate(`/accounts/${account.counterpartyId}`)}
									onKeyDown={e => {
										if (e.key === 'Enter') navigate(`/accounts/${account.counterpartyId}`);
									}}
								>
									<span style={{ flex: '1 1 100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
										<span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
											{label}
											{isDemoHub && (
												<button
													type="button"
													className="faucet-chip"
													disabled={faucetBusy}
													onClick={e => {
														e.stopPropagation();
														requestFaucet();
													}}
												>
													{faucetBusy ? '…' : '+100 USDC · testnet'}
												</button>
											)}
										</span>
										<span className="display num" style={{ fontSize: 16 }}>
											{token ? formatAmount(token.signed, tokenMeta.decimals, 2) : '0'}{' '}
											<span className="faint" style={{ fontSize: 11, fontFamily: 'var(--font-ui)' }}>{tokenMeta.symbol}</span>
										</span>
									</span>
									<span className="hash" style={{ flex: '1 1 100%', marginTop: 2 }}>
										{account.counterpartyId}
									</span>
									<span style={{ flex: '1 1 100%', marginTop: 12 }}>
										{token ? (
											<>
												<DeltaBar derived={token.derived} signed={token.signed} height={6} />
												<span className="faint" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 7 }}>
													<span>← send {formatAmount(token.derived.outCapacity, tokenMeta.decimals, 2)}</span>
													<span>receive {formatAmount(token.derived.inCapacity, tokenMeta.decimals, 2)} →</span>
												</span>
											</>
										) : (
											<span className="faint" style={{ fontSize: 11 }}>
												No tokens yet
											</span>
										)}
									</span>
								</div>
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
						<div className="proof-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
							<span className="muted">State hash</span>
							<span className="hash">{frameHash || '—'}</span>
						</div>
						<div className="proof-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
							<span className="muted">Signer</span>
							<span className="hash">{core.data?.signerId || '—'}</span>
						</div>
						<div className="proof-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
							<span className="muted">Entity</span>
							<span className="hash">{entityId || '—'}</span>
						</div>
					</div>

					<div className="glass proof-panel">
						<span className="caps" style={{ marginBottom: 8 }}>
							Activity
						</span>
						{(activity.data?.events ?? []).slice(0, 4).map((event, index) => (
							<div key={event.id ?? index} className="proof-row">
								<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
									{String(event.title || event.type || 'Frame')}
								</span>
								<span className="faint" style={{ whiteSpace: 'nowrap' }}>
									{formatEventAmount(event) ?? (event.timestamp ? timeAgo(Number(event.timestamp)) : `#${event.height ?? ''}`)}
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
