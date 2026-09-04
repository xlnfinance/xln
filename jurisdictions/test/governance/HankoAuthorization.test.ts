import { expect } from "chai";
import hre from "hardhat";
const { ethers, networkHelpers } = await hre.network.getOrCreate("hardhat");
const { loadFixture } = networkHelpers;
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import type { Depository, EntityProvider } from "../../typechain-types/index.js";
import {
  addressEntityId,
  buildClaimsHanko,
  buildRawSignerHanko,
  buildSingleSignerHanko,
  computeDepositoryBatchHash,
  deployDepositoryStack,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  encodeSingleSignerBoard,
  singleSignerLazyEntityId,
} from "../helpers/hanko.ts";

// Single envelope: abi.encode(HankoBytes{placeholders, packedSignatures, claims, memberSignatures}).
const HANKO_ABI = [
  'tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[],bytes[])',
];
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
    [[ethers.zeroPadValue(entityId, 32), [0], [1], 1, 0, 0, 0]],
    [],
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
    [[ethers.zeroPadValue(entityId, 32), entityIndexes, weights, threshold, 0, 0, 0]],
    [],
  ]]);
}

function boardHash(
  threshold: number,
  entityIds: string[],
  votingPowers: number[],
  delays: readonly [number, number, number] = [0, 0, 0],
): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(BOARD_ABI, [[
    threshold,
    entityIds,
    votingPowers,
    ...delays,
  ]]));
}

function buildClaimHanko(
  entityId: string,
  hash: string,
  privateKeys: string[],
  placeholders: string[],
  entityIndexes: number[],
  weights: bigint[],
  threshold: bigint,
): string {
  const signatures = privateKeys.map((privateKey) =>
    new ethers.SigningKey(privateKey).sign(ethers.getBytes(hash))
  );
  const recoveryBits = new Uint8Array(Math.ceil(signatures.length / 8));
  signatures.forEach((signature, index) => {
    if (signature.v === 28) recoveryBits[Math.floor(index / 8)]! |= 1 << (index % 8);
  });
  const packedSignatures = ethers.concat([
    ...signatures.flatMap((signature) => [signature.r, signature.s]),
    ethers.hexlify(recoveryBits),
  ]);
  return ethers.AbiCoder.defaultAbiCoder().encode(HANKO_ABI, [[
    placeholders,
    packedSignatures,
    [[ethers.zeroPadValue(entityId, 32), entityIndexes, weights, threshold, 0, 0, 0]],
    [],
  ]]);
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
    [admin, entity1, entity2] = await ethers.getSigners();

    // Deploy EntityProvider
    entityProvider = await deployEntityProvider(admin.address);

    ({ depository } = await deployDepositoryStack(await entityProvider.getAddress()));

    return { depository, entityProvider, admin, entity1, entity2 };
  }

  it("processBatch rejects invalid Hanko", async function () {
    const { depository } = await loadFixture(deployFixture);

    const coder = ethers.AbiCoder.defaultAbiCoder();
    const emptyHanko = coder.encode(
      [
        "tuple(bytes32[] placeholders, bytes packedSignatures, tuple(bytes32 entityId, uint256[] entityIndexes, uint256[] weights, uint256 threshold)[] claims, bytes[] memberSignatures)"
      ],
      [
        {
          placeholders: [],
          packedSignatures: "0x",
          claims: [],
          memberSignatures: []
        }
      ]
    );

    await expect(
      depository.processBatch(encodeBatch(emptyBatch()), emptyHanko, 1)
    ).to.be.revertedWithCustomError(depository, "E4");
  });

  it("bounds Hanko bytes and aggregate entity slots before quadratic verification", async function () {
    const { entityProvider } = await loadFixture(deployFixture);
    await expect(
      entityProvider.verifyHankoSignature(
        ethers.hexlify(new Uint8Array(64 * 1024 + 1)),
        ethers.ZeroHash,
      )
    ).to.be.revertedWithCustomError(entityProvider, "HankoProofTooLarge");

    const oversizedShape = ethers.AbiCoder.defaultAbiCoder().encode(HANKO_ABI, [[
      Array.from({ length: 257 }, (_, index) => ethers.zeroPadValue(ethers.toBeHex(index + 1), 32)),
      "0x",
      [],
      [],
    ]]);
    await expect(
      entityProvider.verifyHankoSignature(oversizedShape, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(entityProvider, "HankoProofTooLarge");
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
    ).to.not.revert(ethers);

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

  it("rejects one recovered EOA repeated across signature slots", async function () {
    const { entityProvider, entity1 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("duplicate recovered EOA"));
    const member = addressEntityId(entity1.address);
    const lazyEntityId = boardHash(100, [member, member], [60, 40]);
    const key = deriveHardhatPrivateKey(1);
    const hanko = buildClaimHanko(
      lazyEntityId,
      hash,
      [key, key],
      [],
      [0, 1],
      [60n, 40n],
      100n,
    );

    await expect(entityProvider.verifyHankoSignature(hanko, hash))
      .to.be.revertedWithCustomError(entityProvider, "DuplicateHankoSigner");
  });

  it("rejects one signature slot repeated inside a board claim", async function () {
    const { entityProvider, entity1 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("duplicate board index"));
    const member = addressEntityId(entity1.address);
    const lazyEntityId = boardHash(100, [member, member], [60, 40]);
    const hanko = buildClaimHanko(
      lazyEntityId,
      hash,
      [deriveHardhatPrivateKey(1)],
      [],
      [0, 0],
      [60n, 40n],
      100n,
    );

    await expect(entityProvider.verifyHankoSignature(hanko, hash))
      .to.be.revertedWithCustomError(entityProvider, "DuplicateHankoEntityIndex");
  });

  it("rejects duplicate board members reached through distinct placeholder slots", async function () {
    const { entityProvider, entity1, entity2 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("duplicate resolved board member"));
    const signer = addressEntityId(entity1.address);
    const repeatedPlaceholder = addressEntityId(entity2.address);
    const lazyEntityId = boardHash(
      1,
      [repeatedPlaceholder, repeatedPlaceholder, signer],
      [1, 1, 1],
    );
    const hanko = buildClaimHanko(
      lazyEntityId,
      hash,
      [deriveHardhatPrivateKey(1)],
      [repeatedPlaceholder, repeatedPlaceholder],
      [0, 1, 2],
      [1n, 1n, 1n],
      1n,
    );

    await expect(entityProvider.verifyHankoSignature(hanko, hash))
      .to.be.revertedWithCustomError(entityProvider, "DuplicateHankoPlaceholder");
  });

  it("keeps a legitimate distinct quorum valid when signature and board order differ", async function () {
    const { entityProvider, entity1, entity2 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("distinct quorum reordered"));
    const firstMember = addressEntityId(entity1.address);
    const secondMember = addressEntityId(entity2.address);
    const lazyEntityId = boardHash(100, [firstMember, secondMember], [60, 40]);
    const hanko = buildClaimHanko(
      lazyEntityId,
      hash,
      [deriveHardhatPrivateKey(2), deriveHardhatPrivateKey(1)],
      [],
      [1, 0],
      [60n, 40n],
      100n,
    );

    const [recoveredEntityId, valid] = await entityProvider.verifyHankoSignature(hanko, hash);
    expect(valid).to.equal(true);
    expect(recoveredEntityId).to.equal(lazyEntityId);
  });

  it("accepts reordered recovered signer slots when indexes reconstruct the exact board", async function () {
    const { entityProvider, entity1, entity2 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("descending recovered signer slots"));
    const firstMember = addressEntityId(entity1.address);
    const secondMember = addressEntityId(entity2.address);
    expect(firstMember.toLowerCase() > secondMember.toLowerCase()).to.equal(true);
    const lazyEntityId = boardHash(100, [firstMember, secondMember], [60, 40]);
    const hanko = buildClaimHanko(
      lazyEntityId,
      hash,
      [deriveHardhatPrivateKey(1), deriveHardhatPrivateKey(2)],
      [],
      [0, 1],
      [60n, 40n],
      100n,
    );

    const [recoveredEntityId, valid] = await entityProvider.verifyHankoSignature(hanko, hash);
    expect(valid).to.equal(true);
    expect(recoveredEntityId).to.equal(lazyEntityId);
  });

  it("accepts reordered placeholder slots when indexes reconstruct the exact board", async function () {
    const { entityProvider, admin, entity1, entity2 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("descending placeholder slots"));
    const signer = addressEntityId(entity1.address);
    const placeholders = [addressEntityId(admin.address), addressEntityId(entity2.address)];
    expect(placeholders[0]!.toLowerCase() > placeholders[1]!.toLowerCase()).to.equal(true);
    const lazyEntityId = boardHash(1, [signer, ...placeholders], [1, 1, 1]);
    const hanko = buildClaimHanko(
      lazyEntityId,
      hash,
      [deriveHardhatPrivateKey(1)],
      placeholders,
      [2, 0, 1],
      [1n, 1n, 1n],
      1n,
    );

    const [recoveredEntityId, valid] = await entityProvider.verifyHankoSignature(hanko, hash);
    expect(valid).to.equal(true);
    expect(recoveredEntityId).to.equal(lazyEntityId);
  });

  it("rejects unused signature, placeholder, and sibling-claim proof material", async function () {
    const { entityProvider, entity1, entity2 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("minimal recursive hanko"));
    const first = addressEntityId(entity1.address);
    const second = addressEntityId(entity2.address);
    const firstEntity = boardHash(1, [first], [1]);
    const secondEntity = boardHash(1, [second], [1]);

    const unusedSignature = buildClaimsHanko(
      hash,
      [deriveHardhatPrivateKey(2), deriveHardhatPrivateKey(1)],
      [],
      [[firstEntity, [1], [1], 1]],
    );
    await expect(entityProvider.verifyHankoSignature(unusedSignature, hash))
      .to.be.revertedWithCustomError(entityProvider, "UnusedHankoSignature");

    const unusedPlaceholder = buildClaimsHanko(
      hash,
      [deriveHardhatPrivateKey(1)],
      [second],
      [[firstEntity, [1], [1], 1]],
    );
    await expect(entityProvider.verifyHankoSignature(unusedPlaceholder, hash))
      .to.be.revertedWithCustomError(entityProvider, "UnusedHankoPlaceholder");

    const unreachableSibling = buildClaimsHanko(
      hash,
      [deriveHardhatPrivateKey(2), deriveHardhatPrivateKey(1)],
      [],
      [
        [firstEntity, [1], [1], 1],
        [secondEntity, [0], [1], 1],
      ],
    );
    await expect(entityProvider.verifyHankoSignature(unreachableSibling, hash))
      .to.be.revertedWithCustomError(entityProvider, "UnusedHankoClaim");
  });

  it("accepts a raw 65-byte signature as the signer's own lazy 1-of-1 entity", async function () {
    const { depository, entityProvider, entity1, entity2 } = await loadFixture(deployFixture);
    const privateKey = deriveHardhatPrivateKey(1);
    const lazyId = singleSignerLazyEntityId(entity1.address);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("raw signature shortcut"));

    const raw = buildRawSignerHanko(hash, privateKey);
    expect(ethers.dataLength(raw)).to.equal(65);
    const envelope = buildSingleSignerHanko(lazyId, hash, privateKey);
    expect(ethers.dataLength(envelope)).to.be.greaterThan(65);
    // Same verdict and the same id from both shapes, in both verification modes.
    expect(await entityProvider.verifyHankoSignature(raw, hash)).to.deep.equal([lazyId, true]);
    expect(await entityProvider.verifyCurrentHankoSignature(raw, hash)).to.deep.equal([lazyId, true]);
    expect(await entityProvider.verifyHankoSignature(envelope, hash)).to.deep.equal([lazyId, true]);
    expect(await entityProvider.verifyCurrentHankoSignature(envelope, hash)).to.deep.equal([lazyId, true]);
    // v may be encoded as 0/1 instead of 27/28.
    const v = BigInt(ethers.dataSlice(raw, 64, 65));
    const rawV01 = ethers.concat([ethers.dataSlice(raw, 0, 64), ethers.toBeHex(v - 27n, 1)]);
    expect(await entityProvider.verifyHankoSignature(rawV01, hash)).to.deep.equal([lazyId, true]);
    // A different hash recovers a different key, i.e. a different lazy entity.
    const [otherId, otherOk] = await entityProvider.verifyHankoSignature(raw, ethers.keccak256("0x01"));
    expect(otherOk).to.equal(true);
    expect(otherId).to.not.equal(lazyId);

    // processBatch: raw signature and full envelope drive the same entity nonce lane.
    const tokenId = 1;
    const recipient = addressEntityId(entity2.address);
    await depository.mintToReserve(lazyId, tokenId, 300n);
    const encoded = encodeBatch(emptyBatch({
      reserveToReserve: [{ receivingEntity: recipient, tokenId, amount: 100n }],
    }));
    for (const [nonce, useRaw] of [[1n, true], [2n, false], [3n, true]] as const) {
      const batchHash = await computeDepositoryBatchHash(depository, encoded, nonce);
      const hankoData = useRaw
        ? buildRawSignerHanko(batchHash, privateKey)
        : buildSingleSignerHanko(lazyId, batchHash, privateKey);
      await expect(depository.processBatch(encoded, hankoData, nonce))
        .to.emit(depository, "HankoBatchProcessed")
        .withArgs(lazyId, batchHash, nonce);
    }
    expect(await depository.entityNonces(lazyId)).to.equal(3n);
    expect(await depository._reserves(lazyId, tokenId)).to.equal(0n);
    expect(await depository._reserves(recipient, tokenId)).to.equal(300n);
  });

  it("rejects malformed raw signatures: high-s and bad v fail softly, wrong lengths do not decode", async function () {
    const { depository, entityProvider, entity1 } = await loadFixture(deployFixture);
    const privateKey = deriveHardhatPrivateKey(1);
    const lazyId = singleSignerLazyEntityId(entity1.address);
    const encoded = encodeBatch(emptyBatch());
    const nonce = 1n;
    const batchHash = await computeDepositoryBatchHash(depository, encoded, nonce);
    const signature = new ethers.SigningKey(privateKey).sign(ethers.getBytes(batchHash));
    const good = signature.serialized;
    expect(await entityProvider.verifyHankoSignature(good, batchHash)).to.deep.equal([lazyId, true]);

    const highS = ethers.concat([
      signature.r,
      ethers.toBeHex(SECP256K1_N - BigInt(signature.s), 32),
      ethers.toBeHex(signature.v === 28 ? 27 : 28, 1),
    ]);
    expect(await entityProvider.verifyHankoSignature(highS, batchHash)).to.deep.equal([ethers.ZeroHash, false]);
    await expect(depository.processBatch(encoded, highS, nonce)).to.be.revertedWithCustomError(depository, "E4");

    const badV = ethers.concat([signature.r, signature.s, "0x1d"]); // v = 29
    expect(await entityProvider.verifyHankoSignature(badV, batchHash)).to.deep.equal([ethers.ZeroHash, false]);
    await expect(depository.processBatch(encoded, badV, nonce)).to.be.revertedWithCustomError(depository, "E4");

    // 64 or 66 bytes are neither the raw shape nor a valid abi.encode(HankoBytes).
    const short = ethers.dataSlice(good, 0, 64);
    const long = ethers.concat([good, "0x00"]);
    await expect(entityProvider.verifyHankoSignature(short, batchHash)).to.be.revert(ethers);
    await expect(entityProvider.verifyHankoSignature(long, batchHash)).to.be.revert(ethers);
    await expect(depository.processBatch(encoded, short, nonce)).to.be.revert(ethers);
    await expect(depository.processBatch(encoded, long, nonce)).to.be.revert(ethers);
    expect(await depository.entityNonces(lazyId)).to.equal(0n);
  });

  it("binds all three Board delays into the lazy Entity id", async function () {
    const { entityProvider } = await loadFixture(deployFixture);
    const privateKey = ethers.toBeHex(1n, 32);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("xln:hanko:v1:golden"));
    const member = addressEntityId(ethers.computeAddress(new ethers.SigningKey(privateKey).publicKey));
    const delays = [11, 12, 13] as const;
    const entityId = boardHash(1, [member], [1], delays);
    const hanko = buildClaimsHanko(
      hash,
      [privateKey],
      [],
      [[entityId, [0], [1], 1, delays]],
    );
    expect(entityId).to.equal("0xe3d6aa2ac02777d0796e2996d73c3e203011357aff8b877ee86beab827a8e4f0");
    // Golden over the single 4-field envelope (memberSignatures = []).
    expect(ethers.keccak256(hanko)).to.equal("0x2ff6529255ffbfc79b506c9c3dce1a61bf644942ad38b5c1dcbd63617af6173f");
    expect(await entityProvider.verifyHankoSignature(hanko, hash)).to.deep.equal([entityId, true]);
  });

  it("rejects an Entity claim as the default proposer at member zero", async function () {
    const { entityProvider, entity1 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("entity proposer forbidden"));
    const childId = singleSignerLazyEntityId(entity1.address);
    const parentId = boardHash(1, [childId], [1]);
    const hanko = buildClaimsHanko(hash, [deriveHardhatPrivateKey(1)], [], [
      [childId, [0], [1], 1],
      [parentId, [1], [1], 1],
    ]);
    await expect(entityProvider.verifyHankoSignature(hanko, hash))
      .to.be.revertedWithCustomError(entityProvider, "InvalidHankoFirstMember");
  });

  it("verifies an EOA-anchored parent from an already-verified child claim", async function () {
    const { entityProvider, entity1, entity2 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("recursive child parent"));
    const childId = singleSignerLazyEntityId(entity1.address);
    const anchor = addressEntityId(admin.address);
    const parentId = boardHash(1, [anchor, childId], [1, 1]);
    const hanko = buildClaimsHanko(hash, [deriveHardhatPrivateKey(1)], [anchor], [
      [childId, [1], [1], 1],
      [parentId, [0, 2], [1, 1], 1],
    ]);

    expect(await entityProvider.verifyHankoSignature(hanko, hash)).to.deep.equal([parentId, true]);
  });

  it("binds every registered child claim to its on-chain board", async function () {
    const { entityProvider, admin, entity1 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("registered recursive child"));
    await entityProvider.registerNumberedEntity(encodeSingleSignerBoard(entity1.address));
    const childId = ethers.zeroPadValue(ethers.toBeHex(2), 32);
    const anchor = addressEntityId(admin.address);
    const parentId = boardHash(1, [anchor, childId], [1, 1]);
    const hanko = buildClaimsHanko(hash, [deriveHardhatPrivateKey(1)], [anchor], [
      [childId, [1], [1], 1],
      [parentId, [0, 2], [1, 1], 1],
    ]);

    expect(await entityProvider.verifyHankoSignature(hanko, hash)).to.deep.equal([parentId, true]);

    const forgedChild = buildClaimsHanko(hash, [deriveHardhatPrivateKey(2)], [anchor], [
      [childId, [1], [1], 1],
      [parentId, [0, 2], [1, 1], 1],
    ]);
    expect(await entityProvider.verifyHankoSignature(forgedChild, hash))
      .to.deep.equal([ethers.ZeroHash, false]);
  });

  it("rejects self and future claim references", async function () {
    const { entityProvider, entity1, entity2 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("recursive claim order"));
    const childId = singleSignerLazyEntityId(entity1.address);
    const anchor = addressEntityId(entity2.address);
    const parentId = boardHash(1, [anchor, childId], [1, 1]);
    const futureReference = buildClaimsHanko(hash, [deriveHardhatPrivateKey(1)], [anchor], [
      [parentId, [0, 3], [1, 1], 1],
      [childId, [1], [1], 1],
    ]);
    await expect(entityProvider.verifyHankoSignature(futureReference, hash))
      .to.be.revertedWithCustomError(entityProvider, "InvalidHankoClaimOrder");

    const selfReference = buildClaimsHanko(hash, [deriveHardhatPrivateKey(1)], [anchor], [
      [childId, [0, 2], [1, 1], 1],
    ]);
    await expect(entityProvider.verifyHankoSignature(selfReference, hash))
      .to.be.revertedWithCustomError(entityProvider, "InvalidHankoClaimOrder");
  });

  it("rejects duplicate claim Entity ids", async function () {
    const { entityProvider, entity1 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("duplicate recursive claim"));
    const childId = singleSignerLazyEntityId(entity1.address);
    const duplicate = buildClaimsHanko(hash, [deriveHardhatPrivateKey(1)], [], [
      [childId, [0], [1], 1],
      [childId, [0], [1], 1],
    ]);
    await expect(entityProvider.verifyHankoSignature(duplicate, hash))
      .to.be.revertedWithCustomError(entityProvider, "DuplicateHankoClaimEntity");
  });

  it("canonical Hanko verification uses the current board of a registered entity", async function () {
    const { entityProvider, entity1 } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("indexed recovery"));
    const boardHash = singleSignerLazyEntityId(entity1.address);

    const tx = await entityProvider.registerNumberedEntity(encodeSingleSignerBoard(entity1.address));
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

    const [registered] = await entityProvider.getEntityInfo(entityId);
    expect(registered).to.equal(true);
    const hanko = buildSingleSignerHanko(entityId, hash, deriveHardhatPrivateKey(1));
    const [recoveredEntityId, valid] = await entityProvider.verifyHankoSignature(hanko, hash);
    expect(valid).to.equal(true);
    expect(recoveredEntityId).to.equal(entityId);
  });

  it("binds a shared board independently to every registered entity id", async function () {
    const { entityProvider, entity1, entity2 } = await loadFixture(deployFixture);
    const boardHash = singleSignerLazyEntityId(entity1.address);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("shared board principals"));

    await entityProvider.registerNumberedEntity(encodeSingleSignerBoard(entity1.address));
    await entityProvider.registerNumberedEntity(encodeSingleSignerBoard(entity1.address));
    const firstId = ethers.zeroPadValue(ethers.toBeHex(2), 32);
    const secondId = ethers.zeroPadValue(ethers.toBeHex(3), 32);
    expect((await entityProvider.entities(firstId)).currentBoardHash).to.equal(boardHash);
    expect((await entityProvider.entities(secondId)).currentBoardHash).to.equal(boardHash);

    const firstHanko = buildSingleSignerHanko(firstId, hash, deriveHardhatPrivateKey(1));
    const secondHanko = buildSingleSignerHanko(secondId, hash, deriveHardhatPrivateKey(1));
    expect(await entityProvider.verifyHankoSignature(firstHanko, hash)).to.deep.equal([firstId, true]);
    expect(await entityProvider.verifyHankoSignature(secondHanko, hash)).to.deep.equal([secondId, true]);

    const [secondControlTokenId] = await entityProvider.getTokenIds(3);
    const firstActionHash = await entityProvider.computeEntityTransferHankoHash(
      2, entity2.address, secondControlTokenId, 1, 1,
    );
    const secondActionHash = await entityProvider.computeEntityTransferHankoHash(
      3, entity2.address, secondControlTokenId, 1, 1,
    );
    expect(firstActionHash).to.not.equal(secondActionHash);
    const firstActionHanko = buildSingleSignerHanko(firstId, firstActionHash, deriveHardhatPrivateKey(1));
    await expect(entityProvider.entityTransferTokens(
      3, entity2.address, secondControlTokenId, 1, firstActionHanko,
    )).to.be.revertedWith("Invalid entity signature");
    const secondActionHanko = buildSingleSignerHanko(secondId, secondActionHash, deriveHardhatPrivateKey(1));
    await expect(entityProvider.entityTransferTokens(
      3, entity2.address, secondControlTokenId, 1, secondActionHanko,
    )).to.not.revert(ethers);
  });

  it("does not expose unsafeProcessBatch", async function () {
    const { depository } = await loadFixture(deployFixture);
    expect(depository.interface.hasFunction("unsafeProcessBatch")).to.equal(false);
  });
});
