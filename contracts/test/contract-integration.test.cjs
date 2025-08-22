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
    it("Should start with foundation entity", async function () {
      const nextNumber = await entityProvider.nextNumber();
      expect(nextNumber).to.equal(2); // Foundation entity #1 is already created
    });

    it("Should register a numbered entity", async function () {
      const boardHash = ethers.keccak256(ethers.toUtf8Bytes("test-board"));
      
      await expect(entityProvider.registerNumberedEntity(boardHash))
        .to.emit(entityProvider, "EntityRegistered")
        .withArgs(ethers.zeroPadValue(ethers.toBeHex(2), 32), 2, boardHash); // entityId, entityNumber, boardHash

      const nextNumber = await entityProvider.nextNumber();
      expect(nextNumber).to.equal(3);

      const entityId = ethers.zeroPadValue(ethers.toBeHex(2), 32);
      const entityInfo = await entityProvider.getEntityInfo(entityId);
      expect(entityInfo[3]).to.be.gt(0); // registrationBlock is the 4th element
    });

    it("Should register multiple entities with sequential numbers", async function () {
      const boardHash1 = ethers.keccak256(ethers.toUtf8Bytes("board-1"));
      const boardHash2 = ethers.keccak256(ethers.toUtf8Bytes("board-2"));
      
      await entityProvider.registerNumberedEntity(boardHash1);
      await entityProvider.registerNumberedEntity(boardHash2);

      const nextNumber = await entityProvider.nextNumber();
      expect(nextNumber).to.equal(4);

      const entityId1 = ethers.zeroPadValue(ethers.toBeHex(2), 32);
      const entityId2 = ethers.zeroPadValue(ethers.toBeHex(3), 32);
      const entityInfo1 = await entityProvider.getEntityInfo(entityId1);
      const entityInfo2 = await entityProvider.getEntityInfo(entityId2);
      
      expect(entityInfo1[3]).to.be.gt(0); // registrationBlock is the 4th element
      expect(entityInfo2[3]).to.be.gt(0); // registrationBlock is the 4th element
    });
  });

  describe("Depository", function () {
    it("Should start with no approved providers", async function () {
      const providers = await depository.getApprovedProviders();
      expect(providers.length).to.equal(0);
    });

    it("Should allow adding and removing entity providers", async function () {
      // Add EntityProvider as approved provider
      await depository.addEntityProvider(entityProvider.target);
      
      let providers = await depository.getApprovedProviders();
      expect(providers.length).to.equal(1);
      expect(providers[0]).to.equal(entityProvider.target);

      // Remove provider
      await depository.removeEntityProvider(entityProvider.target);
      
      providers = await depository.getApprovedProviders();
      expect(providers.length).to.equal(0);
    });
  });
});
