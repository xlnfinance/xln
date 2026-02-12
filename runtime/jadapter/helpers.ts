/**
 * JAdapter Helpers
 * Shared utilities for all JAdapter modes (browservm, rpc, anvil)
 * @license AGPL-3.0
 */

import { ethers } from 'ethers';
import type { Depository, EntityProvider } from '../../jurisdictions/typechain-types';
import type { JEvent, JEventCallback } from './types';

// ═══════════════════════════════════════════════════════════════════════════
// CANONICAL J-EVENTS (Single Source of Truth — must match Depository.sol)
// ═══════════════════════════════════════════════════════════════════════════
export const CANONICAL_J_EVENTS = [
  'ReserveUpdated', 'SecretRevealed', 'AccountSettled',
  'DisputeStarted', 'DisputeFinalized', 'DebtCreated', 'HankoBatchProcessed',
] as const;
export type CanonicalJEvent = (typeof CANONICAL_J_EVENTS)[number];

// Hardhat account #0 (publicly known test key)
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

export function setupContractEventListeners(
  depository: Depository,
  entityProvider: EntityProvider,
  eventCallbacks: Map<string, Set<JEventCallback>>,
  anyCallbacks: Set<JEventCallback>
) {
  const depositoryEvents = [
    'ReserveUpdated',
    'SecretRevealed',
    'DisputeStarted',
    'DisputeFinalized',
    'DebtCreated',
    'DebtEnforced',
    'CooperativeClose',
  ];

  for (const eventName of depositoryEvents) {
    // Use any cast to bypass strict typechain event typing
    (depository as any).on(eventName, (...args: any[]) => {
      const event = args[args.length - 1];
      const jEvent: JEvent = {
        name: eventName,
        args: event.args ? Object.fromEntries(event.args.entries()) : {},
        blockNumber: event.blockNumber ?? 0,
        blockHash: event.blockHash ?? '0x',
        transactionHash: event.transactionHash ?? '0x',
      };

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
    // Use any cast to bypass strict typechain event typing
    (entityProvider as any).on(eventName, (...args: any[]) => {
      const event = args[args.length - 1];
      const jEvent: JEvent = {
        name: eventName,
        args: event.args ? Object.fromEntries(event.args.entries()) : {},
        blockNumber: event.blockNumber ?? 0,
        blockHash: event.blockHash ?? '0x',
        transactionHash: event.transactionHash ?? '0x',
      };

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
 * args uses any to avoid TS index signature access issues with Record<string, any>.
 */
export interface RawJEvent {
  name: string;
  args: any;
  blockNumber?: number;
  blockHash?: string;
  transactionHash?: string;
}

/**
 * Check if a raw event is a canonical j-event.
 */
export function isCanonicalEvent(event: RawJEvent): boolean {
  return CANONICAL_J_EVENTS.includes(event.name as CanonicalJEvent);
}

/**
 * Check if a raw event is relevant to a specific entity.
 * Shared between all adapter modes — same logic regardless of source.
 */
export function isEventRelevantToEntity(event: RawJEvent, entityId: string): boolean {
  const normalize = (id: any): string => String(id).toLowerCase();
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
export function rawEventToJEvents(event: RawJEvent, entityId: string): Array<{ type: string; data: Record<string, any> }> {
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
      const settled = args.settled ?? args[''] ?? args[0] ?? [];
      const results: Array<{ type: string; data: Record<string, any> }> = [];
      for (const s of settled) {
        const left = s[0] ?? s.left;
        const right = s[1] ?? s.right;
        if (String(left).toLowerCase() === entityId.toLowerCase() ||
            String(right).toLowerCase() === entityId.toLowerCase()) {
          const tokenId = Number(s[2] ?? s.tokenId ?? 0);
          const leftReserve = (s[3] ?? s.leftReserve ?? 0n).toString();
          const rightReserve = (s[4] ?? s.rightReserve ?? 0n).toString();
          const collateral = (s[5] ?? s.collateral ?? 0n).toString();
          const ondelta = (s[6] ?? s.ondelta ?? 0n).toString();
          const isLeft = String(left).toLowerCase() === entityId.toLowerCase();
          results.push({
            type: 'AccountSettled',
            data: {
              leftEntity: left,
              rightEntity: right,
              counterpartyEntityId: isLeft ? right : left,
              tokenId,
              ownReserve: isLeft ? leftReserve : rightReserve,
              counterpartyReserve: isLeft ? rightReserve : leftReserve,
              collateral,
              ondelta,
              side: isLeft ? 'left' : 'right',
            },
          });
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
          disputeNonce: args.disputeNonce,
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
          initialDisputeNonce: args.initialDisputeNonce,
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
  env: any,
  blockNumber: number,
  blockHash: string,
  txCounter: { value: number },
  adapterLabel: string,
): void {
  // Filter to canonical events only
  const canonical = rawEvents.filter(isCanonicalEvent);
  if (canonical.length === 0) return;

  // Keep runtime console readable: disable noisy per-block watcher logs unless explicitly enabled.
  const shouldLogBatch = !!env?.debugJWatcherBatches;
  if (shouldLogBatch) {
    console.log(`📡 [JAdapter:${adapterLabel}] ${canonical.length} canonical events from block ${blockNumber}`);
  }

  // Group events by relevant entity
  const eventsByEntity = new Map<string, { signerId: string; events: RawJEvent[] }>();

  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    if (!replica.isProposer) continue;
    const [entityId, sid] = replicaKey.split(':');
    if (!entityId || !sid) continue;

    const relevant = canonical.filter(e => isEventRelevantToEntity(e, entityId));
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

    const entityTx = {
      type: 'j_event' as const,
      data: {
        from: signerId,
        observedAt: env.timestamp ?? 0,
        blockNumber,
        blockHash,
        transactionHash: `${adapterLabel}-${blockNumber}-${txCounter.value++}`,
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
