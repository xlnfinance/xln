import { expect } from "chai";
import hre from "hardhat";
const { ethers } = await hre.network.getOrCreate("hardhat");
const FOUNDATION_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FOUNDATION_ID = ethers.zeroPadValue(ethers.toBeHex(1), 32);
// Redesign: shares (Foundation's included) sit at the namespaced treasury, delays are seconds.
const ENTITY_TREASURY_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes("XLN_ENTITY_TREASURY_V1"));
const entityTreasury = (entityNumber) => ethers.getAddress(ethers.dataSlice(ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [ENTITY_TREASURY_DOMAIN, entityNumber]),
), 12));
const ONE_DAY = 24 * 60 * 60;

async function entityProviderFactory() {
  const HankoVerifier = await ethers.getContractFactory("HankoVerifier");
  const verifier = await HankoVerifier.deploy();
  await verifier.waitForDeployment();
  return ethers.getContractFactory("EntityProvider", {
    libraries: { HankoVerifier: await verifier.getAddress() },
  });
}

function singleSignerHanko(hash, privateKey = FOUNDATION_PRIVATE_KEY) {
  const signature = new ethers.SigningKey(privateKey).sign(hash);
  const packed = ethers.concat([signature.r, signature.s, signature.v === 28 ? "0x01" : "0x00"]);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[],bytes[])"],
    [[[], packed, [[FOUNDATION_ID, [0], [1], 1, 0, 0, 0]], []]],
  );
}

describe("EntityProvider with Automatic Governance", function () {
  let entityProvider;
  let owner, alice, bob, carol;
  let foundationEntityId;

  // registerNumberedEntity takes the abi-encoded Board preimage; a blind hash is rejected.
  function singleSignerBoard(address, delays = [0, 0, 0]) {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)"],
      [[
        1,
        [ethers.zeroPadValue(address, 32)],
        [1],
        ...delays,
      ]]
    );
  }
  function singleSignerBoardHash(address, delays = [0, 0, 0]) {
    return ethers.keccak256(singleSignerBoard(address, delays));
  }

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();

    // Deploy EntityProvider
    const EntityProvider = await entityProviderFactory();
    entityProvider = await EntityProvider.deploy(owner.address);
    await entityProvider.waitForDeployment();

    foundationEntityId = await entityProvider.FOUNDATION_ENTITY();
  });

  async function foundationAuthorization(actionType, argumentsHash) {
    const actionNonce = await entityProvider.entityActionNonces(FOUNDATION_ID) + 1n;
    const actionHash = await entityProvider.computeFoundationActionHash(actionType, argumentsHash, actionNonce);
    return { actionNonce, hankoData: singleSignerHanko(actionHash) };
  }

  describe("Foundation Setup", function () {
    it("rejects a zero foundation recipient", async function () {
      const EntityProvider = await entityProviderFactory();
      await expect(EntityProvider.deploy(ethers.ZeroAddress)).to.be.revertedWith("Invalid foundation recipient");
    });

    it("Should deploy with foundation entity #1 with governance", async function () {
      expect(foundationEntityId).to.equal(1);

      const entity = await entityProvider.entities(ethers.zeroPadValue(ethers.toBeHex(1), 32));
      expect(entity.currentBoardHash).to.equal(singleSignerBoardHash(owner.address));
      expect(entity.registrationBlock).to.be.gt(0);
      expect(entity.articles.controlDelay).to.equal(ONE_DAY);

      // Foundation governance tokens live in the Foundation treasury, not the recipient EOA.
      const [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(1);
      const expectedSupply = 100_000_000_000n;

      expect(await entityProvider.balanceOf(entityTreasury(1), controlTokenId)).to.equal(expectedSupply);
      expect(await entityProvider.balanceOf(entityTreasury(1), dividendTokenId)).to.equal(expectedSupply);
      expect(await entityProvider.balanceOf(owner.address, controlTokenId)).to.equal(0n);
      expect(await entityProvider.balanceOf(owner.address, dividendTokenId)).to.equal(0n);
    });

    it("Should authorize foundation functions with the current Foundation Hanko", async function () {
      const [foundationControlTokenId] = await entityProvider.getTokenIds(1);
      expect(await entityProvider.balanceOf(entityTreasury(1), foundationControlTokenId)).to.equal(100_000_000_000n);

      // No name registry on chain any more; foundationRegisterEntity is the
      // Foundation action that stays reachable from a plain fixture.
      const encodedBoard = singleSignerBoard(alice.address);
      const customArticles = { controlDelay: 3, dividendDelay: 5, foundationDelay: 7 };
      const argumentsHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint32 controlDelay,uint32 dividendDelay,uint32 foundationDelay)"],
        [ethers.keccak256(encodedBoard), customArticles],
      ));
      const authorization = await foundationAuthorization(
        await entityProvider.FOUNDATION_REGISTER_ENTITY(),
        argumentsHash,
      );
      await expect(entityProvider.connect(alice).foundationRegisterEntity(
        encodedBoard,
        customArticles,
        authorization.hankoData,
        authorization.actionNonce,
      )).to.emit(entityProvider, "EntityRegistered");
      expect(await entityProvider.nextNumber()).to.equal(3n);
    });

    it("exposes no name registry (names are a relay/UI concern)", async function () {
      const surface = entityProvider.interface.fragments
        .map((fragment) => fragment.name ?? "")
        .filter((name) => /name/i.test(name));
      expect(surface).to.deep.equal([]);
      await entityProvider.registerNumberedEntity(singleSignerBoard(alice.address));
      const info = await entityProvider.getEntityInfo(ethers.zeroPadValue(ethers.toBeHex(2), 32));
      expect(info.length).to.equal(4);
      expect(info[0]).to.equal(true);
      expect(info[1]).to.equal(singleSignerBoardHash(alice.address));
      expect(info[2]).to.equal(ethers.ZeroHash);
      expect(info[3]).to.be.gt(0n);
    });
  });

  describe("Automatic Entity Registration", function () {
    it("Should register new numbered entity with automatic governance", async function () {
      const encodedBoard = singleSignerBoard(alice.address);
      const boardHash = ethers.keccak256(encodedBoard);

      const tx = await entityProvider.registerNumberedEntity(encodedBoard);
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
      expect(entity.articles.controlDelay).to.equal(ONE_DAY);

      // Check governance tokens were created with fixed supply in the entity treasury
      const [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(entityNumber);
      const entityAddress = entityTreasury(entityNumber);
      const expectedSupply = 100_000_000_000n;
      expect(await entityProvider.balanceOf(ethers.getAddress(`0x${entityNumber.toString(16).padStart(40, '0')}`), controlTokenId)).to.equal(0n);

      expect(await entityProvider.balanceOf(entityAddress, controlTokenId)).to.equal(expectedSupply);
      expect(await entityProvider.balanceOf(entityAddress, dividendTokenId)).to.equal(expectedSupply);
    });

    it("Should allow foundation to create entity with custom governance", async function () {
      const encodedBoard = singleSignerBoard(alice.address, [1, 2, 3]);
      const boardHash = ethers.keccak256(encodedBoard);
      const customArticles = {
        controlDelay: 500,
        dividendDelay: 1500,
        foundationDelay: 5000
      };

      const argumentsHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint32 controlDelay,uint32 dividendDelay,uint32 foundationDelay)"],
        [boardHash, customArticles],
      ));
      const authorization = await foundationAuthorization(
        await entityProvider.FOUNDATION_REGISTER_ENTITY(),
        argumentsHash,
      );
      await expect(entityProvider.connect(alice).foundationRegisterEntity(
        encodedBoard,
        customArticles,
        authorization.hankoData,
        authorization.actionNonce,
      )).to.not.revert(ethers);

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

      // Entity number is the low 255 bits of either token id (first-bit flip convention).
      const mask = (1n << 255n) - 1n;
      expect(BigInt(controlTokenId) & mask).to.equal(BigInt(entityNumber));
      expect(BigInt(dividendTokenId) & mask).to.equal(BigInt(entityNumber));
    });
  });

  describe("ERC1155 Token Transfers", function () {
    let entityNumber;
    let controlTokenId, dividendTokenId;

    beforeEach(async function () {
      await entityProvider.registerNumberedEntity(singleSignerBoard(alice.address));
      entityNumber = 2;

      [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(entityNumber);

      // Note: In real usage, tokens would be distributed via Depository.sol using entity hanko signatures
      // For testing, we'll just verify tokens exist in the entity treasury
      const entityAddress = entityTreasury(entityNumber);
      const expectedSupply = 100_000_000_000n;

      expect(await entityProvider.balanceOf(entityAddress, controlTokenId)).to.equal(expectedSupply);
      expect(await entityProvider.balanceOf(entityAddress, dividendTokenId)).to.equal(expectedSupply);

      // For testing transfers, impersonate the namespaced treasury (redesign) and move some tokens.
      // In production, this would be done via entityTransferTokens() with proper hanko signatures
      await ethers.provider.send("hardhat_impersonateAccount", [entityAddress]);
      await ethers.provider.send("hardhat_setBalance", [entityAddress, ethers.toBeHex(ethers.parseEther("1.0"))]);
      const entitySigner = await ethers.getSigner(entityAddress);

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
      const encodedBoard = singleSignerBoard(alice.address);
      const boardHash = ethers.keccak256(encodedBoard);
      await entityProvider.registerNumberedEntity(encodedBoard);
      const entityNumber = 2n;
      const [controlTokenId, dividendTokenId] = await entityProvider.getTokenIds(entityNumber);
      const entityAddress = entityTreasury(entityNumber);
      const entityId = ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32);
      const entity = await entityProvider.entities(entityId);
      const expectedSupply = 100_000_000_000n;

      expect(controlTokenId).to.equal(entityNumber);
      expect(await entityProvider.balanceOf(entityAddress, controlTokenId)).to.equal(expectedSupply);
      expect(await entityProvider.balanceOf(entityAddress, dividendTokenId)).to.equal(expectedSupply);
      expect(entity.proposedBoardHash).to.equal(ethers.ZeroHash);
      expect(entity.currentBoardHash).to.equal(boardHash);
      expect(entity.articles.controlDelay).to.be.gt(0);
    });

  });

  describe("Foundation Access Control", function () {
    it("Should reject calls without a valid current Foundation Hanko", async function () {
      await entityProvider.registerNumberedEntity(singleSignerBoard(alice.address));

      // Alice's key is not the Foundation board: a Hanko she signs over the
      // right hash still fails the Foundation lane.
      const encodedBoard = singleSignerBoard(bob.address);
      const customArticles = { controlDelay: 3, dividendDelay: 5, foundationDelay: 7 };
      const argumentsHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint32 controlDelay,uint32 dividendDelay,uint32 foundationDelay)"],
        [ethers.keccak256(encodedBoard), customArticles],
      ));
      const actionNonce = await entityProvider.entityActionNonces(FOUNDATION_ID) + 1n;
      const actionHash = await entityProvider.computeFoundationActionHash(
        await entityProvider.FOUNDATION_REGISTER_ENTITY(), argumentsHash, actionNonce,
      );
      const alicePrivateKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
      await expect(
        entityProvider.connect(alice).foundationRegisterEntity(
          encodedBoard, customArticles, singleSignerHanko(actionHash, alicePrivateKey), actionNonce,
        )
      ).to.be.revertedWithCustomError(entityProvider, "InvalidFoundationAuthorization");
      await expect(
        entityProvider.connect(alice).foundationRegisterEntity(
          encodedBoard, customArticles, singleSignerHanko(ethers.ZeroHash), actionNonce,
        )
      ).to.be.revertedWithCustomError(entityProvider, "InvalidFoundationAuthorization");
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

        await entityProvider.registerNumberedEntity(encodedBoard); // This creates Entity #2

        const parsedSignature = ethers.Signature.from(signature);
        const packedSignature = ethers.concat([
          parsedSignature.r,
          parsedSignature.s,
          ethers.toBeHex(parsedSignature.v === 28 ? 1 : 0, 1),
        ]);
        const entityId = ethers.zeroPadValue(ethers.toBeHex(2), 32);
        const hanko = ethers.AbiCoder.defaultAbiCoder().encode(
          ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[],bytes[])'],
          [[[], packedSignature, [[
            entityId,
            [0],
            [1],
            1,
            board.boardChangeDelay,
            board.controlChangeDelay,
            board.dividendChangeDelay,
          ]], []]],
        );
        const [recoveredEntityId, valid] = await entityProvider.verifyHankoSignature(hanko, testHash);
        expect(valid).to.equal(true);
        expect(recoveredEntityId).to.equal(entityId);
    });
  });

});
