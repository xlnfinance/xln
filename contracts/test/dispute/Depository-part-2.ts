import { expect } from 'chai';

import hre from 'hardhat';

const { ethers, networkHelpers } = await hre.network.getOrCreate('hardhat');
const { loadFixture, mine, time } = networkHelpers;

import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers.js';

import type { Depository, EntityProvider } from '../../typechain-types/index.js';

import { Contract, type ContractTransactionReceipt } from 'ethers';

import {
  addressEntityId,
  buildSingleSignerHanko,
  canonicalAccountKey,
  computeDepositoryBatchHash,
  deployDepositoryStack,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  encodeSingleSignerBoard,
  foundationListExternalToken,
  singleSignerLazyEntityId,
} from '../helpers/hanko.ts';

const abi = ethers.AbiCoder.defaultAbiCoder();

const COOPERATIVE_UPDATE = 0;

const DISPUTE_PROOF = 1;

const COOPERATIVE_DISPUTE_PROOF = 3;

const MAX_FILL_RATIO = 65535n;

const SETTLEMENT_DIFFS_ABI =
  'tuple(uint256 tokenId,int256 leftDiff,int256 rightDiff,int256 collateralDiff,int256 ondeltaDiff)[]';

const PROOF_BODY_ABI =
  'tuple(bytes32 watchSeed,uint32 leftResponseSeconds,uint32 rightResponseSeconds,int256[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)';

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
  void depository;
  return canonicalAccountKey(left, right);
}

async function advancePastDisputeTimeout(
  target: Depository,
  left: string,
  right: string,
): Promise<void> {
  const key = canonicalAccountKey(left, right);
  const timeout = (await target._accounts(key)).disputeTimeout;
  await time.increaseTo(Number(timeout + 1n));
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
  proposerIsLeft = false,
): Promise<string> {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return ethers.keccak256(
    abi.encode(
      ['uint8', 'uint256', 'address', 'bytes', 'uint256', 'bool', 'bytes32', 'bytes32'],
      [DISPUTE_PROOF, chainId, await depository.getAddress(), accountKey, nonce, proposerIsLeft, proofbodyHash, watchSeed],
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
  lastResortWindowSeconds: bigint,
  appointmentSequence: bigint,
): Promise<string> {
  return depository.computeWatchtowerCounterDisputeHash(
    tower,
    entityId,
    counterentity,
    finalNonce,
    finalProofbodyHash,
    lastResortWindowSeconds,
    appointmentSequence,
  );
}

function proofBodyHash(proofbody: Record<string, unknown>): string {
  return ethers.keccak256(abi.encode([PROOF_BODY_ABI], [proofbody]));
}

function proofBody(offdeltas: bigint[], tokenIds: bigint[], transformers: unknown[] = []): Record<string, unknown> {
  return {
    watchSeed: TEST_WATCH_SEED,
    leftResponseSeconds: 50,
    rightResponseSeconds: 50,
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
): string {
  return abi.encode(['tuple(uint16[] fillRatios, bytes32[] secrets)'], [{ fillRatios, secrets }]);
}

describe('Depository', () => {
  let user0: HardhatEthersSigner;

  let user1: HardhatEthersSigner;

  let depository: Depository;

  let entityProvider: EntityProvider;

  let erc20: Contract;

  let erc721: Contract;

  let erc1155: Contract;

  async function deployFixture() {
    [user0, user1] = await ethers.getSigners();

    // Deploy EntityProvider
    entityProvider = await deployEntityProvider(user0.address);

    const stack = await deployDepositoryStack(await entityProvider.getAddress());
    depository = stack.depository;

    // Deploy ERC20 mock contract
    const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
    erc20 = await ERC20Mock.deploy('ERC20Mock', 'ERC20', 18, 1_000_000);
    await erc20.waitForDeployment();

    // Deploy ERC721 mock contract
    const ERC721Mock = await ethers.getContractFactory('ERC721Mock');
    erc721 = await ERC721Mock.deploy('ERC721Mock', 'ERC721');
    await erc721.waitForDeployment();
    await erc721.mint(user0.address, 1);

    // Deploy ERC1155 mock contract
    const ERC1155Mock = await ethers.getContractFactory('ERC1155Mock');
    erc1155 = await ERC1155Mock.deploy();
    await erc1155.waitForDeployment();
    await erc1155.mint(user0.address, 0, 100, '0x');

    return {
      depository,
      deltaTransformer: stack.deltaTransformer,
      erc20,
      erc721,
      erc1155,
      user0,
      user1,
    };
  }

  // Listing is a Foundation action routed through the EntityProvider.
  async function listExternalToken(
    target: Depository,
    tokenType: number,
    contractAddress: string,
    externalTokenId: bigint | number = 0,
  ): Promise<void> {
    await foundationListExternalToken(entityProvider, await target.getAddress(), tokenType, contractAddress, externalTokenId);
  }

  async function registerFixedSupplyErc20(target: Depository, supply: bigint): Promise<bigint> {
    const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
    const token = await ERC20Mock.deploy('Fixed Supply', 'FIX', 18, supply);
    await token.waitForDeployment();
    await listExternalToken(target, 0, await token.getAddress(), 0);
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
            starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
          },
        ],
      }),
    );
    await target.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);
    await advancePastDisputeTimeout(target, left.entityId, right.entityId);

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
    const [, , tower, wrongTower] = await ethers.getSigners();

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    const appointmentSequence = 3n;
    const lastResortWindowSeconds = 12n;
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
          proposerIsLeft: false,
          proofbodyHash: initialProofbodyHash,
          initialProofbody,
          watchSeed: TEST_WATCH_SEED,
          sig: startSig,
          starterInitialArguments,
          starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        },
      ],
    });
    const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, startBatch);
    await depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    const finalNonce = 2n;
    const finalProofbody = proofBody([-200n], [tokenId]);
    const finalProofbodyHash = proofBodyHash(finalProofbody);
    const finalHash = await disputeProofHash(
      depository,
      acctKey,
      finalNonce,
      finalProofbodyHash,
      TEST_WATCH_SEED,
      true,
    );
    const finalSig = signEntityHash(left.entityId, finalHash, left.privateKey);
    const ownerAuthHash = await watchtowerCounterDisputeHash(
      depository,
      tower.address,
      right.entityId,
      left.entityId,
      finalNonce,
      finalProofbodyHash,
      lastResortWindowSeconds,
      appointmentSequence,
    );
    const ownerAuthorization = signEntityHash(right.entityId, ownerAuthHash, right.privateKey);
    const finalization = {
      counterentity: left.entityId,
      initialNonce: disputeNonce,
      finalNonce,
      proposerIsLeft: true,
      initialProofbodyHash,
      finalProofbody,
      starterArguments: '0x',
      otherArguments: '0x',
      sig: finalSig,
      startedByLeft: true,
      cooperative: false,
    };

    const currentTimestamp = BigInt(await time.latest());
    const timeoutTimestamp = (await depository._accounts(acctKey)).disputeTimeout;
    const lastResortStartTimestamp = timeoutTimestamp - lastResortWindowSeconds;
    if (lastResortStartTimestamp > currentTimestamp) {
      await time.increaseTo(Number(lastResortStartTimestamp));
    }

    await expect(
      depository
        .connect(wrongTower)
        .watchtowerCounterDispute(
          right.entityId,
          finalization,
          lastResortWindowSeconds,
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
          right.entityId,
          sameProof,
          lastResortWindowSeconds,
          appointmentSequence,
          ownerAuthorization,
        ),
    ).to.be.revertedWithCustomError(depository, 'E2');
  });

  it('fences watchtower appointments below watchtowerMinSequence raised by the owner board', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [, , tower] = await ethers.getSigners();

    // The fence lives on the EntityProvider per entity id, so the account owner
    // must be a NUMBERED entity (the starter stays lazy). bytes32(2) sorts first.
    await (await entityProvider.registerNumberedEntity(encodeSingleSignerBoard(user1.address))).wait();
    const ownerNumber = 2n;
    const owner: TestActor = {
      signer: user1,
      entityId: ethers.zeroPadValue(ethers.toBeHex(ownerNumber), 32),
      privateKey: deriveHardhatPrivateKey(1),
    };
    const starter = lazyActor(user0, 0);
    const [left, right] = orderedActors(owner, starter);
    expect(left).to.equal(owner);
    const tokenId = 1n;
    const lastResortWindowSeconds = 16n;

    await depository.mintToReserve(right.entityId, tokenId, 1_000n);
    const fundCollateral = await signDepositoryBatch(depository, right.entityId, right.privateKey, emptyBatch({
      reserveToCollateral: [{ tokenId, receivingEntity: right.entityId, pairs: [{ entity: left.entityId, amount: 300n }] }],
    }));
    await depository.connect(right.signer).processBatch(fundCollateral.encodedBatch, fundCollateral.hankoData, fundCollateral.nonce);

    // RIGHT starts the dispute on a proof signed by LEFT (proposerIsLeft = true).
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const initialProofbody = proofBody([0n], [tokenId]);
    const initialProofbodyHash = proofBodyHash(initialProofbody);
    const disputeNonce = 1n;
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, initialProofbodyHash, TEST_WATCH_SEED, true);
    const start = await signDepositoryBatch(depository, right.entityId, right.privateKey, emptyBatch({
      disputeStarts: [{
        counterentity: left.entityId,
        nonce: disputeNonce,
        proposerIsLeft: true,
        proofbodyHash: initialProofbodyHash,
        initialProofbody,
        watchSeed: TEST_WATCH_SEED,
        sig: signEntityHash(left.entityId, startHash, left.privateKey),
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      }],
    }));
    await depository.connect(right.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    // Newer state signed by the starter (RIGHT), submitted for the owner (LEFT) by its tower.
    const finalNonce = 2n;
    const finalProofbody = proofBody([100n], [tokenId]);
    const finalProofbodyHash = proofBodyHash(finalProofbody);
    const finalHash = await disputeProofHash(depository, acctKey, finalNonce, finalProofbodyHash, TEST_WATCH_SEED, false);
    const finalization = {
      counterentity: right.entityId,
      initialNonce: disputeNonce,
      finalNonce,
      proposerIsLeft: false,
      initialProofbodyHash,
      finalProofbody,
      starterArguments: '0x',
      otherArguments: '0x',
      sig: signEntityHash(right.entityId, finalHash, right.privateKey),
      startedByLeft: false,
      cooperative: false,
    };
    const appointment = async (sequence: bigint) => signEntityHash(
      left.entityId,
      await watchtowerCounterDisputeHash(
        depository, tower.address, left.entityId, right.entityId, finalNonce, finalProofbodyHash, lastResortWindowSeconds, sequence,
      ),
      left.privateKey,
    );

    // Owner raises the fence with one current-board action on the entity nonce lane.
    expect(await entityProvider.watchtowerMinSequence(left.entityId)).to.equal(0n);
    const actionNonce = await entityProvider.entityActionNonces(left.entityId) + 1n;
    const fenceHash = await entityProvider.computeWatchtowerMinSequenceHankoHash(ownerNumber, 5n, actionNonce);
    await expect(entityProvider.setWatchtowerMinSequence(ownerNumber, 5n, signEntityHash(left.entityId, fenceHash, left.privateKey)))
      .to.emit(entityProvider, 'EntityProviderActionExecuted')
      .withArgs(left.entityId, actionNonce, fenceHash, 2n);
    expect(await entityProvider.watchtowerMinSequence(left.entityId)).to.equal(5n);
    expect(await entityProvider.entityActionNonces(left.entityId)).to.equal(actionNonce);
    // Monotonic: equal or lower minimums are rejected before any signature check.
    await expect(entityProvider.setWatchtowerMinSequence(ownerNumber, 5n, '0x'))
      .to.be.revertedWithCustomError(entityProvider, 'InvalidAuthorityAuthorization');
    await expect(entityProvider.setWatchtowerMinSequence(ownerNumber, 4n, '0x'))
      .to.be.revertedWithCustomError(entityProvider, 'InvalidAuthorityAuthorization');
    // A stale-nonce Hanko (signed over nonce N) does not replay.
    await expect(entityProvider.setWatchtowerMinSequence(ownerNumber, 6n, signEntityHash(left.entityId, fenceHash, left.privateKey)))
      .to.be.revertedWith('Invalid entity signature');

    const timeoutTimestamp = (await depository._accounts(acctKey)).disputeTimeout;
    const lastResortStart = timeoutTimestamp - lastResortWindowSeconds;
    if (lastResortStart > BigInt(await time.latest())) await time.increaseTo(Number(lastResortStart));

    // Appointment sequence 4 < 5: revoked, E2 even though the owner signed it.
    await expect(
      depository.connect(tower).watchtowerCounterDispute(
        left.entityId, finalization, lastResortWindowSeconds, 4n, await appointment(4n),
      ),
    ).to.be.revertedWithCustomError(depository, 'E2');
    // Higher than the minimum is fine (checked without committing) and equal is accepted.
    expect(await depository.connect(tower).watchtowerCounterDispute.staticCall(
      left.entityId, finalization, lastResortWindowSeconds, 6n, await appointment(6n),
    )).to.equal(true);
    await expect(
      depository.connect(tower).watchtowerCounterDispute(
        left.entityId, finalization, lastResortWindowSeconds, 5n, await appointment(5n),
      ),
    )
      .to.emit(depository, 'CounterDisputeRegistered')
      .withArgs(left.entityId, right.entityId, finalNonce, false, finalProofbodyHash);
  });

  it('waits the signed window for a newer Pull proof and settles only registry evidence', async function () {
    const { depository, deltaTransformer: transformer } = await loadFixture(deployFixture);

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
    // Negative amount: the pull credits the RIGHT side, so only RIGHT's own
    // registry record may settle it.
    const encodedPullBatch = await transformer.encodeBatch({
      payment: [],
      swap: [],
      pull: [
        {
          deltaIndex: 1,
          amount: -MAX_FILL_RATIO,
          claimedRatio: 0,
          fullHash: pullProof.fullHash,
          partialRoot: pullProof.partialRoot,
          targetRole: false,
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
          starterInitialArguments: '0x',
          starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        },
      ],
    });
    const start = await signDepositoryBatch(depository, right.entityId, right.privateKey, startBatch);
    await depository.connect(right.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    // The beneficiary publishes independent Sprites-like evidence. The outer
    // batch authenticates the writer; the signed Pull later assigns meaning.
    const revealBatch = emptyBatch({
      hashLadderRegistrations: [
        {
          counterpartyEntity: left.entityId,
          targetRole: false,
          fullHash: pullProof.fullHash,
          partialRoot: pullProof.partialRoot,
          witness: {
            fillRatio,
            fullSecret: ethers.ZeroHash,
            reveals: pullProof.reveals,
          },
        },
      ],
    });
    const reveal = await signDepositoryBatch(depository, right.entityId, right.privateKey, revealBatch);
    await depository.connect(right.signer).processBatch(reveal.encodedBatch, reveal.hankoData, reveal.nonce);

    // Finalization waits for the exact sum signed by both account parties. The
    // target role owns the second response window; neither role can shorten it.
    const finalization = {
      counterentity: right.entityId,
      initialNonce: disputeNonce,
      finalNonce: disputeNonce + 1n,
      initialProofbodyHash: proofbodyHash,
      finalProofbody: proofbody,
      starterArguments: '0x',
      otherArguments: '0x',
      // Left is the non-starter and holds Right's newer signed state. Unlike a
      // pull-free counter-proof, this cannot close until both reveal phases end.
      sig: signEntityHash(
        right.entityId,
        await disputeProofHash(depository, acctKey, disputeNonce + 1n, proofbodyHash),
        right.privateKey,
      ),
      startedByLeft: false,
      cooperative: false,
    };
    const earlyBatch = emptyBatch({ disputeFinalizations: [finalization] });
    const early = await signDepositoryBatch(depository, left.entityId, left.privateKey, earlyBatch);
    await expect(
      depository.connect(left.signer).processBatch(early.encodedBatch, early.hankoData, early.nonce),
    ).to.be.revertedWithCustomError(depository, 'E2');

    const counterBatch = emptyBatch({
      counterDisputes: [{
        counterentity: right.entityId,
        initialNonce: disputeNonce,
        initialProofbodyHash: proofbodyHash,
        counterNonce: disputeNonce + 1n,
        counterProofbody: proofbody,
        sig: finalization.sig,
      }],
    });
    const counter = await signDepositoryBatch(depository, left.entityId, left.privateKey, counterBatch);
    await depository.connect(left.signer).processBatch(counter.encodedBatch, counter.hankoData, counter.nonce);

    await advancePastDisputeTimeout(depository, left.entityId, right.entityId);

    const finalBatch = emptyBatch({ disputeFinalizations: [finalization] });
    const final = await signDepositoryBatch(depository, left.entityId, left.privateKey, finalBatch);
    await depository.connect(left.signer).processBatch(final.encodedBatch, final.hankoData, final.nonce);

    // No payment-secret storage was touched: the registry path is disjoint.
    expect(await transformer.hashToTimestamp(hashNode(pullProof.reveals[3]))).to.equal(0n);
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
          starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        },
      ],
    });
    const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, startBatch);
    await depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    const finalNonce = 2n;
    const finalProofbody = proofBody([-300n], [tokenId]);
    const finalHash = await disputeProofHash(depository, acctKey, finalNonce, proofBodyHash(finalProofbody));
    const finalSig = signEntityHash(left.entityId, finalHash, left.privateKey);
    const finalBatch = emptyBatch({
      disputeFinalizations: [
        {
          counterentity: left.entityId,
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
    const finalization = await signDepositoryBatch(depository, right.entityId, right.privateKey, finalBatch);
    await depository
      .connect(right.signer)
      .processBatch(finalization.encodedBatch, finalization.hankoData, finalization.nonce);

    expect(await depository._reserves(left.entityId, tokenId)).to.equal(0n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(100n);
    expect(await depository.debtOutstanding(left.entityId, tokenId)).to.equal(200n);
    expect(await depository.activeDebts(left.entityId)).to.equal(1n);

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
    expect(await depository.activeDebts(left.entityId)).to.equal(0n);
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
          starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
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

    await advancePastDisputeTimeout(depository, left.entityId, right.entityId);

    const afterTimeout = await signDepositoryBatch(depository, left.entityId, left.privateKey, tooEarlyBatch);
    await depository
      .connect(left.signer)
      .processBatch(afterTimeout.encodedBatch, afterTimeout.hankoData, afterTimeout.nonce);

    const account = await depository._accounts(acctKey);
    expect(account.nonce).to.equal(2n);
    expect(account.disputeHash).to.equal(ethers.ZeroHash);
    expect(account.disputeTimeout).to.equal(0n);
  });

  it('rejects historical cooperative signatures as a dispute bypass', async function () {
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

    await expect(
      depository.connect(left.signer).processBatch(close.encodedBatch, close.hankoData, close.nonce),
    ).to.be.revertedWithCustomError(depository, 'E2');
    expect((await depository._accounts(acctKey)).nonce).to.equal(settlementNonce);
  });

  // ── implicit flash: Batch has no Flashloan[]; the initiator may spend ahead of
  //    holding on a token where it owes nothing, the shortfall is a deficit that
  //    later same-batch inflows repay first, and processBatch reverts E3 unless
  //    every deficit is zero at the end. Batch order: deposits, R2R, C2R,
  //    settlements, ..., R2C, external withdrawals.

  async function fundCollateral(target: Depository, from: TestActor, to: TestActor, tokenId: bigint, amount: bigint) {
    await target.mintToReserve(from.entityId, tokenId, amount);
    const fund = await signDepositoryBatch(target, from.entityId, from.privateKey, emptyBatch({
      reserveToCollateral: [{ tokenId, receivingEntity: from.entityId, pairs: [{ entity: to.entityId, amount }] }],
    }));
    await target.connect(from.signer).processBatch(fund.encodedBatch, fund.hankoData, fund.nonce);
  }

  /** C2R leg pulling `amount` of `me`'s collateral with `cp` back to `me`'s reserve, signed by `cp`. */
  async function c2rLeg(target: Depository, me: TestActor, cp: TestActor, tokenId: bigint, amount: bigint) {
    const isLeft = BigInt(me.entityId) < BigInt(cp.entityId);
    const diffs = [{
      tokenId,
      leftDiff: isLeft ? amount : 0n,
      rightDiff: isLeft ? 0n : amount,
      collateralDiff: -amount,
      ondeltaDiff: isLeft ? -amount : 0n,
    }];
    const acctKey = await accountKeyFor(target, me.entityId, cp.entityId);
    const nonce = (await target._accounts(acctKey)).nonce + 1n;
    const sig = signEntityHash(cp.entityId, await cooperativeUpdateHash(target, acctKey, nonce, diffs), cp.privateKey);
    return { counterparty: cp.entityId, tokenId, amount, nonce, sig };
  }

  /** Settlement in which `payer` hands `amount` of reserve to `payee`, signed by `signer` (the non-initiator). */
  async function paySettlement(
    target: Depository, payer: TestActor, payee: TestActor, tokenId: bigint, amount: bigint, signer: TestActor,
  ) {
    const [left, right] = orderedActors(payer, payee);
    const payerIsLeft = left === payer;
    const diffs = [{
      tokenId,
      leftDiff: payerIsLeft ? -amount : amount,
      rightDiff: payerIsLeft ? amount : -amount,
      collateralDiff: 0n,
      ondeltaDiff: 0n,
    }];
    const acctKey = await accountKeyFor(target, left.entityId, right.entityId);
    const nonce = (await target._accounts(acctKey)).nonce + 1n;
    const sig = signEntityHash(signer.entityId, await cooperativeUpdateHash(target, acctKey, nonce, diffs), signer.privateKey);
    return { leftEntity: left.entityId, rightEntity: right.entityId, diffs, forgiveDebtsInTokenIds: [] as bigint[], sig, nonce };
  }

  it('implicit flash (a): repays an R2R overdraw from a same-batch collateral withdrawal, exactly', async function () {
    const { depository } = await loadFixture(deployFixture);
    const initiator = lazyActor(user0, 0);
    const counterparty = lazyActor(user1, 1);
    const recipient = addressEntityId(user1.address);
    const tokenId = 1n;
    await depository.mintToReserve(initiator.entityId, tokenId, 100n);
    await fundCollateral(depository, initiator, counterparty, tokenId, 1_000n);
    const acctKey = await accountKeyFor(depository, initiator.entityId, counterparty.entityId);

    const batch = emptyBatch({
      reserveToReserve: [{ receivingEntity: recipient, tokenId, amount: 700n }], // holds 100
      collateralToReserve: [await c2rLeg(depository, initiator, counterparty, tokenId, 700n)],
    });
    const signed = await signDepositoryBatch(depository, initiator.entityId, initiator.privateKey, batch);
    const receipt = await (await depository
      .connect(initiator.signer)
      .processBatch(signed.encodedBatch, signed.hankoData, signed.nonce)).wait();

    // No inflated intermediate reserve is ever visible: the overdraw shows 0,
    // the repayment shows the exact final balance.
    const initiatorUpdates = decodedEvents(receipt, 'ReserveUpdated')
      .filter(event => event.entity === initiator.entityId)
      .map(event => event.newBalance);
    expect(initiatorUpdates).to.deep.equal([0n, 100n]);
    expect(await depository._reserves(initiator.entityId, tokenId)).to.equal(100n);
    expect(await depository._reserves(recipient, tokenId)).to.equal(700n);
    expect((await depository._collaterals(acctKey, tokenId)).collateral).to.equal(300n);
    expect(await depository.entityNonces(initiator.entityId)).to.equal(2n);
  });

  it('implicit flash (b): reverts E3 when the deficit is not repaid inside the batch', async function () {
    const { depository } = await loadFixture(deployFixture);
    const initiator = lazyActor(user0, 0);
    const counterparty = lazyActor(user1, 1);
    const recipient = addressEntityId(user1.address);
    const tokenId = 1n;
    await depository.mintToReserve(initiator.entityId, tokenId, 100n);
    await fundCollateral(depository, initiator, counterparty, tokenId, 1_000n);

    const unpaid = await signDepositoryBatch(depository, initiator.entityId, initiator.privateKey, emptyBatch({
      reserveToReserve: [{ receivingEntity: recipient, tokenId, amount: 500n }],
    }));
    await expect(
      depository.connect(initiator.signer).processBatch(unpaid.encodedBatch, unpaid.hankoData, unpaid.nonce),
    ).to.be.revertedWithCustomError(depository, 'E3');

    // A partial repayment is not enough either: deficit 400, inflow 300.
    const partial = await signDepositoryBatch(depository, initiator.entityId, initiator.privateKey, emptyBatch({
      reserveToReserve: [{ receivingEntity: recipient, tokenId, amount: 500n }],
      collateralToReserve: [await c2rLeg(depository, initiator, counterparty, tokenId, 300n)],
    }));
    await expect(
      depository.connect(initiator.signer).processBatch(partial.encodedBatch, partial.hankoData, partial.nonce),
    ).to.be.revertedWithCustomError(depository, 'E3');

    expect(await depository.entityNonces(initiator.entityId)).to.equal(1n);
    expect(await depository._reserves(initiator.entityId, tokenId)).to.equal(100n);
    expect(await depository._reserves(recipient, tokenId)).to.equal(0n);
  });

  it("implicit flash (a'): a settlement overdraw is repaid by a later settlement in the same batch", async function () {
    const { depository } = await loadFixture(deployFixture);
    const [, , user2] = await ethers.getSigners();
    const initiator = lazyActor(user0, 0);
    const payee = lazyActor(user1, 1);
    const funder = lazyActor(user2!, 2);
    const tokenId = 1n;
    await depository.mintToReserve(funder.entityId, tokenId, 1_000n);

    const batch = emptyBatch({
      settlements: [
        await paySettlement(depository, initiator, payee, tokenId, 400n, payee),   // initiator pays 400 from nothing
        await paySettlement(depository, funder, initiator, tokenId, 400n, funder), // funder pays initiator 400
      ],
    });
    const signed = await signDepositoryBatch(depository, initiator.entityId, initiator.privateKey, batch);
    await depository.connect(initiator.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce);
    expect(await depository._reserves(initiator.entityId, tokenId)).to.equal(0n);
    expect(await depository._reserves(payee.entityId, tokenId)).to.equal(400n);
    expect(await depository._reserves(funder.entityId, tokenId)).to.equal(600n);
  });

  it('implicit flash (c): an initiator with outstanding debt on the token gets no credit', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [, , user2] = await ethers.getSigners();
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const funder = lazyActor(user2!, 2);
    const recipient = addressEntityId(user2!.address);
    const tokenId = 1n;
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);

    // Dispute with delta -500 and no collateral: LEFT owes RIGHT 500.
    const disputeNonce = 1n;
    const proofbody = proofBody([-500n], [tokenId]);
    const hash = proofBodyHash(proofbody);
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, hash);
    const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, emptyBatch({
      disputeStarts: [{
        counterentity: right.entityId,
        nonce: disputeNonce,
        proposerIsLeft: false,
        proofbodyHash: hash,
        initialProofbody: proofbody,
        watchSeed: TEST_WATCH_SEED,
        sig: signEntityHash(right.entityId, startHash, right.privateKey),
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      }],
    }));
    await depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);
    await advancePastDisputeTimeout(depository, left.entityId, right.entityId);
    const finalize = await signDepositoryBatch(depository, left.entityId, left.privateKey, emptyBatch({
      disputeFinalizations: [{
        counterentity: right.entityId,
        initialNonce: disputeNonce,
        finalNonce: disputeNonce,
        proposerIsLeft: false,
        initialProofbodyHash: hash,
        finalProofbody: proofbody,
        starterArguments: '0x',
        otherArguments: '0x',
        sig: '0x',
        startedByLeft: true,
        cooperative: false,
      }],
    }));
    await depository.connect(left.signer).processBatch(finalize.encodedBatch, finalize.hankoData, finalize.nonce);
    expect(await depository.debtOutstanding(left.entityId, tokenId)).to.equal(500n);
    expect(await depository.activeDebts(left.entityId)).to.equal(1n);

    // Exactly the shape that succeeds for a debt-free initiator in (a'): the
    // same-batch inflow would repay the overdraw, but a debtor may not open one.
    await depository.mintToReserve(funder.entityId, tokenId, 1_000n);
    const batch = emptyBatch({
      reserveToReserve: [{ receivingEntity: recipient, tokenId, amount: 50n }],
      settlements: [await paySettlement(depository, funder, left, tokenId, 50n, funder)],
    });
    const signed = await signDepositoryBatch(depository, left.entityId, left.privateKey, batch);
    await expect(
      depository.connect(left.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(depository, 'E3');
    expect(await depository._reserves(recipient, tokenId)).to.equal(0n);
    expect(await depository._reserves(funder.entityId, tokenId)).to.equal(1_000n);
  });

  it('implicit flash (d): a non-initiator reserve never goes negative, however rich the initiator', async function () {
    const { depository } = await loadFixture(deployFixture);
    const initiator = lazyActor(user0, 0);
    const counterparty = lazyActor(user1, 1);
    const tokenId = 1n;
    await depository.mintToReserve(initiator.entityId, tokenId, 1_000n);
    await depository.mintToReserve(counterparty.entityId, tokenId, 50n);

    // Counterparty signs a settlement paying 100 it does not have.
    const batch = emptyBatch({
      settlements: [await paySettlement(depository, counterparty, initiator, tokenId, 100n, counterparty)],
    });
    const signed = await signDepositoryBatch(depository, initiator.entityId, initiator.privateKey, batch);
    await expect(
      depository.connect(initiator.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(depository, 'E3');
    expect(await depository._reserves(counterparty.entityId, tokenId)).to.equal(50n);
    expect(await depository._reserves(initiator.entityId, tokenId)).to.equal(1_000n);
  });

  it('implicit flash (e): deposit, overdraw, repay from collateral and withdraw the external token in one batch', async function () {
    const { depository } = await loadFixture(deployFixture);
    const initiator = lazyActor(user0, 0);
    const counterparty = lazyActor(user1, 1);
    const recipient = addressEntityId(user1.address);
    const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
    const token = await ERC20Mock.deploy('Flash', 'FLS', 18, 1_000_000n);
    await token.waitForDeployment();
    await listExternalToken(depository, 0, await token.getAddress(), 0);
    const tokenId = (await depository.getTokensLength()) - 1n;
    const depositoryAddress = await depository.getAddress();
    await fundCollateral(depository, initiator, counterparty, tokenId, 1_000n);
    const acctKey = await accountKeyFor(depository, initiator.entityId, counterparty.entityId);
    await token.connect(user0).approve(depositoryAddress, 400n);

    const batch = emptyBatch({
      externalTokenToReserve: [{
        entity: initiator.entityId,
        contractAddress: await token.getAddress(),
        externalTokenId: 0,
        tokenType: 0,
        internalTokenId: tokenId,
        amount: 400n,
      }],
      reserveToReserve: [{ receivingEntity: recipient, tokenId, amount: 1_000n }], // holds 400 after the deposit
      collateralToReserve: [await c2rLeg(depository, initiator, counterparty, tokenId, 900n)], // repays 600, leaves 300
      reserveToExternalToken: [{ receivingEntity: addressEntityId(user0.address), tokenId, amount: 300n }],
    });
    const signed = await signDepositoryBatch(depository, initiator.entityId, initiator.privateKey, batch);
    await depository.connect(initiator.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce);

    expect(await depository._reserves(initiator.entityId, tokenId)).to.equal(0n);
    expect(await depository._reserves(recipient, tokenId)).to.equal(1_000n);
    expect((await depository._collaterals(acctKey, tokenId)).collateral).to.equal(100n);
    expect(await token.balanceOf(depositoryAddress)).to.equal(100n); // deposit 400 - withdrawal 300
    expect(await token.balanceOf(user0.address)).to.equal(1_000_000n - 100n);

    // The withdrawal runs last, so a deficit it opens can never be repaid.
    const overdrawWithdrawal = await signDepositoryBatch(depository, initiator.entityId, initiator.privateKey, emptyBatch({
      reserveToExternalToken: [{ receivingEntity: addressEntityId(user0.address), tokenId, amount: 1n }],
    }));
    await expect(
      depository.connect(initiator.signer).processBatch(
        overdrawWithdrawal.encodedBatch, overdrawWithdrawal.hankoData, overdrawWithdrawal.nonce,
      ),
    ).to.be.revertedWithCustomError(depository, 'E3');
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

  it('keeps signed token/offdelta shape corruption fail-fast', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const malformedProofbody = proofBody([-100n], [107n, 108n]);
    const malformedProofbodyHash = proofBodyHash(malformedProofbody);
    const accountKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const nonce = 1n;
    const innerHash = await disputeProofHash(depository, accountKey, nonce, malformedProofbodyHash);
    const start = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      emptyBatch({
        disputeStarts: [
          {
            counterentity: right.entityId,
            nonce,
            proofbodyHash: malformedProofbodyHash,
            initialProofbody: malformedProofbody,
            watchSeed: TEST_WATCH_SEED,
            sig: signEntityHash(right.entityId, innerHash, right.privateKey),
            starterInitialArguments: '0x',
            starterCounterArguments: '0x',
            starterCounterProofCommitment: ethers.ZeroHash,
          },
        ],
      }),
    );

    await expect(
      depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce),
    ).to.be.revertedWithCustomError(depository, 'E8');
    expect((await depository._accounts(accountKey)).nonce).to.equal(0n);
    expect((await depository._accounts(accountKey)).disputeHash).to.equal(ethers.ZeroHash);
    expect(await depository.entityNonces(left.entityId)).to.equal(0n);
  });

  it('never lets a tower start a dispute when no active dispute exists', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [, , tower] = await ethers.getSigners();

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    const appointmentSequence = 9n;
    const lastResortWindowSeconds = 16n;

    const finalNonce = 2n;
    const finalProofbody = proofBody([-200n], [tokenId]);
    const finalProofbodyHash = proofBodyHash(finalProofbody);
    const finalization = {
      counterentity: right.entityId,
      initialNonce: 1n,
      finalNonce,
      proposerIsLeft: false,
      initialProofbodyHash: proofBodyHash(proofBody([0n], [tokenId])),
      finalProofbody,
      starterArguments: '0x',
      otherArguments: '0x',
      sig: signEntityHash(
        right.entityId,
        await disputeProofHash(
          depository,
          await accountKeyFor(depository, left.entityId, right.entityId),
          finalNonce,
          finalProofbodyHash,
        ),
        right.privateKey,
      ),
      startedByLeft: true,
      cooperative: false,
    };
    const ownerAuthHash = await watchtowerCounterDisputeHash(
      depository,
      tower.address,
      left.entityId,
      right.entityId,
      finalNonce,
      finalProofbodyHash,
      lastResortWindowSeconds,
      appointmentSequence,
    );
    const ownerAuthorization = signEntityHash(left.entityId, ownerAuthHash, left.privateKey);

    await expect(
      depository
        .connect(tower)
        .watchtowerCounterDispute(
          left.entityId,
          finalization,
          lastResortWindowSeconds,
          appointmentSequence,
          ownerAuthorization,
        ),
    ).to.be.revertedWithCustomError(depository, 'E5');
  });
});
