import { safeStringify } from '../protocol/serialization';

type SnapshotQuiescence = {
  pendingRuntimeWork?: number;
  pendingReliableOutputs?: number;
  pendingAccountFrames?: number;
  accountMempoolTxs?: number;
};

type SnapshotHub = {
  name: string;
  online: boolean;
  height: number | undefined;
  quiescence: SnapshotQuiescence | null | undefined;
};

export type HubReadySnapshotFence = {
  ready: boolean;
  signature: string;
  hubs: Array<{
    name: string;
    online: boolean;
    height: number;
    pendingRuntimeWork: number | null;
    pendingReliableOutputs: number | null;
    pendingAccountFrames: number | null;
    accountMempoolTxs: number | null;
  }>;
};

const count = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

/**
 * A ready snapshot is only requested after every hub reports a fully drained
 * runtime. This keeps the checkpoint endpoint a short atomic fence instead of
 * making three one-CPU children compete while they still process bootstrap work.
 */
export const buildHubReadySnapshotFence = (hubs: SnapshotHub[]): HubReadySnapshotFence => {
  const rows = hubs.map(hub => ({
    name: hub.name,
    online: hub.online,
    height: count(hub.height) ?? 0,
    pendingRuntimeWork: count(hub.quiescence?.pendingRuntimeWork),
    pendingReliableOutputs: count(hub.quiescence?.pendingReliableOutputs),
    pendingAccountFrames: count(hub.quiescence?.pendingAccountFrames),
    accountMempoolTxs: count(hub.quiescence?.accountMempoolTxs),
  })).sort((left, right) => left.name.localeCompare(right.name));
  const ready = rows.length > 0 && rows.every(row =>
    row.online
    && row.pendingRuntimeWork === 0
    && row.pendingReliableOutputs === 0
    && row.pendingAccountFrames === 0
    && row.accountMempoolTxs === 0
  );
  return {
    ready,
    signature: safeStringify(rows),
    hubs: rows,
  };
};
