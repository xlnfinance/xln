import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import {
  resolveFinalizedCrossJurisdictionRouteLeg,
  resolveFinalizedPullFillRatio,
} from '../../../account/pull-registry-settlement';
import { BATCH_ABI, type ProofBodyStruct } from '../../../protocol/dispute/proof-body';
import type { CrossJurisdictionPullLeg } from '../../../types/cross-jurisdiction';
import { entity, makeAccount, makeJurisdiction, secret } from '../../helpers/cross-j';

const left = entity('11');
const right = entity('22');
const jurisdiction = makeJurisdiction('Ethereum', 1, '31', '32');
const deltaTransformerAddress = `0x${'44'.repeat(20)}`;
const pull: CrossJurisdictionPullLeg = {
  pullId: 'target-pull',
  tokenId: 1,
  amount: 100n,
  signedAmount: 100n,
  fullHash: secret('41'),
  partialRoot: secret('42'),
};

const proofbody = (claimedRatio: number, targetRole = true): ProofBodyStruct => ({
  watchSeed: secret('43'),
  leftResponseSeconds: 10,
  rightResponseSeconds: 20,
  offdeltas: [0n],
  tokenIds: [1n],
  transformers: [{
    transformerAddress: deltaTransformerAddress,
    encodedBatch: ethers.AbiCoder.defaultAbiCoder().encode(
      [ethers.ParamType.from(BATCH_ABI)],
      [{
        payment: [],
        swap: [],
        pull: [{
          deltaIndex: 0,
          amount: pull.signedAmount,
          claimedRatio,
          fullHash: pull.fullHash,
          partialRoot: pull.partialRoot,
          targetRole,
        }],
      }],
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

  test('accepts both inclusive beneficiary-window boundaries', () => {
    for (const revealedAt of [100, 110]) {
      expect(resolveFinalizedPullFillRatio({
        account: activeAccount(),
        proofbody: proofbody(0x1000),
        canonicalDeltaTransformerAddress: deltaTransformerAddress,
        expectedPull: pull,
        targetRole: true,
        record: { fillRatio: 0x2000, revealedAt },
      })).toBe(0x2000);
    }
  });

  test('late Target remains stored evidence but settles at signed claimedRatio', () => {
    expect(resolveFinalizedPullFillRatio({
      account: activeAccount(),
      proofbody: proofbody(0x1000),
      canonicalDeltaTransformerAddress: deltaTransformerAddress,
      expectedPull: pull,
      targetRole: true,
      record: { fillRatio: 0x3000, revealedAt: 111 },
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
