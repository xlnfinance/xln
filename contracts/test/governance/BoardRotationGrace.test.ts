import { expect } from 'chai';
import hre from 'hardhat';

import {
  boardHashOf,
  buildClaimsHanko,
  buildSingleSignerHanko,
  canonicalAccountKey,
  computeDepositoryBatchHash,
  deployDepositoryStack,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  encodeBoard,
  encodeSingleSignerBoard,
  singleSignerLazyEntityId,
} from '../helpers/hanko.ts';

const { ethers, networkHelpers } = await hre.network.getOrCreate('hardhat');
const { mine, time } = networkHelpers;

// Default articles are SECONDS after the redesign (1 day / 3 days / 10 days).
const DEFAULT_ARTICLES = {
  controlDelay: 24 * 60 * 60,
  dividendDelay: 3 * 24 * 60 * 60,
  foundationDelay: 10 * 24 * 60 * 60,
};

const BOARD_GRACE_SECONDS = 7 * 24 * 60 * 60;
const COOPERATIVE_UPDATE = 0;
const DISPUTE_PROOF = 1;
const WATCH_SEED = ethers.keccak256(ethers.toUtf8Bytes('board-rotation-watch-seed'));
const SETTLEMENT_DIFFS_ABI =
  'tuple(uint256 tokenId,int256 leftDiff,int256 rightDiff,int256 collateralDiff,int256 ondeltaDiff)[]';
const PROOF_BODY_ABI =
  'tuple(bytes32 watchSeed,uint32 leftResponseSeconds,uint32 rightResponseSeconds,int256[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)';

const anchoredEntityMemberBoard = (anchor: string, memberEntityId: string): string =>
  encodeBoard(1, [anchor, memberEntityId], [1, 1]);
const anchoredEntityMemberBoardHash = (anchor: string, memberEntityId: string): string =>
  boardHashOf(anchoredEntityMemberBoard(anchor, memberEntityId));

const emptyProofBody = () => ({
  watchSeed: WATCH_SEED,
  leftResponseSeconds: 2,
  rightResponseSeconds: 3,
  offdeltas: [] as bigint[],
  tokenIds: [] as bigint[],
  transformers: [],
});

const proofBodyHash = (body: ReturnType<typeof emptyProofBody>): string =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([PROOF_BODY_ABI], [body]));

const disputeProofHash = async (
  depository: { getAddress(): Promise<string> },
  accountKey: string,
  nonce: bigint,
  bodyHash: string,
  proposerIsLeft = false,
): Promise<string> => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ['uint8', 'uint256', 'address', 'bytes', 'uint256', 'bool', 'bytes32', 'bytes32'],
  [
    DISPUTE_PROOF,
    (await ethers.provider.getNetwork()).chainId,
    await depository.getAddress(),
    accountKey,
    nonce,
    proposerIsLeft,
    bodyHash,
    WATCH_SEED,
  ],
));

const cooperativeUpdateHash = async (
  depository: { getAddress(): Promise<string> },
  accountKey: string,
  nonce: bigint,
  diffs: unknown[],
): Promise<string> => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ['uint8', 'uint256', 'address', 'bytes', 'uint256', SETTLEMENT_DIFFS_ABI, 'uint256[]'],
  [
    COOPERATIVE_UPDATE,
    (await ethers.provider.getNetwork()).chainId,
    await depository.getAddress(),
    accountKey,
    nonce,
    diffs,
    [],
  ],
));

describe('EntityProvider board rotation grace', function () {
  async function fixture() {
    const [foundation, oldSigner, newSigner, , outsider, fourthSigner] = await ethers.getSigners();
    const provider = await deployEntityProvider(foundation.address);

    const oldBoardHash = singleSignerLazyEntityId(oldSigner.address);
    const newBoardHash = singleSignerLazyEntityId(newSigner.address);
    await provider.registerNumberedEntity(encodeSingleSignerBoard(oldSigner.address));
    // proposeBoard accepts only committed (validated) preimages.
    await provider.commitBoard(encodeSingleSignerBoard(newSigner.address));
    await provider.commitBoard(encodeSingleSignerBoard(outsider.address));
    await provider.commitBoard(encodeSingleSignerBoard(fourthSigner!.address));
    const entityNumber = 2n;
    const entityId = ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32);
    const proposalSignature = async (newHash: string, privateKey: string): Promise<string> => {
      const nonce = await provider.boardActionNonces(entityId) + 1n;
      const digest = await provider.computeBoardProposalHash(entityId, newHash, 0, nonce);
      return buildSingleSignerHanko(entityId, digest, privateKey);
    };

    return {
      provider,
      foundation,
      oldSigner,
      newSigner,
      outsider,
      fourthSigner: fourthSigner!,
      entityId,
      oldBoardHash,
      newBoardHash,
      proposalSignature,
    };
  }

  it('accepts only current and immediate previous board, with an exact seven-day boundary', async function () {
    const {
      provider,
      foundation,
      oldSigner,
      newSigner,
      entityId,
      oldBoardHash,
      newBoardHash,
      proposalSignature,
    } = await fixture();
    const support = await proposalSignature(newBoardHash, deriveHardhatPrivateKey(1));
    await provider.connect(foundation).proposeBoard(entityId, newBoardHash, 0, [support]);
    await time.increase(DEFAULT_ARTICLES.controlDelay);

    const activation = await provider.activateBoard(entityId);
    const receipt = await activation.wait();
    const activationBlock = await ethers.provider.getBlock(receipt!.blockNumber);
    const validUntil = BigInt(activationBlock!.timestamp + BOARD_GRACE_SECONDS);

    await expect(activation).to.emit(provider, 'BoardActivated').withArgs(
      entityId,
      oldBoardHash,
      newBoardHash,
      validUntil,
    );
    const entity = await provider.entities(entityId);
    expect(entity.currentBoardHash).to.equal(newBoardHash);
    expect(entity.previousBoardHash).to.equal(oldBoardHash);
    expect(entity.previousBoardValidUntil).to.equal(validUntil);

    const digest = ethers.keccak256(ethers.toUtf8Bytes('board-grace-regression'));
    const oldHanko = buildSingleSignerHanko(entityId, digest, deriveHardhatPrivateKey(1));
    const newHanko = buildSingleSignerHanko(entityId, digest, deriveHardhatPrivateKey(2));
    const anchor = ethers.zeroPadValue(foundation.address, 32);
    const parentId = anchoredEntityMemberBoardHash(foundation.address, entityId);
    const oldNestedHanko = buildClaimsHanko(digest, [deriveHardhatPrivateKey(1)], [anchor], [
      [entityId, [1], [1], 1],
      [parentId, [0, 2], [1, 1], 1],
    ]);
    const newNestedHanko = buildClaimsHanko(digest, [deriveHardhatPrivateKey(2)], [anchor], [
      [entityId, [1], [1], 1],
      [parentId, [0, 2], [1, 1], 1],
    ]);

    expect(await provider.verifyHankoSignature(oldHanko, digest)).to.deep.equal([entityId, true]);
    expect(await provider.verifyHankoSignature(newHanko, digest)).to.deep.equal([entityId, true]);
    expect(await provider.verifyHankoSignature(oldNestedHanko, digest)).to.deep.equal([parentId, true]);
    expect(await provider.verifyHankoSignature(newNestedHanko, digest)).to.deep.equal([parentId, true]);
    expect(await provider.verifyCurrentHankoSignature(oldHanko, digest)).to.deep.equal([ethers.ZeroHash, false]);
    expect(await provider.verifyCurrentHankoSignature(newHanko, digest)).to.deep.equal([entityId, true]);
    expect(await provider.verifyCurrentHankoSignature(oldNestedHanko, digest)).to.deep.equal([
      ethers.ZeroHash,
      false,
    ]);
    expect(await provider.verifyCurrentHankoSignature(newNestedHanko, digest)).to.deep.equal([parentId, true]);

    await time.setNextBlockTimestamp(Number(validUntil) - 1);
    await mine(1);
    expect(await provider.verifyHankoSignature(oldHanko, digest)).to.deep.equal([entityId, true]);
    expect(await provider.verifyHankoSignature(oldNestedHanko, digest)).to.deep.equal([parentId, true]);

    await time.setNextBlockTimestamp(Number(validUntil));
    await mine(1);
    expect(await provider.verifyHankoSignature(oldHanko, digest)).to.deep.equal([ethers.ZeroHash, false]);
    expect(await provider.verifyHankoSignature(newHanko, digest)).to.deep.equal([entityId, true]);
    expect(await provider.verifyHankoSignature(oldNestedHanko, digest)).to.deep.equal([ethers.ZeroHash, false]);
    expect(await provider.verifyHankoSignature(newNestedHanko, digest)).to.deep.equal([parentId, true]);
  });

  it('cannot evict a retired board before its exact grace boundary (two historical slots)', async function () {
    // Redesign: two retired slots. The rotation right after old->new lands at
    // once (old moves to slot 2); only a THIRD rotation must wait until the
    // oldest retired board's seven-day evidence window has elapsed.
    const {
      provider,
      foundation,
      oldSigner,
      newSigner,
      outsider,
      fourthSigner,
      entityId,
      oldBoardHash,
      newBoardHash,
      proposalSignature,
    } = await fixture();
    const firstSupport = await proposalSignature(newBoardHash, deriveHardhatPrivateKey(1));
    await provider.connect(foundation).proposeBoard(entityId, newBoardHash, 0, [firstSupport]);
    await time.increase(DEFAULT_ARTICLES.controlDelay);
    const firstActivation = await (await provider.activateBoard(entityId)).wait();
    const firstActivationBlock = await ethers.provider.getBlock(firstActivation!.blockNumber);
    const firstValidUntil = BigInt(firstActivationBlock!.timestamp + BOARD_GRACE_SECONDS);

    const thirdBoardHash = singleSignerLazyEntityId(outsider.address);
    const secondSupport = await proposalSignature(thirdBoardHash, deriveHardhatPrivateKey(2));
    await provider.proposeBoard(entityId, thirdBoardHash, 0, [secondSupport]);
    await time.increase(DEFAULT_ARTICLES.controlDelay);
    const secondActivation = await (await provider.activateBoard(entityId)).wait();
    const secondActivationBlock = await ethers.provider.getBlock(secondActivation!.blockNumber);
    const secondValidUntil = BigInt(secondActivationBlock!.timestamp + BOARD_GRACE_SECONDS);
    const afterSecond = await provider.entities(entityId);
    expect(afterSecond.currentBoardHash).to.equal(thirdBoardHash);
    expect(afterSecond.previousBoardHash).to.equal(newBoardHash);
    expect(afterSecond.previousBoardValidUntil).to.equal(secondValidUntil);
    expect(afterSecond.previousBoardHash2).to.equal(oldBoardHash);
    expect(afterSecond.previousBoardValidUntil2).to.equal(firstValidUntil);
    expect(await provider.boardEpochs(entityId)).to.equal(2n);

    const fourthBoardHash = singleSignerLazyEntityId(fourthSigner.address);
    const thirdSupport = await proposalSignature(fourthBoardHash, deriveHardhatPrivateKey(4));
    await provider.proposeBoard(entityId, fourthBoardHash, 0, [thirdSupport]);
    await time.increase(DEFAULT_ARTICLES.controlDelay);

    const proofDigest = ethers.keccak256(ethers.toUtf8Bytes('board-grace-overlap-regression'));
    const oldHanko = buildSingleSignerHanko(entityId, proofDigest, deriveHardhatPrivateKey(1));
    const middleHanko = buildSingleSignerHanko(entityId, proofDigest, deriveHardhatPrivateKey(2));
    const currentHanko = buildSingleSignerHanko(entityId, proofDigest, deriveHardhatPrivateKey(4));
    await time.setNextBlockTimestamp(Number(firstValidUntil) - 1);
    await expect(provider.activateBoard(entityId)).to.be.revertedWithCustomError(
      provider,
      'BoardGracePeriodActive',
    );
    const unchanged = await provider.entities(entityId);
    expect(unchanged.currentBoardHash).to.equal(thirdBoardHash);
    expect(unchanged.previousBoardHash).to.equal(newBoardHash);
    expect(unchanged.previousBoardHash2).to.equal(oldBoardHash);
    expect(unchanged.proposedBoardHash).to.equal(fourthBoardHash);
    expect(await provider.boardEpochs(entityId)).to.equal(2n);
    expect(await provider.verifyHankoSignature(oldHanko, proofDigest)).to.deep.equal([entityId, true]);
    expect(await provider.verifyHankoSignature(middleHanko, proofDigest)).to.deep.equal([entityId, true]);
    expect(await provider.verifyCurrentHankoSignature(oldHanko, proofDigest)).to.deep.equal([ethers.ZeroHash, false]);

    await time.setNextBlockTimestamp(Number(firstValidUntil));
    await expect(provider.activateBoard(entityId)).to.emit(provider, 'BoardActivated');
    const rotated = await provider.entities(entityId);
    expect(rotated.currentBoardHash).to.equal(fourthBoardHash);
    expect(rotated.previousBoardHash).to.equal(thirdBoardHash);
    expect(rotated.previousBoardHash2).to.equal(newBoardHash);
    expect(rotated.previousBoardValidUntil2).to.equal(secondValidUntil);
    expect(await provider.boardEpochs(entityId)).to.equal(3n);
    expect(await provider.verifyHankoSignature(oldHanko, proofDigest)).to.deep.equal([ethers.ZeroHash, false]);
    expect(await provider.verifyHankoSignature(middleHanko, proofDigest)).to.deep.equal([entityId, true]);
    expect(await provider.verifyHankoSignature(currentHanko, proofDigest)).to.deep.equal([entityId, true]);
    expect(oldSigner.address).not.to.equal(newSigner.address);
  });

  it('applies current-only rotation authority to every registered claim in a recursive Hanko', async function () {
    const { provider, foundation, outsider, entityId, newBoardHash, proposalSignature } = await fixture();
    const support = await proposalSignature(newBoardHash, deriveHardhatPrivateKey(1));
    await provider.connect(foundation).proposeBoard(entityId, newBoardHash, 0, [support]);
    await time.increase(DEFAULT_ARTICLES.controlDelay);
    await provider.activateBoard(entityId);

    const thirdBoard = singleSignerLazyEntityId(outsider.address);
    const nonce = await provider.boardActionNonces(entityId) + 1n;
    const digest = await provider.computeBoardProposalHash(entityId, thirdBoard, 0, nonce);
    const oldBoardHanko = buildSingleSignerHanko(entityId, digest, deriveHardhatPrivateKey(1));
    await expect(provider.proposeBoard(
      entityId,
      thirdBoard,
      0,
      [oldBoardHanko],
    )).to.be.revertedWithCustomError(provider, 'InvalidAuthorityAuthorization');

    const anchor = ethers.zeroPadValue(foundation.address, 32);
    await provider.registerNumberedEntity(anchoredEntityMemberBoard(foundation.address, entityId));
    const parentId = ethers.zeroPadValue(ethers.toBeHex(3), 32);
    const parentNextBoard = singleSignerLazyEntityId(outsider.address);
    const parentNonce = await provider.boardActionNonces(parentId) + 1n;
    const parentDigest = await provider.computeBoardProposalHash(parentId, parentNextBoard, 0, parentNonce);
    const oldNestedHanko = buildClaimsHanko(parentDigest, [deriveHardhatPrivateKey(1)], [anchor], [
      [entityId, [1], [1], 1],
      [parentId, [0, 2], [1, 1], 1],
    ]);
    await expect(provider.proposeBoard(parentId, parentNextBoard, 0, [oldNestedHanko]))
      .to.be.revertedWithCustomError(provider, 'InvalidAuthorityAuthorization');

    const newNestedHanko = buildClaimsHanko(parentDigest, [deriveHardhatPrivateKey(2)], [anchor], [
      [entityId, [1], [1], 1],
      [parentId, [0, 2], [1, 1], 1],
    ]);
    await expect(provider.proposeBoard(parentId, parentNextBoard, 0, [newNestedHanko]))
      .to.emit(provider, 'BoardProposed');
  });

  it('rejects a previous-board processBatch during the historical-proof grace window', async function () {
    const {
      provider,
      foundation,
      entityId,
      newBoardHash,
      proposalSignature,
    } = await fixture();
    const support = await proposalSignature(newBoardHash, deriveHardhatPrivateKey(1));
    await provider.connect(foundation).proposeBoard(entityId, newBoardHash, 0, [support]);
    await time.increase(DEFAULT_ARTICLES.controlDelay);
    await provider.activateBoard(entityId);

    const { depository } = await deployDepositoryStack(await provider.getAddress());

    const encodedBatch = encodeBatch(emptyBatch());
    const nonce = 1n;
    const digest = await computeDepositoryBatchHash(depository, encodedBatch, nonce);
    const previousBoardHanko = buildSingleSignerHanko(
      entityId,
      digest,
      deriveHardhatPrivateKey(1),
    );
    const currentBoardHanko = buildSingleSignerHanko(
      entityId,
      digest,
      deriveHardhatPrivateKey(2),
    );

    await expect(depository.processBatch(encodedBatch, previousBoardHanko, nonce))
      .to.be.revertedWithCustomError(depository, 'E4');
    expect(await depository.entityNonces(entityId)).to.equal(0n);

    await expect(depository.processBatch(encodedBatch, currentBoardHanko, nonce))
      .to.emit(depository, 'HankoBatchProcessed')
      .withArgs(entityId, digest, nonce);
    expect(await depository.entityNonces(entityId)).to.equal(nonce);
  });

  it('rejects previous-board money actions but accepts its signed dispute proof', async function () {
    const {
      provider,
      foundation,
      outsider,
      entityId,
      newBoardHash,
      proposalSignature,
    } = await fixture();
    const support = await proposalSignature(newBoardHash, deriveHardhatPrivateKey(1));
    await provider.connect(foundation).proposeBoard(entityId, newBoardHash, 0, [support]);
    await time.increase(DEFAULT_ARTICLES.controlDelay);
    await provider.activateBoard(entityId);

    const { depository } = await deployDepositoryStack(await provider.getAddress());

    const initiator = singleSignerLazyEntityId(outsider.address);
    const initiatorKey = deriveHardhatPrivateKey(4);
    const oldBoardKey = deriveHardhatPrivateKey(1);
    const currentBoardKey = deriveHardhatPrivateKey(2);
    const tokenId = 1n;
    const accountKey = canonicalAccountKey(initiator, entityId);
    const signBatch = async (
      signerEntity: string,
      signerKey: string,
      batch: unknown,
      nonce: bigint,
    ) => {
      const encodedBatch = encodeBatch(batch);
      const digest = await computeDepositoryBatchHash(depository, encodedBatch, nonce);
      return {
        encodedBatch,
        hanko: buildSingleSignerHanko(signerEntity, digest, signerKey),
      };
    };
    const signOuterBatch = (batch: unknown, nonce: bigint) =>
      signBatch(initiator, initiatorKey, batch, nonce);

    await depository.mintToReserve(initiator, tokenId, 2n);
    const funding = await signOuterBatch(emptyBatch({
      reserveToCollateral: [{
        tokenId,
        receivingEntity: initiator,
        pairs: [{ entity: entityId, amount: 2n }],
      }],
    }), 1n);
    await depository.processBatch(funding.encodedBatch, funding.hanko, 1n);

    const initiatorIsLeft = BigInt(initiator) < BigInt(entityId);
    const c2rDiffs = [{
      tokenId,
      leftDiff: initiatorIsLeft ? 1n : 0n,
      rightDiff: initiatorIsLeft ? 0n : 1n,
      collateralDiff: -1n,
      ondeltaDiff: initiatorIsLeft ? -1n : 0n,
    }];
    const c2rDigest = await cooperativeUpdateHash(depository, accountKey, 1n, c2rDiffs);
    const c2r = (sig: string) => emptyBatch({
      collateralToReserve: [{ counterparty: entityId, tokenId, amount: 1n, nonce: 1n, sig }],
    });
    const oldC2r = await signOuterBatch(
      c2r(buildSingleSignerHanko(entityId, c2rDigest, oldBoardKey)),
      2n,
    );
    await expect(depository.processBatch(oldC2r.encodedBatch, oldC2r.hanko, 2n))
      .to.be.revertedWithCustomError(depository, 'E4');
    expect((await depository._accounts(accountKey)).nonce).to.equal(0n);

    const currentC2r = await signOuterBatch(
      c2r(buildSingleSignerHanko(entityId, c2rDigest, currentBoardKey)),
      2n,
    );
    await expect(depository.processBatch(currentC2r.encodedBatch, currentC2r.hanko, 2n))
      .to.emit(depository, 'AccountSettled');
    expect((await depository._accounts(accountKey)).nonce).to.equal(1n);

    const settlementDiffs = [{
      tokenId,
      leftDiff: initiatorIsLeft ? -1n : 1n,
      rightDiff: initiatorIsLeft ? 1n : -1n,
      collateralDiff: 0n,
      ondeltaDiff: 0n,
    }];
    const settlementDigest = await cooperativeUpdateHash(
      depository,
      accountKey,
      2n,
      settlementDiffs,
    );
    const settlement = (sig: string) => emptyBatch({
      settlements: [{
        leftEntity: initiatorIsLeft ? initiator : entityId,
        rightEntity: initiatorIsLeft ? entityId : initiator,
        diffs: settlementDiffs,
        forgiveDebtsInTokenIds: [],
        sig,
        nonce: 2n,
      }],
    });
    const oldSettlement = await signOuterBatch(
      settlement(buildSingleSignerHanko(entityId, settlementDigest, oldBoardKey)),
      3n,
    );
    await expect(depository.processBatch(oldSettlement.encodedBatch, oldSettlement.hanko, 3n))
      .to.be.revertedWithCustomError(depository, 'E4');
    expect((await depository._accounts(accountKey)).nonce).to.equal(1n);

    const currentSettlement = await signOuterBatch(
      settlement(buildSingleSignerHanko(entityId, settlementDigest, currentBoardKey)),
      3n,
    );
    await expect(depository.processBatch(currentSettlement.encodedBatch, currentSettlement.hanko, 3n))
      .to.emit(depository, 'AccountSettled');
    expect((await depository._accounts(accountKey)).nonce).to.equal(2n);

    const initialProofbody = emptyProofBody();
    const initialProofbodyHash = proofBodyHash(initialProofbody);
    const disputeNonce = 3n;
    const startDigest = await disputeProofHash(
      depository,
      accountKey,
      disputeNonce,
      initialProofbodyHash,
    );
    const disputeStart = (sig: string) => emptyBatch({
      disputeStarts: [{
        counterentity: entityId,
        nonce: disputeNonce,
        proofbodyHash: initialProofbodyHash,
        initialProofbody,
        watchSeed: WATCH_SEED,
        sig,
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      }],
    });
    const oldStart = await signOuterBatch(
      disputeStart(buildSingleSignerHanko(entityId, startDigest, oldBoardKey)),
      4n,
    );
    await expect(depository.processBatch(oldStart.encodedBatch, oldStart.hanko, 4n))
      .to.emit(depository, 'DisputeStarted');
    const openedAccount = await depository._accounts(accountKey);
    expect(openedAccount.disputeHash).to.not.equal(ethers.ZeroHash);
    expect(openedAccount.nonce).to.equal(disputeNonce);
    expect(await depository.entityNonces(initiator)).to.equal(4n);

    // The same boundary applies when historical proof finalizes an active
    // dispute: evidence survives rotation; direct money authority does not.
    const peer = singleSignerLazyEntityId(foundation.address);
    const peerKey = deriveHardhatPrivateKey(0);
    const historicalAccountKey = canonicalAccountKey(entityId, peer);
    const historicalStartHash = await disputeProofHash(
      depository,
      historicalAccountKey,
      1n,
      initialProofbodyHash,
    );
    const historicalStart = await signBatch(
      entityId,
      currentBoardKey,
      emptyBatch({
        disputeStarts: [{
          counterentity: peer,
          nonce: 1n,
          proofbodyHash: initialProofbodyHash,
          initialProofbody,
          watchSeed: WATCH_SEED,
          sig: buildSingleSignerHanko(peer, historicalStartHash, peerKey),
          starterInitialArguments: '0x',
          starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        }],
      }),
      1n,
    );
    await expect(depository.processBatch(
      historicalStart.encodedBatch,
      historicalStart.hanko,
      1n,
    )).to.emit(depository, 'DisputeStarted');

    const historicalFinalHash = await disputeProofHash(
      depository,
      historicalAccountKey,
      2n,
      initialProofbodyHash,
    );
    const historicalFinal = await signBatch(
      peer,
      peerKey,
      emptyBatch({
        disputeFinalizations: [{
          counterentity: entityId,
          initialNonce: 1n,
          finalNonce: 2n,
          initialProofbodyHash,
          finalProofbody: initialProofbody,
          starterArguments: '0x',
          otherArguments: '0x',
          sig: buildSingleSignerHanko(entityId, historicalFinalHash, oldBoardKey),
          startedByLeft: BigInt(entityId) < BigInt(peer),
          cooperative: false,
        }],
      }),
      1n,
    );
    await expect(depository.processBatch(
      historicalFinal.encodedBatch,
      historicalFinal.hanko,
      1n,
    )).to.emit(depository, 'DisputeFinalized');
    expect((await depository._accounts(historicalAccountKey)).nonce).to.equal(2n);
  });

  it('rejects previous-board watchtower authority while accepting the current board', async function () {
    const {
      provider,
      foundation,
      newSigner,
      outsider,
      entityId,
      newBoardHash,
      proposalSignature,
    } = await fixture();
    const support = await proposalSignature(newBoardHash, deriveHardhatPrivateKey(1));
    await provider.connect(foundation).proposeBoard(entityId, newBoardHash, 0, [support]);
    await time.increase(DEFAULT_ARTICLES.controlDelay);
    await provider.activateBoard(entityId);

    const { depository } = await deployDepositoryStack(await provider.getAddress());
    const disputeDelay = 5n;

    const counterentity = singleSignerLazyEntityId(outsider.address);
    const accountKey = canonicalAccountKey(entityId, counterentity);
    const initialNonce = 1n;
    const initialProofbody = emptyProofBody();
    const initialProofbodyHash = proofBodyHash(initialProofbody);
    const initialProposerIsLeft = BigInt(entityId) < BigInt(counterentity);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const startHash = await disputeProofHash(
      depository,
      accountKey,
      initialNonce,
      initialProofbodyHash,
      initialProposerIsLeft,
    );
    const startBatch = encodeBatch(emptyBatch({
      disputeStarts: [{
        counterentity: entityId,
        nonce: initialNonce,
        proposerIsLeft: initialProposerIsLeft,
        proofbodyHash: initialProofbodyHash,
        initialProofbody,
        watchSeed: WATCH_SEED,
        sig: buildSingleSignerHanko(
          entityId,
          startHash,
          deriveHardhatPrivateKey(2),
        ),
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      }],
    }));
    const startBatchHash = await computeDepositoryBatchHash(depository, startBatch, 1n);
    await depository.processBatch(
      startBatch,
      buildSingleSignerHanko(counterentity, startBatchHash, deriveHardhatPrivateKey(4)),
      1n,
    );

    const finalNonce = 2n;
    const finalProofbody = emptyProofBody();
    const finalProofbodyHash = proofBodyHash(finalProofbody);
    const finalProposerIsLeft = BigInt(counterentity) < BigInt(entityId);
    const finalHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint8', 'uint256', 'address', 'bytes', 'uint256', 'bool', 'bytes32', 'bytes32'],
      [
        DISPUTE_PROOF,
        chainId,
        await depository.getAddress(),
        accountKey,
        finalNonce,
        finalProposerIsLeft,
        finalProofbodyHash,
        WATCH_SEED,
      ],
    ));
    const finalization = {
      counterentity,
      initialNonce,
      finalNonce,
      proposerIsLeft: finalProposerIsLeft,
      initialProofbodyHash,
      finalProofbody,
      starterArguments: '0x',
      otherArguments: '0x',
      sig: buildSingleSignerHanko(
        counterentity,
        finalHash,
        deriveHardhatPrivateKey(4),
      ),
      startedByLeft: BigInt(counterentity) < BigInt(entityId),
      cooperative: false,
    };
    const towerHash = await depository.computeWatchtowerCounterDisputeHash(
      newSigner.address,
      entityId,
      counterentity,
      finalNonce,
      finalProofbodyHash,
      disputeDelay,
      1n,
    );

    await expect(depository.connect(newSigner).watchtowerCounterDispute(
      entityId,
      finalization,
      disputeDelay,
      1n,
      buildSingleSignerHanko(entityId, towerHash, deriveHardhatPrivateKey(1)),
    )).to.be.revertedWithCustomError(depository, 'E4');

    await expect(depository.connect(newSigner).watchtowerCounterDispute(
      entityId,
      finalization,
      disputeDelay,
      1n,
      buildSingleSignerHanko(entityId, towerHash, deriveHardhatPrivateKey(2)),
    )).to.emit(depository, 'CounterDisputeRegistered')
      .withArgs(entityId, counterentity, finalNonce, finalProposerIsLeft, finalProofbodyHash);

    const timeout = (await depository._accounts(accountKey)).disputeTimeout;
    await time.increaseTo(Number(timeout));
    await expect(depository.connect(newSigner).watchtowerCounterDispute(
      entityId,
      finalization,
      disputeDelay,
      1n,
      buildSingleSignerHanko(entityId, towerHash, deriveHardhatPrivateKey(2)),
    )).to.emit(depository, 'WatchtowerCounterDisputeExecuted')
      .withArgs(newSigner.address, entityId, counterentity, finalNonce, 1n);
  });
});
