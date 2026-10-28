import parityVectors from '../../../../rscore/fixtures/cross-j-absolute-deadline.json';
import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import type { DeltaTransformer } from '../../../../jurisdictions/typechain-types/DeltaTransformer.sol/DeltaTransformer';

import {
  resolveFinalizedCrossJurisdictionRouteLeg,
  resolveFinalizedPullFillRatio,
} from '../../../account/pull-registry-settlement';
import { BATCH_ABI, type ProofBodyStruct } from '../../../protocol/dispute/proof-body';
import { encodeInt512, encodeSignedAmount } from '../../../protocol/crypto/abi-money';
import type { CrossJurisdictionPullLeg } from '../../../types/cross-jurisdiction';
import { addr, entity, makeAccount, secret } from '../../helpers/cross-j';

const left = entity('11');
const right = entity('22');
const jurisdiction = { chainId: 1, depositoryAddress: addr('31') };
const deltaTransformerAddress = `0x${'44'.repeat(20)}`;
const pull: CrossJurisdictionPullLeg = {
  pullId: 'target-pull',
  deadline: 120,
  tokenId: 1,
  amount: 100n,
  signedAmount: 100n,
  fullHash: secret('41'),
  partialRoot: secret('42'),
};

const proofbody = (claimedRatio: number, targetRole = true, signedAmount = pull.signedAmount, deadline = pull.deadline): ProofBodyStruct => ({
  watchSeed: secret('43'),
  leftResponseSeconds: 10,
  rightResponseSeconds: 20,
  offdeltas: [encodeInt512(0n)],
  tokenIds: [1n],
  transformers: [{
    transformerAddress: deltaTransformerAddress,
    encodedBatch: ethers.AbiCoder.defaultAbiCoder().encode(
      [ethers.ParamType.from(BATCH_ABI)],
      [{
        payment: [],
        swap: [],
        loans: [],
        pull: [{
          deltaIndex: 0,
          amount: encodeSignedAmount(signedAmount),
          claimedRatio,
          deadline,
          fullHash: pull.fullHash,
          partialRoot: pull.partialRoot,
          targetRole,
        }],
      } satisfies DeltaTransformer.BatchStruct],
    ),
    allowances: [],
  }],
});

const activeAccount = () => {
  const account = makeAccount(left, right, jurisdiction);
  account.activeDispute = {
    startedByLeft: true,
    initialProofbodyHash: secret('45'),
    initialNonce: 1,
    initialProposerIsLeft: true,
    disputeStartTimestamp: 100,
    disputeTimeout: 130,
    jNonce: 1,
    starterInitialArguments: '0x',
    starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
    observedOnChain: true,
  };
  return account;
};

describe('finalized Pull registry settlement parity', () => {
  test('changing only a Pull deadline changes signed bytes and rejects substitution', () => {
    const original = proofbody(0);
    const changed = proofbody(0, true, pull.signedAmount, pull.deadline + 1);
    expect(ethers.keccak256(original.transformers[0]!.encodedBatch))
      .not.toBe(ethers.keccak256(changed.transformers[0]!.encodedBatch));
    expect(() => resolveFinalizedPullFillRatio({ account: activeAccount(), proofbody: changed,
      canonicalDeltaTransformerAddress: deltaTransformerAddress, expectedPull: pull, targetRole: true,
      record: { fillRatio: 65535, revealedAt: 120 },
    })).toThrow('CROSS_J_FINAL_PULL_MISSING');
  });

  test('shared TS/Rust signed ABI settlement vectors', () => {
    for (const vector of parityVectors) {
      const account = activeAccount();
      account.activeDispute!.disputeStartTimestamp = vector.start;
      account.activeDispute!.disputeTimeout = vector.start + 30;
      const body = proofbody(vector.claimed, vector.targetRole, 100n, vector.deadline);
      expect(body.transformers[0]!.encodedBatch).toBe(vector.encodedBatch);
      expect(resolveFinalizedPullFillRatio({ account, proofbody: body,
        canonicalDeltaTransformerAddress: deltaTransformerAddress,
        expectedPull: { ...pull, deadline: vector.deadline }, targetRole: vector.targetRole,
        record: { fillRatio: vector.ratio, revealedAt: vector.revealedAt },
      })).toBe(vector.expected);
    }
  });

  test('absolute deadlines survive asymmetric starts and pre-dispute publication', () => {
    for (const [targetRole, start, deadline, revealedAt] of [
      [false, 110, 120, 120], [true, 100, 340, 130], [true, 200, 340, 130],
    ] as const) {
      const account = activeAccount();
      account.activeDispute!.disputeStartTimestamp = start;
      account.activeDispute!.disputeTimeout = start + 30;
      expect(resolveFinalizedPullFillRatio({ account,
        proofbody: proofbody(0, targetRole, pull.signedAmount, deadline),
        canonicalDeltaTransformerAddress: deltaTransformerAddress,
        expectedPull: { ...pull, deadline }, targetRole,
        record: { fillRatio: 65535, revealedAt },
      })).toBe(65535);
    }
  });

  test('absolute deadline is inclusive; D+1 is late', () => {
    for (const revealedAt of [120, 121]) expect(resolveFinalizedPullFillRatio({
      account: activeAccount(), proofbody: proofbody(0),
      canonicalDeltaTransformerAddress: deltaTransformerAddress, expectedPull: pull,
      targetRole: true, record: { fillRatio: 65535, revealedAt },
    })).toBe(revealedAt === 120 ? 65535 : 0);
  });

  test('selects the same leg for user and Hub projections without crossing stacks', () => {
    const route = {
      orderId: 'route-projection-parity',
      source: {
        jurisdiction: 'source-stack',
        entityId: 'source-user',
        counterpartyEntityId: 'source-hub',
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: 'target-stack',
        entityId: 'target-hub',
        counterpartyEntityId: 'target-user',
        tokenId: 2,
        amount: 200n,
      },
    };
    for (const [self, counterparty] of [
      ['source-user', 'source-hub'],
      ['source-hub', 'source-user'],
    ]) {
      expect(resolveFinalizedCrossJurisdictionRouteLeg({
        route,
        self: self!,
        counterparty: counterparty!,
        localStack: 'source-stack',
      })).toBe('source');
    }
    for (const [self, counterparty] of [
      ['target-user', 'target-hub'],
      ['target-hub', 'target-user'],
    ]) {
      expect(resolveFinalizedCrossJurisdictionRouteLeg({
        route,
        self: self!,
        counterparty: counterparty!,
        localStack: 'target-stack',
      })).toBe('target');
    }
    expect(() => resolveFinalizedCrossJurisdictionRouteLeg({
      route,
      self: 'source-user',
      counterparty: 'source-hub',
      localStack: 'target-stack',
    })).toThrow('CROSS_J_FINALITY_LEG_MISSING');
  });

  test('accepts pre-dispute evidence and the inclusive absolute deadline', () => {
    for (const [signedAmount, end] of [[100n, 120], [-100n, 120]] as const) {
      for (const revealedAt of [99, 100, end]) {
        expect(resolveFinalizedPullFillRatio({
          account: activeAccount(),
          proofbody: proofbody(0x1000, true, signedAmount),
          canonicalDeltaTransformerAddress: deltaTransformerAddress,
          expectedPull: { ...pull, signedAmount },
          targetRole: true,
          record: { fillRatio: 0x2000, revealedAt },
        })).toBe(0x2000);
      }
      for (const revealedAt of [0, end + 1]) {
        expect(resolveFinalizedPullFillRatio({
          account: activeAccount(),
          proofbody: proofbody(0x1000, true, signedAmount),
          canonicalDeltaTransformerAddress: deltaTransformerAddress,
          expectedPull: { ...pull, signedAmount },
          targetRole: true,
          record: { fillRatio: 0x2000, revealedAt },
        })).toBe(0x1000);
      }
    }
  });

  test('late Target remains stored evidence but settles at signed claimedRatio', () => {
    expect(resolveFinalizedPullFillRatio({
      account: activeAccount(),
      proofbody: proofbody(0x1000),
      canonicalDeltaTransformerAddress: deltaTransformerAddress,
      expectedPull: pull,
      targetRole: true,
      record: { fillRatio: 0x3000, revealedAt: 121 },
    })).toBe(0x1000);
  });

  test('a timely stale record cannot reduce the signed claimedRatio', () => {
    expect(resolveFinalizedPullFillRatio({
      account: activeAccount(),
      proofbody: proofbody(0x3000),
      canonicalDeltaTransformerAddress: deltaTransformerAddress,
      expectedPull: pull,
      targetRole: true,
      record: { fillRatio: 0x2000, revealedAt: 105 },
    })).toBe(0x3000);
  });

  test('role and final ProofBody clock mismatches fail loud', () => {
    expect(() => resolveFinalizedPullFillRatio({
      account: activeAccount(),
      proofbody: proofbody(0x1000, false),
      canonicalDeltaTransformerAddress: deltaTransformerAddress,
      expectedPull: pull,
      targetRole: true,
    })).toThrow('CROSS_J_FINAL_PULL_MISSING');

    const account = activeAccount();
    account.activeDispute!.disputeTimeout = 131;
    expect(() => resolveFinalizedPullFillRatio({
      account,
      proofbody: proofbody(0x1000),
      canonicalDeltaTransformerAddress: deltaTransformerAddress,
      expectedPull: pull,
      targetRole: true,
    })).toThrow('CROSS_J_FINAL_CLOCK_MISMATCH');
  });
});
