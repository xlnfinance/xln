import { ethers } from 'ethers';
import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type {
  AccountReplica,
  CrossJurisdictionDisputeRecovery,
} from '../../types/account';
import type { EntityInput, EntityState } from '../types';
import { addMessage } from '../frame-events';
import { verifyHashLadderBinary } from '../../protocol/htlc/hash-ladder';
import {
  CROSS_J_MAX_FILL_RATIO,
  isCrossJurisdictionTerminalStatus,
} from '../../extensions/cross-j/index';
import { createStructuredLogger, shortHash } from '../../infra/logger';
import { buildCrossJurisdictionEntityOutput, pushCrossJurisdictionEntityOutput } from './cross-j-outputs';
import { batchAddHashLadderReveal, initJBatch } from '../../jurisdiction/machine/batch';
import type { JEventAccountTx } from './j-events-types';

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

/**
 * Queue a registry write with max-ratio preference. On-chain the record is
 * last-write-wins per entity key, and a higher-digit reveal derives every lower
 * one, so the honest maximum is the only ratio worth spending gas on; a
 * lower-ratio replay (e.g. a griefer re-registering derived material) must
 * never downgrade a pending write.
 */
export const queueHashLadderRevealRegistration = (
  state: EntityState,
  pull: { fullHash: string; partialRoot: string },
  decoded: { fillRatio: number; fullSecret?: string; reveals?: [string, string, string, string] },
): 'queued' | 'already-queued' => {
  const jBatchState = (state.jBatchState ??= initJBatch());
  const fullHash = pull.fullHash.toLowerCase();
  const partialRoot = pull.partialRoot.toLowerCase();
  const sameLadder = (op: { fullHash: string; partialRoot: string; fillRatio: number }): boolean =>
    op.fullHash.toLowerCase() === fullHash && op.partialRoot.toLowerCase() === partialRoot;
  const sentBest = (jBatchState.sentBatch?.batch.hashLadderReveals ?? [])
    .filter(sameLadder)
    .reduce((best, op) => Math.max(best, op.fillRatio), 0);
  if (sentBest >= decoded.fillRatio) return 'already-queued';
  const draft = jBatchState.batch.hashLadderReveals;
  const draftBest = draft.filter(sameLadder).reduce((best, op) => Math.max(best, op.fillRatio), 0);
  if (draftBest >= decoded.fillRatio) return 'already-queued';
  for (let index = draft.length - 1; index >= 0; index -= 1) {
    if (sameLadder(draft[index]!)) draft.splice(index, 1);
  }
  batchAddHashLadderReveal(jBatchState, {
    fullHash: pull.fullHash,
    partialRoot: pull.partialRoot,
    fillRatio: decoded.fillRatio,
    fullSecret: decoded.fullSecret ?? ZERO_BYTES32,
    reveals: decoded.reveals ?? [ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32],
  });
  return 'queued';
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
    ladderHash: string;
    fillRatio: number;
    fullSecret: string;
    reveals: [string, string, string, string];
  },
  blockNumber: number,
): number {
  const self = String(state.entityId || '').toLowerCase();
  const ladderHash = String(event.ladderHash || '').toLowerCase();
  if (!self || !ladderHash || event.fillRatio <= 0) return 0;
  const binary = revealBinaryFromRegistryEvent(event);
  const batches = new Map<string, {
    entityId: string;
    signerId: string;
    txs: NonNullable<EntityInput['entityTxs']>;
  }>();
  for (const route of state.crossJurisdictionSwaps?.values?.() ?? []) {
    if (String(route.source?.entityId || '').toLowerCase() !== self) continue;
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

function findCrossJurisdictionRoutesForTargetDispute(
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
  // Finalization is bounded by the on-chain barrier anyway; this timestamp is
  // the runtime-side mirror of it, after which a missing port resolves to a
  // zero claim instead of blocking the dispute forever.
  const resolveByTimestamp = routes.reduce(
    (latest, route) => Math.max(latest, Number(route.targetPull!.revealedUntilTimestamp || 0)),
    0,
  );
  // No source-dispute forcing anywhere: the hub's claim on the source leg is
  // only possible through a public registry write, which the port path then
  // carries here. Incentive, not instruction.
  return {
    representativeRouteId: routes[0]!.orderId,
    recovery: {
      requiredPullIds: snapshotPullIds.filter((pullId) => requiredSet.has(pullId)),
      resultsByPullId,
      resolveByTimestamp,
    },
  };
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
