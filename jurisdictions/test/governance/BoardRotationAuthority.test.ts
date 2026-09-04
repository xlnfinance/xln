import { expect } from 'chai';
import hre from 'hardhat';

import {
  boardHashOf,
  buildFoundationAction,
  buildSingleSignerHanko,
  computeDepositoryBatchHash,
  deployDepositoryStack,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  encodeSingleSignerBoard,
  singleSignerLazyEntityId,
} from '../helpers/hanko.ts';

const { ethers, networkHelpers } = await hre.network.getOrCreate('hardhat');
const { time } = networkHelpers;
const BOARD = 0;
const CONTROL = 1;
const FOUNDATION = 3;
const TARGET_ID = ethers.zeroPadValue(ethers.toBeHex(2), 32);
const HOLDER_A_ID = ethers.zeroPadValue(ethers.toBeHex(3), 32);
const HOLDER_B_ID = ethers.zeroPadValue(ethers.toBeHex(4), 32);
// Governance delays are seconds (redesign); registerNumberedEntity installs the 1 day default.
const ARTICLES = { controlDelay: 3, dividendDelay: 5, foundationDelay: 7 };
const DEFAULT_CONTROL_DELAY = 24 * 60 * 60;

type BoardCommitter = { commitBoard(encodedBoard: string): Promise<{ wait(): Promise<unknown> }> };
// proposeBoard only accepts validated preimages: derive a distinct 1-of-1 board
// per label and commit it (on every provider that must see it).
const nextBoard = async (label: string, ...providers: BoardCommitter[]): Promise<string> => {
  const member = ethers.getAddress(ethers.dataSlice(ethers.keccak256(ethers.toUtf8Bytes(label)), 12));
  const encoded = encodeSingleSignerBoard(member);
  for (const provider of providers) await (await provider.commitBoard(encoded)).wait();
  return boardHashOf(encoded);
};

async function fixture(splitA = 60n) {
  const signers = await ethers.getSigners();
  const provider = await deployEntityProvider(signers[0]!.address);
  const targetBoard = encodeSingleSignerBoard(signers[1]!.address);
  const argumentsHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'tuple(uint32 controlDelay,uint32 dividendDelay,uint32 foundationDelay)'],
    [boardHashOf(targetBoard), ARTICLES],
  ));
  const registration = await buildFoundationAction(
    provider,
    await provider.FOUNDATION_REGISTER_ENTITY(),
    argumentsHash,
  );
  await provider.foundationRegisterEntity(
    targetBoard,
    ARTICLES,
    registration.hankoData,
    registration.actionNonce,
  );
  await provider.registerNumberedEntity(encodeSingleSignerBoard(signers[3]!.address));
  await provider.registerNumberedEntity(encodeSingleSignerBoard(signers[4]!.address));

  const { depository } = await deployDepositoryStack(await provider.getAddress());
  const supply = await provider.TOTAL_CONTROL_SUPPLY();
  const depositoryAddress = await depository.getAddress();
  const purpose = 'settled-control-governance';
  const releaseHash = await provider.computeReleaseControlSharesHankoHash(
    2n,
    depositoryAddress,
    supply,
    0n,
    purpose,
    1n,
  );
  await provider.releaseControlShares(
    2n,
    depositoryAddress,
    supply,
    0n,
    purpose,
    buildSingleSignerHanko(TARGET_ID, releaseHash, deriveHardhatPrivateKey(1)),
  );
  const controlTokenId = (await depository.getTokensLength()) - 1n;
  const amountA = (supply * splitA) / 100n;
  const batch = emptyBatch({
    reserveToReserve: [
      { receivingEntity: HOLDER_A_ID, tokenId: controlTokenId, amount: amountA },
      { receivingEntity: HOLDER_B_ID, tokenId: controlTokenId, amount: supply - amountA },
    ],
  });
  const encodedBatch = encodeBatch(batch);
  const batchHash = await computeDepositoryBatchHash(depository, encodedBatch, 1n);
  await depository.processBatch(
    encodedBatch,
    buildSingleSignerHanko(TARGET_ID, batchHash, deriveHardhatPrivateKey(1)),
    1n,
  );
  return { provider, depository, signers, supply, controlTokenId };
}

const controlHanko = async (
  fx: Awaited<ReturnType<typeof fixture>>,
  holderId: string,
  signerIndex: number,
  boardHash: string,
  nonce = 1n,
): Promise<string> => {
  const digest = await fx.provider.computeBoardProposalHash(TARGET_ID, boardHash, CONTROL, nonce);
  return buildSingleSignerHanko(holderId, digest, deriveHardhatPrivateKey(signerIndex));
};

describe('EntityProvider settled CONTROL governance', function () {
  it('binds one Depository and releases CONTROL only into that custody', async function () {
    const fx = await fixture();
    expect(await fx.provider.shareDepository()).to.equal(await fx.depository.getAddress());
    expect(await fx.depository._reserves(HOLDER_A_ID, fx.controlTokenId)).to.equal(fx.supply * 60n / 100n);
    await expect(fx.provider.bindShareDepository(await fx.depository.getAddress()))
      .to.be.revertedWithCustomError(fx.provider, 'ShareDepositoryAlreadyBound');
    const releaseHash = await fx.provider.computeReleaseControlSharesHankoHash(
      2n,
      fx.signers[8]!.address,
      1n,
      0n,
      'wrong-custody',
      2n,
    );
    await expect(fx.provider.releaseControlShares(
      2n,
      fx.signers[8]!.address,
      1n,
      0n,
      'wrong-custody',
      buildSingleSignerHanko(TARGET_ID, releaseHash, deriveHardhatPrivateKey(1)),
    )).to.be.revertedWithCustomError(fx.provider, 'ShareDepositoryRequired');
  });

  it('lets a current Entity Hanko backed by more than 50% settled CONTROL schedule rotation', async function () {
    const fx = await fixture();
    const boardHash = await nextBoard('reserve-majority', fx.provider);
    const hanko = await controlHanko(fx, HOLDER_A_ID, 3, boardHash);
    await expect(fx.provider.proposeBoard(TARGET_ID, boardHash, CONTROL, [hanko]))
      .to.emit(fx.provider, 'BoardProposed');
    await time.increase(ARTICLES.controlDelay);
    await expect(fx.provider.activateBoard(TARGET_ID)).to.emit(fx.provider, 'BoardActivated');
    expect((await fx.provider.entities(TARGET_ID)).currentBoardHash).to.equal(boardHash);
  });

  it('rejects exactly 50%, duplicate/unsorted supporters, and an unbacked Entity', async function () {
    const half = await fixture(50n);
    const halfBoard = await nextBoard('exact-half', half.provider);
    await expect(half.provider.proposeBoard(
      TARGET_ID,
      halfBoard,
      CONTROL,
      [await controlHanko(half, HOLDER_A_ID, 3, halfBoard)],
    )).to.be.revertedWithCustomError(half.provider, 'InsufficientShareSupport');

    const fx = await fixture();
    const boardHash = await nextBoard('supporter-order', fx.provider);
    const a = await controlHanko(fx, HOLDER_A_ID, 3, boardHash);
    const b = await controlHanko(fx, HOLDER_B_ID, 4, boardHash);
    await expect(fx.provider.proposeBoard(TARGET_ID, boardHash, CONTROL, [a, a]))
      .to.be.revertedWithCustomError(fx.provider, 'DuplicateShareSupporter');
    await expect(fx.provider.proposeBoard(TARGET_ID, boardHash, CONTROL, [b, a]))
      .to.be.revertedWithCustomError(fx.provider, 'ShareSupportersNotSorted');

    const unbackedId = singleSignerLazyEntityId(fx.signers[7]!.address);
    const digest = await fx.provider.computeBoardProposalHash(TARGET_ID, boardHash, CONTROL, 1n);
    const unbacked = buildSingleSignerHanko(unbackedId, digest, deriveHardhatPrivateKey(7));
    await expect(fx.provider.proposeBoard(TARGET_ID, boardHash, CONTROL, [unbacked]))
      .to.be.revertedWithCustomError(fx.provider, 'ShareSupporterHasNoShares');
  });

  it('rejects a retired shareholder board even during historical-proof grace', async function () {
    const fx = await fixture();
    const replacementBoard = encodeSingleSignerBoard(fx.signers[8]!.address);
    await (await fx.provider.commitBoard(replacementBoard)).wait();
    const replacement = boardHashOf(replacementBoard);
    const shareholderNonce = 1n;
    const shareholderDigest = await fx.provider.computeBoardProposalHash(
      HOLDER_A_ID,
      replacement,
      BOARD,
      shareholderNonce,
    );
    await fx.provider.proposeBoard(
      HOLDER_A_ID,
      replacement,
      BOARD,
      [buildSingleSignerHanko(HOLDER_A_ID, shareholderDigest, deriveHardhatPrivateKey(3))],
    );
    await time.increase(DEFAULT_CONTROL_DELAY);
    await fx.provider.activateBoard(HOLDER_A_ID);

    const targetBoard = await nextBoard('retired-shareholder-board', fx.provider);
    const stale = await controlHanko(fx, HOLDER_A_ID, 3, targetBoard);
    await expect(fx.provider.proposeBoard(TARGET_ID, targetBoard, CONTROL, [stale]))
      .to.be.revertedWithCustomError(fx.provider, 'InvalidShareSupportSignature');
    const current = await controlHanko(fx, HOLDER_A_ID, 8, targetBoard);
    await expect(fx.provider.proposeBoard(TARGET_ID, targetBoard, CONTROL, [current]))
      .to.emit(fx.provider, 'BoardProposed');
  });

  it('binds proposal signatures to provider, epoch and nonce', async function () {
    const left = await fixture();
    const right = await fixture();
    const boardHash = await nextBoard('replay-domain', left.provider, right.provider);
    const leftHanko = await controlHanko(left, HOLDER_A_ID, 3, boardHash);
    await expect(right.provider.proposeBoard(TARGET_ID, boardHash, CONTROL, [leftHanko]))
      .to.be.revertedWithCustomError(right.provider, 'InvalidShareSupportSignature');
    await left.provider.proposeBoard(TARGET_ID, boardHash, CONTROL, [leftHanko]);
    await expect(left.provider.proposeBoard(TARGET_ID, await nextBoard('stale', left.provider), CONTROL, [leftHanko]))
      .to.revert(ethers);
  });

  it('keeps BOARD authority current-only and activation permissionless', async function () {
    const fx = await fixture();
    const boardHash = await nextBoard('board-authority', fx.provider);
    const digest = await fx.provider.computeBoardProposalHash(TARGET_ID, boardHash, BOARD, 1n);
    await fx.provider.proposeBoard(
      TARGET_ID,
      boardHash,
      BOARD,
      [buildSingleSignerHanko(TARGET_ID, digest, deriveHardhatPrivateKey(1))],
    );
    await time.increase(ARTICLES.controlDelay);
    await expect(fx.provider.connect(fx.signers[9]!).activateBoard(TARGET_ID))
      .to.emit(fx.provider, 'BoardActivated');

    const lowerPriority = await nextBoard('foundation-after-board', fx.provider);
    const nonce = (await fx.provider.boardActionNonces(TARGET_ID)) + 1n;
    const foundationDigest = await fx.provider.computeBoardProposalHash(
      TARGET_ID,
      lowerPriority,
      FOUNDATION,
      nonce,
    );
    await expect(fx.provider.proposeBoard(
      TARGET_ID,
      lowerPriority,
      FOUNDATION,
      [buildSingleSignerHanko(ethers.zeroPadValue(ethers.toBeHex(1), 32), foundationDigest, deriveHardhatPrivateKey(0))],
    )).to.emit(fx.provider, 'BoardProposed');
  });
});
