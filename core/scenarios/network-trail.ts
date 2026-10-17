import type { RuntimeAdapterGraphEntityCore, RuntimeAdapterGraphFrame } from '../api/runtime-adapter/read/graph-frame';
import { buildRuntimeActivityEvents } from '../api/public/activity-history';
import { serializeTaggedJson } from '../protocol/serialization';
import type { EnvSnapshot } from '../runtime/types';
import type { RuntimeActivityEvent } from '../storage/views/activity-types';
import type { NarrationBadge, ScenarioNarrationBeat } from './harness/narration';

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
  /** Entities whose input this frame processed — what the narration is about. */
  focusEntityIds?: string[];
  /** Bilateral accounts (`left:right`) those inputs touched. */
  focusAccountIds?: string[];
  /** A ladder the narration walks, e.g. bilateral → on-chain → legal finality. */
  badges?: NarrationBadge[];
  /** A presentation starts at this cue: every earlier step is setup it summarises. */
  condensePrior?: true;
  /** A presentation ends at this cue; later frames stay in the full timeline only. */
  endsPresentation?: true;
};

type SnapshotSwapOffer = { giveTokenId?: unknown; wantTokenId?: unknown };

type SnapshotAccount = {
  state?: {
    leftEntity?: unknown;
    rightEntity?: unknown;
    deltas?: ReadonlyMap<number, unknown>;
    swapOffers?: { get(offerId: string): SnapshotSwapOffer | undefined };
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

type SwapOfferLookup = (offerId: string) => SnapshotSwapOffer | undefined;

const tokenIdField = (value: unknown): number | undefined => {
  const tokenId = Number(value);
  return Number.isSafeInteger(tokenId) && tokenId > 0 ? tokenId : undefined;
};

/**
 * Both legs of a swap, maker's view: an offer states them, a fill states its execution amounts
 * against the resting offer. A replay labels the trade with these; a partial leg is omitted.
 */
const swapLegs = (type: string, data: Record<string, unknown>, offerOf: SwapOfferLookup): Record<string, unknown> => {
  const offer = type === 'swap_resolve' ? offerOf(String(data['offerId'] ?? '')) : undefined;
  const legs = type === 'swap_offer'
    ? [data['giveTokenId'], data['giveAmount'], data['wantTokenId'], data['wantAmount']]
    : type === 'swap_resolve'
      ? [offer?.giveTokenId, data['executionGiveAmount'], offer?.wantTokenId, data['executionWantAmount']]
      : [];
  const [giveTokenId, giveAmount, wantTokenId, wantAmount] = [tokenIdField(legs[0]), legs[1], tokenIdField(legs[2]), legs[3]];
  if (giveTokenId === undefined || wantTokenId === undefined) return {};
  if (typeof giveAmount !== 'bigint' || typeof wantAmount !== 'bigint') return {};
  return { giveTokenId, giveAmount, wantTokenId, wantAmount };
};

const graphAccountActivity = (tx: SnapshotAccountActivity, offerOf: SwapOfferLookup): Record<string, unknown> => {
  const data = typeof tx.data === 'object' && tx.data !== null
    ? tx.data as Record<string, unknown>
    : {};
  const tokenId = Number(data['tokenId']);
  const type = String(tx.type || '');
  return {
    type,
    ...(Number.isSafeInteger(tokenId) && tokenId >= 0 ? { tokenId } : {}),
    ...(typeof data['amount'] === 'bigint' ? { amount: data['amount'] } : {}),
    ...(typeof data['fromEntityId'] === 'string' ? { fromEntityId: data['fromEntityId'] } : {}),
    ...(typeof data['toEntityId'] === 'string' ? { toEntityId: data['toEntityId'] } : {}),
    ...swapLegs(type, data, offerOf),
  };
};

const graphAccountActivities = (
  txs: readonly SnapshotAccountActivity[],
  offerOf: SwapOfferLookup,
): Record<string, unknown>[] => txs.slice(-2).map((tx) => graphAccountActivity(tx, offerOf));

const graphAccountFrame = (frame: SnapshotAccountFrame, offerOf: SwapOfferLookup): Record<string, unknown> => ({
  height: integer(frame.height),
  timestamp: integer(frame.timestamp),
  jHeight: integer(frame.jHeight),
  ...(typeof frame.prevFrameHash === 'string' ? { prevFrameHash: frame.prevFrameHash } : {}),
  ...(frame.accountStateRoot !== undefined ? { accountStateRoot: frame.accountStateRoot } : {}),
  ...(frame.stateHash !== undefined ? { stateHash: frame.stateHash } : {}),
  accountTxs: graphAccountActivities(frame.accountTxs ?? [], offerOf),
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
  const offers = account.state?.swapOffers;
  const offerOf: SwapOfferLookup = (offerId) => offers?.get(offerId);
  const mempool = graphAccountActivities(account.mempool ?? [], offerOf);
  return {
    leftEntity: normalizeId(account.state?.leftEntity) || leftEntity,
    rightEntity: normalizeId(account.state?.rightEntity) || rightEntity,
    status: account.status ?? 'open',
    mempool,
    mempoolCount: mempool.length,
    ...(account.currentFrame ? { currentFrame: graphAccountFrame(account.currentFrame, offerOf) } : {}),
    ...(account.pendingFrame ? { pendingFrame: graphAccountFrame(account.pendingFrame, offerOf) } : {}),
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

type SnapshotDebt = { tokenId: number; creditor: string; remainingAmount: bigint; createdDebtIndex: number };

/** One on-chain debt in a trail frame: what the entity still owes, and its queue position. */
export type TrailGraphDebt = { tokenId: number; creditor: string; remaining: bigint; queueIndex: number };

/** A trail's entity core: the live graph core plus the debts the entity owes on-chain. */
export type TrailGraphEntityCore = RuntimeAdapterGraphEntityCore & { debts?: TrailGraphDebt[] };

const graphDebtsFromState = (
  byToken: ReadonlyMap<number, ReadonlyMap<string, SnapshotDebt>> | undefined,
): TrailGraphDebt[] =>
  Array.from(byToken?.values() ?? [])
    .flatMap((debts) => Array.from(debts.values()))
    .filter((debt) => debt.remainingAmount > 0n)
    .map((debt) => ({ tokenId: debt.tokenId, creditor: normalizeId(debt.creditor), remaining: debt.remainingAmount, queueIndex: integer(debt.createdDebtIndex) }))
    .sort((left, right) => left.tokenId - right.tokenId || left.queueIndex - right.queueIndex);

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
    // Same summary shape the live adapter publishes: the jurisdiction name is what lets a
    // replay render its J-machine. Addresses stay out — they vary per anvil lease.
    const jurisdictionName = String(state?.config?.jurisdiction?.name || '').trim();
    // The scenario's authored stage position: a replay places banks where a live run does.
    const position = replica.position
      ? { x: replica.position.x, y: replica.position.y, z: replica.position.z }
      : null;
    return {
      summary: {
        entityId, runtimeId, label, height, isHub: state?.profile?.isHub === true,
        ...(jurisdictionName ? { jurisdiction: { name: jurisdictionName } } : {}),
        ...(position ? { position } : {}),
      },
      core: <TrailGraphEntityCore>{
        entityId,
        signerId: String(replica.signerId || ''),
        height: integer(state?.height ?? height),
        timestamp: integer(state?.timestamp ?? timestamp),
        ...(state?.prevFrameHash ? { prevFrameHash: state.prevFrameHash } : {}),
        reserves: state?.reserves instanceof Map ? new Map(state.reserves) : new Map(),
        // On-chain debts this entity owes, in the Depository's first-come queue order. A
        // replay shows a shortfall that became debt; tx hashes stay out (they vary per lease).
        debts: graphDebtsFromState(state?.outDebtsByToken),
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

const ENTITY_ID_PATTERN = /^0x[0-9a-f]{64}$/;
const FOCUS_COUNTERPARTY_KEYS = [
  'toEntityId', 'fromEntityId', 'targetEntityId', 'counterpartyId', 'counterpartyEntityId',
  'receivingEntity', 'receivingEntityId',
] as const;

const focusEntityId = (value: unknown): string => {
  const entityId = normalizeId(value);
  return ENTITY_ID_PATTERN.test(entityId) ? entityId : '';
};

const focusAccountId = (left: string, right: string): string =>
  left < right ? `${left}:${right}` : `${right}:${left}`;

/** Parties one entity tx names: an explicit route wins, otherwise its counterparty fields. */
const focusPairsOfTx = (self: string, data: Record<string, unknown>): Array<[string, string]> => {
  const route = Array.isArray(data['route']) ? data['route'].map(focusEntityId).filter(Boolean) : [];
  if (route.length >= 2) return route.slice(1).map((hop, index) => [route[index]!, hop]);
  return FOCUS_COUNTERPARTY_KEYS
    .map((key) => focusEntityId(data[key]))
    .filter((other) => other && other !== self)
    .map((other) => [self, other]);
};

/**
 * Who a frame's inputs touched. Authored narration describes exactly these parties, so the
 * replay can light them and dim the rest without a second, hand-written focus list.
 */
const snapshotFocus = (snapshot: EnvSnapshot): { entityIds: string[]; accountIds: string[] } => {
  const entityIds = new Set<string>();
  const accountIds = new Set<string>();
  for (const input of snapshot.runtimeInput?.entityInputs ?? []) {
    const self = focusEntityId(input.entityId);
    if (!self) continue;
    entityIds.add(self);
    for (const tx of input.entityTxs ?? []) {
      const data = typeof tx.data === 'object' && tx.data !== null ? tx.data as Record<string, unknown> : {};
      for (const [left, right] of focusPairsOfTx(self, data)) {
        entityIds.add(left);
        entityIds.add(right);
        accountIds.add(focusAccountId(left, right));
      }
    }
  }
  return { entityIds: [...entityIds].sort(), accountIds: [...accountIds].sort() };
};

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

/**
 * A beat narrates a frame that is already committed, so it becomes a cue of its own on that
 * frame: same height, a distinct id that sorts after the frame's announcing cue.
 */
const beatCues = (
  runtimeId: string,
  beats: readonly ScenarioNarrationBeat[],
  focusByHeight: ReadonlyMap<number, { entityIds: string[]; accountIds: string[] }>,
): NetworkTrailCue[] => {
  const perHeight = new Map<number, number>();
  return beats.map((beat) => {
    const focus = focusByHeight.get(beat.height);
    if (!focus) throw new Error(`NETWORK_TRAIL_BEAT_FRAME_MISSING:h${beat.height}:${beat.title}`);
    const ordinal = perHeight.get(beat.height) ?? 0;
    perHeight.set(beat.height, ordinal + 1);
    const entityIds = beat.focusEntityIds ? [...new Set(beat.focusEntityIds.map(normalizeId))].sort() : focus.entityIds;
    return {
      id: `authored:${runtimeId}:h${beat.height}:b${String(ordinal).padStart(2, '0')}`,
      at: { runtimeId, height: beat.height, timestamp: beat.height },
      title: beat.title,
      ...(beat.what ? { subtitle: beat.what, what: beat.what } : {}),
      ...(beat.why ? { why: beat.why } : {}),
      ...(beat.tradfiParallel ? { tradfiParallel: beat.tradfiParallel } : {}),
      ...(beat.keyMetrics ? { keyMetrics: [...beat.keyMetrics] } : {}),
      ...(beat.badges ? { badges: beat.badges.map((badge) => ({ ...badge })) } : {}),
      ...(beat.condensePrior ? { condensePrior: true as const } : {}),
      ...(beat.endsPresentation ? { endsPresentation: true as const } : {}),
      ...(entityIds.length > 0 ? { focusEntityIds: entityIds } : {}),
      ...(!beat.focusEntityIds && focus.accountIds.length > 0 ? { focusAccountIds: focus.accountIds } : {}),
    };
  });
};

export const networkTrailFromSnapshots = (
  runtimeId: string,
  snapshots: readonly EnvSnapshot[],
  beats: readonly ScenarioNarrationBeat[] = [],
): NetworkTrailV1 => {
  const expected = normalizeId(runtimeId);
  if (!expected) throw new Error('NETWORK_TIMELINE_RUNTIME_ID_REQUIRED');
  const ordered = [...snapshots]
    .filter((snapshot) => integer(snapshot.state.height) >= 1)
    .sort((left, right) => integer(left.state.height) - integer(right.state.height));
  const frames: Record<string, RuntimeAdapterGraphFrame> = {};
  const activity: RuntimeActivityEvent[] = [];
  const cues: NetworkTrailCue[] = [];
  const focusByHeight = new Map<number, { entityIds: string[]; accountIds: string[] }>();
  const indexFrames = ordered.map((snapshot) => {
    const height = integer(snapshot.state.height);
    frames[String(height)] = deterministicGraphFrame(graphFrameFromSnapshot(expected, snapshot));
    activity.push(...activityEventsFromSnapshot(expected, snapshot).map(deterministicActivity));
    const focus = snapshotFocus(snapshot);
    focusByHeight.set(height, focus);
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
        ...(focus.entityIds.length > 0 ? { focusEntityIds: focus.entityIds } : {}),
        ...(focus.accountIds.length > 0 ? { focusAccountIds: focus.accountIds } : {}),
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
  cues.push(...beatCues(expected, beats, focusByHeight));
  cues.sort((left, right) => left.at.height - right.at.height || left.id.localeCompare(right.id));
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
