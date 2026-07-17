import { ethers } from 'ethers';
import type {
  CrossJurisdictionSwapRoute,
  EntityInput,
  EntityState,
  Env,
} from '../../types';
import { addMessage } from '../../state-helpers';
import { decodeHashLadderBinary } from '../../protocol/htlc/hash-ladder';
import { CROSS_J_MAX_FILL_RATIO, isCrossJurisdictionTerminalStatus } from '../../extensions/cross-j/index';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';
import { pushCrossJurisdictionEntityOutput } from './cross-j-outputs';
import type { JEventMempoolOp } from './j-events-types';

const jEventHtlcLog = createStructuredLogger('j.event.htlc');

type DisputeTransformerArgs = {
  secrets?: Array<string>;
  pulls?: Array<string>;
};

function decodeDisputeTransformerArgs(starterInitialArgumentsRaw: unknown): DisputeTransformerArgs[] {
  const starterInitialArguments = String(starterInitialArgumentsRaw || '0x');
  if (starterInitialArguments === '0x') return [];
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  let argArray: string[];
  try {
    [argArray] = abiCoder.decode(['bytes[]'], starterInitialArguments) as unknown as [string[]];
  } catch {
    return [];
  }

  const decodedArgs: DisputeTransformerArgs[] = [];
  for (const arg of argArray) {
    if (!arg || arg === '0x') continue;
    try {
      const [decoded] = abiCoder.decode(
        ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
        arg,
      ) as unknown as [DisputeTransformerArgs];
      decodedArgs.push(decoded);
    } catch {
      // Ignore non-transformer argument formats.
    }
  }
  return decodedArgs;
}

export function decodeDisputeStarterInitialSecrets(starterInitialArgumentsRaw: unknown): string[] {
  const secrets = new Set<string>();
  for (const decoded of decodeDisputeTransformerArgs(starterInitialArgumentsRaw)) {
    for (const secret of decoded.secrets || []) {
      if (ethers.isHexString(secret, 32)) {
        secrets.add(String(secret).toLowerCase());
      }
    }
  }
  return Array.from(secrets);
}

function decodeDisputeCrossPullBinaries(starterInitialArgumentsRaw: unknown): Array<{ fillRatio: number; binary: string }> {
  const binaries: Array<{ fillRatio: number; binary: string }> = [];
  for (const decoded of decodeDisputeTransformerArgs(starterInitialArgumentsRaw)) {
    for (const binary of decoded.pulls || []) {
      try {
        const decodedBinary = decodeHashLadderBinary(binary);
        if (decodedBinary.fillRatio > 0) binaries.push({ fillRatio: decodedBinary.fillRatio, binary });
      } catch {
        // Ignore malformed pull args inside otherwise valid transformer args.
      }
    }
  }
  return binaries;
}

function findCrossJurisdictionRouteForSourceDispute(
  state: EntityState,
  counterpartyId: string,
): CrossJurisdictionSwapRoute | null {
  const self = String(state.entityId || '').toLowerCase();
  const counterparty = String(counterpartyId || '').toLowerCase();
  const candidates = Array.from(state.crossJurisdictionSwaps?.values() ?? [])
    .filter((route) =>
      String(route.source.entityId || '').toLowerCase() === self &&
      String(route.source.counterpartyEntityId || '').toLowerCase() === counterparty &&
      Boolean(route.targetPull) &&
      !isCrossJurisdictionTerminalStatus(route.status),
    )
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return candidates[0] ?? null;
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
      !isCrossJurisdictionTerminalStatus(route.status),
    )
    .sort((left, right) => {
      const leftId = String(left.orderId || '');
      const rightId = String(right.orderId || '');
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
}

export function queueCrossJurisdictionSalvageFromDispute(
  env: Env,
  state: EntityState,
  outputs: EntityInput[],
  counterpartyId: string,
  starterInitialArgumentsRaw: unknown,
  blockNumber: number,
): boolean {
  // Cross-j salvage observes only starterInitialArguments. Incremented args are
  // committed for a possible counter-dispute and must not trigger source/target
  // salvage until that newer proof is actually used.
  return queueCrossJurisdictionSalvageFromArgumentList(
    env,
    state,
    outputs,
    counterpartyId,
    [starterInitialArgumentsRaw],
    blockNumber,
  );
}

export function queueCrossJurisdictionSalvageFromArgumentList(
  env: Env,
  state: EntityState,
  outputs: EntityInput[],
  counterpartyId: string,
  argumentBlobsRaw: unknown[],
  blockNumber: number,
): boolean {
  const pullBinaries: Array<{ fillRatio: number; binary: string }> = [];
  const seen = new Set<string>();
  for (const raw of argumentBlobsRaw) {
    const encoded = String(raw || '0x');
    if (!encoded || encoded === '0x') continue;
    for (const item of decodeDisputeCrossPullBinaries(encoded)) {
      const key = `${item.fillRatio}:${item.binary.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pullBinaries.push(item);
    }
  }
  if (pullBinaries.length === 0) return false;

  const route = findCrossJurisdictionRouteForSourceDispute(state, counterpartyId);
  if (!route) {
    jEventHtlcLog.warn('crossj.salvage_route_missing', { source: shortId(state.entityId), counterparty: shortId(counterpartyId) });
    return false;
  }

  const best = pullBinaries.reduce((acc, item) => item.fillRatio > acc.fillRatio ? item : acc, pullBinaries[0]!);
  pushCrossJurisdictionEntityOutput(env, outputs, route.target.counterpartyEntityId, [{
      type: 'crossJurisdictionSalvage',
      data: {
        routeId: route.orderId,
        binary: best.binary,
        fillRatio: best.fillRatio,
        sourceEntityId: route.source.entityId,
        sourceCounterpartyEntityId: route.source.counterpartyEntityId,
        observedAt: blockNumber,
      },
    }], route.targetSignerId);
  addMessage(state, `🌉 Cross-j pull args observed for ${route.orderId}; target salvage queued`);
  return true;
}

export function queueCrossJurisdictionSourceDisputeFromTargetDispute(
  env: Env,
  state: EntityState,
  outputs: EntityInput[],
  counterpartyId: string,
  starterInitialArgumentsRaw: unknown,
): boolean {
  if (decodeDisputeCrossPullBinaries(starterInitialArgumentsRaw).length > 0) return false;
  const routes = findCrossJurisdictionRoutesForTargetDispute(state, counterpartyId);
  if (routes.length === 0) return false;
  if (routes.length > 1) {
    const routeIds = routes.map((route) => route.orderId).join(',');
    addMessage(
      state,
      `⚠️ Cross-j target dispute route ambiguous for ${counterpartyId.slice(-4)}: ${routeIds}; no source dispute queued`,
    );
    return false;
  }
  const route = routes[0]!;

  if (!route.sourceSignerId) {
    throw new Error(`CROSS_J_SOURCE_DISPUTE_SIGNER_MISSING:${route.orderId}:${route.source.entityId}`);
  }

  pushCrossJurisdictionEntityOutput(env, outputs, route.source.entityId, [
      {
        type: 'disputeStart',
        data: {
          counterpartyEntityId: route.source.counterpartyEntityId,
          crossJurisdictionRouteId: route.orderId,
        },
      },
    ], route.sourceSignerId);
  addMessage(
    state,
    `🌉 Target dispute for ${route.orderId} has no pull args; source dispute queued to force hub reveal`,
  );
  return true;
}

function queueInboundResolvesByHashlock(
  newState: EntityState,
  mempoolOps: JEventMempoolOp[],
  hashlock: string,
  secret: string,
): number {
  let queued = 0;
  for (const [counterpartyId, account] of newState.accounts.entries()) {
    const weAreLeft = account.leftEntity === newState.entityId;
    for (const lock of account.locks.values()) {
      if (String(lock.hashlock).toLowerCase() !== hashlock) continue;
      const senderIsUs = (lock.senderIsLeft && weAreLeft) || (!lock.senderIsLeft && !weAreLeft);
      if (senderIsUs) continue;
      mempoolOps.push({
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
  env: Env,
  newState: EntityState,
  mempoolOps: JEventMempoolOp[],
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
    const recovered = queueInboundResolvesByHashlock(newState, mempoolOps, hashlock, secret);
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
    mempoolOps.push({
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
    pushCrossJurisdictionEntityOutput(env, outputs, relay.targetEntityId, [{
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
