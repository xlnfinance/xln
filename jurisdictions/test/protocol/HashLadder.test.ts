import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

const abiCoder = ethers.AbiCoder.defaultAbiCoder();

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

function partialRoot(roots: string[]): string {
  return ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32", "bytes32", "bytes32"], roots));
}

function nibbles(fillRatio: number): number[] {
  return [
    (fillRatio >> 12) & 0x0f,
    (fillRatio >> 8) & 0x0f,
    (fillRatio >> 4) & 0x0f,
    fillRatio & 0x0f,
  ];
}

describe("HashLadder", function () {
  async function deployHarness() {
    const factory = await ethers.getContractFactory("HashLadderHarness");
    const harness = await factory.deploy();
    await harness.waitForDeployment();
    return harness;
  }

  it("builds the full-fill hash and four-nibble partial root", async function () {
    const harness = await deployHarness();
    const fullSecret = secret("full");
    const bases = [secret("n0"), secret("n1"), secret("n2"), secret("n3")];

    const [fullHash, root] = await harness.buildCommitment(fullSecret, bases);

    const roots = bases.map((base) => hashSteps(base, 15));
    expect(fullHash).to.equal(hashNode(fullSecret));
    expect(root).to.equal(partialRoot(roots));
  });

  it("verifies a partial fill from nibble reveal nodes", async function () {
    const harness = await deployHarness();
    const fullSecret = secret("full");
    const bases = [secret("n0"), secret("n1"), secret("n2"), secret("n3")];
    const [, root] = await harness.buildCommitment(fullSecret, bases);
    const fillRatio = 0x0123;
    const reveals = nibbles(fillRatio).map((digit, index) => hashSteps(bases[index], 15 - digit));

    expect(await harness.partialRootFromReveals(fillRatio, reveals)).to.equal(root);
    expect(await harness.verifyPartial(root, fillRatio, reveals)).to.equal(true);
    expect(await harness.verifyPartial(root, 0x0124, reveals)).to.equal(false);
  });

  it("uses the one-hash full-fill fast path for 0xffff", async function () {
    const harness = await deployHarness();
    const fullSecret = secret("full");
    const bases = [secret("n0"), secret("n1"), secret("n2"), secret("n3")];
    const [fullHash, root] = await harness.buildCommitment(fullSecret, bases);
    const emptyReveals = [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash];

    expect(await harness.verifyFull(fullHash, fullSecret)).to.equal(true);
    expect(await harness.verify(fullHash, root, 0xffff, fullSecret, emptyReveals)).to.equal(true);
    expect(await harness.verifyPartial(root, 0xffff, emptyReveals)).to.equal(false);
  });

  it("treats nibble index 0 as the most significant hex digit", async function () {
    const harness = await deployHarness();

    expect(await harness.nibbleAt(0x0123, 0)).to.equal(0);
    expect(await harness.nibbleAt(0x0123, 1)).to.equal(1);
    expect(await harness.nibbleAt(0x0123, 2)).to.equal(2);
    expect(await harness.nibbleAt(0x0123, 3)).to.equal(3);
  });
});
