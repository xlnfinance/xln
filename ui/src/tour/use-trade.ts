import { useEffect, useMemo, useState } from 'react';
import { getAdapter } from '../runtime/adapter';
import { useApp } from '../runtime/store';
import { createTutorialTradeReader, useTutorialTrade, type TutorialTrade } from './trade';

export function useTradeCompletion(active: boolean, entityId: string): { filled: boolean; error: string | null } {
  const pending = useTutorialTrade(s => s.pending);
  const height = useApp(s => s.height);
  const status = useApp(s => s.adapterStatus);
  const vaultId = useApp(s => s.activeVaultId);
  const [result, setResult] = useState<{ trade: TutorialTrade; filled: boolean; error: string | null } | null>(null);
  const reader = useMemo(() => (pending ? createTutorialTradeReader(pending) : null), [pending]);

  useEffect(() => {
    if (!active || pending?.entityId !== entityId) useTutorialTrade.getState().setPending(null);
  }, [active, entityId, pending]);

  useEffect(() => {
    const adapter = getAdapter();
    if (!active || !pending || pending.entityId !== entityId || !reader || !adapter || status !== 'connected') return;
    let cancelled = false;
    void reader(adapter, height).then(
      filled => {
        if (!cancelled) setResult({ trade: pending, filled, error: null });
      },
      error => {
        if (!cancelled) setResult({ trade: pending, filled: false, error: String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, entityId, pending, reader, height, status, vaultId]);

  return active &&
    pending?.entityId === entityId &&
    pending.runtimeId === getAdapter()?.runtimeId &&
    result?.trade === pending
    ? result
    : { filled: false, error: null };
}
