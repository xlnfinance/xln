import { canonicalAccountDisputeConfig } from '../../account/config/dispute-config';
import { assertAccountJClaimAccumulatorState } from '../../account/j-claims/j-claim-accumulator';
import { PersistentAccountStateMap } from '../../account/state/persistent-state-map';
import { validateDelta } from '../../account/validation/delta-validation';
import { LIMITS } from '../../config/constants';
import type { AccountLendingIntentKind, AccountStateDomain, Delta, HtlcLock, PullCommitment, SettlementWorkspace, SwapOffer } from '../../types/account';
import type { AccountJClaimAccumulatorState } from '../../types/finance/account-j-claims';
import type {
  BilateralRebalanceFeePolicy,
  RebalanceFeePolicySnapshot,
  RebalancePolicy,
  RebalanceRequestFeeState,
} from '../../types/finance/rebalance';
import { decodeRscoreCanonicalValue } from '../canonical-wire';
import { rscoreCheckpointList, rscoreCheckpointTuple } from './checkpoint-wire';
import {
  checkpointBigInt,
  checkpointBool,
  checkpointFlag,
  checkpointHex,
  checkpointRestoreFail,
  checkpointSafeInt,
  checkpointText,
  checkpointTokenId,
  checkpointUint32,
  checkpointUint64,
} from './checkpoint-restore-read';

type RscoreCarriedAccountRoots = Readonly<{
  pullsRoot: string;
  subcontractsRoot: string;
  requestedRebalanceRoot: string;
  requestedRebalanceFeeStateRoot: string;
  leftPendingJClaims: AccountJClaimAccumulatorState;
  rightPendingJClaims: AccountJClaimAccumulatorState;
}>;

type RscoreAccountEnvelope = Readonly<{
  fields: Readonly<Record<string, unknown>>;
  canonicalMempool: readonly unknown[];
  rebalanceShadowPolicy: readonly (readonly [number, RebalancePolicy])[];
  rebalanceShadowSubmitted: readonly (readonly [number, number])[];
}>;

export type RscoreAccountStateSeed = Readonly<{
  ownerEntityId: string;
  signerId: string;
  accountId: string;
  domain: AccountStateDomain;
  leftEntity: string;
  rightEntity: string;
  watchSeed: string;
  disputeConfig: Readonly<{ leftResponseSeconds: number; rightResponseSeconds: number }>;
  jNonce: number;
  lastFinalizedJHeight: number;
  carried: RscoreCarriedAccountRoots;
  /**
   * Absent on the round wire: the engine never authors envelope fields, so the
   * Entity that sent them still holds them. A checkpoint carries it, because
   * the process reading one holds no prior Account.
   */
  envelope: RscoreAccountEnvelope | null;
  deltaTransformer?: string;
  settlementWorkspace?: SettlementWorkspace;
  deltas: PersistentAccountStateMap<number, Delta>;
  locks: PersistentAccountStateMap<string, HtlcLock>;
  lendingIntents: PersistentAccountStateMap<string, AccountLendingIntentKind>;
  swapOffers: PersistentAccountStateMap<string, SwapOffer>;
  rebalanceFeePolicies: PersistentAccountStateMap<number, BilateralRebalanceFeePolicy>;
  pulls: PersistentAccountStateMap<string, PullCommitment>;
  requestedRebalance: PersistentAccountStateMap<number, bigint>;
  requestedRebalanceFeeState: PersistentAccountStateMap<number, RebalanceRequestFeeState>;
}>;

const duplicateKeys = <K>(entries: readonly (readonly [K, unknown])[], field: string): void => {
  if (new Set(entries.map(([key]) => key)).size !== entries.length) checkpointRestoreFail(`${field}_DUPLICATE`);
};

const decodeAccumulator = (value: unknown, field: string): AccountJClaimAccumulatorState => {
  const row = rscoreCheckpointTuple(value, 2, `RESTORE_${field}`);
  return assertAccountJClaimAccumulatorState({
    version: 1,
    root: checkpointHex(row[0], 32, `${field}_ROOT`),
    count: checkpointUint64(row[1], `${field}_COUNT`),
  });
};

const decodeEnvelope = (value: unknown): RscoreAccountEnvelope => {
  const row = rscoreCheckpointTuple(value, 4, 'RESTORE_ENVELOPE');
  const decoded = decodeRscoreCanonicalValue(row[0], 'RESTORE_ENVELOPE_FIELDS');
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    Array.isArray(decoded) ||
    decoded instanceof Map ||
    decoded instanceof Set
  ) {
    return checkpointRestoreFail('ENVELOPE_FIELDS_OBJECT');
  }
  const fields = decoded as Record<string, unknown>;
  if ('accountStateRoot' in fields) {
    return checkpointRestoreFail('ENVELOPE_DERIVED_FIELD');
  }
  if ('mempoolRoot' in fields) return checkpointRestoreFail('ENVELOPE_TRANSIENT_FIELD');
  return {
    fields: Object.freeze({ ...fields }),
    canonicalMempool: Object.freeze(
      rscoreCheckpointList(row[1], 'RESTORE_ENVELOPE_MEMPOOL').map((entry, index) =>
        decodeRscoreCanonicalValue(entry, `RESTORE_ENVELOPE_MEMPOOL_${index}`),
      ),
    ),
    rebalanceShadowPolicy: Object.freeze(
      rscoreCheckpointList(row[2], 'RESTORE_ENVELOPE_SHADOW_POLICY').map((entry, index) => {
        const pair = rscoreCheckpointTuple(entry, 2, `RESTORE_ENVELOPE_SHADOW_POLICY_${index}`);
        const policy = decodeRscoreCanonicalValue(pair[1], `RESTORE_ENVELOPE_SHADOW_POLICY_${index}_VALUE`);
        if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
          return checkpointRestoreFail(`ENVELOPE_SHADOW_POLICY_${index}_VALUE_OBJECT`);
        }
        return Object.freeze([
          checkpointTokenId(pair[0], `ENVELOPE_SHADOW_POLICY_${index}_TOKEN`),
          Object.freeze({ ...(policy as RebalancePolicy) }),
        ] as const);
      }),
    ),
    rebalanceShadowSubmitted: Object.freeze(
      rscoreCheckpointList(row[3], 'RESTORE_ENVELOPE_SHADOW_SUBMITTED').map((entry, index) => {
        const pair = rscoreCheckpointTuple(entry, 2, `RESTORE_ENVELOPE_SHADOW_SUBMITTED_${index}`);
        return Object.freeze([
          checkpointTokenId(pair[0], `ENVELOPE_SHADOW_SUBMITTED_${index}_TOKEN`),
          checkpointSafeInt(pair[1], `ENVELOPE_SHADOW_SUBMITTED_${index}_TIMESTAMP`),
        ] as const);
      }),
    ),
  };
};

const decodeRscoreCheckpointDelta = (value: unknown, index: number): Delta => {
  const row = rscoreCheckpointTuple(value, 10, `RESTORE_DELTA_${index}`);
  return validateDelta(
    {
      tokenId: checkpointTokenId(row[0], `DELTA_${index}_TOKEN_ID`),
      collateral: checkpointBigInt(row[1], `DELTA_${index}_COLLATERAL`),
      ondelta: checkpointBigInt(row[2], `DELTA_${index}_ONDELTA`),
      offdelta: checkpointBigInt(row[3], `DELTA_${index}_OFFDELTA`),
      leftCreditLimit: checkpointBigInt(row[4], `DELTA_${index}_LEFT_CREDIT_LIMIT`),
      rightCreditLimit: checkpointBigInt(row[5], `DELTA_${index}_RIGHT_CREDIT_LIMIT`),
      leftAllowance: checkpointBigInt(row[6], `DELTA_${index}_LEFT_ALLOWANCE`),
      rightAllowance: checkpointBigInt(row[7], `DELTA_${index}_RIGHT_ALLOWANCE`),
      leftHold: checkpointBigInt(row[8], `DELTA_${index}_LEFT_HOLD`),
      rightHold: checkpointBigInt(row[9], `DELTA_${index}_RIGHT_HOLD`),
    },
    `rscore checkpoint delta ${index}`,
  );
};

const decodeLock = (value: unknown, index: number): HtlcLock => {
  const row = rscoreCheckpointTuple(value, 10, `RESTORE_LOCK_${index}`);
  const lock: HtlcLock = {
    lockId: checkpointText(row[0], `LOCK_${index}_ID`),
    hashlock: checkpointHex(row[1], 32, `LOCK_${index}_HASHLOCK`),
    timelock: checkpointBigInt(row[2], `LOCK_${index}_TIMELOCK`),
    revealBeforeHeight: checkpointSafeInt(row[3], `LOCK_${index}_REVEAL_HEIGHT`),
    amount: checkpointBigInt(row[4], `LOCK_${index}_AMOUNT`),
    tokenId: checkpointTokenId(row[5], `LOCK_${index}_TOKEN_ID`),
    senderIsLeft: !checkpointFlag(row[6], `LOCK_${index}_SENDER`),
    createdHeight: checkpointSafeInt(row[7], `LOCK_${index}_CREATED_HEIGHT`),
    createdTimestamp: checkpointSafeInt(row[8], `LOCK_${index}_CREATED_TIMESTAMP`),
    ...(row[9] === null ? {} : { envelopeHash: checkpointHex(row[9], 32, `LOCK_${index}_ENVELOPE_HASH`) }),
  };
  if (!/^0x[0-9a-f]{64}$/.test(lock.lockId) || lock.timelock <= 0n || lock.amount <= 0n || lock.tokenId === 0) {
    return checkpointRestoreFail(`LOCK_${index}_INVALID`);
  }
  return lock;
};

const LENDING_KINDS = [
  'fund',
  'borrow',
  'repay',
  'credit-grant',
  'credit-revoke',
  'close-request',
  'close-payout',
] as const satisfies readonly AccountLendingIntentKind[];

const decodeLending = (value: unknown, index: number): readonly [string, AccountLendingIntentKind] => {
  const row = rscoreCheckpointTuple(value, 2, `RESTORE_LENDING_${index}`);
  const kind = decodeLendingKind(row[1], index);
  return [checkpointText(row[0], `LENDING_${index}_KEY`), kind];
};

const decodeLendingKind = (value: unknown, index: number): AccountLendingIntentKind => {
  const kind = LENDING_KINDS[checkpointSafeInt(value, `LENDING_${index}_KIND`)];
  if (kind === undefined) return checkpointRestoreFail(`LENDING_${index}_KIND`);
  return kind;
};

const decodeOffer = (value: unknown, index: number): SwapOffer => {
  const row = rscoreCheckpointTuple(value, 16, `RESTORE_OFFER_${index}`);
  const timeInForce = row[10] === null ? undefined : checkpointSafeInt(row[10], `OFFER_${index}_TIME_IN_FORCE`);
  if (timeInForce !== undefined && timeInForce !== 0 && timeInForce !== 1 && timeInForce !== 2) {
    return checkpointRestoreFail(`OFFER_${index}_TIME_IN_FORCE`);
  }
  const offer: SwapOffer = {
    offerId: checkpointText(row[0], `OFFER_${index}_ID`),
    giveTokenId: checkpointTokenId(row[1], `OFFER_${index}_GIVE_TOKEN`),
    giveTokenDecimals: checkpointUint32(row[2], `OFFER_${index}_GIVE_DECIMALS`),
    giveAmount: checkpointBigInt(row[3], `OFFER_${index}_GIVE_AMOUNT`),
    wantTokenId: checkpointTokenId(row[4], `OFFER_${index}_WANT_TOKEN`),
    wantTokenDecimals: checkpointUint32(row[5], `OFFER_${index}_WANT_DECIMALS`),
    wantAmount: checkpointBigInt(row[6], `OFFER_${index}_WANT_AMOUNT`),
    maxFee: checkpointBigInt(row[7], `OFFER_${index}_MAX_FEE`),
    minNetReceive: checkpointBigInt(row[8], `OFFER_${index}_MIN_NET_RECEIVE`),
    priceTicks: checkpointBigInt(row[9], `OFFER_${index}_PRICE_TICKS`),
    ...(timeInForce === undefined ? {} : { timeInForce }),
    makerIsLeft: !checkpointFlag(row[11], `OFFER_${index}_MAKER`),
    createdHeight: checkpointSafeInt(row[12], `OFFER_${index}_CREATED_HEIGHT`),
    quantizedGive: checkpointBigInt(row[13], `OFFER_${index}_QUANTIZED_GIVE`),
    quantizedWant: checkpointBigInt(row[14], `OFFER_${index}_QUANTIZED_WANT`),
    ...(row[15] === null
      ? {}
      : {
          crossJurisdiction: decodeRscoreCanonicalValue(
            row[15],
            `OFFER_${index}_CROSS_JURISDICTION`,
          ) as NonNullable<SwapOffer['crossJurisdiction']>,
        }),
  };
  if (
    offer.quantizedGive <= 0n ||
    offer.quantizedWant <= 0n ||
    offer.quantizedGive > offer.giveAmount ||
    offer.quantizedWant > offer.wantAmount
  )
    return checkpointRestoreFail(`OFFER_${index}_QUANTIZED_BOUNDS`);
  return offer;
};

const decodePolicySnapshot = (value: unknown, field: string): RebalanceFeePolicySnapshot | undefined => {
  if (value === null) return undefined;
  const row = rscoreCheckpointTuple(value, 5, `RESTORE_${field}`);
  const snapshot = {
    policyVersion: checkpointSafeInt(row[0], `${field}_VERSION`),
    baseFee: checkpointBigInt(row[1], `${field}_BASE_FEE`),
    liquidityFeeBps: checkpointBigInt(row[2], `${field}_LIQUIDITY_FEE`),
    gasFee: checkpointBigInt(row[3], `${field}_GAS_FEE`),
    updatedAt: checkpointSafeInt(row[4], `${field}_UPDATED_AT`),
  };
  if (
    snapshot.policyVersion === 0 ||
    snapshot.baseFee < 0n ||
    snapshot.gasFee < 0n ||
    snapshot.liquidityFeeBps < 0n ||
    snapshot.liquidityFeeBps > 10_000n
  )
    return checkpointRestoreFail(`${field}_INVALID`);
  return snapshot;
};

const decodePolicy = (value: unknown, index: number): readonly [number, BilateralRebalanceFeePolicy] => {
  const row = rscoreCheckpointTuple(value, 2, `RESTORE_POLICY_${index}`);
  return [
    checkpointTokenId(row[0], `POLICY_${index}_TOKEN_ID`),
    decodePolicyValue(row[1], index),
  ];
};

const decodePolicyValue = (value: unknown, index: number): BilateralRebalanceFeePolicy => {
  const sides = rscoreCheckpointTuple(value, 2, `RESTORE_POLICY_${index}_SIDES`);
  const left = decodePolicySnapshot(sides[0], `POLICY_${index}_LEFT`);
  const right = decodePolicySnapshot(sides[1], `POLICY_${index}_RIGHT`);
  if (left === undefined && right === undefined) return checkpointRestoreFail(`POLICY_${index}_EMPTY`);
  return { ...(left ? { left } : {}), ...(right ? { right } : {}) };
};

export type RscoreCheckpointSectionName =
  | 'deltas'
  | 'locks'
  | 'lendingIntents'
  | 'swapOffers'
  | 'rebalanceFeePolicies'
  | 'pulls'
  | 'requestedRebalance'
  | 'requestedRebalanceFeeState';

const checkpointTextKey = (keyBytes: Uint8Array, field: string): string => {
  const bytes = Buffer.from(keyBytes);
  if (bytes.byteLength < 2 || bytes.readUInt16BE(0) !== bytes.byteLength - 2) {
    return checkpointRestoreFail(`${field}_TEXT_KEY`);
  }
  const value = bytes.subarray(2).toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes.subarray(2))) {
    return checkpointRestoreFail(`${field}_TEXT_KEY_UTF8`);
  }
  return value;
};

const checkpointTokenKey = (keyBytes: Uint8Array, field: string): number => {
  const bytes = Buffer.from(keyBytes);
  if (bytes.byteLength !== 32 || bytes.subarray(0, 30).some(byte => byte !== 0)) {
    return checkpointRestoreFail(`${field}_TOKEN_KEY`);
  }
  return checkpointTokenId(bytes.readUInt16BE(30), field);
};

/** The map key a section's raw radix key spells. */
export const decodeRscoreCheckpointSectionKey = (
  section: RscoreCheckpointSectionName,
  keyBytes: Uint8Array,
  index: number,
): number | string =>
  section === 'deltas' || section === 'rebalanceFeePolicies'
    || section === 'requestedRebalance' || section === 'requestedRebalanceFeeState'
    ? checkpointTokenKey(keyBytes, `${section.toUpperCase()}_${index}`)
    : checkpointTextKey(keyBytes, `${section.toUpperCase()}_${index}`);

/** Decode one typed leaf without trusting the persisted raw radix key. */
export const decodeRscoreCheckpointSectionEntry = (
  section: RscoreCheckpointSectionName,
  keyBytes: Uint8Array,
  value: unknown,
  index: number,
): readonly [number | string, unknown] => {
  switch (section) {
    case 'deltas': {
      const delta = decodeRscoreCheckpointDelta(value, index);
      return [delta.tokenId, delta];
    }
    case 'locks': {
      const lock = decodeLock(value, index);
      return [lock.lockId, lock];
    }
    case 'lendingIntents':
      return [checkpointTextKey(keyBytes, `LENDING_${index}`), decodeLendingKind(value, index)];
    case 'swapOffers': {
      const offer = decodeOffer(value, index);
      return [offer.offerId, offer];
    }
    case 'rebalanceFeePolicies':
      return [checkpointTokenKey(keyBytes, `POLICY_${index}`), decodePolicyValue(value, index)];
    case 'pulls': {
      const pullId = checkpointTextKey(keyBytes, `PULL_${index}`);
      const pull = decodeRscoreCanonicalValue(value, `PULL_${index}`) as PullCommitment;
      if (!pull || typeof pull !== 'object' || pull.pullId !== pullId) {
        return checkpointRestoreFail(`PULL_${index}_ID`);
      }
      return [pullId, pull];
    }
    case 'requestedRebalance':
      return [checkpointTokenKey(keyBytes, `REQUESTED_REBALANCE_${index}`), checkpointBigInt(value, `REQUESTED_REBALANCE_${index}`)];
    case 'requestedRebalanceFeeState':
      return [checkpointTokenKey(keyBytes, `REQUESTED_REBALANCE_FEE_${index}`), decodeRequestedRebalanceFeeState(value, index)];
  }
};

const REBALANCE_REFUND_REASONS = [
  'policy_mismatch',
  'timeout',
  'fee_too_low',
  'manual',
] as const satisfies readonly NonNullable<RebalanceRequestFeeState['refund']>['reason'][];

const decodeRequestedRebalanceFeeState = (
  value: unknown,
  index: number,
): RebalanceRequestFeeState => {
  const row = rscoreCheckpointTuple(value, 8, `RESTORE_REQUESTED_REBALANCE_FEE_${index}`);
  const refund = row[7] === null
    ? undefined
    : (() => {
        const refundRow = rscoreCheckpointTuple(row[7], 2, `RESTORE_REQUESTED_REBALANCE_REFUND_${index}`);
        const reason = REBALANCE_REFUND_REASONS[checkpointSafeInt(refundRow[0], `REQUESTED_REBALANCE_REFUND_${index}_REASON`)];
        if (reason === undefined) return checkpointRestoreFail(`REQUESTED_REBALANCE_REFUND_${index}_REASON`);
        return { reason, refundedAmount: checkpointBigInt(refundRow[1], `REQUESTED_REBALANCE_REFUND_${index}_AMOUNT`) };
      })();
  return {
    requestId: checkpointText(row[0], `REQUESTED_REBALANCE_FEE_${index}_REQUEST_ID`),
    feeTokenId: checkpointTokenId(row[1], `REQUESTED_REBALANCE_FEE_${index}_FEE_TOKEN`),
    feePaidUpfront: checkpointBigInt(row[2], `REQUESTED_REBALANCE_FEE_${index}_PAID`),
    requestedAmount: checkpointBigInt(row[3], `REQUESTED_REBALANCE_FEE_${index}_REQUESTED`),
    policyVersion: checkpointSafeInt(row[4], `REQUESTED_REBALANCE_FEE_${index}_POLICY_VERSION`),
    requestedAt: checkpointSafeInt(row[5], `REQUESTED_REBALANCE_FEE_${index}_REQUESTED_AT`),
    requestedByLeft: checkpointBool(row[6], `REQUESTED_REBALANCE_FEE_${index}_BY_LEFT`),
    ...(refund === undefined ? {} : { refund }),
  };
};

/**
 * The eight Rust-owned account namespaces, built from complete section lists.
 *
 * A wave hands over changes rather than whole trees, so it builds these by
 * applying them to the account it already holds; a restore has no such
 * account and builds them from the complete lists here.
 */
export type RscoreAccountStateTrees = Readonly<{
  deltas: PersistentAccountStateMap<number, Delta>;
  locks: PersistentAccountStateMap<string, HtlcLock>;
  lendingIntents: PersistentAccountStateMap<string, AccountLendingIntentKind>;
  swapOffers: PersistentAccountStateMap<string, SwapOffer>;
  rebalanceFeePolicies: PersistentAccountStateMap<number, BilateralRebalanceFeePolicy>;
  pulls: PersistentAccountStateMap<string, PullCommitment>;
  requestedRebalance: PersistentAccountStateMap<number, bigint>;
  requestedRebalanceFeeState: PersistentAccountStateMap<number, RebalanceRequestFeeState>;
}>;

export const decodeRscoreAccountStateTrees = (
  sectionValues: readonly unknown[],
): RscoreAccountStateTrees => {
  const deltas = rscoreCheckpointList(sectionValues[0], 'RESTORE_DELTAS').map(decodeRscoreCheckpointDelta);
  const locks = rscoreCheckpointList(sectionValues[1], 'RESTORE_LOCKS').map(decodeLock);
  const lending = rscoreCheckpointList(sectionValues[2], 'RESTORE_LENDING').map(decodeLending);
  const offers = rscoreCheckpointList(sectionValues[3], 'RESTORE_OFFERS').map(decodeOffer);
  const policies = rscoreCheckpointList(sectionValues[4], 'RESTORE_POLICIES').map(decodePolicy);
  const pulls = rscoreCheckpointList(sectionValues[5], 'RESTORE_PULLS').map((value, index) => {
    const pull = decodeRscoreCanonicalValue(value, `RESTORE_PULL_${index}`) as PullCommitment;
    if (!pull || typeof pull !== 'object' || typeof pull.pullId !== 'string') {
      return checkpointRestoreFail(`PULL_${index}`);
    }
    return [pull.pullId, pull] as const;
  });
  const requestedRebalance = rscoreCheckpointList(sectionValues[6], 'RESTORE_REQUESTED_REBALANCE')
    .map((value, index) => {
      const row = rscoreCheckpointTuple(value, 2, `RESTORE_REQUESTED_REBALANCE_${index}`);
      return [
        checkpointTokenId(row[0], `REQUESTED_REBALANCE_${index}_TOKEN`),
        checkpointBigInt(row[1], `REQUESTED_REBALANCE_${index}_AMOUNT`),
      ] as const;
    });
  const requestedRebalanceFeeState = rscoreCheckpointList(
    sectionValues[7],
    'RESTORE_REQUESTED_REBALANCE_FEE_STATE',
  ).map((value, index) => {
    const row = rscoreCheckpointTuple(value, 2, `RESTORE_REQUESTED_REBALANCE_FEE_${index}`);
    return [
      checkpointTokenId(row[0], `REQUESTED_REBALANCE_FEE_${index}_TOKEN`),
      decodeRequestedRebalanceFeeState(row[1], index),
    ] as const;
  });
  if (
    deltas.length > LIMITS.MAX_ACCOUNT_TOKEN_ROWS ||
    locks.length > LIMITS.MAX_ACCOUNT_HTLC_LOCKS ||
    offers.length > LIMITS.MAX_ACCOUNT_SWAP_OFFERS
  ) {
    checkpointRestoreFail('SECTION_LIMIT');
  }
  duplicateKeys(
    deltas.map(value => [value.tokenId, value] as const),
    'DELTA',
  );
  duplicateKeys(
    locks.map(value => [value.lockId, value] as const),
    'LOCK',
  );
  duplicateKeys(lending, 'LENDING');
  duplicateKeys(
    offers.map(value => [value.offerId, value] as const),
    'OFFER',
  );
  duplicateKeys(policies, 'POLICY');
  duplicateKeys(pulls, 'PULL');
  duplicateKeys(requestedRebalance, 'REQUESTED_REBALANCE');
  duplicateKeys(requestedRebalanceFeeState, 'REQUESTED_REBALANCE_FEE_STATE');
  return {
    deltas: PersistentAccountStateMap.fromEntries(
      'deltas',
      deltas.map(value => [value.tokenId, value]),
    ),
    locks: PersistentAccountStateMap.fromEntries(
      'locks',
      locks.map(value => [value.lockId, value]),
    ),
    lendingIntents: PersistentAccountStateMap.fromEntries('lendingIntents', lending),
    swapOffers: PersistentAccountStateMap.fromEntries(
      'swapOffers',
      offers.map(value => [value.offerId, value]),
    ),
    rebalanceFeePolicies: PersistentAccountStateMap.fromEntries('rebalanceFeePolicies', policies),
    pulls: PersistentAccountStateMap.fromEntries('pulls', pulls),
    requestedRebalance: PersistentAccountStateMap.fromEntries('requestedRebalance', requestedRebalance),
    requestedRebalanceFeeState: PersistentAccountStateMap.fromEntries(
      'requestedRebalanceFeeState',
      requestedRebalanceFeeState,
    ),
  };
};

export const decodeRscoreAccountStateSeed = (
  accountId: string,
  headerValue: unknown,
  trees: RscoreAccountStateTrees,
): RscoreAccountStateSeed => {
  const header = rscoreCheckpointTuple(headerValue, 10, 'RESTORE_HEADER');
  const identity = rscoreCheckpointTuple(header[2], 5, 'RESTORE_IDENTITY');
  const ownerEntityId = checkpointHex(header[0], 32, 'OWNER');
  const leftEntity = checkpointHex(identity[2], 32, 'LEFT_ENTITY');
  const rightEntity = checkpointHex(identity[3], 32, 'RIGHT_ENTITY');
  if (leftEntity >= rightEntity) checkpointRestoreFail('IDENTITY_ORDER');
  const counterparty =
    ownerEntityId === leftEntity ? rightEntity : ownerEntityId === rightEntity ? leftEntity : undefined;
  if (counterparty !== accountId) checkpointRestoreFail('ACCOUNT_ID_COUNTERPARTY');
  const signerId = checkpointText(header[1], 'SIGNER_ID');
  if (signerId.length === 0) checkpointRestoreFail('SIGNER_ID_EMPTY');
  const dispute = rscoreCheckpointTuple(header[3], 2, 'RESTORE_DISPUTE_CONFIG');
  const carried = rscoreCheckpointTuple(header[6], 6, 'RESTORE_CARRIED');
  return {
    ownerEntityId,
    signerId,
    accountId,
    domain: {
      chainId: checkpointSafeInt(identity[0], 'CHAIN_ID'),
      depositoryAddress: checkpointHex(identity[1], 20, 'DEPOSITORY'),
    },
    leftEntity,
    rightEntity,
    watchSeed: checkpointHex(identity[4], 32, 'WATCH_SEED'),
    disputeConfig: canonicalAccountDisputeConfig({
      leftResponseSeconds: checkpointUint32(dispute[0], 'LEFT_RESPONSE_SECONDS'),
      rightResponseSeconds: checkpointUint32(dispute[1], 'RIGHT_RESPONSE_SECONDS'),
    }),
    jNonce: checkpointSafeInt(header[4], 'J_NONCE'),
    lastFinalizedJHeight: checkpointSafeInt(header[5], 'LAST_FINALIZED_J_HEIGHT'),
    carried: {
      pullsRoot: checkpointHex(carried[0], 32, 'PULLS_ROOT'),
      subcontractsRoot: checkpointHex(carried[1], 32, 'SUBCONTRACTS_ROOT'),
      requestedRebalanceRoot: checkpointHex(carried[2], 32, 'REQUESTED_REBALANCE_ROOT'),
      requestedRebalanceFeeStateRoot: checkpointHex(carried[3], 32, 'REQUESTED_REBALANCE_FEE_ROOT'),
      leftPendingJClaims: decodeAccumulator(carried[4], 'LEFT_CLAIMS'),
      rightPendingJClaims: decodeAccumulator(carried[5], 'RIGHT_CLAIMS'),
    },
    envelope: header[7] === null ? null : decodeEnvelope(header[7]),
    ...(header[8] === null ? {} : { deltaTransformer: checkpointHex(header[8], 20, 'DELTA_TRANSFORMER') }),
    ...(header[9] === null
      ? {}
      : {
          settlementWorkspace: decodeRscoreCanonicalValue(
            header[9],
            'RESTORE_SETTLEMENT_WORKSPACE',
          ) as SettlementWorkspace,
        }),
    ...trees,
  };
};
