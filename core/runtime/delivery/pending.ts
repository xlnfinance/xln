import { keccakTextHash } from '../../protocol/crypto/keccak-text';
import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import type {
  DeliverableEntityInput,
  RuntimeReplica,
  RoutedEntityInput,
  RuntimeEntityInputsEnvelope,
} from '../types';
import { createStructuredLogger } from '../../support/logger';
import { compareStableText, safeStringify } from '../../protocol/serialization';
import { getWallClockMs } from '../../support/time';
import { validateDeliverableEntityInput } from '../delivery/topology/routing-validation';
import { recordRuntimeSecurityIncident } from '../observability/security-incidents';
import { computeProfileRouteHash } from '../../entity/profile/profile-signing';
import { recoverDigestSignerAddress } from '../../account/crypto';
import { matchesTraceSuffix, traceAllDeferredEnabled, traceLog } from '../../support/trace-debug';
import { ACCOUNT_PENDING_STALE_WARNING_MS } from '../../entity/scheduler/config/timing';

import { getEffectiveEntityInputTxs, orderCertifiedOutputsBySequence } from '../../entity/consensus/output/envelope';
import { accountInputAck, accountInputProposal } from '../../account/consensus/flush';
import {
  deliveryAccepted,
  deliveryDeferred,
  deliveryQueued,
  requireDeliveryResult,
  type DeliveryResult,
} from '../../protocol/payments/delivery-result';
import { explainCrossJPairing, selectPotentialCrossJAccountInputPairs } from '../delivery/topology/entity-routing';
import {
  accountProposalSettledBySender,
  accountProposalEvidenceRank,
  accountProposalOutputIdentity,
  buildRouteOutputKey,
  carriesEntityCommitNotification,
  copyRoutedOutputForMerge,
  normalizeRouteText,
} from './identity';
import { createPreparedOutputGraph, type PreparedOutputGraph } from './prepared-output';

const routeLog = createStructuredLogger('network.route');

const shortPairKey = (pairKey: string): string =>
  `${keccakTextHash(pairKey).slice(0, 18)}:len=${pairKey.length}`;

const summarizeAtomicUnitOutput = (
  output: RoutedEntityInput,
): Record<string, unknown> => {
  const marker = output.atomicCrossJurisdictionPair;
  const accountInputs = getEffectiveEntityInputTxs(output).flatMap(tx => {
    if (tx.type !== 'accountInput') return [];
    const proposal = accountInputProposal(tx.data);
    const ack = accountInputAck(tx.data);
    const pullOrders =
      proposal?.frame.accountTxs.flatMap(accountTx =>
        accountTx.type === 'cross_pull_lock' && accountTx.data.crossJurisdiction
          ? [`${accountTx.data.crossJurisdiction.leg}:${accountTx.data.crossJurisdiction.orderId.slice(-24)}`]
          : [],
      ) ?? [];
    return [
      {
        kind: tx.data.kind,
        from: tx.data.fromEntityId,
        to: tx.data.toEntityId,
        proposalHeight: proposal?.frame.height ?? null,
        ackHeight: ack?.height ?? null,
        pullOrders: pullOrders.slice(0, 6),
        pullCount: pullOrders.length,
      },
    ];
  });
  return {
    entityId: output.entityId,
    targetRuntimeId: output.runtimeId,
    entityTxTypes: [...new Set((output.entityTxs ?? []).map(tx => tx.type))],
    sourceRuntimeFrame: output.sourceRuntimeFrame ?? null,
    marker: marker ? { phase: marker.phase, pairKey: shortPairKey(marker.pairKey) } : null,
    accountInputs,
  };
};

const incompleteAtomicUnitLogAt = new Map<string, number>();
const INCOMPLETE_ATOMIC_UNIT_LOG_INTERVAL_MS = 5_000;

const completeAtomicUnitWaitingLogAt = new Map<string, number>();

const logCompleteAtomicUnitWaiting = (
  unit: { outputs: readonly RoutedEntityInput[] },
  retryMeta: ReadonlyArray<Record<string, unknown>>,
): void => {
  if (!unit.outputs.some(output => isCrossJAdmissionProposal(output))) return;
  const key = buildRouteOutputKey(unit.outputs[0]!);
  const now = getWallClockMs();
  if (now - (completeAtomicUnitWaitingLogAt.get(key) ?? 0) < INCOMPLETE_ATOMIC_UNIT_LOG_INTERVAL_MS) return;
  completeAtomicUnitWaitingLogAt.set(key, now);
  routeLog.info('crossj.atomic_complete_waiting', {
    outputs: unit.outputs.map(summarizeAtomicUnitOutput),
    retryMeta,
  });
};

const logIncompleteAtomicUnitParked = (
  env: RuntimeReplica,
  unit: { outputs: readonly RoutedEntityInput[] },
  allPending: readonly RoutedEntityInput[],
): void => {
  const marker = unit.outputs[0]?.atomicCrossJurisdictionPair;
  const key = marker ? marker.pairKey : buildRouteOutputKey(unit.outputs[0]!);
  const now = getWallClockMs();
  const lastAt = incompleteAtomicUnitLogAt.get(key) ?? 0;
  if (now - lastAt < INCOMPLETE_ATOMIC_UNIT_LOG_INTERVAL_MS) return;
  incompleteAtomicUnitLogAt.set(key, now);
  if (marker?.phase === 'ack') {
    // ACK cohorts are born complete in one Runtime frame's outbox and are
    // sent as a whole. A lone ack-marked leg
    // therefore cannot exist under the pairwise-communication invariant; one
    // here means a new splitter crept in upstream and this leg is wedged.
    recordRuntimeSecurityIncident(env, {
      domain: 'cross-j',
      code: 'CROSS_J_ATOMIC_ACK_LEG_UNPAIRED',
      source: 'local-consensus',
      severity: 'critical',
      summary: 'Atomic cross-j ACK leg observed without its sibling in the transport outbox',
      entityId: unit.outputs[0]?.entityId ?? '',
    });
  }
  const unitOutputs = new Set(unit.outputs);
  routeLog.info('crossj.atomic_incomplete_parked', {
    reason: marker
      ? `explicit-${marker.phase}-group-size-${unit.outputs.length}`
      : 'lone-cross-j-proposal',
    outputs: unit.outputs.map(summarizeAtomicUnitOutput),
    // The sibling this unit is waiting for should be another cross-j output in
    // the same pending set. Listing them shows whether it is absent entirely
    // (producer-side gap) or present with a diverging route set (pairing gap).
    otherCrossJPending: allPending
      .filter(output => !unitOutputs.has(output) && isCrossJAdmissionProposal(output))
      .slice(0, 4)
      .map(summarizeAtomicUnitOutput),
    pairing: explainCrossJPairing(
      allPending.filter(output => isCrossJAdmissionProposal(output)).slice(0, 6),
    ),
  });
};

const incompleteAtomicUnitRecoveryDeadline = (
  unit: { outputs: readonly RoutedEntityInput[] },
): number => {
  const output = unit.outputs[0];
  if (!output) return 0;
  // A marker is assigned only after a complete pair has been formed. Seeing
  // one marked leg alone therefore cannot be an ordinary adjacent-frame wait:
  // a splitter, corrupt snapshot, or partial mutation destroyed an atomic
  // transport unit. Wake immediately so the applying loop fails loud.
  if (output.atomicCrossJurisdictionPair) return 0;
  const timestamp = output.sourceRuntimeFrame?.timestamp;
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0) return 0;
  const deadline = timestamp + ACCOUNT_PENDING_STALE_WARNING_MS;
  return Number.isSafeInteger(deadline) ? deadline : 0;
};

const assertIncompleteAtomicUnitRecoverable = (
  env: RuntimeReplica,
  unit: { outputs: readonly RoutedEntityInput[] },
  nowMs: number,
): void => {
  const output = unit.outputs[0];
  if (!output) throw new Error('CROSS_J_ATOMIC_COHORT_EMPTY');
  const marker = output.atomicCrossJurisdictionPair;
  if (marker) {
    throw new Error(
      `CROSS_J_ATOMIC_COHORT_ORPHANED:${marker.phase}:${shortPairKey(marker.pairKey)}`,
    );
  }
  const deadline = incompleteAtomicUnitRecoveryDeadline(unit);
  if (deadline > nowMs) return;
  recordRuntimeSecurityIncident(env, {
    domain: 'cross-j',
    code: 'CROSS_J_INCOMPLETE_COHORT_DROPPED',
    source: 'local-consensus',
    severity: 'critical',
    summary: 'Incomplete cross-j proposal cohort exceeded the Account pending-frame liveness window',
    entityId: output.entityId,
  });
  throw new Error(
    `CROSS_J_ATOMIC_COHORT_RECOVERY_EXPIRED:` +
    `sourceHeight=${String(output.sourceRuntimeFrame?.height)}:` +
    `deadline=${deadline}:now=${nowMs}`,
  );
};

export const MAX_PENDING_NETWORK_OUTPUTS = 10_000;
const NETWORK_RETRY_BASE_MS = 1_000;
// Best-effort delivery: one short exponential cap for every lane keeps
// bilateral and Entity-consensus liveness through a normal peer restart.
const NETWORK_RETRY_MAX_MS = 4_000;

export const isCrossJAdmissionSourceProposal = (output: RoutedEntityInput): boolean =>
  getEffectiveEntityInputTxs(output).some(tx => {
    if (tx.type !== 'accountInput') return false;
    const proposal = accountInputProposal(tx.data);
    if (!proposal) return false;
    const sourcePull = proposal.frame.accountTxs.find(
      accountTx => accountTx.type === 'cross_pull_lock' && accountTx.data.crossJurisdiction?.leg === 'source',
    );
    const binding = sourcePull?.type === 'cross_pull_lock' ? sourcePull.data.crossJurisdiction : undefined;
    if (!binding) return false;
    return proposal.frame.accountTxs.some(
      accountTx =>
        accountTx.type === 'swap_offer' &&
        accountTx.data.crossJurisdiction?.orderId === binding.orderId &&
        String(accountTx.data.crossJurisdiction.routeHash || '').toLowerCase() ===
          String(binding.routeHash || '').toLowerCase(),
    );
  });

const isCrossJAdmissionProposal = (output: RoutedEntityInput): boolean =>
  getEffectiveEntityInputTxs(output).some(tx => {
    if (tx.type !== 'accountInput') return false;
    const proposal = accountInputProposal(tx.data);
    return Boolean(
      proposal?.frame.accountTxs.some(
        accountTx =>
          (accountTx.type === 'cross_pull_lock' && accountTx.data.crossJurisdiction) ||
          accountTx.type === 'cross_pull_close' ||
          accountTx.type === 'cross_swap_fill_ack' ||
          accountTx.type === 'cross_pull_progress',
      ),
    );
  });

export const summarizeAccountEnvelopeOutputs = (outputs: readonly RoutedEntityInput[]) =>
  outputs.map(output => ({
    entityId: output.entityId,
    signerId: output.signerId,
    sourceRuntimeFrame: output.sourceRuntimeFrame ?? null,
    accountInputs: getEffectiveEntityInputTxs(output).flatMap(tx => {
      if (tx.type !== 'accountInput') return [];
      const ack = accountInputAck(tx.data);
      const proposal = accountInputProposal(tx.data);
      return [
        {
          kind: tx.data.kind,
          fromEntityId: tx.data.fromEntityId,
          toEntityId: tx.data.toEntityId,
          ackHeight: ack?.height ?? null,
          proposalHeight: proposal?.frame.height ?? null,
          // Two legs at one Account height are either the same signed proposal
          // retried on a later Runtime frame or two different proposals racing
          // that height. Only the state hash tells those apart, and they need
          // opposite fixes.
          proposalStateHash: proposal?.frame.stateHash ?? null,
          crossPulls:
            proposal?.frame.accountTxs.flatMap(accountTx =>
              accountTx.type === 'cross_pull_lock' && accountTx.data.crossJurisdiction
                ? [
                    {
                      leg: accountTx.data.crossJurisdiction.leg,
                      orderId: accountTx.data.crossJurisdiction.orderId,
                      routeHash: accountTx.data.crossJurisdiction.routeHash,
                    },
                  ]
                : [],
            ) ?? [],
        },
      ];
    }),
  }));

export const groupAtomicCrossJAdmissionOutputs = <T extends RoutedEntityInput>(
  outputs: readonly T[],
): Array<{ outputs: T[]; atomic: boolean; complete: boolean }> => {
  type IndexedUnit = {
    firstIndex: number;
    outputs: T[];
    atomic: boolean;
    complete: boolean;
  };
  const claimed = new Set<number>();
  const indexed: IndexedUnit[] = [];

  // ACK pairs already carry their proposal cohort identity. Group that exact
  // identity before any target batching so two sequential cohorts can never be
  // collapsed into one envelope with one misleading pairKey.
  const explicitGroups = new Map<string, number[]>();
  for (const [index, output] of outputs.entries()) {
    const pair = output.atomicCrossJurisdictionPair;
    if (!pair) continue;
    const key = safeStringify(pair);
    const indexes = explicitGroups.get(key) ?? [];
    indexes.push(index);
    explicitGroups.set(key, indexes);
  }
  for (const indexes of explicitGroups.values()) {
    indexes.forEach(index => claimed.add(index));
    indexed.push({
      firstIndex: Math.min(...indexes),
      outputs: indexes.map(index => outputs[index]!),
      atomic: true,
      complete: indexes.length === 2,
    });
  }

  // Sibling Entity consensus can certify the two Account legs in adjacent
  // Runtime frames. Neither leg leaves this outbox alone. Pair exact route
  // bytes here, then buildRuntimeEntityInputsEnvelope assigns one shared
  // transport frame that the receiver requires before applying either leg.
  for (const pair of selectPotentialCrossJAccountInputPairs(outputs, {
    allowDifferentSourceRuntimeFrames: true,
  })) {
    const indexes = [pair.sourceInputIndex, pair.targetInputIndex];
    if (indexes.some(index => claimed.has(index))) continue;
    indexes.forEach(index => claimed.add(index));
    indexed.push({
      firstIndex: Math.min(...indexes),
      outputs: [outputs[pair.targetInputIndex]!, outputs[pair.sourceInputIndex]!],
      atomic: true,
      complete: true,
    });
  }

  for (const [index, output] of outputs.entries()) {
    if (claimed.has(index)) continue;
    const incompleteCrossJ = isCrossJAdmissionProposal(output);
    indexed.push({
      firstIndex: index,
      outputs: [output],
      atomic: incompleteCrossJ,
      complete: !incompleteCrossJ,
    });
  }
  return indexed
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map(({ firstIndex: _firstIndex, ...unit }) => unit);
};

const overwriteRoutedEntityOutput = <T extends RoutedEntityInput>(target: T, source: T): T => {
  for (const key of Reflect.ownKeys(target)) {
    if (!Reflect.deleteProperty(target, key)) {
      throw new Error(`ROUTE_OUTPUT_FIELD_DELETE_FAILED:${String(key)}`);
    }
  }
  Object.assign(target, source);
  return target;
};

const selectCanonicalOutput = <T extends RoutedEntityInput>(existing: T, incoming: T): T =>
  compareStableText(encodeCanonicalConsensusValue(existing), encodeCanonicalConsensusValue(incoming)) <= 0
    ? existing
    : incoming;

const mergeAccountProposalOutput = <T extends RoutedEntityInput>(existing: T, incoming: T): T | null => {
  const identity = accountProposalOutputIdentity(existing);
  if (!identity || identity !== accountProposalOutputIdentity(incoming)) return null;

  const evidenceDelta = accountProposalEvidenceRank(incoming) - accountProposalEvidenceRank(existing);
  if (evidenceDelta !== 0) {
    return evidenceDelta > 0 ? overwriteRoutedEntityOutput(existing, incoming) : existing;
  }
  const existingFrame = existing.sourceRuntimeFrame;
  const incomingFrame = incoming.sourceRuntimeFrame;
  const incomingIsNewer = Boolean(
    incomingFrame &&
    (!existingFrame ||
      incomingFrame.height > existingFrame.height ||
      (incomingFrame.height === existingFrame.height && incomingFrame.timestamp > existingFrame.timestamp)),
  );
  if (incomingIsNewer) return overwriteRoutedEntityOutput(existing, incoming);
  const canonical = selectCanonicalOutput(existing, incoming);
  return canonical === existing ? existing : overwriteRoutedEntityOutput(existing, incoming);
};

const normalizePrecommitBundles = (bundles: Map<string, string[]>): Map<string, string[]> => {
  const normalized = new Map<string, string[]>();
  for (const [rawSignerId, signatures] of bundles) {
    const signerId = normalizeRouteText(rawSignerId);
    if (normalized.has(signerId)) throw new Error(`ROUTE_PRECOMMIT_DUPLICATE_SIGNER:${rawSignerId}`);
    normalized.set(signerId, signatures);
  }
  return normalized;
};

const mergeOrdinaryOutput = <T extends RoutedEntityInput>(existing: T, incoming: T): T => {
  if (
    (incoming.leaderTimeoutVote || existing.leaderTimeoutVote) &&
    encodeCanonicalConsensusValue(incoming.leaderTimeoutVote) !==
      encodeCanonicalConsensusValue(existing.leaderTimeoutVote)
  ) {
    throw new Error(`ROUTE_LEADER_VOTE_EQUIVOCATION:${incoming.leaderTimeoutVote?.voterId ?? 'missing'}`);
  }
  if (incoming.entityTxs?.length) {
    existing.entityTxs = [...(existing.entityTxs || []), ...incoming.entityTxs];
  }
  if (incoming.hashPrecommits?.size) {
    if (
      existing.hashPrecommitFrame &&
      encodeCanonicalConsensusValue(existing.hashPrecommitFrame) !==
        encodeCanonicalConsensusValue(incoming.hashPrecommitFrame)
    ) {
      throw new Error('ROUTE_PRECOMMIT_FRAME_CONFLICT');
    }
    if (!incoming.hashPrecommitFrame) throw new Error('ROUTE_PRECOMMIT_FRAME_REFERENCE_MISSING');
    existing.hashPrecommitFrame = incoming.hashPrecommitFrame;
    const merged = normalizePrecommitBundles(existing.hashPrecommits ?? new Map());
    for (const [signerId, signatures] of normalizePrecommitBundles(incoming.hashPrecommits)) {
      const previous = merged.get(signerId);
      if (!previous) merged.set(signerId, [...signatures]);
      else if (previous.length !== signatures.length || previous.some((sig, i) => sig !== signatures[i])) {
        throw new Error(`ROUTE_PRECOMMIT_EQUIVOCATION:${signerId}`);
      }
    }
    existing.hashPrecommits = new Map([...merged].sort(([left], [right]) => compareStableText(left, right)));
  }
  if (incoming.proposedFrame) {
    const existingIsCommit = carriesEntityCommitNotification(existing);
    const incomingIsCommit = carriesEntityCommitNotification(incoming);
    if (!existing.proposedFrame || (incomingIsCommit && !existingIsCommit)) {
      existing.proposedFrame = incoming.proposedFrame;
    }
  }
  return existing;
};

export const mergeRoutedEntityOutput = <T extends RoutedEntityInput>(existing: T, incoming: T): T =>
  mergeAccountProposalOutput(existing, incoming) ?? mergeOrdinaryOutput(existing, incoming);

export type PlannedRemoteOutput = {
  output: DeliverableEntityInput;
  targetRuntimeId: string;
};

type RuntimeP2PDispatch = {
  enqueueEntityInputsDelivery(
    targetRuntimeId: string,
    envelope: RuntimeEntityInputsEnvelope,
    ingressTimestamp?: number,
  ): DeliveryResult;
  getVerifiedRuntimeRoute?(entityId: string): { runtimeId: string; lastUpdated: number } | null;
};

export type RuntimeEntityInputRoutingResult = {
  delivery: DeliveryResult;
};

export type RuntimeOutputRoutingDeps = {
  ensureRuntimeInfrastructure(env: RuntimeReplica): NonNullable<RuntimeReplica['infrastructure']>;
  getP2P(env: RuntimeReplica): RuntimeP2PDispatch | null;
  enqueueRuntimeInputs(
    env: RuntimeReplica,
    entityInputs: RoutedEntityInput[],
    runtimeTxs?: never,
    jInputs?: never,
    ingressTimestamp?: number,
  ): void;
  extractEntityId(replicaKey: string): string;
  hasLocalSignerForEntity(env: RuntimeReplica, entityId: string): boolean;
  hasLocalSignerForEntitySigner(env: RuntimeReplica, entityId: string, signerId: string): boolean;
  resolveSoleLocalSignerForEntity(env: RuntimeReplica, entityId: string): string | null;
  resolveRuntimeIdForEntity(env: RuntimeReplica, entityId: string): string | null;
  resolveRuntimeIdForCrossJurisdictionEntity(
    env: RuntimeReplica,
    entityId: string,
    signerId: string,
  ): string | null;
};

const getDeferredNetworkMeta = (
  env: RuntimeReplica,
  deps: RuntimeOutputRoutingDeps,
): NonNullable<NonNullable<RuntimeReplica['infrastructure']>['deferredNetworkMeta']> => {
  const state = deps.ensureRuntimeInfrastructure(env);
  if (!state.deferredNetworkMeta) {
    state.deferredNetworkMeta = new Map();
  }
  return state.deferredNetworkMeta;
};

export const reportRetryableRouteDefer = (
  env: RuntimeReplica,
  deps: RuntimeOutputRoutingDeps,
  output: RoutedEntityInput,
  details: Record<string, unknown>,
): void => {
  const attempts = (getDeferredNetworkMeta(env, deps).get(buildRouteOutputKey(output))?.attempts ?? 0) + 1;
  const payload = { ...details, attempts };
  // TEMP-TRACE-CP2b (pending-frame-stale investigation): unfiltered under
  // XLN_TRACE_ALL_DEFERRED=1 since deferrals are the rare/retry path, not
  // steady-state traffic; otherwise gated by XLN_TRACE_ENTITY_SUFFIXES.
  if (traceAllDeferredEnabled() || matchesTraceSuffix(output.entityId)) {
    traceLog('CP2b:delivery/pending.ts:reportRetryableRouteDefer', {
      entityId: output.entityId,
      signerId: output.signerId,
      attempts,
      details,
    });
  }
  routeLog.info('output.deferred', {
    ...payload,
    entityId: output.entityId,
    signerId: output.signerId,
    runtimeId: output.runtimeId ?? null,
    sourceRuntimeFrame: output.sourceRuntimeFrame ?? null,
    txTypes: (output.entityTxs ?? []).map(tx => tx.type),
  });
  // A deferred output remains durably queued and retryable. Repetition is
  // backpressure telemetry, not a degraded-state verdict; terminal delivery
  // failures are reported by their explicit terminal path.
  env.info?.('network', 'ROUTE_SEND_DEFERRED', payload);
};

const getRuntimeNowMs = (env: RuntimeReplica): number => env.state.timestamp ?? 0;

// Retry metadata must stay in one clock domain. Deterministic scenarios own
// logical time explicitly; production transport retries are wall-clock I/O.
// Mixing Unix time into a scenario retry makes the envelope unreachable forever.
const getNetworkRetryNowMs = (env: RuntimeReplica): number =>
  env.scenarioMode ? getRuntimeNowMs(env) : getWallClockMs();

export const toDeliverableEntityInput = (
  output: RoutedEntityInput,
  targetRuntimeId: string,
): DeliverableEntityInput => {
  const deliverable: DeliverableEntityInput = {
    ...output,
    runtimeId: targetRuntimeId,
  };
  return validateDeliverableEntityInput(deliverable);
};

export const isTriggerOnlyOutput = (output: RoutedEntityInput): boolean =>
  (output.entityTxs?.length ?? 0) === 0 &&
  !output.proposedFrame &&
  !output.leaderTimeoutVote &&
  (!output.jPrefixAttestations || output.jPrefixAttestations.size === 0) &&
  (!output.hashPrecommits || output.hashPrecommits.size === 0);

export const isTxBearingOutput = (output: RoutedEntityInput): boolean => (output.entityTxs?.length ?? 0) > 0;

export const buildRoutingDeliveryResult = (input: {
  remoteCount: number;
  localCount: number;
  pendingCount: number;
}): DeliveryResult => {
  if (input.pendingCount > 0) {
    return deliveryDeferred({
      outcome: 'deferred',
      code: 'ROUTE_DEFERRED_OUTPUTS',
    });
  }
  if (input.remoteCount > 0 && input.localCount > 0) {
    return deliveryAccepted('ROUTE_REMOTE_AND_LOCAL_ACCEPTED');
  }
  if (input.remoteCount > 0) {
    return deliveryAccepted('ROUTE_REMOTE_DELIVERED');
  }
  if (input.localCount > 0) {
    return deliveryQueued({
      code: 'ROUTE_LOCAL_QUEUED',
      retryable: false,
      terminal: true,
    });
  }
  return deliveryAccepted('ROUTE_NOOP');
};

export const enqueueP2PEntityInputsDelivery = (
  p2p: RuntimeP2PDispatch,
  targetRuntimeId: string,
  envelope: RuntimeEntityInputsEnvelope,
  ingressTimestamp: number | undefined,
): DeliveryResult => {
  return requireDeliveryResult(
    p2p.enqueueEntityInputsDelivery(targetRuntimeId, envelope, ingressTimestamp),
    'ROUTE_P2P_INVALID_DELIVERY_RESULT',
  );
};

export const resolveGossipBoardSignerIds = (env: RuntimeReplica, entityId: string): string[] => {
  const targetEntityId = String(entityId || '')
    .trim()
    .toLowerCase();
  if (!targetEntityId || !env.gossip?.getProfiles) return [];
  const profile = env.gossip.getProfiles().find(
    candidate =>
      String(candidate?.entityId || '')
        .trim()
        .toLowerCase() === targetEntityId,
  );
  if (!profile?.runtimeSignature) return [];
  // One recover per distinct (route hash, signature), not per planned output.
  try {
    const routeHash = computeProfileRouteHash(profile);
    const cached = gossipBoardSignerMemo.get(targetEntityId);
    if (cached && cached.routeHash === routeHash && cached.runtimeSignature === profile.runtimeSignature) {
      return cached.signerIds;
    }
    const signerId = recoverDigestSignerAddress(routeHash, profile.runtimeSignature);
    const signerIds = signerId ? [signerId] : [];
    gossipBoardSignerMemo.set(targetEntityId, { routeHash, runtimeSignature: profile.runtimeSignature, signerIds });
    return signerIds;
  } catch {
    return [];
  }
};
const gossipBoardSignerMemo = new Map<string, { routeHash: string; runtimeSignature: string; signerIds: string[] }>();

export const splitPendingOutputsByRetryWindow = (
  env: RuntimeReplica,
  pending: RoutedEntityInput[],
  deps: RuntimeOutputRoutingDeps,
  graph: PreparedOutputGraph = createPreparedOutputGraph(),
): { ready: RoutedEntityInput[]; waiting: RoutedEntityInput[] } => {
  if (pending.length === 0) return { ready: [], waiting: [] };
  const nowMs = getNetworkRetryNowMs(env);
  const meta = getDeferredNetworkMeta(env, deps);
  const ready: RoutedEntityInput[] = [];
  const waiting: RoutedEntityInput[] = [];
  const orderedPending = buildPendingNetworkOutputs(pending, graph);
  for (const unit of groupAtomicCrossJAdmissionOutputs(orderedPending)) {
    if (unit.atomic) {
      if (!unit.complete) {
        logIncompleteAtomicUnitParked(env, unit, orderedPending);
        assertIncompleteAtomicUnitRecoverable(env, unit, nowMs);
        waiting.push(...unit.outputs);
        continue;
      }
      const due = unit.outputs.some(output => {
        const entry = meta.get(graph.prepare(output).routeKey);
        return !entry || entry.nextRetryAt <= nowMs;
      });
      if (due) {
        ready.push(...unit.outputs);
      } else {
        logCompleteAtomicUnitWaiting(unit, unit.outputs.map(output => ({
          key: graph.prepare(output).routeKey.slice(0, 160),
          nextRetryInMs: (meta.get(graph.prepare(output).routeKey)?.nextRetryAt ?? 0) - nowMs,
          attempts: meta.get(graph.prepare(output).routeKey)?.attempts ?? 0,
        })));
        waiting.push(...unit.outputs);
      }
      continue;
    }
    const output = unit.outputs[0]!;
    const entry = meta.get(graph.prepare(output).routeKey);
    if (!entry || entry.nextRetryAt <= nowMs) ready.push(output);
    else waiting.push(output);
  }
  return { ready, waiting };
};

export const getNextNetworkRetryTimestamp = (env: RuntimeReplica, deps: RuntimeOutputRoutingDeps): number | null => {
  const pending = env.pendingNetworkOutputs ?? [];
  if (pending.length === 0) return null;
  const meta = getDeferredNetworkMeta(env, deps);
  let nextRetryAt = Infinity;
  const atomicUnits = groupAtomicCrossJAdmissionOutputs(buildPendingNetworkOutputs(pending));
  for (const unit of atomicUnits) {
    if (unit.atomic && !unit.complete) {
      nextRetryAt = Math.min(nextRetryAt, incompleteAtomicUnitRecoveryDeadline(unit));
    }
  }
  for (const unit of atomicUnits) {
    if (unit.atomic && !unit.complete) continue;
    for (const output of unit.outputs) {
      nextRetryAt = Math.min(nextRetryAt, meta.get(buildRouteOutputKey(output))?.nextRetryAt ?? 0);
    }
  }
  return Number.isFinite(nextRetryAt) ? nextRetryAt : null;
};

export const hasReadyPendingNetworkOutputs = (
  env: RuntimeReplica,
  deps: RuntimeOutputRoutingDeps,
  now = getNetworkRetryNowMs(env),
): boolean => {
  const nextRetryAt = getNextNetworkRetryTimestamp(env, deps);
  const comparableNow = env.scenarioMode ? getNetworkRetryNowMs(env) : now;
  return nextRetryAt !== null && nextRetryAt <= comparableNow;
};

const outputDeliveryPriority = (output: RoutedEntityInput): number => {
  if (output.proposedFrame) return 0;
  if (output.leaderTimeoutVote) return 0;
  if (output.hashPrecommits && output.hashPrecommits.size > 0) return 0;
  const txTypes = new Set((output.entityTxs ?? []).map(tx => tx.type));
  if ([...txTypes].some(type => type === 'j_event' || type.startsWith('dispute'))) return 0;
  if (txTypes.has('accountInput')) return 2;
  return 3;
};

const compareEntityFrameDelivery = (left: RoutedEntityInput, right: RoutedEntityInput): number => {
  const leftFrame = left.proposedFrame;
  const rightFrame = right.proposedFrame;
  if (!leftFrame) return rightFrame ? 1 : 0;
  if (!rightFrame) return -1;
  return (
    compareStableText(left.runtimeId ?? '', right.runtimeId ?? '') ||
    compareStableText(left.entityId, right.entityId) ||
    compareStableText(left.signerId, right.signerId) ||
    leftFrame.height - rightFrame.height ||
    compareStableText(leftFrame.hash, rightFrame.hash)
  );
};

const certifiedOutputDeliveryOrder = (
  output: RoutedEntityInput,
): {
  sourceEntityId: string;
  targetEntityId: string;
  lane: string;
  sequence: bigint;
} | null => {
  const tx = output.entityTxs?.find(candidate => candidate.type === 'consensusOutput');
  if (!tx || tx.type !== 'consensusOutput') return null;
  return {
    sourceEntityId: tx.data.origin.sourceEntityId.toLowerCase(),
    targetEntityId: tx.data.targetEntityId.toLowerCase(),
    lane: tx.data.origin.lane,
    sequence: tx.data.origin.sequence,
  };
};

const compareCertifiedOutputDelivery = (left: RoutedEntityInput, right: RoutedEntityInput): number => {
  const leftOrder = certifiedOutputDeliveryOrder(left);
  const rightOrder = certifiedOutputDeliveryOrder(right);
  if (!leftOrder || !rightOrder) return 0;
  return (
    compareStableText(left.runtimeId ?? '', right.runtimeId ?? '') ||
    compareStableText(leftOrder.sourceEntityId, rightOrder.sourceEntityId) ||
    compareStableText(leftOrder.targetEntityId, rightOrder.targetEntityId) ||
    compareStableText(leftOrder.lane, rightOrder.lane) ||
    (leftOrder.sequence < rightOrder.sequence ? -1 : leftOrder.sequence > rightOrder.sequence ? 1 : 0)
  );
};

export const compareOutputDelivery = (left: RoutedEntityInput, right: RoutedEntityInput): number =>
  compareCertifiedOutputDelivery(left, right) ||
  outputDeliveryPriority(left) - outputDeliveryPriority(right) ||
  compareEntityFrameDelivery(left, right) ||
  compareStableText(buildRouteOutputKey(left), buildRouteOutputKey(right));

export const buildPendingNetworkOutputs = (
  outputs: RoutedEntityInput[],
  graph: PreparedOutputGraph = createPreparedOutputGraph(),
): RoutedEntityInput[] => {
  const deduped = new Map<string, RoutedEntityInput>();
  const mutableMergeTargets = new Set<RoutedEntityInput>();
  for (const output of outputs.flatMap(candidate => graph.split(candidate))) {
    const key = graph.prepare(output).routeKey;
    const existing = deduped.get(key);
    if (existing) {
      const target = mutableMergeTargets.has(existing) ? existing : copyRoutedOutputForMerge(existing);
      if (target !== existing) {
        deduped.set(key, target);
        mutableMergeTargets.add(target);
      }
      mergeRoutedEntityOutput(target, output);
      graph.invalidate(target);
    } else {
      const target = copyRoutedOutputForMerge(output);
      graph.adopt(output, target);
      mutableMergeTargets.add(target);
      deduped.set(key, target);
    }
  }
  const pending = [...deduped.values()]
    .map(output => {
      if (!output.entityTxs || output.entityTxs.length < 2) return output;
      const ordered = orderCertifiedOutputsBySequence(output.entityTxs);
      return ordered.every((tx, index) => tx === output.entityTxs![index])
        ? output
        : { ...output, entityTxs: ordered };
    })
    .sort(compareOutputDelivery);
  if (pending.length > MAX_PENDING_NETWORK_OUTPUTS) {
    throw new Error(
      `NETWORK_OUTBOX_CAPACITY_EXCEEDED: pending=${pending.length} max=${MAX_PENDING_NETWORK_OUTPUTS}`,
    );
  }
  return pending;
};

/**
 * A proposal's terminal is the sender's own Account state: the frame either
 * committed or was rolled back, and neither can be advanced by resending it.
 * Per leg on purpose: one settled leg left behind makes its cohort ambiguous
 * forever, and a settled leg has no successor state to reach.
 */
/** A restarted Runtime retries every restored pending output at once. */
export const markRestoredOutputsDue = (env: RuntimeReplica): void => {
  for (const meta of env.infrastructure?.deferredNetworkMeta?.values() ?? []) meta.nextRetryAt = 0;
};

export const pruneSettledOutputs = (env: RuntimeReplica, outputs: RoutedEntityInput[]): RoutedEntityInput[] =>
  outputs.filter(output => {
    if (!accountProposalSettledBySender(env, output)) return true;
    env.infrastructure?.deferredNetworkMeta?.delete(buildRouteOutputKey(output));
    return false;
  });

export const rescheduleDeferredOutputs = (
  env: RuntimeReplica,
  attemptedPending: RoutedEntityInput[],
  failed: RoutedEntityInput[],
  waiting: RoutedEntityInput[],
  deps: RuntimeOutputRoutingDeps,
  graph: PreparedOutputGraph = createPreparedOutputGraph(),
): RoutedEntityInput[] => {
  const meta = getDeferredNetworkMeta(env, deps);
  const failedKeys = new Set(failed.map(output => graph.prepare(output).routeKey));

  for (const output of attemptedPending) {
    const key = graph.prepare(output).routeKey;
    if (!failedKeys.has(key)) {
      meta.delete(key);
    }
  }

  const nowMs = getNetworkRetryNowMs(env);
  for (const unit of groupAtomicCrossJAdmissionOutputs(buildPendingNetworkOutputs(failed, graph))) {
    if (!unit.complete) continue;
    // Cross-j Account cohorts retry as one envelope. A bounded retry preserves
    // liveness without splitting money legs or spinning every Runtime tick.
    for (const output of unit.outputs) {
      const key = graph.prepare(output).routeKey;
      const attempts = (meta.get(key)?.attempts ?? 0) + 1;
      const delayMs = Math.min(NETWORK_RETRY_MAX_MS, NETWORK_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 5));
      meta.set(key, { attempts, nextRetryAt: nowMs + delayMs });
    }
  }

  return buildPendingNetworkOutputs([...failed, ...waiting], graph);
};
