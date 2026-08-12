import { keccak256 } from 'ethers';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { getAccountPerspective } from '../../account/state/perspective';
import { sameAccountStateDomain } from '../../account/commitment/state-root';
import { deriveDelta } from '../../account/utils';
import { HTLC, LIMITS, TOKENS } from '../../config/constants';
import { quoteHtlcPaymentRoute, type RoutingProfile } from '../../routing/htlc-quote';
import { resolvePaymentDeadlineWindow } from '../../protocol/payments/delivery';
import { createOnionEnvelopes } from '../../protocol/htlc/codec/envelope';
import {
  calculateHopRevealHeight,
  calculateHopTimelock,
  generateLockId,
  hashHtlcSecret,
} from '../../protocol/htlc/utils';
import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import type { EntityInfraContext } from '../../types/entity/infra-context';
import type { PreparedOriginatedHtlcPayment } from '../../types/entity/htlc-infra-context';
import type { EntityTx } from '../../types/entity-tx';
import type { Profile } from '../profile';
import type { EntityState } from '../types';

type HtlcPaymentTx = Extract<EntityTx, { type: 'htlcPayment' }>;

const entityId = (value: unknown, code: string): string => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(code);
  return normalized;
};

const positive = (value: unknown, code: string): bigint => {
  if (typeof value !== 'bigint' || value <= 0n) throw new Error(code);
  return value;
};

const exactRawPayment = (tx: HtlcPaymentTx): void => {
  const allowed = new Set(['amount', 'deliveryMode', 'maxSenderDebit', 'route', 'targetEntityId', 'tokenId', 'description', 'hashlock', 'startedAtMs']);
  if (Object.keys(tx.data).some(key => !allowed.has(key))) throw new Error('HTLC_PAYMENT_FIELDS_INVALID');
  if (!Number.isSafeInteger(tx.data.tokenId) || tx.data.tokenId < 0 || tx.data.tokenId > TOKENS.MAX_TOKEN_ID) {
    throw new Error('HTLC_PAYMENT_TOKEN_INVALID');
  }
  positive(tx.data.amount, 'HTLC_PAYMENT_AMOUNT_INVALID');
  positive(tx.data.maxSenderDebit, 'HTLC_PAYMENT_MAX_SENDER_DEBIT_INVALID');
  if (tx.data.maxSenderDebit < tx.data.amount) throw new Error('HTLC_PAYMENT_MAX_SENDER_DEBIT_BELOW_AMOUNT');
  if (tx.data.deliveryMode !== 'instant' && tx.data.deliveryMode !== 'async') throw new Error('HTLC_PAYMENT_DELIVERY_MODE_INVALID');
  if (tx.data.description !== undefined && (
    typeof tx.data.description !== 'string'
    || tx.data.description !== tx.data.description.trim()
    || new TextEncoder().encode(tx.data.description).byteLength > LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH
  )) throw new Error('HTLC_PAYMENT_DESCRIPTION_INVALID');
};

const normalizeRoute = (raw: readonly string[], source: string, target: string): string[] => {
  const route = raw.map(value => entityId(value, 'HTLC_PAYMENT_ROUTE_ENTITY_INVALID'));
  if (route.length < 2 || route[0] !== source || route.at(-1) !== target) throw new Error('HTLC_PAYMENT_ROUTE_INVALID');
  if (route.length - 1 > HTLC.MAX_HOPS) throw new Error('HTLC_PAYMENT_ROUTE_TOO_LONG');
  const selfRoute = source === target;
  const intermediates = route.slice(1, -1);
  const validSelf = selfRoute && intermediates.length >= 2
    && new Set(intermediates).size === intermediates.length && !intermediates.includes(source);
  if ((!selfRoute && new Set(route).size !== route.length) || (selfRoute && !validSelf)) throw new Error('HTLC_PAYMENT_ROUTE_LOOP');
  return route;
};

const uniqueProfile = (profiles: readonly RoutingProfile[], id: string): RoutingProfile => {
  const matches = profiles.filter(profile => profile.entityId.toLowerCase() === id);
  if (matches.length !== 1) throw new Error(`HTLC_PAYMENT_PROFILE_MATCH_COUNT:${id}:${matches.length}`);
  return matches[0]!;
};

export const hashRawHtlcPaymentTx = (tx: HtlcPaymentTx): string =>
  keccak256(new TextEncoder().encode(encodeCanonicalConsensusValue(tx)));

const keyBytes = (secret: string): Uint8Array => {
  const normalized = secret.startsWith('0x') ? secret.slice(2) : secret;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) throw new Error('HTLC_SOURCE_ENTITY_PRIVATE_KEY_INVALID');
  return Uint8Array.from(normalized.match(/../g)!, value => Number.parseInt(value, 16));
};

export const deriveHtlcPaymentSecret = (privateKey: string, publicContext: Readonly<{
  sourceEntityId: string;
  parentFrameHash: string;
  height: number;
  txIndex: number;
  txHash: string;
}>): string => {
  const bytes = hkdf(
    sha256,
    keyBytes(privateKey),
    sha256(new TextEncoder().encode('xln:htlc-payment-secret:v1:salt')),
    new TextEncoder().encode(encodeCanonicalConsensusValue(publicContext)),
    32,
  );
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
};

export type MaterializeOriginatedHtlcPaymentsInput = Readonly<{
  state: EntityState;
  proposalTxs: readonly EntityTx[];
  profiles: readonly Profile[];
  sourceEntityEncryptionPrivateKey: string;
  parentFrameHash: string;
  height: number;
  resolveRoute(tx: HtlcPaymentTx): Promise<readonly string[]>;
}>;

export const materializeOriginatedHtlcPayments = async (
  input: MaterializeOriginatedHtlcPaymentsInput,
): Promise<PreparedOriginatedHtlcPayment[]> => {
  const originated: PreparedOriginatedHtlcPayment[] = [];
  for (const [txIndex, candidate] of input.proposalTxs.entries()) {
    if (candidate.type !== 'htlcPayment') continue;
    exactRawPayment(candidate);
    const source = entityId(input.state.entityId, 'HTLC_PAYMENT_SOURCE_INVALID');
    const target = entityId(candidate.data.targetEntityId, 'HTLC_PAYMENT_TARGET_INVALID');
    const selectedRoute = candidate.data.route.length > 0 ? candidate.data.route : await input.resolveRoute(candidate);
    const route = normalizeRoute(selectedRoute, source, target);
    const txHash = hashRawHtlcPaymentTx(candidate);
    const secret = deriveHtlcPaymentSecret(input.sourceEntityEncryptionPrivateKey, {
      sourceEntityId: source, parentFrameHash: input.parentFrameHash,
      height: input.height, txIndex, txHash,
    });
    const hashlock = hashHtlcSecret(secret).toLowerCase();
    if (candidate.data.hashlock !== undefined && candidate.data.hashlock.toLowerCase() !== hashlock) {
      throw new Error('HTLC_PAYMENT_HASHLOCK_MISMATCH');
    }
    const startedAtMs = candidate.data.startedAtMs ?? input.state.timestamp;
    if (!Number.isSafeInteger(startedAtMs) || startedAtMs !== input.state.timestamp) throw new Error('HTLC_PAYMENT_STARTED_AT_INVALID');
    const quote = quoteHtlcPaymentRoute(input.profiles, route, candidate.data.tokenId, candidate.data.amount);
    if (quote.senderLockAmount > candidate.data.maxSenderDebit) throw new Error('HTLC_PAYMENT_MAX_SENDER_DEBIT_EXCEEDED');
    const window = resolvePaymentDeadlineWindow({
      mode: candidate.data.deliveryMode,
      runtimeJHeight: input.state.lastFinalizedJHeight,
      timestamp: startedAtMs,
      totalHops: route.length - 1,
    });
    const timelock = calculateHopTimelock(window.baseTimelock, 0);
    const revealBeforeHeight = calculateHopRevealHeight(window.baseHeight, 0, route.length - 1);
    const lockId = generateLockId(hashlock, input.height, txIndex, startedAtMs).toLowerCase();
    const sourceProfile = uniqueProfile(input.profiles, source);
    if (sourceProfile.entityEncryptionPublicKey !== input.state.entityEncryptionPublicKey) {
      throw new Error('HTLC_PAYMENT_SOURCE_PROFILE_KEY_MISMATCH');
    }
    const publicKeys = new Map(route.map(id => [id, uniqueProfile(input.profiles, id).entityEncryptionPublicKey]));
    const domains = route.slice(0, -1).map((from, index) => {
      const to = route[index + 1]!;
      const fromAccount = uniqueProfile(input.profiles, from).accounts.find(row => row.counterpartyId.toLowerCase() === to);
      const toAccount = uniqueProfile(input.profiles, to).accounts.find(row => row.counterpartyId.toLowerCase() === from);
      if (!fromAccount || !toAccount) throw new Error(`HTLC_PAYMENT_PROFILE_ACCOUNT_MISSING:${from}:${to}`);
      if (!sameAccountStateDomain(fromAccount.domain, toAccount.domain)) {
        throw new Error(`HTLC_PAYMENT_PROFILE_ACCOUNT_DOMAIN_MISMATCH:${from}:${to}`);
      }
      if (index === 0) {
        const localAccount = input.state.accounts.get(to);
        if (!localAccount || !sameAccountStateDomain(localAccount.state.domain, fromAccount.domain)) {
          throw new Error(`HTLC_PAYMENT_SOURCE_ACCOUNT_DOMAIN_MISMATCH:${source}:${to}`);
        }
      }
      return fromAccount.domain;
    });
    const envelope = await createOnionEnvelopes(
      route, secret, publicKeys, domains, input.sourceEntityEncryptionPrivateKey,
      quote.hopForwardAmounts, candidate.data.description, startedAtMs,
      { rootLockId: lockId, hashlock, tokenId: candidate.data.tokenId, senderLockAmount: quote.senderLockAmount, timelock, revealBeforeHeight },
      { sourceEntityId: source, parentFrameHash: input.parentFrameHash, entityHeight: input.height, paymentTxHash: txHash },
    );
    originated.push({
      txHash, targetEntityId: target, tokenId: candidate.data.tokenId, recipientAmount: candidate.data.amount,
      route, description: candidate.data.description ?? '', deliveryMode: candidate.data.deliveryMode, startedAtMs,
      hashlock, senderLockAmount: quote.senderLockAmount, maxSenderDebit: candidate.data.maxSenderDebit,
      totalFee: quote.senderLockAmount - candidate.data.amount, lockId, timelock, revealBeforeHeight,
      nextHopEntityId: route[1]!, envelope,
    });
  }
  originated.sort((left, right) => left.txHash.localeCompare(right.txHash));
  for (let index = 1; index < originated.length; index += 1) {
    if (originated[index - 1]!.txHash === originated[index]!.txHash) throw new Error(`HTLC_PAYMENT_TX_DUPLICATE:${originated[index]!.txHash}`);
  }
  return originated;
};

export const validatePreparedHtlcPayment = (
  state: EntityState,
  tx: HtlcPaymentTx,
  infraContext: EntityInfraContext | undefined,
): PreparedOriginatedHtlcPayment => {
  exactRawPayment(tx);
  if (!infraContext) throw new Error('HTLC_PAYMENT_INFRA_CONTEXT_REQUIRED');
  const txHash = hashRawHtlcPaymentTx(tx);
  const prepared = infraContext.htlc.originated.find(entry => entry.txHash === txHash);
  if (!prepared) throw new Error(`HTLC_PAYMENT_PREPARED_CONTEXT_REQUIRED:${txHash}`);
  if (prepared.targetEntityId !== tx.data.targetEntityId.toLowerCase()
    || prepared.tokenId !== tx.data.tokenId || prepared.recipientAmount !== tx.data.amount
    || prepared.maxSenderDebit !== tx.data.maxSenderDebit || prepared.deliveryMode !== tx.data.deliveryMode
    || prepared.startedAtMs !== (tx.data.startedAtMs ?? state.timestamp)) {
    throw new Error(`HTLC_PAYMENT_PREPARED_CONTEXT_MISMATCH:${txHash}`);
  }
  const account = state.accounts.get(prepared.nextHopEntityId);
  const delta = account?.state.deltas.get(prepared.tokenId);
  if (!account || !delta || deriveDelta(delta, getAccountPerspective(account.state, state.entityId).iAmLeft).outCapacity < prepared.senderLockAmount) {
    throw new Error(`HTLC_PAYMENT_OUTBOUND_CAPACITY_INSUFFICIENT:${txHash}`);
  }
  return prepared;
};
