import { describe, expect, test } from 'bun:test';

import {
  ONCHAIN_HANKO_GOLDEN_ACTION_CANCEL_RECEIPT,
  ONCHAIN_HANKO_GOLDEN_ACTION_RECEIPT,
  ONCHAIN_HANKO_GOLDEN_HASHES,
  ONCHAIN_HANKO_GOLDEN_PAYLOADS,
} from '../../tests/fixtures/onchain-hanko-golden';

import { computeBatchHankoHash } from '../jurisdiction/batch';
import {
  createCooperativeDisputeProofHash,
  createDisputeProofHash,
  createSettlementHashWithNonce,
} from '../protocol/dispute/proof-builder';
import { computeWatchtowerCounterDisputeAuthorizationHash } from '../recovery/crypto';
import {
  ENTITY_PROVIDER_ACTION_CANCELLED_EVENT,
  ENTITY_PROVIDER_ACTION_CANCELLED_TOPIC,
  ENTITY_PROVIDER_ACTION_EXECUTED_EVENT,
  ENTITY_PROVIDER_ACTION_EXECUTED_TOPIC,
  ENTITY_PROVIDER_ACTION_KIND,
  encodeBoardProposalCancelHankoPayload,
  encodeBoardProposalHankoPayload,
  encodeCooperativeDisputeProofHankoPayload,
  encodeCancelEntityProviderActionHankoPayload,
  encodeCooperativeUpdateHankoPayload,
  encodeDepositoryBatchHankoPayload,
  encodeDisputeProofHankoPayload,
  encodeEntityTransferHankoPayload,
  encodeFinalDisputeProofHankoPayload,
  encodeReleaseControlSharesHankoPayload,
  encodeWatchtowerCounterDisputeHankoPayload,
  hashEntityTransferHankoPayload,
  hashBoardProposalCancelHankoPayload,
  hashBoardProposalHankoPayload,
  hashCancelEntityProviderActionHankoPayload,
  hashFinalDisputeProofHankoPayload,
  hashReleaseControlSharesHankoPayload,
} from '../hanko/onchain-domain';

const CHAIN_ID = 8453;
const DEPOSITORY = '0x1111111111111111111111111111111111111111';
const ENTITY_PROVIDER = '0x6666666666666666666666666666666666666666';
const BOARD_EPOCH = 11;
const TOWER = '0x2222222222222222222222222222222222222222';
const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const WATCH_SEED = `0x${'33'.repeat(32)}`;
const PROOF_BODY_HASH = `0x${'44'.repeat(32)}`;
const STARTER_ARGUMENTS_HASH = `0x${'55'.repeat(32)}`;
const DOMAIN = { chainId: CHAIN_ID, depositoryAddress: DEPOSITORY } as const;
const ENTITY_PROVIDER_DOMAIN = {
  chainId: CHAIN_ID,
  entityProviderAddress: ENTITY_PROVIDER,
  boardEpoch: BOARD_EPOCH,
} as const;
const ACCOUNT_KEY = `${LEFT}${RIGHT.slice(2)}`;
const ACCOUNT = {
  leftEntity: LEFT,
  rightEntity: RIGHT,
  proofHeader: { nextProofNonce: 7 },
  watchSeed: WATCH_SEED,
};
const DIFFS = [{
  tokenId: 9,
  leftDiff: -7n,
  rightDiff: 2n,
  collateralDiff: 5n,
  ondeltaDiff: -3n,
}];

const GOLDEN_PAYLOADS = ONCHAIN_HANKO_GOLDEN_PAYLOADS;

describe('on-chain Hanko domain golden vectors', () => {
  test('pins exact bytes for active payloads and the reserved FinalDisputeProof vector', () => {
    expect({
      settlement: encodeCooperativeUpdateHankoPayload(DOMAIN, ACCOUNT_KEY, 7, DIFFS, [12]),
      dispute: encodeDisputeProofHankoPayload(DOMAIN, ACCOUNT_KEY, 7, PROOF_BODY_HASH, WATCH_SEED),
      final: encodeFinalDisputeProofHankoPayload(DOMAIN, ACCOUNT_KEY, 7),
      cooperative: encodeCooperativeDisputeProofHankoPayload(
        DOMAIN,
        ACCOUNT_KEY,
        7,
        PROOF_BODY_HASH,
        STARTER_ARGUMENTS_HASH,
      ),
      batch: encodeDepositoryBatchHankoPayload(DOMAIN, '0x1234abcd', 8),
      watchtower: encodeWatchtowerCounterDisputeHankoPayload(DOMAIN, {
        towerAddress: TOWER,
        entityId: LEFT,
        counterentity: RIGHT,
        finalNonce: 9,
        finalProofbodyHash: PROOF_BODY_HASH,
        lastResortWindowBlocks: 16,
        appointmentSequence: 3,
      }),
      entityTransfer: encodeEntityTransferHankoPayload(ENTITY_PROVIDER_DOMAIN, {
        entityNumber: 42,
        to: TOWER,
        tokenId: 9,
        amount: 123,
        actionNonce: 4,
      }),
      releaseControlShares: encodeReleaseControlSharesHankoPayload(ENTITY_PROVIDER_DOMAIN, {
        entityNumber: 42,
        depositoryAddress: DEPOSITORY,
        controlAmount: 100,
        dividendAmount: 200,
        purpose: 'Series A',
        actionNonce: 5,
      }),
      cancelEntityProviderAction: encodeCancelEntityProviderActionHankoPayload(
        ENTITY_PROVIDER_DOMAIN,
        {
          entityNumber: 42,
          actionNonce: 6,
          cancelledActionHash: `0x${'77'.repeat(32)}`,
          cancelledActionKind: 0,
        },
      ),
      boardProposal: encodeBoardProposalHankoPayload(ENTITY_PROVIDER_DOMAIN, {
        entityId: LEFT,
        newBoardHash: `0x${'88'.repeat(32)}`,
        authority: 1,
        actionNonce: 7,
      }),
      boardProposalCancel: encodeBoardProposalCancelHankoPayload(ENTITY_PROVIDER_DOMAIN, {
        entityId: LEFT,
        proposedBoardHash: `0x${'88'.repeat(32)}`,
        proposedBy: 3,
        cancelledBy: 2,
        actionNonce: 7,
      }),
    }).toEqual(GOLDEN_PAYLOADS);
  });

  test('pins active Account hashes and the reserved FinalDisputeProof slot', () => {
    expect(createSettlementHashWithNonce(ACCOUNT, DIFFS, [12], DOMAIN, 7)).toBe(
      ONCHAIN_HANKO_GOLDEN_HASHES.settlement,
    );
    expect(createDisputeProofHash(ACCOUNT, PROOF_BODY_HASH, DOMAIN)).toBe(
      ONCHAIN_HANKO_GOLDEN_HASHES.dispute,
    );
    expect(hashFinalDisputeProofHankoPayload(DOMAIN, ACCOUNT_KEY, 7)).toBe(
      ONCHAIN_HANKO_GOLDEN_HASHES.final,
    );
    expect(createCooperativeDisputeProofHash(
      ACCOUNT,
      PROOF_BODY_HASH,
      STARTER_ARGUMENTS_HASH,
      DOMAIN,
      7,
    )).toBe(ONCHAIN_HANKO_GOLDEN_HASHES.cooperative);
  });

  test('pins Depository batch and watchtower Hanko payloads', () => {
    expect(computeBatchHankoHash(8453n, DEPOSITORY, '0x1234abcd', 8n)).toBe(
      ONCHAIN_HANKO_GOLDEN_HASHES.batch,
    );
    expect(computeWatchtowerCounterDisputeAuthorizationHash(
      CHAIN_ID,
      DEPOSITORY,
      TOWER,
      LEFT,
      RIGHT,
      9,
      PROOF_BODY_HASH,
      16,
      3,
    )).toBe(ONCHAIN_HANKO_GOLDEN_HASHES.watchtower);
  });

  test('pins every EntityProvider Hanko payload', () => {
    expect(hashEntityTransferHankoPayload(ENTITY_PROVIDER_DOMAIN, {
      entityNumber: 42,
      to: TOWER,
      tokenId: 9,
      amount: 123,
      actionNonce: 4,
    })).toBe(ONCHAIN_HANKO_GOLDEN_HASHES.entityTransfer);
    expect(hashReleaseControlSharesHankoPayload(ENTITY_PROVIDER_DOMAIN, {
      entityNumber: 42,
      depositoryAddress: DEPOSITORY,
      controlAmount: 100,
      dividendAmount: 200,
      purpose: 'Series A',
      actionNonce: 5,
    })).toBe(ONCHAIN_HANKO_GOLDEN_HASHES.releaseControlShares);
    expect(hashCancelEntityProviderActionHankoPayload(ENTITY_PROVIDER_DOMAIN, {
      entityNumber: 42,
      actionNonce: 6,
      cancelledActionHash: `0x${'77'.repeat(32)}`,
      cancelledActionKind: 0,
    })).toBe(ONCHAIN_HANKO_GOLDEN_HASHES.cancelEntityProviderAction);
    expect(hashBoardProposalHankoPayload(ENTITY_PROVIDER_DOMAIN, {
      entityId: LEFT,
      newBoardHash: `0x${'88'.repeat(32)}`,
      authority: 1,
      actionNonce: 7,
    })).toBe(ONCHAIN_HANKO_GOLDEN_HASHES.boardProposal);
    expect(hashBoardProposalCancelHankoPayload(ENTITY_PROVIDER_DOMAIN, {
      entityId: LEFT,
      proposedBoardHash: `0x${'88'.repeat(32)}`,
      proposedBy: 3,
      cancelledBy: 2,
      actionNonce: 7,
    })).toBe(ONCHAIN_HANKO_GOLDEN_HASHES.boardProposalCancel);
  });

  test('pins the exact EntityProvider action receipt identity', () => {
    expect(ENTITY_PROVIDER_ACTION_EXECUTED_EVENT).toBe(ONCHAIN_HANKO_GOLDEN_ACTION_RECEIPT.signature);
    expect(ENTITY_PROVIDER_ACTION_EXECUTED_TOPIC).toBe(ONCHAIN_HANKO_GOLDEN_ACTION_RECEIPT.topic);
    expect(ENTITY_PROVIDER_ACTION_KIND).toEqual(ONCHAIN_HANKO_GOLDEN_ACTION_RECEIPT.kinds);
    expect(ENTITY_PROVIDER_ACTION_CANCELLED_EVENT)
      .toBe(ONCHAIN_HANKO_GOLDEN_ACTION_CANCEL_RECEIPT.signature);
    expect(ENTITY_PROVIDER_ACTION_CANCELLED_TOPIC)
      .toBe(ONCHAIN_HANKO_GOLDEN_ACTION_CANCEL_RECEIPT.topic);
  });

  test('rejects an empty cancellation target before signing', () => {
    expect(() => encodeCancelEntityProviderActionHankoPayload(ENTITY_PROVIDER_DOMAIN, {
      entityNumber: 42,
      actionNonce: 6,
      cancelledActionHash: `0x${'00'.repeat(32)}`,
      cancelledActionKind: 0,
    })).toThrow('INVALID_HANKO_CANCELLED_ACTION_HASH');
  });

  test('same Depository address and payload produce different account hashes across chains', () => {
    const otherDomain = { ...DOMAIN, chainId: 1 };
    expect(createSettlementHashWithNonce(ACCOUNT, DIFFS, [12], otherDomain, 7)).not.toBe(
      createSettlementHashWithNonce(ACCOUNT, DIFFS, [12], DOMAIN, 7),
    );
    expect(createDisputeProofHash(ACCOUNT, PROOF_BODY_HASH, otherDomain)).not.toBe(
      createDisputeProofHash(ACCOUNT, PROOF_BODY_HASH, DOMAIN),
    );
    expect(hashEntityTransferHankoPayload(
      { ...ENTITY_PROVIDER_DOMAIN, chainId: 1 },
      { entityNumber: 42, to: TOWER, tokenId: 9, amount: 123, actionNonce: 4 },
    )).not.toBe(hashEntityTransferHankoPayload(
      ENTITY_PROVIDER_DOMAIN,
      { entityNumber: 42, to: TOWER, tokenId: 9, amount: 123, actionNonce: 4 },
    ));
  });

  test('same EntityProvider action cannot replay across board epochs', () => {
    const authorization = {
      entityNumber: 42,
      to: TOWER,
      tokenId: 9,
      amount: 123,
      actionNonce: 4,
    } as const;
    expect(hashEntityTransferHankoPayload(
      { ...ENTITY_PROVIDER_DOMAIN, boardEpoch: BOARD_EPOCH + 1 },
      authorization,
    )).not.toBe(hashEntityTransferHankoPayload(ENTITY_PROVIDER_DOMAIN, authorization));
  });
});
