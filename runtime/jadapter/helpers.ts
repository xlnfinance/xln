/**
 * JAdapter Helpers
 * Shared utilities for all JAdapter modes (browservm, rpc, anvil)
 * @license AGPL-3.0
 */

import { ethers } from 'ethers';
import type { JEvent } from './types';
import type { DisputeFinalizationEvidence, EntityInput, Env, JPrefixAttestation, JReplica, JurisdictionConfig, JurisdictionEvent, RuntimeInput, RuntimeTx, ValidatorJBlockHeader, ValidatorJEventBlock } from '../types';
import { createEmptyBatch, type JBatch } from '../jurisdiction/batch';
import { enqueueRuntimeInput } from '../runtime';
import { createStructuredLogger, shortId } from '../infra/logger';
import {
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
  getJEventJurisdictionRef,
} from '../jurisdiction/event-observation';
import { rememberRecentJEvents } from '../jurisdiction/event-evidence';
import { JBLOCK_LIVENESS_INTERVAL } from '../types';
import {
  assertValidatorJHistoryMatchesCertifiedAnchor,
  getEntityCertifiedJAnchor,
  getValidatorJContiguousThroughHeight,
  getValidatorJExpectedBlockHash,
  recordValidatorJHistory,
} from '../jurisdiction/local-history';
import {
  buildLocalJPrefixAttestation,
  getLocalJPrefixAttestableHeight,
  hasDueLocalJPrefixAdvance,
  hasCurrentRoundJPrefixAttestation,
} from '../jurisdiction/j-prefix-consensus';
import { markLocalJAuthorityRuntimeTx } from '../jurisdiction/registration-evidence';
import {
  bindLocalJEventIngressSource,
  type LocalJEventIngressSource,
} from './local-ingress-source';

// ═══════════════════════════════════════════════════════════════════════════
// CANONICAL J-EVENTS (Single Source of Truth — must match Depository.sol)
// ═══════════════════════════════════════════════════════════════════════════
export const CANONICAL_J_EVENTS = [
  'FoundationBootstrapped', 'EntityRegistered', 'BoardActivated',
  'ReserveUpdated', 'SecretRevealed', 'AccountSettled',
  'ExternalWalletSnapshot', 'ExternalWalletDelta',
  'DisputeStarted', 'DisputeFinalized', 'DebtCreated', 'DebtEnforced', 'DebtForgiven', 'HankoBatchProcessed',
  'EntityProviderActionExecuted', 'EntityProviderActionCancelled',
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

export const toJEvent = (name: string, args: Record<string, unknown> | undefined, meta?: { blockNumber?: number; blockHash?: string; transactionHash?: string; logIndex?: number }): JEvent => ({
  name,
  args: args ?? {},
  blockNumber: meta?.blockNumber ?? 0,
  blockHash: meta?.blockHash ?? '0x',
  transactionHash: meta?.transactionHash ?? '0x',
  ...(meta?.logIndex !== undefined ? { logIndex: meta.logIndex } : {}),
});

export const normalizeAdapterEvents = (events: Array<{
  name: string; args?: Record<string, unknown>; blockNumber?: number; blockHash?: string; transactionHash?: string; logIndex?: number;
}>, fallbackMeta?: { blockNumber?: number; blockHash?: string; transactionHash?: string; logIndex?: number }): JEvent[] =>
  events.map((event) => {
    const meta: { blockNumber?: number; blockHash?: string; transactionHash?: string; logIndex?: number } = {};
    const blockNumber = event.blockNumber ?? fallbackMeta?.blockNumber;
    const blockHash = event.blockHash ?? fallbackMeta?.blockHash;
    const transactionHash = event.transactionHash ?? fallbackMeta?.transactionHash;
    const logIndex = event.logIndex ?? fallbackMeta?.logIndex;
    if (blockNumber !== undefined) meta.blockNumber = blockNumber;
    if (blockHash !== undefined) meta.blockHash = blockHash;
    if (transactionHash !== undefined) meta.transactionHash = transactionHash;
    if (logIndex !== undefined) meta.logIndex = logIndex;
    return toJEvent(event.name, event.args, meta);
  });

export const parseReceiptLogsToJEvents = (receipt: {
  logs: Array<{
    address: string;
    topics: readonly string[];
    data: string;
    index?: number;
    logIndex?: number;
  }>;
  blockNumber: number;
  blockHash: string;
  hash: string;
}, carriers: Array<{ address: string; interface: ethers.Interface }>): JEvent[] => {
  const events: JEvent[] = [];
  const carrierByAddress = new Map<string, { address: string; interface: ethers.Interface }>();
  for (const carrier of carriers) {
    if (!ethers.isAddress(carrier.address)) {
      throw new Error(`J_RECEIPT_CARRIER_ADDRESS_INVALID:${String(carrier.address)}`);
    }
    const address = ethers.getAddress(carrier.address).toLowerCase();
    if (carrierByAddress.has(address)) {
      throw new Error(`J_RECEIPT_CARRIER_ADDRESS_DUPLICATE:${address}`);
    }
    carrierByAddress.set(address, carrier);
  }
  for (let receiptIndex = 0; receiptIndex < receipt.logs.length; receiptIndex += 1) {
    const log = receipt.logs[receiptIndex]!;
    if (!ethers.isAddress(log.address)) {
      throw new Error(`J_RECEIPT_LOG_ADDRESS_INVALID:${receipt.hash}:${receiptIndex}:${String(log.address)}`);
    }
    const index = log.index;
    const legacyLogIndex = log.logIndex;
    if (
      index !== undefined && legacyLogIndex !== undefined &&
      index !== legacyLogIndex
    ) {
      throw new Error(
        `J_RECEIPT_LOG_INDEX_MISMATCH:${receipt.hash}:${receiptIndex}` +
        `:index=${String(index)}:logIndex=${String(legacyLogIndex)}`,
      );
    }
    const logIndex = index ?? legacyLogIndex;
    if (!Number.isSafeInteger(logIndex) || Number(logIndex) < 0) {
      throw new Error(`J_RECEIPT_LOG_INDEX_INVALID:${receipt.hash}:${receiptIndex}:${String(logIndex)}`);
    }
    const topic = String(log.topics[0] || '').toLowerCase();
    const carrier = carrierByAddress.get(ethers.getAddress(log.address).toLowerCase());
    if (!carrier) continue;
    const hasEventTopic = carrier.interface.fragments.some((fragment) =>
      fragment.type === 'event' && (fragment as ethers.EventFragment).topicHash.toLowerCase() === topic
    );
    if (!hasEventTopic) continue;
    let parsed: ethers.LogDescription | null;
    try {
      parsed = carrier.interface.parseLog({ topics: [...log.topics], data: log.data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`J_RECEIPT_LOG_DECODE_FAILED:${receipt.hash}:${receiptIndex}:${message}`);
    }
    if (!parsed) throw new Error(`J_RECEIPT_LOG_DECODE_FAILED:${receipt.hash}:${receiptIndex}:empty`);
    events.push(
      toJEvent(parsed.name, buildParsedLogArgs(parsed), {
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionHash: receipt.hash,
        logIndex: Number(logIndex),
      }),
    );
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

export type PendingWatcherJHistoryRange = {
  fromBlock: number;
  toBlock: number;
  tipBlockHash: string;
  replicaKeys: Set<string>;
};


export type JEventIngressBatch = {
  rawEvents: RawJEvent[];
  blockNumber: number;
  blockHash: string;
};

export type JHistoryRangeIngress = {
  scannedThroughHeight: number;
  tipBlockHash: string;
  headers: ValidatorJBlockHeader[];
};

export type JBlockHeadersIngress = ValidatorJBlockHeader[];

let jEventIngressTransform: ((batch: JEventIngressBatch) => JEventIngressBatch) | null = null;
let jHistoryRangeIngressTransform:
  ((range: JHistoryRangeIngress) => JHistoryRangeIngress) | null = null;
let jBlockHeadersIngressTransform:
  ((headers: JBlockHeadersIngress) => JBlockHeadersIngress) | null = null;

export const setJEventIngressTransform = (
  transform: ((batch: JEventIngressBatch) => JEventIngressBatch) | null,
): (() => void) => {
  const previous = jEventIngressTransform;
  jEventIngressTransform = transform;
  return () => {
    jEventIngressTransform = previous;
  };
};

export const setJHistoryRangeIngressTransform = (
  transform: ((range: JHistoryRangeIngress) => JHistoryRangeIngress) | null,
): (() => void) => {
  const previous = jHistoryRangeIngressTransform;
  jHistoryRangeIngressTransform = transform;
  return () => {
    jHistoryRangeIngressTransform = previous;
  };
};

export const setJBlockHeadersIngressTransform = (
  transform: ((headers: JBlockHeadersIngress) => JBlockHeadersIngress) | null,
): (() => void) => {
  const previous = jBlockHeadersIngressTransform;
  jBlockHeadersIngressTransform = transform;
  return () => {
    jBlockHeadersIngressTransform = previous;
  };
};

export const applyJBlockHeadersIngressTransform = (
  headers: JBlockHeadersIngress,
): JBlockHeadersIngress => {
  const transformed = jBlockHeadersIngressTransform
    ? jBlockHeadersIngressTransform(headers.map((header) => ({ ...header })))
    : headers;
  if (transformed.length !== headers.length) throw new Error('J_HISTORY_HEADER_TRACE_LENGTH_MISMATCH');
  return transformed.map((header, index) => {
    const expectedHeight = headers[index]?.jHeight;
    if (header.jHeight !== expectedHeight || !String(header.jBlockHash || '').trim()) {
      throw new Error(`J_HISTORY_HEADER_TRACE_INVALID:index=${index}`);
    }
    return { jHeight: header.jHeight, jBlockHash: header.jBlockHash.toLowerCase() };
  });
};

const normalizeJurisdictionLabel = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

const normalizeJurisdictionAddress = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

export const findWatcherJurisdictionReplica = (
  env: Env,
  depositoryAddress?: string,
  chainId?: number,
) => {
  const replicas = Array.from(env?.jReplicas?.values?.() || []);
  if (replicas.length === 0) return null;

  const normalizedDepository = String(depositoryAddress ?? '').trim().toLowerCase();
  const normalizedChainId = Number.isFinite(chainId) && Number(chainId) > 0 ? Math.floor(Number(chainId)) : null;
  if (normalizedDepository || normalizedChainId !== null) {
    const addressMatches = replicas.filter((replica) => {
      const candidate = String(
        replica?.depositoryAddress || replica?.contracts?.depository || '',
      ).trim().toLowerCase();
      return !normalizedDepository || candidate === normalizedDepository;
    });
    const matches = normalizedChainId === null
      ? addressMatches
      : addressMatches.filter((replica) => watcherChainIdOf(replica) === normalizedChainId);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(`J_WATCHER_JURISDICTION_AMBIGUOUS:${normalizedChainId ?? 'any'}:${normalizedDepository || 'any'}`);
    }

    // Legacy/scenario replicas may predate the chainId field. A unique Depository
    // still identifies them safely; deterministic deployments with two replicas at
    // the same address remain fail-closed instead of guessing a jurisdiction.
    if (
      normalizedChainId !== null &&
      normalizedDepository &&
      addressMatches.length === 1 &&
      watcherChainIdOf(addressMatches[0]) === null
    ) {
      return addressMatches[0]!;
    }
    return null;
  }

  if (env.activeJurisdiction) {
    const active = env.jReplicas?.get(env.activeJurisdiction);
    if (active) return active;
  }

  return replicas[0] || null;
};

const requireWatcherJurisdictionReplica = (
  env: Env,
  depositoryAddress: string | undefined,
  chainId: number | undefined,
  context: string,
): JReplica => {
  const replica = findWatcherJurisdictionReplica(env, depositoryAddress, chainId);
  if (replica) return replica;
  const available = [...(env.jReplicas?.values?.() || [])]
    .map((candidate) => {
      const address = String(candidate.depositoryAddress || candidate.contracts?.depository || '').toLowerCase();
      return `${candidate.name || 'unnamed'}/${String(candidate.chainId ?? 'missing')}/${address || 'missing'}`;
    })
    .join(',');
  throw new Error(
    `J_WATCHER_JURISDICTION_NOT_FOUND:${context}` +
    `:chain=${String(chainId ?? 'any')}` +
    `:depository=${String(depositoryAddress || 'any').toLowerCase()}` +
    `:available=${available || 'none'}`,
  );
};

const watcherDepositoryOf = (replica: JReplica | null | undefined): string =>
  normalizeJurisdictionAddress(replica?.depositoryAddress || replica?.contracts?.depository || '');

const watcherEntityProviderOf = (replica: JReplica | null | undefined): string =>
  normalizeJurisdictionAddress(replica?.entityProviderAddress || replica?.contracts?.entityProvider || '');

const watcherNameOf = (replica: JReplica | null | undefined): string =>
  normalizeJurisdictionLabel(replica?.name);

const watcherChainIdOf = (replica: JReplica | null | undefined): number | null => {
  const chainId = Number(replica?.chainId);
  return Number.isFinite(chainId) && chainId > 0 ? Math.floor(chainId) : null;
};

export const isEntityReplicaRelevantToWatcher = (
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
  const watcherEntityProvider = watcherEntityProviderOf(watcherReplica);
  const entityProvider = normalizeJurisdictionAddress(jurisdiction.entityProviderAddress);
  const watcherChainId = watcherChainIdOf(watcherReplica);
  const entityChainId = Number(jurisdiction.chainId);
  const chainMatches = !watcherChainId || !Number.isFinite(entityChainId) || watcherChainId === Math.floor(entityChainId);
  if (!chainMatches) return false;
  if (watcherEntityProvider || entityProvider) {
    if (!watcherEntityProvider || !entityProvider || watcherEntityProvider !== entityProvider) return false;
  }
  if (watcherDepository && entityDepository) return watcherDepository === entityDepository;
  const watcherName = watcherNameOf(watcherReplica);
  const entityName = normalizeJurisdictionLabel(jurisdiction.name);
  return Boolean(watcherName && entityName && watcherName === entityName && chainMatches);
};

export function getWatcherStartBlock(env: Env, depositoryAddress?: string, chainId?: number): number {
  const replica = depositoryAddress || chainId !== undefined
    ? requireWatcherJurisdictionReplica(env, depositoryAddress, chainId, 'start-block')
    : findWatcherJurisdictionReplica(env, depositoryAddress, chainId);
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
    if (!Number.isFinite(height) || height < 0) continue;
    minHeight = minHeight === null ? Math.floor(height) : Math.min(minHeight, Math.floor(height));
  }
  return minHeight;
}

export function getMinimumScannedSignerJHeight(env: Env, watcherReplica?: JReplica): number | null {
  let minHeight: number | null = null;
  for (const replica of env.eReplicas?.values?.() || []) {
    if (watcherReplica && !isEntityReplicaRelevantToWatcher(env, replica, watcherReplica)) continue;
    const height = Number(replica.jHistory
      ? getValidatorJContiguousThroughHeight(replica.state, replica.jHistory)
      : replica.state?.lastFinalizedJHeight ?? 0);
    if (!Number.isSafeInteger(height) || height < 0) {
      throw new Error(`J_WATCHER_LOCAL_SCAN_HEIGHT_INVALID:${String(height)}`);
    }
    minHeight = minHeight === null ? height : Math.min(minHeight, height);
  }
  return minHeight;
}

export function updateWatcherJurisdictionCursor(
  env: Env,
  blockNumber: number,
  depositoryAddress?: string,
  chainId?: number,
): void {
  const replica = depositoryAddress || chainId !== undefined
    ? requireWatcherJurisdictionReplica(env, depositoryAddress, chainId, 'cursor-update')
    : findWatcherJurisdictionReplica(env, depositoryAddress, chainId);
  if (!replica) throw new Error('J_WATCHER_JURISDICTION_NOT_FOUND:cursor-update');
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`J_WATCHER_CURSOR_INVALID:${String(blockNumber)}`);
  }
  const nextBlock = Math.floor(blockNumber);
  const currentBlock = replica.blockNumber ?? 0n;
  if (typeof currentBlock !== 'bigint' || currentBlock < 0n) {
    throw new Error(`J_WATCHER_COMMITTED_CURSOR_INVALID:${String(currentBlock)}`);
  }
  if (currentBlock >= BigInt(nextBlock)) return;
  const normalizedDepository = watcherDepositoryOf(replica);
  if (!normalizedDepository) throw new Error('J_WATCHER_DEPOSITORY_MISSING:cursor-update');
  const replicaChainId = watcherChainIdOf(replica);
  const cursorTx: Extract<RuntimeTx, { type: 'advanceJWatcherCursor' }> = {
    type: 'advanceJWatcherCursor',
    data: {
      depositoryAddress: normalizedDepository,
      ...(replicaChainId === null ? {} : { chainId: replicaChainId }),
      blockNumber: nextBlock,
    },
  };
  enqueueRuntimeInput(env, {
    timestamp: nextBlock,
    runtimeTxs: [markLocalJAuthorityRuntimeTx(cursorTx)],
    entityInputs: [],
  });
}

/** Apply a durable watcher-cursor RuntimeTx inside the R-frame transaction. */
export function applyWatcherJurisdictionCursor(
  env: Env,
  data: Extract<RuntimeTx, { type: 'advanceJWatcherCursor' }>['data'],
): void {
  if (!Number.isSafeInteger(data.blockNumber) || data.blockNumber < 0) {
    throw new Error(`J_WATCHER_CURSOR_INVALID:${String(data.blockNumber)}`);
  }
  const replica = requireWatcherJurisdictionReplica(
    env,
    data.depositoryAddress,
    data.chainId,
    'cursor-apply',
  );
  const currentBlock = replica.blockNumber ?? 0n;
  if (typeof currentBlock !== 'bigint' || currentBlock < 0n) {
    throw new Error(`J_WATCHER_COMMITTED_CURSOR_INVALID:${String(currentBlock)}`);
  }
  replica.blockNumber = currentBlock > BigInt(data.blockNumber)
    ? currentBlock
    : BigInt(data.blockNumber);
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
    case 'FoundationBootstrapped':
    case 'EntityRegistered':
    case 'BoardActivated':
      // Board authority is stack-global. Every Entity replica bound to this
      // exact watcher stack must certify the identical ordered registry log.
      return true;

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

    case 'EntityProviderActionExecuted':
    case 'EntityProviderActionCancelled':
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

/**
 * True while an authenticated watcher page has not reached every replica's
 * durable contiguous local J-history. The RPC watcher must not build the next
 * page against stale replica state: doing so either re-enqueues the same page
 * or constructs a range with a gap. Entity finality is tracked separately by
 * resolveCommittedWatcherCursor; this fence covers Runtime-frame durability.
 */
export function isWatcherJHistoryRangeDurable(
  env: Env,
  range: PendingWatcherJHistoryRange,
): boolean {
  if (!Number.isSafeInteger(range.fromBlock) || !Number.isSafeInteger(range.toBlock)) {
    throw new Error(`J_WATCHER_PENDING_SCAN_RANGE_INVALID:${range.fromBlock}:${range.toBlock}`);
  }
  if (range.fromBlock <= 0 || range.toBlock < range.fromBlock) {
    throw new Error(`J_WATCHER_PENDING_SCAN_RANGE_INVALID:${range.fromBlock}:${range.toBlock}`);
  }
  const tipBlockHash = String(range.tipBlockHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(tipBlockHash)) {
    throw new Error(`J_WATCHER_PENDING_SCAN_TIP_INVALID:${range.toBlock}`);
  }
  for (const replicaKey of range.replicaKeys) {
    const replica = env.eReplicas?.get(replicaKey);
    if (!replica) return false;
    const certifiedAnchor = getEntityCertifiedJAnchor(replica.state);
    if (certifiedAnchor && certifiedAnchor.height > range.toBlock) {
      // The certified tip commits to the entire linked-chain ancestry. A
      // concurrently finalized higher prefix may therefore prune this page's
      // local tip hash before the watcher checks durability; requiring the
      // pruned cache entry would turn legitimate progress into a fatal halt.
      assertValidatorJHistoryMatchesCertifiedAnchor(replica.state, replica.jHistory);
      continue;
    }
    if (!replica.jHistory) return false;
    if (getValidatorJContiguousThroughHeight(replica.state, replica.jHistory) < range.toBlock) return false;
    const observedHash = getValidatorJExpectedBlockHash(replica.state, replica.jHistory, range.toBlock);
    if (String(observedHash || '').toLowerCase() !== tipBlockHash) {
      throw new Error(
        `J_WATCHER_PENDING_SCAN_TIP_CONFLICT:${range.toBlock}:` +
        `expected=${tipBlockHash}:observed=${String(observedHash || 'missing').toLowerCase()}`,
      );
    }
  }
  return true;
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
function rawEventToJEventPayloads(event: RawJEvent, entityId: string): JurisdictionEvent[] {
  const args = event.args;

  switch (event.name) {
    case 'FoundationBootstrapped':
      return [{
        type: 'FoundationBootstrapped',
        data: {
          recipient: String(args['recipient'] ?? ''),
          boardHash: String(args['boardHash'] ?? ''),
          controlTokenId: String(args['controlTokenId'] ?? ''),
          dividendTokenId: String(args['dividendTokenId'] ?? ''),
        },
      }];

    case 'EntityRegistered':
      return [{
        type: 'EntityRegistered',
        data: {
          entityId: String(args['entityId'] ?? ''),
          entityNumber: String(args['entityNumber'] ?? ''),
          boardHash: String(args['boardHash'] ?? ''),
        },
      }];

    case 'BoardActivated':
      return [{
        type: 'BoardActivated',
        data: {
          entityId: String(args['entityId'] ?? ''),
          previousBoardHash: String(args['previousBoardHash'] ?? ''),
          newBoardHash: String(args['newBoardHash'] ?? ''),
          previousBoardValidUntil: String(args['previousBoardValidUntil'] ?? ''),
        },
      }];

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

    case 'DisputeStarted': {
      const disputeTimeout = Number(args['disputeTimeout']);
      if (!Number.isSafeInteger(disputeTimeout) || disputeTimeout <= 0) {
        throw new Error(
          `J_EVENT_DISPUTE_TIMEOUT_INVALID:block=${String(event.blockNumber)}:timeout=${String(args['disputeTimeout'])}`,
        );
      }
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
          disputeTimeout,
          ...(args['batchNonce'] !== undefined ? { batchNonce: Number(args['batchNonce']) } : {}),
        },
      }];
    }

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
          batchHash: String(args['batchHash'] ?? ''),
          nonce: Number(args['nonce']),
          success: Boolean(args['success']),
        },
      }];

    case 'EntityProviderActionExecuted': {
      const actionKind = Number(args['actionKind']);
      if (actionKind !== 0 && actionKind !== 1) {
        throw new Error(`J_EVENT_ENTITY_PROVIDER_ACTION_KIND_INVALID:${String(args['actionKind'])}`);
      }
      return [{
        type: 'EntityProviderActionExecuted',
        data: {
          entityId: String(args['entityId'] ?? ''),
          actionNonce: String(args['actionNonce'] ?? ''),
          actionHash: String(args['actionHash'] ?? ''),
          actionKind,
        },
      }];
    }

    case 'EntityProviderActionCancelled': {
      const cancelledActionKind = Number(args['cancelledActionKind']);
      if (cancelledActionKind !== 0 && cancelledActionKind !== 1) {
        throw new Error(
          `J_EVENT_ENTITY_PROVIDER_CANCEL_KIND_INVALID:${String(args['cancelledActionKind'])}`,
        );
      }
      return [{
        type: 'EntityProviderActionCancelled',
        data: {
          entityId: String(args['entityId'] ?? ''),
          actionNonce: String(args['actionNonce'] ?? ''),
          cancelledActionHash: String(args['cancelledActionHash'] ?? ''),
          cancelledActionKind,
          cancelHash: String(args['cancelHash'] ?? ''),
        },
      }];
    }

    default:
      return [];
  }
}

export function rawEventToJEvents(event: RawJEvent, entityId: string): JurisdictionEvent[] {
  const events = rawEventToJEventPayloads(event, entityId);
  return events.map((jEvent, eventIndex) => ({
    ...jEvent,
    ...(event.blockNumber !== undefined ? { blockNumber: event.blockNumber } : {}),
    ...(event.blockHash ? { blockHash: event.blockHash } : {}),
    ...(event.transactionHash ? { transactionHash: event.transactionHash } : {}),
    ...(event.logIndex !== undefined ? { logIndex: event.logIndex } : {}),
    ...(events.length > 1 ? { eventIndex } : {}),
  }));
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
    watcherDepositoryAddress?: string;
    watcherChainId?: number;
    localSourceReplica?: JReplica;
    emitRange?: boolean;
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
    watcherDepositoryAddress,
    watcherChainId,
    localSourceReplica,
    emitRange = true,
  } = options;

  if (localSourceReplica && (watcherDepositoryAddress || watcherChainId !== undefined)) {
    throw new Error(`J_EVENT_LOCAL_SOURCE_SELECTOR_CONFLICT:${adapterLabel}`);
  }

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

  const eventsByReplica = new Map<string, { entityId: string; signerId: string; jurisdictionRef: string; events: RawJEvent[] }>();
  const watcherReplica = localSourceReplica
    ? bindLocalJEventIngressSource(env, localSourceReplica, `${adapterLabel}:event-batch`).replica
    : watcherDepositoryAddress || watcherChainId !== undefined
      ? requireWatcherJurisdictionReplica(env, watcherDepositoryAddress, watcherChainId, 'event-batch')
      : undefined;
  const watcherJurisdictionRef = watcherReplica ? getJEventJurisdictionRef(watcherReplica) : '';

  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    if (watcherReplica && !isEntityReplicaRelevantToWatcher(env, replica, watcherReplica)) continue;
    const jurisdictionRef = getJEventJurisdictionRef(replica.state.config.jurisdiction);
    if (watcherReplica && jurisdictionRef !== watcherJurisdictionRef) {
      throw new Error(
        `J_WATCHER_ENTITY_JURISDICTION_MISMATCH:event-batch` +
        `:watcher=${watcherJurisdictionRef}:entity=${jurisdictionRef}:replica=${replicaKey}`,
      );
    }
    const [entityIdFromKey, signerIdFromKey] = replicaKey.split(':');
    const entityId = String(replica.entityId || entityIdFromKey || '').toLowerCase();
    const signerId = String(replica.signerId || signerIdFromKey || '');
    if (!entityId || !signerId) continue;
    if (blockNumber <= Number(replica.state.lastFinalizedJHeight || 0)) continue;

    const relevant = enrichedRawEvents.filter((event) => isEventRelevantToEntity(event, entityId));
    if (relevant.length === 0) continue;

    const existing = eventsByReplica.get(replicaKey);
    if (existing) {
      existing.events.push(...relevant);
      continue;
    }
    eventsByReplica.set(replicaKey, {
      entityId,
      signerId,
      jurisdictionRef,
      events: [...relevant],
    });
  }

  const runtimeTxs: RuntimeTx[] = [];
  const entityInputs: EntityInput[] = [];
  const evidenceEventsByLog = new Map<string, RawJEvent>();
  for (const [replicaKey, { entityId, signerId, jurisdictionRef, events }] of eventsByReplica) {
    const replica = env.eReplicas.get(replicaKey);
    if (!replica) throw new Error(`J_HISTORY_LOCAL_REPLICA_MISSING:${replicaKey}`);
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

    if (txCounter) txCounter.value += 1;
    const eventsHash = canonicalJurisdictionEventsHash(jEvents);
    const disputeFinalizationEvidenceHash = disputeFinalizationEvidence.length > 0
      ? canonicalDisputeFinalizationEvidenceHash(disputeFinalizationEvidence)
      : undefined;
    const localBlock: ValidatorJEventBlock = {
      jurisdictionRef,
      jHeight: blockNumber,
      jBlockHash: blockHash.toLowerCase(),
      eventsHash,
      events: jEvents,
      ...(disputeFinalizationEvidenceHash ? { disputeFinalizationEvidenceHash } : {}),
      ...(disputeFinalizationEvidence.length > 0 ? { disputeFinalizationEvidence } : {}),
    };
    const observeTx: Extract<RuntimeTx, { type: 'observeJRange' }> = {
      type: 'observeJRange',
      data: {
        entityId,
        signerId,
        jurisdictionRef,
        scannedThroughHeight: blockNumber,
        tipBlockHash: blockHash.toLowerCase(),
        blocks: [localBlock],
      },
    };
    runtimeTxs.push(markLocalJAuthorityRuntimeTx(observeTx));

    if (emitRange) {
      const tentativeHistory = recordValidatorJHistory(replica.jHistory, observeTx.data, replica.state);
      if (hasCurrentRoundJPrefixAttestation(replica)) {
        jadapterHelperLog.debug('j_prefix.attestation_deferred', {
          entity: shortId(entityId),
          targetEntityHeight: replica.state.height + 1,
          reason: 'current_round_already_signed',
        });
      } else if (!hasDueLocalJPrefixAdvance(replica.state, tentativeHistory)) {
        jadapterHelperLog.debug('j_prefix.attestation_deferred', {
          entity: shortId(entityId),
          baseHeight: replica.state.lastFinalizedJHeight,
          scannedThroughHeight: tentativeHistory.scannedThroughHeight,
          reason: 'semantic_event_not_yet_contiguous',
        });
      } else {
        const attestation = buildLocalJPrefixAttestation(env, replica, tentativeHistory);
        if (!attestation) throw new Error(`J_PREFIX_ATTESTATION_NOT_AHEAD:${entityId}:${blockNumber}`);
        entityInputs.push({
          entityId,
          signerId,
          jPrefixAttestations: new Map([[signerId, attestation]]),
        });
      }
    }

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

  if (runtimeTxs.length === 0) return null;
  return {
    input: {
      timestamp: observedAt,
      runtimeTxs,
      entityInputs,
    },
    evidenceEvents: [...evidenceEventsByLog.values()],
  };
}

export type JHistoryRangeRuntimeInput = {
  input: RuntimeInput;
  /** Replicas whose authenticated local scan observation must become durable. */
  scannedReplicaKeys: string[];
  /** Subset that generated a J-range and therefore must reach Entity finality. */
  finalityReplicaKeys: string[];
};

export type JHistoryRangeReplicaKeys = Pick<
  JHistoryRangeRuntimeInput,
  'scannedReplicaKeys' | 'finalityReplicaKeys'
>;

type JHistoryRangeScope = 'watcher' | 'observed';

const mergeJPrefixAttestationInputs = (
  observed: EntityInput['jPrefixAttestations'],
  range: EntityInput['jPrefixAttestations'],
): Map<string, JPrefixAttestation> | undefined => {
  if (!observed && !range) return undefined;
  const merged = new Map(observed || []);
  for (const [signerId, attestation] of range || []) {
    if (merged.has(signerId)) {
      throw new Error(`J_HISTORY_RANGE_PREFIX_ATTESTATION_DUPLICATE:${signerId}`);
    }
    merged.set(signerId, attestation);
  }
  return merged;
};

const appendJHistoryRange = (
  observedInput: RuntimeInput,
  rangeInput: RuntimeInput | null,
): RuntimeInput => {
  if (!rangeInput) return observedInput;
  const merged = new Map<string, EntityInput>();
  for (const input of observedInput.entityInputs || []) {
    merged.set(`${String(input.entityId).toLowerCase()}:${String(input.signerId).toLowerCase()}`, input);
  }
  for (const range of rangeInput.entityInputs) {
    const key = `${String(range.entityId).toLowerCase()}:${String(range.signerId).toLowerCase()}`;
    const observation = merged.get(key);
    if (!observation) {
      merged.set(key, range);
      continue;
    }
    const jPrefixAttestations = mergeJPrefixAttestationInputs(
      observation.jPrefixAttestations,
      range.jPrefixAttestations,
    );
    merged.set(key, {
      ...observation,
      ...range,
      entityTxs: [...(observation.entityTxs || []), ...(range.entityTxs || [])],
      ...(jPrefixAttestations ? { jPrefixAttestations } : {}),
    });
  }
  return {
    ...observedInput,
    timestamp: Math.max(
      Number(observedInput.timestamp ?? 0),
      Number(rangeInput.timestamp ?? 0),
    ),
    runtimeTxs: [...observedInput.runtimeTxs, ...rangeInput.runtimeTxs],
    entityInputs: [...merged.values()],
    ...(observedInput.jInputs || rangeInput.jInputs
      ? { jInputs: [...(observedInput.jInputs || []), ...(rangeInput.jInputs || [])] }
      : {}),
    ...(observedInput.reliableReceipts || rangeInput.reliableReceipts
      ? {
          reliableReceipts: [
            ...(observedInput.reliableReceipts || []),
            ...(rangeInput.reliableReceipts || []),
          ],
        }
      : {}),
  };
};

const combineRuntimeInputs = (inputs: RuntimeInput[]): RuntimeInput | null => {
  let combined: RuntimeInput | null = null;
  for (const input of inputs) combined = combined ? appendJHistoryRange(combined, input) : input;
  return combined;
};

export function buildJHistoryRangeRuntimeInput(
  env: Env,
  newlyObservedInputs: RuntimeInput[],
  scannedThroughHeight: number,
  tipBlockHash: string,
  depositoryAddress?: string,
  headers: Array<{ jHeight: number; jBlockHash: string }> = [],
  chainId?: number,
  scope: JHistoryRangeScope = 'watcher',
): JHistoryRangeRuntimeInput | null {
  if (!Number.isSafeInteger(scannedThroughHeight) || scannedThroughHeight <= 0) {
    throw new Error(`J_HISTORY_RANGE_INVALID_SCANNED_HEIGHT:${String(scannedThroughHeight)}`);
  }
  if (!String(tipBlockHash || '').trim()) throw new Error('J_HISTORY_RANGE_TIP_HASH_MISSING');
  const watcherReplica = depositoryAddress || chainId !== undefined
    ? requireWatcherJurisdictionReplica(env, depositoryAddress, chainId, 'history-range')
    : undefined;
  const watcherJurisdictionRef = watcherReplica ? getJEventJurisdictionRef(watcherReplica) : '';
  const observationsByReplica = new Map<string, Array<Extract<RuntimeTx, { type: 'observeJRange' }>>>();
  for (const runtimeInput of newlyObservedInputs) {
    for (const tx of runtimeInput.runtimeTxs || []) {
      if (tx.type !== 'observeJRange') continue;
      const key = `${String(tx.data.entityId).toLowerCase()}:${String(tx.data.signerId).toLowerCase()}`;
      observationsByReplica.set(key, [...(observationsByReplica.get(key) || []), tx]);
    }
  }

  const runtimeTxs: RuntimeTx[] = [];
  const entityInputs: EntityInput[] = [];
  const scannedReplicaKeys: string[] = [];
  const finalityReplicaKeys: string[] = [];
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    if (watcherReplica && !isEntityReplicaRelevantToWatcher(env, replica, watcherReplica)) continue;
    const entityId = String(replica.state.entityId || replica.entityId || '').toLowerCase();
    const signerId = String(replica.signerId || '').toLowerCase();
    if (!entityId || !signerId) continue;
    const key = `${entityId}:${signerId}`;
    // A transaction receipt proves only the entities named by its events. It
    // cannot advance an unrelated entity's empty J range because the receipt
    // API does not carry the source jurisdiction. In a multi-J runtime with
    // deterministic deployments, doing so would copy chain A's block hash into
    // chain B's Entity history. Long-lived watchers are different: they pass an
    // exact (chainId, Depository) selector and may advance every matching Entity.
    if (scope === 'observed' && !observationsByReplica.has(key)) continue;
    const baseHeight = Number(replica.state.lastFinalizedJHeight || 0);
    const observations = observationsByReplica.get(key) || [];
    if (scannedThroughHeight <= baseHeight) continue;
    const scanDistanceMayReachLiveness = scannedThroughHeight - baseHeight >= JBLOCK_LIVENESS_INTERVAL;
    const jurisdictionRef = getJEventJurisdictionRef(replica.state.config.jurisdiction);
    if (watcherReplica && jurisdictionRef !== watcherJurisdictionRef) {
      throw new Error(
        `J_WATCHER_ENTITY_JURISDICTION_MISMATCH:history-range` +
        `:watcher=${watcherJurisdictionRef}:entity=${jurisdictionRef}:replica=${replicaKey}`,
      );
    }
    let tentativeHistory = replica.jHistory;
    for (const observation of observations) {
      tentativeHistory = recordValidatorJHistory(tentativeHistory, observation.data, replica.state);
    }
    const normalizedTipBlockHash = String(tipBlockHash).toLowerCase();
    const shouldRecordScanTip =
      headers.length > 0 ||
      !tentativeHistory ||
      tentativeHistory.scannedThroughHeight !== scannedThroughHeight ||
      tentativeHistory.tipBlockHash !== normalizedTipBlockHash;
    const scanTipObservation: Extract<RuntimeTx, { type: 'observeJRange' }> | null = shouldRecordScanTip
      ? {
        type: 'observeJRange',
        data: {
          entityId,
          signerId,
          jurisdictionRef,
          scannedThroughHeight,
          tipBlockHash: normalizedTipBlockHash,
          ...(headers.length > 0 ? { headers } : {}),
          blocks: [],
        },
      }
      : null;
    if (scanTipObservation) {
      tentativeHistory = recordValidatorJHistory(tentativeHistory, scanTipObservation.data, replica.state);
    }
    const hasDuePrefixAdvance = hasDueLocalJPrefixAdvance(replica.state, tentativeHistory);
    // Empty authenticated pages below liveness stay outside Runtime state. The
    // one exception is a page that closes the exact prefix for a previously
    // persisted sparse semantic event: that event must become attestable now.
    if (observations.length === 0 && !scanDistanceMayReachLiveness && !hasDuePrefixAdvance) continue;
    if (scanTipObservation) runtimeTxs.push(markLocalJAuthorityRuntimeTx(scanTipObservation));
    scannedReplicaKeys.push(replicaKey);
    // A semantic J event must hold the watcher cursor until the Entity has
    // certified the containing authenticated prefix. This obligation is
    // independent of whether this validator can emit a new attestation now:
    // it may already have signed the current Entity-height round, in which
    // case the event belongs to the next round after that one commits.
    if (observations.length > 0) finalityReplicaKeys.push(replicaKey);
    // An authenticated empty suffix is still durable local evidence, but it is
    // not an Entity range until the liveness interval is due. Treating every
    // scanned replica as pending finality deadlocks the watcher one empty block
    // after an event because no proposal is supposed to exist for that suffix.
    if (!hasDuePrefixAdvance) continue;
    if (!tentativeHistory) throw new Error(`J_HISTORY_DUE_WITHOUT_HISTORY:${replicaKey}`);
    if (hasCurrentRoundJPrefixAttestation(replica)) continue;
    if (getLocalJPrefixAttestableHeight(replica.state, tentativeHistory) === null) {
      jadapterHelperLog.debug('j_prefix.attestation_deferred', {
        entity: shortId(entityId),
        baseHeight: replica.state.lastFinalizedJHeight,
        scannedThroughHeight: tentativeHistory.scannedThroughHeight,
        reason: 'authenticated_headers_incomplete',
      });
      continue;
    }
    const attestation = buildLocalJPrefixAttestation(env, replica, tentativeHistory);
    if (!attestation) continue;
    entityInputs.push({
      entityId,
      signerId,
      jPrefixAttestations: new Map([[signerId, attestation]]),
    });
  }
  if (runtimeTxs.length === 0 && entityInputs.length === 0) return null;
  return {
    input: { timestamp: scannedThroughHeight, runtimeTxs, entityInputs },
    scannedReplicaKeys: scannedReplicaKeys.sort(),
    finalityReplicaKeys: finalityReplicaKeys.sort(),
  };
}

export function enqueueJHistoryRange(
  env: Env,
  newlyObservedInputs: RuntimeInput[],
  scannedThroughHeight: number,
  tipBlockHash: string,
  depositoryAddress?: string,
  headers: Array<{ jHeight: number; jBlockHash: string }> = [],
  chainId?: number,
): JHistoryRangeReplicaKeys {
  // This is the final common boundary for both RPC and BrowserVM watchers.
  // Outer poll cancellation checks reduce wasted I/O, but only this guard can
  // prove that no authenticated empty range is queued after quiesce begins.
  assertJEventIngressOpen(env, 'history-range');
  const ingress = jHistoryRangeIngressTransform
    ? jHistoryRangeIngressTransform({ scannedThroughHeight, tipBlockHash, headers })
    : { scannedThroughHeight, tipBlockHash, headers };
  const built = buildJHistoryRangeRuntimeInput(
    env,
    newlyObservedInputs,
    ingress.scannedThroughHeight,
    ingress.tipBlockHash,
    depositoryAddress,
    ingress.headers,
    chainId,
  );
  const observedInput = combineRuntimeInputs(newlyObservedInputs);
  const input = observedInput
    ? appendJHistoryRange(observedInput, built?.input ?? null)
    : built?.input ?? null;
  if (input) enqueueRuntimeInput(env, input);
  if (!built) return { scannedReplicaKeys: [], finalityReplicaKeys: [] };
  return {
    scannedReplicaKeys: built.scannedReplicaKeys,
    finalityReplicaKeys: built.finalityReplicaKeys,
  };
}

const enqueueJHistoryRewindScoped = (
  env: Env,
  conflictingHeight: number,
  conflictingBlockHash: string,
  requestedReplicaKeys: ReadonlySet<string> | null,
  depositoryAddress?: string,
  chainId?: number,
): string[] => {
  const watcherReplica = depositoryAddress || chainId !== undefined
    ? requireWatcherJurisdictionReplica(env, depositoryAddress, chainId, 'history-rewind')
    : findWatcherJurisdictionReplica(env, depositoryAddress, chainId);
  const runtimeTxs: RuntimeTx[] = [];
  const replicaKeys: string[] = [];
  const foundRequestedKeys = new Set<string>();
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    if (requestedReplicaKeys && !requestedReplicaKeys.has(replicaKey)) continue;
    if (requestedReplicaKeys) foundRequestedKeys.add(replicaKey);
    if (watcherReplica && !isEntityReplicaRelevantToWatcher(env, replica, watcherReplica)) {
      if (requestedReplicaKeys) throw new Error(`J_HISTORY_REWIND_TARGET_JURISDICTION_MISMATCH:${replicaKey}`);
      continue;
    }
    if (!replica.jHistory) {
      if (requestedReplicaKeys) throw new Error(`J_HISTORY_REWIND_TARGET_HISTORY_MISSING:${replicaKey}`);
      continue;
    }
    const certifiedAnchor = getEntityCertifiedJAnchor(replica.state);
    if (certifiedAnchor && replica.jHistory.scannedThroughHeight <= certifiedAnchor.height) {
      if (requestedReplicaKeys) throw new Error(`J_HISTORY_REWIND_TARGET_NOT_PRIVATE:${replicaKey}`);
      continue;
    }
    const entityId = String(replica.state.entityId || replica.entityId || '').trim().toLowerCase();
    const signerId = String(replica.signerId || '').trim().toLowerCase();
    const jurisdictionRef = getJEventJurisdictionRef(replica.state.config.jurisdiction);
    if (!entityId || !signerId) throw new Error(`J_HISTORY_REWIND_REPLICA_ID_MISSING:${replicaKey}`);
    runtimeTxs.push(markLocalJAuthorityRuntimeTx({
      type: 'rewindJHistory',
      data: {
        entityId,
        signerId,
        jurisdictionRef,
        conflictingHeight,
        conflictingBlockHash: String(conflictingBlockHash || '').trim().toLowerCase(),
      },
    }));
    replicaKeys.push(replicaKey);
  }
  if (requestedReplicaKeys) {
    for (const replicaKey of requestedReplicaKeys) {
      if (!foundRequestedKeys.has(replicaKey)) {
        throw new Error(`J_HISTORY_REWIND_TARGET_REPLICA_MISSING:${replicaKey}`);
      }
    }
  }
  if (runtimeTxs.length === 0) return [];
  enqueueRuntimeInput(env, {
    timestamp: conflictingHeight,
    runtimeTxs,
    entityInputs: [],
  });
  return replicaKeys.sort();
};

export function enqueueJHistoryRewindForReplicaKeys(
  env: Env,
  conflictingHeight: number,
  conflictingBlockHash: string,
  replicaKeys: readonly string[],
  depositoryAddress?: string,
  chainId?: number,
): string[] {
  if (replicaKeys.length === 0) throw new Error('J_HISTORY_REWIND_TARGETS_EMPTY');
  const requestedReplicaKeys = new Set(replicaKeys);
  if (requestedReplicaKeys.size !== replicaKeys.length) throw new Error('J_HISTORY_REWIND_TARGETS_DUPLICATE');
  return enqueueJHistoryRewindScoped(
    env,
    conflictingHeight,
    conflictingBlockHash,
    requestedReplicaKeys,
    depositoryAddress,
    chainId,
  );
}

export function enqueueJHistoryRewind(
  env: Env,
  conflictingHeight: number,
  conflictingBlockHash: string,
  depositoryAddress?: string,
  chainId?: number,
): string[] {
  return enqueueJHistoryRewindScoped(
    env,
    conflictingHeight,
    conflictingBlockHash,
    null,
    depositoryAddress,
    chainId,
  );
}

const normalizeManualJEvents = (events: JEvent[], label: string): RawJEvent[] => {
  if (!Array.isArray(events)) throw new Error(`J_EVENT_MANUAL_BATCH_INVALID:${label}`);
  return events.map((event, index) => {
    if (!event || typeof event.name !== 'string' || !CANONICAL_J_EVENT_SET.has(event.name)) {
      throw new Error(`J_EVENT_MANUAL_EVENT_INVALID:${label}:${index}:${String(event?.name ?? 'missing')}`);
    }
    if (!Number.isSafeInteger(event.blockNumber) || event.blockNumber < 0) {
      throw new Error(`J_EVENT_MANUAL_BLOCK_NUMBER_INVALID:${label}:${index}:${String(event.blockNumber)}`);
    }
    if (!ethers.isHexString(event.blockHash, 32)) {
      throw new Error(`J_EVENT_MANUAL_BLOCK_HASH_INVALID:${label}:${index}:${String(event.blockHash)}`);
    }
    if (!String(event.transactionHash || '').trim()) {
      throw new Error(`J_EVENT_MANUAL_TRANSACTION_HASH_MISSING:${label}:${index}`);
    }
    if (
      event.name !== 'ExternalWalletSnapshot' &&
      (!Number.isSafeInteger(event.logIndex) || Number(event.logIndex) < 0)
    ) {
      throw new Error(`J_EVENT_MANUAL_LOG_INDEX_MISSING:${label}:${index}:${event.name}`);
    }
    if (!event.args || typeof event.args !== 'object' || Array.isArray(event.args)) {
      throw new Error(`J_EVENT_MANUAL_ARGS_INVALID:${label}:${index}:${event.name}`);
    }
    return {
      name: event.name,
      args: event.args as RawJEventArgs,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      transactionHash: event.transactionHash,
      ...(event.logIndex !== undefined ? { logIndex: event.logIndex } : {}),
    };
  });
};

export function applyJEventsToEnv(
  env: Env,
  events: JEvent[],
  label: string,
  source: LocalJEventIngressSource,
): void {
  if (!events || events.length === 0) return;
  assertJEventIngressOpen(env, label);
  const rawEvents = normalizeManualJEvents(events, label);
  const input = buildJEventsRuntimeInput(env, events, label, source);
  if (!input) return;
  for (const event of rawEvents) {
    if (event.name !== 'ExternalWalletSnapshot') continue;
    const entityId = String(event.args['entityId'] ?? '').trim().toLowerCase();
    const owner = String(event.args['owner'] ?? '').trim().toLowerCase();
    if (!entityId || !/^0x[0-9a-f]{40}$/.test(owner)) {
      throw new Error(`J_EVENT_EXTERNAL_WALLET_IDENTITY_INVALID:${label}:${entityId || 'missing'}:${owner || 'missing'}`);
    }
    if (!env.runtimeState) env.runtimeState = {};
    if (!env.runtimeState.externalWalletWatchOwners) {
      env.runtimeState.externalWalletWatchOwners = new Map();
    }
    const owners = env.runtimeState.externalWalletWatchOwners.get(entityId) ?? new Map<string, number>();
    const blockNumber = Number(event.blockNumber ?? 0);
    owners.set(owner, Math.max(owners.get(owner) ?? 0, Number.isFinite(blockNumber) ? blockNumber : 0));
    env.runtimeState.externalWalletWatchOwners.set(entityId, owners);
  }
  rememberRecentJEvents(env, rawEvents);
  enqueueRuntimeInput(env, input);
}

export function buildJEventsRuntimeInput(
  env: Env,
  events: JEvent[],
  label: string,
  source: LocalJEventIngressSource,
): RuntimeInput | null {
  if (!events || events.length === 0) return null;
  assertJEventIngressOpen(env, label);
  const boundSource = bindLocalJEventIngressSource(env, source, label);
  const rawEvents = normalizeManualJEvents(events, label);

  const blockGroups = new Map<number, RawJEvent[]>();
  for (const event of rawEvents) {
    const blockNumber = Number(event.blockNumber ?? 0);
    if (!blockGroups.has(blockNumber)) blockGroups.set(blockNumber, []);
    blockGroups.get(blockNumber)!.push(event);
  }

  const txCounter: EventBatchCounter = { value: 0 };
  const runtimeTxs: RuntimeTx[] = [];
  let timestamp = 0;
  let tipBlockHash = '';
  for (const [blockNumber, groupedEvents] of blockGroups) {
    const blockHash = groupedEvents[0]?.blockHash ?? '0x';
    if (groupedEvents.some((event) => event.blockHash?.toLowerCase() !== blockHash.toLowerCase())) {
      throw new Error(`J_EVENT_MANUAL_BLOCK_HASH_MISMATCH:${label}:${blockNumber}`);
    }
    const built = buildRawJEventsRuntimeInput(env, groupedEvents.filter(isCanonicalEvent), {
      blockNumber,
      blockHash,
      adapterLabel: label,
      txCounter,
      logBatch: false,
      emitSettledDebugEvents: false,
      localSourceReplica: boundSource.replica,
      emitRange: false,
    });
    if (built?.input.runtimeTxs?.length) {
      runtimeTxs.push(...built.input.runtimeTxs);
      timestamp = Math.max(timestamp, Number(built.input.timestamp ?? 0));
      if (blockNumber === timestamp) tipBlockHash = blockHash;
    }
  }
  if (runtimeTxs.length === 0) return null;
  const observedInput: RuntimeInput = {
    timestamp,
    runtimeTxs,
    entityInputs: [],
  };
  const range = buildJHistoryRangeRuntimeInput(
    env,
    [observedInput],
    timestamp,
    tipBlockHash,
    undefined,
    [],
    undefined,
    'observed',
  );
  return appendJHistoryRange(observedInput, range?.input ?? null);
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
  watcherDepositoryAddress?: string,
  deferHistoryRange = false,
  source: 'chain' | 'synthetic' = 'synthetic',
  watcherChainId?: number,
  historicalReplicaCatchUp = false,
  localRuntimeTxs: RuntimeTx[] = [],
): RuntimeInput | null {
  // Filter to canonical events only
  const canonical = rawEvents.filter(isCanonicalEvent);
  if (canonical.length === 0) return null;
  assertJEventIngressOpen(env, adapterLabel);

  // De-duplicate ordinary watcher re-scans using canonical log identity. A
  // late replica catch-up must replay those same authenticated logs so the new
  // replica can build its own local history; already-finalized replicas reject
  // them as exact prefix no-ops instead of applying financial events twice.
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
    if (dedup.set.has(key) && !historicalReplicaCatchUp) continue;
    if (!dedup.set.has(key)) {
      dedup.set.add(key);
      dedup.order.push(key);
    }
    deduped.push(event);
  }
  while (dedup.order.length > MAX_DEDUP_LOGS) {
    const oldest = dedup.order.shift();
    if (oldest) dedup.set.delete(oldest);
  }
  if (deduped.length === 0) return null;

  const ingressBatch = jEventIngressTransform
    ? jEventIngressTransform({ rawEvents: deduped, blockNumber, blockHash })
    : { rawEvents: deduped, blockNumber, blockHash };
  if (
    !Number.isSafeInteger(ingressBatch.blockNumber) ||
    ingressBatch.blockNumber < 0 ||
    typeof ingressBatch.blockHash !== 'string' ||
    ingressBatch.rawEvents.length === 0
  ) {
    throw new Error(`J_EVENT_INGRESS_TRANSFORM_INVALID:${adapterLabel}`);
  }
  if (source === 'chain') {
    for (const event of ingressBatch.rawEvents) {
      if (Number(event.blockNumber) !== ingressBatch.blockNumber) {
        throw new Error(`J_EVENT_CHAIN_BLOCK_NUMBER_MISMATCH:${adapterLabel}`);
      }
      if (String(event.blockHash || '').toLowerCase() !== ingressBatch.blockHash.toLowerCase()) {
        throw new Error(`J_EVENT_CHAIN_BLOCK_HASH_MISMATCH:${adapterLabel}`);
      }
      // ExternalWalletSnapshot is a deterministic state read at the block tip,
      // not a Solidity log. Every actual chain log must retain its EVM order.
      if (event.name !== 'ExternalWalletSnapshot' &&
          (!Number.isSafeInteger(event.logIndex) || Number(event.logIndex) < 0)) {
        throw new Error(`J_EVENT_CHAIN_LOG_INDEX_MISSING:${adapterLabel}:${event.name}`);
      }
    }
  }

  const built = buildRawJEventsRuntimeInput(env, ingressBatch.rawEvents, {
    blockNumber: ingressBatch.blockNumber,
    blockHash: ingressBatch.blockHash,
    adapterLabel,
    txCounter,
    logBatch: !!env?.debugJWatcherBatches,
    emitSettledDebugEvents: true,
    ...(watcherDepositoryAddress ? { watcherDepositoryAddress } : {}),
    ...(watcherChainId !== undefined ? { watcherChainId } : {}),
    emitRange: false,
  });
  if (!built && localRuntimeTxs.length === 0) return null;
  if (built) rememberRecentJEvents(env, built.evidenceEvents);
  const baseInput: RuntimeInput = built?.input ?? {
    timestamp: ingressBatch.blockNumber,
    runtimeTxs: [],
    entityInputs: [],
  };
  const authenticatedInput: RuntimeInput = {
    ...baseInput,
    runtimeTxs: [...localRuntimeTxs, ...baseInput.runtimeTxs],
  };
  const range = deferHistoryRange || !built
    ? null
    : buildJHistoryRangeRuntimeInput(
      env,
      [authenticatedInput],
      ingressBatch.blockNumber,
      ingressBatch.blockHash,
      watcherDepositoryAddress,
      [],
      watcherChainId,
    );
  const input = appendJHistoryRange(authenticatedInput, range?.input ?? null);
  if (!deferHistoryRange) enqueueRuntimeInput(env, input);
  return input;
}
