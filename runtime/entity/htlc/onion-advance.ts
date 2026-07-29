import { HTLC } from '../../config/constants';
import type { HtlcLock } from '../../types/account';
import type { EntityState } from '../types';
import type { RuntimeState } from '../../types';
import type { EntityTx } from '../../types/entity-tx';

import { getCertifiedBoardNodeStore, resolveObserverCertifiedBoardHash } from '../../jurisdiction/board-registry';
import { verifyHankoForHash } from '../../hanko/signing';
import { encodeCanonicalConsensusValue } from '../../protocol/canonical-consensus-value';
import {
  computeHtlcEnvelopeContextHash,
  type HtlcEnvelope,
  validateEnvelope,
} from '../../protocol/htlc/envelope';
import {
  type MultiRecipientCiphertext,
  validateMultiRecipientCiphertext,
} from '../../protocol/htlc/multi-recipient';
import {
  encryptedHtlcLayer,
  hashEncryptedHtlcLayer,
  htlcSecretOfferContextHash,
  type HtlcEncryptedEnvelope,
} from '../../protocol/htlc/onion-layer';
import { hashHtlcSecret } from '../../protocol/htlc/utils';

export type HtlcOnionAdvanceTx = Extract<EntityTx, { type: 'htlcOnionAdvance' }>;
const exactKeys = (value: object, expected: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (encodeCanonicalConsensusValue(actual) !== encodeCanonicalConsensusValue(canonicalExpected)) {
    throw new Error(code);
  }
};

const normalizeEntityId = (value: unknown, code: string): string => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(code);
  return normalized;
};

const normalizeBytes32 = (value: unknown, code: string): string => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(code);
  return normalized;
};

const normalizePositiveBigInt = (value: unknown, code: string): bigint => {
  let normalized: bigint;
  try {
    normalized = typeof value === 'bigint' ? value : BigInt(String(value));
  } catch {
    throw new Error(code);
  }
  if (normalized <= 0n) throw new Error(code);
  return normalized;
};

const requireDefaultProposer = (state: EntityState): string => {
  const signerId = String(state.config.validators[0] ?? '')
    .trim()
    .toLowerCase();
  if (!signerId) throw new Error('HTLC_ONION_DEFAULT_PROPOSER_REQUIRED');
  return signerId;
};

const accountAndLock = (state: EntityState, inboundEntityId: string, inboundLockId: string): HtlcLock => {
  const account = state.accounts.get(inboundEntityId);
  if (!account) throw new Error('HTLC_ONION_ADVANCE_INBOUND_ACCOUNT_MISSING');
  const lock = account.locks.get(inboundLockId);
  if (!lock) throw new Error('HTLC_ONION_ADVANCE_INBOUND_LOCK_MISSING');
  return lock;
};

const layerContextHash = (state: EntityState, lock: HtlcLock): string =>
  computeHtlcEnvelopeContextHash({
    entityId: state.entityId,
    lockId: lock.lockId,
    hashlock: lock.hashlock,
    tokenId: lock.tokenId,
    amount: lock.amount,
    timelock: lock.timelock,
    revealBeforeHeight: lock.revealBeforeHeight,
  });

export const validateHtlcSecretOfferForLock = async (
  env: RuntimeState,
  observerState: EntityState,
  payerEntityId: string,
  beneficiaryEntityId: string,
  lock: HtlcLock,
  offer: MultiRecipientCiphertext,
): Promise<MultiRecipientCiphertext> => {
  const recipientSignerId =
    observerState.entityId.toLowerCase() === payerEntityId.toLowerCase()
      ? requireDefaultProposer(observerState)
      : String(offer.recipients[0]?.signerId ?? '')
          .trim()
          .toLowerCase();
  if (!recipientSignerId) throw new Error('HTLC_SECRET_OFFER_DEFAULT_PROPOSER_REQUIRED');
  const normalized = validateMultiRecipientCiphertext(
    offer,
    payerEntityId,
    htlcSecretOfferContextHash(payerEntityId, beneficiaryEntityId, lock),
    recipientSignerId,
  );
  const registeredBoardHash = resolveObserverCertifiedBoardHash(
    observerState,
    getCertifiedBoardNodeStore(env),
    payerEntityId,
  );
  const certified = await verifyHankoForHash(
    normalized.profileCertification.hanko,
    normalized.profileCertification.profileHash,
    payerEntityId,
    env,
    registeredBoardHash ? { registeredBoardHash } : undefined,
  );
  if (!certified.valid) throw new Error(`HTLC_SECRET_OFFER_PROFILE_HANKO_INVALID:${payerEntityId}`);
  return normalized;
};

export const validateLocalCommittedHtlcLayer = async (
  env: RuntimeState,
  state: EntityState,
  lock: HtlcLock,
  envelope: HtlcEncryptedEnvelope,
): Promise<MultiRecipientCiphertext> => {
  const layer = encryptedHtlcLayer(envelope);
  if (!layer) throw new Error(`HTLC_ENCRYPTED_LAYER_REQUIRED:${lock.lockId}`);
  validateMultiRecipientCiphertext(layer, state.entityId, layerContextHash(state, lock), requireDefaultProposer(state));
  const certification = layer.profileCertification;
  const registeredBoardHash = resolveObserverCertifiedBoardHash(state, getCertifiedBoardNodeStore(env), state.entityId);
  const certified = await verifyHankoForHash(
    certification.hanko,
    certification.profileHash,
    state.entityId,
    env,
    registeredBoardHash ? { registeredBoardHash } : undefined,
  );
  if (!certified.valid) throw new Error(`HTLC_ENCRYPTION_PROFILE_HANKO_INVALID:${state.entityId}`);
  return layer;
};

export const buildHtlcOnionAdvanceTx = (
  state: EntityState,
  inboundEntityId: string,
  lock: HtlcLock,
  layer: MultiRecipientCiphertext,
  envelope: HtlcEnvelope,
): HtlcOnionAdvanceTx => {
  validateEnvelope(envelope);
  const common = {
    version: 1 as const,
    proposerSignerId: requireDefaultProposer(state),
    inboundEntityId: normalizeEntityId(inboundEntityId, 'HTLC_ONION_ADVANCE_INBOUND_ENTITY_INVALID'),
    inboundLockId: lock.lockId,
    encryptedLayerHash: hashEncryptedHtlcLayer(layer),
    hashlock: normalizeBytes32(lock.hashlock, 'HTLC_ONION_ADVANCE_HASHLOCK_INVALID'),
    tokenId: lock.tokenId,
    amount: lock.amount,
    timelock: lock.timelock,
    revealBeforeHeight: lock.revealBeforeHeight,
  };
  if (envelope.finalRecipient) {
    if (!envelope.secretOffer) throw new Error('HTLC_ONION_ADVANCE_SECRET_OFFER_REQUIRED');
    return {
      type: 'htlcOnionAdvance',
      data: {
        ...common,
        advance: {
          kind: 'final',
          secretOffer: envelope.secretOffer,
          ...(envelope.description !== undefined ? { description: envelope.description } : {}),
          ...(envelope.startedAtMs !== undefined ? { startedAtMs: envelope.startedAtMs } : {}),
        },
      },
    };
  }
  const innerEnvelope = envelope.innerEnvelope;
  if (!envelope.nextHop || !innerEnvelope) throw new Error('HTLC_ONION_ADVANCE_FORWARD_INVALID');
  return {
    type: 'htlcOnionAdvance',
    data: {
      ...common,
      advance: {
        kind: 'forward',
        nextHop: normalizeEntityId(envelope.nextHop, 'HTLC_ONION_ADVANCE_NEXT_HOP_INVALID'),
        forwardAmount: normalizePositiveBigInt(envelope.forwardAmount, 'HTLC_ONION_ADVANCE_FORWARD_AMOUNT_INVALID'),
        innerEnvelope,
      },
    },
  };
};

export const buildHtlcOnionAcceptOfferTx = (
  state: EntityState,
  downstreamEntityId: string,
  lock: HtlcLock,
  offer: MultiRecipientCiphertext,
): HtlcOnionAdvanceTx => ({
  type: 'htlcOnionAdvance',
  data: {
    version: 1,
    proposerSignerId: requireDefaultProposer(state),
    inboundEntityId: normalizeEntityId(downstreamEntityId, 'HTLC_ONION_ADVANCE_INBOUND_ENTITY_INVALID'),
    inboundLockId: lock.lockId,
    encryptedLayerHash: hashEncryptedHtlcLayer(offer),
    hashlock: normalizeBytes32(lock.hashlock, 'HTLC_ONION_ADVANCE_HASHLOCK_INVALID'),
    tokenId: lock.tokenId,
    amount: lock.amount,
    timelock: lock.timelock,
    revealBeforeHeight: lock.revealBeforeHeight,
    advance: {
      kind: 'acceptOffer',
      offerHash: hashEncryptedHtlcLayer(offer),
    },
  },
});

export const buildHtlcOnionRevealAcceptedTx = (
  state: EntityState,
  downstreamEntityId: string,
  lock: HtlcLock,
  offer: MultiRecipientCiphertext,
  accountFrameHash: string,
  accountFrameHeight: number,
  secret: string,
): HtlcOnionAdvanceTx => ({
  type: 'htlcOnionAdvance',
  data: {
    version: 1,
    proposerSignerId: requireDefaultProposer(state),
    inboundEntityId: normalizeEntityId(downstreamEntityId, 'HTLC_ONION_ADVANCE_INBOUND_ENTITY_INVALID'),
    inboundLockId: lock.lockId,
    encryptedLayerHash: hashEncryptedHtlcLayer(offer),
    hashlock: normalizeBytes32(lock.hashlock, 'HTLC_ONION_ADVANCE_HASHLOCK_INVALID'),
    tokenId: lock.tokenId,
    amount: lock.amount,
    timelock: lock.timelock,
    revealBeforeHeight: lock.revealBeforeHeight,
    advance: {
      kind: 'revealAccepted',
      offerHash: hashEncryptedHtlcLayer(offer),
      accountFrameHash: normalizeBytes32(accountFrameHash, 'HTLC_ONION_ADVANCE_ACCOUNT_FRAME_HASH_INVALID'),
      accountFrameHeight,
      secret,
    },
  },
});

type HtlcOnionAdvance = HtlcOnionAdvanceTx['data']['advance'];

const requireCommittedLayerHash = (
  lock: HtlcLock,
  encryptedLayerHash: string,
): void => {
  if (!lock.envelopeHash) throw new Error('HTLC_ONION_ADVANCE_LAYER_HASH_MISSING');
  if (encryptedLayerHash !== lock.envelopeHash.toLowerCase()) {
    throw new Error('HTLC_ONION_ADVANCE_LAYER_HASH_MISMATCH');
  }
};

const validateFinalAdvance = async (
  env: RuntimeState,
  state: EntityState,
  inboundEntityId: string,
  lock: HtlcLock,
  encryptedLayerHash: string,
  advance: Extract<HtlcOnionAdvance, { kind: 'final' }>,
): Promise<Extract<HtlcOnionAdvance, { kind: 'final' }>> => {
  exactKeys(
    advance,
    [
      'kind',
      'secretOffer',
      ...(advance.description !== undefined ? ['description'] : []),
      ...(advance.startedAtMs !== undefined ? ['startedAtMs'] : []),
    ],
    'HTLC_ONION_ADVANCE_FINAL_FIELDS_INVALID',
  );
  requireCommittedLayerHash(lock, encryptedLayerHash);
  const secretOffer = await validateHtlcSecretOfferForLock(
    env,
    state,
    inboundEntityId,
    state.entityId,
    lock,
    advance.secretOffer,
  );
  const envelope: HtlcEnvelope = {
    finalRecipient: true,
    secretOffer,
    ...(advance.description !== undefined ? { description: advance.description } : {}),
    ...(advance.startedAtMs !== undefined ? { startedAtMs: advance.startedAtMs } : {}),
  };
  validateEnvelope(envelope);
  return {
    kind: 'final',
    secretOffer,
    ...(envelope.description !== undefined ? { description: envelope.description } : {}),
    ...(envelope.startedAtMs !== undefined ? { startedAtMs: envelope.startedAtMs } : {}),
  };
};

const validateAcceptedOfferAdvance = async (
  env: RuntimeState,
  state: EntityState,
  inboundEntityId: string,
  inboundLockId: string,
  encryptedLayerHash: string,
  hashlock: string,
  lock: HtlcLock,
  advance: Extract<HtlcOnionAdvance, { kind: 'acceptOffer' }>,
): Promise<Extract<HtlcOnionAdvance, { kind: 'acceptOffer' }>> => {
  exactKeys(advance, ['kind', 'offerHash'], 'HTLC_ONION_ADVANCE_ACCEPT_FIELDS_INVALID');
  const offer = lock.secretOffer;
  if (!offer) throw new Error('HTLC_ONION_ADVANCE_COMMITTED_SECRET_OFFER_REQUIRED');
  await validateHtlcSecretOfferForLock(env, state, state.entityId, inboundEntityId, lock, offer);
  const offerHash = normalizeBytes32(advance.offerHash, 'HTLC_ONION_ADVANCE_OFFER_HASH_INVALID');
  if (offerHash !== hashEncryptedHtlcLayer(offer) || encryptedLayerHash !== offerHash) {
    throw new Error('HTLC_ONION_ADVANCE_OFFER_HASH_MISMATCH');
  }
  const route = state.htlcRoutes.get(hashlock);
  if (
    !route
    || route.outboundEntity?.toLowerCase() !== inboundEntityId
    || route.outboundLockId !== inboundLockId
  ) {
    throw new Error('HTLC_ONION_ADVANCE_OUTBOUND_ROUTE_MISMATCH');
  }
  return { kind: 'acceptOffer', offerHash };
};

const validateRevealAcceptedAdvance = (
  state: EntityState,
  tx: HtlcOnionAdvanceTx,
  inboundEntityId: string,
  inboundLockId: string,
  encryptedLayerHash: string,
  hashlock: string,
  amount: bigint,
  advance: Extract<HtlcOnionAdvance, { kind: 'revealAccepted' }>,
): Extract<HtlcOnionAdvance, { kind: 'revealAccepted' }> => {
  exactKeys(
    advance,
    ['kind', 'offerHash', 'accountFrameHash', 'accountFrameHeight', 'secret'],
    'HTLC_ONION_ADVANCE_REVEAL_FIELDS_INVALID',
  );
  const route = state.htlcRoutes.get(hashlock);
  if (
    !route
    || route.outboundEntity?.toLowerCase() !== inboundEntityId
    || route.outboundLockId !== inboundLockId
  ) {
    throw new Error('HTLC_ONION_ADVANCE_REVEAL_ROUTE_MISMATCH');
  }
  // The route stores gross inbound value; its accepted downstream lock is net.
  const expectedAmount = route.amount === undefined
    ? undefined
    : route.amount - (route.pendingFee ?? 0n);
  if (
    (route.tokenId !== undefined && route.tokenId !== tx.data.tokenId)
    || (expectedAmount !== undefined && expectedAmount !== amount)
  ) {
    throw new Error(
      `HTLC_ONION_ADVANCE_REVEAL_ROUTE_BINDING_MISMATCH:` +
        `hashlock=${hashlock}:expectedToken=${String(route.tokenId ?? 'missing')}:` +
        `receivedToken=${tx.data.tokenId}:expectedAmount=${String(expectedAmount ?? 'missing')}:` +
        `receivedAmount=${amount}`,
    );
  }
  const offerHash = normalizeBytes32(advance.offerHash, 'HTLC_ONION_ADVANCE_OFFER_HASH_INVALID');
  const accountFrameHash = normalizeBytes32(
    advance.accountFrameHash,
    'HTLC_ONION_ADVANCE_ACCOUNT_FRAME_HASH_INVALID',
  );
  const accountFrameHeight = Number(advance.accountFrameHeight);
  if (!Number.isSafeInteger(accountFrameHeight) || accountFrameHeight < 1) {
    throw new Error('HTLC_ONION_ADVANCE_ACCOUNT_FRAME_HEIGHT_INVALID');
  }
  if (
    route.acceptedOfferHash !== offerHash
    || route.acceptedAccountFrameHash !== accountFrameHash
    || route.acceptedAccountFrameHeight !== accountFrameHeight
  ) {
    throw new Error('HTLC_ONION_ADVANCE_REVEAL_ACK_BINDING_MISMATCH');
  }
  const secret = String(advance.secret ?? '').toLowerCase();
  if (hashHtlcSecret(secret).toLowerCase() !== hashlock) {
    throw new Error('HTLC_ONION_ADVANCE_REVEAL_PREIMAGE_MISMATCH');
  }
  if (encryptedLayerHash !== offerHash) {
    throw new Error('HTLC_ONION_ADVANCE_OFFER_HASH_MISMATCH');
  }
  return { kind: 'revealAccepted', offerHash, accountFrameHash, accountFrameHeight, secret };
};

const validateForwardAdvance = (
  lock: HtlcLock,
  encryptedLayerHash: string,
  hashlock: string,
  advance: Extract<HtlcOnionAdvance, { kind: 'forward' }>,
): Extract<HtlcOnionAdvance, { kind: 'forward' }> => {
  exactKeys(
    advance,
    ['kind', 'nextHop', 'forwardAmount', 'innerEnvelope'],
    'HTLC_ONION_ADVANCE_FORWARD_FIELDS_INVALID',
  );
  requireCommittedLayerHash(lock, encryptedLayerHash);
  const nextHop = normalizeEntityId(advance.nextHop, 'HTLC_ONION_ADVANCE_NEXT_HOP_INVALID');
  const forwardAmount = normalizePositiveBigInt(
    advance.forwardAmount,
    'HTLC_ONION_ADVANCE_FORWARD_AMOUNT_INVALID',
  );
  if (forwardAmount > lock.amount) throw new Error('HTLC_ONION_ADVANCE_FORWARD_AMOUNT_INVALID');
  const contextHash = computeHtlcEnvelopeContextHash({
    entityId: nextHop,
    lockId: `${lock.lockId}-fwd`,
    hashlock,
    tokenId: lock.tokenId,
    amount: forwardAmount,
    timelock: lock.timelock - BigInt(HTLC.MIN_TIMELOCK_DELTA_MS),
    revealBeforeHeight: lock.revealBeforeHeight - HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS,
  });
  const innerEnvelope = validateMultiRecipientCiphertext(
    advance.innerEnvelope,
    nextHop,
    contextHash,
  );
  return { kind: 'forward', nextHop, forwardAmount, innerEnvelope };
};

type ValidatedOnionFields = {
  proposerSignerId: string;
  inboundEntityId: string;
  inboundLockId: string;
  encryptedLayerHash: string;
  hashlock: string;
  amount: bigint;
  timelock: bigint;
  revealBeforeHeight: number;
  lock: HtlcLock | null;
};

const validateOnionFields = (
  state: EntityState,
  tx: HtlcOnionAdvanceTx,
): ValidatedOnionFields => {
  if (tx.data.version !== 1) throw new Error('HTLC_ONION_ADVANCE_VERSION_INVALID');
  const proposerSignerId = String(tx.data.proposerSignerId ?? '').trim().toLowerCase();
  if (proposerSignerId !== requireDefaultProposer(state)) {
    throw new Error('HTLC_ONION_ADVANCE_PROPOSER_MISMATCH');
  }
  const inboundEntityId = normalizeEntityId(
    tx.data.inboundEntityId,
    'HTLC_ONION_ADVANCE_INBOUND_ENTITY_INVALID',
  );
  const inboundLockId = String(tx.data.inboundLockId ?? '');
  if (!inboundLockId) throw new Error('HTLC_ONION_ADVANCE_INBOUND_LOCK_ID_INVALID');
  const encryptedLayerHash = normalizeBytes32(
    tx.data.encryptedLayerHash,
    'HTLC_ONION_ADVANCE_LAYER_HASH_INVALID',
  );
  const hashlock = normalizeBytes32(tx.data.hashlock, 'HTLC_ONION_ADVANCE_HASHLOCK_INVALID');
  const amount = normalizePositiveBigInt(tx.data.amount, 'HTLC_ONION_ADVANCE_AMOUNT_INVALID');
  const timelock = normalizePositiveBigInt(tx.data.timelock, 'HTLC_ONION_ADVANCE_TIMELOCK_INVALID');
  const revealBeforeHeight = Number(tx.data.revealBeforeHeight);
  if (!Number.isSafeInteger(tx.data.tokenId) || tx.data.tokenId < 0) {
    throw new Error('HTLC_ONION_ADVANCE_TOKEN_INVALID');
  }
  if (!Number.isSafeInteger(revealBeforeHeight) || revealBeforeHeight < 1) {
    throw new Error('HTLC_ONION_ADVANCE_REVEAL_HEIGHT_INVALID');
  }
  const lock = tx.data.advance.kind === 'revealAccepted'
    ? null
    : accountAndLock(state, inboundEntityId, inboundLockId);
  if (
    lock &&
    (
      hashlock !== lock.hashlock.toLowerCase() ||
      tx.data.tokenId !== lock.tokenId ||
      amount !== lock.amount ||
      timelock !== lock.timelock ||
      revealBeforeHeight !== lock.revealBeforeHeight
    )
  ) {
    throw new Error('HTLC_ONION_ADVANCE_LOCK_BINDING_MISMATCH');
  }
  return {
    proposerSignerId,
    inboundEntityId,
    inboundLockId,
    encryptedLayerHash,
    hashlock,
    amount,
    timelock,
    revealBeforeHeight,
    lock,
  };
};

const validateOnionAdvance = async (
  env: RuntimeState,
  state: EntityState,
  tx: HtlcOnionAdvanceTx,
  fields: ValidatedOnionFields,
): Promise<HtlcOnionAdvanceTx['data']['advance']> => {
  const { advance } = tx.data;
  const { lock, inboundEntityId, inboundLockId, encryptedLayerHash, hashlock, amount } = fields;
  if (advance.kind === 'final') {
    if (!lock) throw new Error('HTLC_ONION_ADVANCE_INBOUND_LOCK_MISSING');
    return validateFinalAdvance(env, state, inboundEntityId, lock, encryptedLayerHash, advance);
  }
  if (advance.kind === 'acceptOffer') {
    if (!lock) throw new Error('HTLC_ONION_ADVANCE_INBOUND_LOCK_MISSING');
    return validateAcceptedOfferAdvance(
      env,
      state,
      inboundEntityId,
      inboundLockId,
      encryptedLayerHash,
      hashlock,
      lock,
      advance,
    );
  }
  if (advance.kind === 'revealAccepted') {
    return validateRevealAcceptedAdvance(
      state,
      tx,
      inboundEntityId,
      inboundLockId,
      encryptedLayerHash,
      hashlock,
      amount,
      advance,
    );
  }
  if (advance.kind === 'forward') {
    if (!lock) throw new Error('HTLC_ONION_ADVANCE_INBOUND_LOCK_MISSING');
    return validateForwardAdvance(lock, encryptedLayerHash, hashlock, advance);
  }
  throw new Error('HTLC_ONION_ADVANCE_KIND_INVALID');
};

export const validateHtlcOnionAdvanceTx = async (
  env: RuntimeState,
  state: EntityState,
  tx: HtlcOnionAdvanceTx,
): Promise<{ tx: HtlcOnionAdvanceTx }> => {
  exactKeys(tx, ['type', 'data'], 'HTLC_ONION_ADVANCE_TX_FIELDS_INVALID');
  exactKeys(
    tx.data,
    [
      'version',
      'proposerSignerId',
      'inboundEntityId',
      'inboundLockId',
      'encryptedLayerHash',
      'hashlock',
      'tokenId',
      'amount',
      'timelock',
      'revealBeforeHeight',
      'advance',
    ],
    'HTLC_ONION_ADVANCE_FIELDS_INVALID',
  );
  const fields = validateOnionFields(state, tx);
  const advance = await validateOnionAdvance(env, state, tx, fields);

  const normalized: HtlcOnionAdvanceTx = {
    type: 'htlcOnionAdvance',
    data: {
      version: 1,
      proposerSignerId: fields.proposerSignerId,
      inboundEntityId: fields.inboundEntityId,
      inboundLockId: fields.inboundLockId,
      encryptedLayerHash: fields.encryptedLayerHash,
      hashlock: fields.hashlock,
      tokenId: tx.data.tokenId,
      amount: fields.amount,
      timelock: fields.timelock,
      revealBeforeHeight: fields.revealBeforeHeight,
      advance,
    },
  };
  if (encodeCanonicalConsensusValue(tx) !== encodeCanonicalConsensusValue(normalized)) {
    throw new Error('HTLC_ONION_ADVANCE_NON_CANONICAL');
  }
  return { tx: normalized };
};
