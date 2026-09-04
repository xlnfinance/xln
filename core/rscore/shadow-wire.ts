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
  AccountFrame,
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
import { jEventClaimWire } from './process/j-claim-wire';

export const hexToWireBytes = (value: string, expectedBytes: number, code: string): Uint8Array => {
  const clean = value.trim().toLowerCase().replace(/^0x/, '');
  if (clean.length !== expectedBytes * 2 || !/^[0-9a-f]*$/.test(clean)) {
    throw new Error(`${code}:${value}`);
  }
  // Validation above makes Buffer's native hex decoder exact: odd, malformed
  // or truncated input can never reach it. The authority path converts tens
  // of thousands of ids and hashes per frame, so parsing one byte at a time in
  // JavaScript is measurable serialization work outside the Rust engine.
  return Buffer.from(clean, 'hex');
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
 * the engine can commit envelope sections it never interprets without a Rust
 * type per committed shape. Replica coordination travels separately in the
 * consensus wire and never enters this canonical leaf value.
 *
 * Numbers travel as the string JavaScript renders: the shortest
 * representation parses back to the identical double, so the engine
 * re-renders the authority's exact bytes.
 */
export const canonicalValueWire = (value: unknown, depth = 0): RscoreWireValue => {
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

/** The one committed leaf field the engine derives from its Account state. */
const ENGINE_DERIVED_LEAF_FIELDS: ReadonlySet<string> = new Set(['accountStateRoot']);

/**
 * The committed Entity Account leaf minus the Account state root the engine
 * derives. The separate consensus row below still carries the full mempool,
 * proposal, ACK and rollback state needed to continue after cutover; none of
 * that scheduling state is authenticated by the Entity root.
 */
/**
 * One operation of a wave, in the order the authority performed it.
 *
 * Admissions and Account inputs interleave inside a single Runtime frame, and the
 * order is load-bearing: a proposal that loses a height collision returns its
 * transactions to the front of the queue and drops the ones already there, so
 * whether our own admission had landed yet decides what survives.
 */
export const waveAdmitOp = (
  operationIndex: number,
  accountId: string,
  txs: RscoreWireValue[],
): RscoreWireValue =>
  [0, operationIndex, hexToWireBytes(accountId, 32, 'RSCORE_WAVE_ACCOUNT_ID'), txs];

export const waveInputOp = (row: RscoreWireValue): RscoreWireValue => [1, row];

/** Create a financially empty Account inside the abortable Rust candidate. */
export const waveCreateOp = (
  operationIndex: number,
  seed: RscoreWireValue,
): RscoreWireValue => [2, operationIndex, seed];

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
    Array.from(account.shadow.rebalance.policy.entries()).map(
      ([tokenId, policy]) => [tokenId, canonicalValueWire(policy)],
    ),
    Array.from(account.shadow.rebalance.submittedAtByToken.entries()).map(
      ([tokenId, timestamp]) => [tokenId, timestamp],
    ),
  ];
};

/**
 * Why an account snapshot cannot be mirrored, or null when it can.
 *
 * Most out-of-profile sections are *carried*: the engine commits their roots
 * verbatim and no supported transaction mutates them, so a live account with
 * swap/pull/rebalance/J-claim state still reproduces its exact state root.
 * Lending intents remain ineligible because the engine owns their map and a
 * live seed does not yet carry its entries. Settlement workspaces are carried
 * exactly, including Hankos; Rust strips only the same non-unique witnesses
 * as `settlementWorkspaceWithoutHankos` when computing the Account root.
 */
export const shadowIneligibilityReason = (state: AccountState): string | null => {
  if ((state.lendingIntents?.size ?? 0) > 0) return 'LENDING_INTENTS';
  // Live cutover imports complete same-j and cross-j offers. Quantized amounts
  // must still equal the live resting amounts; exact checkpoint recovery owns
  // the independently committed quantized fields.
  for (const offer of (state.swapOffers ?? new Map<string, SwapOffer>()).values()) {
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

const pullsWire = (pulls: AccountState['pulls']): RscoreWireValue[] =>
  [...(pulls ?? new Map()).entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([pullId, pull]) => [pullId, canonicalValueWire(pull)]);

/** Complete native bodies plus roots of sections Rust does not interpret. */
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
    pullsWire(state.pulls),
    swapOffersWire(state.swapOffers),
    root('subcontracts', state.subcontracts),
    root('requestedRebalance', state.requestedRebalance),
    root('requestedRebalanceFeeState', state.requestedRebalanceFeeState),
    rebalanceFeePoliciesWire(state.rebalanceFeePolicies),
    claim(state.leftPendingJClaims),
    claim(state.rightPendingJClaims),
    state.settlementWorkspace === undefined
      ? null
      : canonicalValueWire(state.settlementWorkspace),
  ];
};

/** Complete resting offers, in the engine's own field order. */
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
    offer.crossJurisdiction === undefined
      ? null
      : canonicalValueWire(offer.crossJurisdiction),
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
/**
 * Where the account stands in its own bilateral consensus: the frame it
 * committed, the frame it proposed and has not been acked for, its queue, and
 * the counterparty's certificate over the committed frame.
 *
 * A seed without this starts the account at height zero. That is right for the
 * mirror, which is re-seeded at each frame and told what the frame was, and
 * wrong for an engine that has to propose the *next* frame itself: it would
 * propose height one against an account the Entity has at height three, and
 * every hash from there on would be its own.
 */
export const accountConsensusWire = (account: AccountReplica): RscoreWireValue => {
  const current = account.currentFrame;
  const pending = account.pendingFrame;
  const committed = current === undefined || current.height === 0 ? null : [
    accountFrameWire(current),
    hexToWireBytes(current.stateHash, 32, 'SHADOW_CURRENT_STATE_HASH'),
  ];
  const localCommittedHanko = committedHankoWire(account, committed !== null, pending !== undefined);
  return [
    account.mempool.map(tx => {
      const wire = accountTxWire(tx);
      if (wire === null) throw new Error(`SHADOW_MEMPOOL_TX_UNSUPPORTED:${tx.type}`);
      return wire;
    }),
    // Height zero is no frame at all: the engine chains its first frame to the
    // genesis marker, exactly as this side does.
    committed,
    pending === undefined ? null : [
      accountFrameWire(pending),
      hexToWireBytes(pending.stateHash, 32, 'SHADOW_PENDING_STATE_HASH'),
      hankoWireBytes(pendingFrameHanko(account)),
      outboundAckWire(account.pendingAccountInput?.kind === 'ack_frame'
        ? account.pendingAccountInput.ack
        : undefined),
      disputeDraftWire(account.pendingAccountInput?.proposal?.disputeHanko),
    ],
    account.rollbackCount,
    account.lastRollbackFrameHash === undefined
      ? null
      : hexToWireBytes(account.lastRollbackFrameHash, 32, 'SHADOW_LAST_ROLLBACK'),
    account.counterpartyFrameHanko === undefined
      ? null
      : hankoWireBytes(account.counterpartyFrameHanko),
    localCommittedHanko,
    outboundAckWire(account.lastOutboundAckFrame?.response.ack),
    // The recovery proof this account already stands behind. The engine
    // replaces it the next time a frame moves the state, and spends the nonce
    // after this one when it does.
    disputeDraftWire(account.currentDisputeHash === undefined
      || account.currentDisputeProofBodyHash === undefined
      || account.currentDisputeProofNonce === undefined
      ? undefined
      : {
          ...(account.currentDisputeProofHanko === undefined
            ? {}
            : { hanko: account.currentDisputeProofHanko }),
          hash: account.currentDisputeHash,
          proofBodyHash: account.currentDisputeProofBodyHash,
          proofNonce: Number(account.currentDisputeProofNonce),
          proposerIsLeft: account.currentDisputeProofProposerIsLeft === true,
        }),
    account.proofHeader.nextProofNonce,
    // The counterparty's proof as it last arrived. Their signature travels
    // with it: the leaf commits its digest.
    account.counterpartyDisputeProofHanko === undefined
      || account.counterpartyDisputeProofBodyHash === undefined
      || account.counterpartyDisputeProofNonce === undefined
      || account.counterpartyDisputeHash === undefined
      ? null
      : [
          hankoWireBytes(account.counterpartyDisputeProofHanko),
          // The exact hash they signed. Rebuilding it from the rest would
          // accept a proof whose signature covers something else.
          hexToWireBytes(account.counterpartyDisputeHash, 32, 'SHADOW_PEER_DISPUTE_HASH'),
          hexToWireBytes(account.counterpartyDisputeProofBodyHash, 32, 'SHADOW_PEER_PROOF_BODY_HASH'),
          Number(account.counterpartyDisputeProofNonce),
          account.counterpartyDisputeProofProposerIsLeft === true,
        ],
  ];
};

const committedHankoWire = (
  account: AccountReplica,
  hasCommittedFrame: boolean,
  hasPendingFrame: boolean,
): RscoreWireValue => {
  if (!hasCommittedFrame) return null;
  if (hasPendingFrame) {
    // TypeScript overwrites currentFrameHanko with the pending proposal's
    // Hanko. It can no longer prove the local half of the older committed
    // frame, so bootstrapping from this state would fabricate exact recovery.
    throw new Error('RSCORE_BOOTSTRAP_PENDING_OVER_COMMITTED_UNSUPPORTED');
  }
  if (account.currentFrameHanko === undefined) {
    throw new Error('RSCORE_BOOTSTRAP_LOCAL_FRAME_HANKO_MISSING');
  }
  return hankoWireBytes(account.currentFrameHanko);
};

/**
 * An acknowledgement this side sent, as the engine needs it: the height it
 * covers and the frame hash it binds. The Entity commits both — inside
 * `lastOutboundAckFrame`, and inside a proposal that carried the ack with it.
 */
const outboundAckWire = (
  ack: {
    height: number;
    frameHash: string;
    frameHanko?: string;
    disputeHanko?: { hash: string; proofBodyHash: string; proofNonce: number; proposerIsLeft: boolean };
  } | undefined,
): RscoreWireValue => {
  if (ack === undefined) return null;
  // The retained ACK is evidence, and evidence without its signature proves
  // nothing: an engine handed a hankoless ACK could not retransmit it.
  if (ack.frameHanko === undefined) throw new Error('SHADOW_OUTBOUND_ACK_HANKO_MISSING');
  return [
    ack.height,
    hexToWireBytes(ack.frameHash, 32, 'SHADOW_OUTBOUND_ACK_HASH'),
    hankoWireBytes(ack.frameHanko),
    disputeDraftWire(ack.disputeHanko),
  ];
};

/**
 * Our own signature over the proposed frame. It is not a field of the frame:
 * it lives in the signed proposal still waiting for the counterparty's ack,
 * which is the only place this side keeps it.
 */
const pendingFrameHanko = (account: AccountReplica): string => {
  const input = account.pendingAccountInput;
  const hanko = input === undefined ? undefined : input.proposal?.frameHanko;
  if (typeof hanko !== 'string') throw new Error('SHADOW_PENDING_FRAME_HANKO_MISSING');
  return hanko;
};

/** A proposed frame, whole: the engine replays it and checks its own hash. */
/** Recovery proof identity plus its exact local certificate when committed. */
const disputeDraftWire = (
  draft: {
    hanko?: string;
    hash: string;
    proofBodyHash: string;
    proofNonce: number;
    proposerIsLeft: boolean;
  } | undefined,
): RscoreWireValue => (draft === undefined ? null : [
  draft.hanko === undefined ? null : hankoWireBytes(draft.hanko),
  hexToWireBytes(draft.hash, 32, 'SHADOW_DISPUTE_DRAFT_HASH'),
  hexToWireBytes(draft.proofBodyHash, 32, 'SHADOW_DISPUTE_DRAFT_BODY_HASH'),
  Number(draft.proofNonce),
  draft.proposerIsLeft === true,
]);

const accountFrameWire = (frame: AccountFrame): RscoreWireValue => [
  frame.height,
  frame.timestamp,
  frame.jHeight,
  frame.accountTxs.map(tx => {
    const wire = accountTxWire(tx);
    if (wire === null) throw new Error(`SHADOW_FRAME_TX_UNSUPPORTED:${tx.type}`);
    return wire;
  }),
  frame.prevFrameHash,
  hexToWireBytes(frame.accountStateRoot, 32, 'SHADOW_FRAME_STATE_ROOT'),
];

/**
 * One received peer frame, exactly as the signed AccountInput carried it.
 *
 * Consensus snapshots bind `stateHash` beside their frame because the engine
 * independently restores that binding. A Account input is different: its frame
 * itself carries `stateHash`; dropping it would make Rust judge reconstructed
 * data instead of the canonical input.
 */
export const accountInputFrameWire = (frame: AccountFrame): RscoreWireValue => [
  frame.height,
  frame.timestamp,
  frame.jHeight,
  frame.accountTxs.map(tx => {
    const wire = accountTxWire(tx);
    if (wire === null) throw new Error(`RSCORE_AUTHORITY_FRAME_TX_UNSUPPORTED:${tx.type}`);
    return wire;
  }),
  frame.prevFrameHash,
  hexToWireBytes(frame.accountStateRoot, 32, 'AUTHORITY_FRAME_STATE_ROOT'),
  hexToWireBytes(frame.stateHash, 32, 'AUTHORITY_FRAME_STATE_HASH'),
];

const hankoWireBytes = (value: string): Uint8Array => {
  const clean = value.startsWith('0x') ? value.slice(2) : value;
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`SHADOW_HANKO_INVALID:${clean.length}`);
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'));
};

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
  /**
   * Where consensus stands for this account. Absent for the mirror, which is
   * handed each frame and never proposes one.
   */
  consensus: RscoreWireValue | null = null,
  /**
   * The jurisdiction's `DeltaTransformer`, which the recovery proof names.
   * Absent for the mirror, for the same reason: it signs no proof.
   */
  deltaTransformer: string | null = null,
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
    consensus,
    deltaTransformer === null
      ? null
      : hexToWireBytes(deltaTransformer, 20, 'SHADOW_DELTA_TRANSFORMER'),
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
      crossJurisdiction: RscoreWireValue | null,
    ]
  | readonly [kind: 'offerRemove', offerId: string]
  | readonly [kind: 'cancelRequest', offerId: string]
  | readonly [
      kind: 'accountSettledFinalized',
      tokenId: number,
      jHeight: number,
      collateral: string,
      ondelta: string,
    ]
  | readonly [
      kind: 'requestCollateralCommitted',
      entityId: string,
      accountId: string,
      tokenId: number,
      requestedAmount: string,
      prepaidFee: string,
      requestedAt: number,
    ]
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
  const effects = result.candidateEffects ?? [];
  // Every candidate effect, in order: skipping an unknown kind would compare a
  // shorter list against the engine's and call the frame a match.
  for (let index = 0; index < effects.length; index += 1) {
    const output = effects[index];
    if (output === undefined) throw new Error(`SHADOW_OUTPUT_INDEX_MISSING:${index}`);
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
          offer.crossJurisdiction === undefined
            ? null
            : canonicalValueWire(offer.crossJurisdiction),
        ]);
        break;
      }
      case 'swapOfferRemove':
        rows.push(['offerRemove', output.offerId]);
        break;
      case 'swapCancelRequest':
        rows.push(['cancelRequest', output.offerId]);
        break;
      case 'runtimeEvent': {
        if (output.eventName === 'request_collateral_committed') {
          const {
            entityId,
            accountId,
            tokenId,
            requestedAmount,
            prepaidFee,
            requestedAt,
          } = output.data;
          if (
            typeof entityId !== 'string'
            || typeof accountId !== 'string'
            || typeof tokenId !== 'number'
            || !Number.isSafeInteger(tokenId)
            || typeof requestedAmount !== 'string'
            || !/^\d+$/.test(requestedAmount)
            || typeof prepaidFee !== 'string'
            || !/^\d+$/.test(prepaidFee)
            || typeof requestedAt !== 'number'
            || !Number.isSafeInteger(requestedAt)
          ) {
            throw new Error('SHADOW_OUTPUT_REQUEST_COLLATERAL_COMMITTED_INVALID');
          }
          rows.push([
            'requestCollateralCommitted',
            entityId,
            accountId,
            tokenId,
            requestedAmount,
            prepaidFee,
            requestedAt,
          ]);
          break;
        }
        if (output.eventName !== 'account_settled_finalized_bilateral') {
          throw new Error(`SHADOW_OUTPUT_RUNTIME_EVENT_UNSUPPORTED:${output.eventName}`);
        }
        const { tokenId, jHeight, collateral, ondelta } = output.data;
        if (
          typeof tokenId !== 'number'
          || !Number.isSafeInteger(tokenId)
          || typeof jHeight !== 'number'
          || !Number.isSafeInteger(jHeight)
          || typeof collateral !== 'string'
          || !/^-?\d+$/.test(collateral)
          || typeof ondelta !== 'string'
          || !/^-?\d+$/.test(ondelta)
        ) {
          throw new Error('SHADOW_OUTPUT_ACCOUNT_SETTLED_INVALID');
        }
        const debug = effects[index + 1];
        if (
          debug?.kind !== 'debug'
          || debug.payload['code'] !== 'REB_STEP'
          || debug.payload['step'] !== 5
          || debug.payload['status'] !== 'ok'
          || debug.payload['event'] !== output.eventName
          || debug.payload['tokenId'] !== tokenId
          || debug.payload['jHeight'] !== jHeight
          || debug.payload['collateral'] !== collateral
          || debug.payload['ondelta'] !== ondelta
        ) {
          throw new Error('SHADOW_OUTPUT_ACCOUNT_SETTLED_DEBUG_MISMATCH');
        }
        rows.push(['accountSettledFinalized', tokenId, jHeight, collateral, ondelta]);
        index += 1;
        break;
      }
      case 'debug':
        throw new Error('SHADOW_OUTPUT_ORPHAN_DEBUG');
      default:
        throw new Error('SHADOW_OUTPUT_KIND_UNSUPPORTED');
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

/** Absent stays absent on the wire: several resolve checks distinguish it from zero. */
const optionalAmount = (value: bigint | undefined): string | null =>
  value === undefined ? null : value.toString();

/** Process-wire tx tuple, or null when the tx type is outside the profile. */
export const accountTxWire = (tx: AccountTx): RscoreWireValue[] => {
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
        tx.data.crossJurisdiction === undefined ? null : canonicalValueWire(tx.data.crossJurisdiction),
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
        // Carried, never interpreted: TypeScript hashes whatever the matcher
        // wrote, so a wire that dropped these would make the engine sign a
        // frame TypeScript cannot reproduce.
        tx.data.comment ?? null,
        tx.data.restingGiveTokenId ?? null,
        tx.data.restingWantTokenId ?? null,
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
    case 'j_event_claim':
      return jEventClaimWire(tx);
    case 'lending_fund':
      return [10, tx.data.positionId, tx.data.hubEntityId, tx.data.lenderEntityId,
        tx.data.tokenId, tx.data.amount.toString(),
        tx.data.termId === '1h' ? 0 : tx.data.termId === '1d' ? 1 : 2, tx.data.interestBps];
    case 'lending_borrow_request':
      return [11, tx.data.requestId, tx.data.hubEntityId, tx.data.borrowerEntityId,
        tx.data.tokenId, tx.data.amount.toString(),
        tx.data.termId === '1h' ? 0 : tx.data.termId === '1d' ? 1 : 2, tx.data.maxInterestBps];
    case 'lending_repay':
      return [12, tx.data.loanId, tx.data.hubEntityId, tx.data.borrowerEntityId,
        tx.data.tokenId, tx.data.amount.toString()];
    case 'lending_credit':
      return [13, tx.data.action === 'grant' ? 0 : 1, tx.data.loanId, tx.data.hubEntityId,
        tx.data.borrowerEntityId, tx.data.tokenId, tx.data.creditLimit.toString()];
    case 'lending_close_request':
      return [14, tx.data.positionId, tx.data.hubEntityId, tx.data.lenderEntityId];
    case 'lending_close_payout':
      return [15, tx.data.positionId, tx.data.hubEntityId, tx.data.lenderEntityId,
        tx.data.tokenId, tx.data.amount.toString()];
    case 'request_collateral':
      return [17, tx.data.tokenId, tx.data.amount.toString(), tx.data.feeTokenId ?? null,
        tx.data.feeAmount.toString(), tx.data.policyVersion];
    case 'rebalance_refund':
      return [18, tx.data.requestId, tx.data.requestTokenId, tx.data.amount.toString(), tx.data.reason];
    case 'cross_pull_lock': return [19, canonicalValueWire(tx.data)];
    case 'cross_pull_close': return [20, canonicalValueWire(tx.data)];
    case 'settle_transition': return [23, canonicalValueWire(tx.data)];
    default: {
      const exhaustive: never = tx;
      throw new Error(`SHADOW_ACCOUNT_TX_UNREACHABLE:${String(exhaustive)}`);
    }
  }
};
