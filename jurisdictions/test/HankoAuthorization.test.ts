import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers.js";
import { expect } from "chai";
import hre from "hardhat";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import type { Depository, EntityProvider } from "../typechain-types/index.js";

/**
 * Hanko Authorization Tests (updated for processBatch + unsafeProcessBatch)
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

  it("reserveToReserve authorizes fromEntity signer", async function () {
    const { depository, entity1, entity2 } = await loadFixture(deployFixture);

    const entity1Id = ethers.zeroPadValue(entity1.address, 32);
    const entity2Id = ethers.zeroPadValue(entity2.address, 32);
    const tokenId = 1;
    const fundAmount = ethers.parseEther("100");
    const transferAmount = ethers.parseEther("25");

    await depository.mintToReserve(entity1Id, tokenId, fundAmount);

    await expect(
      depository.connect(entity1).reserveToReserve(entity1Id, entity2Id, tokenId, transferAmount)
    ).to.not.be.reverted;

    const entity1Balance = await depository._reserves(entity1Id, tokenId);
    const entity2Balance = await depository._reserves(entity2Id, tokenId);
    expect(entity1Balance).to.equal(fundAmount - transferAmount);
    expect(entity2Balance).to.equal(transferAmount);
  });

  it("reserveToReserve rejects unauthorized caller", async function () {
    const { depository, entity1, entity2 } = await loadFixture(deployFixture);

    const entity1Id = ethers.zeroPadValue(entity1.address, 32);
    const entity2Id = ethers.zeroPadValue(entity2.address, 32);
    const tokenId = 1;

    await depository.mintToReserve(entity1Id, tokenId, 100n);

    await expect(
      depository.connect(entity2).reserveToReserve(entity1Id, entity2Id, tokenId, 10n)
    ).to.be.revertedWith("E2: caller must be fromEntity or admin");
  });

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
      depository.processBatch("0x", await entityProvider.getAddress(), emptyHanko, 1)
    ).to.be.revertedWithCustomError(depository, "E4");
  });

  it("unsafeProcessBatch allows admin", async function () {
    const { depository, entity1, entity2 } = await loadFixture(deployFixture);

    const entity1Id = ethers.zeroPadValue(entity1.address, 32);
    const entity2Id = ethers.zeroPadValue(entity2.address, 32);
    const tokenId = 1;
    const fundAmount = 1_000n;
    const transferAmount = 100n;

    await depository.mintToReserve(entity1Id, tokenId, fundAmount);

    const batch = {
      flashloans: [],
      reserveToReserve: [{ receivingEntity: entity2Id, tokenId, amount: transferAmount }],
      reserveToCollateral: [],
      collateralToReserve: [],
      settlements: [],
      disputeStarts: [],
      disputeFinalizations: [],
      externalTokenToReserve: [],
      reserveToExternalToken: [],
      revealSecrets: [],
      hub_id: 0,
    };

    await expect(
      depository.unsafeProcessBatch(entity1Id, batch)
    ).to.not.be.reverted;

    const entity1Balance = await depository._reserves(entity1Id, tokenId);
    const entity2Balance = await depository._reserves(entity2Id, tokenId);
    expect(entity1Balance).to.equal(fundAmount - transferAmount);
    expect(entity2Balance).to.equal(transferAmount);
  });
});
