/**
 * Comprehensive tests for Entity Control-Shares functionality
 * Tests the complete flow: Entity registration -> Share release -> Depository integration -> Reserve transfers
 */

import { expect } from "chai";
import hre from "hardhat";
const { ethers } = await hre.network.getOrCreate("hardhat");

// Redesign: shares are minted to the namespaced treasury, never to address(uint160(N)).
const ENTITY_TREASURY_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes("XLN_ENTITY_TREASURY_V1"));
const entityTreasury = (entityNumber) => ethers.getAddress(ethers.dataSlice(ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [ENTITY_TREASURY_DOMAIN, entityNumber]),
), 12));

async function entityProviderFactory() {
  const HankoVerifier = await ethers.getContractFactory("HankoVerifier");
  const verifier = await HankoVerifier.deploy();
  await verifier.waitForDeployment();
  return ethers.getContractFactory("EntityProvider", {
    libraries: { HankoVerifier: await verifier.getAddress() },
  });
}

describe("Entity Control-Shares System", function () {
  let entityProvider;
  let depository;
  let owner, entity1, entity2, investor1, investor2;
  let encodedBoard1, encodedBoard2;
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

  const mockHanko = ethers.AbiCoder.defaultAbiCoder().encode(
    ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[],bytes[])'],
    [[[], `0x${'00'.repeat(65)}`, [[ethers.ZeroHash, [0], [1], 1, 0, 0, 0]], []]],
  );

  beforeEach(async function () {
    [owner, entity1, entity2, investor1, investor2] = await ethers.getSigners();

    // Deploy EntityProvider
    const EntityProviderFactory = await entityProviderFactory();
    entityProvider = await EntityProviderFactory.deploy(owner.address);
    await entityProvider.waitForDeployment();

    // Deploy the exact production library graph. A reduced test-only graph can
    // hide missing link references or a non-canonical Pull authorization root.
    const AccountFactory = await ethers.getContractFactory("Account");
    const account = await AccountFactory.deploy();
    await account.waitForDeployment();

    const BoundsFactory = await ethers.getContractFactory("DepositoryBounds");
    const bounds = await BoundsFactory.deploy();
    await bounds.waitForDeployment();

    const RegistryFactory = await ethers.getContractFactory("HashLadderRegistry");
    const registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const NftCustodyFactory = await ethers.getContractFactory("NftCustody");
    const nftCustody = await NftCustodyFactory.deploy();
    await nftCustody.waitForDeployment();

    const TransformerFactory = await ethers.getContractFactory("DeltaTransformer");
    const transformer = await TransformerFactory.deploy();
    await transformer.waitForDeployment();

    // Deploy Depository with Account library linked
    const DepositoryFactory = await ethers.getContractFactory("Depository", {
      libraries: {
        Account: await account.getAddress(),
        DepositoryBounds: await bounds.getAddress(),
        HashLadderRegistry: await registry.getAddress(),
        NftCustody: await nftCustody.getAddress()
      }
    });
    depository = await DepositoryFactory.deploy(
      await entityProvider.getAddress(),
      await transformer.getAddress(),
    );
    await depository.waitForDeployment();
    await entityProvider.bindShareDepository(await depository.getAddress());

    // Create mock board hashes
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    // registerNumberedEntity takes the abi-encoded Board preimage (validated on chain).
    encodedBoard1 = abiCoder.encode(
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
    boardHash1 = ethers.keccak256(encodedBoard1);

    encodedBoard2 = abiCoder.encode(
      ["tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)"],
      [[
        mockBoard.votingThreshold,
        [ethers.zeroPadValue(entity2.address, 32)],
        [100],
        mockBoard.boardChangeDelay,
        mockBoard.controlChangeDelay,
        mockBoard.dividendChangeDelay
      ]]
    );
    boardHash2 = ethers.keccak256(encodedBoard2);
  });

  describe("Entity Registration with Automatic Governance", function () {
    it("Should register entity with control and dividend tokens", async function () {
      // Register entity
      const tx = await entityProvider.registerNumberedEntity(encodedBoard1);
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

      // Verify the entity treasury owns all tokens initially
      const entityAddress = entityTreasury(entityNumber);
      expect(await entityProvider.balanceOf(ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 20)), controlTokenId)).to.equal(0n);
      const controlBalance = await entityProvider.balanceOf(entityAddress, controlTokenId);
      const dividendBalance = await entityProvider.balanceOf(entityAddress, dividendTokenId);

      expect(controlBalance).to.equal(100_000_000_000n);
      expect(dividendBalance).to.equal(100_000_000_000n);
    });

    it("Should track governance info correctly", async function () {
      // Register entity
      await entityProvider.registerNumberedEntity(encodedBoard1);
      const entityNumber = 2n;
      const [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(entityNumber);
      const entityAddress = entityTreasury(entityNumber);
      const entity = await entityProvider.entities(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32));

      expect(controlTokenId).to.equal(entityNumber);
      expect(await entityProvider.balanceOf(entityAddress, controlTokenId)).to.equal(100_000_000_000n);
      expect(await entityProvider.balanceOf(entityAddress, dividendTokenId)).to.equal(100_000_000_000n);
      expect(entity.proposedBoardHash).to.equal(ethers.ZeroHash);
    });
  });

  describe("Control Shares Release", function () {
    let entityNumber;

    beforeEach(async function () {
      // Register an entity first
      const tx = await entityProvider.registerNumberedEntity(encodedBoard1);
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
      await expect(
        entityProvider.releaseControlShares(
          entityNumber,
          await depository.getAddress(),
          BigInt("1000000000000000"), // 1M control tokens
          0, // No dividend tokens
          "Series A Funding",
          mockHanko,
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
          "0x"
        )
      ).to.be.revertedWithCustomError(entityProvider, "ShareDepositoryRequired");
    });

    it("Should reject release for non-existent entity", async function () {
      await expect(
        entityProvider.releaseControlShares(
          999, // Non-existent entity
          await depository.getAddress(),
          BigInt("1000000000000000"),
          0,
          "Invalid Release",
          "0x"
        )
      ).to.be.revertedWith("Entity doesn't exist");
    });
  });

});
