import { useMemo } from 'react';
import type { RuntimeAdapterEntitySummary } from '@xln/core/api/public/runtime-module';
import { normalizeEntityId } from '@xln/core/protocol/identity/entity-id';
import { getAdapter } from './adapter';
import { useAdapterRead } from './hooks';
import { useApp } from './store';
import { useReceipts } from './financial/receipt-state';
import { shortId } from './format';

/** One entity of the connected runtime, as the switcher and the palette present it. */
export type ServedEntity = {
	entityId: string;
	label: string;
	isHub: boolean;
	/** The chain this entity was created on; empty when the summary carries no jurisdiction. */
	jurisdiction: string;
	height: number;
};

/**
 * `read('entities')` merges the runtime's own replicas with every gossip
 * profile it has heard, so the peers have to be filtered out. Only a live local
 * replica carries a `signerId` (`listLiveEntitySummaries` sets it from the
 * replica; `summaryFromProfile` has none), and its `runtimeId` is this
 * runtime's. Both must agree before we offer an entity we could sign for.
 */
function servedByRuntime(summary: RuntimeAdapterEntitySummary, runtimeId: string): boolean {
	if (!String(summary.signerId || '').trim()) return false;
	const owner = normalizeEntityId(String(summary.runtimeId || ''));
	return !owner || !runtimeId || owner === runtimeId;
}

/**
 * Every entity this runtime can sign for, best first: hubs, then by label.
 *
 * A wallet booted against a multi-jurisdiction stack has one entity per chain,
 * and a granted or newly created entity appears as soon as its replica exists.
 *
 * The read costs one round trip per committed frame, so it is asked for only
 * while a list is actually on screen: the palette is mounted for its shortcut
 * but closed almost always, and so is the switcher's menu. Pass `false` and the
 * hook reads nothing.
 */
export function useServedEntities(enabled = true): ServedEntity[] {
	const read = useAdapterRead<RuntimeAdapterEntitySummary[]>(enabled ? 'entities' : null);
	const status = useApp(s => s.adapterStatus);
	const summaries = read.data;

	return useMemo<ServedEntity[]>(() => {
		if (status !== 'connected' || !Array.isArray(summaries)) return [];
		const runtimeId = normalizeEntityId(String(getAdapter()?.runtimeId || ''));
		const served = summaries
			.filter(summary => servedByRuntime(summary, runtimeId))
			.map(summary => {
				const entityId = normalizeEntityId(String(summary.entityId || ''));
				const label = String(summary.label || '').trim();
				return {
					entityId,
					label: label && label !== entityId ? label : shortId(entityId),
					isHub: summary.isHub === true,
					jurisdiction: String(summary.jurisdiction?.name || '').trim(),
					height: Math.max(0, Math.floor(Number(summary.height ?? 0))),
				};
			})
			.filter(entity => entity.entityId.length > 0);
		served.sort((left, right) => (left.isHub === right.isHub ? left.label.localeCompare(right.label) : left.isHub ? -1 : 1));
		return served;
	}, [summaries, status]);
}

/**
 * Point the whole wallet at another entity of the same runtime.
 *
 * Every screen renders from `activeEntityId`, so the switch is the store write
 * plus dropping what belonged to the entity we are leaving: the signer's
 * on-chain rows (read per entity, and only refreshed on the next frame), the
 * toasts the screen we were on raised, and any receipt drained from the old
 * entity's frames. Callers own navigation: the screen we land on is theirs.
 */
export function switchActiveEntity(entityId: string): void {
	const next = normalizeEntityId(String(entityId || ''));
	const app = useApp.getState();
	if (!next || normalizeEntityId(String(app.activeEntityId || '')) === next) return;
	app.setExternalRows([]);
	app.clearToasts();
	useReceipts.getState().dismiss();
	app.setActiveEntityId(next);
}
