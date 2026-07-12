/**
 * JAdapter Helpers
 * Shared utilities for all JAdapter modes (browservm, rpc, anvil)
 * @license AGPL-3.0
 */

import { ethers } from 'ethers';
import type { JEvent } from './types';
import type { DisputeFinalizationEvidence, EntityInput, Env, JReplica, JurisdictionConfig, JurisdictionEvent, RuntimeInput } from '../types';
import { createEmptyBatch, type JBatch } from '../jurisdiction/batch';
import { enqueueRuntimeInput } from '../runtime';
import { signAccountFrame } from '../account/crypto';
import { createStructuredLogger, shortId } from '../infra/logger';
import {
  buildJEventObservationDigest,
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
} from '../jurisdiction/event-observation';
import { rememberRecentJEvents } from '../jurisdiction/event-evidence';

// ═══════════════════════════════════════════════════════════════════════════
// CANONICAL J-EVENTS (Single Source of Truth — must match Depository.sol)
// ═══════════════════════════════════════════════════════════════════════════
export const CANONICAL_J_EVENTS = [
  'ReserveUpdated', 'SecretRevealed', 'AccountSettled',
  'ExternalWalletSnapshot', 'ExternalWalletDelta',
  'DisputeStarted', 'DisputeFinalized', 'DebtCreated', 'DebtEnforced', 'DebtForgiven', 'HankoBatchProcessed',
] as const;
export type CanonicalJEvent = (typeof CANONICAL_J_EVENTS)[number];
const CANONICAL_J_EVENT_SET = new Set<string>(CANONICAL_J_EVENTS);
const jadapterHelperLog = createStructuredLogger('jadapter.helpers');

// TEST-ONLY fallback signer (Hardhat account #0, publicly known key)
export const DEFAULT_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export function computeAccountKey(entity1: string, entity2: string): string {
  const [left, right] = entity1.toLowerCase() < entity2.toLowerCase()
    ? [entity1, entity2]
    : [entity2, entity1];
  return ethers.solidityPacked(['bytes32', 'bytes32'], [left, right]);
}

export function packTokenReference(
  tokenType: number,
  contractAddress: string,
  externalTokenId: ethers.BigNumberish,
): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint8', 'address', 'uint96'],
    [tokenType, contractAddress, externalTokenId],
  ));
}

export function entityIdToAddress(entityId: string): string {
  const normalized = entityId.toLowerCase().replace('0x', '').padStart(64, '0');
  return ethers.getAddress('0x' + normalized.slice(-40));
}

const buildParsedLogArgs = (parsed: ethers.LogDescription): Record<string, unknown> => Object.fromEntries(
  parsed.fragment.inputs.map((input, index) => [input.name || String(index), parsed.args[index]]),
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
  events.map((event) => {
    const meta: { blockNumber?: number; blockHash?: string; transactionHash?: string } = {};
    const blockNumber = event.blockNumber ?? fallbackMeta?.blockNumber;
    const blockHash = event.blockHash ?? fallbackMeta?.blockHash;
    const transactionHash = event.transactionHash ?? fallbackMeta?.transactionHash;
    if (blockNumber !== undefined) meta.blockNumber = blockNumber;
    if (blockHash !== undefined) meta.blockHash = blockHash;
    if (transactionHash !== undefined) meta.transactionHash = transactionHash;
    return toJEvent(event.name, event.args, meta);
  });

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
  disputeFinalizationEvidence?: DisputeFinalizationEvidence;
}

export type EventBatchCounter = {
  value: number;
  _seenLogs?: {
    set: Set<string>;
    order: string[];
  };
};

export type PendingWatcherJBlockMap = Map<number, Set<string>>;

const normalizeJurisdictionLabel = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

const normalizeJurisdictionAddress = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

const findWatcherJurisdictionReplica = (env: Env, depositoryAddress?: string) => {
  const replicas = Array.from(env?.jReplicas?.values?.() || []);
  if (replicas.length === 0) return null;

  const normalizedDepository = String(depositoryAddress ?? '').trim().toLowerCase();
  if (normalizedDepository) {
    const matched = replicas.find((replica) => {
      const candidate = String(
        replica?.depositoryAddress || replica?.contracts?.depository || '',
      ).trim().toLowerCase();
      return candidate === normalizedDepository;
    });
    if (matched) return matched;
  }

  if (env.activeJurisdiction) {
    const active = env.jReplicas?.get(env.activeJurisdiction);
    if (active) return active;
  }

  return replicas[0] || null;
};

const watcherDepositoryOf = (replica: JReplica | null | undefined): string =>
  normalizeJurisdictionAddress(replica?.depositoryAddress || replica?.contracts?.depository || '');

const watcherNameOf = (replica: JReplica | null | undefined): string =>
  normalizeJurisdictionLabel(replica?.name);

const watcherChainIdOf = (replica: JReplica | null | undefined): number | null => {
  const chainId = Number(replica?.chainId);
  return Number.isFinite(chainId) && chainId > 0 ? Math.floor(chainId) : null;
};

const isEntityReplicaRelevantToWatcher = (
  env: Env,
  replica: { state?: { config?: { jurisdiction?: JurisdictionConfig } } },
  watcherReplica: JReplica,
): boolean => {
  const jurisdiction = replica?.state?.config?.jurisdiction;
  if (!jurisdiction) {
    return (env.jReplicas?.size ?? 0) <= 1;
  }
  const watcherDepository = watcherDepositoryOf(watcherReplica);
  const entityDepository = normalizeJurisdictionAddress(jurisdiction.depositoryAddress);
  if (watcherDepository && entityDepository) return watcherDepository === entityDepository;
  const watcherName = watcherNameOf(watcherReplica);
  const entityName = normalizeJurisdictionLabel(jurisdiction.name);
  const watcherChainId = watcherChainIdOf(watcherReplica);
  const entityChainId = Number(jurisdiction.chainId);
  const chainMatches = !watcherChainId || !Number.isFinite(entityChainId) || watcherChainId === Math.floor(entityChainId);
  return Boolean(watcherName && entityName && watcherName === entityName && chainMatches);
};

export function getWatcherStartBlock(env: Env, depositoryAddress?: string): number {
  const replica = findWatcherJurisdictionReplica(env, depositoryAddress);
  const replicaBlockNumber = Number(replica?.blockNumber ?? 0n);
  const signerBlockNumber = replica ? getMinimumCommittedSignerJHeight(env, replica) : getMinimumCommittedSignerJHeight(env);
  const blockNumber = signerBlockNumber === null
    ? replicaBlockNumber
    : Math.min(replicaBlockNumber, signerBlockNumber);
  if (!Number.isFinite(blockNumber) || blockNumber < 0) return 1;
  return Math.max(1, Math.floor(blockNumber) + 1);
}

export function getMinimumCommittedSignerJHeight(env: Env, watcherReplica?: JReplica): number | null {
  let minHeight: number | null = null;
  for (const replica of env.eReplicas?.values?.() || []) {
    if (watcherReplica && !isEntityReplicaRelevantToWatcher(env, replica, watcherReplica)) continue;
    const height = Number(replica?.state?.lastFinalizedJHeight ?? 0);
    if (!Number.isFinite(height) || height <= 0) continue;
    minHeight = minHeight === null ? Math.floor(height) : Math.min(minHeight, Math.floor(height));
  }
  return minHeight;
}

export function updateWatcherJurisdictionCursor(
  env: Env,
  blockNumber: number,
  depositoryAddress?: string,
): void {
  const replica = findWatcherJurisdictionReplica(env, depositoryAddress);
  if (!replica) return;
  if (!Number.isFinite(blockNumber) || blockNumber < 0) return;
  replica.blockNumber = BigInt(Math.floor(blockNumber));
}

const assertJEventIngressOpen = (env: Env, label: string): void => {
  if (env.runtimeState?.persistenceQuiescing && !env.scenarioMode) {
    env.error?.('jurisdiction', 'J_EVENT_INGRESS_QUIESCING', { label });
    throw new Error(`J_EVENT_INGRESS_QUIESCING:${label}`);
  }
};

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
      return normalize(args['entity']) === normalizedEntity;

    case 'ExternalWalletSnapshot':
      return normalize(args['entityId']) === normalizedEntity;

    case 'ExternalWalletDelta':
      return normalize(args['entityId']) === normalizedEntity;

    case 'SecretRevealed':
      return true; // Global: all entities with matching hashlock should observe

    case 'AccountSettled': {
      const settledRaw = args['settled'] ?? args[''] ?? args[0] ?? [];
      const settled = Array.isArray(settledRaw) ? settledRaw : [];
      for (const rawSettlement of settled) {
        const s = rawSettlement as Record<string, unknown> & unknown[];
        const left = normalize(s[0] ?? s['left']);
        const right = normalize(s[1] ?? s['right']);
        if (left === normalizedEntity || right === normalizedEntity) return true;
      }
      return false;
    }

    case 'DisputeStarted':
      return normalize(args['sender']) === normalizedEntity || normalize(args['counterentity']) === normalizedEntity;

    case 'DisputeFinalized':
      return normalize(args['sender']) === normalizedEntity || normalize(args['counterentity']) === normalizedEntity;

    case 'DebtCreated':
      return normalize(args['debtor']) === normalizedEntity || normalize(args['creditor']) === normalizedEntity;

    case 'DebtEnforced':
      return normalize(args['debtor']) === normalizedEntity || normalize(args['creditor']) === normalizedEntity;

    case 'DebtForgiven':
      return normalize(args['debtor']) === normalizedEntity || normalize(args['creditor']) === normalizedEntity;

    case 'HankoBatchProcessed':
      return normalize(args['entityId']) === normalizedEntity;

    default:
      return false;
  }
}

export function collectRelevantJEventReplicaKeys(env: Env, rawEvents: RawJEvent[]): string[] {
  const canonical = rawEvents.filter(isCanonicalEvent);
  if (canonical.length === 0) return [];

  const replicaKeys = new Set<string>();
  for (const [replicaKey, replica] of env.eReplicas?.entries?.() || []) {
    const [entityIdFromKey] = replicaKey.split(':');
    const entityId = String(replica?.state?.entityId || replica?.entityId || entityIdFromKey || '').toLowerCase();
    if (!entityId) continue;
    if (canonical.some((event) => isEventRelevantToEntity(event, entityId))) {
      replicaKeys.add(replicaKey);
    }
  }

  return [...replicaKeys].sort();
}

export function areJEventReplicaKeysFinalizedThrough(env: Env, replicaKeys: Iterable<string>, blockNumber: number): boolean {
  const targetBlock = Math.floor(Number(blockNumber));
  if (!Number.isFinite(targetBlock) || targetBlock < 0) return false;

  for (const replicaKey of replicaKeys) {
    const replica = env.eReplicas?.get(replicaKey);
    if (!replica) return false;
    const finalizedHeight = Number(replica.state?.lastFinalizedJHeight ?? 0);
    if (!Number.isFinite(finalizedHeight) || finalizedHeight < targetBlock) return false;
  }

  return true;
}

export function rememberPendingWatcherJBlock(
  pending: PendingWatcherJBlockMap,
  blockNumber: number,
  replicaKeys: Iterable<string>,
): void {
  const block = Math.floor(Number(blockNumber));
  if (!Number.isFinite(block) || block < 0) return;
  let entry: Set<string> | null = null;
  for (const replicaKey of replicaKeys) {
    if (!replicaKey) continue;
    if (!entry) {
      entry = pending.get(block) ?? new Set<string>();
      pending.set(block, entry);
    }
    entry.add(replicaKey);
  }
}

export function resolveCommittedWatcherCursor(
  env: Env,
  pending: PendingWatcherJBlockMap,
  candidateCursor: number,
  currentCursor: number,
): number {
  const candidate = Math.max(0, Math.floor(Number(candidateCursor)));
  let resolved = Math.max(0, Math.floor(Number(currentCursor)));
  if (!Number.isFinite(candidate) || !Number.isFinite(resolved)) return 0;
  if (candidate <= resolved) return resolved;

  const pendingBlocks = [...pending.keys()].sort((left, right) => left - right);
  for (const block of pendingBlocks) {
    if (block <= resolved) {
      pending.delete(block);
      continue;
    }
    if (block > candidate) break;

    const replicaKeys = pending.get(block);
    if (!replicaKeys || replicaKeys.size === 0) {
      pending.delete(block);
      continue;
    }

    if (!areJEventReplicaKeysFinalizedThrough(env, replicaKeys, block)) {
      return Math.max(resolved, block - 1);
    }

    pending.delete(block);
    resolved = block;
  }

  return Math.max(resolved, candidate);
}

/**
 * Convert a raw event to j_event format(s) for j-events.ts handler.
 * Returns ARRAY because AccountSettled can contain multiple settlements for same entity.
 * Output format: { type: 'PascalCase', data: { ... } } — matches j-events.ts expectations.
 */
export function rawEventToJEvents(event: RawJEvent, entityId: string): JurisdictionEvent[] {
  const args = event.args;

  switch (event.name) {
    case 'ReserveUpdated':
      return [{
        type: 'ReserveUpdated',
        data: {
          entity: String(args['entity'] ?? ''),
          tokenId: Number(args['tokenId']),
          newBalance: (args['newBalance'] ?? 0).toString(),
        },
      }];

    case 'ExternalWalletSnapshot': {
      const tokenBalances = Array.isArray(args['tokenBalances'])
        ? args['tokenBalances'].map((entry) => {
            const record = entry as Record<string, unknown>;
            const tokenId = record['tokenId'];
            if (record['balance'] === undefined) {
              throw new Error('EXTERNAL_WALLET_SNAPSHOT_BALANCE_MISSING');
            }
            return {
              tokenAddress: String(record['tokenAddress'] ?? ''),
              ...(tokenId !== undefined ? { tokenId: Number(tokenId) } : {}),
              balance: String(record['balance']),
            };
          })
        : [];
      const allowances = Array.isArray(args['allowances'])
        ? args['allowances'].map((entry) => {
            const record = entry as Record<string, unknown>;
            if (record['allowance'] === undefined) {
              throw new Error('EXTERNAL_WALLET_SNAPSHOT_ALLOWANCE_MISSING');
            }
            return {
              tokenAddress: String(record['tokenAddress'] ?? ''),
              spender: String(record['spender'] ?? ''),
              allowance: String(record['allowance']),
            };
          })
        : [];
      return [{
        type: 'ExternalWalletSnapshot',
        data: {
          entityId: String(args['entityId'] ?? ''),
          owner: String(args['owner'] ?? ''),
          ...(args['nativeBalance'] !== undefined ? { nativeBalance: String(args['nativeBalance']) } : {}),
          ...(tokenBalances.length > 0 ? { tokenBalances } : {}),
          ...(allowances.length > 0 ? { allowances } : {}),
        },
      }];
    }

    case 'ExternalWalletDelta':
      return [{
        type: 'ExternalWalletDelta',
        data: {
          entityId: String(args['entityId'] ?? ''),
          owner: String(args['owner'] ?? ''),
          tokenAddress: String(args['tokenAddress'] ?? ''),
          ...(args['tokenId'] !== undefined ? { tokenId: Number(args['tokenId']) } : {}),
          ...(args['balanceDelta'] !== undefined ? { balanceDelta: String(args['balanceDelta']) } : {}),
          ...(args['spender'] !== undefined ? { spender: String(args['spender']) } : {}),
          ...(args['allowance'] !== undefined ? { allowance: String(args['allowance']) } : {}),
        },
      }];

    case 'AccountSettled': {
      // AccountSettlement[] = { left, right, tokens: TokenSettlement[], nonce }
      // TokenSettlement = { tokenId, leftReserve, rightReserve, collateral, ondelta }
      const settledRaw = args['settled'] ?? args[''] ?? args[0] ?? [];
      const settled = Array.isArray(settledRaw) ? settledRaw : [];
      const results: JurisdictionEvent[] = [];
      for (const rawSettlement of settled) {
        const s = rawSettlement as Record<string, unknown> & unknown[];
        const left = s[0] ?? s['left'];
        const right = s[1] ?? s['right'];
        if (String(left).toLowerCase() === entityId.toLowerCase() ||
            String(right).toLowerCase() === entityId.toLowerCase()) {
          const tokensRaw = s[2] ?? s['tokens'] ?? [];
          const tokens = Array.isArray(tokensRaw) ? tokensRaw : [];
          const nonce = Number(s[3] ?? s['nonce'] ?? 0);

          // Emit one j-event per token in the settlement
          for (const rawToken of tokens) {
            const tok = rawToken as Record<string, unknown> & unknown[];
            const tokenId = Number(tok[0] ?? tok['tokenId'] ?? 0);
            const leftReserve = (tok[1] ?? tok['leftReserve'] ?? 0n).toString();
            const rightReserve = (tok[2] ?? tok['rightReserve'] ?? 0n).toString();
            const collateral = (tok[3] ?? tok['collateral'] ?? 0n).toString();
            const ondelta = (tok[4] ?? tok['ondelta'] ?? 0n).toString();
            results.push({
              type: 'AccountSettled',
              data: {
                leftEntity: String(left),
                rightEntity: String(right),
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
          hashlock: String(args['hashlock'] ?? ''),
          revealer: String(args['revealer'] ?? ''),
          secret: String(args['secret'] ?? ''),
        },
      }];

    case 'DisputeStarted':
      return [{
        type: 'DisputeStarted',
        data: {
          sender: String(args['sender'] ?? ''),
          counterentity: String(args['counterentity'] ?? ''),
          nonce: String(args['nonce'] ?? ''),
          proofbodyHash: String(args['proofbodyHash'] ?? ''),
          watchSeed: String(args['watchSeed'] ?? '0x'),
          starterInitialArguments: String(args['starterInitialArguments'] ?? '0x'),
          starterIncrementedArguments: String(args['starterIncrementedArguments'] ?? '0x'),
          ...(args['batchNonce'] !== undefined ? { batchNonce: Number(args['batchNonce']) } : {}),
        },
      }];

    case 'DisputeFinalized':
      return [{
        type: 'DisputeFinalized',
        data: {
          sender: String(args['sender'] ?? ''),
          counterentity: String(args['counterentity'] ?? ''),
          initialNonce: String(args['initialNonce'] ?? ''),
          initialProofbodyHash: String(args['initialProofbodyHash'] ?? ''),
          finalProofbodyHash: String(args['finalProofbodyHash'] ?? ''),
          ...(args['batchNonce'] !== undefined ? { batchNonce: Number(args['batchNonce']) } : {}),
        },
      }];

    case 'DebtCreated':
      return [{
        type: 'DebtCreated',
        data: {
          debtor: String(args['debtor'] ?? ''),
          creditor: String(args['creditor'] ?? ''),
          tokenId: Number(args['tokenId']),
          amount: (args['amount'] ?? 0).toString(),
          debtIndex: Number(args['debtIndex'] ?? 0),
        },
      }];

    case 'DebtEnforced':
      return [{
        type: 'DebtEnforced',
        data: {
          debtor: String(args['debtor'] ?? ''),
          creditor: String(args['creditor'] ?? ''),
          tokenId: Number(args['tokenId']),
          amountPaid: (args['amountPaid'] ?? 0).toString(),
          remainingAmount: (args['remainingAmount'] ?? 0).toString(),
          newDebtIndex: Number(args['newDebtIndex'] ?? 0),
        },
      }];

    case 'DebtForgiven':
      return [{
        type: 'DebtForgiven',
        data: {
          debtor: String(args['debtor'] ?? ''),
          creditor: String(args['creditor'] ?? ''),
          tokenId: Number(args['tokenId']),
          amountForgiven: (args['amountForgiven'] ?? 0).toString(),
          debtIndex: Number(args['debtIndex'] ?? 0),
        },
      }];

    case 'HankoBatchProcessed':
      return [{
        type: 'HankoBatchProcessed',
        data: {
          entityId: String(args['entityId'] ?? ''),
          hankoHash: String(args['hankoHash'] ?? ''),
          nonce: Number(args['nonce']),
          success: Boolean(args['success']),
        },
      }];

    default:
      return [];
  }
}

/**
 * THE ONLY CANONICAL J-EVENT -> RUNTIME INGRESS HELPER.
 *
 * Do not duplicate fanout/grouping/enqueue logic in server/orchestrators/watchers.
 * All J watchers and all manual J-event injections must end up here so that:
 * 1. affected entities are selected by one relevance rule,
 * 2. every registered local replica for that entity receives the same event feed,
 * 3. enqueueing the event is also the wake-up mechanism for the runtime loop.
 *
 * If this logic ever needs to change, change it here once rather than forking
 * subtle variants across the codebase.
 */
export type JEventsRuntimeInputBuildResult = {
  input: RuntimeInput;
  evidenceEvents: RawJEvent[];
};

const resolveJEventObservedAt = (blockNumber: number): number => {
  // This field is part of hashable RuntimeInput/account-frame payloads. It must
  // be derived from canonical J-chain identity, not watcher delivery time or
  // chain wall-clock timestamp, which can differ across observers and fresh RPC
  // scenario runs for the same event sequence.
  const height = Number(blockNumber);
  return Number.isFinite(height) && height > 0 ? Math.floor(height) : 0;
};

export function buildRawJEventsRuntimeInput(
  env: Env,
  rawEvents: RawJEvent[],
  options: {
    blockNumber: number;
    blockHash: string;
    adapterLabel: string;
    txCounter?: EventBatchCounter;
    logBatch?: boolean;
    emitSettledDebugEvents?: boolean;
  },
): JEventsRuntimeInputBuildResult | null {
  if (rawEvents.length === 0) return null;

  const {
    blockNumber,
    blockHash,
    adapterLabel,
    txCounter,
    logBatch = false,
    emitSettledDebugEvents = false,
  } = options;

  if (logBatch) {
    jadapterHelperLog.info('event_batch.canonical', {
      adapterLabel,
      blockNumber,
      count: rawEvents.length,
    });
  }
  const observedAt = resolveJEventObservedAt(blockNumber);

  const hankoNonceByTxAndEntity = new Map<string, string>();
  for (const event of rawEvents) {
    if (event.name !== 'HankoBatchProcessed') continue;
    const txHash = String(event.transactionHash || '').toLowerCase();
    const eventEntity = String(event.args['entityId'] ?? '').toLowerCase();
    const nonce = event.args['nonce'];
    if (!txHash || !eventEntity || nonce === undefined || nonce === null) continue;
    hankoNonceByTxAndEntity.set(`${txHash}:${eventEntity}`, String(nonce));
  }

  const enrichedRawEvents = rawEvents.map((event) => {
    if (event.name !== 'DisputeStarted' && event.name !== 'DisputeFinalized') {
      return event;
    }
    const txHash = String(event.transactionHash || '').toLowerCase();
    const sender = String(event.args['sender'] ?? '').toLowerCase();
    const batchNonce = txHash && sender ? hankoNonceByTxAndEntity.get(`${txHash}:${sender}`) : undefined;
    if (batchNonce === undefined) return event;
    return {
      ...event,
      args: {
        ...event.args,
        batchNonce,
      },
    };
  });

  const eventsByReplica = new Map<string, { entityId: string; signerId: string; events: RawJEvent[] }>();

  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const [entityIdFromKey, signerIdFromKey] = replicaKey.split(':');
    const entityId = String(replica.entityId || entityIdFromKey || '').toLowerCase();
    const signerId = String(replica.signerId || signerIdFromKey || '');
    if (!entityId || !signerId) continue;

    const relevant = enrichedRawEvents.filter((event) => isEventRelevantToEntity(event, entityId));
    if (relevant.length === 0) continue;

    const existing = eventsByReplica.get(replicaKey);
    if (existing) {
      existing.events.push(...relevant);
      continue;
    }
    eventsByReplica.set(replicaKey, { entityId, signerId, events: [...relevant] });
  }

  const entityInputs: EntityInput[] = [];
  const evidenceEventsByLog = new Map<string, RawJEvent>();
  for (const { entityId, signerId, events } of eventsByReplica.values()) {
    const jEvents = events.flatMap((event) => rawEventToJEvents(event, entityId));
    if (jEvents.length === 0) continue;
    const firstJEvent = jEvents[0];
    if (!firstJEvent) continue;
    const disputeFinalizationEvidence = events
      .map((event) => event.disputeFinalizationEvidence)
      .filter((evidence): evidence is DisputeFinalizationEvidence => Boolean(evidence));

    const settledCount = jEvents.filter((event) => event.type === 'AccountSettled').length;
    if (emitSettledDebugEvents && settledCount > 0) {
      jadapterHelperLog.info('j_event.deliver_settled', {
        entityId: shortId(entityId, 8),
        signerId: shortId(signerId, 8),
        blockNumber,
        accountSettled: settledCount,
      });
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

    const transactionHash =
      events[0]?.transactionHash ??
      `${adapterLabel}-${blockNumber}-${txCounter ? txCounter.value++ : entityInputs.length}`;
    const eventsHash = canonicalJurisdictionEventsHash(jEvents);
    const disputeFinalizationEvidenceHash = disputeFinalizationEvidence.length > 0
      ? canonicalDisputeFinalizationEvidenceHash(disputeFinalizationEvidence)
      : undefined;
    const signature = signAccountFrame(
      env,
      signerId,
      buildJEventObservationDigest({
        entityId,
        signerId,
        blockNumber,
        blockHash,
        transactionHash,
        eventsHash,
        ...(disputeFinalizationEvidenceHash ? { disputeFinalizationEvidenceHash } : {}),
      }),
    );

    entityInputs.push({
      entityId,
      signerId,
      entityTxs: [
        {
          type: 'j_event',
          data: {
            from: signerId,
            observedAt,
            blockNumber,
            blockHash,
            transactionHash,
            eventsHash,
            signature,
            events: jEvents,
            event: firstJEvent,
            ...(disputeFinalizationEvidenceHash ? { disputeFinalizationEvidenceHash } : {}),
            ...(disputeFinalizationEvidence.length > 0 ? { disputeFinalizationEvidence } : {}),
          },
        },
      ],
    });

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      const key = event.transactionHash
        ? `${event.transactionHash.toLowerCase()}:${event.logIndex ?? event.name}:${index}`
        : `${event.blockHash ?? blockHash}:${event.name}:${index}`;
      evidenceEventsByLog.set(key, event);
    }

    if (logBatch) {
      jadapterHelperLog.info('event_batch.delivered_to_entity', {
        adapterLabel,
        entityId: shortId(entityId),
        count: jEvents.length,
      });
    }
  }

  if (entityInputs.length === 0) return null;
  return {
    input: {
      timestamp: observedAt,
      runtimeTxs: [],
      entityInputs,
    },
    evidenceEvents: [...evidenceEventsByLog.values()],
  };
}

function enqueueRawJEventsToRuntime(
  env: Env,
  rawEvents: RawJEvent[],
  options: Parameters<typeof buildRawJEventsRuntimeInput>[2],
): void {
  const built = buildRawJEventsRuntimeInput(env, rawEvents, options);
  if (!built) return;
  rememberRecentJEvents(env, built.evidenceEvents);
  enqueueRuntimeInput(env, built.input);
}

export function applyJEventsToEnv(env: Env, events: JEvent[], label = 'J-EVENTS'): void {
  if (!events || events.length === 0) return;
  assertJEventIngressOpen(env, label);
  const rawEvents: RawJEvent[] = events
    .filter((event): event is JEvent & { name: string; args?: Record<string, unknown> } => typeof event?.name === 'string')
    .map((event) => ({
      name: event.name,
      args: (event.args ?? {}) as RawJEventArgs,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      transactionHash: event.transactionHash,
    }));
  if (rawEvents.length === 0) return;
  for (const event of rawEvents) {
    if (event.name !== 'ExternalWalletSnapshot') continue;
    const entityId = String(event.args['entityId'] ?? '').trim().toLowerCase();
    const owner = String(event.args['owner'] ?? '').trim().toLowerCase();
    if (!entityId || !/^0x[0-9a-f]{40}$/.test(owner)) continue;
    if (!env.runtimeState) env.runtimeState = {};
    if (!env.runtimeState.externalWalletWatchOwners) {
      env.runtimeState.externalWalletWatchOwners = new Map();
    }
    const owners = env.runtimeState.externalWalletWatchOwners.get(entityId) ?? new Map<string, number>();
    const blockNumber = Number(event.blockNumber ?? 0);
    owners.set(owner, Math.max(owners.get(owner) ?? 0, Number.isFinite(blockNumber) ? blockNumber : 0));
    env.runtimeState.externalWalletWatchOwners.set(entityId, owners);
  }
  const blockGroups = new Map<number, RawJEvent[]>();
  for (const event of rawEvents) {
    const blockNumber = Number(event.blockNumber ?? 0);
    if (!blockGroups.has(blockNumber)) blockGroups.set(blockNumber, []);
    blockGroups.get(blockNumber)!.push(event);
  }
  const dedupCounter = env.runtimeState?.watcherDedupCounter ?? { value: 0 };
  for (const [blockNumber, groupedEvents] of blockGroups) {
    const blockHash = groupedEvents[0]?.blockHash ?? '0x';
    processEventBatch(groupedEvents, env, blockNumber, blockHash, dedupCounter, label);
  }
}

export function buildJEventsRuntimeInput(env: Env, events: JEvent[], label = 'J-EVENTS'): RuntimeInput | null {
  if (!events || events.length === 0) return null;
  assertJEventIngressOpen(env, label);
  const rawEvents: RawJEvent[] = events
    .filter((event): event is JEvent & { name: string; args?: Record<string, unknown> } => typeof event?.name === 'string')
    .map((event) => ({
      name: event.name,
      args: (event.args ?? {}) as RawJEventArgs,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      transactionHash: event.transactionHash,
    }));
  if (rawEvents.length === 0) return null;

  const blockGroups = new Map<number, RawJEvent[]>();
  for (const event of rawEvents) {
    const blockNumber = Number(event.blockNumber ?? 0);
    if (!blockGroups.has(blockNumber)) blockGroups.set(blockNumber, []);
    blockGroups.get(blockNumber)!.push(event);
  }

  const txCounter: EventBatchCounter = { value: 0 };
  const entityInputs: EntityInput[] = [];
  let timestamp = 0;
  for (const [blockNumber, groupedEvents] of blockGroups) {
    const blockHash = groupedEvents[0]?.blockHash ?? '0x';
    const built = buildRawJEventsRuntimeInput(env, groupedEvents.filter(isCanonicalEvent), {
      blockNumber,
      blockHash,
      adapterLabel: label,
      txCounter,
      logBatch: false,
      emitSettledDebugEvents: false,
    });
    if (built?.input.entityInputs?.length) {
      entityInputs.push(...built.input.entityInputs);
      timestamp = Math.max(timestamp, Number(built.input.timestamp ?? 0));
    }
  }
  if (entityInputs.length === 0) return null;
  return {
    timestamp,
    runtimeTxs: [],
    entityInputs,
  };
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
  assertJEventIngressOpen(env, adapterLabel);

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
    const syntheticEntityKey =
      event.name === 'ExternalWalletSnapshot' || event.name === 'ExternalWalletDelta'
        ? `:${String(event.args['entityId'] ?? '').toLowerCase()}:${String(event.args['owner'] ?? '').toLowerCase()}`
        : '';
    const key = txHash && event.logIndex !== undefined
      ? `${txHash.toLowerCase()}:${event.logIndex}${syntheticEntityKey}`
      : txHash
        ? `${txHash.toLowerCase()}:${event.name}${syntheticEntityKey}:${idx}`
      : `${event.blockHash ?? blockHash}:${event.name}${syntheticEntityKey}:${idx}`;
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

  enqueueRawJEventsToRuntime(env, deduped, {
    blockNumber,
    blockHash,
    adapterLabel,
    txCounter,
    logBatch: !!env?.debugJWatcherBatches,
    emitSettledDebugEvents: true,
  });
}
