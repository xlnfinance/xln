import {
  getCertifiedBoardStackKey,
} from '../../../machine/board-registry';
import {
  getEntityCertifiedJAnchor,
  getValidatorJExpectedBlockHash,
} from '../../../machine/local-history';
import type { EntityReplica } from '../../../../entity/types';
import type { RuntimeReplica } from '../../../../runtime/types';
import type { CertifiedBoardRegistryState } from '../../../../types/entity-board-registry';
import type { CertifiedRegistrationEvidence } from '../../../../types/jurisdiction-runtime';
import { assertCertifiedBoardRegistryMatchesAnchor } from '../state-anchor/rpc-board-anchor';
import { assertEntityReservesMatchAnchor, buildReserveAnchorRoot, projectNonZeroReserves } from '../state-anchor/rpc-reserve-anchor';
import { assertEntityOutDebtsMatchAnchor, describeOutDebts, projectOutDebts } from '../state-anchor/rpc-debt-anchor';
import { readDepositoryAnchorBase, type DepositoryAnchorBase } from '../state-anchor/rpc-depository-base';
import {
  buildNonceAnchorRoot,
  nonceViewFromFold,
  nonceViewFromStorage,
  readEntityActionNonces,
} from '../state-anchor/rpc-nonce-anchor';
import {
  assertBlockHashInAnchorHistory,
  assertDebtCreationProvenance,
  HISTORY_SERVE_WINDOW,
} from '../state-anchor/rpc-debt-provenance';
import {
  buildDebtAnchorRoot,
  buildEntityProvenValuesFromFold,
  buildProvenValuesRoot,
  debtViewFromStorage,
  type EntityProvenValues,
} from '../state-anchor/rpc-proven-values-root';
import {
  enqueueJHistoryRewindForReplicaKeys,
  findWatcherJurisdictionReplica,
} from '../../watcher';
import {
  assertFinalizedWatcherAnchors,
  collectTargetedWatcherRewinds,
  collectWatcherCanonicalAudit,
  type WatcherCanonicalAudit,
} from '../../watcher/observe/watcher-reconciliation';
import type {
  RpcWatcherServices,
  RpcWatcherSession,
} from './rpc-watcher-types';

type EmitWatcherDebug = (payload: Record<string, unknown>) => void;

/**
 * The node answered that it no longer serves state at `height` (Anvil beyond its
 * prune-history window): `height` lies strictly below the head it reports. Only
 * this exact answer skips that height's storage observation; a current or
 * future height, malformed proofs, hash/root/value mismatches and every other
 * failure stay fail-stop. The history fold stays authoritative either way.
 */
export const isHistoricalStateUnavailable = (error: unknown, height: number): boolean => {
  const message = new RegExp(`^BlockOutOfRangeError: block height is (\\d+) but requested was ${height}$`);
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; message?: unknown; error?: unknown; cause?: unknown };
    const match = record.code === -32602 && typeof record.message === 'string' ? message.exec(record.message) : null;
    if (match) {
      const reportedHead = Number(match[1]);
      return Number.isSafeInteger(height) && Number.isSafeInteger(reportedHead) && height < reportedHead;
    }
    current = record.error ?? record.cause;
  }
  return false;
};

/** Heights whose state the node explicitly no longer serves, shared by one audit's observations. */
type UnavailableStateHeights = Set<number>;

const observeUnlessStateUnavailable = async <T>(
  unavailable: UnavailableStateHeights,
  height: number,
  read: () => Promise<T>,
): Promise<T | null> => {
  if (unavailable.has(height)) return null;
  try {
    return await read();
  } catch (error) {
    if (!isHistoricalStateUnavailable(error, height)) throw error;
    unavailable.add(height);
    return null;
  }
};

const clearPendingRewindIfApplied = (
  session: RpcWatcherSession,
  activeEnv: RuntimeReplica,
): boolean => {
  if (session.pendingRewindReplicaKeys.length === 0) return false;
  const stillPending = session.pendingRewindReplicaKeys.some(replicaKey => {
    const replica = activeEnv.state.eReplicas.get(replicaKey);
    if (!replica?.jHistory) return false;
    const certifiedAnchor = getEntityCertifiedJAnchor(replica.state);
    return !certifiedAnchor || replica.jHistory.scannedThroughHeight > certifiedAnchor.height;
  });
  if (stillPending) return true;
  session.pendingRewindReplicaKeys = [];
  return false;
};

const enqueueTargetedRewinds = (
  session: RpcWatcherSession,
  activeEnv: RuntimeReplica,
  services: RpcWatcherServices,
  targetedRewinds: ReturnType<typeof collectTargetedWatcherRewinds>,
  emitWatcherDebug: EmitWatcherDebug,
): boolean => {
  if (targetedRewinds.size === 0) return false;
  const rewoundReplicaKeys = new Set<string>();
  for (const group of targetedRewinds.values()) {
    for (const replicaKey of enqueueJHistoryRewindForReplicaKeys(
      activeEnv,
      group.height,
      group.canonicalHash,
      group.replicaKeys,
      services.depositoryAddress,
      services.chainId,
    )) {
      rewoundReplicaKeys.add(replicaKey);
    }
  }
  session.pendingRewindReplicaKeys = [...rewoundReplicaKeys].sort();
  for (const [height, replicaKeys] of session.pendingBlocks) {
    for (const replicaKey of rewoundReplicaKeys) replicaKeys.delete(replicaKey);
    if (replicaKeys.size === 0) session.pendingBlocks.delete(height);
  }
  session.txCounter._seenLogs = { set: new Set<string>(), order: [] };
  emitWatcherDebug({
    event: 'j_watch_local_frontier_rewind_enqueued',
    replicaCount: session.pendingRewindReplicaKeys.length,
    frontiers: [...targetedRewinds.values()].map(group => ({
      height: group.height,
      canonicalBlockHash: group.canonicalHash,
      replicaCount: group.replicaKeys.length,
    })),
  });
  return true;
};

const enqueueTipRewind = (
  session: RpcWatcherSession,
  activeEnv: RuntimeReplica,
  services: RpcWatcherServices,
  canonicalTipHash: string,
  expectedTipHash: string,
  mismatchingReplicaKeys: string[],
  relevantLastFinalizedHeights: number[],
  emitWatcherDebug: EmitWatcherDebug,
): void => {
  session.pendingRewindReplicaKeys = enqueueJHistoryRewindForReplicaKeys(
    activeEnv,
    session.lastSyncedBlock,
    canonicalTipHash,
    mismatchingReplicaKeys,
    services.depositoryAddress,
    services.chainId,
  );
  if (session.pendingRewindReplicaKeys.length === 0) {
    throw new Error(`J_HISTORY_REORG_WITHOUT_REWINDABLE_SUFFIX:${session.lastSyncedBlock}`);
  }
  session.pendingBlocks.clear();
  session.txCounter._seenLogs = { set: new Set<string>(), order: [] };
  session.lastSyncedBlock = Math.max(0, Math.min(...relevantLastFinalizedHeights));
  emitWatcherDebug({
    event: 'j_watch_reorg_rewind_enqueued',
    conflictingHeight: session.lastSyncedBlock,
    expectedBlockHash: expectedTipHash,
    canonicalBlockHash: canonicalTipHash,
    rewindToHeight: session.lastSyncedBlock,
    replicaCount: session.pendingRewindReplicaKeys.length,
  });
};

/**
 * Each distinct finalized certified-board registry must equal EntityProvider
 * storage at its block, with the stateRoot bound to the canonical header hash.
 * Observation only; the history fold stays authoritative. TRON exposes no state
 * trie, so it keeps the full-history guarantee alone.
 */
const assertBoardRegistriesMatchStorage = async (
  session: RpcWatcherSession,
  replicas: readonly EntityReplica[],
  canonicalHeaders: ReadonlyMap<number, string>,
  services: RpcWatcherServices,
  unavailable: UnavailableStateHeights,
): Promise<Map<EntityReplica, string>> => {
  const replicaKeys = new Map<EntityReplica, string>();
  if (services.mode !== 'rpc' && services.mode !== 'anvil') return replicaKeys;
  const registries = new Map<string, CertifiedBoardRegistryState>();
  for (const replica of replicas) {
    const registry = replica.state.certifiedBoardState;
    if (!registry || registry.finalizedJHeight <= 0) continue;
    const auditKey = `${registry.finalizedJHeight}:${registry.finalizedJBlockHash}:${registry.boardRegistryRoot}`;
    registries.set(auditKey, registry);
    replicaKeys.set(replica, auditKey);
  }
  const jurisdiction = {
    chainId: services.chainId,
    depositoryAddress: services.depositoryAddress,
    entityProviderAddress: services.entityProviderAddress,
  };
  const audits = new Map<string, string>();
  for (const [auditKey, registry] of registries) {
    const proven = session.boardAnchorAudits.get(auditKey);
    if (proven) {
      audits.set(auditKey, proven);
      continue;
    }
    const canonicalHash = canonicalHeaders.get(registry.finalizedJHeight);
    if (!canonicalHash) throw new Error(`J_BOARD_ANCHOR_HEADER_MISSING:height=${registry.finalizedJHeight}`);
    const anchor = await observeUnlessStateUnavailable(unavailable, registry.finalizedJHeight, () =>
      assertCertifiedBoardRegistryMatchesAnchor({
        send: (method, params) => services.provider.send(method, params),
        jurisdiction,
        registry,
        authenticatedBlockHash: canonicalHash,
      }));
    if (anchor) audits.set(auditKey, anchor.root);
  }
  session.boardAnchorAudits = audits;
  return replicaKeys;
};

/**
 * One Depository proof base (hash-bound stateRoot + proven _tokens.length) per
 * audited block, shared by the reserve and out-debt audits of one poll.
 */
type DepositoryBases = (height: number, canonicalHash: string) => Promise<DepositoryAnchorBase>;

const createDepositoryBases = (services: RpcWatcherServices): DepositoryBases => {
  const bases = new Map<string, Promise<DepositoryAnchorBase>>();
  return (height, canonicalHash) => {
    const key = `${height}:${canonicalHash.toLowerCase()}`;
    const cached = bases.get(key);
    if (cached) return cached;
    const base = readDepositoryAnchorBase({
      send: (method, params) => services.provider.send(method, params),
      depositoryAddress: services.depositoryAddress,
      blockNumber: height,
      authenticatedBlockHash: canonicalHash,
      fail: (code, detail = '') => {
        throw new Error(`J_DEPOSITORY_ANCHOR_${code}${detail ? `:${detail}` : ''}`);
      },
    });
    bases.set(key, base);
    return base;
  };
};

/**
 * Entity reserves at each distinct finalized J block must equal Depository
 * storage there, under the same header-hash binding. Reserves change only by
 * finalized ReserveUpdated/AccountSettled events, so the certified anchor is
 * the block they describe. Observation only, Ethereum-RPC only, like boards.
 */
const assertEntityReservesMatchStorage = async (
  session: RpcWatcherSession,
  replicas: readonly EntityReplica[],
  canonicalHeaders: ReadonlyMap<number, string>,
  services: RpcWatcherServices,
  depositoryBases: DepositoryBases,
  unavailable: UnavailableStateHeights,
): Promise<Map<EntityReplica, string>> => {
  const replicaKeys = new Map<EntityReplica, string>();
  if (services.mode !== 'rpc' && services.mode !== 'anvil') return replicaKeys;
  type Audited ={ auditKey: string; entityId: string; reserves: ReadonlyMap<number, bigint> };
  const groups = new Map<string, { height: number; entities: Audited[] }>();
  const audits = new Map<string, { root: string; tokenCount: bigint; batchNonce: bigint }>();
  for (const replica of replicas) {
    const anchor = getEntityCertifiedJAnchor(replica.state);
    if (!anchor) continue;
    const reserves = projectNonZeroReserves(replica.state.reserves);
    const tokens = [...reserves].sort(([left], [right]) => left - right).map(([tokenId, balance]) => `${tokenId}=${balance}`);
    // The reserve chunk also proves entityNonces; the fold's nonce keys the audit.
    const batchNonce = nonceViewFromFold(replica.state).batchNonce;
    const auditKey = `${anchor.height}:${anchor.hash}:${replica.state.entityId.toLowerCase()}:${tokens.join(',')}:nonce=${batchNonce}`;
    replicaKeys.set(replica, auditKey);
    const proven = session.reserveAnchorAudits.get(auditKey);
    if (proven) {
      audits.set(auditKey, proven);
      continue;
    }
    const groupKey = `${anchor.height}:${anchor.hash}`;
    const group = groups.get(groupKey) ?? { height: anchor.height, entities: [] };
    group.entities.push({ auditKey, entityId: replica.state.entityId, reserves });
    groups.set(groupKey, group);
  }
  for (const group of groups.values()) {
    const canonicalHash = canonicalHeaders.get(group.height);
    if (!canonicalHash) throw new Error(`J_RESERVE_ANCHOR_HEADER_MISSING:height=${group.height}`);
    const anchor = await observeUnlessStateUnavailable(unavailable, group.height, async () =>
      assertEntityReservesMatchAnchor({
        send: (method, params) => services.provider.send(method, params),
        jurisdiction: { depositoryAddress: services.depositoryAddress },
        blockNumber: group.height,
        authenticatedBlockHash: canonicalHash,
        base: await depositoryBases(group.height, canonicalHash),
        entities: group.entities,
      }));
    if (!anchor) continue;
    for (const entity of group.entities) {
      const entityId = entity.entityId.toLowerCase();
      const stored = anchor.reserves.get(entityId);
      const batchNonce = anchor.batchNonces.get(entityId);
      if (!stored || batchNonce === undefined) throw new Error(`J_RESERVE_ANCHOR_ENTITY_MISSING:${group.height}:${entityId}`);
      audits.set(entity.auditKey, {
        root: buildReserveAnchorRoot(anchor.tokenCount, new Map([[entityId, stored]])),
        tokenCount: anchor.tokenCount,
        batchNonce,
      });
    }
  }
  session.reserveAnchorAudits = audits;
  return replicaKeys;
};

// Same contract as the reserve audit for the open out-debt ledger (D2): queue
// entries, aggregate and active count at the fenced finalized block, plus the
// creditor-side open in-debt count against inActiveDebts. In-debt identity and
// DebtEntry provenance stay history-only.
const assertEntityOutDebtsMatchStorage = async (
  session: RpcWatcherSession,
  replicas: readonly EntityReplica[],
  canonicalHeaders: ReadonlyMap<number, string>,
  services: RpcWatcherServices,
  depositoryBases: DepositoryBases,
  unavailable: UnavailableStateHeights,
): Promise<Map<EntityReplica, string>> => {
  const replicaKeys = new Map<EntityReplica, string>();
  if (services.mode !== 'rpc' && services.mode !== 'anvil') return replicaKeys;
  type State =EntityReplica['state'];
  type Ledgers = { auditKey: string; entityId: string; outDebtsByToken: State['outDebtsByToken']; inDebtsByToken: State['inDebtsByToken'] };
  const groups = new Map<string, { height: number; entities: Ledgers[] }>();
  const audits = new Map<string, string>();
  for (const replica of replicas) {
    const anchor = getEntityCertifiedJAnchor(replica.state);
    if (!anchor) continue;
    const ledger = describeOutDebts(projectOutDebts(replica.state.entityId, replica.state.outDebtsByToken));
    let inCount = 0;
    for (const bucket of replica.state.inDebtsByToken?.values() ?? []) inCount += bucket.size;
    const auditKey = `${anchor.height}:${anchor.hash}:${replica.state.entityId.toLowerCase()}:${ledger}:in=${inCount}`;
    replicaKeys.set(replica, auditKey);
    const proven = session.debtAnchorAudits.get(auditKey);
    if (proven) {
      audits.set(auditKey, proven);
      continue;
    }
    const groupKey = `${anchor.height}:${anchor.hash}`;
    const group = groups.get(groupKey) ?? { height: anchor.height, entities: [] };
    group.entities.push({
      auditKey,
      entityId: replica.state.entityId,
      outDebtsByToken: replica.state.outDebtsByToken,
      inDebtsByToken: replica.state.inDebtsByToken,
    });
    groups.set(groupKey, group);
  }
  for (const group of groups.values()) {
    const canonicalHash = canonicalHeaders.get(group.height);
    if (!canonicalHash) throw new Error(`J_DEBT_ANCHOR_HEADER_MISSING:height=${group.height}`);
    const anchor = await observeUnlessStateUnavailable(unavailable, group.height, async () =>
      assertEntityOutDebtsMatchAnchor({
        send: (method, params) => services.provider.send(method, params),
        jurisdiction: { depositoryAddress: services.depositoryAddress },
        blockNumber: group.height,
        authenticatedBlockHash: canonicalHash,
        base: await depositoryBases(group.height, canonicalHash),
        entities: group.entities,
      }));
    if (!anchor) continue;
    for (const entity of group.entities) {
      audits.set(entity.auditKey, buildDebtAnchorRoot(debtViewFromStorage(anchor, entity.entityId)));
    }
  }
  session.debtAnchorAudits = audits;
  return replicaKeys;
};

/**
 * EntityProvider entityActionNonces of each audited Entity at its certified J
 * block, one proof per block under the shared hash-bound stateRoot. The board
 * proof covers only numbered entities, so lazy wallet Entities need this one.
 * Keyed by the fold's action nonce: an unchanged nonce is not re-proven. The
 * proven-values root compares it with the fold.
 */
const readEntityActionNoncesFromStorage = async (
  session: RpcWatcherSession,
  replicas: readonly EntityReplica[],
  canonicalHeaders: ReadonlyMap<number, string>,
  services: RpcWatcherServices,
  depositoryBases: DepositoryBases,
  unavailable: UnavailableStateHeights,
): Promise<Map<EntityReplica, string>> => {
  const replicaKeys = new Map<EntityReplica, string>();
  if (services.mode !== 'rpc' && services.mode !== 'anvil') return replicaKeys;
  const groups = new Map<string, { height: number; entities: Array<{ auditKey: string; entityId: string }> }>();
  const audits = new Map<string, bigint>();
  for (const replica of replicas) {
    const anchor = getEntityCertifiedJAnchor(replica.state);
    if (!anchor) continue;
    const entityId = replica.state.entityId.toLowerCase();
    const auditKey = `${anchor.height}:${anchor.hash}:${entityId}:${String(nonceViewFromFold(replica.state).actionNonce)}`;
    replicaKeys.set(replica, auditKey);
    const proven = session.actionNonceAudits.get(auditKey);
    if (proven !== undefined) {
      audits.set(auditKey, proven);
      continue;
    }
    const groupKey = `${anchor.height}:${anchor.hash}`;
    const group = groups.get(groupKey) ?? { height: anchor.height, entities: [] };
    if (!group.entities.some(entity => entity.auditKey === auditKey)) group.entities.push({ auditKey, entityId });
    groups.set(groupKey, group);
  }
  for (const group of groups.values()) {
    const canonicalHash = canonicalHeaders.get(group.height);
    if (!canonicalHash) throw new Error(`J_NONCE_ANCHOR_HEADER_MISSING:height=${group.height}`);
    const stored = await observeUnlessStateUnavailable(unavailable, group.height, async () =>
      readEntityActionNonces({
        send: (method, params) => services.provider.send(method, params),
        entityProviderAddress: services.entityProviderAddress,
        blockNumber: group.height,
        stateRoot: (await depositoryBases(group.height, canonicalHash)).stateRoot,
        entityIds: [...new Set(group.entities.map(entity => entity.entityId))],
      }));
    if (!stored) continue;
    for (const entity of group.entities) {
      const actionNonce = stored.get(entity.entityId);
      if (actionNonce === undefined) throw new Error(`J_NONCE_ANCHOR_ENTITY_MISSING:${group.height}:${entity.entityId}`);
      audits.set(entity.auditKey, actionNonce);
    }
  }
  session.actionNonceAudits = audits;
  return replicaKeys;
};

/**
 * Each open DebtEntry's creation (createdTxHash at a transactionsRoot index, its
 * receipt and the one DebtCreated carrying createdSeq) is proven under the
 * creation header, whose hash the certified anchor's EIP-2935 history slot
 * records. Entries older than that window stay history-only. Observation, the
 * history fold stays authoritative.
 */
const assertEntityDebtProvenance = async (
  session: RpcWatcherSession,
  replicas: readonly EntityReplica[],
  canonicalHeaders: ReadonlyMap<number, string>,
  services: RpcWatcherServices,
  emitWatcherDebug: EmitWatcherDebug,
  unavailable: ReadonlySet<number>,
): Promise<void> => {
  if (services.mode !== 'rpc' && services.mode !== 'anvil') return;
  const send = (method: string, params: unknown[]) => services.provider.send(method, params);
  const audits = new Set<string>();
  let proven = 0;
  let outOfWindow = 0;
  for (const replica of replicas) {
    const anchor = getEntityCertifiedJAnchor(replica.state);
    if (!anchor || unavailable.has(anchor.height)) continue;
    const anchorHash = canonicalHeaders.get(anchor.height);
    if (!anchorHash) throw new Error(`J_DEBT_PROVENANCE_HEADER_MISSING:height=${anchor.height}`);
    const buckets = [...(replica.state.outDebtsByToken?.values() ?? []), ...(replica.state.inDebtsByToken?.values() ?? [])];
    for (const entry of buckets.flatMap(bucket => [...bucket.values()])) {
      if (entry.createdAtBlock > anchor.height) {
        throw new Error(`J_DEBT_PROVENANCE_AFTER_ANCHOR:${entry.debtId}:${entry.createdAtBlock}:${anchor.height}`);
      }
      if (anchor.height - entry.createdAtBlock > HISTORY_SERVE_WINDOW) {
        outOfWindow += 1;
        continue;
      }
      let blockHash = entry.createdAtBlock === anchor.height ? anchorHash : canonicalHeaders.get(entry.createdAtBlock);
      if (!blockHash) {
        const block = (await send('eth_getBlockByNumber', [`0x${entry.createdAtBlock.toString(16)}`, false])) as { hash?: unknown } | null;
        if (typeof block?.hash !== 'string') throw new Error(`J_DEBT_PROVENANCE_BLOCK_MISSING:${entry.createdAtBlock}`);
        blockHash = block.hash.toLowerCase();
      }
      const linkKey = `link:${anchor.height}:${anchorHash}:${entry.createdAtBlock}:${blockHash}`;
      if (entry.createdAtBlock !== anchor.height && !session.debtProvenanceAudits.has(linkKey) && !audits.has(linkKey)) {
        await assertBlockHashInAnchorHistory(send, { blockNumber: anchor.height, blockHash: anchorHash }, entry.createdAtBlock, blockHash);
      }
      audits.add(linkKey);
      const creationKey = [
        'created', entry.debtId, entry.createdAtBlock, blockHash, entry.createdTxHash, entry.createdSeq,
        entry.createdAmount, entry.createdDebtIndex, entry.debtor, entry.creditor, entry.tokenId,
      ].join(':').toLowerCase();
      if (!session.debtProvenanceAudits.has(creationKey) && !audits.has(creationKey)) {
        await assertDebtCreationProvenance({
          send, sendBatch: calls => services.sendAuthenticatedBatch(calls),
          depository: services.depositoryAddress, authenticatedBlockHash: blockHash, entry,
        });
        proven += 1;
      }
      audits.add(creationKey);
    }
  }
  session.debtProvenanceAudits = audits;
  if (proven > 0 || outOfWindow > 0) emitWatcherDebug({ event: 'j_watch_debt_provenance', proven, outOfWindow });
};

/**
 * Per replica, the proven-values root of its fold at the certified J block must
 * equal the root over the storage values the board, reserve, debt and action
 * nonce audits proved at that block. Reuses those proofs: no extra eth_getProof. Kept in
 * process memory only; observation, the history fold stays authoritative.
 */
const assertEntityProvenValuesMatchStorage = (
  session: RpcWatcherSession,
  entries: ReadonlyArray<readonly [string, EntityReplica]>,
  canonicalHeaders: ReadonlyMap<number, string>,
  services: RpcWatcherServices,
  keys: {
    board: ReadonlyMap<EntityReplica, string>;
    reserve: ReadonlyMap<EntityReplica, string>;
    debt: ReadonlyMap<EntityReplica, string>;
    actionNonce: ReadonlyMap<EntityReplica, string>;
  },
  emitWatcherDebug: EmitWatcherDebug,
  unavailable: ReadonlySet<number>,
): void => {
  if (services.mode !== 'rpc' && services.mode !== 'anvil') return;
  const jurisdiction = {
    chainId: services.chainId,
    depositoryAddress: services.depositoryAddress,
    entityProviderAddress: services.entityProviderAddress,
  };
  const proven = new Map<string, EntityProvenValues>();
  const changed: Array<{ entityId: string; height: number; root: string }> = [];
  for (const [replicaKey, replica] of entries) {
    const anchor = getEntityCertifiedJAnchor(replica.state);
    if (!anchor || unavailable.has(anchor.height)) continue;
    const registry = replica.state.certifiedBoardState;
    if (!registry || registry.finalizedJHeight !== anchor.height
      || registry.finalizedJBlockHash.toLowerCase() !== anchor.hash.toLowerCase()) {
      throw new Error(`J_PROVEN_VALUES_ANCHOR_SPLIT:${replicaKey}:${anchor.height}:${String(registry?.finalizedJHeight)}`);
    }
    const boardRoot = session.boardAnchorAudits.get(keys.board.get(replica) ?? '');
    const reserve = session.reserveAnchorAudits.get(keys.reserve.get(replica) ?? '');
    const debtRoot = session.debtAnchorAudits.get(keys.debt.get(replica) ?? '');
    const actionNonce = session.actionNonceAudits.get(keys.actionNonce.get(replica) ?? '');
    const canonicalHash = canonicalHeaders.get(anchor.height);
    if (!boardRoot || !reserve || !debtRoot || actionNonce === undefined || !canonicalHash) {
      throw new Error(`J_PROVEN_VALUES_COMPONENT_MISSING:${replicaKey}:${anchor.height}`);
    }
    const storage = buildProvenValuesRoot({
      jurisdiction,
      entityId: replica.state.entityId,
      blockNumber: anchor.height,
      blockHash: canonicalHash,
      boardRegistryRoot: boardRoot,
      reserveRoot: reserve.root,
      debtRoot,
      nonceRoot: buildNonceAnchorRoot([nonceViewFromStorage(replica.state.entityId, reserve.batchNonce, actionNonce)]),
    });
    const fold = buildEntityProvenValuesFromFold(replica.state, jurisdiction, reserve.tokenCount);
    if (fold.root !== storage.root) {
      throw new Error(`J_PROVEN_VALUES_ROOT_MISMATCH:${replicaKey}:${anchor.height}:fold=${fold.root}:storage=${storage.root}`);
    }
    proven.set(replicaKey, storage);
    if (session.provenValues.get(replicaKey)?.root !== storage.root) {
      changed.push({ entityId: storage.entityId, height: storage.blockNumber, root: storage.root });
    }
  }
  session.provenValues = proven;
  if (changed.length > 0) emitWatcherDebug({ event: 'j_watch_proven_values', entities: changed });
};

type CanonicalTipPlan =
  | { kind: 'none' }
  | { kind: 'rewind-pending' }
  | { kind: 'audit'; audit: WatcherCanonicalAudit }
  | { kind: 'failed'; error: unknown };

// Read-only except for clearing an already-applied rewind; a local planning
// failure is held so it still surfaces after the authority check.
const planWatcherCanonicalTip = (
  session: RpcWatcherSession,
  activeEnv: RuntimeReplica,
  services: RpcWatcherServices,
): CanonicalTipPlan => {
  try {
    if (clearPendingRewindIfApplied(session, activeEnv)) return { kind: 'rewind-pending' };
    if (session.lastSyncedBlock <= 0) return { kind: 'none' };
    const watcherReplica = findWatcherJurisdictionReplica(
      activeEnv,
      services.depositoryAddress,
      services.chainId,
    );
    if (!watcherReplica) return { kind: 'none' };
    const audit = collectWatcherCanonicalAudit(activeEnv, watcherReplica, session.lastSyncedBlock);
    if (audit.relevantReplicas.length === 0) return { kind: 'none' };
    return { kind: 'audit', audit };
  } catch (error) {
    return { kind: 'failed', error };
  }
};

const pickHeaders = (
  headers: ReadonlyMap<number, string>,
  heights: readonly number[],
): Map<number, string> => new Map(heights.flatMap(height => {
  const hash = headers.get(height);
  return hash === undefined ? [] : [[height, hash] as const];
}));

/**
 * Reconciles only authenticated local history. A detected reorg is converted
 * into deterministic Runtime ingress; this adapter never edits Entity state.
 */
const reconcileAuditedCanonicalTip = async (
  session: RpcWatcherSession,
  activeEnv: RuntimeReplica,
  services: RpcWatcherServices,
  audit: WatcherCanonicalAudit,
  canonicalHeaders: ReadonlyMap<number, string>,
  emitWatcherDebug: EmitWatcherDebug,
): Promise<boolean> => {
  assertFinalizedWatcherAnchors(audit, canonicalHeaders, services.chainId);
  const unavailable: UnavailableStateHeights = new Set();
  const replicas = audit.relevantReplicas;
  const board = await assertBoardRegistriesMatchStorage(session, replicas, canonicalHeaders, services, unavailable);
  const depositoryBases = createDepositoryBases(services);
  const reserve = await assertEntityReservesMatchStorage(session, replicas, canonicalHeaders, services, depositoryBases, unavailable);
  const debt = await assertEntityOutDebtsMatchStorage(session, replicas, canonicalHeaders, services, depositoryBases, unavailable);
  const actionNonce = await readEntityActionNoncesFromStorage(
    session, replicas, canonicalHeaders, services, depositoryBases, unavailable,
  );
  await assertEntityDebtProvenance(session, replicas, canonicalHeaders, services, emitWatcherDebug, unavailable);
  assertEntityProvenValuesMatchStorage(
    session,
    audit.relevantReplicaEntries,
    canonicalHeaders,
    services,
    { board, reserve, debt, actionNonce },
    emitWatcherDebug,
    unavailable,
  );
  if (unavailable.size > 0) {
    emitWatcherDebug({ event: 'j_watch_anchor_state_unavailable', heights: [...unavailable].sort((left, right) => left - right) });
  }
  const targetedRewinds = collectTargetedWatcherRewinds(
    audit,
    canonicalHeaders,
    services.chainId,
  );
  if (enqueueTargetedRewinds(session, activeEnv, services, targetedRewinds, emitWatcherDebug)) {
    return true;
  }

  const expectedTipHashes = new Set(
    audit.relevantReplicas
      .map(replica => getValidatorJExpectedBlockHash(
        replica.state,
        replica.jHistory,
        session.lastSyncedBlock,
      ))
      .filter((hash): hash is string => Boolean(hash)),
  );
  if (expectedTipHashes.size === 0) return false;
  if (expectedTipHashes.size !== 1) {
    throw new Error(`J_HISTORY_LOCAL_TIP_DIVERGENCE:height=${session.lastSyncedBlock}`);
  }
  const canonicalTipHash = canonicalHeaders.get(session.lastSyncedBlock);
  if (!canonicalTipHash) {
    throw new Error(`J_HISTORY_HEADER_MISSING:height=${session.lastSyncedBlock}`);
  }
  const expectedTipHash = [...expectedTipHashes][0]!;
  if (canonicalTipHash === expectedTipHash) return false;
  const mismatchingReplicaKeys = audit.relevantReplicaEntries.flatMap(([replicaKey, replica]) =>
    getValidatorJExpectedBlockHash(replica.state, replica.jHistory, session.lastSyncedBlock) === expectedTipHash
      ? [replicaKey]
      : [],
  );
  if (mismatchingReplicaKeys.length === 0) {
    throw new Error(`J_HISTORY_REORG_WITHOUT_REWINDABLE_SUFFIX:${session.lastSyncedBlock}`);
  }
  enqueueTipRewind(
    session,
    activeEnv,
    services,
    canonicalTipHash,
    expectedTipHash,
    mismatchingReplicaKeys,
    audit.relevantReplicas.map(replica => Number(replica.state.lastFinalizedJHeight || 0)),
    emitWatcherDebug,
  );
  return true;
};

const collectAuthorityEvidence = (
  activeEnv: RuntimeReplica,
  services: RpcWatcherServices,
): CertifiedRegistrationEvidence[] => {
  const stackKey = getCertifiedBoardStackKey({
    chainId: services.chainId,
    depositoryAddress: services.depositoryAddress,
    entityProviderAddress: services.entityProviderAddress,
  });
  return Array.from(
    activeEnv.infrastructure?.certifiedRegistrationEvidence?.values() ?? [],
  ).filter(candidate => candidate.stackKey === stackKey);
};

const assertAuthorityEvidenceHeaders = (
  session: RpcWatcherSession,
  evidence: readonly CertifiedRegistrationEvidence[],
  currentHead: number,
  canonicalHeaders: ReadonlyMap<number, string>,
): void => {
  const currentHash = canonicalHeaders.get(currentHead);
  if (!currentHash) throw new Error(`J_AUTHORITY_HEAD_HEADER_MISSING:${currentHead}`);
  const auditKey = `${currentHead}:${currentHash}:${evidence.length}`;
  if (session.lastAuthorityAuditKey === auditKey) return;
  if (evidence.length === 0) {
    session.lastAuthorityAuditKey = auditKey;
    return;
  }
  for (const candidate of evidence) {
    const activationHash = canonicalHeaders.get(candidate.activationHeight);
    if (activationHash !== candidate.blockHash) {
      throw new Error(
        `J_AUTHORITY_FINALIZED_REORG:entity=${candidate.entityId}:` +
        `height=${candidate.activationHeight}:expected=${candidate.blockHash}:` +
        `canonical=${activationHash ?? 'missing'}`,
      );
    }
    const tipHash = canonicalHeaders.get(candidate.observedThroughHeight);
    if (tipHash !== candidate.observedTipBlockHash) {
      throw new Error(
        `J_AUTHORITY_FINALITY_TIP_REORG:entity=${candidate.entityId}:` +
        `height=${candidate.observedThroughHeight}:` +
        `expected=${candidate.observedTipBlockHash}:canonical=${tipHash ?? 'missing'}`,
      );
    }
  }
  session.lastAuthorityAuditKey = auditKey;
};

/**
 * One poll's canonical audit: the authority evidence check, then local tip
 * reconciliation. The head, every evidence height and every local audit
 * height share one header batch, so each check sees exactly the headers it
 * read before, in the same order, for one round trip instead of two.
 */
export const auditWatcherCanonicalState = async (
  session: RpcWatcherSession,
  activeEnv: RuntimeReplica,
  currentHead: number,
  services: RpcWatcherServices,
  emitWatcherDebug: EmitWatcherDebug,
): Promise<boolean> => {
  const evidence = collectAuthorityEvidence(activeEnv, services);
  const authorityHeights = [
    currentHead,
    ...evidence.flatMap(candidate => [candidate.activationHeight, candidate.observedThroughHeight]),
  ];
  const plan = planWatcherCanonicalTip(session, activeEnv, services);
  const auditHeights = plan.kind === 'audit' ? plan.audit.auditHeights : [];
  const headers = new Map(
    (await services.readBlockHeaders([...authorityHeights, ...auditHeights]))
      .map(header => [header.jHeight, header.jBlockHash]),
  );
  assertAuthorityEvidenceHeaders(session, evidence, currentHead, pickHeaders(headers, authorityHeights));
  if (plan.kind === 'failed') throw plan.error;
  if (plan.kind === 'rewind-pending') return true;
  if (plan.kind === 'none') return false;
  return reconcileAuditedCanonicalTip(
    session,
    activeEnv,
    services,
    plan.audit,
    pickHeaders(headers, auditHeights),
    emitWatcherDebug,
  );
};
