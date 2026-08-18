import { useMemo, useState } from 'react';
import type { RuntimeAdapterEntitySummary } from '@xln/core/api/runtime-adapter/types';
import { useApp } from '../core/store';
import { useAdapterRead } from '../core/hooks';
import { useAccounts } from '../core/views';
import { formatAmount, getTokenMeta, timeAgo } from '../core/format';

export type ActivityEventView = {
	id?: string;
	height?: number;
	timestamp?: number;
	kind?: string;
	type?: string;
	direction?: string;
	title?: string;
	subtitle?: string;
	status?: string;
	entityId?: string;
	counterpartyId?: string;
	tokenId?: number;
	amount?: string;
};

type ActivityPage = { events?: ActivityEventView[]; latestHeight?: number; scannedFrames?: number };

export function formatEventAmount(event: ActivityEventView): string | null {
	if (!event.amount || !event.tokenId) return null;
	try {
		const meta = getTokenMeta(Number(event.tokenId));
		const value = BigInt(event.amount);
		const sign = event.direction === 'out' ? '−' : event.direction === 'in' ? '+' : '';
		return `${sign}${formatAmount(value < 0n ? -value : value, meta.decimals, 2)} ${meta.symbol}`;
	} catch {
		return null;
	}
}

/** User-relevant money movements; consensus internals stay in dev tools. */
export const USER_ACTIVITY_TYPES = ['payment', 'htlc', 'swap', 'cross_swap', 'settlement', 'account'];

// Swap handlers emit both a raw internal log line and a structured, formatted
// entry for the same frame — hide the raw duplicate so each swap action shows once.
const RAW_SWAP_LOG = /^(?:📊 Swap offer|📨 Swap cancel requested)/;

export function isDisplayableActivityEvent(event: ActivityEventView): boolean {
	return !RAW_SWAP_LOG.test(String(event.title || ''));
}

const ALL = 'all';

function FilterChips({
	value,
	onChange,
	options,
}: {
	value: string;
	onChange: (next: string) => void;
	options: Array<{ id: string; label: string }>;
}) {
	return (
		<div className="token-switch" style={{ flexWrap: 'wrap' }}>
			{options.map(option => (
				<button
					key={option.id}
					type="button"
					className={value === option.id ? 'active' : ''}
					onClick={() => onChange(option.id)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

export function ActivityScreen() {
	const activeEntityId = useApp(s => s.activeEntityId);
	const entities = useAdapterRead<RuntimeAdapterEntitySummary[]>('entities');
	const [entityFilter, setEntityFilter] = useState<string>(activeEntityId?.toLowerCase() ?? ALL);
	const [accountFilter, setAccountFilter] = useState<string>(ALL);

	const names = useMemo(() => {
		const map = new Map<string, string>();
		for (const summary of entities.data ?? []) {
			if (summary.entityId) map.set(summary.entityId.toLowerCase(), summary.label || '');
		}
		return map;
	}, [entities.data]);

	const nameOf = (id: string | undefined): string => {
		const key = (id ?? '').toLowerCase();
		return names.get(key) || (key ? `${key.slice(0, 10)}…` : '');
	};

	const { accounts } = useAccounts(entityFilter === ALL ? null : entityFilter);

	// Runtime-side filter: entityId narrows the journal projection to that
	// entity's frames. Account scoping is client-side over the same real page —
	// RuntimeActivityFilters has no counterparty filter yet.
	const activity = useAdapterRead<ActivityPage>('activity', {
		limit: 100,
		types: USER_ACTIVITY_TYPES,
		...(entityFilter !== ALL ? { entityId: entityFilter } : {}),
	});

	const events = (activity.data?.events ?? []).filter(
		event =>
			(accountFilter === ALL || (event.counterpartyId ?? '').toLowerCase() === accountFilter) &&
			isDisplayableActivityEvent(event),
	);

	const entityOptions = [
		{ id: ALL, label: 'All entities' },
		...(entities.data ?? [])
			.map(summary => summary.entityId?.toLowerCase() ?? '')
			.filter(Boolean)
			.map(id => ({ id, label: nameOf(id) })),
	];

	const accountOptions = [
		{ id: ALL, label: 'All accounts' },
		...accounts.map(account => ({ id: account.counterpartyId, label: nameOf(account.counterpartyId) })),
	];

	return (
		<div className="screen fade-in" style={{ maxWidth: 760 }}>
			<div className="screen-header" style={{ marginBottom: 20 }}>
				<span className="screen-title">Activity</span>
				<span className="faint" style={{ fontSize: 12 }}>
					{events.length} events · frames from local db
				</span>
			</div>

			<div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 26 }}>
				<FilterChips
					value={entityFilter}
					options={entityOptions}
					onChange={next => {
						setEntityFilter(next);
						setAccountFilter(ALL);
					}}
				/>
				{entityFilter !== ALL && accounts.length > 0 && (
					<FilterChips value={accountFilter} options={accountOptions} onChange={setAccountFilter} />
				)}
			</div>

			<div>
				{events.map((event, index) => {
					const amount = formatEventAmount(event);
					const counterparty = event.counterpartyId ? nameOf(event.counterpartyId) : '';
					return (
						<div key={event.id ?? index} className="row" style={{ padding: '13px 0' }}>
							<span style={{ minWidth: 0 }}>
								<span
									style={{
										display: 'block',
										fontSize: 13.5,
										overflow: 'hidden',
										textOverflow: 'ellipsis',
										whiteSpace: 'nowrap',
									}}
								>
									{String(event.title || event.type || 'Frame')}
								</span>
								<span className="faint" style={{ display: 'block', fontSize: 11.5, marginTop: 2 }}>
									frame #{event.height ?? '—'}
									{counterparty ? ` · with ${counterparty}` : ''}
									{event.subtitle ? ` · ${event.subtitle}` : ''}
								</span>
							</span>
							<span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
								{amount && (
									<span className="display num" style={{ display: 'block', fontSize: 14 }}>
										{amount}
									</span>
								)}
								<span className="faint" style={{ display: 'block', fontSize: 11.5, marginTop: 2 }}>
									{event.timestamp ? timeAgo(Number(event.timestamp)) : `#${event.height ?? ''}`}
								</span>
							</span>
						</div>
					);
				})}
				{events.length === 0 && !activity.loading && (
					<p className="muted" style={{ padding: '18px 0', fontSize: 13 }}>
						Nothing here for this filter yet.
					</p>
				)}
				{activity.error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{activity.error}</p>}
			</div>
		</div>
	);
}
