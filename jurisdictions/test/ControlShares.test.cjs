/**
 * Comprehensive tests for Entity Control-Shares functionality
 * Tests the complete flow: Entity registration -> Share release -> Depository integration -> Reserve transfers
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe.skip("Entity Control-Shares System", function () {
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

  // Helper function to simulate entity transfers (simulates Hanko authorization)
  async function simulateEntityTransfer(entityAddress, tokenId, amount, data = "0x") {
    await ethers.provider.send("hardhat_impersonateAccount", [entityAddress]);
    const entitySigner = await ethers.getSigner(entityAddress);
    
    // Fund the entity address with some ETH for gas
    await entity1.sendTransaction({
      to: entityAddress,
      value: ethers.parseEther("1.0")
    });

    const tx = await entityProvider.connect(entitySigner).safeTransferFrom(
      entityAddress,
      await depository.getAddress(),
      tokenId,
      amount,
      data
    );

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [entityAddress]);
    return tx;
  }

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
    let entityNumber, controlTokenId, dividendTokenId, entityAddress;

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

      [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(entityNumber);
      entityAddress = ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 20));
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

  describe("Depository Integration", function () {
    let entityNumber, controlTokenId, dividendTokenId, entityAddress;

    beforeEach(async function () {
      // Register an entity
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

      [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(entityNumber);
      entityAddress = ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 20));
    });

    it("Should handle direct ERC1155 transfer to depository", async function () {
      const transferAmount = BigInt("1000000000000000"); // 1M tokens

      // Simulate entity transfer (in reality via Hanko signatures)
      await simulateEntityTransfer(
        entityAddress,
        controlTokenId,
        transferAmount,
        ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["Series A Funding"])
      );

      // Check that depository received the tokens in reserves
      const internalTokenId = await depository.getControlShareTokenId(await entityProvider.getAddress(), controlTokenId);
      expect(internalTokenId).to.be.gt(0);

      const reserves = await depository._reserves(entityAddress, internalTokenId);
      expect(reserves).to.equal(transferAmount);
    });

    it("Should emit ControlSharesReceived event", async function () {
      const transferAmount = BigInt("500000000000000");

      const tx = await simulateEntityTransfer(
        entityAddress,
        controlTokenId,
        transferAmount,
        ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["Employee Pool"])
      );

      // Check for ControlSharesReceived event
      await expect(tx).to.emit(depository, 'ControlSharesReceived');
    });

    it("Should create internal token ID efficiently", async function () {
      // First transfer should create new internal token ID
      await simulateEntityTransfer(
        entityAddress,
        controlTokenId,
        BigInt("100000000000000"),
        "0x"
      );

      const internalTokenId1 = await depository.getControlShareTokenId(await entityProvider.getAddress(), controlTokenId);
      expect(internalTokenId1).to.be.gt(0);

      // Second transfer should reuse the same internal token ID
      await simulateEntityTransfer(
        entityAddress,
        controlTokenId,
        BigInt("100000000000000"),
        "0x"
      );

      const internalTokenId2 = await depository.getControlShareTokenId(await entityProvider.getAddress(), controlTokenId);
      expect(internalTokenId2).to.equal(internalTokenId1);

      // Check total reserves
      const totalReserves = await depository._reserves(entityAddress, internalTokenId1);
      expect(totalReserves).to.equal(BigInt("200000000000000"));
    });
  });

  describe("Reserve Transfers", function () {
    let entityNumber1, entityNumber2;
    let controlTokenId1, controlTokenId2;
    let entityAddress1, entityAddress2;
    let internalTokenId;

    beforeEach(async function () {
      // Register two entities
      const tx1 = await entityProvider.registerNumberedEntity(boardHash1);
      const receipt1 = await tx1.wait();
      const event1 = receipt1.logs.find(log => {
        try {
          const parsed = entityProvider.interface.parseLog(log);
          return parsed.name === 'EntityRegistered';
        } catch {
          return false;
        }
      });
      entityNumber1 = entityProvider.interface.parseLog(event1).args.entityNumber;

      const tx2 = await entityProvider.registerNumberedEntity(boardHash2);
      const receipt2 = await tx2.wait();
      const event2 = receipt2.logs.find(log => {
        try {
          const parsed = entityProvider.interface.parseLog(log);
          return parsed.name === 'EntityRegistered';
        } catch {
          return false;
        }
      });
      entityNumber2 = entityProvider.interface.parseLog(event2).args.entityNumber;

      [controlTokenId1] = await entityProvider.getTokenIds(entityNumber1);
      [controlTokenId2] = await entityProvider.getTokenIds(entityNumber2);

      entityAddress1 = ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(entityNumber1), 20));
      entityAddress2 = ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(entityNumber2), 20));

      // Transfer some control tokens to depository for entity1
      await simulateEntityTransfer(
        entityAddress1,
        controlTokenId1,
        BigInt("1000000000000000"),
        "0x"
      );

      internalTokenId = await depository.getControlShareTokenId(await entityProvider.getAddress(), controlTokenId1);
    });

    it("Should transfer control shares between entities using transferControlShares", async function () {
      const transferAmount = BigInt("250000000000000");

      // Check initial balances
      const initialBalance1 = await depository._reserves(entityAddress1, internalTokenId);
      const initialBalance2 = await depository._reserves(entityAddress2, internalTokenId);

      expect(initialBalance1).to.equal(BigInt("1000000000000000"));
      expect(initialBalance2).to.equal(0);

      // Transfer from entityAddress1 to entityAddress2 (need to impersonate the entity)
      await ethers.provider.send("hardhat_impersonateAccount", [entityAddress1]);
      const entitySigner1 = await ethers.getSigner(entityAddress1);
      
      await depository.connect(entitySigner1).transferControlShares(
        entityAddress2,
        internalTokenId,
        transferAmount,
        "Investment Purchase"
      );
      
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [entityAddress1]);

      // Check final balances
      const finalBalance1 = await depository._reserves(entityAddress1, internalTokenId);
      const finalBalance2 = await depository._reserves(entityAddress2, internalTokenId);

      expect(finalBalance1).to.equal(BigInt("750000000000000"));
      expect(finalBalance2).to.equal(transferAmount);
    });

    it("Should emit ControlSharesTransferred event", async function () {
      const transferAmount = BigInt("100000000000000");

      await ethers.provider.send("hardhat_impersonateAccount", [entityAddress1]);
      const entitySigner1 = await ethers.getSigner(entityAddress1);
      
      await expect(
        depository.connect(entitySigner1).transferControlShares(
          entityAddress2,
          internalTokenId,
          transferAmount,
          "Strategic Partnership"
        )
      ).to.emit(depository, 'ControlSharesTransferred')
       .withArgs(entityAddress1, entityAddress2, internalTokenId, transferAmount, "Strategic Partnership");
       
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [entityAddress1]);
    });

    it("Should reject transfer with insufficient balance", async function () {
      const excessiveAmount = BigInt("2000000000000000"); // More than available

      await ethers.provider.send("hardhat_impersonateAccount", [entityAddress1]);
      const entitySigner1 = await ethers.getSigner(entityAddress1);
      
      await expect(
        depository.connect(entitySigner1).transferControlShares(
          entityAddress2,
          internalTokenId,
          excessiveAmount,
          "Invalid Transfer"
        )
      ).to.be.revertedWith("Insufficient control shares");
      
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [entityAddress1]);
    });

    it("Should reject transfer to zero address", async function () {
      await ethers.provider.send("hardhat_impersonateAccount", [entityAddress1]);
      const entitySigner1 = await ethers.getSigner(entityAddress1);
      
      await expect(
        depository.connect(entitySigner1).transferControlShares(
          ethers.ZeroAddress,
          internalTokenId,
          BigInt("100000000000000"),
          "Invalid Transfer"
        )
      ).to.be.revertedWith("Invalid recipient");
      
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [entityAddress1]);
    });

    it("Should reject transfer to self", async function () {
      await ethers.provider.send("hardhat_impersonateAccount", [entityAddress1]);
      const entitySigner1 = await ethers.getSigner(entityAddress1);
      
      await expect(
        depository.connect(entitySigner1).transferControlShares(
          entityAddress1,
          internalTokenId,
          BigInt("100000000000000"),
          "Invalid Transfer"
        )
      ).to.be.revertedWith("Cannot transfer to self");
      
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [entityAddress1]);
    });
  });

  describe("Token Lookup Performance", function () {
    it("Should use O(1) lookup for existing tokens", async function () {
      // Register entity and transfer tokens
      const tx = await entityProvider.registerNumberedEntity(boardHash1);
      const receipt = await tx.wait();
      const event = receipt.logs.find(log => {
        try {
          const parsed = entityProvider.interface.parseLog(log);
          return parsed.name === 'EntityRegistered';
        } catch {
          return false;
        }
      });
      const entityNumber = entityProvider.interface.parseLog(event).args.entityNumber;
      const [controlTokenId] = await entityProvider.getTokenIds(entityNumber);
      const entityAddress = ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 20));

      // First transfer creates the token mapping
      await simulateEntityTransfer(
        entityAddress,
        controlTokenId,
        BigInt("100000000000000"),
        "0x"
      );

      const internalTokenId = await depository.getControlShareTokenId(await entityProvider.getAddress(), controlTokenId);
      expect(internalTokenId).to.be.gt(0);

      // Subsequent lookups should be O(1)
      const internalTokenId2 = await depository.getControlShareTokenId(await entityProvider.getAddress(), controlTokenId);
      expect(internalTokenId2).to.equal(internalTokenId);

      // Transfer again to test the performance path
      await simulateEntityTransfer(
        entityAddress,
        controlTokenId,
        BigInt("50000000000000"),
        "0x"
      );

      // Total should be accumulated correctly
      const totalReserves = await depository._reserves(entityAddress, internalTokenId);
      expect(totalReserves).to.equal(BigInt("150000000000000"));
    });
  });

  describe("Real-World Scenarios", function () {
    it("Should simulate Series A funding round", async function () {
      // Register company entity
      const companyTx = await entityProvider.registerNumberedEntity(boardHash1);
      const companyReceipt = await companyTx.wait();
      const event = companyReceipt.logs.find(log => {
        try {
          const parsed = entityProvider.interface.parseLog(log);
          return parsed.name === 'EntityRegistered';
        } catch {
          return false;
        }
      });
      const companyNumber = entityProvider.interface.parseLog(event).args.entityNumber;
      const [controlTokenId] = await entityProvider.getTokenIds(companyNumber);
      const companyAddress = ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(companyNumber), 20));

      // Company releases 20% of control tokens for Series A (200M out of 1000M)  
      const seriesAAmount = BigInt("200000000000000"); // 200M tokens

      await simulateEntityTransfer(
        companyAddress,
        controlTokenId,
        seriesAAmount,
        ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["Series A Funding Round"])
      );

      // Verify company retains 80% in treasury
      const remainingBalance = await entityProvider.balanceOf(companyAddress, controlTokenId);
      expect(remainingBalance).to.equal(BigInt("800000000000000")); // 800M tokens

      // Verify depository holds the released shares
      const internalTokenId = await depository.getControlShareTokenId(await entityProvider.getAddress(), controlTokenId);
      const depositoryReserves = await depository._reserves(companyAddress, internalTokenId);
      expect(depositoryReserves).to.equal(seriesAAmount);
    });
  });
});
