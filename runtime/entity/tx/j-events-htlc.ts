import { ethers } from 'ethers';
import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type {
  AccountReplica,
  CrossJurisdictionDisputeRecovery,
} from '../../types/account';
import type { DisputeArgumentPlan } from '../../protocol/dispute/argument-snapshot';
import type { DisputeFinalizationEvidence } from '../../types/jurisdiction-events';
import type { EntityInput, EntityState } from '../types';
import { addMessage } from '../frame-events';
import { verifyHashLadderBinary } from '../../protocol/htlc/hash-ladder';
import {
  CROSS_J_MAX_FILL_RATIO,
  isCrossJurisdictionTerminalStatus,
} from '../../extensions/cross-j/index';
import { createStructuredLogger, shortHash } from '../../infra/logger';
import { buildCrossJurisdictionEntityOutput, pushCrossJurisdictionEntityOutput } from './cross-j-outputs';
import type { JEventAccountTx } from './j-events-types';

const jEventHtlcLog = createStructuredLogger('j.event.htlc');

type DisputeTransformerArgs = {
  secrets?: Array<string>;
  pulls?: Array<string>;
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
  // subcontract's arguments as payment/pull evidence.
  const deltaArgs = argArray[0];
  if (!deltaArgs || deltaArgs === '0x') return undefined;
  try {
    const decoded = abiCoder.decode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      deltaArgs,
    )[0];
    if (typeof decoded !== 'object' || decoded === null) return undefined;
    const secrets = decodeStringArray(Reflect.get(decoded, 'secrets'));
    const pulls = decodeStringArray(Reflect.get(decoded, 'pulls'));
    return {
      ...(secrets === undefined ? {} : { secrets }),
      ...(pulls === undefined ? {} : { pulls }),
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

function findCrossJurisdictionRoutesForSourceDispute(
  state: EntityState,
  counterpartyId: string,
): CrossJurisdictionSwapRoute[] {
  const self = String(state.entityId || '').toLowerCase();
  const counterparty = String(counterpartyId || '').toLowerCase();
  const candidates = Array.from(state.crossJurisdictionSwaps?.values() ?? [])
    .filter((route) =>
      String(route.source.entityId || '').toLowerCase() === self &&
      String(route.source.counterpartyEntityId || '').toLowerCase() === counterparty &&
      Boolean(route.targetPull) &&
      // Informational fill progress must not gate dispute recovery: a valid
      // on-chain reveal governs even when no local fill info ever arrived.
      !isCrossJurisdictionTerminalStatus(route.status),
    )
    .sort((left, right) => String(left.orderId).localeCompare(String(right.orderId)));
  return candidates;
}

const positionalPullArguments = (
  plan: Pick<DisputeArgumentPlan, 'leftPullIds' | 'rightPullIds'>,
  evidence: Pick<DisputeFinalizationEvidence, 'leftArguments' | 'rightArguments'> | undefined,
): Map<string, string> => {
  const result = new Map<string, string>();
  const sides = [
    [plan.leftPullIds, decodeDeltaTransformerArgs(evidence?.leftArguments)?.pulls ?? []],
    [plan.rightPullIds, decodeDeltaTransformerArgs(evidence?.rightArguments)?.pulls ?? []],
  ] as const;
  for (const [pullIds, binaries] of sides) {
    for (let index = 0; index < pullIds.length; index++) {
      const pullId = pullIds[index]!;
      if (result.has(pullId)) throw new Error(`CROSS_J_SOURCE_PULL_PLAN_DUPLICATE:${pullId}`);
      result.set(pullId, binaries[index] ?? '0x');
    }
  }
  return result;
};

const verifyPositionalSourcePull = (
  route: CrossJurisdictionSwapRoute,
  binary: string,
): { binary: string; fillRatio: number } => {
  if (!binary || binary === '0x') return { binary: '0x', fillRatio: 0 };
  try {
    const verified = verifyHashLadderBinary({
      fullHash: route.targetPull!.fullHash,
      partialRoot: route.targetPull!.partialRoot,
    }, binary);
    return verified.fillRatio > 0
      ? { binary, fillRatio: verified.fillRatio }
      : { binary: '0x', fillRatio: 0 };
  } catch {
    return { binary: '0x', fillRatio: 0 };
  }
};

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

type SourceDisputeGroup = { route: CrossJurisdictionSwapRoute; routes: CrossJurisdictionSwapRoute[] };

const groupTargetDisputeRoutesBySourceAccount = (
  routes: readonly CrossJurisdictionSwapRoute[],
): SourceDisputeGroup[] => {
  const seenRouteIds = new Set<string>();
  const groups = new Map<string, SourceDisputeGroup>();
  for (const route of routes) {
    if (!route.orderId || seenRouteIds.has(route.orderId)) {
      throw new Error(`CROSS_J_SOURCE_DISPUTE_ROUTE_ID_CONFLICT:${route.orderId || 'missing'}`);
    }
    seenRouteIds.add(route.orderId);
    const lane = [route.source.entityId, route.source.counterpartyEntityId]
      .map(value => String(value || '').toLowerCase());
    const signerId = String(route.sourceSignerId || '').toLowerCase();
    if (lane.some(value => !value) || !signerId) {
      throw new Error(`CROSS_J_SOURCE_DISPUTE_LANE_MISSING:${route.orderId}`);
    }
    const key = lane.join('\0');
    const group = groups.get(key);
    if (group) {
      if (String(group.route.sourceSignerId).toLowerCase() !== signerId) {
        throw new Error(`CROSS_J_SOURCE_DISPUTE_SIGNER_CONFLICT:${route.orderId}`);
      }
      group.routes.push(route);
    } else groups.set(key, { route, routes: [route] });
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => group);
};

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
  outputs: EntityInput[],
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
    resultsByPullId[pullId] = String(result || '0x').toLowerCase();
  }
  const missingRouteIds = new Set(
    routes
      .filter((route) => !Object.hasOwn(resultsByPullId, route.targetPull!.pullId))
      .map((route) => route.orderId),
  );
  const groups = groupTargetDisputeRoutesBySourceAccount(routes)
    .filter((group) => group.routes.some((route) => missingRouteIds.has(route.orderId)));
  const queued = groups.map(({ route }) => buildCrossJurisdictionEntityOutput(
    route.source.entityId,
    route.sourceSignerId,
    [{
      type: 'prepareDispute',
      data: {
        counterpartyEntityId: route.source.counterpartyEntityId,
        description: `Cross-j source dispute prepare ${route.orderId}`,
        crossJurisdictionRouteId: route.orderId,
      },
    }],
  ));
  outputs.push(...queued);
  return {
    representativeRouteId: routes[0]!.orderId,
    recovery: {
      requiredPullIds: snapshotPullIds.filter((pullId) => requiredSet.has(pullId)),
      resultsByPullId,
    },
  };
}

export function refreshCrossJurisdictionTargetRecovery(
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  proofbodyHashes: readonly string[],
  current: CrossJurisdictionDisputeRecovery,
  outputs: EntityInput[],
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
    outputs,
  );
}

export function queueCrossJurisdictionSalvageFromFinalizedArguments(
  state: EntityState,
  outputs: EntityInput[],
  counterpartyId: string,
  evidence: Pick<DisputeFinalizationEvidence, 'leftArguments' | 'rightArguments'> | undefined,
  plan: Pick<DisputeArgumentPlan, 'leftPullIds' | 'rightPullIds'>,
  blockNumber: number,
): boolean {
  const argumentsByPullId = positionalPullArguments(plan, evidence);
  const routes = findCrossJurisdictionRoutesForSourceDispute(state, counterpartyId)
    .filter(route => Boolean(route.sourcePull?.pullId && argumentsByPullId.has(route.sourcePull.pullId)));
  // Both peers see source finality. Only the source-user Entity owns these
  // route rows, so exactly one observer emits the Runtime-private result.
  if (routes.length === 0) return false;
  const batches = new Map<string, {
    entityId: string;
    signerId: string;
    txs: NonNullable<EntityInput['entityTxs']>;
  }>();
  for (const route of routes) {
    const result = verifyPositionalSourcePull(
      route,
      argumentsByPullId.get(route.sourcePull!.pullId)!,
    );
    const entityId = String(route.target.counterpartyEntityId || '').toLowerCase();
    const signerId = String(route.targetSignerId || '').toLowerCase();
    const key = `${entityId}\0${signerId}`;
    const batch = batches.get(key) ?? { entityId, signerId, txs: [] };
    batch.txs.push({
      type: 'crossJurisdictionSalvage',
      data: {
        routeId: route.orderId,
        binary: result.binary,
        fillRatio: result.fillRatio,
        sourceEntityId: route.source.entityId,
        sourceCounterpartyEntityId: route.source.counterpartyEntityId,
        observedAt: blockNumber,
      },
    });
    batches.set(key, batch);
  }
  for (const batch of [...batches.values()].sort((left, right) =>
    `${left.entityId}\0${left.signerId}`.localeCompare(`${right.entityId}\0${right.signerId}`)
  )) {
    outputs.push(buildCrossJurisdictionEntityOutput(batch.entityId, batch.signerId, batch.txs));
  }
  addMessage(state, `🌉 Cross-j source finality returned ${routes.length} target pull result(s)`);
  return true;
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
