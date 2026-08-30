import { encodeCanonicalConsensusBytes } from '../../protocol/serialization/binary-codec';
import { keccakBytesHash } from '../../protocol/crypto/keccak-text';

import { LIMITS } from '../../config/constants';
import type { ConsensusConfig, EntityState, ProposalAction } from '../types';
import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { EntityTx } from '../../types/entity-tx';
import { isCrossJurisdictionTerminalStatus } from '../../extensions/cross-j';
import { EntityCommandRejectionError } from '../tx/processing/invariant-errors';

import { assertNoConsensusVisibleHtlcPaymentSecrets } from '../../protocol/htlc/consensus-secret-guard';
import {
  crossJurisdictionRouteSigner,
  isCrossJurisdictionRouteParticipant,
} from '../../extensions/cross-j/boundary';

const ENTITY_PROPOSAL_ACTION_DOMAIN = 'xln:entity-proposal-action:v1' as const;

export const canonicalEntityBoardSignerId = (
  value: unknown,
  missingCode = 'ENTITY_BOARD_SIGNER_ID_REQUIRED',
): string => {
  const signerId = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!signerId) throw new Error(missingCode);
  return signerId;
};

/**
 * Canonical board power is consensus authority. Never index config.shares with
 * a normalized signer directly: mixed-case EOAs and duplicate canonical keys
 * can otherwise turn valid members into zero-power voters or count one member
 * twice on different replay implementations.
 */
export const resolveCanonicalEntityBoardShares = (
  config: ConsensusConfig,
): Readonly<{ bySigner: ReadonlyMap<string, bigint>; total: bigint }> => {
  if (config.validators.length < 1 || config.validators.length > LIMITS.MAX_VALIDATORS) {
    throw new Error(`ENTITY_BOARD_SIZE_INVALID:${config.validators.length}`);
  }
  const validators = new Set<string>();
  for (const rawSignerId of config.validators) {
    const signerId = canonicalEntityBoardSignerId(rawSignerId);
    if (validators.has(signerId)) throw new Error(`ENTITY_BOARD_DUPLICATE_VALIDATOR:${signerId}`);
    validators.add(signerId);
  }

  const bySigner = new Map<string, bigint>();
  for (const [rawSignerId, share] of Object.entries(config.shares)) {
    const signerId = canonicalEntityBoardSignerId(rawSignerId);
    if (bySigner.has(signerId)) throw new Error(`ENTITY_BOARD_DUPLICATE_SHARE:${signerId}`);
    if (!validators.has(signerId)) throw new Error(`ENTITY_BOARD_UNKNOWN_SHARE:${signerId}`);
    if (typeof share !== 'bigint' || share <= 0n) {
      throw new Error(`ENTITY_BOARD_SHARE_INVALID:${signerId}:${String(share)}`);
    }
    bySigner.set(signerId, share);
  }
  for (const signerId of validators) {
    if (!bySigner.has(signerId)) throw new Error(`ENTITY_BOARD_SHARE_MISSING:${signerId}`);
  }
  const total = Array.from(bySigner.values()).reduce((sum, share) => sum + share, 0n);
  if (typeof config.threshold !== 'bigint' || config.threshold <= 0n || config.threshold > total) {
    throw new Error(`ENTITY_BOARD_THRESHOLD_INVALID:${String(config.threshold)}:${total.toString()}`);
  }
  return { bySigner, total };
};

const protocolTxTypes = new Set<EntityTx['type']>([
  'boardHandover',
  'entityCommand',
  'runtimeOutput',
  'scheduledWake',
  'j_event',
  'accountInput',
]);

const individualTxTypes = new Set<EntityTx['type']>([
  'chat',
  'materializeCrossJurisdictionClear',
  'materializeCrossJurisdictionSwap',
  'propose',
  'vote',
]);

/**
 * Exact next-frame work emitted by a certified Entity frame back to itself.
 *
 * These are control continuations, not a second command lane: the producing
 * frame already committed their bytes, Runtime only carries them across its
 * WAL boundary, and every handler revalidates current state before mutation.
 * Never add ordinary user/financial commands here.
 */
const selfRuntimeContinuationTxTypes = new Set<EntityTx['type']>([
  'disputeFinalize',
  'j_abort_sent_batch',
  'j_broadcast',
  'orderbookSweepCrossJurisdiction',
  'prepareDispute',
  'processHtlcTimeouts',
  'requestCrossJurisdictionClear',
  'settle_execute',
  'settle_propose',
]);

export const isEntityProtocolTx = (tx: EntityTx): boolean => protocolTxTypes.has(tx.type);

/** Security allowlist: new EntityTx variants are collective until explicitly reviewed. */
export const isIndividualEntityCommandTx = (tx: EntityTx): boolean => individualTxTypes.has(tx.type);

export const isCollectiveEntityActionTx = (tx: EntityTx): boolean =>
  !isEntityProtocolTx(tx) && !isIndividualEntityCommandTx(tx);

const assertTxBatchShape: (txs: unknown, code: string) => asserts txs is EntityTx[] = (txs, code) => {
  if (!Array.isArray(txs) || txs.length === 0 || txs.length > LIMITS.MEMPOOL_SIZE) {
    throw new Error(`${code}_TX_COUNT_INVALID:${Array.isArray(txs) ? txs.length : 'not-array'}`);
  }
  for (const tx of txs) {
    if (!tx || typeof tx !== 'object' || typeof (tx as { type?: unknown }).type !== 'string') {
      throw new Error(`${code}_TX_INVALID`);
    }
  }
  const byteLength = encodeCanonicalConsensusBytes({
    domain: ENTITY_PROPOSAL_ACTION_DOMAIN,
    txs,
  }).byteLength;
  if (byteLength > LIMITS.MAX_FRAME_SIZE_BYTES) {
    throw new Error(`${code}_BYTE_LIMIT_EXCEEDED:${byteLength}:${LIMITS.MAX_FRAME_SIZE_BYTES}`);
  }
};

const hashCollectiveEntityActionTxs = (txs: EntityTx[]): string => {
  assertNoConsensusVisibleHtlcPaymentSecrets(txs);
  assertTxBatchShape(txs, 'ENTITY_COLLECTIVE_ACTION');
  for (const tx of txs) {
    if (!isCollectiveEntityActionTx(tx)) {
      throw new Error(`ENTITY_COLLECTIVE_ACTION_TX_FORBIDDEN:${tx.type}`);
    }
  }
  return keccakBytesHash(encodeCanonicalConsensusBytes({
    domain: ENTITY_PROPOSAL_ACTION_DOMAIN,
    version: 1,
    txs,
  }));
};

export const buildEntityTransactionProposalAction = (
  txs: EntityTx[],
): Extract<ProposalAction, { type: 'entity_transaction' }> => ({
  type: 'entity_transaction',
  data: {
    version: 1,
    actionHash: hashCollectiveEntityActionTxs(txs),
    txs: structuredClone(txs),
  },
});

export const assertEntityProposalAction = (value: unknown): ProposalAction => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ENTITY_PROPOSAL_ACTION_INVALID');
  }
  const action = value as Record<string, unknown>;
  if (Object.keys(action).sort().join(',') !== 'data,type') {
    throw new Error('ENTITY_PROPOSAL_ACTION_FIELDS_INVALID');
  }
  if (action['type'] === 'collective_message') {
    const data = action['data'];
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('ENTITY_PROPOSAL_MESSAGE_DATA_INVALID');
    }
    const messageData = data as Record<string, unknown>;
    if (Object.keys(messageData).join(',') !== 'message' || typeof messageData['message'] !== 'string') {
      throw new Error('ENTITY_PROPOSAL_MESSAGE_DATA_INVALID');
    }
    return { type: 'collective_message', data: { message: messageData['message'] } };
  }
  if (action['type'] !== 'entity_transaction') {
    throw new Error(`ENTITY_PROPOSAL_ACTION_TYPE_INVALID:${String(action['type'])}`);
  }
  const data = action['data'];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('ENTITY_PROPOSAL_TRANSACTION_DATA_INVALID');
  }
  const txData = data as Record<string, unknown>;
  if (Object.keys(txData).sort().join(',') !== 'actionHash,txs,version' || txData['version'] !== 1) {
    throw new Error('ENTITY_PROPOSAL_TRANSACTION_DATA_INVALID');
  }
  assertTxBatchShape(txData['txs'], 'ENTITY_COLLECTIVE_ACTION');
  const txs = structuredClone(txData['txs']);
  const actionHash = String(txData['actionHash'] ?? '')
    .trim()
    .toLowerCase();
  const computed = hashCollectiveEntityActionTxs(txs);
  if (actionHash !== computed) {
    throw new Error(`ENTITY_PROPOSAL_ACTION_HASH_MISMATCH:${actionHash || 'missing'}:${computed}`);
  }
  return { type: 'entity_transaction', data: { version: 1, actionHash, txs } };
};

export const hashEntityProposalAction = (value: unknown): string => {
  const action = assertEntityProposalAction(value);
  return keccakBytesHash(encodeCanonicalConsensusBytes({
    domain: ENTITY_PROPOSAL_ACTION_DOMAIN,
    action,
  }));
};

export const assertIndividualEntityCommandTxs = (txs: EntityTx[]): void => {
  for (const tx of txs) {
    if (!isIndividualEntityCommandTx(tx)) {
      throw new EntityCommandRejectionError(
        `ENTITY_COMMAND_COLLECTIVE_ACTION_REQUIRES_PROPOSAL:${tx.type}`,
      );
    }
    if (tx.type === 'propose') assertEntityProposalAction(tx.data.action);
  }
};

export const buildCollectiveEntityProposalTx = (proposer: string, txs: EntityTx[]): EntityTx => ({
  type: 'propose',
  data: { proposer, action: buildEntityTransactionProposalAction(txs) },
});

const normalizeEntityRef = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

const routeBookOwner = (route: CrossJurisdictionSwapRoute): string =>
  normalizeEntityRef(route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId);

const requireSemanticRoute = (
  state: EntityState,
  orderId: string,
  supplied?: CrossJurisdictionSwapRoute,
): CrossJurisdictionSwapRoute => {
  const canonicalOrderId = String(orderId ?? '');
  const stored = state.crossJurisdictionSwaps?.get(canonicalOrderId);
  const route = stored ?? supplied;
  if (!route || route.orderId !== canonicalOrderId) {
    throw new Error(`RUNTIME_OUTPUT_ROUTE_MISSING:${canonicalOrderId || 'missing'}`);
  }
  if (stored && supplied) {
    const storedHash = normalizeEntityRef(stored.routeHash);
    const suppliedHash = normalizeEntityRef(supplied.routeHash);
    if (!storedHash || !suppliedHash || storedHash !== suppliedHash) {
      throw new Error(
        `RUNTIME_OUTPUT_ROUTE_HASH_MISMATCH:${canonicalOrderId}:${suppliedHash || 'missing'}:${storedHash || 'missing'}`,
      );
    }
  }
  return route;
};

const assertSemanticSource = (txType: string, source: string, expected: readonly string[]): void => {
  const allowed = new Set(expected.map(normalizeEntityRef).filter(Boolean));
  if (!allowed.has(source)) {
    throw new Error(
      `RUNTIME_OUTPUT_SEMANTIC_SOURCE_MISMATCH:${txType}:${source || 'missing'}:${Array.from(allowed).join(',') || 'none'}`,
    );
  }
};

const assertSemanticTarget = (txType: string, target: string, expected: unknown): void => {
  const canonicalExpected = normalizeEntityRef(expected);
  if (!canonicalExpected || target !== canonicalExpected) {
    throw new Error(
      `RUNTIME_OUTPUT_SEMANTIC_TARGET_MISMATCH:${txType}:${target || 'missing'}:${canonicalExpected || 'missing'}`,
    );
  }
};

const assertRuntimeCrossJSourceDispute = (
  source: string,
  target: string,
  tx: Extract<EntityTx, { type: 'disputeStart' }>,
  currentState: EntityState,
): void => {
  const routeId = String(tx.data.crossJurisdictionRouteId ?? '');
  if (!routeId) throw new Error('RUNTIME_OUTPUT_CROSS_J_DISPUTE_ROUTE_REQUIRED');
  const route = requireSemanticRoute(currentState, routeId);
  const allowedFields = new Set(['counterpartyEntityId', 'crossJurisdictionRouteId']);
  if (Object.keys(tx.data).some(field => !allowedFields.has(field))) {
    throw new Error('RUNTIME_OUTPUT_CROSS_J_DISPUTE_DATA_FORBIDDEN');
  }
  if (isCrossJurisdictionTerminalStatus(route.status) || !route.targetPull) {
    throw new Error(`RUNTIME_OUTPUT_CROSS_J_DISPUTE_ROUTE_INACTIVE:${route.orderId}:${route.status}`);
  }
  if (normalizeEntityRef(tx.data.counterpartyEntityId) !== normalizeEntityRef(route.source.counterpartyEntityId)) {
    throw new Error(
      `RUNTIME_OUTPUT_CROSS_J_DISPUTE_COUNTERPARTY_MISMATCH:` +
        `${tx.data.counterpartyEntityId}:${route.source.counterpartyEntityId}`,
    );
  }
  assertSemanticSource(tx.type, source, [route.target.counterpartyEntityId]);
  assertSemanticTarget(tx.type, target, route.source.entityId);
};

/** Verify book-owner/source-hub roles carried by certified cross-J outputs. */
const assertRuntimeBookOutputAuthority = (
  source: string,
  target: string,
  tx: EntityTx,
  currentState: EntityState,
): boolean => {
  switch (tx.type) {
    case 'admitCrossJurisdictionBookOrder': {
      const { route } = tx.data;
      assertSemanticSource(tx.type, source, [route.source.counterpartyEntityId]);
      assertSemanticTarget(tx.type, target, routeBookOwner(route));
      return true;
    }
    case 'applyCrossJurisdictionBookProgress': {
      const admission = Array.from(currentState.crossJurisdictionBookAdmissions?.values() ?? []).find(
        candidate =>
          candidate.orderId === tx.data.orderId &&
          normalizeEntityRef(candidate.sourceEntityId) === normalizeEntityRef(tx.data.sourceEntityId),
      );
      if (!admission) {
        throw new Error(`RUNTIME_OUTPUT_BOOK_ADMISSION_MISSING:${tx.data.sourceEntityId}:${tx.data.orderId}`);
      }
      const route = requireSemanticRoute(currentState, tx.data.orderId);
      if (
        normalizeEntityRef(admission.routeHash) !== normalizeEntityRef(route.routeHash) ||
        normalizeEntityRef(admission.bookOwnerEntityId) !== routeBookOwner(route)
      ) {
        throw new Error(`RUNTIME_OUTPUT_BOOK_ADMISSION_ROUTE_MISMATCH:${tx.data.sourceEntityId}:${tx.data.orderId}`);
      }
      assertSemanticSource(tx.type, source, [route.source.counterpartyEntityId]);
      assertSemanticTarget(tx.type, target, routeBookOwner(route));
      return true;
    }
    case 'crossJurisdictionFillNotice': {
      const route = requireSemanticRoute(currentState, tx.data.orderId);
      const sourceHub = normalizeEntityRef(route.source.counterpartyEntityId);
      const targetHub = normalizeEntityRef(route.target.entityId);
      if (target === sourceHub) {
        assertSemanticSource(tx.type, source, [routeBookOwner(route)]);
      } else if (target === targetHub) {
        assertSemanticSource(tx.type, source, [sourceHub]);
      } else {
        throw new Error(`RUNTIME_OUTPUT_CROSS_J_PROGRESS_TARGET_INVALID:${target}`);
      }
      return true;
    }
    default:
      return false;
  }
};

const assertRuntimeBookLifecycleAuthority = (
  source: string,
  target: string,
  tx: EntityTx,
  currentState: EntityState,
): boolean => {
  switch (tx.type) {
    case 'crossPullClose': {
      const route = requireSemanticRoute(currentState, tx.data.proof.orderId, tx.data.route);
      assertSemanticSource(tx.type, source, [route.source.counterpartyEntityId]);
      assertSemanticTarget(tx.type, target, route.target.entityId);
      if (normalizeEntityRef(tx.data.counterpartyEntityId) !== normalizeEntityRef(route.target.counterpartyEntityId)) {
        throw new Error(
          `RUNTIME_OUTPUT_CROSS_PULL_COUNTERPARTY_MISMATCH:` +
            `${tx.data.counterpartyEntityId}:${route.target.counterpartyEntityId}`,
        );
      }
      return true;
    }
    case 'removeCrossJurisdictionBookOrder': {
      const route = requireSemanticRoute(currentState, tx.data.orderId, tx.data.route);
      if (normalizeEntityRef(tx.data.sourceEntityId) !== normalizeEntityRef(route.source.entityId)) {
        throw new Error(
          `RUNTIME_OUTPUT_BOOK_SOURCE_ENTITY_MISMATCH:${tx.data.sourceEntityId}:${route.source.entityId}`,
        );
      }
      assertSemanticSource(tx.type, source, [route.source.counterpartyEntityId]);
      assertSemanticTarget(tx.type, target, routeBookOwner(route));
      return true;
    }
    case 'crossJurisdictionBookOrderRemoved': {
      const route = requireSemanticRoute(currentState, tx.data.orderId, tx.data.route);
      if (normalizeEntityRef(tx.data.sourceEntityId) !== normalizeEntityRef(route.source.entityId)) {
        throw new Error(
          `RUNTIME_OUTPUT_BOOK_REMOVAL_SOURCE_MISMATCH:${tx.data.sourceEntityId}:${route.source.entityId}`,
        );
      }
      if (normalizeEntityRef(tx.data.sourceAccountId) !== normalizeEntityRef(route.source.entityId)) {
        throw new Error(
          `RUNTIME_OUTPUT_BOOK_REMOVAL_ACCOUNT_MISMATCH:${tx.data.sourceAccountId}:${route.source.entityId}`,
        );
      }
      assertSemanticSource(tx.type, source, [routeBookOwner(route)]);
      assertSemanticTarget(tx.type, target, route.source.counterpartyEntityId);
      return true;
    }
    case 'requestCrossJurisdictionClear': {
      const route = requireSemanticRoute(currentState, tx.data.orderId, tx.data.route);
      assertSemanticSource(tx.type, source, [
        route.source.counterpartyEntityId,
        route.target.entityId,
        routeBookOwner(route),
      ]);
      assertSemanticTarget(tx.type, target, route.source.counterpartyEntityId);
      return true;
    }
    default:
      return false;
  }
};

const assertRuntimeCrossJRecoveryAuthority = (
  source: string,
  target: string,
  tx: EntityTx,
  currentState: EntityState,
): boolean => {
  switch (tx.type) {
    case 'crossJurisdictionSalvage': {
      const route = requireSemanticRoute(currentState, tx.data.routeId);
      if (normalizeEntityRef(tx.data.sourceEntityId) !== normalizeEntityRef(route.source.entityId)) {
        throw new Error(
          `RUNTIME_OUTPUT_SALVAGE_SOURCE_ENTITY_MISMATCH:${tx.data.sourceEntityId}:${route.source.entityId}`,
        );
      }
      if (
        normalizeEntityRef(tx.data.sourceCounterpartyEntityId) !== normalizeEntityRef(route.source.counterpartyEntityId)
      ) {
        throw new Error(
          `RUNTIME_OUTPUT_SALVAGE_SOURCE_COUNTERPARTY_MISMATCH:` +
            `${tx.data.sourceCounterpartyEntityId}:${route.source.counterpartyEntityId}`,
        );
      }
      const normalizedTarget = normalizeEntityRef(target);
      if (normalizedTarget === normalizeEntityRef(route.target.counterpartyEntityId)) {
        assertSemanticSource(tx.type, source, [route.source.entityId]);
        assertSemanticTarget(tx.type, target, route.target.counterpartyEntityId);
      } else if (normalizedTarget === normalizeEntityRef(route.source.entityId)) {
        assertSemanticSource(tx.type, source, [route.target.counterpartyEntityId]);
        assertSemanticTarget(tx.type, target, route.source.entityId);
      } else {
        throw new Error(`RUNTIME_OUTPUT_SALVAGE_TARGET_INVALID:${target}`);
      }
      return true;
    }
    case 'resolveHtlcLock': {
      const routeId = String(tx.data.crossJurisdictionRouteId ?? '');
      if (!routeId) throw new Error('RUNTIME_OUTPUT_CROSS_J_HTLC_ROUTE_REQUIRED');
      const route = requireSemanticRoute(currentState, routeId);
      assertSemanticSource(tx.type, source, [route.source.entityId]);
      assertSemanticTarget(tx.type, target, route.target.counterpartyEntityId);
      if (normalizeEntityRef(tx.data.counterpartyEntityId) !== normalizeEntityRef(route.target.entityId)) {
        throw new Error(`RUNTIME_OUTPUT_CROSS_J_HTLC_COUNTERPARTY_MISMATCH:${routeId}`);
      }
      return true;
    }
    case 'disputeStart': {
      assertRuntimeCrossJSourceDispute(source, target, tx, currentState);
      return true;
    }
    default:
      return false;
  }
};

const assertRuntimeOutputSemanticAuthority = (
  source: string,
  target: string,
  tx: EntityTx,
  currentState: EntityState,
): void => {
  // The committed source Runtime binds the emitting Entity and signer. Every
  // nested variant also binds that Entity to its economic role; a type
  // allowlist alone would let A submit bytes whose payload claims source C.
  if (assertRuntimeBookOutputAuthority(source, target, tx, currentState)) return;
  if (assertRuntimeBookLifecycleAuthority(source, target, tx, currentState)) return;
  if (assertRuntimeCrossJRecoveryAuthority(source, target, tx, currentState)) return;
  switch (tx.type) {
    case 'prepareCrossJurisdictionSwap':
      assertSemanticSource(tx.type, source, [tx.data.route.source.entityId]);
      assertSemanticTarget(tx.type, target, tx.data.route.source.counterpartyEntityId);
      return;
    case 'registerCrossJurisdictionSwap': {
      const route = tx.data.route;
      assertSemanticSource(tx.type, source, [route.source.counterpartyEntityId]);
      const sourceHub = normalizeEntityRef(route.source.counterpartyEntityId);
      const targetHub = normalizeEntityRef(route.target.entityId);
      if (target !== sourceHub && target !== targetHub) {
        throw new Error(`RUNTIME_OUTPUT_SEMANTIC_TARGET_MISMATCH:${tx.type}:${target}:${sourceHub},${targetHub}`);
      }
      return;
    }
    default:
      throw new Error(`RUNTIME_OUTPUT_SEMANTIC_VARIANT_FORBIDDEN:${tx.type}`);
  }
};

const assertSelfRuntimeContinuations = (
  source: string,
  sourceSigner: string,
  target: string,
  txs: EntityTx[],
  currentState: EntityState,
): boolean => {
  if (source !== target || !txs.every(tx => selfRuntimeContinuationTxTypes.has(tx.type))) {
    return false;
  }
    const board = resolveCanonicalEntityBoardShares(currentState.config);
    if (!board.bySigner.has(sourceSigner)) {
      throw new Error(
        `RUNTIME_OUTPUT_SOURCE_SIGNER_MISMATCH:${source}:${sourceSigner}:current-board`,
      );
    }
    for (const tx of txs) {
      if (protocolTxTypes.has(tx.type)) {
        throw new Error(`RUNTIME_OUTPUT_NESTED_PROTOCOL_TX_FORBIDDEN:${tx.type}`);
      }
      if (tx.type !== 'requestCrossJurisdictionClear') continue;
      const route = currentState.crossJurisdictionSwaps?.get(tx.data.orderId);
      const expectedSourceSigner = route && crossJurisdictionRouteSigner(route, source);
      if (
        !route ||
        !isCrossJurisdictionRouteParticipant(route, source)
      ) {
        throw new Error(`RUNTIME_OUTPUT_NON_SIBLING_FORBIDDEN:${tx.type}:${source}:${target}`);
      }
      if (!expectedSourceSigner || expectedSourceSigner !== sourceSigner) {
        throw new Error(
          `RUNTIME_OUTPUT_SOURCE_SIGNER_MISMATCH:${source}:${sourceSigner}:` +
            `${expectedSourceSigner || 'missing'}`,
        );
      }
      assertRuntimeOutputSemanticAuthority(source, target, tx, currentState);
    }
    return true;
};

const runtimeOutputRouteId = (tx: EntityTx): string | undefined => {
  switch (tx.type) {
    case 'crossJurisdictionFillNotice':
    case 'applyCrossJurisdictionBookProgress':
    case 'removeCrossJurisdictionBookOrder':
    case 'requestCrossJurisdictionClear':
      return tx.data.orderId;
    case 'crossJurisdictionSalvage':
      return tx.data.routeId;
    case 'resolveHtlcLock':
      return tx.data.crossJurisdictionRouteId;
    case 'disputeStart':
      return tx.data.crossJurisdictionRouteId;
    default:
      return undefined;
  }
};

const runtimeOutputSemanticRoute = (
  tx: EntityTx,
  currentState: EntityState,
): CrossJurisdictionSwapRoute | undefined => {
  const routeId = runtimeOutputRouteId(tx);
  if (routeId) return currentState.crossJurisdictionSwaps?.get(routeId);
  if ('data' in tx && tx.data && typeof tx.data === 'object' && 'route' in tx.data) {
    return (tx.data as { route?: CrossJurisdictionSwapRoute }).route;
  }
  return undefined;
};

const assertSiblingRuntimeOutputs = (
  source: string,
  sourceSigner: string,
  target: string,
  txs: EntityTx[],
  currentState: EntityState,
): void => {
  if (
    source === target &&
    !txs.every(
      tx =>
        tx.type === 'registerCrossJurisdictionSwap' &&
        normalizeEntityRef(tx.data.route.source.counterpartyEntityId) === source,
    )
  ) {
    throw new Error(`RUNTIME_OUTPUT_SELF_FORBIDDEN:${source}:${txs.map(tx => tx.type).join(',')}`);
  }
  for (const tx of txs) {
    if (protocolTxTypes.has(tx.type)) {
      throw new Error(`RUNTIME_OUTPUT_NESTED_PROTOCOL_TX_FORBIDDEN:${tx.type}`);
    }
    const semanticRoute = runtimeOutputSemanticRoute(tx, currentState);
    if (
      !semanticRoute ||
      !isCrossJurisdictionRouteParticipant(semanticRoute, source) ||
      !isCrossJurisdictionRouteParticipant(semanticRoute, target)
    ) {
      throw new Error(`RUNTIME_OUTPUT_NON_SIBLING_FORBIDDEN:${tx.type}:${source}:${target}`);
    }
    const expectedSourceSigner = crossJurisdictionRouteSigner(semanticRoute, source);
    if (!expectedSourceSigner || expectedSourceSigner !== sourceSigner) {
      throw new Error(
        `RUNTIME_OUTPUT_SOURCE_SIGNER_MISMATCH:${source}:${sourceSigner}:` +
          `${expectedSourceSigner || 'missing'}`,
      );
    }
    assertRuntimeOutputSemanticAuthority(source, target, tx, currentState);
  }
};

export const assertRuntimeOutputAuthorization = (
  sourceEntityId: string,
  sourceSignerId: string,
  targetEntityId: string,
  txs: EntityTx[],
  currentState: EntityState,
): void => {
  const source = normalizeEntityRef(sourceEntityId);
  const sourceSigner = normalizeEntityRef(sourceSignerId);
  const target = normalizeEntityRef(targetEntityId);
  if (!source || !sourceSigner || !target || target !== normalizeEntityRef(currentState.entityId)) {
    throw new Error(`RUNTIME_OUTPUT_TARGET_MISMATCH:${target || 'missing'}:${currentState.entityId}`);
  }
  if (txs.length === 0) throw new Error('RUNTIME_OUTPUT_TXS_MISSING');
  if (assertSelfRuntimeContinuations(source, sourceSigner, target, txs, currentState)) return;
  assertSiblingRuntimeOutputs(source, sourceSigner, target, txs, currentState);
};
