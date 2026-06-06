import { loadFixture, mine, time } from "@nomicfoundation/hardhat-toolbox/network-helpers.js";
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import type { Depository } from "../typechain-types/index.js";
import { Contract } from "ethers";
import {
  addressEntityId,
  buildSingleSignerHanko,
  computeDepositoryBatchHash,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  singleSignerLazyEntityId,
} from "./helpers/hanko.ts";

const abi = ethers.AbiCoder.defaultAbiCoder();
const COOPERATIVE_UPDATE = 0;
const DISPUTE_PROOF = 1;
const COOPERATIVE_DISPUTE_PROOF = 3;
const MAX_FILL_RATIO = 65535n;

const SETTLEMENT_DIFFS_ABI = "tuple(uint256 tokenId,int256 leftDiff,int256 rightDiff,int256 collateralDiff,int256 ondeltaDiff)[]";
const PROOF_BODY_ABI =
  "tuple(int256[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)";

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
): Promise<{ encodedBatch: string; hankoData: string; nonce: bigint }> {
  const encodedBatch = encodeBatch(batch);
  const nextNonce = nonce ?? ((await depository.entityNonces(entityId)) + 1n);
  const batchHash = await computeDepositoryBatchHash(depository, encodedBatch, nextNonce);
  return {
    encodedBatch,
    hankoData: buildSingleSignerHanko(entityId, batchHash, privateKey),
    nonce: nextNonce,
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
  return ethers.keccak256(abi.encode(
    ["uint8", "address", "bytes", "uint256", SETTLEMENT_DIFFS_ABI, "uint256[]"],
    [COOPERATIVE_UPDATE, await depository.getAddress(), accountKey, nonce, diffs, forgiveDebtsInTokenIds],
  ));
}

async function disputeProofHash(
  depository: Depository,
  accountKey: string,
  nonce: bigint,
  proofbodyHash: string,
): Promise<string> {
  return ethers.keccak256(abi.encode(
    ["uint8", "address", "bytes", "uint256", "bytes32"],
    [DISPUTE_PROOF, await depository.getAddress(), accountKey, nonce, proofbodyHash],
  ));
}

async function cooperativeDisputeProofHash(
  depository: Depository,
  accountKey: string,
  nonce: bigint,
  proofbody: Record<string, unknown>,
  initialArguments: string,
): Promise<string> {
  return ethers.keccak256(abi.encode(
    ["uint8", "address", "bytes", "uint256", "bytes32", "bytes32"],
    [
      COOPERATIVE_DISPUTE_PROOF,
      await depository.getAddress(),
      accountKey,
      nonce,
      proofBodyHash(proofbody),
      ethers.keccak256(initialArguments),
    ],
  ));
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
    offdeltas,
    tokenIds,
    transformers,
  };
}

function secret(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function hashNode(node: string): string {
  return ethers.keccak256(abi.encode(["bytes32"], [node]));
}

function hashSteps(node: string, steps: number): string {
  let current = node;
  for (let i = 0; i < steps; i++) current = hashNode(current);
  return current;
}

function nibbles(fillRatio: number): number[] {
  return [
    (fillRatio >> 12) & 0x0f,
    (fillRatio >> 8) & 0x0f,
    (fillRatio >> 4) & 0x0f,
    fillRatio & 0x0f,
  ];
}

function partialRoot(roots: string[]): string {
  return ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32", "bytes32", "bytes32"], roots));
}

function buildHashLadderProof(label: string, fillRatio: number): {
  fullSecret: string;
  fullHash: string;
  partialRoot: string;
  reveals: string[];
} {
  const fullSecret = secret(`${label}:full`);
  const bases = [0, 1, 2, 3].map((index) => secret(`${label}:n${index}`));
  const roots = bases.map((base) => hashSteps(base, 15));
  const reveals = nibbles(fillRatio).map((digit, index) => hashSteps(bases[index], 15 - digit));
  return {
    fullSecret,
    fullHash: hashNode(fullSecret),
    partialRoot: partialRoot(roots),
    reveals,
  };
}

function encodeDeltaTransformerArguments(fillRatios: number[] = [], secrets: string[] = [], pulls: string[] = []): string {
  return abi.encode(
    ["tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)"],
    [{ fillRatios, secrets, pulls }],
  );
}

function encodePartialPullBinary(fillRatio: number, reveals: string[]): string {
  return `0x${fillRatio.toString(16).padStart(4, "0")}${reveals.map((reveal) => reveal.slice(2)).join("")}`;
}

describe("Depository", function () {
  let user0: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let depository: Depository;
  let erc20: Contract;
  let erc721: Contract;
  let erc1155: Contract;

  async function deployFixture() {
    [user0, user1] = await hre.ethers.getSigners();

    // Deploy EntityProvider
    const EntityProviderFactory = await hre.ethers.getContractFactory("EntityProvider");
    const entityProvider = await EntityProviderFactory.deploy();
    await entityProvider.waitForDeployment();

    // Deploy Account library first
    const AccountFactory = await hre.ethers.getContractFactory("Account");
    const account = await AccountFactory.deploy();
    await account.waitForDeployment();

    // Deploy Depository with Account library linked
    const DepositoryFactory = await hre.ethers.getContractFactory("Depository", {
      libraries: {
        Account: await account.getAddress()
      }
    });
    depository = await DepositoryFactory.deploy(await entityProvider.getAddress());
    await depository.waitForDeployment();

    // Deploy ERC20 mock contract
    const ERC20Mock = await hre.ethers.getContractFactory("ERC20Mock");
    erc20 = await ERC20Mock.deploy("ERC20Mock", "ERC20", 1_000_000);
    await erc20.waitForDeployment();

    // Deploy ERC721 mock contract
    const ERC721Mock = await hre.ethers.getContractFactory("ERC721Mock");
    erc721 = await ERC721Mock.deploy("ERC721Mock", "ERC721");
    await erc721.waitForDeployment();
    await erc721.mint(user0.address, 1);

    // Deploy ERC1155 mock contract
    const ERC1155Mock = await hre.ethers.getContractFactory("ERC1155Mock");
    erc1155 = await ERC1155Mock.deploy();
    await erc1155.waitForDeployment();
    await erc1155.mint(user0.address, 0, 100, "0x");

    return { depository, erc20, erc721, erc1155, user0, user1 };
  }

  it("ERC20 deposit to reserve", async function () {
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

    const erc20id = await depository.getTokensLength() - 1n;
    const reserve = await depository._reserves(addressEntityId(user0.address), erc20id);

    expect(reserve).to.equal(10_000);
    expect(await erc20.balanceOf(user0.address)).to.equal(990_000);
  });

  it("ERC721 deposit to reserve", async function () {
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

    const erc721id = await depository.getTokensLength() - 1n;
    const reserve = await depository._reserves(addressEntityId(user0.address), erc721id);

    expect(await erc721.ownerOf(1)).to.equal(await depository.getAddress());
    expect(reserve).to.equal(1);
  });

  it("ERC1155 deposit to reserve", async function () {
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

    const erc1155id = await depository.getTokensLength() - 1n;
    const reserve = await depository._reserves(addressEntityId(user0.address), erc1155id);

    expect(reserve).to.equal(50);
    expect(await erc1155.balanceOf(user0.address, 0)).to.equal(50);
  });

  it("reserveToReserve transfers between entities", async function () {
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

    await expect(
      depository.connect(user0).processBatch(encodedBatch, hankoData, nonce)
    ).to.not.be.reverted;

    const reserveFrom = await depository._reserves(fromEntity, tokenId);
    const reserveTo = await depository._reserves(toEntity, tokenId);

    expect(reserveFrom).to.equal(750n);
    expect(reserveTo).to.equal(250n);
  });

  it("processBatch deposits and withdraws external ERC20 reserves through the production path", async function () {
    const { depository, erc20 } = await loadFixture(deployFixture);

    const actor = lazyActor(user0, 0);
    const recipientEntity = addressEntityId(user1.address);

    await erc20.approve(await depository.getAddress(), 10_000n);

    const depositBatch = emptyBatch({
      externalTokenToReserve: [{
        entity: ethers.ZeroHash,
        contractAddress: await erc20.getAddress(),
        externalTokenId: 0,
        tokenType: 0,
        internalTokenId: 0,
        amount: 10_000n,
      }],
    });
    const deposit = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, depositBatch);

    await expect(
      depository.connect(user0).processBatch(deposit.encodedBatch, deposit.hankoData, deposit.nonce)
    ).to.emit(depository, "HankoBatchProcessed")
      .withArgs(actor.entityId, ethers.keccak256(deposit.hankoData), deposit.nonce, true);

    const erc20id = (await depository.getTokensLength()) - 1n;
    expect(await depository._reserves(actor.entityId, erc20id)).to.equal(10_000n);
    expect(await erc20.balanceOf(user0.address)).to.equal(990_000n);

    const withdrawBatch = emptyBatch({
      reserveToExternalToken: [{ receivingEntity: recipientEntity, tokenId: erc20id, amount: 2_500n }],
    });
    const withdraw = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, withdrawBatch);

    await expect(
      depository.connect(user0).processBatch(withdraw.encodedBatch, withdraw.hankoData, withdraw.nonce)
    ).to.emit(depository, "ReserveUpdated")
      .withArgs(actor.entityId, erc20id, 7_500n);

    expect(await depository._reserves(actor.entityId, erc20id)).to.equal(7_500n);
    expect(await erc20.balanceOf(user1.address)).to.equal(2_500n);
  });

  it("processBatch supports no-return ERC20 tokens on deposit and withdrawal", async function () {
    const { depository } = await loadFixture(deployFixture);

    const NoReturnERC20Mock = await hre.ethers.getContractFactory("NoReturnERC20Mock");
    const noReturnToken = await NoReturnERC20Mock.deploy("NoReturn", "NORET", 1_000_000n);
    await noReturnToken.waitForDeployment();

    const actor = lazyActor(user0, 0);
    const recipientEntity = addressEntityId(user1.address);

    await noReturnToken.approve(await depository.getAddress(), 10_000n);

    const depositBatch = emptyBatch({
      externalTokenToReserve: [{
        entity: ethers.ZeroHash,
        contractAddress: await noReturnToken.getAddress(),
        externalTokenId: 0,
        tokenType: 0,
        internalTokenId: 0,
        amount: 10_000n,
      }],
    });
    const deposit = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, depositBatch);

    await expect(
      depository.connect(user0).processBatch(deposit.encodedBatch, deposit.hankoData, deposit.nonce)
    ).to.emit(depository, "HankoBatchProcessed")
      .withArgs(actor.entityId, ethers.keccak256(deposit.hankoData), deposit.nonce, true);

    const tokenId = (await depository.getTokensLength()) - 1n;
    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(10_000n);
    expect(await noReturnToken.balanceOf(await depository.getAddress())).to.equal(10_000n);

    const withdrawBatch = emptyBatch({
      reserveToExternalToken: [{ receivingEntity: recipientEntity, tokenId, amount: 2_500n }],
    });
    const withdraw = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, withdrawBatch);

    await expect(
      depository.connect(user0).processBatch(withdraw.encodedBatch, withdraw.hankoData, withdraw.nonce)
    ).to.emit(depository, "ReserveUpdated")
      .withArgs(actor.entityId, tokenId, 7_500n);

    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(7_500n);
    expect(await noReturnToken.balanceOf(user1.address)).to.equal(2_500n);
  });

  it("rejects zero-amount ERC721 withdrawals instead of transferring the NFT for free", async function () {
    const { depository, erc721 } = await loadFixture(deployFixture);

    const actor = lazyActor(user0, 0);
    const recipientEntity = addressEntityId(user1.address);

    await erc721.approve(await depository.getAddress(), 1);

    const depositBatch = emptyBatch({
      externalTokenToReserve: [{
        entity: ethers.ZeroHash,
        contractAddress: await erc721.getAddress(),
        externalTokenId: 1,
        tokenType: 1,
        internalTokenId: 0,
        amount: 1n,
      }],
    });
    const deposit = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, depositBatch);
    await depository.connect(user0).processBatch(deposit.encodedBatch, deposit.hankoData, deposit.nonce);

    const erc721id = (await depository.getTokensLength()) - 1n;
    const withdrawBatch = emptyBatch({
      reserveToExternalToken: [{ receivingEntity: recipientEntity, tokenId: erc721id, amount: 0n }],
    });
    const withdraw = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, withdrawBatch);

    await expect(
      depository.connect(user0).processBatch(withdraw.encodedBatch, withdraw.hankoData, withdraw.nonce)
    ).to.be.revertedWithCustomError(depository, "E1");

    expect(await erc721.ownerOf(1)).to.equal(await depository.getAddress());
    expect(await depository._reserves(actor.entityId, erc721id)).to.equal(1n);
  });

  it("requires strictly sequential entity batch nonces and binds signatures to nonce and calldata", async function () {
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
      depository.connect(user0).processBatch(first.encodedBatch, first.hankoData, first.nonce)
    ).to.be.revertedWithCustomError(depository, "E2");

    await expect(
      depository.connect(user0).processBatch(first.encodedBatch, first.hankoData, 2n)
    ).to.be.reverted;

    const secondBatch = emptyBatch({
      reserveToReserve: [{ receivingEntity: recipient, tokenId, amount: 25n }],
    });
    const second = await signDepositoryBatch(depository, actor.entityId, actor.privateKey, secondBatch, 2n);
    const tamperedBatch = emptyBatch({
      reserveToReserve: [{ receivingEntity: recipient, tokenId, amount: 26n }],
    });

    await expect(
      depository.connect(user0).processBatch(encodeBatch(tamperedBatch), second.hankoData, second.nonce)
    ).to.be.reverted;
    expect(await depository.entityNonces(actor.entityId)).to.equal(1n);

    await depository.connect(user0).processBatch(second.encodedBatch, second.hankoData, second.nonce);
    expect(await depository.entityNonces(actor.entityId)).to.equal(2n);
    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(875n);
    expect(await depository._reserves(recipient, tokenId)).to.equal(125n);
  });

  it("settles bilateral diffs with counterparty hanko and rejects settlement replay", async function () {
    const { depository } = await loadFixture(deployFixture);

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    await depository.mintToReserve(left.entityId, tokenId, 1_000n);

    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const settlementNonce = 1n;
    const diffs = [{
      tokenId,
      leftDiff: -125n,
      rightDiff: 125n,
      collateralDiff: 0n,
      ondeltaDiff: 0n,
    }];
    const settlementHash = await cooperativeUpdateHash(depository, acctKey, settlementNonce, diffs);
    const settlementSig = signEntityHash(right.entityId, settlementHash, right.privateKey);
    const settlement = {
      leftEntity: left.entityId,
      rightEntity: right.entityId,
      diffs,
      forgiveDebtsInTokenIds: [],
      sig: settlementSig,
      entityProvider: ethers.ZeroAddress,
      hankoData: "0x",
      nonce: settlementNonce,
    };

    const batch = emptyBatch({ settlements: [settlement] });
    const signed = await signDepositoryBatch(depository, left.entityId, left.privateKey, batch);

    await expect(
      depository.connect(left.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce)
    ).to.emit(depository, "AccountSettled");

    const account = await depository._accounts(acctKey);
    expect(account.nonce).to.equal(settlementNonce);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(875n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(125n);

    const replay = await signDepositoryBatch(depository, left.entityId, left.privateKey, batch);
    await expect(
      depository.connect(left.signer).processBatch(replay.encodedBatch, replay.hankoData, replay.nonce)
    ).to.be.revertedWithCustomError(depository, "E2");

    expect((await depository._accounts(acctKey)).nonce).to.equal(settlementNonce);
    expect(await depository.entityNonces(left.entityId)).to.equal(1n);
  });

  it("requires counterparty hanko for empty settlements too", async function () {
    const { depository } = await loadFixture(deployFixture);

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const settlementNonce = 1n;

    const unsignedSettlement = {
      leftEntity: left.entityId,
      rightEntity: right.entityId,
      diffs: [],
      forgiveDebtsInTokenIds: [],
      sig: "0x",
      entityProvider: ethers.ZeroAddress,
      hankoData: "0x",
      nonce: settlementNonce,
    };

    const unsignedBatch = emptyBatch({ settlements: [unsignedSettlement] });
    const unsigned = await signDepositoryBatch(depository, left.entityId, left.privateKey, unsignedBatch);
    await expect(
      depository.connect(left.signer).processBatch(unsigned.encodedBatch, unsigned.hankoData, unsigned.nonce)
    ).to.be.revertedWith("Signature required for settlement");

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
      depository.connect(left.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce)
    ).to.not.be.reverted;

    expect((await depository._accounts(acctKey)).nonce).to.equal(settlementNonce);
    expect(await depository.entityNonces(left.entityId)).to.equal(1n);
  });

  it("blocks cooperative settlement and C2R while a dispute is active", async function () {
    const { depository } = await loadFixture(deployFixture);

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    await depository.mintToReserve(left.entityId, tokenId, 300n);

    const fundCollateralBatch = emptyBatch({
      reserveToCollateral: [{
        tokenId,
        receivingEntity: left.entityId,
        pairs: [{ entity: right.entityId, amount: 100n }],
      }],
    });
    const fundCollateral = await signDepositoryBatch(depository, left.entityId, left.privateKey, fundCollateralBatch);
    await depository.connect(left.signer).processBatch(
      fundCollateral.encodedBatch,
      fundCollateral.hankoData,
      fundCollateral.nonce,
    );

    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const [collateral, ondelta] = await depository.getCollateral(left.entityId, right.entityId, tokenId);
    expect(collateral).to.equal(100n);
    expect(ondelta).to.equal(100n);

    const initialProofbody = proofBody([0n], [tokenId]);
    const initialProofbodyHash = proofBodyHash(initialProofbody);
    const disputeNonce = 1n;
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, initialProofbodyHash);
    const startSig = signEntityHash(right.entityId, startHash, right.privateKey);
    const startBatch = emptyBatch({
      disputeStarts: [{
        counterentity: right.entityId,
        nonce: disputeNonce,
        proofbodyHash: initialProofbodyHash,
        sig: startSig,
        initialArguments: "0x",
      }],
    });
    const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, startBatch);
    await depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    expect((await depository._accounts(acctKey)).disputeHash).to.not.equal(ethers.ZeroHash);

    const settlementNonce = 2n;
    const settlementDiffs = [{
      tokenId,
      leftDiff: -1n,
      rightDiff: 1n,
      collateralDiff: 0n,
      ondeltaDiff: 0n,
    }];
    const settlementSig = signEntityHash(
      right.entityId,
      await cooperativeUpdateHash(depository, acctKey, settlementNonce, settlementDiffs),
      right.privateKey,
    );
    const settlementBatch = emptyBatch({
      settlements: [{
        leftEntity: left.entityId,
        rightEntity: right.entityId,
        diffs: settlementDiffs,
        forgiveDebtsInTokenIds: [],
        sig: settlementSig,
        entityProvider: ethers.ZeroAddress,
        hankoData: "0x",
        nonce: settlementNonce,
      }],
    });
    const settlement = await signDepositoryBatch(depository, left.entityId, left.privateKey, settlementBatch);

    await expect(
      depository.connect(left.signer).processBatch(settlement.encodedBatch, settlement.hankoData, settlement.nonce)
    ).to.be.revertedWithCustomError(depository, "E6");

    const c2rDiffs = [{
      tokenId,
      leftDiff: 1n,
      rightDiff: 0n,
      collateralDiff: -1n,
      ondeltaDiff: -1n,
    }];
    const c2rSig = signEntityHash(
      right.entityId,
      await cooperativeUpdateHash(depository, acctKey, settlementNonce, c2rDiffs),
      right.privateKey,
    );
    const c2rBatch = emptyBatch({
      collateralToReserve: [{
        counterparty: right.entityId,
        tokenId,
        amount: 1n,
        nonce: settlementNonce,
        sig: c2rSig,
      }],
    });
    const c2r = await signDepositoryBatch(depository, left.entityId, left.privateKey, c2rBatch);

    await expect(
      depository.connect(left.signer).processBatch(c2r.encodedBatch, c2r.hankoData, c2r.nonce)
    ).to.be.revertedWithCustomError(depository, "E6");

    expect((await depository._accounts(acctKey)).nonce).to.equal(disputeNonce);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(200n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(0n);
  });

  it("rejects duplicate tokenIds inside one settlement diff", async function () {
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
      settlements: [{
        leftEntity: left.entityId,
        rightEntity: right.entityId,
        diffs,
        forgiveDebtsInTokenIds: [],
        sig: settlementSig,
        entityProvider: ethers.ZeroAddress,
        hankoData: "0x",
        nonce: settlementNonce,
      }],
    });
    const signed = await signDepositoryBatch(depository, left.entityId, left.privateKey, batch);

    await expect(
      depository.connect(left.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce)
    ).to.be.revertedWithCustomError(depository, "E2");

    expect(await depository.entityNonces(left.entityId)).to.equal(0n);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(1_000n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(0n);
  });

  it("rejects oversized batches before mutating reserves or nonces", async function () {
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
      depository.connect(actor.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce)
    ).to.be.revertedWithCustomError(depository, "E10");

    expect(await depository.entityNonces(actor.entityId)).to.equal(0n);
    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(1_000n);
    expect(await depository._reserves(recipient, tokenId)).to.equal(0n);
  });

  it("starts a dispute and finalizes a newer counter-dispute proof", async function () {
    const { depository } = await loadFixture(deployFixture);

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    await depository.mintToReserve(left.entityId, tokenId, 1_000n);

    const fundCollateralBatch = emptyBatch({
      reserveToCollateral: [{
        tokenId,
        receivingEntity: left.entityId,
        pairs: [{ entity: right.entityId, amount: 300n }],
      }],
    });
    const fundCollateral = await signDepositoryBatch(depository, left.entityId, left.privateKey, fundCollateralBatch);
    await depository.connect(left.signer).processBatch(
      fundCollateral.encodedBatch,
      fundCollateral.hankoData,
      fundCollateral.nonce,
    );

    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const collateralBefore = await depository._collaterals(acctKey, tokenId);
    expect(collateralBefore.collateral).to.equal(300n);
    expect(collateralBefore.ondelta).to.equal(300n);

    const initialProofbody = proofBody([0n], [tokenId]);
    const initialProofbodyHash = proofBodyHash(initialProofbody);
    const initialArguments = "0x";
    const disputeNonce = 1n;
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, initialProofbodyHash);
    const startSig = signEntityHash(right.entityId, startHash, right.privateKey);
    const disputeStart = {
      counterentity: right.entityId,
      nonce: disputeNonce,
      proofbodyHash: initialProofbodyHash,
      sig: startSig,
      initialArguments,
    };
    const startBatch = emptyBatch({ disputeStarts: [disputeStart] });
    const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, startBatch);

    await expect(
      depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce)
    ).to.emit(depository, "DisputeStarted")
      .withArgs(left.entityId, right.entityId, disputeNonce, initialProofbodyHash, initialArguments);

    const startedAccount = await depository._accounts(acctKey);
    expect(startedAccount.nonce).to.equal(disputeNonce);
    expect(startedAccount.disputeHash).to.not.equal(ethers.ZeroHash);

    const finalNonce = 2n;
    const finalProofbody = proofBody([-200n], [tokenId]);
    const finalProofbodyHash = proofBodyHash(finalProofbody);
    const finalHash = await disputeProofHash(depository, acctKey, finalNonce, finalProofbodyHash);
    const finalSig = signEntityHash(right.entityId, finalHash, right.privateKey);
    const finalization = {
      counterentity: right.entityId,
      initialNonce: disputeNonce,
      finalNonce,
      initialProofbodyHash,
      finalProofbody,
      finalArguments: "0x",
      initialArguments,
      sig: finalSig,
      startedByLeft: true,
      disputeUntilBlock: 0,
      cooperative: false,
    };
    const finalBatch = emptyBatch({ disputeFinalizations: [finalization] });
    const final = await signDepositoryBatch(depository, left.entityId, left.privateKey, finalBatch);

    await expect(
      depository.connect(left.signer).processBatch(final.encodedBatch, final.hankoData, final.nonce)
    ).to.emit(depository, "DisputeFinalized")
      .withArgs(left.entityId, right.entityId, disputeNonce, initialProofbodyHash, finalProofbodyHash);

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

  it("allows a designated tower to submit a delayed last-resort counter-dispute", async function () {
    const { depository } = await loadFixture(deployFixture);
    const [, , tower] = await hre.ethers.getSigners();

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    const appointmentSequence = 7n;
    const lastResortWindowBlocks = 16n;
    await depository.mintToReserve(left.entityId, tokenId, 1_000n);

    const fundCollateralBatch = emptyBatch({
      reserveToCollateral: [{
        tokenId,
        receivingEntity: left.entityId,
        pairs: [{ entity: right.entityId, amount: 300n }],
      }],
    });
    const fundCollateral = await signDepositoryBatch(depository, left.entityId, left.privateKey, fundCollateralBatch);
    await depository.connect(left.signer).processBatch(
      fundCollateral.encodedBatch,
      fundCollateral.hankoData,
      fundCollateral.nonce,
    );

    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const initialProofbody = proofBody([0n], [tokenId]);
    const initialProofbodyHash = proofBodyHash(initialProofbody);
    const initialArguments = "0x";
    const disputeNonce = 1n;
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, initialProofbodyHash);
    const startSig = signEntityHash(right.entityId, startHash, right.privateKey);
    const startBatch = emptyBatch({
      disputeStarts: [{
        counterentity: right.entityId,
        nonce: disputeNonce,
        proofbodyHash: initialProofbodyHash,
        sig: startSig,
        initialArguments,
      }],
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
      finalArguments: "0x",
      initialArguments,
      sig: finalSig,
      startedByLeft: true,
      disputeUntilBlock: 0,
      cooperative: false,
    };

    await expect(
      depository.connect(tower).watchtowerCounterDispute(
        left.entityId,
        finalization,
        lastResortWindowBlocks,
        appointmentSequence,
        ownerAuthorization,
      )
    ).to.be.revertedWithCustomError(depository, "E2");

    const currentBlock = BigInt(await time.latestBlock());
    const timeoutBlock = (await depository._accounts(acctKey)).disputeTimeout;
    const lastResortStartBlock = timeoutBlock - lastResortWindowBlocks;
    if (lastResortStartBlock > currentBlock) {
      await mine(Number(lastResortStartBlock - currentBlock));
    }

    await expect(
      depository.connect(tower).watchtowerCounterDispute(
        left.entityId,
        finalization,
        lastResortWindowBlocks,
        appointmentSequence,
        ownerAuthorization,
      )
    ).to.emit(depository, "WatchtowerCounterDisputeExecuted")
      .withArgs(tower.address, left.entityId, right.entityId, finalNonce, appointmentSequence);

    const finalizedAccount = await depository._accounts(acctKey);
    const collateralAfter = await depository._collaterals(acctKey, tokenId);
    expect(finalizedAccount.nonce).to.equal(finalNonce);
    expect(finalizedAccount.disputeHash).to.equal(ethers.ZeroHash);
    expect(collateralAfter.collateral).to.equal(0n);
    expect(collateralAfter.ondelta).to.equal(0n);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(800n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(200n);
  });

  it("never lets a tower start a dispute when no active dispute exists", async function () {
    const { depository } = await loadFixture(deployFixture);
    const [, , tower] = await hre.ethers.getSigners();

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    const appointmentSequence = 9n;
    const lastResortWindowBlocks = 16n;

    const finalNonce = 2n;
    const finalProofbody = proofBody([-200n], [tokenId]);
    const finalProofbodyHash = proofBodyHash(finalProofbody);
    const finalization = {
      counterentity: right.entityId,
      initialNonce: 1n,
      finalNonce,
      initialProofbodyHash: proofBodyHash(proofBody([0n], [tokenId])),
      finalProofbody,
      finalArguments: "0x",
      initialArguments: "0x",
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
      disputeUntilBlock: 0,
      cooperative: false,
    };
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

    await expect(
      depository.connect(tower).watchtowerCounterDispute(
        left.entityId,
        finalization,
        lastResortWindowBlocks,
        appointmentSequence,
        ownerAuthorization,
      )
    ).to.be.revertedWithCustomError(depository, "E5");
  });

  it("rejects watchtower counter-dispute from the wrong tower or without a newer signed proof", async function () {
    const { depository } = await loadFixture(deployFixture);
    const [, , tower, wrongTower] = await hre.ethers.getSigners();

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    const appointmentSequence = 3n;
    const lastResortWindowBlocks = 12n;
    await depository.mintToReserve(left.entityId, tokenId, 1_000n);

    const fundCollateralBatch = emptyBatch({
      reserveToCollateral: [{
        tokenId,
        receivingEntity: left.entityId,
        pairs: [{ entity: right.entityId, amount: 300n }],
      }],
    });
    const fundCollateral = await signDepositoryBatch(depository, left.entityId, left.privateKey, fundCollateralBatch);
    await depository.connect(left.signer).processBatch(
      fundCollateral.encodedBatch,
      fundCollateral.hankoData,
      fundCollateral.nonce,
    );

    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const initialProofbody = proofBody([0n], [tokenId]);
    const initialProofbodyHash = proofBodyHash(initialProofbody);
    const initialArguments = "0x";
    const disputeNonce = 1n;
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, initialProofbodyHash);
    const startSig = signEntityHash(right.entityId, startHash, right.privateKey);
    const startBatch = emptyBatch({
      disputeStarts: [{
        counterentity: right.entityId,
        nonce: disputeNonce,
        proofbodyHash: initialProofbodyHash,
        sig: startSig,
        initialArguments,
      }],
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
      finalArguments: "0x",
      initialArguments,
      sig: finalSig,
      startedByLeft: true,
      disputeUntilBlock: 0,
      cooperative: false,
    };

    const currentBlock = BigInt(await time.latestBlock());
    const timeoutBlock = (await depository._accounts(acctKey)).disputeTimeout;
    const lastResortStartBlock = timeoutBlock - lastResortWindowBlocks;
    if (lastResortStartBlock > currentBlock) {
      await mine(Number(lastResortStartBlock - currentBlock));
    }

    await expect(
      depository.connect(wrongTower).watchtowerCounterDispute(
        left.entityId,
        finalization,
        lastResortWindowBlocks,
        appointmentSequence,
        ownerAuthorization,
      )
    ).to.be.revertedWithCustomError(depository, "E4");

    const sameProof = {
      ...finalization,
      finalNonce: disputeNonce,
      sig: "0x",
    };
    await expect(
      depository.connect(tower).watchtowerCounterDispute(
        left.entityId,
        sameProof,
        lastResortWindowBlocks,
        appointmentSequence,
        ownerAuthorization,
      )
    ).to.be.revertedWithCustomError(depository, "E2");
  });

  it("passes dispute argument timestamps into DeltaTransformer pull without storing secrets", async function () {
    const { depository } = await loadFixture(deployFixture);
    const DeltaTransformer = await ethers.getContractFactory("DeltaTransformer");
    const transformer = await DeltaTransformer.deploy();
    await transformer.waitForDeployment();

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenA = 1n;
    const tokenB = 2n;
    await depository.mintToReserve(right.entityId, tokenA, 1_000n);
    await depository.mintToReserve(left.entityId, tokenB, 1_000n);

    const fundRightCollateral = emptyBatch({
      reserveToCollateral: [{
        tokenId: tokenA,
        receivingEntity: right.entityId,
        pairs: [{ entity: left.entityId, amount: 1_000n }],
      }],
    });
    const rightFund = await signDepositoryBatch(depository, right.entityId, right.privateKey, fundRightCollateral);
    await depository.connect(right.signer).processBatch(rightFund.encodedBatch, rightFund.hankoData, rightFund.nonce);

    const fundLeftCollateral = emptyBatch({
      reserveToCollateral: [{
        tokenId: tokenB,
        receivingEntity: left.entityId,
        pairs: [{ entity: right.entityId, amount: 1_000n }],
      }],
    });
    const leftFund = await signDepositoryBatch(depository, left.entityId, left.privateKey, fundLeftCollateral);
    await depository.connect(left.signer).processBatch(leftFund.encodedBatch, leftFund.hankoData, leftFund.nonce);

    const fillRatio = 0x0123;
    const pullProof = buildHashLadderProof("depository-cross-pull", fillRatio);
    const revealDeadline = (await time.latest()) + 10;
    const encodedPullBatch = await transformer.encodeBatch({
      payment: [],
      swap: [],
      pull: [{
        deltaIndex: 1,
        amount: -MAX_FILL_RATIO,
        claimedRatio: 0,
        revealedUntilTimestamp: revealDeadline,
        fullHash: pullProof.fullHash,
        partialRoot: pullProof.partialRoot,
      }],
    });
    const proofbody = proofBody(
      [0n, 0n],
      [tokenA, tokenB],
      [{
        transformerAddress: await transformer.getAddress(),
        encodedBatch: encodedPullBatch,
        allowances: [
          { deltaIndex: 1n, rightAllowance: BigInt(fillRatio), leftAllowance: 0n },
        ],
      }],
    );
    const proofbodyHash = proofBodyHash(proofbody);
    const rightTransformerArgs = encodeDeltaTransformerArguments([], [], [encodePartialPullBinary(fillRatio, pullProof.reveals)]);
    const initialArguments = abi.encode(["bytes[]"], [[rightTransformerArgs]]);
    const disputeNonce = 1n;
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, proofbodyHash);
    const startSig = signEntityHash(right.entityId, startHash, right.privateKey);
    const startBatch = emptyBatch({
      disputeStarts: [{
        counterentity: right.entityId,
        nonce: disputeNonce,
        proofbodyHash,
        sig: startSig,
        initialArguments,
      }],
    });
    const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, startBatch);
    await depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    const startedAccount = await depository._accounts(acctKey);
    expect(startedAccount.disputeStartTimestamp).to.be.lessThanOrEqual(BigInt(revealDeadline));
    await mine(Number(await depository.defaultDisputeDelay()));

    const finalization = {
      counterentity: right.entityId,
      initialNonce: disputeNonce,
      finalNonce: disputeNonce,
      initialProofbodyHash: proofbodyHash,
      finalProofbody: proofbody,
      finalArguments: "0x",
      initialArguments,
      sig: "0x",
      startedByLeft: true,
      disputeUntilBlock: 0,
      cooperative: false,
    };
    const finalBatch = emptyBatch({ disputeFinalizations: [finalization] });
    const final = await signDepositoryBatch(depository, left.entityId, left.privateKey, finalBatch);
    await depository.connect(left.signer).processBatch(final.encodedBatch, final.hankoData, final.nonce);

    expect(await transformer.hashToBlock(hashNode(pullProof.reveals[3]))).to.equal(0n);
    expect(await depository._reserves(left.entityId, tokenB)).to.equal(1_000n - BigInt(fillRatio));
    expect(await depository._reserves(right.entityId, tokenB)).to.equal(BigInt(fillRatio));
  });

  it("locks outstanding debt before reserve outflows and pays FIFO debt in bounded chunks", async function () {
    const { depository } = await loadFixture(deployFixture);

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const recipient = addressEntityId(user1.address);
    const tokenId = 1n;
    await depository.mintToReserve(left.entityId, tokenId, 100n);

    const fundCollateralBatch = emptyBatch({
      reserveToCollateral: [{
        tokenId,
        receivingEntity: left.entityId,
        pairs: [{ entity: right.entityId, amount: 100n }],
      }],
    });
    const fundCollateral = await signDepositoryBatch(depository, left.entityId, left.privateKey, fundCollateralBatch);
    await depository.connect(left.signer).processBatch(
      fundCollateral.encodedBatch,
      fundCollateral.hankoData,
      fundCollateral.nonce,
    );

    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const initialProofbody = proofBody([0n], [tokenId]);
    const initialProofbodyHash = proofBodyHash(initialProofbody);
    const initialArguments = "0x";
    const disputeNonce = 1n;
    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, initialProofbodyHash);
    const startSig = signEntityHash(right.entityId, startHash, right.privateKey);
    const startBatch = emptyBatch({
      disputeStarts: [{
        counterentity: right.entityId,
        nonce: disputeNonce,
        proofbodyHash: initialProofbodyHash,
        sig: startSig,
        initialArguments,
      }],
    });
    const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, startBatch);
    await depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    const finalNonce = 2n;
    const finalProofbody = proofBody([-300n], [tokenId]);
    const finalHash = await disputeProofHash(depository, acctKey, finalNonce, proofBodyHash(finalProofbody));
    const finalSig = signEntityHash(right.entityId, finalHash, right.privateKey);
    const finalBatch = emptyBatch({
      disputeFinalizations: [{
        counterentity: right.entityId,
        initialNonce: disputeNonce,
        finalNonce,
        initialProofbodyHash,
        finalProofbody,
        finalArguments: "0x",
        initialArguments,
        sig: finalSig,
        startedByLeft: true,
        disputeUntilBlock: 0,
        cooperative: false,
      }],
    });
    const finalization = await signDepositoryBatch(depository, left.entityId, left.privateKey, finalBatch);
    await depository.connect(left.signer).processBatch(
      finalization.encodedBatch,
      finalization.hankoData,
      finalization.nonce,
    );

    expect(await depository._reserves(left.entityId, tokenId)).to.equal(0n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(100n);
    expect(await depository.debtOutstanding(left.entityId, tokenId)).to.equal(200n);
    expect(await depository._activeDebtsByToken(left.entityId, tokenId)).to.equal(1n);

    await depository.mintToReserve(left.entityId, tokenId, 100n);
    expect(await depository.spendableReserve(left.entityId, tokenId)).to.equal(0n);

    const blockedBatch = emptyBatch({
      reserveToReserve: [{ receivingEntity: recipient, tokenId, amount: 1n }],
    });
    const blocked = await signDepositoryBatch(depository, left.entityId, left.privateKey, blockedBatch);
    await expect(
      depository.connect(left.signer).processBatch(blocked.encodedBatch, blocked.hankoData, blocked.nonce)
    ).to.be.revertedWithCustomError(depository, "E3");

    expect(await depository._reserves(left.entityId, tokenId)).to.equal(100n);
    expect(await depository.debtOutstanding(left.entityId, tokenId)).to.equal(200n);

    const blockedSettlementNonce = 3n;
    const blockedSettlementDiffs = [{
      tokenId,
      leftDiff: -1n,
      rightDiff: 1n,
      collateralDiff: 0n,
      ondeltaDiff: 0n,
    }];
    const blockedSettlementSig = signEntityHash(
      right.entityId,
      await cooperativeUpdateHash(depository, acctKey, blockedSettlementNonce, blockedSettlementDiffs),
      right.privateKey,
    );
    const blockedSettlementBatch = emptyBatch({
      settlements: [{
        leftEntity: left.entityId,
        rightEntity: right.entityId,
        diffs: blockedSettlementDiffs,
        forgiveDebtsInTokenIds: [],
        sig: blockedSettlementSig,
        entityProvider: ethers.ZeroAddress,
        hankoData: "0x",
        nonce: blockedSettlementNonce,
      }],
    });
    const blockedSettlement = await signDepositoryBatch(
      depository,
      left.entityId,
      left.privateKey,
      blockedSettlementBatch,
    );
    await expect(
      depository.connect(left.signer).processBatch(
        blockedSettlement.encodedBatch,
        blockedSettlement.hankoData,
        blockedSettlement.nonce,
      )
    ).to.be.revertedWithCustomError(depository, "E3");

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
    await depository.connect(left.signer).processBatch(
      spendableTransfer.encodedBatch,
      spendableTransfer.hankoData,
      spendableTransfer.nonce,
    );

    expect(await depository._reserves(left.entityId, tokenId)).to.equal(0n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(300n);
    expect(await depository._reserves(recipient, tokenId)).to.equal(50n);
    expect(await depository.debtOutstanding(left.entityId, tokenId)).to.equal(0n);
    expect(await depository._activeDebtsByToken(left.entityId, tokenId)).to.equal(0n);
    expect(await depository._activeDebts(left.entityId)).to.equal(0n);
  });

  it("requires timeout for unilateral dispute finalization and bumps account nonce once", async function () {
    const { depository } = await loadFixture(deployFixture);

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const finalProofbody = proofBody([], []);
    const finalProofbodyHash = proofBodyHash(finalProofbody);
    const initialArguments = "0x";
    const disputeNonce = 1n;

    const startHash = await disputeProofHash(depository, acctKey, disputeNonce, finalProofbodyHash);
    const startSig = signEntityHash(right.entityId, startHash, right.privateKey);
    const startBatch = emptyBatch({
      disputeStarts: [{
        counterentity: right.entityId,
        nonce: disputeNonce,
        proofbodyHash: finalProofbodyHash,
        sig: startSig,
        initialArguments,
      }],
    });
    const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, startBatch);
    await depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    const finalization = {
      counterentity: right.entityId,
      initialNonce: disputeNonce,
      finalNonce: disputeNonce,
      initialProofbodyHash: finalProofbodyHash,
      finalProofbody,
      finalArguments: "0x",
      initialArguments,
      sig: "0x",
      startedByLeft: true,
      disputeUntilBlock: 0,
      cooperative: false,
    };

    const tooEarlyBatch = emptyBatch({ disputeFinalizations: [finalization] });
    const tooEarly = await signDepositoryBatch(depository, left.entityId, left.privateKey, tooEarlyBatch);
    await expect(
      depository.connect(left.signer).processBatch(tooEarly.encodedBatch, tooEarly.hankoData, tooEarly.nonce)
    ).to.be.revertedWithCustomError(depository, "E2");

    await mine(Number(await depository.defaultDisputeDelay()));

    const afterTimeout = await signDepositoryBatch(depository, left.entityId, left.privateKey, tooEarlyBatch);
    await depository.connect(left.signer).processBatch(
      afterTimeout.encodedBatch,
      afterTimeout.hankoData,
      afterTimeout.nonce,
    );

    const account = await depository._accounts(acctKey);
    expect(account.nonce).to.equal(2n);
    expect(account.disputeHash).to.equal(ethers.ZeroHash);
    expect(account.disputeTimeout).to.equal(0n);
  });

  it("cooperatively finalizes an existing account without an active dispute", async function () {
    const { depository } = await loadFixture(deployFixture);

    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    await depository.mintToReserve(left.entityId, tokenId, 500n);

    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);
    const settlementNonce = 1n;
    const diffs = [{
      tokenId,
      leftDiff: -100n,
      rightDiff: 100n,
      collateralDiff: 0n,
      ondeltaDiff: 0n,
    }];
    const settlementSig = signEntityHash(
      right.entityId,
      await cooperativeUpdateHash(depository, acctKey, settlementNonce, diffs),
      right.privateKey,
    );
    const settlementBatch = emptyBatch({
      settlements: [{
        leftEntity: left.entityId,
        rightEntity: right.entityId,
        diffs,
        forgiveDebtsInTokenIds: [],
        sig: settlementSig,
        entityProvider: ethers.ZeroAddress,
        hankoData: "0x",
        nonce: settlementNonce,
      }],
    });
    const settlement = await signDepositoryBatch(depository, left.entityId, left.privateKey, settlementBatch);
    await depository.connect(left.signer).processBatch(settlement.encodedBatch, settlement.hankoData, settlement.nonce);

    const finalNonce = 2n;
    const finalProofbody = proofBody([], []);
    const cooperativeHash = await cooperativeDisputeProofHash(depository, acctKey, finalNonce, finalProofbody, "0x");
    const cooperativeSig = signEntityHash(right.entityId, cooperativeHash, right.privateKey);
    const closeBatch = emptyBatch({
      disputeFinalizations: [{
        counterentity: right.entityId,
        initialNonce: settlementNonce,
        finalNonce,
        initialProofbodyHash: ethers.ZeroHash,
        finalProofbody,
        finalArguments: "0x",
        initialArguments: "0x",
        sig: cooperativeSig,
        startedByLeft: true,
        disputeUntilBlock: 0,
        cooperative: true,
      }],
    });
    const close = await signDepositoryBatch(depository, left.entityId, left.privateKey, closeBatch);

    await depository.connect(left.signer).processBatch(close.encodedBatch, close.hankoData, close.nonce);
    expect((await depository._accounts(acctKey)).nonce).to.equal(finalNonce);
  });

  it("aggregates duplicate-token flashloans before enforcing repayment", async function () {
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
      depository.connect(user0).processBatch(exploit.encodedBatch, exploit.hankoData, exploit.nonce)
    ).to.be.revertedWithCustomError(depository, "E3");

    expect(await depository.entityNonces(actor.entityId)).to.equal(0n);
    expect(await depository._reserves(actor.entityId, tokenId)).to.equal(0n);
    expect(await depository._reserves(recipient, tokenId)).to.equal(0n);
  });

  it("rejects non-admin use of local dev bootstrap helpers", async function () {
    const { depository, erc20 } = await loadFixture(deployFixture);
    const entity = addressEntityId(user1.address);

    await expect(
      depository.connect(user1).mintToReserve(entity, 1, 1n)
    ).to.be.revertedWithCustomError(depository, "E2");

    await expect(
      depository.connect(user1).mintToReserveBatch([{ entity, tokenId: 1, amount: 1n }])
    ).to.be.revertedWithCustomError(depository, "E2");

    await erc20.connect(user1).approve(await depository.getAddress(), 1n);
    await expect(
      depository.connect(user1).adminRegisterExternalToken({
        entity: ethers.ZeroHash,
        contractAddress: await erc20.getAddress(),
        externalTokenId: 0,
        tokenType: 0,
        internalTokenId: 0,
        amount: 1n,
      })
    ).to.be.revertedWithCustomError(depository, "E2");
  });
});
