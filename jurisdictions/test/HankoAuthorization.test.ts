import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers.js";
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import type { Depository, EntityProvider } from "../typechain-types/index.js";
import {
  addressEntityId,
  buildSingleSignerHanko,
  computeDepositoryBatchHash,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  singleSignerLazyEntityId,
} from "./helpers/hanko.ts";

const HANKO_ABI = ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'];
const BOARD_ABI = [
  'tuple(uint16 votingThreshold, bytes32[] entityIds, uint16[] votingPowers, uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)'
];
const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

function buildHighSHanko(entityId: string, hash: string, privateKey: string): string {
  const signingKey = new ethers.SigningKey(privateKey);
  const signature = signingKey.sign(ethers.getBytes(hash));
  const highS = SECP256K1_N - BigInt(signature.s);
  const flippedV = signature.v === 28 ? 27 : 28;
  const vBit = flippedV === 28 ? 1 : 0;
  const packedSig = ethers.concat([signature.r, ethers.toBeHex(highS, 32), ethers.toBeHex(vBit, 1)]);
  return ethers.AbiCoder.defaultAbiCoder().encode(HANKO_ABI, [[
    [],
    packedSig,
    [[ethers.zeroPadValue(entityId, 32), [0], [1], 1]],
  ]]);
}

function buildSingleSignerClaimHanko(
  entityId: string,
  hash: string,
  privateKey: string,
  placeholders: string[],
  entityIndexes: number[],
  weights: bigint[],
  threshold: bigint,
): string {
  const signingKey = new ethers.SigningKey(privateKey);
  const signature = signingKey.sign(ethers.getBytes(hash));
  const vBit = signature.v === 28 ? 1 : 0;
  const packedSig = ethers.concat([signature.r, signature.s, ethers.toBeHex(vBit, 1)]);
  return ethers.AbiCoder.defaultAbiCoder().encode(HANKO_ABI, [[
    placeholders,
    packedSig,
    [[ethers.zeroPadValue(entityId, 32), entityIndexes, weights, threshold]],
  ]]);
}

function buildRecoverEntityInputs(signerAddress: string, hash: string, privateKey: string): { encodedBoard: string; encodedSignature: string; boardHash: string } {
  const signerEntityId = ethers.zeroPadValue(signerAddress, 32);
  const encodedBoard = ethers.AbiCoder.defaultAbiCoder().encode(BOARD_ABI, [[
    1,
    [signerEntityId],
    [1],
    0,
    0,
    0,
  ]]);
  const signingKey = new ethers.SigningKey(privateKey);
  const signature = signingKey.sign(ethers.getBytes(hash));
  const vBit = signature.v === 28 ? 1 : 0;
  const packedSig = ethers.concat([signature.r, signature.s, ethers.toBeHex(vBit, 1)]);
  const encodedSignature = ethers.AbiCoder.defaultAbiCoder().encode(['bytes[]'], [[packedSig]]);
  return {
    encodedBoard,
    encodedSignature,
    boardHash: ethers.keccak256(encodedBoard),
  };
}

/**
 * Hanko Authorization Tests
 */
describe("Hanko Authorization", function () {
  let depository: Depository;
  let entityProvider: EntityProvider;
  let admin: HardhatEthersSigner;
  let entity1: HardhatEthersSigner;
  let entity2: HardhatEthersSigner;

  async function deployFixture() {
    [admin, entity1, entity2] = await hre.ethers.getSigners();

    // Deploy EntityProvider
    const EntityProviderFactory = await hre.ethers.getContractFactory("EntityProvider");
    entityProvider = await EntityProviderFactory.deploy();
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

    return { depository, entityProvider, admin, entity1, entity2 };
  }

  it("processBatch rejects invalid Hanko", async function () {
    const { depository, entityProvider } = await loadFixture(deployFixture);

    const coder = ethers.AbiCoder.defaultAbiCoder();
    const emptyHanko = coder.encode(
      [
        "tuple(bytes32[] placeholders, bytes packedSignatures, tuple(bytes32 entityId, uint256[] entityIndexes, uint256[] weights, uint256 threshold)[] claims)"
      ],
      [
        {
          placeholders: [],
          packedSignatures: "0x",
          claims: []
        }
      ]
    );

    await expect(
      depository.processBatch("0x", emptyHanko, 1)
    ).to.be.revertedWithCustomError(depository, "E4");
  });

  it("processBatch accepts a correctly signed single-signer reserve transfer", async function () {
    const { depository, entityProvider, entity1, entity2 } = await loadFixture(deployFixture);

    const entity1Id = singleSignerLazyEntityId(entity1.address);
    const entity2Id = addressEntityId(entity2.address);
    const tokenId = 1;
    const fundAmount = 1_000n;
    const transferAmount = 100n;

    await depository.mintToReserve(entity1Id, tokenId, fundAmount);

    const batch = emptyBatch({
      reserveToReserve: [{ receivingEntity: entity2Id, tokenId, amount: transferAmount }],
    });

    const encodedBatch = encodeBatch(batch);
    const entityNonce = await depository.entityNonces(entity1Id);
    const nextNonce = entityNonce + 1n;
    const batchHash = await computeDepositoryBatchHash(depository, encodedBatch, nextNonce);
    const hankoData = buildSingleSignerHanko(entity1Id, batchHash, deriveHardhatPrivateKey(1));

    await expect(
      depository
        .connect(entity1)
        .processBatch(encodedBatch, hankoData, nextNonce)
    ).to.not.be.reverted;

    const entity1Balance = await depository._reserves(entity1Id, tokenId);
    const entity2Balance = await depository._reserves(entity2Id, tokenId);
    expect(entity1Balance).to.equal(fundAmount - transferAmount);
    expect(entity2Balance).to.equal(transferAmount);
  });

  it("processBatch rejects high-s malleable Hanko signatures", async function () {
    const { depository, entity1, entity2 } = await loadFixture(deployFixture);

    const entity1Id = singleSignerLazyEntityId(entity1.address);
    const entity2Id = addressEntityId(entity2.address);
    const tokenId = 1;
    await depository.mintToReserve(entity1Id, tokenId, 1_000n);

    const batch = emptyBatch({
      reserveToReserve: [{ receivingEntity: entity2Id, tokenId, amount: 100n }],
    });
    const encodedBatch = encodeBatch(batch);
    const nextNonce = (await depository.entityNonces(entity1Id)) + 1n;
    const batchHash = await computeDepositoryBatchHash(depository, encodedBatch, nextNonce);
    const hankoData = buildHighSHanko(entity1Id, batchHash, deriveHardhatPrivateKey(1));

    await expect(
      depository.connect(entity1).processBatch(encodedBatch, hankoData, nextNonce)
    ).to.be.revertedWithCustomError(depository, "E4");

    expect(await depository.entityNonces(entity1Id)).to.equal(0n);
    expect(await depository._reserves(entity1Id, tokenId)).to.equal(1_000n);
    expect(await depository._reserves(entity2Id, tokenId)).to.equal(0n);
  });

  it("rejects Hanko claim weights that would truncate below the board hash width", async function () {
    const { entityProvider, entity1, entity2 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("weight truncation"));
    const entity1Member = addressEntityId(entity1.address);
    const entity2Member = addressEntityId(entity2.address);
    const encodedBoard = ethers.AbiCoder.defaultAbiCoder().encode(BOARD_ABI, [[
      2,
      [entity1Member, entity2Member],
      [1, 1],
      0,
      0,
      0,
    ]]);
    const lazyEntityId = ethers.keccak256(encodedBoard);
    const maliciousHanko = buildSingleSignerClaimHanko(
      lazyEntityId,
      hash,
      deriveHardhatPrivateKey(1),
      [entity2Member],
      [1, 0],
      [65537n, 1n],
      2n,
    );

    await expect(
      entityProvider.verifyHankoSignature(maliciousHanko, hash),
    ).to.be.revertedWithCustomError(entityProvider, "InvalidHankoWeight");
  });

  it("recoverEntity uses the board hash index for registered entities", async function () {
    const { entityProvider, entity1 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("indexed recovery"));
    const { encodedBoard, encodedSignature, boardHash } = buildRecoverEntityInputs(
      entity1.address,
      hash,
      deriveHardhatPrivateKey(1),
    );

    const tx = await entityProvider.registerNumberedEntity(boardHash);
    const receipt = await tx.wait();
    const event = receipt?.logs
      .map((log) => {
        try {
          return entityProvider.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((log) => log?.name === "EntityRegistered");
    const entityNumber = event?.args?.entityNumber as bigint;
    const entityId = ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32);

    expect(await entityProvider.boardHashToEntityId(boardHash)).to.equal(entityId);
    expect(await entityProvider.entityIdToNumber(entityId)).to.equal(entityNumber);
    expect(await entityProvider.recoverEntity(encodedBoard, encodedSignature, hash)).to.equal(entityNumber);
  });

  it("rejects duplicate active board hashes instead of making recoverEntity ambiguous", async function () {
    const { entityProvider, entity1 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("duplicate board"));
    const { boardHash } = buildRecoverEntityInputs(entity1.address, hash, deriveHardhatPrivateKey(1));

    await expect(entityProvider.registerNumberedEntity(boardHash)).to.not.be.reverted;
    await expect(entityProvider.registerNumberedEntity(boardHash)).to.be.revertedWith("Board hash already registered");
  });

  it("does not expose unsafeProcessBatch", async function () {
    const { depository } = await loadFixture(deployFixture);
    expect(depository.interface.hasFunction("unsafeProcessBatch")).to.equal(false);
  });
});
