import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers.js";
import { expect } from "chai";
import hre from "hardhat";
import type { DeltaTransformer } from "../typechain-types/index.js";

const { ethers } = hre;

describe("DeltaTransformer", function () {
  async function deployFixture() {
    const factory = await hre.ethers.getContractFactory("DeltaTransformer");
    const transformer = await factory.deploy();
    await transformer.waitForDeployment();
    return { transformer: transformer as DeltaTransformer };
  }

  it("decodes swap fill ratios from uint16 calldata arguments", async function () {
    const { transformer } = await loadFixture(deployFixture);

    const batch = {
      payment: [],
      swap: [
        {
          ownerIsLeft: true,
          addDeltaIndex: 0,
          addAmount: 1_000,
          subDeltaIndex: 1,
          subAmount: 2_000,
        },
      ],
    };
    const encodedBatch = await transformer.encodeBatch(batch);
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const rightArguments = abiCoder.encode(["uint16[]", "bytes32[]"], [[32767], []]);

    const result = await transformer.applyBatch.staticCall([0, 0], encodedBatch, "0x", rightArguments);

    expect(result[0]).to.equal(499);
    expect(result[1]).to.equal(-999);
  });

  it("reverts on out-of-bounds swap delta indices", async function () {
    const { transformer } = await loadFixture(deployFixture);

    const batch = {
      payment: [],
      swap: [
        {
          ownerIsLeft: true,
          addDeltaIndex: 1,
          addAmount: 1,
          subDeltaIndex: 0,
          subAmount: 1,
        },
      ],
    };
    const encodedBatch = await transformer.encodeBatch(batch);
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const rightArguments = abiCoder.encode(["uint16[]", "bytes32[]"], [[65535], []]);

    await expect(
      transformer.applyBatch.staticCall([0], encodedBatch, "0x", rightArguments),
    ).to.be.reverted;
  });
});
