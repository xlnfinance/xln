import { describe, expect, test } from 'bun:test';

import { computeAccountStateRoot, EMPTY_ACCOUNT_STATE_ROOT } from '../../account/commitment/state-root';
import { computeFrameHash } from '../../account/consensus/frame/hash';
import { createEmptyAccountJClaimAccumulator } from '../../account/j-claims/j-claim-accumulator';
import { PersistentAccountStateMap } from '../../account/state/persistent-state-map';
import { attachHankoWitnessesToState } from '../../entity/consensus/input/hanko-witness';
import { computeEntityAccountValueHash } from '../../entity/consensus/state-root';
import {
  EntityAccountCandidateMap,
  PersistentEntityAccountMap,
} from '../../entity/state/persistent-account-map';
import type { EntityState } from '../../entity/types';
import { createDisputeProofHashWithNonce } from '../../protocol/dispute/proof-builder';
import { safeStringify } from '../../protocol/serialization';
import {
  materializeRscoreAccountReplica,
  type RscoreAccountLocalWitnessPlan,
  type RscoreAccountMaterializerBinding,
} from '../../rscore/checkpoint/account-materializer';
import { decodeRscoreAccountRestoreRow } from '../../rscore/checkpoint/checkpoint-restore';
import type { RscoreAccountCheckpointRow } from '../../rscore/checkpoint/wave-checkpoint-decode';
import { accountEnvelopeWire, accountTxWire } from '../../rscore/shadow-wire';
import type { RscoreWireValue } from '../../rscore/process-wire-value';
import type {
  AccountDisputeHanko,
  AccountFrame,
  AccountReplica,
  AccountState,
  Delta,
  HtlcLock,
  SwapOffer,
} from '../../types/account';
import type { BilateralRebalanceFeePolicy, RebalancePolicy } from '../../types/finance/rebalance';

const OWNER = `0x${'11'.repeat(32)}`;
const PEER = `0x${'22'.repeat(32)}`;
const DEPOSITORY = `0x${'44'.repeat(20)}`;
const WATCH_SEED = `0x${'33'.repeat(32)}`;
const SIGNER = 'h1-hub';
const binding: RscoreAccountMaterializerBinding = {
  sessionOwnerEntityId: OWNER,
  expectedSignerId: SIGNER,
};
const noFreshWitnesses: RscoreAccountLocalWitnessPlan = { freshHashesToSign: [] };

const bytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
const hankoBytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value.slice(2), 'hex'));

const deltaWire = (value: Delta): RscoreWireValue[] => [
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

const lockWire = (value: HtlcLock): RscoreWireValue[] => [
  value.lockId,
  bytes(value.hashlock),
  value.timelock.toString(),
  value.revealBeforeHeight,
  value.amount.toString(),
  value.tokenId,
  value.senderIsLeft ? 0 : 1,
  value.createdHeight,
  value.createdTimestamp,
  value.envelopeHash === undefined ? null : bytes(value.envelopeHash),
];

const offerWire = (value: SwapOffer): RscoreWireValue[] => [
  value.offerId,
  value.giveTokenId,
  value.giveTokenDecimals,
  value.giveAmount.toString(),
  value.wantTokenId,
  value.wantTokenDecimals,
  value.wantAmount.toString(),
  value.maxFee.toString(),
  value.minNetReceive.toString(),
  value.priceTicks?.toString() ?? failTest('offer price'),
  value.timeInForce ?? null,
  value.makerIsLeft ? 0 : 1,
  value.createdHeight,
  value.quantizedGive?.toString() ?? failTest('offer quantized give'),
  value.quantizedWant?.toString() ?? failTest('offer quantized want'),
];

const policySnapshotWire = (
  value: NonNullable<BilateralRebalanceFeePolicy['left']> | undefined,
): RscoreWireValue => value === undefined ? null : [
  value.policyVersion,
  value.baseFee.toString(),
  value.liquidityFeeBps.toString(),
  value.gasFee.toString(),
  value.updatedAt,
];

const frameWire = (frame: AccountFrame): RscoreWireValue[] => [
  frame.height,
  frame.timestamp,
  frame.jHeight,
  frame.accountTxs.map(tx => accountTxWire(tx) ?? failTest(`tx:${tx.type}`)),
  frame.prevFrameHash,
  bytes(frame.accountStateRoot),
  frame.byLeft,
  frame.deltas.map(deltaWire),
];

const failTest = (field: string): never => {
  throw new Error(`TEST_FIXTURE_${field}`);
};

const empty = <K extends number | string, V>(
  namespace: Parameters<typeof PersistentAccountStateMap.empty<K, V>>[0],
): PersistentAccountStateMap<K, V> => PersistentAccountStateMap.empty<K, V>(namespace);

const emptyState = (): AccountState => {
  const accumulator = createEmptyAccountJClaimAccumulator();
  return {
    leftEntity: OWNER,
    rightEntity: PEER,
    domain: { chainId: 1, depositoryAddress: DEPOSITORY },
    watchSeed: WATCH_SEED,
    deltas: empty('deltas'),
    locks: empty('locks'),
    swapOffers: empty('swapOffers'),
    pulls: empty('pulls'),
    subcontracts: empty('subcontracts'),
    lendingIntents: empty('lendingIntents'),
    leftPendingJClaims: accumulator,
    rightPendingJClaims: accumulator,
    lastFinalizedJHeight: 0,
    disputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 120 },
    jNonce: 0,
    requestedRebalance: empty('requestedRebalance'),
    requestedRebalanceFeeState: empty('requestedRebalanceFeeState'),
    rebalanceFeePolicies: empty('rebalanceFeePolicies'),
  };
};

const replica = (state: AccountState = emptyState()): AccountReplica => {
  const accountStateRoot = computeAccountStateRoot(state);
  return {
    state,
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      accountStateRoot,
      stateHash: '',
      byLeft: true,
      deltas: [],
    },
    currentHeight: 0,
    rollbackCount: 0,
    proofHeader: { fromEntity: OWNER, toEntity: PEER, nextProofNonce: 1 },
    pendingWithdrawals: empty('pendingWithdrawals'),
    shadow: {
      rebalance: {
        policy: empty('rebalanceShadowPolicy'),
        submittedAtByToken: empty('rebalanceShadowSubmitted'),
      },
    },
  };
};

const ackWire = (
  height: number,
  frameHash: string,
  frameHanko: string,
  dispute?: AccountDisputeHanko,
): RscoreWireValue[] => [
  height,
  bytes(frameHash),
  hankoBytes(frameHanko),
  dispute === undefined ? null : [
    bytes(dispute.hash),
    bytes(dispute.proofBodyHash),
    dispute.proofNonce,
    dispute.proposerIsLeft,
  ],
];

const consensusWire = (account: AccountReplica, localCommittedHanko?: string): RscoreWireValue[] => {
  const pending = account.pendingFrame;
  const pendingInput = account.pendingAccountInput;
  const bundledAck = pendingInput?.kind === 'frame_ack' ? pendingInput.ack : undefined;
  const lastAck = account.lastOutboundFrameAck?.response.ack;
  const localDraft = account.currentDisputeHash === undefined
    || account.currentDisputeProofBodyHash === undefined
    || account.currentDisputeProofNonce === undefined
    ? null
    : [
        bytes(account.currentDisputeHash),
        bytes(account.currentDisputeProofBodyHash),
        account.currentDisputeProofNonce,
        account.currentDisputeProofProposerIsLeft === true,
      ];
  return [
    account.mempool.map(tx => accountTxWire(tx) ?? failTest(`mempool:${tx.type}`)),
    account.currentHeight === 0
      ? null
      : [frameWire(account.currentFrame), bytes(account.currentFrame.stateHash)],
    pending === undefined
      ? null
      : [
          frameWire(pending),
          bytes(pending.stateHash),
          hankoBytes(account.currentFrameHanko ?? failTest('pending hanko')),
          bundledAck === undefined
            ? null
            : ackWire(
                bundledAck.height,
                bundledAck.frameHash,
                bundledAck.frameHanko ?? failTest('bundled ack hanko'),
                bundledAck.disputeHanko,
              ),
          pendingInput?.proposal.disputeHanko === undefined
            ? null
            : [
                bytes(pendingInput.proposal.disputeHanko.hash),
                bytes(pendingInput.proposal.disputeHanko.proofBodyHash),
                pendingInput.proposal.disputeHanko.proofNonce,
                pendingInput.proposal.disputeHanko.proposerIsLeft,
              ],
        ],
    account.rollbackCount,
    account.lastRollbackFrameHash === undefined ? null : bytes(account.lastRollbackFrameHash),
    account.counterpartyFrameHanko === undefined ? null : hankoBytes(account.counterpartyFrameHanko),
    account.currentHeight === 0
      ? null
      : hankoBytes(localCommittedHanko ?? account.currentFrameHanko ?? failTest('local committed hanko')),
    lastAck === undefined
      ? null
      : ackWire(
          lastAck.height,
          lastAck.frameHash,
          lastAck.frameHanko ?? failTest('last ack hanko'),
          lastAck.disputeHanko,
        ),
    localDraft,
    account.proofHeader.nextProofNonce,
    null,
  ];
};

const restoreWire = (
  account: AccountReplica,
  consensus: RscoreWireValue[] = consensusWire(account),
): RscoreWireValue[] => {
  const state = account.state;
  const root = <K extends number | string, V>(
    namespace: Parameters<typeof PersistentAccountStateMap.empty<K, V>>[0],
    value: AccountState[K extends never ? never : keyof AccountState] | undefined,
  ): string => {
    void namespace;
    return (value as PersistentAccountStateMap<K, V> | undefined)?.rootHash() ?? EMPTY_ACCOUNT_STATE_ROOT;
  };
  return [
    bytes(PEER),
    bytes(computeEntityAccountValueHash(account)),
    [
      bytes(OWNER),
      SIGNER,
      [1, bytes(DEPOSITORY), bytes(OWNER), bytes(PEER), bytes(WATCH_SEED)],
      [60, 120],
      state.jNonce,
      state.lastFinalizedJHeight,
      [
        bytes(root('pulls', state.pulls)),
        bytes(root('subcontracts', state.subcontracts)),
        bytes(root('requestedRebalance', state.requestedRebalance)),
        bytes(root('requestedRebalanceFeeState', state.requestedRebalanceFeeState)),
        [bytes(state.leftPendingJClaims.root), state.leftPendingJClaims.count],
        [bytes(state.rightPendingJClaims.root), state.rightPendingJClaims.count],
      ],
      accountEnvelopeWire(account),
      null,
    ],
    [...state.deltas.values()].map(deltaWire),
    [...state.locks.values()].map(lockWire),
    [...(state.lendingIntents ?? new Map()).entries()].map(([key, kind]) => [
      key,
      ['fund', 'borrow', 'repay', 'credit-grant', 'credit-revoke', 'close-request', 'close-payout'].indexOf(kind),
    ]),
    [...state.swapOffers.values()].map(offerWire),
    [...(state.rebalanceFeePolicies ?? new Map()).entries()].map(([tokenId, policy]) => [
      tokenId,
      [policySnapshotWire(policy.left), policySnapshotWire(policy.right)],
    ]),
    consensus,
  ];
};

const checkpointRow = (wire: RscoreWireValue[]): RscoreAccountCheckpointRow => {
  const decoded = decodeRscoreAccountRestoreRow(wire);
  const descriptor = { root: EMPTY_ACCOUNT_STATE_ROOT, leafCount: 0 };
  const changes = { puts: [], dels: [] };
  return {
    accountId: decoded.accountId,
    entityAccountLeaf: decoded.entityAccountLeaf,
    header: wire[2] as readonly RscoreWireValue[],
    sections: {
      deltas: descriptor,
      locks: descriptor,
      lendingIntents: descriptor,
      swapOffers: descriptor,
      rebalanceFeePolicies: descriptor,
    },
    nodeChanges: {
      deltas: changes,
      locks: changes,
      lendingIntents: changes,
      swapOffers: changes,
      rebalanceFeePolicies: changes,
    },
    consensus: wire[8] as readonly RscoreWireValue[],
    decoded,
    wire: [],
  };
};

const nonemptyState = (): AccountState => {
  const state = emptyState();
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
  return {
    ...state,
    deltas: PersistentAccountStateMap.fromEntries('deltas', [[1, delta]]),
    locks: PersistentAccountStateMap.fromEntries('locks', [[lock.lockId, lock]]),
    lendingIntents: PersistentAccountStateMap.fromEntries('lendingIntents', [['intent-1', 'fund']]),
    swapOffers: PersistentAccountStateMap.fromEntries('swapOffers', [[offer.offerId, offer]]),
    rebalanceFeePolicies: PersistentAccountStateMap.fromEntries('rebalanceFeePolicies', [[1, policy]]),
  };
};

const pendingDisputeReplica = (
  frameHanko: string,
  disputeHanko: string,
): Readonly<{ account: AccountReplica; frame: AccountFrame; dispute: AccountDisputeHanko }> => {
  const account = replica();
  const frame: AccountFrame = {
    height: 1,
    timestamp: 100,
    jHeight: 1,
    accountTxs: [],
    prevFrameHash: 'genesis',
    accountStateRoot: computeAccountStateRoot(account.state),
    stateHash: '',
    byLeft: true,
    deltas: [],
  };
  frame.stateHash = computeFrameHash(frame);
  const proofBodyHash = `0x${'77'.repeat(32)}`;
  const dispute: AccountDisputeHanko = {
    hanko: disputeHanko,
    hash: createDisputeProofHashWithNonce(
      account.state,
      proofBodyHash,
      account.state.domain,
      1,
      true,
    ),
    proofBodyHash,
    proofNonce: 1,
    proposerIsLeft: true,
  };
  account.pendingFrame = frame;
  account.pendingAccountInput = {
    kind: 'frame',
    fromEntityId: OWNER,
    toEntityId: PEER,
    domain: { ...account.state.domain },
    disputeConfig: { ...account.state.disputeConfig },
    watchSeed: account.state.watchSeed,
    proposal: { frame, frameHanko, disputeHanko: dispute },
  };
  account.currentFrameHanko = frameHanko;
  account.currentDisputeHash = dispute.hash;
  account.currentDisputeProofBodyHash = dispute.proofBodyHash;
  account.currentDisputeProofNonce = dispute.proofNonce;
  account.currentDisputeProofProposerIsLeft = dispute.proposerIsLeft;
  account.currentDisputeProofHanko = disputeHanko;
  account.proofHeader.nextProofNonce = 2;
  return { account, frame, dispute };
};

describe('rscore Account materializer', () => {
  test('materializes canonical H0 without executing the TypeScript Account machine', () => {
    const target = replica();
    const { account: result, hashesToSign } = materializeRscoreAccountReplica(
      binding,
      PEER,
      checkpointRow(restoreWire(target)),
      null,
      noFreshWitnesses,
    );
    expect(hashesToSign).toEqual([]);
    expect(result).toEqual(target);
    expect(computeAccountStateRoot(result.state)).toBe(computeAccountStateRoot(target.state));
    expect(computeEntityAccountValueHash(result)).toBe(computeEntityAccountValueHash(target));
  });

  test('replaces all five Rust maps and restores pending/ACK/Hanko/rollback consensus', () => {
    const state = nonemptyState();
    const target = replica(state);
    const current: AccountFrame = {
      height: 1,
      timestamp: 100,
      jHeight: 1,
      accountTxs: [],
      prevFrameHash: 'genesis',
      accountStateRoot: computeAccountStateRoot(state),
      stateHash: '',
      byLeft: true,
      deltas: [...state.deltas.values()],
    };
    current.stateHash = computeFrameHash(current);
    const pending: AccountFrame = {
      ...current,
      height: 2,
      timestamp: 101,
      prevFrameHash: current.stateHash,
      stateHash: '',
    };
    pending.stateHash = computeFrameHash(pending);
    const pendingHanko = '0x010203';
    const committedHanko = '0x040506';
    const peerHanko = '0x070809';
    const ackHanko = '0x0a0b0c';
    target.currentFrame = current;
    target.currentHeight = 1;
    target.pendingFrame = pending;
    target.currentFrameHanko = pendingHanko;
    target.counterpartyFrameHanko = peerHanko;
    target.rollbackCount = 2;
    target.lastRollbackFrameHash = `0x${'99'.repeat(32)}`;
    target.mempool = [{ type: 'add_delta', data: { tokenId: 3 } }];
    target.pendingAccountInput = {
      kind: 'frame_ack',
      fromEntityId: OWNER,
      toEntityId: PEER,
      domain: { ...state.domain },
      disputeConfig: { ...state.disputeConfig },
      watchSeed: state.watchSeed,
      ack: { height: 1, frameHash: current.stateHash, frameHanko: ackHanko },
      proposal: { frame: pending, frameHanko: pendingHanko },
    };
    target.lastOutboundFrameAck = {
      height: 1,
      counterpartyEntityId: PEER,
      response: {
        kind: 'ack',
        fromEntityId: OWNER,
        toEntityId: PEER,
        domain: { ...state.domain },
        disputeConfig: { ...state.disputeConfig },
        watchSeed: state.watchSeed,
        ack: { height: 1, frameHash: current.stateHash, frameHanko: ackHanko },
      },
    };
    const prior = replica(emptyState());
    const before = safeStringify(prior);
    const wire = restoreWire(target, consensusWire(target, committedHanko));
    const witnessPlan: RscoreAccountLocalWitnessPlan = { freshHashesToSign: [
      { hash: current.stateHash, type: 'accountFrame', context: `account:${PEER.slice(-8)}:ack:1` },
      { hash: pending.stateHash, type: 'accountFrame', context: `account:${PEER.slice(-8)}:frame:2` },
    ] };
    const materialized = materializeRscoreAccountReplica(
      binding,
      PEER,
      checkpointRow(wire),
      prior,
      witnessPlan,
    );
    const result = materialized.account;
    expect(materialized.hashesToSign).toEqual(witnessPlan.freshHashesToSign);
    expect(result.state.deltas.get(1)).toEqual(state.deltas.get(1));
    expect(result.state.locks.size).toBe(1);
    expect(result.state.lendingIntents?.get('intent-1')).toBe('fund');
    expect(result.state.swapOffers.get('offer-1')).toEqual(state.swapOffers.get('offer-1'));
    expect(result.state.rebalanceFeePolicies?.get(1)).toEqual(state.rebalanceFeePolicies?.get(1));
    expect(result.pendingFrame).toEqual(pending);
    expect(result.pendingAccountInput?.proposal.frameHanko).toBeUndefined();
    expect(result.pendingAccountInput?.kind === 'frame_ack'
      ? result.pendingAccountInput.ack.frameHanko
      : failTest('pending frame_ack')).toBeUndefined();
    expect(result.lastOutboundFrameAck?.response.ack.frameHanko).toBeUndefined();
    expect(result.currentFrameHanko).toBeUndefined();
    expect(result.counterpartyFrameHanko).toBe(peerHanko);
    expect(result.rollbackCount).toBe(2);
    expect(safeStringify(prior)).toBe(before);

    const committed = PersistentEntityAccountMap.fromMap(
      new Map([[PEER, result]]),
      OWNER,
      computeEntityAccountValueHash,
    );
    const accounts = new EntityAccountCandidateMap(committed);
    const entityState = { entityId: OWNER, accounts } as EntityState;
    const rootBeforeWitness = accounts.rootHash();
    const entityWitness = new Map([
      [current.stateHash, {
        hanko: '0x1111' as const,
        type: 'accountFrame' as const,
        entityHeight: 9,
        createdAt: 9,
      }],
      [pending.stateHash, {
        hanko: '0x2222' as const,
        type: 'accountFrame' as const,
        entityHeight: 9,
        createdAt: 9,
      }],
    ]);
    expect(attachHankoWitnessesToState(entityState, entityWitness, 9, [PEER])).toBe(3);
    const certified = accounts.get(PEER) ?? failTest('certified account');
    expect(certified.lastOutboundFrameAck?.response.ack.frameHanko).toBe('0x1111');
    expect(certified.pendingAccountInput?.proposal.frameHanko).toBe('0x2222');
    expect(certified.currentFrameHanko).toBe('0x2222');
    expect(accounts.rootHash()).toBe(rootBeforeWitness);
  });

  test('root-checks carried bodies and supports non-empty H0 shadow policy only from the Entity shell', () => {
    const policy: RebalancePolicy = {
      r2cRequestSoftLimit: 10n,
      hardLimit: 20n,
      maxAcceptableFee: 1n,
    };
    const target = replica();
    target.shadow.rebalance.policy = PersistentAccountStateMap.fromEntries(
      'rebalanceShadowPolicy',
      [[1, policy]],
    );
    const row = checkpointRow(restoreWire(target));
    expect(materializeRscoreAccountReplica(
      binding,
      PEER,
      row,
      target,
      noFreshWitnesses,
    ).account.shadow.rebalance.policy.get(1))
      .toEqual(policy);
    expect(() => materializeRscoreAccountReplica(binding, PEER, row, null, noFreshWitnesses))
      .toThrow('RSCORE_MATERIALIZE_CREATE_REBALANCE_POLICY_ABI_INCOMPLETE');

    const stale = replica();
    stale.state.requestedRebalance = PersistentAccountStateMap.fromEntries(
      'requestedRebalance',
      [[1, 5n]],
    );
    expect(() => materializeRscoreAccountReplica(
      binding,
      PEER,
      checkpointRow(restoreWire(replica())),
      stale,
      noFreshWitnesses,
    ))
      .toThrow('RSCORE_MATERIALIZE_REQUESTED_REBALANCE_ROOT_MISMATCH');
  });

  test('fails loud on signer and leaf bindings', () => {
    const base = replica();
    const row = checkpointRow(restoreWire(base));
    expect(() => materializeRscoreAccountReplica(
      { ...binding, expectedSignerId: 'other' },
      PEER,
      row,
      null,
      noFreshWitnesses,
    ))
      .toThrow('RSCORE_MATERIALIZE_SIGNER_BINDING_MISMATCH');
    expect(() => materializeRscoreAccountReplica(
      binding,
      PEER,
      { ...row, entityAccountLeaf: `0x${'ff'.repeat(32)}` },
      null,
      noFreshWitnesses,
    ))
      .toThrow('RSCORE_MATERIALIZE_LEAF_BINDING_MISMATCH');

  });

  test('keeps fresh Rust local frame/dispute drafts unsigned until Entity quorum attaches witnesses', () => {
    const { account: rust, frame, dispute } = pendingDisputeReplica('0xf0f0', '0xf1f1');
    const row = checkpointRow(restoreWire(rust));
    expect(() => materializeRscoreAccountReplica(
      binding,
      PEER,
      row,
      null,
      noFreshWitnesses,
    )).toThrow('RSCORE_MATERIALIZE_LOCAL_WITNESS_PLAN_INCOMPLETE');
    expect(() => materializeRscoreAccountReplica(binding, PEER, row, null, {
      freshHashesToSign: [{
        hash: frame.stateHash,
        type: 'dispute',
        context: `account:${PEER.slice(-8)}:frame:1`,
      }],
    })).toThrow('RSCORE_MATERIALIZE_LOCAL_WITNESS_PLAN_TYPE_MISMATCH');
    expect(() => materializeRscoreAccountReplica(binding, PEER, row, null, {
      freshHashesToSign: [{
        hash: frame.stateHash,
        type: 'accountFrame',
        context: `account:${PEER.slice(-8)}:ack:1`,
      }],
    })).toThrow('RSCORE_MATERIALIZE_LOCAL_WITNESS_PLAN_CONTEXT_MISMATCH');
    const pending = row.decoded.consensus.pending ?? failTest('decoded pending');
    expect(() => materializeRscoreAccountReplica(binding, PEER, {
      ...row,
      decoded: {
        ...row.decoded,
        consensus: {
          ...row.decoded.consensus,
          pending: {
            ...pending,
            frame: { ...pending.frame, byLeft: false },
          },
        },
      },
    }, null, noFreshWitnesses)).toThrow('RSCORE_MATERIALIZE_PENDING_AUTHOR_MISMATCH');

    const plan: RscoreAccountLocalWitnessPlan = { freshHashesToSign: [
      { hash: frame.stateHash, type: 'accountFrame', context: `account:${PEER.slice(-8)}:frame:1` },
      { hash: dispute.hash, type: 'dispute', context: `account:${PEER.slice(-8)}:dispute` },
    ] };
    const materialized = materializeRscoreAccountReplica(binding, PEER, row, null, plan);
    expect(materialized.hashesToSign).toEqual(plan.freshHashesToSign);
    expect(materialized.account.currentFrameHanko).toBeUndefined();
    expect(materialized.account.currentDisputeProofHanko).toBeUndefined();
    expect(materialized.account.pendingAccountInput?.proposal.frameHanko).toBeUndefined();
    expect(materialized.account.pendingAccountInput?.proposal.disputeHanko?.hanko).toBeUndefined();

    const committed = PersistentEntityAccountMap.fromMap(
      new Map([[PEER, materialized.account]]),
      OWNER,
      computeEntityAccountValueHash,
    );
    const accounts = new EntityAccountCandidateMap(committed);
    const state = { entityId: OWNER, accounts } as EntityState;
    const rootBeforeWitness = accounts.rootHash();
    expect(attachHankoWitnessesToState(state, new Map([
      [frame.stateHash, {
        hanko: '0xa1a1' as const,
        type: 'accountFrame' as const,
        entityHeight: 10,
        createdAt: 10,
      }],
      [dispute.hash, {
        hanko: '0xb2b2' as const,
        type: 'dispute' as const,
        entityHeight: 10,
        createdAt: 10,
      }],
    ]), 10, [PEER])).toBe(2);
    const certified = accounts.get(PEER) ?? failTest('fresh certified account');
    expect(certified.currentFrameHanko).toBe('0xa1a1');
    expect(certified.currentDisputeProofHanko).toBe('0xb2b2');
    expect(certified.pendingAccountInput?.proposal.frameHanko).toBe('0xa1a1');
    expect(certified.pendingAccountInput?.proposal.disputeHanko?.hanko).toBe('0xb2b2');
    expect(accounts.rootHash()).toBe(rootBeforeWitness);
  });

  test('ignores Rust local Hankos and reuses only an exact prior certified tuple', () => {
    const certified = pendingDisputeReplica('0xc1c1', '0xd2d2').account;
    const rust = pendingDisputeReplica('0xffff', '0xeeee').account;
    const materialized = materializeRscoreAccountReplica(
      binding,
      PEER,
      checkpointRow(restoreWire(rust)),
      certified,
      noFreshWitnesses,
    );
    expect(materialized.hashesToSign).toEqual([]);
    expect(materialized.account.currentFrameHanko).toBe('0xc1c1');
    expect(materialized.account.currentDisputeProofHanko).toBe('0xd2d2');
    expect(materialized.account.pendingAccountInput?.proposal.frameHanko).toBe('0xc1c1');
    expect(materialized.account.pendingAccountInput?.proposal.disputeHanko?.hanko).toBe('0xd2d2');
  });
});
