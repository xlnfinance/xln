import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RuntimeAdapterReadQuery } from '@xln/runtime/api/runtime-adapter/types';
import { getAdapter } from './adapter';
import { useApp } from './store';

export type ReadState<T> = {
	data: T | null;
	error: string | null;
	loading: boolean;
	refresh: () => void;
};

/**
 * Adapter read that re-runs on every committed runtime frame.
 *
 * Single code path for embedded and remote: both come through
 * RuntimeAdapter.read plus the onChange tick mirrored in the store.
 */
export function useAdapterRead<T>(path: string | null, query?: RuntimeAdapterReadQuery): ReadState<T> {
	const height = useApp(s => s.height);
	const status = useApp(s => s.adapterStatus);
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState<boolean>(Boolean(path));
	const [manualTick, setManualTick] = useState(0);
	const generation = useRef(0);

	const queryKey = useMemo(() => JSON.stringify(query ?? null), [query]);

	useEffect(() => {
		const adapter = getAdapter();
		if (!path || !adapter || status !== 'connected') {
			return;
		}
		const gen = ++generation.current;
		let cancelled = false;
		adapter
			.read<T>(path, query)
			.then(result => {
				if (cancelled || gen !== generation.current) return;
				setData(result);
				setError(null);
				setLoading(false);
			})
			.catch((readError: unknown) => {
				if (cancelled || gen !== generation.current) return;
				setError(readError instanceof Error ? readError.message : String(readError));
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [path, queryKey, height, status, manualTick]);

	const refresh = useCallback(() => setManualTick(t => t + 1), []);

	return { data, error, loading, refresh };
}

export function useConnected(): boolean {
	return useApp(s => s.adapterStatus === 'connected');
}
