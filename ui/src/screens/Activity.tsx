import { useMemo, useState } from 'react';
import { Icon, type IconName } from '../components/Icons';
import { Sheet } from '../components/Sheet';
import { useApp } from '../runtime/store';
import { dayLabel, formatClock, formatMoney, getTokenMeta, shortId, timeAgo } from '../runtime/format';
import { displayEntityName, useWallet } from '../runtime/views';
import { USER_ACTIVITY_TYPES, useMovements, type Movement } from '../runtime/financial/movements';

export { USER_ACTIVITY_TYPES };

const FILTERS: Array<{ id: string; label: string; types: string[] }> = [
	{ id: 'all', label: 'All', types: USER_ACTIVITY_TYPES },
	{ id: 'payments', label: 'Payments', types: ['payment', 'htlc'] },
	{ id: 'swaps', label: 'Swaps', types: ['swap', 'cross_swap'] },
	{ id: 'settlement', label: 'Settlement', types: ['settlement'] },
	{ id: 'accounts', label: 'Accounts', types: ['account'] },
];

const TONE_CLASS: Record<Movement['tone'], string> = {
	settled: 'st-settled',
	inflight: 'st-inflight',
	pending: 'st-pending',
	failed: 'st-dispute',
	neutral: 'st-neutral',
};

function movementIcon(movement: Movement): { icon: IconName; cls: string } {
	if (movement.kind === 'swap') return { icon: 'swap', cls: 'swap' };
	if (movement.kind === 'settlement') return { icon: 'bank', cls: 'reserve' };
	if (movement.kind === 'account') return { icon: 'shield', cls: 'account' };
	if (movement.direction === 'in') return { icon: 'receive', cls: 'in' };
	return { icon: 'pay', cls: 'out' };
}

export function formatMovementAmount(movement: Movement): string | null {
	if (movement.amount === null || movement.tokenId === null) return null;
	const meta = getTokenMeta(movement.tokenId);
	const sign = movement.kind === 'payment' ? (movement.direction === 'out' ? '−' : movement.direction === 'in' ? '+' : '') : '';
	return `${sign}${formatMoney(movement.amount, meta.decimals)} ${meta.symbol}`;
}

/** "to Meridian Desk via Hub One" / "from Hub One" / "with Hub One". */
export function movementParty(movement: Movement, names: Map<string, string>): string {
	if (!movement.counterpartyId) return '';
	const name = displayEntityName(names, movement.counterpartyId);
	const preposition = movement.kind === 'payment' ? (movement.direction === 'out' ? 'to' : movement.direction === 'in' ? 'from' : 'via') : 'with';
	const via = movement.viaId ? ` via ${displayEntityName(names, movement.viaId)}` : '';
	return `${preposition} ${name}${via}`;
}

export function ActivityRow({
	movement,
	names,
	first,
	selected,
	onClick,
}: {
	movement: Movement;
	names: Map<string, string>;
	first: boolean;
	selected?: boolean;
	onClick?: () => void;
}) {
	const amount = formatMovementAmount(movement);
	const { icon, cls } = movementIcon(movement);
	const party = movementParty(movement, names);
	const Tag = onClick ? 'button' : 'div';
	return (
		<Tag
			{...(onClick ? { type: 'button' as const, onClick } : {})}
			className={`row${onClick ? ' tappable' : ''}${selected ? ' sel' : ''}${first ? ' first' : ''}`}
			data-testid="activity-row"
		>
			<span className="rt">
				<span className={`ev-ic ${cls}`}>
					<Icon name={icon} size={15} />
				</span>
				<span className="tx">
					<span className="t">{movement.title}</span>
					<span className="s">{[party, movement.detail].filter(Boolean).join(' · ') || `frame #${movement.height}`}</span>
				</span>
				<span className="r">
					{amount ? <span className="v num">{amount}</span> : null}
					<span className="u">
						<span className={`state ${TONE_CLASS[movement.tone]}`}>{movement.state}</span>
					</span>
				</span>
			</span>
		</Tag>
	);
}

function MovementDetail({ movement, names }: { movement: Movement; names: Map<string, string> }) {
	const amount = formatMovementAmount(movement);
	const party = movementParty(movement, names);
	return (
		<>
			<div className="rcpt" style={{ textAlign: 'left', padding: 0 }}>
				<div className="caps">
					{movement.kind} · <span className={TONE_CLASS[movement.tone]}>{movement.state}</span>
				</div>
				<div className="a num" style={{ fontSize: 30, marginTop: 10 }}>
					{amount ?? movement.title}
				</div>
				{amount ? <div className="to">{[movement.title, party].filter(Boolean).join(' ')}</div> : null}
			</div>
			<div>
				{movement.counterpartyId ? (
					<div className="kv">
						<span className="k">{movement.direction === 'out' ? 'To' : movement.direction === 'in' ? 'From' : 'With'}</span>
						<span className="v">
							{displayEntityName(names, movement.counterpartyId)} <span className="mono faint">{shortId(movement.counterpartyId, 8, 4)}</span>
						</span>
					</div>
				) : null}
				{movement.viaId ? (
					<div className="kv">
						<span className="k">Via</span>
						<span className="v">{displayEntityName(names, movement.viaId)}</span>
					</div>
				) : null}
				{movement.detail ? (
					<div className="kv">
						<span className="k">Detail</span>
						<span className="v" style={{ fontWeight: 400 }}>
							{movement.detail}
						</span>
					</div>
				) : null}
				<div className="kv">
					<span className="k">Frame</span>
					<span className="v num">#{movement.height.toLocaleString('en-US')}</span>
				</div>
				<div className="kv">
					<span className="k">Time</span>
					<span className="v mono" style={{ color: 'var(--ink-2)' }}>
						{movement.timestamp ? formatClock(movement.timestamp) : '—'}
					</span>
				</div>
				{movement.hash ? (
					<div className="kv">
						<span className="k">Proof</span>
						<span className="v mono" style={{ color: 'var(--ink-2)' }}>
							{shortId(movement.hash, 10, 6)}
						</span>
					</div>
				) : null}
				{movement.events.length > 1 ? (
					<div className="kv">
						<span className="k">Frames</span>
						<span className="v num">{movement.events.length} committed entries</span>
					</div>
				) : null}
			</div>
			<div className="state st-settled" style={{ justifyContent: 'center', display: 'flex' }}>
				From your runtime's committed frames
			</div>
		</>
	);
}

export function ActivityScreen() {
	const entityId = useApp(s => s.activeEntityId);
	const wallet = useWallet(entityId);
	const [filter, setFilter] = useState('all');
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const types = FILTERS.find(entry => entry.id === filter)?.types ?? USER_ACTIVITY_TYPES;
	const accountIds = useMemo(() => wallet.accounts.map(account => account.counterpartyId), [wallet.accounts]);
	const { movements, loading, error } = useMovements(entityId, types, 200, accountIds);
	const selected = movements.find(movement => movement.id === selectedId) ?? null;

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
				<span className="faint" style={{ fontSize: 12 }}>
					{movements.length} movements
				</span>
			</div>
			<div className="two-col" style={{ gridTemplateColumns: 'minmax(0,1fr) 400px' }}>
				<div>
					<div className="chips">
						{FILTERS.map(entry => (
							<button key={entry.id} type="button" className={filter === entry.id ? 'active' : ''} onClick={() => setFilter(entry.id)}>
								{entry.label}
							</button>
						))}
					</div>
					{rows.map(({ movement, day, first }) => (
						<div key={movement.id}>
							{first ? <div className="caps day">{day}</div> : null}
							<ActivityRow movement={movement} names={wallet.names} first={first} selected={movement.id === selectedId} onClick={() => setSelectedId(movement.id)} />
						</div>
					))}
					{movements.length === 0 && !loading && (
						<p className="note" style={{ padding: '18px 0' }}>
							Nothing here for this filter yet.
						</p>
					)}
					{error && <p style={{ color: 'var(--dispute)', fontSize: 13 }}>{error}</p>}
				</div>
				<div className="aside desktop-only">
					{selected ? (
						<div className="card">
							<MovementDetail movement={selected} names={wallet.names} />
						</div>
					) : (
						<div className="card">
							<p className="note">Select a movement to see its receipt.</p>
						</div>
					)}
				</div>
			</div>
			{selected && (
				<div className="mobile-only">
					<Sheet title="Receipt" onClose={() => setSelectedId(null)}>
						<MovementDetail movement={selected} names={wallet.names} />
					</Sheet>
				</div>
			)}
			<span className="faint" style={{ fontSize: 11, display: 'block', marginTop: 24 }}>
				{selected ? timeAgo(selected.timestamp) : ''}
			</span>
		</div>
	);
}
