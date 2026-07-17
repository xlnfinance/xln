import { keccak256 } from 'ethers';

import { HTLC } from '../../constants';
import type { AccountMachine, EntityState, EntityTx, Env, HtlcLock } from '../../types';
import { encodeCanonicalEntityConsensusValue } from '../../entity/consensus/state-root';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../../jurisdiction/board-registry';
import { verifyHankoForHash } from '../../hanko/signing';
import {
  computeHtlcEnvelopeContextHash,
  computeHtlcSecretOfferContextHash,
  type HtlcEnvelope,
  validateEnvelope,
} from './envelope';
import {
  isMultiRecipientCiphertext,
  type MultiRecipientCiphertext,
  validateMultiRecipientCiphertext,
} from './multi-recipient';
import { hashHtlcSecret } from './utils';

export type HtlcOnionAdvanceTx = Extract<EntityTx, { type: 'htlcOnionAdvance' }>;

const exactKeys = (value: object, expected: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (encodeCanonicalEntityConsensusValue(actual) !== encodeCanonicalEntityConsensusValue(canonicalExpected)) {
    throw new Error(code);
  }
};

const normalizeEntityId = (value: unknown, code: string): string => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(code);
  return normalized;
};

const normalizeBytes32 = (value: unknown, code: string): string => {
  const normalized = String(value ?? '').trim().toLowerCase();
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

export const encryptedHtlcLayer = (envelope: HtlcLock['envelope']): MultiRecipientCiphertext | null => {
  if (isMultiRecipientCiphertext(envelope)) return envelope;
  if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
    return isMultiRecipientCiphertext(envelope.innerEnvelope) ? envelope.innerEnvelope : null;
  }
  return null;
};

export const hashEncryptedHtlcLayer = (layer: MultiRecipientCiphertext): string =>
  keccak256(new TextEncoder().encode(encodeCanonicalEntityConsensusValue(layer))).toLowerCase();

const requireDefaultProposer = (state: EntityState): string => {
  const signerId = String(state.config.validators[0] ?? '').trim().toLowerCase();
  if (!signerId) throw new Error('HTLC_ONION_DEFAULT_PROPOSER_REQUIRED');
  return signerId;
};

const accountAndLock = (
  state: EntityState,
  inboundEntityId: string,
  inboundLockId: string,
): { account: AccountMachine; lock: HtlcLock } => {
  const account = state.accounts.get(inboundEntityId);
  if (!account) throw new Error('HTLC_ONION_ADVANCE_INBOUND_ACCOUNT_MISSING');
  const lock = account.locks.get(inboundLockId);
  if (!lock) throw new Error('HTLC_ONION_ADVANCE_INBOUND_LOCK_MISSING');
  return { account, lock };
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

export const htlcSecretOfferContextHash = (
  payerEntityId: string,
  beneficiaryEntityId: string,
  lock: HtlcLock,
): string => computeHtlcSecretOfferContextHash({
  payerEntityId,
  beneficiaryEntityId,
  entityId: beneficiaryEntityId,
  lockId: lock.lockId,
  hashlock: lock.hashlock,
  tokenId: lock.tokenId,
  amount: lock.amount,
  timelock: lock.timelock,
  revealBeforeHeight: lock.revealBeforeHeight,
});

export const validateHtlcSecretOfferForLock = async (
  env: Env,
  observerState: EntityState,
  payerEntityId: string,
  beneficiaryEntityId: string,
  lock: HtlcLock,
  offer: MultiRecipientCiphertext,
): Promise<MultiRecipientCiphertext> => {
  const recipientSignerId = observerState.entityId.toLowerCase() === payerEntityId.toLowerCase()
    ? requireDefaultProposer(observerState)
    : String(offer.recipients[0]?.signerId ?? '').trim().toLowerCase();
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
  env: Env,
  state: EntityState,
  lock: HtlcLock,
): Promise<MultiRecipientCiphertext> => {
  const layer = encryptedHtlcLayer(lock.envelope);
  if (!layer) throw new Error(`HTLC_ENCRYPTED_LAYER_REQUIRED:${lock.lockId}`);
  validateMultiRecipientCiphertext(
    layer,
    state.entityId,
    layerContextHash(state, lock),
    requireDefaultProposer(state),
  );
  const certification = layer.profileCertification;
  const registeredBoardHash = resolveObserverCertifiedBoardHash(
    state,
    getCertifiedBoardNodeStore(env),
    state.entityId,
  );
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

export const validateHtlcOnionAdvanceTx = async (
  env: Env,
  state: EntityState,
  tx: HtlcOnionAdvanceTx,
): Promise<{ tx: HtlcOnionAdvanceTx }> => {
  exactKeys(tx, ['type', 'data'], 'HTLC_ONION_ADVANCE_TX_FIELDS_INVALID');
  exactKeys(tx.data, [
    'version', 'proposerSignerId', 'inboundEntityId', 'inboundLockId', 'encryptedLayerHash',
    'hashlock', 'tokenId', 'amount', 'timelock', 'revealBeforeHeight', 'advance',
  ], 'HTLC_ONION_ADVANCE_FIELDS_INVALID');
  if (tx.data.version !== 1) throw new Error('HTLC_ONION_ADVANCE_VERSION_INVALID');
  const proposerSignerId = String(tx.data.proposerSignerId ?? '').trim().toLowerCase();
  if (proposerSignerId !== requireDefaultProposer(state)) {
    throw new Error('HTLC_ONION_ADVANCE_PROPOSER_MISMATCH');
  }
  const inboundEntityId = normalizeEntityId(tx.data.inboundEntityId, 'HTLC_ONION_ADVANCE_INBOUND_ENTITY_INVALID');
  const inboundLockId = String(tx.data.inboundLockId ?? '');
  if (!inboundLockId) throw new Error('HTLC_ONION_ADVANCE_INBOUND_LOCK_ID_INVALID');
  const live = tx.data.advance.kind === 'revealAccepted'
    ? null
    : accountAndLock(state, inboundEntityId, inboundLockId);
  const lock = live?.lock;
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
  if (lock) {
    if (
      hashlock !== lock.hashlock.toLowerCase()
      || tx.data.tokenId !== lock.tokenId
      || amount !== lock.amount
      || timelock !== lock.timelock
      || revealBeforeHeight !== lock.revealBeforeHeight
    ) {
      throw new Error('HTLC_ONION_ADVANCE_LOCK_BINDING_MISMATCH');
    }
  }

  let advance: HtlcOnionAdvanceTx['data']['advance'];
  if (tx.data.advance.kind === 'final') {
    if (!lock) throw new Error('HTLC_ONION_ADVANCE_INBOUND_LOCK_MISSING');
    exactKeys(tx.data.advance, [
      'kind', 'secretOffer',
      ...(tx.data.advance.description !== undefined ? ['description'] : []),
      ...(tx.data.advance.startedAtMs !== undefined ? ['startedAtMs'] : []),
    ], 'HTLC_ONION_ADVANCE_FINAL_FIELDS_INVALID');
    const layer = await validateLocalCommittedHtlcLayer(env, state, lock);
    if (encryptedLayerHash !== hashEncryptedHtlcLayer(layer)) {
      throw new Error('HTLC_ONION_ADVANCE_LAYER_HASH_MISMATCH');
    }
    const secretOffer = await validateHtlcSecretOfferForLock(
      env,
      state,
      inboundEntityId,
      state.entityId,
      lock,
      tx.data.advance.secretOffer,
    );
    const finalEnvelope: HtlcEnvelope = {
      finalRecipient: true,
      secretOffer,
      ...(tx.data.advance.description !== undefined ? { description: tx.data.advance.description } : {}),
      ...(tx.data.advance.startedAtMs !== undefined ? { startedAtMs: tx.data.advance.startedAtMs } : {}),
    };
    validateEnvelope(finalEnvelope);
    advance = {
      kind: 'final',
      secretOffer,
      ...(finalEnvelope.description !== undefined ? { description: finalEnvelope.description } : {}),
      ...(finalEnvelope.startedAtMs !== undefined ? { startedAtMs: finalEnvelope.startedAtMs } : {}),
    };
  } else if (tx.data.advance.kind === 'acceptOffer') {
    if (!lock) throw new Error('HTLC_ONION_ADVANCE_INBOUND_LOCK_MISSING');
    exactKeys(
      tx.data.advance,
      ['kind', 'offerHash'],
      'HTLC_ONION_ADVANCE_ACCEPT_FIELDS_INVALID',
    );
    const offer = lock.secretOffer;
    if (!offer) throw new Error('HTLC_ONION_ADVANCE_COMMITTED_SECRET_OFFER_REQUIRED');
    await validateHtlcSecretOfferForLock(env, state, state.entityId, inboundEntityId, lock, offer);
    const offerHash = normalizeBytes32(tx.data.advance.offerHash, 'HTLC_ONION_ADVANCE_OFFER_HASH_INVALID');
    if (offerHash !== hashEncryptedHtlcLayer(offer) || encryptedLayerHash !== offerHash) {
      throw new Error('HTLC_ONION_ADVANCE_OFFER_HASH_MISMATCH');
    }
    const route = state.htlcRoutes.get(hashlock);
    if (!route || route.outboundEntity?.toLowerCase() !== inboundEntityId || route.outboundLockId !== inboundLockId) {
      throw new Error('HTLC_ONION_ADVANCE_OUTBOUND_ROUTE_MISMATCH');
    }
    advance = { kind: 'acceptOffer', offerHash };
  } else if (tx.data.advance.kind === 'revealAccepted') {
    exactKeys(
      tx.data.advance,
      ['kind', 'offerHash', 'accountFrameHash', 'accountFrameHeight', 'secret'],
      'HTLC_ONION_ADVANCE_REVEAL_FIELDS_INVALID',
    );
    const route = state.htlcRoutes.get(hashlock);
    if (!route || route.outboundEntity?.toLowerCase() !== inboundEntityId || route.outboundLockId !== inboundLockId) {
      throw new Error('HTLC_ONION_ADVANCE_REVEAL_ROUTE_MISMATCH');
    }
    // A forwarding route stores the gross inbound amount and the earned fee.
    // The accepted downstream Account lock is bound to the net amount.
    const expectedOutboundAmount = route.amount === undefined
      ? undefined
      : route.amount - (route.pendingFee ?? 0n);
    if (
      route.tokenId !== undefined && route.tokenId !== tx.data.tokenId
      || expectedOutboundAmount !== undefined && expectedOutboundAmount !== amount
    ) {
      throw new Error(
        `HTLC_ONION_ADVANCE_REVEAL_ROUTE_BINDING_MISMATCH:` +
        `hashlock=${hashlock}:expectedToken=${String(route.tokenId ?? 'missing')}:` +
        `receivedToken=${tx.data.tokenId}:expectedAmount=${String(expectedOutboundAmount ?? 'missing')}:` +
        `receivedAmount=${amount}`,
      );
    }
    const offerHash = normalizeBytes32(tx.data.advance.offerHash, 'HTLC_ONION_ADVANCE_OFFER_HASH_INVALID');
    const accountFrameHash = normalizeBytes32(
      tx.data.advance.accountFrameHash,
      'HTLC_ONION_ADVANCE_ACCOUNT_FRAME_HASH_INVALID',
    );
    const accountFrameHeight = Number(tx.data.advance.accountFrameHeight);
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
    const secret = String(tx.data.advance.secret ?? '').toLowerCase();
    if (hashHtlcSecret(secret).toLowerCase() !== hashlock) {
      throw new Error('HTLC_ONION_ADVANCE_REVEAL_PREIMAGE_MISMATCH');
    }
    if (encryptedLayerHash !== offerHash) throw new Error('HTLC_ONION_ADVANCE_OFFER_HASH_MISMATCH');
    advance = { kind: 'revealAccepted', offerHash, accountFrameHash, accountFrameHeight, secret };
  } else if (tx.data.advance.kind === 'forward') {
    if (!lock) throw new Error('HTLC_ONION_ADVANCE_INBOUND_LOCK_MISSING');
    exactKeys(
      tx.data.advance,
      ['kind', 'nextHop', 'forwardAmount', 'innerEnvelope'],
      'HTLC_ONION_ADVANCE_FORWARD_FIELDS_INVALID',
    );
    const layer = await validateLocalCommittedHtlcLayer(env, state, lock);
    if (encryptedLayerHash !== hashEncryptedHtlcLayer(layer)) {
      throw new Error('HTLC_ONION_ADVANCE_LAYER_HASH_MISMATCH');
    }
    const nextHop = normalizeEntityId(tx.data.advance.nextHop, 'HTLC_ONION_ADVANCE_NEXT_HOP_INVALID');
    const forwardAmount = normalizePositiveBigInt(
      tx.data.advance.forwardAmount,
      'HTLC_ONION_ADVANCE_FORWARD_AMOUNT_INVALID',
    );
    if (forwardAmount > lock.amount) throw new Error('HTLC_ONION_ADVANCE_FORWARD_AMOUNT_INVALID');
    const forwardTimelock = lock.timelock - BigInt(HTLC.MIN_TIMELOCK_DELTA_MS);
    const forwardRevealBeforeHeight = lock.revealBeforeHeight
      - HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS;
    const forwardContextHash = computeHtlcEnvelopeContextHash({
      entityId: nextHop,
      lockId: `${lock.lockId}-fwd`,
      hashlock,
      tokenId: lock.tokenId,
      amount: forwardAmount,
      timelock: forwardTimelock,
      revealBeforeHeight: forwardRevealBeforeHeight,
    });
    const innerEnvelope = validateMultiRecipientCiphertext(
      tx.data.advance.innerEnvelope,
      nextHop,
      forwardContextHash,
    );
    advance = { kind: 'forward', nextHop, forwardAmount, innerEnvelope };
  } else {
    throw new Error('HTLC_ONION_ADVANCE_KIND_INVALID');
  }

  const normalized: HtlcOnionAdvanceTx = {
    type: 'htlcOnionAdvance',
    data: {
      version: 1,
      proposerSignerId,
      inboundEntityId,
      inboundLockId,
      encryptedLayerHash,
      hashlock,
      tokenId: tx.data.tokenId,
      amount,
      timelock,
      revealBeforeHeight,
      advance,
    },
  };
  if (encodeCanonicalEntityConsensusValue(tx) !== encodeCanonicalEntityConsensusValue(normalized)) {
    throw new Error('HTLC_ONION_ADVANCE_NON_CANONICAL');
  }
  return { tx: normalized };
};
