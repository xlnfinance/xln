const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("EntityProvider with Automatic Governance", function () {
  let entityProvider;
  let owner, alice, bob, carol;
  let foundationEntityId;

  function singleSignerBoardHash(address) {
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)"],
      [[
        1,
        [ethers.zeroPadValue(address, 32)],
        [1],
        0,
        0,
        0
      ]]
    ));
  }

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();
    
    // Deploy EntityProvider
    const EntityProvider = await ethers.getContractFactory("EntityProvider");
    entityProvider = await EntityProvider.deploy(owner.address);
    await entityProvider.waitForDeployment();
    
    foundationEntityId = await entityProvider.FOUNDATION_ENTITY();
  });

  describe("Foundation Setup", function () {
    it("rejects a zero foundation recipient", async function () {
      const EntityProvider = await ethers.getContractFactory("EntityProvider");
      await expect(EntityProvider.deploy(ethers.ZeroAddress)).to.be.revertedWith("Invalid foundation recipient");
    });

    it("Should deploy with foundation entity #1 with governance", async function () {
      expect(foundationEntityId).to.equal(1);
      
      const entity = await entityProvider.entities(ethers.zeroPadValue(ethers.toBeHex(1), 32));
      expect(entity.currentBoardHash).to.equal(singleSignerBoardHash(owner.address));
      expect(entity.registrationBlock).to.be.gt(0);
      expect(entity.articles.controlDelay).to.equal(1000);
      
      // Check foundation governance tokens are controlled by a real deploy-time recipient.
      const [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(1);
      const expectedSupply = 100_000_000_000n;
      
      expect(await entityProvider.balanceOf(owner.address, controlTokenId)).to.equal(expectedSupply);
      expect(await entityProvider.balanceOf(owner.address, dividendTokenId)).to.equal(expectedSupply);
    });

    it("Should allow foundation token holders to use foundation functions", async function () {
      // Owner has foundation tokens directly from constructor bootstrap.
      const [foundationControlTokenId] = await entityProvider.getTokenIds(1);
      expect(await entityProvider.balanceOf(owner.address, foundationControlTokenId)).to.equal(100_000_000_000n);
      
      // Should be able to assign names
      const boardHash = ethers.keccak256(ethers.toUtf8Bytes("test_board"));
      await entityProvider.registerNumberedEntity(boardHash);
      
      await expect(entityProvider.connect(owner).assignName("testname", 2)).to.not.be.reverted;
    });
  });

  describe("Automatic Entity Registration", function () {
    it("Should register new numbered entity with automatic governance", async function () {
      const boardHash = ethers.keccak256(ethers.toUtf8Bytes("test_board"));
      
      const tx = await entityProvider.registerNumberedEntity(boardHash);
      const receipt = await tx.wait();
      
      // Check for events
      const registeredEvent = receipt.logs.some(log => entityProvider.interface.parseLog(log)?.name === 'EntityRegistered');
      const governanceEvent = receipt.logs.some(log => entityProvider.interface.parseLog(log)?.name === 'GovernanceEnabled');
      expect(registeredEvent).to.be.true;
      expect(governanceEvent).to.be.true;
      
      // Next entity should be #2 (foundation is #1)
      const entityNumber = 2;
      
      // Check entity has governance auto-setup
      const entityId = ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32);
      const entity = await entityProvider.entities(entityId);
      expect(entity.currentBoardHash).to.equal(boardHash);
      expect(entity.articles.controlDelay).to.equal(1000);
      
      // Check governance tokens were created with fixed supply
      const [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(entityNumber);
      const entityAddress = ethers.getAddress(`0x${entityNumber.toString(16).padStart(40, '0')}`);
      const expectedSupply = 100_000_000_000n;
      
      expect(await entityProvider.balanceOf(entityAddress, controlTokenId)).to.equal(expectedSupply);
      expect(await entityProvider.balanceOf(entityAddress, dividendTokenId)).to.equal(expectedSupply);
    });

    it("Should allow foundation to create entity with custom governance", async function () {
      const boardHash = ethers.keccak256(ethers.toUtf8Bytes("custom_board"));
      const customArticles = {
        controlDelay: 500,
        dividendDelay: 1500,
        foundationDelay: 5000
      };
      
      await expect(entityProvider.connect(owner).foundationRegisterEntity(boardHash, customArticles)).to.not.be.reverted;
      
      const entityNumber = 2;
      const entityId = ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32);
      const entity = await entityProvider.entities(entityId);
      expect(entity.currentBoardHash).to.equal(boardHash);
      expect(entity.articles).to.deep.equal([
        500n,
        1500n,
        5000n,
      ]);
    });
  });

  describe("Token ID System", function () {
    it("Should generate correct token IDs using first bit flip", async function () {
      const entityNumber = 42;
      const [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(entityNumber);
      
      expect(controlTokenId).to.equal(entityNumber);
      // 255th bit flip
      expect(dividendTokenId).to.equal(BigInt(entityNumber) | (BigInt(1) << BigInt(255)));
      
      // Should be able to extract entity number from both token IDs
      expect(await entityProvider.getEntityFromToken(controlTokenId)).to.equal(entityNumber);
      expect(await entityProvider.getEntityFromToken(dividendTokenId)).to.equal(entityNumber);
    });
  });

  describe("ERC1155 Token Transfers", function () {
    let entityNumber;
    let controlTokenId, dividendTokenId;

    beforeEach(async function () {
      const boardHash = ethers.keccak256(ethers.toUtf8Bytes("test_board"));
      await entityProvider.registerNumberedEntity(boardHash);
      entityNumber = 2;

      [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(entityNumber);
      
      // Note: In real usage, tokens would be distributed via Depository.sol using entity hanko signatures
      // For testing, we'll just verify tokens exist in entity address
      const entityAddress = ethers.getAddress(`0x${entityNumber.toString(16).padStart(40, '0')}`);
      const expectedSupply = 100_000_000_000n;
      
      expect(await entityProvider.balanceOf(entityAddress, controlTokenId)).to.equal(expectedSupply);
      expect(await entityProvider.balanceOf(entityAddress, dividendTokenId)).to.equal(expectedSupply);
      
      // For testing transfers, we'll manually transfer some tokens to test accounts
      // In production, this would be done via entityTransferTokens() with proper hanko signatures
      const foundationAddress = ethers.getAddress(`0x${(1).toString(16).padStart(40, '0')}`);
      await ethers.provider.send("hardhat_impersonateAccount", [entityAddress]);
      const entitySigner = await ethers.getSigner(entityAddress);
      
      await owner.sendTransaction({ to: entityAddress, value: ethers.parseEther("1.0") });
      
      await entityProvider.connect(entitySigner).safeTransferFrom(entityAddress, alice.address, controlTokenId, 1000, "0x");
      await entityProvider.connect(entitySigner).safeTransferFrom(entityAddress, bob.address, controlTokenId, 500, "0x");
      await entityProvider.connect(entitySigner).safeTransferFrom(entityAddress, alice.address, dividendTokenId, 200, "0x");
      await entityProvider.connect(entitySigner).safeTransferFrom(entityAddress, bob.address, dividendTokenId, 800, "0x");
      
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [entityAddress]);
    });

    it("Should support ERC1155 transfers", async function () {
      // Transfer control tokens from Alice to Carol
      await entityProvider.connect(alice).safeTransferFrom(
        alice.address,
        carol.address,
        controlTokenId,
        200,
        "0x"
      );

      expect(await entityProvider.balanceOf(alice.address, controlTokenId)).to.equal(800);
      expect(await entityProvider.balanceOf(carol.address, controlTokenId)).to.equal(200);
    });

    it("Should support ERC1155 batch transfers", async function () {
      await entityProvider.connect(alice).safeBatchTransferFrom(
        alice.address,
        carol.address,
        [controlTokenId, dividendTokenId],
        [100, 50],
        "0x"
      );

      expect(await entityProvider.balanceOf(alice.address, controlTokenId)).to.equal(900);
      expect(await entityProvider.balanceOf(alice.address, dividendTokenId)).to.equal(150);
      expect(await entityProvider.balanceOf(carol.address, controlTokenId)).to.equal(100);
      expect(await entityProvider.balanceOf(carol.address, dividendTokenId)).to.equal(50);
    });

    it("Should support ERC1155 approvals", async function () {
      await entityProvider.connect(alice).setApprovalForAll(bob.address, true);
      
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

  describe("Governance Information", function () {
    it("Should track governance info correctly", async function () {
      const boardHash = ethers.keccak256(ethers.toUtf8Bytes("test_board"));
      await entityProvider.registerNumberedEntity(boardHash);
      const entityNumber = 2;

      const [controlTokenId, dividendTokenId, controlSupply, dividendSupply, hasActiveProposal, articlesHash] = 
        await entityProvider.getGovernanceInfo(entityNumber);
      
      const expectedSupply = 100_000_000_000n;
      expect(controlTokenId).to.equal(entityNumber);
      expect(controlSupply).to.equal(expectedSupply);
      expect(dividendSupply).to.equal(expectedSupply);
      expect(hasActiveProposal).to.be.false;
      expect(articlesHash).to.not.equal(ethers.ZeroHash);
    });

  });

  describe("Foundation Access Control", function () {
    it("Should prevent non-foundation holders from using foundation functions", async function () {
      const boardHash = ethers.keccak256(ethers.toUtf8Bytes("test_board"));
      await entityProvider.registerNumberedEntity(boardHash);
      
      // Alice doesn't have foundation tokens
      await expect(
        entityProvider.connect(alice).assignName("testname", 2)
      ).to.be.revertedWith("Only foundation token holders");
    });
  });

  describe("Entity Hanko Verification", function () {
    it("Should verify a canonical Hanko for a registered entity", async function () {
        // The message hash MUST be prepared according to EIP-191.
        // ethers.hashMessage() automatically prepends the required prefix.
        const testHash = ethers.hashMessage(ethers.toUtf8Bytes("test message"));
        
        // This signature is from 'alice'
        const signature = await alice.signMessage(ethers.toUtf8Bytes("test message"));

        const board = {
            votingThreshold: 1,
            entityIds: [ethers.zeroPadValue(alice.address, 32)],
            votingPowers: [1],
            boardChangeDelay: 0,
            controlChangeDelay: 0,
            dividendChangeDelay: 0
        };

        const encodedBoard = ethers.AbiCoder.defaultAbiCoder().encode(
            ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
            [[board.votingThreshold, board.entityIds, board.votingPowers, board.boardChangeDelay, board.controlChangeDelay, board.dividendChangeDelay]]
        );

        const boardHash = ethers.keccak256(encodedBoard);
        await entityProvider.registerNumberedEntity(boardHash); // This creates Entity #2

        const parsedSignature = ethers.Signature.from(signature);
        const packedSignature = ethers.concat([
          parsedSignature.r,
          parsedSignature.s,
          ethers.toBeHex(parsedSignature.v === 28 ? 1 : 0, 1),
        ]);
        const entityId = ethers.zeroPadValue(ethers.toBeHex(2), 32);
        const hanko = ethers.AbiCoder.defaultAbiCoder().encode(
          ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[])'],
          [[[], packedSignature, [[
            entityId,
            [0],
            [1],
            1,
            board.boardChangeDelay,
            board.controlChangeDelay,
            board.dividendChangeDelay,
          ]]]],
        );
        const [recoveredEntityId, valid] = await entityProvider.verifyHankoSignature(hanko, testHash);
        expect(valid).to.equal(true);
        expect(recoveredEntityId).to.equal(entityId);
    });
  });

});
