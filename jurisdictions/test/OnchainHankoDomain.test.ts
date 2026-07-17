import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers.js';
import { expect } from 'chai';
import type { ContractTransactionReceipt, LogDescription } from 'ethers';
import hre from 'hardhat';

import {
  ONCHAIN_HANKO_GOLDEN_ACTION_CANCEL_RECEIPT,
  ONCHAIN_HANKO_GOLDEN_ACTION_RECEIPT,
  ONCHAIN_HANKO_GOLDEN_HASHES,
  ONCHAIN_HANKO_GOLDEN_PAYLOADS,
  ONCHAIN_HANKO_VECTOR,
} from '../../tests/fixtures/onchain-hanko-golden.ts';

import {
  BOARD_PROPOSAL_CANCEL_HANKO_DOMAIN,
  BOARD_PROPOSAL_HANKO_DOMAIN,
  DEPOSITORY_BATCH_HANKO_DOMAIN,
  WATCHTOWER_COUNTER_DISPUTE_HANKO_DOMAIN,
  encodeCooperativeDisputeProofHankoPayload,
  encodeBoardProposalCancelHankoPayload,
  encodeBoardProposalHankoPayload,
  encodeCancelEntityProviderActionHankoPayload,
  encodeCooperativeUpdateHankoPayload,
  encodeDepositoryBatchHankoPayload,
  encodeDisputeProofHankoPayload,
  encodeEntityTransferHankoPayload,
  encodeFinalDisputeProofHankoPayload,
  encodeReleaseControlSharesHankoPayload,
  encodeWatchtowerCounterDisputeHankoPayload,
  hashCooperativeDisputeProofHankoPayload,
  hashBoardProposalCancelHankoPayload,
  hashBoardProposalHankoPayload,
  hashCancelEntityProviderActionHankoPayload,
  hashCooperativeUpdateHankoPayload,
  hashDepositoryBatchHankoPayload,
  hashDisputeProofHankoPayload,
  hashEntityTransferHankoPayload,
  hashFinalDisputeProofHankoPayload,
  hashReleaseControlSharesHankoPayload,
  hashWatchtowerCounterDisputeHankoPayload,
} from '../../runtime/hanko/onchain-domain.ts';
import type { EntityProvider } from '../typechain-types/contracts/EntityProvider.ts';
import {
  buildSingleSignerHanko,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  singleSignerLazyEntityId,
} from './helpers/hanko.ts';

const { ethers } = hre;
const BOARD_ABI = [
  'tuple(uint16 votingThreshold, bytes32[] entityIds, uint16[] votingPowers, uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)',
];

const encodeSingleSignerBoard = (signerAddress: string): string =>
  ethers.AbiCoder.defaultAbiCoder().encode(BOARD_ABI, [[
    1,
    [ethers.zeroPadValue(signerAddress, 32)],
    [1],
    0,
    0,
    0,
  ]]);

const entityAddress = (entityNumber: bigint): string =>
  ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 20));

const entityId = (entityNumber: bigint): string =>
  ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32);

const exactActionReceipt = (
  entityProvider: EntityProvider,
  receipt: ContractTransactionReceipt | null,
): LogDescription => {
  const providerAddress = String(entityProvider.target).toLowerCase();
  const actionEvents = (receipt?.logs ?? [])
    .filter((log) => log.address.toLowerCase() === providerAddress)
    .map((log) => {
      const parsed = entityProvider.interface.parseLog(log);
      if (!parsed) throw new Error(`ENTITY_PROVIDER_ACTION_LOG_UNDECODABLE:${log.topics[0] ?? 'missing-topic'}`);
      return parsed;
    })
    .filter((event) => event.name === 'EntityProviderActionExecuted');
  expect(actionEvents).to.have.length(1);
  return actionEvents[0]!;
};

describe('canonical on-chain Hanko domains', function () {
  async function deployFixture() {
    const [admin, entitySigner, recipient] = await ethers.getSigners();
    const entityPrivateKey = deriveHardhatPrivateKey(1);

    const entityProviderFactory = await ethers.getContractFactory('EntityProvider');
    const entityProvider = await entityProviderFactory.deploy(admin.address);
    const otherEntityProvider = await entityProviderFactory.deploy(admin.address);
    await Promise.all([entityProvider.waitForDeployment(), otherEntityProvider.waitForDeployment()]);

    const accountFactory = await ethers.getContractFactory('Account');
    const account = await accountFactory.deploy();
    await account.waitForDeployment();

    const hankoCodecFactory = await ethers.getContractFactory('HankoCodec');
    const hankoCodec = await hankoCodecFactory.deploy();
    await hankoCodec.waitForDeployment();

    const depositoryFactory = await ethers.getContractFactory('Depository', {
      libraries: { Account: await account.getAddress() },
    });
    const depository = await depositoryFactory.deploy(await entityProvider.getAddress());
    await depository.waitForDeployment();

    const encodedBoard = encodeSingleSignerBoard(entitySigner.address);
    const boardHash = ethers.keccak256(encodedBoard);
    await (await entityProvider.registerNumberedEntity(boardHash)).wait();
    await (await otherEntityProvider.registerNumberedEntity(boardHash)).wait();

    return {
      account,
      depository,
      encodedBoard,
      entityNumber: 2n,
      entityPrivateKey,
      entityProvider,
      entitySigner,
      hankoCodec,
      otherEntityProvider,
      recipient,
    };
  }

  it('matches independent fixed bytes and hashes for every Hanko codec', async function () {
    const { hankoCodec } = await loadFixture(deployFixture);
    const vector = ONCHAIN_HANKO_VECTOR;
    const accountKey = `${vector.leftEntity}${vector.rightEntity.slice(2)}`;
    const diffs = vector.diffs.map((diff) => ({ ...diff }));
    const forgiveDebts = [...vector.forgiveDebtsInTokenIds];
    const fixedVectors = [
      {
        bytes: await hankoCodec.encodeCooperativeUpdateHankoPayloadForDomain(
          vector.chainId, vector.depositoryAddress, accountKey, vector.accountNonce, diffs, forgiveDebts,
        ),
        hash: await hankoCodec.computeCooperativeUpdateHankoHashForDomain(
          vector.chainId, vector.depositoryAddress, accountKey, vector.accountNonce, diffs, forgiveDebts,
        ),
        expectedBytes: ONCHAIN_HANKO_GOLDEN_PAYLOADS.settlement,
        expectedHash: ONCHAIN_HANKO_GOLDEN_HASHES.settlement,
      },
      {
        bytes: await hankoCodec.encodeDisputeProofHankoPayloadForDomain(
          vector.chainId, vector.depositoryAddress, accountKey, vector.accountNonce,
          vector.proofBodyHash, vector.watchSeed,
        ),
        hash: await hankoCodec.computeDisputeProofHankoHashForDomain(
          vector.chainId, vector.depositoryAddress, accountKey, vector.accountNonce,
          vector.proofBodyHash, vector.watchSeed,
        ),
        expectedBytes: ONCHAIN_HANKO_GOLDEN_PAYLOADS.dispute,
        expectedHash: ONCHAIN_HANKO_GOLDEN_HASHES.dispute,
      },
      {
        bytes: await hankoCodec.encodeFinalDisputeProofHankoPayloadForDomain(
          vector.chainId, vector.depositoryAddress, accountKey, vector.accountNonce,
        ),
        hash: await hankoCodec.computeFinalDisputeProofHankoHashForDomain(
          vector.chainId, vector.depositoryAddress, accountKey, vector.accountNonce,
        ),
        expectedBytes: ONCHAIN_HANKO_GOLDEN_PAYLOADS.final,
        expectedHash: ONCHAIN_HANKO_GOLDEN_HASHES.final,
      },
      {
        bytes: await hankoCodec.encodeCooperativeDisputeProofHankoPayloadForDomain(
          vector.chainId, vector.depositoryAddress, accountKey, vector.accountNonce,
          vector.proofBodyHash, vector.starterArgumentsHash,
        ),
        hash: await hankoCodec.computeCooperativeDisputeProofHankoHashForDomain(
          vector.chainId, vector.depositoryAddress, accountKey, vector.accountNonce,
          vector.proofBodyHash, vector.starterArgumentsHash,
        ),
        expectedBytes: ONCHAIN_HANKO_GOLDEN_PAYLOADS.cooperative,
        expectedHash: ONCHAIN_HANKO_GOLDEN_HASHES.cooperative,
      },
      {
        bytes: await hankoCodec.encodeBatchHankoPayloadForDomain(
          DEPOSITORY_BATCH_HANKO_DOMAIN, vector.chainId, vector.depositoryAddress,
          vector.encodedBatch, vector.batchNonce,
        ),
        hash: await hankoCodec.computeBatchHankoHashForDomain(
          DEPOSITORY_BATCH_HANKO_DOMAIN, vector.chainId, vector.depositoryAddress,
          vector.encodedBatch, vector.batchNonce,
        ),
        expectedBytes: ONCHAIN_HANKO_GOLDEN_PAYLOADS.batch,
        expectedHash: ONCHAIN_HANKO_GOLDEN_HASHES.batch,
      },
      {
        bytes: await hankoCodec.encodeWatchtowerCounterDisputeHankoPayloadForDomain(
          WATCHTOWER_COUNTER_DISPUTE_HANKO_DOMAIN,
          vector.chainId,
          vector.depositoryAddress,
          vector.towerAddress,
          vector.leftEntity,
          vector.rightEntity,
          vector.watchtower.finalNonce,
          vector.proofBodyHash,
          vector.watchtower.lastResortWindowBlocks,
          vector.watchtower.appointmentSequence,
        ),
        hash: await hankoCodec.computeWatchtowerCounterDisputeHankoHashForDomain(
          WATCHTOWER_COUNTER_DISPUTE_HANKO_DOMAIN,
          vector.chainId,
          vector.depositoryAddress,
          vector.towerAddress,
          vector.leftEntity,
          vector.rightEntity,
          vector.watchtower.finalNonce,
          vector.proofBodyHash,
          vector.watchtower.lastResortWindowBlocks,
          vector.watchtower.appointmentSequence,
        ),
        expectedBytes: ONCHAIN_HANKO_GOLDEN_PAYLOADS.watchtower,
        expectedHash: ONCHAIN_HANKO_GOLDEN_HASHES.watchtower,
      },
      {
        bytes: await hankoCodec.encodeEntityTransferHankoPayloadForDomain(
          vector.chainId,
          vector.entityProviderAddress,
          vector.entityTransfer.entityNumber,
          vector.boardEpoch,
          vector.towerAddress,
          vector.entityTransfer.tokenId,
          vector.entityTransfer.amount,
          vector.entityTransfer.actionNonce,
        ),
        hash: await hankoCodec.computeEntityTransferHankoHashForDomain(
          vector.chainId,
          vector.entityProviderAddress,
          vector.entityTransfer.entityNumber,
          vector.boardEpoch,
          vector.towerAddress,
          vector.entityTransfer.tokenId,
          vector.entityTransfer.amount,
          vector.entityTransfer.actionNonce,
        ),
        expectedBytes: ONCHAIN_HANKO_GOLDEN_PAYLOADS.entityTransfer,
        expectedHash: ONCHAIN_HANKO_GOLDEN_HASHES.entityTransfer,
      },
      {
        bytes: await hankoCodec.encodeReleaseControlSharesHankoPayloadForDomain(
          vector.chainId,
          vector.entityProviderAddress,
          vector.releaseControlShares.entityNumber,
          vector.boardEpoch,
          vector.depositoryAddress,
          vector.releaseControlShares.controlAmount,
          vector.releaseControlShares.dividendAmount,
          vector.releaseControlShares.purpose,
          vector.releaseControlShares.actionNonce,
        ),
        hash: await hankoCodec.computeReleaseControlSharesHankoHashForDomain(
          vector.chainId,
          vector.entityProviderAddress,
          vector.releaseControlShares.entityNumber,
          vector.boardEpoch,
          vector.depositoryAddress,
          vector.releaseControlShares.controlAmount,
          vector.releaseControlShares.dividendAmount,
          vector.releaseControlShares.purpose,
          vector.releaseControlShares.actionNonce,
        ),
        expectedBytes: ONCHAIN_HANKO_GOLDEN_PAYLOADS.releaseControlShares,
        expectedHash: ONCHAIN_HANKO_GOLDEN_HASHES.releaseControlShares,
      },
      {
        bytes: await hankoCodec.encodeCancelEntityProviderActionHankoPayloadForDomain(
          vector.chainId,
          vector.entityProviderAddress,
          vector.cancelEntityProviderAction.entityNumber,
          vector.boardEpoch,
          vector.cancelEntityProviderAction.actionNonce,
          vector.cancelEntityProviderAction.cancelledActionHash,
          vector.cancelEntityProviderAction.cancelledActionKind,
        ),
        hash: await hankoCodec.computeCancelEntityProviderActionHankoHashForDomain(
          vector.chainId,
          vector.entityProviderAddress,
          vector.cancelEntityProviderAction.entityNumber,
          vector.boardEpoch,
          vector.cancelEntityProviderAction.actionNonce,
          vector.cancelEntityProviderAction.cancelledActionHash,
          vector.cancelEntityProviderAction.cancelledActionKind,
        ),
        expectedBytes: ONCHAIN_HANKO_GOLDEN_PAYLOADS.cancelEntityProviderAction,
        expectedHash: ONCHAIN_HANKO_GOLDEN_HASHES.cancelEntityProviderAction,
      },
      {
        bytes: await hankoCodec.encodeBoardProposalHankoPayloadForDomain(
          BOARD_PROPOSAL_HANKO_DOMAIN,
          vector.chainId,
          vector.entityProviderAddress,
          vector.boardProposal.entityId,
          vector.boardEpoch,
          vector.boardProposal.newBoardHash,
          vector.boardProposal.authority,
          vector.boardProposal.actionNonce,
        ),
        hash: await hankoCodec.computeBoardProposalHankoHashForDomain(
          BOARD_PROPOSAL_HANKO_DOMAIN,
          vector.chainId,
          vector.entityProviderAddress,
          vector.boardProposal.entityId,
          vector.boardEpoch,
          vector.boardProposal.newBoardHash,
          vector.boardProposal.authority,
          vector.boardProposal.actionNonce,
        ),
        expectedBytes: ONCHAIN_HANKO_GOLDEN_PAYLOADS.boardProposal,
        expectedHash: ONCHAIN_HANKO_GOLDEN_HASHES.boardProposal,
      },
      {
        bytes: await hankoCodec.encodeBoardProposalCancelHankoPayloadForDomain(
          BOARD_PROPOSAL_CANCEL_HANKO_DOMAIN,
          vector.chainId,
          vector.entityProviderAddress,
          vector.boardProposalCancel.entityId,
          vector.boardEpoch,
          vector.boardProposalCancel.proposedBoardHash,
          vector.boardProposalCancel.proposedBy,
          vector.boardProposalCancel.cancelledBy,
          vector.boardProposalCancel.actionNonce,
        ),
        hash: await hankoCodec.computeBoardProposalCancelHankoHashForDomain(
          BOARD_PROPOSAL_CANCEL_HANKO_DOMAIN,
          vector.chainId,
          vector.entityProviderAddress,
          vector.boardProposalCancel.entityId,
          vector.boardEpoch,
          vector.boardProposalCancel.proposedBoardHash,
          vector.boardProposalCancel.proposedBy,
          vector.boardProposalCancel.cancelledBy,
          vector.boardProposalCancel.actionNonce,
        ),
        expectedBytes: ONCHAIN_HANKO_GOLDEN_PAYLOADS.boardProposalCancel,
        expectedHash: ONCHAIN_HANKO_GOLDEN_HASHES.boardProposalCancel,
      },
    ];
    for (const item of fixedVectors) {
      expect(item.bytes).to.equal(item.expectedBytes);
      expect(item.hash).to.equal(item.expectedHash);
      expect(ethers.keccak256(item.bytes)).to.equal(item.expectedHash);
    }
  });

  it('matches canonical TS bytes and hashes for every contract Hanko payload', async function () {
    const { depository, entityProvider, hankoCodec, recipient } = await loadFixture(deployFixture);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const depositoryAddress = await depository.getAddress();
    const entityProviderAddress = await entityProvider.getAddress();
    const left = `0x${'11'.repeat(32)}`;
    const right = `0x${'22'.repeat(32)}`;
    const accountKey = `${left}${right.slice(2)}`;
    const proofbodyHash = `0x${'44'.repeat(32)}`;
    const watchSeed = `0x${'33'.repeat(32)}`;
    const starterArgumentsHash = `0x${'55'.repeat(32)}`;
    const diffs = [{ tokenId: 9, leftDiff: -7n, rightDiff: 2n, collateralDiff: 5n, ondeltaDiff: -3n }];

    const depositoryDomain = { chainId, depositoryAddress };
    const accountVectors = [
      {
        solidityBytes: await hankoCodec.encodeCooperativeUpdateHankoPayloadForDomain(
          chainId, depositoryAddress, accountKey, 7, diffs, [12],
        ),
        solidityHash: await hankoCodec.computeCooperativeUpdateHankoHashForDomain(
          chainId, depositoryAddress, accountKey, 7, diffs, [12],
        ),
        tsBytes: encodeCooperativeUpdateHankoPayload(depositoryDomain, accountKey, 7, diffs, [12]),
        tsHash: hashCooperativeUpdateHankoPayload(depositoryDomain, accountKey, 7, diffs, [12]),
      },
      {
        solidityBytes: await hankoCodec.encodeDisputeProofHankoPayloadForDomain(
          chainId, depositoryAddress, accountKey, 7, proofbodyHash, watchSeed,
        ),
        solidityHash: await hankoCodec.computeDisputeProofHankoHashForDomain(
          chainId, depositoryAddress, accountKey, 7, proofbodyHash, watchSeed,
        ),
        tsBytes: encodeDisputeProofHankoPayload(depositoryDomain, accountKey, 7, proofbodyHash, watchSeed),
        tsHash: hashDisputeProofHankoPayload(depositoryDomain, accountKey, 7, proofbodyHash, watchSeed),
      },
      {
        // FinalDisputeProof is deliberately pinned but has no Depository caller today.
        solidityBytes: await hankoCodec.encodeFinalDisputeProofHankoPayloadForDomain(
          chainId, depositoryAddress, accountKey, 7,
        ),
        solidityHash: await hankoCodec.computeFinalDisputeProofHankoHashForDomain(
          chainId, depositoryAddress, accountKey, 7,
        ),
        tsBytes: encodeFinalDisputeProofHankoPayload(depositoryDomain, accountKey, 7),
        tsHash: hashFinalDisputeProofHankoPayload(depositoryDomain, accountKey, 7),
      },
      {
        solidityBytes: await hankoCodec.encodeCooperativeDisputeProofHankoPayloadForDomain(
          chainId, depositoryAddress, accountKey, 7, proofbodyHash, starterArgumentsHash,
        ),
        solidityHash: await hankoCodec.computeCooperativeDisputeProofHankoHashForDomain(
          chainId, depositoryAddress, accountKey, 7, proofbodyHash, starterArgumentsHash,
        ),
        tsBytes: encodeCooperativeDisputeProofHankoPayload(
          depositoryDomain, accountKey, 7, proofbodyHash, starterArgumentsHash,
        ),
        tsHash: hashCooperativeDisputeProofHankoPayload(
          depositoryDomain, accountKey, 7, proofbodyHash, starterArgumentsHash,
        ),
      },
      {
        solidityBytes: await hankoCodec.encodeBatchHankoPayloadForDomain(
          DEPOSITORY_BATCH_HANKO_DOMAIN, chainId, depositoryAddress, '0x1234abcd', 8,
        ),
        solidityHash: await hankoCodec.computeBatchHankoHashForDomain(
          DEPOSITORY_BATCH_HANKO_DOMAIN, chainId, depositoryAddress, '0x1234abcd', 8,
        ),
        tsBytes: encodeDepositoryBatchHankoPayload(depositoryDomain, '0x1234abcd', 8),
        tsHash: hashDepositoryBatchHankoPayload(depositoryDomain, '0x1234abcd', 8),
      },
    ];
    for (const vector of accountVectors) {
      expect(vector.solidityBytes).to.equal(vector.tsBytes);
      expect(vector.solidityHash).to.equal(vector.tsHash);
      expect(ethers.keccak256(vector.solidityBytes)).to.equal(vector.solidityHash);
    }

    const watchtowerAuthorization = {
      towerAddress: recipient.address,
      entityId: left,
      counterentity: right,
      finalNonce: 9,
      finalProofbodyHash: proofbodyHash,
      lastResortWindowBlocks: 16,
      appointmentSequence: 3,
    };
    const watchtowerBytes = encodeWatchtowerCounterDisputeHankoPayload(
      depositoryDomain,
      watchtowerAuthorization,
    );
    const watchtowerHash = hashWatchtowerCounterDisputeHankoPayload(
      depositoryDomain,
      watchtowerAuthorization,
    );
    expect(await hankoCodec.encodeWatchtowerCounterDisputeHankoPayloadForDomain(
      WATCHTOWER_COUNTER_DISPUTE_HANKO_DOMAIN,
      chainId,
      depositoryAddress,
      watchtowerAuthorization.towerAddress,
      watchtowerAuthorization.entityId,
      watchtowerAuthorization.counterentity,
      watchtowerAuthorization.finalNonce,
      watchtowerAuthorization.finalProofbodyHash,
      watchtowerAuthorization.lastResortWindowBlocks,
      watchtowerAuthorization.appointmentSequence,
    )).to.equal(watchtowerBytes);
    expect(await hankoCodec.computeWatchtowerCounterDisputeHankoHashForDomain(
      WATCHTOWER_COUNTER_DISPUTE_HANKO_DOMAIN,
      chainId,
      depositoryAddress,
      watchtowerAuthorization.towerAddress,
      watchtowerAuthorization.entityId,
      watchtowerAuthorization.counterentity,
      watchtowerAuthorization.finalNonce,
      watchtowerAuthorization.finalProofbodyHash,
      watchtowerAuthorization.lastResortWindowBlocks,
      watchtowerAuthorization.appointmentSequence,
    )).to.equal(watchtowerHash);
    expect(await depository.computeWatchtowerCounterDisputeHash(
      watchtowerAuthorization.towerAddress,
      watchtowerAuthorization.entityId,
      watchtowerAuthorization.counterentity,
      watchtowerAuthorization.finalNonce,
      watchtowerAuthorization.finalProofbodyHash,
      watchtowerAuthorization.lastResortWindowBlocks,
      watchtowerAuthorization.appointmentSequence,
    )).to.equal(watchtowerHash);

    const transferAuthorization = {
      entityNumber: 2,
      to: recipient.address,
      tokenId: 2,
      amount: 100,
      actionNonce: 1,
    };
    const releaseAuthorization = {
      entityNumber: 2,
      depositoryAddress,
      controlAmount: 100,
      dividendAmount: 200,
      purpose: 'Series A',
      actionNonce: 1,
    };
    const entityProviderDomain = { chainId, entityProviderAddress, boardEpoch: 0n };
    const cancelAuthorization = {
      entityNumber: 2,
      actionNonce: 1,
      cancelledActionHash: hashEntityTransferHankoPayload(entityProviderDomain, transferAuthorization),
      cancelledActionKind: 0,
    };
    const boardProposalAuthorization = {
      entityId: left,
      newBoardHash: `0x${'88'.repeat(32)}`,
      authority: 1,
      actionNonce: 7,
    };
    const boardProposalCancelAuthorization = {
      entityId: left,
      proposedBoardHash: boardProposalAuthorization.newBoardHash,
      proposedBy: 3,
      cancelledBy: 2,
      actionNonce: 7,
    };
    expect(await hankoCodec.encodeEntityTransferHankoPayloadForDomain(
      chainId, entityProviderAddress, 2, 0, recipient.address, 2, 100, 1,
    )).to.equal(encodeEntityTransferHankoPayload(entityProviderDomain, transferAuthorization));
    expect(await hankoCodec.computeEntityTransferHankoHashForDomain(
      chainId, entityProviderAddress, 2, 0, recipient.address, 2, 100, 1,
    )).to.equal(hashEntityTransferHankoPayload(entityProviderDomain, transferAuthorization));
    expect(await hankoCodec.encodeReleaseControlSharesHankoPayloadForDomain(
      chainId, entityProviderAddress, 2, 0, depositoryAddress, 100, 200, 'Series A', 1,
    )).to.equal(encodeReleaseControlSharesHankoPayload(entityProviderDomain, releaseAuthorization));
    expect(await hankoCodec.computeReleaseControlSharesHankoHashForDomain(
      chainId, entityProviderAddress, 2, 0, depositoryAddress, 100, 200, 'Series A', 1,
    )).to.equal(hashReleaseControlSharesHankoPayload(entityProviderDomain, releaseAuthorization));
    expect(await entityProvider.encodeEntityTransferHankoPayload(2, recipient.address, 2, 100, 1))
      .to.equal(encodeEntityTransferHankoPayload(entityProviderDomain, transferAuthorization));
    expect(await entityProvider.computeEntityTransferHankoHash(2, recipient.address, 2, 100, 1))
      .to.equal(hashEntityTransferHankoPayload(entityProviderDomain, transferAuthorization));
    expect(await entityProvider.encodeReleaseControlSharesHankoPayload(2, depositoryAddress, 100, 200, 'Series A', 1))
      .to.equal(encodeReleaseControlSharesHankoPayload(entityProviderDomain, releaseAuthorization));
    expect(await entityProvider.computeReleaseControlSharesHankoHash(2, depositoryAddress, 100, 200, 'Series A', 1))
      .to.equal(hashReleaseControlSharesHankoPayload(entityProviderDomain, releaseAuthorization));
    expect(await hankoCodec.encodeCancelEntityProviderActionHankoPayloadForDomain(
      chainId,
      entityProviderAddress,
      cancelAuthorization.entityNumber,
      entityProviderDomain.boardEpoch,
      cancelAuthorization.actionNonce,
      cancelAuthorization.cancelledActionHash,
      cancelAuthorization.cancelledActionKind,
    )).to.equal(encodeCancelEntityProviderActionHankoPayload(entityProviderDomain, cancelAuthorization));
    expect(await hankoCodec.computeCancelEntityProviderActionHankoHashForDomain(
      chainId,
      entityProviderAddress,
      cancelAuthorization.entityNumber,
      entityProviderDomain.boardEpoch,
      cancelAuthorization.actionNonce,
      cancelAuthorization.cancelledActionHash,
      cancelAuthorization.cancelledActionKind,
    )).to.equal(hashCancelEntityProviderActionHankoPayload(entityProviderDomain, cancelAuthorization));
    expect(await entityProvider.encodeCancelEntityProviderActionHankoPayload(
      cancelAuthorization.entityNumber,
      cancelAuthorization.actionNonce,
      cancelAuthorization.cancelledActionHash,
      cancelAuthorization.cancelledActionKind,
    )).to.equal(encodeCancelEntityProviderActionHankoPayload(entityProviderDomain, cancelAuthorization));
    expect(await entityProvider.computeCancelEntityProviderActionHankoHash(
      cancelAuthorization.entityNumber,
      cancelAuthorization.actionNonce,
      cancelAuthorization.cancelledActionHash,
      cancelAuthorization.cancelledActionKind,
    )).to.equal(hashCancelEntityProviderActionHankoPayload(entityProviderDomain, cancelAuthorization));
    expect(await hankoCodec.encodeBoardProposalHankoPayloadForDomain(
      BOARD_PROPOSAL_HANKO_DOMAIN,
      chainId,
      entityProviderAddress,
      boardProposalAuthorization.entityId,
      entityProviderDomain.boardEpoch,
      boardProposalAuthorization.newBoardHash,
      boardProposalAuthorization.authority,
      boardProposalAuthorization.actionNonce,
    )).to.equal(encodeBoardProposalHankoPayload(entityProviderDomain, boardProposalAuthorization));
    expect(await hankoCodec.computeBoardProposalHankoHashForDomain(
      BOARD_PROPOSAL_HANKO_DOMAIN,
      chainId,
      entityProviderAddress,
      boardProposalAuthorization.entityId,
      entityProviderDomain.boardEpoch,
      boardProposalAuthorization.newBoardHash,
      boardProposalAuthorization.authority,
      boardProposalAuthorization.actionNonce,
    )).to.equal(hashBoardProposalHankoPayload(entityProviderDomain, boardProposalAuthorization));
    expect(await entityProvider.encodeBoardProposalHankoPayload(
      boardProposalAuthorization.entityId,
      boardProposalAuthorization.newBoardHash,
      boardProposalAuthorization.authority,
      boardProposalAuthorization.actionNonce,
    )).to.equal(encodeBoardProposalHankoPayload(entityProviderDomain, boardProposalAuthorization));
    expect(await entityProvider.computeBoardProposalHash(
      boardProposalAuthorization.entityId,
      boardProposalAuthorization.newBoardHash,
      boardProposalAuthorization.authority,
      boardProposalAuthorization.actionNonce,
    )).to.equal(hashBoardProposalHankoPayload(entityProviderDomain, boardProposalAuthorization));
    expect(await hankoCodec.encodeBoardProposalCancelHankoPayloadForDomain(
      BOARD_PROPOSAL_CANCEL_HANKO_DOMAIN,
      chainId,
      entityProviderAddress,
      boardProposalCancelAuthorization.entityId,
      entityProviderDomain.boardEpoch,
      boardProposalCancelAuthorization.proposedBoardHash,
      boardProposalCancelAuthorization.proposedBy,
      boardProposalCancelAuthorization.cancelledBy,
      boardProposalCancelAuthorization.actionNonce,
    )).to.equal(encodeBoardProposalCancelHankoPayload(entityProviderDomain, boardProposalCancelAuthorization));
    expect(await hankoCodec.computeBoardProposalCancelHankoHashForDomain(
      BOARD_PROPOSAL_CANCEL_HANKO_DOMAIN,
      chainId,
      entityProviderAddress,
      boardProposalCancelAuthorization.entityId,
      entityProviderDomain.boardEpoch,
      boardProposalCancelAuthorization.proposedBoardHash,
      boardProposalCancelAuthorization.proposedBy,
      boardProposalCancelAuthorization.cancelledBy,
      boardProposalCancelAuthorization.actionNonce,
    )).to.equal(hashBoardProposalCancelHankoPayload(entityProviderDomain, boardProposalCancelAuthorization));
    expect(await entityProvider.encodeBoardProposalCancelHankoPayload(
      boardProposalCancelAuthorization.entityId,
      boardProposalCancelAuthorization.proposedBoardHash,
      boardProposalCancelAuthorization.proposedBy,
      boardProposalCancelAuthorization.cancelledBy,
      boardProposalCancelAuthorization.actionNonce,
    )).to.equal(encodeBoardProposalCancelHankoPayload(entityProviderDomain, boardProposalCancelAuthorization));
    expect(await entityProvider.computeBoardProposalCancelHash(
      boardProposalCancelAuthorization.entityId,
      boardProposalCancelAuthorization.proposedBoardHash,
      boardProposalCancelAuthorization.proposedBy,
      boardProposalCancelAuthorization.cancelledBy,
      boardProposalCancelAuthorization.actionNonce,
    )).to.equal(hashBoardProposalCancelHankoPayload(entityProviderDomain, boardProposalCancelAuthorization));

    const batch = emptyBatch();
    const encodedBatch = encodeBatch(batch);
    const lazyEntityId = singleSignerLazyEntityId(recipient.address);
    const batchHash = hashDepositoryBatchHankoPayload(depositoryDomain, encodedBatch, 1);
    const batchHanko = buildSingleSignerHanko(lazyEntityId, batchHash, deriveHardhatPrivateKey(2));
    await expect(depository.processBatch(encodedBatch, batchHanko, 1)).to.not.be.reverted;
    expect(await depository.entityNonces(lazyEntityId)).to.equal(1);
  });

  it('executes entityTransferTokens and rejects replay, wrong-chain, and wrong-provider signatures', async function () {
    const fixture = await loadFixture(deployFixture);
    const { entityNumber, entityPrivateKey, entityProvider, otherEntityProvider, recipient } = fixture;
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const tokenId = entityNumber;
    const amount = 100n;
    const source = entityAddress(entityNumber);
    const domain = { chainId, entityProviderAddress: await entityProvider.getAddress(), boardEpoch: 0n };
    const authorization = { entityNumber, to: recipient.address, tokenId, amount, actionNonce: 1 };
    const transferHash = hashEntityTransferHankoPayload(domain, authorization);
    const hanko = buildSingleSignerHanko(entityId(entityNumber), transferHash, entityPrivateKey);

    const sourceBefore = await entityProvider.balanceOf(source, tokenId);
    const transferTx = await entityProvider.entityTransferTokens(
      entityNumber, recipient.address, tokenId, amount, hanko,
    );
    const transferEvent = exactActionReceipt(entityProvider, await transferTx.wait());
    expect(transferEvent.args.entityId).to.equal(entityId(entityNumber));
    expect(transferEvent.args.actionNonce).to.equal(1n);
    expect(transferEvent.args.actionHash).to.equal(transferHash);
    expect(transferEvent.args.actionKind).to.equal(BigInt(ONCHAIN_HANKO_GOLDEN_ACTION_RECEIPT.kinds.entityTransfer));
    expect(await entityProvider.balanceOf(source, tokenId)).to.equal(sourceBefore - amount);
    expect(await entityProvider.balanceOf(recipient.address, tokenId)).to.equal(amount);
    expect(await entityProvider.entityActionNonces(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32))).to.equal(1);

    const assertPrimaryUnchanged = async (attempt: () => Promise<unknown>): Promise<void> => {
      const nonceBefore = await entityProvider.entityActionNonces(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32));
      const sourceBalance = await entityProvider.balanceOf(source, tokenId);
      const recipientBalance = await entityProvider.balanceOf(recipient.address, tokenId);
      await expect(attempt()).to.be.revertedWith('Invalid entity signature');
      expect(await entityProvider.entityActionNonces(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32))).to.equal(nonceBefore);
      expect(await entityProvider.balanceOf(source, tokenId)).to.equal(sourceBalance);
      expect(await entityProvider.balanceOf(recipient.address, tokenId)).to.equal(recipientBalance);
    };
    await assertPrimaryUnchanged(() => entityProvider.entityTransferTokens(
      entityNumber, recipient.address, tokenId, amount, hanko,
    ));

    const wrongChainAuthorization = { ...authorization, actionNonce: 2 };
    const wrongChainHanko = buildSingleSignerHanko(entityId(entityNumber), hashEntityTransferHankoPayload(
      { ...domain, chainId: chainId + 1n }, wrongChainAuthorization,
    ), entityPrivateKey);
    await assertPrimaryUnchanged(() => entityProvider.entityTransferTokens(
      entityNumber, recipient.address, tokenId, amount, wrongChainHanko,
    ));

    const otherSourceBefore = await otherEntityProvider.balanceOf(source, tokenId);
    const otherNonceBefore = await otherEntityProvider.entityActionNonces(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32));
    await expect(otherEntityProvider.entityTransferTokens(
      entityNumber, recipient.address, tokenId, amount, hanko,
    )).to.be.revertedWith('Invalid entity signature');
    expect(await otherEntityProvider.entityActionNonces(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32))).to.equal(otherNonceBefore);
    expect(await otherEntityProvider.balanceOf(source, tokenId)).to.equal(otherSourceBefore);
    expect(await otherEntityProvider.balanceOf(recipient.address, tokenId)).to.equal(0);
  });

  it('publishes one exact action receipt identity for deterministic reconciliation', async function () {
    const { entityProvider } = await loadFixture(deployFixture);
    const event = entityProvider.interface.getEvent('EntityProviderActionExecuted');
    expect(event.topicHash).to.equal(ONCHAIN_HANKO_GOLDEN_ACTION_RECEIPT.topic);
    expect(event.inputs.map((input) => [input.name, input.type, input.indexed])).to.deep.equal([
      ['entityId', 'bytes32', true],
      ['actionNonce', 'uint256', true],
      ['actionHash', 'bytes32', true],
      ['actionKind', 'uint8', false],
    ]);
    const cancelled = entityProvider.interface.getEvent('EntityProviderActionCancelled');
    expect(cancelled.topicHash).to.equal(ONCHAIN_HANKO_GOLDEN_ACTION_CANCEL_RECEIPT.topic);
    expect(cancelled.inputs.map((input) => [input.name, input.type, input.indexed])).to.deep.equal([
      ['entityId', 'bytes32', true],
      ['actionNonce', 'uint256', true],
      ['cancelledActionHash', 'bytes32', true],
      ['cancelledActionKind', 'uint8', false],
      ['cancelHash', 'bytes32', false],
    ]);
  });

  it('keeps transfer and release in one replay-protected action nonce lane', async function () {
    const { depository, entityNumber, entityPrivateKey, entityProvider, recipient } = await loadFixture(deployFixture);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const providerDomain = { chainId, entityProviderAddress: await entityProvider.getAddress(), boardEpoch: 0n };
    const numberedEntityId = entityId(entityNumber);
    const depositoryAddress = await depository.getAddress();
    const transferAuthorization = {
      entityNumber,
      to: recipient.address,
      tokenId: entityNumber,
      amount: 1n,
      actionNonce: 1n,
    };
    const releaseAuthorization = {
      entityNumber,
      depositoryAddress,
      controlAmount: 1n,
      dividendAmount: 0n,
      purpose: 'nonce-lane',
      actionNonce: 1n,
    };
    const transferHanko = buildSingleSignerHanko(
      numberedEntityId,
      hashEntityTransferHankoPayload(providerDomain, transferAuthorization),
      entityPrivateKey,
    );
    const staleReleaseHanko = buildSingleSignerHanko(
      numberedEntityId,
      hashReleaseControlSharesHankoPayload(providerDomain, releaseAuthorization),
      entityPrivateKey,
    );

    await expect(entityProvider.releaseControlShares(
      entityNumber,
      depositoryAddress,
      releaseAuthorization.controlAmount,
      releaseAuthorization.dividendAmount,
      releaseAuthorization.purpose,
      transferHanko,
    )).to.be.revertedWith('Invalid entity signature');
    expect(await entityProvider.entityActionNonces(numberedEntityId)).to.equal(0n);

    await expect(entityProvider.entityTransferTokens(
      entityNumber,
      transferAuthorization.to,
      transferAuthorization.tokenId,
      transferAuthorization.amount,
      transferHanko,
    )).to.not.be.reverted;
    expect(await entityProvider.entityActionNonces(numberedEntityId)).to.equal(1n);

    await expect(entityProvider.releaseControlShares(
      entityNumber,
      depositoryAddress,
      releaseAuthorization.controlAmount,
      releaseAuthorization.dividendAmount,
      releaseAuthorization.purpose,
      staleReleaseHanko,
    )).to.be.revertedWith('Invalid entity signature');
    expect(await entityProvider.entityActionNonces(numberedEntityId)).to.equal(1n);

    const nextReleaseAuthorization = { ...releaseAuthorization, actionNonce: 2n };
    const nextReleaseHash = hashReleaseControlSharesHankoPayload(providerDomain, nextReleaseAuthorization);
    const nextReleaseHanko = buildSingleSignerHanko(numberedEntityId, nextReleaseHash, entityPrivateKey);
    const releaseTx = await entityProvider.releaseControlShares(
      entityNumber,
      depositoryAddress,
      nextReleaseAuthorization.controlAmount,
      nextReleaseAuthorization.dividendAmount,
      nextReleaseAuthorization.purpose,
      nextReleaseHanko,
    );
    const releaseEvent = exactActionReceipt(entityProvider, await releaseTx.wait());
    expect(releaseEvent.args.actionNonce).to.equal(2n);
    expect(releaseEvent.args.actionHash).to.equal(nextReleaseHash);
    expect(releaseEvent.args.actionKind).to.equal(BigInt(ONCHAIN_HANKO_GOLDEN_ACTION_RECEIPT.kinds.releaseControlShares));
  });

  it('lets quorum cancel one exact pending action nonce and makes execute/cancel mutually exclusive', async function () {
    const {
      entityNumber,
      entityPrivateKey,
      entityProvider,
      otherEntityProvider,
      recipient,
    } = await loadFixture(deployFixture);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const numberedEntityId = entityId(entityNumber);
    const actionKind = 0;
    const actionNonce = 1n;
    const transferAuthorization = {
      entityNumber,
      to: recipient.address,
      tokenId: entityNumber,
      amount: 1n,
      actionNonce,
    };
    const primaryDomain = {
      chainId,
      entityProviderAddress: await entityProvider.getAddress(),
      boardEpoch: 0n,
    };
    const transferHash = hashEntityTransferHankoPayload(primaryDomain, transferAuthorization);
    const transferHanko = buildSingleSignerHanko(numberedEntityId, transferHash, entityPrivateKey);
    // Independent test oracle: do not derive the expected cancel preimage from
    // the production TS/Solidity helper under test.
    const cancelHash = ethers.keccak256(ethers.solidityPacked(
      ['string', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'bytes32', 'uint8'],
      [
        'CANCEL_ENTITY_PROVIDER_ACTION',
        chainId,
        primaryDomain.entityProviderAddress,
        entityNumber,
        primaryDomain.boardEpoch,
        actionNonce,
        transferHash,
        actionKind,
      ],
    ));
    const cancelHanko = buildSingleSignerHanko(numberedEntityId, cancelHash, entityPrivateKey);
    const wrongChainCancelHash = ethers.keccak256(ethers.solidityPacked(
      ['string', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'bytes32', 'uint8'],
      [
        'CANCEL_ENTITY_PROVIDER_ACTION',
        chainId + 1n,
        primaryDomain.entityProviderAddress,
        entityNumber,
        primaryDomain.boardEpoch,
        actionNonce,
        transferHash,
        actionKind,
      ],
    ));
    const wrongChainCancelHanko = buildSingleSignerHanko(
      numberedEntityId,
      wrongChainCancelHash,
      entityPrivateKey,
    );
    await expect((entityProvider as unknown as {
      cancelEntityProviderAction: (
        entityNumber: bigint,
        actionHash: string,
        actionKind: number,
        hanko: string,
      ) => Promise<unknown>;
    }).cancelEntityProviderAction(
      entityNumber,
      transferHash,
      actionKind,
      wrongChainCancelHanko,
    )).to.be.revertedWith('Invalid entity signature');
    await expect((otherEntityProvider as unknown as {
      cancelEntityProviderAction: (
        entityNumber: bigint,
        actionHash: string,
        actionKind: number,
        hanko: string,
      ) => Promise<unknown>;
    }).cancelEntityProviderAction(
      entityNumber,
      transferHash,
      actionKind,
      cancelHanko,
    )).to.be.revertedWith('Invalid entity signature');
    expect(await entityProvider.entityActionNonces(numberedEntityId)).to.equal(0n);
    expect(await otherEntityProvider.entityActionNonces(numberedEntityId)).to.equal(0n);
    const cancelTx = await (entityProvider as unknown as {
      cancelEntityProviderAction: (
        entityNumber: bigint,
        actionHash: string,
        actionKind: number,
        hanko: string,
      ) => Promise<{ wait: () => Promise<ContractTransactionReceipt | null> }>;
    }).cancelEntityProviderAction(entityNumber, transferHash, actionKind, cancelHanko);
    const cancelReceipt = await cancelTx.wait();
    const cancelEvents = (cancelReceipt?.logs ?? [])
      .filter((log) => log.address.toLowerCase() === String(entityProvider.target).toLowerCase())
      .map((log) => entityProvider.interface.parseLog(log))
      .filter((event): event is LogDescription => event?.name === 'EntityProviderActionCancelled');
    expect(cancelEvents).to.have.length(1);
    expect(cancelEvents[0]!.args.entityId).to.equal(numberedEntityId);
    expect(cancelEvents[0]!.args.actionNonce).to.equal(actionNonce);
    expect(cancelEvents[0]!.args.cancelledActionHash).to.equal(transferHash);
    expect(cancelEvents[0]!.args.cancelledActionKind).to.equal(BigInt(actionKind));
    expect(cancelEvents[0]!.args.cancelHash).to.equal(cancelHash);
    expect(await entityProvider.entityActionNonces(numberedEntityId)).to.equal(actionNonce);

    await expect(entityProvider.entityTransferTokens(
      entityNumber,
      recipient.address,
      entityNumber,
      1n,
      transferHanko,
    )).to.be.revertedWith('Invalid entity signature');
    expect(await entityProvider.entityActionNonces(numberedEntityId)).to.equal(actionNonce);

    const otherDomain = {
      chainId,
      entityProviderAddress: await otherEntityProvider.getAddress(),
      boardEpoch: 0n,
    };
    const otherTransferHash = hashEntityTransferHankoPayload(otherDomain, transferAuthorization);
    const otherTransferHanko = buildSingleSignerHanko(numberedEntityId, otherTransferHash, entityPrivateKey);
    await expect(otherEntityProvider.entityTransferTokens(
      entityNumber,
      recipient.address,
      entityNumber,
      1n,
      otherTransferHanko,
    )).to.not.be.reverted;
    const staleOtherCancelHash = ethers.keccak256(ethers.solidityPacked(
      ['string', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'bytes32', 'uint8'],
      [
        'CANCEL_ENTITY_PROVIDER_ACTION',
        chainId,
        otherDomain.entityProviderAddress,
        entityNumber,
        otherDomain.boardEpoch,
        actionNonce,
        otherTransferHash,
        actionKind,
      ],
    ));
    const staleOtherCancelHanko = buildSingleSignerHanko(
      numberedEntityId,
      staleOtherCancelHash,
      entityPrivateKey,
    );
    await expect((otherEntityProvider as unknown as {
      cancelEntityProviderAction: (
        entityNumber: bigint,
        actionHash: string,
        actionKind: number,
        hanko: string,
      ) => Promise<unknown>;
    }).cancelEntityProviderAction(
      entityNumber,
      otherTransferHash,
      actionKind,
      staleOtherCancelHanko,
    )).to.be.revertedWith('Invalid entity signature');
    expect(await otherEntityProvider.entityActionNonces(numberedEntityId)).to.equal(actionNonce);
  });

  it('executes releaseControlShares and rejects replay, wrong-chain, and wrong-provider signatures', async function () {
    const fixture = await loadFixture(deployFixture);
    const { depository, entityNumber, entityPrivateKey, entityProvider, otherEntityProvider } = fixture;
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const depositoryAddress = await depository.getAddress();
    const [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(entityNumber);
    const source = entityAddress(entityNumber);
    const controlAmount = 100n;
    const dividendAmount = 200n;
    const purpose = 'Series A';
    const domain = { chainId, entityProviderAddress: await entityProvider.getAddress(), boardEpoch: 0n };
    const authorization = {
      entityNumber,
      depositoryAddress,
      controlAmount,
      dividendAmount,
      purpose,
      actionNonce: 1,
    };
    const releaseHash = hashReleaseControlSharesHankoPayload(domain, authorization);
    const hanko = buildSingleSignerHanko(entityId(entityNumber), releaseHash, entityPrivateKey);

    const controlBefore = await entityProvider.balanceOf(source, controlTokenId);
    const dividendBefore = await entityProvider.balanceOf(source, dividendTokenId);
    const releaseTx = await entityProvider.releaseControlShares(
      entityNumber, depositoryAddress, controlAmount, dividendAmount,
      purpose, hanko,
    );
    const releaseEvent = exactActionReceipt(entityProvider, await releaseTx.wait());
    expect(releaseEvent.args.entityId).to.equal(entityId(entityNumber));
    expect(releaseEvent.args.actionNonce).to.equal(1n);
    expect(releaseEvent.args.actionHash).to.equal(releaseHash);
    expect(releaseEvent.args.actionKind).to.equal(BigInt(ONCHAIN_HANKO_GOLDEN_ACTION_RECEIPT.kinds.releaseControlShares));
    expect(await entityProvider.balanceOf(source, controlTokenId)).to.equal(controlBefore - controlAmount);
    expect(await entityProvider.balanceOf(source, dividendTokenId)).to.equal(dividendBefore - dividendAmount);
    expect(await entityProvider.balanceOf(depositoryAddress, controlTokenId)).to.equal(controlAmount);
    expect(await entityProvider.balanceOf(depositoryAddress, dividendTokenId)).to.equal(dividendAmount);
    expect(await entityProvider.entityActionNonces(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32))).to.equal(1);

    const assertPrimaryUnchanged = async (attempt: () => Promise<unknown>): Promise<void> => {
      const nonceBefore = await entityProvider.entityActionNonces(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32));
      const sourceControl = await entityProvider.balanceOf(source, controlTokenId);
      const sourceDividend = await entityProvider.balanceOf(source, dividendTokenId);
      const targetControl = await entityProvider.balanceOf(depositoryAddress, controlTokenId);
      const targetDividend = await entityProvider.balanceOf(depositoryAddress, dividendTokenId);
      await expect(attempt()).to.be.revertedWith('Invalid entity signature');
      expect(await entityProvider.entityActionNonces(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32))).to.equal(nonceBefore);
      expect(await entityProvider.balanceOf(source, controlTokenId)).to.equal(sourceControl);
      expect(await entityProvider.balanceOf(source, dividendTokenId)).to.equal(sourceDividend);
      expect(await entityProvider.balanceOf(depositoryAddress, controlTokenId)).to.equal(targetControl);
      expect(await entityProvider.balanceOf(depositoryAddress, dividendTokenId)).to.equal(targetDividend);
    };
    await assertPrimaryUnchanged(() => entityProvider.releaseControlShares(
      entityNumber, depositoryAddress, controlAmount, dividendAmount,
      purpose, hanko,
    ));

    const wrongChainAuthorization = { ...authorization, actionNonce: 2 };
    const wrongChainHanko = buildSingleSignerHanko(entityId(entityNumber), hashReleaseControlSharesHankoPayload(
      { ...domain, chainId: chainId + 1n }, wrongChainAuthorization,
    ), entityPrivateKey);
    await assertPrimaryUnchanged(() => entityProvider.releaseControlShares(
      entityNumber, depositoryAddress, controlAmount, dividendAmount,
      purpose, wrongChainHanko,
    ));

    const otherControlBefore = await otherEntityProvider.balanceOf(source, controlTokenId);
    const otherDividendBefore = await otherEntityProvider.balanceOf(source, dividendTokenId);
    const otherNonceBefore = await otherEntityProvider.entityActionNonces(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32));
    await expect(otherEntityProvider.releaseControlShares(
      entityNumber, depositoryAddress, controlAmount, dividendAmount,
      purpose, hanko,
    )).to.be.revertedWith('Invalid entity signature');
    expect(await otherEntityProvider.entityActionNonces(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32))).to.equal(otherNonceBefore);
    expect(await otherEntityProvider.balanceOf(source, controlTokenId)).to.equal(otherControlBefore);
    expect(await otherEntityProvider.balanceOf(source, dividendTokenId)).to.equal(otherDividendBefore);
    expect(await otherEntityProvider.balanceOf(depositoryAddress, controlTokenId)).to.equal(0);
    expect(await otherEntityProvider.balanceOf(depositoryAddress, dividendTokenId)).to.equal(0);
  });
});
