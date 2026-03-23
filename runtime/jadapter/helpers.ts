/**
 * JAdapter Helpers
 * Shared utilities for all JAdapter modes (browservm, rpc, anvil)
 * @license AGPL-3.0
 */

import { ethers } from 'ethers';
import type { Depository, EntityProvider } from '../../jurisdictions/typechain-types/index.ts';
import type { JEvent, JEventCallback } from './types';
import type { Env } from '../types';
import { createEmptyBatch, type JBatch } from '../j-batch';

// ═══════════════════════════════════════════════════════════════════════════
// CANONICAL J-EVENTS (Single Source of Truth — must match Depository.sol)
// ═══════════════════════════════════════════════════════════════════════════
export const CANONICAL_J_EVENTS = [
  'ReserveUpdated', 'SecretRevealed', 'AccountSettled',
  'DisputeStarted', 'DisputeFinalized', 'DebtCreated', 'DebtEnforced', 'HankoBatchProcessed',
] as const;
export type CanonicalJEvent = (typeof CANONICAL_J_EVENTS)[number];
const CANONICAL_J_EVENT_SET = new Set<string>(CANONICAL_J_EVENTS);

// TEST-ONLY fallback signer (Hardhat account #0, publicly known key)
export const DEFAULT_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export function computeAccountKey(entity1: string, entity2: string): string {
  const [left, right] = entity1.toLowerCase() < entity2.toLowerCase()
    ? [entity1, entity2]
    : [entity2, entity1];
  return ethers.solidityPacked(['bytes32', 'bytes32'], [left, right]);
}

export function entityIdToAddress(entityId: string): string {
  const normalized = entityId.toLowerCase().replace('0x', '').padStart(64, '0');
  return ethers.getAddress('0x' + normalized.slice(-40));
}

const buildParsedLogArgs = (parsed: any): Record<string, unknown> => Object.fromEntries(
  parsed.fragment.inputs.map((input: { name: string }, index: number) => [input.name, parsed.args[index]]),
);

export const toJEvent = (name: string, args: Record<string, unknown> | undefined, meta?: { blockNumber?: number; blockHash?: string; transactionHash?: string }): JEvent => ({
  name,
  args: args ?? {},
  blockNumber: meta?.blockNumber ?? 0,
  blockHash: meta?.blockHash ?? '0x',
  transactionHash: meta?.transactionHash ?? '0x',
});

export const normalizeAdapterEvents = (events: Array<{
  name: string; args?: Record<string, unknown>; blockNumber?: number; blockHash?: string; transactionHash?: string;
}>, fallbackMeta?: { blockNumber?: number; blockHash?: string; transactionHash?: string }): JEvent[] =>
  events.map((event) =>
    toJEvent(event.name, event.args, {
      blockNumber: event.blockNumber ?? fallbackMeta?.blockNumber,
      blockHash: event.blockHash ?? fallbackMeta?.blockHash,
      transactionHash: event.transactionHash ?? fallbackMeta?.transactionHash,
    }),
  );

export const parseReceiptLogsToJEvents = (receipt: {
  logs: Array<{ topics: readonly string[]; data: string }>; blockNumber: number; blockHash: string; hash: string;
}, carriers: Array<{ interface: ethers.Interface }>): JEvent[] => {
  const events: JEvent[] = [];
  for (const log of receipt.logs) {
    for (const carrier of carriers) {
      try {
        const parsed = carrier.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed) continue;
        events.push(
          toJEvent(parsed.name, buildParsedLogArgs(parsed), {
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash,
            transactionHash: receipt.hash,
          }),
        );
        break;
      } catch {
        // Ignore logs belonging to another contract interface.
      }
    }
  }
  return events;
};

export const buildExternalTokenToReserveBatch = (params: {
  entityId: string; tokenAddress: string; amount: bigint; tokenType?: number; externalTokenId?: bigint; internalTokenId?: number;
}): JBatch => {
  const batch = createEmptyBatch();
  batch.externalTokenToReserve.push({
    entity: params.entityId,
    contractAddress: params.tokenAddress,
    externalTokenId: params.externalTokenId ?? 0n,
    tokenType: params.tokenType ?? 0,
    internalTokenId: params.internalTokenId ?? 0,
    amount: params.amount,
  });
  return batch;
};

export function setupContractEventListeners(
  depository: Depository,
  entityProvider: EntityProvider,
  eventCallbacks: Map<string, Set<JEventCallback>>,
  anyCallbacks: Set<JEventCallback>
) {
  type ContractEventLike = {
    args?: { entries(): Iterable<[string, unknown]> };
    blockNumber?: number;
    blockHash?: string;
    transactionHash?: string;
  };
  type ContractEventSource = {
    on(eventName: string, listener: (...args: unknown[]) => void): unknown;
  };
  const readEvent = (args: unknown[]): ContractEventLike | null => {
    const lastArg = args.at(-1);
    if (typeof lastArg !== 'object' || lastArg === null) return null;
    return lastArg as ContractEventLike;
  };
  const depositoryEvents = [...CANONICAL_J_EVENTS];

  for (const eventName of depositoryEvents) {
    (depository as unknown as ContractEventSource).on(eventName, (...args: unknown[]) => {
      const event = readEvent(args);
      const jEvent = toJEvent(
        eventName,
        event?.args ? Object.fromEntries(event.args.entries()) : {},
        {
          blockNumber: event?.blockNumber,
          blockHash: event?.blockHash,
          transactionHash: event?.transactionHash,
        },
      );

      eventCallbacks.get(eventName)?.forEach(cb => cb(jEvent));
      anyCallbacks.forEach(cb => cb(jEvent));
    });
  }

  const entityProviderEvents = [
    'EntityRegistered',
    'NameAssigned',
    'NameTransferred',
    'GovernanceEnabled',
  ];

  for (const eventName of entityProviderEvents) {
    (entityProvider as unknown as ContractEventSource).on(eventName, (...args: unknown[]) => {
      const event = readEvent(args);
      const jEvent = toJEvent(
        eventName,
        event?.args ? Object.fromEntries(event.args.entries()) : {},
        {
          blockNumber: event?.blockNumber,
          blockHash: event?.blockHash,
          transactionHash: event?.transactionHash,
        },
      );

      eventCallbacks.get(eventName)?.forEach(cb => cb(jEvent));
      anyCallbacks.forEach(cb => cb(jEvent));
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED EVENT CONVERSION — used by ALL JAdapter modes (browservm + rpc)
// Raw events (name + args) → j_event format { type, data } for j-events.ts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Raw event format — common denominator for both BrowserVM and ethers RPC events.
 * BrowserVM emits these directly. RPC adapter normalizes ethers EventLog to this.
 * args supports both named keys and positional indexes.
 */
export type RawJEventArgs = Record<string, unknown> & {
  [index: number]: unknown;
};

export interface RawJEvent {
  name: string;
  args: RawJEventArgs;
  blockNumber?: number;
  blockHash?: string;
  transactionHash?: string;
  logIndex?: number;
}

export type EventBatchCounter = {
  value: number;
  _seenLogs?: {
    set: Set<string>;
    order: string[];
  };
};

const normalizeLowerId = (value: unknown): string => String(value ?? '').toLowerCase();

export function getSelfSignerFinalizedJHeight(env: Env): number {
  const runtimeId = normalizeLowerId(env?.runtimeId);
  if (!runtimeId || !env?.eReplicas) return 0;

  let found = false;
  let minFinalizedHeight = Number.POSITIVE_INFINITY;
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const signerId = normalizeLowerId(replica?.signerId ?? String(replicaKey).split(':')[1] ?? '');
    if (!signerId || signerId !== runtimeId) continue;
    const finalizedHeight = Number(replica?.state?.lastFinalizedJHeight ?? 0);
    if (!Number.isFinite(finalizedHeight)) continue;
    found = true;
    minFinalizedHeight = Math.min(minFinalizedHeight, Math.max(0, Math.floor(finalizedHeight)));
  }

  if (!found || !Number.isFinite(minFinalizedHeight)) return 0;
  return minFinalizedHeight;
}

export function getWatcherStartBlock(env: Env): number {
  return Math.max(1, getSelfSignerFinalizedJHeight(env) + 1);
}

/**
 * Check if a raw event is a canonical j-event.
 */
export function isCanonicalEvent(event: RawJEvent): boolean {
  return CANONICAL_J_EVENT_SET.has(event.name);
}

/**
 * Check if a raw event is relevant to a specific entity.
 * Shared between all adapter modes — same logic regardless of source.
 */
export function isEventRelevantToEntity(event: RawJEvent, entityId: string): boolean {
  const normalize = (id: unknown): string => String(id).toLowerCase();
  const normalizedEntity = normalize(entityId);
  const args = event.args;

  switch (event.name) {
    case 'ReserveUpdated':
      return normalize(args.entity) === normalizedEntity;

    case 'SecretRevealed':
      return true; // Global: any entity with matching hashlock should observe

    case 'AccountSettled': {
      const settled = args.settled ?? args[''] ?? args[0] ?? [];
      for (const s of settled) {
        const left = normalize(s[0] ?? s.left);
        const right = normalize(s[1] ?? s.right);
        if (left === normalizedEntity || right === normalizedEntity) return true;
      }
      return false;
    }

    case 'DisputeStarted':
      return normalize(args.sender) === normalizedEntity || normalize(args.counterentity) === normalizedEntity;

    case 'DisputeFinalized':
      return normalize(args.sender) === normalizedEntity || normalize(args.counterentity) === normalizedEntity;

    case 'DebtCreated':
      return normalize(args.debtor) === normalizedEntity || normalize(args.creditor) === normalizedEntity;

    case 'DebtEnforced':
      return normalize(args.debtor) === normalizedEntity || normalize(args.creditor) === normalizedEntity;

    case 'HankoBatchProcessed':
      return normalize(args.entityId) === normalizedEntity;

    default:
      return false;
  }
}

/**
 * Convert a raw event to j_event format(s) for j-events.ts handler.
 * Returns ARRAY because AccountSettled can contain multiple settlements for same entity.
 * Output format: { type: 'PascalCase', data: { ... } } — matches j-events.ts expectations.
 */
export function rawEventToJEvents(event: RawJEvent, entityId: string): Array<{ type: string; data: Record<string, unknown> }> {
  const args = event.args;

  switch (event.name) {
    case 'ReserveUpdated':
      return [{
        type: 'ReserveUpdated',
        data: {
          entity: args.entity,
          tokenId: Number(args.tokenId),
          newBalance: (args.newBalance ?? 0).toString(),
        },
      }];

    case 'AccountSettled': {
      // AccountSettlement[] = { left, right, tokens: TokenSettlement[], nonce }
      // TokenSettlement = { tokenId, leftReserve, rightReserve, collateral, ondelta }
      const settled = args.settled ?? args[''] ?? args[0] ?? [];
      const results: Array<{ type: string; data: Record<string, any> }> = [];
      for (const s of settled) {
        const left = s[0] ?? s.left;
        const right = s[1] ?? s.right;
        if (String(left).toLowerCase() === entityId.toLowerCase() ||
            String(right).toLowerCase() === entityId.toLowerCase()) {
          const tokens = s[2] ?? s.tokens ?? [];
          const nonce = Number(s[3] ?? s.nonce ?? 0);

          // Emit one j-event per token in the settlement
          for (const tok of tokens) {
            const tokenId = Number(tok[0] ?? tok.tokenId ?? 0);
            const leftReserve = (tok[1] ?? tok.leftReserve ?? 0n).toString();
            const rightReserve = (tok[2] ?? tok.rightReserve ?? 0n).toString();
            const collateral = (tok[3] ?? tok.collateral ?? 0n).toString();
            const ondelta = (tok[4] ?? tok.ondelta ?? 0n).toString();
            results.push({
              type: 'AccountSettled',
              data: {
                leftEntity: left,
                rightEntity: right,
                tokenId,
                leftReserve,
                rightReserve,
                collateral,
                ondelta,
                nonce,
              },
            });
          }
        }
      }
      return results;
    }

    case 'SecretRevealed':
      return [{
        type: 'SecretRevealed',
        data: {
          hashlock: args.hashlock,
          revealer: args.revealer,
          secret: args.secret,
        },
      }];

    case 'DisputeStarted':
      return [{
        type: 'DisputeStarted',
        data: {
          sender: args.sender,
          counterentity: args.counterentity,
          nonce: args.nonce,
          proofbodyHash: args.proofbodyHash,
          initialArguments: args.initialArguments ?? '0x',
        },
      }];

    case 'DisputeFinalized':
      return [{
        type: 'DisputeFinalized',
        data: {
          sender: args.sender,
          counterentity: args.counterentity,
          initialNonce: args.initialNonce,
          initialProofbodyHash: args.initialProofbodyHash,
          finalProofbodyHash: args.finalProofbodyHash,
        },
      }];

    case 'DebtCreated':
      return [{
        type: 'DebtCreated',
        data: {
          debtor: args.debtor,
          creditor: args.creditor,
          tokenId: Number(args.tokenId),
          amount: (args.amount ?? 0).toString(),
          debtIndex: Number(args.debtIndex ?? 0),
        },
      }];

    case 'DebtEnforced':
      return [{
        type: 'DebtEnforced',
        data: {
          debtor: args.debtor,
          creditor: args.creditor,
          tokenId: Number(args.tokenId),
          amountPaid: (args.amountPaid ?? 0).toString(),
          remainingAmount: (args.remainingAmount ?? 0).toString(),
          newDebtIndex: Number(args.newDebtIndex ?? 0),
        },
      }];

    case 'HankoBatchProcessed':
      return [{
        type: 'HankoBatchProcessed',
        data: {
          entityId: args.entityId,
          hankoHash: args.hankoHash,
          nonce: Number(args.nonce),
          success: Boolean(args.success),
        },
      }];

    default:
      return [];
  }
}

/**
 * Process a batch of raw events → group by entity → enqueue as j_event EntityTxs.
 * Shared logic used by both BrowserVM and RPC adapter startWatching().
 */
export function processEventBatch(
  rawEvents: RawJEvent[],
  env: Env,
  blockNumber: number,
  blockHash: string,
  txCounter: EventBatchCounter,
  adapterLabel: string,
): void {
  // Filter to canonical events only
  const canonical = rawEvents.filter(isCanonicalEvent);
  if (canonical.length === 0) return;

  // De-duplicate watcher re-scans using canonical log identity.
  const dedup = (() => {
    if (!txCounter._seenLogs) {
      txCounter._seenLogs = {
        set: new Set<string>(),
        order: [] as string[],
      };
    }
    return txCounter._seenLogs;
  })();
  const MAX_DEDUP_LOGS = 50_000;
  const deduped: RawJEvent[] = [];
  for (let idx = 0; idx < canonical.length; idx++) {
    const event = canonical[idx]!;
    const txHash = event.transactionHash || '';
    const key = txHash && event.logIndex !== undefined
      ? `${txHash.toLowerCase()}:${event.logIndex}`
      : `${event.blockHash ?? blockHash}:${event.name}:${idx}`;
    if (dedup.set.has(key)) continue;
    dedup.set.add(key);
    dedup.order.push(key);
    deduped.push(event);
  }
  while (dedup.order.length > MAX_DEDUP_LOGS) {
    const oldest = dedup.order.shift();
    if (oldest) dedup.set.delete(oldest);
  }
  if (deduped.length === 0) return;

  // Keep runtime console readable: disable noisy per-block watcher logs unless explicitly enabled.
  const shouldLogBatch = !!env?.debugJWatcherBatches;
  if (shouldLogBatch) {
    console.log(`📡 [JAdapter:${adapterLabel}] ${deduped.length} canonical events from block ${blockNumber}`);
  }

  // Group events by relevant entity
  const eventsByEntity = new Map<string, { signerId: string; events: RawJEvent[] }>();

  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    if (!replica.isProposer) continue;
    const [entityId, sid] = replicaKey.split(':');
    if (!entityId || !sid) continue;

    const relevant = deduped.filter(e => isEventRelevantToEntity(e, entityId));
    if (relevant.length === 0) continue;

    if (!eventsByEntity.has(entityId)) {
      eventsByEntity.set(entityId, { signerId: sid, events: [] });
    }
    for (const e of relevant) {
      eventsByEntity.get(entityId)!.events.push(e);
    }
  }

  // Convert and enqueue
  for (const [entityId, { signerId, events }] of eventsByEntity) {
    const jEvents = events.flatMap(e => rawEventToJEvents(e, entityId));
    if (jEvents.length === 0) continue;
    const settledCount = jEvents.filter(e => e.type === 'AccountSettled').length;
    if (settledCount > 0) {
      console.log(
        `[REB][4][J_EVENT_DELIVER] entity=${entityId.slice(-8)} signer=${signerId.slice(-8)} block=${blockNumber} accountSettled=${settledCount}`,
      );
      const p2p = env?.runtimeState?.p2p;
      if (p2p && typeof p2p.sendDebugEvent === 'function') {
        p2p.sendDebugEvent({
          level: 'info',
          code: 'REB_STEP',
          step: 4,
          status: 'ok',
          event: 'j_event_delivered',
          entityId,
          signerId,
          blockNumber,
          accountSettled: settledCount,
        });
      }
    }

    const entityTx = {
      type: 'j_event' as const,
      data: {
        from: signerId,
        observedAt: env.timestamp ?? 0,
        blockNumber,
        blockHash,
        transactionHash: events[0]?.transactionHash ?? `${adapterLabel}-${blockNumber}-${txCounter.value++}`,
        events: jEvents,
        event: jEvents[0],
      },
    };

    if (shouldLogBatch) {
      console.log(`   📮 [JAdapter:${adapterLabel}] → ${entityId.slice(-4)} (${jEvents.length} events)`);
    }
    const mempool = env.runtimeMempool ?? env.runtimeInput;
    if (!mempool.entityInputs) mempool.entityInputs = [];
    mempool.entityInputs.push({ entityId, signerId, entityTxs: [entityTx] });
  }
}
