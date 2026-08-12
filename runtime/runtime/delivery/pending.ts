import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import type {
  DeliverableEntityInput,
  RuntimeReplica,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
  RuntimeEntityInputsEnvelope,
} from '../types';
import { createStructuredLogger } from '../../infra/logger';
import { keccak256, recoverAddress, toUtf8Bytes } from 'ethers';
import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id';
import { compareStableText, safeStringify } from '../../protocol/serialization';
import { getWallClockMs } from '../../infra/time';
import { validateDeliverableEntityInput } from '../routing/routing-validation';
import { recordRuntimeSecurityIncident } from '../observability/security-incidents';
import { computeProfileRouteHash } from '../../entity/profile/profile-signing';
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
import { reliableReceiptCoversIdentity, senderFrontierKey, senderFrontierKeyForIdentity } from '../reliable/reliable-frontier.ts';
import { explainCrossJPairing, selectPotentialCrossJAccountInputPairs } from '../routing/entity-routing';
import {
  accountProposalSettledBySender,
  accountProposalEvidenceRank,
  accountProposalOutputIdentity,
  assertReliableEvidenceCompatible,
  buildRouteOutputKey,
  carriesEntityCommitNotification,
  cloneRoutedOutputWithCachedIdentity,
  getEntityFrameIdentity,
  getReliableOutputIdentity,
  normalizeRouteText,
  splitRoutedOutputByDeliveryLane,
  type ReliableOutputIdentity,
} from './identity';

const routeLog = createStructuredLogger('network.route');

const shortPairKey = (pairKey: string): string =>
  `${keccak256(toUtf8Bytes(pairKey)).slice(0, 18)}:len=${pairKey.length}`;

const summarizeAtomicUnitOutput = (
  output: RoutedEntityInput,
): Record<string, unknown> => {
  const marker = output.atomicCrossJurisdictionPair;
  const reliable = getReliableOutputIdentity(output);
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
    reliable: reliable
      ? { kind: reliable.kind, laneKey: reliable.laneKey, height: reliable.height }
      : null,
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
    // ACK cohorts are born complete in one Runtime frame's outbox and retire
    // only as a whole (pruneReceiptedReliableOutputs). A lone ack-marked leg
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
const NETWORK_RETRY_MAX_MS = 30_000;
// Consensus lanes are bounded and HOL-ordered, so retrying only the lane head
// every few seconds is cheap. Letting that head inherit the 30s best-effort
// backoff can cross the bilateral liveness alarm during a normal peer restart.
const RELIABLE_NETWORK_RETRY_MAX_MS = 4_000;
const RESTORED_RELIABLE_OUTPUTS_DUE = Symbol('restored-reliable-outputs-due');

type RestoredReliableDueEnv = RuntimeReplica & { [RESTORED_RELIABLE_OUTPUTS_DUE]?: true };

const hasRestoredReliableOutputsDue = (env: RuntimeReplica): boolean =>
  (env as RestoredReliableDueEnv)[RESTORED_RELIABLE_OUTPUTS_DUE] === true;

const clearRestoredReliableOutputsDue = (env: RuntimeReplica): void => {
  delete (env as RestoredReliableDueEnv)[RESTORED_RELIABLE_OUTPUTS_DUE];
};

const isAccountAckIdentity = (identity: ReliableOutputIdentity): boolean => identity.kind === 'account-ack';

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
      throw new Error(`ROUTE_RELIABLE_OUTPUT_FIELD_DELETE_FAILED:${String(key)}`);
    }
  }
  Object.assign(target, source);
  return target;
};

const selectCanonicalReliableOutput = <T extends RoutedEntityInput>(existing: T, incoming: T): T =>
  compareStableText(encodeCanonicalConsensusValue(existing), encodeCanonicalConsensusValue(incoming)) <= 0
    ? existing
    : incoming;

const assertReliableMergeIdentity = (existing: ReliableOutputIdentity, incoming: ReliableOutputIdentity): void => {
  assertReliableEvidenceCompatible(existing, incoming);
  if (
    existing.laneKey === incoming.laneKey &&
    existing.order === incoming.order &&
    existing.variantOrder === incoming.variantOrder &&
    existing.logicalKey !== incoming.logicalKey
  ) {
    throw new Error(`ROUTE_RELIABLE_LANE_ORDER_CONFLICT:${existing.kind}:${existing.order}`);
  }
  if (existing.kind !== incoming.kind || existing.logicalKey !== incoming.logicalKey) {
    throw new Error('ROUTE_RELIABLE_IDENTITY_MISMATCH');
  }
};

const requireRetainedRuntimeId = (
  existing: RoutedEntityInput,
  incoming: RoutedEntityInput,
  identity: ReliableOutputIdentity,
): string => {
  const existingRuntimeId = normalizeRuntimeId(existing.runtimeId);
  const incomingRuntimeId = normalizeRuntimeId(incoming.runtimeId);
  if (existingRuntimeId && incomingRuntimeId && existingRuntimeId !== incomingRuntimeId) {
    throw new Error(`ROUTE_RELIABLE_RUNTIME_BINDING_CONFLICT:${identity.kind}:${identity.order}`);
  }
  return existingRuntimeId || incomingRuntimeId;
};

const normalizePrecommitBundles = (bundles: Map<string, string[]>, source: string): Map<string, string[]> => {
  const normalized = new Map<string, string[]>();
  for (const [rawSignerId, signatures] of bundles) {
    const signerId = normalizeRouteText(rawSignerId);
    if (normalized.has(signerId)) {
      throw new Error(`ROUTE_PRECOMMIT_DUPLICATE_SIGNER:${source}:${rawSignerId}`);
    }
    normalized.set(signerId, [...signatures]);
  }
  return normalized;
};

const mergePrecommitBundles = (existing: RoutedEntityInput, incoming: RoutedEntityInput): void => {
  const merged = normalizePrecommitBundles(existing.hashPrecommits!, 'existing');
  for (const [signerId, signatures] of normalizePrecommitBundles(incoming.hashPrecommits!, 'incoming')) {
    const previous = merged.get(signerId);
    if (previous) {
      const exactDuplicate =
        previous.length === signatures.length && previous.every((signature, index) => signature === signatures[index]);
      if (!exactDuplicate) throw new Error(`ROUTE_PRECOMMIT_EQUIVOCATION:${signerId}`);
    } else {
      merged.set(signerId, [...signatures]);
    }
  }
  existing.hashPrecommits = new Map([...merged.entries()].sort(([left], [right]) => compareStableText(left, right)));
};

const mergeReliableOutput = <T extends RoutedEntityInput>(
  existing: T,
  incoming: T,
  existingIdentity: ReliableOutputIdentity,
  incomingIdentity: ReliableOutputIdentity,
): T => {
  assertReliableMergeIdentity(existingIdentity, incomingIdentity);
  const retainedRuntimeId = requireRetainedRuntimeId(existing, incoming, existingIdentity);
  const retainRuntimeBinding = (output: T): T => {
    if (retainedRuntimeId) output.runtimeId = retainedRuntimeId;
    return output;
  };

  if (existingIdentity.kind === 'hash-precommit') {
    mergePrecommitBundles(existing, incoming);
    return retainRuntimeBinding(existing);
  }
  if (existingIdentity.kind === 'entity-frame') {
    const existingIsCommit = carriesEntityCommitNotification(existing);
    const incomingIsCommit = carriesEntityCommitNotification(incoming);
    if (existingIsCommit !== incomingIsCommit) {
      return retainRuntimeBinding(incomingIsCommit ? overwriteRoutedEntityOutput(existing, incoming) : existing);
    }
  }
  const canonical = selectCanonicalReliableOutput(existing, incoming);
  return retainRuntimeBinding(canonical === existing ? existing : overwriteRoutedEntityOutput(existing, incoming));
};

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
  const canonical = selectCanonicalReliableOutput(existing, incoming);
  return canonical === existing ? existing : overwriteRoutedEntityOutput(existing, incoming);
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
  if (incoming.proposedFrame) {
    const existingIsCommit = carriesEntityCommitNotification(existing);
    const incomingIsCommit = carriesEntityCommitNotification(incoming);
    if (!existing.proposedFrame || (incomingIsCommit && !existingIsCommit)) {
      existing.proposedFrame = incoming.proposedFrame;
    }
  }
  return existing;
};

export const mergeRoutedEntityOutput = <T extends RoutedEntityInput>(existing: T, incoming: T): T => {
  const existingReliable = getReliableOutputIdentity(existing);
  const incomingReliable = getReliableOutputIdentity(incoming);
  if (existingReliable || incomingReliable) {
    if (!existingReliable || !incomingReliable) {
      throw new Error('ROUTE_RELIABLE_MERGE_KIND_MISMATCH');
    }
    return mergeReliableOutput(existing, incoming, existingReliable, incomingReliable);
  }
  return mergeAccountProposalOutput(existing, incoming) ?? mergeOrdinaryOutput(existing, incoming);
};

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
  routeLog.info('output.deferred', {
    ...payload,
    entityId: output.entityId,
    signerId: output.signerId,
    runtimeId: output.runtimeId ?? null,
    sourceRuntimeFrame: output.sourceRuntimeFrame ?? null,
    reliableIdentity: getReliableOutputIdentity(output),
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
  try {
    return [recoverAddress(computeProfileRouteHash(profile), profile.runtimeSignature).toLowerCase()];
  } catch {
    return [];
  }
};

export const splitPendingOutputsByRetryWindow = (
  env: RuntimeReplica,
  pending: RoutedEntityInput[],
  deps: RuntimeOutputRoutingDeps,
): { ready: RoutedEntityInput[]; waiting: RoutedEntityInput[] } => {
  if (pending.length === 0) return { ready: [], waiting: [] };
  const nowMs = getNetworkRetryNowMs(env);
  const meta = getDeferredNetworkMeta(env, deps);
  const ready: RoutedEntityInput[] = [];
  const waiting: RoutedEntityInput[] = [];
  const restoredReliableDue = hasRestoredReliableOutputsDue(env);
  // HOL is scoped to an exact comparable protocol lane. Entity-frame,
  // account-ACK and J-finality heights are not mutually comparable; a
  // universal per-Entity queue can deadlock the protocols against each other.
  const blockedReliableLanes = new Set<string>();
  const orderedPending = buildPendingNetworkOutputs(pending);
  const readyAccountAckLanes = new Set(
    orderedPending.flatMap(output => {
      const identity = getReliableOutputIdentity(output);
      if (!identity || !isAccountAckIdentity(identity)) return [];
      const retry = meta.get(buildRouteOutputKey(output));
      return !retry || retry.nextRetryAt <= nowMs ? [identity.laneKey] : [];
    }),
  );

  for (const unit of groupAtomicCrossJAdmissionOutputs(orderedPending)) {
    if (unit.atomic) {
      if (!unit.complete) {
        logIncompleteAtomicUnitParked(env, unit, orderedPending);
        assertIncompleteAtomicUnitRecoverable(env, unit, nowMs);
        waiting.push(...unit.outputs);
        continue;
      }
      const reliableOutputs = unit.outputs.filter(output => getReliableOutputIdentity(output) !== null);
      const reliable = reliableOutputs
        .map(output => getReliableOutputIdentity(output)!)
        .filter((identity): identity is ReliableOutputIdentity => identity !== null);
      const retryFenceOutputs = reliableOutputs.length > 0 ? reliableOutputs : unit.outputs;
      const due =
        (restoredReliableDue && reliable.length > 0) ||
        retryFenceOutputs.some(output => {
          const entry = meta.get(buildRouteOutputKey(output));
          return !entry || entry.nextRetryAt <= nowMs;
        });
      if (due) {
        ready.push(...unit.outputs);
      } else {
        logCompleteAtomicUnitWaiting(unit, retryFenceOutputs.map(output => ({
          key: buildRouteOutputKey(output).slice(0, 160),
          nextRetryInMs: (meta.get(buildRouteOutputKey(output))?.nextRetryAt ?? 0) - nowMs,
          attempts: meta.get(buildRouteOutputKey(output))?.attempts ?? 0,
        })));
        waiting.push(...unit.outputs);
        reliable.forEach(identity => blockedReliableLanes.add(identity.laneKey));
      }
      continue;
    }
    const output = unit.outputs[0]!;
    const reliable = getReliableOutputIdentity(output);
    if (reliable && reliable.kind !== 'account-ack' && blockedReliableLanes.has(reliable.laneKey)) {
      waiting.push(output);
      continue;
    }
    const key = buildRouteOutputKey(output);
    const entry = meta.get(key);
    if ((restoredReliableDue && reliable) || !entry || entry.nextRetryAt <= nowMs) {
      ready.push(output);
      continue;
    }
    if (reliable && isAccountAckIdentity(reliable) && readyAccountAckLanes.has(reliable.laneKey)) {
      // A newly produced ACK proves the peer already signed the Account chain
      // through its predecessor. Wake and emit every older ACK first, then the
      // new ACK in the same pass; a separate delivery receipt must not add a
      // Runtime-frame boundary to bilateral consensus.
      ready.push(output);
      continue;
    }
    waiting.push(output);
    if (reliable && reliable.kind !== 'account-ack') blockedReliableLanes.add(reliable.laneKey);
  }
  return { ready, waiting };
};

export const getNextNetworkRetryTimestamp = (env: RuntimeReplica, deps: RuntimeOutputRoutingDeps): number | null => {
  const pending = env.pendingNetworkOutputs ?? [];
  if (pending.length === 0) return null;
  const meta = getDeferredNetworkMeta(env, deps);
  if (
    hasRestoredReliableOutputsDue(env) &&
    pending.some(output => getReliableOutputIdentity(output) !== null)
  )
    return 0;
  let nextRetryAt = Infinity;
  const blockedUntilByReliableLane = new Map<string, number>();
  const atomicUnits = groupAtomicCrossJAdmissionOutputs(buildPendingNetworkOutputs(pending));
  for (const unit of atomicUnits) {
    if (unit.atomic && !unit.complete) {
      nextRetryAt = Math.min(nextRetryAt, incompleteAtomicUnitRecoveryDeadline(unit));
    }
  }
  const retryScheduledOutputs = atomicUnits.flatMap(unit => {
    if (!unit.atomic) return unit.outputs;
    if (!unit.complete) return [];
    const reliableOutputs = unit.outputs.filter(output => getReliableOutputIdentity(output) !== null);
    // The ordinary source proposal is inseparable from its reliable target
    // ACK. It deliberately has no independent retry metadata: using its
    // implicit deadline=0 here made hasRuntimeWork() spin while the atomic
    // splitter correctly kept the whole envelope in its waiting set.
    return reliableOutputs.length > 0 ? reliableOutputs : unit.outputs;
  });
  for (const output of retryScheduledOutputs) {
    const retry = meta.get(buildRouteOutputKey(output));
    const ownRetryAt = retry?.nextRetryAt ?? 0;
    const reliable = getReliableOutputIdentity(output);
    if (!reliable) {
      nextRetryAt = Math.min(nextRetryAt, ownRetryAt);
      continue;
    }
    const effectiveRetryAt =
      reliable.kind === 'account-ack'
        ? ownRetryAt
        : Math.max(ownRetryAt, blockedUntilByReliableLane.get(reliable.laneKey) ?? 0);
    if (reliable.kind !== 'account-ack') {
      blockedUntilByReliableLane.set(reliable.laneKey, effectiveRetryAt);
    }
    nextRetryAt = Math.min(nextRetryAt, effectiveRetryAt);
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
  const leftIdentity = getEntityFrameIdentity(left);
  const rightIdentity = getEntityFrameIdentity(right);
  if (!leftIdentity) return rightIdentity ? 1 : 0;
  if (!rightIdentity) return -1;
  return (
    compareStableText(left.runtimeId ?? '', right.runtimeId ?? '') ||
    compareStableText(leftIdentity.entityId, rightIdentity.entityId) ||
    compareStableText(left.signerId, right.signerId) ||
    leftIdentity.height - rightIdentity.height ||
    compareStableText(leftIdentity.frameHash, rightIdentity.frameHash)
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

export const compareOutputDelivery = (left: RoutedEntityInput, right: RoutedEntityInput): number => {
  const leftReliable = getReliableOutputIdentity(left);
  const rightReliable = getReliableOutputIdentity(right);
  if (leftReliable && rightReliable) {
    return (
      compareStableText(leftReliable.laneKey, rightReliable.laneKey) ||
      leftReliable.order - rightReliable.order ||
      leftReliable.variantOrder - rightReliable.variantOrder ||
      compareStableText(leftReliable.evidenceKind, rightReliable.evidenceKind) ||
      compareStableText(leftReliable.evidenceDigest, rightReliable.evidenceDigest) ||
      compareStableText(leftReliable.logicalKey, rightReliable.logicalKey)
    );
  }
  if (leftReliable) return -1;
  if (rightReliable) return 1;
  return (
    compareCertifiedOutputDelivery(left, right) ||
    outputDeliveryPriority(left) - outputDeliveryPriority(right) ||
    compareEntityFrameDelivery(left, right) ||
    compareStableText(buildRouteOutputKey(left), buildRouteOutputKey(right))
  );
};

export const buildPendingNetworkOutputs = (outputs: RoutedEntityInput[]): RoutedEntityInput[] => {
  const deduped = new Map<string, RoutedEntityInput>();
  const identitiesByLaneOrder = new Map<string, ReliableOutputIdentity[]>();
  const splitOutputs = outputs.flatMap(output => splitRoutedOutputByDeliveryLane(output));
  for (const output of splitOutputs) {
    const reliable = getReliableOutputIdentity(output);
    if (reliable) {
      const laneOrderKey = safeStringify({
        laneKey: reliable.laneKey,
        order: reliable.order,
        variantOrder: reliable.variantOrder,
      });
      const existingIdentities = identitiesByLaneOrder.get(laneOrderKey) ?? [];
      for (const existingIdentity of existingIdentities) {
        assertReliableEvidenceCompatible(existingIdentity, reliable);
      }
      existingIdentities.push(reliable);
      identitiesByLaneOrder.set(laneOrderKey, existingIdentities);
    }
    const key = buildRouteOutputKey(output);
    const existing = deduped.get(key);
    if (existing) mergeRoutedEntityOutput(existing, output);
    else deduped.set(key, cloneRoutedOutputWithCachedIdentity(output));
  }
  const pending = [...deduped.values()]
    .map(output =>
      output.entityTxs ? { ...output, entityTxs: orderCertifiedOutputsBySequence(output.entityTxs) } : output,
    )
    .sort(compareOutputDelivery);
  const certifiedEntityFrames = new Set<string>();
  for (const output of pending) {
    const identity = getReliableOutputIdentity(output);
    if (identity?.kind !== 'entity-frame' || identity.evidenceKind !== 'entity-certificate') continue;
    certifiedEntityFrames.add(
      safeStringify({
        runtimeId: normalizeRuntimeId(output.runtimeId),
        laneKey: identity.laneKey,
        logicalKey: identity.logicalKey,
      }),
    );
  }
  const superseded = pending.filter(output => {
    const identity = getReliableOutputIdentity(output);
    if (identity?.kind !== 'entity-frame' || identity.evidenceKind !== 'entity-proposal') return true;
    return !certifiedEntityFrames.has(
      safeStringify({
        runtimeId: normalizeRuntimeId(output.runtimeId),
        laneKey: identity.laneKey,
        logicalKey: identity.logicalKey,
      }),
    );
  });
  if (superseded.length > MAX_PENDING_NETWORK_OUTPUTS) {
    throw new Error(
      `NETWORK_OUTBOX_CAPACITY_EXCEEDED: pending=${superseded.length} max=${MAX_PENDING_NETWORK_OUTPUTS}`,
    );
  }
  return superseded;
};

/**
 * A persisted reliable outbox is authoritative, but its wall-clock deadline is
 * not. Restarting begins a new transport session, so every committed lane head
 * is immediately eligible for one real send attempt. Preserve the attempt
 * counter for diagnostics; only reset the operational deadline. A subsequent
 * failed attempt records a fresh bounded backoff in the new process.
 */
export const markRestoredReliableOutputsDue = (env: RuntimeReplica): void => {
  if (!(env.pendingNetworkOutputs ?? []).some(output => getReliableOutputIdentity(output) !== null)) return;
  Object.defineProperty(env, RESTORED_RELIABLE_OUTPUTS_DUE, {
    configurable: true,
    // Runtime frames execute on a shallow-cloned RuntimeReplica. Keep this Symbol
    // enumerable so object spread carries the volatile wake marker into that
    // transaction; string-keyed storage/canonical codecs still exclude it.
    enumerable: true,
    value: true,
  });
};

/**
 * A committed receiver receipt is authoritative for the exact reliable output.
 * Entity replay may deterministically re-emit that output later; retaining it
 * would let an already-finished lane head block the next sparse Account ACK.
 * Coverage remains exact: a lower height, richer evidence, or conflicting hash
 * is never collected by a higher/different receipt.
 */
export const pruneReceiptedReliableOutputs = (
  env: RuntimeReplica,
  outputs: RoutedEntityInput[],
  appliedReceipts: readonly ReliableDeliveryReceipt[] = [],
): RoutedEntityInput[] => {
  // Proposal cohorts intentionally have no transport receipt. Their terminal is
  // the sender's own Account state: the frame either committed or was rolled
  // back, and neither can be advanced by resending it.
  //
  // This is deliberately per-leg and not gated on a complete cohort. Gating on
  // `unit.complete` made the cleanup self-disabling: one settled leg left behind
  // is enough to make its cohort ambiguous, ambiguous cohorts never pair, and an
  // unpaired unit is never complete - so the entry that caused the ambiguity
  // could never be collected. Dropping a settled leg is safe on its own because
  // a settled leg has no successor state to reach.
  const uncommittedOutputs = groupAtomicCrossJAdmissionOutputs(outputs).flatMap(unit =>
    unit.outputs.filter(output => {
      const settled =
        getReliableOutputIdentity(output) === null && accountProposalSettledBySender(env, output);
      if (!settled) return true;
      env.infrastructure?.deferredNetworkMeta?.delete(buildRouteOutputKey(output));
      return false;
    }));
  const active = env.infrastructure?.receivedReliableReceiptLedger;
  const terminal = env.infrastructure?.receivedReliableTerminalWatermarks;
  if ((!active || active.size === 0) && (!terminal || terminal.size === 0)) {
    return uncommittedOutputs;
  }
  const receiptsByFrontier = new Map<string, ReliableDeliveryReceipt[]>();
  for (const receipt of appliedReceipts) {
    const key = senderFrontierKey(receipt);
    const lane = receiptsByFrontier.get(key) ?? [];
    lane.push(receipt);
    receiptsByFrontier.set(key, lane);
  }
  const isReceipted = (output: RoutedEntityInput): boolean => {
    const identity = getReliableOutputIdentity(output);
    const receiverRuntimeId = normalizeRuntimeId(output.runtimeId);
    if (!identity || !receiverRuntimeId) return false;
    const frontierKey = senderFrontierKeyForIdentity(receiverRuntimeId, identity);
    return [active?.get(frontierKey), terminal?.get(frontierKey), ...(receiptsByFrontier.get(frontierKey) ?? [])].some(
      receipt => receipt && reliableReceiptCoversIdentity(receipt, identity),
    );
  };
  const retained: RoutedEntityInput[] = [];
  for (const unit of groupAtomicCrossJAdmissionOutputs(uncommittedOutputs)) {
    if (!unit.complete) {
      retained.push(...unit.outputs);
      continue;
    }
    const reliableOutputs = unit.outputs.filter(output => getReliableOutputIdentity(output) !== null);
    if (unit.atomic) {
      if (reliableOutputs.length > 0 && reliableOutputs.every(isReceipted)) {
        for (const output of unit.outputs) {
          env.infrastructure?.deferredNetworkMeta?.delete(buildRouteOutputKey(output));
        }
        continue;
      }
      // Sibling entities communicate strictly pairwise: an atomic cohort must
      // retire as a whole or retry as a whole. Retiring a receipted leg alone
      // (per-leg, like the loop below) strands its sibling as a permanently
      // incomplete unit that transport refuses to send and retry refuses to
      // schedule. Partial receipts therefore retain the COMPLETE unit; the
      // whole envelope retries, the receiver re-issues receipts for already
      // applied ACK legs (reliable-ingress terminal/exact re-receipt paths),
      // and the unit retires on the next pass with full coverage.
      if (reliableOutputs.some(isReceipted)) {
        routeLog.info('crossj.atomic_receipt_partial_hold', {
          outputs: unit.outputs.map(output => ({
            ...summarizeAtomicUnitOutput(output),
            receipted: isReceipted(output),
          })),
        });
      }
      retained.push(...unit.outputs);
      continue;
    }
    for (const output of unit.outputs) {
      if (!isReceipted(output)) {
        retained.push(output);
        continue;
      }
      env.infrastructure?.deferredNetworkMeta?.delete(buildRouteOutputKey(output));
    }
  }
  return retained;
};

export const rescheduleDeferredOutputs = (
  env: RuntimeReplica,
  attemptedPending: RoutedEntityInput[],
  failed: RoutedEntityInput[],
  waiting: RoutedEntityInput[],
  deps: RuntimeOutputRoutingDeps,
): RoutedEntityInput[] => {
  const meta = getDeferredNetworkMeta(env, deps);
  const failedKeys = new Set(failed.map(output => buildRouteOutputKey(output)));

  for (const output of attemptedPending) {
    const key = buildRouteOutputKey(output);
    if (!failedKeys.has(key)) {
      meta.delete(key);
    }
  }

  const nowMs = getNetworkRetryNowMs(env);
  const retriedReliableLanes = new Set<string>();
  for (const unit of groupAtomicCrossJAdmissionOutputs(buildPendingNetworkOutputs(failed))) {
    if (!unit.complete) continue;
    // Cross-j Account cohorts retry as one envelope. Both proposal legs are
    // idempotent certified frames; ACK legs additionally carry reliable
    // identities. A bounded retry preserves liveness without splitting money
    // legs or spinning every Runtime tick after a peer outage.
    const retryOutputs = unit.outputs;
    for (const output of retryOutputs) {
      const reliable = getReliableOutputIdentity(output);
      if (!unit.atomic && reliable && reliable.kind !== 'account-ack' && retriedReliableLanes.has(reliable.laneKey)) {
        meta.delete(buildRouteOutputKey(output));
        continue;
      }
      const key = buildRouteOutputKey(output);
      const attempts = (meta.get(key)?.attempts ?? 0) + 1;
      const retryMaxMs = unit.atomic || reliable ? RELIABLE_NETWORK_RETRY_MAX_MS : NETWORK_RETRY_MAX_MS;
      const delayMs = Math.min(retryMaxMs, NETWORK_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 5));
      meta.set(key, {
        attempts,
        nextRetryAt: nowMs + delayMs,
      });
      if (reliable) retriedReliableLanes.add(reliable.laneKey);
    }
  }

  if (attemptedPending.some(output => getReliableOutputIdentity(output) !== null)) {
    clearRestoredReliableOutputsDue(env);
  }

  return buildPendingNetworkOutputs([...failed, ...waiting]);
};
