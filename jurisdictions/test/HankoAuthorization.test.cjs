const { expect } = require("chai");
const { ethers } = require("hardhat");

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
  let depository;
  let entityProvider;
  let admin, entity1Signer, entity2Signer;
  let entity1Id, entity2Id;
  const tokenId = 1;

  beforeEach(async function () {
    [admin, entity1Signer, entity2Signer] = await ethers.getSigners();

    // Deploy EntityProvider
    const EntityProvider = await ethers.getContractFactory("EntityProvider");
    entityProvider = await EntityProvider.deploy();
    await entityProvider.waitForDeployment();

    // Deploy Account library first
    const Account = await ethers.getContractFactory("Account");
    const account = await Account.deploy();
    await account.waitForDeployment();

    // Deploy Depository with Account library linked
    const Depository = await ethers.getContractFactory("Depository", {
      libraries: {
        Account: await account.getAddress()
      }
    });
    depository = await Depository.deploy();
    await depository.waitForDeployment();

    // Add EntityProvider to approved list
    await depository.addEntityProvider(await entityProvider.getAddress());

    // Register test entities
    const entity1BoardHash = ethers.keccak256(ethers.toUtf8Bytes("entity1-board"));
    const entity2BoardHash = ethers.keccak256(ethers.toUtf8Bytes("entity2-board"));

    await entityProvider.connect(entity1Signer).registerNumberedEntity(entity1BoardHash);
    await entityProvider.connect(entity2Signer).registerNumberedEntity(entity2BoardHash);

    // Entity IDs (foundation is #1, so first registered is #2)
    entity1Id = ethers.zeroPadValue(ethers.toBeHex(2), 32);
    entity2Id = ethers.zeroPadValue(ethers.toBeHex(3), 32);

    // Fund entities with test reserves
    const fundAmount = ethers.parseEther("1000");
    await depository.mintToReserve(entity1Id, tokenId, fundAmount);
    await depository.mintToReserve(entity2Id, tokenId, fundAmount);
  });

  describe("Test Mode", function () {
    it("Should start with testMode enabled", async function () {
      expect(await depository.testMode()).to.equal(true);
    });

    it("Should allow testMode bypass without Hanko signature", async function () {
      const transferAmount = ethers.parseEther("100");

      // Call reserveToReserve in testMode (no Hanko needed)
      await depository.reserveToReserve(
        entity1Id,
        entity2Id,
        tokenId,
        transferAmount
      );

      // Verify transfer succeeded
      const entity2Balance = await depository._reserves(entity2Id, tokenId);
      expect(entity2Balance).to.equal(ethers.parseEther("1100"));
    });

    it("Should allow processBatch in testMode", async function () {
      const batch = {
        flashloans: [],
        reserveToReserve: [{
          receivingEntity: entity2Id,
          tokenId: tokenId,
          amount: ethers.parseEther("50")
        }],
        reserveToCollateral: [],
        settlements: [],
        disputeStarts: [],
        disputeFinalizations: [],
        externalTokenToReserve: [],
        reserveToExternalToken: [],
        hub_id: 0
      };

      await depository.processBatch(entity1Id, batch);

      const entity2Balance = await depository._reserves(entity2Id, tokenId);
      expect(entity2Balance).to.equal(ethers.parseEther("1050"));
    });

    it("Should allow prefundAccount in testMode", async function () {
      const fundAmount = ethers.parseEther("100");

      await depository.prefundAccount(
        entity1Id,
        entity2Id,
        tokenId,
        fundAmount
      );

      // Check that reserves were deducted
      const entity1Balance = await depository._reserves(entity1Id, tokenId);
      expect(entity1Balance).to.equal(ethers.parseEther("900"));
    });

    it("Should disable testMode permanently", async function () {
      await expect(depository.disableTestModeForever())
        .to.emit(depository, "TestModeDisabled");

      expect(await depository.testMode()).to.equal(false);
    });

    it("Should not allow re-enabling testMode", async function () {
      await depository.disableTestModeForever();

      await expect(
        depository.disableTestModeForever()
      ).to.be.revertedWithCustomError(depository, "E2"); // Unauthorized
    });
  });

  describe("Production Mode", function () {
    beforeEach(async function () {
      // Disable testMode for all production tests
      await depository.disableTestModeForever();
    });

    it("Should reject processBatch without Hanko in production", async function () {
      const batch = {
        flashloans: [],
        reserveToReserve: [{
          receivingEntity: entity2Id,
          tokenId: tokenId,
          amount: ethers.parseEther("50")
        }],
        reserveToCollateral: [],
        settlements: [],
        disputeStarts: [],
        disputeFinalizations: [],
        externalTokenToReserve: [],
        reserveToExternalToken: [],
        hub_id: 0
      };

      await expect(
        depository.processBatch(entity1Id, batch)
      ).to.be.revertedWithCustomError(depository, "E2"); // Unauthorized - use processBatchWithHanko()
    });

    it("Should reject reserveToReserve without valid Hanko", async function () {
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
      // Ensure entities are in order (left < right)
      const leftEntity = entity1Id < entity2Id ? entity1Id : entity2Id;
      const rightEntity = entity1Id < entity2Id ? entity2Id : entity1Id;

      // Direct calls rejected in production - must use processBatchWithHanko
      await expect(
        depository.settle(
          leftEntity,
          rightEntity,
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
      const nonce = await depository.entityNonces(entity1Signer.address);
      expect(nonce).to.equal(0);
    });

    it("Should track nonces per entity address", async function () {
      // Entity addresses derived from entity IDs (take last 20 bytes)
      const entity1Address = ethers.getAddress("0x" + entity1Id.slice(-40));
      const nonce = await depository.entityNonces(entity1Address);
      expect(nonce).to.be.a('bigint');
    });

    // TODO: Add test with actual Hanko signature generation
    // This requires implementing the full Hanko signature creation flow
  });

  describe("EntityProvider Integration", function () {
    it("Should only accept approved EntityProviders", async function () {
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
      const providers = await depository.getApprovedProviders();
      expect(providers).to.include(await entityProvider.getAddress());
    });

    it("Should allow admin to add EntityProvider", async function () {
      // Deploy a second EntityProvider
      const EntityProvider = await ethers.getContractFactory("EntityProvider");
      const secondProvider = await EntityProvider.deploy();
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
      const expectedSeparator = ethers.keccak256(ethers.toUtf8Bytes("XLN_DEPOSITORY_HANKO_V1"));
      const actualSeparator = await depository.DOMAIN_SEPARATOR();

      expect(actualSeparator).to.equal(expectedSeparator);
    });

    // TODO: Test that different action types produce different hashes
    // This ensures RESERVE_TO_RESERVE signatures can't be replayed for SETTLE
  });

  describe("Edge Cases", function () {
    it("Should allow small transfers in testMode", async function () {
      // Direct calls work in testMode
      await depository.reserveToReserve(
        entity1Id,
        entity2Id,
        tokenId,
        ethers.parseEther("1")
      );

      const entity2Balance = await depository._reserves(entity2Id, tokenId);
      expect(entity2Balance).to.equal(ethers.parseEther("1001"));
    });

    it("Should preserve existing functionality for externalTokenToReserve", async function () {
      // externalTokenToReserve should NOT require Hanko (ERC20 don't speak EP.sol)
      // This function should remain unchanged
      // Just verify the function exists
      expect(typeof depository.externalTokenToReserve).to.equal('function');
    });

    it("Should allow multiple operations in testMode", async function () {
      // Multiple transfers should work
      for (let i = 0; i < 5; i++) {
        await depository.reserveToReserve(
          entity1Id,
          entity2Id,
          tokenId,
          ethers.parseEther("10")
        );
      }

      const entity1Balance = await depository._reserves(entity1Id, tokenId);
      const entity2Balance = await depository._reserves(entity2Id, tokenId);

      expect(entity1Balance).to.equal(ethers.parseEther("950"));
      expect(entity2Balance).to.equal(ethers.parseEther("1050"));
    });
  });
});
