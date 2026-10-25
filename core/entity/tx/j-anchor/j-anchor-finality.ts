import type { EntityState } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import { signAccountFrame, verifyAccountSignature } from '../../../account/crypto';
import { initJBatch } from '../../../jurisdiction/machine/batch';
import {
  advanceCertifiedBoardFinality,
  cacheCertifiedBoardNodes,
  createEmptyCertifiedBoardRegistryState,
} from '../../../jurisdiction/machine/board-registry';
import { getJEventJurisdictionRef } from '../../../jurisdiction/machine/event-observation';
import {
  buildJHistoryAnchorClaimDigest,
  getJHistoryRegistrationBaseHeight,
} from '../../../jurisdiction/machine/history-consensus';
import {
  validateJHistoryAnchorClaim,
  type JHistoryAnchorClaimData,
  type JHistoryAnchorClaimValidationResult,
} from '../../../jurisdiction/machine/j-event-range-validation';
import { MAX_ENTITY_FRAME_J_RANGE_BYTES } from '../../../jurisdiction/machine/range-budget';
import {
  buildCarriedBoardRegistry,
  buildCarriedProvenValues,
  buildEntityProvenValuesFromFold,
  type JHistoryAnchorValues,
} from '../../../jurisdiction/machine/state-anchor/proven-values-root';
import { haltRuntimeFailure } from '../../../protocol/errors/failure-taxonomy';
import { encodeCanonicalConsensusBytes } from '../../../protocol/serialization/binary-codec';
import { getEntityLeaderState } from '../../consensus/leader';
import { prepareEntityTxState } from '../../state-clone';

export type { JHistoryAnchorValues };

/** Payload of the 'j_anchor' Entity transaction: the signed claim plus the values it roots. */
export type JHistoryAnchorTxData = JHistoryAnchorClaimData & { values: JHistoryAnchorValues };

const fail = (code: string, detail = ''): never => {
  throw new Error(detail ? `J_ANCHOR_APPLY_${code}:${detail}` : `J_ANCHOR_APPLY_${code}`);
};

const hasEntries = (ledger: EntityState['outDebtsByToken']): boolean =>
  [...(ledger?.values() ?? [])].some((byId) => byId.size > 0);

/**
 * Local state an anchor start can never be admitted over (applyJHistoryAnchor
 * fails on it). The proposer drops a queued 'j_anchor' on it instead of
 * proposing a frame every validator must halt on; the Entity keeps full history.
 */
export const getJAnchorLocalRefusal = (state: EntityState): string | null => {
  if (state.jHistoryFinality) return 'FINALITY_EXISTS';
  if (hasEntries(state.outDebtsByToken) || hasEntries(state.inDebtsByToken)) return 'DEBT_PRESENT';
  if (state.jBatchState?.sentBatch) return 'SENT_BATCH_PRESENT';
  if (state.entityProviderActionState?.pending) return 'ACTION_PENDING';
  return null;
};

/**
 * Writes an admitted anchor start in place of the genesis fold. Every
 * validator recomputes the board registry from the carried records and the
 * values root from the written state; a carried family that does not
 * reproduce the signed root is never committed. Debts stay on full history
 * (identity/provenance is history-only), so any debt fails closed.
 */
export const applyJHistoryAnchor = (input: {
  entityState: EntityState;
  state: EntityState;
  env: EntityRuntimeContext;
  validated: Extract<JHistoryAnchorClaimValidationResult, { ok: true }>;
  signature: string;
  values: JHistoryAnchorValues;
  recomputeValuesRoot: (after: EntityState, tokenCount: bigint) => string;
}): EntityState => {
  const { state, values, validated } = input;
  const refusal = getJAnchorLocalRefusal(state);
  if (refusal) fail(refusal);
  const jurisdiction = state.config.jurisdiction ?? fail('JURISDICTION_MISSING');
  if (values.actionNonce === null) fail('ACTION_NONCE_UNPROVEN');
  for (const [tokenId, amount] of values.reserves) {
    if (amount < 0n) fail('RESERVE_NEGATIVE', String(tokenId));
    if (amount !== 0n && BigInt(tokenId) >= values.tokenCount) fail('RESERVE_UNLISTED', String(tokenId));
  }

  const empty = createEmptyCertifiedBoardRegistryState(jurisdiction);
  if (state.certifiedBoardState && state.certifiedBoardState.boardRegistryRoot !== empty.boardRegistryRoot) {
    fail('BOARD_REGISTRY_NOT_EMPTY');
  }
  const { root: boardRegistryRoot, nodes } = buildCarriedBoardRegistry(jurisdiction, values.boardRecords);
  const board = { ...empty, boardRegistryRoot };

  const reserves = new Map<number, bigint>();
  for (const [tokenId, amount] of values.reserves) if (amount !== 0n) reserves.set(tokenId, amount);
  state.reserves = reserves;
  const action = state.entityProviderActionState;
  // Same rule as the J-event fold: generation is the local intent counter, and
  // a nonce no action ever advanced leaves the state absent.
  if (action || values.actionNonce !== 0n) {
    state.entityProviderActionState = {
      version: 1,
      confirmedNonce: values.actionNonce as bigint,
      generation: action?.generation ?? 0,
    };
  }
  if (values.batchNonce < 0n || values.batchNonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('BATCH_NONCE_INVALID', values.batchNonce.toString());
  }
  // Same rules as the fold: a processed batch (nonce >= 1) creates the batch
  // state, and syncEntityNonce keeps max(proven, current).
  if (state.jBatchState || values.batchNonce > 0n) {
    state.jBatchState ??= initJBatch();
    const currentNonce = Number(state.jBatchState.entityNonce || 0);
    const provenNonce = Number(values.batchNonce);
    state.jBatchState.entityNonce = provenNonce > currentNonce ? provenNonce : currentNonce;
  }

  const { anchor } = validated;
  state.lastFinalizedJHeight = anchor.anchorHeight;
  state.jHistoryFinality = {
    jurisdictionRef: anchor.jurisdictionRef,
    baseHeight: validated.baseHeight,
    finalizedThroughHeight: anchor.anchorHeight,
    tipBlockHash: anchor.anchorBlockHash,
    eventHistoryRoot: validated.eventHistoryRoot,
    proposerSignerId: validated.signerId,
    proposerSignature: input.signature,
    entityHeight: input.entityState.height + 1,
  };
  state.certifiedBoardState = advanceCertifiedBoardFinality(
    board,
    jurisdiction,
    anchor.anchorHeight,
    anchor.anchorBlockHash,
    validated.eventHistoryRoot,
  );
  const recomputed = input.recomputeValuesRoot(state, values.tokenCount);
  if (recomputed !== anchor.provenValuesRoot) fail('VALUES_ROOT_MISMATCH', `${recomputed}:${anchor.provenValuesRoot}`);
  cacheCertifiedBoardNodes(input.env, nodes);
  return state;
};

const J_ANCHOR_FRAME_PAYLOAD_DOMAIN = 'xln.entity-frame.j-anchor-payload.v1';

const normalizeSignerId = (value: unknown): string => String(value || '').trim().toLowerCase();

/**
 * The carried board registry is the whole EntityProvider registry, so the
 * anchor is held to the same canonical frame byte limit as a J range before
 * any of its values are hashed.
 */
const assertJAnchorFrameBudget =(data: JHistoryAnchorTxData): void => {
  if (!data?.values || !Array.isArray(data.values.boardRecords) || !(data.values.reserves instanceof Map)) {
    fail('VALUES_INVALID');
  }
  const byteLength = encodeCanonicalConsensusBytes({
    domain: J_ANCHOR_FRAME_PAYLOAD_DOMAIN,
    version: 1,
    anchor: data,
  }).byteLength;
  if (byteLength > MAX_ENTITY_FRAME_J_RANGE_BYTES) {
    fail('FRAME_BYTE_LIMIT_EXCEEDED', `${byteLength}:${MAX_ENTITY_FRAME_J_RANGE_BYTES}`);
  }
};

/**
 * Proposer side of 'j_anchor', the sibling of buildCertifiedJPrefixTx. The
 * header fields must come from a hash-bound header and the values from
 * storage proven against its stateRoot; the claim roots them over that block
 * and is signed with the proposer's own key. Admission stays in applyJAnchor.
 */
export const buildJAnchorTx = (
  env: EntityRuntimeContext,
  entityState: EntityState,
  proposerSignerId: string,
  header: { anchorHeight: number; anchorBlockHash: string; stateRoot: string },
  values: JHistoryAnchorValues,
): Extract<EntityTx, { type: 'j_anchor' }> => {
  const jurisdiction = entityState.config.jurisdiction ?? fail('JURISDICTION_MISSING');
  const from = normalizeSignerId(proposerSignerId);
  const anchor = {
    jurisdictionRef: getJEventJurisdictionRef(jurisdiction),
    anchorHeight: header.anchorHeight,
    anchorBlockHash: header.anchorBlockHash.toLowerCase(),
    stateRoot: header.stateRoot.toLowerCase(),
    provenValuesRoot: buildCarriedProvenValues({
      jurisdiction,
      entityId: entityState.entityId,
      blockNumber: header.anchorHeight,
      blockHash: header.anchorBlockHash,
      values,
    }).root,
  };
  const baseHeight = getJHistoryRegistrationBaseHeight(jurisdiction);
  const digest = buildJHistoryAnchorClaimDigest({ ...anchor, entityId: entityState.entityId, signerId: from, baseHeight });
  const data: JHistoryAnchorTxData = {
    from,
    baseHeight,
    ...anchor,
    signature: signAccountFrame(env, from, digest).toLowerCase(),
    values,
  };
  assertJAnchorFrameBudget(data);
  return { type: 'j_anchor', data };
};

/**
 * Entity transition for 'j_anchor', the sibling of applyJEvent. The claim is
 * authenticated exactly as at registration base; only then is a delivery
 * already covered by finality a no-op (the range rule: scanned <= finalized).
 * Any other rejection halts, like an invalid range.
 */
export const applyJAnchor = (
  entityState: EntityState,
  data: JHistoryAnchorTxData,
  env: EntityRuntimeContext,
  mutableFrameState = false,
): EntityState => {
  const reject = (code: string): never => {
    if (code === 'J_ANCHOR_PROPOSER_SIGNATURE_INVALID') {
      throw haltRuntimeFailure(
        'J_ANCHOR_PROPOSER_SIGNATURE_INVALID',
        `j_anchor rejected: invalid proposer signature for ${normalizeSignerId(data?.from)}`,
      );
    }
    throw haltRuntimeFailure('J_ANCHOR_REJECTED', `j_anchor rejected: ${code}`);
  };
  const activeProposerId = normalizeSignerId(getEntityLeaderState(entityState).activeValidatorId);
  if (normalizeSignerId(data?.from) !== activeProposerId) reject('J_ANCHOR_NOT_ACTIVE_PROPOSER');
  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction) return reject('J_ANCHOR_JURISDICTION_MISSING');
  let recomputedValuesRoot: string;
  try {
    assertJAnchorFrameBudget(data);
    recomputedValuesRoot = buildCarriedProvenValues({
      jurisdiction,
      entityId: entityState.entityId,
      blockNumber: data.anchorHeight,
      blockHash: data.anchorBlockHash,
      values: data.values,
    }).root;
  } catch (error) {
    return reject(error instanceof Error ? error.message : 'J_ANCHOR_VALUES_INVALID');
  }
  const finality = entityState.jHistoryFinality;
  const validated = validateJHistoryAnchorClaim({
    entityId: entityState.entityId,
    state: finality
      ? { config: entityState.config, lastFinalizedJHeight: getJHistoryRegistrationBaseHeight(jurisdiction) }
      : entityState,
    expectedJurisdictionRef: getJEventJurisdictionRef(jurisdiction),
    activeProposerId,
    data,
    recomputedValuesRoot,
    verifySignature: (signerId, digest, signature) => verifyAccountSignature(env, signerId, digest, signature),
  });
  if (!validated.ok) return reject(validated.code);
  if (finality) {
    if (validated.anchor.anchorHeight <= Number(entityState.lastFinalizedJHeight ?? 0)) return entityState;
    return reject('J_ANCHOR_FINALITY_EXISTS');
  }
  return applyJHistoryAnchor({
    entityState,
    state: prepareEntityTxState(entityState, mutableFrameState),
    env,
    validated,
    signature: String(data.signature ?? '').trim().toLowerCase(),
    values: data.values,
    recomputeValuesRoot: (after, tokenCount) =>
      buildEntityProvenValuesFromFold(after, jurisdiction, tokenCount).root,
  });
};
