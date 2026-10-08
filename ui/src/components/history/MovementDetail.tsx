import { CopyId } from '../CopyId';
import { formatClock } from '../../runtime/format';
import { displayEntityName } from '../../runtime/views';
import { formatMovementAmount, movementParty, TONE_CLASS } from './ActivityRow';
import type { Movement } from '../../runtime/financial/movements';
export function MovementDetail({ movement, names }: { movement: Movement; names: Map<string, string> }) {
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
				{amount ? <div className="to">{[movement.title, party ? party[0]!.toLowerCase() + party.slice(1) : ''].filter(Boolean).join(' ')}</div> : null}
			</div>
			<div>
				{movement.counterpartyId ? (
					<div className="kv">
						<span className="k">{movement.kind === 'payment' && movement.hash ? 'Observed account' : movement.direction === 'out' ? 'To' : movement.direction === 'in' ? 'From' : 'With'}</span>
						<span className="v">
							{displayEntityName(names, movement.counterpartyId)} <CopyId value={movement.counterpartyId} label="Entity id" head={8} tail={4} />
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
						<span className="k">Hash / identifier</span>
						<span className="v">
							<CopyId value={movement.hash} label="Hash / identifier" />
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
			<div className="actions" style={{ display: 'flex', gap: 8, marginTop: 10 }}>
				<button
					type="button"
					className="btn quiet"
					style={{ flex: 1 }}
					data-testid="movement-copy"
					onClick={() => {
						const lines = [
							`${movement.title}${party ? ` ${party}` : ''}${amount ? ` · ${amount}` : ''}`,
							`State: ${movement.state}`,
							movement.timestamp ? `When: ${new Date(movement.timestamp).toISOString()}` : '',
							`Frame: #${movement.height}`,
							movement.hash ? `Hash / identifier: ${movement.hash}` : '',
							'Activity record · xln',
						].filter(Boolean);
						void navigator.clipboard?.writeText(lines.join('\n'));
					}}
				>
					Copy
				</button>
				<button
					type="button"
					className="btn quiet"
					style={{ flex: 1 }}
					data-testid="movement-download"
					title="This entry with its frame, proof and every committed event, as a file for the books"
					onClick={() => {
						const blob = new Blob([JSON.stringify(movement, (_key, value) => (typeof value === 'bigint' ? String(value) : value), 2)], { type: 'application/json' });
						const url = URL.createObjectURL(blob);
						const link = document.createElement('a');
						link.href = url;
						link.download = `xln-activity-frame-${movement.height}.json`;
						link.click();
						setTimeout(() => URL.revokeObjectURL(url), 1_000);
					}}
				>
					Download record
				</button>
			</div>
		</>
	);
}
