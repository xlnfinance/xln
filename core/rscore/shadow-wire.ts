/**
 * TS account state -> rscore process wire builders for the shadow mirror.
 * Every shape here is pinned by tests/rscore/accounts-tree-parity.test.ts and
 * the process wire decoders (rscore/crates/process/src/wire_decode.rs).
 */
import { createHash } from 'node:crypto';

import { EMPTY_ACCOUNT_STATE_ROOT } from '../account/commitment/state-root';
import {
  getKnownTokenIds,
  getSwapPairPolicyForDimensions,
  getTokenInfo,
  isLiquidSwapToken,
} from '../account/utils';
import { requirePersistentAccountStateMap } from '../account/state/persistent-state-map';
import type {
  AccountReplica,
  AccountState,
  AccountTx,
  Delta,
  HtlcLock,
  SwapOffer,
} from '../types/account';
import type {
  BilateralRebalanceFeePolicy,
  RebalanceFeePolicySnapshot,
} from '../types/finance/rebalance';
import type { AccountStateCollection, AccountStateMapNamespace } from '../account/state/persistent-state-map';
import type { ApplyAccountTxOk } from '../account/tx/apply-types';
import type { RscoreWireValue } from './client';

export const hexToWireBytes = (value: string, expectedBytes: number, code: string): Uint8Array => {
  const clean = value.trim().toLowerCase().replace(/^0x/, '');
  if (clean.length !== expectedBytes * 2 || !/^[0-9a-f]*$/.test(clean)) {
    throw new Error(`${code}:${value}`);
  }
  const bytes = new Uint8Array(expectedBytes);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const deltaWire = (delta: Delta): RscoreWireValue[] => [
  delta.tokenId,
  delta.collateral.toString(),
  delta.ondelta.toString(),
  delta.offdelta.toString(),
  delta.leftCreditLimit.toString(),
  delta.rightCreditLimit.toString(),
  delta.leftAllowance.toString(),
  delta.rightAllowance.toString(),
  delta.leftHold.toString(),
  delta.rightHold.toString(),
];

const lockWire = (lock: HtlcLock): RscoreWireValue[] => [
  lock.lockId,
  hexToWireBytes(lock.hashlock, 32, 'SHADOW_HASHLOCK'),
  lock.timelock.toString(),
  lock.revealBeforeHeight,
  lock.amount.toString(),
  lock.tokenId,
  lock.senderIsLeft ? 0 : 1, // Side wire: 0 = left, 1 = right
  lock.createdHeight,
  lock.createdTimestamp,
  lock.envelopeHash === undefined ? null : hexToWireBytes(lock.envelopeHash, 32, 'SHADOW_ENVELOPE_HASH'),
];

/**
 * Why an account snapshot cannot be mirrored, or null when it can.
 *
 * Most out-of-profile sections are *carried*: the engine commits their roots
 * verbatim and no supported transaction mutates them, so a live account with
 * swap/pull/rebalance/J-claim state still reproduces its exact state root.
 * Two cannot be carried and are refused loudly:
 *   - lendingIntents: the engine owns this map itself (it computes the root
 *     from its own entries), so a non-empty one would need the entries.
 *   - settlementWorkspace: TypeScript commits the whole object, not a root,
 *     and the engine has no representation for it.
 */
export const shadowIneligibilityReason = (account: AccountReplica): string | null => {
  const state = account.state;
  if ((state.lendingIntents?.size ?? 0) > 0) return 'LENDING_INTENTS';
  if (state.settlementWorkspace !== undefined) return 'SETTLEMENT_WORKSPACE';
  return null;
};

/**
 * The accumulator counter is a full uint64 on both sides. It travels as a
 * bigint, not a JS number: msgpack encodes it as uint64 and the engine decodes
 * it as u64, so the whole range survives. Coercing through Number() rounded
 * anything past 2^53 into a different jurisdiction section; refusing the value
 * instead would just have narrowed the profile.
 */
const jClaimCount = (count: bigint): bigint => {
  if (count < 0n || count > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`SHADOW_J_CLAIM_COUNT_OUT_OF_RANGE:${count}`);
  }
  return count;
};

/**
 * Registry-derived market tables the engine cannot derive from account state:
 * token decimals, which assets quote a pair, and the per-pair price step. The
 * digest is compared against the engine's own so a registry that moved under a
 * running engine is loud instead of silently mispricing.
 */
export const swapMarketPolicyWire = (): RscoreWireValue[] => {
  const tokenIds = getKnownTokenIds();
  const tokens = tokenIds.map(tokenId => [
    tokenId,
    getTokenInfo(tokenId).decimals,
    isLiquidSwapToken(tokenId) ? 1 : 0,
  ]);
  const steps: RscoreWireValue[] = [];
  for (const base of tokenIds) {
    for (const quote of tokenIds) {
      if (base === quote) continue;
      const step = getSwapPairPolicyForDimensions(
        base,
        quote,
        getTokenInfo(base).decimals,
        getTokenInfo(quote).decimals,
      ).priceStepTicks;
      steps.push([base, quote, Math.max(1, step)]);
    }
  }
  return [tokens, steps];
};

const be32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

/** Same preimage as SwapMarketPolicy::digest on the engine side. */
export const swapMarketPolicyDigest = (policy: readonly RscoreWireValue[]): string => {
  const hasher = createHash('sha256');
  hasher.update(Buffer.from('xln.rscore.swap-market-policy.v1'));
  for (const row of policy[0] as number[][]) {
    hasher.update(be32(row[0]!));
    hasher.update(be32(row[1]!));
    hasher.update(Buffer.from([row[2]!]));
  }
  hasher.update(Buffer.from('steps'));
  // The engine keeps steps in a map keyed by (base, quote); match that order.
  const steps = [...(policy[1] as number[][])]
    .sort((left, right) => (left[0]! - right[0]!) || (left[1]! - right[1]!));
  for (const row of steps) {
    hasher.update(be32(row[0]!));
    hasher.update(be32(row[1]!));
    hasher.update(be32(row[2]!));
  }
  return `0x${hasher.digest('hex')}`;
};

const collectionRoot = (
  namespace: AccountStateMapNamespace,
  map: AccountStateCollection<never, never> | undefined,
): string => (map === undefined
  ? EMPTY_ACCOUNT_STATE_ROOT
  : requirePersistentAccountStateMap(map, namespace).rootHash());

/** Roots of the sections the engine carries without interpreting them. */
const carriedSectionsWire = (account: AccountReplica): RscoreWireValue[] => {
  const state = account.state;
  const claim = (accumulator: { root: string; count: bigint }): RscoreWireValue[] => [
    hexToWireBytes(accumulator.root, 32, 'SHADOW_J_CLAIM_ROOT'),
    jClaimCount(accumulator.count),
  ];
  const root = (
    namespace: AccountStateMapNamespace,
    map: unknown,
  ): Uint8Array => hexToWireBytes(
    collectionRoot(namespace, map as AccountStateCollection<never, never> | undefined),
    32,
    `SHADOW_${namespace.toUpperCase()}_ROOT`,
  );
  return [
    root('pulls', state.pulls),
    swapOffersWire(state.swapOffers),
    root('subcontracts', state.subcontracts),
    root('requestedRebalance', state.requestedRebalance),
    root('requestedRebalanceFeeState', state.requestedRebalanceFeeState),
    rebalanceFeePoliciesWire(state.rebalanceFeePolicies),
    claim(state.leftPendingJClaims),
    claim(state.rightPendingJClaims),
  ];
};

/** Resting same-j offers, in the engine's own field order. */
const swapOffersWire = (
  offers: AccountState['swapOffers'],
): RscoreWireValue[] => [...(offers ?? new Map<string, SwapOffer>()).values()]
  .sort((left, right) => (left.offerId < right.offerId ? -1 : left.offerId > right.offerId ? 1 : 0))
  .map(offer => [
    offer.offerId,
    offer.giveTokenId,
    offer.giveTokenDecimals,
    offer.giveAmount.toString(),
    offer.wantTokenId,
    offer.wantTokenDecimals,
    offer.wantAmount.toString(),
    offer.maxFee.toString(),
    offer.minNetReceive.toString(),
    offer.priceTicks.toString(),
    offer.timeInForce ?? null,
    offer.makerIsLeft ? 0 : 1,
    offer.createdHeight,
  ]);

/**
 * Slot 5 of the carried tuple is not a carried root: the engine owns the
 * rebalance fee registers and recomputes their root, so the seed ships their
 * full contents. An absent side is an empty tuple.
 */
const policySnapshotWire = (
  snapshot: RebalanceFeePolicySnapshot | undefined,
): RscoreWireValue[] => (snapshot === undefined ? [] : [
  snapshot.policyVersion,
  snapshot.baseFee.toString(),
  snapshot.liquidityFeeBps.toString(),
  snapshot.gasFee.toString(),
  snapshot.updatedAt,
]);

const rebalanceFeePoliciesWire = (
  policies: AccountState['rebalanceFeePolicies'],
): RscoreWireValue[] => [...(policies ?? new Map<number, BilateralRebalanceFeePolicy>()).entries()]
  .sort(([left], [right]) => left - right)
  .map(([tokenId, policy]) => [
    tokenId,
    policySnapshotWire(policy.left),
    policySnapshotWire(policy.right),
  ]);

/** Seed-wire row (arity 12) for one committed account snapshot. */
export const accountSeedWire = (
  ownerEntityId: string,
  counterpartyEntityId: string,
  account: AccountReplica,
): RscoreWireValue[] => {
  const state = account.state;
  return [
    hexToWireBytes(counterpartyEntityId, 32, 'SHADOW_ACCOUNT_ID'),
    hexToWireBytes(ownerEntityId, 32, 'SHADOW_OWNER'),
    hexToWireBytes(state.leftEntity, 32, 'SHADOW_LEFT'),
    hexToWireBytes(state.rightEntity, 32, 'SHADOW_RIGHT'),
    state.domain.chainId,
    hexToWireBytes(state.domain.depositoryAddress, 20, 'SHADOW_DEPOSITORY'),
    hexToWireBytes(state.watchSeed, 32, 'SHADOW_WATCH_SEED'),
    [state.disputeConfig.leftResponseSeconds, state.disputeConfig.rightResponseSeconds],
    [...state.deltas.values()]
      .sort((left, right) => left.tokenId - right.tokenId)
      .map(deltaWire),
    [...state.locks.values()]
      .sort((left, right) => (left.lockId < right.lockId ? -1 : left.lockId > right.lockId ? 1 : 0))
      .map(lockWire),
    [state.jNonce, state.lastFinalizedJHeight],
    carriedSectionsWire(account),
  ];
};

export const SHADOW_SUPPORTED_TX_TYPES = new Set([
  'direct_payment', 'htlc_lock', 'htlc_resolve', 'add_delta', 'set_credit_limit',
  'rebalance_policy',
  'swap_offer',
  'swap_cancel_request',
]);

export type ShadowOutputRow =
  | readonly [
      kind: 'forward',
      tokenId: number,
      amount: string,
      route: readonly string[],
      description: string | null,
      deliveryMode: 'trusted',
      trustedGatewayEntityId: string,
    ]
  | readonly [
      kind: 'secret',
      lockId: string,
      hashlock: string,
      secret: string,
      tokenId: number,
      amount: string,
    ]
  | readonly [
      kind: 'offer',
      offerId: string,
      makerSide: number,
      fromEntity: string,
      toEntity: string,
      createdHeight: number,
      giveTokenId: number,
      giveTokenDecimals: number,
      giveAmount: string,
      wantTokenId: number,
      wantTokenDecimals: number,
      wantAmount: string,
      maxFee: string,
      minNetReceive: string,
      priceTicks: string,
      timeInForce: number | null,
    ]
  | readonly [kind: 'cancelRequest', offerId: string]
  | readonly [
      kind: 'error',
      lockId: string,
      hashlock: string,
      tokenId: number,
      amount: string,
      reason: string | null,
    ];

/**
 * Canonical projection of everything one successful tx made observable
 * outside AccountState. HTLC identity and financial fields come exclusively
 * from the applied result, which captured the stored lock before deleting it;
 * reconstructing them from the submitted tx would hide a broken transition.
 */
export const shadowOutputRows = (result: ApplyAccountTxOk): ShadowOutputRow[] => {
  const rows: ShadowOutputRow[] = [];
  for (const output of result.candidateEffects ?? []) {
    if (output.kind !== 'directPaymentForward') continue;
    rows.push([
      'forward',
      output.tokenId,
      output.amount.toString(),
      [...output.route],
      output.description ?? null,
      output.deliveryMode,
      output.trustedGatewayEntityId,
    ]);
  }
  if (result.outcome === 'htlc_secret') {
    rows.push([
      'secret',
      result.lockId,
      result.hashlock,
      result.secret,
      result.tokenId,
      result.amount.toString(),
    ]);
  }
  if (result.outcome === 'swap_offer_created') {
    const offer = result.swapOfferCreated;
    // The offer event type marks priceTicks optional for the cross-j paths;
    // a same-j offer always carries it, and a missing one is a broken
    // transition rather than something to paper over with a default.
    // The event type marks priceTicks and createdHeight optional for the
    // cross-j paths; a same-j offer always carries both, and a missing one is
    // a broken transition rather than something to paper over with a default.
    if (offer.priceTicks === undefined) throw new Error('SHADOW_OFFER_PRICE_TICKS_MISSING');
    if (offer.createdHeight === undefined) throw new Error('SHADOW_OFFER_HEIGHT_MISSING');
    rows.push([
      'offer',
      offer.offerId,
      offer.makerIsLeft ? 0 : 1,
      offer.fromEntity,
      offer.toEntity,
      offer.createdHeight,
      offer.giveTokenId,
      offer.giveTokenDecimals,
      offer.giveAmount.toString(),
      offer.wantTokenId,
      offer.wantTokenDecimals,
      offer.wantAmount.toString(),
      offer.maxFee.toString(),
      offer.minNetReceive.toString(),
      offer.priceTicks.toString(),
      offer.timeInForce === undefined ? null : offer.timeInForce,
    ]);
  }
  if (result.outcome === 'swap_cancel_requested') {
    rows.push(['cancelRequest', result.swapOfferCancelRequested.offerId]);
  }
  if (result.outcome === 'htlc_error') {
    rows.push([
      'error',
      result.lockId,
      result.hashlock,
      result.tokenId,
      result.amount.toString(),
      result.reason ?? null,
    ]);
  }
  return rows;
};

/** Process-wire tx tuple, or null when the tx type is outside the profile. */
export const accountTxWire = (tx: AccountTx): RscoreWireValue[] | null => {
  switch (tx.type) {
    case 'direct_payment':
      return [
        0,
        tx.data.tokenId,
        tx.data.amount.toString(),
        [...tx.data.route],
        tx.data.description ?? null,
        tx.data.fromEntityId,
        tx.data.toEntityId,
        tx.data.deliveryMode === 'direct' ? 0 : 1,
        tx.data.trustedGatewayEntityId ?? null,
      ];
    case 'htlc_lock':
      return [
        1,
        tx.data.lockId,
        hexToWireBytes(tx.data.hashlock, 32, 'SHADOW_HASHLOCK'),
        tx.data.timelock.toString(),
        tx.data.revealBeforeHeight,
        tx.data.amount.toString(),
        tx.data.tokenId,
        tx.data.deliveryMode === undefined ? null : tx.data.deliveryMode === 'instant' ? 0 : 1,
        tx.data.envelope ? Buffer.from(tx.data.envelope.ciphertext, 'base64') : null,
      ];
    case 'add_delta':
      return [3, tx.data.tokenId];
    case 'set_credit_limit':
      return [4, tx.data.tokenId, tx.data.amount.toString()];
    case 'rebalance_policy':
      return [
        5,
        tx.data.tokenId,
        tx.data.policyVersion,
        tx.data.baseFee.toString(),
        tx.data.liquidityFeeBps.toString(),
        tx.data.gasFee.toString(),
      ];
    case 'swap_offer':
      // Cross-jurisdiction offers carry a route, paired pulls and their own
      // settlement path: outside the payment profile, so the engine is never
      // handed one.
      if (tx.data.crossJurisdiction) return null;
      return [
        6,
        tx.data.offerId,
        tx.data.giveTokenId,
        tx.data.giveTokenDecimals,
        tx.data.giveAmount.toString(),
        tx.data.wantTokenId,
        tx.data.wantTokenDecimals,
        tx.data.wantAmount.toString(),
        tx.data.maxFee.toString(),
        tx.data.minNetReceive.toString(),
        tx.data.timeInForce ?? null,
      ];
    case 'swap_cancel_request':
      return [7, tx.data.offerId];
    case 'htlc_resolve':
      return tx.data.outcome === 'secret'
        ? [2, tx.data.lockId, 0, hexToWireBytes(tx.data.secret, 32, 'SHADOW_SECRET')]
        : [2, tx.data.lockId, 1, tx.data.reason ?? null];
    default:
      return null;
  }
};
