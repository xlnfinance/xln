import { useMemo, useState } from 'react';
import type { RuntimeActivityEvent } from '@xln/core/api/public/runtime-module';
import { Icon, type IconName } from '../components/Icons';
import { Sheet } from '../components/Sheet';
import { useAdapterRead } from '../runtime/hooks';
import { useApp } from '../runtime/store';
import { dayLabel, formatClock, formatMoney, getTokenMeta, shortId, timeAgo } from '../runtime/format';
import { displayEntityName, useWallet } from '../runtime/views';

type ActivityPage = { events?: RuntimeActivityEvent[]; latestHeight?: number };

/** User-relevant money movements; consensus internals stay in the developer workspace. */
export const USER_ACTIVITY_TYPES = ['payment', 'htlc', 'swap', 'cross_swap', 'settlement', 'account'];

// Swap handlers emit a raw internal log line and a structured entry for the same
// frame. Hide the raw duplicate so each swap action shows once.
const RAW_SWAP_LOG = /^(?:📊 Swap offer|📨 Swap cancel requested)/;

export function isDisplayableActivityEvent(event: RuntimeActivityEvent): boolean {
	return !RAW_SWAP_LOG.test(String(event.title || ''));
}

const FILTERS: Array<{ id: string; label: string; types: string[] }> = [
	{ id: 'all', label: 'All', types: USER_ACTIVITY_TYPES },
	{ id: 'payments', label: 'Payments', types: ['payment', 'htlc'] },
	{ id: 'swaps', label: 'Swaps', types: ['swap', 'cross_swap'] },
	{ id: 'settlement', label: 'Settlement', types: ['settlement'] },
	{ id: 'accounts', label: 'Accounts', types: ['account'] },
];

type StateTone = 'settled' | 'inflight' | 'pending' | 'neutral' | 'dispute';

function eventTone(event: RuntimeActivityEvent): { tone: StateTone; label: string } {
	const status = String(event.status || '').toLowerCase();
	if (/fail|reject|dispute|error|timeout/.test(status)) return { tone: 'dispute', label: status || 'failed' };
	if (/pending|await|queued|submitted|proposed/.test(status)) return { tone: 'pending', label: status };
	if (/progress|lock|flight|open|partial/.test(status)) return { tone: 'inflight', label: status };
	if (/settle|final|commit|confirm|done|filled|complete|resolved|ok/.test(status)) return { tone: 'settled', label: 'settled' };
	return { tone: 'neutral', label: status || 'signed' };
}

function eventIcon(event: RuntimeActivityEvent): { icon: IconName; cls: string } {
	const type = String(event.type || '');
	if (type === 'swap' || type === 'cross_swap') return { icon: 'swap', cls: 'swap' };
	if (type === 'settlement') return { icon: 'bank', cls: 'reserve' };
	if (type === 'account') return { icon: 'shield', cls: 'account' };
	if (event.direction === 'in') return { icon: 'receive', cls: 'in' };
	return { icon: 'pay', cls: 'out' };
}

export function formatEventAmount(event: RuntimeActivityEvent): string | null {
	if (!event.amount || !event.tokenId) return null;
	try {
		const meta = getTokenMeta(Number(event.tokenId));
		const value = BigInt(event.amount);
		const sign = event.direction === 'out' ? '−' : event.direction === 'in' ? '+' : '';
		return `${sign}${formatMoney(value < 0n ? -value : value, meta.decimals)} ${meta.symbol}`;
	} catch {
		return null;
	}
}

export function ActivityRow({
	event,
	names,
	first,
	selected,
	onClick,
}: {
	event: RuntimeActivityEvent;
	names: Map<string, string>;
	first: boolean;
	selected?: boolean;
	onClick?: () => void;
}) {
	const amount = formatEventAmount(event);
	const { tone, label } = eventTone(event);
	const { icon, cls } = eventIcon(event);
	const counterparty = event.counterpartyId ? displayEntityName(names, event.counterpartyId) : '';
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
					<span className="t">{String(event.title || event.type || 'Frame')}</span>
					<span className="s">
						{[counterparty ? `with ${counterparty}` : '', event.subtitle || ''].filter(Boolean).join(' · ') || `frame #${event.height}`}
					</span>
				</span>
				<span className="r">
					{amount ? <span className="v num">{amount}</span> : null}
					<span className="u">
						<span className={`state st-${tone}`}>{label}</span>
					</span>
				</span>
			</span>
		</Tag>
	);
}

function EventDetail({ event, names }: { event: RuntimeActivityEvent; names: Map<string, string> }) {
	const amount = formatEventAmount(event);
	const { tone, label } = eventTone(event);
	const counterparty = event.counterpartyId ? displayEntityName(names, event.counterpartyId) : '';
	return (
		<>
			<div className="rcpt" style={{ textAlign: 'left', padding: 0 }}>
				<div className="caps">
					{String(event.type || 'event').replace('_', ' ')} · <span className={`st-${tone}`}>{label}</span>
				</div>
				<div className="a num" style={{ fontSize: 30, marginTop: 10 }}>
					{amount ?? String(event.title || '')}
				</div>
				{amount ? <div className="to">{String(event.title || '')}</div> : null}
			</div>
			<div>
				{counterparty ? (
					<div className="kv">
						<span className="k">With</span>
						<span className="v">
							{counterparty} <span className="mono faint">{shortId(event.counterpartyId ?? '', 8, 4)}</span>
						</span>
					</div>
				) : null}
				{event.subtitle ? (
					<div className="kv">
						<span className="k">Detail</span>
						<span className="v" style={{ fontWeight: 400 }}>
							{event.subtitle}
						</span>
					</div>
				) : null}
				<div className="kv">
					<span className="k">Frame</span>
					<span className="v num">#{event.height.toLocaleString('en-US')}</span>
				</div>
				<div className="kv">
					<span className="k">Time</span>
					<span className="v mono" style={{ color: 'var(--ink-2)' }}>
						{event.timestamp ? formatClock(event.timestamp) : '—'}
					</span>
				</div>
				{event.hash ? (
					<div className="kv">
						<span className="k">Proof</span>
						<span className="v mono" style={{ color: 'var(--ink-2)' }}>
							{shortId(event.hash, 10, 6)}
						</span>
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

	const activity = useAdapterRead<ActivityPage>('activity', {
		limit: 100,
		types,
		...(entityId ? { entityId } : {}),
	});
	const events = useMemo(() => (activity.data?.events ?? []).filter(isDisplayableActivityEvent), [activity.data]);
	const selected = events.find(event => event.id === selectedId) ?? null;

	let lastDay = '';
	const rows = events.map(event => {
		const day = event.timestamp ? dayLabel(event.timestamp) : `Frame ${event.height}`;
		const first = day !== lastDay;
		lastDay = day;
		return { event, day, first };
	});

	return (
		<div className="screen fade-in">
			<div className="screen-header">
				<span className="screen-title">Activity</span>
				<span className="faint" style={{ fontSize: 12 }}>
					{events.length} events
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
					{rows.map(({ event, day, first }) => (
						<div key={event.id}>
							{first ? <div className="caps day">{day}</div> : null}
							<ActivityRow event={event} names={wallet.names} first={first} selected={event.id === selectedId} onClick={() => setSelectedId(event.id)} />
						</div>
					))}
					{events.length === 0 && !activity.loading && (
						<p className="note" style={{ padding: '18px 0' }}>
							Nothing here for this filter yet.
						</p>
					)}
					{activity.error && <p style={{ color: 'var(--dispute)', fontSize: 13 }}>{activity.error}</p>}
				</div>
				<div className="aside desktop-only">
					{selected ? (
						<div className="card">
							<EventDetail event={selected} names={wallet.names} />
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
						<EventDetail event={selected} names={wallet.names} />
					</Sheet>
				</div>
			)}
			<span className="faint" style={{ fontSize: 11, display: 'block', marginTop: 24 }}>
				{selected ? timeAgo(selected.timestamp) : ''}
			</span>
		</div>
	);
}
