import { expect } from 'chai';
import hre from 'hardhat';

import {
  FOUNDATION_ENTITY_ID,
  addressEntityId,
  boardHashOf,
  buildClaimsHanko,
  buildFoundationAction,
  buildSingleSignerHanko,
  deployDepositoryStack,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  encodeBoard,
  encodeSingleSignerBoard,
  entityTransferFromTreasury,
  entityTreasuryAddress,
  registerSingleSignerEntity,
  singleSignerLazyEntityId,
} from '../helpers/hanko.ts';

const { ethers, networkHelpers } = await hre.network.getOrCreate('hardhat');
const { loadFixture, mine, time } = networkHelpers;
const abi = ethers.AbiCoder.defaultAbiCoder();

const BOARD = 0;
const DIVIDEND = 2;
const ONE_DAY = 24 * 60 * 60;
const BOARD_GRACE_SECONDS = 7 * ONE_DAY;
const ARTICLES_ABI = 'tuple(uint32 controlDelay,uint32 dividendDelay,uint32 foundationDelay)';

const entityIdOf = (entityNumber: bigint | number): string => ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32);
const legacyEntityAddress = (entityNumber: bigint | number): string =>
  ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 20));
const syntheticMember = (label: string): string =>
  ethers.getAddress(ethers.dataSlice(ethers.keccak256(ethers.toUtf8Bytes(label)), 12));

describe('EntityProvider deploy-once redesign', function () {
  async function fixture() {
    const signers = await ethers.getSigners();
    const provider = await deployEntityProvider(signers[0]!.address);
    const stack = await deployDepositoryStack(await provider.getAddress());
    return { provider, depository: stack.depository, signers };
  }

  const foundationRegister = async (
    provider: Awaited<ReturnType<typeof deployEntityProvider>>,
    encodedBoard: string,
    articles: { controlDelay: number; dividendDelay: number; foundationDelay: number },
  ): Promise<bigint> => {
    const argumentsHash = ethers.keccak256(abi.encode(['bytes32', ARTICLES_ABI], [boardHashOf(encodedBoard), articles]));
    const action = await buildFoundationAction(provider, await provider.FOUNDATION_REGISTER_ENTITY(), argumentsHash);
    await (await provider.foundationRegisterEntity(encodedBoard, articles, action.hankoData, action.actionNonce)).wait();
    return (await provider.nextNumber()) - 1n;
  };

  const boardProposal = async (
    provider: Awaited<ReturnType<typeof deployEntityProvider>>,
    entityId: string,
    newBoardHash: string,
    signerIndex: number,
  ): Promise<string> => {
    const nonce = await provider.boardActionNonces(entityId) + 1n;
    const digest = await provider.computeBoardProposalHash(entityId, newBoardHash, BOARD, nonce);
    return buildSingleSignerHanko(entityId, digest, deriveHardhatPrivateKey(signerIndex));
  };

  describe('board validation (commitBoard)', function () {
    it('rejects unreachable, zero-weight, duplicate, oversized and numbered-slot-0 boards', async function () {
      const { provider, signers } = await loadFixture(fixture);
      const a = signers[1]!.address;
      const b = signers[2]!.address;

      await expect(provider.commitBoard(encodeBoard(3, [a, b], [1, 1])))
        .to.be.revertedWithCustomError(provider, 'InvalidBoard');
      await expect(provider.commitBoard(encodeBoard(1, [a, b], [1, 0])))
        .to.be.revertedWithCustomError(provider, 'InvalidBoard');
      await expect(provider.commitBoard(encodeBoard(1, [a, a], [1, 1])))
        .to.be.revertedWithCustomError(provider, 'InvalidBoard');
      await expect(provider.commitBoard(encodeBoard(0, [a], [1])))
        .to.be.revertedWithCustomError(provider, 'InvalidBoard');
      await expect(provider.commitBoard(encodeBoard(1, [], [])))
        .to.be.revertedWithCustomError(provider, 'InvalidBoard');
      await expect(provider.commitBoard(encodeBoard(1, [a, b], [1])))
        .to.be.revertedWithCustomError(provider, 'InvalidBoard');
      // First member must be address-shaped: a lazy entity hash cannot lead.
      await expect(provider.commitBoard(encodeBoard(1, [ethers.keccak256('0x01'), a], [1, 1])))
        .to.be.revertedWithCustomError(provider, 'InvalidBoard');

      const tooMany = Array.from({ length: 257 }, (_, i) => syntheticMember(`member-${i}`));
      await expect(provider.commitBoard(encodeBoard(1, tooMany, tooMany.map(() => 1))))
        .to.be.revertedWithCustomError(provider, 'InvalidBoard');
      const maxMembers = tooMany.slice(0, 256);
      await expect(provider.commitBoard(encodeBoard(1, maxMembers, maxMembers.map(() => 1))))
        .to.emit(provider, 'BoardCommitted');

      // A registered numbered entity id at slot 0 can never sign: its weight
      // does not count toward reachability.
      const numbered = await registerSingleSignerEntity(provider, a);
      const numberedId = entityIdOf(numbered);
      await expect(provider.commitBoard(encodeBoard(2, [numberedId, b], [1, 1])))
        .to.be.revertedWithCustomError(provider, 'InvalidBoard');
      const reachableWithoutSlot0 = encodeBoard(1, [numberedId, b], [1, 1]);
      await expect(provider.commitBoard(reachableWithoutSlot0))
        .to.emit(provider, 'BoardCommitted').withArgs(boardHashOf(reachableWithoutSlot0));
      expect(await provider.committedBoards(boardHashOf(reachableWithoutSlot0))).to.equal(true);
      // Re-committing is a no-op without a second event.
      await expect(provider.commitBoard(reachableWithoutSlot0)).to.not.emit(provider, 'BoardCommitted');
      // Registration paths run the same predicate.
      await expect(provider.registerNumberedEntity(encodeBoard(3, [a, b], [1, 1])))
        .to.be.revertedWithCustomError(provider, 'InvalidBoard');
      await expect(provider.registerNumberedEntitiesBatch([encodeSingleSignerBoard(a), encodeBoard(1, [a, a], [1, 1])]))
        .to.be.revertedWithCustomError(provider, 'InvalidBoard');
    });
  });

  describe('registration and proposals', function () {
    it('registers a multi-member board and gates proposeBoard on committed preimages', async function () {
      const { provider, signers } = await loadFixture(fixture);
      const members = [signers[1]!.address, signers[2]!.address, signers[3]!.address];
      const board = encodeBoard(2, members, [1, 1, 1]);
      await expect(provider.registerNumberedEntity(board))
        .to.emit(provider, 'EntityRegistered').withArgs(entityIdOf(2), 2n, boardHashOf(board))
        .and.to.emit(provider, 'BoardCommitted').withArgs(boardHashOf(board));
      const entityId = entityIdOf(2);
      expect((await provider.entities(entityId)).currentBoardHash).to.equal(boardHashOf(board));
      expect(await provider.committedBoards(boardHashOf(board))).to.equal(true);

      const nextBoard = encodeSingleSignerBoard(signers[4]!.address);
      const nextHash = boardHashOf(nextBoard);
      const nonce = await provider.boardActionNonces(entityId) + 1n;
      const digest = await provider.computeBoardProposalHash(entityId, nextHash, BOARD, nonce);
      // 2-of-3: signatures of members 0 and 1 occupy slots 1 and 2; member 2 is placeholder 0.
      const hanko = buildClaimsHanko(
        digest,
        [deriveHardhatPrivateKey(1), deriveHardhatPrivateKey(2)],
        [addressEntityId(members[2]!)],
        [[entityId, [1, 2, 0], [1, 1, 1], 2]],
      );
      await expect(provider.proposeBoard(entityId, nextHash, BOARD, [hanko]))
        .to.be.revertedWithCustomError(provider, 'BoardNotCommitted');
      await (await provider.commitBoard(nextBoard)).wait();
      await expect(provider.proposeBoard(entityId, nextHash, BOARD, [hanko]))
        .to.emit(provider, 'BoardProposed');
      expect((await provider.entities(entityId)).proposedBoardHash).to.equal(nextHash);
    });
  });

  describe('seconds-based delays', function () {
    it('activates only once block.timestamp reaches activateAt', async function () {
      const { provider, signers } = await loadFixture(fixture);
      const articles = { controlDelay: 3600, dividendDelay: 7200, foundationDelay: 10 * ONE_DAY };
      const entityNumber = await foundationRegister(provider, encodeSingleSignerBoard(signers[1]!.address), articles);
      const entityId = entityIdOf(entityNumber);
      expect((await provider.entities(entityId)).articles.controlDelay).to.equal(3600n);

      const nextBoard = encodeSingleSignerBoard(signers[2]!.address);
      await (await provider.commitBoard(nextBoard)).wait();
      const nextHash = boardHashOf(nextBoard);
      const tx = await provider.proposeBoard(entityId, nextHash, BOARD, [await boardProposal(provider, entityId, nextHash, 1)]);
      const receipt = await tx.wait();
      const proposedAt = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;
      const expectedActivateAt = BigInt(proposedAt + 3600);
      await expect(tx).to.emit(provider, 'BoardProposed').withArgs(entityId, nextHash, BOARD, 1n, expectedActivateAt);
      expect((await provider.entities(entityId)).activateAt).to.equal(expectedActivateAt);

      await expect(provider.activateBoard(entityId)).to.be.revertedWith('Delay period not met');
      // Blocks are not the unit: 100 blocks (~100 s here) do not satisfy a 3600 s delay.
      await mine(100);
      await expect(provider.activateBoard(entityId)).to.be.revertedWith('Delay period not met');
      await time.setNextBlockTimestamp(Number(expectedActivateAt) - 1);
      await expect(provider.activateBoard(entityId)).to.be.revertedWith('Delay period not met');
      await time.setNextBlockTimestamp(Number(expectedActivateAt));
      await expect(provider.activateBoard(entityId)).to.emit(provider, 'BoardActivated');
      expect((await provider.entities(entityId)).currentBoardHash).to.equal(nextHash);
      expect((await provider.entities(entityId)).activateAt).to.equal(0n);
    });

    it('installs 1 day / 3 days / 10 days default articles on plain registration', async function () {
      const { provider, signers } = await loadFixture(fixture);
      const entityNumber = await registerSingleSignerEntity(provider, signers[1]!.address);
      const articles = (await provider.entities(entityIdOf(entityNumber))).articles;
      expect(articles.controlDelay).to.equal(BigInt(ONE_DAY));
      expect(articles.dividendDelay).to.equal(BigInt(3 * ONE_DAY));
      expect(articles.foundationDelay).to.equal(BigInt(10 * ONE_DAY));
    });
  });

  describe('two historical board slots', function () {
    it('rotates twice back-to-back, blocks a third inside grace, keeps retired evidence authority', async function () {
      const { provider, signers } = await loadFixture(fixture);
      const articles = { controlDelay: 1, dividendDelay: 1, foundationDelay: 1 };
      const boards = [1, 2, 3, 4].map((i) => encodeSingleSignerBoard(signers[i]!.address));
      const hashes = boards.map(boardHashOf);
      const entityNumber = await foundationRegister(provider, boards[0]!, articles);
      const entityId = entityIdOf(entityNumber);
      for (const board of boards.slice(1)) await (await provider.commitBoard(board)).wait();

      const rotate = async (toIndex: number, signerIndex: number) => {
        await (await provider.proposeBoard(
          entityId, hashes[toIndex]!, BOARD, [await boardProposal(provider, entityId, hashes[toIndex]!, signerIndex)],
        )).wait();
        await time.increase(articles.controlDelay);
      };

      await rotate(1, 1);
      const first = await (await provider.activateBoard(entityId)).wait();
      const firstValidUntil = BigInt((await ethers.provider.getBlock(first!.blockNumber))!.timestamp + BOARD_GRACE_SECONDS);

      // Second rotation lands immediately: board A moves to slot 2.
      await rotate(2, 2);
      const second = await (await provider.activateBoard(entityId)).wait();
      const secondValidUntil = BigInt((await ethers.provider.getBlock(second!.blockNumber))!.timestamp + BOARD_GRACE_SECONDS);
      const afterSecond = await provider.entities(entityId);
      expect(afterSecond.currentBoardHash).to.equal(hashes[2]);
      expect(afterSecond.previousBoardHash).to.equal(hashes[1]);
      expect(afterSecond.previousBoardValidUntil).to.equal(secondValidUntil);
      expect(afterSecond.previousBoardHash2).to.equal(hashes[0]);
      expect(afterSecond.previousBoardValidUntil2).to.equal(firstValidUntil);

      // Dispute evidence signed by the first retired board still verifies;
      // current-only (money/governance) verification rejects it.
      const digest = ethers.keccak256(ethers.toUtf8Bytes('retired-board-evidence'));
      const evidenceA = buildSingleSignerHanko(entityId, digest, deriveHardhatPrivateKey(1));
      const evidenceB = buildSingleSignerHanko(entityId, digest, deriveHardhatPrivateKey(2));
      const evidenceC = buildSingleSignerHanko(entityId, digest, deriveHardhatPrivateKey(3));
      expect(await provider.verifyHankoSignature(evidenceA, digest)).to.deep.equal([entityId, true]);
      expect(await provider.verifyHankoSignature(evidenceB, digest)).to.deep.equal([entityId, true]);
      expect(await provider.verifyCurrentHankoSignature(evidenceA, digest)).to.deep.equal([ethers.ZeroHash, false]);
      expect(await provider.verifyCurrentHankoSignature(evidenceB, digest)).to.deep.equal([ethers.ZeroHash, false]);
      expect(await provider.verifyCurrentHankoSignature(evidenceC, digest)).to.deep.equal([entityId, true]);

      // A third rotation waits for the OLDEST retired window.
      await rotate(3, 3);
      await expect(provider.activateBoard(entityId)).to.be.revertedWithCustomError(provider, 'BoardGracePeriodActive');
      await time.setNextBlockTimestamp(Number(firstValidUntil) - 1);
      await expect(provider.activateBoard(entityId)).to.be.revertedWithCustomError(provider, 'BoardGracePeriodActive');
      expect(await provider.verifyHankoSignature(evidenceA, digest)).to.deep.equal([entityId, true]);
      await time.setNextBlockTimestamp(Number(firstValidUntil));
      await expect(provider.activateBoard(entityId)).to.emit(provider, 'BoardActivated');
      const afterThird = await provider.entities(entityId);
      expect(afterThird.currentBoardHash).to.equal(hashes[3]);
      expect(afterThird.previousBoardHash).to.equal(hashes[2]);
      expect(afterThird.previousBoardHash2).to.equal(hashes[1]);
      expect(afterThird.previousBoardValidUntil2).to.equal(secondValidUntil);
      expect(await provider.verifyHankoSignature(evidenceA, digest)).to.deep.equal([ethers.ZeroHash, false]);
      expect(await provider.verifyHankoSignature(evidenceB, digest)).to.deep.equal([entityId, true]);
      expect(await provider.boardEpochs(entityId)).to.equal(3n);
    });
  });

  describe('entity treasuries', function () {
    it('mints shares to entityTreasury(N) and moves them only through entityTransferTokens', async function () {
      const { provider, signers } = await loadFixture(fixture);
      const supply = await provider.TOTAL_CONTROL_SUPPLY();
      const [foundationControl, foundationDividend] = await provider.getTokenIds(1);
      expect(await provider.balanceOf(entityTreasuryAddress(1), foundationControl)).to.equal(supply);
      expect(await provider.balanceOf(entityTreasuryAddress(1), foundationDividend)).to.equal(supply);
      expect(await provider.balanceOf(signers[0]!.address, foundationControl)).to.equal(0n);
      expect(await provider.balanceOf(legacyEntityAddress(1), foundationControl)).to.equal(0n);

      const entityNumber = await registerSingleSignerEntity(provider, signers[1]!.address);
      const treasury = entityTreasuryAddress(entityNumber);
      const [controlTokenId, dividendTokenId] = await provider.getTokenIds(entityNumber);
      expect(treasury).to.not.equal(legacyEntityAddress(entityNumber));
      expect(await provider.balanceOf(treasury, controlTokenId)).to.equal(supply);
      expect(await provider.balanceOf(treasury, dividendTokenId)).to.equal(supply);
      expect(await provider.balanceOf(legacyEntityAddress(entityNumber), controlTokenId)).to.equal(0n);
      expect(await provider.balanceOf(legacyEntityAddress(entityNumber), dividendTokenId)).to.equal(0n);

      const recipient = signers[7]!.address;
      await entityTransferFromTreasury(provider, recipient, controlTokenId, 1_000n, entityNumber, deriveHardhatPrivateKey(1));
      expect(await provider.balanceOf(treasury, controlTokenId)).to.equal(supply - 1_000n);
      expect(await provider.balanceOf(recipient, controlTokenId)).to.equal(1_000n);
      // Foundation shares move the same way, under a Foundation Hanko.
      await entityTransferFromTreasury(provider, recipient, foundationControl, 5n);
      expect(await provider.balanceOf(entityTreasuryAddress(1), foundationControl)).to.equal(supply - 5n);
      expect(await provider.balanceOf(recipient, foundationControl)).to.equal(5n);
      // The recipient EOA has no operator rights over any treasury.
      await expect(provider.connect(signers[0]!).safeTransferFrom(entityTreasuryAddress(1), recipient, foundationControl, 1n, '0x'))
        .to.be.revertedWithCustomError(provider, 'ERC1155MissingApprovalForAll');
    });
  });

  describe('Foundation token listing', function () {
    it('lists an ERC20 through foundationRegisterExternalToken and rejects direct listing', async function () {
      const { provider, depository, signers } = await loadFixture(fixture);
      const tokenFactory = await ethers.getContractFactory('ERC20Mock');
      const token = await tokenFactory.deploy('Listed', 'LST', 18, 1_000_000);
      await token.waitForDeployment();
      const tokenAddress = await token.getAddress();
      const depositoryAddress = await depository.getAddress();

      // Redesign: the deployer EOA (Depository admin) no longer lists tokens.
      await expect(depository.connect(signers[0]!).registerExternalToken(0, tokenAddress, 0))
        .to.be.revertedWithCustomError(depository, 'E2');
      await expect(depository.connect(signers[3]!).registerExternalToken(0, tokenAddress, 0))
        .to.be.revertedWithCustomError(depository, 'E2');

      const argumentsHash = ethers.keccak256(abi.encode(
        ['address', 'uint8', 'address', 'uint256'], [depositoryAddress, 0, tokenAddress, 0],
      ));
      const forged = await buildFoundationAction(
        provider, await provider.FOUNDATION_REGISTER_TOKEN(), argumentsHash, deriveHardhatPrivateKey(3),
      );
      await expect(provider.foundationRegisterExternalToken(
        depositoryAddress, 0, tokenAddress, 0, forged.hankoData, forged.actionNonce,
      )).to.be.revertedWithCustomError(provider, 'InvalidFoundationAuthorization');

      const listing = await buildFoundationAction(provider, await provider.FOUNDATION_REGISTER_TOKEN(), argumentsHash);
      await expect(provider.foundationRegisterExternalToken(
        depositoryAddress, 0, tokenAddress, 0, listing.hankoData, listing.actionNonce + 1n,
      )).to.be.revertedWithCustomError(provider, 'InvalidFoundationActionNonce');
      // The action commits to the depository: the same Hanko cannot list elsewhere.
      await expect(provider.foundationRegisterExternalToken(
        signers[9]!.address, 0, tokenAddress, 0, listing.hankoData, listing.actionNonce,
      )).to.be.revertedWithCustomError(provider, 'InvalidFoundationAuthorization');

      await expect(provider.connect(signers[5]!).foundationRegisterExternalToken(
        depositoryAddress, 0, tokenAddress, 0, listing.hankoData, listing.actionNonce,
      ))
        .to.emit(depository, 'TokenRegistered').withArgs(1n, 0, tokenAddress, 0n)
        .and.to.emit(provider, 'ExternalTokenListed').withArgs(depositoryAddress, 0, tokenAddress, 0n, 1n)
        .and.to.emit(provider, 'FoundationActionExecuted');
      const metadata = await depository._tokens(1n);
      expect(metadata.contractAddress).to.equal(tokenAddress);
      expect(metadata.tokenType).to.equal(0n);
      expect(await depository.getTokensLength()).to.equal(2n);
      expect(await provider.entityActionNonces(FOUNDATION_ENTITY_ID)).to.equal(listing.actionNonce);

      // A target without code or built on another EntityProvider is refused.
      const eoaTarget = await buildFoundationAction(
        provider,
        await provider.FOUNDATION_REGISTER_TOKEN(),
        ethers.keccak256(abi.encode(['address', 'uint8', 'address', 'uint256'], [signers[9]!.address, 0, tokenAddress, 0])),
      );
      await expect(provider.foundationRegisterExternalToken(
        signers[9]!.address, 0, tokenAddress, 0, eoaTarget.hankoData, eoaTarget.actionNonce,
      )).to.be.revertedWithCustomError(provider, 'ShareDepositoryBindingInvalid');
    });
  });

  describe('share depositories', function () {
    it('appends a second Depository by Foundation Hanko and rejects foreign stacks', async function () {
      const { provider, depository, signers } = await loadFixture(fixture);
      const providerAddress = await provider.getAddress();
      const first = await depository.getAddress();
      const { depository: second } = await deployDepositoryStack(providerAddress, { bindShareDepository: false });
      const secondAddress = await second.getAddress();
      expect(await provider.shareDepositories()).to.deep.equal([first]);
      expect(await provider.shareDepository()).to.equal(first);
      await expect(provider.bindShareDepository(secondAddress))
        .to.be.revertedWithCustomError(provider, 'ShareDepositoryAlreadyBound');

      const addAction = async (target: string, privateKey = deriveHardhatPrivateKey(0)) => buildFoundationAction(
        provider,
        await provider.FOUNDATION_ADD_SHARE_DEPOSITORY(),
        ethers.keccak256(abi.encode(['address'], [target])),
        privateKey,
      );
      const forged = await addAction(secondAddress, deriveHardhatPrivateKey(2));
      await expect(provider.foundationAddShareDepository(secondAddress, forged.hankoData, forged.actionNonce))
        .to.be.revertedWithCustomError(provider, 'InvalidFoundationAuthorization');

      const add = await addAction(secondAddress);
      await expect(provider.connect(signers[4]!).foundationAddShareDepository(secondAddress, add.hankoData, add.actionNonce))
        .to.emit(provider, 'ShareDepositoryBound').withArgs(secondAddress);
      expect(await provider.shareDepositories()).to.deep.equal([first, secondAddress]);
      expect(await provider.shareDepository()).to.equal(first);

      const again = await addAction(secondAddress);
      await expect(provider.foundationAddShareDepository(secondAddress, again.hankoData, again.actionNonce))
        .to.be.revertedWithCustomError(provider, 'ShareDepositoryAlreadyBound');

      const otherProvider = await deployEntityProvider(signers[0]!.address);
      const { depository: foreign } = await deployDepositoryStack(await otherProvider.getAddress(), { bindShareDepository: false });
      const foreignAddress = await foreign.getAddress();
      expect(await foreign.entityProvider()).to.not.equal(providerAddress);
      const addForeign = await addAction(foreignAddress);
      await expect(provider.foundationAddShareDepository(foreignAddress, addForeign.hankoData, addForeign.actionNonce))
        .to.be.revertedWithCustomError(provider, 'ShareDepositoryBindingInvalid');
      const addEoa = await addAction(signers[8]!.address);
      await expect(provider.foundationAddShareDepository(signers[8]!.address, addEoa.hankoData, addEoa.actionNonce))
        .to.be.revertedWithCustomError(provider, 'ShareDepositoryBindingInvalid');
      expect(await provider.shareDepositories()).to.deep.equal([first, secondAddress]);

      // The appended Depository is a valid share custodian: release credits its reserve
      // (onERC1155Received accepts the namespaced treasury as `from`).
      const entityNumber = await registerSingleSignerEntity(provider, signers[1]!.address);
      const entityId = entityIdOf(entityNumber);
      const [controlTokenId] = await provider.getTokenIds(entityNumber);
      const releaseHash = await provider.computeReleaseControlSharesHankoHash(entityNumber, secondAddress, 10n, 0n, 'v2', 1n);
      await expect(provider.releaseControlShares(
        entityNumber, secondAddress, 10n, 0n, 'v2', buildSingleSignerHanko(entityId, releaseHash, deriveHardhatPrivateKey(1)),
      )).to.emit(provider, 'ControlSharesReleased').withArgs(entityId, secondAddress, 10n, 0n, 'v2');
      expect(await provider.balanceOf(secondAddress, controlTokenId)).to.equal(10n);
      expect(await second._reserves(entityId, 1n)).to.equal(10n);
      expect(await depository._reserves(entityId, 1n)).to.equal(0n);
    });
  });

  describe('DIVIDEND lane checkpoints', function () {
    it('reads dividend balances one second back and exposes dividendBalanceAt', async function () {
      const { provider, signers } = await loadFixture(fixture);
      const entityNumber = await registerSingleSignerEntity(provider, signers[1]!.address);
      const entityId = entityIdOf(entityNumber);
      const [, dividendTokenId] = await provider.getTokenIds(entityNumber);
      const supply = await provider.TOTAL_DIVIDEND_SUPPLY();
      const holder = signers[6]!;
      const majority = supply * 60n / 100n;
      const nextBoard = encodeSingleSignerBoard(signers[2]!.address);
      await (await provider.commitBoard(nextBoard)).wait();
      const nextHash = boardHashOf(nextBoard);
      const dividendSupport = async (nonce: bigint): Promise<string> => {
        const digest = await provider.computeBoardProposalHash(entityId, nextHash, DIVIDEND, nonce);
        return new ethers.SigningKey(deriveHardhatPrivateKey(6)).sign(ethers.getBytes(digest)).serialized;
      };

      // No shares yet: the lane rejects the supporter.
      await expect(provider.proposeBoard(entityId, nextHash, DIVIDEND, [await dividendSupport(1n)]))
        .to.be.revertedWithCustomError(provider, 'ShareSupporterHasNoShares');

      // Same-block acquisition carries no weight: the majority transfer and the
      // holder's vote are mined together, and the vote reads (block.timestamp - 1).
      await ethers.provider.send('evm_setAutomine', [false]);
      const transferNonce = await provider.entityActionNonces(entityId) + 1n;
      const transferHash = await provider.computeEntityTransferHankoHash(
        entityNumber, holder.address, dividendTokenId, majority, transferNonce,
      );
      const flashTransfer = await provider.entityTransferTokens(
        entityNumber, holder.address, dividendTokenId, majority,
        buildSingleSignerHanko(entityId, transferHash, deriveHardhatPrivateKey(1)), { gasLimit: 2_000_000 },
      );
      const flashVote = await provider.connect(holder).proposeBoard(
        entityId, nextHash, DIVIDEND, [await dividendSupport(1n)], { gasLimit: 2_000_000 },
      );
      await ethers.provider.send('evm_mine', []);
      await ethers.provider.send('evm_setAutomine', [true]);
      const transferReceipt = await ethers.provider.getTransactionReceipt(flashTransfer.hash);
      const voteReceipt = await ethers.provider.getTransactionReceipt(flashVote.hash);
      expect(transferReceipt!.blockNumber).to.equal(voteReceipt!.blockNumber);
      expect(transferReceipt!.index).to.be.lessThan(voteReceipt!.index);
      expect(transferReceipt!.status).to.equal(1);
      expect(voteReceipt!.status).to.equal(0);
      expect(await provider.balanceOf(holder.address, dividendTokenId)).to.equal(majority);
      expect((await provider.entities(entityId)).proposedBoardHash).to.equal(ethers.ZeroHash);

      const transferredAt = (await ethers.provider.getBlock(transferReceipt!.blockNumber))!.timestamp;
      expect(await provider.dividendBalanceAt(holder.address, dividendTokenId, transferredAt - 1)).to.equal(0n);
      expect(await provider.dividendBalanceAt(holder.address, dividendTokenId, transferredAt)).to.equal(majority);
      expect(await provider.dividendBalanceAt(entityTreasuryAddress(entityNumber), dividendTokenId, transferredAt)).to.equal(supply - majority);

      // One second later the checkpoint is visible and the majority holder can propose.
      await time.increase(1);
      const tx = await provider.proposeBoard(entityId, nextHash, DIVIDEND, [await dividendSupport(1n)]);
      const receipt = await tx.wait();
      const proposedAt = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;
      await expect(tx).to.emit(provider, 'BoardProposed')
        .withArgs(entityId, nextHash, DIVIDEND, 1n, BigInt(proposedAt + 3 * ONE_DAY));
    });

    it('lets a numbered entity vote its treasury dividend shares through a current-board Hanko', async function () {
      const { provider, signers } = await loadFixture(fixture);
      const targetNumber = await registerSingleSignerEntity(provider, signers[1]!.address);
      const companyNumber = await registerSingleSignerEntity(provider, signers[2]!.address);
      const targetId = entityIdOf(targetNumber);
      const companyId = entityIdOf(companyNumber);
      const companyTreasury = entityTreasuryAddress(companyNumber);
      const [, dividendTokenId] = await provider.getTokenIds(targetNumber);
      const supply = await provider.TOTAL_DIVIDEND_SUPPLY();
      const holder = signers[6]!;
      const share = supply * 30n / 100n; // 30% EOA + 30% company treasury = majority only together

      await entityTransferFromTreasury(provider, holder.address, dividendTokenId, share, targetNumber, deriveHardhatPrivateKey(1));
      await entityTransferFromTreasury(provider, companyTreasury, dividendTokenId, share, targetNumber, deriveHardhatPrivateKey(1));
      expect(await provider.balanceOf(companyTreasury, dividendTokenId)).to.equal(share);
      await time.increase(1);

      const nextBoard = encodeSingleSignerBoard(signers[3]!.address);
      await (await provider.commitBoard(nextBoard)).wait();
      const nextHash = boardHashOf(nextBoard);
      const digest = await provider.computeBoardProposalHash(targetId, nextHash, DIVIDEND, 1n);
      // EOA: 65-byte signature. Company: current-board Hanko of the numbered entity.
      const eoaAuth = new ethers.SigningKey(deriveHardhatPrivateKey(6)).sign(ethers.getBytes(digest)).serialized;
      const companyAuth = buildSingleSignerHanko(companyId, digest, deriveHardhatPrivateKey(2));
      expect(ethers.dataLength(companyAuth)).to.not.equal(65);
      const voters = [
        { address: holder.address, authorization: eoaAuth },
        { address: companyTreasury, authorization: companyAuth },
      ].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
      const sorted = voters.map((voter) => voter.authorization);

      // Company alone holds 30%: valid voter, insufficient support.
      await expect(provider.proposeBoard(targetId, nextHash, DIVIDEND, [companyAuth]))
        .to.be.revertedWithCustomError(provider, 'InsufficientShareSupport');
      // Voters are ordered by address (EOA or treasury alike).
      await expect(provider.proposeBoard(targetId, nextHash, DIVIDEND, [...sorted].reverse()))
        .to.be.revertedWithCustomError(provider, 'ShareSupportersNotSorted');
      await expect(provider.proposeBoard(targetId, nextHash, DIVIDEND, [companyAuth, companyAuth]))
        .to.be.revertedWithCustomError(provider, 'DuplicateShareSupporter');
      // Only NUMBERED entities vote through a Hanko: a lazy board has no treasury.
      const lazyId = singleSignerLazyEntityId(signers[7]!.address);
      await expect(provider.proposeBoard(targetId, nextHash, DIVIDEND, [buildSingleSignerHanko(lazyId, digest, deriveHardhatPrivateKey(7))]))
        .to.be.revertedWithCustomError(provider, 'InvalidShareSupportSignature');
      // A Hanko over a different digest is not a vote.
      const wrongDigest = await provider.computeBoardProposalHash(targetId, nextHash, DIVIDEND, 2n);
      await expect(provider.proposeBoard(targetId, nextHash, DIVIDEND, [buildSingleSignerHanko(companyId, wrongDigest, deriveHardhatPrivateKey(2))]))
        .to.be.revertedWithCustomError(provider, 'InvalidShareSupportSignature');

      const tx = await provider.proposeBoard(targetId, nextHash, DIVIDEND, sorted);
      const receipt = await tx.wait();
      const proposedAt = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;
      await expect(tx).to.emit(provider, 'BoardProposed')
        .withArgs(targetId, nextHash, DIVIDEND, 1n, BigInt(proposedAt + 3 * ONE_DAY));
      expect((await provider.entities(targetId)).proposedBoardHash).to.equal(nextHash);
    });
  });
});
