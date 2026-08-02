import { loadFixture, mine, time } from '@nomicfoundation/hardhat-toolbox/network-helpers.js';

import { expect } from 'chai';

import hre from 'hardhat';

const { ethers } = hre;

import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers.js';

import type { Depository } from '../typechain-types/index.js';

import { Contract, type ContractTransactionReceipt } from 'ethers';

import {
  addressEntityId,
  buildSingleSignerHanko,
  computeDepositoryBatchHash,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  singleSignerLazyEntityId,
} from './helpers/hanko.ts';

const abi = ethers.AbiCoder.defaultAbiCoder();

const COOPERATIVE_UPDATE = 0;

const DISPUTE_PROOF = 1;

const COOPERATIVE_DISPUTE_PROOF = 3;

const MAX_FILL_RATIO = 65535n;

const SETTLEMENT_DIFFS_ABI =
  'tuple(uint256 tokenId,int256 leftDiff,int256 rightDiff,int256 collateralDiff,int256 ondeltaDiff)[]';

const PROOF_BODY_ABI =
  'tuple(bytes32 watchSeed,int256[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)';

const TEST_WATCH_SEED = ethers.keccak256(ethers.toUtf8Bytes('xln:test-watch-seed'));

const TRANSFORMER_MODE = {
  add: 0,
  absolute: 1,
  revertCall: 2,
  exhaustGas: 3,
  shortReturn: 4,
  wrongLength: 5,
  malformedReturn: 6,
  returnBomb: 7,
} as const;

const TRANSFORMER_SKIP_REASON = {
  noCode: 1n,
  insufficientGas: 2n,
  callFailed: 3n,
  malformedReturn: 4n,
  invalidAllowance: 5n,
  unallowedMutation: 6n,
  unrepresentableBaseDelta: 7n,
} as const;

type TestActor = {
  signer: HardhatEthersSigner;
  entityId: string;
  privateKey: string;
};

function lazyActor(signer: HardhatEthersSigner, signerIndex: number): TestActor {
  return {
    signer,
    entityId: singleSignerLazyEntityId(signer.address),
    privateKey: deriveHardhatPrivateKey(signerIndex),
  };
}

function orderedActors(a: TestActor, b: TestActor): [TestActor, TestActor] {
  return BigInt(a.entityId) < BigInt(b.entityId) ? [a, b] : [b, a];
}

async function signDepositoryBatch(
  depository: Depository,
  entityId: string,
  privateKey: string,
  batch: Record<string, unknown>,
  nonce?: bigint,
): Promise<{ encodedBatch: string; hankoData: string; nonce: bigint; batchHash: string }> {
  const encodedBatch = encodeBatch(batch);
  const nextNonce = nonce ?? (await depository.entityNonces(entityId)) + 1n;
  const batchHash = await computeDepositoryBatchHash(depository, encodedBatch, nextNonce);
  return {
    encodedBatch,
    hankoData: buildSingleSignerHanko(entityId, batchHash, privateKey),
    nonce: nextNonce,
    batchHash,
  };
}

function signEntityHash(entityId: string, hash: string, privateKey: string): string {
  return buildSingleSignerHanko(entityId, hash, privateKey);
}

async function accountKeyFor(depository: Depository, left: string, right: string): Promise<string> {
  return depository.accountKey(left, right);
}

async function cooperativeUpdateHash(
  depository: Depository,
  accountKey: string,
  nonce: bigint,
  diffs: unknown[],
  forgiveDebtsInTokenIds: bigint[] = [],
): Promise<string> {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return ethers.keccak256(
    abi.encode(
      ['uint8', 'uint256', 'address', 'bytes', 'uint256', SETTLEMENT_DIFFS_ABI, 'uint256[]'],
      [COOPERATIVE_UPDATE, chainId, await depository.getAddress(), accountKey, nonce, diffs, forgiveDebtsInTokenIds],
    ),
  );
}

async function disputeProofHash(
  depository: Depository,
  accountKey: string,
  nonce: bigint,
  proofbodyHash: string,
  watchSeed: string = TEST_WATCH_SEED,
): Promise<string> {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return ethers.keccak256(
    abi.encode(
      ['uint8', 'uint256', 'address', 'bytes', 'uint256', 'bytes32', 'bytes32'],
      [DISPUTE_PROOF, chainId, await depository.getAddress(), accountKey, nonce, proofbodyHash, watchSeed],
    ),
  );
}

async function cooperativeDisputeProofHash(
  depository: Depository,
  accountKey: string,
  nonce: bigint,
  proofbody: Record<string, unknown>,
  starterInitialArguments: string,
): Promise<string> {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return ethers.keccak256(
    abi.encode(
      ['uint8', 'uint256', 'address', 'bytes', 'uint256', 'bytes32', 'bytes32'],
      [
        COOPERATIVE_DISPUTE_PROOF,
        chainId,
        await depository.getAddress(),
        accountKey,
        nonce,
        proofBodyHash(proofbody),
        ethers.keccak256(starterInitialArguments),
      ],
    ),
  );
}

async function watchtowerCounterDisputeHash(
  depository: Depository,
  tower: string,
  entityId: string,
  counterentity: string,
  finalNonce: bigint,
  finalProofbodyHash: string,
  lastResortWindowBlocks: bigint,
  appointmentSequence: bigint,
): Promise<string> {
  return depository.computeWatchtowerCounterDisputeHash(
    tower,
    entityId,
    counterentity,
    finalNonce,
    finalProofbodyHash,
    lastResortWindowBlocks,
    appointmentSequence,
  );
}

function proofBodyHash(proofbody: Record<string, unknown>): string {
  return ethers.keccak256(abi.encode([PROOF_BODY_ABI], [proofbody]));
}

function proofBody(offdeltas: bigint[], tokenIds: bigint[], transformers: unknown[] = []): Record<string, unknown> {
  return {
    watchSeed: TEST_WATCH_SEED,
    offdeltas,
    tokenIds,
    transformers,
  };
}

function secret(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function hashNode(node: string): string {
  return ethers.keccak256(abi.encode(['bytes32'], [node]));
}

function hashSteps(node: string, steps: number): string {
  let current = node;
  for (let i = 0; i < steps; i++) current = hashNode(current);
  return current;
}

function nibbles(fillRatio: number): number[] {
  return [(fillRatio >> 12) & 0x0f, (fillRatio >> 8) & 0x0f, (fillRatio >> 4) & 0x0f, fillRatio & 0x0f];
}

function partialRoot(roots: string[]): string {
  return ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32', 'bytes32', 'bytes32'], roots));
}

function buildHashLadderProof(
  label: string,
  fillRatio: number,
): {
  fullSecret: string;
  fullHash: string;
  partialRoot: string;
  reveals: string[];
} {
  const fullSecret = secret(`${label}:full`);
  const bases = [0, 1, 2, 3].map(index => secret(`${label}:n${index}`));
  const roots = bases.map(base => hashSteps(base, 15));
  const reveals = nibbles(fillRatio).map((digit, index) => hashSteps(bases[index], 15 - digit));
  return {
    fullSecret,
    fullHash: hashNode(fullSecret),
    partialRoot: partialRoot(roots),
    reveals,
  };
}

function encodeDeltaTransformerArguments(
  fillRatios: number[] = [],
  secrets: string[] = [],
  pulls: string[] = [],
): string {
  return abi.encode(['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'], [{ fillRatios, secrets, pulls }]);
}

function encodePartialPullBinary(fillRatio: number, reveals: string[]): string {
  return `0x${fillRatio.toString(16).padStart(4, '0')}${reveals.map(reveal => reveal.slice(2)).join('')}`;
}

describe('Depository', () => {
  let user0: HardhatEthersSigner;

  let user1: HardhatEthersSigner;

  let depository: Depository;

  let erc20: Contract;

  let erc721: Contract;

  let erc1155: Contract;

  async function deployFixture() {
    [user0, user1] = await hre.ethers.getSigners();

    // Deploy EntityProvider
    const entityProvider = await deployEntityProvider(user0.address);

    // Deploy Account library first
    const AccountFactory = await hre.ethers.getContractFactory('Account');
    const account = await AccountFactory.deploy();
    await account.waitForDeployment();

    // Deploy Depository with Account library linked
    const DepositoryFactory = await hre.ethers.getContractFactory('Depository', {
      libraries: {
        Account: await account.getAddress(),
      },
    });
    depository = await DepositoryFactory.deploy(await entityProvider.getAddress(), 5760);
    await depository.waitForDeployment();

    // Deploy ERC20 mock contract
    const ERC20Mock = await hre.ethers.getContractFactory('ERC20Mock');
    erc20 = await ERC20Mock.deploy('ERC20Mock', 'ERC20', 18, 1_000_000);
    await erc20.waitForDeployment();

    // Deploy ERC721 mock contract
    const ERC721Mock = await hre.ethers.getContractFactory('ERC721Mock');
    erc721 = await ERC721Mock.deploy('ERC721Mock', 'ERC721');
    await erc721.waitForDeployment();
    await erc721.mint(user0.address, 1);

    // Deploy ERC1155 mock contract
    const ERC1155Mock = await hre.ethers.getContractFactory('ERC1155Mock');
    erc1155 = await ERC1155Mock.deploy();
    await erc1155.waitForDeployment();
    await erc1155.mint(user0.address, 0, 100, '0x');

    return { depository, erc20, erc721, erc1155, user0, user1 };
  }

  async function registerFixedSupplyErc20(target: Depository, supply: bigint): Promise<bigint> {
    const ERC20Mock = await hre.ethers.getContractFactory('ERC20Mock');
    const token = await ERC20Mock.deploy('Fixed Supply', 'FIX', 18, supply);
    await token.waitForDeployment();
    await (await target.registerExternalToken(0, await token.getAddress(), 0)).wait();
    return (await target.getTokensLength()) - 1n;
  }

  type TransformerClauseInput = {
    transformerAddress: string;
    encodedBatch: string;
    allowances: Array<{
      deltaIndex: bigint;
      rightAllowance: bigint;
      leftAllowance: bigint;
    }>;
  };

  async function buildTimedOutTransformerFinalization(
    target: Depository,
    tokenIds: bigint[],
    offdeltas: bigint[],
    transformers: TransformerClauseInput[],
    argumentOverrides: {
      leftArguments?: string;
      rightArguments?: string;
      skipFunding?: boolean;
    } = {},
  ) {
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const collateralPerToken = 100n;

    if (!argumentOverrides.skipFunding) {
      for (const tokenId of tokenIds) {
        await target.mintToReserve(left.entityId, tokenId, collateralPerToken);
      }
      const funding = await signDepositoryBatch(
        target,
        left.entityId,
        left.privateKey,
        emptyBatch({
          reserveToCollateral: tokenIds.map(tokenId => ({
            tokenId,
            receivingEntity: left.entityId,
            pairs: [{ entity: right.entityId, amount: collateralPerToken }],
          })),
        }),
      );
      await target.connect(left.signer).processBatch(funding.encodedBatch, funding.hankoData, funding.nonce);
    }

    const finalProofbody = proofBody(offdeltas, tokenIds, transformers);
    const finalProofbodyHash = proofBodyHash(finalProofbody);
    const accountKey = await accountKeyFor(target, left.entityId, right.entityId);
    const disputeNonce = 1n;
    const argumentList = abi.encode(['bytes[]'], [transformers.map(() => '0x')]);
    const leftArguments = argumentOverrides.leftArguments ?? argumentList;
    const rightArguments = argumentOverrides.rightArguments ?? '0x';
    const startHash = await disputeProofHash(target, accountKey, disputeNonce, finalProofbodyHash);
    const start = await signDepositoryBatch(
      target,
      left.entityId,
      left.privateKey,
      emptyBatch({
        disputeStarts: [
          {
            counterentity: right.entityId,
            nonce: disputeNonce,
            proofbodyHash: finalProofbodyHash,
            initialProofbody: finalProofbody,
            watchSeed: TEST_WATCH_SEED,
            sig: signEntityHash(right.entityId, startHash, right.privateKey),
            starterInitialArguments: leftArguments,
            starterIncrementedArguments: '0x',
          },
        ],
      }),
    );
    await target.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);
    await mine(Number(await target.defaultDisputeDelay()));

    const finalization = {
      counterentity: right.entityId,
      initialNonce: disputeNonce,
      finalNonce: disputeNonce,
      initialProofbodyHash: finalProofbodyHash,
      finalProofbody,
      starterArguments: leftArguments,
      otherArguments: rightArguments,
      sig: '0x',
      startedByLeft: true,
      cooperative: false,
    };
    const final = await signDepositoryBatch(
      target,
      left.entityId,
      left.privateKey,
      emptyBatch({ disputeFinalizations: [finalization] }),
    );
    return { accountKey, final, finalization, left, right };
  }

  function decodedEvents(receipt: ContractTransactionReceipt | null, name: string) {
    if (!receipt) throw new Error(`MISSING_RECEIPT:${name}`);
    const fragment = depository.interface.getEvent(name);
    if (!fragment) throw new Error(`MISSING_EVENT_ABI:${name}`);
    return receipt.logs
      .filter(log => log.topics[0] === fragment.topicHash)
      .map(log => depository.interface.decodeEventLog(fragment, log.data, log.topics));
  }

  it('rejects watchtower counter-dispute from the wrong tower or without a newer signed proof', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [, , tower, wrongTower] = await hre.ethers.getSigners();

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    const appointmentSequence = 3n;
    const lastResortWindowBlocks = 12n;
    await depository.mintToReserve(left.entityId, tokenId, 1_000n);

    const fundCollateralBatch = emptyBatch({
      reserveToCollateral: [
        {
          tokenId,
          receivingEntity: left.entityId,
          pairs: [{ entity: right.entityId, amount: 300n }],
        },
      ],
    });
    const fundCollateral = await signDepositoryBatch(depository, left.entityId, left.privateKey, fundCollateralBatch);
    await depository
      .connect(left.signer)
      .processBatch(fundCollateral.encodedBatch, fundCollateral.hankoData, fundCollateral.nonce);

    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const initialProofbody = proofBody([0n], [tokenId]);
    const initialProofbodyHash = proofBodyHash(initialProofbody);
    const starterInitialArguments = '0x';
    const disputeNonce = 1n;
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, initialProofbodyHash);
    const startSig = signEntityHash(right.entityId, startHash, right.privateKey);
    const startBatch = emptyBatch({
      disputeStarts: [
        {
          counterentity: right.entityId,
          nonce: disputeNonce,
          proofbodyHash: initialProofbodyHash,
          initialProofbody,
          watchSeed: TEST_WATCH_SEED,
          sig: startSig,
          starterInitialArguments,
          starterIncrementedArguments: '0x',
        },
      ],
    });
    const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, startBatch);
    await depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    const finalNonce = 2n;
    const finalProofbody = proofBody([-200n], [tokenId]);
    const finalProofbodyHash = proofBodyHash(finalProofbody);
    const finalHash = await disputeProofHash(depository, acctKey, finalNonce, finalProofbodyHash);
    const finalSig = signEntityHash(right.entityId, finalHash, right.privateKey);
    const ownerAuthHash = await watchtowerCounterDisputeHash(
      depository,
      tower.address,
      left.entityId,
      right.entityId,
      finalNonce,
      finalProofbodyHash,
      lastResortWindowBlocks,
      appointmentSequence,
    );
    const ownerAuthorization = signEntityHash(left.entityId, ownerAuthHash, left.privateKey);
    const finalization = {
      counterentity: right.entityId,
      initialNonce: disputeNonce,
      finalNonce,
      initialProofbodyHash,
      finalProofbody,
      starterArguments: '0x',
      otherArguments: '0x',
      sig: finalSig,
      startedByLeft: true,
      cooperative: false,
    };

    const currentBlock = BigInt(await time.latestBlock());
    const timeoutBlock = (await depository._accounts(acctKey)).disputeTimeout;
    const lastResortStartBlock = timeoutBlock - lastResortWindowBlocks;
    if (lastResortStartBlock > currentBlock) {
      await mine(Number(lastResortStartBlock - currentBlock));
    }

    await expect(
      depository
        .connect(wrongTower)
        .watchtowerCounterDispute(
          left.entityId,
          finalization,
          lastResortWindowBlocks,
          appointmentSequence,
          ownerAuthorization,
        ),
    ).to.be.revertedWithCustomError(depository, 'E4');

    const sameProof = {
      ...finalization,
      finalNonce: disputeNonce,
      sig: '0x',
    };
    await expect(
      depository
        .connect(tower)
        .watchtowerCounterDispute(
          left.entityId,
          sameProof,
          lastResortWindowBlocks,
          appointmentSequence,
          ownerAuthorization,
        ),
    ).to.be.revertedWithCustomError(depository, 'E2');
  });

  it('passes dispute argument timestamps into DeltaTransformer pull without storing secrets', async function () {
    const { depository } = await loadFixture(deployFixture);
    const DeltaTransformer = await ethers.getContractFactory('DeltaTransformer');
    const transformer = await DeltaTransformer.deploy();
    await transformer.waitForDeployment();

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenA = 1n;
    const tokenB = 2n;
    await depository.mintToReserve(right.entityId, tokenA, 1_000n);
    await depository.mintToReserve(left.entityId, tokenB, 1_000n);

    const fundRightCollateral = emptyBatch({
      reserveToCollateral: [
        {
          tokenId: tokenA,
          receivingEntity: right.entityId,
          pairs: [{ entity: left.entityId, amount: 1_000n }],
        },
      ],
    });
    const rightFund = await signDepositoryBatch(depository, right.entityId, right.privateKey, fundRightCollateral);
    await depository.connect(right.signer).processBatch(rightFund.encodedBatch, rightFund.hankoData, rightFund.nonce);

    const fundLeftCollateral = emptyBatch({
      reserveToCollateral: [
        {
          tokenId: tokenB,
          receivingEntity: left.entityId,
          pairs: [{ entity: right.entityId, amount: 1_000n }],
        },
      ],
    });
    const leftFund = await signDepositoryBatch(depository, left.entityId, left.privateKey, fundLeftCollateral);
    await depository.connect(left.signer).processBatch(leftFund.encodedBatch, leftFund.hankoData, leftFund.nonce);

    const fillRatio = 0x0123;
    const pullProof = buildHashLadderProof('depository-cross-pull', fillRatio);
    const revealDeadline = (await time.latest()) + 10;
    const encodedPullBatch = await transformer.encodeBatch({
      payment: [],
      swap: [],
      pull: [
        {
          deltaIndex: 1,
          amount: -MAX_FILL_RATIO,
          claimedRatio: 0,
          revealedUntilTimestamp: revealDeadline,
          fullHash: pullProof.fullHash,
          partialRoot: pullProof.partialRoot,
        },
      ],
    });
    const proofbody = proofBody(
      [0n, 0n],
      [tokenA, tokenB],
      [
        {
          transformerAddress: await transformer.getAddress(),
          encodedBatch: encodedPullBatch,
          allowances: [{ deltaIndex: 1n, rightAllowance: BigInt(fillRatio), leftAllowance: 0n }],
        },
      ],
    );
    const proofbodyHash = proofBodyHash(proofbody);
    const rightTransformerArgs = encodeDeltaTransformerArguments(
      [],
      [],
      [encodePartialPullBinary(fillRatio, pullProof.reveals)],
    );
    const starterInitialArguments = abi.encode(['bytes[]'], [[rightTransformerArgs]]);
    const disputeNonce = 1n;
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, proofbodyHash);
    const startSig = signEntityHash(left.entityId, startHash, left.privateKey);
    const startBatch = emptyBatch({
      disputeStarts: [
        {
          counterentity: left.entityId,
          nonce: disputeNonce,
          proofbodyHash,
          initialProofbody: proofbody,
          watchSeed: TEST_WATCH_SEED,
          sig: startSig,
          starterInitialArguments,
          starterIncrementedArguments: '0x',
        },
      ],
    });
    const start = await signDepositoryBatch(depository, right.entityId, right.privateKey, startBatch);
    await depository.connect(right.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    const startedAccount = await depository._accounts(acctKey);
    expect(startedAccount.disputeStartTimestamp).to.be.lessThanOrEqual(BigInt(revealDeadline));
    await mine(Number(await depository.defaultDisputeDelay()));

    const finalization = {
      counterentity: left.entityId,
      initialNonce: disputeNonce,
      finalNonce: disputeNonce,
      initialProofbodyHash: proofbodyHash,
      finalProofbody: proofbody,
      starterArguments: starterInitialArguments,
      otherArguments: '0x',
      sig: '0x',
      startedByLeft: false,
      cooperative: false,
    };
    const finalBatch = emptyBatch({ disputeFinalizations: [finalization] });
    const final = await signDepositoryBatch(depository, right.entityId, right.privateKey, finalBatch);
    await depository.connect(right.signer).processBatch(final.encodedBatch, final.hankoData, final.nonce);

    expect(await transformer.hashToBlock(hashNode(pullProof.reveals[3]))).to.equal(0n);
    expect(await depository._reserves(left.entityId, tokenB)).to.equal(1_000n - BigInt(fillRatio));
    expect(await depository._reserves(right.entityId, tokenB)).to.equal(BigInt(fillRatio));
  });

  it('locks outstanding debt before reserve outflows and pays FIFO debt in bounded chunks', async function () {
    const { depository } = await loadFixture(deployFixture);

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const recipient = addressEntityId(user1.address);
    const tokenId = await registerFixedSupplyErc20(depository, 1_000_000n);
    await depository.mintToReserve(left.entityId, tokenId, 100n);

    const fundCollateralBatch = emptyBatch({
      reserveToCollateral: [
        {
          tokenId,
          receivingEntity: left.entityId,
          pairs: [{ entity: right.entityId, amount: 100n }],
        },
      ],
    });
    const fundCollateral = await signDepositoryBatch(depository, left.entityId, left.privateKey, fundCollateralBatch);
    await depository
      .connect(left.signer)
      .processBatch(fundCollateral.encodedBatch, fundCollateral.hankoData, fundCollateral.nonce);

    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const initialProofbody = proofBody([0n], [tokenId]);
    const initialProofbodyHash = proofBodyHash(initialProofbody);
    const starterInitialArguments = '0x';
    const disputeNonce = 1n;
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, initialProofbodyHash);
    const startSig = signEntityHash(right.entityId, startHash, right.privateKey);
    const startBatch = emptyBatch({
      disputeStarts: [
        {
          counterentity: right.entityId,
          nonce: disputeNonce,
          proofbodyHash: initialProofbodyHash,
          initialProofbody,
          watchSeed: TEST_WATCH_SEED,
          sig: startSig,
          starterInitialArguments,
          starterIncrementedArguments: '0x',
        },
      ],
    });
    const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, startBatch);
    await depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    const finalNonce = 2n;
    const finalProofbody = proofBody([-300n], [tokenId]);
    const finalHash = await disputeProofHash(depository, acctKey, finalNonce, proofBodyHash(finalProofbody));
    const finalSig = signEntityHash(right.entityId, finalHash, right.privateKey);
    const finalBatch = emptyBatch({
      disputeFinalizations: [
        {
          counterentity: right.entityId,
          initialNonce: disputeNonce,
          finalNonce,
          initialProofbodyHash,
          finalProofbody,
          starterArguments: '0x',
          otherArguments: '0x',
          sig: finalSig,
          startedByLeft: true,
          cooperative: false,
        },
      ],
    });
    const finalization = await signDepositoryBatch(depository, left.entityId, left.privateKey, finalBatch);
    await depository
      .connect(left.signer)
      .processBatch(finalization.encodedBatch, finalization.hankoData, finalization.nonce);

    expect(await depository._reserves(left.entityId, tokenId)).to.equal(0n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(100n);
    expect(await depository.debtOutstanding(left.entityId, tokenId)).to.equal(200n);
    expect(await depository._activeDebtsByToken(left.entityId, tokenId)).to.equal(1n);

    await depository.mintToReserve(left.entityId, tokenId, 100n);

    const independentTokenId = await registerFixedSupplyErc20(depository, 1_000_000n);
    await depository.mintToReserve(left.entityId, independentTokenId, 7n);
    const blockedBatch = emptyBatch({
      reserveToReserve: [
        { receivingEntity: recipient, tokenId, amount: 1n },
        { receivingEntity: recipient, tokenId: independentTokenId, amount: 7n },
      ],
    });
    const blocked = await signDepositoryBatch(depository, left.entityId, left.privateKey, blockedBatch);
    await expect(depository.connect(left.signer).processBatch(blocked.encodedBatch, blocked.hankoData, blocked.nonce))
      .to.be.revertedWithCustomError(depository, 'E3');

    expect(await depository._reserves(left.entityId, tokenId)).to.equal(100n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(100n);
    expect(await depository._reserves(recipient, tokenId)).to.equal(0n);
    expect(await depository.debtOutstanding(left.entityId, tokenId)).to.equal(200n);
    expect(await depository._reserves(left.entityId, independentTokenId)).to.equal(7n);
    expect(await depository._reserves(recipient, independentTokenId)).to.equal(0n);

    const incomingSettlementNonce = 3n;
    const incomingSettlementDiffs = [
      {
        tokenId,
        leftDiff: 100n,
        rightDiff: -100n,
        collateralDiff: 0n,
        ondeltaDiff: 0n,
      },
    ];
    const incomingSettlementSig = signEntityHash(
      right.entityId,
      await cooperativeUpdateHash(depository, acctKey, incomingSettlementNonce, incomingSettlementDiffs),
      right.privateKey,
    );
    const blockedSettlementNonce = 4n;
    const blockedSettlementDiffs = [
      {
        tokenId,
        leftDiff: -100n,
        rightDiff: 100n,
        collateralDiff: 0n,
        ondeltaDiff: 0n,
      },
    ];
    const blockedSettlementSig = signEntityHash(
      right.entityId,
      await cooperativeUpdateHash(depository, acctKey, blockedSettlementNonce, blockedSettlementDiffs),
      right.privateKey,
    );
    const blockedSettlementBatch = emptyBatch({
      settlements: [
        {
          leftEntity: left.entityId,
          rightEntity: right.entityId,
          diffs: incomingSettlementDiffs,
          forgiveDebtsInTokenIds: [],
          sig: incomingSettlementSig,
          nonce: incomingSettlementNonce,
        },
        {
          leftEntity: left.entityId,
          rightEntity: right.entityId,
          diffs: blockedSettlementDiffs,
          forgiveDebtsInTokenIds: [],
          sig: blockedSettlementSig,
          nonce: blockedSettlementNonce,
        },
      ],
    });
    const blockedSettlement = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      blockedSettlementBatch,
    );
    await expect(
      depository
        .connect(left.signer)
        .processBatch(blockedSettlement.encodedBatch, blockedSettlement.hankoData, blockedSettlement.nonce),
    )
      .to.be.revertedWithCustomError(depository, 'E3');

    expect((await depository._accounts(acctKey)).nonce).to.equal(finalNonce);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(100n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(100n);
    expect(await depository.debtOutstanding(left.entityId, tokenId)).to.equal(200n);

    await depository.enforceDebts(left.entityId, tokenId, 32);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(0n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(200n);
    expect(await depository.debtOutstanding(left.entityId, tokenId)).to.equal(100n);

    await depository.mintToReserve(left.entityId, tokenId, 150n);
    const spendableTransferBatch = emptyBatch({
      reserveToReserve: [{ receivingEntity: recipient, tokenId, amount: 50n }],
    });
    const spendableTransfer = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      spendableTransferBatch,
    );
    await depository
      .connect(left.signer)
      .processBatch(spendableTransfer.encodedBatch, spendableTransfer.hankoData, spendableTransfer.nonce);

    expect(await depository._reserves(left.entityId, tokenId)).to.equal(0n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(300n);
    expect(await depository._reserves(recipient, tokenId)).to.equal(50n);
    expect(await depository.debtOutstanding(left.entityId, tokenId)).to.equal(0n);
    expect(await depository._activeDebtsByToken(left.entityId, tokenId)).to.equal(0n);
  });

  it('requires timeout for unilateral dispute finalization and bumps account nonce once', async function () {
    const { depository } = await loadFixture(deployFixture);

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const finalProofbody = proofBody([], []);
    const finalProofbodyHash = proofBodyHash(finalProofbody);
    const starterInitialArguments = '0x';
    const disputeNonce = 1n;

    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, finalProofbodyHash);
    const startSig = signEntityHash(right.entityId, startHash, right.privateKey);
    const startBatch = emptyBatch({
      disputeStarts: [
        {
          counterentity: right.entityId,
          nonce: disputeNonce,
          proofbodyHash: finalProofbodyHash,
          initialProofbody: finalProofbody,
          watchSeed: TEST_WATCH_SEED,
          sig: startSig,
          starterInitialArguments,
          starterIncrementedArguments: '0x',
        },
      ],
    });
    const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, startBatch);
    await depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    const finalization = {
      counterentity: right.entityId,
      initialNonce: disputeNonce,
      finalNonce: disputeNonce,
      initialProofbodyHash: finalProofbodyHash,
      finalProofbody,
      starterArguments: starterInitialArguments,
      otherArguments: '0x',
      sig: '0x',
      startedByLeft: true,
      cooperative: false,
    };

    const tooEarlyBatch = emptyBatch({ disputeFinalizations: [finalization] });
    const tooEarly = await signDepositoryBatch(depository, left.entityId, left.privateKey, tooEarlyBatch);
    await expect(
      depository.connect(left.signer).processBatch(tooEarly.encodedBatch, tooEarly.hankoData, tooEarly.nonce),
    ).to.be.revertedWithCustomError(depository, 'E2');

    await mine(Number(await depository.defaultDisputeDelay()));

    const afterTimeout = await signDepositoryBatch(depository, left.entityId, left.privateKey, tooEarlyBatch);
    await depository
      .connect(left.signer)
      .processBatch(afterTimeout.encodedBatch, afterTimeout.hankoData, afterTimeout.nonce);

    const account = await depository._accounts(acctKey);
    expect(account.nonce).to.equal(2n);
    expect(account.disputeHash).to.equal(ethers.ZeroHash);
    expect(account.disputeTimeout).to.equal(0n);
  });

  it('cooperatively finalizes an existing account without an active dispute', async function () {
    const { depository } = await loadFixture(deployFixture);

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    await depository.mintToReserve(left.entityId, tokenId, 500n);

    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const settlementNonce = 1n;
    const diffs = [
      {
        tokenId,
        leftDiff: -100n,
        rightDiff: 100n,
        collateralDiff: 0n,
        ondeltaDiff: 0n,
      },
    ];
    const settlementSig = signEntityHash(
      right.entityId,
      await cooperativeUpdateHash(depository, acctKey, settlementNonce, diffs),
      right.privateKey,
    );
    const settlementBatch = emptyBatch({
      settlements: [
        {
          leftEntity: left.entityId,
          rightEntity: right.entityId,
          diffs,
          forgiveDebtsInTokenIds: [],
          sig: settlementSig,
          nonce: settlementNonce,
        },
      ],
    });
    const settlement = await signDepositoryBatch(depository, left.entityId, left.privateKey, settlementBatch);
    await depository.connect(left.signer).processBatch(settlement.encodedBatch, settlement.hankoData, settlement.nonce);

    const finalNonce = 2n;
    const finalProofbody = proofBody([], []);
    const cooperativeHash = await cooperativeDisputeProofHash(depository, acctKey, finalNonce, finalProofbody, '0x');
    const cooperativeSig = signEntityHash(right.entityId, cooperativeHash, right.privateKey);
    const closeBatch = emptyBatch({
      disputeFinalizations: [
        {
          counterentity: right.entityId,
          initialNonce: settlementNonce,
          finalNonce,
          initialProofbodyHash: ethers.ZeroHash,
          finalProofbody,
          starterArguments: '0x',
          otherArguments: '0x',
          sig: cooperativeSig,
          startedByLeft: false,
          cooperative: true,
        },
      ],
    });
    const close = await signDepositoryBatch(depository, left.entityId, left.privateKey, closeBatch);

    await depository.connect(left.signer).processBatch(close.encodedBatch, close.hankoData, close.nonce);
    expect((await depository._accounts(acctKey)).nonce).to.equal(finalNonce);
  });

  it('aggregates duplicate-token flashloans before enforcing repayment', async function () {
    const { depository } = await loadFixture(deployFixture);

    const actor = lazyActor(user0, 0);
    const recipient = addressEntityId(user1.address);
    const tokenId = 1n;

    const exploitBatch = emptyBatch({
      flashloans: [
        { tokenId, amount: 10n },
        { tokenId, amount: 10n },
      ],
      reserveToReserve: [{ receivingEntity: recipient, tokenId, amount: 10n }],
    });
    const exploit = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, exploitBatch);

    await expect(
      depository.connect(user0).processBatch(exploit.encodedBatch, exploit.hankoData, exploit.nonce),
    ).to.be.revertedWithCustomError(depository, 'E3');

    expect(await depository.entityNonces(actor.entityId)).to.equal(0n);
    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(0n);
    expect(await depository._reserves(recipient, tokenId)).to.equal(0n);
  });

  it('rejects non-admin use of local dev bootstrap helpers', async function () {
    const { depository, erc20 } = await loadFixture(deployFixture);
    const entity = addressEntityId(user1.address);

    await expect(depository.connect(user1).mintToReserve(entity, 1, 1n)).to.be.revertedWithCustomError(
      depository,
      'E2',
    );

    await erc20.connect(user1).approve(await depository.getAddress(), 1n);
    await expect(
      depository.connect(user1).adminRegisterExternalToken({
        entity: ethers.ZeroHash,
        contractAddress: await erc20.getAddress(),
        externalTokenId: 0,
        tokenType: 0,
        internalTokenId: 0,
        amount: 1n,
      }),
    ).to.be.revertedWithCustomError(depository, 'E2');
  });
});
