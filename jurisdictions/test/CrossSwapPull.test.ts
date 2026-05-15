import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers.js";
import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;
const abiCoder = ethers.AbiCoder.defaultAbiCoder();
const MAX_FILL_RATIO = 65535n;

function secret(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function hashNode(node: string): string {
  return ethers.keccak256(abiCoder.encode(["bytes32"], [node]));
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

function buildProof(label: string, fillRatio: number) {
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

function encodePartialBinary(fillRatio: number, reveals: string[]): string {
  return `0x${fillRatio.toString(16).padStart(4, "0")}${reveals.map((reveal) => reveal.slice(2)).join("")}`;
}

function encodePullArguments(binaries: string[]): string {
  return abiCoder.encode(["bytes[]"], [binaries]);
}

describe("CrossSwapPull", function () {
  async function deployFixture() {
    const factory = await ethers.getContractFactory("CrossSwapPull");
    const transformer = await factory.deploy();
    await transformer.waitForDeployment();
    return { transformer };
  }

  async function encodeSinglePull(
    transformer: Awaited<ReturnType<typeof deployFixture>>["transformer"],
    fillRatio: number,
    amount: bigint,
    revealedUntilBlock: number,
  ) {
    const proof = buildProof("pull", fillRatio);
    const encodedBatch = await transformer.encodeBatch({
      pulls: [
        {
          ownerIsLeft: true,
          addDeltaIndex: 0,
          amount,
          subDeltaIndex: 1,
          revealedUntilBlock,
          fullHash: proof.fullHash,
          partialRoot: proof.partialRoot,
        },
      ],
    });
    return { proof, encodedBatch };
  }

  it("applies a partial pull only when the fill ratio matches the hash ladder", async function () {
    const { transformer } = await loadFixture(deployFixture);
    const fillRatio = 0x0123;
    const deadline = (await ethers.provider.getBlockNumber()) + 10;
    const { proof, encodedBatch } = await encodeSinglePull(transformer, fillRatio, MAX_FILL_RATIO, deadline);
    const rightArguments = encodePullArguments([encodePartialBinary(fillRatio, proof.reveals)]);

    const result = await transformer.applyBatch.staticCall([0, 0], encodedBatch, "0x", rightArguments);

    expect(result[0]).to.equal(BigInt(fillRatio));
    expect(result[1]).to.equal(-BigInt(fillRatio));
  });

  it("keeps the 100% fill fast path to one full-fill secret", async function () {
    const { transformer } = await loadFixture(deployFixture);
    const deadline = (await ethers.provider.getBlockNumber()) + 10;
    const { proof, encodedBatch } = await encodeSinglePull(transformer, 0xffff, 1234n, deadline);
    const rightArguments = encodePullArguments([proof.fullSecret]);

    const result = await transformer.applyBatch.staticCall([0, 0], encodedBatch, "0x", rightArguments);

    expect(result[0]).to.equal(1234n);
    expect(result[1]).to.equal(-1234n);
  });

  it("ignores stale calldata-only ladder reveals after the pull deadline", async function () {
    const { transformer } = await loadFixture(deployFixture);
    const fillRatio = 0x0001;
    const deadline = (await ethers.provider.getBlockNumber()) + 1;
    const { proof, encodedBatch } = await encodeSinglePull(transformer, fillRatio, MAX_FILL_RATIO, deadline);
    await mine(2);

    const rightArguments = encodePullArguments([encodePartialBinary(fillRatio, proof.reveals)]);
    const result = await transformer.applyBatch.staticCall([0, 0], encodedBatch, "0x", rightArguments);

    expect(result[0]).to.equal(0n);
    expect(result[1]).to.equal(0n);
  });

  it("accepts expired ladder arguments when the dispute argument block was before the deadline", async function () {
    const { transformer } = await loadFixture(deployFixture);
    const fillRatio = 0x0123;
    const argumentBlock = await ethers.provider.getBlockNumber();
    const deadline = argumentBlock + 5;
    const { proof, encodedBatch } = await encodeSinglePull(transformer, fillRatio, MAX_FILL_RATIO, deadline);
    await mine(5);

    const rightArguments = encodePullArguments([encodePartialBinary(fillRatio, proof.reveals)]);
    const result = await transformer.applyBatchWithArgumentBlocks.staticCall(
      [0, 0],
      encodedBatch,
      "0x",
      rightArguments,
      argumentBlock,
      argumentBlock,
    );

    expect(result[0]).to.equal(BigInt(fillRatio));
    expect(result[1]).to.equal(-BigInt(fillRatio));
  });

  it("gives the target leg a T plus delay window to reuse source secrets", async function () {
    const factory = await ethers.getContractFactory("CrossSwapPull");
    const source = await factory.deploy();
    const target = await factory.deploy();
    await source.waitForDeployment();
    await target.waitForDeployment();

    const fillRatio = 0x00af;
    const proof = buildProof("cross", fillRatio);
    const currentBlock = await ethers.provider.getBlockNumber();
    const sourceDeadline = currentBlock + 5;
    const targetDeadline = sourceDeadline + 8;
    const sourceBatch = await source.encodeBatch({
      pulls: [
        {
          ownerIsLeft: true,
          addDeltaIndex: 0,
          amount: MAX_FILL_RATIO,
          subDeltaIndex: 1,
          revealedUntilBlock: sourceDeadline,
          fullHash: proof.fullHash,
          partialRoot: proof.partialRoot,
        },
      ],
    });
    const targetBatch = await target.encodeBatch({
      pulls: [
        {
          ownerIsLeft: true,
          addDeltaIndex: 0,
          amount: MAX_FILL_RATIO,
          subDeltaIndex: 1,
          revealedUntilBlock: targetDeadline,
          fullHash: proof.fullHash,
          partialRoot: proof.partialRoot,
        },
      ],
    });
    const argumentsForBothLegs = encodePullArguments([encodePartialBinary(fillRatio, proof.reveals)]);

    const sourceArgumentBlock = sourceDeadline;
    await mine(6);
    expect(await ethers.provider.getBlockNumber()).to.be.greaterThan(sourceDeadline);

    const sourceResult = await source.applyBatchWithArgumentBlocks.staticCall(
      [0, 0],
      sourceBatch,
      "0x",
      argumentsForBothLegs,
      sourceArgumentBlock,
      sourceArgumentBlock,
    );
    expect(sourceResult[0]).to.equal(BigInt(fillRatio));

    const targetArgumentBlock = targetDeadline;
    await mine(8);

    const targetResult = await target.applyBatchWithArgumentBlocks.staticCall(
      [0, 0],
      targetBatch,
      "0x",
      argumentsForBothLegs,
      targetArgumentBlock,
      targetArgumentBlock,
    );
    expect(targetResult[0]).to.equal(BigInt(fillRatio));
    expect(targetResult[1]).to.equal(-BigInt(fillRatio));
  });

  it("does not maintain an on-chain secret registry", async function () {
    const { transformer } = await loadFixture(deployFixture);
    await expect(transformer.revealSecret(secret("unused"))).to.be.revertedWithCustomError(
      transformer,
      "SecretRegistryDisabled",
    );
    expect(await transformer.hashToBlock(hashNode(secret("unused")))).to.equal(0n);
  });
});
