import type { RuntimeReplica, XLNModule } from '@xln/core/api/public/runtime-module';

type CatchupApi = Pick<
  XLNModule,
  'getJWatcherDrainStatus' | 'isJWatcherDrainComplete' | 'observeJWatcherDrainProgress' | 'getJWatcherDrainProgressKey'
>;
type CatchupTarget = Parameters<XLNModule['getJWatcherDrainStatus']>[1];
type DrainStatus = ReturnType<XLNModule['getJWatcherDrainStatus']>;

/** What the wallet screen shows while the j-catchup fence is closed. */
export type ChainSyncView = {
  state: 'syncing' | 'stalled';
  jurisdiction: string;
  through: number;
  target: number;
};

/** Catch-up polls only local state; this bounds CPU for a wait with no deadline. */
export const CHAIN_CATCHUP_POLL_MS = 500;

const STALLED = 'J_WATCHER_DRAIN_STALLED';
const CANCELLED = 'WALLET_LOCKED';

/** The session that started this catch-up no longer owns the wallet (lock, replacement). */
export const isChainCatchupCancelled = (error: unknown): boolean =>
  error instanceof Error && error.message === CANCELLED;

/** Throws WALLET_LOCKED once the session that started this work lost the wallet. */
export const assertSessionOwned = (owns: () => boolean): void => {
  if (!owns()) throw new Error(CANCELLED);
};

const authenticatedThrough = (status: DrainStatus): number =>
  Math.min(
    status.targetBlock,
    status.authenticatedThrough,
    ...status.replicas.map(replica => Math.max(replica.localScannedThrough, replica.authenticatedThrough)),
  );

/**
 * One poll of the shared J-watcher drain criterion; true once every captured
 * target drained. A stall uses the hubs' drain deadline: a hub that stalls
 * fails and its supervisor restarts the catch-up, so the wallet, which has no
 * supervisor, shows the stall and keeps polling with the fence closed. Progress
 * resets the deadline; nothing here ever opens the fence early. The probe
 * throws WALLET_LOCKED, before reading or publishing, once `owns` is false.
 */
export const createChainCatchupProbe = (
  xln: CatchupApi,
  env: RuntimeReplica,
  targets: readonly CatchupTarget[],
  nameOf: (chainId: number) => string,
  publish: (view: ChainSyncView | null) => void,
  owns: () => boolean,
  now: () => number = () => performance.now(),
): (() => boolean) => {
  let progress: ReturnType<CatchupApi['observeJWatcherDrainProgress']> | null = null;
  let shown = '';
  const show = (view: ChainSyncView | null): void => {
    const key = JSON.stringify(view);
    if (key === shown) return;
    shown = key;
    publish(view);
  };
  return () => {
    assertSessionOwned(owns);
    const statuses = targets.map(target => xln.getJWatcherDrainStatus(env, target));
    const lagging = statuses.find(status => !xln.isJWatcherDrainComplete(status));
    if (!lagging) {
      show(null);
      return true;
    }
    let stalled = false;
    try {
      progress = xln.observeJWatcherDrainProgress(progress, statuses.map(xln.getJWatcherDrainProgressKey).join('|'), now());
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith(STALLED)) throw error;
      stalled = true;
    }
    show({
      state: stalled ? 'stalled' : 'syncing',
      jurisdiction: nameOf(lagging.chainId),
      through: authenticatedThrough(lagging),
      target: lagging.targetBlock,
    });
    return false;
  };
};

/** Pending finality or a durable cursor can block completion too, so a stall names no single cause. */
export const chainSyncText = (view: ChainSyncView): string => {
  const position = `${view.jurisdiction}: block ${view.through.toLocaleString('en-US')} of ${view.target.toLocaleString('en-US')}`;
  return view.state === 'stalled'
    ? `Chain sync is not progressing. ${position}. Payments stay paused.`
    : `Syncing ${position}. Payments open when sync completes.`;
};

/** Opens the j-catchup fence only after `wait` saw the probe report a full drain, for the owning session. */
export const openAfterChainCatchup = async (
  xln: Pick<XLNModule, 'setRuntimeDeliveryReady'>,
  env: RuntimeReplica,
  probe: () => boolean,
  owns: () => boolean,
  wait: (probe: () => boolean) => Promise<void>,
): Promise<void> => {
  await wait(probe);
  assertSessionOwned(owns);
  xln.setRuntimeDeliveryReady(env, true);
};
