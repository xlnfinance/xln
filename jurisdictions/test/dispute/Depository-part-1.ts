import { loadFixture, mine, time } from '@nomicfoundation/hardhat-toolbox/network-helpers.js';
import { expect } from 'chai';
import hre from 'hardhat';
const { ethers } = hre;
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers.js';
import type { Depository } from '../../typechain-types/index.js';
import { Contract, type ContractTransactionReceipt } from 'ethers';
import {
  addressEntityId,
  buildSingleSignerHanko,
  computeDepositoryBatchHash,
  deployDepositoryStack,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  singleSignerLazyEntityId,
} from '../helpers/hanko.ts';
import { createWatchedErc20TokenReader } from '../../../runtime/jurisdiction/adapter/rpc-watcher-inputs.ts';
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
  return depository.accountKey(left, right);
}
async function advancePastDisputeTimeout(
  target: Depository,
  left: string,
  right: string,
): Promise<void> {
  const key = await target.accountKey(left, right);
  const timeout = (await target._accounts(key)).disputeTimeout;
  // disputeTimeout is an absolute unix second. Mining a number of blocks would
  // silently reintroduce chain-specific block-time policy into the test.
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
    // Short signed bilateral windows keep timeout tests fast. They are proof
    // policy, not a deployment-wide contract setting.
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
  let erc20: Contract;
  let erc721: Contract;
  let erc1155: Contract;
  async function deployFixture() {
    [user0, user1] = await hre.ethers.getSigners();
    // Deploy EntityProvider
    const entityProvider = await deployEntityProvider(user0.address);
    ({ depository } = await deployDepositoryStack(await entityProvider.getAddress()));
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
      disputeNonce?: bigint;
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
    const disputeNonce = argumentOverrides.disputeNonce ?? 1n;
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
            proposerIsLeft: false,
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
      proposerIsLeft: false,
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
  it('ERC20 deposit to reserve', async function () {
    const { depository, erc20 } = await loadFixture(deployFixture);
    await erc20.approve(await depository.getAddress(), 10_000);
    expect(await erc20.balanceOf(user0.address)).to.equal(1_000_000);
    await depository.connect(user0).adminRegisterExternalToken({
      entity: ethers.ZeroHash,
      contractAddress: await erc20.getAddress(),
      externalTokenId: 0,
      tokenType: 0,
      internalTokenId: 0,
      amount: 10_000,
    });
    const erc20id = (await depository.getTokensLength()) - 1n;
    const reserve = await depository._reserves(addressEntityId(user0.address), erc20id);
    expect(reserve).to.equal(10_000);
    expect(await erc20.balanceOf(user0.address)).to.equal(990_000);
  });
  it('ERC721 deposit to reserve', async function () {
    const { depository, erc721 } = await loadFixture(deployFixture);
    await erc721.approve(await depository.getAddress(), 1);
    expect(await erc721.ownerOf(1)).to.equal(user0.address);
    await depository.connect(user0).adminRegisterExternalToken({
      entity: ethers.ZeroHash,
      contractAddress: await erc721.getAddress(),
      externalTokenId: 1,
      tokenType: 1,
      internalTokenId: 0,
      amount: 1,
    });
    const erc721id = (await depository.getTokensLength()) - 1n;
    const reserve = await depository._reserves(addressEntityId(user0.address), erc721id);
    expect(await erc721.ownerOf(1)).to.equal(await depository.getAddress());
    expect(reserve).to.equal(1);
  });
  it('ERC1155 deposit to reserve', async function () {
    const { depository, erc1155 } = await loadFixture(deployFixture);
    await erc1155.setApprovalForAll(await depository.getAddress(), true);
    expect(await erc1155.balanceOf(user0.address, 0)).to.equal(100);
    await depository.connect(user0).adminRegisterExternalToken({
      entity: ethers.ZeroHash,
      contractAddress: await erc1155.getAddress(),
      externalTokenId: 0,
      tokenType: 2,
      internalTokenId: 0,
      amount: 50,
    });
    const erc1155id = (await depository.getTokensLength()) - 1n;
    const reserve = await depository._reserves(addressEntityId(user0.address), erc1155id);
    expect(reserve).to.equal(50);
    expect(await erc1155.balanceOf(user0.address, 0)).to.equal(50);
  });
  it('reserveToReserve transfers between entities', async function () {
    const { depository } = await loadFixture(deployFixture);
    const fromEntity = singleSignerLazyEntityId(user0.address);
    const toEntity = addressEntityId(user1.address);
    const tokenId = 1;
    await depository.mintToReserve(fromEntity, tokenId, 1_000n);
    const batch = emptyBatch({
      reserveToReserve: [{ receivingEntity: toEntity, tokenId, amount: 250n }],
    });
    const encodedBatch = encodeBatch(batch);
    const nonce = (await depository.entityNonces(fromEntity)) + 1n;
    const batchHash = await computeDepositoryBatchHash(depository, encodedBatch, nonce);
    const hankoData = buildSingleSignerHanko(fromEntity, batchHash, deriveHardhatPrivateKey(0));
    await expect(depository.connect(user0).processBatch(encodedBatch, hankoData, nonce)).to.not.be.reverted;
    const reserveFrom = await depository._reserves(fromEntity, tokenId);
    const reserveTo = await depository._reserves(toEntity, tokenId);
    expect(reserveFrom).to.equal(750n);
    expect(reserveTo).to.equal(250n);
  });
  it('reverts an underfunded R2C batch without consuming its nonce', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [, , user2] = await ethers.getSigners();
    const actor = lazyActor(user0, 0);
    const tokenId = 1n;
    const firstCounterparty = addressEntityId(user1.address);
    const secondCounterparty = addressEntityId(user2.address);
    await depository.mintToReserve(actor.entityId, tokenId, 10n);
    const batch = emptyBatch({
      reserveToCollateral: [
        {
          tokenId,
          receivingEntity: actor.entityId,
          pairs: [
            { entity: firstCounterparty, amount: 6n },
            { entity: secondCounterparty, amount: 5n },
          ],
        },
      ],
    });
    const signed = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, batch);
    await expect(depository.connect(actor.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce))
      .to.be.revertedWithCustomError(depository, 'E3');
    expect(await depository.entityNonces(actor.entityId)).to.equal(0n);
    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(10n);
    expect(
      (await depository._collaterals(await depository.accountKey(actor.entityId, firstCounterparty), tokenId))
        .collateral,
    ).to.equal(0n);
    expect(
      (await depository._collaterals(await depository.accountKey(actor.entityId, secondCounterparty), tokenId))
        .collateral,
    ).to.equal(0n);
  });
  it('reverts underfunded C2R/R2E batches and keeps signature failures fatal', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = await registerFixedSupplyErc20(depository, 1_000_000n);
    const accountKey = await depository.accountKey(left.entityId, right.entityId);
    const c2rNonce = 1n;
    const c2rDiffs = [
      {
        tokenId,
        leftDiff: 1n,
        rightDiff: 0n,
        collateralDiff: -1n,
        ondeltaDiff: -1n,
      },
    ];
    const c2rSig = signEntityHash(
      right.entityId,
      await cooperativeUpdateHash(depository, accountKey, c2rNonce, c2rDiffs),
      right.privateKey,
    );
    const batch = emptyBatch({
      collateralToReserve: [
        {
          counterparty: right.entityId,
          tokenId,
          amount: 1n,
          nonce: c2rNonce,
          sig: c2rSig,
        },
      ],
      reserveToExternalToken: [
        {
          receivingEntity: addressEntityId(user1.address),
          tokenId,
          amount: 1n,
        },
      ],
    });
    const signed = await signDepositoryBatch(depository, left.entityId, left.privateKey, batch);
    await expect(depository.connect(left.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce))
      .to.be.revertedWithCustomError(depository, 'E3');
    expect((await depository._accounts(accountKey)).nonce).to.equal(0n);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(0n);
    const invalidBatch = emptyBatch({
      collateralToReserve: [
        {
          counterparty: right.entityId,
          tokenId,
          amount: 1n,
          nonce: c2rNonce,
          sig: buildSingleSignerHanko(right.entityId, ethers.ZeroHash, right.privateKey),
        },
      ],
    });
    const invalid = await signDepositoryBatch(depository, left.entityId, left.privateKey, invalidBatch);
    await expect(
      depository.connect(left.signer).processBatch(invalid.encodedBatch, invalid.hankoData, invalid.nonce),
    ).to.be.revertedWithCustomError(depository, 'E4');
    expect(await depository.entityNonces(left.entityId)).to.equal(0n);
  });
  it('rejects permissionless token-id allocation from the production batch path', async function () {
    const { depository, erc20 } = await loadFixture(deployFixture);
    const actor = lazyActor(user0, 0);
    const registryLengthBefore = await depository.getTokensLength();
    await erc20.approve(await depository.getAddress(), 1n);
    const depositBatch = emptyBatch({
      externalTokenToReserve: [
        {
          entity: ethers.ZeroHash,
          contractAddress: await erc20.getAddress(),
          externalTokenId: 0,
          tokenType: 0,
          internalTokenId: 0,
          amount: 1n,
        },
      ],
    });
    const deposit = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, depositBatch);
    await expect(
      depository.connect(user0).processBatch(deposit.encodedBatch, deposit.hankoData, deposit.nonce),
    ).to.be.revertedWithCustomError(depository, 'E11');
    expect(await depository.getTokensLength()).to.equal(registryLengthBefore);
  });
  it('assigns stable token IDs only through the deployment admin', async function () {
    const { depository, erc20 } = await loadFixture(deployFixture);
    const readWatchedTokens = createWatchedErc20TokenReader(depository, () => undefined);
    const tokenAddress = await erc20.getAddress();
    const packedToken = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(['uint8', 'address', 'uint96'], [0, tokenAddress, 0]),
    );
    await expect(depository.connect(user1).registerExternalToken(0, tokenAddress, 0)).to.be.revertedWithCustomError(
      depository,
      'E2',
    );
    expect(await readWatchedTokens()).to.deep.equal([]);
    await expect(depository.connect(user0).registerExternalToken(0, tokenAddress, 0))
      .to.emit(depository, 'TokenRegistered')
      .withArgs(1n, 0, tokenAddress, 0n);
    expect(await readWatchedTokens()).to.deep.equal([{ tokenId: 1, address: tokenAddress.toLowerCase() }]);
    expect(await depository.tokenToId(packedToken)).to.equal(1n);
    await depository.connect(user0).registerExternalToken(0, tokenAddress, 0);
    expect(await depository.getTokensLength()).to.equal(2n);
    expect(await depository.tokenToId(packedToken)).to.equal(1n);
  });
  it('accepts ERC1155 custody without allocating an unregistered token ID', async function () {
    const { depository, erc1155 } = await loadFixture(deployFixture);
    const registryLengthBefore = await depository.getTokensLength();
    await erc1155.setApprovalForAll(await depository.getAddress(), true);
    await expect(erc1155.safeTransferFrom(user0.address, await depository.getAddress(), 0, 1, '0x')).to.not.be.reverted;
    expect(await depository.getTokensLength()).to.equal(registryLengthBefore);
    expect(await erc1155.balanceOf(await depository.getAddress(), 0)).to.equal(1n);
    expect(await erc1155.balanceOf(user0.address, 0)).to.equal(99n);
  });
  it('processBatch deposits and withdraws external ERC20 reserves through the production path', async function () {
    const { depository, erc20 } = await loadFixture(deployFixture);
    const actor = lazyActor(user0, 0);
    const recipientEntity = addressEntityId(user1.address);
    await depository.registerExternalToken(0, await erc20.getAddress(), 0);
    await erc20.approve(await depository.getAddress(), 10_000n);
    const depositBatch = emptyBatch({
      externalTokenToReserve: [
        {
          entity: ethers.ZeroHash,
          contractAddress: await erc20.getAddress(),
          externalTokenId: 0,
          tokenType: 0,
          internalTokenId: 0,
          amount: 10_000n,
        },
      ],
    });
    const deposit = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, depositBatch);
    await expect(depository.connect(user0).processBatch(deposit.encodedBatch, deposit.hankoData, deposit.nonce))
      .to.emit(depository, 'HankoBatchProcessed')
      .withArgs(actor.entityId, deposit.batchHash, deposit.nonce);
    const erc20id = (await depository.getTokensLength()) - 1n;
    expect(await depository._reserves(actor.entityId, erc20id)).to.equal(10_000n);
    expect(await erc20.balanceOf(user0.address)).to.equal(990_000n);
    const withdrawBatch = emptyBatch({
      reserveToExternalToken: [{ receivingEntity: recipientEntity, tokenId: erc20id, amount: 2_500n }],
    });
    const withdraw = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, withdrawBatch);
    await expect(depository.connect(user0).processBatch(withdraw.encodedBatch, withdraw.hankoData, withdraw.nonce))
      .to.emit(depository, 'ReserveUpdated')
      .withArgs(actor.entityId, erc20id, 7_500n);
    expect(await depository._reserves(actor.entityId, erc20id)).to.equal(7_500n);
    expect(await erc20.balanceOf(user1.address)).to.equal(2_500n);
  });
  it('processBatch supports no-return ERC20 tokens on deposit and withdrawal', async function () {
    const { depository } = await loadFixture(deployFixture);
    const NoReturnERC20Mock = await hre.ethers.getContractFactory('NoReturnERC20Mock');
    const noReturnToken = await NoReturnERC20Mock.deploy('NoReturn', 'NORET', 1_000_000n);
    await noReturnToken.waitForDeployment();
    const actor = lazyActor(user0, 0);
    const recipientEntity = addressEntityId(user1.address);
    await depository.registerExternalToken(0, await noReturnToken.getAddress(), 0);
    await noReturnToken.approve(await depository.getAddress(), 10_000n);
    const depositBatch = emptyBatch({
      externalTokenToReserve: [
        {
          entity: ethers.ZeroHash,
          contractAddress: await noReturnToken.getAddress(),
          externalTokenId: 0,
          tokenType: 0,
          internalTokenId: 0,
          amount: 10_000n,
        },
      ],
    });
    const deposit = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, depositBatch);
    await expect(depository.connect(user0).processBatch(deposit.encodedBatch, deposit.hankoData, deposit.nonce))
      .to.emit(depository, 'HankoBatchProcessed')
      .withArgs(actor.entityId, deposit.batchHash, deposit.nonce);
    const tokenId = (await depository.getTokensLength()) - 1n;
    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(10_000n);
    expect(await noReturnToken.balanceOf(await depository.getAddress())).to.equal(10_000n);
    const withdrawBatch = emptyBatch({
      reserveToExternalToken: [{ receivingEntity: recipientEntity, tokenId, amount: 2_500n }],
    });
    const withdraw = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, withdrawBatch);
    await expect(depository.connect(user0).processBatch(withdraw.encodedBatch, withdraw.hankoData, withdraw.nonce))
      .to.emit(depository, 'ReserveUpdated')
      .withArgs(actor.entityId, tokenId, 7_500n);
    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(7_500n);
    expect(await noReturnToken.balanceOf(user1.address)).to.equal(2_500n);
  });
  it('uses exact balance deltas for false-return ERC20 deposits and withdrawals', async function () {
    const { depository } = await loadFixture(deployFixture);
    const FalseReturnERC20 = await hre.ethers.getContractFactory('FalseReturnERC20Mock');
    const token = await FalseReturnERC20.deploy(1_000_000n);
    await token.waitForDeployment();
    const actor = lazyActor(user0, 0);
    const recipientEntity = addressEntityId(user1.address);
    await depository.registerExternalToken(0, await token.getAddress(), 0);
    await token.approve(await depository.getAddress(), 10_000n);
    const deposit = await signDepositoryBatch(
      depository,
      actor.entityId,
      actor.privateKey,
      emptyBatch({
        externalTokenToReserve: [
          {
            entity: ethers.ZeroHash,
            contractAddress: await token.getAddress(),
            externalTokenId: 0,
            tokenType: 0,
            internalTokenId: 0,
            amount: 10_000n,
          },
        ],
      }),
    );
    await depository.connect(user0).processBatch(deposit.encodedBatch, deposit.hankoData, deposit.nonce);
    const tokenId = (await depository.getTokensLength()) - 1n;
    const withdrawal = await signDepositoryBatch(
      depository,
      actor.entityId,
      actor.privateKey,
      emptyBatch({
        reserveToExternalToken: [{ receivingEntity: recipientEntity, tokenId, amount: 2_500n }],
      }),
    );
    await depository.connect(user0).processBatch(withdrawal.encodedBatch, withdrawal.hankoData, withdrawal.nonce);
    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(7_500n);
    expect(await token.balanceOf(await depository.getAddress())).to.equal(7_500n);
    expect(await token.balanceOf(user1.address)).to.equal(2_500n);
  });
  it('rejects fee-on-transfer ERC20 withdrawals without reducing reserve', async function () {
    const { depository } = await loadFixture(deployFixture);
    const FeeToken = await hre.ethers.getContractFactory('FeeOnTransferERC20');
    const token = await FeeToken.deploy(1_000_000n);
    await token.waitForDeployment();
    const actor = lazyActor(user0, 0);
    const recipientEntity = addressEntityId(user1.address);
    await depository.registerExternalToken(0, await token.getAddress(), 0);
    await token.approve(await depository.getAddress(), 10_000n);
    const depositBatch = emptyBatch({
      externalTokenToReserve: [
        {
          entity: ethers.ZeroHash,
          contractAddress: await token.getAddress(),
          externalTokenId: 0,
          tokenType: 0,
          internalTokenId: 0,
          amount: 10_000n,
        },
      ],
    });
    const deposit = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, depositBatch);
    await depository.connect(user0).processBatch(deposit.encodedBatch, deposit.hankoData, deposit.nonce);
    const tokenId = (await depository.getTokensLength()) - 1n;
    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(9_900n);
    const withdrawBatch = emptyBatch({
      reserveToExternalToken: [{ receivingEntity: recipientEntity, tokenId, amount: 1_000n }],
    });
    const withdraw = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, withdrawBatch);
    await expect(
      depository.connect(user0).processBatch(withdraw.encodedBatch, withdraw.hankoData, withdraw.nonce),
    ).to.be.revertedWithCustomError(depository, 'E11');
    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(9_900n);
    expect(await token.balanceOf(user1.address)).to.equal(0n);
  });
  it('rejects zero-amount ERC721 withdrawals instead of transferring the NFT for free', async function () {
    const { depository, erc721 } = await loadFixture(deployFixture);
    const actor = lazyActor(user0, 0);
    const recipientEntity = addressEntityId(user1.address);
    await depository.registerExternalToken(1, await erc721.getAddress(), 1);
    await erc721.approve(await depository.getAddress(), 1);
    const depositBatch = emptyBatch({
      externalTokenToReserve: [
        {
          entity: ethers.ZeroHash,
          contractAddress: await erc721.getAddress(),
          externalTokenId: 1,
          tokenType: 1,
          internalTokenId: 0,
          amount: 1n,
        },
      ],
    });
    const deposit = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, depositBatch);
    await depository.connect(user0).processBatch(deposit.encodedBatch, deposit.hankoData, deposit.nonce);
    const erc721id = (await depository.getTokensLength()) - 1n;
    const withdrawBatch = emptyBatch({
      reserveToExternalToken: [{ receivingEntity: recipientEntity, tokenId: erc721id, amount: 0n }],
    });
    const withdraw = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, withdrawBatch);
    await expect(
      depository.connect(user0).processBatch(withdraw.encodedBatch, withdraw.hankoData, withdraw.nonce),
    ).to.be.revertedWithCustomError(depository, 'E1');
    expect(await erc721.ownerOf(1)).to.equal(await depository.getAddress());
    expect(await depository._reserves(actor.entityId, erc721id)).to.equal(1n);
  });
  it('requires strictly sequential entity batch nonces and binds signatures to nonce and calldata', async function () {
    const { depository } = await loadFixture(deployFixture);
    const actor = lazyActor(user0, 0);
    const recipient = addressEntityId(user1.address);
    const tokenId = 1;
    await depository.mintToReserve(actor.entityId, tokenId, 1_000n);
    const firstBatch = emptyBatch({
      reserveToReserve: [{ receivingEntity: recipient, tokenId, amount: 100n }],
    });
    const first = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, firstBatch);
    await depository.connect(user0).processBatch(first.encodedBatch, first.hankoData, first.nonce);
    expect(await depository.entityNonces(actor.entityId)).to.equal(1n);
    await expect(
      depository.connect(user0).processBatch(first.encodedBatch, first.hankoData, first.nonce),
    ).to.be.revertedWithCustomError(depository, 'E2');
    await expect(depository.connect(user0).processBatch(first.encodedBatch, first.hankoData, 2n)).to.be.reverted;
    const secondBatch = emptyBatch({
      reserveToReserve: [{ receivingEntity: recipient, tokenId, amount: 25n }],
    });
    const second = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, secondBatch, 2n);
    const tamperedBatch = emptyBatch({
      reserveToReserve: [{ receivingEntity: recipient, tokenId, amount: 26n }],
    });
    await expect(depository.connect(user0).processBatch(encodeBatch(tamperedBatch), second.hankoData, second.nonce)).to
      .be.reverted;
    expect(await depository.entityNonces(actor.entityId)).to.equal(1n);
    await depository.connect(user0).processBatch(second.encodedBatch, second.hankoData, second.nonce);
    expect(await depository.entityNonces(actor.entityId)).to.equal(2n);
    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(875n);
    expect(await depository._reserves(recipient, tokenId)).to.equal(125n);
  });
  it('settles bilateral diffs with counterparty hanko and rejects settlement replay', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    const forgiveOnlyTokenId = 2n;
    await depository.mintToReserve(left.entityId, tokenId, 1_000n);
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const settlementNonce = 1n;
    const diffs = [
      {
        tokenId,
        leftDiff: -125n,
        rightDiff: 125n,
        collateralDiff: 0n,
        ondeltaDiff: 0n,
      },
    ];
    // Overlap between a diff and forgiveness must not duplicate AccountSettled tokens.
    const forgiveDebtsInTokenIds = [tokenId, forgiveOnlyTokenId];
    const settlementHash = await cooperativeUpdateHash(
      depository,
      acctKey,
      settlementNonce,
      diffs,
      forgiveDebtsInTokenIds,
    );
    const settlementSig = signEntityHash(right.entityId, settlementHash, right.privateKey);
    const settlement = {
      leftEntity: left.entityId,
      rightEntity: right.entityId,
      diffs,
      forgiveDebtsInTokenIds,
      sig: settlementSig,
      nonce: settlementNonce,
    };
    const batch = emptyBatch({ settlements: [settlement] });
    const signed = await signDepositoryBatch(depository, left.entityId, left.privateKey, batch);
    const settleResponse = await depository
      .connect(left.signer)
      .processBatch(signed.encodedBatch, signed.hankoData, signed.nonce);
    await expect(settleResponse).to.emit(depository, 'AccountSettled');
    // Exactly one ReserveUpdated per mutated reserve side (left decrease + right increase).
    await expect(settleResponse)
      .to.emit(depository, 'ReserveUpdated')
      .withArgs(left.entityId, tokenId, 875n);
    await expect(settleResponse)
      .to.emit(depository, 'ReserveUpdated')
      .withArgs(right.entityId, tokenId, 125n);
    const receipt = await settleResponse.wait();
    const settledEvents = receipt!.logs
      .map((log) => {
        try {
          return depository.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((parsed) => parsed?.name === 'AccountSettled');
    expect(settledEvents).to.have.length(1);
    const settledAccounts = settledEvents[0]!.args[0] as Array<{
      left: string;
      right: string;
      nonce: bigint;
      tokens: Array<{
        tokenId: bigint;
        leftReserve: bigint;
        rightReserve: bigint;
        collateral: bigint;
        ondelta: bigint;
      }>;
    }>;
    expect(settledAccounts).to.have.length(1);
    expect(settledAccounts[0]!.left).to.equal(left.entityId);
    expect(settledAccounts[0]!.right).to.equal(right.entityId);
    expect(settledAccounts[0]!.nonce).to.equal(settlementNonce);
    const tokens = settledAccounts[0]!.tokens;
    expect(tokens.map((t) => t.tokenId)).to.deep.equal([tokenId, forgiveOnlyTokenId]);
    expect(tokens[0]!.tokenId).to.equal(tokenId);
    expect(tokens[0]!.leftReserve).to.equal(875n);
    expect(tokens[0]!.rightReserve).to.equal(125n);
    expect(tokens[0]!.collateral).to.equal(0n);
    expect(tokens[0]!.ondelta).to.equal(0n);
    expect(tokens[1]!.tokenId).to.equal(forgiveOnlyTokenId);
    expect(tokens[1]!.leftReserve).to.equal(0n);
    expect(tokens[1]!.rightReserve).to.equal(0n);
    expect(tokens[1]!.collateral).to.equal(0n);
    expect(tokens[1]!.ondelta).to.equal(0n);
    const account = await depository._accounts(acctKey);
    expect(account.nonce).to.equal(settlementNonce);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(875n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(125n);
    const replay = await signDepositoryBatch(depository, left.entityId, left.privateKey, batch);
    await expect(
      depository.connect(left.signer).processBatch(replay.encodedBatch, replay.hankoData, replay.nonce),
    ).to.be.revertedWithCustomError(depository, 'E2');
    expect((await depository._accounts(acctKey)).nonce).to.equal(settlementNonce);
    expect(await depository.entityNonces(left.entityId)).to.equal(1n);
  });
  it('rejects duplicate forgiveness token ids before one settlement can advance the debt cursor twice', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const forgiveDebtsInTokenIds = [tokenId, tokenId];
    const settlementHash = await cooperativeUpdateHash(
      depository,
      acctKey,
      1n,
      [],
      forgiveDebtsInTokenIds,
    );
    const batch = emptyBatch({
      settlements: [{
        leftEntity: left.entityId,
        rightEntity: right.entityId,
        diffs: [],
        forgiveDebtsInTokenIds,
        sig: signEntityHash(right.entityId, settlementHash, right.privateKey),
        nonce: 1n,
      }],
    });
    const signed = await signDepositoryBatch(depository, left.entityId, left.privateKey, batch);
    await expect(
      depository.connect(left.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(depository, 'E2');
    expect(await depository.entityNonces(left.entityId)).to.equal(0n);
    expect((await depository._accounts(acctKey)).nonce).to.equal(0n);
  });
  it('rejects unsafe Account and outer batch nonces at the Solidity write boundary', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const maxSafeNonce = 9_007_199_254_740_991n;
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const diffs = [{
      tokenId: 1n,
      leftDiff: 0n,
      rightDiff: 0n,
      collateralDiff: 0n,
      ondeltaDiff: 0n,
    }];
    const settlementHash = await cooperativeUpdateHash(depository, acctKey, maxSafeNonce, diffs);
    const batch = emptyBatch({
      settlements: [{
        leftEntity: left.entityId,
        rightEntity: right.entityId,
        diffs,
        forgiveDebtsInTokenIds: [],
        sig: signEntityHash(right.entityId, settlementHash, right.privateKey),
        nonce: maxSafeNonce,
      }],
    });
    const signed = await signDepositoryBatch(depository, left.entityId, left.privateKey, batch);
    const expectUnsafeBatch = async (unsafeBatch: Record<string, unknown>): Promise<void> => {
      const candidate = await signDepositoryBatch(depository, left.entityId, left.privateKey, unsafeBatch);
      await expect(
        depository.connect(left.signer).processBatch(
          candidate.encodedBatch,
          candidate.hankoData,
          candidate.nonce,
        ),
      ).to.be.revertedWithCustomError(depository, 'E10');
      expect(await depository.entityNonces(left.entityId)).to.equal(0n);
    };
    await expectUnsafeBatch(batch);
    await expectUnsafeBatch(emptyBatch({
      collateralToReserve: [{
        counterparty: right.entityId,
        tokenId: 1n,
        amount: 1n,
        nonce: maxSafeNonce,
        sig: '0x',
      }],
    }));
    const emptyProof = proofBody([], []);
    const emptyProofHash = proofBodyHash(emptyProof);
    await expectUnsafeBatch(emptyBatch({
      disputeStarts: [{
        counterentity: right.entityId,
        nonce: maxSafeNonce,
        proposerIsLeft: false,
        proofbodyHash: emptyProofHash,
        initialProofbody: emptyProof,
        watchSeed: TEST_WATCH_SEED,
        sig: '0x',
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: ethers.ZeroHash,
      }],
    }));
    await expectUnsafeBatch(emptyBatch({
      counterDisputes: [{
        counterentity: right.entityId,
        initialNonce: maxSafeNonce,
        initialProofbodyHash: emptyProofHash,
        counterNonce: maxSafeNonce,
        proposerIsLeft: false,
        counterProofbody: emptyProof,
        sig: '0x',
      }],
    }));
    await expectUnsafeBatch(emptyBatch({
      disputeFinalizations: [{
        counterentity: right.entityId,
        initialNonce: maxSafeNonce,
        finalNonce: maxSafeNonce,
        proposerIsLeft: false,
        initialProofbodyHash: emptyProofHash,
        finalProofbody: emptyProof,
        starterArguments: '0x',
        otherArguments: '0x',
        sig: '0x',
        startedByLeft: true,
        cooperative: false,
      }],
    }));
    await expect(
      depository.connect(left.signer).processBatch('0x', '0x', maxSafeNonce + 1n),
    ).to.be.revertedWithCustomError(depository, 'E10');
    expect(await depository.entityNonces(left.entityId)).to.equal(0n);
    expect((await depository._accounts(acctKey)).nonce).to.equal(0n);
  });
  it('reserves the maximum safe nonce for one unilateral finalization successor', async function () {
    const { depository } = await loadFixture(deployFixture);
    const maxSafeNonce = 9_007_199_254_740_991n;
    const dispute = await buildTimedOutTransformerFinalization(
      depository,
      [],
      [],
      [],
      { skipFunding: true, disputeNonce: maxSafeNonce - 1n },
    );
    await expect(
      depository
        .connect(dispute.left.signer)
        .processBatch(dispute.final.encodedBatch, dispute.final.hankoData, dispute.final.nonce),
    )
      .to.emit(depository, 'DisputeFinalized')
      .withArgs(
        dispute.left.entityId,
        dispute.right.entityId,
        maxSafeNonce - 1n,
        proofBodyHash(proofBody([], [])),
        ethers.keccak256(abi.encode(
          ['bytes32', 'uint256', 'bool', 'bool', 'bytes32', 'bytes32', 'bytes32'],
          [
            proofBodyHash(proofBody([], [])),
            maxSafeNonce - 1n,
            false,
            true,
            ethers.keccak256(dispute.finalization.starterArguments as string),
            ethers.keccak256(dispute.finalization.otherArguments as string),
            ethers.keccak256('0x'),
          ],
        )),
      );
    expect((await depository._accounts(dispute.accountKey)).nonce).to.equal(maxSafeNonce);
  });
  it('reverts settlement with E8 when a reserve would exceed int256.max and leaves no partial diff', async function () {
    const { depository } = await loadFixture(deployFixture);
    const INT256_MAX = (1n << 255n) - 1n;
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    await depository.mintToReserve(left.entityId, tokenId, INT256_MAX);
    await depository.mintToReserve(right.entityId, tokenId, 1n);
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const settlementNonce = 1n;
    const diffs = [
      {
        tokenId,
        leftDiff: 1n,
        rightDiff: -1n,
        collateralDiff: 0n,
        ondeltaDiff: 0n,
      },
    ];
    const settlementHash = await cooperativeUpdateHash(depository, acctKey, settlementNonce, diffs);
    const settlement = {
      leftEntity: left.entityId,
      rightEntity: right.entityId,
      diffs,
      forgiveDebtsInTokenIds: [] as bigint[],
      sig: signEntityHash(right.entityId, settlementHash, right.privateKey),
      nonce: settlementNonce,
    };
    const signed = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      emptyBatch({ settlements: [settlement] }),
    );
    await expect(
      depository.connect(left.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(depository, 'E8');
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(INT256_MAX);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(1n);
    expect((await depository._accounts(acctKey)).nonce).to.equal(0n);
    expect(await depository.entityNonces(left.entityId)).to.equal(0n);
  });
  it('reverts settlement and R2C with E8 when collateral would exceed int256.max', async function () {
    const { depository } = await loadFixture(deployFixture);
    const INT256_MAX = (1n << 255n) - 1n;
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    await depository.mintToReserve(left.entityId, tokenId, INT256_MAX);
    await depository.mintToReserve(right.entityId, tokenId, 2n);
    // Fund collateral to INT256_MAX via R2C from left.
    const fundMax = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      emptyBatch({
        reserveToCollateral: [
          {
            tokenId,
            receivingEntity: left.entityId,
            pairs: [{ entity: right.entityId, amount: INT256_MAX }],
          },
        ],
      }),
    );
    await depository
      .connect(left.signer)
      .processBatch(fundMax.encodedBatch, fundMax.hankoData, fundMax.nonce);
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    expect((await depository._collaterals(acctKey, tokenId)).collateral).to.equal(INT256_MAX);
    // Further R2C into the same collateral bucket must hit E8 (accumulation).
    const overflowR2c = await signDepositoryBatch(
      depository,
      right.entityId,
      right.privateKey,
      emptyBatch({
        reserveToCollateral: [
          {
            tokenId,
            receivingEntity: left.entityId,
            pairs: [{ entity: right.entityId, amount: 1n }],
          },
        ],
      }),
    );
    await expect(
      depository
        .connect(right.signer)
        .processBatch(overflowR2c.encodedBatch, overflowR2c.hankoData, overflowR2c.nonce),
    ).to.be.revertedWithCustomError(depository, 'E8');
    expect((await depository._collaterals(acctKey, tokenId)).collateral).to.equal(INT256_MAX);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(2n);
    // Settlement path: move 1 from right reserve into already-max collateral.
    const settlementNonce = 1n;
    const diffs = [
      {
        tokenId,
        leftDiff: 0n,
        rightDiff: -1n,
        collateralDiff: 1n,
        ondeltaDiff: 0n,
      },
    ];
    const settlementHash = await cooperativeUpdateHash(depository, acctKey, settlementNonce, diffs);
    const settlement = {
      leftEntity: left.entityId,
      rightEntity: right.entityId,
      diffs,
      forgiveDebtsInTokenIds: [] as bigint[],
      sig: signEntityHash(right.entityId, settlementHash, right.privateKey),
      nonce: settlementNonce,
    };
    const signed = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      emptyBatch({ settlements: [settlement] }),
    );
    await expect(
      depository.connect(left.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(depository, 'E8');
    expect((await depository._collaterals(acctKey, tokenId)).collateral).to.equal(INT256_MAX);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(2n);
    expect((await depository._accounts(acctKey)).nonce).to.equal(0n);
  });
  it('requires counterparty hanko for empty settlements too', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const settlementNonce = 1n;
    const unsignedSettlement = {
      leftEntity: left.entityId,
      rightEntity: right.entityId,
      diffs: [],
      forgiveDebtsInTokenIds: [],
      sig: '0x',
      nonce: settlementNonce,
    };
    const unsignedBatch = emptyBatch({ settlements: [unsignedSettlement] });
    const unsigned = await signDepositoryBatch(depository, left.entityId, left.privateKey, unsignedBatch);
    await expect(
      depository.connect(left.signer).processBatch(unsigned.encodedBatch, unsigned.hankoData, unsigned.nonce),
    ).to.be.revertedWith('Signature required for settlement');
    expect((await depository._accounts(acctKey)).nonce).to.equal(0n);
    expect(await depository.entityNonces(left.entityId)).to.equal(0n);
    const settlementHash = await cooperativeUpdateHash(depository, acctKey, settlementNonce, []);
    const signedSettlement = {
      ...unsignedSettlement,
      sig: signEntityHash(right.entityId, settlementHash, right.privateKey),
    };
    const signedBatch = emptyBatch({ settlements: [signedSettlement] });
    const signed = await signDepositoryBatch(depository, left.entityId, left.privateKey, signedBatch);
    await expect(
      depository.connect(left.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(depository, 'E2');
    expect((await depository._accounts(acctKey)).nonce).to.equal(0n);
    expect(await depository.entityNonces(left.entityId)).to.equal(0n);
  });
  it('blocks cooperative settlement and C2R while a dispute is active', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    await depository.mintToReserve(left.entityId, tokenId, 300n);
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
    const collateralState = await depository._collaterals(acctKey, tokenId);
    expect(collateralState.collateral).to.equal(100n);
    expect(collateralState.ondelta).to.equal(100n);
    const initialProofbody = proofBody([0n], [tokenId]);
    const initialProofbodyHash = proofBodyHash(initialProofbody);
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
          starterInitialArguments: '0x',
          starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        },
      ],
    });
    const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, startBatch);
    await depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);
    expect((await depository._accounts(acctKey)).disputeHash).to.not.equal(ethers.ZeroHash);
    const settlementNonce = 2n;
    const settlementDiffs = [
      {
        tokenId,
        leftDiff: -1n,
        rightDiff: 1n,
        collateralDiff: 0n,
        ondeltaDiff: 0n,
      },
    ];
    const settlementSig = signEntityHash(
      right.entityId,
      await cooperativeUpdateHash(depository, acctKey, settlementNonce, settlementDiffs),
      right.privateKey,
    );
    const settlementBatch = emptyBatch({
      settlements: [
        {
          leftEntity: left.entityId,
          rightEntity: right.entityId,
          diffs: settlementDiffs,
          forgiveDebtsInTokenIds: [],
          sig: settlementSig,
          nonce: settlementNonce,
        },
      ],
    });
    const settlement = await signDepositoryBatch(depository, left.entityId, left.privateKey, settlementBatch);
    await expect(
      depository.connect(left.signer).processBatch(settlement.encodedBatch, settlement.hankoData, settlement.nonce),
    ).to.be.revertedWithCustomError(depository, 'E6');
    const c2rDiffs = [
      {
        tokenId,
        leftDiff: 1n,
        rightDiff: 0n,
        collateralDiff: -1n,
        ondeltaDiff: -1n,
      },
    ];
    const c2rSig = signEntityHash(
      right.entityId,
      await cooperativeUpdateHash(depository, acctKey, settlementNonce, c2rDiffs),
      right.privateKey,
    );
    const c2rBatch = emptyBatch({
      collateralToReserve: [
        {
          counterparty: right.entityId,
          tokenId,
          amount: 1n,
          nonce: settlementNonce,
          sig: c2rSig,
        },
      ],
    });
    const c2r = await signDepositoryBatch(depository, left.entityId, left.privateKey, c2rBatch);
    await expect(
      depository.connect(left.signer).processBatch(c2r.encodedBatch, c2r.hankoData, c2r.nonce),
    ).to.be.revertedWithCustomError(depository, 'E6');
    expect((await depository._accounts(acctKey)).nonce).to.equal(disputeNonce);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(200n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(0n);
  });
  it('rejects C2R amounts outside the signed int256 domain before mutation', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    const amount = 1n << 255n;
    const batch = emptyBatch({
      collateralToReserve: [
        {
          counterparty: right.entityId,
          tokenId,
          amount,
          nonce: 1n,
          sig: '0x',
        },
      ],
    });
    const signed = await signDepositoryBatch(depository, left.entityId, left.privateKey, batch);
    const accountKey = await accountKeyFor(depository, left.entityId, right.entityId);

    await expect(
      depository.connect(left.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(depository, 'E8');
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(0n);
    expect((await depository._accounts(accountKey)).nonce).to.equal(0n);
  });

  it('rejects duplicate tokenIds inside one settlement diff', async function () {
    const { depository } = await loadFixture(deployFixture);

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    await depository.mintToReserve(left.entityId, tokenId, 1_000n);

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
      {
        tokenId,
        leftDiff: -25n,
        rightDiff: 25n,
        collateralDiff: 0n,
        ondeltaDiff: 0n,
      },
    ];
    const settlementSig = signEntityHash(
      right.entityId,
      await cooperativeUpdateHash(depository, acctKey, settlementNonce, diffs),
      right.privateKey,
    );
    const batch = emptyBatch({
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
    const signed = await signDepositoryBatch(depository, left.entityId, left.privateKey, batch);

    await expect(
      depository.connect(left.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(depository, 'E2');

    expect(await depository.entityNonces(left.entityId)).to.equal(0n);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(1_000n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(0n);
  });

  it('rejects oversized batches before mutating reserves or nonces', async function () {
    const { depository } = await loadFixture(deployFixture);

    const actor = lazyActor(user0, 0);
    const recipient = addressEntityId(user1.address);
    const tokenId = 1n;
    await depository.mintToReserve(actor.entityId, tokenId, 1_000n);

    const oversizedTransfers = Array.from({ length: 65 }, () => ({
      receivingEntity: recipient,
      tokenId,
      amount: 1n,
    }));
    const batch = emptyBatch({ reserveToReserve: oversizedTransfers });
    const signed = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, batch);

    await expect(
      depository.connect(actor.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(depository, 'E10');

    expect(await depository.entityNonces(actor.entityId)).to.equal(0n);
    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(1_000n);
    expect(await depository._reserves(recipient, tokenId)).to.equal(0n);
  });

  it('admits at most one defensive dispute finalization per transaction', async function () {
    const { depository } = await loadFixture(deployFixture);
    const actor = lazyActor(user0, 0);
    const finalization = {
      counterentity: addressEntityId(user1.address),
      initialNonce: 1n,
      finalNonce: 1n,
      initialProofbodyHash: ethers.ZeroHash,
      finalProofbody: proofBody([], []),
      starterArguments: '0x',
      otherArguments: '0x',
      sig: '0x',
      startedByLeft: true,
      cooperative: false,
    };
    const signed = await signDepositoryBatch(
      depository,
      actor.entityId,
      actor.privateKey,
      emptyBatch({ disputeFinalizations: [finalization, finalization] }),
    );

    await expect(
      depository.connect(actor.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(depository, 'E10');
    expect(await depository.entityNonces(actor.entityId)).to.equal(0n);
  });

  it('rejects batches over the aggregate 50-op cap even when each array is under its own cap', async function () {
    const { depository } = await loadFixture(deployFixture);

    const actor = lazyActor(user0, 0);
    const recipient = addressEntityId(user1.address);
    const tokenId = 1n;
    await depository.mintToReserve(actor.entityId, tokenId, 1_000n);

    const transfers = Array.from({ length: 51 }, () => ({
      receivingEntity: recipient,
      tokenId,
      amount: 1n,
    }));
    const batch = emptyBatch({ reserveToReserve: transfers });
    const signed = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, batch);

    await expect(
      depository.connect(actor.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(depository, 'E10');

    expect(await depository.entityNonces(actor.entityId)).to.equal(0n);
    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(1_000n);
    expect(await depository._reserves(recipient, tokenId)).to.equal(0n);
  });

  it('rejects zero-value R2C before it can forge a victim AccountSettled event', async function () {
    const { depository } = await loadFixture(deployFixture);
    const signers = await hre.ethers.getSigners();
    const attacker = lazyActor(signers[2]!, 2);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));

    await depository.mintToReserve(left.entityId, 1n, 1n);
    const validFunding = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      emptyBatch({
        reserveToCollateral: [{
          tokenId: 1n,
          receivingEntity: left.entityId,
          pairs: [{ entity: right.entityId, amount: 1n }],
        }],
      }),
    );
    await depository
      .connect(left.signer)
      .processBatch(validFunding.encodedBatch, validFunding.hankoData, validFunding.nonce);

    const poison = await signDepositoryBatch(
      depository,
      attacker.entityId,
      attacker.privateKey,
      emptyBatch({
        reserveToCollateral: [{
          tokenId: 999n,
          receivingEntity: left.entityId,
          pairs: [{ entity: right.entityId, amount: 0n }],
        }],
      }),
    );
    await expect(
      depository
        .connect(attacker.signer)
        .processBatch(poison.encodedBatch, poison.hankoData, poison.nonce),
    ).to.be.revertedWithCustomError(depository, 'E1');

    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    expect((await depository._collaterals(acctKey, 999n)).collateral).to.equal(0n);
    expect(await depository.entityNonces(attacker.entityId)).to.equal(0n);
  });

  it('lets only the non-starter finalize a newer jointly signed counter-proof', async function () {
    const { depository } = await loadFixture(deployFixture);

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
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
    const collateralBefore = await depository._collaterals(acctKey, tokenId);
    expect(collateralBefore.collateral).to.equal(300n);
    expect(collateralBefore.ondelta).to.equal(300n);

    const initialProofbody = proofBody([0n], [tokenId]);
    const initialProofbodyHash = proofBodyHash(initialProofbody);
    const starterInitialArguments = '0x';
    const disputeNonce = 1n;
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, initialProofbodyHash);
    const startSig = signEntityHash(right.entityId, startHash, right.privateKey);
    const disputeStart = {
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
    };
    const startBatch = emptyBatch({ disputeStarts: [disputeStart] });
    const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, startBatch);
    const startResponse = await depository
      .connect(left.signer)
      .processBatch(start.encodedBatch, start.hankoData, start.nonce);
    await expect(startResponse).to.emit(depository, 'DisputeStarted');

    const startReceipt = await startResponse.wait();
    const disputeStarted = startReceipt!.logs
      .map((log) => {
        try {
          return depository.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === 'DisputeStarted');
    expect(disputeStarted).to.not.equal(undefined);
    expect(disputeStarted!.args[0]).to.equal(left.entityId);
    expect(disputeStarted!.args[1]).to.equal(right.entityId);
    expect(disputeStarted!.args[2]).to.equal(disputeNonce);
    expect(disputeStarted!.args[3]).to.equal(false);
    expect(disputeStarted!.args[4]).to.equal(initialProofbodyHash);
    expect(disputeStarted!.args[5]).to.equal(TEST_WATCH_SEED);
    expect(disputeStarted!.args[6]).to.equal(starterInitialArguments);
    expect(disputeStarted!.args[7]).to.equal('0x');
    expect(disputeStarted!.args[8]).to.equal(ethers.ZeroHash);
    const disputeTimeout = disputeStarted!.args[9] as bigint;
    const disputeStartTimestamp = disputeStarted!.args[10] as bigint;
    expect(disputeTimeout).to.equal(disputeStartTimestamp + 100n);

    const startedAccount = await depository._accounts(acctKey);
    expect(startedAccount.nonce).to.equal(disputeNonce);
    expect(startedAccount.disputeHash).to.not.equal(ethers.ZeroHash);
    expect(startedAccount.disputeTimeout).to.equal(disputeTimeout);
    expect(startedAccount.disputeStartTimestamp).to.equal(disputeStartTimestamp);

    const finalNonce = 2n;
    const finalProofbody = proofBody([-200n], [tokenId]);
    const finalProofbodyHash = proofBodyHash(finalProofbody);
    const finalHash = await disputeProofHash(depository, acctKey, finalNonce, finalProofbodyHash);
    const staleVictimSignature = signEntityHash(right.entityId, finalHash, right.privateKey);
    const starterFinalization = {
      counterentity: right.entityId,
      initialNonce: disputeNonce,
      finalNonce,
      proposerIsLeft: false,
      initialProofbodyHash,
      finalProofbody,
      starterArguments: '0x',
      otherArguments: '0x',
      sig: staleVictimSignature,
      startedByLeft: true,
      cooperative: false,
    };
    const starterFinal = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      emptyBatch({ disputeFinalizations: [starterFinalization] }),
    );
    await expect(
      depository
        .connect(left.signer)
        .processBatch(starterFinal.encodedBatch, starterFinal.hankoData, starterFinal.nonce),
    ).to.be.revertedWithCustomError(depository, 'E2');

    const counterpartyFinalization = {
      ...starterFinalization,
      counterentity: left.entityId,
      proposerIsLeft: true,
      sig: signEntityHash(
        left.entityId,
        await disputeProofHash(depository, acctKey, finalNonce, finalProofbodyHash, TEST_WATCH_SEED, true),
        left.privateKey,
      ),
    };
    const final = await signDepositoryBatch(
      depository,
      right.entityId,
      right.privateKey,
      emptyBatch({ disputeFinalizations: [counterpartyFinalization] }),
    );

    // This newer signed state has no Pull. Prove the success below is truly
    // before timeout: waiting would add no evidence and would only let the
    // starter delay adoption of a state it already signed.
    expect(BigInt(await time.latest())).to.be.lessThan(disputeTimeout);

    await expect(depository.connect(right.signer).processBatch(final.encodedBatch, final.hankoData, final.nonce))
      .to.emit(depository, 'DisputeFinalized')
      .withArgs(
        right.entityId,
        left.entityId,
        disputeNonce,
        finalProofbodyHash,
        ethers.keccak256(abi.encode(
          ['bytes32', 'uint256', 'bool', 'bool', 'bytes32', 'bytes32', 'bytes32'],
          [initialProofbodyHash, finalNonce, true, true, ethers.keccak256('0x'), ethers.keccak256('0x'),
            ethers.keccak256(counterpartyFinalization.sig)],
        )),
      );

    const finalizedAccount = await depository._accounts(acctKey);
    const collateralAfter = await depository._collaterals(acctKey, tokenId);
    expect(finalizedAccount.nonce).to.equal(finalNonce);
    expect(finalizedAccount.disputeHash).to.equal(ethers.ZeroHash);
    expect(finalizedAccount.disputeTimeout).to.equal(0n);
    expect(collateralAfter.collateral).to.equal(0n);
    expect(collateralAfter.ondelta).to.equal(0n);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(800n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(200n);
  });

  it('carries cooperative ondelta diffs into the next dispute exactly once', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    await depository.mintToReserve(left.entityId, tokenId, 1_000n);

    const fund = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      emptyBatch({
        reserveToCollateral: [
          {
            tokenId,
            receivingEntity: left.entityId,
            pairs: [{ entity: right.entityId, amount: 300n }],
          },
        ],
      }),
    );
    await depository.connect(left.signer).processBatch(fund.encodedBatch, fund.hankoData, fund.nonce);

    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const settlementNonce = 1n;
    const diffs = [
      {
        tokenId,
        leftDiff: 100n,
        rightDiff: 0n,
        collateralDiff: -100n,
        ondeltaDiff: -100n,
      },
    ];
    const settlementSig = signEntityHash(
      right.entityId,
      await cooperativeUpdateHash(depository, acctKey, settlementNonce, diffs),
      right.privateKey,
    );
    const settlement = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      emptyBatch({
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
      }),
    );
    await depository.connect(left.signer).processBatch(settlement.encodedBatch, settlement.hankoData, settlement.nonce);

    const afterCooperative = await depository._collaterals(acctKey, tokenId);
    expect((await depository._accounts(acctKey)).nonce).to.equal(settlementNonce);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(800n);
    expect(afterCooperative.collateral).to.equal(200n);
    expect(afterCooperative.ondelta).to.equal(200n);

    const disputeNonce = 2n;
    const finalNonce = 3n;
    const proof = proofBody([-50n], [tokenId]);
    const proofHash = proofBodyHash(proof);
    const startSig = signEntityHash(
      right.entityId,
      await disputeProofHash(depository, acctKey, disputeNonce, proofHash),
      right.privateKey,
    );
    const disputeStart = {
      counterentity: right.entityId,
      nonce: disputeNonce,
      proofbodyHash: proofHash,
      initialProofbody: proof,
      watchSeed: TEST_WATCH_SEED,
      sig: startSig,
      starterInitialArguments: '0x',
      starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
    };
    const start = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      emptyBatch({ disputeStarts: [disputeStart] }),
    );
    await depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    const finalSig = signEntityHash(
      left.entityId,
      await disputeProofHash(depository, acctKey, finalNonce, proofHash),
      left.privateKey,
    );
    const finalization = {
      counterentity: left.entityId,
      initialNonce: disputeNonce,
      finalNonce,
      initialProofbodyHash: proofHash,
      finalProofbody: proof,
      starterArguments: '0x',
      otherArguments: '0x',
      sig: finalSig,
      startedByLeft: true,
      cooperative: false,
    };
    const finalize = await signDepositoryBatch(
      depository,
      right.entityId,
      right.privateKey,
      emptyBatch({ disputeFinalizations: [finalization] }),
    );
    await depository.connect(right.signer).processBatch(finalize.encodedBatch, finalize.hankoData, finalize.nonce);

    const afterDispute = await depository._collaterals(acctKey, tokenId);
    expect((await depository._accounts(acctKey)).nonce).to.equal(finalNonce);
    expect(afterDispute.collateral).to.equal(0n);
    expect(afterDispute.ondelta).to.equal(0n);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(950n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(50n);

    const replay = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      emptyBatch({ disputeStarts: [disputeStart] }),
    );
    await expect(
      depository.connect(left.signer).processBatch(replay.encodedBatch, replay.hankoData, replay.nonce),
    ).to.be.revertedWithCustomError(depository, 'E2');
  });

  it('binds starter initial and counter dispute arguments independently', async function () {
    const starterInitialArguments = abi.encode(['bytes[]'], [[encodeDeltaTransformerArguments([1])]]);
    const starterCounterArguments = abi.encode(['bytes[]'], [[encodeDeltaTransformerArguments([2])]]);
    const wrongInitialArguments = abi.encode(['bytes[]'], [[encodeDeltaTransformerArguments([3])]]);
    const wrongCounterArguments = abi.encode(['bytes[]'], [[encodeDeltaTransformerArguments([4])]]);

    async function setupStartedDispute() {
      const { depository } = await loadFixture(deployFixture);
      const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
      const initialNonce = 1n;
      const initialProofbody = proofBody([], []);
      const initialProofbodyHash = proofBodyHash(initialProofbody);
      const starterCounterProofCommitment = ethers.keccak256(abi.encode(
        ['uint256', 'bool', 'bytes32'],
        [2n, false, initialProofbodyHash],
      ));
      const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
      const startHash = await disputeProofHash(depository, acctKey, initialNonce, initialProofbodyHash);
      const startSig = signEntityHash(right.entityId, startHash, right.privateKey);
      const startBatch = emptyBatch({
        disputeStarts: [
          {
            counterentity: right.entityId,
            nonce: initialNonce,
            proofbodyHash: initialProofbodyHash,
            initialProofbody,
            watchSeed: TEST_WATCH_SEED,
            sig: startSig,
            starterInitialArguments,
            starterCounterArguments,
            starterCounterProofCommitment,
          },
        ],
      });
      const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, startBatch);
      await depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);
      return { depository, left, right, acctKey, initialNonce, initialProofbody, initialProofbodyHash };
    }

    async function signFinalBatch(depository: Depository, entity: TestActor, finalization: Record<string, unknown>) {
      return signDepositoryBatch(
        depository,
        entity.entityId,
        entity.privateKey,
        emptyBatch({ disputeFinalizations: [finalization] }),
      );
    }

    {
      const { depository, left, right, initialNonce, initialProofbody, initialProofbodyHash } =
        await setupStartedDispute();
      await advancePastDisputeTimeout(depository, left.entityId, right.entityId);
      const finalization = {
        counterentity: right.entityId,
        initialNonce,
        finalNonce: initialNonce,
        initialProofbodyHash,
        finalProofbody: initialProofbody,
        starterArguments: starterInitialArguments,
        otherArguments: '0x',
        sig: '0x',
        startedByLeft: true,
        cooperative: false,
      };
      const final = await signFinalBatch(depository, left, finalization);
      await depository.connect(left.signer).processBatch(final.encodedBatch, final.hankoData, final.nonce);
      expect(
        (await depository._accounts(await accountKeyFor(depository, left.entityId, right.entityId))).disputeHash,
      ).to.equal(ethers.ZeroHash);
    }

    {
      const { depository, left, right, initialNonce, initialProofbody, initialProofbodyHash } =
        await setupStartedDispute();
      await advancePastDisputeTimeout(depository, left.entityId, right.entityId);
      const finalization = {
        counterentity: right.entityId,
        initialNonce,
        finalNonce: initialNonce,
        initialProofbodyHash,
        finalProofbody: initialProofbody,
        starterArguments: starterCounterArguments,
        otherArguments: '0x',
        sig: '0x',
        startedByLeft: true,
        cooperative: false,
      };
      const final = await signFinalBatch(depository, left, finalization);
      await expect(
        depository.connect(left.signer).processBatch(final.encodedBatch, final.hankoData, final.nonce),
      ).to.be.revertedWithCustomError(depository, 'E9');
    }

    {
      const { depository, left, right, initialNonce, initialProofbody, initialProofbodyHash } =
        await setupStartedDispute();
      await advancePastDisputeTimeout(depository, left.entityId, right.entityId);
      const finalization = {
        counterentity: right.entityId,
        initialNonce,
        finalNonce: initialNonce,
        initialProofbodyHash,
        finalProofbody: initialProofbody,
        starterArguments: wrongInitialArguments,
        otherArguments: '0x',
        sig: '0x',
        startedByLeft: true,
        cooperative: false,
      };
      const final = await signFinalBatch(depository, left, finalization);
      await expect(
        depository.connect(left.signer).processBatch(final.encodedBatch, final.hankoData, final.nonce),
      ).to.be.revertedWithCustomError(depository, 'E9');
    }

    {
      const { depository, left, right, initialNonce, initialProofbody, initialProofbodyHash } =
        await setupStartedDispute();
      await advancePastDisputeTimeout(depository, left.entityId, right.entityId);
      const finalization = {
        counterentity: right.entityId,
        initialNonce,
        finalNonce: initialNonce,
        initialProofbodyHash,
        finalProofbody: initialProofbody,
        starterArguments: starterInitialArguments,
        otherArguments: '0x',
        sig: '0x',
        startedByLeft: false,
        cooperative: false,
      };
      const final = await signFinalBatch(depository, left, finalization);
      await expect(
        depository.connect(left.signer).processBatch(final.encodedBatch, final.hankoData, final.nonce),
      ).to.be.revertedWithCustomError(depository, 'E9');
    }

    {
      const { depository, left, right, initialNonce, initialProofbodyHash } = await setupStartedDispute();
      const finalNonce = 2n;
      const finalProofbody = proofBody([], []);
      const finalProofbodyHash = proofBodyHash(finalProofbody);
      const finalHash = await disputeProofHash(
        depository,
        await accountKeyFor(depository, left.entityId, right.entityId),
        finalNonce,
        finalProofbodyHash,
      );
      const finalization = {
        counterentity: left.entityId,
        initialNonce,
        finalNonce,
        initialProofbodyHash,
        finalProofbody,
        starterArguments: starterCounterArguments,
        otherArguments: '0x',
        sig: signEntityHash(left.entityId, finalHash, left.privateKey),
        startedByLeft: true,
        cooperative: false,
      };
      const final = await signFinalBatch(depository, right, finalization);
      await depository.connect(right.signer).processBatch(final.encodedBatch, final.hankoData, final.nonce);
      expect(
        (await depository._accounts(await accountKeyFor(depository, left.entityId, right.entityId))).nonce,
      ).to.equal(finalNonce);
    }

    {
      const { depository, left, right, initialNonce, initialProofbodyHash } = await setupStartedDispute();
      const finalNonce = 2n;
      const finalProofbody = proofBody([], []);
      const finalProofbodyHash = proofBodyHash(finalProofbody);
      const finalHash = await disputeProofHash(
        depository,
        await accountKeyFor(depository, left.entityId, right.entityId),
        finalNonce,
        finalProofbodyHash,
      );
      const finalization = {
        counterentity: left.entityId,
        initialNonce,
        finalNonce,
        initialProofbodyHash,
        finalProofbody,
        starterArguments: wrongCounterArguments,
        otherArguments: '0x',
        sig: signEntityHash(left.entityId, finalHash, left.privateKey),
        startedByLeft: true,
        cooperative: false,
      };
      const final = await signFinalBatch(depository, right, finalization);
      await expect(
        depository.connect(right.signer).processBatch(final.encodedBatch, final.hankoData, final.nonce),
      ).to.be.revertedWithCustomError(depository, 'E9');
    }
  });

  it('treats malformed dispute argument wrappers as empty evidence', async function () {
    const { depository } = await loadFixture(deployFixture);
    const DeltaTransformer = await ethers.getContractFactory('DeltaTransformer');
    const transformer = await DeltaTransformer.deploy();
    await transformer.waitForDeployment();

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const encodedSwapBatch = await transformer.encodeBatch({
      payment: [],
      swap: [
        {
          ownerIsLeft: false,
          addDeltaIndex: 0,
          addAmount: 100n,
          subDeltaIndex: 1,
          subAmount: 100n,
        },
      ],
      pull: [],
    });
    const proofbody = proofBody(
      [0n, 0n],
      [1n, 2n],
      [
        {
          transformerAddress: await transformer.getAddress(),
          encodedBatch: encodedSwapBatch,
          allowances: [
            { deltaIndex: 0n, rightAllowance: 0n, leftAllowance: 100n },
            { deltaIndex: 1n, rightAllowance: 100n, leftAllowance: 0n },
          ],
        },
      ],
    );
    const proofbodyHash = proofBodyHash(proofbody);
    const starterInitialArguments = '0x1234';
    const disputeNonce = 1n;
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, proofbodyHash);
    const startSig = signEntityHash(right.entityId, startHash, right.privateKey);
    const startBatch = emptyBatch({
      disputeStarts: [
        {
          counterentity: right.entityId,
          nonce: disputeNonce,
          proposerIsLeft: false,
          proofbodyHash,
          initialProofbody: proofbody,
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
    await advancePastDisputeTimeout(depository, left.entityId, right.entityId);

    const finalization = {
      counterentity: right.entityId,
      initialNonce: disputeNonce,
      finalNonce: disputeNonce,
      initialProofbodyHash: proofbodyHash,
      finalProofbody: proofbody,
      starterArguments: starterInitialArguments,
      otherArguments: '0x',
      sig: '0x',
      startedByLeft: true,
      cooperative: false,
    };
    const final = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      emptyBatch({ disputeFinalizations: [finalization] }),
    );

    await expect(
      depository.connect(left.signer).processBatch(final.encodedBatch, final.hankoData, final.nonce),
    ).to.emit(depository, 'DisputeFinalized');
    expect((await depository._accounts(acctKey)).disputeHash).to.equal(ethers.ZeroHash);
    expect(await depository._reserves(left.entityId, 1n)).to.equal(0n);
    expect(await depository._reserves(right.entityId, 2n)).to.equal(0n);
  });

  it('never accepts starter argument blobs that cannot be repeated inside a 15M-gas finalization', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const finalProofbody = proofBody([], []);
    const finalProofbodyHash = proofBodyHash(finalProofbody);
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const disputeNonce = 1n;
    // Two 168 KiB blobs fit the start transaction today, but finalization must
    // repeat both and duplicate the selected starter side. The accepted start
    // must therefore either be rejected by the argument budget or remain
    // executable within the jurisdiction's 15M-gas liveness envelope.
    const starterInitialArguments = `0x${'ff'.repeat(168 * 1024)}`;
    const starterCounterArguments = `0x${'ee'.repeat(168 * 1024)}`;
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, finalProofbodyHash);
    const start = await signDepositoryBatch(
      depository,
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
            starterInitialArguments,
            starterCounterArguments,
            starterCounterProofCommitment: ethers.ZeroHash,
          },
        ],
      }),
    );

    try {
      const startTx = await depository
        .connect(left.signer)
        .processBatch(start.encodedBatch, start.hankoData, start.nonce, { gasLimit: 15_000_000n });
      await startTx.wait();
    } catch (error) {
      expect(String(error)).to.contain('E10');
      return;
    }

    await advancePastDisputeTimeout(depository, left.entityId, right.entityId);
    const final = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      emptyBatch({
        disputeFinalizations: [
          {
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
          },
        ],
      }),
    );
    await expect(
      depository
        .connect(left.signer)
        .processBatch(final.encodedBatch, final.hankoData, final.nonce, { gasLimit: 15_000_000n }),
    ).to.emit(depository, 'DisputeFinalized');
    expect((await depository._accounts(acctKey)).disputeHash).to.equal(ethers.ZeroHash);
  });

  it('never accepts a signed proof body that cannot be revealed inside a 15M-gas finalization', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const oversizedProofbody = proofBody(
      [],
      [],
      [
        {
          transformerAddress: user0.address,
          // Just above the 176 KiB signed-body cap while still below the 15M
          // intrinsic calldata floor, so the contract itself must reject E10.
          encodedBatch: `0x${'dd'.repeat(180 * 1024)}`,
          allowances: [],
        },
      ],
    );
    const oversizedProofbodyHash = proofBodyHash(oversizedProofbody);
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const disputeNonce = 1n;
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, oversizedProofbodyHash);
    const start = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      emptyBatch({
        disputeStarts: [
          {
            counterentity: right.entityId,
            nonce: disputeNonce,
            proofbodyHash: oversizedProofbodyHash,
            initialProofbody: oversizedProofbody,
            watchSeed: TEST_WATCH_SEED,
            sig: signEntityHash(right.entityId, startHash, right.privateKey),
            starterInitialArguments: '0x',
            starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
          },
        ],
      }),
    );
    await expect(
      depository
        .connect(left.signer)
        .processBatch(start.encodedBatch, start.hankoData, start.nonce, { gasLimit: 15_000_000n }),
    ).to.be.revertedWithCustomError(depository, 'E10');
    expect((await depository._accounts(acctKey)).disputeHash).to.equal(ethers.ZeroHash);
  });

  it('keeps the dispute active when any signed transformer cannot execute exactly', async function () {
    const failureModes = [
      'no-code',
      'revert',
      'out-of-gas',
      'malformed-batch',
      'short-return',
      'wrong-length',
      'malformed-return',
      'return-bomb',
    ] as const;

    for (const failureMode of failureModes) {
      const { depository: target } = await loadFixture(deployFixture);
      const Harness = await ethers.getContractFactory('TransformerLivenessHarness');
      const harness = await Harness.deploy();
      await harness.waitForDeployment();
      const [, , noCodeSigner] = await ethers.getSigners();
      const tokenId = 101n;
      const mode = {
        revert: TRANSFORMER_MODE.revertCall,
        'out-of-gas': TRANSFORMER_MODE.exhaustGas,
        'short-return': TRANSFORMER_MODE.shortReturn,
        'wrong-length': TRANSFORMER_MODE.wrongLength,
        'malformed-return': TRANSFORMER_MODE.malformedReturn,
        'return-bomb': TRANSFORMER_MODE.returnBomb,
      }[failureMode as Exclude<typeof failureMode, 'no-code' | 'malformed-batch'>];
      const transformerAddress = failureMode === 'no-code'
        ? noCodeSigner.address
        : await harness.getAddress();
      const encodedBatch = failureMode === 'no-code'
        ? '0x'
        : failureMode === 'malformed-batch'
          ? '0x1234'
          : await harness.encode(mode, 0n, 0n, tokenId);
      const dispute = await buildTimedOutTransformerFinalization(
        target,
        [tokenId],
        [-100n],
        [{
          transformerAddress,
          encodedBatch,
          allowances: [{ deltaIndex: 0n, rightAllowance: 100n, leftAllowance: 100n }],
        }],
      );

      await expect(
        target
          .connect(dispute.left.signer)
          .processBatch(dispute.final.encodedBatch, dispute.final.hankoData, dispute.final.nonce, {
            gasLimit: 15_000_000n,
          }),
        failureMode,
      ).to.be.revertedWithCustomError(target, 'TransformerExecutionFailed');
      expect((await target._accounts(dispute.accountKey)).disputeHash, failureMode)
        .to.not.equal(ethers.ZeroHash);
      expect(await target._reserves(dispute.left.entityId, tokenId), failureMode).to.equal(0n);
      expect(await target._reserves(dispute.right.entityId, tokenId), failureMode).to.equal(0n);
    }
  });

  it('reverts caller gas starvation without consuming the active dispute', async function () {
    const { depository } = await loadFixture(deployFixture);
    const Harness = await ethers.getContractFactory('TransformerLivenessHarness');
    const harness = await Harness.deploy();
    await harness.waitForDeployment();
    const tokenId = 115n;
    const transformerAddress = await harness.getAddress();
    const encodedBatch = await harness.encode(TRANSFORMER_MODE.add, 0n, 10n, tokenId);
    const transformers = [{
      transformerAddress,
      encodedBatch,
      allowances: [{ deltaIndex: 0n, rightAllowance: 0n, leftAllowance: 10n }],
    }];
    const dispute = await buildTimedOutTransformerFinalization(
      depository,
      [tokenId],
      [-100n],
      transformers,
    );

    await expect(
      depository
        .connect(dispute.left.signer)
        .processBatch(dispute.final.encodedBatch, dispute.final.hankoData, dispute.final.nonce, {
          gasLimit: 2_500_000n,
        }),
    ).to.be.revertedWithCustomError(depository, 'TransformerGasBudgetUnavailable');
    expect((await depository._accounts(dispute.accountKey)).disputeHash).to.not.equal(ethers.ZeroHash);

    await expect(
      depository
        .connect(dispute.left.signer)
        .processBatch(dispute.final.encodedBatch, dispute.final.hankoData, dispute.final.nonce, {
          gasLimit: 15_000_000n,
        }),
    ).to.emit(depository, 'DisputeFinalized');
    expect((await depository._accounts(dispute.accountKey)).disputeHash).to.equal(ethers.ZeroHash);
  });

  it('rejects over-budget transformer arguments without consuming the active dispute', async function () {
    const { depository } = await loadFixture(deployFixture);
    const Harness = await ethers.getContractFactory('TransformerLivenessHarness');
    const harness = await Harness.deploy();
    await harness.waitForDeployment();
    const tokenId = 113n;
    const oversizedArgument = `0x${'00'.repeat(512 * 1024)}`;
    const oversizedArgumentList = abi.encode(['bytes[]'], [[oversizedArgument]]);
    const dispute = await buildTimedOutTransformerFinalization(
      depository,
      [tokenId],
      [-100n],
      [
        {
          transformerAddress: await harness.getAddress(),
          encodedBatch: await harness.encode(TRANSFORMER_MODE.add, 0n, 10n, tokenId),
          allowances: [{ deltaIndex: 0n, rightAllowance: 0n, leftAllowance: 10n }],
        },
      ],
    );

    const oversizedFinal = await signDepositoryBatch(
      depository,
      dispute.left.entityId,
      dispute.left.privateKey,
      emptyBatch({
        disputeFinalizations: [
          {
            ...dispute.finalization,
            otherArguments: oversizedArgumentList,
          },
        ],
      }),
    );
    await expect(
      depository
        .connect(dispute.left.signer)
        .processBatch(oversizedFinal.encodedBatch, oversizedFinal.hankoData, oversizedFinal.nonce, {
          gasLimit: 15_000_000n,
        }),
    ).to.be.revertedWithCustomError(depository, 'E10');
    expect((await depository._accounts(dispute.accountKey)).disputeHash).to.not.equal(ethers.ZeroHash);

    const tx = await depository
      .connect(dispute.left.signer)
      .processBatch(dispute.final.encodedBatch, dispute.final.hankoData, dispute.final.nonce, {
        gasLimit: 15_000_000n,
      });
    const receipt = await tx.wait();
    expect((await depository._accounts(dispute.accountKey)).disputeHash).to.equal(ethers.ZeroHash);
    expect(receipt?.gasUsed).to.be.lessThan(15_000_000n);
  });

  it('executes a near-limit valid signed transformer batch within the 15M envelope', async function () {
    const { depository } = await loadFixture(deployFixture);
    const Harness = await ethers.getContractFactory('TransformerLivenessHarness');
    const harness = await Harness.deploy();
    await harness.waitForDeployment();
    const tokenId = 114n;
    const prefix = (await harness.encode(TRANSFORMER_MODE.add, 0n, 10n, tokenId)).slice(2);
    const nearLimitBatch = `0x${prefix}${'00'.repeat(168 * 1024 - prefix.length / 2)}`;
    const dispute = await buildTimedOutTransformerFinalization(
      depository,
      [tokenId],
      [-100n],
      [
        {
          transformerAddress: await harness.getAddress(),
          encodedBatch: nearLimitBatch,
          allowances: [{ deltaIndex: 0n, rightAllowance: 0n, leftAllowance: 10n }],
        },
      ],
    );

    const tx = await depository
      .connect(dispute.left.signer)
      .processBatch(dispute.final.encodedBatch, dispute.final.hankoData, dispute.final.nonce, {
        gasLimit: 15_000_000n,
      });
    const receipt = await tx.wait();
    expect((await depository._accounts(dispute.accountKey)).disputeHash).to.equal(ethers.ZeroHash);
    expect(receipt?.gasUsed).to.be.lessThan(15_000_000n);
  });

  it('reverts the whole signed transformer program when one clause mutates an unallowed token', async function () {
    const { depository } = await loadFixture(deployFixture);
    const Harness = await ethers.getContractFactory('TransformerLivenessHarness');
    const harness = await Harness.deploy();
    await harness.waitForDeployment();
    const transformerAddress = await harness.getAddress();
    const tokenA = 103n;
    const tokenB = 104n;
    const transformers = [
      {
        transformerAddress,
        encodedBatch: await harness.encode(TRANSFORMER_MODE.add, 0n, 20n, tokenA),
        allowances: [{ deltaIndex: 0n, rightAllowance: 0n, leftAllowance: 20n }],
      },
      {
        transformerAddress,
        encodedBatch: await harness.encode(TRANSFORMER_MODE.add, 1n, 50n, tokenB),
        allowances: [{ deltaIndex: 0n, rightAllowance: 0n, leftAllowance: 100n }],
      },
      {
        transformerAddress,
        encodedBatch: await harness.encode(TRANSFORMER_MODE.add, 0n, 10n, tokenA),
        allowances: [{ deltaIndex: 0n, rightAllowance: 0n, leftAllowance: 10n }],
      },
    ];
    const dispute = await buildTimedOutTransformerFinalization(
      depository,
      [tokenA, tokenB],
      [-100n, -100n],
      transformers,
    );

    await expect(
      depository
        .connect(dispute.left.signer)
        .processBatch(dispute.final.encodedBatch, dispute.final.hankoData, dispute.final.nonce, {
          gasLimit: 15_000_000n,
        }),
    ).to.be.revertedWithCustomError(depository, 'TransformerExecutionFailed');
    expect((await depository._accounts(dispute.accountKey)).disputeHash).to.not.equal(ethers.ZeroHash);
    expect(await depository._reserves(dispute.left.entityId, tokenA)).to.equal(0n);
    expect(await depository._reserves(dispute.right.entityId, tokenA)).to.equal(0n);
    expect(await depository._reserves(dispute.left.entityId, tokenB)).to.equal(0n);
    expect(await depository._reserves(dispute.right.entityId, tokenB)).to.equal(0n);
  });

  it('rejects out-of-range and duplicate transformer allowances', async function () {
    const invalidAllowances = [
      [{ deltaIndex: 1n, rightAllowance: 0n, leftAllowance: 50n }],
      [
        { deltaIndex: 0n, rightAllowance: 0n, leftAllowance: 25n },
        { deltaIndex: 0n, rightAllowance: 0n, leftAllowance: 25n },
      ],
    ];
    for (const allowances of invalidAllowances) {
      const { depository: target } = await loadFixture(deployFixture);
      const Harness = await ethers.getContractFactory('TransformerLivenessHarness');
      const harness = await Harness.deploy();
      await harness.waitForDeployment();
      const tokenId = 111n;
      const dispute = await buildTimedOutTransformerFinalization(
        target,
        [tokenId],
        [-100n],
        [{
          transformerAddress: await harness.getAddress(),
          encodedBatch: await harness.encode(TRANSFORMER_MODE.add, 0n, 50n, tokenId),
          allowances,
        }],
      );

      await expect(
        target
          .connect(dispute.left.signer)
          .processBatch(dispute.final.encodedBatch, dispute.final.hankoData, dispute.final.nonce),
      ).to.be.revertedWithCustomError(target, 'TransformerExecutionFailed');
      expect((await target._accounts(dispute.accountKey)).disputeHash).to.not.equal(ethers.ZeroHash);
    }
  });

  it('clamps oversized and int256-min transformer outputs to signed per-token holds', async function () {
    const { depository } = await loadFixture(deployFixture);
    const Harness = await ethers.getContractFactory('TransformerLivenessHarness');
    const harness = await Harness.deploy();
    await harness.waitForDeployment();
    const transformerAddress = await harness.getAddress();
    const tokenA = await registerFixedSupplyErc20(depository, 1_000n);
    const tokenB = await registerFixedSupplyErc20(depository, 1_000n);
    const int256Max = (1n << 255n) - 1n;
    const int256Min = -(1n << 255n);
    const transformers = [
      {
        transformerAddress,
        encodedBatch: await harness.encode(TRANSFORMER_MODE.absolute, 0n, int256Max, tokenA),
        allowances: [{ deltaIndex: 0n, rightAllowance: 0n, leftAllowance: 40n }],
      },
      {
        transformerAddress,
        encodedBatch: await harness.encode(TRANSFORMER_MODE.absolute, 1n, int256Min, tokenB),
        allowances: [{ deltaIndex: 1n, rightAllowance: 25n, leftAllowance: 0n }],
      },
    ];
    const dispute = await buildTimedOutTransformerFinalization(
      depository,
      [tokenA, tokenB],
      [-100n, -100n],
      transformers,
    );

    const tx = await depository
      .connect(dispute.left.signer)
      .processBatch(dispute.final.encodedBatch, dispute.final.hankoData, dispute.final.nonce, {
        gasLimit: 15_000_000n,
      });
    const receipt = await tx.wait();
    const clamps = decodedEvents(receipt, 'TransformerDeltaClamped');

    expect(clamps).to.have.length(2);
    expect(clamps.map(event => event.tokenId)).to.deep.equal([tokenA, tokenB]);
    expect(clamps.map(event => event.appliedValue)).to.deep.equal([40n, -25n]);
    expect(await depository._reserves(dispute.left.entityId, tokenA)).to.equal(40n);
    expect(await depository._reserves(dispute.right.entityId, tokenA)).to.equal(60n);
    expect(await depository._reserves(dispute.right.entityId, tokenB)).to.equal(100n);
    expect(await depository.debtOutstanding(dispute.left.entityId, tokenB)).to.equal(25n);
  });

  it('never returns int256.min when a transformer has the maximum right allowance', async function () {
    const { depository } = await loadFixture(deployFixture);
    const Harness = await ethers.getContractFactory('TransformerLivenessHarness');
    const harness = await Harness.deploy();
    await harness.waitForDeployment();
    const tokenId = await registerFixedSupplyErc20(depository, (1n << 255n) - 1n);
    const int256Min = -(1n << 255n);
    const uint256Max = (1n << 256n) - 1n;
    const dispute = await buildTimedOutTransformerFinalization(
      depository,
      [tokenId],
      [-100n],
      [
        {
          transformerAddress: await harness.getAddress(),
          encodedBatch: await harness.encode(TRANSFORMER_MODE.absolute, 0n, int256Min, tokenId),
          allowances: [{ deltaIndex: 0n, rightAllowance: uint256Max, leftAllowance: 0n }],
        },
      ],
    );

    await expect(
      depository
        .connect(dispute.left.signer)
        .processBatch(dispute.final.encodedBatch, dispute.final.hankoData, dispute.final.nonce, {
          gasLimit: 15_000_000n,
        }),
    ).to.emit(depository, 'DisputeFinalized');
    expect((await depository._accounts(dispute.accountKey)).disputeHash).to.equal(ethers.ZeroHash);
    expect(await depository.debtOutstanding(dispute.left.entityId, tokenId)).to.equal((1n << 255n) - 1n);
  });

  it('rejects a transformer when its exact base delta cannot fit the signed ABI', async function () {
    const { depository } = await loadFixture(deployFixture);
    const Harness = await ethers.getContractFactory('TransformerLivenessHarness');
    const harness = await Harness.deploy();
    await harness.waitForDeployment();
    const tokenId = await registerFixedSupplyErc20(depository, (1n << 255n) - 1n);
    const int256Min = -(1n << 255n);
    const dispute = await buildTimedOutTransformerFinalization(
      depository,
      [tokenId],
      [int256Min],
      [
        {
          transformerAddress: await harness.getAddress(),
          encodedBatch: await harness.encode(TRANSFORMER_MODE.absolute, 0n, int256Min, tokenId),
          allowances: [{ deltaIndex: 0n, rightAllowance: 0n, leftAllowance: 0n }],
        },
      ],
      { skipFunding: true },
    );

    await expect(
      depository
        .connect(dispute.left.signer)
        .processBatch(dispute.final.encodedBatch, dispute.final.hankoData, dispute.final.nonce, {
          gasLimit: 15_000_000n,
        }),
    ).to.be.revertedWithCustomError(depository, 'TransformerExecutionFailed');
    expect((await depository._accounts(dispute.accountKey)).disputeHash).to.not.equal(ethers.ZeroHash);
    expect(await depository.debtOutstanding(dispute.left.entityId, tokenId)).to.equal(0n);
  });

  it('executes the runtime maximum swap book inside the bounded transformer call', async function () {
    const { depository } = await loadFixture(deployFixture);
    const DeltaTransformer = await ethers.getContractFactory('DeltaTransformer');
    const transformer = await DeltaTransformer.deploy();
    await transformer.waitForDeployment();
    const tokenA = 109n;
    const tokenB = 110n;
    const encodedBatch = await transformer.encodeBatch({
      payment: [],
      swap: Array.from({ length: 1_000 }, () => ({
        ownerIsLeft: true,
        addDeltaIndex: 0,
        addAmount: 1n,
        subDeltaIndex: 1,
        subAmount: 1n,
      })),
      pull: [],
    });
    const fullFillArguments = encodeDeltaTransformerArguments(
      Array.from({ length: 1_000 }, () => Number(MAX_FILL_RATIO)),
    );
    const rightArguments = abi.encode(['bytes[]'], [[fullFillArguments]]);
    const dispute = await buildTimedOutTransformerFinalization(
      depository,
      [tokenA, tokenB],
      [-100n, -100n],
      [
        {
          transformerAddress: await transformer.getAddress(),
          encodedBatch,
          allowances: [
            { deltaIndex: 0n, rightAllowance: 0n, leftAllowance: 1_000n },
            { deltaIndex: 1n, rightAllowance: 1_000n, leftAllowance: 0n },
          ],
        },
      ],
      { rightArguments },
    );

    // Dynamic right-side fill evidence belongs to the non-starter. Rebuild
    // only the outer batch orientation so Bob submits his own arguments;
    // Alice must never impersonate them even after timeout.
    const nonstarterFinal = await signDepositoryBatch(
      depository,
      dispute.right.entityId,
      dispute.right.privateKey,
      emptyBatch({
        disputeFinalizations: [{
          ...dispute.finalization,
          counterentity: dispute.left.entityId,
        }],
      }),
    );

    const tx = await depository
      .connect(dispute.right.signer)
      .processBatch(nonstarterFinal.encodedBatch, nonstarterFinal.hankoData, nonstarterFinal.nonce, {
        gasLimit: 15_000_000n,
      });
    const receipt = await tx.wait();
    expect((await depository._accounts(dispute.accountKey)).disputeHash).to.equal(ethers.ZeroHash);
    expect(receipt?.gasUsed).to.be.lessThan(15_000_000n);
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
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
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

  it('allows a designated tower to submit a delayed last-resort counter-dispute', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [, , tower] = await hre.ethers.getSigners();

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    const appointmentSequence = 7n;
    const lastResortWindowSeconds = 16n;
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

    await expect(
      depository
        .connect(tower)
        .watchtowerCounterDispute(
          right.entityId,
          finalization,
          lastResortWindowSeconds,
          appointmentSequence,
          ownerAuthorization,
        ),
    ).to.be.revertedWithCustomError(depository, 'E2');

    const currentTimestamp = BigInt(await time.latest());
    const timeoutTimestamp = (await depository._accounts(acctKey)).disputeTimeout;
    const lastResortStartTimestamp = timeoutTimestamp - lastResortWindowSeconds;
    if (lastResortStartTimestamp > currentTimestamp) {
      await time.increaseTo(Number(lastResortStartTimestamp));
    }

    const unsafeFinalNonce = 9_007_199_254_740_991n;
    const unsafeFinalHash = await disputeProofHash(
      depository,
      acctKey,
      unsafeFinalNonce,
      finalProofbodyHash,
      TEST_WATCH_SEED,
      true,
    );
    const unsafeOwnerAuthHash = await watchtowerCounterDisputeHash(
      depository,
      tower.address,
      right.entityId,
      left.entityId,
      unsafeFinalNonce,
      finalProofbodyHash,
      lastResortWindowSeconds,
      appointmentSequence,
    );
    const unsafeFinalization = {
      ...finalization,
      finalNonce: unsafeFinalNonce,
      sig: signEntityHash(left.entityId, unsafeFinalHash, left.privateKey),
    };
    const unsafeOwnerAuthorization = signEntityHash(
      right.entityId,
      unsafeOwnerAuthHash,
      right.privateKey,
    );
    await expect(
      depository
        .connect(tower)
        .watchtowerCounterDispute(
          right.entityId,
          unsafeFinalization,
          lastResortWindowSeconds,
          appointmentSequence,
          unsafeOwnerAuthorization,
        ),
    ).to.be.revertedWithCustomError(depository, 'E10');

    await expect(
      depository
        .connect(tower)
        .watchtowerCounterDispute(
          right.entityId,
          finalization,
          lastResortWindowSeconds,
          appointmentSequence,
          ownerAuthorization,
        ),
    )
      .to.emit(depository, 'CounterDisputeRegistered')
      .withArgs(right.entityId, left.entityId, finalNonce, true, finalProofbodyHash);

    // The tower may lock the newer signed branch during the last-resort
    // window, but the same finalization barrier T applies to everyone. A
    // second submission at T executes the already-selected proof.
    await time.increaseTo(Number(timeoutTimestamp));
    await expect(
      depository
        .connect(tower)
        .watchtowerCounterDispute(
          right.entityId,
          unsafeFinalization,
          lastResortWindowSeconds,
          appointmentSequence,
          unsafeOwnerAuthorization,
        ),
    ).to.be.revertedWithCustomError(depository, 'E10');
    await expect(
      depository
        .connect(tower)
        .watchtowerCounterDispute(
          right.entityId,
          finalization,
          lastResortWindowSeconds,
          appointmentSequence,
          ownerAuthorization,
        ),
    )
      .to.emit(depository, 'WatchtowerCounterDisputeExecuted')
      .withArgs(tower.address, right.entityId, left.entityId, finalNonce, appointmentSequence);

    const finalizedAccount = await depository._accounts(acctKey);
    const collateralAfter = await depository._collaterals(acctKey, tokenId);
    expect(finalizedAccount.nonce).to.equal(finalNonce);
    expect(finalizedAccount.disputeHash).to.equal(ethers.ZeroHash);
    expect(collateralAfter.collateral).to.equal(0n);
    expect(collateralAfter.ondelta).to.equal(0n);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(800n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(200n);
  });

  it('never lets a tower start a dispute when no active dispute exists', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [, , tower] = await hre.ethers.getSigners();

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
