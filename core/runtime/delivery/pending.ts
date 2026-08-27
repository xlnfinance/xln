import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import type {
  DeliverableEntityInput,
  RuntimeReplica,
  RoutedEntityInput,
  RuntimeEntityInputsEnvelope,
} from '../types';
import { compareStableText, safeStringify } from '../../protocol/serialization';
import { validateDeliverableEntityInput } from '../delivery/topology/routing-validation';
import { computeProfileRouteHash } from '../../entity/profile/profile-signing';
import { recoverDigestSignerAddress } from '../../account/crypto';
import { LIMITS } from '../../config/constants';

import { getEffectiveEntityInputTxs } from '../../entity/consensus/output/envelope';
import { accountInputAck, accountInputProposal } from '../../account/consensus/flush';
import {
  deliveryAccepted,
  deliveryQueued,
  requireDeliveryResult,
  type DeliveryResult,
} from '../../protocol/payments/delivery-result';
import { selectPotentialCrossJAccountInputPairs } from '../delivery/topology/entity-routing';
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

export const MAX_PENDING_NETWORK_OUTPUTS = LIMITS.MAX_PENDING_NETWORK_OUTPUTS;

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
  bootstrapDirectEntityRoutes?(entityIds: readonly string[], timeoutMs: number): Promise<boolean>;
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
  if (input.pendingCount > 0) throw new Error(`ROUTE_DEFERRED_OUTPUTS_FORBIDDEN:${input.pendingCount}`);
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
  if (!targetEntityId || !env.gossip?.getProfile) return [];
  const profile = env.gossip.getProfile(targetEntityId);
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
  } catch (error) {
    const dump = safeStringify({ entityId: targetEntityId, profile });
    env.error?.('network', 'ROUTE_PROFILE_SIGNATURE_INVALID', {
      entityId: targetEntityId,
      error: error instanceof Error ? error.message : String(error),
      dump,
    }, targetEntityId);
    throw new Error(
      `ROUTE_PROFILE_SIGNATURE_INVALID:${targetEntityId}:` +
        `${error instanceof Error ? error.message : String(error)}:dump=${dump}`,
    );
  }
};
const gossipBoardSignerMemo = new Map<string, { routeHash: string; runtimeSignature: string; signerIds: string[] }>();

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

const compareOutputDeliveryWithKeys = (
  left: RoutedEntityInput,
  right: RoutedEntityInput,
  leftRouteKey: string,
  rightRouteKey: string,
): number =>
  outputDeliveryPriority(left) - outputDeliveryPriority(right) ||
  compareEntityFrameDelivery(left, right) ||
  compareStableText(leftRouteKey, rightRouteKey);

export const compareOutputDelivery = (left: RoutedEntityInput, right: RoutedEntityInput): number =>
  compareOutputDeliveryWithKeys(
    left,
    right,
    buildRouteOutputKey(left),
    buildRouteOutputKey(right),
  );

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
    .sort((left, right) => compareOutputDeliveryWithKeys(
      left,
      right,
      graph.prepare(left).routeKey,
      graph.prepare(right).routeKey,
    ));
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
export const pruneSettledOutputs = (env: RuntimeReplica, outputs: RoutedEntityInput[]): RoutedEntityInput[] =>
  outputs.filter(output => !accountProposalSettledBySender(env, output));
