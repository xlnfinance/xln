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
import { canonicalAccountTxForFrameHash } from '../account/consensus/frame/hash';
import { projectEntityAccountLeaf } from '../entity/consensus/state-root';
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
 * Canonical values on the wire: the same nine-variant model both sides hash
 * (`encodeAccountStateValue` here, `CanonicalValue` in the engine), tagged so
 * the engine can commit sections it never interprets — the mempool in its
 * frame-hash form, hankos, acks, frame bindings — without a Rust type per
 * shape the authority happens to commit.
 *
 * Numbers travel as the string JavaScript renders: the shortest
 * representation parses back to the identical double, so the engine
 * re-renders the authority's exact bytes.
 */
const canonicalValueWire = (value: unknown, depth = 0): RscoreWireValue => {
  if (depth > 32) throw new Error('SHADOW_CANONICAL_DEPTH');
  if (value === null) return [0];
  switch (typeof value) {
    case 'boolean': return [1, value ? 1 : 0];
    case 'number': {
      if (!Number.isFinite(value)) throw new Error(`SHADOW_CANONICAL_NON_FINITE:${String(value)}`);
      return [2, String(value)];
    }
    case 'bigint': return [3, value.toString()];
    case 'string': return [4, value];
    default: break;
  }
  if (Array.isArray(value)) return [5, value.map(entry => canonicalValueWire(entry, depth + 1))];
  if (value instanceof Map) {
    return [6, [...value.entries()].map(([key, entry]) => [
      canonicalValueWire(key, depth + 1),
      canonicalValueWire(entry, depth + 1),
    ])];
  }
  if (value instanceof Set) {
    return [7, [...value.values()].map(entry => canonicalValueWire(entry, depth + 1))];
  }
  if (typeof value === 'object') {
    // Same filter the authority's encoder applies: an undefined property is
    // not part of the value.
    return [8, Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, canonicalValueWire(entry, depth + 1)])];
  }
  throw new Error(`SHADOW_CANONICAL_UNSUPPORTED:${typeof value}`);
};

/** Fields the engine derives itself; sending them would prove nothing. */
const ENGINE_DERIVED_LEAF_FIELDS: ReadonlySet<string> = new Set(['accountStateRoot', 'mempoolRoot']);

/**
 * The replica shell the Entity commits around the financial state: its own
 * account-leaf projection minus the two roots the engine derives, plus the
 * mempool in the canonical form the frame hash uses. With it the engine's
 * account tree leaf is the Entity's account leaf, so the two accounts roots
 * are directly comparable.
 */
/**
 * One operation of a wave, in the order the authority performed it.
 *
 * Admissions and peer inputs interleave inside a single Runtime frame, and the
 * order is load-bearing: a proposal that loses a height collision returns its
 * transactions to the front of the queue and drops the ones already there, so
 * whether our own admission had landed yet decides what survives.
 */
export const waveAdmitOp = (accountId: string, txs: RscoreWireValue[]): RscoreWireValue =>
  [0, hexToWireBytes(accountId, 32, 'RSCORE_WAVE_ACCOUNT_ID'), txs];

export const waveInputOp = (row: RscoreWireValue): RscoreWireValue => [1, row];

export const accountEnvelopeWire = (account: AccountReplica): RscoreWireValue => {
  const projected = projectEntityAccountLeaf(account);
  for (const field of ENGINE_DERIVED_LEAF_FIELDS) {
    if (!(field in projected)) throw new Error(`SHADOW_LEAF_FIELD_MISSING:${field}`);
  }
  const fields = Object.entries(projected)
    .filter(([key, value]) => !ENGINE_DERIVED_LEAF_FIELDS.has(key) && value !== undefined)
    .map(([key, value]) => [key, canonicalValueWire(value)]);
  return [
    [8, fields],
    account.mempool.map(tx => canonicalValueWire(canonicalAccountTxForFrameHash(tx))),
  ];
};

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
export const shadowIneligibilityReason = (state: AccountState): string | null => {
  if ((state.lendingIntents?.size ?? 0) > 0) return 'LENDING_INTENTS';
  if (state.settlementWorkspace !== undefined) return 'SETTLEMENT_WORKSPACE';
  // The engine owns the offer rows now, so it can only import offers it can
  // represent: same-j offers whose committed price and quantized amounts are
  // present and equal to the resting amounts. Anything else would be re-encoded
  // lossily into a root that happens to look right.
  for (const offer of (state.swapOffers ?? new Map<string, SwapOffer>()).values()) {
    if (offer.crossJurisdiction) return 'CROSS_J_SWAP_OFFER';
    if (offer.priceTicks === undefined) return 'SWAP_OFFER_WITHOUT_PRICE';
    if (offer.quantizedGive !== offer.giveAmount || offer.quantizedWant !== offer.wantAmount) {
      return 'SWAP_OFFER_QUANTIZED_MISMATCH';
    }
  }
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

/**
 * One policy row of exactly `arity` numbers. A short row is a wire defect, and
 * hashing it with a hole would produce a digest that agrees with nothing.
 */
const policyRow = (row: readonly number[], arity: number, label: string): readonly number[] => {
  if (row.length !== arity || row.some(value => !Number.isFinite(value))) {
    throw new Error(`SHADOW_POLICY_ROW:${label}:${row.length}`);
  }
  return row;
};

/** Same preimage as SwapMarketPolicy::digest on the engine side. */
export const swapMarketPolicyDigest = (policy: readonly RscoreWireValue[]): string => {
  const hasher = createHash('sha256');
  hasher.update(Buffer.from('xln.rscore.swap-market-policy.v1'));
  for (const row of policy[0] as number[][]) {
    const [tokenId, decimals, flags] = policyRow(row, 3, 'token');
    hasher.update(be32(tokenId ?? 0));
    hasher.update(be32(decimals ?? 0));
    hasher.update(Buffer.from([flags ?? 0]));
  }
  hasher.update(Buffer.from('steps'));
  // The engine keeps steps in a map keyed by (base, quote); match that order.
  const steps = (policy[1] as number[][])
    .map(row => policyRow(row, 3, 'step'))
    .sort((left, right) => ((left[0] ?? 0) - (right[0] ?? 0)) || ((left[1] ?? 0) - (right[1] ?? 0)));
  for (const [base, quote, step] of steps) {
    hasher.update(be32(base ?? 0));
    hasher.update(be32(quote ?? 0));
    hasher.update(be32(step ?? 0));
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
const carriedSectionsWire = (state: AccountState): RscoreWireValue[] => {
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
  state: AccountState,
  /**
   * The replica shell that belongs with this state. Absent when the seed is
   * the state a frame started in: that frame's own execution installs the
   * shell it produced.
   */
  envelope: RscoreWireValue | null = null,
): RscoreWireValue[] => {
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
    carriedSectionsWire(state),
    envelope,
  ];
};

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
      kind: 'offerUpsert',
      offerId: string,
      leftEntity: string,
      rightEntity: string,
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
      makerSide: number,
      createdHeight: number,
      quantizedGive: string,
      quantizedWant: string,
    ]
  | readonly [kind: 'offerRemove', offerId: string]
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
  // Every candidate effect, in order: skipping an unknown kind would compare a
  // shorter list against the engine's and call the frame a match.
  for (const output of result.candidateEffects ?? []) {
    switch (output.kind) {
      case 'directPaymentForward':
        rows.push([
          'forward',
          output.tokenId,
          output.amount.toString(),
          [...output.route],
          output.description ?? null,
          output.deliveryMode,
          output.trustedGatewayEntityId,
        ]);
        break;
      case 'swapOfferUpsert': {
        const offer = output.offer;
        rows.push([
          'offerUpsert',
          offer.offerId,
          offer.leftEntity,
          offer.rightEntity,
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
          offer.makerIsLeft ? 0 : 1,
          offer.createdHeight,
          offer.quantizedGive.toString(),
          offer.quantizedWant.toString(),
        ]);
        break;
      }
      case 'swapOfferRemove':
        rows.push(['offerRemove', output.offerId]);
        break;
      case 'swapCancelRequest':
        rows.push(['cancelRequest', output.offerId]);
        break;
      default:
        throw new Error(`SHADOW_OUTPUT_KIND_UNSUPPORTED:${output.kind}`);
    }
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

/**
 * Support is a property of the payload, not of the tx type: a cross-jurisdiction
 * swap offer is the same `swap_offer` type as a same-j one and the engine
 * cannot execute it. Callers must treat a null wire as unsupported.
 */
export const shadowTxSupported = (tx: AccountTx): boolean => accountTxWire(tx) !== null;

/** Absent stays absent on the wire: several resolve checks distinguish it from zero. */
const optionalAmount = (value: bigint | undefined): string | null =>
  value === undefined ? null : value.toString();

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
        optionalAmount(tx.data.priceTicks),
      ];
    case 'swap_cancel_request':
      return [7, tx.data.offerId];
    case 'swap_resolve':
      return [
        8,
        tx.data.offerId,
        tx.data.fillRatio,
        optionalAmount(tx.data.fillNumerator),
        optionalAmount(tx.data.fillDenominator),
        tx.data.cancelRemainder ? 1 : 0,
        tx.data.feeTokenId ?? null,
        optionalAmount(tx.data.feeAmount),
        optionalAmount(tx.data.executionGiveAmount),
        optionalAmount(tx.data.executionWantAmount),
        optionalAmount(tx.data.restingPriceTicks),
        optionalAmount(tx.data.restingGiveAmount),
        optionalAmount(tx.data.restingWantAmount),
        optionalAmount(tx.data.restingQuantizedGive),
        optionalAmount(tx.data.restingQuantizedWant),
      ];
    case 'htlc_resolve':
      return tx.data.outcome === 'secret'
        ? [2, tx.data.lockId, 0, hexToWireBytes(tx.data.secret, 32, 'SHADOW_SECRET')]
        : [2, tx.data.lockId, 1, tx.data.reason ?? null];
    default:
      return null;
  }
};
