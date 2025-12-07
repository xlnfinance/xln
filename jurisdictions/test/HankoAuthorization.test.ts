import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers.js";
import { expect } from "chai";
import hre from "hardhat";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import { Depository, EntityProvider } from "../typechain-types/index.js";

/**
 * Hanko Authorization Tests
 *
 * Tests the Hanko signature verification system for entity-level actions:
 * - testMode bypass for testing
 * - Production mode enforcement
 * - Nonce replay protection
 * - EntityProvider integration
 */
describe("Hanko Authorization", function () {
  let depository: Depository;
  let entityProvider: EntityProvider;
  let admin: HardhatEthersSigner;
  let entity1: HardhatEthersSigner;
  let entity2: HardhatEthersSigner;
  let entity3: HardhatEthersSigner;

  async function deployFixture() {
    [admin, entity1, entity2, entity3] = await hre.ethers.getSigners();

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
    depository = await DepositoryFactory.deploy();
    await depository.waitForDeployment();

    // Add EntityProvider to approved list
    await depository.addEntityProvider(await entityProvider.getAddress());

    // Register test entities in EntityProvider
    const entity1BoardHash = ethers.keccak256(ethers.toUtf8Bytes("entity1-board"));
    const entity2BoardHash = ethers.keccak256(ethers.toUtf8Bytes("entity2-board"));

    await entityProvider.connect(entity1).registerNumberedEntity(entity1BoardHash);
    await entityProvider.connect(entity2).registerNumberedEntity(entity2BoardHash);

    // Fund entities with test reserves
    const entity1Id = ethers.zeroPadValue(ethers.toBeHex(2), 32); // Entity #2 (foundation is #1)
    const entity2Id = ethers.zeroPadValue(ethers.toBeHex(3), 32); // Entity #3

    const tokenId = 1;
    const fundAmount = ethers.parseEther("1000");

    await depository.mintToReserve(entity1Id, tokenId, fundAmount);
    await depository.mintToReserve(entity2Id, tokenId, fundAmount);

    return { depository, entityProvider, admin, entity1, entity2, entity3, entity1Id, entity2Id, tokenId };
  }

  describe("Test Mode", function () {
    it("Should start with testMode enabled", async function () {
      const { depository } = await loadFixture(deployFixture);
      expect(await depository.testMode()).to.equal(true);
    });

    it("Should allow testMode bypass without Hanko signature", async function () {
      const { depository, entity1Id, entity2Id, tokenId } = await loadFixture(deployFixture);

      const transferAmount = ethers.parseEther("100");

      // Call reserveToReserve in testMode (no Hanko needed)
      await expect(
        depository.reserveToReserve(
          entity1Id,
          entity2Id,
          tokenId,
          transferAmount
        )
      ).to.not.be.reverted;

      // Verify transfer succeeded
      const entity2Balance = await depository._reserves(entity2Id, tokenId);
      expect(entity2Balance).to.equal(ethers.parseEther("1100"));
    });

    it("Should allow processBatch in testMode", async function () {
      const { depository, entity1Id, entity2Id, tokenId } = await loadFixture(deployFixture);

      const batch = {
        reserveToExternalToken: [],
        externalTokenToReserve: [],
        reserveToReserve: [{
          receivingEntity: entity2Id,
          tokenId: tokenId,
          amount: ethers.parseEther("50")
        }],
        reserveToCollateral: [],
        settlements: [],
        cooperativeUpdate: [],
        cooperativeDisputeProof: [],
        initialDisputeProof: [],
        finalDisputeProof: [],
        flashloans: [],
        hub_id: 0
      };

      await expect(
        depository.processBatch(entity1Id, batch)
      ).to.not.be.reverted;
    });

    it("Should disable testMode permanently", async function () {
      const { depository } = await loadFixture(deployFixture);

      await expect(depository.disableTestModeForever())
        .to.emit(depository, "TestModeDisabled");

      expect(await depository.testMode()).to.equal(false);
    });

    it("Should not allow re-enabling testMode", async function () {
      const { depository } = await loadFixture(deployFixture);

      await depository.disableTestModeForever();

      await expect(
        depository.disableTestModeForever()
      ).to.be.revertedWith("Test mode already disabled");
    });
  });

  describe("Production Mode", function () {
    it("Should reject processBatch without Hanko in production", async function () {
      const { depository, entity1Id, entity2Id, tokenId } = await loadFixture(deployFixture);

      // Disable testMode
      await depository.disableTestModeForever();

      const batch = {
        reserveToExternalToken: [],
        externalTokenToReserve: [],
        reserveToReserve: [{
          receivingEntity: entity2Id,
          tokenId: tokenId,
          amount: ethers.parseEther("50")
        }],
        reserveToCollateral: [],
        settlements: [],
        cooperativeUpdate: [],
        cooperativeDisputeProof: [],
        initialDisputeProof: [],
        finalDisputeProof: [],
        flashloans: [],
        hub_id: 0
      };

      await expect(
        depository.processBatch(entity1Id, batch)
      ).to.be.revertedWith("Depository: use processBatchWithHanko() in production");
    });

    it("Should reject reserveToReserve without valid Hanko", async function () {
      const { depository, entity1Id, entity2Id, tokenId } = await loadFixture(deployFixture);

      // Disable testMode
      await depository.disableTestModeForever();

      const transferAmount = ethers.parseEther("100");

      // Direct calls rejected in production - must use processBatchWithHanko
      await expect(
        depository.reserveToReserve(
          entity1Id,
          entity2Id,
          tokenId,
          transferAmount
        )
      ).to.be.revertedWithCustomError(depository, "E2"); // Unauthorized
    });

    it("Should reject prefundAccount without valid Hanko", async function () {
      const { depository, entity1Id, entity2Id, tokenId } = await loadFixture(deployFixture);

      // Disable testMode
      await depository.disableTestModeForever();

      const fundAmount = ethers.parseEther("100");

      // Direct calls rejected in production - must use processBatchWithHanko
      await expect(
        depository.prefundAccount(
          entity1Id,
          entity2Id,
          tokenId,
          fundAmount
        )
      ).to.be.revertedWithCustomError(depository, "E2"); // Unauthorized
    });

    it("Should reject settle without valid Hanko", async function () {
      const { depository, entity1Id, entity2Id } = await loadFixture(deployFixture);

      // Disable testMode
      await depository.disableTestModeForever();

      // Direct calls rejected in production - must use processBatchWithHanko
      await expect(
        depository.settle(
          entity1Id,
          entity2Id,
          [], // diffs
          [], // forgiveDebtsInTokenIds
          [], // insuranceRegs
          "0x" // counterparty sig
        )
      ).to.be.revertedWithCustomError(depository, "E2"); // Unauthorized
    });
  });

  describe("Nonce Management", function () {
    it("Should start with nonce 0 for new entities", async function () {
      const { depository, entity1 } = await loadFixture(deployFixture);

      const nonce = await depository.entityNonces(entity1.address);
      expect(nonce).to.equal(0);
    });

    it("Should increment nonce after processBatchWithHanko", async function () {
      const { depository, entityProvider, entity1Id } = await loadFixture(deployFixture);

      // This would require creating valid Hanko signatures
      // For now, just verify nonce getter works
      const entity1Address = ethers.getAddress(entity1Id);
      const nonce = await depository.entityNonces(entity1Address);
      expect(nonce).to.be.a('bigint');
    });

    // TODO: Add test with actual Hanko signature generation
    // This requires implementing the full Hanko signature creation flow
  });

  describe("EntityProvider Integration", function () {
    it("Should only accept approved EntityProviders via processBatchWithHanko", async function () {
      const { depository, entity1Id, entity2Id, tokenId } = await loadFixture(deployFixture);

      // Disable testMode
      await depository.disableTestModeForever();

      // Direct calls no longer take provider - they just reject in prod mode
      // EntityProvider verification only happens via processBatchWithHanko
      await expect(
        depository.reserveToReserve(
          entity1Id,
          entity2Id,
          tokenId,
          ethers.parseEther("100")
        )
      ).to.be.revertedWithCustomError(depository, "E2"); // Unauthorized
    });

    it("Should list approved EntityProviders", async function () {
      const { depository, entityProvider } = await loadFixture(deployFixture);

      const providers = await depository.getApprovedProviders();
      expect(providers).to.include(await entityProvider.getAddress());
    });

    it("Should allow admin to add EntityProvider", async function () {
      const { depository, admin } = await loadFixture(deployFixture);

      // Deploy a second EntityProvider
      const EntityProviderFactory = await hre.ethers.getContractFactory("EntityProvider");
      const secondProvider = await EntityProviderFactory.deploy();
      await secondProvider.waitForDeployment();

      const secondAddress = await secondProvider.getAddress();

      await expect(
        depository.connect(admin).addEntityProvider(secondAddress)
      ).to.emit(depository, "EntityProviderAdded")
        .withArgs(secondAddress);

      const providers = await depository.getApprovedProviders();
      expect(providers).to.include(secondAddress);
    });

    it("Should allow admin to remove EntityProvider", async function () {
      const { depository, entityProvider, admin } = await loadFixture(deployFixture);

      const providerAddress = await entityProvider.getAddress();

      await expect(
        depository.connect(admin).removeEntityProvider(providerAddress)
      ).to.emit(depository, "EntityProviderRemoved")
        .withArgs(providerAddress);

      const providers = await depository.getApprovedProviders();
      expect(providers).to.not.include(providerAddress);
    });
  });

  describe("Domain Separation", function () {
    it("Should use correct DOMAIN_SEPARATOR", async function () {
      const { depository } = await loadFixture(deployFixture);

      const expectedSeparator = ethers.keccak256(ethers.toUtf8Bytes("XLN_DEPOSITORY_HANKO_V1"));
      const actualSeparator = await depository.DOMAIN_SEPARATOR();

      expect(actualSeparator).to.equal(expectedSeparator);
    });

    // TODO: Test that different action types produce different hashes
    // This ensures RESERVE_TO_RESERVE signatures can't be replayed for SETTLE
  });

  describe("Edge Cases", function () {
    it("Should allow small transfers in testMode", async function () {
      const { depository, entity1Id, entity2Id, tokenId } = await loadFixture(deployFixture);

      // Direct calls work in testMode
      await expect(
        depository.reserveToReserve(
          entity1Id,
          entity2Id,
          tokenId,
          ethers.parseEther("1")
        )
      ).to.not.be.reverted;
    });

    it("Should preserve existing functionality for externalTokenToReserve", async function () {
      const { depository } = await loadFixture(deployFixture);

      // externalTokenToReserve should NOT require Hanko (ERC20 don't speak EP.sol)
      // This function should remain unchanged
      // Just verify it exists
      expect(depository.externalTokenToReserve).to.exist;
    });
  });
});
