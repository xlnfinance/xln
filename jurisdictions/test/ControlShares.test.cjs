/**
 * Comprehensive tests for Entity Control-Shares functionality
 * Tests the complete flow: Entity registration -> Share release -> Depository integration -> Reserve transfers
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Entity Control-Shares System", function () {
  let entityProvider;
  let depository;
  let owner, entity1, entity2, investor1, investor2;
  let boardHash1, boardHash2;

  // Mock board and signature data for testing
  const mockBoard = {
    votingThreshold: 51,
    entityIds: [],
    votingPowers: [],
    boardChangeDelay: 1000,
    controlChangeDelay: 2000,
    dividendChangeDelay: 3000
  };

  const mockSignature = "0x" + "00".repeat(65); // Mock signature

  beforeEach(async function () {
    [owner, entity1, entity2, investor1, investor2] = await ethers.getSigners();

    // Deploy EntityProvider
    const EntityProviderFactory = await ethers.getContractFactory("EntityProvider");
    entityProvider = await EntityProviderFactory.deploy();
    await entityProvider.waitForDeployment();

    // Deploy Account library first
    const AccountFactory = await ethers.getContractFactory("Account");
    const account = await AccountFactory.deploy();
    await account.waitForDeployment();

    // Deploy Depository with Account library linked
    const DepositoryFactory = await ethers.getContractFactory("Depository", {
      libraries: {
        Account: await account.getAddress()
      }
    });
    depository = await DepositoryFactory.deploy(await entityProvider.getAddress());
    await depository.waitForDeployment();

    // Create mock board hashes
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    boardHash1 = ethers.keccak256(abiCoder.encode(
      ["tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)"],
      [[
        mockBoard.votingThreshold,
        [ethers.zeroPadValue(entity1.address, 32)],
        [100],
        mockBoard.boardChangeDelay,
        mockBoard.controlChangeDelay,
        mockBoard.dividendChangeDelay
      ]]
    ));

    boardHash2 = ethers.keccak256(abiCoder.encode(
      ["tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)"],
      [[
        mockBoard.votingThreshold,
        [ethers.zeroPadValue(entity2.address, 32)],
        [100],
        mockBoard.boardChangeDelay,
        mockBoard.controlChangeDelay,
        mockBoard.dividendChangeDelay
      ]]
    ));
  });

  describe("Entity Registration with Automatic Governance", function () {
    it("Should register entity with control and dividend tokens", async function () {
      // Register entity
      const tx = await entityProvider.registerNumberedEntity(boardHash1);
      const receipt = await tx.wait();

      // Check EntityRegistered event
      const entityRegisteredEvent = receipt.logs.find(log => {
        try {
          const parsed = entityProvider.interface.parseLog(log);
          return parsed.name === 'EntityRegistered';
        } catch {
          return false;
        }
      });
      
      expect(entityRegisteredEvent).to.not.be.undefined;
      const parsedEvent = entityProvider.interface.parseLog(entityRegisteredEvent);
      const entityNumber = parsedEvent.args.entityNumber;
      expect(entityNumber).to.equal(2); // Foundation is #1, first user entity is #2

      // Verify token IDs
      const [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(entityNumber);
      expect(controlTokenId).to.equal(entityNumber);

      // Verify entity owns all tokens initially
      const entityAddress = ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 20));
      const controlBalance = await entityProvider.balanceOf(entityAddress, controlTokenId);
      const dividendBalance = await entityProvider.balanceOf(entityAddress, dividendTokenId);

      expect(controlBalance).to.equal(BigInt("1000000000000000")); // 1e15  
      expect(dividendBalance).to.equal(BigInt("1000000000000000")); // 1e15
    });

    it("Should track governance info correctly", async function () {
      // Register entity
      await entityProvider.registerNumberedEntity(boardHash1);
      
      const govInfo = await entityProvider.getGovernanceInfo(2);
      expect(govInfo.controlTokenId).to.equal(2);
      expect(govInfo.controlSupply).to.equal(BigInt("1000000000000000"));
      expect(govInfo.dividendSupply).to.equal(BigInt("1000000000000000"));
      expect(govInfo.hasActiveProposal).to.be.false;
    });
  });

  describe("Control Shares Release", function () {
    let entityNumber;

    beforeEach(async function () {
      // Register an entity first
      const tx = await entityProvider.registerNumberedEntity(boardHash1);
      const receipt = await tx.wait();
      const entityRegisteredEvent = receipt.logs.find(log => {
        try {
          const parsed = entityProvider.interface.parseLog(log);
          return parsed.name === 'EntityRegistered';
        } catch {
          return false;
        }
      });
      const parsedEvent = entityProvider.interface.parseLog(entityRegisteredEvent);
      entityNumber = parsedEvent.args.entityNumber;

    });

    it("Should reject release without valid signature", async function () {
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const encodedBoard = abiCoder.encode(
        ["tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)"],
        [[
          mockBoard.votingThreshold,
          [ethers.zeroPadValue(entity1.address, 32)],
          [100],
          mockBoard.boardChangeDelay,
          mockBoard.controlChangeDelay,
          mockBoard.dividendChangeDelay
        ]]
      );

      await expect(
        entityProvider.releaseControlShares(
          entityNumber,
          await depository.getAddress(),
          BigInt("1000000000000000"), // 1M control tokens
          0, // No dividend tokens
          "Series A Funding",
          encodedBoard,
          mockSignature
        )
      ).to.be.revertedWith("Invalid entity signature");
    });

    it("Should reject release with zero amounts", async function () {
      await expect(
        entityProvider.releaseControlShares(
          entityNumber,
          await depository.getAddress(),
          0, // No control tokens
          0, // No dividend tokens
          "Invalid Release",
          "0x",
          "0x"
        )
      ).to.be.revertedWith("Must release some tokens");
    });

    it("Should reject release to zero address", async function () {
      await expect(
        entityProvider.releaseControlShares(
          entityNumber,
          ethers.ZeroAddress,
          BigInt("1000000000000000"),
          0,
          "Invalid Release",
          "0x",
          "0x"
        )
      ).to.be.revertedWith("Invalid depository address");
    });

    it("Should reject release for non-existent entity", async function () {
      await expect(
        entityProvider.releaseControlShares(
          999, // Non-existent entity
          await depository.getAddress(),
          BigInt("1000000000000000"),
          0,
          "Invalid Release",
          "0x",
          "0x"
        )
      ).to.be.revertedWith("Entity doesn't exist");
    });
  });

});
