const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("EntityProvider Governance Tests", function () {
  let entityProvider;
  let owner, alice, bob, carol, foundation;
  let foundationEntityId;

  beforeEach(async function () {
    [owner, alice, bob, carol, foundation] = await ethers.getSigners();
    
    // Deploy EntityProvider
    const EntityProvider = await ethers.getContractFactory("EntityProvider");
    entityProvider = await EntityProvider.deploy();
    await entityProvider.waitForDeployment();
    
    foundationEntityId = await entityProvider.FOUNDATION_ENTITY();
  });

  describe("Basic functionality", function () {
    it("Should deploy with foundation entity #1", async function () {
      expect(foundationEntityId).to.equal(1);
      
      const entity = await entityProvider.entities(ethers.zeroPadValue(ethers.toBeHex(1), 32));
      expect(entity.exists).to.be.true;
      expect(entity.registrationBlock).to.be.gt(0);
    });

    it("Should register new numbered entity", async function () {
      const boardHash = ethers.keccak256(ethers.toUtf8Bytes("test_board"));
      
      const tx = await entityProvider.registerNumberedEntity(boardHash);
      const receipt = await tx.wait();
      
      // Should emit EntityRegistered event
      const event = receipt.logs.find(log => log.fragment?.name === 'EntityRegistered');
      expect(event).to.not.be.undefined;
      
      // Next entity should be #2
      const nextNumber = await entityProvider.nextNumber();
      expect(nextNumber).to.equal(3);
    });
  });

  describe("Token ID generation", function () {
    it("Should generate correct token IDs using first bit flip", async function () {
      const entityNumber = 42;
      const [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(entityNumber);
      
      // Control token should be original entity number
      expect(controlTokenId).to.equal(entityNumber);
      
      // Dividend token should have first bit set (entityNumber | 0x8000000000000000000000000000000000000000000000000000000000000000)
      const expectedDividendId = BigInt(entityNumber) | (BigInt(1) << BigInt(255));
      expect(dividendTokenId).to.equal(expectedDividendId);
    });

    it("Should extract entity number from token ID", async function () {
      const originalEntityNumber = 123;
      const [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(originalEntityNumber);
      
      // Should extract correct entity number from both token types
      expect(await entityProvider.getEntityFromToken(controlTokenId)).to.equal(originalEntityNumber);
      expect(await entityProvider.getEntityFromToken(dividendTokenId)).to.equal(originalEntityNumber);
    });
  });

  describe("Governance setup", function () {
    let entityNumber;
    let entityId;

    beforeEach(async function () {
      const boardHash = ethers.keccak256(ethers.toUtf8Bytes("test_board"));
      const tx = await entityProvider.registerNumberedEntity(boardHash);
      await tx.wait();
      
      entityNumber = 2; // Should be the second entity after foundation
      entityId = ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32);
    });

    it("Should setup governance with control and dividend tokens", async function () {
      const holders = [alice.address, bob.address];
      const controlAmounts = [1000, 500]; // Alice 66.7%, Bob 33.3%
      const dividendAmounts = [200, 800]; // Alice 20%, Bob 80%
      
      const articles = {
        controlDelay: 1000,
        dividendDelay: 3000, 
        foundationDelay: 10000,
        controlThreshold: 51
      };

      const tx = await entityProvider.setupGovernance(
        entityNumber,
        holders,
        controlAmounts,
        dividendAmounts,
        articles
      );
      await tx.wait();

      // Check balances
      const [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(entityNumber);
      
      expect(await entityProvider.balanceOf(alice.address, controlTokenId)).to.equal(1000);
      expect(await entityProvider.balanceOf(bob.address, controlTokenId)).to.equal(500);
      expect(await entityProvider.balanceOf(alice.address, dividendTokenId)).to.equal(200);
      expect(await entityProvider.balanceOf(bob.address, dividendTokenId)).to.equal(800);

      // Check total supplies
      expect(await entityProvider.totalControlSupply(entityId)).to.equal(1500);
      expect(await entityProvider.totalDividendSupply(entityId)).to.equal(1000);
    });

    it("Should track governance info correctly", async function () {
      const holders = [alice.address];
      const controlAmounts = [1000];
      const dividendAmounts = [500];
      
      const articles = {
        controlDelay: 2000,
        dividendDelay: 6000,
        foundationDelay: 20000, 
        controlThreshold: 67
      };

      await entityProvider.setupGovernance(
        entityNumber,
        holders,
        controlAmounts,
        dividendAmounts,
        articles
      );

      const [controlTokenId, dividendTokenId, controlSupply, dividendSupply, hasActiveProposal, articlesHash] = 
        await entityProvider.getGovernanceInfo(entityNumber);
      
      expect(controlTokenId).to.equal(entityNumber);
      expect(controlSupply).to.equal(1000);
      expect(dividendSupply).to.equal(500);
      expect(hasActiveProposal).to.be.false;
    });
  });

  describe("ERC1155 compatibility", function () {
    let entityNumber;
    let controlTokenId, dividendTokenId;

    beforeEach(async function () {
      const boardHash = ethers.keccak256(ethers.toUtf8Bytes("test_board"));
      await entityProvider.registerNumberedEntity(boardHash);
      entityNumber = 2;

      const holders = [alice.address, bob.address];
      const controlAmounts = [1000, 500];
      const dividendAmounts = [200, 800];
      
      const articles = {
        controlDelay: 1000,
        dividendDelay: 3000,
        foundationDelay: 10000,
        controlThreshold: 51
      };

      await entityProvider.setupGovernance(
        entityNumber,
        holders, 
        controlAmounts,
        dividendAmounts,
        articles
      );

      [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(entityNumber);
    });

    it("Should support ERC1155 transfers", async function () {
      // Transfer control tokens from Alice to Carol
      await entityProvider.connect(alice).safeTransferFrom(
        alice.address,
        carol.address,
        controlTokenId,
        100,
        "0x"
      );

      expect(await entityProvider.balanceOf(alice.address, controlTokenId)).to.equal(900);
      expect(await entityProvider.balanceOf(carol.address, controlTokenId)).to.equal(100);
    });

    it("Should support ERC1155 batch transfers", async function () {
      const ids = [controlTokenId, dividendTokenId];
      const amounts = [50, 25];

      await entityProvider.connect(alice).safeBatchTransferFrom(
        alice.address,
        carol.address,
        ids,
        amounts,
        "0x"
      );

      expect(await entityProvider.balanceOf(alice.address, controlTokenId)).to.equal(950);
      expect(await entityProvider.balanceOf(alice.address, dividendTokenId)).to.equal(175);
      expect(await entityProvider.balanceOf(carol.address, controlTokenId)).to.equal(50);
      expect(await entityProvider.balanceOf(carol.address, dividendTokenId)).to.equal(25);
    });

    it("Should support ERC1155 approvals", async function () {
      await entityProvider.connect(alice).setApprovalForAll(bob.address, true);
      expect(await entityProvider.isApprovedForAll(alice.address, bob.address)).to.be.true;

      // Bob can now transfer Alice's tokens
      await entityProvider.connect(bob).safeTransferFrom(
        alice.address,
        carol.address,
        controlTokenId,
        200,
        "0x"
      );

      expect(await entityProvider.balanceOf(alice.address, controlTokenId)).to.equal(800);
      expect(await entityProvider.balanceOf(carol.address, controlTokenId)).to.equal(200);
    });
  });

  describe("Integration with entity management", function () {
    it("Should maintain entity functionality alongside governance", async function () {
      // Register entity
      const boardHash = ethers.keccak256(ethers.toUtf8Bytes("integration_test"));
      await entityProvider.registerNumberedEntity(boardHash);
      const entityNumber = 2;

      // Setup governance
      await entityProvider.setupGovernance(
        entityNumber,
        [alice.address],
        [1000],
        [500],
        { controlDelay: 1000, dividendDelay: 3000, foundationDelay: 10000, controlThreshold: 51 }
      );

      // Check that entity still exists and has governance
      const entityId = ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32);
      const entity = await entityProvider.entities(entityId);
      
      expect(entity.exists).to.be.true;
      expect(entity.currentBoardHash).to.equal(boardHash);
      expect(entity.articlesHash).to.not.equal(ethers.ZeroHash);
    });
  });
}); 