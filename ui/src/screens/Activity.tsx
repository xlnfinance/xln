import { useAdapterRead } from '../runtime/hooks';
import { timeAgo } from '../runtime/format';

type ActivityEvent = {
	type?: string;
	kind?: string;
	timestamp?: number;
	height?: number;
	description?: string;
	amount?: string;
	tokenId?: number;
} & Record<string, unknown>;

type ActivityPage = { events?: ActivityEvent[] };

export function ActivityScreen() {
	const activity = useAdapterRead<ActivityPage>('activity', { limit: 60 });
	const events = activity.data?.events ?? [];

	return (
		<div className="screen fade-in" style={{ maxWidth: 720 }}>
			<div className="screen-header">
				<span className="screen-title">Activity</span>
				<span className="faint" style={{ fontSize: 12 }}>
					{events.length} events
				</span>
			</div>

			<div>
				{events.map((event, index) => (
					<div key={index} className="row" style={{ padding: '13px 0' }}>
						<span style={{ minWidth: 0 }}>
							<span style={{ display: 'block', fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
								{String(event.description || event.type || event.kind || 'Frame')}
							</span>
							<span className="faint" style={{ display: 'block', fontSize: 11.5, marginTop: 2 }}>
								frame #{event.height ?? '—'}
							</span>
						</span>
						<span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
							{event.timestamp ? timeAgo(Number(event.timestamp)) : ''}
						</span>
					</div>
				))}
				{events.length === 0 && !activity.loading && (
					<p className="muted" style={{ padding: '18px 0', fontSize: 13 }}>
						Nothing yet — activity appears here as frames commit.
					</p>
				)}
				{activity.error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{activity.error}</p>}
			</div>
		</div>
	);
}
