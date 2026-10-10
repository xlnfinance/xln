import { getJurisdictionBadgeInfo } from '@xln/frontend/lib/utils/identity/jurisdictionBadge';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icons';
import { useApp } from '../runtime/store';
import { switchActiveEntity, useServedEntities } from '../runtime/entities';
import { shortId } from '../runtime/format';

/**
 * The identity block on Home and Desk, and the way between entities.
 *
 * One runtime serves several entities — one per jurisdiction after boot, plus
 * any the user creates or is granted — and every screen renders from the active
 * one. The trigger names it and says whether it is a hub; picking another
 * re-points the whole wallet and returns to Home, because the flow-scoped
 * routes (an account, a half-filled payment) belong to the entity we left.
 */
export function EntitySwitcher({ name, status }: { name: string; status: ReactNode }) {
	const activeEntityId = useApp(s => s.activeEntityId);
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const entities = useServedEntities(open);
	const root = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: MouseEvent): void => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') setOpen(false);
		};
		window.addEventListener('mousedown', onPointerDown);
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('mousedown', onPointerDown);
			window.removeEventListener('keydown', onKey);
		};
	}, [open]);

	const active = entities.find(entity => entity.entityId === activeEntityId) ?? null;
	const label = active?.label || name;
	const pick = (entityId: string): void => {
		setOpen(false);
		switchActiveEntity(entityId);
		navigate('/');
	};

	return (
		<div className="picker entity-switcher" ref={root} data-testid="entity-switcher">
			<button
				type="button"
				className="entity-switch"
				onClick={() => setOpen(value => !value)}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={`Active entity ${label}. Switch entity`}
				data-testid="entity-switcher-trigger"
				data-entity-id={activeEntityId ?? ''}
			>
				<span className="avatar sm">{label.slice(0, 1).toUpperCase()}</span>
				<span className="id">
					<span className="n">
						{label}
						{active?.isHub ? <span className="chip hub">hub</span> : null}
					</span>
					{status}
				</span>
				<span className="caret">
					<Icon name="chevronDown" size={14} />
				</span>
			</button>

			{open ? (
				<div className="picker-menu entity-switcher-menu" role="listbox" aria-label="Entities on this runtime" data-testid="entity-switcher-menu">
					{entities.map(entity => (
						<button
							key={entity.entityId}
							type="button"
							role="option"
							aria-selected={entity.entityId === activeEntityId}
							className={`picker-option jurisdiction-surface${entity.entityId === activeEntityId ? ' active' : ''}`}
							data-jurisdiction={getJurisdictionBadgeInfo(entity.jurisdiction)?.className ?? 'generic'}
							style={{ borderLeft: '3px solid var(--jurisdiction-color)' }}
							onClick={() => pick(entity.entityId)}
							data-testid="entity-switcher-entity"
							data-entity-id={entity.entityId}
						>
							<span className="t">
								<span className="avatar sm">{entity.label.slice(0, 1).toUpperCase()}</span>
								{entity.label}
								{entity.isHub ? <span className="chip hub">hub</span> : null}
								{entity.entityId === activeEntityId ? <Icon name="check" size={14} /> : null}
							</span>
							<span className="faint" style={{ fontSize: 11.5 }}>
								{entity.jurisdiction ? `${entity.jurisdiction} · ` : ''}
								{shortId(entity.entityId)} · frame #{entity.height.toLocaleString('en-US')}
							</span>
						</button>
					))}
					{entities.length === 0 ? (
						<p className="note" style={{ padding: '9px 10px' }}>
							This runtime serves no other entity yet.
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}
