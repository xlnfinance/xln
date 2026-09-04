import type { RuntimeAdapterGraphFrame } from '../api/runtime-adapter/resolve';
import { buildRuntimeActivityEvents } from '../api/public/activity-history';
import { serializeTaggedJson } from '../protocol/serialization';
import type { EnvSnapshot } from '../runtime/types';
import type { RuntimeActivityEvent } from '../storage/views/activity-types';

export type NetworkTrailIndexFrame = {
  runtimeId: string;
  height: number;
  timestamp: number;
  stateHash: string;
  materialized: boolean;
  graphChanged?: boolean;
};

export type NetworkTrailV1 = {
  version: 1;
  runtimeId: string;
  index: { runtimeId: string; frames: NetworkTrailIndexFrame[] };
  frames: Record<string, RuntimeAdapterGraphFrame>;
  activity: RuntimeActivityEvent[];
  cues: NetworkTrailCue[];
};

export type NetworkTrailCue = {
  id: string;
  at: { runtimeId: string; height: number; timestamp: number };
  title: string;
  subtitle?: string;
  what?: string;
  why?: string;
  tradfiParallel?: string;
  keyMetrics?: string[];
};

type SnapshotAccount = {
  state?: {
    leftEntity?: unknown;
    rightEntity?: unknown;
    deltas?: ReadonlyMap<number, unknown>;
  };
  status?: unknown;
  mempool?: SnapshotAccountActivity[];
  currentFrame?: SnapshotAccountFrame;
  pendingFrame?: SnapshotAccountFrame;
  currentHeight?: unknown;
  rollbackCount?: unknown;
  lastRollbackFrameHash?: unknown;
  activeDispute?: { startedByLeft?: boolean; disputeTimeout?: number; initialNonce?: number };
};

type SnapshotAccountActivity = {
  type?: unknown;
  data?: unknown;
};

type SnapshotAccountFrame = {
  height?: unknown;
  timestamp?: unknown;
  jHeight?: unknown;
  prevFrameHash?: unknown;
  accountStateRoot?: unknown;
  stateHash?: unknown;
  accountTxs?: SnapshotAccountActivity[];
};

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

const integer = (value: unknown): number => {
  const parsed = Math.floor(Number(value ?? 0));
  return Number.isFinite(parsed) ? parsed : 0;
};

const graphAccountActivity = (tx: SnapshotAccountActivity): Record<string, unknown> => {
  const data = typeof tx.data === 'object' && tx.data !== null
    ? tx.data as Record<string, unknown>
    : {};
  const tokenId = Number(data['tokenId']);
  return {
    type: String(tx.type || ''),
    ...(Number.isSafeInteger(tokenId) && tokenId >= 0 ? { tokenId } : {}),
    ...(typeof data['amount'] === 'bigint' ? { amount: data['amount'] } : {}),
    ...(typeof data['fromEntityId'] === 'string' ? { fromEntityId: data['fromEntityId'] } : {}),
    ...(typeof data['toEntityId'] === 'string' ? { toEntityId: data['toEntityId'] } : {}),
  };
};

const graphAccountActivities = (txs: readonly SnapshotAccountActivity[]): Record<string, unknown>[] =>
  txs.slice(-2).map(graphAccountActivity);

const graphAccountFrame = (frame: SnapshotAccountFrame): Record<string, unknown> => ({
  height: integer(frame.height),
  timestamp: integer(frame.timestamp),
  jHeight: integer(frame.jHeight),
  ...(typeof frame.prevFrameHash === 'string' ? { prevFrameHash: frame.prevFrameHash } : {}),
  ...(frame.accountStateRoot !== undefined ? { accountStateRoot: frame.accountStateRoot } : {}),
  ...(frame.stateHash !== undefined ? { stateHash: frame.stateHash } : {}),
  accountTxs: graphAccountActivities(frame.accountTxs ?? []),
  accountTxCount: frame.accountTxs?.length ?? 0,
});

const graphAccountFromSnapshot = (
  observerEntityId: string,
  counterpartyId: string,
  account: SnapshotAccount,
): Record<string, unknown> => {
  const other = normalizeId(counterpartyId);
  const [leftEntity, rightEntity] = observerEntityId < other
    ? [observerEntityId, other]
    : [other, observerEntityId];
  const mempool = graphAccountActivities(account.mempool ?? []);
  return {
    leftEntity: normalizeId(account.state?.leftEntity) || leftEntity,
    rightEntity: normalizeId(account.state?.rightEntity) || rightEntity,
    status: account.status ?? 'open',
    mempool,
    mempoolCount: mempool.length,
    ...(account.currentFrame ? { currentFrame: graphAccountFrame(account.currentFrame) } : {}),
    ...(account.pendingFrame ? { pendingFrame: graphAccountFrame(account.pendingFrame) } : {}),
    deltas: new Map(account.state?.deltas ?? []),
    currentHeight: integer(account.currentHeight),
    rollbackCount: integer(account.rollbackCount),
    ...(account.lastRollbackFrameHash ? { lastRollbackFrameHash: account.lastRollbackFrameHash } : {}),
    ...(account.activeDispute ? {
      activeDispute: {
        startedByLeft: account.activeDispute.startedByLeft === true,
        disputeTimeout: integer(account.activeDispute.disputeTimeout),
        initialNonce: integer(account.activeDispute.initialNonce),
      },
    } : {}),
  };
};

/** Browser-safe projection shared by CLI recording and in-browser scenarios. */
export const graphFrameFromSnapshot = (
  runtimeId: string,
  snapshot: EnvSnapshot,
): RuntimeAdapterGraphFrame => {
  const height = integer(snapshot.state.height);
  const timestamp = integer(snapshot.state.timestamp);
  const profiles = new Map(
    (snapshot.gossip?.profiles ?? []).map((profile) => [normalizeId(profile.entityId), profile]),
  );
  const entities = Array.from(snapshot.state.eReplicas.values()).map((replica) => {
    const entityId = normalizeId(replica.entityId);
    const state = replica.state;
    const profile = profiles.get(entityId);
    const label = String(profile?.name || state?.profile?.name || entityId);
    const accounts = Array.from(state?.accounts?.entries?.() ?? [])
      .map(([counterpartyId, account]) => graphAccountFromSnapshot(entityId, counterpartyId, account));
    return {
      summary: { entityId, runtimeId, label, height, isHub: state?.profile?.isHub === true },
      core: {
        entityId,
        signerId: String(replica.signerId || ''),
        height: integer(state?.height ?? height),
        timestamp: integer(state?.timestamp ?? timestamp),
        ...(state?.prevFrameHash ? { prevFrameHash: state.prevFrameHash } : {}),
        reserves: state?.reserves instanceof Map ? new Map(state.reserves) : new Map(),
        profile: { name: label, isHub: state?.profile?.isHub === true },
      },
      accounts: { items: accounts, nextCursor: null },
    };
  }).sort((left, right) => left.summary.entityId.localeCompare(right.summary.entityId));

  return { runtimeId, height, timestamp, stateHash: '', entities } as RuntimeAdapterGraphFrame;
};

export const snapshotChangedGraph = (snapshot: EnvSnapshot): boolean => {
  const input = snapshot.runtimeInput;
  if ((input?.runtimeTxs?.length ?? 0) > 0 || (input?.jInputs?.length ?? 0) > 0) return true;
  return (input?.entityInputs ?? []).some((entry) => (entry.entityTxs?.length ?? 0) > 0);
};

export const activityEventsFromSnapshot = (
  runtimeId: string,
  snapshot: EnvSnapshot,
): RuntimeActivityEvent[] => buildRuntimeActivityEvents({
  height: integer(snapshot.state.height),
  timestamp: integer(snapshot.state.timestamp),
  ...(snapshot.runtimeInput ? { runtimeInput: snapshot.runtimeInput } : {}),
}).map((event) => ({ ...event, runtimeId: normalizeId(runtimeId) }));

const deterministicAccountFrame = (value: unknown): unknown => {
  if (!value || typeof value !== 'object') return value;
  const frame = value as Record<string, unknown>;
  return {
    ...frame,
    timestamp: integer(frame['height']),
    prevFrameHash: '',
    accountStateRoot: '',
    stateHash: '',
  };
};

const deterministicGraphFrame = (frame: RuntimeAdapterGraphFrame): RuntimeAdapterGraphFrame => ({
  ...frame,
  timestamp: frame.height,
  stateHash: '',
  entities: frame.entities.map((entity) => ({
    ...entity,
    core: entity.core ? { ...entity.core, timestamp: entity.core.height, prevFrameHash: '' } : null,
    accounts: {
      ...entity.accounts,
      items: entity.accounts.items.map((account) => ({
        ...account,
        currentFrame: deterministicAccountFrame(account.currentFrame) as typeof account.currentFrame,
        ...(account.pendingFrame
          ? { pendingFrame: deterministicAccountFrame(account.pendingFrame) as typeof account.pendingFrame }
          : {}),
        ...(account.activeDispute
          ? { activeDispute: { ...account.activeDispute, disputeTimeout: 0 } }
          : {}),
        lastRollbackFrameHash: '',
      })),
    },
  })),
});

const deterministicActivity = (event: RuntimeActivityEvent): RuntimeActivityEvent => ({
  ...event,
  timestamp: event.height,
  ...('hash' in event ? { hash: '' } : {}),
});

export const networkTrailFromSnapshots = (
  runtimeId: string,
  snapshots: readonly EnvSnapshot[],
): NetworkTrailV1 => {
  const expected = normalizeId(runtimeId);
  if (!expected) throw new Error('NETWORK_TIMELINE_RUNTIME_ID_REQUIRED');
  const ordered = [...snapshots]
    .filter((snapshot) => integer(snapshot.state.height) >= 1)
    .sort((left, right) => integer(left.state.height) - integer(right.state.height));
  const frames: Record<string, RuntimeAdapterGraphFrame> = {};
  const activity: RuntimeActivityEvent[] = [];
  const cues: NetworkTrailCue[] = [];
  const indexFrames = ordered.map((snapshot) => {
    const height = integer(snapshot.state.height);
    frames[String(height)] = deterministicGraphFrame(graphFrameFromSnapshot(expected, snapshot));
    activity.push(...activityEventsFromSnapshot(expected, snapshot).map(deterministicActivity));
    const subtitle = snapshot.meta?.subtitle;
    if (subtitle) {
      const shortSubtitle = String(subtitle.what || snapshot.narrative || snapshot.description || '').trim();
      cues.push({
        id: `authored:${expected}:h${height}`,
        at: { runtimeId: expected, height, timestamp: height },
        title: subtitle.title,
        ...(shortSubtitle ? { subtitle: shortSubtitle } : {}),
        ...(subtitle.what ? { what: subtitle.what } : {}),
        ...(subtitle.why ? { why: subtitle.why } : {}),
        ...(subtitle.tradfiParallel ? { tradfiParallel: subtitle.tradfiParallel } : {}),
        ...(subtitle.keyMetrics ? { keyMetrics: [...subtitle.keyMetrics] } : {}),
      });
    }
    return {
      runtimeId: expected,
      height,
      timestamp: height,
      stateHash: '',
      materialized: true,
      graphChanged: snapshotChangedGraph(snapshot),
    };
  });
  activity.sort((left, right) => left.height - right.height || left.id.localeCompare(right.id));
  return {
    version: 1,
    runtimeId: expected,
    index: { runtimeId: expected, frames: indexFrames },
    frames,
    activity,
    cues,
  };
};

export const serializeNetworkTrailV1 = (trail: NetworkTrailV1): string =>
  serializeTaggedJson(trail);
