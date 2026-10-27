import { useMemo } from 'react';
import type { RuntimeAdapterReadQuery, RuntimeActivityEvent } from '@xln/core/api/public/runtime-module';
import { useAdapterRead } from '../hooks';

/** User-relevant money movements; consensus internals stay in the developer workspace. */
export const USER_ACTIVITY_TYPES = ['payment', 'htlc', 'swap', 'cross_swap', 'settlement', 'account', 'j_event', 'j_batch'];

export { walletMovements } from './movement-projection';
export type { Movement } from './movement-projection';
import { walletMovements, type Movement } from './movement-projection';

type ActivityPage = {
	events?: RuntimeActivityEvent[];
	latestHeight?: number;
	nextBeforeHeight?: number | null;
	availability?: 'complete' | 'partial';
	unavailableThroughHeight?: number;
};

export function useMovements(
	entityId: string | null,
	types: readonly string[],
	limit: number,
	accountIds: readonly string[],
	filters: RuntimeAdapterReadQuery = {},
): {
	nextBeforeHeight: number | null;
	/** Frames through this height are not on this device (e.g. before a restore). */
	unavailableThroughHeight: number;
	partial: boolean;
	movements: Movement[];
	loading: boolean;
	error: string | null;
} {
	const query = useMemo(() => ({ ...filters, limit, types: [...types], ...(entityId ? { entityId } : {}) }), [entityId, limit, types, filters]);
	const page = useAdapterRead<ActivityPage>(entityId ? 'activity' : null, query);
	const accountsKey = accountIds.join(',');
	const movements = useMemo(
		() => walletMovements(page.data?.events ?? [], entityId, accountsKey ? accountsKey.split(',') : []),
		[page.data, entityId, accountsKey],
	);
	return {
		movements,
		loading: page.loading,
		error: page.error,
		nextBeforeHeight: page.data?.nextBeforeHeight ?? null,
		unavailableThroughHeight: page.data?.unavailableThroughHeight ?? 0,
		partial: page.data?.availability === 'partial',
	};
}
