const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Contract Integration Tests", function () {
  let entityProvider;
  let depository;
  let owner;
  let addr1;
  let addr2;

  beforeEach(async function () {
    [owner, addr1, addr2] = await ethers.getSigners();

    const EntityProvider = await ethers.getContractFactory("EntityProvider");
    entityProvider = await EntityProvider.deploy();

    const Depository = await ethers.getContractFactory("Depository");
    depository = await Depository.deploy();
  });

  describe("EntityProvider", function () {
    it("Should start with 0 entities", async function () {
      const count = await entityProvider.getEntityCount();
      expect(count).to.equal(0);
    });

    it("Should create an entity and increment count", async function () {
      const boardHash = ethers.keccak256(ethers.toUtf8Bytes("test-board"));
      
      await expect(entityProvider.createEntity(boardHash))
        .to.emit(entityProvider, "EntityCreated")
        .withArgs(1, boardHash);

      const count = await entityProvider.getEntityCount();
      expect(count).to.equal(1);

      const [retrievedBoardHash, exists] = await entityProvider.getEntity(1);
      expect(exists).to.be.true;
      expect(retrievedBoardHash).to.equal(boardHash);
    });

    it("Should create multiple entities with sequential numbers", async function () {
      const boardHash1 = ethers.keccak256(ethers.toUtf8Bytes("board-1"));
      const boardHash2 = ethers.keccak256(ethers.toUtf8Bytes("board-2"));
      
      await entityProvider.createEntity(boardHash1);
      await entityProvider.createEntity(boardHash2);

      const count = await entityProvider.getEntityCount();
      expect(count).to.equal(2);

      const [hash1, exists1] = await entityProvider.getEntity(1);
      const [hash2, exists2] = await entityProvider.getEntity(2);
      
      expect(exists1).to.be.true;
      expect(exists2).to.be.true;
      expect(hash1).to.equal(boardHash1);
      expect(hash2).to.equal(boardHash2);
    });
  });

  describe("Depository", function () {
    it("Should start with 0 balance for any account", async function () {
      const balance = await depository.getBalance(ethers.ZeroAddress, owner.address);
      expect(balance).to.equal(0);
    });

    it("Should allow deposits and withdrawals", async function () {
      const amount = ethers.parseEther("1.0");
      
      // Deposit
      await depository.deposit(ethers.ZeroAddress, { value: amount });
      
      let balance = await depository.getBalance(ethers.ZeroAddress, owner.address);
      expect(balance).to.equal(amount);

      // Withdraw
      await depository.withdraw(ethers.ZeroAddress, amount);
      
      balance = await depository.getBalance(ethers.ZeroAddress, owner.address);
      expect(balance).to.equal(0);
    });
  });
});
