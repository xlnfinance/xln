import { useLocation } from 'react-router-dom';
import { SwapHistory } from '../components/history/SwapHistory';
import { useEffect, useMemo, useState } from 'react';
import { Sheet } from '../components/Sheet';
import { ActivityRow } from '../components/history/ActivityRow';
import { MovementDetail } from '../components/history/MovementDetail';
import { exportCsv } from '../components/history/export';
import { useApp } from '../runtime/store';
import { dayLabel, formatUsd } from '../runtime/format';
import { useWallet } from '../runtime/views';
import { usdOf } from '../runtime/financial/prices';
import { USER_ACTIVITY_TYPES, useMovements } from '../runtime/financial/movements';
export { ActivityRow, formatMovementAmount, movementParty } from '../components/history/ActivityRow';
export { USER_ACTIVITY_TYPES };

const FILTERS: Array<{ id: string; label: string; types: string[] }> = [
	{ id: 'all', label: 'All', types: USER_ACTIVITY_TYPES },
	{ id: 'payments', label: 'Payments', types: ['payment', 'htlc'] },
	{ id: 'swaps', label: 'Swaps', types: [] },
	{ id: 'cross-swaps', label: 'Across networks', types: ['cross_swap'] },
	{ id: 'settlement', label: 'Settlement', types: ['settlement'] },
	{ id: 'onchain', label: 'On-chain', types: ['j_event', 'j_batch'] },
	{ id: 'accounts', label: 'Accounts', types: ['account'] },
];

const PAGE = 200;

export function ActivityScreen() {
	const entityId = useApp(s => s.activeEntityId);
	return <EntityActivity key={entityId ?? 'none'} entityId={entityId} />;
}

function EntityActivity({ entityId }: { entityId: string | null }) {
	const wallet = useWallet(entityId);
	const [filter, setFilter] = useState('all');
	const location = useLocation();
	const [selectedId, setSelectedId] = useState<string | null>(() =>
		typeof location.state?.movementId === 'string' ? location.state.movementId : null);
	const [search, setSearch] = useState('');
	// A page, not a ceiling: the books outlive any fixed number of rows.
	const [cursors, setCursors] = useState<Array<number | null>>([null]);
	const [from, setFrom] = useState('');
	const [to, setTo] = useState('');
	const limit = PAGE;
	const filters = useMemo(() => ({
		...(cursors.at(-1) !== null ? { beforeHeight: cursors.at(-1)! } : {}),
		...(search.trim() ? { q: search.trim() } : {}),
		...(from ? { fromTimestamp: new Date(from).getTime() } : {}),
		...(to ? { toTimestamp: new Date(to).getTime() } : {}),
		scanLimit: 1000,
	}), [cursors, search, from, to]);
	const types = FILTERS.find(entry => entry.id === filter)?.types ?? USER_ACTIVITY_TYPES;
	const accountIds = useMemo(() => wallet.accounts.map(account => account.counterpartyId), [wallet.accounts]);
	const { movements: loaded, loading, error, nextBeforeHeight } = useMovements(filter === 'swaps' ? null : entityId, types, limit, accountIds, filters);
	const more = nextBeforeHeight !== null;
	const movements = loaded;
	// Desktop shows the latest movement's receipt until the user picks another; on a phone the sheet opens only on tap.
	const [desktop, setDesktop] = useState(() => window.matchMedia('(min-width: 1101px)').matches);
	useEffect(() => {
		const media = window.matchMedia('(min-width: 1101px)');
		const changed = () => setDesktop(media.matches);
		media.addEventListener('change', changed);
		return () => media.removeEventListener('change', changed);
	}, []);
	const selected = filter === 'swaps' ? null : movements.find(movement => movement.id === selectedId) ?? (desktop ? (movements[0] ?? null) : null);

	// The day at a glance, for whoever closes the till: what came in, what went out, how many movements.
	const today = useMemo(() => {
		const startOfDay = new Date();
		startOfDay.setHours(0, 0, 0, 0);
		let received = 0;
		let sent = 0;
		let count = 0;
		for (const movement of movements) {
			if (movement.kind !== 'payment' || movement.tone !== 'settled' || !movement.timestamp || movement.timestamp < startOfDay.getTime() || movement.amount === null || movement.tokenId === null) continue;
			const usd = usdOf(movement.tokenId, movement.amount);
			if (movement.direction === 'in') received += usd;
			else if (movement.direction === 'out') sent += usd;
			count += 1;
		}
		return { received, sent, count };
	}, [movements]);

	let lastDay = '';
	const rows = movements.map(movement => {
		const day = movement.timestamp ? dayLabel(movement.timestamp) : `Frame ${movement.height}`;
		const first = day !== lastDay;
		lastDay = day;
		return { movement, day, first };
	});

	return (
		<div className="screen fade-in">
			<div className="screen-header">
				<span className="screen-title">Activity</span>
				{filter !== 'swaps' && today.count > 0 ? (
					<span className="note num" data-testid="activity-today" style={{ marginLeft: 12 }}>
						This page today · in {formatUsd(today.received)} · out {formatUsd(today.sent)} · {today.count} {today.count === 1 ? 'movement' : 'movements'}
					</span>
				) : null}
				{filter !== 'swaps' && movements.length > 0 ? (
					<button type="button" className="btn quiet sm" onClick={() => exportCsv(movements)} data-testid="activity-export" title="Every movement shown here, with frame height and hash, for your books">
						Export CSV
					</button>
				) : null}
				<span className="faint" style={{ fontSize: 12 }} hidden={filter === 'swaps'}>
					{movements.length} {movements.length === 1 ? 'movement' : 'movements'}
				</span>
			</div>
			<div className="two-col activity">
				<div>
					{filter !== 'swaps' && <>
					<input
						className="input"
						type="search"
						placeholder="Search stored history"
						value={search}
						onChange={event => { setSearch(event.target.value); setCursors([null]); }}
						data-testid="activity-search"
						style={{ marginBottom: 8 }}
					/>
					<div className="actions" style={{ gridTemplateColumns: '1fr 1fr' }}>
                        <label className="field">From<input className="input" type="datetime-local" value={from} onChange={event => { setFrom(event.target.value); setCursors([null]); }} /></label>
                        <label className="field">Until<input className="input" type="datetime-local" value={to} onChange={event => { setTo(event.target.value); setCursors([null]); }} /></label>
                    </div>
                    {cursors.length > 1 && <button type="button" className="btn quiet sm" onClick={() => setCursors(value => value.slice(0, -1))}>Newer records</button>}
                    </>}
                    <div className="chips">
						{FILTERS.map(entry => (
							<button key={entry.id} type="button" className={filter === entry.id ? 'active' : ''} onClick={() => { setFilter(entry.id); setCursors([null]); }}>
								{entry.label}
							</button>
						))}
					</div>
					{filter === 'swaps' && entityId ? <SwapHistory key={entityId} entityId={entityId} accountIds={accountIds} names={wallet.names} /> : null}
					{filter !== 'swaps' && rows.map(({ movement, day, first }) => (
						<div key={movement.id}>
							{first ? <div className="caps day">{day}</div> : null}
							<ActivityRow movement={movement} names={wallet.names} first={first} selected={movement.id === selected?.id} onClick={() => setSelectedId(movement.id)} />
						</div>
					))}
					{filter !== 'swaps' && movements.length === 0 && !loading && !error && (
						<p className="note" style={{ padding: '18px 0' }}>
							{search.trim() ? `Nothing loaded matches "${search.trim()}".` : more ? 'No matching activity on this page.' : 'No matching activity.'}
						</p>
					)}
					{filter !== 'swaps' && more && (
						<div style={{ padding: '12px 0' }}>
							<button
								type="button"
								className="btn quiet sm"
								onClick={() => { if (nextBeforeHeight !== null) setCursors(value => [...value, nextBeforeHeight]); }}
								disabled={loading || Boolean(error)}
								data-testid="activity-more"
							>
								{loading ? 'Loading…' : 'Earlier records'}
							</button>
							<span className="faint" style={{ fontSize: 12, marginLeft: 10 }}>
								{search.trim()
									? `Searching the ${loaded.length.toLocaleString('en-US')} movements on this page.`
									: `Showing the ${loaded.length.toLocaleString('en-US')} movements on this page.`}
							</span>
						</div>
					)}
					{error && <p style={{ color: 'var(--dispute)', fontSize: 13 }}>{error}</p>}
				</div>
				{filter !== 'swaps' && <div className="aside desktop-only">
					{selected ? (
						<div className="card">
							<MovementDetail movement={selected} names={wallet.names} />
						</div>
					) : (
						<div className="card">
							<p className="note">Select a movement to see its receipt.</p>
						</div>
					)}
				</div>}
			</div>
			{selected && !desktop && (
				<div className="mobile-only">
					<Sheet title="Receipt" onClose={() => setSelectedId(null)}>
						<MovementDetail movement={selected} names={wallet.names} />
					</Sheet>
				</div>
			)}
		</div>
	);
}
