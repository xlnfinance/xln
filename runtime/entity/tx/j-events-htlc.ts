import { ethers } from 'ethers';
import type {
  CrossJurisdictionPullLeg,
  CrossJurisdictionSwapRoute,
} from '../../types/cross-jurisdiction';
import type {
  AccountReplica,
  CrossJurisdictionDisputeRecovery,
} from '../../types/account';
import type { EntityInput, EntityState } from '../types';
import { addMessage } from '../frame-events';
import { decodeHashLadderBinary, verifyHashLadderBinary } from '../../protocol/htlc/hash-ladder';
import {
  buildCrossJurisdictionPullReveal,
  CROSS_J_MAX_FILL_RATIO,
  deriveCrossJurisdictionPrivateSeed,
  getCrossJurisdictionCommittedProofRatio,
  isCrossJurisdictionTerminalStatus,
  transitionCrossJurisdictionRouteStatus,
} from '../../extensions/cross-j/index';
import { createStructuredLogger, shortHash } from '../../infra/logger';
import { buildCrossJurisdictionEntityOutput, pushCrossJurisdictionEntityOutput } from './cross-j-outputs';
import {
  batchAddHashLadderRegistration,
  hasHashLadderRegistrationRoom,
  initJBatch,
  isBatchEmpty,
} from '../../jurisdiction/machine/batch';
import type { JEventAccountTx } from './j-events-types';
import { compareStableText } from '../../protocol/serialization';
import type { ProofBodyStruct } from '../../../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { findExactSignedProofBodyPull } from '../../account/pull-registry-settlement';

const jEventHtlcLog = createStructuredLogger('j.event.htlc');

type DisputeTransformerArgs = {
  secrets?: Array<string>;
};

const decodeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return undefined;
  return [...value];
};

function decodeDeltaTransformerArgs(starterInitialArgumentsRaw: unknown): DisputeTransformerArgs | undefined {
  const starterInitialArguments = String(starterInitialArgumentsRaw || '0x');
  if (starterInitialArguments === '0x') return undefined;
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  let argArray: string[];
  try {
    const value = abiCoder.decode(['bytes[]'], starterInitialArguments)[0];
    const decoded = decodeStringArray(value);
    if (!decoded) return undefined;
    argArray = decoded;
  } catch {
    return undefined;
  }
  // The built-in DeltaTransformer is the first proof-body transformer. Keep
  // this position: compacting away an empty first slot would reinterpret a
  // subcontract's arguments as payment evidence.
  const deltaArgs = argArray[0];
  if (!deltaArgs || deltaArgs === '0x') return undefined;
  try {
    const decoded = abiCoder.decode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets)'],
      deltaArgs,
    )[0];
    if (typeof decoded !== 'object' || decoded === null) return undefined;
    const secrets = decodeStringArray(Reflect.get(decoded, 'secrets'));
    return {
      ...(secrets === undefined ? {} : { secrets }),
    };
  } catch {
    // Optional dispute evidence is adversarial. Solidity treats malformed
    // arguments as empty, so the observer must reach the same result.
    return undefined;
  }
}

export function decodeDisputeStarterInitialSecrets(starterInitialArgumentsRaw: unknown): string[] {
  const secrets = new Set<string>();
  const decoded = decodeDeltaTransformerArgs(starterInitialArgumentsRaw);
  for (const secret of decoded?.secrets || []) {
    if (ethers.isHexString(secret, 32)) {
      secrets.add(String(secret).toLowerCase());
    }
  }
  return Array.from(secrets);
}


export const ladderHashForPull = (pull: { fullHash: string; partialRoot: string }): string =>
  ethers.keccak256(
    ethers.solidityPacked(['bytes32', 'bytes32'], [pull.fullHash, pull.partialRoot]),
  ).toLowerCase();

const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;

const pullMatchesLadder = (
  pull: { fullHash: string; partialRoot: string } | undefined,
  ladderHash: string,
): boolean => Boolean(pull && ladderHashForPull(pull) === ladderHash);

const counterpartyForRouteLeg = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  targetRole: boolean,
): string => {
  const self = String(state.entityId).toLowerCase();
  const leg = targetRole ? route.target : route.source;
  const entity = String(leg.entityId).toLowerCase();
  const counterparty = String(leg.counterpartyEntityId).toLowerCase();
  if (self === entity) return counterparty;
  if (self === counterparty) return entity;
  throw new Error(`J_HASH_LADDER_ACCOUNT_PARTY_MISMATCH:${route.orderId}:${self}`);
};

/** Queue one signed-role registry write: source is sticky, target replaceable. */
export type HashLadderRevealQueueResult =
  | 'queued'
  | 'already-queued'
  | 'deferred-batch-pending'
  | 'source-window-expired';

export const isSourceRevealWindowExpired = (
  runtimeTimestampMs: number,
  deadlineSec: number,
): boolean => Math.floor(runtimeTimestampMs / 1_000) > deadlineSec;

/**
 * Mirror Depository's first-Source admission clock before mutating a J draft.
 * A local unobserved dispute is allowed because its start and reveal are mined
 * by one processBatch; an observed dispute uses inclusive unix-second bounds.
 */
const sourceRevealWindowStatus = (
  state: EntityState,
  counterpartyEntity: string,
): 'open' | 'expired' => {
  const counterparty = counterpartyEntity.toLowerCase();
  const account = state.accounts.get(counterparty);
  if (!account?.activeDispute) {
    throw new Error(`J_HASH_LADDER_SOURCE_ACTIVE_DISPUTE_MISSING:${counterparty}`);
  }
  const active = account.activeDispute;
  if (!active.observedOnChain) return 'open';
  const startSec = Number(active.disputeStartTimestamp);
  if (!Number.isSafeInteger(startSec) || startSec < 0) {
    throw new Error(`J_HASH_LADDER_SOURCE_DISPUTE_START_INVALID:${String(active.disputeStartTimestamp)}`);
  }
  const self = state.entityId.toLowerCase();
  const selfIsLeft = account.state.leftEntity.toLowerCase() === self;
  const ownerWindow = selfIsLeft
    ? account.state.disputeConfig.leftResponseSeconds
    : account.state.disputeConfig.rightResponseSeconds;
  const nowSec = Math.floor(Number(state.timestamp) / 1_000);
  if (nowSec < startSec) {
    throw new Error(`J_HASH_LADDER_SOURCE_WINDOW_NOT_OPEN:${nowSec}:${startSec}`);
  }
  return nowSec > startSec + ownerWindow ? 'expired' : 'open';
};

export const stashPendingRegistryReveal = (
  state: EntityState,
  counterpartyEntity: string,
  pull: { fullHash: string; partialRoot: string },
  decoded: { fillRatio: number; fullSecret?: string; reveals?: [string, string, string, string] },
  targetRole: boolean,
): void => {
  const ladderHash = ladderHashForPull(pull);
  const normalizedCounterparty = String(counterpartyEntity).toLowerCase();
  let matchedRoutes = 0;
  for (const route of state.crossJurisdictionSwaps?.values?.() ?? []) {
    const rolePull = targetRole ? route.targetPull : route.sourcePull;
    if (!pullMatchesLadder(rolePull, ladderHash)) continue;
    if (counterpartyForRouteLeg(state, route, targetRole) !== normalizedCounterparty) continue;
    matchedRoutes += 1;
    const pending = {
      fillRatio: decoded.fillRatio,
      fullSecret: decoded.fullSecret ?? ZERO_BYTES32,
      reveals: decoded.reveals ?? [ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32],
    };
    if (targetRole) {
      // Target may always replace an unsent port with the newest public Source
      // evidence. Its signed Pull reads the replaceable Target slot.
      route.pendingTargetRegistryReveal = pending;
    } else if (!route.pendingSourceRegistryReveal) {
      // Never replace source evidence: a second witness can be combined with
      // the first. The first queued source reveal is the only one publishable.
      route.pendingSourceRegistryReveal = pending;
    }
    route.updatedAt = Number(state.timestamp || route.updatedAt || 0);
  }
  if (matchedRoutes === 0) {
    throw new Error(
      `J_HASH_LADDER_ROUTE_SLOT_MISSING:${state.entityId}:` +
      `${ladderHash}:${targetRole ? 'target' : 'source'}`,
    );
  }
};

const targetRevealHasActiveDispute = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
): boolean => Boolean(
  state.accounts.get(String(route.target.entityId || '').toLowerCase())?.activeDispute,
);

/** Count witnesses that have not yet entered an immutable sent batch. */
export const countDeferredHashLadderReveals = (state: EntityState): number => {
  let pending = 0;
  for (const route of state.crossJurisdictionSwaps?.values?.() ?? []) {
    if (route.pendingSourceRegistryReveal) pending += 1;
    // Pre-binding Target evidence is durable but not yet publishable. It must
    // neither block an unrelated Account finalization nor be flushed by an
    // unrelated Hanko ACK before the target dispute defines S.
    if (route.pendingTargetRegistryReveal && targetRevealHasActiveDispute(state, route)) pending += 1;
  }
  return pending;
};

/** Flush role-scoped reveals after the immutable in-flight batch clears. */
export const flushDeferredHashLadderReveals = (
  state: EntityState,
  accountCounterparty?: string,
): number => {
  if (state.jBatchState?.sentBatch) return 0;
  const scopedCounterparty = accountCounterparty?.toLowerCase();
  let flushed = 0;
  for (const route of state.crossJurisdictionSwaps?.values?.() ?? []) {
    const sourcePending = route.pendingSourceRegistryReveal;
    if (sourcePending && route.sourcePull) {
      const sourceCounterparty = counterpartyForRouteLeg(state, route, false);
      if (scopedCounterparty && sourceCounterparty !== scopedCounterparty) continue;
      delete route.pendingSourceRegistryReveal;
      const result = queueHashLadderRevealRegistration(
        state,
        sourceCounterparty,
        route.sourcePull,
        sourcePending,
        false,
      );
      if (result === 'queued') flushed += 1;
    }
    const targetPending = route.pendingTargetRegistryReveal;
    if (targetPending && route.targetPull && targetRevealHasActiveDispute(state, route)) {
      const targetCounterparty = counterpartyForRouteLeg(state, route, true);
      if (scopedCounterparty && targetCounterparty !== scopedCounterparty) continue;
      delete route.pendingTargetRegistryReveal;
      const result = queueHashLadderRevealRegistration(
        state,
        targetCounterparty,
        route.targetPull,
        targetPending,
        true,
      );
      if (result === 'queued') flushed += 1;
    }
  }
  return flushed;
};

const collectExistingRegistryRatios = (
  state: EntityState,
  normalizedCounterparty: string,
  ladderHash: string,
  targetRole: boolean,
): {
  jBatchState: NonNullable<EntityState['jBatchState']>;
  confirmedRatios: number[];
  queuedRatios: number[];
} => {
  const jBatchState = (state.jBatchState ??= initJBatch());
  const confirmedRatios: number[] = [];
  const queuedRatios: number[] = [];
  for (const route of state.crossJurisdictionSwaps?.values?.() ?? []) {
    const rolePull = targetRole ? route.targetPull : route.sourcePull;
    if (!pullMatchesLadder(rolePull, ladderHash)) continue;
    if (counterpartyForRouteLeg(state, route, targetRole) !== normalizedCounterparty) continue;
    const confirmed = targetRole
      ? route.targetRegistryFillRatio
      : route.sourceRegistryFillRatio;
    const pending = targetRole
      ? route.pendingTargetRegistryReveal
      : route.pendingSourceRegistryReveal;
    if (confirmed !== undefined) confirmedRatios.push(confirmed);
    if (pending) queuedRatios.push(pending.fillRatio);
  }
  const collectBatchRatios = (
    registrations: typeof jBatchState.batch.hashLadderRegistrations,
  ): void => {
    for (const registration of registrations) {
      if (
        registration.targetRole === targetRole
        && registration.counterpartyEntity.toLowerCase() === normalizedCounterparty
        && ladderHashForPull(registration) === ladderHash
      ) queuedRatios.push(registration.witness.fillRatio);
    }
  };
  collectBatchRatios(jBatchState.batch.hashLadderRegistrations);
  if (jBatchState.sentBatch) collectBatchRatios(jBatchState.sentBatch.batch.hashLadderRegistrations);
  for (const recoveryBatch of jBatchState.recoveryBatches ?? []) {
    collectBatchRatios(recoveryBatch.hashLadderRegistrations);
  }
  return { jBatchState, confirmedRatios, queuedRatios };
};

export const queueHashLadderRevealRegistration = (
  state: EntityState,
  counterpartyEntity: string,
  pull: CrossJurisdictionPullLeg,
  decoded: { fillRatio: number; fullSecret?: string; reveals?: [string, string, string, string] },
  targetRole: boolean,
): HashLadderRevealQueueResult => {
  if (!Number.isInteger(decoded.fillRatio) || decoded.fillRatio <= 0 || decoded.fillRatio > 0xffff) {
    throw new Error(`J_HASH_LADDER_FILL_RATIO_INVALID:${String(decoded.fillRatio)}`);
  }
  const ladderHash = ladderHashForPull(pull);
  const normalizedCounterparty = String(counterpartyEntity).toLowerCase();
  if (!ethers.isHexString(normalizedCounterparty, 32)) {
    throw new Error(`J_HASH_LADDER_COUNTERPARTY_INVALID:${counterpartyEntity}`);
  }
  // A source reveal is a one-time witness: an exact retry is harmless, while
  // any different ratio is E12-equivalent evidence of an attempted second
  // source. Target is intentionally replaceable, but only monotonically: an
  // exact retry is a no-op, a lower ratio is stale/conflicting, and a higher
  // ratio replaces the draft or becomes the one deferred successor to a sent
  // batch. Include confirmed and deferred route state so retries cannot create
  // redundant broadcasts merely because the same write left the draft batch.
  const { jBatchState, confirmedRatios, queuedRatios } = collectExistingRegistryRatios(
    state,
    normalizedCounterparty,
    ladderHash,
    targetRole,
  );
  if (queuedRatios.includes(decoded.fillRatio)) return 'already-queued';
  if (!targetRole && confirmedRatios.includes(decoded.fillRatio)) return 'already-queued';
  const existingRatios = [...confirmedRatios, ...queuedRatios];
  if (existingRatios.length > 0) {
    const currentRatio = Math.max(...existingRatios);
    if (!targetRole || decoded.fillRatio < currentRatio) {
      throw new Error(
        `J_HASH_LADDER_REGISTRATION_CONFLICT:${ladderHash}:` +
        `${targetRole ? 'target' : 'source'}:` +
        `${currentRatio}:${decoded.fillRatio}`,
      );
    }
  }
  if (!targetRole && sourceRevealWindowStatus(state, normalizedCounterparty) === 'expired') {
    return 'source-window-expired';
  }

  // The sent batch is immutable, but the next draft remains writable. Queue
  // there whenever capacity exists: a Pull-bearing dispute start may already
  // be holding its zero-window Source witnesses behind the sent nonce, and
  // deferring those witnesses separately would break their atomicity.
  const registration: Parameters<typeof batchAddHashLadderRegistration>[1] = {
    counterpartyEntity: normalizedCounterparty,
    targetRole,
    fullHash: pull.fullHash,
    partialRoot: pull.partialRoot,
    witness: {
      fillRatio: decoded.fillRatio,
      fullSecret: decoded.fullSecret ?? ZERO_BYTES32,
      reveals: decoded.reveals ?? [ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32],
    },
  };
  if (!hasHashLadderRegistrationRoom(jBatchState.batch, registration)) {
    stashPendingRegistryReveal(state, normalizedCounterparty, pull, decoded, targetRole);
    if (jBatchState.sentBatch && !isBatchEmpty(jBatchState.batch)) {
      // The immutable batch's ACK must drain this already-full successor before
      // the pending witness can enter the following batch. Without the latch,
      // the editable draft and a time-sensitive reveal could remain stranded.
      jBatchState.autoBroadcastDraft = true;
    }
    return 'deferred-batch-pending';
  }

  batchAddHashLadderRegistration(jBatchState, registration);
  if (jBatchState.sentBatch) {
    // The exact Hanko ACK owns the next broadcast continuation. Latch the
    // nonempty draft now so an unrelated in-flight batch cannot strand it.
    jBatchState.autoBroadcastDraft = true;
  }
  return 'queued';
};

export type SourceHubClaimRegistration = {
  routeId: string;
  fillRatio: number;
  result: HashLadderRevealQueueResult;
};

/**
 * Publish the Source Hub's already-committed independent registry evidence.
 * The Account dispute supplies only the settlement clock: registry admission
 * does not inspect or replay its ProofBody because processBatch already
 * authenticates the writing Entity.
 *
 * A local starter must call this after installing its draft activeDispute and
 * before sealing jBatch. The start and Source registration then execute in one
 * Depository.processBatch transaction, so Solidity observes the registration
 * at the inclusive start second even if mining itself is delayed.
 */
export const queueSourceHubClaimRegistrationForRoute = (
  state: EntityState,
  routeId: string,
  counterpartyId: string,
  runtimeSeed: string | undefined,
): SourceHubClaimRegistration | undefined => {
  const route = state.crossJurisdictionSwaps?.get(routeId);
  if (!route) throw new Error(`CROSS_J_SOURCE_CLAIM_ROUTE_MISSING:${routeId}`);
  if (isCrossJurisdictionTerminalStatus(route.status) || !route.sourcePull) return undefined;
  const self = String(state.entityId).toLowerCase();
  if (
    String(route.source.counterpartyEntityId).toLowerCase() !== self
    || String(route.source.entityId).toLowerCase() !== counterpartyId.toLowerCase()
  ) {
    return undefined;
  }
  const fillRatio = getCrossJurisdictionCommittedProofRatio(route);
  if (fillRatio <= 0) return undefined;
  const sourceAccount = state.accounts.get(counterpartyId.toLowerCase());
  if (!sourceAccount) {
    throw new Error(`CROSS_J_SOURCE_CLAIM_ACCOUNT_MISSING:${routeId}:${counterpartyId}`);
  }
  const active = sourceAccount.activeDispute;
  if (active?.observedOnChain) {
    const startSec = Number(active.disputeStartTimestamp);
    const selfIsLeft = sourceAccount.state.leftEntity.toLowerCase() === self;
    const beneficiaryWindow = selfIsLeft
      ? sourceAccount.state.disputeConfig.leftResponseSeconds
      : sourceAccount.state.disputeConfig.rightResponseSeconds;
    const deadlineSec = startSec + beneficiaryWindow;
    if (isSourceRevealWindowExpired(Number(state.timestamp), deadlineSec)) {
      return { routeId, fillRatio, result: 'source-window-expired' };
    }
  }
  const reveal = buildCrossJurisdictionPullReveal(
    route,
    fillRatio,
    deriveCrossJurisdictionPrivateSeed(runtimeSeed, route),
  );
  return {
    routeId,
    fillRatio,
    result: queueHashLadderRevealRegistration(
      state,
      counterpartyId,
      route.sourcePull,
      decodeHashLadderBinary(reveal.binary),
      false,
    ),
  };
};

/** Queue every committed Source claim frozen by one Account dispute. */
export const queueSourceHubClaimRegistrationsForAccount = (
  state: EntityState,
  counterpartyId: string,
  runtimeSeed: string | undefined,
  signedProofbody: ProofBodyStruct,
  canonicalDeltaTransformerAddress: string,
): SourceHubClaimRegistration[] => {
  const self = String(state.entityId).toLowerCase();
  const counterparty = counterpartyId.toLowerCase();
  const routeIds = Array.from(state.crossJurisdictionSwaps?.values?.() ?? [])
    .filter(route => (
      !isCrossJurisdictionTerminalStatus(route.status)
      && Boolean(route.sourcePull)
      && route.source.counterpartyEntityId.toLowerCase() === self
      && route.source.entityId.toLowerCase() === counterparty
    ))
    .map(route => route.orderId)
    .sort(compareStableText);
  const claims: SourceHubClaimRegistration[] = [];
  for (const routeId of routeIds) {
    const route = state.crossJurisdictionSwaps!.get(routeId)!;
    if (!findExactSignedProofBodyPull(
      signedProofbody,
      route.sourcePull!,
      false,
      canonicalDeltaTransformerAddress,
    )) continue;
    const claim = queueSourceHubClaimRegistrationForRoute(
      state,
      routeId,
      counterpartyId,
      runtimeSeed,
    );
    if (claim) claims.push(claim);
  }
  return claims;
};

/**
 * The compact off-chain reveal encoding shared with the account close path:
 * 32-byte full secret for a 100% fill, otherwise 2-byte big-endian uint16
 * ratio followed by the four nibble reveal nodes.
 */
const revealBinaryFromRegistryEvent = (event: {
  fillRatio: number;
  fullSecret: string;
  reveals: readonly string[];
}): string => {
  if (event.fillRatio >= CROSS_J_MAX_FILL_RATIO) return event.fullSecret.toLowerCase();
  const ratioHex = event.fillRatio.toString(16).padStart(4, '0');
  return `0x${ratioHex}${event.reveals.map(reveal => reveal.slice(2)).join('')}`.toLowerCase();
};

/**
 * Registry-event driven cross-j recovery. A HashLadderRevealRegistered event on
 * the source chain is the ONLY recovery trigger: the hub cannot claim the
 * source pull on-chain without making the reveal publicly portable, so the
 * target user simply registers the same verified material on the target chain
 * under its own key. Exactly one local entity owns the source-user lane per
 * route, so exactly one port instruction is emitted per reveal.
 */
export function queueCrossJurisdictionRevealPorts(
  state: EntityState,
  outputs: EntityInput[],
  event: {
    entity: string;
    counterpartyEntity: string;
    ladderHash: string;
    fillRatio: number;
    fullSecret: string;
    reveals: [string, string, string, string];
    targetRole: boolean;
  },
  blockNumber: number,
): number {
  const self = String(state.entityId || '').toLowerCase();
  const ladderHash = String(event.ladderHash || '').toLowerCase();
  if (!self || !ladderHash || event.fillRatio <= 0 || event.targetRole) return 0;
  const binary = revealBinaryFromRegistryEvent(event);
  const batches = new Map<string, {
    entityId: string;
    signerId: string;
    txs: NonNullable<EntityInput['entityTxs']>;
  }>();
  for (const route of state.crossJurisdictionSwaps?.values?.() ?? []) {
    if (String(route.source?.entityId || '').toLowerCase() !== self) continue;
    if (String(route.source?.counterpartyEntityId || '').toLowerCase() !== String(event.entity).toLowerCase()) continue;
    if (String(route.source.entityId).toLowerCase() !== String(event.counterpartyEntity).toLowerCase()) continue;
    if (!route.sourcePull || !route.targetPull) continue;
    if (isCrossJurisdictionTerminalStatus(route.status)) continue;
    if (ladderHashForPull(route.sourcePull) !== ladderHash) continue;
    // The source chain already verified this material at registration; a
    // mismatch against the target commitment here means the local route mirror
    // is corrupt, and that must stay loud rather than silently dropped.
    const verified = verifyHashLadderBinary({
      fullHash: route.targetPull.fullHash,
      partialRoot: route.targetPull.partialRoot,
    }, binary);
    if (verified.fillRatio !== event.fillRatio) {
      throw new Error(
        `CROSS_J_REVEAL_PORT_RATIO_MISMATCH:${route.orderId}:` +
        `event=${event.fillRatio}:verified=${verified.fillRatio}`,
      );
    }
    const entityId = String(route.target.counterpartyEntityId || '').toLowerCase();
    const signerId = String(route.targetSignerId || '').toLowerCase();
    if (!entityId || !signerId) {
      throw new Error(`CROSS_J_REVEAL_PORT_LANE_MISSING:${route.orderId}`);
    }
    const key = `${entityId}\0${signerId}`;
    const batch = batches.get(key) ?? { entityId, signerId, txs: [] };
    batch.txs.push({
      type: 'crossJurisdictionSalvage',
      data: {
        routeId: route.orderId,
        binary,
        fillRatio: event.fillRatio,
        sourceEntityId: route.source.entityId,
        sourceCounterpartyEntityId: route.source.counterpartyEntityId,
        observedAt: blockNumber,
      },
    });
    batches.set(key, batch);
  }
  for (const batch of [...batches.values()].sort((left, right) =>
    `${left.entityId}\0${left.signerId}`.localeCompare(`${right.entityId}\0${right.signerId}`),
  )) {
    outputs.push(buildCrossJurisdictionEntityOutput(batch.entityId, batch.signerId, batch.txs));
  }
  if (batches.size > 0) {
    addMessage(state, `🌉 Cross-j reveal observed: porting ratio ${event.fillRatio} to ${batches.size} target lane(s)`);
  }
  return batches.size;
}

export function findCrossJurisdictionRoutesForTargetDispute(
  state: EntityState,
  counterpartyId: string,
): CrossJurisdictionSwapRoute[] {
  const self = String(state.entityId || '').toLowerCase();
  const counterparty = String(counterpartyId || '').toLowerCase();
  return Array.from(state.crossJurisdictionSwaps?.values() ?? [])
    .filter((route) =>
      String(route.target.counterpartyEntityId || '').toLowerCase() === self &&
      String(route.target.entityId || '').toLowerCase() === counterparty &&
      Boolean(route.targetPull) &&
      // Informational fill progress must not gate dispute recovery: a valid
      // on-chain reveal governs even when no local fill info ever arrived.
      !isCrossJurisdictionTerminalStatus(route.status),
    )
    .sort((left, right) => {
      const leftId = String(left.orderId || '');
      const rightId = String(right.orderId || '');
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
}

const targetUserSnapshotPullIds = (
  state: EntityState,
  account: AccountReplica,
  proofbodyHashes: readonly string[],
): string[] => {
  const self = String(state.entityId || '').toLowerCase();
  const side = self === String(account.state.leftEntity || '').toLowerCase()
    ? 'left'
    : self === String(account.state.rightEntity || '').toLowerCase()
      ? 'right'
      : null;
  if (!side) throw new Error(`CROSS_J_TARGET_ACCOUNT_ROLE_MISMATCH:${state.entityId}`);
  const pullIds: string[] = [];
  const seen = new Set<string>();
  for (const proofbodyHash of proofbodyHashes) {
    const snapshot = account.disputeArgumentSnapshotsByHash?.[proofbodyHash];
    if (!snapshot) {
      throw new Error(`CROSS_J_TARGET_SIGNED_SNAPSHOT_MISSING:${proofbodyHash || 'missing'}`);
    }
    const sidePullIds = side === 'left'
      ? snapshot.plan.leftPullIds
      : snapshot.plan.rightPullIds;
    for (const pullId of sidePullIds) {
      if (!seen.has(pullId)) {
        seen.add(pullId);
        pullIds.push(pullId);
      }
    }
  }
  return pullIds;
};

export type CrossJurisdictionTargetRecoveryPlan = {
  recovery: CrossJurisdictionDisputeRecovery;
  representativeRouteId: string;
};

const selectTargetRecoveryRoutes = (
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  proofbodyHashes: readonly string[],
): { routes: CrossJurisdictionSwapRoute[]; snapshotPullIds: string[] } => {
  const candidates = findCrossJurisdictionRoutesForTargetDispute(state, counterpartyId);
  if (candidates.length === 0) return { routes: [], snapshotPullIds: [] };
  const snapshotPullIds = targetUserSnapshotPullIds(state, account, proofbodyHashes);
  const snapshotSet = new Set(snapshotPullIds);
  const routes = candidates
    .filter((route) => snapshotSet.has(route.targetPull!.pullId));
  return { routes, snapshotPullIds };
};

export function planCrossJurisdictionTargetRecovery(
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  proofbodyHashes: readonly string[],
  suppliedResults: Readonly<Record<string, string>>,
): CrossJurisdictionTargetRecoveryPlan | null {
  const { routes, snapshotPullIds } = selectTargetRecoveryRoutes(
    state,
    account,
    counterpartyId,
    proofbodyHashes,
  );
  if (routes.length === 0) return null;
  const requiredSet = new Set(routes.map((route) => route.targetPull!.pullId));
  const resultsByPullId: Record<string, string> = {};
  for (const [pullId, result] of Object.entries(suppliedResults)) {
    if (!requiredSet.has(pullId)) {
      throw new Error(`CROSS_J_TARGET_RECOVERY_RESULT_UNBOUND:${pullId}`);
    }
    resultsByPullId[pullId] = String(result || '0').toLowerCase();
  }
  // Port-wait recovery stays local. Sibling dispute fanout is a separate
  // EntityTx path (`crossJurisdictionForceSiblingDispute`): observing any
  // DisputeStarted on a route leg asks every sibling to start its own clock
  // (must-close — missing signer binder throws). Missing ports abandon only
  // after a source-jurisdiction tip is past its beneficiary-side Source
  // deadline. Target writes remain durable even when late, but settle as zero.
  // No sealed pull.revealedUntilTimestamp market gate.
  return {
    representativeRouteId: routes[0]!.orderId,
    recovery: {
      requiredPullIds: snapshotPullIds.filter((pullId) => requiredSet.has(pullId)),
      resultsByPullId,
    },
  };
}

type SiblingDisputeTarget = {
  entityId: string;
  signerId: string;
  routeId: string;
};

/**
 * Map this entity's role on a route to the intra-runtime sibling that must
 * start its own dispute clock. Users fan out user↔user; hubs fan out hub↔hub.
 */
const siblingDisputeTargetForRoute = (
  route: CrossJurisdictionSwapRoute,
  self: string,
): SiblingDisputeTarget | null => {
  const sourceUser = String(route.source?.entityId || '').toLowerCase();
  const sourceHub = String(route.source?.counterpartyEntityId || '').toLowerCase();
  const targetHub = String(route.target?.entityId || '').toLowerCase();
  const targetUser = String(route.target?.counterpartyEntityId || '').toLowerCase();
  if (self === sourceUser) {
    const signerId = String(route.targetSignerId || '').toLowerCase();
    return signerId && targetUser ? { entityId: targetUser, signerId, routeId: route.orderId } : null;
  }
  if (self === targetUser) {
    const signerId = String(route.sourceSignerId || '').toLowerCase();
    return signerId && sourceUser ? { entityId: sourceUser, signerId, routeId: route.orderId } : null;
  }
  if (self === sourceHub) {
    const signerId = String(route.targetHubSignerId || '').toLowerCase();
    return signerId && targetHub ? { entityId: targetHub, signerId, routeId: route.orderId } : null;
  }
  if (self === targetHub) {
    const signerId = String(route.sourceHubSignerId || '').toLowerCase();
    return signerId && sourceHub ? { entityId: sourceHub, signerId, routeId: route.orderId } : null;
  }
  return null;
};

const routeTouchesDisputedAccount = (
  route: CrossJurisdictionSwapRoute,
  self: string,
  counterparty: string,
): boolean => {
  const sourceUser = String(route.source?.entityId || '').toLowerCase();
  const sourceHub = String(route.source?.counterpartyEntityId || '').toLowerCase();
  const targetHub = String(route.target?.entityId || '').toLowerCase();
  const targetUser = String(route.target?.counterpartyEntityId || '').toLowerCase();
  const sourceLeg =
    (self === sourceUser && counterparty === sourceHub) ||
    (self === sourceHub && counterparty === sourceUser);
  const targetLeg =
    (self === targetUser && counterparty === targetHub) ||
    (self === targetHub && counterparty === targetUser);
  return sourceLeg || targetLeg;
};

/**
 * Must-close sibling clock fanout.
 *
 * Different wall-clock T across chains is fine; equal bilateral delay *config*
 * is the prepare rule. What is not fine: soft-skipping a live route that lacks
 * a signer binder — that left one leg's dispute unstarted while the other
 * finalized (economic residual). Missing binder → throw SIGNER_MISSING.
 *
 * This is not a network best-effort fanout. `localRuntimeProtocol:'cross-j'`
 * is accepted only for an exact local target, drained as a continuation of
 * the same Runtime candidate, and covered by that candidate's single WAL
 * commit. A crash before WAL publishes neither leg; recovery after WAL sees
 * both. Never move this output into the transport outbox: doing so would
 * create the one-leg durability gap that the must-close invariant forbids.
 */
export function queueCrossJurisdictionSiblingDisputeFanout(
  state: EntityState,
  outputs: EntityInput[],
  counterpartyId: string,
  observedAt?: number,
): number {
  const self = String(state.entityId || '').toLowerCase();
  const counterparty = String(counterpartyId || '').toLowerCase();
  if (!self || !counterparty) return 0;
  const batches = new Map<string, {
    entityId: string;
    signerId: string;
    txs: NonNullable<EntityInput['entityTxs']>;
  }>();
  for (const route of state.crossJurisdictionSwaps?.values?.() ?? []) {
    if (isCrossJurisdictionTerminalStatus(route.status)) continue;
    if (!routeTouchesDisputedAccount(route, self, counterparty)) continue;
    if (!route.sourcePull || !route.targetPull) {
      if (route.status === 'intent' && !route.sourcePull && !route.targetPull) {
        // A persisted raw intent has no bilateral lock and therefore no sibling
        // clock to start. Authoritative Account dispute start cancels that
        // zero-exposure preparation instead of wedging J-event ingestion.
        transitionCrossJurisdictionRouteStatus(
          route,
          'cancelled',
          Number(state.timestamp || 0),
        );
        continue;
      }
      throw new Error(`CROSS_J_SIBLING_DISPUTE_PULLS_MISSING:${route.orderId}`);
    }
    const sibling = siblingDisputeTargetForRoute(route, self);
    if (!sibling) {
      // Must-close: a live non-terminal route with pulls that touches this
      // disputed Account must always resolve a sibling binder. Soft-skip left
      // the other leg's clock unstarted (silence→0 residual). Auth admission
      // already requires four signers — absence here is state corruption.
      throw new Error(
        `CROSS_J_SIBLING_DISPUTE_SIGNER_MISSING:${route.orderId}:self=${self}`,
      );
    }
    const key = `${sibling.entityId}\0${sibling.signerId}`;
    const batch = batches.get(key) ?? {
      entityId: sibling.entityId,
      signerId: sibling.signerId,
      txs: [],
    };
    batch.txs.push({
      type: 'crossJurisdictionForceSiblingDispute',
      data: {
        routeId: sibling.routeId,
        observedCounterpartyEntityId: counterparty,
        ...(observedAt !== undefined ? { observedAt } : {}),
      },
    });
    batches.set(key, batch);
  }
  for (const batch of [...batches.values()].sort((left, right) =>
    `${left.entityId}\0${left.signerId}`.localeCompare(`${right.entityId}\0${right.signerId}`),
  )) {
    outputs.push(buildCrossJurisdictionEntityOutput(batch.entityId, batch.signerId, batch.txs));
  }
  if (batches.size > 0) {
    addMessage(
      state,
      `⚔️ Cross-j dispute observed vs ${counterparty.slice(-4)}: fanning out to ${batches.size} sibling lane(s)`,
    );
  }
  return batches.size;
}

export function refreshCrossJurisdictionTargetRecovery(
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  proofbodyHashes: readonly string[],
  current: CrossJurisdictionDisputeRecovery,
): CrossJurisdictionTargetRecoveryPlan | null {
  const { routes } = selectTargetRecoveryRoutes(
    state,
    account,
    counterpartyId,
    proofbodyHashes,
  );
  const required = new Set(routes.map((route) => route.targetPull!.pullId));
  const retainedResults = Object.fromEntries(
    Object.entries(current.resultsByPullId)
      .filter(([pullId]) => required.has(pullId)),
  );
  return planCrossJurisdictionTargetRecovery(
    state,
    account,
    counterpartyId,
    proofbodyHashes,
    retainedResults,
  );
}

function queueInboundResolvesByHashlock(
  newState: EntityState,
  accountTxs: JEventAccountTx[],
  hashlock: string,
  secret: string,
): number {
  let queued = 0;
  for (const [counterpartyId, account] of newState.accounts.entries()) {
    const weAreLeft = account.state.leftEntity === newState.entityId;
    for (const lock of account.state.locks.values()) {
      if (String(lock.hashlock).toLowerCase() !== hashlock) continue;
      const senderIsUs = (lock.senderIsLeft && weAreLeft) || (!lock.senderIsLeft && !weAreLeft);
      if (senderIsUs) continue;
      accountTxs.push({
        accountId: counterpartyId,
        tx: {
          type: 'htlc_resolve',
          data: {
            lockId: lock.lockId,
            outcome: 'secret' as const,
            secret,
          },
        },
      });
      queued++;
    }
  }
  return queued;
}

export function applyKnownHtlcSecret(
  newState: EntityState,
  accountTxs: JEventAccountTx[],
  outputs: EntityInput[],
  hashlockRaw: string,
  secretRaw: string,
  blockNumber: number,
  source: 'SecretRevealed' | 'DisputeStarted',
): boolean {
  const hashlock = String(hashlockRaw).toLowerCase();
  const secret = String(secretRaw).toLowerCase();

  const directRoute = newState.htlcRoutes.get(hashlock);
  const route = directRoute ?? Array.from(newState.htlcRoutes.entries())
    .find(([candidateKey]) => candidateKey.toLowerCase() === hashlock)?.[1];

  if (!route) {
    const recovered = queueInboundResolvesByHashlock(newState, accountTxs, hashlock, secret);
    if (recovered > 0) {
      addMessage(newState, `🔓 HTLC reveal observed: ${hashlock.slice(0, 10)}... | Block ${blockNumber}`);
      return true;
    }
    jEventHtlcLog.debug('htlc.secret_unknown', { source, hashlock: shortHash(hashlock) });
    return false;
  }

  if (route.secret) {
    addMessage(newState, `🔓 HTLC reveal observed: ${hashlock.slice(0, 10)}... | Block ${blockNumber}`);
    return true;
  }

  route.secret = secret;

  if (route.pendingFee) {
    newState.htlcFeesEarned = (newState.htlcFeesEarned || 0n) + route.pendingFee;
    delete route.pendingFee;
  }

  if (route.outboundLockId) {
    newState.lockBook.delete(route.outboundLockId);
  }
  if (route.inboundLockId) {
    newState.lockBook.delete(route.inboundLockId);
  }

  if (route.inboundEntity && route.inboundLockId) {
    accountTxs.push({
      accountId: route.inboundEntity,
      tx: {
        type: 'htlc_resolve',
        data: {
          lockId: route.inboundLockId,
          outcome: 'secret' as const,
          secret,
        },
      },
    });
  } else if (route.crossJurisdictionRelay) {
    const relay = route.crossJurisdictionRelay;
    pushCrossJurisdictionEntityOutput(outputs, relay.targetEntityId, [{
        type: 'resolveHtlcLock',
        data: {
          counterpartyEntityId: relay.targetCounterpartyEntityId,
          lockId: relay.targetLockId,
          secret,
          crossJurisdictionRouteId: relay.routeId,
          description: `Cross-j ${relay.routeId} target claim ${relay.fillRatio}/${CROSS_J_MAX_FILL_RATIO}`,
        },
      }], relay.targetSignerId);
  }

  addMessage(newState, `🔓 HTLC reveal observed: ${hashlock.slice(0, 10)}... | Block ${blockNumber}`);
  return true;
}
