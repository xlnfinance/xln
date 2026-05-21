import { ethers } from 'ethers';
import type {
  AccountTx,
  CrossJurisdictionSwapRoute,
  EntityInput,
  EntityState,
  Env,
} from '../types';
import { addMessage } from '../state-helpers';
import { decodeHashLadderBinary } from '../hashladder';
import { isCrossJurisdictionTerminalStatus } from '../cross-jurisdiction';
import { createStructuredLogger, shortHash, shortId, shortOrder } from '../logger';

const jEventHtlcLog = createStructuredLogger('j.event.htlc');

export type JEventMempoolOp = {
  accountId: string;
  tx: AccountTx;
};

type DisputeTransformerArgs = {
  secrets?: Array<string>;
  pulls?: Array<string>;
};

function decodeDisputeTransformerArgs(initialArgumentsRaw: unknown): DisputeTransformerArgs[] {
  const initialArguments = String(initialArgumentsRaw || '0x');
  if (initialArguments === '0x') return [];
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  let argArray: string[];
  try {
    [argArray] = abiCoder.decode(['bytes[]'], initialArguments) as unknown as [string[]];
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

export function decodeDisputeInitialSecrets(initialArgumentsRaw: unknown): string[] {
  const secrets = new Set<string>();
  for (const decoded of decodeDisputeTransformerArgs(initialArgumentsRaw)) {
    for (const secret of decoded.secrets || []) {
      if (ethers.isHexString(secret, 32)) {
        secrets.add(String(secret).toLowerCase());
      }
    }
  }
  return Array.from(secrets);
}

function decodeDisputeCrossPullBinaries(initialArgumentsRaw: unknown): Array<{ fillRatio: number; binary: string }> {
  const binaries: Array<{ fillRatio: number; binary: string }> = [];
  for (const decoded of decodeDisputeTransformerArgs(initialArgumentsRaw)) {
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

function findCrossJurisdictionRouteForTargetDispute(
  state: EntityState,
  counterpartyId: string,
): CrossJurisdictionSwapRoute | null {
  const self = String(state.entityId || '').toLowerCase();
  const counterparty = String(counterpartyId || '').toLowerCase();
  for (const route of state.crossJurisdictionSwaps?.values() ?? []) {
    if (
      String(route.target.counterpartyEntityId || '').toLowerCase() === self &&
      String(route.target.entityId || '').toLowerCase() === counterparty
    ) {
      return route;
    }
  }
  return null;
}

function findAccountByCounterparty(state: EntityState, counterpartyEntityId: string) {
  const normalized = String(counterpartyEntityId || '').toLowerCase();
  if (!normalized) return null;
  return Array.from(state.accounts.entries()).find(([accountId, account]) =>
    String(accountId || '').toLowerCase() === normalized ||
    String(account.leftEntity || '').toLowerCase() === normalized ||
    String(account.rightEntity || '').toLowerCase() === normalized,
  )?.[1] ?? null;
}

function findEntityStateById(env: Env, entityId: string): EntityState | null {
  const target = String(entityId || '').toLowerCase();
  if (!target) return null;
  return Array.from(env.eReplicas?.values?.() || [])
    .map((replica) => replica?.state)
    .find((state) => state && String(state.entityId || '').toLowerCase() === target) ?? null;
}

function hasQueuedDisputeStart(state: EntityState | null, counterpartyEntityId: string): boolean {
  const target = String(counterpartyEntityId || '').toLowerCase();
  const draft = state?.jBatchState?.batch?.disputeStarts || [];
  const sent = state?.jBatchState?.sentBatch?.batch?.disputeStarts || [];
  return (
    draft.some((op) => String(op?.counterentity || '').toLowerCase() === target) ||
    sent.some((op) => String(op?.counterentity || '').toLowerCase() === target)
  );
}

export function queueCrossJurisdictionSalvageFromDispute(
  state: EntityState,
  outputs: EntityInput[],
  counterpartyId: string,
  initialArgumentsRaw: unknown,
  blockNumber: number,
): boolean {
  const initialArguments = String(initialArgumentsRaw || '0x');
  if (!initialArguments || initialArguments === '0x') return false;
  const pullBinaries = decodeDisputeCrossPullBinaries(initialArguments);
  if (pullBinaries.length === 0) return false;

  const route = findCrossJurisdictionRouteForSourceDispute(state, counterpartyId);
  if (!route) {
    jEventHtlcLog.warn('crossj.salvage_route_missing', { source: shortId(state.entityId), counterparty: shortId(counterpartyId) });
    return false;
  }

  const best = pullBinaries.reduce((acc, item) => item.fillRatio > acc.fillRatio ? item : acc, pullBinaries[0]!);
  outputs.push({
    entityId: route.target.counterpartyEntityId,
    entityTxs: [{
      type: 'crossJurisdictionSalvage',
      data: {
        routeId: route.orderId,
        binary: best.binary,
        fillRatio: best.fillRatio,
        sourceEntityId: route.source.entityId,
        sourceCounterpartyEntityId: route.source.counterpartyEntityId,
        observedAt: blockNumber,
      },
    }],
  });
  addMessage(state, `🌉 Cross-j pull args observed for ${route.orderId}; target salvage queued`);
  return true;
}

export function queueCrossJurisdictionSourceDisputeFromTargetDispute(
  env: Env,
  state: EntityState,
  outputs: EntityInput[],
  counterpartyId: string,
  initialArgumentsRaw: unknown,
): boolean {
  if (decodeDisputeCrossPullBinaries(initialArgumentsRaw).length > 0) return false;
  const route = findCrossJurisdictionRouteForTargetDispute(state, counterpartyId);
  if (!route) return false;

  const sourceUserState = findEntityStateById(env, route.source.entityId);
  const sourceAccount = sourceUserState
    ? findAccountByCounterparty(sourceUserState, route.source.counterpartyEntityId)
    : null;
  if (!sourceUserState || !sourceAccount) {
    jEventHtlcLog.warn('crossj.source_account_unavailable', { route: shortOrder(route.orderId), source: shortId(route.source.entityId), counterparty: shortId(route.source.counterpartyEntityId) });
    return false;
  }
  if ((sourceAccount.status ?? 'active') === 'disputed' || sourceAccount.activeDispute) return false;
  if (hasQueuedDisputeStart(sourceUserState, route.source.counterpartyEntityId)) return false;

  outputs.push({
    entityId: route.source.entityId,
    entityTxs: [
      {
        type: 'disputeStart',
        data: {
          counterpartyEntityId: route.source.counterpartyEntityId,
          description: `Cross-j target dispute ${route.orderId} forces source pull reveal`,
        },
      },
      { type: 'j_broadcast', data: {} },
    ],
  });
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
    outputs.push({
      entityId: relay.targetEntityId,
      entityTxs: [{
        type: 'resolveHtlcLock',
        data: {
          counterpartyEntityId: relay.targetCounterpartyEntityId,
          lockId: relay.targetLockId,
          secret,
          description: `Cross-j ${relay.routeId} target claim ${relay.fillRatio}/65535`,
        },
      }],
    });
  }

  addMessage(newState, `🔓 HTLC reveal observed: ${hashlock.slice(0, 10)}... | Block ${blockNumber}`);
  return true;
}
