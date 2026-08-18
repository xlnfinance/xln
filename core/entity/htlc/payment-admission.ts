import { keccak256 } from 'ethers';
import { getAccountPerspective } from '../../account/state/perspective';
import { sameAccountStateDomain } from '../../account/commitment/state-root';
import { canProcessAccountTxForDisputeStatus } from '../../account/consensus/dispute/policy';
import { deriveDelta } from '../../account/utils';
import { HTLC, LIMITS, TOKENS } from '../../config/constants';
import { quoteHtlcPaymentRoute, type RoutingProfile } from '../../pathfinding/htlc-quote';
import { resolvePaymentDeadlineWindow } from '../../protocol/payments/delivery';
import { createOnionEnvelopes } from '../../protocol/htlc/codec/envelope';
import {
  calculateHopRevealHeight,
  calculateHopTimelock,
  generateLockId,
  hashHtlcSecret,
} from '../../protocol/htlc/utils';
import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import { getDeterministicHtlcTestSecret } from '../../protocol/htlc/test-secret-capability';
import type { EntityInfraContext } from '../../types/entity/infra-context';
import type { PreparedOriginatedHtlcPayment } from '../../types/entity/htlc-infra-context';
import type { EntityTx } from '../../types/entity-tx';
import { rejectFailure } from '../../protocol/errors/failure-taxonomy';
import { toJHeight, toUnixMs } from '../../protocol/units';
import type { Profile } from '../profile';
import type { EntityState } from '../types';
import type { AccountStateDomain } from '../../types/account';

type HtlcPaymentTx = Extract<EntityTx, { type: 'htlcPayment' }>;

function rejectHtlcPayment(message: string): never {
  throw rejectFailure('HTLC_PAYMENT_INVALID', message);
}

const entityId = (value: unknown, code: string): string => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) return rejectHtlcPayment(code);
  return normalized;
};

const positive = (value: unknown, code: string): bigint => {
  if (typeof value !== 'bigint' || value <= 0n) return rejectHtlcPayment(code);
  return value;
};

const assertRawHtlcPayment = (tx: HtlcPaymentTx): void => {
  const allowed = new Set(['amount', 'deliveryMode', 'maxSenderDebit', 'route', 'targetEntityId', 'tokenId', 'description', 'hashlock', 'startedAtMs']);
  if (Object.keys(tx.data).some(key => !allowed.has(key))) rejectHtlcPayment('HTLC_PAYMENT_FIELDS_INVALID');
  if (!Number.isSafeInteger(tx.data.tokenId) || tx.data.tokenId < 0 || tx.data.tokenId > TOKENS.MAX_TOKEN_ID) {
    rejectHtlcPayment('HTLC_PAYMENT_TOKEN_INVALID');
  }
  positive(tx.data.amount, 'HTLC_PAYMENT_AMOUNT_INVALID');
  positive(tx.data.maxSenderDebit, 'HTLC_PAYMENT_MAX_SENDER_DEBIT_INVALID');
  if (tx.data.maxSenderDebit < tx.data.amount) rejectHtlcPayment('HTLC_PAYMENT_MAX_SENDER_DEBIT_BELOW_AMOUNT');
  if (tx.data.deliveryMode !== 'instant' && tx.data.deliveryMode !== 'async') rejectHtlcPayment('HTLC_PAYMENT_DELIVERY_MODE_INVALID');
  if (tx.data.description !== undefined && (
    typeof tx.data.description !== 'string'
    || tx.data.description !== tx.data.description.trim()
    || new TextEncoder().encode(tx.data.description).byteLength > LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH
  )) rejectHtlcPayment('HTLC_PAYMENT_DESCRIPTION_INVALID');
  if (tx.data.hashlock !== undefined && !/^0x[0-9a-f]{64}$/.test(tx.data.hashlock)) {
    rejectHtlcPayment('HTLC_PAYMENT_HASHLOCK_INVALID');
  }
};

/**
 * Domain of the `from -> to` lane as both Profiles describe it.
 *
 * Only the side that opened an Account advertises it, so a routed hop normally
 * has exactly one row. Where both sides advertise, the two rows must agree:
 * disagreeing domains mean the peers are settling on different jurisdictions
 * and the payment must not be routed through them.
 */
const hopAccountDomain = (
  profiles: readonly RoutingProfile[],
  from: string,
  to: string,
  reject: (reason: string) => never,
): AccountStateDomain => {
  const fromAccount = uniqueProfile(profiles, from).accounts
    .find(row => row.counterpartyId.toLowerCase() === to);
  const toAccount = uniqueProfile(profiles, to).accounts
    .find(row => row.counterpartyId.toLowerCase() === from);
  if (!fromAccount && !toAccount) reject(`HTLC_PAYMENT_PROFILE_ACCOUNT_MISSING:${from}:${to}`);
  if (fromAccount && toAccount && !sameAccountStateDomain(fromAccount.domain, toAccount.domain)) {
    reject(`HTLC_PAYMENT_PROFILE_ACCOUNT_DOMAIN_MISMATCH:${from}:${to}`);
  }
  return (fromAccount ?? toAccount!).domain;
};

const normalizeRoute = (raw: readonly string[], source: string, target: string): string[] => {
  const route = raw.map(value => entityId(value, 'HTLC_PAYMENT_ROUTE_ENTITY_INVALID'));
  if (route.length < 2 || route[0] !== source || route.at(-1) !== target) rejectHtlcPayment('HTLC_PAYMENT_ROUTE_INVALID');
  if (route.length - 1 > HTLC.MAX_HOPS) rejectHtlcPayment('HTLC_PAYMENT_ROUTE_TOO_LONG');
  const selfRoute = source === target;
  const intermediates = route.slice(1, -1);
  const validSelf = selfRoute && intermediates.length >= 2
    && new Set(intermediates).size === intermediates.length && !intermediates.includes(source);
  if ((!selfRoute && new Set(route).size !== route.length) || (selfRoute && !validSelf)) rejectHtlcPayment('HTLC_PAYMENT_ROUTE_LOOP');
  return route;
};

const uniqueProfile = (profiles: readonly RoutingProfile[], id: string): RoutingProfile => {
  const matches = profiles.filter(profile => profile.entityId.toLowerCase() === id);
  if (matches.length !== 1) rejectHtlcPayment(`HTLC_PAYMENT_PROFILE_MATCH_COUNT:${id}:${matches.length}`);
  return matches[0]!;
};

export const hashRawHtlcPaymentTx = (tx: HtlcPaymentTx): string =>
  keccak256(new TextEncoder().encode(encodeCanonicalConsensusValue(tx)));

const secureRandomBytes32Hex = (): string => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
};

/**
 * Proposer-only entropy, created before Entity consensus starts. The preimage
 * is never put in the Entity transaction or prepared context; only the target
 * ciphertext contains it. Validator replay therefore cannot reconstruct the
 * bearer secret from the shared Entity decryption key.
 */
export const generateHtlcPaymentPreimage = (): string => secureRandomBytes32Hex();

const generateHtlcEphemeralPrivateKey = (deterministicTestSeed?: string): string => {
  const digest = deterministicTestSeed === undefined
    ? undefined
    : keccak256(new TextEncoder().encode(deterministicTestSeed)).slice(2);
  const bytes = digest === undefined
    ? globalThis.crypto.getRandomValues(new Uint8Array(32))
    : Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16));
  // Make the serialized private scalar canonical before noble applies the same
  // RFC 7748 clamping internally.
  bytes[0] = bytes[0]! & 248;
  bytes[31] = (bytes[31]! & 127) | 64;
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
};

export type MaterializeOriginatedHtlcPaymentsInput = Readonly<{
  state: EntityState;
  proposalTxs: readonly EntityTx[];
  profiles: readonly Profile[];
  height: number;
  resolveRoute(tx: HtlcPaymentTx): Promise<readonly string[]>;
}>;

export const materializeOriginatedHtlcPayments = async (
  input: MaterializeOriginatedHtlcPaymentsInput,
): Promise<PreparedOriginatedHtlcPayment[]> => {
  const originated: PreparedOriginatedHtlcPayment[] = [];
  const activeHashlocks = new Set([...input.state.htlcRoutes.keys()].map(hashlock => hashlock.toLowerCase()));
  for (const [txIndex, candidate] of input.proposalTxs.entries()) {
    if (candidate.type !== 'htlcPayment') continue;
    assertRawHtlcPayment(candidate);
    const source = entityId(input.state.entityId, 'HTLC_PAYMENT_SOURCE_INVALID');
    const target = entityId(candidate.data.targetEntityId, 'HTLC_PAYMENT_TARGET_INVALID');
    const selectedRoute = candidate.data.route.length > 0 ? candidate.data.route : await input.resolveRoute(candidate);
    const route = normalizeRoute(selectedRoute, source, target);
    const txHash = hashRawHtlcPaymentTx(candidate);
    const localSecret = getDeterministicHtlcTestSecret(candidate);
    const secret = localSecret ?? generateHtlcPaymentPreimage();
    if (!/^0x[0-9a-f]{64}$/.test(secret)) rejectHtlcPayment('HTLC_PAYMENT_PREIMAGE_INVALID');
    const hashlock = hashHtlcSecret(secret).toLowerCase();
    if (candidate.data.hashlock !== undefined && candidate.data.hashlock !== hashlock) {
      rejectHtlcPayment('HTLC_PAYMENT_HASHLOCK_MISMATCH');
    }
    if (activeHashlocks.has(hashlock)) rejectHtlcPayment(`HTLC_PAYMENT_HASHLOCK_ALREADY_ACTIVE:${hashlock}`);
    activeHashlocks.add(hashlock);
    const startedAtMs = candidate.data.startedAtMs ?? input.state.timestamp;
    if (!Number.isSafeInteger(startedAtMs) || startedAtMs !== input.state.timestamp) rejectHtlcPayment('HTLC_PAYMENT_STARTED_AT_INVALID');
    const quote = quoteHtlcPaymentRoute(input.profiles, route, candidate.data.tokenId, candidate.data.amount);
    if (quote.senderLockAmount > candidate.data.maxSenderDebit) rejectHtlcPayment('HTLC_PAYMENT_MAX_SENDER_DEBIT_EXCEEDED');
    const window = resolvePaymentDeadlineWindow({
      mode: candidate.data.deliveryMode,
      runtimeJHeight: toJHeight(input.state.lastFinalizedJHeight),
      timestamp: toUnixMs(startedAtMs),
      totalHops: route.length - 1,
    });
    const timelock = calculateHopTimelock(window.baseTimelock, 0);
    const revealBeforeHeight = calculateHopRevealHeight(window.baseHeight, 0, route.length - 1);
    const lockId = generateLockId(hashlock, input.height, txIndex, startedAtMs).toLowerCase();
    const sourceProfile = uniqueProfile(input.profiles, source);
    if (sourceProfile.entityEncryptionPublicKey !== input.state.entityEncryptionPublicKey) {
      rejectHtlcPayment('HTLC_PAYMENT_SOURCE_PROFILE_KEY_MISMATCH');
    }
    const publicKeys = new Map(route.map(id => [id, uniqueProfile(input.profiles, id).entityEncryptionPublicKey]));
    const domains = route.slice(0, -1).map((from, index) => {
      const to = route[index + 1]!;
      const domain = hopAccountDomain(input.profiles, from, to, rejectHtlcPayment);
      if (index === 0) {
        const localAccount = input.state.accounts.get(to);
        if (!localAccount || !sameAccountStateDomain(localAccount.state.domain, domain)) {
          rejectHtlcPayment(`HTLC_PAYMENT_SOURCE_ACCOUNT_DOMAIN_MISMATCH:${source}:${to}`);
        }
      }
      return domain;
    });
    const envelope = await createOnionEnvelopes(
      route, secret, publicKeys, domains,
      quote.hopForwardAmounts, candidate.data.description, startedAtMs,
      { rootLockId: lockId, hashlock, tokenId: candidate.data.tokenId, senderLockAmount: quote.senderLockAmount, timelock, revealBeforeHeight },
      (() => {
        let keyIndex = 0;
        return () => generateHtlcEphemeralPrivateKey(
          localSecret === undefined ? undefined : `${txHash}:${keyIndex++}`,
        );
      })(),
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
    if (originated[index - 1]!.txHash === originated[index]!.txHash) rejectHtlcPayment(`HTLC_PAYMENT_TX_DUPLICATE:${originated[index]!.txHash}`);
  }
  return originated;
};

type AssertOriginatedInput = Readonly<{
  state: EntityState;
  proposalTxs: readonly EntityTx[];
  profiles: readonly Profile[];
  height: number;
  originated: readonly PreparedOriginatedHtlcPayment[];
}>;

const assertOriginRouteEvidence = (
  input: AssertOriginatedInput,
  tx: HtlcPaymentTx,
  origin: PreparedOriginatedHtlcPayment,
): void => {
  const source = entityId(input.state.entityId, 'HTLC_PAYMENT_SOURCE_INVALID');
  const target = entityId(tx.data.targetEntityId, 'HTLC_PAYMENT_TARGET_INVALID');
  const route = normalizeRoute(origin.route, source, target);
  if (tx.data.route.length > 0 && encodeCanonicalConsensusValue(route) !== encodeCanonicalConsensusValue(tx.data.route)) {
    rejectHtlcPayment(`HTLC_PAYMENT_PREPARED_ROUTE_MISMATCH:${origin.txHash}`);
  }
  const sourceProfile = uniqueProfile(input.profiles, source);
  if (sourceProfile.entityEncryptionPublicKey !== input.state.entityEncryptionPublicKey) {
    rejectHtlcPayment('HTLC_PAYMENT_SOURCE_PROFILE_KEY_MISMATCH');
  }
  for (const [index, from] of route.slice(0, -1).entries()) {
    const to = route[index + 1]!;
    const domain = hopAccountDomain(input.profiles, from, to, rejectHtlcPayment);
    if (index === 0) {
      const local = input.state.accounts.get(to);
      if (!local || !sameAccountStateDomain(local.state.domain, domain)) {
        rejectHtlcPayment(`HTLC_PAYMENT_SOURCE_ACCOUNT_DOMAIN_MISMATCH:${source}:${to}`);
      }
    }
  }
};

const assertOriginEconomics = (
  input: AssertOriginatedInput,
  tx: HtlcPaymentTx,
  txIndex: number,
  origin: PreparedOriginatedHtlcPayment,
): void => {
  const startedAtMs = tx.data.startedAtMs ?? input.state.timestamp;
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs !== input.state.timestamp) rejectHtlcPayment('HTLC_PAYMENT_STARTED_AT_INVALID');
  const quote = quoteHtlcPaymentRoute(input.profiles, [...origin.route], tx.data.tokenId, tx.data.amount);
  if (quote.senderLockAmount > tx.data.maxSenderDebit) rejectHtlcPayment('HTLC_PAYMENT_MAX_SENDER_DEBIT_EXCEEDED');
  const window = resolvePaymentDeadlineWindow({
    mode: tx.data.deliveryMode,
    runtimeJHeight: toJHeight(input.state.lastFinalizedJHeight),
    timestamp: toUnixMs(startedAtMs),
    totalHops: origin.route.length - 1,
  });
  const expected = {
    targetEntityId: tx.data.targetEntityId.toLowerCase(), tokenId: tx.data.tokenId,
    recipientAmount: tx.data.amount, description: tx.data.description ?? '', deliveryMode: tx.data.deliveryMode,
    startedAtMs, senderLockAmount: quote.senderLockAmount, maxSenderDebit: tx.data.maxSenderDebit,
    totalFee: quote.senderLockAmount - tx.data.amount,
    lockId: generateLockId(origin.hashlock, input.height, txIndex, startedAtMs).toLowerCase(),
    timelock: calculateHopTimelock(window.baseTimelock, 0),
    revealBeforeHeight: calculateHopRevealHeight(window.baseHeight, 0, origin.route.length - 1),
    nextHopEntityId: origin.route[1]!,
  };
  if (tx.data.hashlock !== undefined && tx.data.hashlock !== origin.hashlock) {
    rejectHtlcPayment(`HTLC_PAYMENT_PREPARED_HASHLOCK_MISMATCH:${origin.txHash}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (origin[key as keyof typeof origin] !== value) rejectHtlcPayment(`HTLC_PAYMENT_PREPARED_${key.toUpperCase()}_MISMATCH:${origin.txHash}`);
  }
};

/** Validators authenticate public payment facts but never recreate proposer entropy. */
export const assertOriginatedHtlcPayments = (input: AssertOriginatedInput): void => {
  const expectedTxs = input.proposalTxs
    .map((tx, txIndex) => ({ tx, txIndex }))
    .filter((row): row is { tx: HtlcPaymentTx; txIndex: number } => row.tx.type === 'htlcPayment');
  if (expectedTxs.length !== input.originated.length) rejectHtlcPayment('HTLC_PAYMENT_PREPARED_ORIGIN_COUNT_MISMATCH');
  const origins = new Map(input.originated.map(origin => [origin.txHash, origin]));
  const activeHashlocks = new Set([...input.state.htlcRoutes.keys()].map(hashlock => hashlock.toLowerCase()));
  for (const { tx, txIndex } of expectedTxs) {
    assertRawHtlcPayment(tx);
    const txHash = hashRawHtlcPaymentTx(tx);
    const origin = origins.get(txHash);
    if (!origin) rejectHtlcPayment(`HTLC_PAYMENT_PREPARED_CONTEXT_REQUIRED:${txHash}`);
    if (activeHashlocks.has(origin.hashlock)) rejectHtlcPayment(`HTLC_PAYMENT_HASHLOCK_ALREADY_ACTIVE:${origin.hashlock}`);
    activeHashlocks.add(origin.hashlock);
    assertOriginRouteEvidence(input, tx, origin);
    assertOriginEconomics(input, tx, txIndex, origin);
  }
};

export const validatePreparedHtlcPayment = (
  state: EntityState,
  tx: HtlcPaymentTx,
  infraContext: EntityInfraContext | undefined,
): PreparedOriginatedHtlcPayment => {
  assertRawHtlcPayment(tx);
  if (!infraContext) rejectHtlcPayment('HTLC_PAYMENT_INFRA_CONTEXT_REQUIRED');
  const txHash = hashRawHtlcPaymentTx(tx);
  const prepared = infraContext.htlc.originated.find(entry => entry.txHash === txHash);
  if (!prepared) {
    const available = infraContext.htlc.originated.slice(0, 8).map(entry => entry.txHash).join(',');
    rejectHtlcPayment(
      `HTLC_PAYMENT_PREPARED_CONTEXT_REQUIRED:${txHash}:` +
      `available=${infraContext.htlc.originated.length}[${available}]`,
    );
  }
  if (prepared.targetEntityId !== tx.data.targetEntityId.toLowerCase()
    || prepared.tokenId !== tx.data.tokenId || prepared.recipientAmount !== tx.data.amount
    || prepared.maxSenderDebit !== tx.data.maxSenderDebit || prepared.deliveryMode !== tx.data.deliveryMode
    || (tx.data.startedAtMs !== undefined && prepared.startedAtMs !== tx.data.startedAtMs)) {
    rejectHtlcPayment(`HTLC_PAYMENT_PREPARED_CONTEXT_MISMATCH:${txHash}`);
  }
  if (state.htlcRoutes.has(prepared.hashlock)) {
    rejectHtlcPayment(`HTLC_PAYMENT_HASHLOCK_ALREADY_ACTIVE:${prepared.hashlock}`);
  }
  const account = state.accounts.get(prepared.nextHopEntityId);
  if (!account || !canProcessAccountTxForDisputeStatus(account.status)) {
    rejectHtlcPayment(`HTLC_PAYMENT_OUTBOUND_ACCOUNT_UNAVAILABLE:${txHash}`);
  }
  const delta = account.state.deltas.get(prepared.tokenId);
  if (!delta || deriveDelta(delta, getAccountPerspective(account.state, state.entityId).iAmLeft).outCapacity < prepared.senderLockAmount) {
    rejectHtlcPayment(`HTLC_PAYMENT_OUTBOUND_CAPACITY_INSUFFICIENT:${txHash}`);
  }
  return prepared;
};
