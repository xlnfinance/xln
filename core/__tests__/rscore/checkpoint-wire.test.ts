import { describe, expect, test } from 'bun:test';

import { computeAccountStateRoot } from '../../account/commitment/state-root';
import { computeFrameHash } from '../../account/consensus/frame/hash';
import { createEmptyAccountJClaimAccumulator } from '../../account/j-claims/j-claim-accumulator';
import { PersistentAccountStateMap } from '../../account/state/persistent-state-map';
import { computeEntityAccountLeafDigest } from '../../entity/consensus/state-root';
import { computeIntegrityDigest } from '../../support/bytes/integrity-checksum';
import type { AccountFrame, AccountState, Delta, HtlcLock, SwapOffer } from '../../types/account';
import type { BilateralRebalanceFeePolicy } from '../../types/finance/rebalance';
import { decodeRscoreAccountRestoreRow } from '../../rscore/checkpoint/checkpoint-restore';
import {
  assertRscoreCheckpointCandidate,
  decodeRscoreCheckpointChanges,
  type RscoreCheckpointToken,
} from '../../rscore/checkpoint/checkpoint-wire';

const root = Buffer.alloc(32, 0x31);
const signer = Buffer.alloc(32, 0x42);

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const DEPOSITORY = `0x${'44'.repeat(20)}`;
const WATCH_SEED = `0x${'33'.repeat(32)}`;
const bytes = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex');

const canonicalWire = (value: unknown): unknown[] => {
  if (value === null) return [0];
  if (typeof value === 'boolean') return [1, value ? 1 : 0];
  if (typeof value === 'number') return [2, String(value)];
  if (typeof value === 'bigint') return [3, value.toString()];
  if (typeof value === 'string') return [4, value];
  if (Array.isArray(value)) return [5, value.map(canonicalWire)];
  if (typeof value === 'object') {
    return [8, Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, canonicalWire(entry)])];
  }
  throw new Error(`unsupported test canonical value: ${String(value)}`);
};

const delta: Delta = {
  tokenId: 1,
  collateral: 100n,
  ondelta: 4n,
  offdelta: -3n,
  leftCreditLimit: 10n,
  rightCreditLimit: 11n,
  leftAllowance: 12n,
  rightAllowance: 13n,
  leftHold: 1n,
  rightHold: 2n,
};

const lock: HtlcLock = {
  lockId: `0x${'55'.repeat(32)}`,
  hashlock: `0x${'66'.repeat(32)}`,
  timelock: 1_000n,
  revealBeforeHeight: 20,
  amount: 7n,
  tokenId: 1,
  senderIsLeft: true,
  createdHeight: 2,
  createdTimestamp: 90,
  envelopeHash: `0x${'77'.repeat(32)}`,
};

const offer: SwapOffer = {
  offerId: 'offer-1',
  giveTokenId: 1,
  giveTokenDecimals: 6,
  giveAmount: 20n,
  wantTokenId: 2,
  wantTokenDecimals: 6,
  wantAmount: 30n,
  maxFee: 2n,
  minNetReceive: 28n,
  priceTicks: 1_500n,
  timeInForce: 0,
  makerIsLeft: true,
  createdHeight: 2,
  quantizedGive: 20n,
  quantizedWant: 30n,
};

const policy: BilateralRebalanceFeePolicy = {
  left: { policyVersion: 1, baseFee: 2n, liquidityFeeBps: 50n, gasFee: 3n, updatedAt: 88 },
};

const deltaWire = (value: Delta): unknown[] => [
  value.tokenId,
  value.collateral.toString(),
  value.ondelta.toString(),
  value.offdelta.toString(),
  value.leftCreditLimit.toString(),
  value.rightCreditLimit.toString(),
  value.leftAllowance.toString(),
  value.rightAllowance.toString(),
  value.leftHold.toString(),
  value.rightHold.toString(),
];

const restoreFixture = (): { row: unknown[]; stateRoot: string; leaf: string; frameHash: string } => {
  const deltas = PersistentAccountStateMap.fromEntries('deltas', [[delta.tokenId, delta]]);
  const locks = PersistentAccountStateMap.fromEntries('locks', [[lock.lockId, lock]]);
  const lendingIntents = PersistentAccountStateMap.fromEntries('lendingIntents', [['intent-1', 'fund' as const]]);
  const swapOffers = PersistentAccountStateMap.fromEntries('swapOffers', [[offer.offerId, offer]]);
  const rebalanceFeePolicies = PersistentAccountStateMap.fromEntries('rebalanceFeePolicies', [[1, policy]]);
  const empty = <K extends number | string, V>(
    namespace: Parameters<typeof PersistentAccountStateMap.empty<K, V>>[0],
  ) => PersistentAccountStateMap.empty<K, V>(namespace);
  const claim = createEmptyAccountJClaimAccumulator();
  const state: AccountState = {
    leftEntity: LEFT,
    rightEntity: RIGHT,
    domain: { chainId: 1, depositoryAddress: DEPOSITORY },
    watchSeed: WATCH_SEED,
    deltas,
    locks,
    swapOffers,
    lendingIntents,
    leftPendingJClaims: claim,
    rightPendingJClaims: claim,
    lastFinalizedJHeight: 5,
    disputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 120 },
    jNonce: 4,
    requestedRebalance: empty('requestedRebalance'),
    requestedRebalanceFeeState: empty('requestedRebalanceFeeState'),
    rebalanceFeePolicies,
  };
  const stateRoot = computeAccountStateRoot(state);
  const frame: AccountFrame = {
    height: 3,
    timestamp: 100,
    jHeight: 5,
    accountTxs: [],
    prevFrameHash: `0x${'aa'.repeat(32)}`,
    accountStateRoot: stateRoot,
    stateHash: '',
  };
  frame.stateHash = computeFrameHash(frame);
  const peerHanko = '0x010203';
  const ackHanko = '0x040506';
  const ackBinding = {
    height: frame.height,
    counterpartyEntityId: RIGHT,
    response: {
      kind: 'ack',
      fromEntityId: LEFT,
      toEntityId: RIGHT,
      ack: { height: frame.height, frameHash: frame.stateHash },
    },
  };
  const leaf = computeEntityAccountLeafDigest(
    Object.entries({
      status: 'active',
      publicPinned: true,
      currentHeight: frame.height,
      rollbackCount: 0,
      currentFrameHash: frame.stateHash,
      proofHeader: { fromEntity: LEFT, toEntity: RIGHT, nextProofNonce: 7 },
      lastOutboundFrameAck: ackBinding,
      counterpartyFrameHanko: computeIntegrityDigest(new TextEncoder().encode(peerHanko)),
      accountStateRoot: stateRoot,
      mempoolRoot: `0x${'00'.repeat(32)}`,
    }),
  );
  const frameWire = [
    frame.height,
    frame.timestamp,
    frame.jHeight,
    [],
    frame.prevFrameHash,
    bytes(frame.accountStateRoot),
  ];
  const emptyRoot = bytes(empty('pulls').rootHash());
  const header = [
    bytes(LEFT),
    'h1-hub',
    [1, bytes(DEPOSITORY), bytes(LEFT), bytes(RIGHT), bytes(WATCH_SEED)],
    [60, 120],
    4,
    5,
    [
      emptyRoot,
      bytes(empty('subcontracts').rootHash()),
      bytes(empty('requestedRebalance').rootHash()),
      bytes(empty('requestedRebalanceFeeState').rootHash()),
      [bytes(claim.root), claim.count],
      [bytes(claim.root), claim.count],
    ],
    [canonicalWire({ status: 'active', publicPinned: true }), []],
    null,
  ];
  const row = [
    bytes(RIGHT),
    bytes(leaf),
    header,
    [deltaWire(delta)],
    [
      [
        lock.lockId,
        bytes(lock.hashlock),
        lock.timelock.toString(),
        lock.revealBeforeHeight,
        lock.amount.toString(),
        lock.tokenId,
        0,
        lock.createdHeight,
        lock.createdTimestamp,
        bytes(lock.envelopeHash!),
      ],
    ],
    [['intent-1', 0]],
    [
      [
        offer.offerId,
        offer.giveTokenId,
        offer.giveTokenDecimals,
        offer.giveAmount.toString(),
        offer.wantTokenId,
        offer.wantTokenDecimals,
        offer.wantAmount.toString(),
        offer.maxFee.toString(),
        offer.minNetReceive.toString(),
        offer.priceTicks!.toString(),
        offer.timeInForce,
        0,
        offer.createdHeight,
        offer.quantizedGive.toString(),
        offer.quantizedWant.toString(),
      ],
    ],
    [[1, [[1, '2', '50', '3', 88], null]]],
    [],
    [
      [],
      [frameWire, bytes(frame.stateHash)],
      null,
      0,
      null,
      Buffer.from([1, 2, 3]),
      Buffer.from([4]),
      [frame.height, bytes(frame.stateHash), bytes(ackHanko), null],
      null,
      7,
      null,
    ],
  ];
  return { row, stateRoot, leaf, frameHash: frame.stateHash };
};

const token = (
  baseRevision: number,
  revision: number,
  accountsRoot: Uint8Array = root,
  accountCount = 1,
): RscoreCheckpointToken => [baseRevision, revision, accountsRoot, signer, accountCount];

describe('rscore checkpoint wire', () => {
  test('materializes and verifies one exact restore row without inventing carried bodies', () => {
    const fixture = restoreFixture();
    const decoded = decodeRscoreAccountRestoreRow(fixture.row);
    expect(decoded.accountStateRoot).toBe(fixture.stateRoot);
    expect(decoded.entityAccountLeaf).toBe(fixture.leaf);
    expect(decoded.consensus.currentFrame?.stateHash).toBe(fixture.frameHash);
    expect(decoded.consensus.lastOutboundAck).toEqual({
      height: 3,
      frameHash: fixture.frameHash,
      frameHanko: '0x040506',
    });
    expect(decoded.stateSeed.deltas.get(1)).toEqual(delta);
    expect(decoded.stateSeed.locks.get(lock.lockId)).toEqual(lock);
    expect(decoded.stateSeed.lendingIntents.get('intent-1')).toBe('fund');
    expect(decoded.stateSeed.swapOffers.get(offer.offerId)).toEqual(offer);
    expect(decoded.stateSeed.rebalanceFeePolicies.get(1)).toEqual(policy);
    expect(decoded.rootOnlyCarriedSections).toEqual([
      'pulls',
      'subcontracts',
      'requestedRebalance',
      'requestedRebalanceFeeState',
    ]);
  });

  test('keeps exact ACK Hanko bytes outside the compact Entity leaf binding', () => {
    const first = restoreFixture();
    const firstDecoded = decodeRscoreAccountRestoreRow(first.row);
    const second = restoreFixture();
    const consensus = second.row[9] as unknown[];
    const ack = consensus[7] as unknown[];
    ack[2] = Buffer.from([0x09, 0x08, 0x07, 0x06]);
    const secondDecoded = decodeRscoreAccountRestoreRow(second.row);

    expect(firstDecoded.entityAccountLeaf).toBe(secondDecoded.entityAccountLeaf);
    expect(firstDecoded.consensus.lastOutboundAck?.frameHanko).toBe('0x040506');
    expect(secondDecoded.consensus.lastOutboundAck?.frameHanko).toBe('0x09080706');

    const oldShape = restoreFixture().row;
    const oldConsensus = oldShape[9] as unknown[];
    const oldAck = oldConsensus[7] as unknown[];
    oldConsensus[7] = [oldAck[0], oldAck[1], oldAck[3]];
    expect(() => decodeRscoreAccountRestoreRow(oldShape)).toThrow(
      'RSCORE_CHECKPOINT_RESTORE_LAST_OUTBOUND_ACK_ARITY',
    );
  });

  test('rejects corrupt frame, state-root and Entity-leaf commitments', () => {
    const badFrame = restoreFixture().row;
    ((badFrame[9] as unknown[])[1] as unknown[])[1] = Buffer.alloc(32, 0xff);
    expect(() => decodeRscoreAccountRestoreRow(badFrame)).toThrow('CURRENT_FRAME_HASH_MISMATCH');

    const badRoot = restoreFixture().row;
    ((badRoot[2] as unknown[])[6] as unknown[])[0] = Buffer.alloc(32, 0xee);
    expect(() => decodeRscoreAccountRestoreRow(badRoot)).toThrow('CURRENT_ACCOUNT_STATE_ROOT_MISMATCH');

    const badLeaf = restoreFixture().row;
    badLeaf[1] = Buffer.alloc(32, 0xdd);
    expect(() => decodeRscoreAccountRestoreRow(badLeaf)).toThrow('ACCOUNT_LEAF_MISMATCH');
  });

  test('rejects a non-canonical carried envelope instead of normalizing it', () => {
    const fixture = restoreFixture().row;
    const envelope = (fixture[2] as unknown[])[7] as unknown[];
    envelope[0] = [
      8,
      [
        ['status', [4, 'active']],
        ['status', [4, 'disputed']],
      ],
    ];
    expect(() => decodeRscoreAccountRestoreRow(fixture)).toThrow('OBJECT_DUPLICATE');
  });

  test('rejects a checkpoint that regresses its durable revision', () => {
    expect(() => decodeRscoreCheckpointChanges([token(10, 9), token(9, 9), [], []])).toThrow(
      'RSCORE_CHECKPOINT_TOKEN_RELATION',
    );

    expect(() => decodeRscoreCheckpointChanges([token(10, 10), token(10, 10), [], []])).not.toThrow();
  });

  test('binds the durable checkpoint to the exact prepared candidate', () => {
    const checkpoint = decodeRscoreCheckpointChanges([token(3, 4), token(4, 4), [], []]);
    const expected = {
      revision: 4,
      accountsRoot: `0x${root.toString('hex')}`,
      accountCount: 1,
    };
    expect(() => assertRscoreCheckpointCandidate(checkpoint, expected)).not.toThrow();
    expect(() =>
      assertRscoreCheckpointCandidate(checkpoint, {
        ...expected,
        revision: 5,
      }),
    ).toThrow('RSCORE_CHECKPOINT_CANDIDATE_MISMATCH');
    expect(() =>
      assertRscoreCheckpointCandidate(checkpoint, {
        ...expected,
        accountsRoot: `0x${'ff'.repeat(32)}`,
      }),
    ).toThrow('RSCORE_CHECKPOINT_CANDIDATE_MISMATCH');
    expect(() =>
      assertRscoreCheckpointCandidate(checkpoint, {
        ...expected,
        accountCount: 2,
      }),
    ).toThrow('RSCORE_CHECKPOINT_CANDIDATE_MISMATCH');
  });
});
