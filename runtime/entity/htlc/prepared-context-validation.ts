import type { HtlcPreparedInfraContext } from '../../types/entity/htlc-infra-context';
import { assertOpaqueHtlcCiphertext } from '../../protocol/htlc/multi-recipient';
import { normalizeAccountStateDomain } from '../../account/commitment/state-root';
import { LIMITS, TOKENS } from '../../config/constants';

const bytes32 = (value: unknown, code: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(code);
  if (value !== normalized) throw new Error(`${code}_NON_CANONICAL`);
  return normalized;
};

const validatePreparedEntries = (context: HtlcPreparedInfraContext): void => {
  let previousKey = '';
  for (const entry of context.entries) {
    if (!entry || typeof entry !== 'object' || !entry.binding || !entry.outcome) throw new Error('HTLC_PREPARED_ENTRY_INVALID');
    if (Object.keys(entry).sort().join(',') !== 'binding,outcome') throw new Error('HTLC_PREPARED_ENTRY_FIELDS_INVALID');
    const binding = entry.binding;
    if (Object.keys(binding).sort().join(',') !== [
      'accountFrameHash', 'accountHeight', 'amount', 'domain', 'envelopeHash', 'fromEntityId', 'hashlock',
      'lockId', 'revealBeforeHeight', 'timelock', 'toEntityId', 'tokenId',
    ].sort().join(',')) throw new Error('HTLC_PREPARED_BINDING_FIELDS_INVALID');
    bytes32(binding.fromEntityId, 'HTLC_PREPARED_FROM_ENTITY_INVALID');
    bytes32(binding.toEntityId, 'HTLC_PREPARED_TO_ENTITY_INVALID');
    bytes32(binding.accountFrameHash, 'HTLC_PREPARED_ACCOUNT_FRAME_INVALID');
    bytes32(binding.lockId, 'HTLC_PREPARED_LOCK_ID_INVALID');
    bytes32(binding.envelopeHash, 'HTLC_PREPARED_ENVELOPE_HASH_INVALID');
    bytes32(binding.hashlock, 'HTLC_PREPARED_HASHLOCK_INVALID');
    if (!Number.isSafeInteger(binding.accountHeight) || binding.accountHeight < 1) throw new Error('HTLC_PREPARED_ACCOUNT_HEIGHT_INVALID');
    if (
      !Number.isSafeInteger(binding.tokenId) || binding.tokenId < 0 || binding.tokenId > TOKENS.MAX_TOKEN_ID ||
      typeof binding.amount !== 'bigint' || binding.amount <= 0n ||
      typeof binding.timelock !== 'bigint' || binding.timelock <= 0n
    ) {
      throw new Error('HTLC_PREPARED_ECONOMICS_INVALID');
    }
    if (!Number.isSafeInteger(binding.revealBeforeHeight) || binding.revealBeforeHeight < 1) throw new Error('HTLC_PREPARED_REVEAL_HEIGHT_INVALID');
    const domain = normalizeAccountStateDomain(binding.domain, 'HTLC_PREPARED_DOMAIN');
    if (domain.depositoryAddress !== binding.domain.depositoryAddress) throw new Error('HTLC_PREPARED_DOMAIN_NON_CANONICAL');
    const key = `${binding.accountFrameHash}:${binding.lockId}`;
    if (key <= previousKey) throw new Error(key === previousKey ? 'HTLC_PREPARED_BINDING_DUPLICATE' : 'HTLC_PREPARED_ENTRIES_NOT_SORTED');
    previousKey = key;
    if (entry.outcome.kind === 'forward') {
      if (Object.keys(entry.outcome).sort().join(',') !== 'forwardAmount,innerEnvelope,kind,nextHopEntityId') {
        throw new Error('HTLC_PREPARED_FORWARD_FIELDS_INVALID');
      }
      bytes32(entry.outcome.nextHopEntityId, 'HTLC_PREPARED_NEXT_HOP_INVALID');
      if (typeof entry.outcome.forwardAmount !== 'bigint' || entry.outcome.forwardAmount <= 0n || entry.outcome.forwardAmount > binding.amount) {
        throw new Error('HTLC_PREPARED_FORWARD_AMOUNT_INVALID');
      }
      assertOpaqueHtlcCiphertext(entry.outcome.innerEnvelope);
    } else if (entry.outcome.kind === 'final') {
      const allowed = new Set(['kind', 'secret', 'description', 'startedAtMs']);
      if (Object.keys(entry.outcome).some(keyName => !allowed.has(keyName))) throw new Error('HTLC_PREPARED_FINAL_FIELDS_INVALID');
      bytes32(entry.outcome.secret, 'HTLC_PREPARED_FINAL_SECRET_INVALID');
      if (entry.outcome.description !== undefined && (
        typeof entry.outcome.description !== 'string' ||
        new TextEncoder().encode(entry.outcome.description).byteLength > LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH
      )) throw new Error('HTLC_PREPARED_DESCRIPTION_INVALID');
      if (entry.outcome.startedAtMs !== undefined && (!Number.isSafeInteger(entry.outcome.startedAtMs) || entry.outcome.startedAtMs < 0)) {
        throw new Error('HTLC_PREPARED_STARTED_AT_INVALID');
      }
    } else if (entry.outcome.kind === 'reject') {
      if (Object.keys(entry.outcome).sort().join(',') !== 'kind,reason') throw new Error('HTLC_PREPARED_REJECT_FIELDS_INVALID');
      if (!new Set([
        'ciphertext_invalid', 'decrypt_failed', 'next_hop_account_missing', 'next_hop_offline',
        'insufficient_capacity', 'fee_below_policy', 'deadline_unsafe',
      ]).has(entry.outcome.reason)) throw new Error('HTLC_PREPARED_REJECT_REASON_INVALID');
    } else throw new Error('HTLC_PREPARED_OUTCOME_INVALID');
  }
};

const validateOriginRoute = (origin: HtlcPreparedInfraContext['originated'][number]): void => {
  if (!Array.isArray(origin.route) || origin.route.length < 2 || origin.route.length > 101) {
    throw new Error('HTLC_PREPARED_ORIGIN_ROUTE_INVALID');
  }
  origin.route.forEach((routeEntityId: string) => bytes32(routeEntityId, 'HTLC_PREPARED_ORIGIN_ROUTE_ENTITY_INVALID'));
  if (origin.route[0] === origin.route.at(-1)) {
    const intermediates = origin.route.slice(1, -1);
    if (intermediates.length < 2 || new Set(intermediates).size !== intermediates.length || intermediates.includes(origin.route[0]!)) {
      throw new Error('HTLC_PREPARED_ORIGIN_ROUTE_LOOP');
    }
  } else if (new Set(origin.route).size !== origin.route.length) throw new Error('HTLC_PREPARED_ORIGIN_ROUTE_LOOP');
  if (origin.targetEntityId !== origin.route.at(-1) || origin.nextHopEntityId !== origin.route[1]) {
    throw new Error('HTLC_PREPARED_ORIGIN_ROUTE_BINDING_INVALID');
  }
};

const validateOriginEconomics = (origin: HtlcPreparedInfraContext['originated'][number]): void => {
  if (!Number.isSafeInteger(origin.tokenId) || origin.tokenId < 0 || origin.tokenId > TOKENS.MAX_TOKEN_ID) {
    throw new Error('HTLC_PREPARED_ORIGIN_TOKEN_INVALID');
  }
  if (
    typeof origin.recipientAmount !== 'bigint' || origin.recipientAmount <= 0n
    || typeof origin.senderLockAmount !== 'bigint' || origin.senderLockAmount < origin.recipientAmount
    || typeof origin.maxSenderDebit !== 'bigint' || origin.maxSenderDebit < origin.senderLockAmount
    || typeof origin.totalFee !== 'bigint' || origin.totalFee !== origin.senderLockAmount - origin.recipientAmount
    || typeof origin.timelock !== 'bigint' || origin.timelock <= 0n
  ) throw new Error('HTLC_PREPARED_ORIGIN_ECONOMICS_INVALID');
  if (origin.deliveryMode !== 'instant' && origin.deliveryMode !== 'async') throw new Error('HTLC_PREPARED_ORIGIN_MODE_INVALID');
  if (!Number.isSafeInteger(origin.startedAtMs) || origin.startedAtMs <= 0) throw new Error('HTLC_PREPARED_ORIGIN_STARTED_AT_INVALID');
  if (!Number.isSafeInteger(origin.revealBeforeHeight) || origin.revealBeforeHeight <= 0) throw new Error('HTLC_PREPARED_ORIGIN_HEIGHT_INVALID');
  if (typeof origin.description !== 'string'
    || new TextEncoder().encode(origin.description).byteLength > LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH) {
    throw new Error('HTLC_PREPARED_ORIGIN_DESCRIPTION_INVALID');
  }
};

const validatePreparedOrigins = (context: HtlcPreparedInfraContext): void => {
  let previousOriginHash = '';
  const originatedKeys = [
    'deliveryMode', 'description', 'envelope', 'hashlock', 'lockId', 'maxSenderDebit', 'nextHopEntityId',
    'recipientAmount', 'revealBeforeHeight', 'route', 'senderLockAmount', 'startedAtMs', 'targetEntityId',
    'timelock', 'tokenId', 'totalFee', 'txHash',
  ].sort().join(',');
  for (const origin of context.originated) {
    if (!origin || typeof origin !== 'object' || Object.keys(origin).sort().join(',') !== originatedKeys) {
      throw new Error('HTLC_PREPARED_ORIGIN_FIELDS_INVALID');
    }
    bytes32(origin.txHash, 'HTLC_PREPARED_ORIGIN_TX_HASH_INVALID');
    bytes32(origin.targetEntityId, 'HTLC_PREPARED_ORIGIN_TARGET_INVALID');
    bytes32(origin.hashlock, 'HTLC_PREPARED_ORIGIN_HASHLOCK_INVALID');
    bytes32(origin.lockId, 'HTLC_PREPARED_ORIGIN_LOCK_ID_INVALID');
    bytes32(origin.nextHopEntityId, 'HTLC_PREPARED_ORIGIN_NEXT_HOP_INVALID');
    if (origin.txHash <= previousOriginHash) {
      throw new Error(origin.txHash === previousOriginHash
        ? 'HTLC_PREPARED_ORIGIN_DUPLICATE'
        : 'HTLC_PREPARED_ORIGIN_NOT_SORTED');
    }
    previousOriginHash = origin.txHash;
    validateOriginRoute(origin);
    validateOriginEconomics(origin);
    assertOpaqueHtlcCiphertext(origin.envelope);
  }
};

export const validateHtlcPreparedInfraContext = (value: unknown): HtlcPreparedInfraContext => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('HTLC_PREPARED_CONTEXT_INVALID');
  const context = value as HtlcPreparedInfraContext;
  if (
    Object.keys(context).sort().join(',') !== 'entries,originated,version'
    || context.version !== 1 || !Array.isArray(context.entries) || !Array.isArray(context.originated)
  ) throw new Error('HTLC_PREPARED_CONTEXT_INVALID');
  validatePreparedEntries(context);
  validatePreparedOrigins(context);
  return structuredClone(context);
};
