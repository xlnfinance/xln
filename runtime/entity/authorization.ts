import { ethers } from 'ethers';

import { LIMITS } from '../constants';
import type {
  ConsensusConfig,
  CrossJurisdictionSwapRoute,
  EntityState,
  EntityTx,
  ProposalAction,
} from '../types';
import {
  buildCrossJurisdictionPullBinding,
  isCrossJurisdictionTerminalStatus,
} from '../extensions/cross-j';
import { encodeCanonicalEntityConsensusValue } from './consensus/state-root';
import { assertNoConsensusVisibleHtlcPaymentSecrets } from '../protocol/htlc/consensus-secret-guard';
import { isCrossJurisdictionSiblingPair } from '../extensions/cross-j/boundary';

export const ENTITY_PROPOSAL_ACTION_DOMAIN = 'xln:entity-proposal-action:v1' as const;

export const canonicalEntityBoardSignerId = (
  value: unknown,
  missingCode = 'ENTITY_BOARD_SIGNER_ID_REQUIRED',
): string => {
  const signerId = String(value ?? '').trim().toLowerCase();
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
  'entityCommand',
  'consensusOutput',
  'runtimeOutput',
  'scheduledWake',
  'j_event',
  'j_event_account_claim',
  'accountInput',
  'certifyProfile',
]);

const individualTxTypes = new Set<EntityTx['type']>([
  'chat',
  'htlcOnionAdvance',
  'materializeCrossJurisdictionClear',
  'materializeCrossJurisdictionSwap',
  'propose',
  'vote',
]);

const crossEntityCertifiedTxTypes = new Set<EntityTx['type']>([
  'accountInput',
]);

export const isEntityProtocolTx = (tx: EntityTx): boolean => protocolTxTypes.has(tx.type);

/** Security allowlist: new EntityTx variants are collective until explicitly reviewed. */
export const isIndividualEntityCommandTx = (tx: EntityTx): boolean =>
  individualTxTypes.has(tx.type);

export const isCollectiveEntityActionTx = (tx: EntityTx): boolean =>
  !isEntityProtocolTx(tx) && !isIndividualEntityCommandTx(tx);

const assertTxBatchShape: (
  txs: unknown,
  code: string,
) => asserts txs is EntityTx[] = (txs, code) => {
  if (!Array.isArray(txs) || txs.length === 0 || txs.length > LIMITS.MEMPOOL_SIZE) {
    throw new Error(`${code}_TX_COUNT_INVALID:${Array.isArray(txs) ? txs.length : 'not-array'}`);
  }
  for (const tx of txs) {
    if (!tx || typeof tx !== 'object' || typeof (tx as { type?: unknown }).type !== 'string') {
      throw new Error(`${code}_TX_INVALID`);
    }
  }
  const byteLength = new TextEncoder().encode(encodeCanonicalEntityConsensusValue({
    domain: ENTITY_PROPOSAL_ACTION_DOMAIN,
    txs,
  })).byteLength;
  if (byteLength > LIMITS.MAX_FRAME_SIZE_BYTES) {
    throw new Error(`${code}_BYTE_LIMIT_EXCEEDED:${byteLength}:${LIMITS.MAX_FRAME_SIZE_BYTES}`);
  }
};

export const hashCollectiveEntityActionTxs = (txs: EntityTx[]): string => {
  assertNoConsensusVisibleHtlcPaymentSecrets(txs);
  assertTxBatchShape(txs, 'ENTITY_COLLECTIVE_ACTION');
  for (const tx of txs) {
    if (!isCollectiveEntityActionTx(tx)) {
      throw new Error(`ENTITY_COLLECTIVE_ACTION_TX_FORBIDDEN:${tx.type}`);
    }
  }
  return ethers.keccak256(ethers.toUtf8Bytes(encodeCanonicalEntityConsensusValue({
    domain: ENTITY_PROPOSAL_ACTION_DOMAIN,
    version: 1,
    txs,
  }))).toLowerCase();
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
  const actionHash = String(txData['actionHash'] ?? '').trim().toLowerCase();
  const computed = hashCollectiveEntityActionTxs(txs);
  if (actionHash !== computed) {
    throw new Error(`ENTITY_PROPOSAL_ACTION_HASH_MISMATCH:${actionHash || 'missing'}:${computed}`);
  }
  return { type: 'entity_transaction', data: { version: 1, actionHash, txs } };
};

export const hashEntityProposalAction = (value: unknown): string => {
  const action = assertEntityProposalAction(value);
  return ethers.keccak256(ethers.toUtf8Bytes(encodeCanonicalEntityConsensusValue({
    domain: ENTITY_PROPOSAL_ACTION_DOMAIN,
    action,
  }))).toLowerCase();
};

export const assertIndividualEntityCommandTxs = (txs: EntityTx[]): void => {
  for (const tx of txs) {
    if (!isIndividualEntityCommandTx(tx)) {
      throw new Error(`ENTITY_COMMAND_COLLECTIVE_ACTION_REQUIRES_PROPOSAL:${tx.type}`);
    }
    if (tx.type === 'propose') assertEntityProposalAction(tx.data.action);
  }
};

export const buildCollectiveEntityProposalTx = (
  proposer: string,
  txs: EntityTx[],
): EntityTx => ({
  type: 'propose',
  data: { proposer, action: buildEntityTransactionProposalAction(txs) },
});

const normalizeEntityRef = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const routeBookOwner = (route: CrossJurisdictionSwapRoute): string =>
  normalizeEntityRef(
    route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId,
  );

const requireSemanticRoute = (
  state: EntityState,
  orderId: string,
  supplied?: CrossJurisdictionSwapRoute,
): CrossJurisdictionSwapRoute => {
  const canonicalOrderId = String(orderId ?? '');
  const stored = state.crossJurisdictionSwaps?.get(canonicalOrderId);
  const route = stored ?? supplied;
  if (!route || route.orderId !== canonicalOrderId) {
    throw new Error(`CONSENSUS_OUTPUT_ROUTE_MISSING:${canonicalOrderId || 'missing'}`);
  }
  if (stored && supplied) {
    const storedHash = normalizeEntityRef(stored.routeHash);
    const suppliedHash = normalizeEntityRef(supplied.routeHash);
    if (!storedHash || !suppliedHash || storedHash !== suppliedHash) {
      throw new Error(`CONSENSUS_OUTPUT_ROUTE_HASH_MISMATCH:${canonicalOrderId}:${suppliedHash || 'missing'}:${storedHash || 'missing'}`);
    }
  }
  return route;
};

const assertSemanticSource = (
  txType: string,
  source: string,
  expected: readonly string[],
): void => {
  const allowed = new Set(expected.map(normalizeEntityRef).filter(Boolean));
  if (!allowed.has(source)) {
    throw new Error(
      `CONSENSUS_OUTPUT_SEMANTIC_SOURCE_MISMATCH:${txType}:${source || 'missing'}:${Array.from(allowed).join(',') || 'none'}`,
    );
  }
};

const assertSemanticTarget = (txType: string, target: string, expected: unknown): void => {
  const canonicalExpected = normalizeEntityRef(expected);
  if (!canonicalExpected || target !== canonicalExpected) {
    throw new Error(
      `CONSENSUS_OUTPUT_SEMANTIC_TARGET_MISMATCH:${txType}:${target || 'missing'}:${canonicalExpected || 'missing'}`,
    );
  }
};

const requireCertifiedCrossJRoute = (
  txs: readonly EntityTx[],
  orderId: string,
  routeHash: string,
): CrossJurisdictionSwapRoute => {
  const routes = txs.flatMap(candidate =>
    candidate.type === 'registerCrossJurisdictionSwap' &&
    String(candidate.data.route.orderId) === String(orderId) &&
    normalizeEntityRef(candidate.data.route.routeHash) === normalizeEntityRef(routeHash)
      ? [candidate.data.route]
      : [],
  );
  if (routes.length !== 1) {
    throw new Error(`CONSENSUS_OUTPUT_CROSS_J_PULL_ROUTE_AMBIGUOUS:${orderId}:${routes.length}`);
  }
  return routes[0]!;
};

const assertCertifiedCrossJTargetPull = (
  source: string,
  target: string,
  tx: Extract<EntityTx, { type: 'pullLock' }>,
  certifiedTxs: readonly EntityTx[],
): void => {
  const binding = tx.data.crossJurisdiction;
  if (!binding || binding.leg !== 'target') {
    throw new Error('CONSENSUS_OUTPUT_CROSS_J_PULL_BINDING_REQUIRED:pullLock:target');
  }
  const route = requireCertifiedCrossJRoute(certifiedTxs, binding.orderId, binding.routeHash);
  const pull = route.targetPull;
  if (!pull) throw new Error(`CONSENSUS_OUTPUT_CROSS_J_TARGET_PULL_MISSING:${route.orderId}`);
  assertSemanticSource(tx.type, source, [route.source.counterpartyEntityId]);
  assertSemanticTarget(tx.type, target, route.target.entityId);
  const exactPull =
    normalizeEntityRef(tx.data.counterpartyEntityId) === normalizeEntityRef(route.target.counterpartyEntityId) &&
    tx.data.pullId === pull.pullId &&
    tx.data.tokenId === pull.tokenId &&
    tx.data.amount === pull.signedAmount &&
    tx.data.revealedUntilTimestamp === pull.revealedUntilTimestamp &&
    normalizeEntityRef(tx.data.fullHash) === normalizeEntityRef(pull.fullHash) &&
    normalizeEntityRef(tx.data.partialRoot) === normalizeEntityRef(pull.partialRoot);
  const expectedBinding = buildCrossJurisdictionPullBinding(route, 'target');
  const exactBinding = encodeCanonicalEntityConsensusValue(binding) ===
    encodeCanonicalEntityConsensusValue(expectedBinding);
  if (!exactPull || !exactBinding) {
    throw new Error(`CONSENSUS_OUTPUT_CROSS_J_TARGET_PULL_MISMATCH:${route.orderId}`);
  }
};

const assertCertifiedCrossJSourceDispute = (
  source: string,
  target: string,
  tx: Extract<EntityTx, { type: 'disputeStart' }>,
  currentState: EntityState,
): void => {
  const routeId = String(tx.data.crossJurisdictionRouteId ?? '');
  if (!routeId) throw new Error('CONSENSUS_OUTPUT_CROSS_J_DISPUTE_ROUTE_REQUIRED');
  const route = requireSemanticRoute(currentState, routeId);
  const allowedFields = new Set(['counterpartyEntityId', 'crossJurisdictionRouteId']);
  if (Object.keys(tx.data).some((field) => !allowedFields.has(field))) {
    throw new Error('CONSENSUS_OUTPUT_CROSS_J_DISPUTE_DATA_FORBIDDEN');
  }
  if (isCrossJurisdictionTerminalStatus(route.status) || !route.targetPull) {
    throw new Error(
      `CONSENSUS_OUTPUT_CROSS_J_DISPUTE_ROUTE_INACTIVE:${route.orderId}:${route.status}`,
    );
  }
  if (
    normalizeEntityRef(tx.data.counterpartyEntityId) !==
    normalizeEntityRef(route.source.counterpartyEntityId)
  ) {
    throw new Error(
      `CONSENSUS_OUTPUT_CROSS_J_DISPUTE_COUNTERPARTY_MISMATCH:` +
        `${tx.data.counterpartyEntityId}:${route.source.counterpartyEntityId}`,
    );
  }
  assertSemanticSource(tx.type, source, [route.target.counterpartyEntityId]);
  assertSemanticTarget(tx.type, target, route.source.entityId);
};

/**
 * The outer Hanko proves which Entity emitted the output. Each nested variant
 * must additionally bind that source to the economic role it claims; merely
 * type-allowlisting a payload lets Entity A forge a command that says it came
 * from C while validators correctly verify only A's Hanko.
 */
export const assertCertifiedOutputSemanticAuthority = (
  source: string,
  target: string,
  tx: EntityTx,
  currentState: EntityState,
  certifiedTxs: readonly EntityTx[] = [tx],
): void => {
  switch (tx.type) {
    case 'accountInput': {
      assertSemanticSource(tx.type, source, [tx.data.fromEntityId]);
      assertSemanticTarget(tx.type, target, tx.data.toEntityId);
      return;
    }
    case 'prepareCrossJurisdictionSwap': {
      throw new Error('RUNTIME_OUTPUT_CROSS_J_INTENT_MUST_USE_ACCOUNT');
    }
    case 'registerCrossJurisdictionSwap': {
      const route = tx.data.route;
      assertSemanticSource(tx.type, source, [route.source.counterpartyEntityId]);
      const sourceHub = normalizeEntityRef(route.source.counterpartyEntityId);
      const targetHub = normalizeEntityRef(route.target.entityId);
      if (target !== sourceHub && target !== targetHub) {
        throw new Error(
          `CONSENSUS_OUTPUT_SEMANTIC_TARGET_MISMATCH:${tx.type}:${target}:${sourceHub},${targetHub}`,
        );
      }
      return;
    }
    case 'pullLock': {
      assertCertifiedCrossJTargetPull(source, target, tx, certifiedTxs);
      return;
    }
    case 'admitCrossJurisdictionBookOrder': {
      const { route } = tx.data;
      assertSemanticSource(tx.type, source, [route.source.counterpartyEntityId]);
      assertSemanticTarget(tx.type, target, routeBookOwner(route));
      return;
    }
    case 'applyCrossJurisdictionBookProgress': {
      const admission = Array.from(currentState.crossJurisdictionBookAdmissions?.values() ?? [])
        .find(candidate =>
          candidate.orderId === tx.data.orderId &&
          normalizeEntityRef(candidate.sourceEntityId) === normalizeEntityRef(tx.data.sourceEntityId),
        );
      if (!admission) {
        throw new Error(`CONSENSUS_OUTPUT_BOOK_ADMISSION_MISSING:${tx.data.sourceEntityId}:${tx.data.orderId}`);
      }
      const route = requireSemanticRoute(currentState, tx.data.orderId);
      if (
        normalizeEntityRef(admission.routeHash) !== normalizeEntityRef(route.routeHash) ||
        normalizeEntityRef(admission.bookOwnerEntityId) !== routeBookOwner(route)
      ) {
        throw new Error(`CONSENSUS_OUTPUT_BOOK_ADMISSION_ROUTE_MISMATCH:${tx.data.sourceEntityId}:${tx.data.orderId}`);
      }
      assertSemanticSource(tx.type, source, [route.source.counterpartyEntityId]);
      assertSemanticTarget(tx.type, target, routeBookOwner(route));
      return;
    }
    case 'crossJurisdictionFillNotice': {
      const route = requireSemanticRoute(currentState, tx.data.orderId);
      assertSemanticSource(tx.type, source, [routeBookOwner(route)]);
      assertSemanticTarget(tx.type, target, route.source.counterpartyEntityId);
      return;
    }
    case 'crossJurisdictionSettled': {
      const route = requireSemanticRoute(currentState, tx.data.orderId);
      const sourceUser = normalizeEntityRef(route.source.entityId);
      const sourceHub = normalizeEntityRef(route.source.counterpartyEntityId);
      if (target === sourceUser) {
        assertSemanticSource(tx.type, source, [route.target.counterpartyEntityId]);
      } else if (target === sourceHub) {
        assertSemanticSource(tx.type, source, [route.target.entityId]);
      } else {
        throw new Error(
          `CONSENSUS_OUTPUT_SEMANTIC_TARGET_MISMATCH:${tx.type}:${target}:${sourceUser},${sourceHub}`,
        );
      }
      return;
    }
    case 'crossPullClose': {
      const route = requireSemanticRoute(currentState, tx.data.proof.orderId, tx.data.route);
      assertSemanticSource(tx.type, source, [route.source.entityId]);
      assertSemanticTarget(tx.type, target, route.target.counterpartyEntityId);
      if (normalizeEntityRef(tx.data.counterpartyEntityId) !== normalizeEntityRef(route.target.entityId)) {
        throw new Error(
          `CONSENSUS_OUTPUT_CROSS_PULL_COUNTERPARTY_MISMATCH:${tx.data.counterpartyEntityId}:${route.target.entityId}`,
        );
      }
      return;
    }
    case 'removeCrossJurisdictionBookOrder': {
      const route = requireSemanticRoute(currentState, tx.data.orderId, tx.data.route);
      if (normalizeEntityRef(tx.data.sourceEntityId) !== normalizeEntityRef(route.source.entityId)) {
        throw new Error(
          `CONSENSUS_OUTPUT_BOOK_SOURCE_ENTITY_MISMATCH:${tx.data.sourceEntityId}:${route.source.entityId}`,
        );
      }
      assertSemanticSource(tx.type, source, [route.source.counterpartyEntityId]);
      assertSemanticTarget(tx.type, target, routeBookOwner(route));
      return;
    }
    case 'crossJurisdictionBookOrderRemoved': {
      const route = requireSemanticRoute(currentState, tx.data.orderId, tx.data.route);
      if (normalizeEntityRef(tx.data.sourceEntityId) !== normalizeEntityRef(route.source.entityId)) {
        throw new Error(
          `CONSENSUS_OUTPUT_BOOK_REMOVAL_SOURCE_MISMATCH:${tx.data.sourceEntityId}:${route.source.entityId}`,
        );
      }
      if (normalizeEntityRef(tx.data.sourceAccountId) !== normalizeEntityRef(route.source.entityId)) {
        throw new Error(
          `CONSENSUS_OUTPUT_BOOK_REMOVAL_ACCOUNT_MISMATCH:${tx.data.sourceAccountId}:${route.source.entityId}`,
        );
      }
      assertSemanticSource(tx.type, source, [routeBookOwner(route)]);
      assertSemanticTarget(tx.type, target, route.source.counterpartyEntityId);
      return;
    }
    case 'requestCrossJurisdictionClear': {
      const route = requireSemanticRoute(currentState, tx.data.orderId, tx.data.route);
      assertSemanticSource(tx.type, source, [
        route.source.counterpartyEntityId,
        route.target.entityId,
        routeBookOwner(route),
      ]);
      assertSemanticTarget(tx.type, target, route.source.counterpartyEntityId);
      return;
    }
    case 'crossJurisdictionSalvage': {
      const route = requireSemanticRoute(currentState, tx.data.routeId);
      if (normalizeEntityRef(tx.data.sourceEntityId) !== normalizeEntityRef(route.source.entityId)) {
        throw new Error(
          `CONSENSUS_OUTPUT_SALVAGE_SOURCE_ENTITY_MISMATCH:${tx.data.sourceEntityId}:${route.source.entityId}`,
        );
      }
      if (
        normalizeEntityRef(tx.data.sourceCounterpartyEntityId) !==
        normalizeEntityRef(route.source.counterpartyEntityId)
      ) {
        throw new Error(
          `CONSENSUS_OUTPUT_SALVAGE_SOURCE_COUNTERPARTY_MISMATCH:` +
            `${tx.data.sourceCounterpartyEntityId}:${route.source.counterpartyEntityId}`,
        );
      }
      assertSemanticSource(tx.type, source, [route.source.entityId]);
      assertSemanticTarget(tx.type, target, route.target.counterpartyEntityId);
      return;
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
      return;
    }
    case 'disputeStart': {
      assertCertifiedCrossJSourceDispute(source, target, tx, currentState);
      return;
    }
    default:
      throw new Error(`CONSENSUS_OUTPUT_SEMANTIC_VARIANT_FORBIDDEN:${tx.type}`);
  }
};

export const assertRuntimeOutputAuthorization = (
  sourceEntityId: string,
  targetEntityId: string,
  txs: EntityTx[],
  currentState: EntityState,
): void => {
  const source = normalizeEntityRef(sourceEntityId);
  const target = normalizeEntityRef(targetEntityId);
  if (!source || !target || target !== normalizeEntityRef(currentState.entityId)) {
    throw new Error(`RUNTIME_OUTPUT_TARGET_MISMATCH:${target || 'missing'}:${currentState.entityId}`);
  }
  if (txs.length === 0) throw new Error('RUNTIME_OUTPUT_TXS_MISSING');
  if (
    source === target &&
    !txs.every(tx =>
      tx.type === 'registerCrossJurisdictionSwap' &&
      normalizeEntityRef(tx.data.route.source.counterpartyEntityId) === source
    )
  ) {
    throw new Error(`RUNTIME_OUTPUT_SELF_FORBIDDEN:${source}`);
  }
  for (const tx of txs) {
    if (protocolTxTypes.has(tx.type)) {
      throw new Error(`RUNTIME_OUTPUT_NESTED_PROTOCOL_TX_FORBIDDEN:${tx.type}`);
    }
    const suppliedRoute = tx.type === 'crossJurisdictionFillNotice' ||
      tx.type === 'crossJurisdictionSettled' ||
      tx.type === 'applyCrossJurisdictionBookProgress' ||
      tx.type === 'removeCrossJurisdictionBookOrder' ||
      tx.type === 'requestCrossJurisdictionClear' ||
      tx.type === 'crossJurisdictionSalvage' ||
      tx.type === 'resolveHtlcLock' ||
      tx.type === 'disputeStart'
      ? undefined
      : 'data' in tx && tx.data && typeof tx.data === 'object' && 'route' in tx.data
        ? (tx.data as { route?: CrossJurisdictionSwapRoute }).route
        : undefined;
    const pairedPullRoute = tx.type === 'pullLock' && tx.data.crossJurisdiction
      ? txs.find((candidate): candidate is Extract<EntityTx, { type: 'registerCrossJurisdictionSwap' }> =>
          candidate.type === 'registerCrossJurisdictionSwap' &&
          candidate.data.route.orderId === tx.data.crossJurisdiction?.orderId)?.data.route
      : undefined;
    const semanticRoute = suppliedRoute ?? pairedPullRoute ?? (() => {
      const orderId = tx.type === 'crossJurisdictionFillNotice' ||
        tx.type === 'crossJurisdictionSettled' ||
        tx.type === 'applyCrossJurisdictionBookProgress'
        ? tx.data.orderId
        : tx.type === 'removeCrossJurisdictionBookOrder' || tx.type === 'requestCrossJurisdictionClear'
          ? tx.data.orderId
          : tx.type === 'crossJurisdictionSalvage'
            ? tx.data.routeId
            : tx.type === 'resolveHtlcLock'
              ? tx.data.crossJurisdictionRouteId
              : tx.type === 'disputeStart'
                ? tx.data.crossJurisdictionRouteId
                : undefined;
      return orderId ? currentState.crossJurisdictionSwaps?.get(orderId) : undefined;
    })();
    const selfSourceRegistration = source === target &&
      tx.type === 'registerCrossJurisdictionSwap' &&
      normalizeEntityRef(semanticRoute?.source.counterpartyEntityId) === source;
    if (
      !semanticRoute ||
      (!selfSourceRegistration && !isCrossJurisdictionSiblingPair(semanticRoute, source, target))
    ) {
      throw new Error(`RUNTIME_OUTPUT_NON_SIBLING_FORBIDDEN:${tx.type}:${source}:${target}`);
    }
    assertCertifiedOutputSemanticAuthority(source, target, tx, currentState, txs);
  }
};

export const assertCertifiedEntityOutputAuthorization = (
  sourceEntityId: string,
  targetEntityId: string,
  txs: EntityTx[],
  currentState: EntityState,
): void => {
  const source = sourceEntityId.trim().toLowerCase();
  const target = targetEntityId.trim().toLowerCase();
  const selfOutput = source === target;
  for (const tx of txs) {
    if (isIndividualEntityCommandTx(tx) || tx.type === 'entityCommand') {
      throw new Error(`CONSENSUS_OUTPUT_INDIVIDUAL_TX_FORBIDDEN:${tx.type}`);
    }
    if (!selfOutput && !crossEntityCertifiedTxTypes.has(tx.type)) {
      throw new Error(`CONSENSUS_OUTPUT_CROSS_ENTITY_TX_FORBIDDEN:${tx.type}`);
    }
    if (!selfOutput) assertCertifiedOutputSemanticAuthority(source, target, tx, currentState, txs);
  }
};
